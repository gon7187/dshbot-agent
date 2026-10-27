// Guest access for the daemon: owner invites by a one-time code, a guest gets an own harness session,
// a daily limit and /kick. Same harness as daemon.test.ts: the daemon runs as a child process
// against a fake Telegram Bot API and a local DeepSeek stub. A tiny preload shifts the child's clock
// (Date) by an offset read from a file, so the 24 hour expiry and the UTC day can be tested.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { GUEST_CHARTER, GUEST_IDENTITY } from '../src/index.js'
export { GUEST_CHARTER, GUEST_IDENTITY }

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export const TEST_TIMEOUT_MS = 170_000
export const WAIT_MS = 45_000
export const LONG_POLL_HOLD_MS = 20_000
export const QUIET_MS = 1_800
/** A little over the real-time guest pace limit. */
export const GUEST_GAP_MS = 3_500
export const HOUR_MS = 3_600_000

export const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
export const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

export const OWNER_CHAT = 7
export const GUEST_A = 5550001
export const GUEST_B = 5550002
export const GUEST_C = 5550003
export const GROUP_CHAT = -100500
export const SUPERGROUP_CHAT = -1001234567890

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- shared timeline of everything the two fake servers saw ---------------------------------

export type JsonObject = Record<string, unknown>

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

// --- fake DeepSeek Messages API (Anthropic style, SSE) ---------------------------------------

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function pongStream(): string {
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

export function pongMessage(): string {
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

export interface Stub {
  server: Server
  origin: string
  /**
   * Paid-call-then-cancel scenario: the first `COSTCANCEL-first` call answers
   * with an owner tool_use and an expensive usage, the follow-up call with its
   * tool_result is left in flight until the guest cancels the turn.
   */
  costCancel: boolean
  /** The in-flight follow-up call saw its connection close, i.e. the turn was aborted. */
  cancelled: boolean
}

/** The tool_use of the paid-call-then-cancel scenario; the guest schema denies it before execute. */
export function costCancelToolStream(): string {
  const usage = { input_tokens: 12, output_tokens: 1_000_000 }
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
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_costcancel', name: 'read', input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'secret-notes.txt' }) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage,
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

/** True when the last message of a model request carries tool results. */
export function lastMessageHasToolResult(body: JsonObject): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = (messages[messages.length - 1] ?? {}) as { content?: unknown }
  if (!Array.isArray(last.content)) return false
  return last.content.some((part: unknown) => (part as { type?: unknown } | null)?.type === 'tool_result')
}

export async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', costCancel: false, cancelled: false }
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
      if (stub.costCancel && JSON.stringify(body.messages).includes('COSTCANCEL-first')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (lastMessageHasToolResult(body)) {
          // Keep the call open: the guest presses Stop while this request is in
          // flight, after the first (already paid) call completed.
          res.on('close', () => {
            stub.cancelled = true
          })
          return
        }
        res.end(costCancelToolStream())
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
  /** Reject stream drafts with 400 so the stream falls to the edit mode with a Stop button. */
  rejectDrafts: boolean
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
    rejectDrafts: false,
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
      if (tg.rejectDrafts && (method === 'sendRichMessageDraft' || method === 'sendMessageDraft')) {
        reply(400, JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: method not supported' }))
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

export function privateMessage(chatId: number, text: string): JsonObject {
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

/** A press of an inline button (the Stop button of a stream) in `chatId`. */
export function buttonPress(fromId: number, chatId: number, data: string): JsonObject {
  updateCounter += 1
  return {
    update_id: updateCounter,
    callback_query: {
      id: `cb-${updateCounter}`,
      from: { id: fromId, is_bot: false, first_name: 'T' },
      chat_instance: 'dshbot-test-instance',
      data,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'T' },
        text: 'preview',
      },
    },
  }
}

// --- reading what the fake servers received ----------------------------------------------------

export function flatten(content: unknown): string {
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

export interface Msg {
  role: string
  text: string
}

export function messagesOf(body: JsonObject): Msg[] {
  const raw = body.messages
  if (!Array.isArray(raw)) return []
  return raw.map((m: unknown) => {
    const message = (m ?? {}) as { role?: unknown; content?: unknown }
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

export function userTexts(body: JsonObject): string[] {
  return messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => m.text)
}

export function modelCalls(timeline: Timeline): DsEvent[] {
  return timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

/** Model calls whose user messages mention `needle`. */
export function callsMentioning(timeline: Timeline, needle: string): DsEvent[] {
  return modelCalls(timeline).filter((c) => userTexts(c.body).some((t) => t.includes(needle)))
}

/** Messages the bot sent (any send method) to `chatId`. */
export function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

export function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
}

/** Every string value anywhere inside a Bot API call (text, rich blocks), keys excluded. */
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

/** `callback_data` of the Stop button on the newest stream preview sent to `chatId`. */
export function stopCallbackOf(chatId: number): string | undefined {
  const events = world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.params.chat_id !== chatId) continue
    const markup = event.params.reply_markup as { inline_keyboard?: unknown } | undefined
    const rows = markup?.inline_keyboard
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!Array.isArray(row)) continue
      for (const button of row) {
        const data = (button as { callback_data?: unknown } | null)?.callback_data
        if (typeof data === 'string' && data.startsWith('stop:')) return data
      }
    }
  }
  return undefined
}

/**
 * Code-like tokens (8+ characters, not a plain lowercase word, not a date or a timestamp),
 * best first: tokens with digits, then the rest in order of appearance.
 */
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
  clockFile: string
  daemons: Daemon[]
}

export let scratch: string
export let clockPreload: string
export let world: World

export function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

/** Shifts the clock of the daemon process: Date.now() and new Date() add the number found in the clock file. */
export function setClockOffset(ms: number): void {
  writeFileSync(world.clockFile, String(ms))
}

/** Offset that puts the child's clock at 12:00 UTC of the current day. */
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

export function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

export async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

/** Waits until the daemon polls Telegram (so its handlers are installed). */
export async function startDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(extraEnv)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

export async function stopDaemon(d: Daemon): Promise<void> {
  if (d.exited) return
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 8_000)
  await d.exit
  clearTimeout(timer)
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

/** Pairing code tokens in freshly printed stderr: digits first, then upper or mixed case words. */
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

/** The first private chat pairs as the owner with the one-time code from the journal. */
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

/** `chatId` says `text` and waits for the pong that answers it. */
export async function ask(d: Daemon, text: string, chatId: number): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in chat ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
}

/** A guest message honours the real-time pace limit: one accepted message per 3 s. */
export async function askGuest(d: Daemon, text: string, chatId: number): Promise<void> {
  await sleep(GUEST_GAP_MS)
  await ask(d, text, chatId)
}

/** The owner sends /invite and the code is read from the answer in the owner chat. */
export async function invite(d: Daemon): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation code in the owner chat', () => codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  return codeLike(textsSince(mark, OWNER_CHAT))[0] as string
}

/** `chatId` sends a code and waits for any answer (the greeting). */
export async function sendCode(d: Daemon, chatId: number, code: string): Promise<void> {
  const before = sentTo(world.timeline, chatId).length
  say(chatId, code)
  await waitFor(`a greeting in chat ${chatId}`, () => sentTo(world.timeline, chatId).length > before, d)
}

export async function joinGuest(d: Daemon, chatId: number): Promise<string> {
  const code = await invite(d)
  await sendCode(d, chatId, code)
  return code
}

/** The owner sends /guests and returns everything the bot said back. */
export async function listGuests(d: Daemon): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/guests')
  await waitFor('an answer to /guests', () => textsSince(mark, OWNER_CHAT).length > 0, d)
  await sleep(300)
  return textsSince(mark, OWNER_CHAT).join('\n')
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
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-guest-test-'))
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












