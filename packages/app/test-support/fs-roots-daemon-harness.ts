// Extra file roots of the owner (DSHBOT_HOME/fs-roots.json) and the `write` tool, through the daemon.
// Same harness as fs-tools.test.ts and exec-tool.test.ts: the daemon runs as a child process against a fake
// Telegram Bot API and a local DeepSeek stub that plays the model. For an owner (or guest) message `run-tool-N`
// the stub issues one scripted tool call; when the tool is not in tools[] of the request it loads it through
// `tool_search` first (the lazy tools of an owner turn), reads the result from the next request and answers `pong`.
// Effects are checked on disk. fs-roots.json is an array of `{ "path": "<absolute dir>", "mode": "ro" | "rw" }`;
// a missing mode means ro. `write` takes path and content | content_base64, and append: true.

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

export const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export const TEST_TIMEOUT_MS = 240_000
export const WAIT_MS = 45_000
export const LONG_POLL_HOLD_MS = 20_000
export const MIB = 1024 * 1024

export const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
export const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

export const OWNER_CHAT = 7
export const GUEST_CHAT = 5550001

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type JsonObject = Record<string, unknown>

// --- timeline of everything the two fake servers saw -------------------------------------------

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
  seq: number
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

export function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}


// --- the scripted model --------------------------------------------------------------------------

/** One tool call: the tool name and its input as the model would send it. */
export interface ToolCall {
  tool: string
  input: JsonObject
  /** send the call even if the tool is not offered (a model that invents a tool_use) */
  force?: boolean
}

export interface Outcome {
  /** the tool is not among the tools[] of the model request, even after tool_search */
  missing?: string
  /** tool_search calls the stub made to load the tool */
  searches: number
  /** what the tool answered, as the next model request carried it */
  result?: { text: string; isError: boolean }
}

export interface Stub {
  server: Server
  origin: string
  calls: Map<number, ToolCall>
  outcomes: Map<number, Outcome>
}

export function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function messageStart(): string {
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

export function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

export function pongStream(): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

export function toolUseStream(id: string, name: string, input: JsonObject): string {
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

export function flatten(content: unknown): string {
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
export function toolSchemas(body: JsonObject): Map<string, { props: string[]; required: string[] }> {
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

export function toolNames(body: JsonObject): string[] {
  return [...toolSchemas(body).keys()]
}

/** The tool result carried by the last message of a model request, if there is one. */
export function lastToolResult(body: JsonObject): { id: string; text: string; isError: boolean } | undefined {
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
export function markerOf(body: JsonObject): number | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of [...messages].reverse()) {
    const message = asObject(raw)
    if (message.role !== 'user') continue
    const found = /run-tool-(\d+)/.exec(flatten(message.content))
    if (found !== null) return Number(found[1])
  }
  return undefined
}

export async function startStub(timeline: Timeline): Promise<Stub> {
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
  push(update: JsonObject): void
}

export function flushQueue(tg: FakeTelegram): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
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

export function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

export function textsSince(mark: number, chatId: number): string[] {
  return sentTo(world.timeline, chatId)
    .filter((e) => e.n > mark)
    .flatMap((e) => deepStrings(e.params))
}

/** Code-like tokens (8+ characters, not a plain lowercase word), best first. */
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

export function userTexts(body: JsonObject): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.map(asObject).filter((m) => m.role === 'user').map((m) => flatten(m.content))
}

export function callsMentioning(timeline: Timeline, needle: string): DsEvent[] {
  return timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && userTexts(e.body).some((t) => t.includes(needle)),
  )
}

// --- the daemon as a child process ------------------------------------------------------------------

export interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}

export function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}


export interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  /** the HOME of the daemon; DSHBOT_HOME lives inside it, as it does for a real install */
  home: string
  dshbotHome: string
  workspace: string
  appDir: string
  outside: string
  runtimeDir: string
  daemons: Daemon[]
  callSeq: number
}

export let scratch: string
export let world: World

export function spawnDaemon(): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
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

export function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

export async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

export async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

export function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

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
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore, d)
}

/** `chatId` says `text` and waits for the pong that answers it. */
export async function ask(d: Daemon, text: string, chatId: number): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in chat ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
}

export async function startOwnerDaemon(): Promise<Daemon> {
  const d = await startDaemon()
  await pairOwner(d)
  return d
}

export interface ToolResult {
  text: string
  isError: boolean
}

/** The model is asked to call `call` in `chatId`; waits for the pong that ends the turn. */
export async function runTool(d: Daemon, call: ToolCall, chatId = OWNER_CHAT): Promise<{ n: number; outcome: Outcome | undefined }> {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.calls.set(n, call)
  await ask(d, `run-tool-${n}`, chatId)
  return { n, outcome: world.stub.outcomes.get(n) }
}

/** One tool call of the owner turn; resolves with what the tool answered. */
export async function useTool(d: Daemon, call: ToolCall): Promise<ToolResult> {
  const { outcome } = await runTool(d, call)
  const what = `${call.tool} ${JSON.stringify(call.input).slice(0, 300)}`
  expect(outcome, `the model was not asked to run: ${what}\n${output(d)}`).toBeDefined()
  expect(outcome?.missing, `the tool must be offered to the owner: ${what}`).toBeUndefined()
  expect(outcome?.result, `no tool result reached the model for: ${what}\n${output(d)}`).toBeDefined()
  return outcome?.result as ToolResult
}

export const readIt = (path: string): ToolCall => ({ tool: 'read', input: { path } })
export const listIt = (path: string, recursive = false): ToolCall => ({ tool: 'list', input: { path, recursive } })
export const grepIt = (regex: string, path: string): ToolCall => ({ tool: 'grep', input: { regex, path } })
export const editIt = (path: string, oldString: string, newString: string): ToolCall => ({
  tool: 'edit',
  input: { path, old_string: oldString, new_string: newString },
})
export const createIt = (path: string, content: string): ToolCall => ({ tool: 'edit', input: { path, content } })
export const writeText = (path: string, content: string, append = false): ToolCall => ({
  tool: 'write',
  input: { path, content, ...(append ? { append: true } : {}) },
})
export const writeBytes = (path: string, bytes: Buffer, append = false): ToolCall => ({
  tool: 'write',
  input: { path, content_base64: bytes.toString('base64'), ...(append ? { append: true } : {}) },
})
export const runIt = (command: string): ToolCall => ({ tool: 'exec', input: { command } })

export const FAILURE_WORDS =
  /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|outside|only|protect|защищ|limit|лимит|exceed|превы/i

export const READ_ONLY_WORDS = /read-only|readonly|только\s+(?:для\s+)?чтени|режим\w*\s+ro\b|\bro\b/i

/** A refusal of the tool: flagged as an error or worded as one, with a reason, and no leak of `secret`. */
export function expectRefused(result: ToolResult, what: string, secret?: string): void {
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be a refusal\n${result.text}`).toBe(true)
  if (secret !== undefined) expect(result.text, `${what}: content must not leak`).not.toContain(secret)
}

/** The tool worked: no error flag. */
export function expectOk(result: ToolResult, what: string): void {
  expect(result.isError, `${what} must succeed: ${result.text}`).toBe(false)
}

/** The refusal of a write into a read-only root names the read-only mode. */
export function expectReadOnlyRefusal(result: ToolResult, what: string): void {
  expectRefused(result, what)
  expect(result.text, `${what}: the message must name the read-only mode`).toMatch(READ_ONLY_WORDS)
}

// --- the files of the scenarios -----------------------------------------------------------------------

export function put(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

export function slurp(path: string): string {
  return readFileSync(path, 'utf8')
}

/** A fresh directory under the scratch directory, resolved through symlinks. */
export function makeRoot(label: string): string {
  return realpathSync(mkdtempSync(join(scratch, `${label}-`)))
}

export function fsRootsFile(): string {
  return join(world.dshbotHome, 'fs-roots.json')
}

/** The owner's fs-roots.json before the daemon starts. */
export function declareRoots(entries: unknown): void {
  mkdirSync(world.dshbotHome, { recursive: true })
  writeFileSync(fsRootsFile(), JSON.stringify(entries))
}

export const q = (path: string): string => `'${path}'`

/** The invitation of the owner is redeemed by the guest chat. */
export async function admitGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation code in the owner chat', () => codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  const code = codeLike(textsSince(mark, OWNER_CHAT))[0] as string
  const greeted = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, code)
  await waitFor('the guest greeting', () => sentTo(world.timeline, GUEST_CHAT).length > greeted, d)
}

// --- harness lifecycle ----------------------------------------------------------------------------------

export function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp, so roots under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-fs-roots-test-')))
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
  const home = realpathSync(mkdtempSync(join(scratch, 'home-')))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  const world_: World = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    appDir: join(dshbotHome, 'app'),
    outside: makeRoot('outside'),
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
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
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [c1] a read-only root ------------------------------------------------------------------------------


// --- [c2] a read-write root -----------------------------------------------------------------------------


// --- [c3] the write tool --------------------------------------------------------------------------------



// --- [c4] refusals of write -----------------------------------------------------------------------------


// --- [c5] exec sees the extra roots ---------------------------------------------------------------------


// --- [c6] roots that are not accepted -------------------------------------------------------------------




// --- [c7] a guest ---------------------------------------------------------------------------------------


// --- [h1] the light prefix ------------------------------------------------------------------------------


// --- [c9] key directories and the state of the bot stay hidden ----------------------------------------------

