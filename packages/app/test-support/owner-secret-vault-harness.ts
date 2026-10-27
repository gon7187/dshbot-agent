// The secret vault of the owner, through the daemon: `/secret NAME` makes the next message of the owner the
// value of a secret (a file 0600 in DSHBOT_HOME/secrets, the message deleted from the chat, the value in no
// history, journal, recall or model request), `/secrets` and `/unsecret` list and remove, mcp.json refers to a
// secret as `${secret:NAME}` in env and headers, and exec gets a secret by name as an environment variable. A
// value is scrubbed from every output, also after the secret was deleted or replaced while a server process or a
// background job that got the old value is still alive. Same harness as mcp-owner-daemon.test.ts: the daemon
// runs as a child process against a fake Telegram Bot API and a local DeepSeek stub that plays the main model
// from a script per turn marker (`turn-xx-N`: tool calls first, then the answer `fin <marker>`). The stdio MCP
// server is a small program written next to the test, the SSE one (headers) runs in the test process.
//
// What the tests rely on and what they leave open:
//   - the file of a secret lies in DSHBOT_HOME/secrets and its name contains the name of the secret; its text is
//     the value, a trailing newline is allowed;
//   - the wording of the answers is open: a saved secret is answered with its name and "сохран...", an invalid
//     name with any message; a scrubbed value is replaced by any placeholder;
//   - the bot menu, the model and the stub never see a value, so every surface is searched for the whole value
//     (requests of the model, everything the bot sent, the journal of the daemon, every file under the home of
//     the daemon outside of the secrets directory); output of exec is also searched for pieces of 4 characters;
//   - the clock of the daemon is fake only in the test of the five minute timeout.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export const TEST_TIMEOUT_MS = 280_000
export const WAIT_MS = 45_000
export const TURN_WAIT_MS = 120_000
export const LONG_POLL_HOLD_MS = 20_000

export const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
export const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

export const OWNER_CHAT = 7
export const GUEST_CHAT = 31

export const MARKER_RE = /turn-[a-z]+-\d+/

export const STDIO_SERVER = 'testsrv'
export const BAD_SERVER = 'badsrv'
export const SSE_SERVER = 'ssesrv'
export const ECHO = `mcp__${STDIO_SERVER}__echo`
export const ENVLEAK = `mcp__${STDIO_SERVER}__envleak`
export const WHOAMI = `mcp__${SSE_SERVER}__whoami`
export const QUOTE = `mcp__${SSE_SERVER}__quote`
export const LANG_VALUE = 'en_US.UTF-8'

/** Values with punctuation in every piece of 4 characters, so a leaked piece cannot be a word of a prompt. */
export const SECRET_A = 'Zq~7Xv!K9w^Lp2%Rt@8Jm&Yc*4Nb$Hd'
export const SECRET_B = 'Hy#5Bn?Qe+3Ws=Vf;9Gu:Ta,6Ri.Oj_1'
/** Plain values for the chat tests; the word inside is what recall would look for. */
export const WORD_VALUE = 'sk-zebrawolf-48Qm7xLpVt29'
export const API_VALUE = 'Kd83mXq0TvRz9WpLs2'
export const API_VALUE_NEW = 'Nw41cYb7HgJe5UaFo6'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type JsonObject = Record<string, unknown>

// --- the stdio MCP server of the tests ---------------------------------------------------------------------

/**
 * A stdio MCP server in plain Node. Argument: the data directory of this server. It appends its environment to
 * launches.jsonl at every start. Tools: `echo`, and `envleak`, which answers with the credentials it got in its
 * environment, as a careless server would.
 */
export const FIXTURE_SERVER = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ env: process.env }) + '\\n')

const tools = [
  {
    name: 'echo',
    description: 'Echoes the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'envleak',
    description: 'Answers with the credentials of its environment.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
]

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const text = (value) => ({ content: [{ type: 'text', text: value }] })

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  if (id === undefined) return
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'testsrv', version: '1.0.0' } } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else if (method === 'tools/list') {
    send({ id, result: { tools } })
  } else if (method === 'tools/call') {
    if (params.name === 'echo') send({ id, result: text('ECHO:' + ((params.arguments || {}).text || '')) })
    else if (params.name === 'envleak') send({ id, result: text('ENVAUTH:' + (process.env.API_AUTH || '') + ' ENVTOKEN:' + (process.env.TOKEN || '')) })
    else send({ id, error: { code: -32602, message: 'unknown tool ' + params.name } })
  } else {
    send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
})
`

// --- the SSE MCP server of the tests (headers) ---------------------------------------------------------------

export interface SseServer {
  server: Server
  origin: string
  /** Authorization of every request, in order. */
  authorizations: string[]
  /** Number of event streams the clients opened. */
  streams: number
}

/** The token a client sent: the part of `Authorization: Bearer <token>` after the scheme. */
export const tokenOf = (authorization: string | undefined): string => (authorization ?? '').replace(/^Bearer /, '')

/**
 * The tools of the SSE server depend on the token of the client, like a service that quotes the credentials it
 * was given: `whoami` answers with the whole Authorization header, `quote` repeats the token in its description
 * and in its schema, `peek_<token>` carries the token in its name and `keyed` in a key of its schema.
 */
export function sseTools(token: string): JsonObject[] {
  const readOnly = { readOnlyHint: true, destructiveHint: false }
  return [
    {
      name: 'echo',
      description: 'Echoes the text back over SSE.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: readOnly,
    },
    {
      name: 'whoami',
      description: 'Answers with the Authorization header it got.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
    },
    {
      name: 'quote',
      description: `Quotes the credential ${token} in its description.`,
      inputSchema: {
        type: 'object',
        description: `The credential is ${token}.`,
        properties: {
          text: { type: 'string', description: `Say ${token}`, default: token, enum: [token, 'other'] },
        },
        required: ['text'],
      },
      annotations: readOnly,
    },
    {
      name: `peek_${token}`,
      description: 'A tool whose name carries the credential.',
      inputSchema: { type: 'object', properties: {} },
      annotations: readOnly,
    },
    {
      name: 'keyed',
      description: 'A tool whose schema key carries the credential.',
      inputSchema: { type: 'object', properties: { [token]: { type: 'string' } } },
      annotations: readOnly,
    },
  ]
}

export async function startSse(): Promise<SseServer> {
  const remote: SseServer = { server: undefined as unknown as Server, origin: '', authorizations: [], streams: 0 }
  const streams = new Map<string, ServerResponse>()
  let sessions = 0
  remote.server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
    if (authorization === undefined || !authorization.startsWith('Bearer ') || authorization.length < 10) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    remote.authorizations.push(authorization)
    if (req.method === 'GET' && url.pathname.startsWith('/sse')) {
      sessions += 1
      remote.streams += 1
      const sessionId = `s${sessions}`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      streams.set(sessionId, res)
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`)
      res.on('close', () => streams.delete(sessionId))
      return
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      void readBody(req).then((raw) => {
        const stream = streams.get(url.searchParams.get('sessionId') ?? '')
        res.writeHead(202, { 'content-type': 'text/plain' })
        res.end('Accepted')
        const request = parseObject(raw)
        if (stream === undefined || request.id === undefined) return
        const params = asObject(request.params)
        const reply = (message: JsonObject): void => {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...message })}\n\n`)
        }
        if (request.method === 'initialize') {
          reply({
            result: {
              protocolVersion: params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'ssesrv', version: '1.0.0' },
            },
          })
        } else if (request.method === 'ping') {
          reply({ result: {} })
        } else if (request.method === 'tools/list') {
          reply({ result: { tools: sseTools(tokenOf(authorization)) } })
        } else if (request.method === 'tools/call') {
          const text =
            params.name === 'whoami'
              ? `WHOAMI:${authorization}`
              : params.name === 'quote'
                ? `QUOTE:${tokenOf(authorization)}`
                : `SSE-ECHO:${String(asObject(params.arguments).text ?? '')}`
          reply({ result: { content: [{ type: 'text', text }] } })
        } else {
          reply({ error: { code: -32601, message: `method not found: ${String(request.method)}` } })
        }
      })
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>((resolve) => remote.server.listen(0, '127.0.0.1', resolve))
  remote.origin = `http://127.0.0.1:${(remote.server.address() as AddressInfo).port}`
  return remote
}

// --- timeline of everything the two fake servers saw -------------------------------------------

export interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
  messageId?: number
}

export interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
}

export type Event = TgEvent | DsEvent

export interface Timeline {
  events: Event[]
  seq: number
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

export function parseObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // multipart or garbage: keep the raw text
  }
  return { __raw: raw }
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

export function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

// --- request readers ---------------------------------------------------------------------------------

export function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const b = asObject(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .join('')
}

export interface Block {
  kind: 'text' | 'tool_result'
  text: string
  isError: boolean
}

export function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content, isError: false }]
  if (!Array.isArray(content)) return []
  const found: Block[] = []
  for (const raw of content) {
    const block = asObject(raw)
    if (block.type === 'text' && typeof block.text === 'string') {
      found.push({ kind: 'text', text: block.text, isError: false })
    } else if (block.type === 'tool_result') {
      found.push({ kind: 'tool_result', text: flatten(block.content), isError: block.is_error === true })
    }
  }
  return found
}

export function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

/** Tools a request declares. */
export function toolsOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.tools) ? body.tools.map(asObject) : []
}

/** Index of the last user message with a turn marker, and the marker. */
export function markerMessage(body: JsonObject): { at: number; marker: string } | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const hit = blocksOf(message.content)
      .filter((block) => block.kind === 'text')
      .map((block) => MARKER_RE.exec(block.text))
      .find((match) => match !== null)
    if (hit !== undefined && hit !== null) return { at, marker: hit[0] }
  }
  return undefined
}

/** Tool results the model got with this request, from its last user message. */
export function lastResults(body: JsonObject): Block[] {
  const messages = messagesOf(body)
  const last = messages[messages.length - 1]
  return last !== undefined && last.role === 'user' ? blocksOf(last.content).filter((block) => block.kind === 'tool_result') : []
}

export function lastResultText(call: DsEvent): string {
  return lastResults(call.body)
    .map((block) => block.text)
    .join('\n')
}

// --- the scripted model --------------------------------------------------------------------------

export type Action = { kind: 'tool'; name: string; input: JsonObject } | { kind: 'text'; text: string }

export interface Stub {
  server: Server
  origin: string
  /** Tool calls of a turn of main, by marker; after the last one the model answers `fin <marker>`. */
  scripts: Map<string, Action[]>
}

export const search = (query: string): Action => ({ kind: 'tool', name: 'tool_search', input: { query } })
export const call = (name: string, input: JsonObject = {}): Action => ({ kind: 'tool', name, input })

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function messageStart(): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  })
}

export function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

export function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

export function toolUseStream(id: string, name: string, input: JsonObject): string {
  return [
    messageStart(),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('tool_use'),
  ].join('')
}

export function plainMessage(text: string): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  })
}

/** Assistant messages of the turn the last user message with a marker opened. */
export function turnStep(body: JsonObject, at: number): number {
  return messagesOf(body)
    .slice(at + 1)
    .filter((message) => message.role === 'assistant').length
}

export async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', scripts: new Map() }
  let toolUses = 0
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const found = markerMessage(body)
      if (found === undefined) {
        res.end(textStream('pong'))
        return
      }
      const script = stub.scripts.get(found.marker) ?? []
      const action = script[turnStep(body, found.at)]
      if (action === undefined || action.kind === 'text') {
        res.end(textStream(action?.text ?? `fin ${found.marker}`))
      } else {
        toolUses += 1
        res.end(toolUseStream(`toolu_main_${toolUses}`, action.name, action.input))
      }
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP ----------------------------------------------------

export interface QueuedUpdate {
  update: JsonObject
  delivered: boolean
}

export interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

export interface FakeTelegram {
  server: Server
  origin: string
  queue: QueuedUpdate[]
  holders: Holder[]
  polls: number
  sentIds: number
  push(update: JsonObject): void
}

export function flushQueue(tg: FakeTelegram): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  holder.res.writeHead(200, { 'content-type': 'application/json' })
  holder.res.end(JSON.stringify({ ok: true, result: ready.map((q) => q.update) }))
}

export function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    tg.sentIds += 1
    const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
    return { message_id: 9000 + tg.sentIds, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' }
  }
  return true
}

export async function startTelegram(timeline: Timeline): Promise<FakeTelegram> {
  const tg: FakeTelegram = {
    server: undefined as unknown as Server,
    origin: '',
    queue: [],
    holders: [],
    polls: 0,
    sentIds: 0,
    push(update) {
      tg.queue.push({ update, delivered: false })
      flushQueue(tg)
    },
  }
  tg.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const match = /^\/bot(.+)\/([A-Za-z]+)$/.exec((req.url ?? '').split('?')[0] ?? '')
      const method = match?.[2] ?? ''
      const params = parseObject(raw)
      timeline.seq += 1
      const event: TgEvent = { n: timeline.seq, src: 'tg', method, params }
      timeline.events.push(event)

      const reply = (status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      }
      if (!match || decodeURIComponent(match[1] ?? '') !== BOT_TOKEN) {
        reply(401, JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
        return
      }
      if (method === 'getUpdates') {
        tg.polls += 1
        const offset = typeof params.offset === 'number' ? params.offset : undefined
        tg.queue = tg.queue.filter((q) => !(q.delivered && offset !== undefined && (q.update.update_id as number) < offset))
        if (tg.queue.length > 0) {
          for (const q of tg.queue) q.delivered = true
          reply(200, JSON.stringify({ ok: true, result: tg.queue.map((q) => q.update) }))
          return
        }
        const holder: Holder = {
          res,
          timer: setTimeout(() => {
            const at = tg.holders.indexOf(holder)
            if (at >= 0) tg.holders.splice(at, 1)
            reply(200, JSON.stringify({ ok: true, result: [] }))
          }, LONG_POLL_HOLD_MS),
        }
        tg.holders.push(holder)
        res.on('close', () => {
          clearTimeout(holder.timer)
          const at = tg.holders.indexOf(holder)
          if (at >= 0) tg.holders.splice(at, 1)
        })
        return
      }
      const result = okResult(tg, method, params)
      const sentId = asObject(result).message_id
      if (typeof sentId === 'number') event.messageId = sentId
      reply(200, JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

// --- the fake clock of the daemon (only the test of the timeout uses it) --------------------------------

export const CLOCK_PRELOAD = `
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}
const control = process.env.FAKE_CLOCK_CONTROL
const MAX_DELAY = 2147483647
let offset = 0
let lastSeq = 0

function readCommand() {
  if (!control) return undefined
  try {
    return JSON.parse(readFileSync(control, 'utf8'))
  } catch {
    return undefined
  }
}

const initial = readCommand()
if (initial && typeof initial.seq === 'number') {
  lastSeq = initial.seq
  offset = Number(initial.total) || 0
}

const virtualNow = () => realNow() + offset

globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) return new target(virtualNow())
    return Reflect.construct(target, args, newTarget)
  },
  get(target, prop) {
    if (prop === 'now') return () => virtualNow()
    return Reflect.get(target, prop)
  },
  apply(target) {
    return new target(virtualNow()).toString()
  },
})

const entries = new Map()

function delayOf(delay) {
  const ms = Math.trunc(Number(delay))
  return Number.isFinite(ms) && ms >= 1 && ms <= MAX_DELAY ? ms : 1
}

function patchedSetTimeout(fn, delay, ...args) {
  if (typeof fn !== 'function') return real.setTimeout(fn, delay, ...args)
  const ms = delayOf(delay)
  const entry = { fn, args, ms, repeat: false, due: virtualNow() + ms }
  const handle = real.setTimeout(() => {
    entries.delete(handle)
    fn(...args)
  }, ms)
  entries.set(handle, entry)
  return handle
}

function patchedSetInterval(fn, delay, ...args) {
  if (typeof fn !== 'function') return real.setInterval(fn, delay, ...args)
  const ms = delayOf(delay)
  const entry = { fn, args, ms, repeat: true, due: virtualNow() + ms }
  const handle = real.setInterval(() => {
    entry.due = virtualNow() + ms
    fn(...args)
  }, ms)
  entries.set(handle, entry)
  return handle
}

if (real.setTimeout[promisify.custom]) {
  Object.defineProperty(patchedSetTimeout, promisify.custom, { value: real.setTimeout[promisify.custom], configurable: true })
}

globalThis.setTimeout = patchedSetTimeout
globalThis.setInterval = patchedSetInterval
globalThis.clearTimeout = (handle) => {
  entries.delete(handle)
  return real.clearTimeout(handle)
}
globalThis.clearInterval = (handle) => {
  entries.delete(handle)
  return real.clearInterval(handle)
}

function fire(handle, entry) {
  if (entry.repeat) {
    entry.due = virtualNow() + entry.ms
  } else {
    entries.delete(handle)
    real.clearTimeout(handle)
  }
  try {
    entry.fn(...entry.args)
  } catch (error) {
    process.nextTick(() => {
      throw error
    })
  }
}

const poll = real.setInterval(() => {
  const command = readCommand()
  if (!command || typeof command.seq !== 'number' || command.seq <= lastSeq) return
  lastSeq = command.seq
  offset = Number(command.total) || 0
  const now = virtualNow()
  for (const [handle, entry] of [...entries]) {
    if (handle._destroyed) {
      entries.delete(handle)
    } else if (entry.due <= now || (command.poke && entry.repeat)) {
      fire(handle, entry)
    }
  }
  writeFileSync(control + '.ack', String(lastSeq))
}, 10)
poll.unref()
`

export interface Clock {
  control: string
  seq: number
  total: number
}

export function writeClock(clock: Clock, poke: boolean): void {
  clock.seq += 1
  const staged = `${clock.control}.next`
  writeFileSync(staged, JSON.stringify({ seq: clock.seq, total: clock.total, poke }))
  renameSync(staged, clock.control)
}

export function readAck(clock: Clock): number {
  try {
    return Number(readFileSync(`${clock.control}.ack`, 'utf8')) || 0
  } catch {
    return 0
  }
}

// --- update builders and readers ---------------------------------------------------------------

export let nextMessageId = 100
/** Id of the message that opened the last turn of `turnAs`. */
export let lastTurnMessage = 0
export let updateCounter = 5000

export interface Said {
  update: JsonObject
  messageId: number
}

export function privateMessage(chatId: number, text: string, atMs: number): Said {
  updateCounter += 1
  nextMessageId += 1
  return {
    messageId: nextMessageId,
    update: {
      update_id: updateCounter,
      message: {
        message_id: nextMessageId,
        date: Math.floor(atMs / 1000),
        chat: { id: chatId, type: 'private', first_name: 'T' },
        from: { id: chatId, is_bot: false, first_name: 'T' },
        text,
      },
    },
  }
}

export function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

// --- the daemon as a child process ------------------------------------------------------------------

export interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}

export interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  sse?: SseServer
  /** HOME of the daemon; DSHBOT_HOME lives inside it, as it does for a real install. */
  home: string
  dshbotHome: string
  workspace: string
  runtimeDir: string
  /** Where the stdio MCP servers of the tests write down their launches. */
  dataDir: string
  clock: Clock
  daemons: Daemon[]
}

export let scratch: string
export let serverFile: string
export let clockPreload: string
export let world: World

export const secretsDir = (): string => join(world.dshbotHome, 'secrets')

export function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (entry point of the daemon)').toBe('string')
  return script as string
}

export function spawnDaemon(fakeClock: boolean): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    LANG: LANG_VALUE,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    ...(fakeClock
      ? { FAKE_CLOCK_CONTROL: world.clock.control, NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}` }
      : {}),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn('sh', ['-c', `exec ${startScript()}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const daemon: Daemon = {
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exit: new Promise((resolve) => {
      child.on('close', (code, signal) => {
        daemon.exited = true
        resolve({ code, signal })
      })
    }),
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    daemon.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  world.daemons.push(daemon)
  return daemon
}

export function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

export async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

export async function startDaemon(fakeClock = false): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(fakeClock)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

/** SIGTERM and wait for the exit: the next daemon starts on the same state directory. */
export async function stopDaemon(d: Daemon): Promise<void> {
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 15_000)
  await d.exit
  clearTimeout(timer)
}

/** `chatId` says `text`; the message carries the time of the (possibly fake) clock of the daemon. */
export function say(chatId: number, text: string): number {
  const said = privateMessage(chatId, text, Date.now() + world.clock.total)
  world.tg.push(said.update)
  return said.messageId
}

export function pairingCandidates(fresh: string): string[] {
  const found: Array<{ token: string; rank: number; hinted: number; at: number }> = []
  let at = 0
  for (const line of fresh.split('\n')) {
    const hinted = /code|код|pair/i.test(line) ? 0 : 1
    for (const token of line.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? []) {
      at += 1
      if (token.length < 6) continue
      if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
      if ([BOT_TOKEN, DEEPSEEK_KEY, BOT_TOKEN.split(':')[1] ?? ''].some((s) => s.includes(token))) continue
      found.push({ token, rank: /\d/.test(token) ? 0 : /^[a-z]+$/.test(token) ? 2 : 1, hinted, at })
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.hinted - b.hinted || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
}

/** The first private chat pairs as the owner with the one-time code from the journal. */
export async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore, d)
}

export async function startOwnerDaemon(fakeClock = false): Promise<Daemon> {
  const d = await startDaemon(fakeClock)
  await pairOwner(d)
  return d
}

/** Model requests of the main model for one turn, in order. */
export function turnCalls(marker: string): DsEvent[] {
  return world.timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && e.body.stream !== false && markerMessage(e.body)?.marker === marker,
  )
}

export function replyEvent(chatId: number, marker: string): TgEvent | undefined {
  const reply = new RegExp(`fin ${marker}(?!\\d)`)
  return sentTo(world.timeline, chatId).find((e) => reply.test(JSON.stringify(e.params)))
}

/** `chatId` opens a turn with `marker` and waits for the reply of the model to arrive in the chat. */
export async function turnAs(d: Daemon, chatId: number, marker: string, extra = ''): Promise<DsEvent[]> {
  lastTurnMessage = say(chatId, `${marker} сделай, пожалуйста${extra}`)
  await waitFor(`the reply of turn ${marker}`, () => replyEvent(chatId, marker) !== undefined, d, TURN_WAIT_MS)
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

export const ownerTurn = (d: Daemon, marker: string, extra = ''): Promise<DsEvent[]> => turnAs(d, OWNER_CHAT, marker, extra)

/** Script the model for `marker`, run the turn, return the text of the result of every scripted action. */
export async function scripted(d: Daemon, marker: string, actions: Action[]): Promise<string[]> {
  world.stub.scripts.set(marker, actions)
  const calls = await ownerTurn(d, marker)
  return actions.map((_, i) => {
    const next = calls[i + 1]
    return next === undefined ? '' : lastResultText(next)
  })
}

/** A guest turn is subject to the real 3 second pace of the daemon: the harness waits it out. */
export async function admitGuest(d: Daemon): Promise<void> {
  const ownerMark = world.timeline.seq
  say(OWNER_CHAT, '/invite 2h')
  const linkRe = /t\.me\/dshbot_test_bot\?start=([A-Za-z0-9_-]{8,64})/
  const linkText = (): string =>
    sentTo(world.timeline, OWNER_CHAT)
      .filter((e) => e.n > ownerMark)
      .map((e) => JSON.stringify(e.params))
      .join('\n')
  await waitFor('an invitation link in the owner chat', () => linkRe.test(linkText()), d)
  const code = linkRe.exec(linkText())?.[1] ?? ''
  const before = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, `/start ${code}`)
  await waitFor('a greeting for the guest', () => sentTo(world.timeline, GUEST_CHAT).length > before, d)
}

/** Everything the bot sent into `chatId` after event number `mark`, as text. */
export function textsSince(mark: number, chatId: number): string {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
    .join('\n')
}

/** Ids of the messages the bot deleted in `chatId`. */
export function deletedIn(chatId: number): number[] {
  return world.timeline.events
    .filter((e): e is TgEvent => e.src === 'tg' && e.method === 'deleteMessage' && e.params.chat_id === chatId)
    .map((e) => Number(e.params.message_id))
}

/** The owner asks for the export of the history; the file or the message arrives within a moment. */
export async function exportHistory(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/export')
  await waitFor(
    'the export of the history',
    () => world.timeline.events.some((e) => e.src === 'tg' && e.n > mark && ['sendDocument', 'sendMessage', 'sendRichMessage'].includes(e.method)),
    d,
  )
  await sleep(900)
}

/** The owner types a command and gets everything the bot answers within a moment. */
export async function commandReply(d: Daemon, text: string): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, text)
  await waitFor(`an answer to ${text}`, () => sentTo(world.timeline, OWNER_CHAT).some((e) => e.n > mark), d)
  await sleep(900)
  return textsSince(mark, OWNER_CHAT)
}

// --- the vault on disk and the search for leaks -------------------------------------------------------------

export interface SecretFile {
  name: string
  mode: number
  text: string
}

export function secretFiles(): SecretFile[] {
  const dir = secretsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter(({ path }) => lstatSync(path).isFile())
    .map(({ name, path }) => ({ name, mode: statSync(path).mode & 0o777, text: readFileSync(path, 'utf8') }))
}

/** The file of a secret: its name is the name of the secret (or contains it). */
export function secretNamed(name: string): SecretFile | undefined {
  const files = secretFiles()
  return files.find((file) => file.name === name) ?? files.find((file) => file.name.toUpperCase().includes(name.toUpperCase()))
}

export const valueOf = (file: SecretFile | undefined): string | undefined => file?.text.replace(/\r?\n$/, '')

/** `/secret NAME`, then `value` as the next message; resolves when the file holds the value. */
export async function saveSecret(d: Daemon, name: string, value: string): Promise<number> {
  say(OWNER_CHAT, `/secret ${name}`)
  await sleep(700)
  const valueMessage = say(OWNER_CHAT, value)
  await waitFor(`the secret ${name} to be saved`, () => valueOf(secretNamed(name)) === value, d)
  return valueMessage
}

export function filesUnder(dir: string, skip: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (path === skip) continue
    if (entry.isDirectory()) found.push(...filesUnder(path, skip))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** Every place a value must never reach, with its content: model requests, bot messages, journal, state files. */
export function surfaces(): Array<{ where: string; data: Buffer }> {
  const found: Array<{ where: string; data: Buffer }> = []
  for (const event of world.timeline.events) {
    const where = event.src === 'ds' ? `model request #${event.n}` : `telegram ${event.method} #${event.n}`
    found.push({ where, data: Buffer.from(JSON.stringify(event.src === 'ds' ? event.body : event.params), 'utf8') })
  }
  for (const [i, d] of world.daemons.entries()) {
    found.push({ where: `daemon ${i} stdout`, data: Buffer.from(d.stdout, 'utf8') })
    found.push({ where: `daemon ${i} stderr`, data: Buffer.from(d.stderr, 'utf8') })
  }
  for (const path of filesUnder(world.home, secretsDir())) {
    try {
      found.push({ where: `file ${path.slice(world.home.length)}`, data: readFileSync(path) })
    } catch {
      // a file that vanished while the daemon works
    }
  }
  return found
}

/** Where `value` shows up; an empty list is the goal. */
export function leaksOf(value: string): string[] {
  const needle = Buffer.from(value, 'utf8')
  return surfaces()
    .filter(({ data }) => data.includes(needle))
    .map(({ where }) => where)
}

/** Pieces of 4 characters of a value: a scrubber that only knows the whole value lets them through. */
export function pieces(value: string): string[] {
  const found: string[] = []
  for (let at = 0; at + 4 <= value.length; at += 1) found.push(value.slice(at, at + 4))
  return found
}

export function visiblePiece(text: string, value: string): string | undefined {
  return pieces(value).find((piece) => text.includes(piece))
}

/** Pieces with a punctuation mark inside can occur in no prompt, so they are searched in whole requests too. */
export function leakedPieces(value: string): string[] {
  const odd = pieces(value).filter((piece) => /[^A-Za-z0-9]/.test(piece))
  return surfaces()
    .filter(({ data }) => odd.some((piece) => data.includes(Buffer.from(piece, 'utf8'))))
    .map(({ where }) => where)
}

export function expectNoLeak(value: string, what: string): void {
  expect(leaksOf(value), `${what}: the value must be on no surface`).toEqual([])
}

// --- mcp.json -----------------------------------------------------------------------------------------------

export function writeMcpJson(servers: Record<string, unknown>): void {
  writeFileSync(join(world.dshbotHome, 'mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
}

export function stdioEntry(name: string, env: Record<string, string>): Record<string, unknown> {
  const dir = join(world.dataDir, name)
  mkdirSync(dir, { recursive: true })
  return { command: process.execPath, args: [serverFile, dir], env }
}

export function jsonLines(file: string): JsonObject[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseObject(line))
}

export const launchesOf = (name: string): JsonObject[] => jsonLines(join(world.dataDir, name, 'launches.jsonl'))

/** Save the secrets, stop the daemon, write mcp.json and start it again: the daemon resolves the references at start. */
export async function restartWithMcp(d: Daemon, secrets: Record<string, string>, servers: Record<string, unknown>): Promise<Daemon> {
  for (const [name, value] of Object.entries(secrets)) await saveSecret(d, name, value)
  await stopDaemon(d)
  writeMcpJson(servers)
  return startDaemon()
}

// --- harness lifecycle ----------------------------------------------------------------------------------

export function makeScratch(): string {
  // /var/tmp first: the sandbox gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-vault-test-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  const dir = join(scratch, 'fixture')
  mkdirSync(dir, { recursive: true })
  serverFile = join(dir, 'server.mjs')
  writeFileSync(serverFile, FIXTURE_SERVER)
  clockPreload = join(scratch, 'fake-clock.mjs')
  writeFileSync(clockPreload, CLOCK_PRELOAD)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    dataDir: mkdtempSync(join(scratch, 'data-')),
    clock: { control: join(scratch, `clock-${Math.random().toString(36).slice(2)}`), seq: 0, total: 0 },
    daemons: [],
  }
  mkdirSync(world.workspace, { recursive: true })
  writeClock(world.clock, false)
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
  if (world.sse !== undefined) await closeServer(world.sse.server)
})

// --- [c1] ---------------------------------------------------------------------------------------------------


// --- [c2] ---------------------------------------------------------------------------------------------------


// --- [c3] ---------------------------------------------------------------------------------------------------


// --- [c4] ---------------------------------------------------------------------------------------------------




// --- [c5] ---------------------------------------------------------------------------------------------------


// --- [c6] ---------------------------------------------------------------------------------------------------


// --- [c7] ---------------------------------------------------------------------------------------------------


// --- [c9] ---------------------------------------------------------------------------------------------------

/** The servers of c9: a stdio one with the secret in env and an SSE one with the secret in a header. */
export async function startServersWithSecret(): Promise<Daemon> {
  world.sse = await startSse()
  const d0 = await startOwnerDaemon()
  const d = await restartWithMcp(
    d0,
    { APITOKEN: API_VALUE },
    {
      [STDIO_SERVER]: stdioEntry(STDIO_SERVER, { API_AUTH: 'Bearer ${secret:APITOKEN}', TOKEN: '${secret:APITOKEN}' }),
      [SSE_SERVER]: { type: 'sse', url: `${world.sse.origin}/sse`, headers: { Authorization: 'Bearer ${secret:APITOKEN}' } },
    },
  )
  await waitFor('the servers of mcp.json to start', () => launchesOf(STDIO_SERVER).length > 0 && (world.sse?.streams ?? 0) > 0, d)
  await sleep(2_000)
  expect(asObject(launchesOf(STDIO_SERVER)[0]?.env).API_AUTH, 'the server got the secret').toBe(`Bearer ${API_VALUE}`)
  return d
}

/** The servers still hold the old value: whatever they print, the model, the report and the journal never get it. */
export async function expectOldValueScrubbed(d: Daemon, tag: string): Promise<void> {
  const results = await scripted(d, `turn-${tag}-1`, [
    search(ENVLEAK),
    call(ENVLEAK),
    search(WHOAMI),
    call(WHOAMI),
    search(QUOTE),
    call(QUOTE, { text: 'x' }),
  ])
  expect(results[1], 'the stdio server answered').toContain('ENVAUTH:')
  expect(results[3], 'the SSE server answered').toContain('WHOAMI:')
  expect(results[5], 'the quoting tool answered').toContain('QUOTE:')
  for (const result of [results[1], results[3], results[5]]) {
    expect(result, 'the old value is replaced in the result of a call').not.toContain(API_VALUE)
  }
  const report = await commandReply(d, '/mcp')
  expect(report, 'the report is there').toContain(SSE_SERVER)
  expect(report, 'the report never shows the old value').not.toContain(API_VALUE)
  expectNoLeak(API_VALUE, 'the old value of a secret that a live server still holds')
}



// --- [h1] mcp ------------------------------------------------------------------------------------------------


// --- [c10] --------------------------------------------------------------------------------------------------

/** exec_status windows over the first line `KEY=<value>\n` and the second one after it: whole, cut, tiny. */
export const WINDOWS: Array<{ offset: number; limit: number }> = [
  { offset: 0, limit: 100_000 },
  { offset: 0, limit: 20 },
  { offset: 20, limit: 8 },
  { offset: 10, limit: 30 },
  { offset: 30, limit: 100 },
  { offset: 4, limit: 32 },
  { offset: 3, limit: 5 },
  { offset: 0, limit: 12 },
  { offset: 12, limit: 3 },
  { offset: 25, limit: 12 },
  { offset: 37, limit: 20 },
  { offset: 45, limit: 100 },
]

/** First 16 hex digits of the sha256 of a value: what a command prints to prove that it saw the value. */
export function shaOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** The command wrote the hash of its variable into the workspace: the secret really reached its environment. */
export function expectCommandSaw(value: string): void {
  const file = join(world.workspace, 'hash.txt')
  expect(existsSync(file), 'the command wrote the hash of its secret').toBe(true)
  expect(readFileSync(file, 'utf8').trim(), 'the command saw exactly the value of the secret in its environment').toBe(shaOf(value))
}

export function jobIdOf(text: string): string {
  const id = /"id"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  expect(id, `a background start names the job id: ${text}`).toBeDefined()
  return id as string
}

export async function backgroundJobKeepsTheOldValueScrubbed(mode: 'delete' | 'replace'): Promise<void> {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'LONGKEY', SECRET_A)
  const done = join(world.workspace, 'done.flag')

  // the job prints the value at once and again after the secret is gone
  const command = `printf %s "$LONGKEY" | sha256sum | cut -c1-16 > hash.txt; printf 'KEY=%s\\n' "$LONGKEY"; sleep 22; printf 'AGAIN=%s\\n' "$LONGKEY"; touch done.flag`
  const started = await scripted(d, 'turn-xa-1', [call('exec', { command, secrets: ['LONGKEY'], background: true })])
  const id = jobIdOf(started[0] as string)
  expect(visiblePiece(started[0] as string, SECRET_A), 'the start answer shows no value').toBeUndefined()
  await sleep(2_000)
  expectCommandSaw(SECRET_A)

  if (mode === 'delete') {
    await commandReply(d, '/unsecret LONGKEY')
    await waitFor('the secret to be removed', () => secretNamed('LONGKEY') === undefined, d)
  } else {
    await saveSecret(d, 'LONGKEY', SECRET_B)
  }

  const readers: Action[] = [
    call('exec_status', { id }),
    ...WINDOWS.map(({ offset, limit }) => call('exec_status', { id, offset, limit })),
  ]
  const running = await scripted(d, 'turn-xb-1', [search('exec_status'), ...readers])
  const runningPages = running.slice(1)
  expect(runningPages[0], 'the tail shows the first line of the running job').toContain('KEY=')
  for (const [i, page] of runningPages.entries()) {
    expect(page.length, `status call ${i} answered`).toBeGreaterThan(0)
    expect(visiblePiece(page, SECRET_A), `status call ${i} of the running job shows a piece of the old value:\n${page}`).toBeUndefined()
  }

  await waitFor('the job to finish', () => existsSync(done), d, 60_000)
  // the notice about the end of the job goes through the model before the next owner turn
  await sleep(3_000)
  const finished = (await scripted(d, 'turn-xc-1', [search('exec_status'), ...readers])).slice(1)
  expect(finished[0], 'the tail of the finished job shows the second line').toContain('AGAIN=')
  expect(finished[1], 'the whole output of the finished job has both lines').toContain('AGAIN=')
  for (const [i, page] of finished.entries()) {
    expect(visiblePiece(page, SECRET_A), `status call ${i} of the finished job shows a piece of the old value:\n${page}`).toBeUndefined()
  }

  expect(leaksOf(SECRET_A), 'the old value is on no surface, the message about the end of the job included').toEqual([])
  expect(leakedPieces(SECRET_A), 'no piece of the old value on any surface').toEqual([])
  if (mode === 'replace') expect(leaksOf(SECRET_B), 'the new value is on no surface').toEqual([])
}



// --- [h1] exec -----------------------------------------------------------------------------------------------

