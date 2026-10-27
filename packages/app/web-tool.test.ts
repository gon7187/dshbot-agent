// The web tool of the bot: search through DeepSeek, fetch with the SSRF guard, everything the network
// returns inside a frame of untrusted data, no web tool for guests.
// Same harness as fs-tools.test.ts: the daemon runs as a child process against a fake Telegram Bot API and
// a local DeepSeek stub that plays the model (an owner message `run-tool-N` makes it call one tool).
// The daemon runs in its production configuration. Only the process environment is prepared, by a preload
// file the test writes to its scratch directory (NODE_OPTIONS=--import):
//   * the global fetch sends https://api.deepseek.com requests to a local search stub and writes down
//     the URL it was asked for, so a search that goes anywhere else is visible;
//   * the name fixture.example.test resolves to a public address and connects to 127.0.0.1, which lets a
//     fetch succeed without loosening the SSRF guard (a loopback or private literal is still refused);
//   * every socket connect to a private literal address is written down, and is refused;
//   * while a flag file exists, the random bytes and UUIDs asked for by code in packages/tools-web are
//     constant, so the test can learn the boundary of the frame and then serve a page that contains it.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

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

/** One web call in logical terms; the stub maps it onto the tool and the input schema the request offers. */
interface WebCall {
  intent: 'search' | 'fetch'
  /** the query, or the URL */
  value: string
}

interface Outcome {
  /** no web tool among the tools[] of the model request */
  missing?: string
  /** the logical arguments could not be placed onto the input schema */
  unmapped?: string
  /** the input the stub sent */
  sent?: JsonObject
  /** what the tool answered, as the next model request carried it */
  result?: { text: string; isError: boolean }
}

interface Stub {
  server: Server
  origin: string
  calls: Map<number, WebCall>
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

interface ToolSchema {
  props: string[]
  required: string[]
  properties: Record<string, JsonObject>
}

/** Tools the request offers: name to the input schema. */
function toolSchemas(body: JsonObject): Map<string, ToolSchema> {
  const found = new Map<string, ToolSchema>()
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const tool = asObject(raw)
    const fn = asObject(tool.function)
    const name = typeof tool.name === 'string' ? tool.name : typeof fn.name === 'string' ? fn.name : undefined
    if (name === undefined) continue
    const schema = asObject(tool.input_schema ?? tool.parameters ?? fn.parameters)
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
    const properties = asObject(schema.properties)
    found.set(name, {
      props: Object.keys(properties),
      required,
      properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, asObject(value)])),
    })
  }
  return found
}

function toolNames(body: JsonObject): string[] {
  return [...toolSchemas(body).keys()]
}

const isWebTool = (name: string): boolean => /web/i.test(name)

const URL_KEYS = /^(url|uri|link|href|address)$/i
const QUERY_KEYS = /^(query|queries|q|search|search_query|searchQuery|terms|text)$/i

/** Picks the web tool for the call and builds its input, or explains why the request does not fit. */
function chooseWebTool(
  call: WebCall,
  tools: Map<string, ToolSchema>,
): { name: string; input: JsonObject } | { missing: string } | { unmapped: string } {
  const web = [...tools.entries()].filter(([name]) => isWebTool(name))
  if (web.length === 0) return { missing: `no web tool in tools[]: ${JSON.stringify([...tools.keys()])}` }
  const chosen =
    web.find(([name]) => name.toLowerCase().includes(call.intent)) ??
    web.find(([name]) => name.toLowerCase() === 'web') ??
    web[0]
  if (chosen === undefined) return { missing: 'no web tool' }
  const [name, schema] = chosen
  const keys = call.intent === 'fetch' ? URL_KEYS : QUERY_KEYS
  const valueKey =
    schema.props.find((prop) => keys.test(prop)) ??
    schema.props.find((prop) => (call.intent === 'fetch' ? /url/i : /quer/i).test(prop)) ??
    schema.required[0]
  if (valueKey === undefined) return { unmapped: `no ${call.intent} property in the input schema of ${name}` }
  const input: JsonObject = {}
  input[valueKey] = schema.properties[valueKey]?.type === 'array' ? [call.value] : call.value
  // a mode selector: a property with an enum that offers the intent
  for (const prop of schema.props) {
    if (prop === valueKey) continue
    const options = (Array.isArray(schema.properties[prop]?.enum) ? (schema.properties[prop]?.enum as unknown[]) : []).filter(
      (option): option is string => typeof option === 'string',
    )
    const option =
      options.find((candidate) => candidate.toLowerCase().includes(call.intent)) ??
      (call.intent === 'fetch' ? options.find((candidate) => /read|open|get|page|url/i.test(candidate)) : undefined)
    if (option !== undefined) input[prop] = option
  }
  const unset = schema.required.find((prop) => input[prop] === undefined)
  if (unset !== undefined) return { unmapped: `required property ${unset} of ${name} is not mapped` }
  return { name, input }
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

function lastUserText(body: JsonObject): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = asObject(messages[messages.length - 1])
  return last.role === 'user' ? flatten(last.content) : ''
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', calls: new Map(), outcomes: new Map() }
  const pending = new Map<string, number>()
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
      if (result !== undefined) {
        const n = pending.get(result.id)
        if (n !== undefined) {
          const outcome = stub.outcomes.get(n)
          if (outcome !== undefined) outcome.result = { text: result.text, isError: result.isError }
        }
        res.end(pongStream())
        return
      }

      const marker = /run-tool-(\d+)/.exec(lastUserText(body))
      const n = marker === null ? undefined : Number(marker[1])
      const call = n === undefined ? undefined : stub.calls.get(n)
      // every scripted call is issued once, however often the same user message comes back
      if (n === undefined || call === undefined || stub.outcomes.has(n)) {
        res.end(pongStream())
        return
      }
      const outcome: Outcome = {}
      stub.outcomes.set(n, outcome)
      const chosen = chooseWebTool(call, toolSchemas(body))
      if ('missing' in chosen) {
        outcome.missing = chosen.missing
        res.end(pongStream())
        return
      }
      if ('unmapped' in chosen) {
        outcome.unmapped = chosen.unmapped
        res.end(pongStream())
        return
      }
      const input = chosen.input
      outcome.sent = input
      const id = `toolu_${n}`
      pending.set(id, n)
      res.end(toolUseStream(id, chosen.name, input))
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

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

function textsSince(mark: number, chatId: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
}

/** Code-like tokens (8+ characters, not a plain lowercase word), best first. */
function codeLike(texts: string[]): string[] {
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

function userTexts(body: JsonObject): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.map(asObject).filter((m) => m.role === 'user').map((m) => flatten(m.content))
}

function callsMentioning(timeline: Timeline, needle: string): DsEvent[] {
  return timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && userTexts(e.body).some((t) => t.includes(needle)),
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

/** A local HTTP server that counts what reaches it. */
interface Probe {
  server: Server
  origin: string
  port: number
  connections: number
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>
}

interface Page {
  contentType: string
  body: string
}

interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  home: string
  dshbotHome: string
  workspace: string
  appDir: string
  /** the page the fixture host serves; the fixture is the target of the fetches that must succeed */
  fixture: Probe
  page: Page
  /** answers the search requests that the preload redirects from api.deepseek.com */
  search: Probe
  searchResponse: JsonObject
  /** where DEEPSEEK_SEARCH_BASE_URL points: it must stay unused */
  stranger: Probe
  /** where the proxy variables point: it must stay unused */
  proxy: Probe
  logFile: string
  rngFlag: string
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
    NODE_OPTIONS: `--import=${pathToFileURL(preloadFile).href}`,
    WEBTEST_FIXTURE_HOST: FIXTURE_HOST,
    WEBTEST_SEARCH_STUB: world.search.origin,
    WEBTEST_LOG: world.logFile,
    WEBTEST_RNG_FLAG: world.rngFlag,
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

/** `chatId` says `text` and waits for the pong that answers it. */
async function ask(d: Daemon, text: string, chatId: number): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in chat ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
}

// --- the preload: the environment of the production daemon, nothing of the daemon itself ---------------

/** A name that resolves (in the preload only) to a public address and connects to 127.0.0.1. */
const FIXTURE_HOST = 'fixture.example.test'

const PRELOAD_SOURCE = String.raw`
import { appendFileSync, existsSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const net = require('node:net')
const dns = require('node:dns')
const crypto = require('node:crypto')

const FIXTURE_HOST = process.env.WEBTEST_FIXTURE_HOST
const SEARCH_STUB = process.env.WEBTEST_SEARCH_STUB
const LOG = process.env.WEBTEST_LOG
const RNG_FLAG = process.env.WEBTEST_RNG_FLAG
const PUBLIC_ADDRESS = '93.184.216.34'
const PRIVATE_TARGETS = ['10.0.0.1', '169.254.169.254']

const note = (kind, data) => appendFileSync(LOG, JSON.stringify({ kind, ...data }) + '\n')
const parseUrl = (value) => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

// connects: written down, the fixture name goes to loopback, private literals are refused
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function patchedConnect(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (options && typeof options === 'object' && typeof options.host === 'string') {
    note('connect', { host: options.host, port: Number(options.port) })
    if (options.host === FIXTURE_HOST) {
      options.host = '127.0.0.1'
      delete options.lookup
    } else if (PRIVATE_TARGETS.includes(options.host)) {
      queueMicrotask(() => this.destroy(Object.assign(new Error('refused by the test'), { code: 'ECONNREFUSED' })))
      return this
    }
  }
  return originalConnect.apply(this, args)
}

// name resolution: only the fixture name is special
const originalLookup = dns.promises.lookup
dns.promises.lookup = async function patchedLookup(hostname, ...rest) {
  if (hostname === FIXTURE_HOST) return [{ address: PUBLIC_ADDRESS, family: 4 }]
  return originalLookup.call(this, hostname, ...rest)
}

// the global fetch: whatever goes to api.deepseek.com is answered by the search stub
const realFetch = globalThis.fetch
globalThis.fetch = function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers = new Headers(init && init.headers ? init.headers : undefined)
  const target = parseUrl(url)
  if (target === undefined) return realFetch(input, init)
  note('fetch', {
    url,
    hostname: target.hostname,
    auth: (headers.get('x-api-key') || '') + ' ' + (headers.get('authorization') || ''),
  })
  if (target.hostname === 'api.deepseek.com') {
    return realFetch(SEARCH_STUB + target.pathname + target.search, init)
  }
  return realFetch(input, init)
}

// randomness asked for by packages/tools-web is constant while the flag file exists
const FIXED_BYTE = 0x5a
const FIXED_UUID = '5a5a5a5a-5a5a-4a5a-9a5a-5a5a5a5a5a5a'
function fixedForTools() {
  if (!existsSync(RNG_FLAG)) return false
  const frames = String(new Error().stack).split('\n').slice(1)
  const caller = frames.find((line) => !line.includes('webtest-preload') && !line.includes('node:internal'))
  return caller !== undefined && caller.includes('/packages/tools-web/')
}
const randomBytes = crypto.randomBytes
crypto.randomBytes = function patchedRandomBytes(size, callback) {
  if (!fixedForTools()) return randomBytes.apply(this, arguments)
  const bytes = Buffer.alloc(size, FIXED_BYTE)
  if (typeof callback !== 'function') return bytes
  queueMicrotask(() => callback(null, bytes))
}
const randomUUID = crypto.randomUUID
crypto.randomUUID = function patchedRandomUUID() {
  return fixedForTools() ? FIXED_UUID : randomUUID.apply(this, arguments)
}
const randomInt = crypto.randomInt
crypto.randomInt = function patchedRandomInt(...args) {
  if (!fixedForTools()) return randomInt.apply(this, args)
  return typeof args[1] === 'number' ? args[0] : 0
}
const randomFillSync = crypto.randomFillSync
crypto.randomFillSync = function patchedRandomFillSync(buffer, ...rest) {
  if (!fixedForTools()) return randomFillSync.call(this, buffer, ...rest)
  new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength).fill(FIXED_BYTE)
  return buffer
}
const webCrypto = Object.getPrototypeOf(globalThis.crypto)
const getRandomValues = webCrypto.getRandomValues
webCrypto.getRandomValues = function patchedGetRandomValues(array) {
  if (!fixedForTools()) return getRandomValues.call(this, array)
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(FIXED_BYTE)
  return array
}
const webRandomUUID = webCrypto.randomUUID
webCrypto.randomUUID = function patchedWebRandomUUID() {
  return fixedForTools() ? FIXED_UUID : webRandomUUID.call(this)
}

syncBuiltinESMExports()
`

let preloadFile: string

// --- local servers --------------------------------------------------------------------------------------

async function startProbe(answer: (req: IncomingMessage, res: ServerResponse, probe: Probe) => void): Promise<Probe> {
  const probe: Probe = { server: undefined as unknown as Server, origin: '', port: 0, connections: 0, requests: [] }
  probe.server = createServer((req, res) => {
    void readBody(req).then((body) => {
      probe.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      answer(req, res, probe)
    })
  })
  probe.server.on('connection', () => {
    probe.connections += 1
  })
  probe.server.on('connect', (_req, socket) => {
    probe.connections += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => probe.server.listen(0, '127.0.0.1', resolve))
  probe.port = (probe.server.address() as AddressInfo).port
  probe.origin = `http://127.0.0.1:${probe.port}`
  return probe
}

// --- what the network returns ----------------------------------------------------------------------------------

const PAGE_MARKER = 'pagebodymarker4417'
const SEARCH_MARKER = 'searchmarker9051'
const INJECTED = 'INJECTED-INSTRUCTION-AFTER-THE-FRAME'

const htmlPage = (body: string): Page => ({
  contentType: 'text/html; charset=utf-8',
  body: `<html><head><title>Fixture</title></head><body><h1>Heading</h1><p>${body}</p></body></html>`,
})

const searchAnswer = (text: string): JsonObject => ({
  id: 'msg_search',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-v4-flash',
  stop_reason: 'end_turn',
  usage: { input_tokens: 5, output_tokens: 5 },
  content: [
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          url: `https://found.example/${SEARCH_MARKER}`,
          title: `${SEARCH_MARKER} title`,
          page_age: '1 day ago',
        },
      ],
    },
    {
      type: 'text',
      text: 'summary',
      citations: [{ type: 'web_search_result_location', url: `https://found.example/${SEARCH_MARKER}`, cited_text: text }],
    },
  ],
})

const fetchCall = (value: string): WebCall => ({ intent: 'fetch', value })
const searchCall = (value: string): WebCall => ({ intent: 'search', value })

const fixtureUrl = (path = '/page'): string => `http://${FIXTURE_HOST}:${world.fixture.port}${path}`

interface Logged {
  kind: string
  [key: string]: unknown
}

/** The entries the preload wrote down, in order. */
function logged(kind: string): Logged[] {
  if (!existsSync(world.logFile)) return []
  return readFileSync(world.logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => parseObject(line) as Logged)
    .filter((entry) => entry.kind === kind)
}

// --- frame helpers ------------------------------------------------------------------------------------------------

/** Maximal alphanumeric runs of 6+ characters: the shape of a random boundary or of one part of it. */
const tokensOf = (text: string): string[] => text.match(/[A-Za-z0-9]{6,}/g) ?? []

function countOf(text: string, token: string): number {
  return text.split(token).length - 1
}

/** Tokens that occur at least twice in `text` (an opening and a closing mention) and never in `other`. */
function boundaryTokens(text: string, other: string): string[] {
  const elsewhere = new Set(tokensOf(other))
  return [...new Set(tokensOf(text))].filter((token) => !elsewhere.has(token) && countOf(text, token) >= 2)
}

type ToolAnswer = { text: string; isError: boolean }

/** The model calls `call` as the owner's turn; resolves with what the tool answered. */
async function useTool(d: Daemon, call: WebCall): Promise<ToolAnswer> {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.calls.set(n, call)
  await ask(d, `run-tool-${n}`, OWNER_CHAT)
  const outcome = world.stub.outcomes.get(n)
  const what = `${call.intent} ${JSON.stringify(call.value)}`
  expect(outcome, `the model was not asked to run: ${what}\n${output(d)}`).toBeDefined()
  expect(outcome?.missing, `the web tool must be offered to the owner: ${what}`).toBeUndefined()
  expect(outcome?.unmapped, `the input schema must fit the task: ${what}`).toBeUndefined()
  expect(outcome?.result, `no tool result reached the model for: ${what}\nsent: ${JSON.stringify(outcome?.sent)}\n${output(d)}`).toBeDefined()
  return outcome?.result as ToolAnswer
}

const FAILURE_WORDS =
  /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|outside|only|block|public|private|заблок|ssrf/i

/** A failed tool call: flagged as an error or worded as one, with a reason, and no leak of `secret`. */
function expectFailure(result: ToolAnswer, what: string, secret: string): void {
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.text, `${what}: content must not leak`).not.toContain(secret)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be an error`).toBe(true)
}

/** Result `a` is framed by a boundary that `b` (the same call, made again) does not carry; `content` lies inside it. */
function expectFrame(a: ToolAnswer, b: ToolAnswer, content: string, what: string): void {
  expect(a.text, `${what}: the content must reach the model`).toContain(content)
  const boundaries = boundaryTokens(a.text, b.text)
  expect(boundaries.length, `${what}: a boundary that differs between two calls and is stated at least twice\n${a.text}`).toBeGreaterThan(0)
  const places: number[] = []
  for (let at = a.text.indexOf(content); at !== -1; at = a.text.indexOf(content, at + content.length)) places.push(at)
  const framed = boundaries.some((token) => {
    const first = a.text.indexOf(token)
    const last = a.text.lastIndexOf(token)
    return places.every((at) => first < at && at < last)
  })
  expect(framed, `${what}: the content must lie between the first and the last mention of the boundary\n${a.text}`).toBe(true)
}

/** Lines of a framed answer that state the boundary: the opening and closing marks. */
function frameLines(text: string, boundaries: string[]): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && boundaries.some((token) => line.includes(token)))
}

function linesEqualTo(text: string, wanted: string): number {
  return text.split('\n').filter((line) => line.trim() === wanted).length
}

// --- harness lifecycle ----------------------------------------------------------------------------------

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-web-test-')))
  preloadFile = join(scratch, 'webtest-preload.mjs')
  writeFileSync(preloadFile, PRELOAD_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const control = mkdtempSync(join(scratch, 'ctl-'))
  const world_: World = {
    timeline,
    tg,
    stub,
    home: mkdtempSync(join(scratch, 'home-')),
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    appDir: join(dshbotHome, 'app'),
    fixture: await startProbe((_req, res) => {
      res.writeHead(200, { 'content-type': world.page.contentType })
      res.end(world.page.body)
    }),
    page: htmlPage(PAGE_MARKER),
    search: await startProbe((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(world.searchResponse))
    }),
    searchResponse: searchAnswer(SEARCH_MARKER),
    stranger: await startProbe((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }),
    proxy: await startProbe((_req, res) => {
      res.writeHead(502)
      res.end()
    }),
    logFile: join(control, 'events.log'),
    rngFlag: join(control, 'rng-fixed'),
    daemons: [],
    callSeq: 0,
  }
  mkdirSync(world_.workspace, { recursive: true })
  mkdirSync(world_.appDir, { recursive: true })
  world = world_
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  for (const probe of [world.fixture, world.search, world.stranger, world.proxy]) await closeServer(probe.server)
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

async function startOwnerDaemon(extraEnv: Record<string, string> = {}): Promise<Daemon> {
  const d = await startDaemon(extraEnv)
  await pairOwner(d)
  return d
}

// --- [ssrf] ----------------------------------------------------------------------------------------------

test('test_ssrf_fetch_of_loopback_and_private_addresses_is_refused_without_a_connection', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.page = htmlPage(PAGE_MARKER)
  const d = await startOwnerDaemon()

  // the control: a public name is fetched, so the refusals below are the guard's and not a broken tool
  const control = await useTool(d, fetchCall(fixtureUrl('/control')))
  expect(control.text, 'the control fetch of a public address must deliver the page').toContain(PAGE_MARKER)
  const hitsAfterControl = world.fixture.requests.length
  const connectionsAfterControl = world.fixture.connections

  world.page = { contentType: 'text/plain', body: 'LOOPBACK-SECRET-BODY' }
  const targets = [
    `http://127.0.0.1:${world.fixture.port}/secret`,
    `http://localhost:${world.fixture.port}/secret`,
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
  ]
  for (const url of targets) {
    const result = await useTool(d, fetchCall(url))
    expectFailure(result, `fetch ${url}`, 'LOOPBACK-SECRET-BODY')
  }

  expect(world.fixture.requests.length, 'no request reached the loopback server').toBe(hitsAfterControl)
  expect(world.fixture.connections, 'no connection reached the loopback server').toBe(connectionsAfterControl)
  const connects = logged('connect')
  for (const host of ['10.0.0.1', '169.254.169.254']) {
    expect(connects.filter((entry) => entry.host === host), `no connection attempt to ${host}`).toEqual([])
  }
  const toLoopbackFixture = connects.filter((entry) => entry.host !== FIXTURE_HOST && entry.port === world.fixture.port)
  expect(toLoopbackFixture, 'no connection attempt to the loopback server by its own address').toEqual([])
})

// --- [base] ---------------------------------------------------------------------------------------------

test('test_base_search_goes_to_api_deepseek_com_and_proxy_variables_are_not_used', { timeout: TEST_TIMEOUT_MS }, async () => {
  const proxyUrl = world.proxy.origin
  const d = await startOwnerDaemon({
    DEEPSEEK_SEARCH_BASE_URL: `${world.stranger.origin}/anthropic/v1`,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
  })

  await useTool(d, searchCall('base-query-xyz'))
  const searched = logged('fetch').filter((entry) => entry.hostname !== '127.0.0.1')
  expect(searched.length, 'the search must make a request to the outside').toBeGreaterThan(0)
  for (const entry of searched) expect(entry.hostname, `search request went to ${String(entry.url)}`).toBe('api.deepseek.com')
  expect(world.search.requests.length, 'the request meant for api.deepseek.com must have been made').toBeGreaterThan(0)
  expect(
    searched.some((entry) => String(entry.auth).includes(DEEPSEEK_KEY)),
    'the search is authorized with DEEPSEEK_API_KEY',
  ).toBe(true)
  expect(world.stranger.connections, 'DEEPSEEK_SEARCH_BASE_URL is not used').toBe(0)
  expect(world.stranger.requests, 'DEEPSEEK_SEARCH_BASE_URL is not used').toEqual([])
  expect(
    callsMentioning(world.timeline, 'Perform a web search').length,
    'the search must not go to the conversation endpoint either',
  ).toBe(0)

  // a fetch: the page is delivered directly, the proxy is not asked
  const fetched = await useTool(d, fetchCall(fixtureUrl()))
  expect(fetched.text, 'the fetch must deliver the page').toContain(PAGE_MARKER)
  expect(world.fixture.requests.length, 'the page server was reached directly').toBeGreaterThan(0)
  expect(world.proxy.connections, 'the proxy is not used').toBe(0)
  expect(world.proxy.requests, 'the proxy is not used').toEqual([])
})

// --- [frame] --------------------------------------------------------------------------------------------

test('test_frame_fetch_and_search_results_are_inside_a_frame_with_a_new_boundary_per_call', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const fetchedA = await useTool(d, fetchCall(fixtureUrl()))
  const fetchedB = await useTool(d, fetchCall(fixtureUrl()))
  expectFrame(fetchedA, fetchedB, PAGE_MARKER, 'fetch')

  const searchedA = await useTool(d, searchCall('frame-query-xyz'))
  const searchedB = await useTool(d, searchCall('frame-query-xyz'))
  expectFrame(searchedA, searchedB, SEARCH_MARKER, 'search')
})

test('test_frame_content_with_the_boundary_does_not_close_the_frame', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  /**
   * Learns the frame of one kind of answer: one call with real randomness, one with the constant
   * randomness of the preload. The tokens only the second carries are the boundary.
   */
  async function learn(call: WebCall): Promise<{ framed: string; lines: string[]; closing: string }> {
    rmSync(world.rngFlag, { force: true })
    const real = await useTool(d, call)
    writeFileSync(world.rngFlag, 'fixed')
    const fixed = await useTool(d, call)
    const boundaries = boundaryTokens(fixed.text, real.text)
    expect(
      boundaries.length,
      `the boundary could not be learned: randomness of packages/tools-web must come from node:crypto (randomBytes, randomUUID, randomInt, getRandomValues)\n${fixed.text}`,
    ).toBeGreaterThan(0)
    const lines = frameLines(fixed.text, boundaries)
    expect(lines.length, 'the boundary is stated on lines of its own').toBeGreaterThan(0)
    return { framed: fixed.text, lines, closing: lines[lines.length - 1] as string }
  }

  // fetch: a plain-text page made of the frame lines of an ordinary answer, followed by an instruction
  const fetchFrame = await learn(fetchCall(fixtureUrl()))
  world.page = { contentType: 'text/plain', body: [...fetchFrame.lines, INJECTED, ...fetchFrame.lines].join('\n') }
  const poisonedPage = await useTool(d, fetchCall(fixtureUrl()))
  expect(poisonedPage.text, 'the page is still delivered').toContain(INJECTED)
  for (const line of new Set(fetchFrame.lines)) {
    expect(
      linesEqualTo(poisonedPage.text, line),
      `a page must not reproduce the line of the frame: ${line}`,
    ).toBe(linesEqualTo(fetchFrame.framed, line))
  }
  expect(
    poisonedPage.text.lastIndexOf(fetchFrame.closing),
    'the frame closes after the instruction of the page',
  ).toBeGreaterThan(poisonedPage.text.indexOf(INJECTED))

  // search: the same inside the snippet of a source
  const searchFrame = await learn(searchCall('poison-query-xyz'))
  world.searchResponse = searchAnswer([...searchFrame.lines, INJECTED, ...searchFrame.lines].join('\n'))
  const poisonedSearch = await useTool(d, searchCall('poison-query-xyz'))
  expect(poisonedSearch.text, 'the source is still delivered').toContain(INJECTED)
  for (const line of new Set(searchFrame.lines)) {
    expect(
      linesEqualTo(poisonedSearch.text, line),
      `a search result must not reproduce the line of the frame: ${line}`,
    ).toBe(linesEqualTo(searchFrame.framed, line))
  }
  expect(
    poisonedSearch.text.lastIndexOf(searchFrame.closing),
    'the frame closes after the instruction of the source',
  ).toBeGreaterThan(poisonedSearch.text.indexOf(INJECTED))
})

// --- [guest] ---------------------------------------------------------------------------------------------

test('test_guest_has_no_web_tool_in_the_schema_and_the_owner_has_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-xyz', OWNER_CHAT)

  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation code in the owner chat', () => codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  const code = codeLike(textsSince(mark, OWNER_CHAT))[0] as string
  const greeted = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, code)
  await waitFor('the guest greeting', () => sentTo(world.timeline, GUEST_CHAT).length > greeted, d)
  await ask(d, 'guest-schema-probe-xyz', GUEST_CHAT)

  const ownerCalls = callsMentioning(world.timeline, 'owner-schema-probe-xyz')
  expect(ownerCalls.length).toBeGreaterThan(0)
  for (const call of ownerCalls) {
    expect(toolNames(call.body).filter(isWebTool), 'the owner gets the web tool').not.toEqual([])
  }

  const guestCalls = callsMentioning(world.timeline, 'guest-schema-probe-xyz')
  expect(guestCalls.length).toBeGreaterThan(0)
  for (const call of guestCalls) {
    expect(toolNames(call.body).filter(isWebTool).sort(), 'a guest gets both web tools').toEqual([
      'web_fetch',
      'web_search',
    ])
  }
})
