// Streaming the model reply into Telegram. The daemon runs as a child process against a fake Telegram Bot API
// and a local DeepSeek stub (same harness as turn-cancel.test.ts). The stub answers in parts with pauses longer
// than the stream throttle, so the daemon sees generation events one by one. The fake Telegram records every
// call and keeps the state of the chat (what each message shows after sends, edits and deletes), so a test
// asserts what a person would see. The draft methods are rejected with 400 as in a chat without Bot API 10.3
// drafts: the stream falls to the edit mode (sendMessage, then editMessageText with the Stop button).
//
// The model may ask for `gate_probe`, a fake tool registered through the tools seam of the runner (a preload
// swaps the runner module the app imports for a wrapper that appends the tool to the `tools` option). It runs
// until the test creates a gate file or until the AbortSignal it was handed fires.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete } from './test-support/turn-events.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 120_000
const WAIT_MS = 45_000
const CANCEL_WAIT_MS = 20_000
const LONG_POLL_HOLD_MS = 20_000
/** Pause between the parts of a streamed answer: longer than the one-second throttle of the stream. */
const PART_GAP_MS = 1_300
/** The fake tool waits this long unless the gate opens or it is cancelled. */
const GATE_TOOL_MS = 90_000
const TELEGRAM_TEXT_LIMIT = 4096

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const MARKER_RE = /(?:stream|tool|long)-\d+/
const INVITE_LINK = /https:\/\/t\.me\/dshbot_test_bot\?start=([A-Za-z0-9_-]+)/

const STREAM_PARTS = ['Ответ-стрим: альфа ', 'бета ', 'гамма ', 'дельта']
const STREAM_REPLY = STREAM_PARTS.join('')

const TOOL_NAME = 'gate_probe'
const TOOL_PREAMBLE_PARTS = ['Начинаю работу. ', 'Сейчас проверю.']

const LONG_LINES = 70
const LONG_PARTS = 5

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- timeline of everything the two fake servers saw -------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
  /** The id of the message the fake created for a send call. */
  messageId?: number
  /** True when the fake answered the call with an error. */
  rejected: boolean
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

// --- the DeepSeek stub ----------------------------------------------------------------------------
//
// The marker of the turn is the last `stream-N` / `tool-N` / `long-N` in a user text message.
//   stream: the answer comes in STREAM_PARTS with pauses.
//   tool:   some text, then a call of the gate tool; with the tool_result the answer is `fin <marker>`.
//   long:   an answer of LONG_LINES paragraphs, longer than a Telegram message, in LONG_PARTS parts.

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

function textStart(index: number): string {
  return sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
}

function textDelta(index: number, text: string): string {
  return sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
}

function blockStop(index: number): string {
  return sse('content_block_stop', { type: 'content_block_stop', index })
}

function toolUseBlock(index: number, id: string, name: string): string {
  return [
    sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({}) },
    }),
    blockStop(index),
  ].join('')
}

function plainMessage(text: string): string {
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
      const record = asObject(block)
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

function blocksOf(message: unknown): JsonObject[] {
  const content = asObject(message).content
  return Array.isArray(content) ? content.map(asObject) : []
}

function messagesOf(body: JsonObject): unknown[] {
  return Array.isArray(body.messages) ? body.messages : []
}

/** The marker of the last user text message of the request. */
function markerOf(body: JsonObject): string | undefined {
  const messages = messagesOf(body)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asObject(messages[i])
    if (message.role !== 'user') continue
    const found = MARKER_RE.exec(flatten(message.content))
    if (found) return found[0]
  }
  return undefined
}

function lastMessageIsToolResult(body: JsonObject): boolean {
  const messages = messagesOf(body)
  const last = messages[messages.length - 1]
  return blocksOf(last).some((block) => block.type === 'tool_result')
}

function lineOf(index: number): string {
  return `Строка-${String(index).padStart(4, '0')} абвгд ежзий клмно пртуф хцчшщ эюя абвгд ежзий клмно пртуф хцчшщ эюя`
}

function longParts(): string[] {
  const per = LONG_LINES / LONG_PARTS
  const parts: string[] = []
  for (let part = 0; part < LONG_PARTS; part += 1) {
    const lines: string[] = []
    for (let i = part * per + 1; i <= (part + 1) * per; i += 1) lines.push(lineOf(i))
    parts.push(lines.join('\n\n') + (part === LONG_PARTS - 1 ? '' : '\n\n'))
  }
  return parts
}

/** The text of one assistant message in several deltas, with pauses between them. */
async function streamTextParts(res: ServerResponse, parts: string[], finish: string): Promise<void> {
  res.write(messageStart() + textStart(0))
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) await sleep(PART_GAP_MS)
    res.write(textDelta(0, parts[i] as string))
  }
  res.end(blockStop(0) + finish)
}

interface Stub {
  server: Server
  origin: string
}

async function startStub(timeline: Timeline): Promise<Stub> {
  let toolUses = 0
  const stub: Stub = { server: undefined as unknown as Server, origin: '' }
  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then(async (raw) => {
      const body = parseObject(raw)
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall && body.stream !== false) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const marker = markerOf(body)
      if (marker === undefined) {
        await streamTextParts(res, ['pong'], messageEnd('end_turn'))
        return
      }
      if (marker.startsWith('stream')) {
        await streamTextParts(res, STREAM_PARTS, messageEnd('end_turn'))
        return
      }
      if (marker.startsWith('long')) {
        await streamTextParts(res, longParts(), messageEnd('end_turn'))
        return
      }
      if (!lastMessageIsToolResult(body)) {
        toolUses += 1
        res.write(messageStart() + textStart(0))
        for (let i = 0; i < TOOL_PREAMBLE_PARTS.length; i += 1) {
          if (i > 0) await sleep(PART_GAP_MS)
          res.write(textDelta(0, TOOL_PREAMBLE_PARTS[i] as string))
        }
        res.end(blockStop(0) + toolUseBlock(1, `toolu_stub_${toolUses}`, TOOL_NAME) + messageEnd('tool_use'))
        return
      }
      await streamTextParts(res, [`fin ${marker}`], messageEnd('end_turn'))
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
  /** What every message shows now, by `chat:message_id`, in the order of creation. */
  shown: Map<string, string>
  /** False: sendRichMessage answers 400, as in a chat without rich messages. */
  richSupported: boolean
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

interface Outcome {
  error?: string
  result?: unknown
  messageId?: number
}

function chatOf(params: JsonObject): number {
  return typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
}

function shownKey(chatId: number, messageId: unknown): string {
  return `${chatId}:${String(messageId)}`
}

/** What a message shows: the text of a plain message, the whole rich body of a rich one. */
function shownText(params: JsonObject): string {
  if (params.rich_message !== undefined) return JSON.stringify(params.rich_message)
  return typeof params.text === 'string' ? params.text : ''
}

function respond(tg: FakeTelegram, method: string, params: JsonObject): Outcome {
  if (method === 'getMe') return { result: { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' } }
  if (method === 'sendRichMessageDraft' || method === 'sendMessageDraft') {
    return { error: 'Bad Request: method is not supported in this chat' }
  }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    if (method === 'sendRichMessage' && !tg.richSupported) return { error: 'Bad Request: rich messages are not supported' }
    const text = shownText(params)
    if (method === 'sendMessage' && text.length > TELEGRAM_TEXT_LIMIT) return { error: 'Bad Request: message is too long' }
    tg.sentIds += 1
    const chatId = chatOf(params)
    const messageId = 9000 + tg.sentIds
    tg.shown.set(shownKey(chatId, messageId), text)
    return {
      messageId,
      result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' },
    }
  }
  if (method === 'editMessageText') {
    const key = shownKey(chatOf(params), params.message_id)
    const text = shownText(params)
    if (!tg.shown.has(key)) return { error: 'Bad Request: message to edit not found' }
    if (text.length > TELEGRAM_TEXT_LIMIT) return { error: 'Bad Request: message is too long' }
    if (tg.shown.get(key) === text) return { error: 'Bad Request: message is not modified' }
    tg.shown.set(key, text)
    return { result: true }
  }
  if (method === 'deleteMessage') {
    tg.shown.delete(shownKey(chatOf(params), params.message_id))
    return { result: true }
  }
  return { result: true }
}

async function startTelegram(timeline: Timeline, richSupported: boolean): Promise<FakeTelegram> {
  const tg: FakeTelegram = {
    server: undefined as unknown as Server,
    origin: '',
    queue: [],
    holders: [],
    polls: 0,
    sentIds: 0,
    shown: new Map(),
    richSupported,
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
      const event: TgEvent = { n: timeline.seq, src: 'tg', method, params, rejected: false }
      timeline.events.push(event)

      const reply = (status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      }
      if (!match || decodeURIComponent(match[1] ?? '') !== BOT_TOKEN) {
        event.rejected = true
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
      const outcome = respond(tg, method, params)
      if (outcome.messageId !== undefined) event.messageId = outcome.messageId
      if (outcome.error !== undefined) {
        event.rejected = true
        reply(400, JSON.stringify({ ok: false, error_code: 400, description: outcome.error }))
        return
      }
      reply(200, JSON.stringify({ ok: true, result: outcome.result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

let nextMessageId = 100
let updateCounter = 1000

function privateMessage(chatId: number, text: string): JsonObject {
  updateCounter += 1
  return {
    update_id: updateCounter,
    message: {
      message_id: (nextMessageId += 1),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

function buttonPress(fromId: number, chatId: number, messageId: number, data: string): JsonObject {
  updateCounter += 1
  return {
    update_id: updateCounter,
    callback_query: {
      id: `cb-${updateCounter}`,
      from: { id: fromId, is_bot: false, first_name: 'T' },
      chat_instance: 'dshbot-test-instance',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'T' },
        text: 'preview',
      },
    },
  }
}

function say(text: string, chatId = OWNER_CHAT): void {
  world.tg.push(privateMessage(chatId, text))
}

function tgEvents(): TgEvent[] {
  return world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

function sentTo(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId)
}

/** True when any Telegram call (send, edit, draft) carried `needle`. */
function telegramCarried(needle: string): boolean {
  return tgEvents().some((e) => e.method !== 'getUpdates' && JSON.stringify(e.params).includes(needle))
}

/** What the messages of a chat show right now, in the order of their creation. */
function visible(chatId: number): string[] {
  const prefix = `${chatId}:`
  return [...world.tg.shown.entries()].filter(([key]) => key.startsWith(prefix)).map(([, text]) => text)
}

/** Accepted calls of one method to a chat after `mark`. */
function callsSince(mark: number, chatId: number, ...methods: string[]): TgEvent[] {
  return tgEvents().filter((e) => e.n > mark && !e.rejected && methods.includes(e.method) && e.params.chat_id === chatId)
}

function stopCallbackOf(event: TgEvent): string | undefined {
  const rows = asObject(event.params.reply_markup).inline_keyboard
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const button of row) {
      const data = asObject(button).callback_data
      if (typeof data === 'string' && data.startsWith('stop:')) return data
    }
  }
  return undefined
}

function hasButtons(markup: unknown): boolean {
  const rows = asObject(markup).inline_keyboard
  return Array.isArray(rows) && rows.flat().length > 0
}

// --- the gate tool, registered through the seam of the runner ----------------------------------------------

function toolLog(): string[] {
  if (!existsSync(world.toolLog)) return []
  return readFileSync(world.toolLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function writeSeamFiles(dir: string): string {
  const runnerUrl = pathToFileURL(join(repoRoot, 'packages', 'runner', 'src', 'index.ts')).href
  const wrapper = join(dir, 'runner-with-gate-tool.mjs')
  const preload = join(dir, 'preload-gate-tool.mjs')
  writeFileSync(
    wrapper,
    `import { appendFileSync, existsSync } from 'node:fs'
import { startRunner as realStartRunner } from ${JSON.stringify(runnerUrl)}
export * from ${JSON.stringify(runnerUrl)}

const record = (line) => appendFileSync(process.env.GATE_TOOL_LOG, line + '\\n')

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

const gateTool = {
  name: ${JSON.stringify(TOOL_NAME)},
  description: 'Test probe that works until it is released. Call it with no arguments.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(args, ...rest) {
    const signal = [...rest].map((value) => signalIn(value)).find((candidate) => candidate !== undefined)
    record('start')
    return await new Promise((resolve) => {
      const done = (line, text) => {
        clearInterval(poll)
        clearTimeout(timer)
        record(line)
        resolve(text)
      }
      const poll = setInterval(() => {
        if (existsSync(process.env.GATE_FILE)) done('finished', 'gate probe finished')
      }, 50)
      const timer = setTimeout(() => done('finished', 'gate probe finished'), ${GATE_TOOL_MS})
      if (signal?.aborted) done('aborted', 'gate probe aborted')
      else signal?.addEventListener('abort', () => done('aborted', 'gate probe aborted'), { once: true })
    })
  },
}

export async function startRunner(options) {
  return realStartRunner({ ...options, tools: [...(options.tools ?? []), gateTool] })
}
`,
  )
  writeFileSync(
    preload,
    `import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const wrapperUrl = pathToFileURL(${JSON.stringify(wrapper)}).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = typeof context.parentURL === 'string' ? context.parentURL : ''
    if (/runner\\/src\\/index\\.js$/.test(specifier) && parent.includes('/packages/app/src/')) {
      return { url: wrapperUrl, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`,
  )
  return preload
}

// --- the daemon as a child process --------------------------------------------------------------------------

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
  toolLog: string
  gateFile: string
  preload: string
  daemons: Daemon[]
}

let scratch: string
let world: World

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
    GATE_TOOL_LOG: world.toolLog,
    GATE_FILE: world.gateFile,
    ...TURN_EVENTS_ON,
    ...extraEnv,
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(repoRoot, 'packages', 'app', 'register.mjs'),
      '--import',
      world.preload,
      join(repoRoot, 'packages', 'app', 'src', 'main.ts'),
    ],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
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
  const calls = tgEvents()
    .filter((e) => e.method !== 'getUpdates')
    .slice(-25)
    .map((e) => `${e.n} ${e.method}${e.rejected ? ' (rejected)' : ''} ${JSON.stringify(e.params).slice(0, 160)}`)
    .join('\n')
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}\n--- tool log ---\n${toolLog().join('\n')}\n--- last telegram calls ---\n${calls}`
}

async function waitFor(what: string, cond: () => boolean, d: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${output(d)}`).toBe(true)
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
  say('hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  say(pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(extraEnv)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  await pairOwner(d)
  return d
}

/** The owner issues an invitation link and GUEST_CHAT presses it. */
async function joinGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say('/invite')
  await waitFor(
    'an invitation link in the owner chat',
    () => callsSince(mark, OWNER_CHAT, 'sendMessage', 'sendRichMessage').some((e) => INVITE_LINK.test(JSON.stringify(e.params))),
    d,
  )
  const link = callsSince(mark, OWNER_CHAT, 'sendMessage', 'sendRichMessage')
    .map((e) => INVITE_LINK.exec(JSON.stringify(e.params)))
    .find((found) => found !== null)
  const code = link?.[1] ?? ''
  expect(code, 'the invitation code must be in the link').not.toBe('')
  const before = sentTo(GUEST_CHAT).length
  say(`/start ${code}`, GUEST_CHAT)
  await waitFor('the greeting of the new guest', () => sentTo(GUEST_CHAT).length > before, d)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-reply-stream-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

async function openWorld(richSupported: boolean): Promise<void> {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline, richSupported)
  const seamDir = mkdtempSync(join(scratch, 'seam-'))
  mkdirSync(seamDir, { recursive: true })
  world = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome: join(mkdtempSync(join(scratch, 'state-')), 'dshbot'),
    toolLog: join(seamDir, 'gate-tool.log'),
    gateFile: join(seamDir, 'gate-open'),
    preload: writeSeamFiles(seamDir),
    daemons: [],
  }
}

beforeEach(async () => {
  await openWorld(true)
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [stream] --------------------------------------------------------------------------------------------

/** One reply streamed into `chatId`: one send, edits while the model writes, the full text at the end. */
async function expectStreamedReply(d: Daemon, chatId: number, marker: string): Promise<void> {
  const mark = world.timeline.seq
  const turns = turnCompletions(d)
  say(`${marker} расскажи`, chatId)
  await waitFor(
    'the whole reply of the model in the chat',
    () => visible(chatId).some((text) => text.includes(STREAM_REPLY)),
    d,
  )
  // The event comes after every send and edit of the turn (owner or guest alike).
  await waitForTurnComplete(d, turns, `the turn ${marker}`, WAIT_MS)

  const sends = callsSince(mark, chatId, 'sendMessage')
  const edits = callsSince(mark, chatId, 'editMessageText')
  expect(sends, `the reply must start as exactly one sendMessage\n${output(d)}`).toHaveLength(1)
  expect(edits.length, `the preview must be edited while the model writes\n${output(d)}`).toBeGreaterThanOrEqual(1)
  expect(edits.every((e) => e.params.message_id === sends[0]?.messageId), 'edits go to the message that was sent').toBe(true)
  expect(
    String(sends[0]?.params.text ?? ''),
    'the first message is a preview made while the model was still writing',
  ).not.toContain(STREAM_PARTS[STREAM_PARTS.length - 1] as string)
  expect(visible(chatId).some((text) => text.includes(STREAM_REPLY)), 'the final text equals the reply of the model').toBe(true)
}

test('test_stream_owner_reply_is_one_send_then_edits_and_ends_with_the_model_text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await expectStreamedReply(d, OWNER_CHAT, 'stream-1')
})

test('test_stream_guest_reply_is_one_send_then_edits_and_ends_with_the_model_text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await joinGuest(d)
  await expectStreamedReply(d, GUEST_CHAT, 'stream-2')
})

// --- [stop] ----------------------------------------------------------------------------------------------

test('test_stop_button_on_the_stream_cancels_the_turn_and_the_button_is_removed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const mark = world.timeline.seq
  const turns = turnCompletions(d)
  say('tool-1 сделай, пожалуйста')
  await waitFor('the gate tool to start', () => toolLog().includes('start'), d)

  const findPreview = (): TgEvent | undefined =>
    callsSince(mark, OWNER_CHAT, 'sendMessage', 'editMessageText').find((e) => stopCallbackOf(e) !== undefined)
  await waitFor('a message of the stream with the Stop button', () => findPreview() !== undefined, d)
  const withButton = findPreview() as TgEvent
  const data = stopCallbackOf(withButton) as string
  const previewId = withButton.method === 'sendMessage' ? withButton.messageId : Number(withButton.params.message_id)
  expect(typeof previewId, 'the message with the button must have an id').toBe('number')

  const pressedAt = world.timeline.seq
  world.tg.push(buttonPress(OWNER_CHAT, OWNER_CHAT, previewId as number, data))
  await waitFor('the AbortSignal of the running tool to fire after the Stop button', () => toolLog().includes('aborted'), d, CANCEL_WAIT_MS)

  // The stopped turn still ends with the event, after its cleanup of the preview: a final reply of
  // this turn could only have been sent before it.
  await waitForTurnComplete(d, turns, 'the stopped turn tool-1', CANCEL_WAIT_MS)
  expect(toolLog(), 'the tool must not run to its end after the Stop button').not.toContain('finished')
  expect(telegramCarried('fin tool-1'), `the final reply of the model must not be sent after Stop\n${output(d)}`).toBe(false)
  expect(d.exited, `the daemon must survive the Stop button\n${output(d)}`).toBe(false)

  // The keyboard is gone: the last accepted call on the preview after the press leaves no buttons (or deletes it).
  const after = tgEvents().filter(
    (e) =>
      e.n > pressedAt &&
      !e.rejected &&
      (e.method === 'editMessageReplyMarkup' || e.method === 'editMessageText' || e.method === 'deleteMessage') &&
      e.params.chat_id === OWNER_CHAT &&
      e.params.message_id === previewId,
  )
  const last = after[after.length - 1]
  expect(last, `the Stop button must be removed from the preview after the press\n${output(d)}`).toBeDefined()
  expect(last?.method === 'deleteMessage' || !hasButtons(last?.params.reply_markup), 'the last call on the preview must leave no buttons').toBe(true)
})

// --- [status] --------------------------------------------------------------------------------------------

test('test_status_tool_name_is_shown_while_the_tool_runs_and_removed_after_the_final', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const turns = turnCompletions(d)
  say('tool-2 сделай, пожалуйста')
  await waitFor('the gate tool to start', () => toolLog().includes('start'), d)
  await waitFor(
    `the name of the tool (${TOOL_NAME}) in the chat while it runs`,
    () => visible(OWNER_CHAT).some((text) => text.includes(TOOL_NAME)),
    d,
  )
  expect(toolLog(), 'the status must be visible while the tool is still running').not.toContain('finished')

  writeFileSync(world.gateFile, 'open')
  await waitFor('the final reply after the tool finished', () => visible(OWNER_CHAT).some((text) => text.includes('fin tool-2')), d)
  await waitForTurnComplete(d, turns, 'the turn tool-2', WAIT_MS)
  expect(
    visible(OWNER_CHAT).filter((text) => text.includes(TOOL_NAME)),
    `the status with the tool name must be gone after the final\n${output(d)}`,
  ).toEqual([])
  expect(
    visible(OWNER_CHAT).some((text) => text.includes('fin tool-2')),
    'the final reply stays in the chat',
  ).toBe(true)
})

// --- [long] ----------------------------------------------------------------------------------------------

test('test_long_reply_over_4096_chars_arrives_in_several_messages_without_losing_text', { timeout: TEST_TIMEOUT_MS }, async () => {
  // A chat without rich messages: the final goes down the ladder to plain/HTML text, cut to the 4096 limit.
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
  await openWorld(false)

  const d = await startOwnerDaemon()
  const mark = world.timeline.seq
  const turns = turnCompletions(d)
  say('long-1 напиши длинно')
  const lastLine = `Строка-${String(LONG_LINES).padStart(4, '0')}`
  await waitFor('the last line of the long reply in the chat', () => visible(OWNER_CHAT).some((text) => text.includes(lastLine)), d)
  await waitForTurnComplete(d, turns, 'the turn long-1', WAIT_MS)

  const shown = visible(OWNER_CHAT)
  const missing: string[] = []
  for (let i = 1; i <= LONG_LINES; i += 1) {
    const marker = `Строка-${String(i).padStart(4, '0')}`
    if (!shown.some((text) => text.includes(marker))) missing.push(marker)
  }
  expect(missing, `no line of the reply may be lost\n${output(d)}`).toEqual([])

  const carriers = shown.filter((text) => text.includes('Строка-'))
  expect(carriers.length, 'a reply over 4096 chars must arrive in several messages').toBeGreaterThanOrEqual(2)
  for (const text of carriers) expect(text.length, 'one message cannot exceed the Telegram limit').toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT)
  expect(callsSince(mark, OWNER_CHAT, 'sendMessage').length, 'the reply is split into more than one send').toBeGreaterThanOrEqual(2)

  // The long reply is streamed like any other: a preview made while the model writes, then edits of it.
  const sends = callsSince(mark, OWNER_CHAT, 'sendMessage')
  expect(String(sends[0]?.params.text ?? ''), 'the first message is a preview made while the model was still writing').not.toContain(lastLine)
  expect(callsSince(mark, OWNER_CHAT, 'editMessageText').length, 'the preview must be edited while the model writes').toBeGreaterThanOrEqual(1)
})
