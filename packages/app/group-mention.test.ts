// Groups: the bot lives in allowed groups and answers only when it is addressed. The owner opens a
// group with /group_allow and closes it with /group_deny; in an allowed group only an @mention of the
// bot or a reply to its own message gets a turn, and that turn runs in the group's own session with
// the guest toolset. Same harness as guest.test.ts: the daemon runs as a child process against a fake
// Telegram Bot API and a local DeepSeek stub, and a tiny preload shifts the child's clock (Date) so the
// UTC day of the daily cost limit can be moved.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete, waitForUpdateComplete } from './test-support/turn-events.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
const HOUR_MS = 3_600_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const BOT_ID = 4242
const BOT_USERNAME = 'dshbot_test_bot'
const MENTION = `@${BOT_USERNAME}`
const OTHER_MENTION = '@some_other_helper_bot'

const OWNER_CHAT = 7
const GUEST_A = 5550001
const MEMBER_A = 5550011
const MEMBER_B = 5550012
const GROUP_ONE = -100501
const GROUP_TWO = -1001234567891

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

// --- fake DeepSeek Messages API (Anthropic style, SSE) ---------------------------------------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A one-word answer; `outputTokens` is what the turn is billed for. */
function pongStream(outputTokens: number): string {
  const usage = { input_tokens: 12, output_tokens: outputTokens }
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
        usage,
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage,
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
}

/** A turn whose newest user message carries this marker is billed for a million output tokens. */
const EXPENSIVE_MARK = 'EXPENSIVE-turn'

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '' }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      timeline.lastActivityAt = Date.now()
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      const newestUser = userTexts(body).at(-1) ?? ''
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // 1M output tokens of deepseek-flash cost more than the default daily guest limit of 1 USD.
      res.end(pongStream(newestUser.includes(EXPENSIVE_MARK) ? 1_000_000 : 1))
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

function flushQueue(tg: FakeTelegram, timeline: Timeline): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  timeline.lastActivityAt = Date.now()
  holder.res.writeHead(200, { 'content-type': 'application/json' })
  holder.res.end(JSON.stringify({ ok: true, result: ready.map((q) => q.update) }))
}

function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: BOT_ID, is_bot: true, first_name: 'DSHBOT', username: BOT_USERNAME }
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
      timeline.lastActivityAt = Date.now()
      flushQueue(tg, timeline)
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
          timeline.lastActivityAt = Date.now()
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

// --- update builders ---------------------------------------------------------------------------

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

type Addressing =
  /** Plain group text, nobody is addressed. */
  | { kind: 'none' }
  /** The text starts with an @mention (a real `mention` entity) of `handle`. */
  | { kind: 'mention'; handle: string }
  /** A reply to a message the bot itself sent earlier. */
  | { kind: 'reply-to-bot' }
  /** A reply to a message of another group member. */
  | { kind: 'reply-to-member'; memberId: number }

function groupMessage(
  chatId: number,
  fromId: number,
  text: string,
  addressing: Addressing = { kind: 'none' },
  type: 'group' | 'supergroup' = chatId < -1_000_000_000_000 ? 'supergroup' : 'group',
): JsonObject {
  updateCounter += 1
  nextMessageId += 1
  const chat = { id: chatId, type, title: 'g' }
  const message: JsonObject = {
    message_id: nextMessageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    from: { id: fromId, is_bot: false, first_name: 'T' },
    text,
  }
  if (addressing.kind === 'mention') {
    message.text = `${addressing.handle} ${text}`
    message.entities = [{ type: 'mention', offset: 0, length: addressing.handle.length }]
  } else if (addressing.kind === 'reply-to-bot') {
    message.reply_to_message = {
      message_id: 9001,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: BOT_ID, is_bot: true, first_name: 'DSHBOT', username: BOT_USERNAME },
      text: 'an earlier answer of the bot',
    }
  } else if (addressing.kind === 'reply-to-member') {
    message.reply_to_message = {
      message_id: 8001,
      date: Math.floor(Date.now() / 1000),
      chat,
      from: { id: addressing.memberId, is_bot: false, first_name: 'M' },
      text: 'a remark of another member',
    }
  }
  return { update_id: updateCounter, message }
}

// --- reading what the fake servers received ----------------------------------------------------

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

function userTexts(body: JsonObject): string[] {
  return messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
}

/** Names of the tools a model request offers. */
function toolNamesOf(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools
    .map((tool: unknown) => (tool as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === 'string')
    .sort()
}

function modelCalls(timeline: Timeline): DsEvent[] {
  return timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

/** Model calls whose user messages mention `needle`. */
function callsMentioning(timeline: Timeline, needle: string): DsEvent[] {
  return modelCalls(timeline).filter((c) => userTexts(c.body).some((t) => t.includes(needle)))
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

/** Every string value anywhere inside a Bot API call (text, rich blocks), keys excluded. */
function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

/** Texts the bot sent to `chatId` after timeline position `mark`. */
function textsSince(mark: number, chatId: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
}

/**
 * Code-like tokens (8+ characters, not a plain lowercase word, not a date or a timestamp),
 * best first: tokens with digits, then the rest in order of appearance.
 */
function codeLike(texts: string[]): string[] {
  const found: Array<{ token: string; rank: number; at: number }> = []
  let at = 0
  for (const token of texts.join('\n').match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? []) {
    at += 1
    if (token.length < 8) continue
    if (/^[a-z_]+$/.test(token)) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
    found.push({ token, rank: /\d/.test(token) ? 0 : 1, at })
  }
  found.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
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
  clockFile: string
  daemons: Daemon[]
}

let scratch: string
let clockPreload: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

/** Shifts the clock of the daemon process: Date.now() and new Date() add the number found in the clock file. */
function setClockOffset(ms: number): void {
  writeFileSync(world.clockFile, String(ms))
}

/** Offset that puts the child's clock at 12:00 UTC of the current day. */
function noonUtcOffset(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12) - now.getTime()
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
    FAKE_CLOCK_FILE: world.clockFile,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}`,
    ...TURN_EVENTS_ON,
    // The tests are not about the real-time pace of a chat: keeping it would put
    // a 3 second sleep between almost every message.
    DSHBOT_GUEST_MIN_INTERVAL_MS: '0',
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
async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(extraEnv)
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

// --- conversation helpers ---------------------------------------------------------------------------

function say(chatId: number, text: string): number {
  const update = privateMessage(chatId, text)
  world.tg.push(update)
  return Number(update.update_id)
}

/** Pairing code tokens in freshly printed stderr: digits first, then upper or mixed case words. */
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
  const updateId = say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitForUpdateComplete(d, updateId, 'the pairing message')
}

/** `chatId` says `text` in private and waits for the pong that answers it. */
async function ask(d: Daemon, text: string, chatId: number): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in chat ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
}

/** The owner sends /invite and the code is read from the answer in the owner chat. */
async function invite(d: Daemon): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation code in the owner chat', () => codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  return codeLike(textsSince(mark, OWNER_CHAT))[0] as string
}

async function joinGuest(d: Daemon, chatId: number): Promise<void> {
  const code = await invite(d)
  const before = sentTo(world.timeline, chatId).length
  const updateId = say(chatId, code)
  await waitFor(`a greeting in chat ${chatId}`, () => sentTo(world.timeline, chatId).length > before, d)
  await waitForUpdateComplete(d, updateId, 'the guest code message')
}

/** A group member addresses the bot (or not) and the call returns once its update is handled. */
async function groupSay(d: Daemon, chatId: number, fromId: number, text: string, addressing?: Addressing): Promise<void> {
  const update = groupMessage(chatId, fromId, text, addressing)
  world.tg.push(update)
  await waitForUpdateComplete(d, Number(update.update_id), `the group update ${JSON.stringify(text)}`, WAIT_MS)
}

/** Like {@link groupSay}, but the message must get a pong in the group. */
async function groupAsk(d: Daemon, chatId: number, fromId: number, text: string, addressing: Addressing): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  const turns = turnCompletions(d)
  const update = groupMessage(chatId, fromId, text, addressing)
  world.tg.push(update)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in group ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
  // The event is printed after every send of the turn, so no quiet window is needed.
  await waitForTurnComplete(d, turns, `the group turn ${JSON.stringify(text)}`, WAIT_MS)
  await waitForUpdateComplete(d, Number(update.update_id), `the group update ${JSON.stringify(text)}`, WAIT_MS)
  // Assertions read the timeline right after the event; the fixture records a
  // request before it answers, so the whole reply is already there.
}

const mentionBot: Addressing = { kind: 'mention', handle: MENTION }

/** The owner opens the group with /group_allow, written in the group itself. */
async function allowGroup(d: Daemon, chatId: number): Promise<void> {
  await groupSay(d, chatId, OWNER_CHAT, '/group_allow')
  expect(d.exited, `daemon exited after /group_allow\n${output(d)}`).toBe(false)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

const CLOCK_PRELOAD = `
import { readFileSync } from 'node:fs'
const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
const file = process.env.FAKE_CLOCK_FILE
function offset() {
  if (!file) return 0
  try {
    return Number(readFileSync(file, 'utf8')) || 0
  } catch {
    return 0
  }
}
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) return new target(realNow() + offset())
    return Reflect.construct(target, args, newTarget)
  },
  get(target, prop) {
    if (prop === 'now') return () => realNow() + offset()
    return Reflect.get(target, prop)
  },
  apply(target) {
    return new target(realNow() + offset()).toString()
  },
})
`

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-group-test-'))
  clockPreload = join(scratch, 'fake-clock.mjs')
  writeFileSync(clockPreload, CLOCK_PRELOAD)
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
    clockFile: join(scratch, `clock-${Math.random().toString(36).slice(2)}`),
    daemons: [],
  }
  setClockOffset(0)
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

test('test_c1_owner_group_allow_opens_the_group_group_deny_closes_it_and_the_list_survives_a_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = await startDaemon()
  await pairOwner(first)

  await allowGroup(first, GROUP_ONE)
  await groupAsk(first, GROUP_ONE, MEMBER_A, 'opened-by-owner-aaa', mentionBot)
  expect(callsMentioning(world.timeline, 'opened-by-owner-aaa').length).toBeGreaterThan(0)

  // the allowance is per group: the other group stays closed
  await groupSay(first, GROUP_TWO, MEMBER_A, 'other-group-closed-bbb', mentionBot)
  expect(callsMentioning(world.timeline, 'other-group-closed-bbb')).toHaveLength(0)
  expect(pongsTo(world.timeline, GROUP_TWO)).toHaveLength(0)

  // the list is in state.db, so a restart with the same home keeps the group open
  await stopDaemon(first)
  const second = await startDaemon()
  await groupAsk(second, GROUP_ONE, MEMBER_A, 'after-restart-ccc', mentionBot)
  expect(callsMentioning(world.timeline, 'after-restart-ccc').length).toBeGreaterThan(0)

  // /group_deny closes it again, and a mention no longer reaches the model
  await groupSay(second, GROUP_ONE, OWNER_CHAT, '/group_deny')
  const calls = modelCalls(world.timeline).length
  const sent = sentTo(world.timeline, GROUP_ONE).length
  await groupSay(second, GROUP_ONE, MEMBER_A, 'after-deny-ddd', mentionBot)
  expect(callsMentioning(world.timeline, 'after-deny-ddd')).toHaveLength(0)
  expect(modelCalls(world.timeline).length).toBe(calls)
  expect(sentTo(world.timeline, GROUP_ONE).length).toBe(sent)

  // the denial is durable as well
  await stopDaemon(second)
  const third = await startDaemon()
  await groupSay(third, GROUP_ONE, MEMBER_A, 'denied-after-restart-eee', mentionBot)
  expect(callsMentioning(world.timeline, 'denied-after-restart-eee')).toHaveLength(0)
  expect(pongsTo(world.timeline, GROUP_ONE).length).toBe(2)
  expect(third.exited).toBe(false)
})

test('test_c1_group_allow_and_group_deny_from_a_non_owner_are_ignored', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d, GUEST_A)

  // a plain member and a guest of the bot cannot open a group
  const sent = sentTo(world.timeline, GROUP_ONE).length
  await groupSay(d, GROUP_ONE, MEMBER_A, '/group_allow')
  await groupSay(d, GROUP_ONE, GUEST_A, '/group_allow')
  await groupSay(d, GROUP_ONE, MEMBER_A, 'still-closed-aaa', mentionBot)
  expect(callsMentioning(world.timeline, 'still-closed-aaa')).toHaveLength(0)
  expect(pongsTo(world.timeline, GROUP_ONE)).toHaveLength(0)
  expect(sentTo(world.timeline, GROUP_ONE).length, 'a non-owner command must be ignored silently').toBe(sent)

  // nor can they close a group the owner opened
  await allowGroup(d, GROUP_ONE)
  await groupSay(d, GROUP_ONE, MEMBER_A, '/group_deny')
  await groupSay(d, GROUP_ONE, GUEST_A, '/group_deny')
  await groupAsk(d, GROUP_ONE, MEMBER_B, 'still-open-bbb', mentionBot)
  expect(callsMentioning(world.timeline, 'still-open-bbb').length).toBeGreaterThan(0)
})

test('test_c2_allowed_group_answers_a_mention_and_a_reply_to_the_bot_and_ignores_everything_else', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await allowGroup(d, GROUP_ONE)

  // an @mention gets an answer, from any member
  await groupAsk(d, GROUP_ONE, MEMBER_A, 'mention-text-aaa', mentionBot)
  expect(callsMentioning(world.timeline, 'mention-text-aaa').length).toBeGreaterThan(0)

  // a reply to a message of the bot gets an answer without a mention
  await groupAsk(d, GROUP_ONE, MEMBER_B, 'reply-to-bot-text-bbb', { kind: 'reply-to-bot' })
  expect(callsMentioning(world.timeline, 'reply-to-bot-text-bbb').length).toBeGreaterThan(0)

  // everything else is dropped silently and the model is not called
  const calls = modelCalls(world.timeline).length
  const pongs = pongsTo(world.timeline, GROUP_ONE).length
  const sent = sentTo(world.timeline, GROUP_ONE).length
  await groupSay(d, GROUP_ONE, MEMBER_A, 'plain-chatter-ccc')
  await groupSay(d, GROUP_ONE, MEMBER_B, 'reply-to-member-ddd', { kind: 'reply-to-member', memberId: MEMBER_A })
  await groupSay(d, GROUP_ONE, MEMBER_A, 'other-bot-mention-eee', { kind: 'mention', handle: OTHER_MENTION })
  await groupSay(d, GROUP_ONE, OWNER_CHAT, 'owner-plain-chatter-fff')

  for (const needle of ['plain-chatter-ccc', 'reply-to-member-ddd', 'other-bot-mention-eee', 'owner-plain-chatter-fff']) {
    expect(callsMentioning(world.timeline, needle), `${needle} reached the model`).toHaveLength(0)
  }
  expect(modelCalls(world.timeline).length).toBe(calls)
  expect(pongsTo(world.timeline, GROUP_ONE).length).toBe(pongs)
  expect(sentTo(world.timeline, GROUP_ONE).length, 'the bot said something about unaddressed messages').toBe(sent)
})

test('test_c3_group_turn_runs_in_its_own_session_with_the_guest_toolset_even_for_the_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await allowGroup(d, GROUP_ONE)
  await allowGroup(d, GROUP_TWO)
  await joinGuest(d, GUEST_A)

  await ask(d, 'owner-private-aaa111', OWNER_CHAT)
  // the owner writes in the group: still a group turn
  await groupAsk(d, GROUP_ONE, OWNER_CHAT, 'group-one-owner-bbb222', mentionBot)
  await groupAsk(d, GROUP_TWO, MEMBER_A, 'group-two-ccc333', mentionBot)
  await groupAsk(d, GROUP_ONE, MEMBER_B, 'group-one-again-ddd444', mentionBot)
  await ask(d, 'owner-again-eee555', OWNER_CHAT)
  await ask(d, 'guest-toolset-fff666', GUEST_A)

  const callsOf = (needle: string): DsEvent[] => {
    const calls = callsMentioning(world.timeline, needle)
    expect(calls.length, `no model call for ${needle}`).toBeGreaterThan(0)
    return calls
  }

  // the toolset is the guest one: nothing of what the owner holds
  const ownerTools = toolNamesOf(callsOf('owner-private-aaa111')[0]?.body ?? {})
  const guestTools = toolNamesOf(callsOf('guest-toolset-fff666')[0]?.body ?? {})
  const ownerOnly = ownerTools.filter((name) => !guestTools.includes(name))
  expect(ownerOnly.length, 'the owner turn must offer tools the guest does not have').toBeGreaterThan(0)
  for (const needle of ['group-one-owner-bbb222', 'group-two-ccc333', 'group-one-again-ddd444']) {
    for (const call of callsOf(needle)) {
      const tools = toolNamesOf(call.body)
      expect(tools, `group turn of ${needle} must carry exactly the guest toolset`).toEqual(guestTools)
      for (const name of ownerOnly) expect(tools).not.toContain(name)
    }
  }

  // the sessions do not cross: owner, group one and group two keep their own history
  const seen = (needle: string): string[] => callsOf(needle).map((c) => JSON.stringify(c.body))
  for (const call of seen('group-one-owner-bbb222')) {
    expect(call).not.toContain('owner-private-aaa111')
    expect(call).not.toContain('group-two-ccc333')
  }
  for (const call of seen('group-two-ccc333')) {
    expect(call).not.toContain('owner-private-aaa111')
    expect(call).not.toContain('group-one-owner-bbb222')
  }
  for (const call of seen('group-one-again-ddd444')) {
    expect(call, 'a group keeps its own history').toContain('group-one-owner-bbb222')
    expect(call).not.toContain('owner-private-aaa111')
    expect(call).not.toContain('group-two-ccc333')
  }
  for (const call of seen('owner-again-eee555')) {
    expect(call).toContain('owner-private-aaa111')
    expect(call).not.toContain('group-one-owner-bbb222')
    expect(call).not.toContain('group-two-ccc333')
    expect(call).not.toContain('group-one-again-ddd444')
  }
})

test('test_c4_unallowed_group_gets_no_answer_to_anything_even_a_mention_of_the_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  await joinGuest(d, GUEST_A)

  const calls = modelCalls(world.timeline).length
  const sent = sentTo(world.timeline, GROUP_ONE).length
  await groupSay(d, GROUP_ONE, MEMBER_A, 'closed-mention-aaa', mentionBot)
  await groupSay(d, GROUP_ONE, OWNER_CHAT, 'closed-owner-mention-bbb', mentionBot)
  await groupSay(d, GROUP_ONE, MEMBER_B, 'closed-reply-ccc', { kind: 'reply-to-bot' })
  await groupSay(d, GROUP_ONE, MEMBER_A, 'closed-plain-ddd')
  await groupSay(d, GROUP_ONE, MEMBER_A, '/help', mentionBot)
  await groupSay(d, GROUP_ONE, GUEST_A, 'closed-guest-eee', mentionBot)
  await groupSay(d, GROUP_ONE, MEMBER_A, '/group_deny')

  for (const needle of ['closed-mention-aaa', 'closed-owner-mention-bbb', 'closed-reply-ccc', 'closed-plain-ddd', 'closed-guest-eee']) {
    expect(callsMentioning(world.timeline, needle), `${needle} reached the model`).toHaveLength(0)
  }
  expect(modelCalls(world.timeline).length).toBe(calls)
  expect(sentTo(world.timeline, GROUP_ONE).length, 'the bot answered in a group that is not allowed').toBe(sent)

  // a group the owner opened does not open the others
  await allowGroup(d, GROUP_TWO)
  await groupAsk(d, GROUP_TWO, MEMBER_A, 'open-mention-fff', mentionBot)
  const sentOne = sentTo(world.timeline, GROUP_ONE).length
  await groupSay(d, GROUP_ONE, MEMBER_A, 'still-closed-ggg', mentionBot)
  expect(callsMentioning(world.timeline, 'still-closed-ggg')).toHaveLength(0)
  expect(sentTo(world.timeline, GROUP_ONE).length).toBe(sentOne)
})

test('test_c5_group_turns_count_against_the_daily_cost_limit_until_the_next_day', { timeout: TEST_TIMEOUT_MS }, async () => {
  setClockOffset(noonUtcOffset())
  const d = await startDaemon()
  await pairOwner(d)
  await allowGroup(d, GROUP_ONE)

  // default DSHBOT_GUEST_DAILY_USD is 1; the first turn is billed 1.2
  await groupAsk(d, GROUP_ONE, MEMBER_A, `${EXPENSIVE_MARK}-first`, mentionBot)
  expect(callsMentioning(world.timeline, `${EXPENSIVE_MARK}-first`).length).toBeGreaterThan(0)

  const calls = modelCalls(world.timeline).length
  const pongs = pongsTo(world.timeline, GROUP_ONE).length
  const mark = world.timeline.seq
  await groupSay(d, GROUP_ONE, MEMBER_B, 'over-the-limit-second', mentionBot)
  await groupSay(d, GROUP_ONE, MEMBER_A, 'over-the-limit-reply', { kind: 'reply-to-bot' })

  expect(callsMentioning(world.timeline, 'over-the-limit-second'), 'the model was called over the daily limit').toHaveLength(0)
  expect(callsMentioning(world.timeline, 'over-the-limit-reply'), 'the model was called over the daily limit').toHaveLength(0)
  expect(modelCalls(world.timeline).length).toBe(calls)
  expect(pongsTo(world.timeline, GROUP_ONE).length).toBe(pongs)
  expect(textsSince(mark, GROUP_ONE).join('')).not.toContain('pong')

  // the limit belongs to the group: the owner's own chat is not affected
  await ask(d, 'owner-unaffected-aaa', OWNER_CHAT)

  // the next UTC day starts with a fresh budget
  setClockOffset(noonUtcOffset() + 24 * HOUR_MS)
  await groupAsk(d, GROUP_ONE, MEMBER_B, 'next-day-text-third', mentionBot)
  expect(callsMentioning(world.timeline, 'next-day-text-third').length).toBeGreaterThan(0)
})

