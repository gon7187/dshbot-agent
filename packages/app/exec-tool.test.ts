// The exec tool of the bot: bwrap sandbox with an allowlist, guard verdicts with approval buttons,
// foreground timeout, background jobs, guests in a separate empty sandbox.
// Same harness as fs-tools.test.ts: the daemon runs as a child process against a fake Telegram Bot API
// and a local DeepSeek stub. The stub plays the model: for a message `run-tool-N` it answers with one
// tool call whose arguments are mapped onto the property names found in the tools[] schema of the
// request, reads the tool result from the next request and then answers `pong`. Effects are checked on
// disk. A tiny preload shifts the clock of the daemon, which is how an expired approval is produced.
//
// Accepted shapes of the schema (the stub maps the logical call onto whatever the request offers):
//   run         tool `exec`; command in command|cmd|script|shell|code; timeout in a property with
//               "timeout" in its name (milliseconds when the name ends with "ms" or the description
//               says milliseconds, otherwise seconds); background as a boolean property named
//               background|bg|detach|async|run_in_background, or an enum value background|detach|async.
//   status/stop a separate tool whose name says status|poll|output|tail|log / stop|kill|cancel|terminate,
//               or `exec` (or a job/process/task tool) with an enum value (action, mode, ...) saying so,
//               or a boolean property named like the action; the id goes to id|job_id|jobId|task_id|...

import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

// --- the scripted model --------------------------------------------------------------------------

/** One tool call in logical terms; the stub maps the names onto the real input schema. */
type ExecCall =
  | {
      kind: 'run'
      command: string
      timeoutSec?: number
      background?: boolean
      /** send the call even if the tool is not in tools[] (a model inventing a tool_use) */
      force?: boolean
    }
  | { kind: 'status'; id: string }
  | { kind: 'stop'; id: string }

interface Outcome {
  /** the tool is not among the tools[] of the model request */
  missing?: string
  /** the logical arguments could not be placed onto the input schema */
  unmapped?: string
  /** the tool name and input the stub sent */
  sent?: { name: string; input: JsonObject }
  /** what the tool answered, as the next model request carried it */
  result?: { text: string; isError: boolean }
}

interface Stub {
  server: Server
  origin: string
  calls: Map<number, ExecCall>
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

interface Schema {
  props: Record<string, JsonObject>
  required: string[]
}

/** Tools the request offers: name to the properties of its input schema. */
function toolSchemas(body: JsonObject): Map<string, Schema> {
  const found = new Map<string, Schema>()
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const tool = asObject(raw)
    const fn = asObject(tool.function)
    const name = typeof tool.name === 'string' ? tool.name : typeof fn.name === 'string' ? fn.name : undefined
    if (name === undefined) continue
    const schema = asObject(tool.input_schema ?? tool.parameters ?? fn.parameters)
    const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []
    const props: Record<string, JsonObject> = {}
    for (const [key, value] of Object.entries(asObject(schema.properties))) props[key] = asObject(value)
    found.set(name, { props, required })
  }
  return found
}

function toolNames(body: JsonObject): string[] {
  return [...toolSchemas(body).keys()]
}

const COMMAND_NAMES = ['command', 'cmd', 'script', 'shell', 'code']
const BACKGROUND_FLAGS = /^(?:background|bg|detach|detached|async|run_in_background|runInBackground)$/i
const BACKGROUND_VALUE = /^(?:background|detach|detached|async)$/i
const ID_NAMES = ['id', 'job_id', 'jobId', 'job', 'task_id', 'taskId', 'process_id', 'processId', 'handle']
const FS_TOOLS = new Set(['read', 'edit', 'list', 'grep'])

function pickKey(schema: Schema, names: readonly string[]): string | undefined {
  return names.find((name) => name in schema.props)
}

function enumValues(prop: JsonObject): string[] {
  const values: string[] = []
  if (Array.isArray(prop.enum)) values.push(...prop.enum.filter((v): v is string => typeof v === 'string'))
  if (typeof prop.const === 'string') values.push(prop.const)
  for (const key of ['oneOf', 'anyOf']) {
    const alternatives = prop[key]
    if (Array.isArray(alternatives)) for (const alt of alternatives) values.push(...enumValues(asObject(alt)))
  }
  return values
}

function buildRun(call: Extract<ExecCall, { kind: 'run' }>, schema: Schema): JsonObject | string {
  const input: JsonObject = {}
  const commandKey = pickKey(schema, COMMAND_NAMES) ?? schema.required[0]
  if (commandKey === undefined) return 'no command property in the input schema'
  input[commandKey] = call.command

  if (call.timeoutSec !== undefined) {
    const key = Object.keys(schema.props).find((name) => /timeout/i.test(name))
    if (key === undefined) return 'no timeout property in the input schema'
    const description = String(schema.props[key]?.description ?? '')
    const milliseconds = /ms$|milli/i.test(key) || /millisecond|миллисек|\bms\b/i.test(description)
    input[key] = milliseconds ? call.timeoutSec * 1000 : call.timeoutSec
  }

  const purposeKey = Object.keys(schema.props).find((name) => /^purpose$/i.test(name))
  if (purposeKey !== undefined) input[purposeKey] = 'проверяю поведение exec через карточку подтверждения'

  if (call.background === true) {
    const flag = Object.keys(schema.props).find((name) => BACKGROUND_FLAGS.test(name))
    if (flag !== undefined) {
      input[flag] = true
      return input
    }
    for (const [key, prop] of Object.entries(schema.props)) {
      const value = enumValues(prop).find((v) => BACKGROUND_VALUE.test(v))
      if (value !== undefined) {
        input[key] = value
        return input
      }
    }
    return 'no way to run in the background in the input schema'
  }
  return input
}

function jobInput(kind: 'status' | 'stop', schema: Schema, id: string, dedicated: boolean): JsonObject | undefined {
  const input: JsonObject = {}
  const valueRe = kind === 'status' ? /^(?:status|poll|check|get|output|logs?|tail|read|wait|info|show)$/i : /^(?:stop|kill|cancel|terminate|abort)$/i
  const flagRe = kind === 'status' ? /^(?:status|poll|check|tail|output|logs?)$/i : /^(?:stop|kill|cancel|terminate|abort)$/i
  let known = dedicated
  for (const [key, prop] of Object.entries(schema.props)) {
    const value = enumValues(prop).find((v) => valueRe.test(v))
    if (value !== undefined) {
      input[key] = value
      known = true
    }
  }
  if (!known) {
    const flag = Object.keys(schema.props).find((name) => flagRe.test(name))
    if (flag === undefined) return undefined
    if (schema.props[flag]?.type === 'boolean') {
      input[flag] = true
    } else {
      input[flag] = id
      return input
    }
  }
  const idKey = pickKey(schema, ID_NAMES) ?? schema.required.find((name) => !(name in input))
  if (idKey === undefined) return undefined
  input[idKey] = id
  return input
}

function placeJob(kind: 'status' | 'stop', id: string, schemas: Map<string, Schema>): { name: string; input: JsonObject } | string {
  const nameRe = kind === 'status' ? /status|poll|output|tail|logs?/i : /stop|kill|cancel|terminate|abort/i
  const others = [...schemas.keys()].filter((name) => !FS_TOOLS.has(name))
  const dedicated = others.filter((name) => name !== 'exec' && nameRe.test(name))
  const multi = ['exec', ...others.filter((name) => name !== 'exec' && !dedicated.includes(name) && /job|process|task|exec|bash|shell/i.test(name))]
  for (const name of dedicated) {
    const input = jobInput(kind, schemas.get(name) as Schema, id, true)
    if (input !== undefined) return { name, input }
  }
  for (const name of multi) {
    const schema = schemas.get(name)
    if (schema === undefined) continue
    const input = jobInput(kind, schema, id, false)
    if (input !== undefined) return { name, input }
  }
  return `no way to ${kind} a job in tools[]: ${JSON.stringify([...schemas.keys()])}`
}

function placeCall(call: ExecCall, schemas: Map<string, Schema>): { name: string; input: JsonObject } | { missing: string } | string {
  if (call.kind === 'run') {
    const schema = schemas.get('exec')
    if (schema === undefined) {
      if (call.force === true) return { name: 'exec', input: { command: call.command } }
      return { missing: `tool "exec" is not in tools[]: ${JSON.stringify([...schemas.keys()])}` }
    }
    const input = buildRun(call, schema)
    return typeof input === 'string' ? input : { name: 'exec', input }
  }
  return placeJob(call.kind, call.id, schemas)
}

/** The request offers tool_search and its system prompt lists `name` in the lazy index. */
function offersLazy(body: JsonObject, name: string): boolean {
  return toolSchemas(body).has('tool_search') && JSON.stringify(body.system ?? '').includes(`\\n${name}: `)
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
  /** tool_search calls of the stub, by tool_use id, to the scripted call they load a job tool for */
  const searching = new Map<string, number>()
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
      // exec_status and exec_stop are lazy for the owner: the stub loads the
      // tool with tool_search first and places the call in the next request
      const searchedFor = result === undefined ? undefined : searching.get(result.id)
      if (searchedFor !== undefined) {
        searching.delete((result as { id: string }).id)
        place(searchedFor, stub.calls.get(searchedFor) as ExecCall, stub.outcomes.get(searchedFor) as Outcome, body)
        return
      }
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
      const lazyName = call.kind === 'status' ? 'exec_status' : call.kind === 'stop' ? 'exec_stop' : undefined
      if (lazyName !== undefined && !toolSchemas(body).has(lazyName) && offersLazy(body, lazyName)) {
        const id = `toolu_search_${n}`
        searching.set(id, n)
        res.end(toolUseStream(id, 'tool_search', { query: lazyName }))
        return
      }
      place(n, call, outcome, body)
    })
    function place(n: number, call: ExecCall, outcome: Outcome, body: JsonObject): void {
      const placed = placeCall(call, toolSchemas(body))
      if (typeof placed === 'string') {
        outcome.unmapped = placed
        res.end(pongStream())
        return
      }
      if ('missing' in placed) {
        outcome.missing = placed.missing
        res.end(pongStream())
        return
      }
      outcome.sent = placed
      const id = `toolu_${n}`
      pending.set(id, n)
      res.end(toolUseStream(id, placed.name, placed.input))
    }
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

/** An approval card: a sent message with an inline keyboard of an allow and a deny button. */
interface Card {
  n: number
  chatId: number
  messageId: number
  text: string
  buttons: number
  allow: string
  deny: string
}

function cardsIn(timeline: Timeline, chatId?: number): Card[] {
  const cards: Card[] = []
  for (const e of timeline.events) {
    if (e.src !== 'tg' || e.method !== 'sendMessage') continue
    if (chatId !== undefined && e.params.chat_id !== chatId) continue
    const rows = asObject(e.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows)) continue
    const buttons = rows.flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
    const data = buttons.map((b) => (typeof b.callback_data === 'string' ? b.callback_data : ''))
    // callback_data is tga1[r]:<kind>:<a|d>:<id>
    const allow = data.find((d) => d.split(':')[2] === 'a')
    const deny = data.find((d) => d.split(':')[2] === 'd')
    if (allow === undefined || deny === undefined || e.messageId === undefined) continue
    cards.push({
      n: e.n,
      chatId: typeof e.params.chat_id === 'number' ? e.params.chat_id : -1,
      messageId: e.messageId,
      text: deepStrings(e.params.text).join('\n'),
      buttons: buttons.length,
      allow,
      deny,
    })
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
  /** the HOME of the daemon; DSHBOT_HOME lives inside it, as it does for a real install */
  home: string
  dshbotHome: string
  workspace: string
  appDir: string
  outside: string
  runtimeDir: string
  clockFile: string
  daemons: Daemon[]
  callSeq: number
}

let scratch: string
let clockPreload: string
let world: World

const CLOCK_PRELOAD = `
import { readFileSync } from 'node:fs'
const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
const file = process.env.FAKE_CLOCK_FILE
function offset() {
  if (!file) return 0
  try {
    return Number(readFileSync(file, 'utf8')) || 0
  } catch {
    return 0
  }
}
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) return new target(realNow() + offset())
    return Reflect.construct(target, args, newTarget)
  },
  get(target, prop) {
    if (prop === 'now') return () => realNow() + offset()
    return Reflect.get(target, prop)
  },
  apply(target) {
    return new target(realNow() + offset()).toString()
  },
})
`

/** Shifts the clock of the daemon process: Date.now() and new Date() add the number found in the clock file. */
function setClockOffset(ms: number): void {
  writeFileSync(world.clockFile, String(ms))
}

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

interface SpawnOptions {
  /** extra variables of the daemon environment (the parent of the sandboxed commands) */
  env?: Record<string, string>
  /** directories put in front of PATH */
  pathFirst?: string[]
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
    FAKE_CLOCK_FILE: world.clockFile,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}`,
    ...(options.env ?? {}),
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

/** `chatId` says `text` and waits for the pong that answers it. */
async function ask(d: Daemon, text: string, chatId: number): Promise<void> {
  const pongs = pongsTo(world.timeline, chatId).length
  say(chatId, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)} in chat ${chatId}`, () => pongsTo(world.timeline, chatId).length > pongs, d)
}

interface ToolResult {
  text: string
  isError: boolean
}

/** The model is asked to call `call` in `chatId`; returns its number without waiting for the answer. */
function beginTool(call: ExecCall, chatId = OWNER_CHAT): number {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.calls.set(n, call)
  say(chatId, `run-tool-${n}`)
  return n
}

/** The call was placed onto the schema, or the test is already lost for a clear reason. */
function expectPlaced(n: number, d: Daemon): Outcome {
  const outcome = world.stub.outcomes.get(n)
  expect(outcome, `the model was not asked to run call ${n}\n${output(d)}`).toBeDefined()
  expect(outcome?.missing, 'the tool must be offered to the owner').toBeUndefined()
  expect(outcome?.unmapped, 'the input schema must fit the call').toBeUndefined()
  return outcome as Outcome
}

async function resultOf(d: Daemon, n: number, timeoutMs = WAIT_MS): Promise<ToolResult> {
  await waitFor(
    `the result of call ${n} to reach the model`,
    () => {
      const outcome = world.stub.outcomes.get(n)
      return outcome?.result !== undefined || outcome?.missing !== undefined || outcome?.unmapped !== undefined
    },
    d,
    timeoutMs,
  )
  const outcome = expectPlaced(n, d)
  expect(outcome.result, `no tool result reached the model for call ${n}: ${JSON.stringify(outcome.sent)}\n${output(d)}`).toBeDefined()
  return outcome.result as ToolResult
}

/** One tool call of the owner turn; resolves with what the tool answered. */
async function useTool(d: Daemon, call: ExecCall, chatId = OWNER_CHAT): Promise<ToolResult> {
  const pongs = pongsTo(world.timeline, chatId).length
  const n = beginTool(call, chatId)
  await waitFor(
    `a pong answer to call ${n} in chat ${chatId}`,
    () => pongsTo(world.timeline, chatId).length > pongs || world.stub.outcomes.get(n)?.missing !== undefined || world.stub.outcomes.get(n)?.unmapped !== undefined,
    d,
  )
  return resultOf(d, n)
}

const run = (command: string, extra: { timeoutSec?: number; background?: boolean; force?: boolean } = {}): ExecCall => ({
  kind: 'run',
  command,
  ...extra,
})

const FAILURE_WORDS = /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|sandbox|песочниц|expired|истек|истёк|declin|отклон/i

/** A refusal or failure of the tool: flagged as an error or worded as one, with a reason. */
function expectRefused(result: ToolResult, what: string): void {
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be a refusal\n${result.text}`).toBe(true)
}

const q = (path: string): string => `'${path}'`

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox gets its own /tmp, so a decoy under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-exec-test-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  clockPreload = join(scratch, 'fake-clock.mjs')
  writeFileSync(clockPreload, CLOCK_PRELOAD)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  const world_: World = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    appDir: join(dshbotHome, 'app'),
    outside: mkdtempSync(join(scratch, 'outside-')),
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    clockFile: join(scratch, `clock-${Math.random().toString(36).slice(2)}`),
    daemons: [],
    callSeq: 0,
  }
  mkdirSync(world_.workspace, { recursive: true })
  mkdirSync(world_.appDir, { recursive: true })
  world = world_
  setClockOffset(0)
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

function putFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// --- [home] ---------------------------------------------------------------------------------------------

interface Decoy {
  rel: string
  marker: string
}

const DECOYS: readonly Decoy[] = [
  '.config/dshbot/token.txt',
  '.ssh/id_test',
  '.gnupg/secring.gpg',
  '.claude/credentials.json',
  '.codex/auth.json',
  '.config/opencode/auth.json',
  '.config/gh/hosts.yml',
  '.netrc',
  '.foo/anything.txt',
  '.local/share/other-app/secret.txt',
].map((rel) => ({ rel, marker: `DECOY-${rel.replace(/[^A-Za-z0-9]/g, '-')}-SECRET-77` }))

const HOME_TOP_LEVEL_DECOYS = ['.ssh', '.gnupg', '.claude', '.codex', '.config', '.netrc', '.foo']

/** Command that tries to read every decoy, lists the home and the runtime directory, then reads `control`. */
function peekCommand(control: string): string {
  const reads = DECOYS.map((decoy) => `cat ${q(join(world.home, decoy.rel))} 2>/dev/null`)
  return [
    ...reads,
    `cat ${q(join(world.runtimeDir, 'bus-decoy.sock'))} 2>/dev/null`,
    "echo '=== HOME-LS ==='",
    `ls -A ${q(world.home)} 2>&1`,
    "echo '=== RUNTIME-LS ==='",
    `ls -A ${q(world.runtimeDir)} 2>&1`,
    "echo '=== CONTROL ==='",
    `cat ${q(control)}`,
  ].join('; ')
}

function plantDecoys(): void {
  for (const decoy of DECOYS) putFile(join(world.home, decoy.rel), `${decoy.marker}\n`)
  putFile(join(world.runtimeDir, 'bus-decoy.sock'), 'RUNTIME-DECOY-SECRET-77\n')
}

function expectNoDecoys(text: string): void {
  for (const decoy of DECOYS) expect(text, `${decoy.rel} must not be readable inside`).not.toContain(decoy.marker)
  expect(text, 'the runtime directory must not be visible inside').not.toContain('RUNTIME-DECOY-SECRET-77')
  const homeListing = text.split('=== HOME-LS ===')[1]?.split('=== RUNTIME-LS ===')[0] ?? ''
  const homeNames = homeListing.split('\n').map((line) => line.trim())
  for (const name of HOME_TOP_LEVEL_DECOYS) expect(homeNames, `${name} must not be listed in the home inside`).not.toContain(name)
  const runtimeListing = text.split('=== RUNTIME-LS ===')[1]?.split('=== CONTROL ===')[0] ?? ''
  expect(runtimeListing, 'the runtime directory must be empty or absent inside').not.toContain('bus-decoy.sock')
}

test('test_home_decoys_are_invisible_and_default_allowlist_is_readable', { timeout: TEST_TIMEOUT_MS }, async () => {
  plantDecoys()
  const readable = [
    ['.local/share/mise/installs/tool/bin/tool.txt', 'ALLOWLIST-MISE-OK'],
    ['.local/bin/tool.txt', 'ALLOWLIST-LOCAL-BIN-OK'],
    ['.cargo/bin/tool.txt', 'ALLOWLIST-CARGO-OK'],
    ['.rustup/toolchains/tool.txt', 'ALLOWLIST-RUSTUP-OK'],
  ] as const
  for (const [rel, marker] of readable) putFile(join(world.home, rel), `${marker}\n`)
  const d = await startOwnerDaemon()

  const reads = readable.map(([rel]) => `cat ${q(join(world.home, rel))}`).join('; ')
  const result = await useTool(d, run(`${peekCommand(join(world.home, readable[0][0]))}; echo '=== ALLOWLIST ==='; ${reads}`))

  // the command ran at all: the control file of the allowlist comes back
  expect(result.text, `the command must run\n${result.text}`).toContain('=== CONTROL ===')
  for (const [rel, marker] of readable) expect(result.text, `${rel} is in the default allowlist`).toContain(marker)
  expectNoDecoys(result.text)
})

test('test_home_allowlist_comes_from_dshbot_exec_ro_paths', { timeout: TEST_TIMEOUT_MS }, async () => {
  plantDecoys()
  const custom = join(world.home, 'my-toolchain')
  putFile(join(custom, 'tool.txt'), 'CUSTOM-ALLOWLIST-OK\n')
  const d = await startOwnerDaemon({ env: { DSHBOT_EXEC_RO_PATHS: custom } })

  const result = await useTool(d, run(peekCommand(join(custom, 'tool.txt'))))
  expect(result.text, `the command must run\n${result.text}`).toContain('=== CONTROL ===')
  expect(result.text, 'a directory of DSHBOT_EXEC_RO_PATHS is readable').toContain('CUSTOM-ALLOWLIST-OK')
  expectNoDecoys(result.text)
})

// --- [write] --------------------------------------------------------------------------------------------

test('test_write_only_the_workspace_is_writable', { timeout: TEST_TIMEOUT_MS }, async () => {
  const toolMarker = join(world.home, '.local', 'bin', 'tool-marker.txt')
  putFile(toolMarker, 'tool-original\n')
  putFile(join(world.workspace, 'pre.txt'), 'pre\n')
  const hostEtc = '/etc/dshbot-exec-test-w7.txt'
  const hostUsr = '/usr/dshbot-exec-test-w6.txt'
  const outsideFile = join(world.outside, 'w1.txt')
  const dshbotFile = join(world.dshbotHome, 'w2.txt')
  const appFile = join(world.appDir, 'w3.txt')
  const homeFile = join(world.home, 'w4.txt')
  const allowlistFile = join(world.home, '.local', 'bin', 'w5.txt')
  const d = await startOwnerDaemon()

  const command = [
    `echo ws-ok > ${q(join(world.workspace, 'written.txt'))}`,
    `echo more >> ${q(join(world.workspace, 'pre.txt'))}`,
    `mkdir -p ${q(join(world.workspace, 'sub'))}`,
    `echo nested > ${q(join(world.workspace, 'sub', 'n.txt'))}`,
    `echo x > ${q(outsideFile)}`,
    `echo x > ${q(dshbotFile)}`,
    `echo x > ${q(appFile)}`,
    `echo x > ${q(homeFile)}`,
    `echo x > ${q(allowlistFile)} || echo ALLOWLIST-WRITE-FAILED`,
    `echo tampered >> ${q(toolMarker)} || echo ALLOWLIST-APPEND-FAILED`,
    `echo x > ${q(hostUsr)} || echo USR-WRITE-FAILED`,
    `echo x > ${q(hostEtc)} || echo ETC-WRITE-FAILED`,
    "echo WRITE-CHECK-DONE",
  ].join('; ')
  const result = await useTool(d, run(command))

  expect(result.text, `the command must run\n${result.text}`).toContain('WRITE-CHECK-DONE')
  expect(readFileSync(join(world.workspace, 'written.txt'), 'utf8'), 'the workspace is writable').toBe('ws-ok\n')
  expect(readFileSync(join(world.workspace, 'pre.txt'), 'utf8')).toBe('pre\nmore\n')
  expect(readFileSync(join(world.workspace, 'sub', 'n.txt'), 'utf8')).toBe('nested\n')

  for (const path of [outsideFile, dshbotFile, appFile, homeFile, allowlistFile, hostUsr, hostEtc]) {
    expect(existsSync(path), `${path} must not be written`).toBe(false)
  }
  expect(readFileSync(toolMarker, 'utf8'), 'an allowlist directory is read-only').toBe('tool-original\n')
  expect(result.text, 'writing into an allowlist directory fails').toContain('ALLOWLIST-WRITE-FAILED')
  expect(result.text, 'appending to an allowlist file fails').toContain('ALLOWLIST-APPEND-FAILED')
  expect(result.text, 'writing into /usr fails').toContain('USR-WRITE-FAILED')
})

test('test_write_broken_bwrap_rejects_the_command_and_nothing_runs', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fakeBin = mkdtempSync(join(scratch, 'fakebin-'))
  const fake = join(fakeBin, 'bwrap')
  writeFileSync(fake, '#!/bin/sh\necho "bwrap: simulated sandbox failure" >&2\nexit 1\n')
  chmodSync(fake, 0o755)
  const marker = join(world.workspace, 'must-not-exist.txt')
  const d = await startOwnerDaemon({ pathFirst: [fakeBin] })

  const result = await useTool(d, run(`touch ${q(marker)}; echo RAN-4''2`))

  expectRefused(result, 'a command without a working sandbox')
  expect(result.text, 'the command must not run').not.toContain('RAN-42')
  expect(existsSync(marker), 'nothing may run without the sandbox').toBe(false)
})

// --- [env] ----------------------------------------------------------------------------------------------

test('test_env_child_gets_a_minimal_environment_without_keys_and_tokens', { timeout: TEST_TIMEOUT_MS }, async () => {
  const parentOnly: Record<string, string> = {
    DATABASE_URL: 'postgres://user:dbpass-77@db.example/app',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value-77',
    GITHUB_TOKEN: 'ghp_dshbot_test_value_77',
    MY_CUSTOM_PARENT_VAR: 'custom-parent-value-77',
  }
  const d = await startOwnerDaemon({ env: parentOnly })

  const result = await useTool(d, run("env; echo '=== EXPORTED ==='; export -p"))

  expect(result.text, `the command must run\n${result.text}`).toMatch(/(?:^|\n)(?:export )?PATH=/)
  expect(result.text, 'HOME is part of the minimal set').toMatch(/(?:^|\n)(?:export )?HOME=/)
  const names = ['DEEPSEEK_API_KEY', 'TELEGRAM_BOT_TOKEN', 'FAKE_CLOCK_FILE', 'NODE_OPTIONS', ...Object.keys(parentOnly)]
  for (const name of names) expect(result.text, `${name} must not reach the child`).not.toContain(name)
  const values = [DEEPSEEK_KEY, BOT_TOKEN, BOT_TOKEN.split(':')[1] ?? '', ...Object.values(parentOnly)]
  for (const value of values) expect(result.text, 'a secret value must not reach the child').not.toContain(value)
})

// --- [guard] --------------------------------------------------------------------------------------------

test('test_guard_deny_refuses_without_running_and_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const marker = join(world.workspace, 'deny-ran.txt')
  const d = await startOwnerDaemon()

  // control: an allowed command runs without any card
  const control = await useTool(d, run(`echo CONTROL-4''2`))
  expect(control.text).toContain('CONTROL-42')

  const result = await useTool(d, run(`touch ${q(marker)} && gh repo create demo --public`))

  expectRefused(result, 'a command the guard denies')
  expect(existsSync(marker), 'a denied command must not run').toBe(false)
  expect(cardsIn(world.timeline), 'a denied command asks nobody').toHaveLength(0)
})

/** A directory the confirm command removes, and the command itself. */
function doomedCommand(): { doomed: string; command: string } {
  const doomed = join(world.workspace, 'doomed')
  putFile(join(doomed, 'keep.txt'), 'keep\n')
  return { doomed, command: `rm -rf ${q(doomed)} && echo CONFIRMED-4''2` }
}

async function waitForCard(d: Daemon, n: number): Promise<Card> {
  await waitFor(
    'an approval card for the owner',
    () => cardsIn(world.timeline, OWNER_CHAT).length > 0 || world.stub.outcomes.get(n)?.missing !== undefined || world.stub.outcomes.get(n)?.unmapped !== undefined,
    d,
  )
  expectPlaced(n, d)
  const cards = cardsIn(world.timeline, OWNER_CHAT)
  expect(cards, 'one approval card, with an allow and a deny button').toHaveLength(1)
  return cards[0] as Card
}

test('test_guard_confirm_runs_only_after_the_allow_button_and_text_yes_is_not_an_approval', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
  const d = await startOwnerDaemon()

  const n = beginTool(run(command))
  const card = await waitForCard(d, n)
  expect(card.buttons, 'the card has buttons').toBeGreaterThanOrEqual(2)
  expect(card.text, 'the card shows what is going to run').toContain('doomed')

  await sleep(1_500)
  expect(existsSync(doomed), 'nothing runs before the button').toBe(true)
  expect(world.stub.outcomes.get(n)?.result, 'the command waits for the button').toBeUndefined()

  // Words in the chat are not an approval. A text message closes the card with
  // a refusal (the owner has moved on) instead of confirming it.
  say(OWNER_CHAT, 'да')
  say(OWNER_CHAT, 'Да, выполняй')
  say(OWNER_CHAT, 'yes')
  const refused = await resultOf(d, n)
  expectRefused(refused, 'text in the chat is not an approval')
  expect(existsSync(doomed), 'the text "да" must not confirm').toBe(true)

  // The closed card cannot be reopened by a late button press.
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
  await sleep(1_000)
  expect(world.stub.outcomes.get(n)?.result, 'a late allow press does not run the refused command').toBe(refused)
  expect(existsSync(doomed), 'the command did not run after the stale allow button').toBe(true)
})

/** An owner message with a document or a voice note: never a plain text of the owner. */
function ownerMedia(kind: 'document' | 'voice'): JsonObject {
  const update = privateMessage(OWNER_CHAT, '')
  const message = asObject(update.message)
  delete message.text
  if (kind === 'document') {
    message.document = { file_id: `doc-${updateCounter}`, file_unique_id: `udoc-${updateCounter}`, file_name: 'notes.txt', mime_type: 'text/plain', file_size: 12 }
    message.caption = 'посмотри файл'
  } else {
    message.voice = { file_id: `voice-${updateCounter}`, file_unique_id: `uvoice-${updateCounter}`, duration: 2, mime_type: 'audio/ogg', file_size: 1200 }
  }
  return update
}

test('test_guard_confirm_card_keeps_waiting_through_a_command_a_file_and_a_voice_note', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
  const d = await startOwnerDaemon()

  const n = beginTool(run(command))
  const card = await waitForCard(d, n)

  // Only a typed text supersedes the exec card. A command, a file and a voice
  // note leave it waiting for the button, as before steering existed.
  say(OWNER_CHAT, '/status')
  world.tg.push(ownerMedia('document'))
  world.tg.push(ownerMedia('voice'))
  await sleep(2_000)
  expect(d.exited, `the daemon keeps running\n${output(d)}`).toBe(false)
  expect(world.stub.outcomes.get(n)?.result, 'the exec waits for the button after /status, a file and a voice note').toBeUndefined()
  expect(existsSync(doomed), 'nothing runs before the button').toBe(true)

  // The button still decides the same card.
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
  const result = await resultOf(d, n)
  expect(result.isError, `the allowed command runs\n${result.text}`).toBe(false)
  expect(result.text).toContain('CONFIRMED-42')
  expect(existsSync(doomed), 'the allowed command removed the directory').toBe(false)
})

test('test_guard_confirm_deny_button_refuses_without_running', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
  const d = await startOwnerDaemon()

  const n = beginTool(run(command))
  const card = await waitForCard(d, n)
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))

  const result = await resultOf(d, n)
  expectRefused(result, 'a command the owner declined')
  expect(result.text).not.toContain('CONFIRMED-42')
  expect(existsSync(doomed), 'a declined command must not run').toBe(true)
})

test('test_guard_confirm_expired_card_refuses_without_running', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
  const d = await startOwnerDaemon()

  const n = beginTool(run(command))
  const card = await waitForCard(d, n)

  // the deadline of the card passes; a late press of the allow button must not run anything
  setClockOffset(25 * 60 * 60 * 1000)
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))

  const result = await resultOf(d, n)
  expectRefused(result, 'a command whose approval expired')
  expect(result.text).not.toContain('CONFIRMED-42')
  expect(existsSync(doomed), 'an expired approval must not run the command').toBe(true)
})

// --- [timeout] ------------------------------------------------------------------------------------------

test('test_timeout_kills_the_process_and_its_children_and_marks_the_result', { timeout: TEST_TIMEOUT_MS }, async () => {
  const heartbeat = join(world.workspace, 'child-heartbeat.txt')
  const ticks = Array.from({ length: 150 }, (_, i) => i + 1).join(' ')
  const d = await startOwnerDaemon()

  // the child shell writes a tick every 0.2 s for at most 30 s; the parent only waits for it
  const command = `( for i in ${ticks}; do echo x >> ${q(heartbeat)}; sleep 0.2; done ) & echo child-started; wait`
  const result = await useTool(d, run(command, { timeoutSec: 3 }))

  expect(result.text, `the result of a timed out command is marked\n${result.text}`).toMatch(/time(?:d)?[\s_-]?out|таймаут|time limit|превыш|истёк|истек/i)
  expect(existsSync(heartbeat), 'the child must have run before the timeout (is the timeout in seconds?)').toBe(true)

  await sleep(1_000)
  const before = statSync(heartbeat).size
  expect(before).toBeGreaterThan(0)
  await sleep(1_500)
  expect(statSync(heartbeat).size, 'the child of a timed out command must be killed').toBe(before)
})

// --- [jobs] ---------------------------------------------------------------------------------------------

/** Candidate job ids in a start result: JSON fields first, then words that look like an id. */
function jobIds(text: string): string[] {
  const found: string[] = []
  const add = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') found.push(String(value))
  }
  const objectText = /\{[\s\S]*\}/.exec(text)?.[0]
  for (const candidate of [text, objectText]) {
    if (candidate === undefined) continue
    try {
      const parsed = asObject(JSON.parse(candidate))
      for (const name of ID_NAMES) add(parsed[name])
    } catch {
      // not JSON
    }
  }
  const common = /^(?:started|running|background|status|id|job|jobs|the|is|to|use|with|and|task|process|pid|started|command)$/i
  for (const match of text.matchAll(/(?:job|id|task|process)\W{0,6}([A-Za-z0-9][A-Za-z0-9_.-]{1,63})/gi)) {
    if (match[1] !== undefined && !common.test(match[1])) found.push(match[1])
  }
  for (const token of text.match(/[A-Za-z0-9_-]+/g) ?? []) {
    if (token.length >= 2 && /\d/.test(token) && !common.test(token)) found.push(token)
  }
  return [...new Set(found)].slice(0, 6)
}

/** Asks for the status of `ids` until one answers with `marker`; returns that id and answer. */
async function statusUntil(d: Daemon, ids: string[], marker: RegExp, what: string): Promise<{ id: string; result: ToolResult }> {
  let last = ''
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const id of ids) {
      const result = await useTool(d, { kind: 'status', id })
      last = result.text
      if (marker.test(result.text)) return { id, result }
    }
    await sleep(700)
  }
  expect.fail(`${what}: no status answer matched ${marker} for ids ${JSON.stringify(ids)}; last answer:\n${last}`)
}

test('test_jobs_background_run_returns_an_id_at_once_status_shows_the_tail_and_stop_kills', { timeout: TEST_TIMEOUT_MS }, async () => {
  const heartbeat = join(world.workspace, 'bg-heartbeat.txt')
  const ticks = Array.from({ length: 150 }, (_, i) => i + 1).join(' ')
  const d = await startOwnerDaemon()

  const command = `echo BG-LINE-A; echo BG-LINE-B; for i in ${ticks}; do echo x >> ${q(heartbeat)}; sleep 0.2; done`
  const started = Date.now()
  const start = await useTool(d, run(command, { background: true }))
  const elapsed = Date.now() - started

  expect(elapsed, 'a background start returns at once, not after the 30 s of the command').toBeLessThan(20_000)
  const ids = jobIds(start.text)
  expect(ids.length, `the start answer must carry a job id\n${start.text}`).toBeGreaterThan(0)

  // the command goes on after the answer
  await sleep(1_200)
  const grown = existsSync(heartbeat) ? statSync(heartbeat).size : 0
  expect(grown, 'the job runs on in the background').toBeGreaterThan(0)

  const { id, result: status } = await statusUntil(d, ids, /BG-LINE-B/, 'status of a running job')
  expect(status.text, 'the tail of the output shows the first lines').toContain('BG-LINE-A')
  expect(status.text, 'the status says the job is running').toMatch(/run|выполн|active|актив|работа|идёт|идет|progress/i)

  const stop = await useTool(d, { kind: 'stop', id })
  expect(stop.isError, `stop answers without an error\n${stop.text}`).toBe(false)

  await sleep(1_500)
  const afterStop = statSync(heartbeat).size
  await sleep(1_500)
  expect(statSync(heartbeat).size, 'stop kills the process of the job').toBe(afterStop)
})

test('test_jobs_status_of_a_finished_job_gives_the_end_of_a_long_output', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const start = await useTool(d, run("seq -f 'row-%g' 1 30000; echo FIN-4''2; exit 3", { background: true }))
  const ids = jobIds(start.text)
  expect(ids.length, `the start answer must carry a job id\n${start.text}`).toBeGreaterThan(0)

  const { result } = await statusUntil(d, ids, /FIN-42/, 'status of a finished job')
  expect(result.text, 'the tail ends with the last rows').toContain('row-30000')
  expect(result.text, 'a tail is not the whole output').not.toMatch(/(?:^|\n)row-1(?:\n|$)/)
  expect(result.text.length, 'a tail is short').toBeLessThan(100_000)
  expect(result.text, 'the status says the job is over').toMatch(/exit|код|code|finish|done|заверш|ended|complet|stopped|status/i)
  expect(result.text, 'the exit code is part of the status').toMatch(/(?:^|\D)3(?:\D|$)/)
})

// --- [bang] owner `!command` beyond the in-memory output budget ------------------------------------------

test('test_bang_output_beyond_the_stream_budget_comes_as_a_whole_file', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rows = 30_000
  const d = await startOwnerDaemon()
  const mark = world.timeline.seq

  // ~290 KB of stdout: far beyond the 64 000-byte tail the executor keeps in memory.
  say(OWNER_CHAT, `!seq -f 'big-%g' 1 ${rows}`)
  const documents = (): TgEvent[] =>
    world.timeline.events.filter(
      (e): e is TgEvent => e.src === 'tg' && e.n > mark && e.method === 'sendDocument',
    )
  await waitFor('the output as a document', () => documents().length > 0, d)

  const raw = String((documents()[0] as TgEvent).params.__raw ?? '')
  const fileRows = raw.split(/\r?\n/).filter((line) => /^big-\d+$/.test(line))
  expect(fileRows[0], 'the file starts with the first row').toBe('big-1')
  expect(fileRows.at(-1), 'the file ends with the last row').toBe(`big-${rows}`)
  expect(fileRows.length, 'the file holds every row, not only the tail').toBe(rows)
  expect(raw, 'the whole output is not marked as a lost head').not.toContain('начало вывода потеряно')

  const shown = textsSince(mark, OWNER_CHAT).join('\n')
  expect(shown, 'the message says the output was cut').toMatch(/обрезан/)
  expect(shown, 'the message shows the head of the output').toContain('big-1\n')
  expect(shown.length, 'the message does not carry the whole output').toBeLessThan(10_000)
})

// --- [guest] --------------------------------------------------------------------------------------------

test('test_guest_gets_exec_only_in_its_own_sandbox_and_an_ownerless_turn_draws_no_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
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
  for (const call of ownerCalls) expect(toolNames(call.body), 'the owner gets exec').toContain('exec')

  const guestCalls = callsMentioning(world.timeline, 'guest-schema-probe-xyz')
  expect(guestCalls.length).toBeGreaterThan(0)
  for (const call of guestCalls) {
    expect(toolNames(call.body), 'a guest gets exactly the three guest tools').toEqual([
      'exec',
      'web_fetch',
      'web_search',
    ])
  }

  // A guest `exec` needs no owner card: it runs in a fresh empty sandbox, so
  // the owner's directory in the command is not even present there. The frame
  // of the answer deliberately contains the word "не выполняй" of the
  // external-data notice, so it must not be read through FAILURE_WORDS.
  // (a guest message honours the real-time pace limit: one accepted message per 3 s)
  await sleep(3_500)
  const cardsBefore = cardsIn(world.timeline).length
  const started = Date.now()
  const result = await useTool(d, run(command, { force: true }), GUEST_CHAT)
  expect(Date.now() - started, 'a guest command is bounded, not left waiting for a card').toBeLessThan(25_000)
  expect(result.isError, `exec in a guest sandbox succeeds\n${result.text}`).toBe(false)
  expect(result.text, 'the guest command ran in its sandbox').toContain('CONFIRMED-42')
  expect(result.text).toMatch(/^exit 0\n/)
  expect(existsSync(doomed), 'the owner workspace of a guest is untouched').toBe(true)
  expect(cardsIn(world.timeline).length, 'no approval card for a turn without the owner').toBe(cardsBefore)
})
