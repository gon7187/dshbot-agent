// Files sent to the owner's chat by the model: the `send_file` tool of main, of the own session of a task, of a
// planned turn (schedule) and of the analysis of attachments. The daemon runs as a child process against a fake
// Telegram Bot API and a DeepSeek stub (same harness as attachments-intake.test.ts and schedule-clock.test.ts).
//
// Contract the tests rely on (everything else is left to the implementation):
//   - the tool is called `send_file` with `path` (absolute, or relative to DSHBOT_HOME/workspace), an optional
//     `caption` and an optional `as` (document | photo | audio | voice); by default an image goes as a photo and
//     anything else as a document;
//   - the upload is a multipart request of sendPhoto / sendDocument / sendAudio / sendVoice into the owner chat, the
//     file part is named after the method (photo, document, audio, voice) and keeps the file name and the bytes;
//   - the answer of the tool carries the message_id of the sent message; a refusal is a tool error and no request
//     reaches the Bot API;
//   - the stub plays the model: a main turn is told by `own-<tag>` in the owner message, a planned turn by
//     `sched-job-<tag>` in the text of the job, the session of a task by `tsk-<tag>` (it offers task_complete), the
//     analysis of attachments by a `<file ` block, a guest by `gst-<tag>`; every one of them plays a script of tool
//     calls and then answers `fin <marker>`. A tool that is not in the request is first looked up with tool_search
//     (a lazy tool), except for forged calls of a guest;
//   - the clock is fake (preload of schedule-clock.test.ts): `advanceClock(ms)` moves Date and fires the due timers.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const RUN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000
const MB = 1024 * 1024
const MINUTE_MS = 60_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

// --- fixtures: png, pdf, csv -------------------------------------------------------------------------------

function buildPng(): Buffer {
  const size = 16
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * stride + 1 + x * 3
      raw[at] = 200
      raw[at + 1] = (x * 16) % 256
      raw[at + 2] = (y * 16) % 256
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A PDF with the binary comment line that real writers put after the header: bytes that are not valid UTF-8. */
function buildPdf(): Buffer {
  const stream = 'BT /F1 14 Tf 72 700 Td (SEND-PDF-BODY) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n%', 'latin1'),
    Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0xfe, 0x80, 0x00, 0x0a]),
    Buffer.from(out.slice('%PDF-1.4\n'.length), 'latin1'),
  ])
}

function buildCsv(): Buffer {
  return Buffer.from('город;сумма\r\nМосква;100\r\nСанкт-Петербург;250\r\n', 'utf8')
}

// --- timeline of everything the two fakes saw ------------------------------------------------------------------

interface Part {
  name: string
  filename?: string
  contentType?: string
  data: Buffer
}

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  /** JSON body, or the plain fields of a multipart form */
  params: JsonObject
  parts: Part[]
  /** message_id the fake handed out for a send */
  messageId?: number
}

type Role = 'main' | 'session' | 'judge' | 'intake' | 'guest' | 'other'

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
  role: Role
  marker: string
  /** index of the first message of the turn */
  from: number
  /** assistant messages of the turn that were not a tool_search */
  step: number
}

type Event = TgEvent | DsEvent

interface Timeline {
  events: Event[]
  seq: number
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

function parseObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // not json
  }
  return {}
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** The parts of a multipart body, bytes untouched. */
function parseMultipart(body: Buffer, contentType: string): Part[] {
  const found = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = found?.[1] ?? found?.[2]
  if (boundary === undefined) return []
  const opening = Buffer.from(`--${boundary}`)
  const parts: Part[] = []
  let at = body.indexOf(opening)
  while (at >= 0) {
    const start = at + opening.length
    if (body.subarray(start, start + 2).toString('latin1') === '--') break
    const headEnd = body.indexOf('\r\n\r\n', start)
    if (headEnd < 0) break
    const next = body.indexOf(`\r\n--${boundary}`, headEnd + 4)
    if (next < 0) break
    const head = body.subarray(start, headEnd).toString('utf8')
    const name = /[ ;]name="([^"]*)"/.exec(head)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename }),
      ...(type === undefined ? {} : { contentType: type.trim() }),
      data: Buffer.from(body.subarray(headEnd + 4, next)),
    })
    at = next + 2
  }
  return parts
}

// --- stream shapes of the model ------------------------------------------------------------------------------

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
      usage: { input_tokens: 4321, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 77 },
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

// --- reading requests of the model -------------------------------------------------------------------------------

/** Text blocks of a content (no tool results, no tool uses). */
function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const record = asObject(block)
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

function blocksOf(message: unknown): JsonObject[] {
  const content = asObject(message).content
  return Array.isArray(content) ? content.map(asObject) : []
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

function everything(body: JsonObject): string {
  return JSON.stringify(body.system ?? '') + JSON.stringify(messagesOf(body))
}

function userTexts(body: JsonObject): string {
  return messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => flatten(m.content))
    .join('\n')
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

/** The system prompt of a request: the field `system`, or the leading system messages. */
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

const OWNER_TURN_RE = /\b(?:own-[a-z0-9]+|sched-job-[a-z0-9]+)/
const TASK_RE = /\btsk-[a-z0-9]+/
const GUEST_RE = /\bgst-[a-z0-9]+/

/** The last user message with a marker of an owner turn or of a planned turn. */
function turnOf(body: JsonObject): { index: number; marker: string } | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const found = OWNER_TURN_RE.exec(flatten(message.content))
    if (found) return { index: at, marker: found[0] }
  }
  return undefined
}

/** Steps of the model since message `from`: assistant messages, and how many of them only searched for a tool. */
function stepOf(body: JsonObject, from: number): { step: number; searched: number } {
  let step = 0
  let searched = 0
  for (const message of messagesOf(body).slice(from)) {
    if (message.role !== 'assistant') continue
    const uses = blocksOf(message).filter((b) => b.type === 'tool_use')
    if (uses.length > 0 && uses.every((b) => b.name === 'tool_search')) searched += 1
    else step += 1
  }
  return { step, searched }
}

function classify(body: JsonObject): { role: Role; marker: string; from: number } {
  const names = toolNames(body)
  const taskMarker = TASK_RE.exec(everything(body))?.[0]
  if (taskMarker !== undefined && asObject(body.response_format).type === 'json_object') {
    return { role: 'judge', marker: `judge-${taskMarker}`, from: 0 }
  }
  if (names.includes('task_complete')) return { role: 'session', marker: taskMarker ?? 'tsk-none', from: 0 }
  const turn = turnOf(body)
  if (turn !== undefined) return { role: 'main', marker: turn.marker, from: turn.index + 1 }
  const guest = GUEST_RE.exec(userTexts(body))?.[0]
  if (guest !== undefined) return { role: 'guest', marker: guest, from: 0 }
  if (/<file |"type":"image"/.test(JSON.stringify(messagesOf(body)))) return { role: 'intake', marker: 'intake', from: 0 }
  if (taskMarker !== undefined && names.length === 0) return { role: 'judge', marker: `judge-${taskMarker}`, from: 0 }
  return { role: 'other', marker: '', from: 0 }
}

// --- mapping logical calls onto the input schemas of other tools --------------------------------------------------

const ACTION_NAMES = ['action', 'op', 'operation', 'command', 'mode', 'cmd']
const TEXT_NAMES = ['prompt', 'task', 'text', 'message', 'instruction', 'instructions', 'description', 'goal', 'content', 'body']
const SPEC_NAMES = ['schedule', 'spec', 'when', 'expression', 'timing', 'time']
const CREATE_VALUE = /^(?:create|add|new|set|schedule)$/i

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

function pickKey(schema: ToolSchema, names: readonly string[]): string | undefined {
  return names.find((name) => name in schema.properties)
}

function placeCreate(schema: ToolSchema, input: JsonObject): void {
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = enumValues(prop).find((v) => CREATE_VALUE.test(v))
    if (value !== undefined) {
      input[key] = value
      return
    }
  }
  const key = pickKey(schema, ACTION_NAMES)
  if (key !== undefined) input[key] = 'create'
}

function fillRequired(schema: ToolSchema, input: JsonObject): void {
  for (const key of schema.required) {
    if (key in input) continue
    const prop = schema.properties[key] ?? {}
    const choices = enumValues(prop)
    if (choices.length > 0) input[key] = choices[0]
    else if (isNumeric(prop)) input[key] = 1
    else if (prop.type === 'boolean') input[key] = false
    else if (prop.type === 'array') input[key] = []
    else input[key] = `test-${key}`
  }
}

function schemaOf(body: JsonObject, name: string): ToolSchema {
  const schema = toolSchemas(body).get(name)
  if (schema === undefined) throw new Error(`tool "${name}" is not offered: ${JSON.stringify(toolNames(body))}`)
  return schema
}

/** The `task` tool: a goal and the shell command of the acceptance check. */
function buildTask(body: JsonObject, goal: string, acceptance: string): JsonObject {
  const schema = schemaOf(body, 'task')
  const input: JsonObject = {}
  placeCreate(schema, input)
  const goalKey = pickKey(schema, ['goal', 'objective', 'task', 'description', 'prompt', 'text'])
  if (goalKey === undefined) throw new Error(`no goal property in ${JSON.stringify(schema.props)}`)
  input[goalKey] = goal
  const acceptKey = schema.props.find((key) => /accept|приёмк|приемк|verif/i.test(key))
  if (acceptKey === undefined) throw new Error(`no acceptance property in ${JSON.stringify(schema.props)}`)
  const acceptProp = schema.properties[acceptKey] ?? {}
  if (acceptProp.type === 'object') {
    const sub = asObject(acceptProp.properties)
    const object: JsonObject = {}
    let placed = false
    for (const [key, value] of Object.entries(sub)) {
      const choices = enumValues(asObject(value))
      if (choices.length > 0) {
        object[key] = choices.find((c) => /shell|command|cmd/i.test(c)) ?? choices[0]
      } else if (/command|cmd|shell|script|check/i.test(key)) {
        object[key] = acceptance
        placed = true
      }
    }
    if (!placed) {
      const first = Object.keys(sub).find((key) => asObject(sub[key]).type === 'string' && !(key in object))
      if (first === undefined) throw new Error(`no command property in the acceptance object ${JSON.stringify(Object.keys(sub))}`)
      object[first] = acceptance
    }
    input[acceptKey] = object
  } else {
    input[acceptKey] = acceptance
  }
  const originKey = schema.props.find((k) => /origin|источник/i.test(k))
  if (originKey !== undefined) {
    const choices = enumValues(schema.properties[originKey] ?? {})
    input[originKey] = choices.find((c) => /owner/i.test(c)) ?? 'owner'
  }
  fillRequired(schema, input)
  return input
}

function buildComplete(body: JsonObject, evidence: string): JsonObject {
  const schema = schemaOf(body, 'task_complete')
  const key = schema.props.find((k) => /evidence|доказ/i.test(k)) ?? schema.required[0] ?? 'evidence'
  const input: JsonObject = { [key]: evidence }
  fillRequired(schema, input)
  return input
}

/** The `schedule` tool: an interval job with the text of the job. */
function buildSchedule(body: JsonObject, minutes: number, text: string): JsonObject {
  const schema = schemaOf(body, 'schedule')
  const input: JsonObject = {}
  placeCreate(schema, input)
  const specKey = pickKey(schema, SPEC_NAMES)
  if (specKey === undefined) throw new Error(`no schedule property in ${JSON.stringify(schema.props)}`)
  input[specKey] = `every ${minutes}m`
  const textKey = pickKey(schema, TEXT_NAMES)
  if (textKey === undefined) throw new Error(`no text property in ${JSON.stringify(schema.props)}`)
  input[textKey] = text
  fillRequired(schema, input)
  return input
}

// --- the scripted model --------------------------------------------------------------------------------------------

interface ToolStep {
  tool: string
  input: JsonObject | ((body: JsonObject) => JsonObject)
  /** a forged call: made even when the request does not offer the tool */
  forge?: boolean
}

type Action = ToolStep | { text: string }

interface Stub {
  server: Server
  origin: string
  /** the script of every marker (`own-x`, `sched-job-x`, `tsk-x`, `gst-x`, `intake`) */
  scripts: Map<string, Action[]>
  /** scripts that could not be played */
  errors: string[]
}

type Reply = { text: string } | { tool: string; input: JsonObject }

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', scripts: new Map(), errors: [] }

  function answer(marker: string, body: JsonObject, from: number): Reply {
    const actions = stub.scripts.get(marker) ?? []
    const { step, searched } = stepOf(body, from)
    const action = actions[step]
    if (action === undefined) return { text: `fin ${marker}` }
    if ('text' in action) return { text: action.text }
    const offered = toolNames(body)
    if (action.forge !== true && !offered.includes(action.tool) && offered.includes('tool_search') && searched === 0) {
      return { tool: 'tool_search', input: { query: action.tool } }
    }
    try {
      return { tool: action.tool, input: typeof action.input === 'function' ? action.input(body) : action.input }
    } catch (error) {
      stub.errors.push(error instanceof Error ? error.message : String(error))
      return { text: `UNMAPPED ${marker}` }
    }
  }

  stub.server = createServer((req, res) => {
    void readBody(req).then((buffer) => {
      const body = parseObject(buffer.toString('utf8'))
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      const { role, marker, from } = classify(body)
      timeline.seq += 1
      timeline.events.push({ n: timeline.seq, src: 'ds', body, role, marker, from, step: stepOf(body, from).step })

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (role === 'judge') {
        res.end(textStream('{"verdict":"done","reason":"JUDGE-OK"}'))
        return
      }
      if (role === 'other') {
        res.end(textStream('pong'))
        return
      }
      const reply = answer(marker, body, from)
      if ('text' in reply) res.end(textStream(reply.text))
      else res.end(toolUseStream(`toolu_${timeline.seq}`, reply.tool, reply.input))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP --------------------------------------------------------------------------

interface QueuedUpdate {
  update: JsonObject
  delivered: boolean
}

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeFile {
  path: string
  data: Buffer
}

interface FakeTelegram {
  server: Server
  origin: string
  queue: QueuedUpdate[]
  holders: Holder[]
  polls: number
  sentIds: number
  /** files the bot may fetch, by file_id */
  files: Map<string, FakeFile>
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

function chatOf(params: JsonObject): number {
  const chat = Number(params.chat_id)
  return Number.isFinite(chat) ? chat : OWNER_CHAT
}

const FILE_METHODS = ['sendDocument', 'sendPhoto', 'sendAudio', 'sendVoice']
const SEND_METHODS = new Set(['sendMessage', 'sendRichMessage', ...FILE_METHODS])

function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
  if (SEND_METHODS.has(method)) {
    tg.sentIds += 1
    return {
      message_id: 9000 + tg.sentIds,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatOf(params), type: 'private' },
      text: '',
    }
  }
  if (method === 'getFile') {
    const id = String(params.file_id ?? '')
    const file = tg.files.get(id)
    return file === undefined
      ? undefined
      : { file_id: id, file_unique_id: `u-${id}`, file_size: file.data.length, file_path: file.path }
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
    files: new Map(),
    push(update) {
      tg.queue.push({ update, delivered: false })
      flushQueue(tg)
    },
  }
  tg.server = createServer((req, res) => {
    void readBody(req).then((buffer) => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      const reply = (status: number, body: string | Buffer, type = 'application/json'): void => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }

      const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(url)
      if (download !== null) {
        const path = decodeURIComponent(download[2] ?? '')
        const file = [...tg.files.values()].find((f) => f.path === path)
        if (decodeURIComponent(download[1] ?? '') !== BOT_TOKEN || file === undefined) {
          reply(404, JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
          return
        }
        reply(200, file.data, 'application/octet-stream')
        return
      }

      const match = /^\/bot(.+)\/([A-Za-z]+)$/.exec(url)
      const method = match?.[2] ?? ''
      const contentType = String(req.headers['content-type'] ?? '')
      const parts = contentType.includes('multipart/') ? parseMultipart(buffer, contentType) : []
      const params: JsonObject = contentType.includes('multipart/')
        ? Object.fromEntries(parts.filter((p) => p.filename === undefined).map((p) => [p.name, p.data.toString('utf8')]))
        : parseObject(buffer.toString('utf8'))
      timeline.seq += 1
      const event: TgEvent = { n: timeline.seq, src: 'tg', method, params, parts }
      timeline.events.push(event)

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
      if (method === 'getFile' && !tg.files.has(String(params.file_id ?? ''))) {
        reply(400, JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file_id' }))
        return
      }
      const result = okResult(tg, method, params)
      if (SEND_METHODS.has(method)) event.messageId = (result as { message_id: number }).message_id
      reply(200, JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

// --- updates of the owner ------------------------------------------------------------------------------------------

let nextMessageId = 100
let updateCounter = 5000
let fileCounter = 0

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

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
}

/** The owner sends a document; the fake serves it by getFile. */
function ownerSendsDocument(data: Buffer, name: string, mime: string): void {
  fileCounter += 1
  const id = `zzfile${fileCounter}`
  world.tg.files.set(id, { path: `documents/${id}`, data })
  updateCounter += 1
  nextMessageId += 1
  world.tg.push({
    update_id: updateCounter,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      document: { file_id: id, file_unique_id: `u-${id}`, file_name: name, mime_type: mime, file_size: data.length },
    },
  })
}

// --- reading what the fakes received -------------------------------------------------------------------------------------

function tgEvents(): TgEvent[] {
  return world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

function dsEvents(marker: string): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.marker === marker)
}

function sentTo(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && chatOf(e.params) === chatId)
}

function textOf(event: TgEvent): string {
  return deepStrings(event.params).join('\n')
}

/** Every upload of a file to any chat. */
function fileSends(): TgEvent[] {
  return tgEvents().filter((e) => FILE_METHODS.includes(e.method))
}

/** The file part of an upload. */
function filePartOf(event: TgEvent): Part {
  const part = event.parts.find((p) => p.filename !== undefined)
  expect(part, `${event.method} must carry a file part: ${JSON.stringify(event.parts.map((p) => p.name))}`).toBeDefined()
  return part as Part
}

/** The upload arrived in the owner chat by `method`, under the field `field`, with these bytes and this name. */
function expectUpload(event: TgEvent | undefined, method: string, field: string, name: string, data: Buffer): void {
  expect(event, `no upload of ${name}`).toBeDefined()
  const sent = event as TgEvent
  expect(sent.method, `${name} goes by ${method}`).toBe(method)
  expect(chatOf(sent.params), 'into the chat of the owner').toBe(OWNER_CHAT)
  const part = filePartOf(sent)
  expect(part.name, `the file part of ${method} is called ${field}`).toBe(field)
  expect(part.filename, 'the file name is kept').toBe(name)
  expect(part.data.length, `the size of ${name}`).toBe(data.length)
  expect(Buffer.compare(part.data, data), `the bytes of ${name} arrive unchanged`).toBe(0)
}

interface ToolOutcome {
  name: string
  text: string
  isError: boolean
}

/** Results of the tool calls of the last request of a turn, in order. */
function outcomesOf(marker: string): ToolOutcome[] {
  const events = dsEvents(marker)
  const last = events[events.length - 1]
  if (last === undefined) return []
  const names = new Map<string, string>()
  const found: ToolOutcome[] = []
  for (const message of messagesOf(last.body).slice(last.from)) {
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use') names.set(String(block.id), String(block.name))
      if (block.type === 'tool_result') {
        found.push({
          name: names.get(String(block.tool_use_id)) ?? '',
          text: flatten(block.content),
          isError: block.is_error === true,
        })
      }
    }
  }
  return found
}

function sendResults(marker: string): ToolOutcome[] {
  return outcomesOf(marker).filter((o) => o.name === 'send_file')
}

/** The model has been asked again after `steps` actions of the script of the marker: its results are in. */
function reached(marker: string, steps: number): boolean {
  return dsEvents(marker).some((e) => e.step >= steps)
}

// --- the fake clock of the daemon (the preload of schedule-clock.test.ts) -----------------------------------------------------

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

// --- the daemon as a child process ------------------------------------------------------------------------------------

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
  workspace: string
  runtimeDir: string
  clock: Clock
  daemons: Daemon[]
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
    XDG_RUNTIME_DIR: world.runtimeDir,
    FAKE_CLOCK_CONTROL: world.clock.control,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}`,
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
  const sends = fileSends().map((e) => `${e.method}:${e.parts.map((p) => p.filename ?? p.name).join(',')}`)
  return [
    `--- stdout ---\n${d.stdout.slice(-3000)}`,
    `--- stderr ---\n${d.stderr.slice(-3000)}`,
    `--- stub errors ---\n${world.stub.errors.join('\n')}`,
    `--- file sends ---\n${sends.join('\n')}`,
  ].join('\n')
}

async function waitFor(what: string, cond: () => boolean, d: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${output(d)}`).toBe(true)
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

async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
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
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(): Promise<Daemon> {
  const d = await startDaemon()
  await pairOwner(d)
  return d
}

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

/** The owner invites a guest chat; returns once the guest chat has been greeted. */
async function joinGuest(d: Daemon, chatId: number): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  const invitation = (): string[] =>
    codeLike(
      sentTo(OWNER_CHAT)
        .filter((e) => e.n > mark)
        .map(textOf),
    )
  await waitFor('an invitation code in the owner chat', () => invitation().length > 0, d)
  const code = invitation()[0] as string
  const before = sentTo(chatId).length
  say(chatId, code)
  await waitFor(`a greeting in chat ${chatId}`, () => sentTo(chatId).length > before, d)
}

// --- files of the workspace ---------------------------------------------------------------------------------------------------

/** Writes a file under the workspace of the owner and returns its absolute path. */
function put(relative: string, data: Buffer | string): string {
  const target = join(world.workspace, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, data)
  return target
}

function sendStep(input: JsonObject): ToolStep {
  return { tool: 'send_file', input }
}

// --- harness lifecycle -----------------------------------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-sendfile-test-')))
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
  const workspace = join(dshbotHome, 'workspace')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace,
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    clock: { control: join(scratch, `clock-${Math.random().toString(36).slice(2)}`), seq: 0, total: 0 },
    daemons: [],
  }
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
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

// --- [send] ----------------------------------------------------------------------------------------------------------------------------

test('test_send_png_pdf_and_csv_of_the_workspace_reach_the_bot_api_byte_for_byte_by_the_right_method', { timeout: TEST_TIMEOUT_MS }, async () => {
  const png = buildPng()
  const pdf = buildPdf()
  const csv = buildCsv()
  const pngPath = put('outbox/chart.png', png)
  const pdfPath = put('outbox/report.pdf', pdf)
  const csvPath = put('downloads/table.csv', csv)
  world.stub.scripts.set('own-sendfiles', [
    sendStep({ path: pngPath, caption: 'CAPTION-PNG график продаж' }),
    sendStep({ path: pdfPath, caption: 'CAPTION-PDF отчёт' }),
    sendStep({ path: csvPath, caption: 'CAPTION-CSV таблица' }),
  ])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-sendfiles пришли график, отчёт и таблицу файлами')
  await waitFor('the turn to end after three sends', () => reached('own-sendfiles', 3), d, RUN_WAIT_MS)

  const sends = fileSends()
  expect(sends.map((e) => e.method), `three uploads, one per file\n${output(d)}`).toEqual(['sendPhoto', 'sendDocument', 'sendDocument'])
  expectUpload(sends[0], 'sendPhoto', 'photo', 'chart.png', png)
  expectUpload(sends[1], 'sendDocument', 'document', 'report.pdf', pdf)
  expectUpload(sends[2], 'sendDocument', 'document', 'table.csv', csv)
  expect(sends[0]?.params.caption, 'the caption of the photo arrives').toBe('CAPTION-PNG график продаж')
  expect(sends[1]?.params.caption, 'the caption of the pdf arrives').toBe('CAPTION-PDF отчёт')
  expect(sends[2]?.params.caption, 'the caption of the csv arrives').toBe('CAPTION-CSV таблица')

  const results = sendResults('own-sendfiles')
  expect(results, 'the model got an answer for every call').toHaveLength(3)
  results.forEach((result, i) => {
    expect(result.isError, `send_file must succeed: ${result.text}`).toBe(false)
    expect(result.text, 'the answer names the message_id of the sent message').toContain(String(sends[i]?.messageId))
  })
})

test('test_send_as_overrides_the_default_method_of_the_mime_type', { timeout: TEST_TIMEOUT_MS }, async () => {
  const png = buildPng()
  const song = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0xff, 0xfb, 0x90, 0x00, 0x80, 0x81, 0x82])
  const note = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xfe, 0xff, 0x80, 0x00])
  const pngPath = put('outbox/plain.png', png)
  const songPath = put('outbox/song.mp3', song)
  const notePath = put('outbox/note.ogg', note)
  world.stub.scripts.set('own-sendas', [
    sendStep({ path: pngPath, as: 'document' }),
    sendStep({ path: songPath, as: 'audio', caption: 'CAPTION-SONG' }),
    sendStep({ path: notePath, as: 'voice' }),
  ])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-sendas пришли картинку документом, песню и голосовое')
  await waitFor('the turn to end after three sends', () => reached('own-sendas', 3), d, RUN_WAIT_MS)

  const sends = fileSends()
  expect(sends.map((e) => e.method), `the method follows "as"\n${output(d)}`).toEqual(['sendDocument', 'sendAudio', 'sendVoice'])
  expectUpload(sends[0], 'sendDocument', 'document', 'plain.png', png)
  expectUpload(sends[1], 'sendAudio', 'audio', 'song.mp3', song)
  expectUpload(sends[2], 'sendVoice', 'voice', 'note.ogg', note)
  expect(sends[1]?.params.caption).toBe('CAPTION-SONG')
})

// --- [paths] ---------------------------------------------------------------------------------------------------------------------------

test('test_paths_outside_of_the_workspace_symlinks_dotdot_and_big_files_are_refused_without_a_request', { timeout: TEST_TIMEOUT_MS }, async () => {
  const secret = 'PATHS-SECRET-BODY\n'
  const outside = join(world.home, 'outside-secret.txt')
  writeFileSync(outside, secret)
  const upFromWorkspace = join(world.dshbotHome, 'outside-up.txt')
  writeFileSync(upFromWorkspace, secret)
  const config = join(world.dshbotHome, '.config', 'secret.json')
  mkdirSync(dirname(config), { recursive: true })
  writeFileSync(config, '{"token":"PATHS-SECRET-BODY"}\n')
  const outsideDir = join(world.home, 'outside-dir')
  mkdirSync(outsideDir)
  writeFileSync(join(outsideDir, 'inner.txt'), secret)

  mkdirSync(world.workspace, { recursive: true })
  symlinkSync(outside, join(world.workspace, 'link-out.txt'))
  symlinkSync(outsideDir, join(world.workspace, 'link-dir'))
  const huge = join(world.workspace, 'downloads', 'huge.bin')
  mkdirSync(dirname(huge), { recursive: true })
  writeFileSync(huge, '')
  truncateSync(huge, 51 * MB)
  const folder = join(world.workspace, 'outbox')
  mkdirSync(folder, { recursive: true })
  const good = put('downloads/ok.txt', 'PATHS-GOOD-BODY\n')

  const bad: Array<{ what: string; path: string }> = [
    { what: 'an absolute path outside the workspace', path: outside },
    { what: 'a relative path with ..', path: '../outside-up.txt' },
    { what: 'an absolute path with .. out of the workspace', path: join(world.workspace, '..', 'outside-up.txt') },
    { what: 'a symlink to a file outside', path: join(world.workspace, 'link-out.txt') },
    { what: 'a file behind a symlink to a directory outside', path: join(world.workspace, 'link-dir', 'inner.txt') },
    { what: 'a file of DSHBOT_HOME/.config', path: config },
    { what: 'a file over 50 MB', path: huge },
    { what: 'a directory', path: folder },
    { what: 'a file that does not exist', path: join(world.workspace, 'downloads', 'missing.txt') },
  ]
  world.stub.scripts.set('own-sendpaths', [...bad.map((b) => sendStep({ path: b.path })), sendStep({ path: good })])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-sendpaths пришли все эти файлы')
  await waitFor('the turn to end after ten calls', () => reached('own-sendpaths', bad.length + 1), d, RUN_WAIT_MS)

  const results = sendResults('own-sendpaths')
  expect(results, `every call got an answer\n${output(d)}`).toHaveLength(bad.length + 1)
  bad.forEach((b, i) => {
    const result = results[i] as ToolOutcome
    expect(result.isError, `${b.what} must be a tool error: ${result.text}`).toBe(true)
    expect(result.text.trim().length, `${b.what}: the error says why`).toBeGreaterThan(0)
  })
  expect(results[6]?.text, 'the error of the big file names the limit').toMatch(/50|МБ|MB|лимит|limit|больш|размер|large|size/i)

  // only the control file reached the Bot API: no request for any refused path, and none carries the secret
  const sends = fileSends()
  expect(sends, 'a refused path makes no upload').toHaveLength(1)
  expectUpload(sends[0], 'sendDocument', 'document', 'ok.txt', Buffer.from('PATHS-GOOD-BODY\n'))
  expect(results[bad.length]?.isError, `the control file is sent: ${results[bad.length]?.text}`).toBe(false)
  for (const event of tgEvents()) {
    for (const part of event.parts) expect(part.data.toString('latin1'), 'no secret leaves in a request').not.toContain('PATHS-SECRET-BODY')
  }
})

// --- [lanes] ---------------------------------------------------------------------------------------------------------------------------

test('test_lanes_main_offers_send_file_and_sends_a_file_of_the_workspace', { timeout: TEST_TIMEOUT_MS }, async () => {
  const csv = buildCsv()
  const csvPath = put('main-lane.csv', csv)
  world.stub.scripts.set('own-lanemain', [sendStep({ path: csvPath, caption: 'CAPTION-LANE-MAIN' })])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-lanemain пришли csv файлом')
  await waitFor('the turn of main to end', () => reached('own-lanemain', 1), d, RUN_WAIT_MS)

  const last = dsEvents('own-lanemain').at(-1) as DsEvent
  expect(toolNames(last.body), 'main offers send_file (at once or after tool_search)').toContain('send_file')
  const sends = fileSends()
  expect(sends, `one upload\n${output(d)}`).toHaveLength(1)
  expectUpload(sends[0], 'sendDocument', 'document', 'main-lane.csv', csv)
  expect(sends[0]?.params.caption).toBe('CAPTION-LANE-MAIN')
})

test('test_lanes_task_session_offers_send_file_and_sends_a_file_of_the_workspace', { timeout: TEST_TIMEOUT_MS }, async () => {
  const png = buildPng()
  const pngPath = put('task-lane.png', png)
  world.stub.scripts.set('own-lanetask', [
    { tool: 'task', input: (body) => buildTask(body, 'tsk-lanetask: пришли график файлом', 'true') },
  ])
  world.stub.scripts.set('tsk-lanetask', [
    sendStep({ path: pngPath, caption: 'CAPTION-LANE-TASK' }),
    { tool: 'task_complete', input: (body) => buildComplete(body, 'EVID-LANE-TASK') },
  ])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-lanetask создай задачу: пришли график файлом')
  await waitFor('the session of the task to see the result of send_file', () => reached('tsk-lanetask', 1), d, RUN_WAIT_MS)

  const last = dsEvents('tsk-lanetask').at(-1) as DsEvent
  expect(toolNames(last.body), 'the session of a task offers send_file').toContain('send_file')
  const sends = fileSends()
  expect(sends, `one upload from the session of the task\n${output(d)}`).toHaveLength(1)
  expectUpload(sends[0], 'sendPhoto', 'photo', 'task-lane.png', png)
  expect(sends[0]?.params.caption).toBe('CAPTION-LANE-TASK')
  const result = sendResults('tsk-lanetask')[0]
  expect(result?.isError, `send_file works in the session of the task: ${result?.text}`).toBe(false)
  expect(result?.text).toContain(String(sends[0]?.messageId))
})

test('test_lanes_planned_turn_offers_send_file_and_sends_a_file_of_the_workspace', { timeout: TEST_TIMEOUT_MS }, async () => {
  const pdf = buildPdf()
  const pdfPath = put('schedule-lane.pdf', pdf)
  world.stub.scripts.set('own-lanesched', [
    { tool: 'schedule', input: (body) => buildSchedule(body, 10, 'sched-job-lanesched пришли отчёт файлом') },
  ])
  world.stub.scripts.set('sched-job-lanesched', [sendStep({ path: pdfPath, caption: 'CAPTION-LANE-SCHED' })])
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-lanesched каждые десять минут присылай отчёт файлом')
  await waitFor('the schedule to be created', () => reached('own-lanesched', 1), d, RUN_WAIT_MS)
  expect(fileSends(), 'nothing is sent before the job is due').toHaveLength(0)

  await advanceClock(11 * MINUTE_MS, d, true)
  await waitPoking('the planned turn to send the file', () => reached('sched-job-lanesched', 1), d)

  const last = dsEvents('sched-job-lanesched').at(-1) as DsEvent
  expect(toolNames(last.body), 'a planned turn offers send_file').toContain('send_file')
  const sends = fileSends()
  expect(sends, `one upload from the planned turn\n${output(d)}`).toHaveLength(1)
  expectUpload(sends[0], 'sendDocument', 'document', 'schedule-lane.pdf', pdf)
  expect(sends[0]?.params.caption).toBe('CAPTION-LANE-SCHED')
  const result = sendResults('sched-job-lanesched')[0]
  expect(result?.isError, `send_file works in a planned turn: ${result?.text}`).toBe(false)
})

test('test_lanes_intake_offers_send_file_and_sends_a_binary_file_of_the_workspace_as_an_attachment', { timeout: TEST_TIMEOUT_MS }, async () => {
  const png = buildPng()
  const pngPath = put('outbox/zzlane-chart.png', png)
  world.stub.scripts.set('intake', [sendStep({ path: pngPath, caption: 'CAPTION-LANE-INTAKE' })])
  const d = await startOwnerDaemon()
  ownerSendsDocument(Buffer.from('lane intake body\n'), 'zzlane-in.txt', 'text/plain')
  await waitFor('the analysis to see the result of send_file', () => reached('intake', 1), d, RUN_WAIT_MS)

  const first = dsEvents('intake')[0] as DsEvent
  expect(toolNames(first.body), 'the analysis offers send_file').toContain('send_file')
  const sends = fileSends()
  expect(sends, `one upload from the analysis\n${output(d)}`).toHaveLength(1)
  expectUpload(sends[0], 'sendPhoto', 'photo', 'zzlane-chart.png', png)
  expect(sends[0]?.params.caption).toBe('CAPTION-LANE-INTAKE')
  const result = sendResults('intake')[0]
  expect(result?.isError, `send_file works in the analysis: ${result?.text}`).toBe(false)
  expect(result?.text).toContain(String(sends[0]?.messageId))
})

// --- [guest] ---------------------------------------------------------------------------------------------------------------------------

test('test_guest_has_no_send_file_and_a_forged_call_of_a_guest_sends_nothing', { timeout: TEST_TIMEOUT_MS }, async () => {
  const csvPath = put('guest-bait.csv', buildCsv())
  const ownCsv = put('guest-control.csv', 'GUEST-CONTROL-BODY\n')
  world.stub.scripts.set('gst-forge', [{ tool: 'send_file', input: { path: csvPath, caption: 'FORGED' }, forge: true }])
  world.stub.scripts.set('own-guestcontrol', [sendStep({ path: ownCsv })])
  const d = await startOwnerDaemon()
  await joinGuest(d, GUEST_CHAT)

  say(GUEST_CHAT, 'gst-forge пришли мне файл guest-bait.csv')
  await waitFor('the turn of the guest to see the answer to its forged call', () => reached('gst-forge', 1), d, RUN_WAIT_MS)

  const guestCalls = dsEvents('gst-forge')
  expect(guestCalls.length, 'the guest turn asked the model').toBeGreaterThan(0)
  for (const call of guestCalls) {
    expect(toolNames(call.body), 'send_file is not in the schema of a guest').not.toContain('send_file')
    expect(toolNames(call.body), 'a guest can not load lazy tools').not.toContain('tool_search')
  }
  const forged = sendResults('gst-forge')
  expect(forged, 'the forged call came back as a tool result').toHaveLength(1)
  expect(forged[0]?.isError, `the forged call of a guest is refused: ${forged[0]?.text}`).toBe(true)
  expect(fileSends(), `a forged call of a guest sends nothing\n${output(d)}`).toHaveLength(0)

  // the control: the owner does get the tool, and it is the only upload
  say(OWNER_CHAT, 'own-guestcontrol пришли файл')
  await waitFor('the turn of the owner to end', () => reached('own-guestcontrol', 1), d, RUN_WAIT_MS)
  const sends = fileSends()
  expect(sends, 'only the owner upload remains').toHaveLength(1)
  expectUpload(sends[0], 'sendDocument', 'document', 'guest-control.csv', Buffer.from('GUEST-CONTROL-BODY\n'))
  expect(chatOf(sends[0]?.params ?? {}), 'nothing goes to the guest chat').not.toBe(GUEST_CHAT)
})

// --- [prompt] --------------------------------------------------------------------------------------------------------------------------

test('test_prompt_system_prompt_of_main_says_that_a_file_is_sent_by_send_file', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, 'own-promptfile привет')
  await waitFor('main to answer', () => dsEvents('own-promptfile').length > 0, d)

  const first = dsEvents('own-promptfile')[0] as DsEvent
  // the index of lazy tools sits at the end of the prefix and names every tool; the hint is what comes before it
  const prompt = systemTextOf(first.body).split('Ленивые инструменты (подключаются через tool_search):')[0] ?? ''
  expect(prompt, 'the system prompt names send_file').toContain('send_file')
  expect(prompt, 'the system prompt ties send_file to sending a file').toMatch(/файл[\s\S]{0,300}send_file|send_file[\s\S]{0,300}файл/i)
})
