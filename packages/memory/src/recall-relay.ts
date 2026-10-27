import { Agent as HttpAgent, createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'

/**
 * A local relay in front of the model API that carries the recall block of one
 * owner turn without writing it into the session.
 *
 * The runner stores the text of a turn in the durable history, so a block that
 * rode inside that text would pile up in the session and sit in front of every
 * later tail. Here the turn text goes into the history unchanged; the relay
 * appends the block to that one user message in each outgoing request of the
 * turn and forwards everything else byte for byte. Once the turn detaches the
 * block is gone: the next request carries the plain history.
 */
export interface RecallRelay {
  /** Base URL the runner talks to instead of the upstream one. */
  readonly baseUrl: string
  /**
   * Append `block` to the user message that opens the turn, in the model
   * requests of the owner's `main` session only, until the returned function is
   * called.
   *
   * `mainSystem` is a stable part of the `main` system prompt (the daemon
   * passes the owner persona prefix). A request whose system prompt does not
   * carry it belongs to a subagent, a guest or another service session: it
   * passes through byte for byte, even when its last user message repeats the
   * text of the owner turn.
   */
  attach(turnText: string, block: string, mainSystem: string): () => void
  close(): Promise<void>
}

export interface RecallRelayOptions {
  /** Upstream base URL of the model API. */
  upstream: string
  log?: (line: string) => void
}

/**
 * Start the relay, or return `undefined` when the upstream address cannot be
 * parsed or is not HTTP(S): the runner then talks to it directly and a bad
 * address fails the model call as it always did, not the daemon's start.
 */
export async function startRecallRelay(options: RecallRelayOptions): Promise<RecallRelay | undefined> {
  let upstream: URL
  try {
    upstream = new URL(options.upstream)
  } catch {
    return undefined
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return undefined
  const secure = upstream.protocol === 'https:'
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true })
  const basePath = upstream.pathname.replace(/\/+$/, '')
  let attached: { turnText: string; block: string; mainSystem: string } | undefined

  function rewrite(raw: Buffer): Buffer {
    const current = attached
    if (current === undefined || raw.length === 0) return raw
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return raw
    }
    if (body === null || typeof body !== 'object') return raw
    // Only the visible history of `main` opens with this exact turn; the same
    // text in a subagent or guest request is not the owner's turn.
    if (!isMainSessionRequest(body, current.mainSystem)) return raw
    const messages = (body as { messages?: unknown }).messages
    if (!Array.isArray(messages)) return raw
    return withBlock(messages, current.turnText, current.block) ? Buffer.from(JSON.stringify(body), 'utf8') : raw
  }

  function forward(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const headers: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === 'host' || name === 'content-length' || name === 'connection') continue
      headers[name] = value
    }
    if (body.length > 0 || req.method === 'POST' || req.method === 'PUT') headers['content-length'] = body.length
    const target = `${basePath}${req.url ?? '/'}`
    const send = secure ? httpsRequest : httpRequest
    const outgoing = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === '' ? undefined : upstream.port,
        method: req.method,
        path: `${target}`,
        headers,
        agent,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers)
        answer.pipe(res)
        answer.on('error', () => res.destroy())
      },
    )
    // A network failure upstream stays a network failure for the runner.
    outgoing.on('error', (error) => {
      options.log?.(`recall relay: upstream request failed: ${error.message}`)
      res.destroy()
    })
    // A cancelled turn cancels the upstream call too.
    res.on('close', () => {
      if (!res.writableFinished) outgoing.destroy()
    })
    outgoing.end(body)
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('error', () => res.destroy())
    req.on('end', () => {
      let body: Buffer = Buffer.concat(chunks)
      try {
        body = rewrite(body)
      } catch (error) {
        // The block is advisory: the request goes out as the runner sent it.
        options.log?.(`recall relay: block not attached: ${error instanceof Error ? error.message : String(error)}`)
      }
      forward(req, res, body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.unref()
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    attach(turnText, block, mainSystem) {
      const entry = { turnText, block, mainSystem }
      attached = turnText === '' || block === '' || mainSystem === '' ? undefined : entry
      return () => {
        if (attached === entry) attached = undefined
      }
    },
    close() {
      attached = undefined
      agent.destroy()
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}

/** Text of a system prompt given as a string, a text block or an array of them. */
function systemText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => systemText(part)).join('')
  if (value === null || typeof value !== 'object') return ''
  const block = value as { type?: unknown; text?: unknown }
  return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/**
 * Whether this request is the owner's `main` session. The route puts the
 * system prompt in the top-level `system` field; a leading `system`/`developer`
 * message carries the same text on other routes.
 */
function isMainSessionRequest(body: object, mainSystem: string): boolean {
  const request = body as { system?: unknown; messages?: unknown }
  if (systemText(request.system).includes(mainSystem)) return true
  if (!Array.isArray(request.messages)) return false
  for (const raw of request.messages as unknown[]) {
    if (raw === null || typeof raw !== 'object') return false
    const message = raw as { role?: unknown; content?: unknown }
    if (message.role !== 'system' && message.role !== 'developer') return false
    if (systemText(message.content).includes(mainSystem)) return true
  }
  return false
}

/**
 * Append the block to the user message that opened the turn.
 *
 * Only a message whose whole text is `turnText` qualifies: a longer message
 * that merely quotes it (a forwarded task, a subagent prompt) is not the turn
 * and stays untouched. Tool results ride as user messages too; they carry no
 * text of the turn, so the search walks past them to the message that does.
 * Returns whether the body actually changed.
 */
function withBlock(messages: unknown[], turnText: string, block: string): boolean {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as { role?: unknown; content?: unknown } | null
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue
    if (typeof message.content === 'string') {
      if (message.content !== turnText) return false
      message.content = `${turnText}\n\n${block}`
      return true
    }
    if (!Array.isArray(message.content)) continue
    const parts = message.content as unknown[]
    const texts = parts.filter((part): part is { type: 'text'; text: string } => {
      const text = part as { type?: unknown; text?: unknown } | null
      return text !== null && typeof text === 'object' && text.type === 'text' && typeof text.text === 'string'
    })
    // A user message of tool results has no text of its own: the turn is
    // earlier in the history and keeps its block on later requests.
    if (texts.length === 0) continue
    if (texts.map((part) => part.text).join('') !== turnText) return false
    const last = texts[texts.length - 1] as { text: string }
    last.text = `${turnText}\n\n${block}`
    return true
  }
  return false
}
