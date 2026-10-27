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
  /** When true every request is answered with HTTP 500 whose body echoes the API key. */
  failWithKey: boolean
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', timeline, failWithKey: false }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      timeline.lastActivityAt = Date.now()
      if (stub.failWithKey) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `upstream failure, x-api-key was ${DEEPSEEK_KEY}` } }))
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

function spawnDaemon(extraEnv: Record<string, string> = {}): Daemon {
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
    ...extraEnv,
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
  await settle() // absence: nothing else must arrive in the window
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

test('test_c1_first_private_message_without_owner_asks_for_a_code_that_stays_in_the_journal', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  const code = await requestCode(d, OWNER_CHAT)
  await settle() // absence: nothing else must arrive in the window

  // the model is not touched
  expect(modelCalls(world.timeline)).toHaveLength(0)
  // the bot answers in chat 7 and asks for the code
  expect(sentTo(world.timeline, OWNER_CHAT).length).toBeGreaterThan(0)
  // the one-time code of 6+ characters is in the local journal
  expect(code.length).toBeGreaterThanOrEqual(6)
  expect(d.stderr).toContain(code)
  // and in no Telegram API call: not in a method, not in any parameter
  for (const e of world.timeline.events) {
    if (e.src !== 'tg') continue
    expect(`${e.method} ${JSON.stringify(e.params)}`, `code leaked into ${e.method}`).not.toContain(code)
  }
})

test('test_c2_wrong_code_does_not_make_the_chat_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  const code = await requestCode(d, OWNER_CHAT)

  say(OWNER_CHAT, `zz${code}zz`)
  await settle() // absence: nothing else must arrive in the window
  say(OWNER_CHAT, 'ping')
  await settle() // absence: nothing else must arrive in the window

  expect(modelCalls(world.timeline)).toHaveLength(0)
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(0)
})

test('test_c2_after_five_wrong_attempts_even_the_right_code_is_rejected_until_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  const code = await requestCode(d, OWNER_CHAT)

  for (let i = 0; i < 5; i += 1) say(OWNER_CHAT, `wrong-${i}-${code.split('').reverse().join('')}`)
  await settle() // absence: nothing else must arrive in the window
  say(OWNER_CHAT, code)
  await settle() // absence: nothing else must arrive in the window
  say(OWNER_CHAT, 'ping')
  await settle() // absence: nothing else must arrive in the window

  expect(modelCalls(world.timeline)).toHaveLength(0)
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(0)
})

test('test_c2_right_code_on_first_try_saves_the_owner_across_a_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = await startDaemon()
  await pairOwner(first)
  await ask(first, 'ping')
  await stopDaemon(first)

  const calls = modelCalls(world.timeline).length
  const second = await startDaemon()
  // no new pairing round: the stored owner is answered by the model right away
  await ask(second, 'ping again')
  expect(modelCalls(world.timeline).length).toBeGreaterThan(calls)
  expect(callsMentioning(world.timeline, 'ping again').length).toBeGreaterThan(0)
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(2)
})

test('test_c3_owner_ping_gets_reaction_then_model_request_then_pong_then_second_reaction', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const update = await ask(d, 'ping')
  const messageId = messageIdOf(update)
  await waitFor(
    'the second reaction',
    () => tgCalls(world.timeline, 'setMessageReaction').filter((e) => e.params.message_id === messageId).length >= 2,
    d,
  )

  const isReaction = (e: Event): boolean =>
    e.src === 'tg' && e.method === 'setMessageReaction' && e.params.chat_id === OWNER_CHAT && e.params.message_id === messageId
  const isPingRequest = (e: Event): boolean => e.src === 'ds' && userTexts(e.body).some((t) => t.includes('ping'))
  const isPong = (e: Event): boolean =>
    e.src === 'tg' &&
    (e.method === 'sendRichMessage' || e.method === 'sendMessage') &&
    e.params.chat_id === OWNER_CHAT &&
    JSON.stringify(e.params).includes('pong')

  // only this turn counts: from the first reaction on the ping message
  const start = world.timeline.events.find(isReaction)
  expect(start, 'no setMessageReaction on the ping message').toBeDefined()
  const turn = world.timeline.events.filter((e) => e.n >= (start as Event).n)
  const steps = [isReaction, isPingRequest, isPong, isReaction]
  let at = 0
  for (const e of turn) {
    if (at < steps.length && (steps[at] as (e: Event) => boolean)(e)) at += 1
  }
  expect(at, `expected reaction, ping request, pong, reaction in this order; matched ${at} of 4`).toBe(4)
})

test('test_c4_foreign_private_chat_and_group_never_reach_the_model_when_an_owner_exists', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  say(STRANGER_CHAT, 'stranger-text-xyz')
  world.tg.push(groupMessage((updateCounter += 1), 'group-text-xyz'))
  await ask(d, 'ping')
  await settle() // absence: nothing else must arrive in the window

  expect(callsMentioning(world.timeline, 'stranger-text-xyz')).toHaveLength(0)
  expect(callsMentioning(world.timeline, 'group-text-xyz')).toHaveLength(0)
  expect(callsMentioning(world.timeline, 'ping').length).toBeGreaterThan(0)
  expect(pongsTo(world.timeline, STRANGER_CHAT)).toHaveLength(0)
  expect(pongsTo(world.timeline, GROUP_CHAT)).toHaveLength(0)
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(1)
})

test('test_c5_a_repeated_update_id_is_handled_once_also_after_a_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = await startDaemon()
  await pairOwner(first)

  updateCounter += 1
  const ping = privateMessage(updateCounter, OWNER_CHAT, 'ping')
  const turns = turnCompletions(first)
  world.tg.push(ping)
  await waitFor('the first pong', () => pongsTo(world.timeline, OWNER_CHAT).length === 1, first)
  await waitForTurnComplete(first, turns, 'the owner turn ping', WAIT_MS)

  // the same update again in the same run, then a different message to know the duplicate was passed over
  world.tg.push(ping)
  await ask(first, 'second')
  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(2)

  await stopDaemon(first)
  const second = await startDaemon()
  world.tg.push(ping)
  await ask(second, 'third')
  await settle() // absence: nothing else must arrive in the window

  expect(pongsTo(world.timeline, OWNER_CHAT)).toHaveLength(3)
  // one turn for `ping`: history never contains it twice
  const last = modelCalls(world.timeline).at(-1)
  expect(last).toBeDefined()
  const pingMessages = userTexts((last as DsEvent).body).filter((t) => t.includes('ping'))
  expect(pingMessages).toHaveLength(1)
  const pingTurns = modelCalls(world.timeline).filter(
    (c) => userTexts(c.body).some((t) => t.includes('ping')) && !userTexts(c.body).some((t) => t.includes('second')),
  )
  expect(pingTurns).toHaveLength(1)
})

test('test_c6_system_prompt_starts_with_the_charter_and_contains_the_seed_identity', { timeout: TEST_TIMEOUT_MS }, async () => {
  const charter = readFileSync(join(repoRoot, 'CHARTER.md'), 'utf8').trim()
  const identity = readFileSync(join(repoRoot, 'persona', 'identity.seed.md'), 'utf8').trim()

  const d = await startDaemon()
  await pairOwner(d)
  await ask(d, 'ping')

  const calls = callsMentioning(world.timeline, 'ping')
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    const system = systemTextOf(call.body)
    const charterAt = system.indexOf(charter)
    // the charter is the first block; at most a short section heading may precede it
    expect(charterAt, 'the system prompt must contain CHARTER.md').toBeGreaterThanOrEqual(0)
    expect(charterAt).toBeLessThanOrEqual(20)
    const identityAt = system.indexOf(identity)
    expect(identityAt, 'the system prompt must contain persona/identity.seed.md').toBeGreaterThan(charterAt)
  }
})

test('test_c7_panic_from_the_owner_exits_with_77_within_5_seconds_and_a_foreign_panic_does_not', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  say(STRANGER_CHAT, '/panic')
  world.tg.push(groupMessage((updateCounter += 1), '/panic'))
  await ask(d, 'ping')
  await settle() // absence: nothing else must arrive in the window
  expect(d.exited, `a foreign /panic must not stop the daemon\n${output(d)}`).toBe(false)

  const sentAt = Date.now()
  say(OWNER_CHAT, '/panic')
  const result = await Promise.race([d.exit, sleep(EXIT_LIMIT_MS).then(() => undefined)])
  expect(result, `the daemon did not exit within ${EXIT_LIMIT_MS} ms of /panic\n${output(d)}`).toBeDefined()
  expect(Date.now() - sentAt).toBeLessThanOrEqual(EXIT_LIMIT_MS + 500)
  expect(result?.code).toBe(77)
})

test('test_c8_sigterm_without_an_active_turn_exits_with_0_within_5_seconds', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await sleep(700)
  expect(d.exited, output(d)).toBe(false)

  d.child.kill('SIGTERM')
  const result = await Promise.race([d.exit, sleep(EXIT_LIMIT_MS).then(() => undefined)])
  expect(result, `the daemon did not exit within ${EXIT_LIMIT_MS} ms of SIGTERM\n${output(d)}`).toBeDefined()
  expect(result?.signal).toBeNull()
  expect(result?.code).toBe(0)
})

function leaks(d: Daemon): string[] {
  const text = `${d.stdout}\n${d.stderr}`
  return secretParts().filter((s) => text.includes(s) || text.includes(encodeURIComponent(s)))
}

function failTelegramSends(echoUrl: string): void {
  for (const method of ['sendMessage', 'sendRichMessage']) {
    world.tg.failures.set(method, {
      status: 502,
      contentType: 'text/html',
      body: `<html><body><h1>502 Bad Gateway</h1>upstream ${echoUrl} for ${BOT_TOKEN}</body></html>`,
    })
  }
}

function expectNoSecretsSent(): void {
  for (const e of world.timeline.events) {
    if (e.src !== 'tg') continue
    for (const secret of secretParts()) expect(JSON.stringify(e.params), `${e.method} carries a secret`).not.toContain(secret)
  }
}

test('test_c9_deepseek_500_and_telegram_502_never_print_the_secrets', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  failTelegramSends(`${world.tg.origin}/bot${BOT_TOKEN}/sendMessage`)
  world.stub.failWithKey = true

  const calls = modelCalls(world.timeline).length
  say(OWNER_CHAT, 'ping')
  await waitFor('the failing model call', () => modelCalls(world.timeline).length > calls || d.exited, d)
  await settle() // absence: nothing else must arrive in the window

  expect(modelCalls(world.timeline).length).toBeGreaterThan(calls)
  expect(leaks(d)).toEqual([])
  expectNoSecretsSent()
  await stopDaemon(d)
  expect(leaks(d)).toEqual([])
})

test('test_c9_telegram_401_on_the_reaction_and_502_on_sends_never_print_the_token', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  const echoUrl = `${world.tg.origin}/bot${BOT_TOKEN}/setMessageReaction`
  world.tg.failures.set('setMessageReaction', {
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: ${echoUrl} token ${BOT_TOKEN}` }),
  })
  failTelegramSends(echoUrl)
  world.stub.failWithKey = true

  const reactions = tgCalls(world.timeline, 'setMessageReaction').length
  say(OWNER_CHAT, 'ping')
  await waitFor('the failing reaction call', () => tgCalls(world.timeline, 'setMessageReaction').length > reactions || d.exited, d)
  await settle() // absence: nothing else must arrive in the window

  expect(tgCalls(world.timeline, 'setMessageReaction').length).toBeGreaterThan(reactions)
  expect(leaks(d)).toEqual([])
  expectNoSecretsSent()
  await stopDaemon(d)
  expect(leaks(d)).toEqual([])
})

test('test_c9_fatal_telegram_401_after_a_502_does_not_print_the_token', { timeout: TEST_TIMEOUT_MS }, async () => {
  const echoUrl = `${world.tg.origin}/bot${BOT_TOKEN}/getUpdates`
  world.tg.failures.set('getUpdates', {
    status: 502,
    contentType: 'text/html',
    body: `<html><body><h1>502 Bad Gateway</h1>${echoUrl} ${BOT_TOKEN}</body></html>`,
  })
  const d = spawnDaemon()
  await waitFor('the 502 poll', () => tgCalls(world.timeline, 'getUpdates').length >= 1 || d.exited, d)

  world.tg.failures.set('getUpdates', {
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: ${echoUrl} token ${BOT_TOKEN}` }),
  })
  await waitFor('the 401 poll', () => tgCalls(world.timeline, 'getUpdates').length >= 2 || d.exited, d)
  await sleep(2_500)

  expect(tgCalls(world.timeline, 'getUpdates').length).toBeGreaterThanOrEqual(2)
  expect(leaks(d)).toEqual([])
  await stopDaemon(d)
  expect(leaks(d)).toEqual([])
})

// The consciousness parsers throw a plain Error; the daemon must still treat an
// unreadable value as a configuration error (exit 78), not as a crash that
// systemd would restart into the same failure.
test.each([
  { name: 'DSHBOT_PROACTIVE_PER_DAY', value: 'many' },
  { name: 'DSHBOT_FREE_WAKE_CHANCE', value: '2' },
  { name: 'DSHBOT_WAKE_JITTER', value: 'often' },
])('test_c6_unreadable_$name exits_with_the_configuration_code_78', { timeout: TEST_TIMEOUT_MS }, async ({ name, value }) => {
  const d = spawnDaemon({ [name]: value })
  const result = await d.exit
  expect(result, output(d)).toEqual({ code: 78, signal: null })
  expect(d.stderr).toContain(name)
  expect(d.stderr).not.toContain(BOT_TOKEN)
  expect(world.tg.polls, 'a configuration error stops before polling').toBe(0)
})
