// Self-rewriting of the bot (DESIGN §8.3): candidate worktree, deterministic gate, owner card, adoption.
//
// The daemon runs as a child process against a fake Telegram Bot API and a local DeepSeek stub, the same
// way packages/app/exec-tool.test.ts does it. DSHBOT_HOME/app is a temporary git repository on the branch
// `live`; the bot's own code never runs from it here, only its files and history matter.
//
// The stub plays two models. For an owner message `scripted-turn-N` it answers with a script of tool calls
// (one per request; the arguments are mapped onto the property names found in the tools[] schema of the
// request), collects the result of every call and finally answers `pong`. Every other non-streaming
// request is the review of the diff by the gate: the stub approves it. Effects are checked on disk
// and in what the fake Telegram saw.
//
// The result of self_change is expected to carry the absolute path DSHBOT_HOME/candidates/<id> of the
// candidate; the id is the last path component and goes to self_submit.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { createEvolve } from '../../packages/evolve/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const TURN_MS = 120_000
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
  /** message_id the fake API gave to a sent message */
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

// --- the scripted model --------------------------------------------------------------------------

/** One tool call in logical terms; the stub maps the names onto the real input schema. */
type Call =
  | { tool: 'self_change'; description: string }
  | { tool: 'self_submit'; id: string }
  | { tool: 'read'; path: string }
  | { tool: 'edit'; path: string; old: string; replacement: string }

/** What the script knows about the candidate once self_change answered. */
interface Ctx {
  id: string
  /** DSHBOT_HOME/candidates/<id> */
  candidate: string
}

type Step = (ctx: Ctx) => Call

interface Answer {
  text: string
  isError: boolean
}

interface Turn {
  steps: Step[]
  /** tool names of the last model request of the turn */
  offered: string[]
  /** the system prompt of the last model request of the turn, as JSON */
  system?: string
  results: Answer[]
  /** the logical call could not be placed; the test is lost for this reason */
  unmapped?: string
  finished: boolean
}

interface Stub {
  server: Server
  origin: string
  turns: Map<number, Turn>
  /** requests of the review of the gate */
  reviews: JsonObject[]
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
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

function textMessage(text: string): string {
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

interface Schema {
  props: string[]
  required: string[]
}

function toolName(raw: unknown): string | undefined {
  const tool = asObject(raw)
  const fn = asObject(tool.function)
  return typeof tool.name === 'string' ? tool.name : typeof fn.name === 'string' ? fn.name : undefined
}

/** Tools the request offers: name to the property names of its input schema. */
function toolSchemas(body: JsonObject): Map<string, Schema> {
  const found = new Map<string, Schema>()
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const name = toolName(raw)
    if (name === undefined) continue
    const tool = asObject(raw)
    const schema = asObject(tool.input_schema ?? tool.parameters ?? asObject(tool.function).parameters)
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
    found.set(name, { props: Object.keys(asObject(schema.properties)), required })
  }
  return found
}

/** Names of the tools[] of a request, duplicates kept. */
function rawToolNames(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map(toolName).filter((name): name is string => name !== undefined)
}

const PATH_NAMES = ['path', 'file_path', 'filePath', 'file', 'filename']
const OLD_NAMES = ['old_string', 'oldString', 'old_text', 'oldText', 'old', 'search', 'find']
const NEW_NAMES = ['new_string', 'newString', 'new_text', 'newText', 'new', 'replace', 'replacement']
const DESCRIPTION_NAMES = ['description', 'описание', 'task', 'request', 'goal', 'summary', 'change', 'prompt', 'text']
const ID_NAMES = ['id', 'candidate_id', 'candidateId', 'candidate', 'change_id', 'changeId']

/** Builds the tool input from the logical call, or explains why the schema does not fit. */
function buildInput(call: Call, schema: Schema): JsonObject | string {
  const pick = (names: string[]): string | undefined => names.find((name) => schema.props.includes(name))
  const input: JsonObject = {}
  switch (call.tool) {
    case 'self_change': {
      const key = pick(DESCRIPTION_NAMES) ?? schema.required[0] ?? schema.props[0]
      if (key === undefined) return 'no description property in the input schema of self_change'
      input[key] = call.description
      return input
    }
    case 'self_submit': {
      const key = pick(ID_NAMES) ?? schema.required[0] ?? schema.props[0]
      if (key === undefined) return 'no id property in the input schema of self_submit'
      input[key] = call.id
      return input
    }
    case 'read': {
      const key = pick(PATH_NAMES) ?? schema.required[0]
      if (key === undefined) return 'no path property in the input schema of read'
      input[key] = call.path
      return input
    }
    case 'edit': {
      const pathKey = pick(PATH_NAMES) ?? schema.required[0]
      const oldKey = pick(OLD_NAMES)
      const newKey = pick(NEW_NAMES)
      if (pathKey === undefined || oldKey === undefined || newKey === undefined) {
        return 'no path/old/new properties in the input schema of edit'
      }
      input[pathKey] = call.path
      input[oldKey] = call.old
      input[newKey] = call.replacement
      return input
    }
  }
}

function userTexts(body: JsonObject): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.map(asObject).filter((m) => m.role === 'user').map((m) => flatten(m.content))
}

/** Results of the tool calls of one scripted turn, by call index. */
function turnResults(body: JsonObject, n: number): Answer[] {
  const found = new Map<string, Answer>()
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of messages) {
    const message = asObject(raw)
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = asObject(part)
      if (block.type !== 'tool_result') continue
      found.set(String(block.tool_use_id ?? ''), { text: flatten(block.content), isError: block.is_error === true })
    }
  }
  const results: Answer[] = []
  for (let index = 0; ; index += 1) {
    const answer = found.get(`toolu_${n}_${index}`)
    if (answer === undefined) return results
    results.push(answer)
  }
}

function turnNumber(body: JsonObject): number | undefined {
  for (const text of userTexts(body).reverse()) {
    const marker = /scripted-turn-(\d+)/.exec(text)
    if (marker) return Number(marker[1])
  }
  return undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function candidateOf(results: Answer[], candidatesDir: string): Ctx | undefined {
  const pattern = new RegExp(`${escapeRegExp(candidatesDir)}/([\\w-]+(?:\\.[\\w-]+)*)`)
  for (const result of results) {
    const match = pattern.exec(result.text)
    if (match?.[1] !== undefined) return { id: match[1], candidate: join(candidatesDir, match[1]) }
  }
  return undefined
}

/** The verdict of the reviewer, worded the way the review prompt asks for it. */
function approval(body: JsonObject): string {
  const prompt = [flatten(body.system), ...userTexts(body)].join('\n')
  const summary = 'Reviewed against the checklist: no blocking issues found.'
  if (/json/i.test(prompt)) {
    return JSON.stringify({
      verdict: 'approve',
      approved: true,
      ok: true,
      pass: true,
      passed: true,
      status: 'approve',
      decision: 'approve',
      issues: [],
      findings: [],
      blocking: [],
      summary,
      reason: summary,
      comment: summary,
    })
  }
  for (const word of ['APPROVE', 'PASS', 'OK', 'LGTM']) {
    if (new RegExp(`\\b${word}\\b`).test(prompt)) return `${word}\n\n${summary}`
  }
  return `APPROVE\n\n${summary}`
}

async function startStub(timeline: Timeline, candidatesDir: string): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', turns: new Map(), reviews: [] }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body })
      }
      const reply = (text: string): void => {
        if (body.stream !== false) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(textStream(text))
        } else {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(textMessage(text))
        }
      }
      const finish = (turn: Turn, problem?: string): void => {
        if (problem !== undefined) turn.unmapped = problem
        turn.finished = true
        reply('pong')
      }

      const n = turnNumber(body)
      const turn = n === undefined ? undefined : stub.turns.get(n)
      if (n === undefined || turn === undefined) {
        if (isModelCall && (body.stream === false || String(body.system ?? '').includes('ревьюер'))) {
          stub.reviews.push(body)
          reply(approval(body))
        } else {
          reply('pong')
        }
        return
      }

      turn.offered = rawToolNames(body)
      turn.system = JSON.stringify(body.system ?? '')
      turn.results = turnResults(body, n)
      const done = turn.results.length
      const step = turn.steps[done]
      if (step === undefined || turn.unmapped !== undefined) {
        finish(turn)
        return
      }
      // the first call is self_change itself: only later calls need the candidate it returned
      const ctx = done === 0 ? { id: '', candidate: '' } : candidateOf(turn.results, candidatesDir)
      if (ctx === undefined) {
        finish(turn, `no ${candidatesDir}/<id> path in the results of the tools: ${JSON.stringify(turn.results)}`)
        return
      }
      const call = step(ctx)
      const schema = toolSchemas(body).get(call.tool)
      if (schema === undefined) {
        finish(turn, `tool "${call.tool}" is not in tools[]: ${JSON.stringify(turn.offered)}`)
        return
      }
      const input = buildInput(call, schema)
      if (typeof input === 'string') {
        finish(turn, input)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(toolUseStream(`toolu_${n}_${done}`, call.tool, input))
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

/** The owner card of a candidate: a sent message with an Accept and a Reject button. */
interface Card {
  messageId: number
  text: string
  accept: string
  reject: string
}

function cardsIn(timeline: Timeline): Card[] {
  const cards: Card[] = []
  for (const e of sentTo(timeline, OWNER_CHAT)) {
    const rows = asObject(e.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows) || e.messageId === undefined) continue
    const buttons = rows.flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
    const accept = buttons.find((b) => typeof b.text === 'string' && /принять/i.test(b.text))
    const reject = buttons.find((b) => typeof b.text === 'string' && /отклонить/i.test(b.text))
    if (accept === undefined || reject === undefined) continue
    if (typeof accept.callback_data !== 'string' || typeof reject.callback_data !== 'string') continue
    cards.push({
      messageId: e.messageId,
      text: deepStrings(e.params).join('\n'),
      accept: accept.callback_data,
      reject: reject.callback_data,
    })
  }
  return cards
}

/** The text of the card's message as sent, without the labels of its buttons. */
function sentCardText(card: Card): string {
  const event = sentTo(world.timeline, OWNER_CHAT).find((e) => e.messageId === card.messageId)
  return typeof event?.params.text === 'string' ? event.params.text : ''
}

/** The last edit of the card's message, once the daemon made it. */
function editedCardText(card: Card): string | undefined {
  let text: string | undefined
  for (const e of world.timeline.events) {
    if (e.src !== 'tg' || e.method !== 'editMessageText' || e.params.message_id !== card.messageId) continue
    if (typeof e.params.text === 'string') text = e.params.text
  }
  return text
}

/** After a press the card keeps its explanation paragraph, and the status line comes after it. */
function expectDecidedCard(card: Card, status: RegExp, what: string): void {
  const original = sentCardText(card)
  const paragraph = original.slice(original.lastIndexOf('\n\n') + 2)
  expect(paragraph, `${what}: the card had an explanation\n${original}`).toContain('заменю свой код')
  const edited = editedCardText(card) ?? ''
  const at = edited.indexOf(paragraph)
  expect(at, `${what}: the edited card keeps the explanation\n${edited}`).toBeGreaterThanOrEqual(0)
  expect(edited.slice(at + paragraph.length), `${what}: the status line comes after the explanation\n${edited}`).toMatch(status)
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
  /** the HOME of the daemon; DSHBOT_HOME lives inside it, as it does for a real install */
  home: string
  dshbotHome: string
  /** the live repository: DSHBOT_HOME/app */
  live: string
  candidates: string
  /** a directory outside every root the bot may use */
  outside: string
  runtimeDir: string
  /** the commit the branch live starts on */
  base: string
  daemons: Daemon[]
  turnSeq: number
}

let scratch: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

interface SpawnOptions {
  /** directories put in front of PATH */
  pathFirst?: string[]
}

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: world.home, ...GIT_IDENTITY },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function spawnDaemon(options: SpawnOptions = {}): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [...(options.pathFirst ?? []), dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    ...GIT_IDENTITY,
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

async function startDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(options)
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

async function startOwnerDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const d = await startDaemon(options)
  await pairOwner(d)
  return d
}

/** Plays a script of tool calls as one owner turn and waits until the model has answered. */
async function runTurn(d: Daemon, steps: Step[]): Promise<Turn> {
  world.turnSeq += 1
  const n = world.turnSeq
  const turn: Turn = { steps, offered: [], results: [], finished: false }
  world.stub.turns.set(n, turn)
  say(OWNER_CHAT, `scripted-turn-${n}`)
  await waitFor(`the scripted turn ${n} to finish`, () => turn.finished, d, TURN_MS)
  expect(turn.unmapped, `the script could not be placed\n${output(d)}`).toBeUndefined()
  await sleep(300)
  return turn
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: a sandbox gets its own /tmp, so a decoy under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-evolve-test-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const FIXTURE_MANIFEST = `${JSON.stringify({ name: 'live-fixture', private: true, type: 'module', scripts: { test: 'node check.mjs' } }, null, 2)}\n`
const FIXTURE_LOCK = `${JSON.stringify({ name: 'live-fixture', lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`

/** The live repository: a git repo on the branch live with a passing `npm test`, protected files and a node_modules. */
function makeLive(live: string): string {
  mkdirSync(live, { recursive: true })
  put(join(live, 'package.json'), FIXTURE_MANIFEST)
  put(join(live, 'package-lock.json'), FIXTURE_LOCK)
  put(join(live, 'check.mjs'), 'process.exit(0)\n')
  put(join(live, 'CHARTER.md'), 'charter text\n')
  put(join(live, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
  put(join(live, 'packages', 'guard', 'src', 'index.ts'), 'export const guard = 1\n')
  put(join(live, 'notes.md'), 'original notes\n')
  put(join(live, '.gitignore'), 'node_modules/\n')
  put(join(live, 'node_modules', 'live-dep', 'index.js'), 'module.exports = 1\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'config', 'user.name', 'Test')
  git(live, 'config', 'user.email', 'test@example.invalid')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
  return git(live, 'rev-parse', 'HEAD')
}

beforeAll(() => {
  scratch = makeScratch()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  const candidates = join(dshbotHome, 'candidates')
  const stub = await startStub(timeline, candidates)
  const tg = await startTelegram(timeline)
  const live = join(dshbotHome, 'app')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    live,
    candidates,
    outside: mkdtempSync(join(scratch, 'outside-')),
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    base: '',
    daemons: [],
    turnSeq: 0,
  }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  world.base = makeLive(live)
  // the toolchain directory the sandbox of the gate binds read-only is looked up under the daemon HOME
  const realMise = join(homedir(), '.local', 'share', 'mise')
  if (existsSync(realMise)) symlinkSync(realMise, join(home, '.local', 'share', 'mise'))
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- script building blocks ------------------------------------------------------------------------------

const change: Step = () => ({ tool: 'self_change', description: 'tidy the notes file' })
const submit: Step = (ctx) => ({ tool: 'self_submit', id: ctx.id })
const readIn =
  (rel: string): Step =>
  (ctx) => ({ tool: 'read', path: join(ctx.candidate, rel) })
const editIn =
  (rel: string, old: string, replacement: string): Step =>
  (ctx) => ({ tool: 'edit', path: join(ctx.candidate, rel), old, replacement })

/** self_change, read and edit of one file of the candidate, then the gate (self_submit is the fourth call) */
const editAndSubmit = (rel: string, old: string, replacement: string): Step[] => [
  change,
  readIn(rel),
  editIn(rel, old, replacement),
  submit,
]
const SUBMIT_AT = 3

const NOTES_ADDED = 'added by candidate'

function candidateDir(turn: Turn): string {
  const match = /\/candidates\/([\w-]+(?:\.[\w-]+)*)/.exec(turn.results[0]?.text ?? '')
  expect(match, `self_change must return the absolute candidate path\n${JSON.stringify(turn.results[0])}`).not.toBeNull()
  return join(world.candidates, match?.[1] as string)
}

const FAILURE_WORDS = /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|read-only|outside|песочниц|declin|отклон/i

function expectRefused(answer: Answer | undefined, what: string): void {
  expect(answer, `${what}: the tool must answer`).toBeDefined()
  const result = answer as Answer
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be a refusal\n${result.text}`).toBe(true)
}

/** The gate says no: the answer of self_submit is a failure with a reason, there is no card and nothing is adopted. */
async function expectGateRejected(turn: Turn, what: string): Promise<string> {
  const answer = turn.results[SUBMIT_AT]
  expectRefused(answer, `${what}: self_submit`)
  await sleep(1500)
  expect(cardsIn(world.timeline), `${what}: the owner gets no card`).toHaveLength(0)
  expect(existsSync(join(world.dshbotHome, 'adopt.json')), `${what}: adopt.json is not written`).toBe(false)
  return (answer as Answer).text
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
}

// --- [candidate] ----------------------------------------------------------------------------------------

test('test_candidate_self_change_makes_a_worktree_of_live_and_edit_changes_the_candidate_only', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, [change, readIn('notes.md'), editIn('notes.md', 'original notes', `original notes\n${NOTES_ADDED}`)])

  expect(turn.results[0]?.isError, `self_change must succeed\n${turn.results[0]?.text}`).toBe(false)
  const candidate = candidateDir(turn)
  expect(existsSync(join(candidate, 'notes.md')), 'the candidate is a checkout of live').toBe(true)
  expect(git(world.live, 'worktree', 'list', '--porcelain'), 'the candidate is a git worktree of live').toContain(`worktree ${candidate}`)
  expect(git(candidate, 'rev-parse', 'HEAD'), 'the candidate starts from the tip of live').toBe(world.base)

  expect(turn.results[2]?.isError, `edit must succeed on the candidate\n${turn.results[2]?.text}`).toBe(false)
  expect(readFileSync(join(candidate, 'notes.md'), 'utf8'), 'edit changes the candidate').toContain(NOTES_ADDED)
  expect(readFileSync(join(world.live, 'notes.md'), 'utf8'), 'edit does not change live').toBe('original notes\n')
  expect(git(world.live, 'rev-parse', 'HEAD')).toBe(world.base)
  expect(git(world.live, 'status', '--porcelain'), 'live stays clean').toBe('')
})

// --- [oldtest] ------------------------------------------------------------------------------------------

test('test_oldtest_candidate_is_edited_by_tools_fs_at_its_absolute_path_and_live_is_not_touched', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  // an edit without a read first: the read-before-write check of tools-fs refuses it
  const turn = await runTurn(d, [
    change,
    editIn('notes.md', 'original notes', 'unread edit'),
    readIn('notes.md'),
    editIn('notes.md', 'original notes', `original notes\n${NOTES_ADDED}`),
  ])

  const candidate = candidateDir(turn)
  expectRefused(turn.results[1], 'edit of a candidate file that was not read')
  expect(turn.results[3]?.isError, `edit after read must succeed\n${turn.results[3]?.text}`).toBe(false)
  const notes = readFileSync(join(candidate, 'notes.md'), 'utf8')
  expect(notes, 'the edit after the read is applied').toContain(NOTES_ADDED)
  expect(notes, 'the refused edit is not applied').not.toContain('unread edit')
  expect(turn.offered.filter((name) => name === 'edit'), 'one edit tool, the one of tools-fs').toHaveLength(1)
  expect(turn.offered.filter((name) => name === 'read'), 'one read tool, the one of tools-fs').toHaveLength(1)
  expect(readFileSync(join(world.live, 'notes.md'), 'utf8')).toBe('original notes\n')
  expect(git(world.live, 'rev-parse', 'HEAD')).toBe(world.base)
  expect(git(world.live, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
  expect(git(world.live, 'status', '--porcelain')).toBe('')
})

// --- [h2] -----------------------------------------------------------------------------------------------

test('test_h2_edit_outside_the_roots_and_in_live_is_refused', { timeout: TEST_TIMEOUT_MS }, async () => {
  const stranger = join(world.outside, 'stranger.md')
  put(stranger, 'stranger text\n')
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, [
    change,
    () => ({ tool: 'read', path: join(world.live, 'notes.md') }),
    () => ({ tool: 'edit', path: join(world.live, 'notes.md'), old: 'original notes', replacement: 'tampered in live' }),
    () => ({ tool: 'read', path: stranger }),
    () => ({ tool: 'edit', path: stranger, old: 'stranger text', replacement: 'tampered outside' }),
  ])

  expect(turn.offered, 'self_change is offered').toContain('self_change')
  expectRefused(turn.results[2], 'edit of a file in live')
  expectRefused(turn.results[4], 'edit of a file outside the roots')
  expect(readFileSync(join(world.live, 'notes.md'), 'utf8'), 'live is not written').toBe('original notes\n')
  expect(readFileSync(stranger, 'utf8'), 'a file outside the roots is not written').toBe('stranger text\n')
  expect(git(world.live, 'status', '--porcelain')).toBe('')
})

test('test_h2_requests_offer_self_change_and_self_submit_next_to_the_fs_tools_without_duplicates', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, [])

  for (const name of ['self_change', 'self_submit', 'read', 'edit']) {
    expect(turn.offered.filter((n) => n === name), `${name} is offered exactly once in ${JSON.stringify(turn.offered)}`).toHaveLength(1)
  }
  expect(new Set(turn.offered).size, `tools are added, not replaced: no name twice in ${JSON.stringify(turn.offered)}`).toBe(
    turn.offered.length,
  )
})

// --- [h2exec] -------------------------------------------------------------------------------------------

test('test_h2exec_evolve_adds_only_self_change_and_self_submit_eagerly_self_discard_lazily_and_no_shell_of_its_own', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, [])

  const offered = turn.offered
  expect(offered.length, 'the request carries tools').toBeGreaterThan(0)
  const evolveNames = offered.filter((name) => /^self/i.test(name) || /evolve/i.test(name))
  expect([...evolveNames].sort(), 'evolve contributes exactly self_change and self_submit to tools[]').toEqual([
    'self_change',
    'self_submit',
  ])
  // self_discard is lazy for the owner: only its index line is in the prefix
  expect(offered, 'tool_search loads the lazy tools').toContain('tool_search')
  expect(turn.system ?? '', 'self_discard is in the lazy index of the prefix').toContain('\\nself_discard: ')
  const allowed = new Set(['exec', 'exec_status', 'exec_stop'])
  const shellLike = offered.filter((name) => /exec|shell|bash|terminal|(?:^|_)sh(?:$|_)/i.test(name))
  expect(
    shellLike.filter((name) => !allowed.has(name)),
    `the only shell is the sandboxed exec of the terminal tools, got ${JSON.stringify(offered)}`,
  ).toEqual([])
  expect(new Set(offered).size, 'no tool is offered twice, so there is no second exec/read/edit').toBe(offered.length)
})

// --- [protected] ----------------------------------------------------------------------------------------

test('test_protected_candidate_touching_charter_fails_the_gate_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('CHARTER.md', 'charter text', 'charter text, rewritten by the bot'))

  const candidate = candidateDir(turn)
  expect(readFileSync(join(candidate, 'CHARTER.md'), 'utf8'), 'the fixture edit reached the candidate').toContain('rewritten by the bot')
  const text = await expectGateRejected(turn, 'CHARTER.md')
  expect(text, 'the answer names the protected path').toMatch(/CHARTER\.md/)
  expect(readFileSync(join(world.live, 'CHARTER.md'), 'utf8')).toBe('charter text\n')
})

test('test_protected_candidate_touching_packages_guard_fails_the_gate_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('packages/guard/src/index.ts', 'guard = 1', 'guard = 2'))

  const candidate = candidateDir(turn)
  expect(readFileSync(join(candidate, 'packages', 'guard', 'src', 'index.ts'), 'utf8')).toContain('guard = 2')
  const text = await expectGateRejected(turn, 'packages/guard')
  expect(text, 'the answer names the protected path').toMatch(/packages\/guard/)
})

// --- [tests] --------------------------------------------------------------------------------------------

test('test_tests_candidate_with_a_failing_npm_test_fails_the_gate_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('check.mjs', 'process.exit(0)', 'process.exit(1)'))

  expect(readFileSync(join(candidateDir(turn), 'check.mjs'), 'utf8'), 'the fixture edit reached the candidate').toContain('process.exit(1)')
  await expectGateRejected(turn, 'failing npm test')
  expect(world.stub.reviews, 'a candidate that fails the tests is not sent to the review').toHaveLength(0)
})

// --- [card] ---------------------------------------------------------------------------------------------

async function passingCandidate(d: Daemon): Promise<{ turn: Turn; candidate: string; card: Card }> {
  const turn = await runTurn(d, editAndSubmit('notes.md', 'original notes', `original notes\n${NOTES_ADDED}`))
  const candidate = candidateDir(turn)
  await waitFor('the owner card with the Accept and Reject buttons', () => cardsIn(world.timeline).length > 0, d)
  return { turn, candidate, card: cardsIn(world.timeline)[0] as Card }
}

test('test_card_candidate_that_passed_the_gate_gives_buttons_and_no_adopt_json_before_the_press', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const { turn, candidate, card } = await passingCandidate(d)

  expect(turn.results[SUBMIT_AT]?.isError, `self_submit reports the passed gate as a result\n${turn.results[SUBMIT_AT]?.text}`).toBe(false)
  expect(turn.results[SUBMIT_AT]?.text.trim().length, 'self_submit returns the outcome of the gate as text').toBeGreaterThan(0)
  expect(cardsIn(world.timeline), 'one card per candidate').toHaveLength(1)
  expect(card.text, 'the card carries the diff stat').toContain('notes.md')
  expect(card.text, 'the card carries the outcome of the review').toMatch(/ревью|review/i)
  expect(world.stub.reviews.length, 'the diff went to the reviewer').toBeGreaterThan(0)
  expect(JSON.stringify(world.stub.reviews[0]), 'the review request carries the diff').toContain(NOTES_ADDED)
  expect(String(world.stub.reviews[0]?.model), 'the reviewer is the runner default flash').toContain('flash')
  expect(String(world.stub.reviews[0]?.model)).not.toContain('v4-pro')

  expect(git(candidate, 'status', '--porcelain'), 'the passed candidate is committed').toBe('')
  expect(git(candidate, 'rev-parse', 'HEAD~1'), 'the commit is on top of live').toBe(world.base)
  await sleep(1500)
  expect(existsSync(join(world.dshbotHome, 'adopt.json')), 'adopt.json waits for the press of Accept').toBe(false)
  expect(d.exited, 'the bot keeps running until the owner decides').toBe(false)
  expect(git(world.live, 'rev-parse', 'HEAD'), 'live is not switched').toBe(world.base)
})

test('test_card_accept_writes_adopt_json_with_the_candidate_sha_and_exits_with_42', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const { candidate, card } = await passingCandidate(d)
  const sha = git(candidate, 'rev-parse', 'HEAD')

  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.accept))

  await waitFor('adopt.json after Accept', () => existsSync(join(world.dshbotHome, 'adopt.json')), d)
  const adopt = asObject(JSON.parse(readFileSync(join(world.dshbotHome, 'adopt.json'), 'utf8')) as unknown)
  expect(adopt.sha, 'adopt.json carries the sha of the candidate commit').toBe(sha)
  await waitFor('the process to leave for the systemd restart', () => d.exited, d)
  expect((await d.exit).code, 'exit code 42 asks systemd for the adoption restart').toBe(42)
  expectDecidedCard(card, /Принято/, 'accept')
})

test('test_card_reject_adopts_nothing_and_the_bot_keeps_running', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const { card } = await passingCandidate(d)

  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.reject))
  await waitFor('the edit of the rejected card', () => editedCardText(card) !== undefined, d)
  expectDecidedCard(card, /Отклонено/, 'reject')
  await sleep(3000)

  expect(existsSync(join(world.dshbotHome, 'adopt.json')), 'Reject writes no adopt.json').toBe(false)
  expect(d.exited, 'Reject does not restart the bot').toBe(false)
  expect(git(world.live, 'rev-parse', 'HEAD')).toBe(world.base)
})

// --- [h1] -----------------------------------------------------------------------------------------------

const RAN_MARKER = "writeFileSync(new URL('./ran.marker', import.meta.url), 'ran')"

test('test_h1_gate_runs_npm_test_in_a_sandbox_without_the_home_and_the_runtime_dir_of_the_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  const decoyHome = join(world.home, '.config', 'dshbot', 'dshbot.env')
  const decoyRuntime = join(world.runtimeDir, 'decoy.sock')
  const leakLog = join(world.outside, 'leak.log')
  put(decoyHome, 'DEEPSEEK_API_KEY=decoy-secret\n')
  put(decoyRuntime, 'runtime-decoy\n')
  const probe = [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
    RAN_MARKER,
    'let leaked = false',
    `for (const path of ${JSON.stringify([decoyHome, decoyRuntime])}) {`,
    "  try { readFileSync(path, 'utf8'); leaked = true } catch { /* hidden by the sandbox */ }",
    '}',
    `if (leaked) appendFileSync(${JSON.stringify(leakLog)}, 'leaked')`,
    'process.exit(leaked ? 0 : 1)',
  ].join('\n')
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('check.mjs', 'process.exit(0)', probe))

  await expectGateRejected(turn, 'a test that reads the decoys')
  expect(existsSync(join(candidateDir(turn), 'ran.marker')), 'npm test did run, in the candidate').toBe(true)
  expect(existsSync(leakLog), 'the decoys in HOME and in XDG_RUNTIME_DIR were not read').toBe(false)
  expect(readFileSync(decoyHome, 'utf8')).toBe('DEEPSEEK_API_KEY=decoy-secret\n')
})

test('test_h1_gate_sandbox_keeps_the_live_node_modules_read_only', { timeout: TEST_TIMEOUT_MS }, async () => {
  const liveModules = join(world.live, 'node_modules')
  const before = listTree(liveModules)
  const probe = [
    "import { writeFileSync } from 'node:fs'",
    RAN_MARKER,
    // the candidate gets its own node_modules inside the sandbox, but the live tree
    // is not visible writable (it is only the read-only lower layer)
    `try { writeFileSync(${JSON.stringify(join(liveModules, 'pwned.txt'))}, 'x') } catch { process.exit(1) }`,
    'process.exit(0)',
  ].join('\n')
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('check.mjs', 'process.exit(0)', probe))

  await expectGateRejected(turn, 'a test that writes into node_modules')
  expect(existsSync(join(candidateDir(turn), 'ran.marker')), 'npm test did run, in the candidate').toBe(true)
  expect(existsSync(join(liveModules, 'pwned.txt')), 'nothing is written into the live node_modules').toBe(false)
  expect(listTree(liveModules), 'the live node_modules are unchanged').toEqual(before)
})

test('test_h1_gate_fails_without_a_working_sandbox_and_runs_no_tests', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fakeBin = mkdtempSync(join(scratch, 'fakebin-'))
  const fake = join(fakeBin, 'bwrap')
  writeFileSync(fake, '#!/bin/sh\necho "bwrap: simulated sandbox failure" >&2\nexit 1\n')
  chmodSync(fake, 0o755)
  const hostMarker = join(world.outside, 'tests-ran-on-the-host.txt')
  const probe = [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(hostMarker)}, 'ran')`,
    'process.exit(0)',
  ].join('\n')
  const d = await startOwnerDaemon({ pathFirst: [fakeBin] })

  const turn = await runTurn(d, editAndSubmit('check.mjs', 'process.exit(0)', probe))

  await expectGateRejected(turn, 'a broken sandbox')
  expect(existsSync(hostMarker), 'without a sandbox the tests do not run at all').toBe(false)
})

test('test_h1_candidate_changing_package_json_fails_the_gate_with_the_dependencies_reason', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('package.json', '"name": "live-fixture"', '"name": "live-fixture-renamed"'))

  expect(readFileSync(join(candidateDir(turn), 'package.json'), 'utf8'), 'the fixture edit reached the candidate').toContain('renamed')
  const text = await expectGateRejected(turn, 'package.json')
  expect(text.toLowerCase(), 'the reason is stated').toContain('зависимости меняются только через завод')
})

test('test_h1_candidate_changing_package_lock_json_fails_the_gate_with_the_dependencies_reason', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const turn = await runTurn(d, editAndSubmit('package-lock.json', '"name": "live-fixture"', '"name": "live-fixture-renamed"'))

  expect(readFileSync(join(candidateDir(turn), 'package-lock.json'), 'utf8'), 'the fixture edit reached the candidate').toContain('renamed')
  const text = await expectGateRejected(turn, 'package-lock.json')
  expect(text.toLowerCase(), 'the reason is stated').toContain('зависимости меняются только через завод')
})

// --- [upstream] -----------------------------------------------------------------------------------------

/**
 * gh double: a rebase merge replays every commit of the PR head that main lacks by ancestry, the way
 * GitHub lists the commits of a PR, so a pushed live commit that drags its ancestors along shows up in main.
 */
function installGhDouble(bin: string, maintainer: string, log: string): void {
  put(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const git = (...argv) => cp.execFileSync('git', argv, {
  cwd: ${JSON.stringify(maintainer)}, encoding: 'utf8', env: { ...process.env, ...${JSON.stringify(GIT_IDENTITY)} },
}).trim()
if (args[1] === 'list') process.stdout.write('[]')
else if (args[1] === 'create') process.stdout.write('https://github.com/test/bot/pull/1\\n')
else if (args[1] === 'merge') {
  git('fetch', '-q', 'origin')
  git('checkout', '-q', 'main')
  git('reset', '-q', '--hard', 'origin/main')
  const head = 'origin/' + args[2]
  for (const sha of git('rev-list', '--reverse', 'main..' + head).split('\\n').filter(Boolean)) {
    git('cherry-pick', '--allow-empty', '--keep-redundant-commits', sha)
  }
  git('push', '-q', 'origin', 'main')
}
`)
  chmodSync(join(bin, 'gh'), 0o755)
}

test('test_upstream_sends_only_the_own_patch_and_never_the_owner_commit_between_two_evolve_commits', { timeout: TEST_TIMEOUT_MS }, async () => {
  const live = world.live
  const origin = join(world.home, 'origin.git')
  const maintainer = join(world.home, 'maintainer')
  const bin = mkdtempSync(join(scratch, 'bin-'))
  const log = join(bin, 'gh.jsonl')
  git(world.home, 'init', '-q', '--bare', '-b', 'main', origin)
  git(live, 'remote', 'add', 'origin', origin)
  git(live, 'push', '-q', 'origin', 'live:main')
  git(world.home, 'clone', '-q', '--branch', 'main', origin, maintainer)
  put(join(maintainer, 'main-only.md'), 'independent main change\n')
  git(maintainer, 'add', 'main-only.md')
  git(maintainer, 'commit', '-q', '-m', 'Independent main change')
  git(maintainer, 'push', '-q', 'origin', 'main')
  installGhDouble(bin, maintainer, log)

  const commit = (file: string, subject: string, author?: string): string => {
    put(join(live, file), `${subject}\n`)
    git(live, 'add', file)
    git(live, 'commit', '-q', ...(author === undefined ? [] : ['--author', author]), '-m', subject, '-m', `Body of ${subject}.`)
    return git(live, 'rev-parse', 'HEAD')
  }
  commit('first-evolve.md', 'evolve: first own change')
  commit('manual.md', 'Manual maintenance by the owner', 'Owner <owner@example.invalid>')
  const second = commit('notes.md', 'evolve: second own change')

  const savedPath = process.env.PATH
  process.env.PATH = [bin, savedPath ?? ''].join(delimiter)
  try {
    const evolve = createEvolve({
      home: world.dshbotHome,
      live,
      review: { baseUrl: world.stub.origin, apiKey: DEEPSEEK_KEY },
      card: async () => undefined,
      upstream: { enabled: true, isolation: 'host' },
      log: () => undefined,
    })
    const report = await evolve.syncUpstream()
    expect(report, `both own commits are published (${report.error ?? 'no error'})`).toMatchObject({ state: 'ok', published: 2, missing: 0 })

    git(maintainer, 'fetch', '-q', 'origin')
    const mainFiles = git(maintainer, 'ls-tree', '-r', '--name-only', 'origin/main').split('\n')
    expect(mainFiles, 'positive control: the first own patch reached main').toContain('first-evolve.md')
    expect(git(maintainer, 'show', 'origin/main:notes.md'), 'positive control: the second own patch reached main').toBe('evolve: second own change')
    expect(mainFiles, 'the independent main change survives').toContain('main-only.md')
    expect(mainFiles, 'the owner commit between two evolve commits never reaches main').not.toContain('manual.md')
    expect(git(maintainer, 'log', '--format=%s', 'origin/main'), 'no owner commit in the main history').not.toContain('Manual maintenance')

    const branches = git(origin, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/evolve/').split('\n')
    expect(branches, 'one evolve branch per own commit').toHaveLength(2)
    for (const line of branches) {
      const [branch = '', tip = ''] = line.split(' ')
      expect(tip.startsWith(branch.slice('evolve/'.length)), `${branch} is named after the commit it carries`).toBe(true)
      expect(git(origin, 'rev-list', '--count', `main..${tip}^`), `${branch} carries one commit on top of main`).toBe('0')
    }
    const creates = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((args) => args[1] === 'create')
    expect(creates.map((args) => args[args.indexOf('--title') + 1]), 'the PRs are titled after the own commits').toEqual(['evolve: first own change', 'evolve: second own change'])
    expect(creates[1]?.[creates[1].indexOf('--body') + 1], 'the PR names the live commit it came from').toContain(second)

    expect(git(live, 'rev-parse', 'live'), 'live keeps its own history').toBe(second)
    expect(git(live, 'status', '--porcelain'), 'the rebuild leaves the live worktree and index untouched').toBe('')
    const pushes = git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/evolve/').split('\n').length
    expect(await evolve.syncUpstream(), 'the next sync finds nothing to send').toMatchObject({ state: 'ok', published: 0 })
    expect(git(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/evolve/').split('\n')).toHaveLength(pushes)
  } finally {
    process.env.PATH = savedPath
  }
})
