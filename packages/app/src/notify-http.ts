// Local HTTP intake of external events: `POST /notify` writes to the owner in
// Telegram without a model turn, `POST /wake` starts an ordinary turn of `main`
// with the event as untrusted data. The listener is loopback-only, requires a
// bearer token and refuses bodies over the limit before they are buffered.
//
// The module owns no daemon state: the caller supplies the owner check, the
// delivery and the wake turn, so the same code is exercised by the integration
// test against a real daemon and by any future unit test of the status codes.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** Largest accepted event body: 64 KiB. */
export const NOTIFY_BODY_LIMIT = 64 * 1024

/** The only host the listener ever binds: no LAN, no tunnel on the daemon side. */
export const NOTIFY_BIND_HOST = '127.0.0.1'

export interface NotifyHttpOptions {
  /** Bearer token; the caller keeps an empty token from reaching this function. */
  token: string
  /** TCP port of the listener. */
  port: number
  /** Body cap; defaults to {@link NOTIFY_BODY_LIMIT}. */
  bodyLimit?: number
  /** True when the daemon has a paired owner to write to. */
  ownerBound: () => boolean
  /** Delivers the text to the owner; rejects (or returns false) when it did not. */
  notify: (text: string) => Promise<boolean>
  /** Starts the turn of an external event; must not throw into the response. */
  wake: (text: string) => void | Promise<void>
  /** Journal line; must never receive the token or the body. */
  log: (message: string) => void
}

export interface NotifyHttpServer {
  /** The port the server was asked to bind. */
  readonly port: number
  /** Stops accepting connections and closes the open ones. */
  close(): Promise<void>
}

/** The two routes of the listener and nothing else. */
const ROUTES = new Set(['/notify', '/wake'])

/** Constant-time check of `Authorization: Bearer <token>`. */
function authorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const given = header.slice(prefix.length)
  const expected = Buffer.from(token, 'utf8')
  const actual = Buffer.from(given, 'utf8')
  // The length is not secret (the token length is fixed by its owner); compare
  // only equal-length buffers, because timingSafeEqual throws on a mismatch.
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

interface BodyResult {
  text: string
  tooLarge: boolean
}

/**
 * Reads the request body up to `limit` bytes. A declared oversized body is not
 * buffered at all; the rest of a stream that crosses the limit is drained, so a
 * 413 can still be written on a keep-alive connection.
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
        // Stop buffering but keep draining: the response goes out after this
        // function resolves, and a paused socket would never see it.
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

function reply(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  })
  res.end(body)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Starts the loopback listener. A port that is already in use is reported to
 * the journal and never thrown: external events are an extra channel, and a
 * busy port must not keep the daemon (or Telegram) down.
 */
export function startNotifyHttpServer(options: NotifyHttpOptions): NotifyHttpServer {
  const token = options.token
  const bodyLimit = options.bodyLimit !== undefined && options.bodyLimit > 0 ? options.bodyLimit : NOTIFY_BODY_LIMIT

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (!ROUTES.has(path)) {
        req.resume()
        reply(res, 404, 'not found')
        return
      }
      if (req.method !== 'POST') {
        req.resume()
        reply(res, 405, 'method not allowed', { allow: 'POST' })
        return
      }
      if (!authorized(req.headers.authorization, token)) {
        req.resume()
        reply(res, 401, 'unauthorized')
        return
      }
      if (!options.ownerBound()) {
        req.resume()
        reply(res, 409, 'no owner is paired yet')
        return
      }
      const body = await readBody(req, bodyLimit)
      if (body.tooLarge) {
        reply(res, 413, `body is over ${bodyLimit} bytes`)
        return
      }
      if (body.text.trim() === '') {
        reply(res, 400, 'empty body')
        return
      }
      if (path === '/notify') {
        let delivered = false
        try {
          delivered = await options.notify(body.text)
        } catch (error) {
          options.log(`notify: delivery failed: ${describe(error)}`)
        }
        if (delivered) reply(res, 200, 'ok')
        else reply(res, 502, 'not delivered to the owner')
        return
      }
      // The turn waits in the common `main` queue behind an owner or planned
      // turn: answer now, so the external script is not held for the model.
      reply(res, 202, 'event accepted')
      void Promise.resolve()
        .then(() => options.wake(body.text))
        .catch((error: unknown) => options.log(`notify: wake turn failed: ${describe(error)}`))
    } catch (error) {
      options.log(`notify: request failed: ${describe(error)}`)
      if (!res.headersSent) reply(res, 500, 'internal error')
      else res.end()
    }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  let reported = false
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (reported) return
    reported = true
    const code = typeof error.code === 'string' ? error.code : ''
    options.log(
      `notify: listener on ${NOTIFY_BIND_HOST}:${options.port} failed: ${code === '' ? '' : `${code} `}${describe(error)}`,
    )
  })

  try {
    server.listen(options.port, NOTIFY_BIND_HOST)
  } catch (error) {
    options.log(`notify: listener on ${NOTIFY_BIND_HOST}:${options.port} failed: ${describe(error)}`)
  }

  return {
    port: options.port,
    close() {
      server.closeAllConnections()
      if (!server.listening) return Promise.resolve()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}
