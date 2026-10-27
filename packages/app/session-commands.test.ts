// Owner session commands: /new, /status, /model, /compact, /help, the command menu and the iteration
// limit. Same harness as turn-rules.test.ts: the daemon runs as a child process against a fake Telegram
// Bot API and a local DeepSeek stub. The owner chat is seeded into the store before the start, so the
// menu published at start already knows the owner. The stub answers a turn of the main session with
// `fin <marker>` where the marker (`sc-xx-NN`) sits in the last owner message; a request without tools
// (the summary of a compaction) gets a fixed text. A marker can be held: the stub then never answers,
// which plays a turn that is still running.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'
import { createDoctorTool, doctorReport, runDoctor, type DoctorDeps } from './src/doctor.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 150_000
const LONG_POLL_HOLD_MS = 20_000
/** A little over the real-time guest pace limit. */
const GUEST_GAP_MS = 3_500

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

/** kv key of the paired owner chat (OWNER_KV_KEY of the app); seeded so the daemon starts as paired. */
const OWNER_KV_KEY = 'telegram.owner_chat_id'

const MARKER_RE = /\bsc-[a-z]+-\d+\b/
const SUMMARY_STUB_TEXT = 'SUMMARY-STUB of the earlier conversation'

const OWNER_COMMAND_NAMES = ['new', 'status', 'model', 'compact', 'help', 'stop', 'invite', 'kick', 'guests', 'panic']
const OWNER_ONLY_NAMES = ['new', 'status', 'model', 'compact', 'stop', 'invite', 'kick', 'guests', 'panic']

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

interface Held {
  marker: string
  closed: boolean
}

interface Stub {
  server: Server
  origin: string
  /** Markers whose main turn is never answered. */
  holds: Set<string>
  held: Held[]
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

function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function textMessage(text: string): string {
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

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

/** Text of the whole history of a request, system prompt excluded. */
/**
 * A turn's recall block is a service insertion that may quote an archived
 * session as memory; the clean-history checks look at the conversation without
 * it.
 */
function withoutRecallBlocks(text: string): string {
  return text.replace(/<context_recall>[\s\S]*?<\/context_recall>/g, '')
}

function historyText(body: JsonObject): string {
  return withoutRecallBlocks(
    messagesOf(body)
      .map((message) => flatten(message.content))
      .join('\n'),
  )
}

function systemTextOf(body: JsonObject): string {
  const field = flatten(body.system)
  if (field) return field
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(flatten(m.content))
  }
  return leading.join('')
}

function toolNamesOf(body: JsonObject): string[] {
  return (Array.isArray(body.tools) ? body.tools.map(asObject) : [])
    .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
    .filter((name) => name !== '')
}

/** The marker in the last user message of a request, if any. */
function markerOf(body: JsonObject): string | undefined {
  const users = messagesOf(body).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return last === undefined ? undefined : MARKER_RE.exec(flatten(last.content))?.[0]
}

/** The background review of experience: it carries skill_manage and not the owner's edit tool. */
function isReviewBody(body: JsonObject): boolean {
  const names = toolNamesOf(body)
  return names.includes('skill_manage') && !names.includes('edit')
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', holds: new Set(), held: [] }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      const streaming = body.stream !== false
      const marker = toolNamesOf(body).length > 0 ? markerOf(body) : undefined
      const text = marker === undefined ? SUMMARY_STUB_TEXT : `fin ${marker}`
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(textMessage(text))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (marker !== undefined && stub.holds.has(marker)) {
        const held: Held = { marker, closed: false }
        stub.held.push(held)
        res.write(messageStart())
        res.on('close', () => {
          held.closed = true
        })
        return
      }
      res.end(textStream(text))
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
  workspace: string
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

/** Main turns of the owner: requests with tools that are not the background review. */
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

/** The daemon command reached no model: nothing but the background review was asked after `mark`. */
async function expectNoModelAfter(mark: number, context: string): Promise<void> {
  await sleep(1_200)
  const asked = world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.n > mark && !isReviewBody(e.body))
  expect(asked, `${context}: no request to the model`).toHaveLength(0)
}

function sessionsDir(): string {
  return join(world.dshbotHome, 'dsh', 'sessions')
}

function archiveNames(): string[] {
  const dir = sessionsDir()
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('main.bak-')) : []
}

function mainLog(): string {
  return readFileSync(join(sessionsDir(), 'main', 'events.jsonl'), 'utf8')
}

function modelOf(call: DsEvent): unknown {
  return call.body.model
}

/** One owner message of about 6000 characters that is never mistaken for a marker. */
const FILLER = 'длинное описание задачи без особого смысла '.repeat(140)

/** Integers of a text; groups of three digits split by a space or a comma are one number. */
function numbersIn(text: string): number[] {
  return (text.match(/\d{1,3}(?:[\u00a0\u202f ,]\d{3})+|\d+/g) ?? []).map((token) => Number(token.replace(/\D/g, '')))
}

/** The context size in tokens of a status text: the number next to the word "tokens". */
function contextTokensOf(status: string): number | undefined {
  const after = /(\d{1,3}(?:[\u00a0\u202f ,]\d{3})+|\d+)\s*(?:токен|ток\b|tok)/i.exec(status)
  const before = /(?:токен\w*|tokens?)[^\d\n]{0,30}(\d{1,3}(?:[\u00a0\u202f ,]\d{3})+|\d+)/i.exec(status)
  const hit = after?.[1] ?? before?.[1]
  return hit === undefined ? undefined : Number(hit.replace(/\D/g, ''))
}

/** The owner invites a guest chat and the guest enters with the code. */
async function inviteGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation link', () => textsSince(OWNER_CHAT, mark).some((t) => /start=[A-Za-z0-9_-]+/.test(t)), d)
  const code = /start=([A-Za-z0-9_-]+)/.exec(textsSince(OWNER_CHAT, mark).join('\n'))?.[1] as string
  const greeted = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, code)
  await waitFor('the greeting of the guest', () => sentTo(world.timeline, GUEST_CHAT).length > greeted, d)
  await sleep(500)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-sc-')))
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
    workspace: join(dshbotHome, 'workspace'),
    daemons: [],
  }
  mkdirSync(world_.workspace, { recursive: true })
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

// --- [new] ----------------------------------------------------------------------------------------------

test('test_new_archives_main_session_and_next_turn_starts_with_a_clean_history', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await runTurn(d, 'sc-nw-1')
  expect(existsSync(join(sessionsDir(), 'main')), 'the main session is on disk before /new').toBe(true)
  expect(archiveNames()).toEqual([])

  const mark = world.timeline.seq
  const reply = await command(d, '/new')
  const archives = archiveNames()
  expect(archives, 'main was renamed to main.bak-<time>').toHaveLength(1)
  expect(reply, 'the answer names the archive').toContain(archives[0] as string)
  expect(readFileSync(join(sessionsDir(), archives[0] as string, 'events.jsonl'), 'utf8'), 'the old history is in the archive').toContain('sc-nw-1')
  await expectNoModelAfter(mark, '/new')

  const calls = await runTurn(d, 'sc-nw-2')
  const body = (calls[0] as DsEvent).body
  expect(historyText(body), 'the next turn does not see the old history').not.toContain('sc-nw-1')
  expect(messagesOf(body).filter((m) => m.role === 'assistant'), 'no old assistant message').toHaveLength(0)
  const log = mainLog()
  expect(log, 'main is a fresh session').toContain('sc-nw-2')
  expect(withoutRecallBlocks(log), 'main does not carry the old turn').not.toContain('sc-nw-1')
  expect(archiveNames(), 'the archive was not touched again').toEqual(archives)
})

test('test_new_during_a_running_turn_stops_it_first', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  world.stub.holds.add('sc-nh-1')
  say(OWNER_CHAT, 'sc-nh-1 долгий ход')
  await waitFor('the held request of the running turn', () => world.stub.held.length > 0, d)
  expect(world.stub.held[0]?.closed).toBe(false)

  const reply = await command(d, '/new')
  await waitFor('the running request to be aborted by /new', () => world.stub.held[0]?.closed === true, d)
  const archives = archiveNames()
  expect(archives, 'the session was archived').toHaveLength(1)
  expect(reply).toContain(archives[0] as string)
  expect(
    sentTo(world.timeline, OWNER_CHAT).some((e) => JSON.stringify(e.params).includes('fin sc-nh-1')),
    'the stopped turn gives no answer',
  ).toBe(false)

  const calls = await runTurn(d, 'sc-nh-2')
  expect(historyText((calls[0] as DsEvent).body), 'the stopped turn is not in the new history').not.toContain('sc-nh-1')
  expect(mainLog()).not.toContain('sc-nh-1')
})

// --- [status] -------------------------------------------------------------------------------------------

test('test_status_answers_without_a_model_turn_and_shows_the_state_of_main', { timeout: TEST_TIMEOUT_MS }, async () => {
  // A candidate's shared Git directory is intentionally hidden by the evolve sandbox.
  const revision = '1234567890abcdef1234567890abcdef12345678'
  const d = await startOwnerDaemon({ DSHBOT_SHA: revision })
  await runTurn(d, 'sc-st-1', FILLER)
  await runTurn(d, 'sc-st-2', FILLER)
  const calls = await runTurn(d, 'sc-st-3', FILLER)
  const lastRequest = (calls[calls.length - 1] as DsEvent).body
  const requested = messagesOf(lastRequest).filter((m) => m.role === 'user' || m.role === 'assistant').length
  const historyCount = requested + 1

  const mark = world.timeline.seq
  const status = await command(d, '/status')
  await expectNoModelAfter(mark, '/status')

  expect(status, 'the model of main').toMatch(/deepseek-[\w.-]*flash/)
  expect(status, 'the id of the session').toMatch(/\bmain\b/)
  expect(status, `the number of messages of the history (${historyCount})`).toMatch(new RegExp(`(?<![\\d.,])${historyCount}(?![\\d.,]?\\d)`))
  const names = toolNamesOf(lastRequest)
  expect(names.length, 'main has tools').toBeGreaterThan(0)
  for (const name of names) expect(status, `the tool ${name} is listed`).toContain(name)
  // A checkout reports its own HEAD; without a readable Git directory the override is the fallback.
  expect(status, 'the short revision of the running code').toMatch(/sha: [0-9a-f]{7,12}\b/)
  expect(status, 'the uptime of the daemon').toMatch(/аптайм|uptime|работает|работаю/i)
  expect(status, 'the spend of the day').toMatch(/\$\d+\.\d+/)
  const tokens = contextTokensOf(status)
  expect(tokens, `the context estimate in tokens\n${status}`).toBeDefined()

  await runTurn(d, 'sc-st-4', FILLER)
  const later = await command(d, '/status')
  expect(later, 'the history grew by one exchange').toMatch(new RegExp(`(?<![\\d.,])${historyCount + 2}(?![\\d.,]?\\d)`))
  const laterTokens = contextTokensOf(later)
  expect(laterTokens, `the context estimate grows with the history\n${later}`).toBeGreaterThan(tokens as number)
  const next = await runTurn(d, 'sc-st-5')
  expect(historyText((next[0] as DsEvent).body), 'the command is not in the history').not.toContain('/status')
})

// --- [model] --------------------------------------------------------------------------------------------

test('test_model_switches_the_model_of_main_from_the_next_turn_and_keeps_the_history', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const current = await command(d, '/model')
  expect(current, 'without an argument the current model is shown').toMatch(/deepseek-[\w.-]*flash/)
  await runTurn(d, 'sc-md-1')

  const mark = world.timeline.seq
  const switched = await command(d, '/model pro')
  expect(switched.trim().length).toBeGreaterThan(0)
  await expectNoModelAfter(mark, '/model pro')
  expect(await command(d, '/model'), 'the current model is now pro').toContain('deepseek-v4-pro')
  const pro = await runTurn(d, 'sc-md-2')
  for (const call of pro) expect(modelOf(call), 'the request of the next turn uses pro').toBe('deepseek-v4-pro')
  expect(historyText((pro[0] as DsEvent).body), 'the history survives the switch').toContain('sc-md-1')

  const unknown = await command(d, '/model turbo')
  expect(unknown, 'an unknown value lists the choices').toMatch(/flash/)
  expect(unknown).toMatch(/pro/)
  const still = await runTurn(d, 'sc-md-3')
  for (const call of still) expect(modelOf(call), 'an unknown value changes nothing').toBe('deepseek-v4-pro')

  await command(d, '/model flash')
  const flash = await runTurn(d, 'sc-md-4')
  for (const call of flash) expect(modelOf(call), 'the request of the next turn uses flash').toBe('deepseek-flash')
  const text = historyText((flash[0] as DsEvent).body)
  for (const marker of ['sc-md-1', 'sc-md-2', 'sc-md-3']) expect(text, `${marker} stays in the history`).toContain(marker)
  expect(text, 'a command is not a message of the history').not.toContain('/model')
})

test('test_model_choice_survives_a_restart_of_the_daemon', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await runTurn(d, 'sc-mp-1')
  await command(d, '/model pro')
  await stopDaemon(d)

  const again = await startDaemon()
  expect(await command(again, '/model'), 'the choice is remembered').toContain('deepseek-v4-pro')
  const calls = await runTurn(again, 'sc-mp-2')
  for (const call of calls) expect(modelOf(call), 'the restarted daemon asks pro').toBe('deepseek-v4-pro')
  expect(historyText((calls[0] as DsEvent).body), 'the history is the same session').toContain('sc-mp-1')
})

// --- [recall] the turn's recall block ------------------------------------------------------------------

/** Words no ordinary text shares: a message made of them strongly hits whatever memory holds them. */
const RECALL_RARE = 'zorblaxquux wibblefrotz plinkoquark snarfblatt gribnoxel vexorplin'

function seedRecallJournal(name: string, text: string): void {
  const dir = join(world.dshbotHome, 'memory', 'journal')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
}

/** The recall blocks a request carries, wherever they sit. */
function recallBlocksOf(body: JsonObject): string {
  const text = messagesOf(body)
    .map((message) => flatten(message.content))
    .join('\n')
  return (text.match(/<context_recall>[\s\S]*?<\/context_recall>/g) ?? []).join('\n')
}

test('test_recall_block_leaves_out_the_chat_of_main_restored_after_a_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  seedRecallJournal('notes-restart.md', `${RECALL_RARE} JMARKRESTART\n`)
  const d = await startOwnerDaemon()
  await runTurn(d, 'sc-rr-1', `${RECALL_RARE} CHATMARKRESTART`)
  await stopDaemon(d)

  const again = await startDaemon()
  const calls = await runTurn(again, 'sc-rr-2', RECALL_RARE)
  const body = (calls[0] as DsEvent).body
  expect(historyText(body), 'the restarted daemon goes on with the same session').toContain('CHATMARKRESTART')
  const blocks = recallBlocksOf(body)
  expect(blocks, 'the journal is a strong hit of the turn').toContain('JMARKRESTART')
  expect(blocks, 'the restored session is in the history, not in the block').not.toContain('CHATMARKRESTART')
})

test('test_recall_block_is_not_stored_in_the_history_of_main', { timeout: TEST_TIMEOUT_MS }, async () => {
  seedRecallJournal('notes-history.md', `${RECALL_RARE} JMARKHISTORY\n`)
  const d = await startOwnerDaemon()
  const first = await runTurn(d, 'sc-rh-1', RECALL_RARE)
  for (const call of first) expect(recallBlocksOf(call.body), 'every request of the turn carries the block').toContain('JMARKHISTORY')
  expect(mainLog(), 'the session log of main holds no recall block').not.toContain('context_recall')
  expect(mainLog()).not.toContain('JMARKHISTORY')

  const second = await runTurn(d, 'sc-rh-2')
  for (const call of second) {
    expect(JSON.stringify(call.body.messages), 'the next turn does not carry the block of the previous one').not.toContain('JMARKHISTORY')
  }
  expect(historyText((second[0] as DsEvent).body), 'the previous turn itself is in the history').toContain('sc-rh-1')
})

// --- [compact] ------------------------------------------------------------------------------------------

test('test_compact_shrinks_the_history_of_the_same_main_session_and_keeps_the_last_messages', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const markers = Array.from({ length: 12 }, (_, index) => `sc-cp-${String(index + 1).padStart(2, '0')}`)
  let before: DsEvent[] = []
  for (const marker of markers) before = await runTurn(d, marker, FILLER)
  const sizeBefore = JSON.stringify(messagesOf((before[before.length - 1] as DsEvent).body)).length
  const countBefore = messagesOf((before[before.length - 1] as DsEvent).body).length

  const reply = await command(d, '/compact', OWNER_CHAT, TURN_WAIT_MS)
  const sizes = numbersIn(reply)
  expect(sizes.length, `the answer carries the context size before and after\n${reply}`).toBeGreaterThanOrEqual(2)
  expect(sizes[0] as number, 'the size after is smaller than before').toBeGreaterThan(sizes[1] as number)
  expect(archiveNames(), 'the session of main is not archived by /compact').toEqual([])
  expect(existsSync(join(sessionsDir(), 'main')), 'main stays the same session').toBe(true)

  const after = await runTurn(d, 'sc-cp-13')
  const body = (after[0] as DsEvent).body
  const messages = messagesOf(body)
  expect(JSON.stringify(messages).length, 'the request after /compact is shorter').toBeLessThan(sizeBefore)
  expect(messages.length, 'fewer messages after /compact').toBeLessThan(countBefore)
  const lastUser = messages.find((m) => m.role === 'user' && flatten(m.content).includes('sc-cp-12'))
  expect(lastUser, 'the last owner message is kept').toBeDefined()
  const lastReply = messages.find((m) => m.role === 'assistant' && flatten(m.content).includes('fin sc-cp-12'))
  expect(lastReply, 'the last answer is kept').toBeDefined()
  expect(historyText(body), 'the oldest turn is gone from the request').not.toContain('sc-cp-01')
})

// --- [help] ---------------------------------------------------------------------------------------------

test('test_help_lists_every_owner_command_and_gives_a_guest_only_the_guest_ones', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const mark = world.timeline.seq
  const help = await command(d, '/help')
  await expectNoModelAfter(mark, '/help')
  for (const name of OWNER_COMMAND_NAMES) {
    const line = help.split('\n').find((candidate) => candidate.includes(`/${name}`))
    expect(line, `/${name} is listed with a description`).toBeDefined()
    expect((line as string).replace(`/${name}`, '').trim().length, `/${name} has a description on its line`).toBeGreaterThan(5)
  }

  await inviteGuest(d)
  const guestMark = world.timeline.seq
  const guestHelp = await command(d, '/help', GUEST_CHAT)
  expect(guestHelp.trim().length, 'a guest gets an answer').toBeGreaterThan(0)
  for (const name of OWNER_ONLY_NAMES) {
    expect(guestHelp, `/${name} is not shown to a guest`).not.toMatch(new RegExp(`/${name}\\b`))
  }
  await expectNoModelAfter(guestMark, 'a guest /help')
})

// --- [menu] ---------------------------------------------------------------------------------------------

test('test_menu_publishes_the_full_list_for_the_owner_chat_and_the_guest_list_for_the_rest', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const menus = (): TgEvent[] => world.timeline.events.filter((e): e is TgEvent => e.src === 'tg' && e.method === 'setMyCommands')
  const scopeOf = (e: TgEvent): JsonObject => asObject(e.params.scope)
  const namesOf = (e: TgEvent): string[] =>
    (Array.isArray(e.params.commands) ? e.params.commands.map(asObject) : []).map((c) => String(c.command))
  const isOwnerScope = (e: TgEvent): boolean => scopeOf(e).type === 'chat' && Number(scopeOf(e).chat_id) === OWNER_CHAT
  await waitFor('the menu of the owner chat', () => menus().some(isOwnerScope), d)
  await waitFor('the menu for the other chats', () => menus().some((e) => !isOwnerScope(e)), d)

  const owner = menus().filter(isOwnerScope)
  const ownerMenu = owner[owner.length - 1] as TgEvent
  const ownerList = namesOf(ownerMenu)
  for (const name of OWNER_COMMAND_NAMES) expect(ownerList, `the owner menu has /${name}`).toContain(name)
  const entries = Array.isArray(ownerMenu.params.commands) ? ownerMenu.params.commands.map(asObject) : []
  for (const entry of entries) {
    expect(String(entry.description).trim().length, `/${String(entry.command)} has a description`).toBeGreaterThan(0)
  }

  const others = menus().filter((e) => !isOwnerScope(e))
  const guestList = namesOf(others[others.length - 1] as TgEvent)
  expect(guestList.length, 'the guest menu is not empty').toBeGreaterThan(0)
  for (const name of [...OWNER_ONLY_NAMES, 'goal', 'loop', 'budget']) {
    expect(guestList, `the guest menu has no /${name}`).not.toContain(name)
  }
})

// --- [guest] --------------------------------------------------------------------------------------------

test('test_guest_session_commands_are_refused_without_a_model_turn_or_session_change', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await runTurn(d, 'sc-gu-1')
  await inviteGuest(d)
  const mainBefore = mainLog()

  for (const text of ['/new', '/status', '/model pro', '/compact']) {
    await sleep(GUEST_GAP_MS)
    const mark = world.timeline.seq
    const answer = await command(d, text, GUEST_CHAT)
    expect(answer.trim().length, `${text}: the guest gets a refusal`).toBeGreaterThan(0)
    expect(answer, `${text}: the refusal shows no state of the owner`).not.toMatch(/deepseek-|sc-gu-1/)
    await expectNoModelAfter(mark, `guest ${text}`)
  }

  expect(archiveNames(), 'a guest cannot archive main').toEqual([])
  expect(mainLog(), 'the session of main was not touched').toBe(mainBefore)
  const calls = await runTurn(d, 'sc-gu-2')
  expect(historyText((calls[0] as DsEvent).body), 'the history of main is intact').toContain('sc-gu-1')
  for (const call of calls) expect(modelOf(call), 'a guest cannot switch the model').not.toBe('deepseek-v4-pro')
})

// --- [iterlimit] ----------------------------------------------------------------------------------------

const ITERATIONS_NEAR = (limit: number): RegExp =>
  new RegExp(`(?:итерац|iteration)[^\\n]{0,100}(?<!\\d)${limit}(?!\\d)|(?<!\\d)${limit}(?!\\d)[^\\n]{0,100}(?:итерац|iteration)`, 'i')

test('test_iterlimit_default_is_210_in_status_and_in_what_the_model_is_told', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const calls = await runTurn(d, 'sc-it-1')
  const body = (calls[0] as DsEvent).body
  expect(`${systemTextOf(body)}\n${historyText(body)}`, 'the model is told its iteration limit').toMatch(ITERATIONS_NEAR(210))
  expect(await command(d, '/status'), '/status shows the limit').toMatch(ITERATIONS_NEAR(210))
})

test('test_iterlimit_env_value_reaches_status_and_the_model', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon({ DSHBOT_MAX_TURN_ITERATIONS: '37' })
  const calls = await runTurn(d, 'sc-it-2')
  const body = (calls[0] as DsEvent).body
  expect(`${systemTextOf(body)}\n${historyText(body)}`, 'the model is told the configured limit').toMatch(ITERATIONS_NEAR(37))
  expect(await command(d, '/status'), '/status shows the configured limit').toMatch(ITERATIONS_NEAR(37))
})

test.each(['abc', '0', '-3', '2.5'])(
  'test_iterlimit_invalid_value %s stops the start with a clear message',
  { timeout: TEST_TIMEOUT_MS },
  async (value) => {
    seedOwner()
    const pollsBefore = world.tg.polls
    const d = spawnDaemon({ DSHBOT_MAX_TURN_ITERATIONS: value })
    await waitFor('the daemon to exit', () => d.exited, d, 20_000)
    const { code } = await d.exit
    expect(code, `the daemon refuses DSHBOT_MAX_TURN_ITERATIONS=${value}\n${output(d)}`).not.toBe(0)
    expect(d.stderr, 'the message names the variable').toContain('DSHBOT_MAX_TURN_ITERATIONS')
    expect(world.tg.polls, 'the daemon never started polling').toBe(pollsBefore)
  },
)

// --- [btw prefix] ---------------------------------------------------------------------------------------

test('test_btw_side_turn_reuses_the_system_prefix_of_main_byte_for_byte', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const mainBody = ((await runTurn(d, 'sc-bp-1'))[0] as DsEvent).body
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/btw какая сейчас погода')
  const sideCall = (): DsEvent | undefined =>
    world.timeline.events.find(
      (e): e is DsEvent => e.src === 'ds' && e.n > mark && historyText(e.body).includes('какая сейчас погода'),
    )
  await waitFor('the model request of the side question', () => sideCall() !== undefined, d)
  const sideBody = (sideCall() as DsEvent).body
  expect([...toolNamesOf(sideBody)].sort(), 'the side turn keeps only the web tools').toEqual(['web_fetch', 'web_search'])
  expect(toolNamesOf(mainBody).length, 'main has more tools than the side turn').toBeGreaterThan(2)
  expect(systemTextOf(sideBody).length, 'the prefix is not empty').toBeGreaterThan(0)
  expect(JSON.stringify(sideBody.system), 'the side turn has the system prefix of main').toBe(JSON.stringify(mainBody.system))
})

// /doctor branches the daemon tests cannot reach cheaply: a home that cannot be measured, a tool that is on
// PATH but cannot run, and a CDP address that carries a password. runDoctor is called directly.

function doctorDeps(home: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const db = new DatabaseSync(':memory:')
  return {
    home,
    env: { PATH: '', HOME: home, TELEGRAM_BOT_TOKEN: BOT_TOKEN, DEEPSEEK_API_KEY: DEEPSEEK_KEY, DSHBOT_HOME: home },
    telegram: { call: async () => ({ username: 'doctor_bot', id: 1 }) as never },
    deepseek: {
      baseUrl: 'http://127.0.0.1:1',
      apiKey: DEEPSEEK_KEY,
      fetch: async () => new Response('{}', { status: 200 }),
    },
    mcp: { status: () => [], problems: () => [] },
    db,
    budgetMs: 10_000,
    ...overrides,
  }
}

test('test_doctor_unmeasurable_home_is_an_error_with_a_hint', async () => {
  const home = join(scratch, 'doctor-missing-home', 'dshbot')
  const checks = await runDoctor(doctorDeps(home))
  const space = checks.find((item) => item.id === 'space')
  expect(space?.status).toBe('error')
  expect(space?.text).toMatch(/DSHBOT_HOME существует/)
  // The failure of one check does not stop the rest.
  expect(checks.find((item) => item.id === 'age')).toBeDefined()
  expect(checks.find((item) => item.id === 'telegram')?.status).toBe('ok')
})

test('test_doctor_tool_on_path_that_cannot_run_is_an_error_with_a_hint', async () => {
  const bin = realpathSync(mkdtempSync(join(scratch, 'doctor-bin-')))
  // ffmpeg exits non-zero, bwrap is not an executable format at all (the spawn itself fails).
  writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\nexit 3\n')
  writeFileSync(join(bin, 'bwrap'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
  chmodSync(join(bin, 'ffmpeg'), 0o755)
  chmodSync(join(bin, 'bwrap'), 0o755)
  const home = realpathSync(mkdtempSync(join(scratch, 'doctor-home-')))
  const deps = doctorDeps(home)
  const checks = await runDoctor({ ...deps, env: { ...deps.env, PATH: bin } })
  for (const id of ['ffmpeg', 'bwrap']) {
    const line = checks.find((item) => item.id === id)
    expect(line?.status, line?.text).toBe('error')
    expect(line?.text).toMatch(new RegExp(`переустановите ${id}`))
  }
})

test('test_doctor_cdp_url_secret_is_not_in_the_report_or_the_tool_result', async () => {
  const home = realpathSync(mkdtempSync(join(scratch, 'doctor-home-')))
  const userinfoSecret = 'cdp-user-pass-0123456789'
  const deps = doctorDeps(home, {
    browserCdpUrl: `http://admin:${userinfoSecret}@127.0.0.1:1/devtools/${DEEPSEEK_KEY}?token=${BOT_TOKEN}#${userinfoSecret}`,
    secretValues: [DEEPSEEK_KEY],
  })
  const report = await doctorReport(deps)
  const tool = createDoctorTool(() => doctorReport(deps))
  const result = String(await tool.execute({}))
  for (const text of [report, result]) {
    expect(text).toMatch(/CDP http:\/\/127\.0\.0\.1:1/)
    expect(text).not.toContain(userinfoSecret)
    expect(text).not.toContain('admin')
    expect(text).not.toContain(DEEPSEEK_KEY)
    expect(text).not.toContain(BOT_TOKEN)
  }
})

test('c1 c2 doctor distinguishes disabled MCP servers from connection failures', async () => {
  const home = realpathSync(mkdtempSync(join(scratch, 'doctor-mcp-')))
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: {
      disabled: { command: 'disabled-server', enabled: false },
      broken: { command: 'broken-server' },
    },
  }))
  const checks = await runDoctor(doctorDeps(home, {
    mcp: {
      status: () => [
        { name: 'disabled', transport: 'stdio', state: 'disabled', tools: 0, toolDetails: [] },
        { name: 'broken', transport: 'stdio', state: 'failed', tools: 0, toolDetails: [], error: 'connection refused' },
      ],
      problems: () => [],
    },
  }))
  const disabled = checks.find((item) => item.id === 'mcp.disabled')
  const broken = checks.find((item) => item.id === 'mcp.broken')
  expect(broken?.status, broken?.text).toBe('error')
  expect(broken?.text).toContain('connection refused')
  expect(broken?.text).toContain('проверьте command, args и env в mcp.json')
  expect(disabled?.status, disabled?.text).toBe('ok')
  expect(disabled?.text).toMatch(/выключен/i)
  expect(disabled?.text).toMatch(/enabled\s*:\s*false/)
})
