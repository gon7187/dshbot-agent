// Nesting of DSHBOT_HOME in an extra root of fs-roots.json is decided on the relative path, not on its text:
// a home called "..dshbot" next to the root's files is inside the root, so the root is read-only and journaled.
// Same harness as fs-roots-daemon.test.ts, trimmed to one owner scenario: the daemon runs as a child process
// against a fake Telegram Bot API and a local DeepSeek stub that plays the model.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

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

// --- the scripted model --------------------------------------------------------------------------

/** One tool call: the tool name and its input as the model would send it. */
interface ToolCall {
  tool: string
  input: JsonObject
  /** send the call even if the tool is not offered (a model that invents a tool_use) */
  force?: boolean
}

interface Outcome {
  /** the tool is not among the tools[] of the model request, even after tool_search */
  missing?: string
  /** tool_search calls the stub made to load the tool */
  searches: number
  /** what the tool answered, as the next model request carried it */
  result?: { text: string; isError: boolean }
}

interface Stub {
  server: Server
  origin: string
  calls: Map<number, ToolCall>
  outcomes: Map<number, Outcome>
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

function pongStream(): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
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

/** Tools the request offers: name to the property names of its input schema. */
function toolSchemas(body: JsonObject): Map<string, { props: string[]; required: string[] }> {
  const found = new Map<string, { props: string[]; required: string[] }>()
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const tool = asObject(raw)
    const fn = asObject(tool.function)
    const name = typeof tool.name === 'string' ? tool.name : typeof fn.name === 'string' ? fn.name : undefined
    if (name === undefined) continue
    const schema = asObject(tool.input_schema ?? tool.parameters ?? fn.parameters)
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
    found.set(name, { props: Object.keys(asObject(schema.properties)), required })
  }
  return found
}

function toolNames(body: JsonObject): string[] {
  return [...toolSchemas(body).keys()]
}

/** The tool result carried by the last message of a model request, if there is one. */
function lastToolResult(body: JsonObject): { id: string; text: string; isError: boolean } | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of messages.slice(-2).reverse()) {
    const message = asObject(raw)
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = asObject(part)
      if (block.type !== 'tool_result') continue
      return {
        id: String(block.tool_use_id ?? ''),
        text: flatten(block.content),
        isError: block.is_error === true,
      }
    }
  }
  return undefined
}

/** Number of the `run-tool-N` marker in the latest user message that carries one. */
function markerOf(body: JsonObject): number | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of [...messages].reverse()) {
    const message = asObject(raw)
    if (message.role !== 'user') continue
    const found = /run-tool-(\d+)/.exec(flatten(message.content))
    if (found !== null) return Number(found[1])
  }
  return undefined
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', calls: new Map(), outcomes: new Map() }
  const issued = new Map<string, { n: number; search: boolean }>()
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

      const result = lastToolResult(body)
      const known = result === undefined ? undefined : issued.get(result.id)
      if (result !== undefined && known === undefined) {
        res.end(pongStream())
        return
      }
      if (result !== undefined && known !== undefined && !known.search) {
        const outcome = stub.outcomes.get(known.n)
        if (outcome !== undefined) outcome.result = { text: result.text, isError: result.isError }
        res.end(pongStream())
        return
      }

      const n = known?.n ?? markerOf(body)
      const call = n === undefined ? undefined : stub.calls.get(n)
      if (n === undefined || call === undefined) {
        res.end(pongStream())
        return
      }
      // every scripted call is issued once, however often the same user message comes back
      if (known === undefined && stub.outcomes.has(n)) {
        res.end(pongStream())
        return
      }
      const outcome = stub.outcomes.get(n) ?? { searches: 0 }
      stub.outcomes.set(n, outcome)

      const names = toolNames(body)
      if (names.includes(call.tool) || (call.force === true && (outcome.searches >= 2 || !names.includes('tool_search')))) {
        const id = `toolu_${n}`
        issued.set(id, { n, search: false })
        res.end(toolUseStream(id, call.tool, call.input))
        return
      }
      if (names.includes('tool_search') && outcome.searches < 2) {
        outcome.searches += 1
        const id = `toolu_search_${n}_${outcome.searches}`
        issued.set(id, { n, search: true })
        res.end(toolUseStream(id, 'tool_search', { query: call.tool }))
        return
      }
      outcome.missing = `tool "${call.tool}" is not in tools[]: ${JSON.stringify(names)}`
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

function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
}

// --- the daemon as a child process ------------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stderr: string
  exit: Promise<unknown>
  exited: boolean
}

interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  /** the HOME of the daemon */
  home: string
  /** the directory the owner declares as a read-write root */
  base: string
  /** DSHBOT_HOME: a directory called "..dshbot" inside `base` */
  dshbotHome: string
  daemons: Daemon[]
  callSeq: number
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
    XDG_RUNTIME_DIR: mkdtempSync(join(scratch, 'run-')),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn('sh', ['-c', `exec ${startScript()}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const daemon: Daemon = {
    child,
    stderr: '',
    exited: false,
    exit: new Promise((resolve) => {
      child.on('close', (code, signal) => {
        daemon.exited = true
        resolve({ code, signal })
      })
    }),
  }
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  world.daemons.push(daemon)
  return daemon
}

function output(d: Daemon): string {
  return `--- stderr ---\n${d.stderr.slice(-3000)}`
}

async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
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

async function startOwnerDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)

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
  return d
}

interface ToolResult {
  text: string
  isError: boolean
}

/** One tool call of the owner turn; resolves with what the tool answered after the pong that ends the turn. */
async function useTool(d: Daemon, call: ToolCall): Promise<ToolResult> {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.calls.set(n, call)
  const pongs = pongsTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, `run-tool-${n}`)
  await waitFor(`a pong answer to run-tool-${n}`, () => pongsTo(world.timeline, OWNER_CHAT).length > pongs, d)
  const outcome = world.stub.outcomes.get(n)
  const what = `${call.tool} ${JSON.stringify(call.input).slice(0, 300)}`
  expect(outcome, `the model was not asked to run: ${what}\n${output(d)}`).toBeDefined()
  expect(outcome?.missing, `the tool must be offered to the owner: ${what}`).toBeUndefined()
  expect(outcome?.result, `no tool result reached the model for: ${what}\n${output(d)}`).toBeDefined()
  return outcome?.result as ToolResult
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp, so roots under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-fs-home-nesting-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const base = realpathSync(mkdtempSync(join(scratch, 'base-')))
  const dshbotHome = join(base, '..dshbot')
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
  world = {
    timeline,
    tg,
    stub,
    home: realpathSync(mkdtempSync(join(scratch, 'home-'))),
    base,
    dshbotHome,
    daemons: [],
    callSeq: 0,
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

// --- [h2] "..dshbot" inside the root -----------------------------------------------------------------------

test('test_h2_home_named_dot_dot_prefix_inside_a_rw_root_makes_the_root_read_only_and_is_journaled', { timeout: TEST_TIMEOUT_MS }, async () => {
  // DSHBOT_HOME = <base>/..dshbot: relative(base, home) is "..dshbot", which is nesting, not "outside the root"
  writeFileSync(join(world.base, 'note.txt'), 'NESTED-HOME-MARKER-H2\n')
  const sibling = realpathSync(mkdtempSync(join(scratch, 'sibling-')))
  writeFileSync(join(world.dshbotHome, 'fs-roots.json'), JSON.stringify([
    { path: world.base, mode: 'rw' },
    { path: sibling, mode: 'rw' },
  ]))
  const d = await startOwnerDaemon()

  const read = await useTool(d, { tool: 'read', input: { path: join(world.base, 'note.txt') } })
  expect(read.isError, `the root is still readable: ${read.text}`).toBe(false)
  expect(read.text).toContain('NESTED-HOME-MARKER-H2')

  const created = await useTool(d, { tool: 'write', input: { path: join(world.base, 'new.txt'), content: 'HACKED' } })
  expect(created.isError, `write into a root that contains DSHBOT_HOME must be refused: ${created.text}`).toBe(true)
  expect(created.text, 'the refusal names the read-only mode').toMatch(/read-only|readonly|только\s+(?:для\s+)?чтени|\bro\b/i)
  expect(existsSync(join(world.base, 'new.txt')), 'nothing is created in the nested-home root').toBe(false)

  const edited = await useTool(d, { tool: 'edit', input: { path: join(world.base, 'note.txt'), old_string: 'MARKER', new_string: 'CHANGED' } })
  expect(edited.isError, `edit in a root that contains DSHBOT_HOME must be refused: ${edited.text}`).toBe(true)
  expect(readFileSync(join(world.base, 'note.txt'), 'utf8')).toBe('NESTED-HOME-MARKER-H2\n')

  const journal = d.stderr.split('\n').filter((line) => line.includes('fs-roots') && line.includes(world.base))
  expect(journal.length, `the journal must say that the root was forced to read-only\n${output(d)}`).toBeGreaterThan(0)

  // a root that really is outside DSHBOT_HOME keeps its mode
  const ok = await useTool(d, { tool: 'write', input: { path: join(sibling, 'ok.txt'), content: 'fine' } })
  expect(ok.isError, `a rw root outside DSHBOT_HOME stays writable: ${ok.text}`).toBe(false)
  expect(readFileSync(join(sibling, 'ok.txt'), 'utf8')).toBe('fine')
})
