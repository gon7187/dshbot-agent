import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete } from './test-support/turn-events.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 150_000
const WAIT_MS = 45_000
const EXIT_LIMIT_MS = 5_000
const LONG_POLL_HOLD_MS = 20_000
const QUIET_MS = 1_800
const FAIL_REASON = 'upstream-reason-marker-4417'

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const BOT_TOKEN_SECRET_PART = 'AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const STRANGER_CHAT = 8
const GROUP_CHAT = -100500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- shared timeline of everything the two fake servers saw ---------------------------------

type JsonObject = Record<string, unknown>

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
  lastActivityAt: number
  seq: number
}

function newTimeline(): Timeline {
  return { events: [], lastActivityAt: Date.now(), seq: 0 }
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
    // multipart or garbage: keep the raw text for leak checks
  }
  return { __raw: raw }
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

// --- fake DeepSeek Messages API (Anthropic style, SSE) ---------------------------------------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function pongStream(): string {
  return [
    sse('message_start', {
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
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
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

interface Stub {
  server: Server
  origin: string
  timeline: Timeline
  /** When true every model request is answered with HTTP 400 whose message names the reason and echoes the API key. */
  failTurn: boolean
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', timeline, failTurn: false }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      timeline.lastActivityAt = Date.now()
      if (stub.failTurn && isModelCall) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${FAIL_REASON}, x-api-key was ${DEEPSEEK_KEY}` } }))
        return
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(pongStream())
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

interface FailRule {
  status: number
  contentType: string
  body: string
}

interface FakeTelegram {
  server: Server
  origin: string
  timeline: Timeline
  queue: QueuedUpdate[]
  holders: Holder[]
  polls: number
  sentIds: number
  failures: Map<string, FailRule>
  push(update: JsonObject): void
}

function flushQueue(tg: FakeTelegram): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  tg.timeline.lastActivityAt = Date.now()
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
    timeline,
    queue: [],
    holders: [],
    polls: 0,
    sentIds: 0,
    failures: new Map(),
    push(update) {
      tg.queue.push({ update, delivered: false })
      tg.timeline.lastActivityAt = Date.now()
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
      if (method !== 'getUpdates') timeline.lastActivityAt = Date.now()

      const reply = (status: number, contentType: string, body: string): void => {
        res.writeHead(status, { 'content-type': contentType })
        res.end(body)
      }
      if (!match || decodeURIComponent(match[1] ?? '') !== BOT_TOKEN) {
        reply(401, 'application/json', JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
        return
      }
      const rule = tg.failures.get(method)
      if (rule) {
        reply(rule.status, rule.contentType, rule.body)
        return
      }
      if (method === 'getUpdates') {
        tg.polls += 1
        const offset = typeof params.offset === 'number' ? params.offset : undefined
        tg.queue = tg.queue.filter((q) => !(q.delivered && offset !== undefined && (q.update.update_id as number) < offset))
        if (tg.queue.length > 0) {
          for (const q of tg.queue) q.delivered = true
          timeline.lastActivityAt = Date.now()
          reply(200, 'application/json', JSON.stringify({ ok: true, result: tg.queue.map((q) => q.update) }))
          return
        }
        const holder: Holder = {
          res,
          timer: setTimeout(() => {
            const at = tg.holders.indexOf(holder)
            if (at >= 0) tg.holders.splice(at, 1)
            reply(200, 'application/json', JSON.stringify({ ok: true, result: [] }))
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
      reply(200, 'application/json', JSON.stringify({ ok: true, result: okResult(tg, method, params) }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

// --- update builders ---------------------------------------------------------------------------

let nextMessageId = 100

function privateMessage(updateId: number, chatId: number, text: string, messageId = (nextMessageId += 1)): JsonObject {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

function groupMessage(updateId: number, text: string): JsonObject {
  return {
    update_id: updateId,
    message: {
      message_id: (nextMessageId += 1),
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP_CHAT, type: 'group', title: 'g' },
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

function messageIdOf(update: JsonObject): number {
  return (update.message as { message_id: number }).message_id
}

// --- reading what the fake DeepSeek received ----------------------------------------------------

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .join('')
}

interface Msg {
  role: string
  text: string
}

function messagesOf(body: JsonObject): Msg[] {
  const raw = body.messages
  if (!Array.isArray(raw)) return []
  return raw.map((m: unknown) => {
    const message = (m ?? {}) as { role?: unknown; content?: unknown }
    return { role: String(message.role ?? ''), text: flatten(message.content) }
  })
}

function systemTextOf(body: JsonObject): string {
  const field = flatten(body.system)
  if (field) return field
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(m.text)
  }
  return leading.join('')
}

function userTexts(body: JsonObject): string[] {
  return messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
}

function modelCalls(timeline: Timeline): DsEvent[] {
  return timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

/** Model calls whose user messages mention `needle`. */
function callsMentioning(timeline: Timeline, needle: string): DsEvent[] {
  return modelCalls(timeline).filter((c) => userTexts(c.body).some((t) => t.includes(needle)))
}

function tgCalls(timeline: Timeline, method: string): TgEvent[] {
  return timeline.events.filter((e): e is TgEvent => e.src === 'tg' && e.method === method)
}

/** Messages the bot sent (any send method) to `chatId`. */
function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
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
    ...TURN_EVENTS_ON,
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

/** Waits until the daemon polls Telegram (so its handlers are installed). */
async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
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

/** Nothing new has happened on either fake for QUIET_MS and every queued update was handed out. */
async function settle(): Promise<void> {
  const started = Date.now()
  for (;;) {
    const undelivered = world.tg.queue.some((q) => !q.delivered)
    const quiet = Date.now() - world.timeline.lastActivityAt >= QUIET_MS
    if (!undelivered && quiet) return
    if (Date.now() - started > WAIT_MS) return
    await sleep(60)
  }
}

// --- pairing helpers ----------------------------------------------------------------------------------

function secretParts(): string[] {
  return [BOT_TOKEN, BOT_TOKEN_SECRET_PART, DEEPSEEK_KEY]
}

/**
 * Code-like tokens in freshly printed stderr, best first: tokens with digits, then mixed or upper case
 * ones, then lowercase words; tokens on a line that talks about a code or pairing come first.
 */
function codeCandidates(fresh: string): string[] {
  const found: Array<{ token: string; rank: number; hinted: number; at: number }> = []
  let at = 0
  for (const line of fresh.split('\n')) {
    const hinted = /code|код|pair/i.test(line) ? 0 : 1
    for (const token of line.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? []) {
      at += 1
      if (token.length < 6) continue
      if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
      if (secretParts().some((s) => s.includes(token))) continue
      const rank = /\d/.test(token) ? 0 : /^[a-z]+$/.test(token) ? 2 : 1
      found.push({ token, rank, hinted, at })
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.hinted - b.hinted || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
}

let updateCounter = 1000

function say(chatId: number, text: string): JsonObject {
  updateCounter += 1
  const update = privateMessage(updateCounter, chatId, text)
  world.tg.push(update)
  return update
}

/** First private message from `chatId` while there is no owner; returns the code printed to the journal. */
async function requestCode(d: Daemon, chatId: number): Promise<string> {
  const mark = d.stderr.length
  say(chatId, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => codeCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, chatId).length > 0,
    d,
  )
  const code = codeCandidates(d.stderr.slice(mark))[0] as string
  expect(code.length).toBeGreaterThanOrEqual(6)
  return code
}

async function pairOwner(d: Daemon, chatId = OWNER_CHAT): Promise<string> {
  const code = await requestCode(d, chatId)
  say(chatId, code)
  await settle() // background: the pairing confirmation arrives in the background
  return code
}

/** Owner says `text` and waits for the pong that answers it. */
async function ask(d: Daemon, text: string, chatId = OWNER_CHAT): Promise<JsonObject> {
  const pongs = pongsTo(world.timeline, chatId).length
  const update = say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
  return update
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-app-test-'))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline = newTimeline()
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  world = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome: join(mkdtempSync(join(scratch, 'state-')), 'dshbot'),
    daemons: [],
  }
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

function leaks(d: Daemon): string[] {
  const text = `${d.stdout}\n${d.stderr}`
  return secretParts().filter((s) => text.includes(s) || text.includes(encodeURIComponent(s)))
}

test('test_error_failed_turn_tells_the_owner_it_was_not_done_instead_of_repeating_the_old_reply', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await ask(d, 'привет')
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(1)

  world.stub.failTurn = true
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  const calls = modelCalls(world.timeline).length
  const turns = turnCompletions(d)
  say(OWNER_CHAT, 'вопрос, который упадёт')
  await waitFor('the failing model call', () => modelCalls(world.timeline).length > calls || d.exited, d)
  await waitFor('an owner message about the failed turn', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore || d.exited, d)
  // A failed turn ends with the event too, after its notice and reaction reached the fake.
  await waitForTurnComplete(d, turns, 'the failed owner turn', WAIT_MS)

  const fresh = sentTo(world.timeline, OWNER_CHAT)
    .slice(sentBefore)
    .map((e) => JSON.stringify(e.params))
  expect(fresh.length, output(d)).toBeGreaterThan(0)
  // the old answer is not served again
  for (const text of fresh) expect(text, 'the previous reply came back').not.toContain('pong')
  // the owner learns that the turn failed, and why
  const notice = fresh.find((text) => /ход не выполнен/i.test(text))
  expect(notice, `no "ход не выполнен" notice among: ${fresh.join(' | ')}\n${output(d)}`).toBeDefined()
  expect(notice).toContain(FAIL_REASON)
  await stopDaemon(d)
})

test('test_secrets_failed_turn_notice_and_journal_never_carry_the_api_key', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await ask(d, 'привет')

  world.stub.failTurn = true
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  const calls = modelCalls(world.timeline).length
  const turns = turnCompletions(d)
  say(OWNER_CHAT, 'вопрос, который упадёт')
  await waitFor('the failing model call', () => modelCalls(world.timeline).length > calls || d.exited, d)
  await waitFor('an owner message about the failed turn', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore || d.exited, d)
  // A failed turn ends with the event too, after its notice and reaction reached the fake.
  await waitForTurnComplete(d, turns, 'the failed owner turn', WAIT_MS)

  const fresh = sentTo(world.timeline, OWNER_CHAT).slice(sentBefore)
  expect(fresh.some((e) => /ход не выполнен/i.test(JSON.stringify(e.params))), `no failed-turn notice\n${output(d)}`).toBe(true)
  for (const e of world.timeline.events) {
    if (e.src !== 'tg') continue
    for (const secret of secretParts()) expect(JSON.stringify(e.params), `${e.method} carries a secret`).not.toContain(secret)
  }
  expect(leaks(d)).toEqual([])
  await stopDaemon(d)
  expect(leaks(d)).toEqual([])
})
