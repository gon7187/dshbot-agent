// The schedule of the bot: the `schedule` tool, the ticker of the daemon and the planned turns it starts.
// Same harness as exec-tool.test.ts: the daemon runs as a child process against a fake Telegram Bot API and a
// local DeepSeek stub. The stub plays the model: for an owner message `run-tool-N` it answers with one tool call
// whose arguments are mapped onto the property names found in the tools[] schema of the request; for a planned
// turn it recognises the job by the marker `sched-job-<name>` inside the text of the job and plays the script
// registered for that name (reply, exec call or an HTTP failure).
//
// The clock is fake: a preload replaces Date and the timer functions of the daemon process. The test moves the
// clock through a control file: `advanceClock(ms)` adds ms to Date and fires every timer that has become due at
// once (an interval or timeout set with a longer delay than the real wait of the test fires immediately);
// `poke` fires every interval once more, which is how "the ticker fired twice in a row" is produced.
//
// Accepted shapes of the schema of `schedule` (the stub maps the logical call onto whatever the request offers):
//   action      a property named action|op|operation|command|mode|cmd, enum values create|add|... / list|show|...
//               / remove|delete|cancel|...
//   when        one string property named schedule|spec|when|expression|timing|time holding the parseSchedule
//               text ("every 30m", "*/10 * * * *"); or cron|cron_expression for a cron; or every|interval|period
//               (a number in minutes, milliseconds when the name says ms, seconds when it says sec; or "30m")
//   job text    prompt|task|text|message|instruction(s)|description|goal|content|body
//   idleOnly    a boolean property named idleOnly|idle_only|idle-only
//   remove      the id goes to id|job_id|jobId|job|schedule_id|scheduleId|name

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const RUN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

const MINUTE_MS = 60_000

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

type When = { type: 'every'; minutes: number } | { type: 'cron'; expression: string }

/** One tool call in logical terms; the stub maps the names onto the real input schema. */
type ToolCall =
  | { kind: 'create'; when: When; text: string; idleOnly?: boolean }
  | { kind: 'list' }
  | { kind: 'remove'; id: string }
  | { kind: 'exec'; command: string }

/** What a planned turn of the job does when the model is asked. */
type JobScript = { kind: 'reply'; text: string } | { kind: 'exec'; command: string }

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
  calls: Map<number, ToolCall>
  outcomes: Map<number, Outcome>
  jobs: Map<string, JobScript>
  jobOutcomes: Map<string, Outcome>
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
const ACTION_NAMES = ['action', 'op', 'operation', 'command', 'mode', 'cmd']
const TEXT_NAMES = ['prompt', 'task', 'text', 'message', 'instruction', 'instructions', 'description', 'goal', 'content', 'body']
const SPEC_NAMES = ['schedule', 'spec', 'when', 'expression', 'timing', 'time']
const CRON_NAMES = ['cron', 'cron_expression', 'cronExpression']
const INTERVAL_NAMES = ['every', 'interval', 'interval_ms', 'intervalMs', 'interval_minutes', 'intervalMinutes', 'period']
const ID_NAMES = ['id', 'job_id', 'jobId', 'job', 'schedule_id', 'scheduleId', 'name']

const ACTION_VALUES = {
  create: /^(?:create|add|new|set|schedule)$/i,
  list: /^(?:list|ls|show|all|get)$/i,
  remove: /^(?:remove|delete|rm|del|cancel|unschedule)$/i,
} as const

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

function isNumeric(prop: JsonObject | undefined): boolean {
  return prop?.type === 'number' || prop?.type === 'integer'
}

function buildExec(command: string, schema: Schema): JsonObject | string {
  const commandKey = pickKey(schema, COMMAND_NAMES) ?? schema.required[0]
  if (commandKey === undefined) return 'no command property in the input schema'
  const input: JsonObject = { [commandKey]: command }
  if ('purpose' in schema.props) input.purpose = 'проверяю поведение exec через карточку подтверждения'
  return input
}

function placeAction(kind: keyof typeof ACTION_VALUES, schema: Schema, input: JsonObject): string | undefined {
  for (const [key, prop] of Object.entries(schema.props)) {
    const value = enumValues(prop).find((v) => ACTION_VALUES[kind].test(v))
    if (value !== undefined) {
      input[key] = value
      return undefined
    }
  }
  const key = pickKey(schema, ACTION_NAMES)
  if (key !== undefined) {
    input[key] = kind
    return undefined
  }
  return kind === 'create' ? undefined : `no action property to ${kind} in the input schema`
}

function placeWhen(when: When, schema: Schema, input: JsonObject): string | undefined {
  if (when.type === 'cron') {
    const key = pickKey(schema, CRON_NAMES) ?? pickKey(schema, SPEC_NAMES)
    if (key === undefined) return 'no property for a cron expression in the input schema'
    input[key] = when.expression
    return undefined
  }
  const specKey = pickKey(schema, SPEC_NAMES)
  if (specKey !== undefined) {
    input[specKey] = `every ${when.minutes}m`
    return undefined
  }
  const key = pickKey(schema, INTERVAL_NAMES)
  if (key === undefined) return 'no property for an interval in the input schema'
  if (!isNumeric(schema.props[key])) {
    input[key] = `${when.minutes}m`
  } else if (/ms|milli/i.test(key)) {
    input[key] = when.minutes * MINUTE_MS
  } else if (/sec/i.test(key)) {
    input[key] = when.minutes * 60
  } else {
    input[key] = when.minutes
  }
  return undefined
}

function fillRequired(schema: Schema, input: JsonObject): void {
  for (const key of schema.required) {
    if (key in input) continue
    const prop = schema.props[key] ?? {}
    const choices = enumValues(prop)
    if (choices.length > 0) input[key] = choices[0]
    else if (isNumeric(prop)) input[key] = 1
    else if (prop.type === 'boolean') input[key] = false
    else input[key] = `test-${key}`
  }
}

function buildSchedule(call: Exclude<ToolCall, { kind: 'exec' }>, schema: Schema): JsonObject | string {
  const input: JsonObject = {}
  const action = placeAction(call.kind, schema, input)
  if (action !== undefined) return action

  if (call.kind === 'create') {
    const whenError = placeWhen(call.when, schema, input)
    if (whenError !== undefined) return whenError
    const textKey = pickKey(schema, TEXT_NAMES) ?? schema.required.find((name) => !(name in input) && schema.props[name]?.type === 'string')
    if (textKey === undefined) return 'no property for the text of the job in the input schema'
    input[textKey] = call.text
    if (call.idleOnly === true) {
      const idleKey = Object.keys(schema.props).find((name) => /^idle[_-]?only$/i.test(name))
      if (idleKey === undefined) return 'no idleOnly property in the input schema'
      input[idleKey] = true
    }
  } else if (call.kind === 'remove') {
    const idKey = pickKey(schema, ID_NAMES) ?? schema.required.find((name) => !(name in input))
    if (idKey === undefined) return 'no id property in the input schema'
    input[idKey] = isNumeric(schema.props[idKey]) && /^\d+$/.test(call.id) ? Number(call.id) : call.id
  }
  fillRequired(schema, input)
  return input
}

function placeCall(call: ToolCall, schemas: Map<string, Schema>): { name: string; input: JsonObject } | { missing: string } | string {
  const name = call.kind === 'exec' ? 'exec' : 'schedule'
  const schema = schemas.get(name)
  if (schema === undefined) return { missing: `tool "${name}" is not in tools[]: ${JSON.stringify([...schemas.keys()])}` }
  const input = call.kind === 'exec' ? buildExec(call.command, schema) : buildSchedule(call, schema)
  return typeof input === 'string' ? input : { name, input }
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

/** The turn a model request belongs to: the last user text with a marker, and the steps taken since. */
interface TurnRef {
  kind: 'tool' | 'job'
  key: string
  /** assistant messages after the message that opened the turn */
  step: number
}

const TURN_MARKER = /run-tool-(\d+)|sched-job-([a-z0-9]+)/

function turnOf(body: JsonObject): TurnRef | undefined {
  const messages = Array.isArray(body.messages) ? body.messages.map(asObject) : []
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const match = TURN_MARKER.exec(flatten(message.content))
    if (match === null) continue
    const step = messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    if (match[1] !== undefined) return { kind: 'tool', key: match[1], step }
    return { kind: 'job', key: match[2] as string, step }
  }
  return undefined
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    calls: new Map(),
    outcomes: new Map(),
    jobs: new Map(),
    jobOutcomes: new Map(),
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
      const turn = turnOf(body)
      const script = turn?.kind === 'job' ? stub.jobs.get(turn.key) : undefined
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      const result = turn !== undefined && turn.step > 0 ? lastToolResult(body) : undefined
      if (turn?.kind === 'tool') {
        const n = Number(turn.key)
        const call = stub.calls.get(n)
        if (turn.step > 0) {
          const outcome = stub.outcomes.get(n)
          if (outcome !== undefined && result !== undefined) outcome.result = { text: result.text, isError: result.isError }
          res.end(textStream('pong'))
          return
        }
        if (call === undefined) {
          res.end(textStream('pong'))
          return
        }
        const outcome: Outcome = {}
        stub.outcomes.set(n, outcome)
        const placed = placeCall(call, toolSchemas(body))
        if (typeof placed === 'string') {
          outcome.unmapped = placed
          res.end(textStream('pong'))
        } else if ('missing' in placed) {
          outcome.missing = placed.missing
          res.end(textStream('pong'))
        } else {
          outcome.sent = placed
          res.end(toolUseStream(`toolu_${n}`, placed.name, placed.input))
        }
        return
      }

      if (turn?.kind === 'job') {
        const done = textStream(`fin sched-job-${turn.key}`)
        if (script === undefined) {
          res.end(done)
          return
        }
        if (script.kind === 'reply') {
          res.end(textStream(script.text))
          return
        }
        if (script.kind === 'exec') {
          const outcome = stub.jobOutcomes.get(turn.key) ?? {}
          stub.jobOutcomes.set(turn.key, outcome)
          if (turn.step > 0) {
            if (result !== undefined) outcome.result = { text: result.text, isError: result.isError }
            res.end(done)
            return
          }
          const placed = placeCall({ kind: 'exec', command: script.command }, toolSchemas(body))
          if (typeof placed === 'string') {
            outcome.unmapped = placed
            res.end(done)
          } else if ('missing' in placed) {
            outcome.missing = placed.missing
            res.end(done)
          } else {
            outcome.sent = placed
            res.end(toolUseStream(`toolu_job_${turn.key}`, placed.name, placed.input))
          }
          return
        }
      }
      res.end(textStream('pong'))
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

function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
}

/** Texts of the messages the owner chat got after `mark` (a timeline number). */
function ownerTextsSince(mark: number): string[] {
  return sentTo(world.timeline, OWNER_CHAT)
    .filter((e) => e.n > mark)
    .map((e) => deepStrings(e.params).join('\n'))
}

/** An approval card: a sent message with an inline keyboard of an allow and a deny button. */
interface Card {
  n: number
  messageId: number
  text: string
  allow: string
  deny: string
}

function cardsIn(timeline: Timeline, chatId: number): Card[] {
  const cards: Card[] = []
  for (const e of timeline.events) {
    if (e.src !== 'tg' || e.method !== 'sendMessage') continue
    if (e.params.chat_id !== chatId) continue
    const rows = asObject(e.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows)) continue
    const buttons = rows.flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
    const data = buttons.map((b) => (typeof b.callback_data === 'string' ? b.callback_data : ''))
    // callback_data is tga1[r]:<kind>:<a|d>:<id>
    const allow = data.find((d) => d.split(':')[2] === 'a')
    const deny = data.find((d) => d.split(':')[2] === 'd')
    if (allow === undefined || deny === undefined || e.messageId === undefined) continue
    cards.push({ n: e.n, messageId: e.messageId, text: deepStrings(e.params.text).join('\n'), allow, deny })
  }
  return cards
}

/** Model requests (streaming) that belong to the turn of one job, in order. */
function jobCalls(name: string): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => {
    if (e.src !== 'ds' || e.body.stream === false) return false
    const turn = turnOf(e.body)
    return turn?.kind === 'job' && turn.key === name
  })
}

/** How many planned turns of the job started: model requests that open the turn. */
function runsOf(name: string): number {
  return jobCalls(name).filter((e) => turnOf(e.body)?.step === 0).length
}

// --- the fake clock of the daemon --------------------------------------------------------------------

// Date and the timer functions of the daemon process live in a virtual time: real time plus the offset the test
// writes into the control file. A command {seq, total, poke} sets the offset to `total`, fires every timer whose
// virtual due time has passed (once) and, with `poke`, every interval once more; then the preload acknowledges it.
const CLOCK_PRELOAD = `
import { readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const RealDate = Date
const realNow = RealDate.now.bind(RealDate)
const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}
const control = process.env.FAKE_CLOCK_CONTROL
const MAX_DELAY = 2147483647
let offset = 0
let lastSeq = 0

function readCommand() {
  if (!control) return undefined
  try {
    return JSON.parse(readFileSync(control, 'utf8'))
  } catch {
    return undefined
  }
}

const initial = readCommand()
if (initial && typeof initial.seq === 'number') {
  lastSeq = initial.seq
  offset = Number(initial.total) || 0
}

const virtualNow = () => realNow() + offset

globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    if (args.length === 0) return new target(virtualNow())
    return Reflect.construct(target, args, newTarget)
  },
  get(target, prop) {
    if (prop === 'now') return () => virtualNow()
    return Reflect.get(target, prop)
  },
  apply(target) {
    return new target(virtualNow()).toString()
  },
})

const entries = new Map()

function delayOf(delay) {
  const ms = Math.trunc(Number(delay))
  return Number.isFinite(ms) && ms >= 1 && ms <= MAX_DELAY ? ms : 1
}

function patchedSetTimeout(fn, delay, ...args) {
  if (typeof fn !== 'function') return real.setTimeout(fn, delay, ...args)
  const ms = delayOf(delay)
  const entry = { fn, args, ms, repeat: false, due: virtualNow() + ms }
  const handle = real.setTimeout(() => {
    entries.delete(handle)
    fn(...args)
  }, ms)
  entries.set(handle, entry)
  return handle
}

function patchedSetInterval(fn, delay, ...args) {
  if (typeof fn !== 'function') return real.setInterval(fn, delay, ...args)
  const ms = delayOf(delay)
  const entry = { fn, args, ms, repeat: true, due: virtualNow() + ms }
  const handle = real.setInterval(() => {
    entry.due = virtualNow() + ms
    fn(...args)
  }, ms)
  entries.set(handle, entry)
  return handle
}

if (real.setTimeout[promisify.custom]) {
  Object.defineProperty(patchedSetTimeout, promisify.custom, { value: real.setTimeout[promisify.custom], configurable: true })
}

globalThis.setTimeout = patchedSetTimeout
globalThis.setInterval = patchedSetInterval
globalThis.clearTimeout = (handle) => {
  entries.delete(handle)
  return real.clearTimeout(handle)
}
globalThis.clearInterval = (handle) => {
  entries.delete(handle)
  return real.clearInterval(handle)
}

function fire(handle, entry) {
  if (entry.repeat) {
    entry.due = virtualNow() + entry.ms
  } else {
    entries.delete(handle)
    real.clearTimeout(handle)
  }
  try {
    entry.fn(...entry.args)
  } catch (error) {
    process.nextTick(() => {
      throw error
    })
  }
}

const poll = real.setInterval(() => {
  const command = readCommand()
  if (!command || typeof command.seq !== 'number' || command.seq <= lastSeq) return
  lastSeq = command.seq
  offset = Number(command.total) || 0
  const now = virtualNow()
  for (const [handle, entry] of [...entries]) {
    if (handle._destroyed) {
      entries.delete(handle)
    } else if (entry.due <= now || (command.poke && entry.repeat)) {
      fire(handle, entry)
    }
  }
  writeFileSync(control + '.ack', String(lastSeq))
}, 10)
poll.unref()
`

interface Clock {
  control: string
  seq: number
  total: number
}

function writeClock(clock: Clock, poke: boolean): void {
  clock.seq += 1
  const staged = `${clock.control}.next`
  writeFileSync(staged, JSON.stringify({ seq: clock.seq, total: clock.total, poke }))
  renameSync(staged, clock.control)
}

function readAck(clock: Clock): number {
  try {
    return Number(readFileSync(`${clock.control}.ack`, 'utf8')) || 0
  } catch {
    return 0
  }
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
  runtimeDir: string
  clock: Clock
  daemons: Daemon[]
  callSeq: number
}

let scratch: string
let clockPreload: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

interface SpawnOptions {
  /** extra variables of the daemon environment */
  env?: Record<string, string>
}

function spawnDaemon(options: SpawnOptions = {}): Daemon {
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
    FAKE_CLOCK_CONTROL: world.clock.control,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}`,
    ...(options.env ?? {}),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  // `exec` makes the node process the direct child, so signals and exit codes are the daemon's own.
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

/** Moves the clock of the daemon forward and fires the timers that became due; resolves once it acknowledged. */
async function advanceClock(ms: number, d: Daemon, poke = false): Promise<void> {
  world.clock.total += ms
  writeClock(world.clock, poke)
  const seq = world.clock.seq
  await waitFor('the fake clock of the daemon to acknowledge', () => readAck(world.clock) >= seq || d.exited, d)
  expect(d.exited, `daemon exited while the clock moved\n${output(d)}`).toBe(false)
}

/** Waits for `cond`, nudging the ticker of the daemon every few seconds in case it waits for its own timer. */
async function waitPoking(what: string, cond: () => boolean, d: Daemon, timeoutMs = RUN_WAIT_MS): Promise<void> {
  const started = Date.now()
  let lastNudge = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) {
    await sleep(40)
    if (Date.now() - lastNudge >= 2_000 && !cond()) {
      lastNudge = Date.now()
      await advanceClock(1_000, d, true)
    }
  }
  expect(cond(), `timed out waiting for: ${what}\n${output(d)}`).toBe(true)
}

/** Nothing new has happened on either fake for `ms`. */
async function quietFor(ms: number, capMs = 60_000): Promise<void> {
  const started = Date.now()
  let last = world.timeline.seq
  let since = Date.now()
  while (Date.now() - started < capMs) {
    await sleep(100)
    if (world.timeline.seq !== last) {
      last = world.timeline.seq
      since = Date.now()
    } else if (Date.now() - since >= ms) return
  }
}

async function startDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(options)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

async function stopDaemon(d: Daemon): Promise<void> {
  if (d.exited) return
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 8_000)
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

async function startOwnerDaemon(): Promise<Daemon> {
  const d = await startDaemon()
  await pairOwner(d)
  return d
}

/** The owner says `text` and waits for the pong that answers it. */
async function ask(d: Daemon, text: string): Promise<void> {
  const pongs = pongsTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, text)
  await waitFor(`a pong answer to ${JSON.stringify(text)}`, () => pongsTo(world.timeline, OWNER_CHAT).length > pongs, d)
}

interface ToolResult {
  text: string
  isError: boolean
}

/** The model is asked to call `call` in the owner turn; returns its number without waiting for the answer. */
function beginTool(call: ToolCall): number {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.calls.set(n, call)
  say(OWNER_CHAT, `run-tool-${n}`)
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
async function useTool(d: Daemon, call: ToolCall): Promise<ToolResult> {
  const pongs = pongsTo(world.timeline, OWNER_CHAT).length
  const n = beginTool(call)
  await waitFor(
    `a pong answer to call ${n}`,
    () => pongsTo(world.timeline, OWNER_CHAT).length > pongs || world.stub.outcomes.get(n)?.missing !== undefined || world.stub.outcomes.get(n)?.unmapped !== undefined,
    d,
  )
  return resultOf(d, n)
}

const everyMinutes = (minutes: number): When => ({ type: 'every', minutes })

const createJob = (name: string, when: When, extra: { idleOnly?: boolean } = {}): ToolCall => ({
  kind: 'create',
  when,
  text: `sched-job-${name} проверь почту и коротко доложи`,
  ...extra,
})

/** A job is created through the tool and the tool says it worked. */
async function addJob(d: Daemon, name: string, when: When, extra: { idleOnly?: boolean } = {}): Promise<ToolResult> {
  const result = await useTool(d, createJob(name, when, extra))
  expect(result.isError, `schedule create must succeed\n${result.text}`).toBe(false)
  return result
}

const q = (path: string): string => `'${path}'`

const FAILURE_WORDS = /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|sandbox|песочниц|expired|истек|истёк|declin|отклон|unavailable|недоступ/i

/** A refusal or failure of the tool: flagged as an error or worded as one, with a reason. */
function expectRefused(result: ToolResult, what: string): void {
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be a refusal\n${result.text}`).toBe(true)
}

/** A directory the confirm command removes, and the command itself. */
function doomedCommand(): { doomed: string; command: string } {
  const doomed = join(world.workspace, 'doomed')
  mkdirSync(doomed, { recursive: true })
  writeFileSync(join(doomed, 'keep.txt'), 'keep\n')
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

// --- reading ids out of tool answers -----------------------------------------------------------------

const ID_LABEL = /\b(?:id|job_id|jobId|schedule_id)\b["']?\s*[:=#]?\s*["']?([A-Za-z0-9_.-]+)/i

function idKeyed(value: unknown, marker: string | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = idKeyed(item, marker)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  const object = value as JsonObject
  for (const child of Object.values(object)) {
    const found = idKeyed(child, marker)
    if (found !== undefined) return found
  }
  const id = object.id ?? object.job_id ?? object.jobId ?? object.schedule_id
  if ((typeof id === 'string' || typeof id === 'number') && (marker === undefined || JSON.stringify(object).includes(marker))) {
    return String(id)
  }
  return undefined
}

/** The id of the job in a tool answer: the one whose entry mentions `marker`, or the only one when it is omitted. */
function idOf(text: string, marker?: string): string | undefined {
  try {
    const found = idKeyed(JSON.parse(text) as unknown, marker)
    if (found !== undefined) return found
  } catch {
    // plain text: look at the lines
  }
  const lines = text.split('\n').filter((line) => marker === undefined || line.includes(marker))
  for (const line of lines) {
    const labelled = ID_LABEL.exec(line)
    if (labelled?.[1] !== undefined) return labelled[1]
    const hash = /#([A-Za-z0-9_-]+)/.exec(line)
    if (hash?.[1] !== undefined) return hash[1]
  }
  for (const line of marker === undefined ? [] : lines) {
    const leading = /^\s*(?:[-*]\s*)?\[?`?([A-Za-z0-9_-]+)`?\]?[\s.:)]/.exec(line)
    if (leading?.[1] !== undefined && /\d/.test(leading[1])) return leading[1]
  }
  return undefined
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-sched-test-')))
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
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    clock: { control: join(scratch, `clock-${Math.random().toString(36).slice(2)}`), seq: 0, total: 0 },
    daemons: [],
    callSeq: 0,
  }
  mkdirSync(world_.workspace, { recursive: true })
  mkdirSync(world_.appDir, { recursive: true })
  world = world_
  writeClock(world.clock, false)
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [create] -------------------------------------------------------------------------------------------

test('test_create_interval_and_cron_jobs_are_saved_listed_removed_and_survive_a_restart', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const first = await addJob(d, 'cr1', everyMinutes(30))
  await addJob(d, 'cr2', { type: 'cron', expression: '*/10 * * * *' })

  const showsInterval = (text: string): boolean => text.includes('sched-job-cr1') || /\b30\b|30\s*m|30\s*мин|1800000|1800\b/i.test(text)
  const showsCron = (text: string): boolean => text.includes('sched-job-cr2') || text.includes('*/10')

  const listed = await useTool(d, { kind: 'list' })
  expect(listed.isError, `schedule list must succeed\n${listed.text}`).toBe(false)
  expect(showsInterval(listed.text), `list shows the interval job\n${listed.text}`).toBe(true)
  expect(showsCron(listed.text), `list shows the cron job\n${listed.text}`).toBe(true)

  // the jobs live in the store: a new process of the daemon still has them
  await stopDaemon(d)
  const d2 = await startDaemon()
  const afterRestart = await useTool(d2, { kind: 'list' })
  expect(afterRestart.isError, `schedule list must succeed after the restart\n${afterRestart.text}`).toBe(false)
  expect(showsInterval(afterRestart.text), `the interval job survives the restart\n${afterRestart.text}`).toBe(true)
  expect(showsCron(afterRestart.text), `the cron job survives the restart\n${afterRestart.text}`).toBe(true)

  const id = idOf(first.text) ?? idOf(afterRestart.text, 'sched-job-cr1')
  expect(id, `the id of the interval job must be readable from the answers of the tool\n${first.text}\n${afterRestart.text}`).toBeDefined()

  const removed = await useTool(d2, { kind: 'remove', id: id as string })
  expect(removed.isError, `schedule remove must succeed\n${removed.text}`).toBe(false)

  const rest = await useTool(d2, { kind: 'list' })
  expect(rest.text, 'the removed job is gone from the list').not.toContain('sched-job-cr1')
  expect(showsCron(rest.text), `the other job stays\n${rest.text}`).toBe(true)
  expect(/every\s*30\s*m/i.test(rest.text), 'the removed interval is gone from the list').toBe(false)
})

// --- [fire] ---------------------------------------------------------------------------------------------

test('test_fire_a_due_job_makes_exactly_one_planned_turn_even_when_the_ticker_runs_twice', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.stub.jobs.set('fire', { kind: 'reply', text: 'FIRE-REPORT-1' })
  const d = await startOwnerDaemon()
  await addJob(d, 'fire', everyMinutes(10))

  await sleep(2_000)
  expect(runsOf('fire'), 'a job that is not due does not start').toBe(0)

  const mark = world.timeline.seq
  // the due time passes, and the ticker fires twice in a row at that very moment
  await advanceClock(11 * MINUTE_MS, d, true)
  await advanceClock(0, d, true)
  await waitPoking(
    'the report of the planned turn',
    () => ownerTextsSince(mark).some((text) => text.includes('FIRE-REPORT-1')),
    d,
  )
  await advanceClock(0, d, true)
  await quietFor(2_500)

  expect(runsOf('fire'), `exactly one planned turn for one due time\n${output(d)}`).toBe(1)
  expect(
    ownerTextsSince(mark).filter((text) => text.includes('FIRE-REPORT-1')),
    'the report reaches the owner once',
  ).toHaveLength(1)
})

// --- [silent] -------------------------------------------------------------------------------------------

test('test_silent_reply_of_a_planned_turn_is_not_sent_and_an_ordinary_one_is', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.stub.jobs.set('sil', { kind: 'reply', text: '[SILENT]' })
  world.stub.jobs.set('rep', { kind: 'reply', text: 'NEWS-REPORT-7' })
  const d = await startOwnerDaemon()
  await addJob(d, 'sil', everyMinutes(5))
  await addJob(d, 'rep', everyMinutes(5))

  const mark = world.timeline.seq
  await advanceClock(6 * MINUTE_MS, d, true)
  await waitPoking(
    'both planned turns to ask the model',
    () => runsOf('sil') >= 1 && runsOf('rep') >= 1,
    d,
  )
  await waitPoking(
    'the ordinary report of the planned turn',
    () => ownerTextsSince(mark).some((text) => text.includes('NEWS-REPORT-7')),
    d,
  )
  await quietFor(3_000)

  const texts = ownerTextsSince(mark)
  expect(texts.filter((text) => text.includes('NEWS-REPORT-7')), 'an ordinary reply is sent').toHaveLength(1)
  for (const text of texts) {
    expect(text, 'a reply marked SILENT is not sent to the owner').not.toContain('SILENT')
    expect(text, 'nothing is sent for the silent job').not.toContain('sched-job-sil')
  }
  expect(texts, 'the owner gets the one ordinary report and nothing else').toHaveLength(1)
})

// --- [confirm] ------------------------------------------------------------------------------------------

test('test_confirm_a_planned_turn_gets_a_refusal_at_once_and_no_approval_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { doomed, command } = doomedCommand()
  world.stub.jobs.set('conf', { kind: 'exec', command })
  const d = await startOwnerDaemon()

  // control: in the turn of the owner the same command asks for a card
  const control = beginTool({ kind: 'exec', command })
  const card = await waitForCard(d, control)
  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.deny))
  await resultOf(d, control)
  const cardsBefore = cardsIn(world.timeline, OWNER_CHAT).length
  expect(cardsBefore).toBe(1)

  await addJob(d, 'conf', everyMinutes(5))
  const mark = world.timeline.seq
  await advanceClock(6 * MINUTE_MS, d, true)
  await waitPoking(
    'the result of the exec call of the planned turn',
    () => {
      const outcome = world.stub.jobOutcomes.get('conf')
      return outcome?.result !== undefined || outcome?.missing !== undefined || outcome?.unmapped !== undefined
    },
    d,
  )
  const outcome = world.stub.jobOutcomes.get('conf') as Outcome
  expect(outcome.missing, 'the planned turn of the owner session offers exec').toBeUndefined()
  expect(outcome.unmapped, 'the input schema of exec fits the call').toBeUndefined()
  expectRefused(outcome.result as ToolResult, 'a confirm command in a planned turn')
  expect(outcome.result?.text).not.toContain('CONFIRMED-42')

  await quietFor(2_500)
  expect(existsSync(doomed), 'a refused command does not run').toBe(true)
  expect(cardsIn(world.timeline, OWNER_CHAT).length, 'no approval card in a planned turn').toBe(cardsBefore)
  const keyboards = world.timeline.events.filter(
    (e): e is TgEvent => e.src === 'tg' && e.n > mark && e.method === 'sendMessage' && e.params.reply_markup !== undefined,
  )
  expect(keyboards, 'no message with buttons in a planned turn').toHaveLength(0)
})

// --- [idle] ---------------------------------------------------------------------------------------------

test('test_idle_only_job_due_during_a_turn_of_the_owner_starts_after_that_turn_ends', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { command } = doomedCommand()
  world.stub.jobs.set('idle', { kind: 'reply', text: 'IDLE-REPORT-3' })
  const d = await startOwnerDaemon()
  await addJob(d, 'idle', everyMinutes(2), { idleOnly: true })

  // the owner turn waits for a button: it is going on while the job becomes due
  const pongsBefore = pongsTo(world.timeline, OWNER_CHAT).length
  const n = beginTool({ kind: 'exec', command })
  const card = await waitForCard(d, n)
  await advanceClock(3 * MINUTE_MS, d, true)
  await sleep(3_000)
  await advanceClock(0, d, true)
  await sleep(2_000)
  expect(runsOf('idle'), 'an idleOnly job does not start while the owner turn is going on').toBe(0)

  world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
  const result = await resultOf(d, n)
  expect(result.text, `the confirmed command runs\n${result.text}`).toContain('CONFIRMED-42')
  await waitFor('the end of the owner turn', () => pongsTo(world.timeline, OWNER_CHAT).length > pongsBefore, d)

  await waitPoking('the planned turn of the idleOnly job', () => runsOf('idle') >= 1, d)

  const ownerCalls = world.timeline.events.filter((e): e is DsEvent => {
    if (e.src !== 'ds' || e.body.stream === false) return false
    const turn = turnOf(e.body)
    return turn?.kind === 'tool' && turn.key === String(n)
  })
  expect(ownerCalls.length, 'the owner turn asked the model').toBeGreaterThan(0)
  const ownerEnd = Math.max(...ownerCalls.map((e) => e.n))
  const jobStart = Math.min(...jobCalls('idle').map((e) => e.n))
  expect(jobStart, 'the job asks the model only after the owner turn is over').toBeGreaterThan(ownerEnd)
  await waitFor(
    'the report of the job',
    () => ownerTextsSince(0).some((text) => text.includes('IDLE-REPORT-3')),
    d,
  )
})

// --- [dedup] --------------------------------------------------------------------------------------------

test('test_dedup_the_same_error_of_one_job_reaches_the_owner_once', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await addJob(d, 'err', everyMinutes(5))
  await stopDaemon(d)

  // the model service address is broken when the job comes round: the planned turn cannot be done, every time
  const d2 = await startDaemon({ env: { DEEPSEEK_BASE_URL: 'not a url' } })
  const mark = world.timeline.seq

  await advanceClock(6 * MINUTE_MS, d2, true)
  await waitPoking('the first failing planned turn to report', () => ownerTextsSince(mark).length >= 1, d2)
  await quietFor(6_000)
  const first = ownerTextsSince(mark)
  expect(first, `one message for the first error\n${first.join('\n---\n')}`).toHaveLength(1)

  // the job comes round again, twice, and fails in the same way
  for (let round = 0; round < 2; round += 1) {
    await advanceClock(6 * MINUTE_MS, d2, true)
    await sleep(3_000)
    await advanceClock(0, d2, true)
    await quietFor(4_000)
  }
  const later = ownerTextsSince(mark)
  expect(later, `the same error is not repeated\n${later.join('\n---\n')}`).toEqual(first)
})

// --- [h1] and [h2] --------------------------------------------------------------------------------------

test('test_h1_owner_turn_offers_exec_and_schedule_without_wake_script_and_the_own_shell_is_gone', { timeout: TEST_TIMEOUT_MS }, async () => {
  expect(existsSync(join(repoRoot, 'packages', 'app', 'src', 'exec-tool.ts')), 'the own shell of the schedule task is deleted').toBe(false)
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-h1')

  const probes = world.timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && e.body.stream !== false && JSON.stringify(e.body.messages).includes('owner-schema-probe-h1'),
  )
  expect(probes.length, 'the probe reached the model').toBeGreaterThan(0)
  const schemas = toolSchemas((probes[0] as DsEvent).body)
  expect(toolNames((probes[0] as DsEvent).body), 'the owner gets exec of the sandbox package').toContain('exec')
  expect(schemas.has('schedule'), 'the owner gets schedule').toBe(true)
  const schedule = schemas.get('schedule') as Schema
  for (const name of Object.keys(schedule.props)) expect(name, 'schedule has no wake_script').not.toMatch(/wake/i)
})

test('test_h2_exec_of_the_sandbox_runs_for_the_owner_next_to_schedule', { timeout: TEST_TIMEOUT_MS }, async () => {
  expect(existsSync(join(repoRoot, 'packages', 'app', 'exec-tool.test.ts')), 'the tests of the sandbox exec stay').toBe(true)
  expect(existsSync(join(repoRoot, 'packages', 'tools-exec', 'src', 'index.ts')), 'the sandbox exec package stays').toBe(true)
  const d = await startOwnerDaemon()

  const result = await useTool(d, { kind: 'exec', command: `echo H2-4''2` })
  expect(result.text, `an allowed command runs through exec\n${result.text}`).toContain('H2-42')

  const listed = await useTool(d, { kind: 'list' })
  expect(listed.isError, `schedule list answers in the same session\n${listed.text}`).toBe(false)
})

// --- [nogate] -------------------------------------------------------------------------------------------

test('test_nogate_schedule_has_no_wake_script_and_every_due_job_reaches_the_model', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.stub.jobs.set('nogate', { kind: 'reply', text: 'NOGATE-REPORT-5' })
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-nogate')

  const probes = world.timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && e.body.stream !== false && JSON.stringify(e.body.messages).includes('owner-schema-probe-nogate'),
  )
  expect(probes.length, 'the probe reached the model').toBeGreaterThan(0)
  const schedule = toolSchemas((probes[0] as DsEvent).body).get('schedule') as Schema
  expect(schedule, 'the owner gets schedule').toBeDefined()
  expect(JSON.stringify(schedule), 'the schema of schedule offers no wake script').not.toMatch(/wake/i)

  await addJob(d, 'nogate', everyMinutes(10))
  const mark = world.timeline.seq
  await advanceClock(11 * MINUTE_MS, d, true)
  await waitPoking(
    'the report of the planned turn',
    () => ownerTextsSince(mark).some((text) => text.includes('NOGATE-REPORT-5')),
    d,
  )
  expect(runsOf('nogate'), `a due job always calls the model, nothing skips it\n${output(d)}`).toBe(1)
})
