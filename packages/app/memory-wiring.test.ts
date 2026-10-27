// Memory through the daemon: the memory tool, recall over the dialogue history, the frozen snapshot in the tail
// of the owner turn, update_identity and the tools a guest does not get. Same harness as experience-review.test.ts:
// the daemon runs as a child process against a fake Telegram Bot API and a local DeepSeek stub that plays the
// main model from the marker `turn-xx-N` of the owner message. A script per test lists the tool calls of the model.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 200_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 31

const MARKER_RE = /turn-[a-z]+-\d+/

const MEMORY_LIMIT = 2200
const USER_LIMIT = 1400

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

// --- request readers ---------------------------------------------------------------------------------

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const b = asObject(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      return ''
    })
    .join('')
}

interface Block {
  kind: 'text' | 'tool_result'
  text: string
  isError: boolean
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content, isError: false }]
  if (!Array.isArray(content)) return []
  const found: Block[] = []
  for (const raw of content) {
    const block = asObject(raw)
    if (block.type === 'text' && typeof block.text === 'string') {
      found.push({ kind: 'text', text: block.text, isError: false })
    } else if (block.type === 'tool_result') {
      found.push({ kind: 'tool_result', text: flatten(block.content), isError: block.is_error === true })
    }
  }
  return found
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

function messageText(message: JsonObject): string {
  return blocksOf(message.content)
    .map((block) => block.text)
    .join('\n')
}

function systemTextOf(body: JsonObject): string {
  const field = flatten(body.system)
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(flatten(m.content))
  }
  return field + leading.join('')
}

/** Everything of a request that sits in the cached prefix: system prompt and tool schemas, as bytes. */
function prefixBytes(body: JsonObject): string {
  const leading = messagesOf(body).filter((m) => m.role === 'system' || m.role === 'developer')
  return JSON.stringify({ system: body.system, leading, tools: body.tools })
}

function toolNames(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools.map(asObject) : []
  return tools.map((tool) => (typeof tool.name === 'string' ? tool.name : '')).sort()
}

function toolSchema(body: JsonObject, name: string): JsonObject {
  const tools = Array.isArray(body.tools) ? body.tools.map(asObject) : []
  const tool = tools.find((t) => t.name === name)
  return asObject(tool?.input_schema ?? tool?.parameters ?? tool?.inputSchema)
}

/** Index of the last owner message with a turn marker, and the marker. */
function markerMessage(body: JsonObject): { at: number; marker: string } | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const hit = blocksOf(message.content)
      .filter((block) => block.kind === 'text')
      .map((block) => MARKER_RE.exec(block.text))
      .find((match) => match !== null)
    if (hit !== undefined && hit !== null) return { at, marker: hit[0] }
  }
  return undefined
}

/** What follows the previous answer of the model: the owner message and whatever the bot put around it. */
function tailOf(body: JsonObject): string {
  const messages = messagesOf(body).filter((m) => m.role !== 'system' && m.role !== 'developer')
  let marked = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as JsonObject
    if (message.role === 'user' && MARKER_RE.test(messageText(message))) {
      marked = i
      break
    }
  }
  expect(marked, 'the owner message with the turn marker is in the request').toBeGreaterThanOrEqual(0)
  let previous = -1
  for (let i = marked - 1; i >= 0; i -= 1) {
    if ((messages[i] as JsonObject).role === 'assistant') {
      previous = i
      break
    }
  }
  return messages.slice(previous + 1).map(messageText).join('\n')
}

// --- the scripted model --------------------------------------------------------------------------

type Step = { kind: 'tool'; name: string; input: JsonObject } | { kind: 'text'; text: string }

interface MainView {
  marker: string
  /** Assistant messages after the owner message of this turn. */
  step: number
  body: JsonObject
  /** Tool results the model got for its previous call. */
  results: Block[]
}

interface Stub {
  server: Server
  origin: string
  /** Script of the main model; a step of kind text (or none) ends the turn with `fin <marker>`. */
  main: (view: MainView) => Step | undefined
  toolCalls: number
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

function mainViewOf(body: JsonObject, marker: string, at: number): MainView {
  const rest = messagesOf(body).slice(at + 1)
  const last = rest[rest.length - 1]
  return {
    marker,
    step: rest.filter((m) => m.role === 'assistant').length,
    body,
    results: last !== undefined && last.role === 'user' ? blocksOf(last.content).filter((b) => b.kind === 'tool_result') : [],
  }
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    main: () => undefined,
    toolCalls: 0,
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
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const found = markerMessage(body)
      if (found === undefined) {
        res.end(textStream('pong'))
        return
      }
      const step = stub.main(mainViewOf(body, found.marker, found.at))
      if (step !== undefined && step.kind === 'tool') {
        stub.toolCalls += 1
        res.end(toolUseStream(`toolu_mem_${stub.toolCalls}`, step.name, step.input))
        return
      }
      res.end(textStream(step === undefined ? `fin ${found.marker}` : `fin ${found.marker} ${step.text}`))
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
    // a night turn of the memory consolidation is not part of this harness
    DSHBOT_DREAM_AT: 'off',
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
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

async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
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
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(): Promise<Daemon> {
  const d = await startDaemon()
  await pairOwner(d)
  return d
}

/** Model requests of the main model for one turn, in order. */
function turnCalls(marker: string): DsEvent[] {
  return world.timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && e.body.stream !== false && markerMessage(e.body)?.marker === marker,
  )
}

function replyEvent(chatId: number, marker: string): TgEvent | undefined {
  const reply = new RegExp(`fin ${marker}(?!\\d)`)
  return sentTo(world.timeline, chatId).find((e) => reply.test(JSON.stringify(e.params)))
}

/** `chatId` opens a turn with `marker` and waits for the reply of the model to arrive in the chat. */
async function turnAs(d: Daemon, chatId: number, marker: string, text = 'сделай, пожалуйста'): Promise<DsEvent[]> {
  say(chatId, `${marker} ${text}`)
  await waitFor(`the reply of turn ${marker}`, () => replyEvent(chatId, marker) !== undefined, d, TURN_WAIT_MS)
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

const ownerTurn = (d: Daemon, marker: string, text?: string): Promise<DsEvent[]> => turnAs(d, OWNER_CHAT, marker, text)

async function admitGuest(d: Daemon): Promise<void> {
  const ownerMark = world.timeline.seq
  say(OWNER_CHAT, '/invite 2h')
  const linkRe = /t\.me\/dshbot_test_bot\?start=([A-Za-z0-9_-]{8,64})/
  const linkText = (): string =>
    sentTo(world.timeline, OWNER_CHAT)
      .filter((e) => e.n > ownerMark)
      .map((e) => JSON.stringify(e.params))
      .join('\n')
  await waitFor('an invitation link in the owner chat', () => linkRe.test(linkText()), d)
  const code = linkRe.exec(linkText())?.[1] ?? ''
  const before = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, `/start ${code}`)
  await waitFor('a greeting for the guest', () => sentTo(world.timeline, GUEST_CHAT).length > before, d)
}

// --- memory files -------------------------------------------------------------------------------------

function memoryFile(name: string): string {
  return join(world.dshbotHome, 'memory', name)
}

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function seedMemory(name: string, content: string): void {
  mkdirSync(join(world.dshbotHome, 'memory'), { recursive: true })
  writeFileSync(memoryFile(name), content)
}

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

/** memory tool input in the shape of the tool the experience review already uses. */
function memoryCall(target: 'memory' | 'user', ...operations: JsonObject[]): Step {
  return { kind: 'tool', name: 'memory', input: { target, operations } }
}

/** recall input built from the schema the model was given: the query is the one string property it asks for. */
function recallCall(body: JsonObject, query: string): Step {
  const schema = toolSchema(body, 'recall')
  const props = Object.keys(asObject(schema.properties))
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
  const name = ['query', 'q', 'text', 'search', 'terms'].find((c) => props.includes(c)) ?? required[0] ?? 'query'
  return { kind: 'tool', name: 'recall', input: { [name]: query } }
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-mw-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  world = { timeline, tg, stub, home: mkdtempSync(join(scratch, 'home-')), dshbotHome, daemons: [] }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

/** The model plays `steps` in turn `marker`; `seen(step)` runs when the model is asked for step number `step`. */
function script(marker: string, steps: Step[], seen: (step: number, results: Block[]) => void = () => undefined): void {
  world.stub.main = (view) => {
    if (view.marker !== marker) return undefined
    seen(view.step, view.results)
    return steps[view.step]
  }
}

// --- [mem] -----------------------------------------------------------------------------------------------

test('test_mem_add_replace_remove_by_exact_text_and_a_full_file_rejects_the_entry_unchanged', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fact = 'Сервер владельца стоит в Хельсинки MEMFACTONE'
  const factChanged = 'Сервер владельца стоит в Таллине MEMFACTTWO'
  const big = `BIGENTRY ${'a'.repeat(1990)}`
  const over = `OVERFLOWENTRY ${'b'.repeat(300)}`
  const userFact = 'Владелец любит коротко USERFACTONE'
  const userOver = `USEROVER ${'c'.repeat(1500)}`

  const state: Array<{ memory: string; user: string }> = []
  const results: Block[][] = []
  const steps: Step[] = [
    memoryCall('memory', { op: 'add', text: fact }), // 0
    memoryCall('memory', { op: 'add', text: big }), // 1
    memoryCall('memory', { op: 'add', text: over }), // 2: more than the file takes
    memoryCall('user', { op: 'add', text: userFact }), // 3
    memoryCall('user', { op: 'add', text: userOver }), // 4: more than USER.md takes
    memoryCall('memory', { op: 'replace', match: fact, text: factChanged }), // 5
    memoryCall('memory', { op: 'remove', match: big }), // 6
    memoryCall('memory', { op: 'remove', match: 'NO-SUCH-ENTRY-TEXT' }), // 7
  ]
  script('turn-mm-1', steps, (step, got) => {
    state[step] = { memory: readOrEmpty(memoryFile('MEMORY.md')), user: readOrEmpty(memoryFile('USER.md')) }
    results[step] = got
  })

  const d = await startOwnerDaemon()
  await ownerTurn(d, 'turn-mm-1')
  expect(world.stub.toolCalls, 'the model called the memory tool for every scripted step').toBe(steps.length)

  const after = (step: number): { memory: string; user: string } => state[step + 1] as { memory: string; user: string }
  expect(after(0).memory, 'add writes the entry into MEMORY.md').toContain(fact)
  expect(after(1).memory).toContain(fact)
  expect(after(1).memory).toContain(big)
  expect(after(1).memory.length).toBeLessThanOrEqual(MEMORY_LIMIT)

  expect(after(2).memory, 'an entry over the 2200 byte limit leaves MEMORY.md unchanged').toBe(after(1).memory)
  expect(after(2).memory).not.toContain('OVERFLOWENTRY')
  const rejected = results[3] ?? []
  expect(rejected.length, 'the model got a tool result for the rejected add').toBeGreaterThan(0)
  expect(
    rejected.some((b) => b.isError || /limit|лимит|2200|сжат|compress|consolid|shorten|сократ/i.test(b.text)),
    `the rejection is an error with a hint: ${JSON.stringify(rejected)}`,
  ).toBe(true)

  expect(after(3).user, 'add to the user store writes USER.md').toContain(userFact)
  expect(after(3).memory, 'a USER.md entry does not touch MEMORY.md').toBe(after(1).memory)
  expect(after(4).user, 'an entry over the 1400 byte limit leaves USER.md unchanged').toBe(after(3).user)
  expect(after(4).user).not.toContain('USEROVER')

  expect(after(5).memory, 'replace by the exact text of the entry').toContain(factChanged)
  expect(after(5).memory).not.toContain('MEMFACTONE')
  expect(after(5).memory).toContain(big)

  expect(after(6).memory, 'remove by the exact text of the entry').not.toContain('BIGENTRY')
  expect(after(6).memory).toContain(factChanged)

  expect(after(7).memory, 'a match that is in no entry changes nothing').toBe(after(6).memory)
  expect(readOrEmpty(memoryFile('MEMORY.md'))).toBe(after(6).memory)
  expect(readOrEmpty(memoryFile('USER.md'))).toBe(after(4).user)
})

// --- [recall] --------------------------------------------------------------------------------------------

function dateForms(): string[] {
  const forms = new Set<string>()
  for (const ms of [Date.now() - 3_600_000, Date.now(), Date.now() + 3_600_000]) {
    const at = new Date(ms)
    const pad = (n: number): string => String(n).padStart(2, '0')
    forms.add(at.toISOString().slice(0, 10))
    forms.add(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`)
    forms.add(`${pad(at.getUTCDate())}.${pad(at.getUTCMonth() + 1)}.${at.getUTCFullYear()}`)
    forms.add(`${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}`)
  }
  return [...forms]
}

test('test_recall_finds_the_owner_word_with_a_date_and_never_finds_what_a_guest_wrote', { timeout: TEST_TIMEOUT_MS }, async () => {
  const ownerWord = 'zorblaxquux'
  const guestWord = 'quokkaword7'
  const guestSide = 'pancakesalpha'

  const d = await startOwnerDaemon()
  await ownerTurn(d, 'turn-rc-1', `запомни слово ${ownerWord} и ещё marmaladebeta`)
  await admitGuest(d)
  await turnAs(d, GUEST_CHAT, 'turn-gu-1', `${guestWord} ${guestSide} betagamma`)
  await sleep(800)

  let ownerHit: Block[] = []
  let guestHit: Block[] = []
  const owner = d
  world.stub.main = (view) => {
    if (view.marker === 'turn-rc-2') {
      if (view.step === 0) return recallCall(view.body, ownerWord)
      ownerHit = view.results
    }
    if (view.marker === 'turn-rc-3') {
      if (view.step === 0) return recallCall(view.body, guestWord)
      guestHit = view.results
    }
    return undefined
  }
  const dates = dateForms()
  await ownerTurn(owner, 'turn-rc-2', 'что я просил запомнить?')
  await ownerTurn(owner, 'turn-rc-3', 'а что писал гость?')
  const datesAfter = dateForms()

  const found = ownerHit.map((b) => b.text).join('\n')
  expect(found, 'recall by the unique word finds the turn of the owner').toContain(ownerWord)
  expect([...dates, ...datesAfter].some((form) => found.includes(form)), `the hit carries a date: ${found}`).toBe(true)

  expect(guestHit.length, 'the model got a tool result for the recall of the guest word').toBeGreaterThan(0)
  const missed = guestHit.map((b) => b.text).join('\n')
  expect(missed, 'the message of the guest is not in the recall index of the owner').not.toContain(guestSide)
  expect(missed).not.toContain('betagamma')
  expect(missed).not.toContain('turn-gu-1')
})

// --- [snapshot] ------------------------------------------------------------------------------------------

test('test_snapshot_memory_is_in_the_tail_not_the_prefix_and_a_write_in_the_session_does_not_reach_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const seedMemoryFact = 'Окружение: бот живёт на ноутбуке SEEDMEMFACT'
  const seedUserFact = 'Владелец любит коротко SEEDUSERFACT'
  const fresh = 'Каталог проектов лежит в ~/work NEWSNAPFACT'
  seedMemory('MEMORY.md', seedMemoryFact)
  seedMemory('USER.md', seedUserFact)

  script('turn-sn-1', [memoryCall('memory', { op: 'add', text: fresh })])
  const d = await startOwnerDaemon()
  const first = (await ownerTurn(d, 'turn-sn-1'))[0] as DsEvent
  expect(readOrEmpty(memoryFile('MEMORY.md')), 'the write of the turn reached the file').toContain('NEWSNAPFACT')

  const tail = tailOf(first.body)
  expect(tail, 'MEMORY.md is in the tail of the first request of the session').toContain('SEEDMEMFACT')
  expect(tail, 'USER.md is in the tail of the first request of the session').toContain('SEEDUSERFACT')
  const prefix = prefixBytes(first.body)
  expect(prefix, 'MEMORY.md is not in the prefix').not.toContain('SEEDMEMFACT')
  expect(prefix, 'USER.md is not in the prefix').not.toContain('SEEDUSERFACT')

  const second = (await ownerTurn(d, 'turn-sn-2'))[0] as DsEvent
  expect(prefixBytes(second.body), 'the prefix is byte for byte the same in the next turn').toBe(prefix)
  const nextTail = tailOf(second.body)
  expect(nextTail, 'an entry written in this session is not in the tail of the same session').not.toContain('NEWSNAPFACT')
  expect(systemTextOf(second.body)).not.toContain('NEWSNAPFACT')
})

// --- [identity] ------------------------------------------------------------------------------------------

test('test_identity_update_with_the_current_revision_changes_the_file_a_stale_one_does_not', { timeout: TEST_TIMEOUT_MS }, async () => {
  // update_identity refuses a non-empty identity under 200 characters without force, so every version is
  // longer: this test is about the revision check, not the shrink guard
  const body = 'Отвечаю коротко и по делу, помню владельца и его проекты. '.repeat(4)
  const seed = `Я — тестовый бот. IDENTITYSEEDMARK\n${body}\n`
  const changed = `Я — тестовый бот, который умеет меняться. IDENTITYNEWMARK\n${body}\n`
  const third = `Я — третья версия. IDENTITYTHIRDMARK\n${body}\n`
  seedMemory('identity.md', seed)
  const seedRevision = sha256(seed)

  const files: string[] = []
  const results: Block[][] = []
  script(
    'turn-id-1',
    [
      // update_identity is lazy for the owner: the model loads it first
      { kind: 'tool', name: 'tool_search', input: { query: 'update_identity' } }, // 0: load
      { kind: 'tool', name: 'update_identity', input: { text: changed, expected_revision: 'f'.repeat(64) } }, // 1: wrong
      { kind: 'tool', name: 'update_identity', input: { text: changed, expected_revision: seedRevision } }, // 2: right
      { kind: 'tool', name: 'update_identity', input: { text: third, expected_revision: seedRevision } }, // 3: stale
    ],
    (step, got) => {
      files[step] = readOrEmpty(memoryFile('identity.md'))
      results[step] = got
    },
  )

  const d = await startOwnerDaemon()
  const firstCalls = await ownerTurn(d, 'turn-id-1')
  const first = firstCalls[0] as DsEvent
  // the last request of the turn already carries the update_identity loaded by tool_search
  const last = firstCalls[firstCalls.length - 1] as DsEvent
  expect(world.stub.toolCalls, 'the model loaded update_identity and called it three times').toBe(4)

  expect(files[1], 'loading the tool leaves identity.md unchanged').toBe(seed)
  expect(files[2], 'a wrong revision leaves identity.md unchanged').toBe(seed)
  expect(files[3], 'the current revision changes identity.md').toBe(changed)
  expect(files[4], 'the old revision is stale after the change and leaves identity.md unchanged').toBe(changed)
  expect(readOrEmpty(memoryFile('identity.md'))).toBe(changed)
  for (const step of [2, 4]) {
    const got = results[step] ?? []
    expect(got.length, `the model got a tool result for the rejected call before step ${step}`).toBeGreaterThan(0)
    expect(got.some((b) => b.isError || /revision|ревиз|conflict|конфликт/i.test(b.text)), JSON.stringify(got)).toBe(true)
  }

  // identity stays in the prefix as the snapshot of the session
  expect(systemTextOf(first.body)).toContain('IDENTITYSEEDMARK')
  const second = (await ownerTurn(d, 'turn-id-2'))[0] as DsEvent
  expect(prefixBytes(second.body), 'the prefix does not change after update_identity').toBe(prefixBytes(last.body))
  expect(systemTextOf(second.body), 'the system prompt does not change after update_identity').toBe(systemTextOf(first.body))
  expect(systemTextOf(second.body)).not.toContain('IDENTITYNEWMARK')
})

// --- [guest] ---------------------------------------------------------------------------------------------

test('test_guest_has_no_memory_recall_or_update_identity_in_the_tool_schema', { timeout: TEST_TIMEOUT_MS }, async () => {
  const memoryTools = ['memory', 'recall', 'update_identity']
  const d = await startOwnerDaemon()
  const ownerCalls = await ownerTurn(d, 'turn-gt-1')
  const ownerTools = toolNames((ownerCalls[0] as DsEvent).body)
  for (const name of ['memory', 'recall']) expect(ownerTools, `the owner has the ${name} tool`).toContain(name)
  // update_identity is lazy for the owner: indexed in the prefix, loaded by tool_search
  expect(ownerTools, 'the owner has tool_search').toContain('tool_search')
  expect(systemTextOf((ownerCalls[0] as DsEvent).body), 'the owner index lists update_identity').toContain('\nupdate_identity: ')

  await admitGuest(d)
  const guestCalls = await turnAs(d, GUEST_CHAT, 'turn-gu-2')
  for (const call of guestCalls) {
    const tools = toolNames(call.body)
    for (const name of memoryTools) expect(tools, `the guest has no ${name} tool`).not.toContain(name)
  }
})

// --- [knowledge limits] ----------------------------------------------------------------------------

test('test_knowledge_limits_are_checked_before_trimming_and_a_refused_write_creates_nothing', async () => {
  const { writeKnowledgeTopic } = await import('../memory/src/knowledge.js')
  const directory = join(world.dshbotHome, 'memory', 'knowledge')
  const refused: Array<[string, string, string]> = [
    ['summary of 200 letters and a trailing space', 'с'.repeat(200) + ' ', 'text'],
    ['summary of a leading space and 200 letters', ' ' + 'с'.repeat(200), 'text'],
    ['summary with a trailing newline', 'summary\n', 'text'],
    ['text of 20000 letters and a trailing space', 'summary', 'т'.repeat(20_000) + ' '],
  ]
  for (const [label, summary, text] of refused) {
    expect(() => writeKnowledgeTopic(directory, { topic: 'limit', summary, text }), label).toThrow()
  }
  expect(existsSync(directory), 'a refused write creates no knowledge directory').toBe(false)

  writeKnowledgeTopic(directory, { topic: 'limit', summary: ` ${'с'.repeat(198)} `, text: 'т'.repeat(20_000) })
  expect(readFileSync(join(directory, 'limit.md'), 'utf8')).toContain(`summary: "${'с'.repeat(198)}"`)
})
