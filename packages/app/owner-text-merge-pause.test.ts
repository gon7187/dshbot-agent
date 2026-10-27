// The pause that glues a series of owner texts into one turn (DSHBOT_DEBOUNCE_MS, default 300 ms): a lone text goes to
// the model without a long wait, a nearly simultaneous pair becomes one turn, a text sent after the pause during a
// running turn joins that turn, and an explicit 1500 ms keeps the old merging. The daemon runs as a child process
// against a fake Telegram Bot API and a local DeepSeek stub (same harness as owner-steer-inflight.test.ts).
//
// The stub recognises the turn by markers in the text the model is given:
//   gate-N   asks for gate_probe (replaces the schedule tool of the app, waits for the release file), then answers
//   ok-N     answers at once
// The answer is `fin <last marker> r<number of the model request>`.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 150_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
const QUIET_MS = 2_500
/** The steer travels through the poller lane at once; this is the time the daemon gets to take it before the gate opens. */
const STEER_SETTLE_MS = 1_000
/** A lone text must reach the model well before the old pause of 1500 ms could have passed. */
const FIRST_REQUEST_BUDGET_MS = 1_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

const MARKER_RE = /(?:gate|ok)-\d+/g

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
  /** Wall-clock time the stub received the request. */
  at: number
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

interface Stub {
  server: Server
  origin: string
}

/** The number of assistant messages after position `at`: the step of the script. */
function stepAfter(body: JsonObject, at: number): number {
  return messagesOf(body)
    .slice(at + 1)
    .filter((message) => message.role === 'assistant').length
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '' }
  let requests = 0

  function answer(res: ServerResponse, body: JsonObject): void {
    requests += 1
    const number = requests
    const messages = messagesOf(body)
    let lastMarker: string | undefined
    let gateAt = -1
    for (const [at, message] of messages.entries()) {
      for (const found of userTextOf(message).match(MARKER_RE) ?? []) {
        lastMarker = found
        if (found.startsWith('gate-')) gateAt = at
      }
    }
    if (lastMarker === undefined) {
      res.end(textStream('pong'))
      return
    }
    if (gateAt >= 0 && stepAfter(body, gateAt) === 0) {
      res.end(toolUseStream('toolu_stub_gate', 'gate_probe', {}))
      return
    }
    res.end(textStream(`fin ${lastMarker} r${number}`))
  }

  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall && body.stream !== false) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', at: Date.now(), body })
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      answer(res, body)
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

function modelCalls(): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

function tgEvents(): TgEvent[] {
  return world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

function sentTo(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId)
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
  const stub = await startStub(timeline)
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

// --- [c1] a lone text does not wait for the old pause -----------------------------------------------------

test('test_c1_lone_owner_text_reaches_the_model_without_the_old_pause_of_1500_ms', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const sentAt = Date.now()
  say('ok-1 одиночный текст')

  await waitFor('the first model request', () => modelCalls().length > 0, d)
  const firstAt = (modelCalls()[0] as DsEvent).at
  expect(firstAt - sentAt, `a lone text waits only for the short merge pause\n${output(d)}`).toBeLessThanOrEqual(FIRST_REQUEST_BUDGET_MS)
  await waitFor('the answer', () => replyIds('ok-1').size > 0, d)
})

// --- [c2] two nearly simultaneous texts are one turn ------------------------------------------------------

test('test_c2_two_owner_texts_100_ms_apart_are_one_turn_in_order_of_sending', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('ok-1 первое')
  await sleep(100)
  say('ok-2 второе')

  await waitFor('the answer to the pair', () => replyIds('ok-2').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  expect(calls, `a pair 100 ms apart is one turn\n${output(d)}`).toHaveLength(1)
  const body = (calls[0] as DsEvent).body
  expect(occurrences(body, 'ok-1'), 'the first text is shown once').toBe(1)
  expect(occurrences(body, 'ok-2'), 'the second text is shown once').toBe(1)
  expect(positionOf(body, 'ok-1')).toBeLessThan(positionOf(body, 'ok-2'))
  expect(replyIds('ok-1').size, 'no separate answer for the first text').toBe(0)
})

// --- [c3] a text after the pause during a running turn joins that turn ----------------------------------

test('test_c3_text_one_second_after_the_first_joins_the_running_turn_before_its_final_answer', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('gate-1 сделай, пожалуйста')
  await waitFor('the gate tool of the turn to start', () => gateLog().includes('start'), d)
  await sleep(STEER_SETTLE_MS) // the second text comes about 1 s after the first, while the turn is in flight
  say('ok-2 и ещё это')
  await sleep(STEER_SETTLE_MS) // background: the steer must join the in-flight turn
  releaseGate()

  await waitFor('the answer of the turn', () => replyIds('ok-2').size > 0, d) // the answer names the last marker it saw
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  const first = (calls[0] as DsEvent).body
  expect(occurrences(first, 'ok-2'), 'the first request was sent before the second text existed').toBe(0)
  const next = afterGate()
  expect(next, `no model step followed the gate\n${output(d)}`).toBeDefined()
  expect(occurrences((next as DsEvent).body, 'ok-2'), 'the step before the final answer shows the second text once').toBe(1)
  expect(calls, `the second text joins the turn and starts none of its own\n${output(d)}`).toHaveLength(2)
  expect(replyIds('ok-2').size, 'one answer for the turn that took the text').toBe(1)
})

// --- [c4] an explicit 1500 ms keeps the old merging -------------------------------------------------------

test('test_c4_explicit_debounce_of_1500_ms_merges_texts_900_ms_apart_into_one_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon({ DSHBOT_DEBOUNCE_MS: '1500' })
  say('ok-1 первое')
  await sleep(900)
  say('ok-2 второе')

  await waitFor('the answer to the pair', () => replyIds('ok-2').size > 0, d)
  await quiet() // absence: no extra model call after the turn

  const calls = modelCalls()
  expect(calls, `a pause under the explicit 1500 ms is one turn\n${output(d)}`).toHaveLength(1)
  const body = (calls[0] as DsEvent).body
  expect(occurrences(body, 'ok-1'), 'the first text is shown once').toBe(1)
  expect(occurrences(body, 'ok-2'), 'the second text is shown once').toBe(1)
  expect(positionOf(body, 'ok-1')).toBeLessThan(positionOf(body, 'ok-2'))
  expect(replyIds('ok-1').size, 'no separate answer for the first text').toBe(0)
})
