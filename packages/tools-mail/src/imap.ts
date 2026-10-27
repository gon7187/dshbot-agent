// Minimal IMAP4rev1 client for the `mail` tool.
//
// Only what the owner's mailboxes need: LOGIN over TLS, SELECT INBOX (for the
// UIDVALIDITY and the message count), UID SEARCH, UID FETCH, LIST (to find the
// drafts folder), APPEND (a draft of the owner) and LOGOUT. The connection is a
// `node:tls` socket with the default trust store, so `NODE_EXTRA_CA_CERTS` of
// the daemon is honoured and a certificate that does not verify is a connection
// error before any credential is sent. There is no plaintext mode, no STARTTLS
// upgrade and no STORE, COPY or EXPUNGE: the only write is APPEND of a draft.
//
// Responses are parsed as a sequence of text fragments and literal buffers, so
// a message with CRLF, braces or the boundary word inside cannot break the
// parser. Nothing here logs a command line: a LOGIN line carries the password
// and must never reach the journal.

import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/** One mailbox connection, already authenticated. */
export interface ImapConnection {
  readonly socket: TLSSocket
  readonly reader: ImapReader
  /** Next command tag; the server only echoes it. */
  nextTag(): string
  command(text: string): Promise<ImapReply>
  /** A command with one literal at its end (APPEND), waiting for the continuation. */
  commandWithLiteral(prefix: string, literal: Buffer): Promise<ImapReply>
  close(): void
}

/** The untagged lines and the final status of one command. */
export interface ImapReply {
  /** Logical lines of the response; `first` is the text before the first literal. */
  lines: ImapLine[]
  /** Status word of the tagged final line (OK, NO, BAD). */
  status: string
  /** Text after the status word; server prose only, never credentials. */
  text: string
}

/** One logical response line: text fragments interleaved with literal buffers. */
export interface ImapLine {
  segments: Array<string | Buffer>
  /** Text of the line before the first literal. */
  first: string
}

interface Waiter {
  (): void
}

/** Buffered reader of one socket, keeping literal-sized reads exact. */
export class ImapReader {
  private buffer: Buffer = Buffer.alloc(0)
  private failure: Error | undefined
  private closed = false
  private waiters: Waiter[] = []
  private readonly socket: TLSSocket

  constructor(socket: TLSSocket) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.wake()
    })
    socket.on('error', (error: Error) => {
      this.failure = error
      this.wake()
    })
    socket.on('close', () => {
      this.closed = true
      this.wake()
    })
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Throws the transport failure before returning a partial line. */
  private check(): void {
    if (this.failure !== undefined) throw this.failure
  }

  async readUntilCrlf(): Promise<Buffer> {
    for (;;) {
      const at = this.buffer.indexOf('\r\n')
      if (at >= 0) {
        const line = this.buffer.subarray(0, at)
        this.buffer = this.buffer.subarray(at + 2)
        return line
      }
      this.check()
      if (this.closed) {
        if (this.buffer.length === 0) throw new Error('соединение IMAP закрыто сервером')
        const line = this.buffer
        this.buffer = Buffer.alloc(0)
        return line
      }
      await this.wait()
    }
  }

  async readExact(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      this.check()
      if (this.closed) throw new Error('соединение IMAP закрыто до конца литерала')
      await this.wait()
    }
    const data = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return data
  }

  /** One logical line; `{n}` literals are read as bytes, not as text. */
  async readLine(): Promise<ImapLine> {
    const segments: Array<string | Buffer> = []
    let text = ''
    for (;;) {
      const fragment = (await this.readUntilCrlf()).toString('utf8')
      const literal = /\{(\d+)\+?\}$/.exec(fragment)
      if (literal) {
        text += fragment.slice(0, literal.index)
        if (text !== '') {
          segments.push(text)
          text = ''
        }
        segments.push(await this.readExact(Number(literal[1])))
        continue
      }
      text += fragment
      break
    }
    if (text !== '') segments.push(text)
    const first = typeof segments[0] === 'string' ? segments[0] : ''
    return { segments, first }
  }
}

/** Markers of the final line of a tagged command. */
const FINAL = /^(OK|NO|BAD|BYE|PREAUTH)\b/i

class Connection implements ImapConnection {
  readonly reader: ImapReader
  readonly socket: TLSSocket
  private tag = 0

  constructor(socket: TLSSocket) {
    this.socket = socket
    this.reader = new ImapReader(socket)
  }

  nextTag(): string {
    this.tag += 1
    return `m${this.tag}`
  }

  async command(text: string): Promise<ImapReply> {
    const tag = this.nextTag()
    this.socket.write(`${tag} ${text}\r\n`)
    return await this.readReply(tag, [])
  }

  /**
   * Sends one command whose last argument is a literal of `literal.length`
   * bytes. The server may answer with a continuation (`+ ...`), so the bytes
   * are written only after it; a server that refuses the command instead ends
   * with the tagged line and no literal is sent.
   */
  async commandWithLiteral(prefix: string, literal: Buffer): Promise<ImapReply> {
    const tag = this.nextTag()
    this.socket.write(`${tag} ${prefix} {${literal.length}}\r\n`)
    const lines: ImapLine[] = []
    for (;;) {
      const line = await this.reader.readLine()
      if (/^\+/.test(line.first)) break
      if (line.first.startsWith(`${tag} `)) {
        const rest = line.first.slice(tag.length + 1)
        const status = FINAL.exec(rest)?.[1] ?? ''
        if (status !== '') return { lines, status: status.toUpperCase(), text: rest }
      }
      lines.push(line)
      if (/^\* BYE\b/i.test(line.first)) throw new Error('сервер IMAP закрыл соединение')
    }
    this.socket.write(literal)
    this.socket.write('\r\n')
    return await this.readReply(tag, lines)
  }

  private async readReply(tag: string, lines: ImapLine[]): Promise<ImapReply> {
    for (;;) {
      const line = await this.reader.readLine()
      if (line.first.startsWith(`${tag} `)) {
        const rest = line.first.slice(tag.length + 1)
        const status = FINAL.exec(rest)?.[1] ?? ''
        if (status !== '') return { lines, status: status.toUpperCase(), text: rest }
      }
      lines.push(line)
      if (/^\* BYE\b/i.test(line.first)) throw new Error('сервер IMAP закрыл соединение')
    }
  }

  close(): void {
    try {
      this.socket.write(`${this.nextTag()} LOGOUT\r\n`)
    } catch {
      // A closed socket is already the outcome we want.
    }
    this.socket.end()
    this.socket.destroy()
  }
}

export interface ConnectOptions {
  host: string
  port: number
  /** Per-command socket timeout; the whole tool call is bounded by the turn. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** Opens a TLS connection and reads the greeting. The caller authenticates. */
export async function connectImap(options: ConnectOptions): Promise<ImapConnection> {
  const timeoutMs = options.timeoutMs ?? 25_000
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    let settled = false
    const connection = tlsConnect({
      host: options.host,
      port: options.port,
      // SNI and certificate identity use the host name; an IP literal is
      // verified against the IP SAN of the certificate by node itself.
      servername: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(options.host) ? undefined : options.host,
      rejectUnauthorized: true,
    })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      connection.destroy()
      reject(error)
    }
    const connect = (): void => {
      if (settled) return
      settled = true
      resolve(connection)
    }
    connection.setTimeout(timeoutMs, () => fail(new Error('таймаут подключения к серверу IMAP')))
    connection.once('secureConnect', connect)
    connection.once('error', (error: Error) => fail(error))
    connection.once('close', () => fail(new Error('сервер IMAP закрыл соединение до приветствия')))
    if (options.signal !== undefined) {
      const abort = (): void => fail(new Error('подключение к серверу IMAP отменено'))
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('таймаут операции IMAP')))
  const connection = new Connection(socket)
  try {
    // The greeting is an untagged `* OK ...` line; nothing to check beyond
    // that it arrived before a command is sent.
    await connection.reader.readLine()
    return connection
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** Escapes one IMAP quoted string. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface SelectInfo {
  uidvalidity: number
  exists: number
  uidnext?: number
}

/** SELECT INBOX and read the UIDVALIDITY the checkpoint is tied to. */
export async function selectInbox(connection: ImapConnection): Promise<SelectInfo> {
  const reply = await connection.command('SELECT INBOX')
  if (reply.status !== 'OK') throw new Error('не удалось открыть ящик INBOX')
  let exists = 0
  let uidvalidity: number | undefined
  let uidnext: number | undefined
  for (const line of reply.lines) {
    const existsMatch = /^\*\s+(\d+)\s+EXISTS\b/i.exec(line.first)
    if (existsMatch) exists = Number(existsMatch[1])
    const validityMatch = /\[UIDVALIDITY\s+(\d+)\]/i.exec(line.first)
    if (validityMatch) uidvalidity = Number(validityMatch[1])
    const nextMatch = /\[UIDNEXT\s+(\d+)\]/i.exec(line.first)
    if (nextMatch) uidnext = Number(nextMatch[1])
  }
  if (uidvalidity === undefined) throw new Error('сервер IMAP не сообщил UIDVALIDITY ящика')
  return { uidvalidity, exists, ...(uidnext === undefined ? {} : { uidnext }) }
}

/** Authenticates with LOGIN. A refusal is an authorization error without server prose. */
export async function login(connection: ImapConnection, user: string, password: string): Promise<void> {
  const reply = await connection.command(`LOGIN ${quote(user)} ${quote(password)}`)
  if (reply.status !== 'OK') {
    throw new Error('ошибка авторизации: сервер IMAP отклонил логин или пароль')
  }
}

/** One mailbox of `LIST` with the attributes that name its role. */
export interface MailboxInfo {
  name: string
  attributes: string[]
}

function unquoteName(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return value
}

/** Every mailbox of the account; a server without LIST support answers empty. */
export async function listMailboxes(connection: ImapConnection): Promise<MailboxInfo[]> {
  const reply = await connection.command('LIST "" "*"')
  if (reply.status !== 'OK') return []
  const boxes: MailboxInfo[] = []
  for (const line of reply.lines) {
    const match = /^\*\s+(?:LIST|XLIST)\s+\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)$/i.exec(line.first)
    if (match === null) continue
    const attributes = (match[1] ?? '').trim().split(/\s+/).filter((item) => item !== '')
    boxes.push({ name: unquoteName(match[2] ?? ''), attributes })
  }
  return boxes
}

/** The folder that carries `\Drafts`, or the conventional `Drafts` when the server does not say. */
export function draftsMailbox(boxes: readonly MailboxInfo[]): string {
  const found = boxes.find((box) => box.attributes.some((attribute) => attribute.toLowerCase() === '\\drafts'))
  if (found !== undefined) return found.name
  const named = boxes.find((box) => /^(?:drafts|черновики)$/i.test(box.name))
  return named?.name ?? 'Drafts'
}

/** APPEND one letter to a mailbox with the `\Draft` flag. */
export async function appendMailbox(
  connection: ImapConnection,
  mailbox: string,
  raw: Buffer,
): Promise<void> {
  const reply = await connection.commandWithLiteral(`APPEND ${quote(mailbox)} (\\Draft)`, raw)
  if (reply.status !== 'OK') throw new Error(`сервер IMAP не принял черновик в папку ${mailbox}`)
}

/** UIDs of the SEARCH result, in server order. */export function searchUids(reply: ImapReply): number[] {
  if (reply.status !== 'OK') throw new Error('сервер IMAP отклонил поиск писем')
  const found: number[] = []
  for (const line of reply.lines) {
    const match = /^\*\s+SEARCH\b(.*)$/i.exec(line.first)
    if (!match) continue
    for (const token of (match[1] ?? '').trim().split(/\s+/)) {
      if (/^\d+$/.test(token)) found.push(Number(token))
    }
  }
  return found
}

export interface FetchResult {
  uid: number
  /** Every literal of the response, in order (header block or full message). */
  literals: Buffer[]
}

/** Parses the tokens of one FETCH response; only UID atoms and literals matter. */
function tokensOf(line: ImapLine): Array<{ atom?: string; literal?: Buffer }> {
  const tokens: Array<{ atom?: string; literal?: Buffer }> = []
  for (const segment of line.segments) {
    if (Buffer.isBuffer(segment)) {
      tokens.push({ literal: segment })
      continue
    }
    let index = 0
    while (index < segment.length) {
      const char = segment[index] as string
      if (char === ' ' || char === '\t') {
        index += 1
        continue
      }
      if (char === '"') {
        let value = ''
        index += 1
        while (index < segment.length) {
          const current = segment[index] as string
          if (current === '\\' && index + 1 < segment.length) {
            value += segment[index + 1] as string
            index += 2
            continue
          }
          if (current === '"') {
            index += 1
            break
          }
          value += current
          index += 1
        }
        tokens.push({ atom: value })
        continue
      }
      if (char === '(' || char === ')') {
        index += 1
        continue
      }
      let atom = ''
      while (index < segment.length) {
        const current = segment[index] as string
        if (current === ' ' || current === '\t' || current === '(' || current === ')') break
        atom += current
        index += 1
      }
      tokens.push({ atom })
    }
  }
  return tokens
}

/** UID FETCH of the given set; `item` is an IMAP fetch item. */
export async function fetchMessages(connection: ImapConnection, set: string, item: string): Promise<FetchResult[]> {
  const reply = await connection.command(`UID FETCH ${set} (UID ${item})`)
  if (reply.status !== 'OK') throw new Error('сервер IMAP отклонил чтение писем')
  const results: FetchResult[] = []
  for (const line of reply.lines) {
    if (!/^\*\s+\d+\s+FETCH\b/i.test(line.first)) continue
    const tokens = tokensOf(line)
    let uid: number | undefined
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.atom?.toUpperCase() !== 'UID') continue
      const value = tokens[index + 1]?.atom
      if (value !== undefined && /^\d+$/.test(value)) uid = Number(value)
      break
    }
    if (uid === undefined) continue
    const literals = tokens.flatMap((token) => (token.literal === undefined ? [] : [token.literal]))
    results.push({ uid, literals })
  }
  // The server is not required to answer in set order.
  results.sort((left, right) => left.uid - right.uid)
  return results
}

/** Closes a connection without reporting a failed LOGOUT as a tool error. */
export function closeQuietly(connection: ImapConnection | undefined): void {
  try {
    connection?.close()
  } catch {
    // Already closed.
  }
}
