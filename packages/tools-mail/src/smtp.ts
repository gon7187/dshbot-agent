// The SMTP half of the `mail` tool: one letter, one connection, no retries.
//
// Two shapes are supported, chosen by the port the owner wrote in `mail.json`:
// 465 starts TLS at once (implicit TLS), every other port speaks clear text
// until `STARTTLS` and only then offers credentials. The certificate is always
// verified against the default trust store (plus `NODE_EXTRA_CA_CERTS` of the
// daemon), so an untrusted server is an error before AUTH and no password ever
// travels unencrypted.
//
// Errors of this module are prefixed with `SMTP: ` so the tool can answer with
// a connection error of the right side of the mailbox. A password is never part
// of an error text; the caller scrubs the value as the last line of defence.

import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

const CRLF = '\r\n'

export interface SmtpSettings {
  host: string
  port: number
}

export interface SmtpOptions extends SmtpSettings {
  user: string
  password: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface OutgoingMail {
  from: string
  to: readonly string[]
  cc: readonly string[]
  /** The letter as {@link composeMail} built it, ASCII only, CRLF line ends. */
  raw: string
}

interface Reply {
  code: number
  text: string
}

class Reader {
  private socket: Socket | TLSSocket
  private buffer: Buffer = Buffer.alloc(0)
  private failure: Error | undefined
  private closed = false
  private waiters: Array<() => void> = []
  private readonly onData: (chunk: Buffer) => void
  private readonly onError: (error: Error) => void
  private readonly onClose: () => void

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.onData = (chunk: Buffer): void => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.wake()
    }
    this.onError = (error: Error): void => {
      this.failure = error
      this.wake()
    }
    this.onClose = (): void => {
      this.closed = true
      this.wake()
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  /** Stops reading the socket before the plain connection is wrapped in TLS. */
  detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.buffer = Buffer.alloc(0)
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }

  async readLine(): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf(CRLF)
      if (at >= 0) {
        const line = this.buffer.subarray(0, at).toString('utf8')
        this.buffer = this.buffer.subarray(at + 2)
        return line
      }
      if (this.failure !== undefined) throw this.failure
      if (this.closed) throw new Error('SMTP: сервер закрыл соединение')
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function localName(): string {
  return 'dshbot.local'
}

function withTimeout(socket: Socket | TLSSocket, timeoutMs: number, what: string): void {
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SMTP: таймаут ${what}`)))
}

async function openTls(options: SmtpOptions): Promise<TLSSocket> {
  const timeoutMs = options.timeoutMs ?? 25_000
  return await new Promise<TLSSocket>((resolve, reject) => {
    let settled = false
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      servername: isIpLiteral(options.host) ? undefined : options.host,
      rejectUnauthorized: true,
    })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error('SMTP: таймаут подключения к серверу')))
    socket.once('secureConnect', () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
    socket.once('error', fail)
    socket.once('close', () => fail(new Error('SMTP: сервер закрыл соединение до приветствия')))
    if (options.signal !== undefined) {
      const abort = (): void => fail(new Error('SMTP: подключение отменено'))
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
}

async function openPlain(options: SmtpOptions): Promise<Socket> {
  const timeoutMs = options.timeoutMs ?? 25_000
  return await new Promise<Socket>((resolve, reject) => {
    let settled = false
    const socket = netConnect({ host: options.host, port: options.port })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error('SMTP: таймаут подключения к серверу')))
    socket.once('connect', () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
    socket.once('error', fail)
    socket.once('close', () => fail(new Error('SMTP: сервер закрыл соединение до подключения')))
    if (options.signal !== undefined) {
      const abort = (): void => fail(new Error('SMTP: подключение отменено'))
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
}

async function upgradeTls(plain: Socket, options: SmtpOptions, reader: Reader): Promise<{ socket: TLSSocket; reader: Reader }> {
  reader.detach()
  const timeoutMs = options.timeoutMs ?? 25_000
  const socket = await new Promise<TLSSocket>((resolve, reject) => {
    let settled = false
    const secure = tlsConnect({
      socket: plain,
      servername: isIpLiteral(options.host) ? undefined : options.host,
      rejectUnauthorized: true,
    })
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      secure.destroy()
      reject(error)
    }
    secure.setTimeout(timeoutMs, () => fail(new Error('SMTP: таймаут TLS-соединения')))
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      resolve(secure)
    })
    secure.once('error', fail)
    secure.once('close', () => fail(new Error('SMTP: сервер закрыл соединение во время TLS')))
  })
  return { socket, reader: new Reader(socket) }
}

async function readReply(reader: Reader): Promise<Reply> {
  const lines: string[] = []
  for (;;) {
    const line = await reader.readLine()
    lines.push(line)
    if (/^\d{3}(?:\s|$)/.test(line)) {
      return { code: Number(line.slice(0, 3)), text: lines.join('\n') }
    }
    if (lines.length > 200) throw new Error('SMTP: сервер прислал слишком длинный ответ')
  }
}

async function command(reader: Reader, socket: Socket | TLSSocket, text: string): Promise<Reply> {
  socket.write(`${text}${CRLF}`)
  return await readReply(reader)
}

interface Extended {
  mechanisms: string[]
  startTls: boolean
  encrypted: boolean
}

async function ehlo(reader: Reader, socket: Socket | TLSSocket, encrypted: boolean): Promise<Extended> {
  const reply = await command(reader, socket, `EHLO ${localName()}`)
  if (reply.code !== 250) throw new Error(`SMTP: сервер отклонил EHLO (${reply.code})`)
  const mechanisms: string[] = []
  let startTls = false
  for (const line of reply.text.split('\n')) {
    if (/^\d{3}[ -]STARTTLS\b/i.test(line.trim())) startTls = true
    const auth = /\bAUTH[ =](.+)$/i.exec(line.replace(/^\d{3}[ -]/, '').trim())
    if (auth !== null) {
      for (const name of (auth[1] ?? '').trim().split(/\s+/)) {
        if (name !== '') mechanisms.push(name.toUpperCase())
      }
    }
  }
  return { mechanisms, startTls, encrypted }
}

function plainToken(user: string, password: string): string {
  return Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')
}

async function authenticate(reader: Reader, socket: Socket | TLSSocket, options: SmtpOptions, mechanisms: string[]): Promise<void> {
  const token = plainToken(options.user, options.password)
  if (mechanisms.length === 0 || mechanisms.includes('PLAIN')) {
    const reply = await command(reader, socket, `AUTH PLAIN ${token}`)
    if (reply.code === 235) return
    if (reply.code === 334) {
      const continued = await command(reader, socket, token)
      if (continued.code === 235) return
      throw new Error('SMTP: сервер отклонил логин или пароль')
    }
    if (reply.code !== 504 && reply.code !== 500 && mechanisms.length > 0) {
      throw new Error('SMTP: сервер отклонил авторизацию')
    }
  }
  if (mechanisms.includes('LOGIN') || mechanisms.length === 0) {
    const asked = await command(reader, socket, 'AUTH LOGIN')
    if (asked.code !== 334) throw new Error('SMTP: сервер отклонил авторизацию')
    const user = await command(reader, socket, Buffer.from(options.user, 'utf8').toString('base64'))
    if (user.code !== 334) throw new Error('SMTP: сервер отклонил логин или пароль')
    const password = await command(reader, socket, Buffer.from(options.password, 'utf8').toString('base64'))
    if (password.code !== 235) throw new Error('SMTP: сервер отклонил логин или пароль')
    return
  }
  throw new Error('SMTP: сервер не предлагает ни AUTH PLAIN, ни AUTH LOGIN')
}

/** Escapes one address for an SMTP command: `<...>` with CR/LF and `>` removed. */
function envelopeAddress(address: string): string {
  return `<${address.replace(/[\r\n<>]/g, '').trim()}>`
}

/** Dot-stuffing of SMTP DATA: a line that starts with `.` gets one more. */
function dotStuff(raw: string): string {
  const normalized = raw.replace(/\r?\n/g, CRLF)
  const stuffed = normalized.replace(/(^|\r\n)\./g, '$1..')
  return stuffed.endsWith(CRLF) ? stuffed : `${stuffed}${CRLF}`
}

/**
 * Sends one letter and returns the `Message-ID` the server accepted. Throws on
 * every refusal; the caller maps the text to the tool answer.
 */
export async function sendSmtp(options: SmtpOptions, mail: OutgoingMail): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 25_000
  const implicit = options.port === 465
  let socket: Socket | TLSSocket
  let reader: Reader
  if (implicit) {
    socket = await openTls(options)
    reader = new Reader(socket)
  } else {
    socket = await openPlain(options)
    reader = new Reader(socket)
  }
  try {
    withTimeout(socket, timeoutMs, 'операции SMTP')
    const greeting = await readReply(reader)
    if (greeting.code !== 220) throw new Error(`SMTP: сервер ответил ${greeting.code} на подключение`)
    let extended = await ehlo(reader, socket, implicit)
    if (!implicit && !extended.encrypted) {
      const started = await command(reader, socket, 'STARTTLS')
      if (started.code !== 220) throw new Error('SMTP: сервер отказал в STARTTLS')
      const upgraded = await upgradeTls(socket, options, reader)
      socket = upgraded.socket
      reader = upgraded.reader
      withTimeout(socket, timeoutMs, 'операции SMTP')
      extended = await ehlo(reader, socket, true)
    }
    await authenticate(reader, socket, options, extended.mechanisms)

    const sender = await command(reader, socket, `MAIL FROM:${envelopeAddress(mail.from)}`)
    if (sender.code !== 250) throw new Error(`SMTP: сервер отклонил отправителя (${sender.code})`)
    for (const recipient of [...mail.to, ...mail.cc]) {
      const accepted = await command(reader, socket, `RCPT TO:${envelopeAddress(recipient)}`)
      if (accepted.code !== 250 && accepted.code !== 251) {
        throw new Error(`SMTP: сервер отклонил адресата (${accepted.code})`)
      }
    }
    const data = await command(reader, socket, 'DATA')
    if (data.code !== 354) throw new Error(`SMTP: сервер не принял DATA (${data.code})`)
    socket.write(`${dotStuff(mail.raw)}.${CRLF}`)
    const queued = await readReply(reader)
    if (queued.code !== 250) throw new Error(`SMTP: сервер не принял письмо (${queued.code})`)
    try {
      socket.write(`QUIT${CRLF}`)
    } catch {
      // The letter is accepted; a failed goodbye is not an error.
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    throw new Error(text.startsWith('SMTP:') ? text : `SMTP: ${text}`)
  } finally {
    socket.end()
    socket.destroy()
  }
}
