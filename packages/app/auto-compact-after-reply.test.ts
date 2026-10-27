// Automatic compaction of the history of main AFTER the reply to the owner, not before the turn. Same harness as
// auto-compact.test.ts: the daemon runs as a child process against a fake Telegram Bot API and a local DeepSeek
// stub. The stub plays three kinds of requests:
//   - a request without tools (the summary of a compaction) gets a fixed text, or an HTTP error while `failSummary`;
//   - a request with tools whose last user text carries a marker `ac-xx-N` is an owner turn: it answers `fin <marker>`;
//   - a request with tools whose last user text has no marker is the service turn before a compaction: the stub
//     writes one fact with the memory tool, then ends with a fixed text (or an HTTP error while `failFlush`).
// While `hold` is a pending promise, the first answers of a compaction (service turn, summary) wait for it.
//
// Contract the tests rely on:
//   - `DSHBOT_AUTO_COMPACT_TOKENS` is the threshold in the tokens `/context` shows, 0 switches the automatic path off;
//   - a turn of the owner that leaves the history over the threshold is followed by a compaction in the idle time,
//     after the reply has been delivered; the owner gets the notice as a separate message after the reply;
//   - an owner message that comes during that compaction interrupts it: the history stays as it was,
//     the turn starts at once, the compaction repeats in the idle time after the reply, and the
//     interrupted attempt tells the owner nothing;
//   - before the owner turn the history is compacted only when it is at least twice the threshold; between
//     the threshold and twice the threshold the turn runs on the history as it is and the compaction follows
//     the reply.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 420_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 150_000
const LONG_POLL_HOLD_MS = 20_000
const SETTLE_MS = 1_500
/** Long enough for a compaction that would start right after a reply to show up. */
const IDLE_MS = 5_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

/** kv key of the paired owner chat (OWNER_KV_KEY of the app); seeded so the daemon starts as paired. */
const OWNER_KV_KEY = 'telegram.owner_chat_id'

const THRESHOLD_ENV = 'DSHBOT_AUTO_COMPACT_TOKENS'

const MARKER_RE = /\bac-[a-z]+-\d+\b/
const SUMMARY_STUB_TEXT = 'SUMMARY-STUB of the earlier conversation'
const FLUSH_DONE_TEXT = 'FLUSH-DONE-STUB the facts are saved'
const FACT_PREFIX = 'AUTOFACT'

const AUTO_NOTICE_RE = /контекст сжат автоматически/i
const FAILED_NOTICE_RE = /не удалось/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- timeline of everything the two fake servers saw -------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
}

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
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

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

// --- the scripted model -------------------------------------------------------------------------

interface Stub {
  server: Server
  origin: string
  /** While on, a request without tools (the summary of a compaction) fails with an HTTP error. */
  failSummary: boolean
  /** While on, the service turn before a compaction fails with an HTTP error. */
  failFlush: boolean
  /** While pending, the service turn and the summary of a compaction wait for it before they answer. */
  hold: Promise<void> | undefined
  facts: number
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

function messageJson(content: unknown[], stopReason: string): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content,
    stop_reason: stopReason,
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
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function blocksOf(content: unknown): JsonObject[] {
  return Array.isArray(content) ? content.map(asObject) : []
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

/** Text of the whole history of a request, system prompt excluded. */
function historyText(body: JsonObject): string {
  return messagesOf(body)
    .map((message) => flatten(message.content))
    .join('\n')
}

function toolNamesOf(body: JsonObject): string[] {
  return (Array.isArray(body.tools) ? body.tools.map(asObject) : [])
    .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
    .filter((name) => name !== '')
}

/** The last user message that carries text (a message with tool results alone does not open a turn). */
function lastTextUser(body: JsonObject): { index: number; text: string } | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const text = flatten(message.content)
    if (text.trim() !== '') return { index: at, text }
  }
  return undefined
}

/** The marker of the turn a request belongs to; none for the service turn before a compaction. */
function markerOf(body: JsonObject): string | undefined {
  const opened = lastTextUser(body)
  return opened === undefined ? undefined : MARKER_RE.exec(opened.text)?.[0]
}

function endsWithToolResult(body: JsonObject): boolean {
  const messages = messagesOf(body)
  const last = messages[messages.length - 1]
  return last !== undefined && last.role === 'user' && blocksOf(last.content).some((b) => b.type === 'tool_result')
}

/** The background review of experience: it carries skill_manage and not the owner's edit tool. */
function isReviewBody(body: JsonObject): boolean {
  const names = toolNamesOf(body)
  return names.includes('skill_manage') && !names.includes('edit')
}

/** The request of a compaction: the history plus the instruction to write one checkpoint. */
function isSummaryRequest(body: JsonObject): boolean {
  const users = messagesOf(body).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return last !== undefined && flatten(last.content).includes('Output only the checkpoint text')
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    failSummary: false,
    failFlush: false,
    hold: undefined,
    facts: 0,
  }
  stub.server = createServer((req, res) => {
    void readBody(req).then(async (raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      const streaming = body.stream !== false
      const fail = (message: string): void => {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
      }
      const answerText = (text: string): void => {
        if (!streaming) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(messageJson([{ type: 'text', text }], 'end_turn'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(textStream(text))
      }
      const answerTool = (name: string, input: JsonObject): void => {
        const id = `toolu_${timeline.seq}_${name}`
        if (!streaming) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(messageJson([{ type: 'tool_use', id, name, input }], 'tool_use'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(toolUseStream(id, name, input))
      }

      if (isSummaryRequest(body)) {
        if (stub.hold) await stub.hold
        if (stub.failSummary) fail('summary model is down')
        else answerText(SUMMARY_STUB_TEXT)
        return
      }
      if (toolNamesOf(body).length === 0 || isReviewBody(body)) {
        answerText(SUMMARY_STUB_TEXT)
        return
      }
      const marker = markerOf(body)
      if (marker !== undefined) {
        answerText(`fin ${marker}`)
        return
      }
      // the service turn before a compaction: save one fact, then finish
      if (stub.hold) await stub.hold
      if (stub.failFlush) {
        fail('service turn is down')
        return
      }
      if (endsWithToolResult(body)) {
        answerText(FLUSH_DONE_TEXT)
        return
      }
      stub.facts += 1
      answerTool('memory', {
        target: 'memory',
        operations: [{ op: 'add', text: `${FACT_PREFIX}-${stub.facts} the owner prefers short answers` }],
      })
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

// --- update builders and readers ---------------------------------------------------------------

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

/** Messages the chat got after the timeline number `mark`, one text per message. */
function textsSince(chatId: number, mark: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .map((e) => deepStrings(e.params).join('\n'))
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
  daemons: Daemon[]
}

let scratch: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

function spawnDaemon(extraEnv: Record<string, string> = {}): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    // a night turn of the memory consolidation is not part of this harness
    DSHBOT_DREAM_AT: 'off',
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    ...extraEnv,
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

async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(extraEnv)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

/** The store of the daemon knows the owner chat before the first start: no pairing round. */
function seedOwner(): void {
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER_CHAT))
  } finally {
    store.close()
  }
}

async function startOwnerDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  seedOwner()
  return startDaemon(extraEnv)
}

async function stopDaemon(d: Daemon): Promise<void> {
  d.child.kill('SIGTERM')
  const killer = setTimeout(() => d.child.kill('SIGKILL'), 20_000)
  await d.exit
  clearTimeout(killer)
}

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

/** The owner sends a daemon command and gets the text of the answer. */
async function command(d: Daemon, text: string, chatId = OWNER_CHAT, timeoutMs = WAIT_MS): Promise<string> {
  const mark = world.timeline.seq
  say(chatId, text)
  await waitFor(`an answer to ${JSON.stringify(text)}`, () => textsSince(chatId, mark).length > 0, d, timeoutMs)
  await sleep(300)
  return textsSince(chatId, mark).join('\n')
}

/** Main turns of the owner and the service turns: requests with tools that are not the background review. */
function mainCalls(): DsEvent[] {
  return world.timeline.events.filter(
    (e): e is DsEvent =>
      e.src === 'ds' && e.body.stream !== false && toolNamesOf(e.body).length > 0 && !isReviewBody(e.body),
  )
}

/** Model requests of one owner turn, in order. */
function turnCalls(marker: string): DsEvent[] {
  return mainCalls().filter((e) => markerOf(e.body) === marker)
}

/** First requests of the service turns before a compaction: the history ends with a text without a marker. */
function flushCalls(): DsEvent[] {
  return mainCalls().filter((e) => markerOf(e.body) === undefined && !endsWithToolResult(e.body))
}

/** Requests of the summary of a compaction. */
function summaryCalls(): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && isSummaryRequest(e.body))
}

/** The owner opens a turn with `marker` and waits for the reply of the model to arrive in the chat. */
async function runTurn(d: Daemon, marker: string, filler = ''): Promise<DsEvent[]> {
  say(OWNER_CHAT, `${marker} расскажи что-нибудь ${filler}`)
  await waitFor(
    `the reply of turn ${marker}`,
    () => sentTo(world.timeline, OWNER_CHAT).some((e) => JSON.stringify(e.params).includes(`fin ${marker}`)),
    d,
    TURN_WAIT_MS,
  )
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

/** One owner message of about 6000 characters that is never mistaken for a marker. */
const FILLER = 'длинное описание задачи без особого смысла '.repeat(140)

function marker(prefix: string, index: number): string {
  return `ac-${prefix}-${String(index).padStart(2, '0')}`
}

/** The owner talks `count` long turns to the main session: markers ac-<prefix>-01 … */
async function buildHistory(d: Daemon, prefix: string, count: number, filler = FILLER): Promise<void> {
  for (let index = 1; index <= count; index += 1) await runTurn(d, marker(prefix, index), filler)
}

interface Sizes {
  system: number
  tools: number
  history: number
  /** What `/context` adds up to: the size the request is priced by. */
  total: number
}

/** The parts of the main context from `/context`, no model call. */
async function contextSizes(d: Daemon): Promise<Sizes> {
  const text = await command(d, '/context')
  const grab = (re: RegExp): number => Number(re.exec(text)?.[1] ?? Number.NaN)
  const system = grab(/Системный префикс:\s*(\d+)/)
  const tools = grab(/Схемы инструментов[^:\n]*:\s*(\d+)/)
  const history = grab(/История:\s*(\d+)/)
  for (const part of [system, tools, history]) expect(Number.isFinite(part), `/context carries the sizes\n${text}`).toBe(true)
  expect(history, `the history of main is not empty\n${text}`).toBeGreaterThan(0)
  return { system, tools, history, total: system + tools + history }
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-ac-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const world_: World = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    daemons: [],
  }
  mkdirSync(dshbotHome, { recursive: true })
  world = world_
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

/**
 * The first daemon (automatic compaction off) talks `count` long turns and goes away; the history stays on disk
 * for the second daemon, which starts with the threshold the test chooses from the sizes returned here.
 */
async function historyOnDisk(prefix: string, count: number): Promise<Sizes> {
  const first = await startOwnerDaemon({ [THRESHOLD_ENV]: '0' })
  await buildHistory(first, prefix, count)
  const sizes = await contextSizes(first)
  await stopDaemon(first)
  return sizes
}

// --- scenario helpers ---------------------------------------------------------------------------------------

/** The owner message that takes the history over the threshold: three times the usual filler. */
const BIG = FILLER.repeat(3)

/** Margin above the size of the history on disk: the next turn starts under it, the big message ends over it. */
const MARGIN_TOKENS = 1_500

/** Requests of a compaction (service turn and summary) after the timeline number `mark`, in order. */
function compactionCalls(mark: number): DsEvent[] {
  return [...flushCalls(), ...summaryCalls()].filter((e) => e.n > mark).sort((x, y) => x.n - y.n)
}

/** The message with the reply of the turn `marker_` in the chat of the owner. */
function replyOf(marker_: string): TgEvent | undefined {
  return sentTo(world.timeline, OWNER_CHAT).find((e) => JSON.stringify(e.params).includes(`fin ${marker_}`))
}

/** Messages to the owner after `mark` with the automatic notice about a compaction. */
function autoNoticesSince(mark: number): TgEvent[] {
  return sentTo(world.timeline, OWNER_CHAT).filter((e) => e.n > mark && AUTO_NOTICE_RE.test(deepStrings(e.params).join('\n')))
}

/** Messages that warn about a failed compaction. */
function warningsSince(mark: number): string[] {
  return textsSince(OWNER_CHAT, mark).filter((text) => FAILED_NOTICE_RE.test(text) && /сжа|контекст/i.test(text))
}

interface Scenario {
  d: Daemon
  threshold: number
}

/**
 * A history of twelve long turns on disk, then a daemon whose threshold is a little above that history: it
 * starts under the threshold, and one big owner message takes it over.
 */
async function startUnderThreshold(): Promise<Scenario> {
  const sizes = await historyOnDisk('aa', 12)
  const threshold = sizes.total + MARGIN_TOKENS
  const d = await startDaemon({ [THRESHOLD_ENV]: String(threshold) })
  const now = await contextSizes(d)
  expect(now.total, 'the daemon starts under the threshold').toBeLessThan(threshold)
  return { d, threshold }
}

/** The big turn `ac-zz-01`: resolves when its reply is in the chat. */
async function bigTurn(d: Daemon): Promise<DsEvent[]> {
  const calls = await runTurn(d, marker('zz', 1), BIG)
  expect(replyOf(marker('zz', 1)), 'the reply of the big turn is in the chat').toBeDefined()
  return calls
}

// --- [c1] the compaction comes after the reply ------------------------------------------------------------

test('test_c1_over_the_threshold_after_the_turn_the_reply_is_delivered_before_any_compaction_request', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  const mark = world.timeline.seq

  const calls = await bigTurn(d)
  const reply = replyOf(marker('zz', 1)) as TgEvent
  await waitFor('the compaction after the reply', () => summaryCalls().some((e) => e.n > mark), d, WAIT_MS)

  const compaction = compactionCalls(mark)
  expect(compaction.length, `the history over the threshold was compacted without a new message\n${output(d)}`).toBeGreaterThanOrEqual(1)
  expect((calls[0] as DsEvent).n, 'the turn of the owner is the first request after the message').toBeLessThan((compaction[0] as DsEvent).n)
  expect(reply.n, 'the reply was delivered before the first request of the compaction').toBeLessThan((compaction[0] as DsEvent).n)
  expect(historyText((calls[0] as DsEvent).body), 'the turn ran on the history as it was, not on a summary').toContain(marker('aa', 1))
  expect(historyText((calls[0] as DsEvent).body)).not.toContain(SUMMARY_STUB_TEXT)
})

// --- [c2] the next turn starts on the compacted history ---------------------------------------------------

test('test_c2_the_next_turn_after_the_compaction_after_the_reply_starts_with_its_own_request_on_the_compacted_history', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  const mark = world.timeline.seq
  await bigTurn(d)
  await waitFor('the notice about the compaction', () => autoNoticesSince(mark).length > 0, d, WAIT_MS)
  await sleep(SETTLE_MS) // background: the compaction after the reply

  const next = world.timeline.seq
  const calls = await runTurn(d, marker('zz', 2))
  await sleep(SETTLE_MS) // background: the compaction after the reply

  const first = world.timeline.events.find(
    (e): e is DsEvent =>
      e.src === 'ds' && e.n > next && e.body.stream !== false && toolNamesOf(e.body).length > 0 && !isReviewBody(e.body),
  )
  expect(first, 'the model was asked').toBeDefined()
  expect((first as DsEvent).n, 'the first request of the turn is the request of the turn').toBe((calls[0] as DsEvent).n)
  expect(compactionCalls(next), 'no compaction request in the turn that follows').toHaveLength(0)
  const body = (calls[0] as DsEvent).body
  expect(historyText(body), 'the turn runs on the compacted history: the summary is in it').toContain(SUMMARY_STUB_TEXT)
  expect(historyText(body), 'the oldest turns are replaced by the summary').not.toContain(marker('aa', 1))
  expect(historyText(body), 'the message of the owner is in the history').toContain(marker('zz', 2))
  expect(autoNoticesSince(next), 'no second notice: the history was already compacted').toHaveLength(0)
})

// --- [c3] a message that comes during the compaction ------------------------------------------------------

test('test_c3_a_message_during_the_compaction_after_the_reply_interrupts_it_and_the_compaction_repeats_after_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  let release: () => void = () => undefined
  world.stub.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const mark = world.timeline.seq
  await bigTurn(d)
  await waitFor('the compaction to start', () => compactionCalls(mark).length > 0, d, WAIT_MS)

  // The message does not wait for the held service turn: its request reaches the
  // model while the compaction exercises the same hold.
  say(OWNER_CHAT, `${marker('zz', 2)} ещё вопрос`)
  await waitFor('the turn of the message that interrupted the compaction', () => turnCalls(marker('zz', 2)).length > 0, d, TURN_WAIT_MS)
  const first = turnCalls(marker('zz', 2))[0] as DsEvent
  expect(summaryCalls().filter((e) => e.n > mark), 'the interrupted attempt wrote no summary').toHaveLength(0)
  expect(historyText(first.body), 'the history is as it was before the compaction').not.toContain(SUMMARY_STUB_TEXT)
  expect(historyText(first.body), 'the old turns are still there').toContain(marker('aa', 1))
  expect(historyText(first.body), 'the message of the owner reached the model').toContain(marker('zz', 2))

  release()
  await waitFor(
    'the reply to the message that interrupted the compaction',
    () => replyOf(marker('zz', 2)) !== undefined,
    d,
    TURN_WAIT_MS,
  )
  const reply = replyOf(marker('zz', 2)) as TgEvent
  await waitFor('the notice of the repeated compaction', () => autoNoticesSince(mark).length > 0, d, TURN_WAIT_MS)
  await sleep(SETTLE_MS) // background: the repeated compaction after the reply

  const summaries = summaryCalls().filter((e) => e.n > mark)
  expect(summaries.length, `the compaction was repeated and finished once\n${output(d)}`).toBe(1)
  expect((summaries[0] as DsEvent).n, 'the repeated summary comes after the reply').toBeGreaterThan(reply.n)
  expect(historyText((summaries[0] as DsEvent).body), 'the repeated compaction sees the new turn').toContain(marker('zz', 2))
  expect(autoNoticesSince(mark), 'the interrupted attempt sent no notice').toHaveLength(1)
  expect(warningsSince(mark), 'the interrupted attempt sent no warning').toEqual([])
})

// --- [c4] at the hard limit at the start of the turn -------------------------------------------------------

test('test_c4_history_at_the_hard_limit_when_the_message_comes_is_compacted_before_the_turn_with_a_notice', { timeout: TEST_TIMEOUT_MS }, async () => {
  const sizes = await historyOnDisk('aa', 12)
  // At 0.45 of the total the threshold is at most half the history, so the
  // message starts the turn at the hard limit (twice the threshold).
  const d = await startDaemon({ [THRESHOLD_ENV]: String(Math.floor(sizes.total * 0.45)) })

  const mark = world.timeline.seq
  const calls = await runTurn(d, marker('zz', 1))
  await sleep(SETTLE_MS) // background: the compaction after the reply

  const summaries = summaryCalls().filter((e) => e.n > mark)
  expect(summaries.length, `the session at the hard limit was summarized before the turn\n${output(d)}`).toBe(1)
  expect((summaries[0] as DsEvent).n, 'the summary comes before the turn of the owner').toBeLessThan((calls[0] as DsEvent).n)
  const body = (calls[0] as DsEvent).body
  expect(historyText(body), 'the turn runs on the compacted session').toContain(SUMMARY_STUB_TEXT)
  expect(historyText(body), 'the oldest turns are replaced by the summary').not.toContain(marker('aa', 1))
  expect(historyText(body), 'the message of the owner reached the compacted session').toContain(marker('zz', 1))

  const notices = autoNoticesSince(mark)
  expect(notices.length, `the owner gets one message about the compaction\n${textsSince(OWNER_CHAT, mark).join('\n---\n')}`).toBe(1)
  expect(replyOf(marker('zz', 1)), 'the owner gets the reply').toBeDefined()
})

// --- [c5] the notice is a separate message after the reply ------------------------------------------------

test('test_c5_the_notice_about_the_compaction_after_the_reply_is_a_separate_message_after_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  const mark = world.timeline.seq
  await bigTurn(d)
  const reply = replyOf(marker('zz', 1)) as TgEvent
  await waitFor('the notice about the compaction', () => autoNoticesSince(mark).length > 0, d, WAIT_MS)
  await sleep(SETTLE_MS) // background: the compaction after the reply

  const notices = autoNoticesSince(mark)
  expect(notices.length, `one notice\n${textsSince(OWNER_CHAT, mark).join('\n---\n')}`).toBe(1)
  const notice = notices[0] as TgEvent
  expect(notice.n, 'the notice comes after the reply').toBeGreaterThan(reply.n)
  expect(notice, 'the notice is another message than the reply').not.toBe(reply)
  expect(JSON.stringify(notice.params), 'the notice does not carry the reply').not.toContain(`fin ${marker('zz', 1)}`)
  expect(AUTO_NOTICE_RE.test(JSON.stringify(reply.params)), 'the reply does not carry the notice').toBe(false)
  expect(deepStrings(notice.params).join('\n'), 'the notice names tokens').toMatch(/токен/i)
})

// --- [c6] threshold 0 -------------------------------------------------------------------------------------

test('test_c6_threshold_zero_nothing_is_compacted_after_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon({ [THRESHOLD_ENV]: '0' })
  await buildHistory(d, 'aa', 12)
  const sizes = await contextSizes(d)
  expect(sizes.history, 'the history is long').toBeGreaterThan(5_000)

  const mark = world.timeline.seq
  await runTurn(d, marker('zz', 1), BIG)
  await sleep(IDLE_MS) // absence: no compaction after the reply

  expect(compactionCalls(mark), 'no service turn and no summary after the reply').toHaveLength(0)
  const told = textsSince(OWNER_CHAT, mark).filter((text) => AUTO_NOTICE_RE.test(text) || /сжат|очист|очищ/i.test(text))
  expect(told, 'the owner hears nothing about a compaction').toEqual([])

  const grown = await contextSizes(d)
  expect(grown.total - sizes.total, 'the big message takes the history over the margin of the other tests').toBeGreaterThan(MARGIN_TOKENS)
  const calls = await runTurn(d, marker('zz', 2))
  expect(historyText((calls[0] as DsEvent).body), 'the history of main is intact').toContain(marker('aa', 1))
})

// --- [c7] the compaction after the reply fails ------------------------------------------------------------

async function expectFailureAfterReplyIsHarmless(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  await bigTurn(d)
  await waitFor('a compaction attempt after the reply', () => compactionCalls(mark).length > 0, d, WAIT_MS)
  await waitFor('the warning about the failed compaction', () => warningsSince(mark).length > 0, d, WAIT_MS)
  await sleep(IDLE_MS) // absence: no second warning and no notice of the failed compaction

  const texts = textsSince(OWNER_CHAT, mark)
  expect(warningsSince(mark).length, `the owner gets one warning about the failed compaction\n${texts.join('\n---\n')}`).toBe(1)
  expect(autoNoticesSince(mark), 'no message about a compaction that failed').toHaveLength(0)
  expect(replyOf(marker('zz', 1)), 'the reply stays in the chat').toBeDefined()

  const calls = await runTurn(d, marker('zz', 2))
  const body = (calls[0] as DsEvent).body
  expect(historyText(body), 'the history was not lost: the old turns are there').toContain(marker('aa', 1))
  expect(historyText(body), 'the history was not lost: the big turn is there').toContain(marker('zz', 1))
  expect(historyText(body), 'the message of the owner reached the model').toContain(marker('zz', 2))
  expect(replyOf(marker('zz', 2)), 'the next turn of the owner got its reply').toBeDefined()
}

test('test_c7_a_failed_summary_after_the_reply_warns_once_and_the_next_turn_runs', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  world.stub.failSummary = true
  await expectFailureAfterReplyIsHarmless(d)
})

test('test_c7_a_failed_service_turn_after_the_reply_warns_once_and_the_next_turn_runs', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d } = await startUnderThreshold()
  world.stub.failFlush = true
  await expectFailureAfterReplyIsHarmless(d)
})
