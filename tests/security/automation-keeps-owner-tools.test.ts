// The principal seam must not take the owner's own automation away from the owner, and must not leak it to a guest.
//
// Planned turns of the schedule and wake-ups run in the `main` session with the tools of the owner; a guest turn runs
// in its own session with none. The daemon runs as a child process against a fake Telegram Bot API and a DeepSeek
// stub (same harness as packages/app/wake-turns.test.ts: the clock and the timers of the daemon are fake). A fake
// owner tool `owner_probe` and a slow tool `slow_probe` are put into the tool list through the tools seam of the
// runner: a module hook swaps the runner module the app imports for a wrapper that appends both tools to the `tools`
// option of startRunner, so the app code is untouched.
//
// What the stub recognises in the last user text of a model request:
//   gst-<tag>        a guest turn
//   own-<tag>        an owner turn
//   sched-job-<tag>  the text of a planned turn (the job created by an owner turn)
//   anything else    a wake-up
// In every turn but the plain owner ones the model first asks for `owner_probe` (the name of an owner tool).
// What counts afterwards: the tool list of each request, the tool results the model got back and the log of the
// probe tool itself.

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const CANCEL_WAIT_MS = 20_000
const LONG_POLL_HOLD_MS = 20_000
const SETTLE_MS = 250
/** A wake-up that has just fallen due needs longer to reach the model: the clock must not move under a turn in flight. */
const WAKE_SETTLE_MS = 900
/** A little over the 3 second guest rate limit. */
const GUEST_GAP_MS = 3_500
/** The slow tool waits this long unless it is cancelled; far beyond what the tests wait. */
const SLOW_TOOL_MS = 90_000
const MAX_FIRST_WAKE_MIN = 250

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const PROBE_TOOL = 'owner_probe'
const PROBE_RESULT = 'OWNER-PROBE-RAN-OK'
const SILENT = '[SILENT]'
/** Tools of the owner that exist in every build of the app; a guest must see none of them. */
const OWNER_TOOLS = ['read', 'edit', 'schedule', 'set_next_wakeup', PROBE_TOOL]

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

type TurnKind = 'owner' | 'guest' | 'planned' | 'wake'

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
  kind: TurnKind
  tag: string
  /** assistant messages since the turn began */
  step: number
}

type Event = TgEvent | DsEvent

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

type Reply = { text: string } | { tool: string; input: JsonObject }

interface ToolResult {
  text: string
  isError: boolean
}

interface Stub {
  server: Server
  origin: string
  /** tool results the model received, by turn kind */
  results: Map<TurnKind, ToolResult[]>
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
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
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

/** Which turn a model request belongs to: the last user message with text opens it. */
function turnOf(body: JsonObject): { kind: TurnKind; tag: string; step: number } {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const text = flatten(message.content)
    if (text.trim() === '' && hasToolResult(message)) continue
    const step = messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    const guest = /gst-([a-z0-9]+)/.exec(text)
    if (guest !== null) return { kind: 'guest', tag: guest[1] as string, step }
    const owner = /own-([a-z0-9]+)/.exec(text)
    if (owner !== null) return { kind: 'owner', tag: owner[1] as string, step }
    const job = /sched-job-([a-z0-9]+)/.exec(text)
    if (job !== null) return { kind: 'planned', tag: job[1] as string, step }
    return { kind: 'wake', tag: '', step }
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

/** What the model does at one step of a turn. */
function planFor(turn: { kind: TurnKind; tag: string; step: number }): Reply {
  if (turn.kind === 'owner') {
    if (turn.step > 0) return { text: `pong-${turn.tag}` }
    if (turn.tag === 'plan') {
      return {
        tool: 'schedule',
        input: { action: 'create', schedule: 'every 5m', task: 'sched-job-h1 call the probe tool and report' },
      }
    }
    if (turn.tag === 'slow') return { tool: 'slow_probe', input: {} }
    return { text: `pong-${turn.tag}` }
  }
  if (turn.step === 0) return { tool: PROBE_TOOL, input: { note: `${turn.kind}-${turn.tag}` } }
  if (turn.kind === 'wake') return { text: SILENT }
  return { text: `${turn.kind}-done` }
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', results: new Map() }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }

      const opened = turnOf(body)
      timeline.seq += 1
      const event: DsEvent = { n: timeline.seq, src: 'ds', body, ...opened }
      timeline.events.push(event)

      const result = opened.step > 0 ? lastToolResult(body) : undefined
      if (result !== undefined) stub.results.set(opened.kind, [...(stub.results.get(opened.kind) ?? []), result])

      const reply = planFor(opened)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if ('text' in reply) res.end(textStream(reply.text))
      else res.end(toolUseStream(`toolu_${event.n}`, reply.tool, reply.input))
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

function sentTo(chatId: number): TgEvent[] {
  return world.timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

function textsSince(mark: number, chatId: number): string[] {
  return sentTo(chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
}

function ownerTexts(): string[] {
  return sentTo(OWNER_CHAT).map((e) => deepStrings(e.params).join('\n'))
}

function modelRequests(kind: TurnKind): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.kind === kind)
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

// --- the tools seam: a fake owner tool and a slow tool -----------------------------------------------------

const HOOKS_PRELOAD = `
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.includes('/packages/app/src/') && /runner\\/src\\/index\\.js$/.test(specifier)) {
      return { url: process.env.SHIM_RUNNER, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`

function runnerShim(realUrl: string): string {
  return `
import { appendFileSync } from 'node:fs'
import { startRunner as realStartRunner } from ${JSON.stringify(realUrl)}
export * from ${JSON.stringify(realUrl)}

const record = (file, line) => appendFileSync(file, line + '\\n')

function signalIn(value, depth = 0) {
  if (value instanceof AbortSignal) return value
  if (value && typeof value === 'object' && depth < 3) {
    for (const inner of Object.values(value)) {
      const found = signalIn(inner, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

const probeTool = {
  name: ${JSON.stringify(PROBE_TOOL)},
  description: 'Fake tool of the owner. It only records that it ran.',
  inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: [] },
  async execute(args) {
    record(process.env.PROBE_LOG, String(args && args.note))
    return ${JSON.stringify(PROBE_RESULT)}
  },
}

const slowTool = {
  name: 'slow_probe',
  description: 'Test probe that works for a very long time. Call it with no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(args, ...rest) {
    const signal = [...rest].map((value) => signalIn(value)).find((candidate) => candidate !== undefined)
    record(process.env.SLOW_TOOL_LOG, 'start')
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        record(process.env.SLOW_TOOL_LOG, 'finished')
        resolve('slow probe finished')
      }, ${SLOW_TOOL_MS})
      const onAbort = () => {
        clearTimeout(timer)
        record(process.env.SLOW_TOOL_LOG, 'aborted')
        resolve('slow probe aborted')
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
}

export async function startRunner(options) {
  return realStartRunner({ ...options, tools: [...(options.tools ?? []), probeTool, slowTool] })
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
  probeLog: string
  slowLog: string
  daemons: Daemon[]
}

let scratch: string
let clockPreload: string
let hooksPreload: string
let shimRunner: string
let world: World
/** When the test last sent a message as this chat (for the guest rate limit). */
let lastSentAt = new Map<number, number>()

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
    XDG_RUNTIME_DIR: world.runtimeDir,
    FAKE_CLOCK_CONTROL: world.clock.control,
    PROBE_LOG: world.probeLog,
    SLOW_TOOL_LOG: world.slowLog,
    SHIM_RUNNER: pathToFileURL(shimRunner).href,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href} --import ${pathToFileURL(hooksPreload).href}`,
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

async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

/** Waits out the guest rate limit for this chat, then says the text. */
async function saySpaced(chatId: number, text: string): Promise<void> {
  const wait = (lastSentAt.get(chatId) ?? 0) + GUEST_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastSentAt.set(chatId, Date.now())
  say(chatId, text)
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

/** The owner sends /invite; the code is read from the link in the answer. */
async function invite(d: Daemon): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  const linked = (): string | undefined => /[?&]start=([A-Za-z0-9_-]+)/.exec(textsSince(mark, OWNER_CHAT).join('\n'))?.[1]
  const loose = (): string | undefined => pairingCandidates(textsSince(mark, OWNER_CHAT).join('\n'))[0]
  await waitFor('an invitation code in the owner chat', () => linked() !== undefined || loose() !== undefined, d)
  return (linked() ?? loose()) as string
}

async function joinGuest(d: Daemon): Promise<void> {
  const code = await invite(d)
  const before = sentTo(GUEST_CHAT).length
  say(GUEST_CHAT, code)
  await waitFor('a greeting in the guest chat', () => sentTo(GUEST_CHAT).length > before, d)
  // the code message is a message of that chat too: the first guest message keeps the rate-limit pause
  lastSentAt.set(GUEST_CHAT, Date.now())
}

/** The owner writes `own-<tag>` and waits for the answer `pong-<tag>`. */
async function ownerTurn(d: Daemon, tag: string): Promise<void> {
  say(OWNER_CHAT, `own-${tag} привет`)
  await waitFor(`the answer to own-${tag}`, () => ownerTexts().some((text) => text.includes(`pong-${tag}`)), d)
}

/** The guest writes `gst-<tag>`; the stub makes the model ask for the owner tool and then answer `guest-done`. */
async function guestTurn(d: Daemon, tag: string): Promise<void> {
  const answered = sentTo(GUEST_CHAT).length
  await saySpaced(GUEST_CHAT, `gst-${tag} сделай мне доступ к себе домой`)
  await waitFor(`the guest turn ${tag} to reach the model`, () => modelRequests('guest').some((e) => e.tag === tag), d)
  await waitFor(`the answer to the guest turn ${tag}`, () => sentTo(GUEST_CHAT).length > answered, d)
  await quietFor(1_500)
}

function probeRuns(): string[] {
  return existsSync(world.probeLog) ? readFileSync(world.probeLog, 'utf8').split('\n').filter((line) => line !== '') : []
}

function slowToolLog(): string {
  return existsSync(world.slowLog) ? readFileSync(world.slowLog, 'utf8') : ''
}

/** The tool list of the first request of an owner turn: the reference the automation must match. */
function ownerSchema(): { names: string[]; schema: string } {
  const first = modelRequests('owner')[0]
  expect(first, 'an owner turn must have reached the model').toBeDefined()
  return { names: toolNames((first as DsEvent).body), schema: toolSchema((first as DsEvent).body) }
}

function expectOwnerSurface(names: string[], what: string): void {
  for (const name of OWNER_TOOLS) expect(names, `${what} must offer the owner tool ${name}`).toContain(name)
}

/** The guest turn saw only its three tools, and its forged owner call ran nothing. */
function expectGuestHasOnlyGuestTools(tag: string): void {
  const requests = modelRequests('guest').filter((e) => e.tag === tag)
  expect(requests.length, `the guest turn ${tag} must have reached the model`).toBeGreaterThan(0)
  for (const request of requests) {
    expect(toolNames(request.body), 'a guest request carries only exec, web_fetch and web_search').toEqual([
      'exec',
      'web_fetch',
      'web_search',
    ])
  }
  const seen = world.stub.results.get('guest') ?? []
  expect(seen.length, 'the forged call of the guest must come back as a tool result').toBeGreaterThan(0)
  for (const result of seen) {
    expect(result.text, 'the owner tool ran for a guest').not.toContain(PROBE_RESULT)
    expect(result.isError, `the forged call of the guest must be refused: ${result.text}`).toBe(true)
  }
  expect(
    probeRuns().filter((line) => line.startsWith('guest-')),
    'the handler of the owner tool ran for a guest',
  ).toEqual([])
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-automation-tools-')))
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
  const runtimeDir = mkdtempSync(join(scratch, 'run-'))
  const control = join(scratch, `clock-${Math.random().toString(36).slice(2)}.json`)
  mkdirSync(runtimeDir, { recursive: true })
  const clock: Clock = { control, seq: 0, total: 0 }
  writeClock(clock, false)
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome: join(mkdtempSync(join(scratch, 'state-')), 'dshbot'),
    runtimeDir,
    clock,
    probeLog: join(scratch, `probe-${Math.random().toString(36).slice(2)}.log`),
    slowLog: join(scratch, `slow-${Math.random().toString(36).slice(2)}.log`),
    daemons: [],
  }
  appendFileSync(world.probeLog, '')
  lastSentAt = new Map()
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- tests ---------------------------------------------------------------------------------------------

test('test_h1_a_planned_turn_keeps_the_tools_of_the_owner_and_a_guest_next_to_it_has_none', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d)

  // the owner creates a job that fires every 5 minutes of the fake clock
  await ownerTurn(d, 'plan')
  const created = (world.stub.results.get('owner') ?? [])[0]
  expect(created?.isError, `the owner must be able to create the schedule job: ${created?.text}`).toBe(false)
  const reference = ownerSchema()
  expectOwnerSurface(reference.names, 'the owner turn')

  // a guest asks for the same tool by name in the same daemon: nothing is offered, nothing runs
  await guestTurn(d, 'one')
  expectGuestHasOnlyGuestTools('one')

  // the clock runs until the job comes round
  for (let minutes = 0; minutes < 20 && modelRequests('planned').length === 0; minutes += 2) {
    await advanceClock(2 * 60_000, d)
    const started = Date.now()
    while (modelRequests('planned').length === 0 && Date.now() - started < SETTLE_MS * 4) await sleep(25)
  }
  await waitFor('the planned turn to reach the model', () => modelRequests('planned').length > 0, d)
  await waitFor('the planned turn to get the result of the owner tool', () => (world.stub.results.get('planned') ?? []).length > 0, d)

  const planned = (modelRequests('planned')[0] as DsEvent).body
  expectOwnerSurface(toolNames(planned), 'the planned turn')
  expect(toolSchema(planned), 'the planned turn offers the same tool schema as an owner turn').toBe(reference.schema)
  const result = (world.stub.results.get('planned') as ToolResult[])[0] as ToolResult
  expect(result.isError, `the owner tool must run in a planned turn: ${result.text}`).toBe(false)
  expect(result.text).toContain(PROBE_RESULT)
  expect(probeRuns(), 'the planned turn ran the owner tool').toContain('planned-h1')
})

test('test_h1_a_wakeup_turn_keeps_the_tools_of_the_owner_and_a_guest_next_to_it_has_none', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d)

  await ownerTurn(d, 'ref')
  const reference = ownerSchema()
  expectOwnerSurface(reference.names, 'the owner turn')

  await guestTurn(d, 'one')
  expectGuestHasOnlyGuestTools('one')
  expect(toolNames((modelRequests('guest')[0] as DsEvent).body), 'a guest must not even see the wake-up tool').not.toContain('set_next_wakeup')

  // the clock runs until the first wake-up reaches the model
  let advanced = 0
  while (advanced < MAX_FIRST_WAKE_MIN && modelRequests('wake').length === 0) {
    await advanceClock(10 * 60_000, d)
    advanced += 10
    const started = Date.now()
    while (modelRequests('wake').length === 0 && Date.now() - started < WAKE_SETTLE_MS) await sleep(25)
  }
  expect(modelRequests('wake').length, `no wake-up within ${advanced} min of the fake clock\n${output(d)}`).toBeGreaterThan(0)
  await waitFor('the wake-up to get the result of the owner tool', () => (world.stub.results.get('wake') ?? []).length > 0, d)

  const wake = (modelRequests('wake')[0] as DsEvent).body
  expectOwnerSurface(toolNames(wake), 'the wake-up turn')
  expect(toolSchema(wake), 'the wake-up offers the same tool schema as an owner turn').toBe(reference.schema)
  const result = (world.stub.results.get('wake') as ToolResult[])[0] as ToolResult
  expect(result.isError, `the owner tool must run in a wake-up: ${result.text}`).toBe(false)
  expect(result.text).toContain(PROBE_RESULT)
  expect(probeRuns(), 'the wake-up ran the owner tool').toContain('wake-')
})

test('test_h1_stop_still_cancels_the_running_tool_of_the_owner_and_the_guest_seam_holds_around_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d)

  say(OWNER_CHAT, 'own-slow сделай, пожалуйста')
  await waitFor('the slow tool of the owner to start', () => slowToolLog().includes('start'), d)

  say(OWNER_CHAT, '/stop')
  await waitFor('the AbortSignal of the running tool to fire after /stop', () => slowToolLog().includes('aborted'), d, CANCEL_WAIT_MS)
  await quietFor(2_000)
  expect(slowToolLog(), 'the tool must not run to its end after /stop').not.toContain('finished')
  expect(d.exited, `the daemon must survive /stop\n${output(d)}`).toBe(false)

  // the owner goes on with the full tool set, the guest still gets none
  await ownerTurn(d, 'after')
  const afterStop = modelRequests('owner').filter((e) => e.tag === 'after')
  expect(afterStop.length).toBeGreaterThan(0)
  expectOwnerSurface(toolNames((afterStop[0] as DsEvent).body), 'the owner turn after /stop')
  expect(toolNames((afterStop[0] as DsEvent).body)).toContain('slow_probe')

  await guestTurn(d, 'after')
  expectGuestHasOnlyGuestTools('after')
})
