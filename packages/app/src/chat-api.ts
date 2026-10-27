// OpenAI-compatible chat completions endpoint for the owner's API column.
//
// A client (for example, xiaozhi-server on the same host) calls one tool of its
// voice model, `ask_openclaw`, which POSTs an OpenAI-shaped request to
// `<base_url>/chat/completions`. Before this module the request went to the
// OpenClaw gateway; now the same request starts an ordinary owner turn in this
// daemon and the final text of that turn is the assistant message.
//
// The module owns no runner state: the caller supplies the turn callback, so
// the HTTP contract, validation, authentication and TLS are tested without a
// model. Only the documented route and method exist; every other path or
// method is a 404, and an invalid body is refused before the callback runs.

import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

/** Largest accepted request body: 64 KiB, the same cap as the local intake. */
export const CHAT_BODY_LIMIT = 64 * 1024

/** The only route of the listener. */
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

/** Host the endpoint binds unless `DSHBOT_OPENAI_HOST` says otherwise. */
export const CHAT_DEFAULT_HOST = '127.0.0.1'

/**
 * Wire model of the column turn. The owner's rule is that the bot itself never
 * spends on `pro`, so whatever the client puts into `model` (including an
 * `openclaw/pro` string) is ignored and the turn always runs on the cheap
 * text-only flash route.
 */
export const CHAT_COLUMN_MODEL = 'deepseek-v4-flash'

/** One accepted request after validation. */
export interface ChatTurnRequest {
  /** Stable device id of the column; one session per id. */
  user: string
  /** The last user message of the request. */
  text: string
  /** `tool_choice: "none"`: the turn runs without any tool schema. */
  noTools: boolean
}

export interface ChatApiOptions {
  /** Bearer token; the caller keeps an empty token from reaching this function. */
  token: string
  /** TCP port of the listener. */
  port: number
  /** Interface to bind; defaults to {@link CHAT_DEFAULT_HOST}. */
  host?: string
  /** PEM certificate and key contents; both or neither, never one alone. */
  tls?: { cert: string; key: string }
  /** Body cap; defaults to {@link CHAT_BODY_LIMIT}. */
  bodyLimit?: number
  /** Runs one column turn and returns the final text of the model turn. */
  runTurn: (request: ChatTurnRequest) => Promise<string>
  /** Journal line; must never receive the token or the body. */
  log: (message: string) => void
}

export interface ChatApiServer {
  /** The port the server was asked to bind. */
  readonly port: number
  /** The interface the server was asked to bind. */
  readonly host: string
  /** True when the listener speaks TLS with the supplied certificate. */
  readonly tls: boolean
  /** Stops accepting connections and closes the open ones. */
  close(): Promise<void>
}

/** Constant-time check of `Authorization: Bearer <token>`. */
function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const given = header.slice(prefix.length)
  const expected = Buffer.from(token, 'utf8')
  const actual = Buffer.from(given, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

interface BodyResult {
  text: string
  tooLarge: boolean
}

/**
 * Reads the body up to `limit` bytes. A declared oversized body is never
 * buffered; a stream that crosses the limit is drained, so the error response
 * can still be written on a keep-alive connection.
 */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    req.resume()
    return Promise.resolve({ text: '', tooLarge: true })
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const settle = (result: BodyResult): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      total += chunk.length
      if (total > limit) {
        req.resume()
        settle({ text: '', tooLarge: true })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => settle({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: false })
    const onError = (): void => settle({ text: '', tooLarge: false })
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

function reply(res: ServerResponse, status: number, json: unknown): void {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(json), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  res.end(body)
}

function errorReply(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { error: { message, type: 'invalid_request_error' } })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Text of an OpenAI content value: a string or the text blocks of an array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const value = asObject(block)
      return value?.type === 'text' && typeof value.text === 'string' ? value.text : ''
    })
    .join('')
}

interface ParsedRequest {
  user: string
  text: string
  noTools: boolean
}

/**
 * Validates the OpenAI-shaped body. The column sends one user message, but a
 * superset is accepted exactly as documented: the last message must come from
 * the user and carry non-empty text. `stream` is refused because the answer is
 * always one complete JSON body.
 */
function parseRequest(raw: string): ParsedRequest | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Request body is not valid JSON' }
  }
  const body = asObject(parsed)
  if (body === undefined) return { error: 'Request body must be a JSON object' }
  const user = typeof body.user === 'string' ? body.user.trim() : ''
  if (user === '') return { error: 'Field "user" must be a non-empty string' }
  if (user.length > 512) return { error: 'Field "user" is too long' }
  if (body.stream === true) return { error: 'Streaming is not supported; send "stream": false' }
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'Field "messages" must be a non-empty array' }
  }
  const last = asObject(messages.at(-1))
  if (last === undefined || last.role !== 'user') {
    return { error: 'The last message must have role "user"' }
  }
  const text = contentText(last.content).trim()
  if (text === '') return { error: 'The last user message must have non-empty content' }
  // `model` is deliberately ignored: the owner's column always runs on the
  // cheap flash route, including when the client names `openclaw/pro`.
  return { user, text, noTools: body.tool_choice === 'none' }
}

function completionBody(text: string, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
  }
}

/**
 * Starts the listener. Unlike the notify intake, this one is a real answer
 * channel: a port that is already in use is reported to the journal and the
 * daemon keeps running, but the caller can see from the returned server that
 * the endpoint is not available.
 */
export function startChatApiServer(options: ChatApiOptions): ChatApiServer {
  const token = options.token
  const host = options.host?.trim() === '' || options.host === undefined ? CHAT_DEFAULT_HOST : options.host
  const bodyLimit = options.bodyLimit !== undefined && options.bodyLimit > 0 ? options.bodyLimit : CHAT_BODY_LIMIT
  let server: Server

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (path !== CHAT_COMPLETIONS_PATH || req.method !== 'POST') {
        req.resume()
        errorReply(res, 404, 'Not found')
        return
      }
      if (!authorized(req.headers.authorization, token)) {
        req.resume()
        errorReply(res, 401, 'Invalid or missing bearer token')
        return
      }
      const body = await readBody(req, bodyLimit)
      if (body.tooLarge) {
        errorReply(res, 400, `Request body is over ${bodyLimit} bytes`)
        return
      }
      const request = parseRequest(body.text)
      if ('error' in request) {
        errorReply(res, 400, request.error)
        return
      }
      // The turn is the only slow part: the caller owns its concurrency, the
      // session and the model, so this module only maps its result to OpenAI.
      const text = await options.runTurn(request)
      reply(res, 200, completionBody(text, CHAT_COLUMN_MODEL))
    } catch (error) {
      options.log(`chat-api: request failed: ${describe(error)}`)
      if (!res.headersSent) errorReply(res, 500, 'The column turn failed')
      else res.end()
    }
  }

  if (options.tls !== undefined) {
    server = createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, (req, res) => {
      void handle(req, res)
    })
  } else {
    server = createHttpServer((req, res) => {
      void handle(req, res)
    })
  }

  let reported = false
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (reported) return
    reported = true
    const code = typeof error.code === 'string' ? error.code : ''
    options.log(
      `chat-api: listener on ${host}:${options.port} failed: ${code === '' ? '' : `${code} `}${describe(error)}`,
    )
  })

  try {
    server.listen(options.port, host)
  } catch (error) {
    options.log(`chat-api: listener on ${host}:${options.port} failed: ${describe(error)}`)
  }

  return {
    port: options.port,
    host,
    tls: options.tls !== undefined,
    close() {
      server.closeAllConnections()
      if (!server.listening) return Promise.resolve()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

/** Reads both PEM files of a TLS listener; a broken pair is not half-used. */
export function readTlsPair(certPath: string, keyPath: string): { cert: string; key: string } | undefined {
  try {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
  } catch {
    return undefined
  }
}
