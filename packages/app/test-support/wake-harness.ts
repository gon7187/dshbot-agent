// Shared harness of the wake-up tests (wake-clock*.test.ts and wake-turns*.test.ts): the fake DeepSeek
// stub, the fake Telegram Bot API, the fake clock, the module hooks, the daemon child process and the
// test world. Importing this module from a test file registers the beforeAll/afterAll/beforeEach/afterEach
// hooks of the file and gives it a fresh world per test.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete } from './turn-events.js'


const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
const SETTLE_MS = 250
/** A wake-up that has just fallen due needs longer to reach the model: the clock must not move under a turn in flight. */
const WAKE_SETTLE_MS = 900

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7

const SILENT = '[SILENT]'
const MAX_FIRST_WAKE_MIN = 250
const WAKE_LABEL = /wake|пробужд/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

// --- timeline of everything the two fakes saw ---------------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
}

type TurnKind = 'owner' | 'wake'

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
  kind: TurnKind
  /** owner tag, or the number of the wake attempt */
  tag: string
  /** assistant messages since the turn began */
  step: number
}

/** The stub finished writing the answer of the request with number `of`. */
interface DsEndEvent {
  n: number
  src: 'dsend'
  of: number
}

type Event = TgEvent | DsEvent | DsEndEvent

interface Timeline {
  events: Event[]
  seq: number
}

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

// --- the scripted model --------------------------------------------------------------------------

/** What the model does at one step of a turn. */
type Reply =
  | { text: string }
  | { tool: string; input: JsonObject }
  | { wakeup: number }
  | { fail: true }

interface ToolResult {
  text: string
  isError: boolean
}

interface TurnInfo {
  kind: TurnKind
  tag: string
  step: number
  /** the tool result the model sees at this step (the one of the previous step) */
  result: ToolResult | undefined
}

type Plan = (turn: TurnInfo) => Reply | Promise<Reply>

interface Stub {
  server: Server
  origin: string
  /** plans of the owner turns by tag; the default answers `pong-<tag>` */
  owner: Map<string, Plan>
  /** plans of the wake-up attempts in order; the default answers [SILENT] */
  wake: Plan[]
  /** tool results the model received, by `kind:tag` */
  results: Map<string, ToolResult[]>
  attempts: number
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
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
      usage: { input_tokens: 4321, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 77 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

function toolUseStream(id: string, name: string, input: JsonObject): string {
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

function flatten(content: unknown): string {
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

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

function hasToolResult(message: JsonObject): boolean {
  return Array.isArray(message.content) && message.content.some((part) => asObject(part).type === 'tool_result')
}

function lastToolResult(body: JsonObject): ToolResult | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = asObject(part)
      if (block.type !== 'tool_result') continue
      return { text: flatten(block.content), isError: block.is_error === true }
    }
  }
  return undefined
}

const OWNER_PREFIX = /^own-([a-z0-9]+)/

/** Which turn a model request belongs to: the last user message with text opens it. */
function turnOf(body: JsonObject): { kind: TurnKind; tag: string; step: number } {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const text = flatten(message.content)
    if (text.trim() === '' && hasToolResult(message)) continue
    const step = messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    const owner = OWNER_PREFIX.exec(text.trim())
    return owner === null ? { kind: 'wake', tag: '', step } : { kind: 'owner', tag: owner[1] as string, step }
  }
  return { kind: 'wake', tag: '', step: 0 }
}

/** Names of the tools the request offers. */
function toolNames(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.flatMap((raw) => {
    const tool = asObject(raw)
    const fn = asObject(tool.function)
    const name = typeof tool.name === 'string' ? tool.name : fn.name
    return typeof name === 'string' ? [name] : []
  })
}

/** The tool schema as the model gets it: byte-comparable between two requests. */
function toolSchema(body: JsonObject): string {
  return JSON.stringify(body.tools ?? null)
}

/** The numeric property of set_next_wakeup in the request; `minutes` when the schema has none. */
function minutesKey(body: JsonObject): string {
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const tool = asObject(raw)
    if (tool.name !== 'set_next_wakeup') continue
    const schema = asObject(tool.input_schema ?? tool.parameters)
    const props = Object.entries(asObject(schema.properties))
    const numeric = props.find(([, prop]) => ['number', 'integer'].includes(String(asObject(prop).type)))
    if (numeric !== undefined) return numeric[0]
    const first = props[0]
    if (first !== undefined) return first[0]
  }
  return 'minutes'
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    owner: new Map(),
    wake: [],
    results: new Map(),
    attempts: 0,
  }
  stub.server = createServer((req, res) => {
    void readBody(req).then(async (raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }

      const opened = turnOf(body)
      let tag = opened.tag
      if (opened.kind === 'wake') {
        if (opened.step === 0) stub.attempts += 1
        tag = String(stub.attempts)
      }
      timeline.seq += 1
      const event: DsEvent = { n: timeline.seq, src: 'ds', body, kind: opened.kind, tag, step: opened.step }
      timeline.events.push(event)

      const result = opened.step > 0 ? lastToolResult(body) : undefined
      const key = `${opened.kind}:${tag}`
      if (result !== undefined) stub.results.set(key, [...(stub.results.get(key) ?? []), result])

      const plan = opened.kind === 'owner' ? stub.owner.get(tag) : stub.wake[stub.attempts - 1]
      const reply: Reply = plan
        ? await plan({ kind: opened.kind, tag, step: opened.step, result })
        : { text: opened.kind === 'owner' ? `pong-${tag}` : SILENT }

      if ('fail' in reply) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'wake stub refusal' } }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if ('text' in reply) res.end(textStream(reply.text))
        else if ('wakeup' in reply) {
          res.end(toolUseStream(`toolu_${event.n}`, 'set_next_wakeup', { [minutesKey(body)]: reply.wakeup }))
        } else res.end(toolUseStream(`toolu_${event.n}`, reply.tool, reply.input))
      }
      timeline.seq += 1
      timeline.events.push({ n: timeline.seq, src: 'dsend', of: event.n })
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP ----------------------------------------------------

interface QueuedUpdate {
  update: JsonObject
  delivered: boolean
}

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeTelegram {
  server: Server
  origin: string
  queue: QueuedUpdate[]
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

function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    tg.sentIds += 1
    const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
    return { message_id: 9000 + tg.sentIds, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' }
  }
  return true
}

async function startTelegram(timeline: Timeline): Promise<FakeTelegram> {
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
      timeline.events.push({ n: timeline.seq, src: 'tg', method, params })

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
      reply(200, JSON.stringify({ ok: true, result: okResult(tg, method, params) }))
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

function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

function ownerTexts(): string[] {
  return sentTo(world.timeline, OWNER_CHAT).map((e) => deepStrings(e.params).join('\n'))
}

function everythingSentByTheBot(): string {
  return world.timeline.events
    .filter((e): e is TgEvent => e.src === 'tg' && e.method !== 'getUpdates')
    .map((e) => JSON.stringify(e.params))
    .join('\n')
}

function modelRequests(kind: TurnKind): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.kind === kind)
}

/** The number of wake-up attempts the model has been asked for. */
function wakeAttempts(): number {
  return world.stub.attempts
}

// --- the fake clock of the daemon --------------------------------------------------------------------

const CLOCK_PRELOAD = `
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

interface Clock {
  control: string
  seq: number
  total: number
}

function writeClock(clock: Clock, poke: boolean): void {
  clock.seq += 1
  const staged = `${clock.control}.next`
  writeFileSync(staged, JSON.stringify({ seq: clock.seq, total: clock.total, poke }))
  renameSync(staged, clock.control)
}

function readAck(clock: Clock): number {
  try {
    return Number(readFileSync(`${clock.control}.ack`, 'utf8')) || 0
  } catch {
    return 0
  }
}

// --- module hooks of the daemon: a fake `task` tool and a count of the runner starts -----------------

// The hooks reroute two imports of the app (and of a wake-up package) to small modules that re-export the real ones
// and wrap one function:
//   createWebTools   gets a fake `task` tool in its result (an existing tool of that name is replaced; its
//                    description is logged to FAKE_TASK_PRESENT)
//   startRunner      appends a line to FAKE_RUNNER_LOG before it starts the runner
const HOOKS_PRELOAD = `
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.includes('/packages/app/src/') || parent.includes('/packages/consciousness/')) {
      if (/tools-web\\/src\\/index\\.js$/.test(specifier)) return { url: process.env.SHIM_WEB, shortCircuit: true }
      if (/runner\\/src\\/index\\.js$/.test(specifier)) return { url: process.env.SHIM_RUNNER, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`

function webShim(realUrl: string): string {
  return `
import { appendFileSync } from 'node:fs'
import * as real from ${JSON.stringify(realUrl)}
export * from ${JSON.stringify(realUrl)}

const fakeTask = {
  name: 'task',
  description: 'Fake task tool of the test: it only records its arguments.',
  inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: [] },
  async execute(args) {
    appendFileSync(process.env.FAKE_TASK_LOG, JSON.stringify(args) + '\\n')
    return 'TASK-RAN-OK'
  },
}

export function createWebTools(options) {
  const tools = real.createWebTools(options)
  if (process.env.FAKE_TASK !== '1') return tools
  const present = tools.find((tool) => tool.name === 'task')
  if (present) appendFileSync(process.env.FAKE_TASK_PRESENT, String(present.description) + '\\n')
  return [...tools.filter((tool) => tool.name !== 'task'), fakeTask]
}
`
}

function runnerShim(realUrl: string): string {
  return `
import { appendFileSync } from 'node:fs'
import * as real from ${JSON.stringify(realUrl)}
export * from ${JSON.stringify(realUrl)}

export async function startRunner(options) {
  appendFileSync(process.env.FAKE_RUNNER_LOG, 'start\\n')
  return real.startRunner(options)
}
`
}

// --- the daemon as a child process ------------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}

interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  home: string
  dshbotHome: string
  runtimeDir: string
  clock: Clock
  taskLog: string
  taskPresent: string
  runnerLog: string
  daemons: Daemon[]
}

let scratch: string
let clockPreload: string
let hooksPreload: string
let shimWeb: string
let shimRunner: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

interface SpawnOptions {
  /** extra variables of the daemon environment */
  env?: Record<string, string>
  /** put the fake `task` tool into the tool list (default true) */
  fakeTask?: boolean
}

function spawnDaemon(options: SpawnOptions = {}): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    // a night turn of the memory consolidation is not part of this harness
    DSHBOT_DREAM_AT: 'off',
    // The wake-up must be repeatable in these tests: a random free minute or a random spread of the
    // interval would change one wake-up prompt against another. A test that checks those settings
    // passes its own value through `options.env`, which wins over these defaults.
    DSHBOT_WAKE_JITTER: '0',
    DSHBOT_FREE_WAKE_CHANCE: '0',
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    FAKE_CLOCK_CONTROL: world.clock.control,
    ...TURN_EVENTS_ON,
    // One message per turn in these harnesses: the debounce series would only add 1.5 s to every turn.
    DSHBOT_DEBOUNCE_MS: '0',
    FAKE_TASK: options.fakeTask === false ? '0' : '1',
    FAKE_TASK_LOG: world.taskLog,
    FAKE_TASK_PRESENT: world.taskPresent,
    FAKE_RUNNER_LOG: world.runnerLog,
    SHIM_WEB: pathToFileURL(shimWeb).href,
    SHIM_RUNNER: pathToFileURL(shimRunner).href,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href} --import ${pathToFileURL(hooksPreload).href}`,
    // Quiet hours are wall-clock hours of the owner's zone. A test that pins
    // `DSHBOT_TZ` chooses them deliberately (the quiet and night tests do); a
    // test that does not pin a zone must not change its outcome with the hour
    // the suite happens to run at, so the fake clock starts with no quiet
    // window. An explicit `DSHBOT_QUIET_HOURS` in the options still wins below.
    ...(options.env?.DSHBOT_TZ === undefined ? { DSHBOT_QUIET_HOURS: '' } : {}),
    ...(options.env ?? {}),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  // `exec` makes the node process the direct child, so signals and exit codes are the daemon's own.
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

/** Moves the clock of the daemon forward and fires the timers that became due; resolves once it acknowledged. */
async function advanceClock(ms: number, d: Daemon): Promise<void> {
  world.clock.total += ms
  writeClock(world.clock, true)
  const seq = world.clock.seq
  await waitFor('the fake clock of the daemon to acknowledge', () => readAck(world.clock) >= seq || d.exited, d)
  expect(d.exited, `daemon exited while the clock moved\n${output(d)}`).toBe(false)
}

/** Nothing new has happened on either fake for `ms`. */
async function quietFor(ms: number, capMs = 60_000): Promise<void> {
  const started = Date.now()
  let last = world.timeline.seq
  let since = Date.now()
  while (Date.now() - started < capMs) {
    await sleep(100)
    if (world.timeline.seq !== last) {
      last = world.timeline.seq
      since = Date.now()
    } else if (Date.now() - since >= ms) return
  }
}

async function startDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(options)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

async function stopDaemon(d: Daemon): Promise<void> {
  if (d.exited) return
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 8_000)
  await d.exit
  clearTimeout(timer)
}

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
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
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const d = await startDaemon(options)
  await pairOwner(d)
  return d
}

/**
 * The owner writes `own-<tag>` and waits for the answer `pong-<tag>` (or the text of `final`) and the
 * end-of-turn event. The event comes after every send of the turn, so a test may assert on the whole
 * answer at once instead of waiting for a quiet window.
 */
async function ownerTurn(d: Daemon, tag: string, plan?: Plan, final = `pong-${tag}`): Promise<void> {
  if (plan !== undefined) world.stub.owner.set(tag, plan)
  const turns = turnCompletions(d)
  say(OWNER_CHAT, `own-${tag} привет`)
  await waitFor(`the answer to own-${tag}`, () => ownerTexts().some((text) => text.includes(final)), d)
  await waitForTurnComplete(d, turns, `the owner turn own-${tag}`, WAIT_MS)
}

/** An owner turn that calls one tool and then answers `pong-<tag>`. */
function callThenPong(tag: string, call: Reply): Plan {
  return (turn) => (turn.step === 0 ? call : { text: `pong-${tag}` })
}

/** A wake-up turn that calls one tool and then ends with `final`. */
function callThenText(call: Reply, final: string): Plan {
  return (turn) => (turn.step === 0 ? call : { text: final })
}

// --- moving the clock until the wake-up comes (or does not) ------------------------------------------

/** Advances the clock by `minutes` in steps; stops early when `stop()` holds. Returns the minutes advanced. */
async function advanceMinutes(
  d: Daemon,
  minutes: number,
  stepMin: number,
  stop: () => boolean,
  settleMs = SETTLE_MS,
): Promise<number> {
  let advanced = 0
  while (advanced < minutes && !stop()) {
    const step = Math.min(stepMin, minutes - advanced)
    await advanceClock(step * 60_000, d)
    advanced += step
    const started = Date.now()
    while (!stop() && Date.now() - started < settleMs) await sleep(25)
  }
  return advanced
}

/**
 * Real time a wake-up that fell due inside a jumped window gets to reach the model. The clock itself
 * does not move: a late alarm of the daemon cannot fire until the test moves it again.
 */
const EARLY_WAKE_GRACE_MS = 1_500

/** Waits up to `ms` of real time for a wake-up attempt beyond `baseline`; the clock is not moved. */
async function awaitAttempt(d: Daemon, baseline: number, ms: number): Promise<boolean> {
  const started = Date.now()
  while (wakeAttempts() <= baseline && !d.exited && Date.now() - started < ms) await sleep(25)
  return wakeAttempts() > baseline
}

/**
 * The clock jumps the whole first-wake window at once (the default interval is 60 min and an alarm is
 * still honoured up to 240 min past its due time), then waits for the attempt to reach the model.
 * The first one is within 250 min.
 */
async function untilAttempt(d: Daemon, baseline: number, maxMin = MAX_FIRST_WAKE_MIN): Promise<number> {
  await advanceClock(maxMin * 60_000, d)
  await awaitAttempt(d, baseline, WAIT_MS)
  expect(wakeAttempts(), `no wake-up within ${maxMin} min of the fake clock\n${output(d)}`).toBeGreaterThan(baseline)
  return maxMin
}

/** The wake-up attempt is over: the model was answered and the daemon went quiet. */
async function wakeFinished(d: Daemon, attempt: number): Promise<void> {
  await waitFor(`the wake-up attempt ${attempt} to reach the model`, () => wakeAttempts() >= attempt, d)
  await quietFor(1_500)
}

/**
 * No wake-up attempt beyond `baseline` during the next `minutes` of the fake clock. The window is
 * jumped in one step: an alarm that falls due inside it still fires and the grace catches it, while
 * an alarm due after the dotted line cannot fire because the clock stops there.
 */
async function expectNoWake(d: Daemon, baseline: number, minutes: number, what: string): Promise<void> {
  await advanceClock(minutes * 60_000, d)
  await awaitAttempt(d, baseline, EARLY_WAKE_GRACE_MS)
  expect(wakeAttempts(), `${what}: a wake-up came within ${minutes} min, too early`).toBe(baseline)
}

/**
 * A wake-up attempt beyond `baseline` comes within the next `minutes` of the fake clock. The jump is
 * the whole window: an alarm that is later than the upper bound is not fired by real time, only by
 * another move of the fake clock, so the wait cannot turn a late wake-up into a pass.
 */
async function expectWakeWithin(d: Daemon, baseline: number, minutes: number, what: string): Promise<void> {
  await advanceClock(minutes * 60_000, d)
  await awaitAttempt(d, baseline, WAIT_MS)
  expect(wakeAttempts(), `${what}: no wake-up within ${minutes} min\n${output(d)}`).toBeGreaterThan(baseline)
}

/** The first wake-up sets the interval to `asked` minutes and the test waits until it is over. */
async function firstWakeSets(d: Daemon, asked: number): Promise<void> {
  world.stub.wake[0] = callThenText({ wakeup: asked }, SILENT)
  await untilAttempt(d, 0)
  await wakeFinished(d, 1)
}

// --- reading state.db and the usage files ----------------------------------------------------------------

function openState(): DatabaseSync {
  return new DatabaseSync(join(world.dshbotHome, 'state.db'), { readOnly: true })
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}

/** Usage records labelled as wake-up calls: rows of the usage tables and kv entries of the usage keys. */
function wakeUsageInState(): number {
  const db = openState()
  try {
    const names = tableNames(db)
    let records = 0
    for (const name of names) {
      if (!/usage/i.test(name) || /^guest_usage$/i.test(name)) continue
      const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() as Array<Record<string, unknown>>
      records += rows.filter((row) =>
        Object.values(row).some((value) => typeof value === 'string' && WAKE_LABEL.test(value)),
      ).length
    }
    if (names.includes('kv')) {
      const rows = db.prepare('SELECT key, value FROM kv').all() as Array<{ key: string; value: string }>
      records += rows.filter((row) => /usage/i.test(row.key) && WAKE_LABEL.test(`${row.key} ${row.value}`)).length
    }
    return records
  } finally {
    db.close()
  }
}

/** Usage lines labelled as wake-up calls in files under DSHBOT_HOME whose names contain `usage`. */
function wakeUsageInFiles(): number {
  let lines = 0
  for (const entry of readdirSync(world.dshbotHome, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/usage/i.test(entry.name)) continue
    const text = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    lines += text.split('\n').filter((line) => WAKE_LABEL.test(line)).length
  }
  return lines
}

function stateTables(): string[] {
  const db = openState()
  try {
    return tableNames(db)
  } finally {
    db.close()
  }
}

function taskRuns(): string[] {
  return existsSync(world.taskLog) ? readFileSync(world.taskLog, 'utf8').split('\n').filter((line) => line !== '') : []
}

function runnerStarts(): number {
  return existsSync(world.runnerLog) ? readFileSync(world.runnerLog, 'utf8').split('\n').filter((line) => line !== '').length : 0
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-wake-support-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  clockPreload = join(scratch, 'fake-clock.mjs')
  writeFileSync(clockPreload, CLOCK_PRELOAD)
  hooksPreload = join(scratch, 'module-hooks.mjs')
  writeFileSync(hooksPreload, HOOKS_PRELOAD)
  shimWeb = join(scratch, 'web-shim.mjs')
  writeFileSync(shimWeb, webShim(pathToFileURL(join(repoRoot, 'packages', 'tools-web', 'src', 'index.ts')).href))
  shimRunner = join(scratch, 'runner-shim.mjs')
  writeFileSync(shimRunner, runnerShim(pathToFileURL(join(repoRoot, 'packages', 'runner', 'src', 'index.ts')).href))
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
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    clock: { control: join(scratch, `clock-${Math.random().toString(36).slice(2)}`), seq: 0, total: 0 },
    taskLog: join(home, 'task-calls.log'),
    taskPresent: join(home, 'task-present.log'),
    runnerLog: join(home, 'runner-starts.log'),
    daemons: [],
  }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
  writeClock(world.clock, false)
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- usage records of the wake-up calls (the variant of wake-clock.test.ts) --------------------------------

const CLOCK_WAKE_LABEL = /^wake(?:[-_ ]?up)?$/i

/** An object is labelled `wake` when one of its values is that string or it has a field of that name. */
function labelledWake(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(labelledWake)
  if (value === null || typeof value !== 'object') return false
  const entries = Object.entries(value)
  if (entries.some(([key, item]) => CLOCK_WAKE_LABEL.test(key) || (typeof item === 'string' && CLOCK_WAKE_LABEL.test(item.trim())))) {
    return true
  }
  return entries.some(([, item]) => typeof item === 'object' && labelledWake(item))
}

interface UsageRows {
  /** rows of the tables whose name contains `usage` */
  tableRows: number
  /** of them labelled wake */
  tableWake: number
  /** kv entries whose key contains `usage` and which carry a wake label */
  kvWake: number
}

function readUsage(): UsageRows {
  const db = openState()
  try {
    const usage: UsageRows = { tableRows: 0, tableWake: 0, kvWake: 0 }
    for (const name of tableNames(db)) {
      if (/usage/i.test(name) && !/^guest_usage$/i.test(name)) {
        const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        usage.tableRows += rows.length
        usage.tableWake += rows.filter((row) => labelledWake({ ...row })).length
      }
    }
    if (tableNames(db).includes('kv')) {
      const rows = db.prepare('SELECT * FROM kv').all() as Array<Record<string, unknown>>
      for (const row of rows) {
        const key = Object.values(row).find((value) => typeof value === 'string' && /usage/i.test(value))
        if (key === undefined) continue
        for (const value of Object.values(row)) {
          if (typeof value !== 'string') continue
          let parsed: unknown = value
          try {
            parsed = JSON.parse(value)
          } catch {
            // plain text value
          }
          if (labelledWake(parsed)) usage.kvWake += 1
        }
      }
    }
    return usage
  } finally {
    db.close()
  }
}

const TASK_CALL: Reply = { tool: 'task', input: { prompt: 'by-wake' } }

export {
  TEST_TIMEOUT_MS,
  WAIT_MS,
  LONG_POLL_HOLD_MS,
  SETTLE_MS,
  WAKE_SETTLE_MS,
  BOT_TOKEN,
  DEEPSEEK_KEY,
  OWNER_CHAT,
  SILENT,
  MAX_FIRST_WAKE_MIN,
  TASK_CALL,
  OWNER_PREFIX,
  sleep,
  world,
  asObject,
  deepStrings,
  messagesOf,
  flatten,
  hasToolResult,
  toolNames,
  toolSchema,
  modelRequests,
  ownerTexts,
  everythingSentByTheBot,
  wakeAttempts,
  taskRuns,
  runnerStarts,
  stateTables,
  readUsage,
  wakeUsageInState,
  wakeUsageInFiles,
  startDaemon,
  startOwnerDaemon,
  stopDaemon,
  pairOwner,
  say,
  output,
  waitFor,
  advanceClock,
  advanceMinutes,
  untilAttempt,
  wakeFinished,
  expectNoWake,
  expectWakeWithin,
  firstWakeSets,
  ownerTurn,
  callThenPong,
  callThenText,
}

export type {
  JsonObject,
  TgEvent,
  TurnKind,
  DsEvent,
  DsEndEvent,
  Event,
  Timeline,
  Reply,
  ToolResult,
  TurnInfo,
  Plan,
  Stub,
  FakeTelegram,
  Daemon,
  World,
  SpawnOptions,
  UsageRows,
}
