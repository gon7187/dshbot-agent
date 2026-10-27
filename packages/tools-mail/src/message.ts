// RFC 5322 / MIME parsing for the `mail` tool, without a dependency.
//
// The tool only needs three things from a letter: the sender, the subject and
// the date of the header, the readable text of the body (HTML translated to
// text) and the attachments with their decoded bytes. Everything here is a
// pure function over the bytes the IMAP server returned; nothing is written
// and nothing is logged.

const CRLF = '\r\n'

/** One decoded MIME part. */
export interface MimePart {
  type: string
  subtype: string
  /** File name of an attachment, already RFC 2047 decoded. */
  filename?: string
  disposition?: string
  /** Decoded content of a leaf. */
  content?: Buffer
  /** Readable text of a `text/*` leaf. */
  text?: string
  children?: MimePart[]
}

export interface ParsedMessage {
  headers: Map<string, string>
  root: MimePart
  /** Attachments in the order of the letter. */
  attachments: Array<{ name: string; size: number; content: Buffer }>
  /** Readable body text (HTML already translated). */
  text: string
}

// --- header helpers ---------------------------------------------------------------------------------

/** Splits a raw message into its header block and body bytes. */
function splitMessage(raw: Buffer): { header: Buffer; body: Buffer } {
  const crlfAt = raw.indexOf('\r\n\r\n')
  if (crlfAt >= 0) return { header: raw.subarray(0, crlfAt), body: raw.subarray(crlfAt + 4) }
  const lfAt = raw.indexOf('\n\n')
  if (lfAt >= 0) return { header: raw.subarray(0, lfAt), body: raw.subarray(lfAt + 2) }
  return { header: raw, body: Buffer.alloc(0) }
}

/** Header map with lower-case names; continuation lines are unfolded. */
function parseHeaders(raw: Buffer): Map<string, string> {
  const headers = new Map<string, string>()
  const text = raw.toString('latin1')
  let name = ''
  let value = ''
  const flush = (): void => {
    if (name !== '') headers.set(name, value.trim())
    name = ''
    value = ''
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      value += ` ${line.trim()}`
      continue
    }
    flush()
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    name = line.slice(0, colon).trim().toLowerCase()
    value = line.slice(colon + 1)
  }
  flush()
  return headers
}

/** Parses `type/subtype; key=value; key="quoted"` into a lower-case map. */
function parseContentType(value: string | undefined): { type: string; subtype: string; params: Map<string, string> } {
  const params = new Map<string, string>()
  if (value === undefined || value.trim() === '') return { type: 'text', subtype: 'plain', params }
  const parts = splitParams(value)
  const kind = (parts.shift() ?? 'text/plain').trim().toLowerCase()
  const slash = kind.indexOf('/')
  const type = slash < 0 ? kind : kind.slice(0, slash)
  const subtype = slash < 0 ? 'plain' : kind.slice(slash + 1)
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim().toLowerCase()
    let raw = part.slice(eq + 1).trim()
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1)
    params.set(key, raw.replace(/\\(.)/g, '$1'))
  }
  return { type, subtype, params }
}

/** Splits a header value on `;` outside quoted strings. */
function splitParams(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string
    if (char === '"' && value[index - 1] !== '\\') quoted = !quoted
    if (char === ';' && !quoted) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Decodes RFC 2047 encoded words; unknown charsets fall back to UTF-8. */
export function decodeWords(value: string): string {
  // RFC 2047: the whitespace between two adjacent encoded words is not part of
  // the text, so a folded long value comes back without invented spaces.
  const joined = value.replace(/(\?=)\s+(?==\?)/g, '$1')
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, payload: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(
              payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
              'latin1',
            )
      return decodeCharset(bytes, charset)
    } catch {
      return payload
    }
  })
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const name = (charset ?? '').trim().toLowerCase()
  if (name === '' || name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii') {
    return bytes.toString('utf8')
  }
  try {
    return new TextDecoder(name).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

/** RFC 2231 percent escapes into bytes; a bare character counts as its own byte. */
function decodePercent(value: string): Buffer {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string
    if (char === '%' && /^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }
    bytes.push(char.charCodeAt(0) & 0xff)
  }
  return Buffer.from(bytes)
}

/**
 * RFC 2231 parameter (`name*=charset'lang'data`, or the `name*0*` continuation
 * form) with its charset honoured. Returns `undefined` when the header has no
 * extended form of the parameter.
 */
function extendedParam(params: Map<string, string>, key: string): string | undefined {
  const direct = params.get(`${key}*`)
  if (direct !== undefined) {
    const match = /^([^']*)'([^']*)'([\s\S]*)$/.exec(direct)
    const charset = match?.[1] ?? 'utf-8'
    const data = match?.[3] ?? direct
    return decodeCharset(decodePercent(data), charset)
  }
  let result = ''
  let charset = 'utf-8'
  for (let index = 0; ; index += 1) {
    const encoded = params.get(`${key}*${index}*`)
    const plain = params.get(`${key}*${index}`)
    if (encoded !== undefined) {
      let data = encoded
      if (index === 0) {
        const match = /^([^']*)'([^']*)'([\s\S]*)$/.exec(encoded)
        if (match !== null) {
          charset = match[1] ?? charset
          data = match[3] ?? ''
        }
      }
      result += decodeCharset(decodePercent(data), charset)
    } else if (plain !== undefined) {
      result += plain
    } else {
      break
    }
  }
  return result === '' ? undefined : result
}

/** Decodes one body according to Content-Transfer-Encoding. */
function decodeTransfer(body: Buffer, encoding: string | undefined): Buffer {
  const value = (encoding ?? '').trim().toLowerCase()
  if (value === 'base64') {
    const text = body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '')
    return Buffer.from(text, 'base64')
  }
  if (value === 'quoted-printable') {
    const text = body.toString('latin1').replace(/=\r?\n/g, '')
    const bytes: number[] = []
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index] as string
      if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16))
        index += 2
        continue
      }
      bytes.push(char.charCodeAt(0) & 0xff)
    }
    return Buffer.from(bytes)
  }
  return body
}

// --- HTML to text -----------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** A deterministic HTML-to-text translation: no active markup reaches the model. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|table|ul|ol)\s*>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  text = decodeEntities(text)
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// --- multipart tree ---------------------------------------------------------------------------------

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`, 'latin1')
  const parts: Buffer[] = []
  let index = body.indexOf(marker)
  while (index >= 0) {
    let start = index + marker.length
    if (body.subarray(start, start + 2).toString('latin1') === '--') break
    if (body[start] === 13 && body[start + 1] === 10) start += 2
    else if (body[start] === 10) start += 1
    const next = body.indexOf(marker, start)
    if (next < 0) break
    let end = next
    if (end >= 2 && body[end - 2] === 13 && body[end - 1] === 10) end -= 2
    else if (end >= 1 && body[end - 1] === 10) end -= 1
    parts.push(body.subarray(start, end))
    index = next
  }
  return parts
}

function parsePart(header: Buffer, body: Buffer): MimePart {
  const headers = parseHeaders(header)
  const contentType = parseContentType(headers.get('content-type'))
  const disposition = headers.get('content-disposition')
  const dispositionParsed = parseContentType(disposition)
  const filenameRaw =
    extendedParam(dispositionParsed.params, 'filename') ??
    extendedParam(contentType.params, 'name') ??
    dispositionParsed.params.get('filename') ??
    contentType.params.get('name')
  const filename = filenameRaw === undefined ? undefined : decodeWords(filenameRaw)
  const part: MimePart = {
    type: contentType.type,
    subtype: contentType.subtype,
    ...(filename === undefined ? {} : { filename }),
    ...(disposition === undefined ? {} : { disposition: dispositionParsed.type }),
  }
  if (contentType.type === 'multipart') {
    const boundary = contentType.params.get('boundary')
    if (boundary !== undefined) {
      part.children = splitMultipart(body, boundary).map((child) => {
        const split = splitMessage(child)
        return parsePart(split.header, split.body)
      })
      return part
    }
  }
  const content = decodeTransfer(body, headers.get('content-transfer-encoding'))
  part.content = content
  if (contentType.type === 'text') {
    const decoded = decodeCharset(content, contentType.params.get('charset'))
    part.text = contentType.subtype === 'html' ? htmlToText(decoded) : decoded.replace(/\r\n/g, '\n')
  }
  return part
}

function collect(part: MimePart, attachments: ParsedMessage['attachments'], texts: string[]): void {
  if (part.children !== undefined) {
    for (const child of part.children) collect(child, attachments, texts)
    return
  }
  const isAttachment = part.disposition === 'attachment' || part.filename !== undefined
  if (isAttachment && part.filename !== undefined) {
    const content = part.content ?? Buffer.alloc(0)
    attachments.push({ name: part.filename, size: content.length, content })
    return
  }
  if (part.type === 'text' && part.text !== undefined && part.text.trim() !== '') texts.push(part.text.trim())
}

/** Parses one complete letter (BODY[]). */
export function parseMessage(raw: Buffer): ParsedMessage {
  const split = splitMessage(raw)
  const headers = parseHeaders(split.header)
  const root = parsePart(split.header, split.body)
  const attachments: ParsedMessage['attachments'] = []
  const texts: string[] = []
  collect(root, attachments, texts)
  return { headers, root, attachments, text: texts.join('\n\n') }
}

/** `Sender Name <a@b>` or `a@b`; the header as the letter carries it, decoded. */
export function senderOf(message: ParsedMessage): string {
  return decodeWords(message.headers.get('from') ?? '').replace(/\s+/g, ' ').trim()
}

export function subjectOf(message: ParsedMessage): string {
  return decodeWords(message.headers.get('subject') ?? '').replace(/\s+/g, ' ').trim()
}

export function dateOf(message: ParsedMessage): Date | undefined {
  const raw = message.headers.get('date')
  if (raw === undefined) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** Header fields fetched for the list: no body and no attachments on the wire. */
export function headersOf(raw: Buffer): Map<string, string> {
  return parseHeaders(splitMessage(raw).header)
}
