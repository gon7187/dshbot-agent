// A text message of the owner that arrives while a turn of his is running joins that turn on its next model step
// (agent.steer) instead of waiting for the end, and a quick series of texts becomes one turn. The daemon runs as a
// child process against a fake Telegram Bot API and a local DeepSeek stub (same harness as turn-cancel.test.ts).
//
// The tools of the stub model:
//   - `gate_probe` replaces the schedule tool of the app (the way turn-cancel-planned.test.ts does it): it waits
//     until the test writes the release file, or until its AbortSignal fires. It keeps a turn of main "in flight"
//     for as long as a test needs, owner turn or planned turn alike.
//   - `host_exec` of the real app (alias `box`, a dangerous command) stands for the card that waits for a decision.
//
// The stub recognises the turn by markers in the text the model is given:
//   gate-N   asks for gate_probe, then answers
//   hold-N   answers only after a pause (the model call of the turn is in flight for a while)
//   card-N   asks for tool_search, then for host_exec on a dangerous command, then answers
//   nudge-N  answers with a promise of later work (the app asks once more), the second request asks for gate_probe
//   ok-N     answers at once
// A message of the owner without a marker (`sw-N ...`) never starts a script. The answer is
// `fin <last marker> r<number of the model request>`, so a turn answered twice shows up as two different numbers.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 150_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
const QUIET_MS = 2_500
/** The steer travels through the poller lane at once; this is the time the daemon gets to take it before the gate opens. */
const STEER_SETTLE_MS = 1_000
/** The model call of a `hold` turn is answered after this pause. */
const HOLD_MS = 2_500
/** A pause well under the default debounce of 300 ms. */
const QUICK_GAP_MS = 100
/** The final reaction hangs longer than two repeats of "typing…" (every 4 s). */
const DONE_REACTION_HANG_MS = 9_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 31

const MARKER_RE = /(?:gate|ok|hold|card|nudge)-\d+/g
const SCRIPTED_RE = /^(?:gate|hold|card|nudge)-/
const NUDGE_FRAGMENT = 'Обещание без задачи не принимается'
const FAILURE_WORDS = /отказ|запрещ|нельзя|не выполн|refus|denied|declin|forbid|not allowed|error|ошибк|expired|истек|истёк/i
/** The status reactions the app puts on a message it serves itself: working and done. */
const OWN_REACTIONS = ['👀', '🎉']

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- timeline of everything the two fake servers saw -------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
  messageId?: number
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

// --- reading a model request ----------------------------------------------------------------------

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

function blocksOf(message: JsonObject): JsonObject[] {
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.map(asObject) : []
}

/** The text blocks of a user message; tool results are not part of what the user wrote. */
function userTextOf(message: JsonObject): string {
  if (message.role !== 'user') return ''
  return blocksOf(message)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/** Every user text of the request, in order. */
function userTexts(body: JsonObject): string[] {
  return messagesOf(body)
    .map(userTextOf)
    .filter((text) => text !== '')
}

/** How many times `needle` is found in the user texts of the request. */
function occurrences(body: JsonObject, needle: string): number {
  return userTexts(body).reduce((sum, text) => sum + text.split(needle).length - 1, 0)
}

/** Position of the first `needle` in the user texts glued in order, or -1. */
function positionOf(body: JsonObject, needle: string): number {
  return userTexts(body).join('\n').indexOf(needle)
}

interface ToolResult {
  text: string
  isError: boolean
}

function toolResultsOf(message: JsonObject | undefined): ToolResult[] {
  if (message === undefined) return []
  return blocksOf(message)
    .filter((block) => block.type === 'tool_result')
    .map((block) => ({
      text: deepStrings(block.content).join('\n'),
      isError: block.is_error === true,
    }))
}

/** Tool results the model got with this request: those of the user messages after its last answer. */
function lastResults(body: JsonObject): ToolResult[] {
  const messages = messagesOf(body)
  let from = 0
  messages.forEach((message, at) => {
    if (message.role === 'assistant') from = at + 1
  })
  return messages.slice(from).flatMap((message) => toolResultsOf(message))
}

function hasResultText(body: JsonObject, needle: string): boolean {
  return messagesOf(body).some((message) => toolResultsOf(message).some((result) => result.text.includes(needle)))
}

// --- the DeepSeek stub ----------------------------------------------------------------------------

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

/** host_exec input for an alias and a command, placed onto the property names of the schema in tools[]. */
function hostInput(body: JsonObject, alias: string, command: string): JsonObject | undefined {
  const tools = Array.isArray(body.tools) ? body.tools.map(asObject) : []
  const tool = tools.find((candidate) => candidate.name === 'host_exec')
  if (tool === undefined) return undefined
  const props = Object.keys(asObject(asObject(tool.input_schema ?? tool.parameters).properties))
  const commandKey = props.find((p) => /^(command|cmd|script|shell|code)$/i.test(p)) ?? props.find((p) => /command|cmd/i.test(p))
  if (commandKey === undefined) return undefined
  const aliasKey =
    props.find((p) => p !== commandKey && /^(host|alias|target|server|machine|name|hostname|host_alias)$/i.test(p)) ??
    props.find((p) => p !== commandKey && /host|alias|target|server|machine/i.test(p))
  if (aliasKey === undefined) return undefined
  return { [commandKey]: command, [aliasKey]: alias, ...(props.includes('purpose') ? { purpose: 'проверяю карточку во время хода владельца' } : {}) }
}

interface Stub {
  server: Server
  origin: string
  /** The directory the `card` script asks host_exec to remove. */
  doomed: string
}

/** The number of assistant messages after position `at`: the step of the script. */
function stepAfter(body: JsonObject, at: number): number {
  return messagesOf(body)
    .slice(at + 1)
    .filter((message) => message.role === 'assistant').length
}

async function startStub(timeline: Timeline, doomed: string): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', doomed }
  let requests = 0
  let toolUses = 0

  async function answer(res: ServerResponse, body: JsonObject): Promise<void> {
    requests += 1
    const number = requests
    const messages = messagesOf(body)
    let lastMarker: string | undefined
    let scriptedAt = -1
    let scripted = ''
    let nudgeAt = -1
    for (const [at, message] of messages.entries()) {
      const text = userTextOf(message)
      for (const found of text.match(MARKER_RE) ?? []) {
        lastMarker = found
        if (SCRIPTED_RE.test(found)) {
          scriptedAt = at
          scripted = found
        }
      }
      if (text.includes(NUDGE_FRAGMENT)) nudgeAt = at
    }
    if (lastMarker === undefined) {
      res.end(textStream('pong'))
      return
    }
    const final = textStream(`fin ${lastMarker} r${number}`)
    const useTool = (name: string, input: JsonObject): string => {
      toolUses += 1
      return toolUseStream(`toolu_stub_${toolUses}`, name, input)
    }
    if (nudgeAt > scriptedAt) {
      res.end(stepAfter(body, nudgeAt) === 0 ? useTool('gate_probe', {}) : final)
      return
    }
    const step = stepAfter(body, scriptedAt)
    if (scripted.startsWith('gate-')) {
      res.end(step === 0 ? useTool('gate_probe', {}) : final)
    } else if (scripted.startsWith('hold-')) {
      if (step === 0) await sleep(HOLD_MS)
      res.end(final)
    } else if (scripted.startsWith('nudge-')) {
      res.end(step === 0 ? textStream('Сделаю позже, вернусь к этому позже.') : final)
    } else if (scripted.startsWith('card-')) {
      if (step === 0) {
        res.end(useTool('tool_search', { query: 'host_exec' }))
      } else if (step === 1) {
        const input = hostInput(body, 'box', `rm -rf '${stub.doomed}' && echo c9-removed`)
        res.end(input === undefined ? textStream('PROBLEM host_exec is not placed') : useTool('host_exec', input))
      } else {
        res.end(final)
      }
    } else {
      res.end(final)
    }
  }

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
      await answer(res, body)
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
  /** The final "done" reaction (🎉) is answered only after this pause; 0 answers at once. */
  doneReactionHangMs: number
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

function okResult(tg: FakeTelegram, method: string, params: JsonObject): { result: unknown; messageId?: number } {
  if (method === 'getMe') return { result: { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' } }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    tg.sentIds += 1
    const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
    const messageId = 9000 + tg.sentIds
    return {
      result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' },
      messageId,
    }
  }
  return { result: true }
}

async function startTelegram(timeline: Timeline): Promise<FakeTelegram> {
  const tg: FakeTelegram = {
    server: undefined as unknown as Server,
    origin: '',
    queue: [],
    holders: [],
    polls: 0,
    sentIds: 0,
    doneReactionHangMs: 0,
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
      const event: TgEvent = { n: 0, src: 'tg', method, params }
      timeline.seq += 1
      event.n = timeline.seq
      timeline.events.push(event)

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
      const made = okResult(tg, method, params)
      if (made.messageId !== undefined) event.messageId = made.messageId
      const done = method === 'setMessageReaction' && JSON.stringify(params.reaction ?? '').includes('🎉')
      if (done && tg.doneReactionHangMs > 0) {
        setTimeout(() => reply(200, JSON.stringify({ ok: true, result: made.result })), tg.doneReactionHangMs)
        return
      }
      reply(200, JSON.stringify({ ok: true, result: made.result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

let nextMessageId = 100
let updateCounter = 1000

/** A private message of `chatId`; `extra` adds fields such as a document, a voice or a caption. */
function privateMessage(chatId: number, extra: JsonObject): { update: JsonObject; messageId: number } {
  updateCounter += 1
  nextMessageId += 1
  return {
    messageId: nextMessageId,
    update: {
      update_id: updateCounter,
      message: {
        message_id: nextMessageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'T' },
        from: { id: chatId, is_bot: false, first_name: 'T' },
        ...extra,
      },
    },
  }
}

/** Sends a text message and returns its message_id. */
function say(text: string, chatId = OWNER_CHAT): number {
  const made = privateMessage(chatId, { text })
  world.tg.push(made.update)
  return made.messageId
}

function sendExtra(extra: JsonObject, chatId = OWNER_CHAT): number {
  const made = privateMessage(chatId, extra)
  world.tg.push(made.update)
  return made.messageId
}

function buttonPress(fromId: number, messageId: number, data: string): JsonObject {
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
        chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
        text: 'card',
      },
    },
  }
}

function modelCalls(): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds')
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

/** The numbers `r<n>` of the distinct answers `fin <marker> r<n>` that reached Telegram. */
function replyIds(marker: string): Set<string> {
  const found = new Set<string>()
  const re = new RegExp(`fin ${marker} r(\\d+)`, 'g')
  for (const e of tgEvents()) {
    if (e.method === 'getUpdates') continue
    for (const hit of JSON.stringify(e.params).matchAll(re)) found.add(hit[1] as string)
  }
  return found
}

/** The emoji put on a message of the chat by setMessageReaction, in order. */
function reactionsOn(chatId: number, messageId: number): string[] {
  return tgEvents()
    .filter((e) => e.method === 'setMessageReaction' && e.params.chat_id === chatId && e.params.message_id === messageId)
    .flatMap((e) => (Array.isArray(e.params.reaction) ? e.params.reaction.map((r) => String(asObject(r).emoji ?? '')) : []))
}

/** The first model request that carries the result of the gate: the next step after the gate opened. */
function afterGate(): DsEvent | undefined {
  return modelCalls().find((call) => hasResultText(call.body, 'gate released'))
}

// --- the tool and the seams -------------------------------------------------------------------------------

function gateLog(): string[] {
  if (!existsSync(world.gateLog)) return []
  return readFileSync(world.gateLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
}

function releaseGate(): void {
  writeFileSync(world.gateRelease, 'open')
}

function writePreload(dir: string): string {
  const schedulerUrl = pathToFileURL(join(repoRoot, 'packages', 'scheduler', 'src', 'index.ts')).href
  const wrapper = join(dir, 'scheduler-with-gate-tool.mjs')
  const preload = join(dir, 'preload-gate-tool.mjs')
  writeFileSync(
    wrapper,
    `import { appendFileSync, existsSync } from 'node:fs'
import { createScheduleTool as realCreateScheduleTool } from ${JSON.stringify(schedulerUrl)}
export * from ${JSON.stringify(schedulerUrl)}

const record = (line) => appendFileSync(process.env.GATE_LOG, line + '\\n')

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

// The app puts this object into the tool list of the main session behind its own wrapper; the stub model
// calls it by the new name.
export function createScheduleTool(options) {
  const base = realCreateScheduleTool(options)
  return {
    ...base,
    name: 'gate_probe',
    description: 'Test probe that waits until it is released. Call it with no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, ...rest) {
      const signal = [...rest].map((value) => signalIn(value)).find((candidate) => candidate !== undefined)
      record('start')
      return await new Promise((resolve) => {
        const poll = setInterval(() => {
          if (existsSync(process.env.GATE_RELEASE)) {
            clearInterval(poll)
            record('released')
            resolve('gate released')
          }
        }, 50)
        const onAbort = () => {
          clearInterval(poll)
          record('aborted')
          resolve('gate aborted')
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
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
    if (/scheduler\\/src\\/index\\.js$/.test(specifier) && parent.includes('/packages/app/src/')) {
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
  gateLog: string
  gateRelease: string
  doomed: string
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
    GATE_LOG: world.gateLog,
    GATE_RELEASE: world.gateRelease,
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
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}\n--- gate log ---\n${gateLog().join('\n')}`
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

/** The owner opens a turn with `marker` and waits until the gate of its tool is closed behind it. */
async function startGateTurn(d: Daemon, marker: string): Promise<number> {
  const id = say(`${marker} сделай, пожалуйста`)
  await waitFor(`the gate tool of ${marker} to start`, () => gateLog().includes('start'), d)
  return id
}

/** A guest joins by the link of /invite. */
async function admitGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say('/invite 2h')
  const linkRe = /t\.me\/dshbot_test_bot\?start=([A-Za-z0-9_-]{8,64})/
  const linkText = (): string =>
    sentTo(OWNER_CHAT)
      .filter((e) => e.n > mark)
      .map((e) => JSON.stringify(e.params))
      .join('\n')
  await waitFor('an invitation link in the owner chat', () => linkRe.test(linkText()), d)
  const code = linkRe.exec(linkText())?.[1] ?? ''
  const before = sentTo(GUEST_CHAT).length
  say(`/start ${code}`, GUEST_CHAT)
  await waitFor('a greeting for the guest', () => sentTo(GUEST_CHAT).length > before, d)
}

/** A due schedule row in the store of the running daemon: the ticker starts a planned turn for it. */
function seedDueJob(task: string): void {
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    const registry = createScheduleRegistry(store, { now: () => new Date(Date.now() - 3_600_000) })
    registry.create({ spec: 'every 1m', task })
  } finally {
    store.close()
  }
}

/** Nothing new reached either fake for QUIET_MS. */
async function quiet(): Promise<void> {
  let seen = world.timeline.seq
  let since = Date.now()
  while (Date.now() - since < QUIET_MS) {
    await sleep(100)
    if (world.timeline.seq !== seen) {
      seen = world.timeline.seq
      since = Date.now()
    }
  }
}

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp, so a file under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-steer-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = makeScratch()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const seamDir = mkdtempSync(join(scratch, 'seam-'))
  const doomed = join(mkdtempSync(join(scratch, 'outside-')), 'doomed')
  mkdirSync(doomed, { recursive: true })
  writeFileSync(join(doomed, 'keep.txt'), 'keep\n')
  const stub = await startStub(timeline, doomed)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  world = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    gateLog: join(seamDir, 'gate.log'),
    gateRelease: join(seamDir, 'gate.release'),
    doomed,
    preload: writePreload(seamDir),
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

// --- [c1] [c2] a message during the turn joins it --------------------------------------------------------

test('test_c1_text_during_the_owner_turn_reaches_the_next_model_step_as_a_user_message_and_is_not_a_turn_of_its_own', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await startGateTurn(d, 'gate-1')
  say('sw-2 и ещё учти вот это')
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()
  await waitFor('the answer of the turn', () => replyIds('gate-1').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  const next = afterGate()
  expect(next, `no model step followed the gate\n${output(d)}`).toBeDefined()
  expect(occurrences((next as DsEvent).body, 'sw-2'), 'the next step of the turn shows the owner message exactly once').toBe(1)
  expect(
    calls.filter((call) => occurrences(call.body, 'sw-2') > 0),
    'the message was given to the model in one request, not again in a turn of its own',
  ).toHaveLength(1)
  expect(calls, `the steered message must not start a model turn of its own\n${output(d)}`).toHaveLength(2)
  expect(replyIds('gate-1').size, 'one answer for the turn that took the message').toBe(1)
  expect(d.exited).toBe(false)
})

test('test_c2_the_message_taken_into_the_running_turn_gets_a_reaction', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await startGateTurn(d, 'gate-1')
  const steerId = say('sw-2 и ещё учти вот это')
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()
  await waitFor('the answer of the turn', () => replyIds('gate-1').size > 0, d)
  await waitFor('a reaction on the message taken into the turn', () => reactionsOn(OWNER_CHAT, steerId).length > 0, d, 10_000)
  await quiet() // absence: no extra model call after the turn

  expect(modelCalls(), 'the reaction belongs to a message that joined the turn, not to a turn of its own').toHaveLength(2)
  expect(occurrences((afterGate() as DsEvent).body, 'sw-2')).toBe(1)
})

// --- [c3] the turn ended before the message could join -----------------------------------------------------

test('test_c3_message_that_misses_the_end_of_the_turn_is_answered_once_and_not_lost', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('hold-1 подумай')
  await waitFor('the model call of the held turn', () => modelCalls().length > 0, d)
  await sleep(700)
  // the model call is in flight and answers in about HOLD_MS: this message lands at the very end of the turn
  say('ok-2 а это второе')

  await waitFor('an answer to the second message', () => replyIds('ok-2').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  const last = (calls[calls.length - 1] as DsEvent).body
  expect(occurrences(last, 'ok-2'), `the second message is in the history once\n${output(d)}`).toBe(1)
  expect(occurrences(last, 'hold-1'), 'the first message is in the history once').toBe(1)
  expect(replyIds('ok-2').size, 'the second message is answered once').toBe(1)
  expect(d.exited).toBe(false)
})

// --- [c4] a series of quick texts is one turn ---------------------------------------------------------------

test('test_c4_quick_series_of_texts_without_a_running_turn_is_one_turn_in_order_of_arrival', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('ok-1 первое')
  await sleep(QUICK_GAP_MS)
  say('ok-2 второе')
  await sleep(QUICK_GAP_MS)
  say('ok-3 третье')

  await waitFor('the answer to the series', () => replyIds('ok-3').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  expect(calls, `a series with pauses under the debounce is one turn\n${output(d)}`).toHaveLength(1)
  const body = (calls[0] as DsEvent).body
  for (const marker of ['ok-1', 'ok-2', 'ok-3']) expect(occurrences(body, marker), `${marker} is shown once`).toBe(1)
  expect(positionOf(body, 'ok-1')).toBeLessThan(positionOf(body, 'ok-2'))
  expect(positionOf(body, 'ok-2')).toBeLessThan(positionOf(body, 'ok-3'))
  expect(replyIds('ok-1').size + replyIds('ok-2').size, 'no separate answers for the first two messages').toBe(0)
})

test('test_c4_a_series_longer_than_the_debounce_in_total_still_merges_while_each_pause_is_short', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('ok-1 первое')
  await sleep(200)
  say('ok-2 второе')
  await sleep(200)
  say('ok-3 третье')

  await waitFor('the answer to the series', () => replyIds('ok-3').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  expect(calls, `each pause is under the default 300 ms: one turn\n${output(d)}`).toHaveLength(1)
  const body = (calls[0] as DsEvent).body
  expect(positionOf(body, 'ok-1')).toBeGreaterThanOrEqual(0)
  expect(positionOf(body, 'ok-1')).toBeLessThan(positionOf(body, 'ok-2'))
  expect(positionOf(body, 'ok-2')).toBeLessThan(positionOf(body, 'ok-3'))
})

// --- [c5] commands, files and voice are neither merged nor steered -----------------------------------------

test('test_c5_command_file_and_voice_during_the_turn_do_not_join_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await startGateTurn(d, 'gate-1')
  const statusId = say('/status')
  const fileId = sendExtra({
    document: { file_id: 'doc-1', file_unique_id: 'u-doc-1', file_name: 'a.txt', mime_type: 'text/plain', file_size: 10 },
    caption: 'sw-3 вот файл',
  })
  const voiceId = sendExtra({
    voice: { file_id: 'voice-1', file_unique_id: 'u-voice-1', duration: 2, mime_type: 'audio/ogg', file_size: 100 },
    caption: 'sw-4 голосовое',
  })
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()
  await waitFor('the answer of the turn', () => replyIds('gate-1').size > 0, d)
  await waitFor('the answer to /status', () => telegramCarried('Модель main'), d)
  await quiet() // absence: no extra model call after the turn

  const next = afterGate()
  expect(next, `no model step followed the gate\n${output(d)}`).toBeDefined()
  for (const needle of ['/status', 'sw-3', 'sw-4']) {
    expect(occurrences((next as DsEvent).body, needle), `${needle} must not join the running turn`).toBe(0)
  }
  for (const id of [statusId, fileId, voiceId]) {
    expect(reactionsOn(OWNER_CHAT, id), `message ${id} was not taken into the turn: no reaction`).toEqual([])
  }
  expect(d.exited, 'the daemon survives the file and the voice message').toBe(false)
})

test('test_c5_command_between_quick_texts_still_answers_and_never_reaches_the_model', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('ok-1 первое')
  await sleep(QUICK_GAP_MS)
  say('/status')
  await sleep(QUICK_GAP_MS)
  say('ok-2 второе')

  await waitFor('the answer to /status', () => telegramCarried('Модель main'), d)
  await waitFor('the answer to the texts', () => replyIds('ok-2').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  for (const call of calls) expect(occurrences(call.body, '/status'), 'a command is not text for the model').toBe(0)
  const last = (calls[calls.length - 1] as DsEvent).body
  expect(occurrences(last, 'ok-1')).toBe(1)
  expect(occurrences(last, 'ok-2')).toBe(1)
})

// --- [c6] a guest never joins the turn of the owner ---------------------------------------------------------

test('test_c6_guest_message_during_the_owner_turn_does_not_join_it_and_is_answered_on_its_own', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await admitGuest(d)
  await sleep(3_300)
  await startGateTurn(d, 'gate-1')
  const guestId = say('ok-9 привет от гостя', GUEST_CHAT)
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()
  await waitFor('the answer of the owner turn', () => replyIds('gate-1').size > 0, d)
  await waitFor('the answer to the guest', () => sentTo(GUEST_CHAT).some((e) => JSON.stringify(e.params).includes('fin ok-9')), d)
  await quiet() // absence: no extra model call after the turn

  const next = afterGate()
  expect(next, `no model step followed the gate\n${output(d)}`).toBeDefined()
  expect(occurrences((next as DsEvent).body, 'ok-9'), 'the guest text is not in the owner turn').toBe(0)
  expect(
    sentTo(OWNER_CHAT).some((e) => JSON.stringify(e.params).includes('ok-9')),
    'nothing of the guest reaches the owner chat',
  ).toBe(false)
  expect(reactionsOn(GUEST_CHAT, guestId), 'a guest message is not marked as taken into the owner turn').toEqual([])
})

// --- [c7] /stop after the message joined ----------------------------------------------------------------------

test('test_c7_stop_after_a_joined_message_does_not_bring_it_back_as_a_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await startGateTurn(d, 'gate-1')
  say('sw-2 и ещё учти вот это')
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn

  say('/stop')
  await waitFor('the tool of the turn to be aborted', () => gateLog().includes('aborted'), d, 20_000)
  await quiet() // absence: no extra model call after the turn

  expect(
    tgEvents().some((e) => e.method !== 'getUpdates' && /fin (?:gate|ok)-\d+/.test(JSON.stringify(e.params))),
    `a stopped turn is silent, and so is the message that joined it\n${output(d)}`,
  ).toBe(false)
  expect(modelCalls(), 'the message of the stopped turn does not start a turn of its own').toHaveLength(1)

  say('ok-3 привет')
  await waitFor('a normal answer after /stop', () => replyIds('ok-3').size > 0, d)
  const last = (modelCalls()[modelCalls().length - 1] as DsEvent).body
  expect(occurrences(last, 'sw-2'), 'the message is in the history at most once').toBeLessThanOrEqual(1)
  expect(replyIds('ok-3').size).toBe(1)
})

// --- [c9] the turn waits for the decision on a card ------------------------------------------------------------

test('test_c9_text_while_a_card_waits_refuses_the_card_and_joins_the_same_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeFileSync(join(world.dshbotHome, 'hosts.json'), `${JSON.stringify({ box: { local: true } }, null, 2)}\n`)
  const d = await startOwnerDaemon()
  say('card-1 сотри каталог')
  await waitFor(
    'an approval card for the owner',
    () =>
      sentTo(OWNER_CHAT).some((e) => {
        const rows = asObject(e.params.reply_markup).inline_keyboard
        return Array.isArray(rows) && JSON.stringify(rows).includes('tga1')
      }),
    d,
    90_000,
  )
  await sleep(500)
  const steerId = say('sw-9 не надо, оставь как есть')

  await waitFor('the answer of the turn', () => replyIds('card-1').size > 0, d, 90_000)
  await waitFor('a reaction on the message taken into the turn', () => reactionsOn(OWNER_CHAT, steerId).length > 0, d, 10_000)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  expect(existsSync(world.doomed), 'the card was refused: nothing is removed').toBe(true)
  expect(calls, `the text joined the turn: search, command, final answer and no turn of its own\n${output(d)}`).toHaveLength(3)
  const afterCard = (calls[2] as DsEvent).body
  const results = lastResults(afterCard)
  expect(results.some((result) => result.isError || FAILURE_WORDS.test(result.text)), 'the model got a refusal for the command').toBe(true)
  expect(results.some((result) => result.text.includes('c9-removed'))).toBe(false)
  expect(occurrences(afterCard, 'sw-9'), 'the same step shows the owner text next to the refusal').toBe(1)
  expect(replyIds('card-1').size).toBe(1)
})

// --- [c10] planned turns and wake-ups do not take owner messages -------------------------------------------------

test('test_c10_planned_turn_does_not_see_owner_texts_and_both_are_served_after_it_in_order', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  seedDueJob('gate-5 проверь отчёты')
  await waitFor('the gate tool of the planned turn to start', () => gateLog().includes('start'), d)

  const firstId = say('ok-6 первое сообщение')
  // longer than the debounce: the first text has passed the merge and waits for the queue
  await sleep(2_500)
  const secondId = say('ok-7 второе сообщение')
  await sleep(STEER_SETTLE_MS)
  for (const id of [firstId, secondId]) {
    expect(
      reactionsOn(OWNER_CHAT, id).filter((emoji) => !OWN_REACTIONS.includes(emoji)),
      'no "taken into the turn" mark while a planned turn runs',
    ).toEqual([])
  }

  releaseGate()
  await waitFor('the answer to the owner texts', () => replyIds('ok-7').size > 0, d, 90_000)
  await quiet() // absence: no extra model call after the turn

  const planned = afterGate()
  expect(planned, `the planned turn went on after the gate\n${output(d)}`).toBeDefined()
  expect(occurrences((planned as DsEvent).body, 'ok-6'), 'the planned turn does not see the first text').toBe(0)
  expect(occurrences((planned as DsEvent).body, 'ok-7'), 'the planned turn does not see the second text').toBe(0)

  const calls = modelCalls()
  const last = (calls[calls.length - 1] as DsEvent).body
  expect(occurrences(last, 'ok-6'), 'the first text is served once').toBe(1)
  expect(occurrences(last, 'ok-7'), 'the second text is served once').toBe(1)
  expect(positionOf(last, 'ok-6')).toBeLessThan(positionOf(last, 'ok-7'))
  expect(replyIds('ok-7').size).toBe(1)
})

// --- [h1] the turn goes on with the nudge about promised work ------------------------------------------------------

test('test_h1_text_during_the_promised_work_nudge_turn_joins_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('nudge-1 сделай, пожалуйста')
  await waitFor('the gate tool of the nudge turn to start', () => gateLog().includes('start'), d, 90_000)
  expect(
    modelCalls().some((call) => occurrences(call.body, NUDGE_FRAGMENT) > 0),
    'the gate belongs to the second turn of the chain, the one with the nudge',
  ).toBe(true)

  const steerId = say('sw-2 и ещё учти вот это')
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()
  await waitFor('the answer of the chain', () => replyIds('nudge-1').size > 0, d)
  await waitFor('a reaction on the message taken into the turn', () => reactionsOn(OWNER_CHAT, steerId).length > 0, d, 10_000)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  const next = afterGate()
  expect(next, `no model step followed the gate\n${output(d)}`).toBeDefined()
  expect(occurrences((next as DsEvent).body, 'sw-2'), 'the step after the gate shows the owner message once').toBe(1)
  expect(calls, 'promise, nudge with the gate, final answer: no turn of its own for the message').toHaveLength(3)
  expect(replyIds('nudge-1').size).toBe(1)
})

// --- "typing…" stops with the delivered answer --------------------------------------------------------------

test('test_typing_stops_when_the_answer_is_delivered_even_if_the_done_reaction_hangs', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  world.tg.doneReactionHangMs = DONE_REACTION_HANG_MS
  const mark = world.timeline.seq
  const id = say('hold-1 подумай')
  await waitFor('the answer of the held turn', () => replyIds('hold-1').size > 0, d)
  await waitFor('the done reaction to be asked for', () => reactionsOn(OWNER_CHAT, id).includes('🎉'), d, 10_000)
  const done = tgEvents().find(
    (e) => e.method === 'setMessageReaction' && e.params.message_id === id && JSON.stringify(e.params.reaction).includes('🎉'),
  ) as TgEvent
  // the done reaction is still unanswered for most of this pause
  await sleep(DONE_REACTION_HANG_MS - 1_000)

  const typing = tgEvents().filter((e) => e.n > mark && e.method === 'sendChatAction' && e.params.chat_id === OWNER_CHAT)
  expect(typing.length, `typing went out for the turn\n${output(d)}`).toBeGreaterThan(0)
  expect(
    typing.filter((e) => e.n > done.n),
    'no typing after the answer while the done reaction hangs',
  ).toHaveLength(0)
  expect(d.exited).toBe(false)
})
