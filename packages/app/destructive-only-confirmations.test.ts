// Confirmations only for the destructive and the irreversible: an owner turn that has already taken external
// content (web_search, an MCP read) still runs an ordinary MCP tool, opens a browser page on a new public host
// and keeps the network of exec, without a card. What stays: destructive and `confirm` MCP tools, quoting private
// data in outgoing arguments and the canary. Real daemon against local Telegram, model, HTTP and MCP fakes; the
// harness is the one of outbound-content-policy.test.ts without mail and ssh.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sandboxProfile } from '../tools-exec/src/index.js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 280_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

const MARKER_RE = /turn-[a-z]+-\d+/

const SERVER = 'testsrv'
const CONFIRM_SERVER = 'confsrv'
const ECHO = 'mcp__testsrv__echo'
const WRITE = 'mcp__testsrv__write'
const FALSE_READONLY = 'mcp__testsrv__explicit_write'
const WIPE = 'mcp__testsrv__wipe'
const CONFIRM_WRITE = 'mcp__confsrv__write'

function findChromium(): string | undefined {
  const configured = process.env.DSHBOT_BROWSER_PATH
  if (configured && existsSync(configured)) return configured
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(directory, name)
      if (directory !== '' && existsSync(candidate)) return candidate
    }
  }
  return undefined
}
const chromium = findChromium()
const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"

const HOST_A = 'first.fixture.test'
const HOST_B = 'second.fixture.test'
const BODY = 'EXTERNAL-FIXTURE-OK'
const LANDED = 'LANDED-PAGE-OK'
const PRIVATE_MEMORY = 'memoryAlpha0123456789_private_be'
const VAULT_VALUE = 'vault-Z9!q' // Shorter than 32: secrets have no fragment-length exemption.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the MCP server of the tests -----------------------------------------------------------------------------

/**
 * A stdio MCP server in plain Node. Argument: the data directory of this server. It appends every tools/call to
 * calls.jsonl and its pid to launches.jsonl at every start. One reader, two ordinary writers (without
 * readOnlyHint and with readOnlyHint: false) and one tool with destructiveHint: true.
 */
const FIXTURE_SERVER = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n')

const schema = { type: 'object', properties: { text: { type: 'string' } } }
const tools = [
  { name: 'echo', description: 'Read external text.', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Write external text.', inputSchema: schema },
  { name: 'explicit_write', description: 'Write external text.', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'wipe', description: 'Wipe the data.', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true } },
]

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  if (id === undefined) return
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'testsrv', version: '1.0.0' } } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else if (method === 'tools/list') {
    send({ id, result: { tools } })
  } else if (method === 'tools/call') {
    appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ name: params.name, arguments: params.arguments || {} }) + '\\n')
    const text = params.name === 'echo' ? 'ECHO:' + ((params.arguments || {}).text || '') : 'DONE:' + params.name
    send({ id, result: { content: [{ type: 'text', text }] } })
  } else {
    send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
})
`


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

/** Names of the tools a request declares, sorted. */
/** Index of the last user message with a turn marker, and the marker. */
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

/** Tool results the model got with this request, from its last user message. */
function lastResults(body: JsonObject): Block[] {
  const messages = messagesOf(body)
  const last = messages[messages.length - 1]
  return last !== undefined && last.role === 'user' ? blocksOf(last.content).filter((block) => block.kind === 'tool_result') : []
}


// --- the scripted model --------------------------------------------------------------------------

type Action = { kind: 'tool'; name: string; input: JsonObject } | { kind: 'text'; text: string }

interface Stub {
  server: Server
  origin: string
  /** Tool calls of a turn of main, by marker; after the last one the model answers `fin <marker>`. */
  scripts: Map<string, Action[]>
  dynamic?: (marker: string, step: number, body: JsonObject) => Action | undefined
}

const search = (query: string): Action => ({ kind: 'tool', name: 'tool_search', input: { query } })
const call = (name: string, input: JsonObject = {}): Action => ({ kind: 'tool', name, input })

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

/** Assistant messages of the turn the last user message with a marker opened. */
function turnStep(body: JsonObject, at: number): number {
  return messagesOf(body)
    .slice(at + 1)
    .filter((message) => message.role === 'assistant').length
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', scripts: new Map() }
  let toolUses = 0
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      if (Array.isArray(body.tools) && body.tools.some((tool) => String(asObject(tool).type).startsWith('web_search'))) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_search', type: 'message', role: 'assistant', model: 'deepseek-v4-flash', stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
          content: [{ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
            { type: 'web_search_result', url: 'https://found.example/fact', title: BODY, page_age: '1 day ago' },
          ] }, { type: 'text', text: 'summary', citations: [
            { type: 'web_search_result_location', url: 'https://found.example/fact', cited_text: BODY },
          ] }],
        }))
        return
      }
      if (body.stream !== true) {
        // the judge of /goal asks without streaming: the goal is done after its first turn
        const asked = messagesOf(body).map((m) => flatten(m.content)).join('\n')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage(/судья/.test(asked) ? '{"done": true, "reason": "ok"}' : 'pong'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const found = markerMessage(body)
      if (found === undefined) {
        res.end(textStream('pong'))
        return
      }
      const script = stub.scripts.get(found.marker) ?? []
      const step = turnStep(body, found.at)
      const action = stub.dynamic?.(found.marker, step, body) ?? script[step]
      if (action === undefined || action.kind === 'text') {
        res.end(textStream(action?.text ?? `fin ${found.marker}`))
      } else {
        toolUses += 1
        res.end(toolUseStream(`toolu_main_${toolUses}`, action.name, action.input))
      }
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
      const event: TgEvent = { n: timeline.seq, src: 'tg', method, params }
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
      const result = okResult(tg, method, params)
      const sentId = asObject(result).message_id
      if (typeof sentId === 'number') event.messageId = sentId
      reply(200, JSON.stringify({ ok: true, result }))
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

function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

/** An approval card: a sent message with an inline keyboard of an allow and a deny button. */
interface Card {
  chatId: number
  messageId: number
  text: string
  allow: string
  deny: string
}

function cardsIn(timeline: Timeline, chatId: number): Card[] {
  const cards: Card[] = []
  for (const e of sentTo(timeline, chatId)) {
    const rows = asObject(e.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows) || e.messageId === undefined) continue
    const data = rows
      .flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
      .map((button) => (typeof button.callback_data === 'string' ? button.callback_data : ''))
    // callback_data of an approval is tga1[r]:<kind>:<a|d>:<id>
    const allow = data.find((d) => /^tga1r?:/.test(d) && d.split(':')[2] === 'a')
    const deny = data.find((d) => /^tga1r?:/.test(d) && d.split(':')[2] === 'd')
    if (allow === undefined || deny === undefined) continue
    cards.push({ chatId, messageId: e.messageId, text: deepStrings(e.params.text).join('\n'), allow, deny })
  }
  return cards
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
  /** Where the MCP server of the tests writes down launches and calls. */
  dataDir: string
  daemons: Daemon[]
  fixture: Server
  fixturePort: number
  hits: string[]
}

let scratch: string
let serverFile: string
let world: World
let preloadFile: string
let searchShim: string
let browserPath: string

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (entry point of the daemon)').toBe('string')
  return script as string
}

function spawnDaemon(extraEnv: Record<string, string>): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    DSHBOT_DREAM_AT: 'off',
    DSHBOT_BROWSER_PATH: browserPath,
    NODE_OPTIONS: `--import ${pathToFileURL(preloadFile).href}`,
    OUTBOUND_SEARCH_SHIM: pathToFileURL(searchShim).href,
    OUTBOUND_SEARCH_URL: `${world.stub.origin}/anthropic`,
    ...extraEnv,
  }
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

/** SIGTERM and wait for the exit: the next daemon starts on the same state directory. */
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

async function startOwnerDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const d = await startDaemon(extraEnv)
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
async function turnAs(d: Daemon, chatId: number, marker: string): Promise<DsEvent[]> {
  say(chatId, `${marker} сделай, пожалуйста`)
  await waitFor(`the reply of turn ${marker}`, () => replyEvent(chatId, marker) !== undefined, d, TURN_WAIT_MS)
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

const ownerTurn = (d: Daemon, marker: string): Promise<DsEvent[]> => turnAs(d, OWNER_CHAT, marker)


// --- the MCP files of the tests --------------------------------------------------------------------------

const mcpJsonPath = (): string => join(world.dshbotHome, 'mcp.json')

function writeMcpJson(servers: Record<string, unknown>): void {
  writeFileSync(mcpJsonPath(), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`)
}

/** Data directory of one stdio server of the tests: its launches and calls. */
function dirOf(name: string): string {
  const dir = join(world.dataDir, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The stdio server `name` with the policy fields of `extra`. */
function stdioEntry(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [serverFile, dirOf(name)], ...extra }
}

function jsonLines(file: string): JsonObject[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseObject(line))
}

const launches = (name: string): JsonObject[] => jsonLines(join(world.dataDir, name, 'launches.jsonl'))
const callsOf = (name: string): JsonObject[] => jsonLines(join(world.dataDir, name, 'calls.jsonl'))
const calledNames = (name: string): unknown[] => callsOf(name).map((c) => c.name)

/** The daemon connects the servers of mcp.json at start: wait for their launches, then for the tool lists. */
async function waitServersUp(d: Daemon, names: string[]): Promise<void> {
  for (const name of names) await waitFor(`the MCP server ${name} to be launched`, () => launches(name).length > 0, d)
  await sleep(1_500)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

// Only transports are redirected: the two fixture names resolve to a public address that connects to the local
// fixture server, and the web tools of the daemon send web_search to the stub. Real tools and approvals run.
const TRANSPORT_PRELOAD = String.raw`
import { createRequire, syncBuiltinESMExports, registerHooks } from 'node:module'
const require = createRequire(import.meta.url)
const net = require('node:net')
const dns = require('node:dns')
const originalLookup = dns.promises.lookup
const originalConnect = net.Socket.prototype.connect
const names = ['first.fixture.test', 'second.fixture.test']
dns.promises.lookup = async function(host, options) {
  if (!names.includes(host)) return originalLookup.call(this, host, options)
  const entry = { address: '93.184.216.34', family: 4 }
  return options?.all ? [entry] : entry
}
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (options && typeof options === 'object' && (names.includes(options.host) || options.host === '93.184.216.34')) {
    options.host = '127.0.0.1'
    delete options.lookup
  }
  return originalConnect.apply(this, args)
}
syncBuiltinESMExports()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/packages/app/src/') && /tools-web\/src\/index\.js$/.test(specifier)) {
      return { url: process.env.OUTBOUND_SEARCH_SHIM, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-destructive-only-')))
  serverFile = join(scratch, 'server.mjs')
  writeFileSync(serverFile, FIXTURE_SERVER)
  preloadFile = join(scratch, 'transports.mjs')
  writeFileSync(preloadFile, TRANSPORT_PRELOAD)
  searchShim = join(scratch, 'search-endpoint.mjs')
  const realWeb = pathToFileURL(join(repoRoot, 'packages/tools-web/src/index.ts')).href
  writeFileSync(searchShim, `
import * as real from ${JSON.stringify(realWeb)}
export * from ${JSON.stringify(realWeb)}
export function createWebTools(options) {
  return real.createWebTools({ ...options, searchBaseUrl: process.env.OUTBOUND_SEARCH_URL })
}
`)
  browserPath = join(scratch, 'chromium')
  writeFileSync(browserPath, `#!/bin/sh\nexec ${shellQuote(chromium ?? '/nonexistent/chromium')} --no-sandbox "$@"\n`, { mode: 0o755 })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Pages of the fixture server: the answer depends on the path, the host is whatever the browser asked for. */
function fixturePage(path: string, port: number, response: ServerResponse): void {
  if (path.startsWith('/bounce')) {
    response.writeHead(302, { location: `http://${HOST_B}:${port}/landed` })
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  if (path.startsWith('/landed') || path.startsWith('/clicked')) {
    response.end(`<html><body>${BODY} ${LANDED}</body></html>`)
  } else if (path.startsWith('/links')) {
    response.end(`<html><body>${BODY}<p><a href="http://${HOST_B}:${port}/clicked">Other host link</a></p></body></html>`)
  } else {
    response.end(`<html><body>${BODY}</body></html>`)
  }
}

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const dataDir = mkdtempSync(join(scratch, 'data-'))
  const hits: string[] = []
  let fixturePort = 0
  const fixture = createServer((request, response) => {
    hits.push(`${request.headers.host}${request.url}`)
    fixturePage(request.url ?? '/', fixturePort, response)
  })
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  fixturePort = (fixture.address() as AddressInfo).port
  world = { timeline, tg, stub, home: mkdtempSync(join(scratch, 'home-')), dshbotHome, dataDir, daemons: [],
    fixture, fixturePort, hits }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  mkdirSync(join(dshbotHome, 'memory'), { recursive: true })
  writeFileSync(join(dshbotHome, 'memory', 'MEMORY.md'), `# Memory\nleft:${PRIVATE_MEMORY}:right\n`)
  mkdirSync(join(dshbotHome, 'secrets'), { recursive: true })
  writeFileSync(join(dshbotHome, 'secrets', 'EXPORT_KEY'), VAULT_VALUE, { mode: 0o600 })
  writeMcpJson({
    [SERVER]: stdioEntry(SERVER),
    [CONFIRM_SERVER]: stdioEntry(CONFIRM_SERVER, { confirm: ['write'] }),
  })
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (d.exited) continue
    d.child.kill('SIGTERM')
    const timer = setTimeout(() => d.child.kill('SIGKILL'), 8_000)
    await d.exit
    clearTimeout(timer)
  }
  await Promise.all([closeServer(world.tg.server), closeServer(world.stub.server), closeServer(world.fixture)])
})

// --- helpers of the tests ----------------------------------------------------------------------------------

const fixtureUrl = (path: string, host = HOST_A): string => `http://${host}:${world.fixturePort}${path}`
const newCards = (mark: number): Card[] => cardsIn({ events: world.timeline.events.filter((e) => e.n > mark), seq: world.timeline.seq }, OWNER_CHAT)

function resultAt(marker: string, actionIndex: number): Block {
  const request = turnCalls(marker)[actionIndex + 1]
  expect(request, `the model received the result of step ${actionIndex} in ${marker}`).toBeDefined()
  const results = lastResults((request as DsEvent).body)
  expect(results, 'one actual tool result reached the model').toHaveLength(1)
  return results[0] as Block
}

function expectRefusal(result: Block): void {
  expect(result.isError || /отказ|не выполн|не вызван|недоступ|запрещ|подтвержд|владел|denied|refus|blocked|approval/i.test(result.text), result.text).toBe(true)
  expect(result.text.trim(), 'the refusal explains why the operation did not run').not.toBe('')
}

/** Card or the end of the turn, whichever comes first: a card that must not be there fails at once. */
async function pendingOrFinished(d: Daemon, marker: string, mark: number): Promise<void> {
  await waitFor('an approval card or the completed turn', () => newCards(mark).length > 0 || replyEvent(OWNER_CHAT, marker) !== undefined, d, TURN_WAIT_MS)
}

/** The turn runs to its end without a single owner card. */
async function runsWithoutCard(d: Daemon, marker: string, mark: number): Promise<void> {
  say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
  await pendingOrFinished(d, marker, mark)
  expect(newCards(mark).map((card) => card.text), `no owner card in ${marker}`).toEqual([])
}

async function pendingCard(d: Daemon, marker: string, mark: number): Promise<Card> {
  await pendingOrFinished(d, marker, mark)
  expect(newCards(mark), `the call needs one owner card in ${marker}`).toHaveLength(1)
  await sleep(250)
  return newCards(mark)[0] as Card
}

async function finish(d: Daemon, marker: string): Promise<void> {
  await waitFor('the final owner answer', () => replyEvent(OWNER_CHAT, marker) !== undefined, d, TURN_WAIT_MS)
}

async function ready(): Promise<Daemon> {
  const daemon = await startOwnerDaemon()
  await waitServersUp(daemon, [SERVER, CONFIRM_SERVER])
  return daemon
}

const SEARCH = call('web_search', { query: 'ordinary public facts' })

/** The ref of the snapshot line that carries `name`. */
function refOf(snapshot: string, name: string): string {
  const line = snapshot.split('\n').find((item) => item.includes(name)) ?? ''
  const found = /\[ref=([a-z0-9]+)\]/.exec(line)?.[1]
  expect(found, `the snapshot gives a ref to ${name}:\n${snapshot}`).toBeDefined()
  return found as string
}

const sandboxAvailable = ((): boolean => {
  const directory = mkdtempSync(join(tmpdir(), 'dshbot-destructive-only-probe-'))
  try {
    const profile = sandboxProfile({ home: directory, workspace: directory, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { timeout: 10_000 })
    return probe.error === undefined && probe.status === 0 && spawnSync('curl', ['--version']).status === 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})()

// --- c1, c2: ordinary MCP tools after external content ------------------------------------------------------------

for (const target of [WRITE, FALSE_READONLY]) {
  const written = target === WRITE ? 'write' : 'explicit_write'
  test(`test_c1_after_web_search_${written}_runs_without_a_card`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-search-1'
    world.stub.scripts.set(marker, [SEARCH, search(target), call(target, { text: 'PUBLIC-WRITE-AFTER-SEARCH' })])
    const d = await ready()
    const mark = world.timeline.seq
    await runsWithoutCard(d, marker, mark)
    expect(resultAt(marker, 0).text, 'the search result really reached the model first').toContain(BODY)
    expect(resultAt(marker, 2).isError, resultAt(marker, 2).text).toBe(false)
    expect(resultAt(marker, 2).text).toContain(`DONE:${written}`)
    expect(callsOf(SERVER)).toEqual([{ name: written, arguments: { text: 'PUBLIC-WRITE-AFTER-SEARCH' } }])
  })

  test(`test_c2_after_an_mcp_read_${written}_of_the_same_server_runs_without_a_card`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-state-1'
    world.stub.scripts.set(marker, [search(ECHO), search(target), call(ECHO, { text: 'STATE-OF-THE-LIGHT' }), call(target, { text: 'PUBLIC-WRITE-AFTER-READ' })])
    const d = await ready()
    const mark = world.timeline.seq
    await runsWithoutCard(d, marker, mark)
    expect(resultAt(marker, 2).text, 'the state read reached the model first').toContain('ECHO:STATE-OF-THE-LIGHT')
    expect(resultAt(marker, 3).isError, resultAt(marker, 3).text).toBe(false)
    expect(resultAt(marker, 3).text).toContain(`DONE:${written}`)
    expect(calledNames(SERVER)).toEqual(['echo', written])
  })
}

// --- c3: the browser after external content ----------------------------------------------------------------------

test.skipIf(chromium === undefined)('test_c3_after_web_search_browser_open_of_a_new_public_host_needs_no_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-search-2'
  world.stub.scripts.set(marker, [SEARCH, search('browser'), call('browser', { action: 'open', url: fixtureUrl('/opened') })])
  const d = await ready()
  const mark = world.timeline.seq
  await runsWithoutCard(d, marker, mark)
  expect(resultAt(marker, 2).isError, resultAt(marker, 2).text).toBe(false)
  expect(resultAt(marker, 2).text).toContain(BODY)
  expect(world.hits.some((hit) => hit.startsWith(HOST_A) && hit.includes('/opened'))).toBe(true)
})

test.skipIf(chromium === undefined)('test_c3_after_web_search_a_click_to_a_new_public_host_is_not_refused', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-search-3'
  world.stub.scripts.set(marker, [SEARCH, search('browser'),
    call('browser', { action: 'open', url: fixtureUrl('/links') }),
    call('browser', { action: 'snapshot' }),
  ])
  world.stub.dynamic = (turn, step, body) => {
    if (turn !== marker || step !== 4) return undefined
    return call('browser', { action: 'click', ref: refOf(lastResults(body)[0]?.text ?? '', 'Other host link') })
  }
  const d = await ready()
  const mark = world.timeline.seq
  await runsWithoutCard(d, marker, mark)
  const clicked = resultAt(marker, 4)
  expect(clicked.isError, clicked.text).toBe(false)
  expect(clicked.text).toContain(LANDED)
  expect(world.hits.some((hit) => hit.startsWith(HOST_B) && hit.includes('/clicked'))).toBe(true)
})

test.skipIf(chromium === undefined)('test_c3_after_web_search_a_redirect_to_a_new_public_host_is_not_refused', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-search-4'
  world.stub.scripts.set(marker, [SEARCH, search('browser'), call('browser', { action: 'open', url: fixtureUrl('/bounce') })])
  const d = await ready()
  const mark = world.timeline.seq
  await runsWithoutCard(d, marker, mark)
  const opened = resultAt(marker, 2)
  expect(opened.isError, opened.text).toBe(false)
  expect(opened.text).toContain(LANDED)
  expect(world.hits.some((hit) => hit.startsWith(HOST_B) && hit.includes('/landed'))).toBe(true)
})

// --- c4: the network of exec after external content ---------------------------------------------------------------

test.skipIf(!sandboxAvailable)('test_c4_exec_keeps_its_network_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-exec-1'
  world.stub.scripts.set(marker, [SEARCH, search(ECHO), call(ECHO, { text: 'STATE' }),
    call('exec', { command: `curl -sS --max-time 5 '${fixtureUrl('/after-external')}'`, timeout_sec: 20 }),
  ])
  const d = await ready()
  const mark = world.timeline.seq
  await runsWithoutCard(d, marker, mark)
  const network = resultAt(marker, 3)
  expect(network.text).not.toMatch(/сеть закрыта после внешнего контента/i)
  expect(network.text, 'the request of exec reached the fixture through the proxy').toContain(BODY)
  expect(world.hits.some((hit) => hit.includes('/after-external'))).toBe(true)
})

// --- c6: what still asks ------------------------------------------------------------------------------------------

for (const target of [WIPE, CONFIRM_WRITE]) {
  test(`test_c6_owner_turn_${target.replace(/^mcp__/, '')}_still_gets_a_card_and_waits_for_the_button`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-destroy-1'
    world.stub.scripts.set(marker, [SEARCH, search(target), call(target, { text: 'PUBLIC-TEXT' })])
    const d = await ready()
    const mark = world.timeline.seq
    say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
    const card = await pendingCard(d, marker, mark)
    expect(card.text, 'the card names the tool').toMatch(target === WIPE ? /wipe/ : /write/)
    expect(callsOf(SERVER)).toEqual([])
    expect(callsOf(CONFIRM_SERVER)).toEqual([])
    world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))
    await finish(d, marker)
    expectRefusal(resultAt(marker, 2))
    expect(callsOf(SERVER)).toEqual([])
    expect(callsOf(CONFIRM_SERVER)).toEqual([])
  })
}

for (const entry of [
  { label: 'memory', value: `prefix ${PRIVATE_MEMORY} suffix`, source: /MEMORY\.md|долговременн.*памят/i },
  { label: 'vault_secret', value: VAULT_VALUE, source: /EXPORT_KEY|секрет|secret/i },
]) {
  test(`test_c6_quoting_${entry.label}_in_an_outgoing_argument_still_gets_a_card_naming_the_source`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-private-1'
    world.stub.scripts.set(marker, [search(WRITE), call(WRITE, { text: entry.value })])
    const d = await ready()
    const mark = world.timeline.seq
    say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
    const card = await pendingCard(d, marker, mark)
    expect(card.text, 'the card identifies the private source').toMatch(entry.source)
    expect(callsOf(SERVER)).toEqual([])
    world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))
    await finish(d, marker)
    expectRefusal(resultAt(marker, 1))
    expect(callsOf(SERVER)).toEqual([])
  })
}

/** The whole snapshot of the first request carries the canary of this session. */
function memorySnapshot(body: JsonObject): string {
  const texts = messagesOf(body).map((message) => flatten(message.content)).join('\n')
  const snapshot = [...texts.matchAll(/<context\b[^>]*>([\s\S]*?)<\/context>/g)].map((match) => match[1]).join('\n')
  expect(snapshot, 'the initial request contains the host memory snapshot').toContain(PRIVATE_MEMORY)
  return snapshot
}

test('test_c6_an_argument_with_the_canary_is_refused_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-canary-1'
  let snapshot = ''
  world.stub.dynamic = (turn, step, body) => {
    if (turn !== marker) return undefined
    if (step === 0) {
      snapshot = memorySnapshot(body)
      return search(WRITE)
    }
    if (step === 1) return call(WRITE, { text: `ordinary-prefix ${snapshot} ordinary-suffix` })
    return undefined
  }
  const d = await ready()
  const mark = world.timeline.seq
  say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
  await pendingOrFinished(d, marker, mark)
  expect(newCards(mark), 'there is no allow button for a canary').toEqual([])
  expect(snapshot, 'the attempted leak includes the snapshot of this turn').toContain(PRIVATE_MEMORY)
  expectRefusal(resultAt(marker, 1))
  expect(callsOf(SERVER), 'the peer never got the canary').toEqual([])
})
