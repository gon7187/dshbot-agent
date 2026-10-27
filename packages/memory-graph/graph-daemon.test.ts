// The graph tool of the bot over the real MCP server-memory from node_modules: file location, search/open/remove,
// the environment of the server process, its life cycle, and the tool seam (an ordinary tool of main, none for a guest).
// Same harness as packages/app/exec-tool.test.ts: the daemon runs as a child process against a fake Telegram Bot API
// and a local DeepSeek stub. The stub plays the model: for a message `run-tool-N` it answers with one call of the
// tool `graph`, mapping the logical call onto whatever input schema the request offers, reads the tool result
// from the next request and answers `pong`. Effects are checked on disk and in /proc.
//
// Accepted shapes of the schema:
//   action      a property whose enum has search|open|add|remove (or a string property named action);
//   search      the text in query|q|term|text|keyword|search|pattern|name;
//   open/remove the entity in names|entityNames|name|entity|entities|nodes|query (an array or a scalar);
//   add         entities (objects name/entityType/observations), relations (from/to/relationType) and
//               observations (strings, or objects entityName/contents) as far as the schema has them.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000
const EXIT_LIMIT_MS = 15_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the facts the tests put into the graph ----------------------------------------------------------------

const ALICE = 'Alice Tester77'
const ALICE_TYPE = 'person'
const NIMBUS = 'Project Nimbus77'
const NIMBUS_TYPE = 'project'
const RELATION = 'works_on'
const WORD = 'zorblaxium'
const ALICE_FACT = `prefers ${WORD} tea in the morning`
const NIMBUS_FACT = 'is a cloud migration effort'

interface EntitySpec {
  name: string
  type: string
  observations: string[]
}

interface RelationSpec {
  from: string
  to: string
  type: string
}

const ENTITIES: EntitySpec[] = [
  { name: ALICE, type: ALICE_TYPE, observations: [ALICE_FACT] },
  { name: NIMBUS, type: NIMBUS_TYPE, observations: [NIMBUS_FACT] },
]
const RELATIONS: RelationSpec[] = [{ from: ALICE, to: NIMBUS, type: RELATION }]

// --- timeline of everything the two fake servers saw -------------------------------------------------------

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

// --- the scripted model ------------------------------------------------------------------------------------

/** One graph call in logical terms; the stub maps the names onto the real input schema. */
type GraphCall =
  | { kind: 'search'; query: string; force?: boolean }
  | { kind: 'open'; name: string; force?: boolean }
  | { kind: 'add'; entities: EntitySpec[]; relations: RelationSpec[]; force?: boolean }
  | { kind: 'remove'; name: string; force?: boolean }

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
  calls: Map<number, GraphCall>
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

/** The schema of the items of an array property (the first object alternative of an anyOf/oneOf). */
function itemsOf(prop: JsonObject): JsonObject {
  const items = asObject(prop.items)
  for (const key of ['oneOf', 'anyOf']) {
    const alternatives = items[key]
    if (Array.isArray(alternatives)) {
      const object = alternatives.map(asObject).find((alt) => alt.properties !== undefined || alt.type === 'object')
      if (object !== undefined) return object
    }
  }
  return items
}

function isArrayProp(prop: JsonObject): boolean {
  return prop.type === 'array' || prop.items !== undefined
}

function isObjectItems(prop: JsonObject): boolean {
  const items = itemsOf(prop)
  return items.type === 'object' || items.properties !== undefined
}

const NAME_KEY = /^(?:name|entityName|entity_name|entity|id)$/i
const TYPE_KEY = /^(?:entityType|entity_type|type|kind)$/i
const OBSERVATIONS_KEY = /^(?:observations|contents|facts|notes)$/i
const FROM_KEY = /^(?:from|source|subject|fromEntity|from_entity)$/i
const TO_KEY = /^(?:to|target|object|toEntity|to_entity)$/i
const RELATION_TYPE_KEY = /^(?:relationType|relation_type|relation|type|predicate|kind)$/i

function fillEntity(item: JsonObject, entity: EntitySpec): JsonObject {
  const fields = asObject(item.properties)
  if (Object.keys(fields).length === 0) return { name: entity.name, entityType: entity.type, observations: entity.observations }
  const out: JsonObject = {}
  for (const [key, prop] of Object.entries(fields)) {
    if (NAME_KEY.test(key)) out[key] = entity.name
    else if (TYPE_KEY.test(key)) out[key] = entity.type
    else if (OBSERVATIONS_KEY.test(key)) out[key] = asObject(prop).type === 'string' ? entity.observations.join('; ') : entity.observations
  }
  return out
}

function fillRelation(item: JsonObject, relation: RelationSpec): JsonObject {
  const fields = asObject(item.properties)
  if (Object.keys(fields).length === 0) return { from: relation.from, to: relation.to, relationType: relation.type }
  const out: JsonObject = {}
  for (const key of Object.keys(fields)) {
    if (FROM_KEY.test(key)) out[key] = relation.from
    else if (TO_KEY.test(key)) out[key] = relation.to
    else if (RELATION_TYPE_KEY.test(key)) out[key] = relation.type
  }
  return out
}

function fillObservation(item: JsonObject, entity: EntitySpec): JsonObject {
  const fields = asObject(item.properties)
  if (Object.keys(fields).length === 0) return { entityName: entity.name, contents: entity.observations }
  const out: JsonObject = {}
  for (const [key, prop] of Object.entries(fields)) {
    if (NAME_KEY.test(key)) out[key] = entity.name
    else if (OBSERVATIONS_KEY.test(key)) out[key] = asObject(prop).type === 'string' ? entity.observations.join('; ') : entity.observations
  }
  return out
}

function buildAdd(schema: Schema, call: Extract<GraphCall, { kind: 'add' }>): JsonObject {
  const input: JsonObject = {}
  for (const [key, prop] of Object.entries(schema.props)) {
    if (/^entities$/i.test(key)) {
      input[key] = call.entities.map((entity) => fillEntity(itemsOf(prop), entity))
    } else if (/^(?:relations|relationships|links)$/i.test(key)) {
      input[key] = call.relations.map((relation) => fillRelation(itemsOf(prop), relation))
    } else if (/^observations$/i.test(key)) {
      input[key] = isObjectItems(prop)
        ? call.entities.map((entity) => fillObservation(itemsOf(prop), entity))
        : call.entities.flatMap((entity) => entity.observations)
    } else if (/^(?:name|entity|entityName|entity_name)$/i.test(key)) {
      input[key] = call.entities[0]?.name
    } else if (/^(?:entityType|entity_type)$/i.test(key)) {
      input[key] = call.entities[0]?.type
    }
  }
  return input
}

/** The entity name for open and remove, in the shape of the first property that can carry it. */
function buildTarget(schema: Schema, name: string): JsonObject {
  for (const candidate of ['names', 'entityNames', 'entity_names', 'name', 'entity', 'entities', 'nodes', 'query']) {
    const prop = schema.props[candidate]
    if (prop === undefined) continue
    if (!isArrayProp(prop)) return { [candidate]: name }
    return { [candidate]: [isObjectItems(prop) ? fillEntity(itemsOf(prop), { name, type: '', observations: [] }) : name] }
  }
  return {}
}

function buildSearch(schema: Schema, query: string): JsonObject {
  for (const candidate of ['query', 'q', 'term', 'text', 'keyword', 'search', 'pattern', 'name']) {
    if (candidate in schema.props) return { [candidate]: query }
  }
  return {}
}

function placeCall(call: GraphCall, schemas: Map<string, Schema>): { name: string; input: JsonObject } | { missing: string } | string {
  const schema = schemas.get('graph')
  if (schema === undefined) {
    if (call.force === true) return { name: 'graph', input: legacyInput(call) }
    return { missing: `tool "graph" is not in tools[]: ${JSON.stringify([...schemas.keys()])}` }
  }
  const actionKey =
    Object.keys(schema.props).find((key) => enumValues(schema.props[key] as JsonObject).includes('search')) ??
    Object.keys(schema.props).find((key) => /^(?:action|op|operation|mode|command)$/i.test(key))
  if (actionKey === undefined) return `no action property in the input schema of graph: ${JSON.stringify(Object.keys(schema.props))}`

  const filled =
    call.kind === 'search'
      ? buildSearch(schema, call.query)
      : call.kind === 'add'
        ? buildAdd(schema, call)
        : buildTarget(schema, call.name)
  if (Object.keys(filled).length === 0) return `the ${call.kind} call has no place in the input schema of graph: ${JSON.stringify(Object.keys(schema.props))}`
  return { name: 'graph', input: { [actionKey]: call.kind, ...filled } }
}

/** What a model inventing a tool_use of an unoffered tool would send. */
function legacyInput(call: GraphCall): JsonObject {
  if (call.kind === 'search') return { action: 'search', query: call.query }
  if (call.kind === 'add') {
    return {
      action: 'add',
      entities: call.entities.map((e) => ({ name: e.name, entityType: e.type, observations: e.observations })),
      relations: call.relations.map((r) => ({ from: r.from, to: r.to, relationType: r.type })),
    }
  }
  return { action: call.kind, names: [call.name], name: call.name }
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
  /** tool_search calls of the stub, by tool_use id, to the scripted call they load graph for */
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
      // graph is lazy for the owner: the stub loads it with tool_search first
      // and places the scripted call in the request that follows the result
      const searchedFor = result === undefined ? undefined : searching.get(result.id)
      if (searchedFor !== undefined) {
        searching.delete((result as { id: string }).id)
        place(searchedFor, stub.calls.get(searchedFor) as GraphCall, stub.outcomes.get(searchedFor) as Outcome, body)
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
      if (!toolSchemas(body).has('graph') && call.force !== true && offersLazy(body, 'graph')) {
        const id = `toolu_search_${n}`
        searching.set(id, n)
        res.end(toolUseStream(id, 'tool_search', { query: 'graph' }))
        return
      }
      place(n, call, outcome, body)
    })
    function place(n: number, call: GraphCall, outcome: Outcome, body: JsonObject): void {
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

// --- fake Telegram Bot API over local HTTP -----------------------------------------------------------------

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

// --- update builders and readers ---------------------------------------------------------------------------

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

function modelRequests(timeline: Timeline): DsEvent[] {
  return timeline.events.filter((e): e is DsEvent => e.src === 'ds' && Array.isArray(e.body.tools))
}

// --- the daemon as a child process -------------------------------------------------------------------------

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
  runtimeDir: string
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

/** The owner invites a guest; returns once the guest is greeted. */
async function admitGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation code in the owner chat', () => codeLike(textsSince(mark, OWNER_CHAT)).length > 0, d)
  const code = codeLike(textsSince(mark, OWNER_CHAT))[0] as string
  const greeted = sentTo(world.timeline, GUEST_CHAT).length
  say(GUEST_CHAT, code)
  await waitFor('the guest greeting', () => sentTo(world.timeline, GUEST_CHAT).length > greeted, d)
}

interface ToolResult {
  text: string
  isError: boolean
}

/** The model is asked to issue `call` in `chatId`; returns its number without waiting for the answer. */
function beginTool(call: GraphCall, chatId = OWNER_CHAT): number {
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

/** One graph call of a turn; resolves with what the tool answered. */
async function useTool(d: Daemon, call: GraphCall, chatId = OWNER_CHAT): Promise<ToolResult> {
  const pongs = pongsTo(world.timeline, chatId).length
  const n = beginTool(call, chatId)
  await waitFor(
    `a pong answer to call ${n} in chat ${chatId}`,
    () => pongsTo(world.timeline, chatId).length > pongs || world.stub.outcomes.get(n)?.missing !== undefined || world.stub.outcomes.get(n)?.unmapped !== undefined,
    d,
  )
  return resultOf(d, n)
}

const addAll = (): GraphCall => ({ kind: 'add', entities: ENTITIES, relations: RELATIONS })

const FAILURE_WORDS = /error|ошибк|fail|отказ|refus|denied|reject|not |cannot|can't|нельзя|не |must|forbid|запрещ|unknown|unavailable|недоступ/i

/** A refusal or failure of the tool: flagged as an error or worded as one, with a reason. */
function expectRefused(result: ToolResult, what: string): void {
  expect(result.text.trim().length, `${what}: the refusal must carry a reason`).toBeGreaterThan(0)
  expect(result.isError || FAILURE_WORDS.test(result.text), `${what}: the answer must be a refusal\n${result.text}`).toBe(true)
}

// --- processes and files -----------------------------------------------------------------------------------

function procParent(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // pid (comm) state ppid ...; comm may contain spaces and parentheses
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (rest[0] === 'Z') return undefined
    return Number(rest[1])
  } catch {
    return undefined
  }
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return ''
  }
}

function isAlive(pid: number): boolean {
  return procParent(pid) !== undefined
}

/** Live processes below `root` in the process tree whose command line names the server-memory package. */
function serverPids(root: number): number[] {
  const parents = new Map<number, number>()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const parent = procParent(pid)
    if (parent !== undefined) parents.set(pid, parent)
  }
  const below = new Set<number>()
  let grew = true
  while (grew) {
    grew = false
    for (const [pid, parent] of parents) {
      if (!below.has(pid) && (parent === root || below.has(parent))) {
        below.add(pid)
        grew = true
      }
    }
  }
  return [...below].filter((pid) => cmdlineOf(pid).includes('server-memory'))
}

function environOf(pid: number): string[] {
  return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter((line) => line.length > 0)
}

function graphFile(): string {
  return join(world.dshbotHome, 'memory', 'graph.jsonl')
}

function readGraphFile(): string {
  return existsSync(graphFile()) ? readFileSync(graphFile(), 'utf8') : ''
}

function graphLines(): JsonObject[] {
  return readGraphFile()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseObject)
}

function filesUnder(dir: string, base = dir): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full, base))
    else found.push(full.slice(base.length))
  }
  return found.sort()
}

const serverPackageDir = (): string => join(repoRoot, 'node_modules', '@modelcontextprotocol', 'server-memory')

// --- harness lifecycle -------------------------------------------------------------------------------------

function makeScratch(): string {
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-graph-test-')))
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
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  mkdirSync(dshbotHome, { recursive: true })
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    daemons: [],
    callSeq: 0,
  }
})

afterEach(async () => {
  const leftovers: number[] = []
  for (const d of world.daemons) {
    if (d.child.pid !== undefined) leftovers.push(...serverPids(d.child.pid))
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [file] ------------------------------------------------------------------------------------------------

test('test_file_add_writes_entity_observation_and_relation_to_graph_jsonl_and_not_into_the_package', { timeout: TEST_TIMEOUT_MS }, async () => {
  const packageDir = serverPackageDir()
  expect(existsSync(packageDir), `${packageDir} must be installed`).toBe(true)
  const packageBefore = filesUnder(packageDir)
  const d = await startOwnerDaemon()

  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must succeed\n${added.text}`).toBe(false)

  expect(existsSync(graphFile()), `${graphFile()} must exist after graph add`).toBe(true)
  const lines = graphLines()
  const entity = lines.find((line) => line.name === ALICE)
  expect(entity, `an entity line for ${ALICE} in graph.jsonl:\n${readGraphFile()}`).toBeDefined()
  expect(entity?.entityType, 'the entity type is stored').toBe(ALICE_TYPE)
  expect(entity?.observations, 'the observation is stored with the entity').toContain(ALICE_FACT)
  expect(lines.some((line) => line.name === NIMBUS), `an entity line for ${NIMBUS}`).toBe(true)
  const relation = lines.find((line) => line.from === ALICE && line.to === NIMBUS)
  expect(relation, `a relation line ${ALICE} -> ${NIMBUS} in graph.jsonl:\n${readGraphFile()}`).toBeDefined()
  expect(relation?.relationType, 'the relation type is stored').toBe(RELATION)

  expect(filesUnder(packageDir), 'the server-memory package directory must stay as it was (no memory files in node_modules)').toEqual(packageBefore)
})

// --- [search] ----------------------------------------------------------------------------------------------

test('test_search_finds_the_entity_by_an_observation_word_open_returns_observations_and_relations_remove_deletes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must succeed\n${added.text}`).toBe(false)

  const miss = await useTool(d, { kind: 'search', query: 'qwertyuiopnothere' })
  expect(miss.text, 'a word nobody wrote finds nothing').not.toContain(ALICE)

  const found = await useTool(d, { kind: 'search', query: WORD })
  expect(found.isError, `search must succeed\n${found.text}`).toBe(false)
  expect(found.text, 'search by a word of an observation finds the entity').toContain(ALICE)

  const opened = await useTool(d, { kind: 'open', name: ALICE })
  expect(opened.isError, `open must succeed\n${opened.text}`).toBe(false)
  expect(opened.text, 'open returns the observations').toContain(ALICE_FACT)
  expect(opened.text, 'open returns the relation type').toContain(RELATION)
  expect(opened.text, 'open returns the other end of the relation').toContain(NIMBUS)

  const removed = await useTool(d, { kind: 'remove', name: ALICE })
  expect(removed.isError, `remove must succeed\n${removed.text}`).toBe(false)

  const after = await useTool(d, { kind: 'search', query: WORD })
  expect(after.text, 'a removed entity is no longer found').not.toContain(ALICE)
  expect(after.text, 'a removed observation is no longer found').not.toContain(ALICE_FACT)
  const reopened = await useTool(d, { kind: 'open', name: ALICE })
  expect(reopened.text, 'a removed entity has no observations to open').not.toContain(ALICE_FACT)

  const file = readGraphFile()
  expect(file, 'the removed entity is gone from graph.jsonl').not.toContain(ALICE)
  expect(file, 'the other entity stays in graph.jsonl').toContain(NIMBUS)
})

// --- [env] -------------------------------------------------------------------------------------------------

test('test_env_server_process_has_neither_the_deepseek_key_nor_the_bot_token', { timeout: TEST_TIMEOUT_MS }, async () => {
  const parentOnly: Record<string, string> = {
    DATABASE_URL: 'postgres://user:dbpass-77@db.example/app',
    GITHUB_TOKEN: 'ghp_dshbot_test_value_77',
    MY_CUSTOM_PARENT_VAR: 'custom-parent-value-77',
  }
  const d = await startOwnerDaemon({ env: parentOnly })
  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must succeed\n${added.text}`).toBe(false)

  const pids = serverPids(d.child.pid as number)
  expect(pids.length, 'the server-memory process runs below the daemon after a graph call').toBeGreaterThan(0)
  for (const pid of pids) {
    const lines = environOf(pid)
    const raw = lines.join('\n')
    expect(lines, 'the server gets its file path from MEMORY_FILE_PATH').toContain(`MEMORY_FILE_PATH=${graphFile()}`)
    for (const name of ['DEEPSEEK_API_KEY', 'TELEGRAM_BOT_TOKEN', ...Object.keys(parentOnly)]) {
      expect(raw, `${name} must not reach the server process`).not.toContain(name)
    }
    for (const value of [DEEPSEEK_KEY, BOT_TOKEN, BOT_TOKEN.split(':')[1] ?? '', ...Object.values(parentOnly)]) {
      expect(raw, 'a secret value must not reach the server process').not.toContain(value)
    }
  }
})

// --- [life] ------------------------------------------------------------------------------------------------

test('test_life_server_starts_on_first_call_restarts_after_a_kill_and_ends_with_the_daemon', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const root = d.child.pid as number

  await ask(d, 'plain-turn-without-the-graph', OWNER_CHAT)
  expect(serverPids(root), 'no server process before the first graph call').toEqual([])
  expect(existsSync(graphFile()), 'no graph file before the first graph call').toBe(false)

  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must succeed\n${added.text}`).toBe(false)
  const first = serverPids(root)
  expect(first.length, 'the server process runs after the first graph call').toBeGreaterThan(0)

  for (const pid of first) process.kill(pid, 'SIGKILL')
  await waitFor('the killed server process to be gone', () => first.every((pid) => !isAlive(pid)), d)
  await sleep(1_000)

  const found = await useTool(d, { kind: 'search', query: WORD })
  expect(found.isError, `graph works after the server process was killed\n${found.text}`).toBe(false)
  expect(found.text, 'the restarted server serves the same graph').toContain(ALICE)
  const second = serverPids(root)
  expect(second.length, 'a new server process runs after the restart').toBeGreaterThan(0)
  expect(second.filter((pid) => first.includes(pid)), 'the restarted server is a new process').toEqual([])

  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), EXIT_LIMIT_MS)
  await d.exit
  clearTimeout(timer)
  await waitFor('the server process to end with the daemon', () => second.every((pid) => !isAlive(pid)), d, 10_000)
})

// --- [lazy] and [h1] ---------------------------------------------------------------------------------------

test('test_lazy_graph_is_a_lazy_tool_of_main_and_a_guest_has_none', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-xyz', OWNER_CHAT)
  await admitGuest(d)
  await ask(d, 'guest-schema-probe-xyz', GUEST_CHAT)

  const ownerCalls = callsMentioning(world.timeline, 'owner-schema-probe-xyz')
  expect(ownerCalls.length).toBeGreaterThan(0)
  for (const call of ownerCalls) {
    expect(toolNames(call.body), 'graph is not in the light prefix of main').not.toContain('graph')
    expect(offersLazy(call.body, 'graph'), 'main gets graph through tool_search').toBe(true)
  }

  const guestCalls = callsMentioning(world.timeline, 'guest-schema-probe-xyz')
  expect(guestCalls.length).toBeGreaterThan(0)
  for (const call of guestCalls) expect(toolNames(call.body), 'a guest must not get graph').not.toContain('graph')

  // main loads it with tool_search and uses it in the same turn
  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must work for main\n${added.text}`).toBe(false)

  // a model that invents the tool_use of a guest turn: refused, nothing written
  // The guest pace is real: a message closer than 3 seconds to the previous one is dropped.
  await sleep(3_200)
  const intruder: EntitySpec = { name: 'Guest Intruder77', type: 'person', observations: ['guest-wrote-this-77'] }
  const result = await useTool(d, { kind: 'add', entities: [intruder], relations: [], force: true }, GUEST_CHAT)
  expectRefused(result, 'graph in a guest turn')
  expect(readGraphFile(), 'nothing is written for a guest').not.toContain('Guest Intruder77')
  expect(readGraphFile(), 'the owner facts are intact').toContain(ALICE)
})

test('test_h1_main_requests_carry_graph_and_a_guest_has_neither_graph_nor_lazy_discovery', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-xyz', OWNER_CHAT)
  await admitGuest(d)
  await ask(d, 'guest-schema-probe-xyz', GUEST_CHAT)
  const added = await useTool(d, addAll())
  expect(added.isError, `graph add must work for main after tool_search\n${added.text}`).toBe(false)
  const found = await useTool(d, { kind: 'search', query: WORD })
  expect(found.text).toContain(ALICE)

  const ownerCalls = callsMentioning(world.timeline, 'owner-schema-probe-xyz')
  expect(ownerCalls.length).toBeGreaterThan(0)
  for (const call of ownerCalls) {
    expect(offersLazy(call.body, 'graph'), 'the request of main indexes graph for tool_search').toBe(true)
  }
  const guestCalls = callsMentioning(world.timeline, 'guest-schema-probe-xyz')
  expect(guestCalls.length).toBeGreaterThan(0)
  for (const call of guestCalls) {
    expect(toolNames(call.body), 'the request of a guest has no graph').not.toContain('graph')
  }

  const requests = modelRequests(world.timeline)
  expect(requests.length).toBeGreaterThan(0)
  // The graph is a lazy tool of main (the light prefix): its schema is out of
  // the first request and tool_search loads it; a guest gets neither the graph
  // nor lazy discovery.
  // Only the first request: a later request of the same session carries the
  // probe in its history and the graph that tool_search has loaded since.
  expect(toolNames((ownerCalls[0] as DsEvent).body), 'the graph of main is behind lazy loading').not.toContain('graph')
  for (const call of guestCalls) {
    expect(toolNames(call.body), 'the request of a guest has no lazy discovery').not.toContain('tool_search')
  }
})
