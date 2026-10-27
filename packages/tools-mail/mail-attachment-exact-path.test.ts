// A path in `attachments` is used exactly as it was given: a trailing space belongs to the file name, and a trailing
// line break is refused before the card and before SMTP. SMTP is replaced by a recorder, so the tests read the letter
// exactly as it would be handed to the server.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const PASSWORD_ENV = 'MAIL_ATTACHMENT_EXACT_PATH_PASSWORD'
const PLAIN = 'plain-content\n'
const SPACED = 'spaced-content\n'

let home = ''
let workspace = ''
let cards: MailApprovalRequest[] = []

function context(): RunnerToolContext {
  return { sessionId: 'main' } as unknown as RunnerToolContext
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-mail-exact-path-'))
  workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  process.env[PASSWORD_ENV] = 'exact-path-secret'
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

function toolWith() {
  return createMailTool({
    home,
    timeoutMs: 5_000,
    approval: async (request) => {
      cards.push(request)
      return 'allow'
    },
  })
}

async function send(attachments: string[]): Promise<string> {
  return (await toolWith().execute(
    { action: 'send', box: BOX, to: ['ivan@example.org'], subject: 'Файлы', text: 'Во вложении.', attachments },
    context(),
  )) as string
}

async function refusal(attachments: string[]): Promise<string> {
  try {
    await send(attachments)
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
  filename: string | undefined
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

test('test_c6_h1_h2_a_path_with_a_trailing_space_is_attached_as_that_file_with_its_own_name', async () => {
  writeFileSync(join(workspace, 'report.csv'), PLAIN)
  writeFileSync(join(workspace, 'report.csv '), SPACED)

  await send(['report.csv '])

  expect(cards, 'the owner saw one card').toHaveLength(1)
  expect(cards[0]?.attachments, 'the card names the file with its trailing space').toEqual(['report.csv '])
  expect(sent, 'the letter went out').toHaveLength(1)
  const files = attachmentsOf(sent[0]?.raw ?? '')
  expect(files, 'only the file that was named is attached').toHaveLength(1)
  expect(files[0]?.filename).toBe('report.csv ')
  expect(files[0]?.name).toBe('report.csv ')
  expect(files[0]?.content.toString('utf8')).toBe(SPACED)
  expect(sent[0]?.raw, 'the content of report.csv is not sent').not.toContain(Buffer.from(PLAIN).toString('base64').trim())
})

test('test_c6_h1_h2_a_path_with_a_trailing_line_break_is_refused_before_the_card_and_smtp', async () => {
  writeFileSync(join(workspace, 'report.csv'), PLAIN)

  for (const path of ['report.csv\n', 'report.csv\r\n']) {
    const failed = await refusal([path])

    expect(failed, `${JSON.stringify(path)} is refused`).not.toBe('')
    expect(cards, `no card was drawn for ${JSON.stringify(path)}`).toHaveLength(0)
    expect(sent, `no letter was handed to SMTP for ${JSON.stringify(path)}`).toHaveLength(0)
  }
})

test('test_c6_h1_h2_an_empty_or_blank_path_is_still_refused_with_a_reason', async () => {
  writeFileSync(join(workspace, 'report.csv'), PLAIN)

  for (const path of ['', '   ']) {
    const failed = await refusal([path])

    expect(failed, `${JSON.stringify(path)} is refused`).not.toBe('')
    expect(failed).toMatch(/attachments|вложени/i)
    expect(cards).toHaveLength(0)
    expect(sent).toHaveLength(0)
  }
})
