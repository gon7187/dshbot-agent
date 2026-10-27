// MCP servers of the owner through the daemon: the list comes from DSHBOT_HOME/mcp.json only, the tools are
// the owner's alone and lazy, a destructive tool needs the button of the owner, a broken server leaves the daemon
// alone, and the environment of a stdio server is scrubbed. Same harness as browser-daemon.test.ts: the daemon
// runs as a child process against a fake Telegram Bot API and a local DeepSeek stub. The stub plays the main
// model from a script per turn marker (`turn-xx-N`: tool calls first, then the answer `fin <marker>`) and the
// judge of /goal with a `done` verdict. The MCP server is a small stdio program written next to the test: it
// writes down its own environment at every launch and every call it gets, so the test sees what the daemon did.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { GuestRegistry } from './src/guests.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 280_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 31

const MARKER_RE = /turn-[a-z]+-\d+/

const SERVER = 'testsrv'
const ECHO = `mcp__${SERVER}__echo`
const WIPE = `mcp__${SERVER}__wipe`
const CRASH = `mcp__${SERVER}__crash`
const LAZY_INDEX_TITLE = 'Ленивые инструменты'
const LANG_VALUE = 'en_US.UTF-8'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the MCP server of the tests -----------------------------------------------------------------------------

/**
 * A stdio MCP server in plain Node. Arguments: the data directory and the number of filler tools. It appends its
 * environment to launches.jsonl at every start and every tools/call to calls.jsonl; `wipe` (destructiveHint)
 * leaves wiped.txt, `crash` ends the process without an answer.
 */
const FIXTURE_SERVER = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
const filler = Number(process.argv[3] || '0')
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ env: process.env, argv: process.argv.slice(2) }) + '\\n')

const tools = [
  {
    name: 'echo',
    description: 'Echoes the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'wipe',
    description: 'Wipes the data of the test server.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'crash',
    description: 'Exits the server process without answering.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
]
for (let i = 0; i < filler; i += 1) {
  const properties = {}
  for (let k = 0; k < 8; k += 1) properties['arg' + k] = { type: 'string', description: 'x'.repeat(80) }
  tools.push({
    name: 'filler_' + i,
    description: 'Filler tool number ' + i + '. ' + 'It does nothing useful. '.repeat(20),
    inputSchema: { type: 'object', properties },
    annotations: { readOnlyHint: true, destructiveHint: false },
  })
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const text = (value) => ({ content: [{ type: 'text', text: value }] })

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
    if (params.name === 'echo') {
      send({ id, result: text('ECHO:' + ((params.arguments || {}).text || '')) })
    } else if (params.name === 'wipe') {
      writeFileSync(join(dir, 'wiped.txt'), 'wiped')
      send({ id, result: text('WIPED-OK') })
    } else if (params.name === 'crash') {
      process.exit(3)
    } else {
      send({ id, error: { code: -32602, message: 'unknown tool ' + params.name } })
    }
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

/** Names of the tools a request declares, sorted. */
function toolNames(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools.map(asObject) : []
  return tools.map((tool) => (typeof tool.name === 'string' ? tool.name : '')).sort()
}

/** The tool schemas of a request, as the bytes that sit in the cached prefix. */
function toolBytes(body: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(body.tools ?? []), 'utf8')
}

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

function lastResultText(call: DsEvent): string {
  return lastResults(call.body)
    .map((block) => block.text)
    .join('\n')
}

// --- the scripted model --------------------------------------------------------------------------

type Action = { kind: 'tool'; name: string; input: JsonObject } | { kind: 'text'; text: string }

interface Stub {
  server: Server
  origin: string
  /** Tool calls of a turn of main, by marker; after the last one the model answers `fin <marker>`. */
  scripts: Map<string, Action[]>
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
      if (body.stream === false) {
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
      const action = script[turnStep(body, found.at)]
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
}

let scratch: string
let serverFile: string
let world: World

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
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    // ambient names that are no secrets by their look: a server must not get them either
    AMBIENT_CANARY_NOTE: 'canary-value-of-the-daemon',
    OWNER_PRIVATE_NOTE: 'private-value-of-the-daemon',
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
async function stopDaemon(d: Daemon): Promise<void> {
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 15_000)
  await d.exit
  clearTimeout(timer)
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

/** A guest turn is subject to the real 3 second pace of the daemon: the harness waits it out. */
const guestTurn = async (d: Daemon, marker: string): Promise<DsEvent[]> => {
  await sleep(3_200)
  return turnAs(d, GUEST_CHAT, marker)
}

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

// --- the MCP files of the tests --------------------------------------------------------------------------

/** mcp.json of the owner in the format of Claude Code; returns its text. */
function writeMcpJson(options: { filler?: number; servers?: Record<string, unknown> } = {}): string {
  const text = `${JSON.stringify(
    {
      mcpServers: {
        ...(options.servers ?? {}),
        [SERVER]: {
          command: process.execPath,
          args: [serverFile, world.dataDir, String(options.filler ?? 0)],
          env: { TESTSRV_FLAG: 'on' },
        },
      },
    },
    null,
    2,
  )}\n`
  writeFileSync(join(world.dshbotHome, 'mcp.json'), text)
  return text
}

function jsonLines(file: string): JsonObject[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseObject(line))
}

const launches = (): JsonObject[] => jsonLines(join(world.dataDir, 'launches.jsonl'))
const serverCalls = (): JsonObject[] => jsonLines(join(world.dataDir, 'calls.jsonl'))
const wiped = (): boolean => existsSync(join(world.dataDir, 'wiped.txt'))

/** The daemon connects the servers of mcp.json at start: wait for the first launch, then for the tool list. */
async function waitServerUp(d: Daemon): Promise<void> {
  await waitFor('the MCP server of mcp.json to be launched', () => launches().length > 0, d)
  await sleep(1_500)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-mcp-')))
  const dir = join(scratch, 'fixture')
  mkdirSync(dir, { recursive: true })
  serverFile = join(dir, 'server.mjs')
  writeFileSync(serverFile, FIXTURE_SERVER)
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
  world = { timeline, tg, stub, home: mkdtempSync(join(scratch, 'home-')), dshbotHome, dataDir, daemons: [] }
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

// --- [connect] -------------------------------------------------------------------------------------------

test('test_connect_owner_calls_a_tool_of_the_stdio_server_and_a_guest_request_carries_no_tools_at_all', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  world.stub.scripts.set('turn-co-1', [search(ECHO), call(ECHO, { text: 'PING-7' })])
  world.stub.scripts.set('turn-co-2', [call(ECHO, { text: 'GUEST-FORGED' })])
  const d = await startOwnerDaemon()
  await waitServerUp(d)

  const calls = await ownerTurn(d, 'turn-co-1')
  const enabled = calls.find((c) => toolNames(c.body).includes(ECHO))
  expect(enabled, `after tool_search the tool ${ECHO} is among the tools of the next request`).toBeDefined()
  const last = calls[calls.length - 1] as DsEvent
  const results = lastResults(last.body)
  expect(results, 'the model got the result of the MCP call').toHaveLength(1)
  expect((results[0] as Block).isError, (results[0] as Block).text).toBe(false)
  expect((results[0] as Block).text, 'the result is the answer of the server').toContain('ECHO:PING-7')
  expect(serverCalls().map((c) => c.name), 'the server got the call once').toEqual(['echo'])
  expect(cardsIn(world.timeline, OWNER_CHAT), 'a read-only tool needs no confirmation').toEqual([])

  // a guest: only the three guest tools, no MCP and no index of lazy tools
  await admitGuest(d)
  const guestCalls = await guestTurn(d, 'turn-co-2')
  for (const guestCall of guestCalls) {
    expect(toolNames(guestCall.body), 'the request of a guest turn declares only its three tools').toEqual([
      'exec',
      'web_fetch',
      'web_search',
    ])
    const system = systemTextOf(guestCall.body)
    expect(system, 'the guest gets no index of lazy tools').not.toContain(LAZY_INDEX_TITLE)
    expect(system).not.toContain('mcp__')
  }
  const forged = lastResults((guestCalls[guestCalls.length - 1] as DsEvent).body)
  for (const result of forged) expect(result.text, 'a forged call of the guest runs nothing').not.toContain('ECHO:GUEST-FORGED')
  expect(serverCalls().map((c) => c.name), 'the forged call of the guest did not reach the server').toEqual(['echo'])
})

// --- [env] -----------------------------------------------------------------------------------------------

test('test_env_stdio_server_gets_path_home_lang_and_its_own_env_but_no_key_of_the_bot', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  world.stub.scripts.set('turn-ev-1', [search(ECHO), call(ECHO, { text: 'ENV' })])
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  await ownerTurn(d, 'turn-ev-1')

  const started = launches()
  expect(started.length, 'the server was launched at least once').toBeGreaterThan(0)
  // the SDK of the client adds its own defaults for the user; nothing of the daemon beyond PATH, HOME, LANG
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'TESTSRV_FLAG', 'LOGNAME', 'SHELL', 'TERM', 'USER'])
  for (const launch of started) {
    const env = asObject(launch.env)
    const keys = Object.keys(env)
    expect(keys.filter((key) => !allowed.has(key)), 'only PATH, HOME, LANG and the env of mcp.json reach the server').toEqual([])
    expect(env.TESTSRV_FLAG, 'the env of the server from mcp.json').toBe('on')
    expect(typeof env.PATH, 'PATH is passed').toBe('string')
    expect(typeof env.HOME, 'HOME is passed').toBe('string')
    expect(env.LANG, 'LANG is passed').toBe(LANG_VALUE)
    expect(keys, 'no key of the bot').not.toContain('DEEPSEEK_API_KEY')
    expect(keys).not.toContain('TELEGRAM_BOT_TOKEN')
    const everything = JSON.stringify(env)
    expect(everything, 'the DeepSeek key is nowhere in the environment').not.toContain(DEEPSEEK_KEY)
    expect(everything, 'the Telegram token is nowhere in the environment').not.toContain(BOT_TOKEN.split(':')[1] as string)
  }
})

// --- [config] --------------------------------------------------------------------------------------------

test('test_config_servers_come_from_mcp_json_of_the_owner_only_and_edit_refuses_to_write_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const original = writeMcpJson()
  // the same server in every other place a client could look: none of them is read
  const shadowDir = mkdtempSync(join(scratch, 'shadow-'))
  const shadow = {
    mcpServers: { shadow: { command: process.execPath, args: [serverFile, shadowDir, '0'] } },
  }
  mkdirSync(join(world.dshbotHome, 'workspace'), { recursive: true })
  for (const file of [
    join(world.dshbotHome, 'workspace', '.mcp.json'),
    join(world.dshbotHome, 'workspace', 'mcp.json'),
    join(world.home, '.mcp.json'),
    join(world.home, '.claude.json'),
  ]) {
    writeFileSync(file, JSON.stringify(shadow))
  }
  const mcpPath = join(world.dshbotHome, 'mcp.json')
  const link = join(world.dshbotHome, 'workspace', 'mcp-link.json')
  symlinkSync(mcpPath, link)

  world.stub.scripts.set('turn-cf-1', [
    search(ECHO),
    search('mcp__shadow__echo'),
    call('edit', { path: mcpPath, old_string: SERVER, new_string: 'evil' }),
    call('edit', { path: link, old_string: SERVER, new_string: 'evil' }),
    call('edit', { path: mcpPath, content: '{"mcpServers":{}}' }),
  ])
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  const calls = await ownerTurn(d, 'turn-cf-1')
  expect(calls.length, 'the turn went through every scripted call').toBeGreaterThanOrEqual(6)

  expect(lastResultText(calls[1] as DsEvent), 'the server of mcp.json is found').toContain(ECHO)
  expect(lastResultText(calls[2] as DsEvent), 'a server from any other file is not there').not.toMatch(/Подключены/)
  for (const at of [3, 4, 5]) {
    const results = lastResults((calls[at] as DsEvent).body)
    expect(results, `edit attempt ${at - 2} got a result`).toHaveLength(1)
    expect((results[0] as Block).isError, `edit attempt ${at - 2} is refused: ${(results[0] as Block).text}`).toBe(true)
  }
  expect(readFileSync(mcpPath, 'utf8'), 'mcp.json of the owner is untouched').toBe(original)
  expect(existsSync(join(shadowDir, 'launches.jsonl')), 'a server from another file was never started').toBe(false)
  for (const c of calls) expect(toolNames(c.body).filter((name) => name.startsWith('mcp__shadow__'))).toEqual([])
})

// --- [lazy] ----------------------------------------------------------------------------------------------

test('test_lazy_tool_schemas_of_main_do_not_grow_with_the_tools_of_the_server', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson({ filler: 0 })
  const small = await startOwnerDaemon()
  await waitServerUp(small)
  const smallCalls = await ownerTurn(small, 'turn-lz-1')
  const smallFirst = (smallCalls[0] as DsEvent).body
  expect(toolNames(smallFirst).filter((name) => name.startsWith('mcp__')), 'no schema of an MCP tool in the first request').toEqual([])
  await stopDaemon(small)

  // 3 tools of the server become 43, with long descriptions and wide schemas
  world.stub.scripts.set('turn-lz-2', [search('mcp__testsrv__filler_39')])
  writeMcpJson({ filler: 40 })
  const before = launches().length
  const large = await startDaemon()
  await waitFor('the larger server to be launched', () => launches().length > before, large)
  await sleep(1_500)
  const largeCalls = await ownerTurn(large, 'turn-lz-2')
  const largeFirst = (largeCalls[0] as DsEvent).body
  expect(toolNames(largeFirst).filter((name) => name.startsWith('mcp__')), 'no schema of an MCP tool in the first request').toEqual([])

  expect(toolNames(largeFirst), 'the same tools are declared however many the server has').toEqual(toolNames(smallFirst))
  expect(toolBytes(largeFirst), 'the schemas weigh the same however many tools the server has').toBe(toolBytes(smallFirst))

  // the tools are not lost: the lazy mechanism enables one of them on request
  const enabled = largeCalls.find((c) => toolNames(c.body).includes('mcp__testsrv__filler_39'))
  expect(enabled, 'tool_search enables a tool of the server').toBeDefined()
  expect(toolNames((enabled as DsEvent).body).filter((name) => name.startsWith('mcp__')), 'only the asked tool is added').toEqual([
    'mcp__testsrv__filler_39',
  ])
})

// --- [destructive] ---------------------------------------------------------------------------------------

test('test_destructive_owner_gets_a_card_and_the_tool_does_not_run_until_the_button_allows_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  world.stub.scripts.set('turn-de-1', [search(WIPE), call(WIPE)])
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  say(OWNER_CHAT, 'turn-de-1 сотри данные')
  await waitFor('the confirmation card for the owner', () => cardsIn(world.timeline, OWNER_CHAT).length > 0, d, TURN_WAIT_MS)
  const card = cardsIn(world.timeline, OWNER_CHAT)[0] as Card
  expect(card.text, 'the card names the tool').toMatch(/wipe/)

  // nobody said yes: the tool does not run and the model has no result
  await sleep(2_000)
  expect(wiped(), 'the destructive tool did not run before the answer of the owner').toBe(false)
  expect(serverCalls(), 'the server never got the call').toEqual([])
  expect(replyEvent(OWNER_CHAT, 'turn-de-1'), 'the turn is still waiting').toBeUndefined()
  const waiting = turnCalls('turn-de-1')
  expect(lastResultText(waiting[waiting.length - 1] as DsEvent), 'the model has no result of the wipe yet').not.toContain('WIPED-OK')

  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
  await waitFor('the reply after the owner allowed it', () => replyEvent(OWNER_CHAT, 'turn-de-1') !== undefined, d, TURN_WAIT_MS)
  expect(wiped(), 'the tool ran after the yes').toBe(true)
  const calls = turnCalls('turn-de-1')
  const results = lastResults((calls[calls.length - 1] as DsEvent).body)
  expect((results[0] as Block).isError, (results[0] as Block).text).toBe(false)
  expect((results[0] as Block).text).toContain('WIPED-OK')
})

test('test_destructive_owner_denies_the_card_and_the_tool_never_runs', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  world.stub.scripts.set('turn-dn-1', [search(WIPE), call(WIPE)])
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  say(OWNER_CHAT, 'turn-dn-1 сотри данные')
  await waitFor('the confirmation card for the owner', () => cardsIn(world.timeline, OWNER_CHAT).length > 0, d, TURN_WAIT_MS)
  const card = cardsIn(world.timeline, OWNER_CHAT)[0] as Card
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))
  await waitFor('the reply after the owner refused it', () => replyEvent(OWNER_CHAT, 'turn-dn-1') !== undefined, d, TURN_WAIT_MS)

  expect(wiped(), 'a refused destructive tool did not run').toBe(false)
  expect(serverCalls(), 'the server never got the call').toEqual([])
  const calls = turnCalls('turn-dn-1')
  const results = lastResults((calls[calls.length - 1] as DsEvent).body)
  expect(results, 'the model got an answer to the call').toHaveLength(1)
  expect((results[0] as Block).isError, 'the refusal is an error result').toBe(true)
  expect((results[0] as Block).text).not.toContain('WIPED-OK')
})

test('test_destructive_planned_turn_is_refused_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  world.stub.scripts.set('turn-dp-1', [search(WIPE), call(WIPE)])
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  // /goal runs its turns on its own: nobody is in the chat to press a button
  say(OWNER_CHAT, '/goal turn-dp-1 сотри данные сервера')
  await waitFor('the model to get the result of the wipe call', () => turnCalls('turn-dp-1').length >= 3, d, TURN_WAIT_MS)
  const calls = turnCalls('turn-dp-1')
  const results = lastResults((calls[2] as DsEvent).body)
  expect(results, 'the model got an answer to the call').toHaveLength(1)
  expect((results[0] as Block).isError, `a destructive tool is refused in an autonomous turn: ${(results[0] as Block).text}`).toBe(true)
  expect((results[0] as Block).text).not.toContain('WIPED-OK')
  expect(wiped(), 'the tool did not run in an autonomous turn').toBe(false)
  expect(serverCalls(), 'the server never got the call').toEqual([])
  expect(cardsIn(world.timeline, OWNER_CHAT), 'no card was left for the owner').toEqual([])
})

// --- [crash] ---------------------------------------------------------------------------------------------

test('test_crash_missing_command_and_a_server_that_dies_in_work_leave_the_daemon_running', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson({ servers: { broken: { command: join(scratch, 'no-such-dir', 'mcp-server-nope'), args: [] } } })
  world.stub.scripts.set('turn-cr-1', [search(ECHO), call(ECHO, { text: 'ALIVE-1' })])
  world.stub.scripts.set('turn-cr-2', [search(CRASH), call(CRASH)])
  const d = await startOwnerDaemon()
  expect(d.exited, `the daemon started with a server whose command does not exist\n${output(d)}`).toBe(false)
  await waitServerUp(d)

  // the working server is not affected by the broken one
  const first = await ownerTurn(d, 'turn-cr-1')
  expect(lastResultText(first[first.length - 1] as DsEvent), 'the working server answers').toContain('ECHO:ALIVE-1')

  // the server dies in the middle of a call: the model gets an error it can read
  const second = await ownerTurn(d, 'turn-cr-2')
  const results = lastResults((second[second.length - 1] as DsEvent).body)
  expect(results, 'the model got an answer to the call of the dead server').toHaveLength(1)
  expect((results[0] as Block).isError, 'the call of a dead server is an error result').toBe(true)
  expect((results[0] as Block).text.trim().length, 'the error says something').toBeGreaterThan(0)
  expect((results[0] as Block).text, 'the error is a message, not a stack').not.toMatch(/\n\s+at \S+/)

  // the daemon is alive and the owner is still served
  expect(d.exited, `the daemon is still running\n${output(d)}`).toBe(false)
  const third = await ownerTurn(d, 'turn-cr-3')
  expect(third.length).toBeGreaterThan(0)
  expect(d.exited, `the daemon is still running after the next turn\n${output(d)}`).toBe(false)
})

// --- [h1] ------------------------------------------------------------------------------------------------

test('test_h1_guest_turn_declares_no_tools_and_there_is_no_guest_status', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeMcpJson()
  const d = await startOwnerDaemon()
  await waitServerUp(d)
  // control: the owner has tools in the same daemon
  const ownerCalls = await ownerTurn(d, 'turn-hg-1')
  expect(toolNames((ownerCalls[0] as DsEvent).body).length, 'the owner has tools').toBeGreaterThan(0)

  await admitGuest(d)
  const guestCalls = await guestTurn(d, 'turn-hg-2')
  for (const guestCall of guestCalls) {
    expect(toolNames(guestCall.body), 'a guest sees exactly the three guest tools').toEqual([
      'exec',
      'web_fetch',
      'web_search',
    ])
    expect(JSON.stringify(guestCall.body.tools ?? []), 'the guest schema carries no guest_status').not.toContain('guest_status')
    expect(JSON.stringify(guestCall.body), 'no guest_status anywhere in a guest request').not.toContain('guest_status')
  }
  for (const ownerCall of ownerCalls) expect(JSON.stringify(ownerCall.body)).not.toContain('guest_status')
  expect(
    (GuestRegistry.prototype as unknown as Record<string, unknown>).usedDaily,
    'GuestRegistry has nothing that was added for guest_status',
  ).toBeUndefined()
})
