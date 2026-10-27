// The names under which `mail send` attaches files: the name the owner (or the model) gave the path, not the name of
// the file a symlink points to, and a long or non-ASCII name travels whole. SMTP is replaced by a recorder (the real
// client trusts only the system store), so the tests read the letter exactly as it would be handed to the server.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { MailApprovalRequest } from './src/index.js'
import { createMailTool } from './src/index.js'
import type { RunnerToolContext } from '../runner/src/index.js'

const sent = vi.hoisted(() => [] as Array<{ to: string[]; raw: string }>)

vi.mock('./src/smtp.js', () => ({
  sendSmtp: async (_options: unknown, mail: { to: string[]; raw: string }): Promise<void> => {
    sent.push({ to: [...mail.to], raw: mail.raw })
  },
}))

const BOX = 'work'
const PASSWORD_ENV = 'MAIL_ATTACHMENT_NAMES_PASSWORD'
const CSV = 'id,total\n1,10\n2,20\n'

let home = ''
let workspace = ''
let cards: MailApprovalRequest[] = []

function context(): RunnerToolContext {
  return { sessionId: 'main' } as unknown as RunnerToolContext
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-mail-attachment-names-'))
  workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  process.env[PASSWORD_ENV] = 'attachment-names-secret'
  writeFileSync(
    join(home, 'mail.json'),
    JSON.stringify({
      [BOX]: {
        host: '127.0.0.1',
        port: 9,
        login: 'owner@example.org',
        password_env: PASSWORD_ENV,
        tls: true,
        smtp: { host: '127.0.0.1', port: 9 },
      },
    }),
  )
  sent.length = 0
  cards = []
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function toolWith(extra: { hidden?: Array<{ path: string }> } = {}) {
  return createMailTool({
    home,
    timeoutMs: 5_000,
    approval: async (request) => {
      cards.push(request)
      return 'allow'
    },
    ...extra,
  })
}

async function send(tool: ReturnType<typeof toolWith>, attachments: string[]): Promise<string> {
  return (await tool.execute(
    { action: 'send', box: BOX, to: ['ivan@example.org'], subject: 'Файлы', text: 'Во вложении.', attachments },
    context(),
  )) as string
}

async function refusal(tool: ReturnType<typeof toolWith>, attachments: string[]): Promise<string> {
  try {
    await send(tool, attachments)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

// --- reading the letter back ----------------------------------------------------------------------------------

function unfold(headers: string): string {
  return headers.replace(/\r\n([ \t])/g, '$1')
}

function splitMessage(text: string): { head: string; body: string } {
  const at = text.indexOf('\r\n\r\n')
  return at < 0 ? { head: text, body: '' } : { head: unfold(text.slice(0, at)), body: text.slice(at + 4) }
}

function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, '$1')
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, kind: string, data: string) => {
    expect(charset.toLowerCase()).toBe('utf-8')
    if (kind.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8')
    const bytes = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  })
}

function percentDecoded(value: string): string {
  const bytes = Buffer.from(
    value.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  )
  return bytes.toString('utf8')
}

/** One parameter of a structured header, with RFC 2231 (`name*`, `name*0*`, `name*0`) and RFC 2047 undone. */
function parameter(header: string, wanted: string): string | undefined {
  const found = new Map<string, string>()
  const pattern = /;\s*([^=\s;]+)=("(?:[^"\\]|\\.)*"|[^;\s]*)/g
  for (let match = pattern.exec(header); match !== null; match = pattern.exec(header)) {
    const value = (match[2] as string).replace(/^"([\s\S]*)"$/, (_w, inner: string) => inner.replace(/\\(.)/g, '$1'))
    found.set((match[1] as string).toLowerCase(), value)
  }
  const key = wanted.toLowerCase()
  const extended = found.get(`${key}*`)
  if (extended !== undefined) return percentDecoded(extended.replace(/^[^']*'[^']*'/, ''))
  const parts: string[] = []
  for (let index = 0; ; index += 1) {
    const encoded = found.get(`${key}*${index}*`)
    const plain = found.get(`${key}*${index}`)
    if (encoded !== undefined) parts.push(percentDecoded(index === 0 ? encoded.replace(/^[^']*'[^']*'/, '') : encoded))
    else if (plain !== undefined) parts.push(plain)
    else break
  }
  if (parts.length > 0) return parts.join('')
  const direct = found.get(key)
  return direct === undefined ? undefined : decodeWords(direct)
}

interface AttachmentPart {
  /** `filename` of Content-Disposition, decoded */
  filename: string | undefined
  /** `name` of Content-Type, decoded */
  name: string | undefined
  content: Buffer
}

function attachmentsOf(raw: string): AttachmentPart[] {
  const top = splitMessage(raw)
  const boundary = /boundary=("[^"]+"|[^;\s]+)/i.exec(top.head)?.[1]?.replace(/"/g, '')
  expect(boundary, 'the letter with attachments is multipart').toBeDefined()
  const result: AttachmentPart[] = []
  for (const chunk of top.body.split(`--${boundary as string}`)) {
    const part = splitMessage(chunk.replace(/^\r\n/, ''))
    const disposition = /^Content-Disposition:\s*(.*)$/im.exec(part.head)?.[1]
    if (disposition === undefined || !/^\s*attachment/i.test(disposition)) continue
    const type = /^Content-Type:\s*(.*)$/im.exec(part.head)?.[1] ?? ''
    result.push({
      filename: parameter(disposition, 'filename'),
      name: parameter(type, 'name'),
      content: Buffer.from(part.body.replace(/\s+/g, ''), 'base64'),
    })
  }
  return result
}

// --- tests -----------------------------------------------------------------------------------------------------

test('test_c6_a_symlink_is_attached_under_its_own_name_with_the_content_of_the_target', async () => {
  writeFileSync(join(workspace, 'data.csv'), CSV)
  symlinkSync(join(workspace, 'data.csv'), join(workspace, 'report.csv'))

  await send(toolWith(), ['report.csv'])

  expect(cards, 'the owner saw one card').toHaveLength(1)
  expect(cards[0]?.attachments, 'the card names the attachment as the path was given').toEqual(['report.csv'])
  expect(sent, 'the letter went out').toHaveLength(1)
  const files = attachmentsOf(sent[0]?.raw ?? '')
  expect(files).toHaveLength(1)
  expect(files[0]?.filename).toBe('report.csv')
  expect(files[0]?.name).toBe('report.csv')
  expect(files[0]?.content.toString('utf8')).toBe(CSV)
})

test('test_c6_a_symlink_given_by_an_absolute_path_keeps_the_name_of_the_link', async () => {
  mkdirSync(join(workspace, 'sub'))
  writeFileSync(join(workspace, 'sub', 'data.csv'), CSV)
  symlinkSync(join(workspace, 'sub', 'data.csv'), join(workspace, 'sub', 'latest.csv'))

  await send(toolWith(), [join(workspace, 'sub', 'latest.csv')])

  const files = attachmentsOf(sent[0]?.raw ?? '')
  expect(files.map((file) => file.filename)).toEqual(['latest.csv'])
  expect(cards[0]?.attachments).toEqual(['latest.csv'])
})

test('test_c6_a_symlink_out_of_the_roots_is_still_refused_before_the_card', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'dshbot-mail-attachment-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'harmless.txt'))

    const failed = await refusal(toolWith(), ['harmless.txt'])

    expect(failed, 'the link out of the roots is refused').not.toBe('')
    expect(cards, 'no card was drawn').toHaveLength(0)
    expect(sent, 'nothing was sent').toHaveLength(0)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('test_c6_a_symlink_into_a_hidden_path_is_still_refused_before_the_card', async () => {
  mkdirSync(join(workspace, 'private'))
  writeFileSync(join(workspace, 'private', 'keys.txt'), 'hidden')
  symlinkSync(join(workspace, 'private', 'keys.txt'), join(workspace, 'notes.txt'))

  const failed = await refusal(toolWith({ hidden: [{ path: join(workspace, 'private') }] }), ['notes.txt'])

  expect(failed, 'the link into a hidden path is refused').not.toBe('')
  expect(cards, 'no card was drawn').toHaveLength(0)
  expect(sent, 'nothing was sent').toHaveLength(0)
})

test('test_c6_an_ascii_name_longer_than_200_characters_goes_out_whole', async () => {
  const name = `${'a'.repeat(230)}.txt`
  writeFileSync(join(workspace, name), 'long ascii')

  await send(toolWith(), [name])

  expect(cards[0]?.attachments, 'the card shows the whole name').toEqual([name])
  const files = attachmentsOf(sent[0]?.raw ?? '')
  expect(files).toHaveLength(1)
  expect(files[0]?.filename).toBe(name)
  expect(files[0]?.name).toBe(name)
  expect(files[0]?.content.toString('utf8')).toBe('long ascii')
})

test('test_c6_a_non_ascii_name_longer_than_200_characters_goes_out_whole', async () => {
  const name = `отчёт-${'ж'.repeat(10)}-${'x'.repeat(190)}.csv`
  expect([...name].length).toBeGreaterThan(200)
  writeFileSync(join(workspace, name), CSV)

  await send(toolWith(), [name])

  expect(cards[0]?.attachments, 'the card shows the whole name').toEqual([name])
  const files = attachmentsOf(sent[0]?.raw ?? '')
  expect(files).toHaveLength(1)
  expect(files[0]?.filename).toBe(name)
  expect(files[0]?.name).toBe(name)
  expect(files[0]?.content.toString('utf8')).toBe(CSV)
  // The headers stay ASCII, so the letter is the same bytes on any server.
  expect(sent[0]?.raw).toMatch(/^[\x00-\x7f]*$/)
})

test('test_c6_a_name_with_a_line_break_is_refused_before_the_card_and_smtp', async () => {
  const name = 'report\nBcc: evil@example.org.txt'
  writeFileSync(join(workspace, name), 'x')

  const failed = await refusal(toolWith(), [name])

  expect(failed, 'a name that cannot travel unchanged is refused').not.toBe('')
  expect(failed, 'the refusal names the file name as the reason').toMatch(/им(?:я|ен)|name/i)
  expect(cards, 'no card was drawn').toHaveLength(0)
  expect(sent, 'no letter was handed to SMTP').toHaveLength(0)
})

test('test_c6_a_name_with_a_carriage_return_is_refused_before_the_card_and_smtp', async () => {
  const name = 'report\rfinal.txt'
  writeFileSync(join(workspace, name), 'x')

  const failed = await refusal(toolWith(), [name])

  expect(failed).not.toBe('')
  expect(cards).toHaveLength(0)
  expect(sent).toHaveLength(0)
})
