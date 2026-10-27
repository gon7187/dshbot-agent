// Composing an outgoing letter of the owner, without a dependency.
//
// The letter is built as a pure string over ASCII: the subject and the file
// names travel as RFC 2047 encoded words, the text and every attachment as
// base64. That keeps the bytes the SMTP server receives independent of the
// encoding of the process and lets `mail send` dot-stuff the whole message as
// text. `packages/tools-mail/src/message.ts` parses the same shape back, so the
// tests and the tool share one description of a letter.

import { randomUUID } from 'node:crypto'

const CRLF = '\r\n'
const BASE64_LINE = 76

export interface MailAttachment {
  /** File name as the owner knows it, without any directory. */
  name: string
  content: Buffer
}

export interface ComposeInput {
  from: string
  to: readonly string[]
  cc: readonly string[]
  subject: string
  text: string
  attachments?: readonly MailAttachment[]
  /** `Message-ID` of the letter being answered. */
  inReplyTo?: string
}

export interface ComposedMail {
  /** The message as SMTP DATA expects it, without the final dot line. */
  raw: string
  messageId: string
}

function headerValue(value: string): string {
  // A header value can never carry a bare line break: it would start a new
  // header of the sender's choosing.
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 encoded word(s) for any value, split on character boundaries. */
function encodedWords(value: string): string {
  // A folded header is decoded word by word, so each word must decode on its own.
  const words: string[] = []
  let current = ''
  for (const char of value) {
    if (current !== '' && Buffer.byteLength(`${current}${char}`, 'utf8') > 45) {
      words.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== '') words.push(current)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

/** RFC 2047 encoded word(s) for a non-ASCII header; ASCII stays readable. */
export function encodeHeader(value: string): string {
  const clean = headerValue(value)
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return encodedWords(clean)
}

function quotedParam(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value) && !/["\\]/.test(value)) return `"${value}"`
  const encoded = Buffer.from(value, 'utf8').toString('base64')
  return `"=?UTF-8?B?${encoded}?="`
}

/** One parameter value with quotes and backslashes escaped, for an ASCII value. */
function quotedValue(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`
}

function asciiPrintable(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value)
}

/**
 * RFC 2231 percent-encoded tokens of one UTF-8 string, one token per character.
 * Bytes that are safe in a parameter stay readable; everything else, including
 * CR and LF, becomes `%XX`, so the header itself is plain ASCII whatever the
 * file name holds. A token is never split, so a multi-byte character never
 * straddles two continuation segments.
 */
function percentEncodedTokens(value: string): string[] {
  const tokens: string[] = []
  for (const character of value) {
    let token = ''
    for (const byte of Buffer.from(character, 'utf8')) {
      const char = String.fromCharCode(byte)
      token += /[A-Za-z0-9._~-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
    tokens.push(token)
  }
  return tokens
}

/**
 * RFC 2231 parameter, in continuation segments so no header line grows without
 * bound. The first segment carries `UTF-8''`; the whole name is preserved.
 */
function extendedParam(key: string, value: string): string {
  const tokens = percentEncodedTokens(value)
  const chunks: string[] = []
  let current = ''
  for (const token of tokens) {
    if (current !== '' && current.length + token.length > 60) {
      chunks.push(current)
      current = ''
    }
    current += token
  }
  if (current !== '' || chunks.length === 0) chunks.push(current)
  return chunks
    .map((chunk, index) => (index === 0 ? `${key}*0*=UTF-8''${chunk}` : `${key}*${index}*=${chunk}`))
    .join(`;${CRLF} `)
}

/**
 * `filename` of Content-Disposition: plain when short and ASCII, otherwise RFC
 * 2231 with the complete name (long or non-ASCII names are never cut).
 */
function filenameParam(value: string): string {
  if (asciiPrintable(value) && value.length <= 60 && !/["\\]/.test(value)) return `filename=${quotedValue(value)}`
  return extendedParam('filename', value)
}

/**
 * `name` of Content-Type: plain when short and ASCII, otherwise RFC 2047
 * encoded words. The complete name is encoded; encoded words fold only between
 * themselves, so each one decodes on its own.
 */
function nameParam(value: string): string {
  if (asciiPrintable(value) && value.length <= 60 && !/["\\]/.test(value)) return `name=${quotedValue(value)}`
  return `name="${encodedWords(value)}"`
}

function base64Lines(content: Buffer): string {
  const encoded = content.toString('base64')
  const lines: string[] = []
  for (let index = 0; index < encoded.length; index += BASE64_LINE) {
    lines.push(encoded.slice(index, index + BASE64_LINE))
  }
  return lines.join(CRLF)
}

function boundaryFor(text: string): string {
  for (;;) {
    const boundary = `=_dshbot_${randomUUID().replace(/[^A-Za-z0-9]/g, '')}`
    if (!text.includes(boundary)) return boundary
  }
}

function domainOf(from: string): string {
  const at = from.lastIndexOf('@')
  const domain = at < 0 ? '' : from.slice(at + 1).trim()
  return /^[A-Za-z0-9.-]+$/.test(domain) ? domain : 'dshbot.local'
}

/** The body part of the letter: text and, when present, the files. */
function bodyOf(input: ComposeInput): { headers: string[]; body: string } {
  const attachments = input.attachments ?? []
  const textHeaders = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ]
  if (attachments.length === 0) {
    return { headers: textHeaders, body: base64Lines(Buffer.from(input.text, 'utf8')) }
  }
  const boundary = boundaryFor(input.text)
  const parts: string[] = []
  parts.push(`--${boundary}`, ...textHeaders, '', base64Lines(Buffer.from(input.text, 'utf8')))
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/octet-stream; ${nameParam(attachment.name)}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${filenameParam(attachment.name)}`,
      '',
      base64Lines(attachment.content),
    )
  }
  parts.push(`--${boundary}--`)
  return { headers: [`Content-Type: multipart/mixed; boundary=${quotedParam(boundary)}`], body: parts.join(CRLF) }
}

/** Builds the message `mail send` and `mail draft` hand to the server. */
export function composeMail(input: ComposeInput): ComposedMail {
  const messageId = `<${randomUUID()}@${domainOf(input.from)}>`
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    `From: ${headerValue(input.from)}`,
    `To: ${input.to.map(headerValue).join(', ')}`,
    ...(input.cc.length === 0 ? [] : [`Cc: ${input.cc.map(headerValue).join(', ')}`]),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ]
  if (input.inReplyTo !== undefined && input.inReplyTo !== '') {
    const reference = headerValue(input.inReplyTo)
    headers.push(`In-Reply-To: ${reference}`, `References: ${reference}`)
  }
  const body = bodyOf(input)
  return {
    raw: `${[...headers, ...body.headers].join(CRLF)}${CRLF}${CRLF}${body.body}${CRLF}`,
    messageId,
  }
}

/** Prefixes `Re: ` unless the subject already answers something. */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`
}
