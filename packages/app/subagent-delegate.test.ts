// The delegate tool: a child agent in the same process on the flash model, with a subset of the tools of the
// parent, no way to delegate again, no approvals, and one self-reported result for the parent.
// The daemon runs as a child process against a fake Telegram Bot API and a local DeepSeek stub (same harness as
// turn-cancel.test.ts and exec-tool.test.ts). The stub plays two roles and tells them apart by the text of the
// request: an owner message `par-<scenario>` is a parent turn, a request that carries `kid-<scenario>` and no
// parent marker is the child. The parent asks for delegate (loading it through tool_search first when it is
// offered lazily), maps the logical call onto the property names of its input schema, and the stub writes
// down what the child request offered and what the parent got back.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const CANCEL_WAIT_MS = 20_000
const LONG_POLL_HOLD_MS = 20_000
const QUIET_MS = 2_500
const GUEST_GAP_MS = 3_500

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const PARENT_RE = /par-[a-z]+/
const CHILD_RE = /kid-[a-z]+/
const REPORT_PREFIX = 'KID-REPORT-'
/** Tools no child may hold, whatever the parent asks for. */
const FORBIDDEN_FOR_CHILD = ['delegate', 'task', 'schedule', 'zavod']
const TOOL_SEARCH = 'tool_search'
const MCP_SERVER = 'testsrv'
const MCP_WIPE = `mcp__${MCP_SERVER}__wipe`

/**
 * A stdio MCP server in plain Node for the destructive-call scenario: `wipe` is marked destructiveHint, so the
 * daemon must never run it for a delegated child. It writes down its launches and every call it gets.
 */
const MCP_FIXTURE_SERVER = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ env: process.env }) + '\\n')

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
    send({
      id,
      result: {
        tools: [
          {
            name: 'wipe',
            description: 'Wipes the data of the test server.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        ],
      },
    })
  } else if (method === 'tools/call') {
    appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ name: params.name, arguments: params.arguments || {} }) + '\\n')
    if (params.name === 'wipe') {
      writeFileSync(join(dir, 'wiped.txt'), 'wiped')
      send({ id, result: { content: [{ type: 'text', text: 'WIPED-OK' }] } })
    } else {
      send({ id, error: { code: -32602, message: 'unknown tool ' + params.name } })
    }
  } else {
    send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
})
`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

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
  role: 'parent' | 'child' | 'guest' | 'other'
  /** `par-x` for a parent request, `kid-x` for a child request */
  marker: string
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

// --- the DeepSeek stub: a parent and a child --------------------------------------------------------

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

function textBlocks(text: string): string {
  return [
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ].join('')
}

function textStream(text: string): string {
  return [messageStart(), textBlocks(text), messageEnd('end_turn')].join('')
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

function messagesOf(body: JsonObject): unknown[] {
  return Array.isArray(body.messages) ? body.messages : []
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

/** The last owner message with a parent marker: its index and the marker. */
function parentTurnOf(body: JsonObject): { index: number; marker: string } | undefined {
  const messages = messagesOf(body)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = asObject(messages[i])
    if (message.role !== 'user') continue
    const found = PARENT_RE.exec(flatten(message.content))
    if (found) return { index: i, marker: found[0] }
  }
  return undefined
}

function everything(body: JsonObject): string {
  return JSON.stringify(body.system ?? '') + JSON.stringify(messagesOf(body))
}

interface DelegateScenario {
  task: string
  tools: string[]
}

const SCENARIOS: Record<string, DelegateScenario> = {
  'par-run': { task: 'kid-run: list the notes and report what you found', tools: ['read', 'list'] },
  'par-deny': { task: 'kid-deny: report what you found', tools: ['read', 'delegate', 'task', 'schedule', 'zavod'] },
  'par-confirm': { task: 'kid-confirm: clean up the old directory', tools: ['exec'] },
  'par-mcp': { task: 'kid-mcp: wipe the data with the MCP tool', tools: [MCP_WIPE] },
  'par-stop': { task: 'kid-stop: work on it for a long time', tools: ['read'] },
}

/** What the stub learned about the delegation of one parent scenario. */
interface DelegateOutcome {
  /** the logical arguments could not be placed onto the input schema */
  unmapped?: string
  /** the input the stub sent */
  sent?: JsonObject
  /** what the tool answered, as the next parent request carried it */
  result?: { text: string; isError: boolean }
}

interface HeldResponse {
  res: ServerResponse
  closed: boolean
  released: boolean
}

interface Stub {
  server: Server
  origin: string
  outcomes: Map<string, DelegateOutcome>
  /** results of the exec tool as the child saw them, by child marker */
  childToolResults: Map<string, string[]>
  held: Map<string, HeldResponse>
  release(key: string, text: string): void
}

/** Maps the logical call onto whatever input schema the request offers. */
function delegateInput(scenario: DelegateScenario, schema: ToolSchema): JsonObject | { unmapped: string } {
  const toolsKey =
    schema.props.find((prop) => /tool|инструмент/i.test(prop)) ??
    schema.props.find((prop) => schema.properties[prop]?.type === 'array')
  const taskKey =
    schema.props.find((prop) => prop !== toolsKey && /task|задач|prompt|goal|instruction|objective/i.test(prop)) ??
    schema.required.find((prop) => prop !== toolsKey && schema.properties[prop]?.type === 'string')
  if (taskKey === undefined || toolsKey === undefined) {
    return { unmapped: `no task or tools property in ${JSON.stringify(schema.props)}` }
  }
  const input: JsonObject = {}
  input[taskKey] = scenario.task
  input[toolsKey] = schema.properties[toolsKey]?.type === 'string' ? scenario.tools.join(',') : scenario.tools
  return input
}

async function startStub(timeline: Timeline): Promise<Stub> {
  let toolUses = 0
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    outcomes: new Map(),
    childToolResults: new Map(),
    held: new Map(),
    release(key, text) {
      const held = stub.held.get(key)
      if (held === undefined || held.closed || held.released) return
      held.released = true
      held.res.end(`${textBlocks(text)}${messageEnd('end_turn')}`)
    },
  }

  function hold(key: string, res: ServerResponse): void {
    const held: HeldResponse = { res, closed: false, released: false }
    stub.held.set(key, held)
    res.on('close', () => {
      held.closed = true
    })
    res.write(messageStart())
  }

  function answerParent(res: ServerResponse, body: JsonObject, turn: { index: number; marker: string }): void {
    const marker = turn.marker
    const scenario = SCENARIOS[marker]
    const current = messagesOf(body).slice(turn.index)
    const uses: JsonObject[] = []
    const results: JsonObject[] = []
    for (const message of current) {
      for (const block of blocksOf(message)) {
        if (block.type === 'tool_use') uses.push(block)
        if (block.type === 'tool_result') results.push(block)
      }
    }
    const delegateUse = uses.find((use) => use.name === 'delegate')
    const tools = toolSchemas(body)
    if (scenario === undefined) {
      res.end(textStream(`fin ${marker}`))
      return
    }
    if (delegateUse !== undefined) {
      const result = results.find((r) => r.tool_use_id === delegateUse.id)
      const outcome = stub.outcomes.get(marker) ?? {}
      if (result !== undefined) {
        outcome.result = { text: flatten(result.content), isError: result.is_error === true }
        stub.outcomes.set(marker, outcome)
      }
      res.end(textStream(`fin ${marker}`))
      return
    }
    if (marker === 'par-mcp') {
      // The parent must load both the delegate tool and the destructive MCP tool
      // through tool_search, then hand the MCP tool to the child.
      const searches = uses.filter((use) => use.name === TOOL_SEARCH).length
      const missing = !tools.has('delegate') ? 'delegate subagent' : !tools.has(MCP_WIPE) ? 'wipe' : undefined
      if (missing !== undefined && searches < 4) {
        toolUses += 1
        res.end(toolUseStream(`toolu_stub_${toolUses}`, TOOL_SEARCH, { query: missing }))
        return
      }
      const delegate = tools.get('delegate')
      if (delegate === undefined || !tools.has(MCP_WIPE)) {
        res.end(
          textStream(`MCP-DELEGATE-MISSING ${marker} delegate=${delegate !== undefined} wipe=${tools.has(MCP_WIPE)}`),
        )
        return
      }
      const input = delegateInput(scenario, delegate)
      toolUses += 1
      stub.outcomes.set(marker, { sent: input })
      res.end(toolUseStream(`toolu_stub_${toolUses}`, 'delegate', input))
      return
    }
    const delegate = tools.get('delegate')
    if (delegate !== undefined) {
      const input = delegateInput(scenario, delegate)
      toolUses += 1
      if ('unmapped' in input && typeof input.unmapped === 'string' && Object.keys(input).length === 1) {
        stub.outcomes.set(marker, { unmapped: input.unmapped })
        res.end(textStream(`fin ${marker}`))
        return
      }
      stub.outcomes.set(marker, { sent: input })
      res.end(toolUseStream(`toolu_stub_${toolUses}`, 'delegate', input))
      return
    }
    // delegate is lazy: it is loaded through tool_search first
    if (tools.has(TOOL_SEARCH) && uses.filter((use) => use.name === TOOL_SEARCH).length < 2) {
      toolUses += 1
      res.end(toolUseStream(`toolu_stub_${toolUses}`, TOOL_SEARCH, { query: 'delegate subagent' }))
      return
    }
    res.end(textStream(`NO-DELEGATE-TOOL ${marker}`))
  }

  function answerChild(res: ServerResponse, body: JsonObject, kid: string): void {
    const messages = messagesOf(body)
    const last = messages[messages.length - 1]
    const lastResults = blocksOf(last).filter((block) => block.type === 'tool_result')
    if (lastResults.length > 0) {
      stub.childToolResults.set(kid, lastResults.map((block) => flatten(block.content)))
    }
    if (kid === 'kid-stop') {
      hold('child', res)
      return
    }
    if (kid === 'kid-mcp' && lastResults.length === 0) {
      if (!toolNames(body).includes(MCP_WIPE)) {
        res.end(textStream(`CHILD-NO-WIPE ${kid}`))
        return
      }
      toolUses += 1
      res.end(toolUseStream(`toolu_stub_${toolUses}`, MCP_WIPE, {}))
      return
    }
    if (kid === 'kid-confirm' && lastResults.length === 0) {
      toolUses += 1
      const doomed = join(world.workspace, 'doomed')
      res.end(toolUseStream(`toolu_stub_${toolUses}`, 'exec', { command: `rm -rf '${doomed}' && echo CONFIRMED-4''2` }))
      return
    }
    res.end(textStream(`${REPORT_PREFIX}${kid}`))
  }

  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      const turn = parentTurnOf(body)
      const kid = turn === undefined ? CHILD_RE.exec(everything(body))?.[0] : undefined
      const guest = turn === undefined && kid === undefined && everything(body).includes('hold-guest')
      const role: DsEvent['role'] = turn !== undefined ? 'parent' : kid !== undefined ? 'child' : guest ? 'guest' : 'other'
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body, role, marker: turn?.marker ?? kid ?? '' })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (turn !== undefined) {
        answerParent(res, body, turn)
      } else if (kid !== undefined) {
        answerChild(res, body, kid)
      } else if (guest) {
        hold('guest', res)
      } else {
        res.end(textStream('pong'))
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

function okResult(tg: FakeTelegram, method: string, params: JsonObject): { result: unknown; messageId?: number } {
  if (method === 'getMe') return { result: { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' } }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    tg.sentIds += 1
    const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
    const messageId = 9000 + tg.sentIds
    return {
      result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' },
      messageId,
    }
  }
  return { result: true }
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
      const answer = okResult(tg, method, params)
      if (answer.messageId !== undefined) event.messageId = answer.messageId
      reply(200, JSON.stringify({ ok: true, result: answer.result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

let nextMessageId = 100
let updateCounter = 1000

function privateMessage(chatId: number, text: string): JsonObject {
  updateCounter += 1
  return {
    update_id: updateCounter,
    message: {
      message_id: (nextMessageId += 1),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

function say(text: string, chatId = OWNER_CHAT): void {
  world.tg.push(privateMessage(chatId, text))
}

function modelCalls(): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds')
}

function callsOf(role: DsEvent['role'], marker?: string): DsEvent[] {
  return modelCalls().filter((e) => e.role === role && (marker === undefined || e.marker === marker))
}

function tgEvents(): TgEvent[] {
  return world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

function sentTo(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId)
}

function ownerTexts(): string[] {
  return sentTo(OWNER_CHAT).map((e) => JSON.stringify(e.params))
}

/** Every string inside a Telegram parameter object. */
function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

/** Invitation-code-like tokens of a text, best first: tokens with digits, then the rest in order. */
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

function guestTexts(): string[] {
  return sentTo(GUEST_CHAT).map((e) => JSON.stringify(e.params))
}

/** True when any Telegram call (send, edit, draft) carried `needle`. */
function telegramCarried(needle: string): boolean {
  return tgEvents().some((e) => e.method !== 'getUpdates' && JSON.stringify(e.params).includes(needle))
}

/** Messages with an inline keyboard sent to the owner: approval cards. */
function cardsToOwner(): TgEvent[] {
  return sentTo(OWNER_CHAT).filter((e) => {
    const rows = asObject(e.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows)) return false
    return rows.flatMap((row) => (Array.isArray(row) ? row.map(asObject) : [])).some((b) => {
      const data = typeof b.callback_data === 'string' ? b.callback_data : ''
      return data.split(':')[2] === 'a' || data.split(':')[2] === 'd'
    })
  })
}

// --- the daemon as a child process --------------------------------------------------------------------------

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
  mcpDir: string
  daemons: Daemon[]
}

let scratch: string
let mcpServerFile: string
let world: World

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
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn(
    process.execPath,
    ['--import', join(repoRoot, 'packages', 'app', 'register.mjs'), join(repoRoot, 'packages', 'app', 'src', 'main.ts')],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
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
  const calls = modelCalls()
    .map((c) => `${c.role}:${c.marker}:${c.body.model as string}:[${toolNames(c.body).join(',')}]`)
    .join('\n')
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}\n--- model requests ---\n${calls}`
}

async function waitFor(what: string, cond: () => boolean, d: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${output(d)}`).toBe(true)
}

/** Tokens of the daemon journal that can be the one-time pairing code, best first. */
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
  say('hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  say(pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  await pairOwner(d)
  return d
}

/** Nothing new reached either fake for QUIET_MS. */
async function quiet(): Promise<void> {
  let seen = world.timeline.seq
  let since = Date.now()
  while (Date.now() - since < QUIET_MS) {
    await sleep(100)
    if (world.timeline.seq !== seen) {
      seen = world.timeline.seq
      since = Date.now()
    }
  }
}

/** Every tool_use id of the request has a tool_result and the other way round. */
function expectNoDanglingToolUse(body: JsonObject, context: string): void {
  const used: string[] = []
  const answered: string[] = []
  for (const message of messagesOf(body)) {
    for (const block of blocksOf(message)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') used.push(block.id)
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') answered.push(block.tool_use_id)
    }
  }
  for (const id of used) expect(answered, `${context}: tool_use ${id} has no tool_result`).toContain(id)
  for (const id of answered) expect(used, `${context}: tool_result for ${id} has no tool_use`).toContain(id)
}

/** The owner asks for a scenario and waits for the final reply of the parent. */
async function runScenario(d: Daemon, marker: string): Promise<DelegateOutcome> {
  say(`${marker} сделай, пожалуйста`)
  await waitFor(
    `the final reply of ${marker}`,
    () =>
      ownerTexts().some((text) => text.includes(`fin ${marker}`) || text.includes('NO-DELEGATE-TOOL')) ||
      world.stub.outcomes.get(marker)?.unmapped !== undefined,
    d,
  )
  expect(telegramCarried('NO-DELEGATE-TOOL'), `the parent was offered no delegate tool (not even through tool_search)\n${output(d)}`).toBe(false)
  const outcome = world.stub.outcomes.get(marker) ?? {}
  expect(outcome.unmapped, `the delegate input schema must offer a task and a tools property\n${output(d)}`).toBeUndefined()
  return outcome
}

/** Tools of the child request except the discovery tool of lazy loading. */
function childTools(call: DsEvent): string[] {
  return toolNames(call.body).filter((name) => name !== TOOL_SEARCH).sort()
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of the exec tool gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-subagent-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  const fixture = join(scratch, 'fixture')
  mkdirSync(fixture, { recursive: true })
  mcpServerFile = join(fixture, 'server.mjs')
  writeFileSync(mcpServerFile, MCP_FIXTURE_SERVER)
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
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace,
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    mcpDir: mkdtempSync(join(scratch, 'mcp-')),
    daemons: [],
  }
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  for (const key of ['child', 'guest']) world.stub.release(key, 'late')
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [run] ----------------------------------------------------------------------------------------------

test('test_run_delegate_starts_a_flash_child_with_only_the_asked_tools_and_returns_a_self_report', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const mark = ownerTexts().length
  say('/model pro')
  await waitFor('the switch to the pro model', () => ownerTexts().slice(mark).some((text) => /pro/.test(text)), d)

  const outcome = await runScenario(d, 'par-run')

  const kids = callsOf('child', 'kid-run')
  expect(kids.length, `the child never asked the model\n${output(d)}`).toBeGreaterThan(0)
  const parents = callsOf('parent', 'par-run')
  expect(String(parents[0]?.body.model), 'the parent runs on the pro model').toMatch(/pro/)
  expect(parents[0] ? toolNames(parents[0].body) : [], 'the parent holds the tools the child is cut from').toEqual(
    expect.arrayContaining(['read', 'list', 'exec']),
  )
  for (const kid of kids) {
    expect(String(kid.body.model), 'the child runs on deepseek-flash').toMatch(/flash/)
    expect(String(kid.body.model)).not.toMatch(/pro/)
    expect(childTools(kid), 'the child sees exactly the asked subset of the tools of the parent').toEqual(['list', 'read'])
    expect(everything(kid.body), 'the child gets the task').toContain('kid-run: list the notes')
  }

  const result = outcome.result
  expect(result, `the parent got no result of the delegate tool\n${output(d)}`).toBeDefined()
  expect(result?.isError, 'a finished child is not a tool error').toBe(false)
  expect(result?.text, 'the parent receives the summary of the child').toContain(`${REPORT_PREFIX}kid-run`)
  expect(result?.text, 'the result is marked as a self-report, not a verified fact').toMatch(/самоотч[её]т|self-?report/i)
  expect(ownerTexts().some((text) => text.includes('fin par-run')), 'the parent finishes its own turn').toBe(true)
})

// --- [deny] ---------------------------------------------------------------------------------------------

test('test_deny_child_never_holds_delegate_task_schedule_or_zavod_even_when_asked', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const outcome = await runScenario(d, 'par-deny')

  const parents = callsOf('parent', 'par-deny')
  expect(parents.length, 'a parent turn happened').toBeGreaterThan(0)
  const kids = callsOf('child', 'kid-deny')
  const text = outcome.result?.text ?? ''
  if (kids.length === 0) {
    // The call asking for forbidden tools may be refused as a whole; then the parent sees a refusal.
    expect(outcome.result, `no child and no answer\n${output(d)}`).toBeDefined()
    expect(outcome.result?.isError || /отказ|запрещ|нельзя|refus|denied|forbid|not allowed|cannot/i.test(text), `a plain refusal\n${text}`).toBe(true)
  }
  for (const kid of kids) {
    const names = toolNames(kid.body)
    for (const forbidden of FORBIDDEN_FOR_CHILD) expect(names, `the child must not hold ${forbidden}`).not.toContain(forbidden)
    expect(names, 'the allowed part of the request stays').toContain('read')
  }
  // the requested names of the parent were not silently dropped by the stub
  expect(world.stub.outcomes.get('par-deny')?.sent, 'the forbidden names were asked for').toBeDefined()
})

test('test_deny_confirmation_inside_a_child_is_refused_and_the_owner_gets_no_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const doomed = join(world.workspace, 'doomed')
  mkdirSync(doomed, { recursive: true })
  writeFileSync(join(doomed, 'keep.txt'), 'keep\n')
  const d = await startOwnerDaemon()

  const outcome = await runScenario(d, 'par-confirm')

  expect(callsOf('child', 'kid-confirm').length, `the child never ran\n${output(d)}`).toBeGreaterThan(1)
  const seen = (world.stub.childToolResults.get('kid-confirm') ?? []).join('\n')
  expect(seen.trim().length, 'the child must get a tool result for the command that needs confirmation').toBeGreaterThan(0)
  expect(seen, 'the command must not have run').not.toContain('CONFIRMED-42')
  expect(/отказ|запрещ|нельзя|подтвержд|refus|denied|declin|not allowed|approval|confirm|error|ошибк/i.test(seen), `a refusal reaches the child\n${seen}`).toBe(true)
  expect(existsSync(join(doomed, 'keep.txt')), 'a refused command must not remove anything').toBe(true)
  expect(cardsToOwner(), 'a child asks the owner nothing: no approval card').toHaveLength(0)
  expect(outcome.result?.text ?? '', 'the parent still gets the report of the child').toContain(`${REPORT_PREFIX}kid-confirm`)
})

// --- [mcp-destructive] -----------------------------------------------------------------------------------

function jsonLines(file: string): JsonObject[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(parseObject)
}

test(
  'test_destructive_mcp_tool_of_a_delegated_child_is_refused_and_the_owner_gets_no_card',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    // mcp.json belongs to the owner: the daemon reads it and connects the server
    const mcpPath = join(world.dshbotHome, 'mcp.json')
    writeFileSync(
      mcpPath,
      `${JSON.stringify(
        { mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [mcpServerFile, world.mcpDir] } } },
        null,
        2,
      )}\n`,
    )
    const d = await startOwnerDaemon()
    await waitFor('the MCP server of mcp.json to start', () => existsSync(join(world.mcpDir, 'launches.jsonl')), d)
    await sleep(1_500)

    const outcome = await runScenario(d, 'par-mcp')

    expect(callsOf('child', 'kid-mcp').length, `the child never ran\n${output(d)}`).toBeGreaterThan(1)
    expect(telegramCarried('CHILD-NO-WIPE'), `the destructive tool was not handed to the child\n${output(d)}`).toBe(false)
    const seen = (world.stub.childToolResults.get('kid-mcp') ?? []).join('\n')
    expect(seen.trim().length, 'the child must get a tool result for the destructive MCP call').toBeGreaterThan(0)
    expect(seen, 'the destructive tool must not run for a child').not.toContain('WIPED-OK')
    expect(
      /отказ|запрещ|нельзя|подтвержд|refus|denied|declin|not allowed|approval|confirm|error|ошибк/i.test(seen),
      `a refusal reaches the child\n${seen}`,
    ).toBe(true)
    expect(existsSync(join(world.mcpDir, 'wiped.txt')), 'a refused destructive tool must not wipe anything').toBe(false)
    expect(jsonLines(join(world.mcpDir, 'calls.jsonl')), 'the server never got the call').toHaveLength(0)
    expect(cardsToOwner(), 'a child asks the owner nothing: no approval card').toHaveLength(0)
    expect(outcome.result?.text ?? '', 'the parent still gets the report of the child').toContain(`${REPORT_PREFIX}kid-mcp`)
    expect(telegramCarried('fin par-mcp'), 'the parent finishes its own turn').toBe(true)
    expect(d.exited, `the daemon survives the refused call\n${output(d)}`).toBe(false)
  },
)

// --- [stop] ---------------------------------------------------------------------------------------------

test('test_stop_owner_stop_cancels_the_running_child_and_the_parent_turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say('par-stop сделай, пожалуйста')
  await waitFor(
    'the child to be waiting for its model answer',
    () => world.stub.held.get('child') !== undefined || telegramCarried('NO-DELEGATE-TOOL'),
    d,
  )
  expect(telegramCarried('NO-DELEGATE-TOOL'), `the parent was offered no delegate tool\n${output(d)}`).toBe(false)
  expect(world.stub.held.get('child')?.closed, 'the child request is open before /stop').toBe(false)
  const parentCalls = callsOf('parent', 'par-stop').length

  say('/stop')
  await waitFor(
    'the model request of the child to be cancelled after /stop',
    () => world.stub.held.get('child')?.closed === true,
    d,
    CANCEL_WAIT_MS,
  )
  await quiet() // background: the delegated child runs outside the turn

  expect(callsOf('parent', 'par-stop').length, 'the parent asks the model nothing after /stop').toBe(parentCalls)
  expect(callsOf('child', 'kid-stop'), 'the child is not restarted after /stop').toHaveLength(1)
  expect(telegramCarried('fin par-stop'), `the final reply of the parent must not be sent after /stop\n${output(d)}`).toBe(false)
  expect(telegramCarried(REPORT_PREFIX), 'no report of a stopped child reaches the owner').toBe(false)
  expect(d.exited, `the daemon must survive /stop\n${output(d)}`).toBe(false)

  const before = modelCalls().length
  say('par-next привет')
  await waitFor('the normal reply to the message after /stop', () => ownerTexts().some((text) => text.includes('fin par-next')), d)
  const next = modelCalls().slice(before).filter((call) => call.role === 'parent' && call.marker === 'par-next')
  expect(next.length, 'the model was asked for the message after /stop').toBeGreaterThan(0)
  for (const call of next) expectNoDanglingToolUse(call.body, 'request after /stop')
  expect(callsOf('child', 'kid-stop'), 'no child outlives /stop').toHaveLength(1)
})

// --- [nopatch] ------------------------------------------------------------------------------------------

test('test_nopatch_owner_stop_leaves_the_turn_of_a_guest_running', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const inviteMark = world.timeline.seq
  say('/invite')
  const invitation = (): string[] =>
    codeLike(sentTo(OWNER_CHAT).filter((e) => e.n > inviteMark).flatMap((e) => deepStrings(e.params)))
  await waitFor('an invitation code in the owner chat', () => invitation().length > 0, d)
  const code = invitation()[0]
  const greeted = sentTo(GUEST_CHAT).length
  say(code as string, GUEST_CHAT)
  await waitFor('a greeting for the guest', () => sentTo(GUEST_CHAT).length > greeted, d)
  await sleep(GUEST_GAP_MS)

  say('hold-guest привет', GUEST_CHAT)
  await waitFor('the model request of the guest turn', () => world.stub.held.get('guest') !== undefined, d)
  expect(world.stub.held.get('guest')?.closed).toBe(false)

  say('/stop')
  await waitFor('the answer to /stop', () => ownerTexts().some((text) => /остановил/i.test(text)), d)
  await quiet() // background: the delegated child runs outside the turn
  expect(world.stub.held.get('guest')?.closed, 'the /stop of the owner must not cancel the turn of a guest').toBe(false)

  world.stub.release('guest', 'fin hold-guest')
  await waitFor('the answer of the guest turn', () => guestTexts().some((text) => text.includes('fin hold-guest')), d)
})
