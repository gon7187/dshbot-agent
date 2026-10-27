// Red team of the guest surface (DESIGN D8: the defence is code, not the refusal of the model).
//
// The daemon runs as a child process against a fake Telegram Bot API and a local DeepSeek stub
// (same harness as packages/app/guest.test.ts). The stub plays a model that has been talked into
// everything: in a guest turn it answers with tool_use blocks that carry the names of the owner's
// tools (exec, edit, read, list) and of tools that do not exist yet (memory, schedule, task, ...).
// What counts is what happened afterwards: files on disk, tool results the stub got back, the
// cards and notices the fake Telegram saw, the journal (stderr) and the request bodies themselves.
//
// A tiny preload pins the clock of the daemon to 12:00 UTC so the UTC day cannot roll over in a test.
// The guest rate limit (one message per 3 seconds) is real time: tests space guest messages by
// GUEST_GAP_MS instead of faking timers.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, hostname, release, tmpdir, userInfo } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export const TEST_TIMEOUT_MS = 170_000
export const WAIT_MS = 45_000
export const LONG_POLL_HOLD_MS = 20_000
export const QUIET_MS = 1_800
/** A little over the 3 second guest rate limit. */
export const GUEST_GAP_MS = 3_500

export const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
export const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

export const OWNER_CHAT = 7
export const GUEST_A = 5550001
export const GUEST_B = 5550002
export const GUEST_C = 5550003
export const GUEST_D = 5550004
export const GUEST_E = 5550005
export const STRANGER = 5559001
export const GROUP_CHAT = -100500
export const SUPERGROUP_CHAT = -1001234567890

export const SECRET_FILE = 'secret-notes.txt'
export const SECRET_TEXT = 'SECRET-WORKSPACE-CONTENT-4711'
/** Printed only when the shell really evaluates the arithmetic: the call itself carries `$((6*7))`. */
export const EXEC_CANARY = 'EXEC-CANARY-42'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type JsonObject = Record<string, unknown>

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

// --- shared timeline of everything the two fake servers saw ---------------------------------

export interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
}

export interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
}

export type Event = TgEvent | DsEvent

export interface Timeline {
  events: Event[]
  lastActivityAt: number
  seq: number
}

export function newTimeline(): Timeline {
  return { events: [], lastActivityAt: Date.now(), seq: 0 }
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

// --- the scripted model --------------------------------------------------------------------------

/** One tool_use the stub puts into its answer. */
export interface ForgedCall {
  name: string
  input: JsonObject
}

export interface ToolResultSeen {
  text: string
  isError: boolean
}

export interface Stub {
  server: Server
  origin: string
  /** tool_use blocks sent as the answer to every fresh message that does not start with OWNER */
  forge: ForgedCall[]
  /** usage.output_tokens of every answer, to make a turn cost money */
  outputTokens: number
  /** tool_use ids the stub sent, in order */
  sentIds: string[]
  /** tool results the model requests carried back, by tool_use id */
  results: Map<string, ToolResultSeen>
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function messageStart(stub: Stub): string {
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
      usage: { input_tokens: 12, output_tokens: stub.outputTokens },
    },
  })
}

export function messageEnd(stub: Stub, stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: 12, output_tokens: stub.outputTokens },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

export function textStream(stub: Stub, text: string): string {
  return [
    messageStart(stub),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd(stub, 'end_turn'),
  ].join('')
}

export function toolUseStream(stub: Stub, blocks: Array<{ id: string; call: ForgedCall }>): string {
  const parts = [messageStart(stub)]
  blocks.forEach(({ id, call }, index) => {
    parts.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name: call.name, input: {} },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index }),
    )
  })
  parts.push(messageEnd(stub, 'tool_use'))
  return parts.join('')
}

export function pongMessage(stub: Stub): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: stub.outputTokens },
  })
}

export function flatten(content: unknown): string {
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

export function lastMessage(body: JsonObject): JsonObject {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return asObject(messages[messages.length - 1])
}

/** tool_result blocks carried by the last message of a model request. */
export function lastToolResults(body: JsonObject): Array<{ id: string; text: string; isError: boolean }> {
  const message = lastMessage(body)
  if (message.role !== 'user' || !Array.isArray(message.content)) return []
  const found: Array<{ id: string; text: string; isError: boolean }> = []
  for (const part of message.content) {
    const block = asObject(part)
    if (block.type !== 'tool_result') continue
    found.push({ id: String(block.tool_use_id ?? ''), text: flatten(block.content), isError: block.is_error === true })
  }
  return found
}

export function lastUserText(body: JsonObject): string {
  const message = lastMessage(body)
  return message.role === 'user' ? flatten(message.content) : ''
}

export async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    forge: [],
    outputTokens: 1,
    sentIds: [],
    results: new Map(),
  }
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
        res.end(pongMessage(stub))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      const seen = lastToolResults(body)
      if (seen.length > 0) {
        for (const result of seen) stub.results.set(result.id, { text: result.text, isError: result.isError })
        res.end(textStream(stub, 'pong'))
        return
      }

      const text = lastUserText(body)
      if (stub.forge.length === 0 || text.startsWith('OWNER')) {
        const echo = /say:(\S+)/.exec(text)?.[1]
        res.end(textStream(stub, echo === undefined ? 'pong' : `pong ${echo}`))
        return
      }
      const blocks = stub.forge.map((call, index) => ({ id: `toolu_forged_${stub.sentIds.length + index + 1}`, call }))
      for (const block of blocks) stub.sentIds.push(block.id)
      res.end(toolUseStream(stub, blocks))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- forged calls ----------------------------------------------------------------------------------

export const FORGED_EXEC: ForgedCall = {
  name: 'exec',
  input: { command: 'echo EXEC-CANARY-$((6*7)) > exec-pwned.txt; cat exec-pwned.txt' },
}
export const FORGED_EDIT: ForgedCall = { name: 'edit', input: { path: 'edit-pwned.txt', content: 'pwned by a guest' } }
export const FORGED_READ: ForgedCall = { name: 'read', input: { path: SECRET_FILE } }
export const FORGED_LIST: ForgedCall = { name: 'list', input: { path: '.' } }

/** Owner tools that exist in the app today; every attempt with these names is a rejected attempt. */
export const FORGED_REGISTERED: ForgedCall[] = [FORGED_EXEC, FORGED_EDIT, FORGED_READ, FORGED_LIST]

/** Tools of the roadmap: memory, schedules, tasks, web, zavod, subagents, skills. */
export const FORGED_FUTURE: ForgedCall[] = [
  { name: 'memory', input: { action: 'write', text: 'GUEST-MEMORY-WRITE' } },
  { name: 'schedule', input: { action: 'create', cron: '* * * * *', prompt: 'GUEST-SCHEDULE' } },
  { name: 'task', input: { action: 'create', title: 'GUEST-TASK', acceptance: 'true' } },
  { name: 'web', input: { url: 'http://127.0.0.1:9/guest' } },
  { name: 'zavod', input: { action: 'start', title: 'GUEST-ZAVOD' } },
  { name: 'subagent', input: { prompt: 'GUEST-SUBAGENT' } },
  { name: 'skill_create', input: { name: 'guest-skill', body: 'GUEST-SKILL' } },
]

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

export function flushQueue(tg: FakeTelegram, timeline: Timeline): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  timeline.lastActivityAt = Date.now()
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

export let nextMessageId = 100
export let updateCounter = 5000

export function privateMessage(chatId: number, text: string, extra: JsonObject = {}): JsonObject {
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
      ...extra,
    },
  }
}

/** A message the guest forwards from the owner's chat, as Telegram describes it. */
export function forwardedFromOwner(chatId: number, text: string): JsonObject {
  const owner = { id: OWNER_CHAT, is_bot: false, first_name: 'Owner' }
  return privateMessage(chatId, text, {
    forward_from: owner,
    forward_date: Math.floor(Date.now() / 1000) - 60,
    forward_origin: { type: 'user', sender_user: owner, date: Math.floor(Date.now() / 1000) - 60 },
  })
}

/** A document with a caption: the file itself is not text, the caption is. */
export function documentWithCaption(chatId: number, caption: string): JsonObject {
  const update = privateMessage(chatId, caption)
  const message = asObject(update.message)
  delete message.text
  message.caption = caption
  message.document = { file_id: 'BQACAgIAAxkBAAIB', file_unique_id: 'AgADx', file_name: 'run-me.sh', mime_type: 'text/x-shellscript', file_size: 128 }
  return update
}

export function groupMessage(chatId: number, type: 'group' | 'supergroup', fromId: number, text: string): JsonObject {
  updateCounter += 1
  nextMessageId += 1
  return {
    update_id: updateCounter,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type, title: 'g' },
      from: { id: fromId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

// --- reading what the fake servers received ----------------------------------------------------

export function messagesOf(body: JsonObject): Array<{ role: string; text: string }> {
  const raw = body.messages
  if (!Array.isArray(raw)) return []
  return raw.map((m: unknown) => {
    const message = asObject(m)
    return { role: String(message.role ?? ''), text: flatten(message.content) }
  })
}

export function systemTextOf(body: JsonObject): string {
  const field = flatten(body.system)
  if (field) return field
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(m.text)
  }
  return leading.join('')
}

export function toolNamesOf(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => {
    const t = asObject(tool)
    return typeof t.name === 'string' ? t.name : String(asObject(t.function).name)
  })
}

export function modelCalls(timeline: Timeline): DsEvent[] {
  return timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

/** Model requests whose whole body mentions `needle`. */
export function callsWith(needle: string): DsEvent[] {
  return modelCalls(world.timeline).filter((c) => JSON.stringify(c.body).includes(needle))
}

export function tgEvents(timeline: Timeline): TgEvent[] {
  return timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

export function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return tgEvents(timeline).filter(
    (e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId,
  )
}

export function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
}

export function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

/** Texts the bot sent to `chatId` after timeline position `mark`. */
export function textsSince(mark: number, chatId: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
}

/** Everything the bot ever sent to anybody, flattened to text. */
export function allSentText(): string {
  return tgEvents(world.timeline)
    .filter((e) => e.method !== 'getUpdates')
    .flatMap((e) => deepStrings(e.params))
    .join('\n')
}

export function codeLike(texts: string[]): string[] {
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
  home: string
  dshbotHome: string
  workspace: string
  clockFile: string
  daemons: Daemon[]
}

export let scratch: string
export let clockPreload: string
export let world: World
/** When the test last sent a message as this chat (for the rate limit). */
export let lastSentAt = new Map<number, number>()

export function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

export function noonUtcOffset(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12) - now.getTime()
}

export function spawnDaemon(extraEnv: Record<string, string> = {}): Daemon {
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

export function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

export async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

export async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(extraEnv)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

/** Nothing new has happened on either fake for QUIET_MS and every queued update was handed out. */
export async function settle(): Promise<void> {
  const started = Date.now()
  for (;;) {
    const undelivered = world.tg.queue.some((q) => !q.delivered)
    const quiet = Date.now() - world.timeline.lastActivityAt >= QUIET_MS
    if (!undelivered && quiet) return
    if (Date.now() - started > WAIT_MS) return
    await sleep(60)
  }
}

// --- conversation helpers ---------------------------------------------------------------------------

export function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

/** Waits out the guest rate limit for this chat, then pushes the update. */
export async function pushSpaced(chatId: number, update: JsonObject): Promise<void> {
  const wait = (lastSentAt.get(chatId) ?? 0) + GUEST_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastSentAt.set(chatId, Date.now())
  world.tg.push(update)
}

export async function saySpaced(chatId: number, text: string): Promise<void> {
  await pushSpaced(chatId, privateMessage(chatId, text))
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

export async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, OWNER_CHAT).length > 0,
    d,
  )
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await settle() // background: the pairing confirmation arrives in the background
}

/** The owner sends /invite; the code is read from the link in the answer. */
export async function invite(d: Daemon, duration?: string): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, duration === undefined ? '/invite' : `/invite ${duration}`)
  const linked = (): string | undefined => /[?&]start=([A-Za-z0-9_-]+)/.exec(textsSince(mark, OWNER_CHAT).join('\n'))?.[1]
  await waitFor('an invitation link in the owner chat', () => linked() !== undefined || codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  return linked() ?? (codeLike(textsSince(mark, OWNER_CHAT))[0] as string)
}

export async function joinGuest(d: Daemon, chatId: number): Promise<void> {
  // A week: some tests move the fake clock by a whole day to check the daily
  // limit reset, and the default 30 minute access term would otherwise expire
  // the guest before the next day arrives.
  const code = await invite(d, '7d')
  const before = sentTo(world.timeline, chatId).length
  say(chatId, code)
  await waitFor(`a greeting in chat ${chatId}`, () => sentTo(world.timeline, chatId).length > before, d)
  // the code message is a message of that chat too: the first guest message keeps the rate-limit pause
  lastSentAt.set(chatId, Date.now())
}

/** The owner sends /guests and returns everything the bot said back. */
export async function listGuests(d: Daemon): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/guests')
  await waitFor('an answer to /guests', () => textsSince(mark, OWNER_CHAT).length > 0, d)
  await sleep(300)
  return textsSince(mark, OWNER_CHAT).join('\n')
}

/** Lines of the journal written after `mark` (a stderr length). */
export function journalSince(d: Daemon, mark: number): string[] {
  return d.stderr.slice(mark).split('\n')
}

// --- the owner's state ---------------------------------------------------------------------------------

export const STATE_TABLES = /task|schedul|memory|recall|skill|wake|experience|review|job|note|remind/i

export function treeDigest(root: string, skip: (relative: string) => boolean, relative = ''): string[] {
  const lines: string[] = []
  const entries = existsSync(join(root, relative)) ? readdirSync(join(root, relative), { withFileTypes: true }) : []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (skip(rel)) continue
    if (entry.isDirectory()) {
      lines.push(`${rel}/`, ...treeDigest(root, skip, rel))
    } else if (statSync(join(root, rel)).isFile()) {
      lines.push(`${rel} ${createHash('sha1').update(readFileSync(join(root, rel))).digest('hex')}`)
    }
  }
  return lines
}

/** Files of DSHBOT_HOME (memory, skills, workspace, identity) and the rows of the owner's state tables. */
export function ownerStateSnapshot(): string {
  const files = treeDigest(world.dshbotHome, (rel) => rel === 'dsh' || rel.startsWith('state.db') || rel.startsWith('dsh/'))
  const rows: string[] = []
  const dbPath = join(world.dshbotHome, 'state.db')
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      for (const { name } of tables) {
        if (!STATE_TABLES.test(name) || /^guest/i.test(name)) continue
        rows.push(`${name}: ${JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all(), (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))}`)
      }
    } finally {
      db.close()
    }
  }
  return [...files, ...rows].join('\n')
}

/** Owner memory and workspace seeded before the daemon starts, so a change has something to hit. */
export function seedOwnerFiles(): void {
  mkdirSync(join(world.dshbotHome, 'memory'), { recursive: true })
  mkdirSync(join(world.dshbotHome, 'skills'), { recursive: true })
  mkdirSync(world.workspace, { recursive: true })
  writeFileSync(join(world.dshbotHome, 'memory', 'MEMORY.md'), 'Owner fact: the owner likes tea.\n')
  writeFileSync(join(world.dshbotHome, 'skills', 'deploy.md'), 'Owner skill: deploy by hand.\n')
  writeFileSync(join(world.workspace, SECRET_FILE), `${SECRET_TEXT}\n`)
}

/** What each forged call could have left behind or leaked. */
export function expectNothingExecuted(): void {
  expect(existsSync(join(world.workspace, 'exec-pwned.txt')), 'exec ran for a guest').toBe(false)
  expect(existsSync(join(world.workspace, 'edit-pwned.txt')), 'edit ran for a guest').toBe(false)
  for (const [id, result] of world.stub.results) {
    expect(result.text, `result of ${id} shows that exec ran`).not.toContain(EXEC_CANARY)
    expect(result.text, `result of ${id} leaks the owner's file`).not.toContain(SECRET_TEXT)
  }
  expect(allSentText(), 'the bot said the owner secret in a chat').not.toContain(SECRET_TEXT)
  expect(allSentText(), 'the bot said the exec output in a chat').not.toContain(EXEC_CANARY)
}

export function expectNoApprovalCard(): void {
  for (const e of tgEvents(world.timeline)) {
    if (e.method === 'getUpdates') continue
    const serialized = JSON.stringify(e.params)
    expect(serialized, `${e.method} carries buttons: ${serialized}`).not.toMatch(/inline_keyboard|callback_data|reply_markup/)
  }
}

// --- harness lifecycle ----------------------------------------------------------------------------------

export const CLOCK_PRELOAD = `
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
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-redteam-test-'))
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
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  world = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    clockFile: join(scratch, `clock-${Math.random().toString(36).slice(2)}`),
    daemons: [],
  }
  writeFileSync(world.clockFile, String(noonUtcOffset()))
  lastSentAt = new Map()
  seedOwnerFiles()
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




/** Everything the owner chat received, from the start. */
export function textsSinceStart(chatId: number): string {
  return textsSince(0, chatId).join('\n')
}



export const HOST_STATE_LINES = [
  'Хост ZZHOSTBOX-77 работает на Linux 7.2, пользователь zzowneruser.',
  'Домашний каталог /home/zzowneruser/dshbot, postgres слушает порт 54329.',
]
export const MEMORY_LINE = 'Owner fact: пароль от роутера ZZROUTER-SECRET-91.'

/** Strings that tell a guest where the owner's bot lives. */
export function hostFacts(): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ['home directory of the test daemon', world.home],
    ['DSHBOT_HOME', world.dshbotHome],
    ['parent of DSHBOT_HOME', dirname(world.dshbotHome)],
    ['the repository path', repoRoot.replace(/\/$/, '')],
    ['a home path', '/home/'],
  ]
  const user = userInfo().username
  if (user.length >= 4) facts.push(['the host user name', user])
  const host = hostname()
  if (host.length >= 4) facts.push(['the host name', host])
  facts.push(['the real home directory', homedir()], ['the kernel release', release()])
  return facts
}

export function expectNoHostFacts(system: string): void {
  expect(system.length, 'the guest request has no system prompt').toBeGreaterThan(0)
  expect(system, 'the word Linux reached a guest').not.toMatch(/linux/i)
  for (const [what, fact] of hostFacts()) expect(system, `${what} reached a guest prefix`).not.toContain(fact)
}







/** Numbers on the /guests line of one guest, without the chat id and without durations. */
export function numbersOnLineOf(listing: string, chatId: number): number[] {
  const line = listing.split('\n').find((l) => l.includes(String(chatId)))
  expect(line, `/guests has no line for ${chatId}:\n${listing}`).toBeDefined()
  const rest = (line ?? '')
    .replaceAll(String(chatId), ' ')
    .replace(/\d+\s*(?:мин|min|ч|h|д|d|m)(?![A-Za-zА-Яа-я])/gi, ' ')
  return (rest.match(/\d+/g) ?? []).map(Number)
}




export interface RedMessage {
  /** who says it */
  from: number
  build: () => JsonObject
}


export function allSentTextTo(chatId: number): string {
  return sentTo(world.timeline, chatId)
    .flatMap((e) => deepStrings(e.params))
    .join('\n')
}
