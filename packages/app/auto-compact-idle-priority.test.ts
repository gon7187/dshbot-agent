// The automatic compaction of the history of main never holds the owner back unless the context is far over the
// threshold. Same harness as auto-compact-after-reply.test.ts: the daemon runs as a child process against a fake
// Telegram Bot API and a local DeepSeek stub. The stub plays three kinds of requests:
//   - a request without tools (the summary of a compaction) gets a fixed text;
//   - a request with tools whose last user text carries a marker `ac-xx-N` is a turn of main: the owner turn
//     `ac-zz-N` or `ac-aa-N` answers `fin <marker>`, a wake-up `ac-wk-N` or a planned run `ac-job-N` answers [SILENT];
//   - a request with tools whose last user text has no marker is the service turn before a compaction: the stub
//     writes one fact with the memory tool, then ends with a fixed text.
// While `hold` is a pending promise, the first answers of a compaction (service turn, summary) wait for it.
//
// Contract the tests rely on:
//   - `DSHBOT_AUTO_COMPACT_TOKENS` is the threshold in the tokens `/context` shows;
//   - a message of the owner that comes during a compaction in the idle time interrupts it: the history stays as it
//     was, the turn starts at once, the compaction repeats in the idle time after the reply, and the interrupted
//     attempt tells the owner nothing;
//   - before the turn of the owner the history is compacted only when it is at least twice the threshold; between
//     the threshold and twice the threshold the turn runs on the history as it is and the compaction follows the
//     reply;
//   - a turn of main without the owner (wake-up, planned run) that leaves the history over the threshold is
//     followed by a compaction in the idle time, and the owner is not written to about it.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 420_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 150_000
const LONG_POLL_HOLD_MS = 20_000
const SETTLE_MS = 1_500

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const NOTIFY_TOKEN = 'ac-notify-bearer-0123456789'

const OWNER_CHAT = 7

/** kv key of the paired owner chat (OWNER_KV_KEY of the app); seeded so the daemon starts as paired. */
const OWNER_KV_KEY = 'telegram.owner_chat_id'

const THRESHOLD_ENV = 'DSHBOT_AUTO_COMPACT_TOKENS'

const MARKER_RE = /\bac-[a-z]+-\d+\b/
const SILENT_MARKER_RE = /^ac-(?:wk|job)-/
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
        answerText(SUMMARY_STUB_TEXT)
        return
      }
      if (toolNamesOf(body).length === 0 || isReviewBody(body)) {
        answerText(SUMMARY_STUB_TEXT)
        return
      }
      const marker = markerOf(body)
      if (marker !== undefined) {
        answerText(SILENT_MARKER_RE.test(marker) ? '[SILENT]' : `fin ${marker}`)
        return
      }
      // the service turn before a compaction: save one fact, then finish
      if (stub.hold) await stub.hold
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

/** Main turns and the service turns: requests with tools that are not the background review. */
function mainCalls(): DsEvent[] {
  return world.timeline.events.filter(
    (e): e is DsEvent =>
      e.src === 'ds' && e.body.stream !== false && toolNamesOf(e.body).length > 0 && !isReviewBody(e.body),
  )
}

/** Model requests of one turn, in order. */
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

/** The owner opens a turn with `marker` and waits for the reply of the model to arrive in the chat. */
async function runTurn(d: Daemon, marker: string, filler = ''): Promise<DsEvent[]> {
  say(OWNER_CHAT, `${marker} расскажи что-нибудь ${filler}`)
  await waitFor(`the reply of turn ${marker}`, () => replyOf(marker) !== undefined, d, TURN_WAIT_MS)
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

/** One owner message of about 6000 characters that is never mistaken for a marker. */
const FILLER = 'длинное описание задачи без особого смысла '.repeat(140)

/** The text that takes the history over the threshold: three times the usual filler. */
const BIG = FILLER.repeat(3)

/** Margin above the size of the history on disk: the next turn starts under it, a big text ends over it. */
const MARGIN_TOKENS = 1_500

function marker(prefix: string, index: number): string {
  return `ac-${prefix}-${String(index).padStart(2, '0')}`
}

/** The owner talks `count` long turns to the main session: markers ac-<prefix>-01 … */
async function buildHistory(d: Daemon, prefix: string, count: number): Promise<void> {
  for (let index = 1; index <= count; index += 1) await runTurn(d, marker(prefix, index), FILLER)
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-ac-idle-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  world = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    daemons: [],
  }
  mkdirSync(dshbotHome, { recursive: true })
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
async function historyOnDisk(count: number): Promise<Sizes> {
  const first = await startOwnerDaemon({ [THRESHOLD_ENV]: '0' })
  await buildHistory(first, 'aa', count)
  const sizes = await contextSizes(first)
  await stopDaemon(first)
  return sizes
}

/**
 * A history of ten long turns on disk, then a daemon whose threshold is a little above that history: it starts
 * under the threshold, and one big text takes it over (but far from twice the threshold).
 */
async function startUnderThreshold(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const sizes = await historyOnDisk(10)
  const threshold = sizes.total + MARGIN_TOKENS
  const d = await startDaemon({ ...extraEnv, [THRESHOLD_ENV]: String(threshold) })
  const now = await contextSizes(d)
  expect(now.total, 'the daemon starts under the threshold').toBeLessThan(threshold)
  return d
}

/** A daemon over a history of ten turns on disk whose threshold is `share` of the size of that history. */
async function startWithThreshold(share: number): Promise<{ d: Daemon; threshold: number; total: number }> {
  const sizes = await historyOnDisk(10)
  const threshold = Math.floor(sizes.total * share)
  const d = await startDaemon({ [THRESHOLD_ENV]: String(threshold) })
  const now = await contextSizes(d)
  return { d, threshold, total: now.total }
}

// --- [c1 c2 c3] a message of the owner interrupts the compaction in the idle time ----------------------------

test('test_c1_c2_c3_owner_message_during_the_idle_compaction_interrupts_it_and_the_compaction_repeats_after_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startUnderThreshold()
  let release: () => void = () => undefined
  world.stub.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const mark = world.timeline.seq

  // the big turn takes the history over the threshold; the compaction after the reply stops at its service turn
  const big = await runTurn(d, marker('zz', 1), BIG)
  expect(big.length).toBeGreaterThan(0)
  await waitFor('the compaction after the reply to start', () => compactionCalls(mark).length > 0, d)

  // [c1] the next message does not wait for the compaction: the model gets the turn while the compaction is held
  say(OWNER_CHAT, `${marker('zz', 2)} ещё вопрос`)
  await waitFor(
    'the request of the turn while the compaction has not finished',
    () => turnCalls(marker('zz', 2)).length > 0,
    d,
  )
  const body = (turnCalls(marker('zz', 2))[0] as DsEvent).body
  expect(summaryCalls().filter((e) => e.n > mark), 'the held compaction has not produced a summary').toHaveLength(0)
  expect(historyText(body), 'the history is as it was before the compaction: no summary of the interrupted attempt').not.toContain(SUMMARY_STUB_TEXT)
  expect(historyText(body), 'the old turns are still there').toContain(marker('aa', 1))
  expect(historyText(body), 'the big turn is still there').toContain(marker('zz', 1))
  expect(historyText(body), 'the message of the owner reached the model').toContain(marker('zz', 2))

  // [c3] the interrupted attempt tells the owner nothing, whatever the stub does with the held answers
  release()
  await waitFor('the reply to the message that interrupted the compaction', () => replyOf(marker('zz', 2)) !== undefined, d, TURN_WAIT_MS)
  const second = replyOf(marker('zz', 2)) as TgEvent

  // [c2] the compaction repeats in the idle time after that reply, on the history that has the new turn
  await waitFor('the notice of the repeated compaction', () => autoNoticesSince(mark).length > 0, d, TURN_WAIT_MS)
  await sleep(SETTLE_MS) // absence: no second notice and no warning from the interrupted attempt

  const summaries = summaryCalls().filter((e) => e.n > mark)
  expect(summaries.length, `the compaction was repeated and finished once\n${output(d)}`).toBe(1)
  expect((summaries[0] as DsEvent).n, 'the summary comes after the reply to the interrupting message').toBeGreaterThan(second.n)
  expect(historyText((summaries[0] as DsEvent).body), 'the repeated compaction sees the new turn').toContain(marker('zz', 2))
  const notices = autoNoticesSince(mark)
  expect(notices, `the owner gets exactly one notice, from the repeated compaction\n${textsSince(OWNER_CHAT, mark).join('\n---\n')}`).toHaveLength(1)
  expect((notices[0] as TgEvent).n, 'the notice comes after the reply').toBeGreaterThan(second.n)
  expect(warningsSince(mark), 'no warning about a failed compaction').toEqual([])
})

// --- [c4] between the threshold and twice the threshold the turn does not wait ------------------------------

test('test_c4_context_between_the_threshold_and_twice_the_threshold_runs_the_turn_first_and_compacts_after_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d, threshold, total } = await startWithThreshold(0.7)
  expect(total, 'the history is over the threshold').toBeGreaterThanOrEqual(threshold)
  expect(total, 'the history is under twice the threshold').toBeLessThan(threshold * 2)

  const mark = world.timeline.seq
  const calls = await runTurn(d, marker('zz', 1))
  const first = calls[0] as DsEvent
  expect(mainCalls().filter((e) => e.n > mark)[0]?.n, 'the first request after the message is the turn itself').toBe(first.n)
  expect(compactionCalls(mark).filter((e) => e.n < first.n), 'no service turn and no summary before the turn').toHaveLength(0)
  expect(historyText(first.body), 'the turn ran on the history as it was').toContain(marker('aa', 1))
  expect(historyText(first.body)).not.toContain(SUMMARY_STUB_TEXT)

  const reply = replyOf(marker('zz', 1)) as TgEvent
  await waitFor('the notice about the compaction after the reply', () => autoNoticesSince(mark).length > 0, d, TURN_WAIT_MS)
  const after = compactionCalls(mark)
  expect(after.length, 'the compaction ran after the reply').toBeGreaterThan(0)
  expect((after[0] as DsEvent).n, 'the compaction starts after the reply').toBeGreaterThan(reply.n)
  expect((autoNoticesSince(mark)[0] as TgEvent).n, 'the notice comes after the reply').toBeGreaterThan(reply.n)
})

// --- [c5] twice the threshold blocks the turn ---------------------------------------------------------------

test('test_c5_context_at_twice_the_threshold_is_compacted_before_the_turn_and_the_notice_comes_before_the_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { d, threshold, total } = await startWithThreshold(0.45)
  expect(total, 'the history is at least twice the threshold').toBeGreaterThanOrEqual(threshold * 2)

  const mark = world.timeline.seq
  const calls = await runTurn(d, marker('zz', 1))
  const first = calls[0] as DsEvent
  const summaries = summaryCalls().filter((e) => e.n > mark)
  expect(summaries.length, `the history was summarized before the turn\n${output(d)}`).toBeGreaterThanOrEqual(1)
  expect((summaries[0] as DsEvent).n, 'the summary comes before the request of the turn').toBeLessThan(first.n)
  expect(historyText(first.body), 'the turn runs on the compacted history').toContain(SUMMARY_STUB_TEXT)
  expect(historyText(first.body), 'the oldest turns are replaced by the summary').not.toContain(marker('aa', 1))

  const notices = autoNoticesSince(mark)
  expect(notices.length, `the owner got the notice\n${textsSince(OWNER_CHAT, mark).join('\n---\n')}`).toBeGreaterThanOrEqual(1)
  const reply = replyOf(marker('zz', 1)) as TgEvent
  expect((notices[0] as TgEvent).n, 'the notice comes before the reply').toBeLessThan(reply.n)
})

// --- [c6] a wake-up leaves the history over the threshold -----------------------------------------------------

/** Waits until the local HTTP intake of the daemon answers, then posts the text to /wake. */
async function postWake(port: number, text: string): Promise<number> {
  const url = `http://127.0.0.1:${port}/wake`
  const started = Date.now()
  for (;;) {
    try {
      await fetch(url, { method: 'GET' })
      break
    } catch {
      expect(Date.now() - started, 'the HTTP intake of the daemon did not open').toBeLessThan(WAIT_MS)
      await sleep(100)
    }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${NOTIFY_TOKEN}`, 'content-type': 'text/plain; charset=utf-8' },
    body: text,
  })
  return response.status
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('test_c6_wakeup_turn_over_the_threshold_is_compacted_in_the_idle_time_without_a_notice_and_the_owner_turn_runs_on_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const port = await freePort()
  const d = await startUnderThreshold({ DSHBOT_NOTIFY_PORT: String(port), DSHBOT_NOTIFY_TOKEN: NOTIFY_TOKEN })
  const mark = world.timeline.seq

  expect(await postWake(port, `${marker('wk', 1)} ${BIG}`), 'the wake-up event is accepted').toBe(202)
  await waitFor('the wake-up turn to reach the model', () => turnCalls(marker('wk', 1)).length > 0, d, TURN_WAIT_MS)
  await waitFor('the compaction after the wake-up turn', () => summaryCalls().some((e) => e.n > mark), d, TURN_WAIT_MS)
  await sleep(SETTLE_MS) // background: the compaction after the wake-up turn finishes

  const wake = turnCalls(marker('wk', 1))[0] as DsEvent
  expect((compactionCalls(mark)[0] as DsEvent).n, 'the compaction comes after the wake-up turn').toBeGreaterThan(wake.n)
  expect(autoNoticesSince(mark), 'no notice about the compaction without the owner').toHaveLength(0)
  expect(warningsSince(mark), 'no warning about a failed compaction').toEqual([])
  expect(textsSince(OWNER_CHAT, mark).filter((text) => /сжат/i.test(text)), 'the owner is not written to about the compaction').toEqual([])

  // the next turn of the owner starts on the compacted history, with no compaction in front of it
  const next = world.timeline.seq
  const calls = await runTurn(d, marker('zz', 1))
  const first = calls[0] as DsEvent
  expect(compactionCalls(next).filter((e) => e.n < first.n), 'no compaction before the turn of the owner').toHaveLength(0)
  expect(historyText(first.body), 'the turn runs on the compacted history').toContain(SUMMARY_STUB_TEXT)
  expect(historyText(first.body), 'the oldest turns are replaced by the summary').not.toContain(marker('aa', 1))
  expect(historyText(first.body), 'the message of the owner reached the model').toContain(marker('zz', 1))
})

// --- [c7] a planned run of the schedule leaves the history over the threshold ----------------------------------

/** A due schedule row in the store of the running daemon: the ticker starts one planned turn for it. */
function seedDueJob(task: string): void {
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    const registry = createScheduleRegistry(store, { now: () => new Date(Date.now() - 3_600_000) })
    registry.create({ spec: 'every 1m', task, maxRuns: 1 })
  } finally {
    store.close()
  }
}

test('test_c7_planned_run_over_the_threshold_is_compacted_in_the_idle_time_without_a_notice', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startUnderThreshold()
  const mark = world.timeline.seq

  seedDueJob(`${marker('job', 1)} ${BIG}`)
  await waitFor('the planned turn to reach the model', () => turnCalls(marker('job', 1)).length > 0, d, TURN_WAIT_MS)
  await waitFor('the compaction after the planned turn', () => summaryCalls().some((e) => e.n > mark), d, TURN_WAIT_MS)
  await sleep(SETTLE_MS) // background: the compaction after the planned turn finishes

  const planned = turnCalls(marker('job', 1))[0] as DsEvent
  expect((compactionCalls(mark)[0] as DsEvent).n, 'the compaction comes after the planned turn').toBeGreaterThan(planned.n)
  expect(autoNoticesSince(mark), 'no notice about the compaction without the owner').toHaveLength(0)
  expect(warningsSince(mark), 'no warning about a failed compaction').toEqual([])
  expect(textsSince(OWNER_CHAT, mark).filter((text) => /сжат/i.test(text)), 'the owner is not written to about the compaction').toEqual([])
})
