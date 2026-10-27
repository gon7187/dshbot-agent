// Tools that only read run in parallel inside one assistant step; everything that writes, runs commands, sends
// messages, changes the bot or may ask the owner for a button stays in turn and is a barrier for the calls around it.
// The model answers the owner's `run-<name>` message with a scripted list of tool_use blocks in ONE response; the
// fakes behind the tools take a second per call and write down when each call started and ended, so the test sees
// overlap (parallel) or order (barrier) and not only the total time. Same harness as web-tool.test.ts: the daemon
// runs as a child process in its production configuration against a fake Telegram Bot API, a local DeepSeek stub
// and local HTTP servers; a preload only steers the process environment:
//   * the global fetch sends https://api.deepseek.com requests (the web_search endpoint) to a local search fake;
//   * the name fixture.example.test resolves to a public address and connects to 127.0.0.1, so web_fetch passes the
//     SSRF guard without loosening it.
// The MCP server is a stdio program written next to the test, as in mcp-owner-daemon.test.ts.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete } from './test-support/turn-events.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
/** Every fake call takes this long: two parallel calls fit in the budget, two calls in turn do not. */
const CALL_MS = 1_000
const PARALLEL_BUDGET_MS = 1_800
const SERIAL_FLOOR_MS = 2_000
/** Clock noise between the stub, the fakes and `date` inside the sandbox (all one machine). */
const SKEW_MS = 100

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001
const FIXTURE_HOST = 'fixture.example.test'

const SERVER = 'testsrv'
const MCP_RO = `mcp__${SERVER}__readonly_probe`
const MCP_PLAIN = `mcp__${SERVER}__plain_probe`
const MCP_DESTRUCTIVE = `mcp__${SERVER}__destructive_probe`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- small helpers -------------------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function parseObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // multipart or garbage: keep the raw text
  }
  return { __raw: raw }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const b = asObject(block)
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// --- the scripted model --------------------------------------------------------------------------------

/** One tool_use block of a scripted response. */
interface ToolUse {
  name: string
  input: JsonObject
}

/** What the model asked in one response and what the tools gave back, as the next request carried it. */
interface StepRecord {
  sentAt: number
  /** tool_result texts of the next request, in the order the harness put them there */
  results?: string[]
  nextRequestAt?: number
}

interface Stub {
  server: Server
  origin: string
  /** marker of the owner message to the responses the model gives, in order */
  scripts: Map<string, ToolUse[][]>
  steps: Map<string, StepRecord[]>
  seen: Map<string, number>
}

function messageStart(): string {
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

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function pongStream(): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

function pongMessage(): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  })
}

/** Several tool_use blocks in one assistant message: the case that decides parallel or in turn. */
function toolUsesStream(prefix: string, uses: readonly ToolUse[]): string {
  const blocks = uses.flatMap((use, index) => [
    sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `${prefix}_${index}`, name: use.name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(use.input) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index }),
  ])
  return [messageStart(), ...blocks, messageEnd('tool_use')].join('')
}

/** tool_result texts of the last message of a request, in order; undefined when the last message has none. */
function trailingResults(body: JsonObject): string[] | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const content = asObject(messages[messages.length - 1]).content
  if (!Array.isArray(content)) return undefined
  const results = content.map(asObject).filter((block) => block.type === 'tool_result')
  return results.length === 0 ? undefined : results.map((block) => flatten(block.content))
}

/** The `run-<name>` marker in the newest user message that has one (earlier turns of the session carry their own). */
function lastMarker(body: JsonObject): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of [...messages].reverse().map(asObject)) {
    if (message.role !== 'user') continue
    const found = /run-[a-z0-9]+/.exec(flatten(message.content))
    if (found !== null) return found[0]
  }
  return undefined
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', scripts: new Map(), steps: new Map(), seen: new Map() }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const at = Date.now()
      const body = parseObject(raw)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const marker = lastMarker(body)
      const script = marker === undefined ? undefined : stub.scripts.get(marker)
      if (marker === undefined || script === undefined) {
        res.end(pongStream())
        return
      }
      const records = stub.steps.get(marker) ?? []
      stub.steps.set(marker, records)
      const previous = records[records.length - 1]
      const results = trailingResults(body)
      if (previous !== undefined && results !== undefined && previous.results === undefined) {
        previous.results = results
        previous.nextRequestAt = at
      }
      const index = stub.seen.get(marker) ?? 0
      const uses = script[index]
      if (uses === undefined || (index > 0 && results === undefined)) {
        res.end(pongStream())
        return
      }
      stub.seen.set(marker, index + 1)
      records.push({ sentAt: Date.now() })
      res.end(toolUsesStream(`toolu_${marker}_${index}`, uses))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP ------------------------------------------------------------

interface TgEvent {
  n: number
  method: string
  params: JsonObject
  messageId?: number
}

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeTelegram {
  server: Server
  origin: string
  events: TgEvent[]
  queue: Array<{ update: JsonObject; delivered: boolean }>
  holders: Holder[]
  polls: number
  sentIds: number
  push(update: JsonObject): void
}

function flushQueue(tg: FakeTelegram): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  holder.res.writeHead(200, { 'content-type': 'application/json' })
  holder.res.end(JSON.stringify({ ok: true, result: ready.map((q) => q.update) }))
}

async function startTelegram(): Promise<FakeTelegram> {
  const tg: FakeTelegram = {
    server: undefined as unknown as Server,
    origin: '',
    events: [],
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
      const event: TgEvent = { n: tg.events.length + 1, method, params }
      tg.events.push(event)
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
      let result: unknown = true
      if (method === 'getMe') result = { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
      if (method === 'sendMessage' || method === 'sendRichMessage') {
        tg.sentIds += 1
        event.messageId = 9000 + tg.sentIds
        const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
        result = { message_id: event.messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' }
      }
      reply(200, JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

let nextMessageId = 100
let updateCounter = 5000

function privateMessage(chatId: number, text: string): JsonObject {
  updateCounter += 1
  nextMessageId += 1
  return {
    update_id: updateCounter,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

/** A press of an inline button (the card of the owner) in `chatId`. */
function buttonPress(fromId: number, messageId: number, data: string): JsonObject {
  updateCounter += 1
  return {
    update_id: updateCounter,
    callback_query: {
      id: `cb-${updateCounter}`,
      from: { id: fromId, is_bot: false, first_name: 'T' },
      chat_instance: 'dshbot-test-instance',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: 'private', first_name: 'T' },
        text: 'card',
      },
    },
  }
}

function sentTo(chatId: number): TgEvent[] {
  return world.tg.events.filter(
    (e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId,
  )
}

/** Buttons of the inline keyboards the bot sent to the owner: the cards that wait for an answer. */
interface Card {
  messageId: number
  allow: string
}

function ownerCards(): Card[] {
  const cards: Card[] = []
  for (const event of sentTo(OWNER_CHAT)) {
    const rows = asObject(event.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows) || event.messageId === undefined) continue
    const data = rows
      .flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
      .map((button) => (typeof button.callback_data === 'string' ? button.callback_data : ''))
    // callback_data of an approval is tga1[r]:<kind>:<a|d>:<id>
    const allow = data.find((value) => /^tga1r?:/.test(value) && value.split(':')[2] === 'a')
    if (allow !== undefined) cards.push({ messageId: event.messageId, allow })
  }
  return cards
}

// --- the fakes behind the tools --------------------------------------------------------------------------

/** One call a fake got: its label, when it started and when it answered. */
interface Span {
  label: string
  start: number
  end: number
}

interface Probe {
  server: Server
  origin: string
  port: number
  spans: Span[]
}

/** A local HTTP server whose every request takes CALL_MS and is written down as a span. */
async function startSlowServer(answer: (req: IncomingMessage, body: string) => { label: string; contentType: string; text: string }): Promise<Probe> {
  const probe: Probe = { server: undefined as unknown as Server, origin: '', port: 0, spans: [] }
  probe.server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const start = Date.now()
      const reply = answer(req, body)
      setTimeout(() => {
        probe.spans.push({ label: reply.label, start, end: Date.now() })
        res.writeHead(200, { 'content-type': reply.contentType })
        res.end(reply.text)
      }, CALL_MS)
    })
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', resolve))
  probe.port = (probe.server.address() as AddressInfo).port
  probe.origin = `http://127.0.0.1:${probe.port}`
  return probe
}

/** The search endpoint: the answer carries the query it was asked, so the order of results is visible. */
function searchAnswer(_req: IncomingMessage, body: string): { label: string; contentType: string; text: string } {
  const query = /for the query: ([A-Za-z0-9_-]+)/.exec(body)?.[1] ?? 'unknown'
  const url = `https://found.example/${query}`
  return {
    label: query,
    contentType: 'application/json',
    text: JSON.stringify({
      id: 'msg_search',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
      content: [
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url, title: `${query} title`, page_age: '1 day ago' }] },
        { type: 'text', text: 'summary', citations: [{ type: 'web_search_result_location', url, cited_text: query }] },
      ],
    }),
  }
}

function pageAnswer(req: IncomingMessage): { label: string; contentType: string; text: string } {
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  return {
    label: path,
    contentType: 'text/html; charset=utf-8',
    text: `<html><head><title>Fixture</title></head><body><h1>Heading</h1><p>page ${path}</p></body></html>`,
  }
}

/**
 * A stdio MCP server in plain Node. Each tool call sleeps CALL_MS and appends its start and end to spans.jsonl.
 * readonly_probe: readOnlyHint only. plain_probe: no annotations. destructive_probe: readOnlyHint and destructiveHint.
 */
const MCP_SERVER_SOURCE = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
const delay = Number(process.argv[3])
const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
const tools = [
  { name: 'readonly_probe', description: 'Probe that only reads (parallelprobe).', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'plain_probe', description: 'Probe without hints (parallelprobe).', inputSchema: schema },
  { name: 'destructive_probe', description: 'Probe that reads and destroys (parallelprobe).', inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: true } },
]
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')

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
    const start = Date.now()
    const label = params.name + ':' + ((params.arguments || {}).id || '')
    setTimeout(() => {
      appendFileSync(join(dir, 'spans.jsonl'), JSON.stringify({ label, start, end: Date.now() }) + '\\n')
      send({ id, result: { content: [{ type: 'text', text: 'DONE:' + label }] } })
    }, delay)
  } else {
    send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
})
`

function mcpSpans(): Span[] {
  const file = join(world.mcpDir, 'spans.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Span)
}

// --- the daemon as a child process ----------------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}

interface World {
  tg: FakeTelegram
  stub: Stub
  search: Probe
  fixture: Probe
  home: string
  dshbotHome: string
  mcpDir: string
  daemons: Daemon[]
}

let scratch: string
let preloadFile: string
let mcpServerFile: string
let world: World

const PRELOAD_SOURCE = String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const net = require('node:net')
const dns = require('node:dns')

const FIXTURE_HOST = process.env.PARALLELTEST_FIXTURE_HOST
const SEARCH_STUB = process.env.PARALLELTEST_SEARCH_STUB
const PUBLIC_ADDRESS = '93.184.216.34'

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function patchedConnect(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (options && typeof options === 'object' && options.host === FIXTURE_HOST) {
    options.host = '127.0.0.1'
    delete options.lookup
  }
  return originalConnect.apply(this, args)
}

const originalLookup = dns.promises.lookup
dns.promises.lookup = async function patchedLookup(hostname, ...rest) {
  if (hostname === FIXTURE_HOST) return [{ address: PUBLIC_ADDRESS, family: 4 }]
  return originalLookup.call(this, hostname, ...rest)
}

const realFetch = globalThis.fetch
globalThis.fetch = function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let target
  try {
    target = new URL(url)
  } catch {
    return realFetch(input, init)
  }
  if (target.hostname === 'api.deepseek.com') return realFetch(SEARCH_STUB + target.pathname + target.search, init)
  return realFetch(input, init)
}

syncBuiltinESMExports()
`

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

function spawnDaemon(): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    NODE_OPTIONS: `--import=${pathToFileURL(preloadFile).href}`,
    PARALLELTEST_FIXTURE_HOST: FIXTURE_HOST,
    PARALLELTEST_SEARCH_STUB: world.search.origin,
    ...TURN_EVENTS_ON,
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

function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  // the fixed pause lets the daemon finish connecting its MCP servers and installing handlers after the first poll
  await sleep(1_500)
  return d
}

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

/** Code-like tokens (8+ characters, not a plain lowercase word), digits first: the invitation code. */
function codeLike(texts: string[]): string[] {
  const found: Array<{ token: string; rank: number; at: number }> = []
  let at = 0
  for (const token of texts.join('\n').match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? []) {
    at += 1
    if (token.length < 8 || /^[a-z_]+$/.test(token)) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
    found.push({ token, rank: /\d/.test(token) ? 0 : 1, at })
  }
  found.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
}

function pairingCandidates(fresh: string): string[] {
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
async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

/** The owner invites a guest and the guest joins with the code from the answer. */
async function joinGuest(d: Daemon): Promise<void> {
  const mark = world.tg.events.length
  say(OWNER_CHAT, '/invite')
  const invitation = (): string[] =>
    world.tg.events.slice(mark).filter((e) => e.params.chat_id === OWNER_CHAT).flatMap((e) => deepStrings(e.params))
  await waitFor('an invitation code in the owner chat', () => codeLike(invitation()).length > 0, d)
  const before = sentTo(GUEST_CHAT).length
  say(GUEST_CHAT, codeLike(invitation())[0] as string)
  await waitFor('a greeting for the guest', () => sentTo(GUEST_CHAT).length > before, d)
  // a guest message is accepted about every 3 s: the pause keeps the first question inside the pace limit
  await sleep(3_500)
}

interface TurnTrace {
  /** the responses of the model and what the tools answered */
  steps: StepRecord[]
  /** how long each step took: from the response of the model to the next request */
  durations: number[]
}

/** `chatId` says `run-<name>`, the model answers with `script`, and the turn is awaited to its end. */
async function runTurn(d: Daemon, name: string, script: ToolUse[][], chatId = OWNER_CHAT): Promise<TurnTrace> {
  const marker = `run-${name}`
  world.stub.scripts.set(marker, script)
  const before = turnCompletions(d)
  say(chatId, `${marker} please`)
  await waitForTurnComplete(d, before, `the turn ${marker}`, 60_000)
  const steps = world.stub.steps.get(marker) ?? []
  expect(steps.length, `the model was asked ${script.length} times in ${marker}\n${output(d)}`).toBe(script.length)
  for (const step of steps) expect(step.nextRequestAt, `the results of every step reached the model in ${marker}\n${output(d)}`).toBeDefined()
  return { steps, durations: steps.map((s) => (s.nextRequestAt as number) - s.sentAt) }
}

function spanOf(spans: readonly Span[], label: string): Span {
  const found = spans.find((span) => span.label === label)
  expect(found, `the fake got a call ${label}: ${JSON.stringify(spans.map((s) => s.label))}`).toBeDefined()
  return found as Span
}

/** The second call began after the first one ended: they ran in turn. */
function expectInTurn(first: Span, second: Span, what: string): void {
  expect(second.start + SKEW_MS, `${what}: ${second.label} must start after ${first.label} ended`).toBeGreaterThanOrEqual(first.end)
}

/** Result texts mention the labels in the order of the calls, one label per result. */
function expectOrder(results: readonly string[] | undefined, labels: readonly string[], what: string): void {
  expect(results, `${what}: the results reached the model`).toBeDefined()
  expect(results as string[], `${what}: one result per call`).toHaveLength(labels.length)
  labels.forEach((label, index) => {
    expect((results as string[])[index], `${what}: result ${index} answers ${label}`).toContain(label)
  })
}

/** Nanosecond timestamps `date +%s%N` printed into an exec answer, as milliseconds. */
function execTimes(text: string): number[] {
  return (text.match(/\b\d{19}\b/g) ?? []).map((value) => Number(BigInt(value) / 1_000_000n))
}

const TIMED_SLEEP = 'date +%s%N; sleep 1; date +%s%N'

const search = (query: string): ToolUse => ({ name: 'web_search', input: { query } })
const exec = (): ToolUse => ({ name: 'exec', input: { command: TIMED_SLEEP } })
const fixtureUrl = (path: string): string => `http://${FIXTURE_HOST}:${world.fixture.port}${path}`

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-parallel-tools-')))
  preloadFile = join(scratch, 'parallel-preload.mjs')
  writeFileSync(preloadFile, PRELOAD_SOURCE)
  mcpServerFile = join(scratch, 'mcp-server.mjs')
  writeFileSync(mcpServerFile, MCP_SERVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  mkdirSync(dshbotHome, { recursive: true })
  world = {
    stub: await startStub(),
    tg: await startTelegram(),
    search: await startSlowServer(searchAnswer),
    fixture: await startSlowServer((req) => pageAnswer(req)),
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    mcpDir: mkdtempSync(join(scratch, 'mcp-')),
    daemons: [],
  }
  writeFileSync(
    join(dshbotHome, 'mcp.json'),
    JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [mcpServerFile, world.mcpDir, String(CALL_MS)] } } }),
  )
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
  await closeServer(world.search.server)
  await closeServer(world.fixture.server)
})

// --- tests ----------------------------------------------------------------------------------------------

test('test_c1_two_web_searches_of_one_answer_run_in_parallel_and_the_results_keep_the_order', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const trace = await runTurn(d, 'twosearch', [[search('alphaquery'), search('betaquery')]])

  expect(trace.durations[0], 'two searches of a second each take under 1.8 s together').toBeLessThan(PARALLEL_BUDGET_MS)
  expectOrder(trace.steps[0]?.results, ['alphaquery', 'betaquery'], 'c1')
  expect(world.search.spans.map((s) => s.label).sort(), 'both searches reached the provider').toEqual(['alphaquery', 'betaquery'])
})

test('test_c8_guest_session_runs_two_web_searches_in_parallel_too', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d)
  const trace = await runTurn(d, 'guestsearch', [[search('guestalpha'), search('guestbeta')]], GUEST_CHAT)

  expect(trace.durations[0], 'the guest searches take under 1.8 s together').toBeLessThan(PARALLEL_BUDGET_MS)
  expectOrder(trace.steps[0]?.results, ['guestalpha', 'guestbeta'], 'c8')
})

test('test_c3_web_fetch_with_save_goes_in_turn_and_without_save_in_parallel', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const saved = await runTurn(d, 'fetchsave', [
    [
      { name: 'web_fetch', input: { url: fixtureUrl('/save-a'), save: true } },
      { name: 'web_fetch', input: { url: fixtureUrl('/save-b'), save: true } },
    ],
  ])
  expect(saved.durations[0], 'two saving fetches of a second each take at least 2 s').toBeGreaterThanOrEqual(SERIAL_FLOOR_MS)
  expectInTurn(spanOf(world.fixture.spans, '/save-a'), spanOf(world.fixture.spans, '/save-b'), 'save: true')
  expectOrder(saved.steps[0]?.results, ['save-a', 'save-b'], 'c3 save')

  const plain = await runTurn(d, 'fetchplain', [
    [
      { name: 'web_fetch', input: { url: fixtureUrl('/plain-a') } },
      { name: 'web_fetch', input: { url: fixtureUrl('/plain-b') } },
    ],
  ])
  expect(plain.durations[0], 'two plain fetches of a second each take under 1.8 s together').toBeLessThan(PARALLEL_BUDGET_MS)
  expectOrder(plain.steps[0]?.results, ['plain-a', 'plain-b'], 'c3 plain')
})

test('test_c4_c5_exec_is_a_barrier_between_searches_and_two_execs_go_in_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  const around = await runTurn(d, 'barrier', [[search('firstquery'), exec(), search('lastquery')]])
  const first = spanOf(world.search.spans, 'firstquery')
  const last = spanOf(world.search.spans, 'lastquery')
  const [execStart, execEnd] = execTimes(around.steps[0]?.results?.[1] ?? '')
  expect(execStart, 'exec printed its start time').toBeDefined()
  expect(execEnd, 'exec printed its end time').toBeDefined()
  expect(execStart! + SKEW_MS, 'exec starts only after the result of the first search').toBeGreaterThanOrEqual(first.end)
  expect(last.start + SKEW_MS, 'the second search starts only after exec finished').toBeGreaterThanOrEqual(execEnd!)
  expect(around.durations[0], 'search, exec and search in turn take about 3 s').toBeGreaterThanOrEqual(3 * CALL_MS - SKEW_MS)
  expect(around.steps[0]?.results?.[0], 'first result answers the first search').toContain('firstquery')
  expect(around.steps[0]?.results?.[2], 'third result answers the second search').toContain('lastquery')

  const twice = await runTurn(d, 'twoexec', [[exec(), exec()]])
  const [firstStart, firstEnd] = execTimes(twice.steps[0]?.results?.[0] ?? '')
  const [secondStart] = execTimes(twice.steps[0]?.results?.[1] ?? '')
  expect(firstStart, 'the first exec printed its times').toBeDefined()
  expect(firstEnd, 'the first exec printed its end time').toBeDefined()
  expect(secondStart, 'the second exec printed its start time').toBeDefined()
  expect(secondStart! + SKEW_MS, 'the second exec starts after the first one ended').toBeGreaterThanOrEqual(firstEnd!)
  expect(twice.durations[0], 'two execs of a second each take at least 2 s').toBeGreaterThanOrEqual(SERIAL_FLOOR_MS)
})

test('test_c7_tool_search_is_a_barrier_between_two_searches', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const trace = await runTurn(d, 'searchbarrier', [[search('beforequery'), { name: 'tool_search', input: { query: 'host_exec' } }, search('afterquery')]])

  expectInTurn(spanOf(world.search.spans, 'beforequery'), spanOf(world.search.spans, 'afterquery'), 'tool_search between the searches')
  expect(trace.durations[0], 'the second search waited for the first one').toBeGreaterThanOrEqual(2 * CALL_MS - SKEW_MS)
  expectOrder([trace.steps[0]?.results?.[0] ?? '', trace.steps[0]?.results?.[2] ?? ''], ['beforequery', 'afterquery'], 'c7')
})

test('test_c6_mcp_tool_with_read_only_hint_runs_in_parallel_other_mcp_tools_in_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const load = (name: string): ToolUse[] => [{ name: 'tool_search', input: { query: name } }]
  const twice = (name: string, ids: [string, string]): ToolUse[] => ids.map((id) => ({ name, input: { id } }))

  const readOnly = await runTurn(d, 'mcpreadonly', [load(MCP_RO), twice(MCP_RO, ['r1', 'r2'])])
  expect(readOnly.durations[1], 'two calls of a read-only MCP tool take under 1.8 s together').toBeLessThan(PARALLEL_BUDGET_MS)
  expectOrder(readOnly.steps[1]?.results, ['r1', 'r2'], 'c6 read-only')

  const plain = await runTurn(d, 'mcpplain', [load(MCP_PLAIN), twice(MCP_PLAIN, ['p1', 'p2'])])
  expect(plain.durations[1], 'two calls of an MCP tool without hints take at least 2 s').toBeGreaterThanOrEqual(SERIAL_FLOOR_MS)
  expectInTurn(spanOf(mcpSpans(), `plain_probe:p1`), spanOf(mcpSpans(), `plain_probe:p2`), 'no hints')
  expectOrder(plain.steps[1]?.results, ['p1', 'p2'], 'c6 plain')

  // A destructive tool asks the owner for a button before every call: the test presses "allow" on every card.
  const answered = new Set<number>()
  const presser = setInterval(() => {
    for (const card of ownerCards()) {
      if (answered.has(card.messageId)) continue
      answered.add(card.messageId)
      world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
    }
  }, 100)
  try {
    const destructive = await runTurn(d, 'mcpdestructive', [load(MCP_DESTRUCTIVE), twice(MCP_DESTRUCTIVE, ['d1', 'd2'])])
    expect(answered.size, 'the owner was asked for a card').toBeGreaterThan(0)
    expect(destructive.durations[1], 'two calls of a destructive MCP tool take at least 2 s').toBeGreaterThanOrEqual(SERIAL_FLOOR_MS)
    expectInTurn(spanOf(mcpSpans(), 'destructive_probe:d1'), spanOf(mcpSpans(), 'destructive_probe:d2'), 'read-only and destructive hints')
    expectOrder(destructive.steps[1]?.results, ['d1', 'd2'], 'c6 destructive')
  } finally {
    clearInterval(presser)
  }
})
