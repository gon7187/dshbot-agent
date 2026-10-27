// How composeMail writes a long ASCII file name: `name` of Content-Type as RFC 2047 encoded words and `filename` of
// Content-Disposition as RFC 2231 continuations, both carrying the whole name. The headers are decoded here by hand,
// not through message.ts, so the test does not share a mistake with the parser of the tool.

import { expect, test } from 'vitest'

import { composeMail } from './src/compose.js'

const LONG_NAME = `${'a'.repeat(210)}.csv`

function attachmentHeaders(raw: string): { contentType: string; disposition: string } {
  const part = raw.split(/\r\n--=_dshbot_[A-Za-z0-9]+(?:--)?\r\n?/).find((chunk) => chunk.includes('application/octet-stream'))
  expect(part).toBeDefined()
  const head = (part ?? '').split('\r\n\r\n')[0] ?? ''
  // Unfold: a header continues on lines that start with whitespace.
  const lines = head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')
  const contentType = lines.find((line) => /^content-type:/i.test(line)) ?? ''
  const disposition = lines.find((line) => /^content-disposition:/i.test(line)) ?? ''
  return { contentType, disposition }
}

function decodeRfc2047(value: string): string {
  const words = value.trim().split(/\s+/)
  const bytes: Buffer[] = []
  for (const word of words) {
    const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/i.exec(word)
    expect(match, `not an RFC 2047 word: ${word}`).not.toBeNull()
    bytes.push(Buffer.from(match?.[1] ?? '', 'base64'))
  }
  return Buffer.concat(bytes).toString('utf8')
}

function decodeRfc2231(header: string, key: string): string {
  const segments = [...header.matchAll(new RegExp(`${key}\\*(\\d+)\\*=([^;\\s]+)`, 'g'))]
  expect(segments.length).toBeGreaterThan(1)
  const ordered = segments.map((match) => ({ index: Number(match[1]), value: match[2] ?? '' }))
  ordered.forEach((segment, position) => expect(segment.index).toBe(position))
  const joined = ordered.map((segment) => segment.value).join('')
  expect(joined.startsWith("UTF-8''")).toBe(true)
  return decodeURIComponent(joined.slice("UTF-8''".length))
}

test('test_h1_long_ascii_name_is_rfc2047_in_name_and_rfc2231_in_filename', () => {
  const { raw } = composeMail({
    from: 'owner@example.org',
    to: ['ivan@example.org'],
    cc: [],
    subject: 'Файлы',
    text: 'Во вложении.',
    attachments: [{ name: LONG_NAME, content: Buffer.from('id,total\n1,10\n') }],
  })
  const { contentType, disposition } = attachmentHeaders(raw)

  const name = /;\s*name="([^"]*)"/i.exec(contentType)
  expect(name, contentType).not.toBeNull()
  expect(name?.[1]).not.toContain(LONG_NAME)
  expect(name?.[1]).toMatch(/^=\?UTF-8\?B\?/i)
  expect(decodeRfc2047(name?.[1] ?? '')).toBe(LONG_NAME)

  expect(disposition).not.toMatch(/;\s*filename="/i)
  expect(decodeRfc2231(disposition, 'filename')).toBe(LONG_NAME)

  // Every physical header line stays within the 998-octet limit of RFC 5322.
  for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998)
})

test('test_h1_short_ascii_name_stays_plain', () => {
  const { raw } = composeMail({
    from: 'owner@example.org',
    to: ['ivan@example.org'],
    cc: [],
    subject: 'Файлы',
    text: 'Во вложении.',
    attachments: [{ name: 'report.csv', content: Buffer.from('x') }],
  })
  const { contentType, disposition } = attachmentHeaders(raw)
  expect(contentType).toMatch(/;\s*name="report\.csv"/)
  expect(disposition).toMatch(/;\s*filename="report\.csv"/)
})
