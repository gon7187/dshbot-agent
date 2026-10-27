import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

import {
  MAIL_CARD_LIMIT,
  MAIL_SUBJECT_LIMIT,
  createMailTool,
  cutMailText,
  formatMailDate,
  mailConfirmationText,
  safeAttachmentName,
  type MailApprovalRequest,
} from './src/index.js'
import { decodeWords, htmlToText, parseMessage } from './src/message.js'
import type { RunnerToolContext } from '../runner/src/index.js'

const home = mkdtempSync(join(tmpdir(), 'dshbot-mail-unit-'))

function context(sessionId: string): RunnerToolContext {
  return { sessionId } as unknown as RunnerToolContext
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

test('test_c2_html_becomes_readable_text_without_tags', () => {
  const text = htmlToText('<p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul><a href="/x">link</a>')
  expect(text).toContain('Hello world')
  expect(text).toContain('one')
  expect(text).toContain('link')
  expect(text).not.toMatch(/<\/?(?:p|b|ul|li|a)\b/i)
  expect(htmlToText('<p>a&nbsp;&amp;&nbsp;b &#1055;&#x440;'))
    .toContain('a & b Пр')
})

test('test_c2_a_long_text_is_cut_with_a_note', () => {
  const long = `HEAD${'x'.repeat(200_000)}TAIL`
  const cut = cutMailText(long)
  expect(cut.length).toBeLessThan(120_000)
  expect(cut).toContain('HEAD')
  expect(cut).not.toContain('TAIL')
  expect(cut).toMatch(/обрезан/)
  expect(cutMailText('short')).toBe('short')
})

test('test_c3_attachment_names_lose_dotdot_and_slashes', () => {
  expect(safeAttachmentName('../../escape.txt')).toBe('escape.txt')
  expect(safeAttachmentName('sub/dir/escape.txt')).toBe('escape.txt')
  expect(safeAttachmentName('..\\..\\win.txt')).toBe('win.txt')
  expect(safeAttachmentName('..')).toBe('attachment')
  expect(safeAttachmentName('a\u0000b.txt')).toBe('ab.txt')
})

test('test_c1_c2_a_letter_is_parsed_with_its_text_and_attachment', () => {
  const subject = Buffer.from('Счёт за март').toString('base64')
  const raw = Buffer.from(
    [
      'Date: Sun, 17 Mar 2024 12:00:00 +0000',
      `From: =?UTF-8?B?${Buffer.from('Бухгалтерия').toString('base64')}?= <buh@example.org>`,
      `Subject: =?UTF-8?B?${subject}?=`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html; charset="utf-8"',
      '',
      '<p>Hello <b>world</b></p>',
      '--b1',
      'Content-Type: application/pdf; name="file.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="file.pdf"',
      '',
      Buffer.from('PDF').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n'),
    'latin1',
  )
  const message = parseMessage(raw)
  expect(decodeWords(message.headers.get('subject') ?? '')).toBe('Счёт за март')
  expect(message.text).toBe('Hello world')
  expect(message.attachments).toHaveLength(1)
  expect(message.attachments[0]?.name).toBe('file.pdf')
  expect(message.attachments[0]?.size).toBe(3)
  expect(message.attachments[0]?.content?.toString()).toBe('PDF')
  expect(formatMailDate(new Date('2024-03-17T12:00:00Z'))).toBe('2024-03-17 12:00')
})

test('test_c6_a_box_without_tls_is_refused_before_a_connection', async () => {
  writeFileSync(
    join(home, 'mail.json'),
    JSON.stringify({ plain: { host: '127.0.0.1', port: 1, login: 'a@b', password_env: 'MAIL_UNIT_PASSWORD', tls: false } }),
  )
  process.env.MAIL_UNIT_PASSWORD = 'unit-secret'
  const tool = createMailTool({ home })
  await expect(tool.execute({ action: 'list', box: 'plain' }, undefined)).rejects.toThrow(/TLS/i)
  let failed = ''
  try {
    await tool.execute({ action: 'list', box: 'plain' }, undefined)
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error)
  }
  expect(failed).toContain('TLS')
  expect(failed).not.toContain('unit-secret')
})

test('test_c8_an_unknown_action_lists_the_actions_and_the_tool_is_owner_only', async () => {
  writeFileSync(join(home, 'mail.json'), JSON.stringify({}))
  const tool = createMailTool({ home })
  await expect(tool.execute({ action: 'forward', box: 'plain' }, undefined)).rejects.toThrow(
    /list, read, save_attachment, checkpoint, send, draft/,
  )
  await expect(tool.execute({ action: 'list', box: 'plain' }, context('guest-1'))).rejects.toThrow(
    /только в main-сессии владельца/,
  )
})

/** A TCP listener that only counts connections: IMAP and SMTP of a refused letter must never be reached. */
async function countingServer(): Promise<{ server: Server; port: number; connections: () => number }> {
  let connections = 0
  const server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, port: (server.address() as AddressInfo).port, connections: () => connections }
}

function cardRequest(overrides: Partial<MailApprovalRequest>): MailApprovalRequest {
  return {
    box: 'work',
    from: 'owner@example.org',
    to: ['alice@example.org'],
    cc: [],
    subject: 'Договор',
    text: 'Текст письма.',
    attachments: [],
    ...overrides,
  }
}

test('test_c2_the_card_keeps_every_recipient_cc_the_whole_subject_and_the_start_of_the_text', () => {
  const to = Array.from({ length: 60 }, (_, i) => `recipient-${i}@example.org`)
  const cc = ['copy-first@example.org', 'copy-last@example.org']
  const subject = `ТЕМА-НАЧАЛО ${'с'.repeat(MAIL_SUBJECT_LIMIT - 24)} ТЕМА-КОНЕЦ`
  expect(subject.length).toBeLessThanOrEqual(MAIL_SUBJECT_LIMIT)
  const start = 'НАЧАЛО-ТЕКСТА'
  const card = mailConfirmationText(cardRequest({ to, cc, subject, text: `${start} ${'текст '.repeat(2_000)}КОНЕЦ-ТЕКСТА` }))
  expect(card.length).toBeLessThanOrEqual(MAIL_CARD_LIMIT)
  for (const address of [...to, ...cc]) expect(card).toContain(address)
  expect(card).toContain(subject)
  expect(card).toContain(start)
  expect(card).not.toContain('КОНЕЦ-ТЕКСТА')
  expect(card).toContain('owner@example.org')
})

test('test_c2_a_letter_whose_card_would_be_cut_is_refused_before_the_card_imap_and_smtp', async () => {
  const imap = await countingServer()
  const smtp = await countingServer()
  try {
    writeFileSync(
      join(home, 'mail.json'),
      JSON.stringify({
        work: {
          host: '127.0.0.1',
          port: imap.port,
          login: 'owner@example.org',
          password_env: 'MAIL_UNIT_PASSWORD',
          tls: true,
          smtp: { host: '127.0.0.1', port: smtp.port },
        },
      }),
    )
    process.env.MAIL_UNIT_PASSWORD = 'unit-secret'
    let cards = 0
    const tool = createMailTool({
      home,
      approval: async () => {
        cards += 1
        return 'allow'
      },
    })
    const many = Array.from({ length: 150 }, (_, i) => `recipient-${i}@example.org`)
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['150 recipients', { to: many, cc: ['copy@example.org'], subject: 'Договор' }, /адресаты \(151\).*не помещаются/],
      ['a subject of 3800 characters', { to: ['alice@example.org'], subject: 'т'.repeat(3_800) }, /тема письма длиннее 300/],
      ['a reply whose Re: prefix crosses the limit', { to: ['alice@example.org'], subject: 'т'.repeat(MAIL_SUBJECT_LIMIT - 1), reply_to: 7 }, /тема письма длиннее 300/],
    ]
    for (const [what, input, reason] of cases) {
      let failed = ''
      try {
        await tool.execute({ action: 'send', box: 'work', text: 'Текст письма.', ...input }, context('main'))
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error)
      }
      expect(failed, `${what} is refused`).toMatch(reason)
      expect(failed, `${what}: the refusal says nothing was sent`).toContain('Письмо не отправлено')
    }
    await new Promise((done) => setTimeout(done, 100))
    expect(cards, 'no card was drawn').toBe(0)
    expect(imap.connections(), 'no IMAP connection').toBe(0)
    expect(smtp.connections(), 'no SMTP connection').toBe(0)
    expect(() => mailConfirmationText(cardRequest({ to: many }))).toThrow(/не помещаются/)
  } finally {
    imap.server.close()
    smtp.server.close()
  }
})
