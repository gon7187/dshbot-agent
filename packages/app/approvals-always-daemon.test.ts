// "Always allow" on the approval card of a host command and /approvals with the list and the revoke buttons.
// A card of exec, host_exec (ssh and the local alias) with a guard `confirm` verdict has three buttons: allow, always,
// deny. "Always" runs the command now and lets the very same command (the same text, for host_exec the same host)
// run later in the turns of the owner without a card; the permissions live in state.db and survive a restart;
// /approvals lists them with a revoke button each; a guard `deny` and every turn without the owner (a guest, a
// delegated child) keep their old behaviour. The wake-up has its own file (approvals-always-wake.test.ts).
// Same harness as host-exec-daemon.test.ts: the daemon runs as a child process against a fake Telegram Bot API and
// a local DeepSeek stub that plays the main model from a script per turn marker (`turn-xx-N`: tool calls first, then
// the answer `fin <marker>`) and the child of delegate (a request that carries `kid-xx`). ssh is a fake executable
// first in the PATH of the daemon. The buttons are found by their labels, not by the codec of callback_data.

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete, waitForUpdateComplete } from './test-support/turn-events.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 290_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7
const GUEST_CHAT = 31

const MARKER_RE = /turn-[a-z]+-\d+/
const CHILD_RE = /kid-[a-z]+/

const TOOL = 'host_exec'
const TOOL_SEARCH = 'tool_search'

const MCP_SERVER = 'testsrv'
const WIPE = `mcp__${MCP_SERVER}__wipe`

const HOSTS = {
  prod: { user: 'deploy', host: '192.0.2.10', port: 2222 },
  staging: { user: 'ops', host: 'staging.example.test', port: 22 },
}

const RESTART = 'systemctl restart nginx'

const FAILURE_WORDS = /отказ|запрещ|нельзя|не выполн|refus|denied|declin|forbid|not allowed|error|ошибк|expired|истек|истёк/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the fake ssh and the MCP server ----------------------------------------------------------------------

/** ssh of the tests: appends `--- call` and one `ARG:<argument>` line per argument to the log, prints FAKE-SSH. */
function fakeSshScript(logFile: string): string {
  return `#!/bin/sh
{
  echo '--- call'
  for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
} >> '${logFile}'
echo FAKE-SSH
exit 0
`
}

/** A stdio MCP server in plain Node: `echo` is read-only, `wipe` is destructive and leaves wiped.txt. */
const MCP_FIXTURE = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')

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
]

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
    if (params.name === 'wipe') {
      writeFileSync(join(dir, 'wiped.txt'), 'wiped')
      send({ id, result: text('WIPED-OK') })
    } else {
      send({ id, result: text('ECHO:' + ((params.arguments || {}).text || '')) })
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
  role: 'main' | 'child'
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

interface Schema {
  properties: Record<string, JsonObject>
  required: string[]
}

/** The input schema of a tool declared in a request. */
function schemaOf(body: JsonObject, name: string): Schema | undefined {
  const tools = Array.isArray(body.tools) ? body.tools.map(asObject) : []
  const tool = tools.find((candidate) => candidate.name === name)
  if (tool === undefined) return undefined
  const schema = asObject(tool.input_schema ?? tool.parameters)
  const properties = asObject(schema.properties)
  return {
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, asObject(value)])),
    required: Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  }
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

/** Every tool result in the whole request, oldest first. */
function allResults(body: JsonObject): Block[] {
  return messagesOf(body).flatMap((message) => (message.role === 'user' ? blocksOf(message.content).filter((b) => b.kind === 'tool_result') : []))
}

const refused = (result: Block): boolean => result.isError || FAILURE_WORDS.test(result.text)

/** The only tool result of the last request of a turn. */
function finalResult(calls: DsEvent[]): Block {
  const results = lastResults((calls[calls.length - 1] as DsEvent).body)
  expect(results, 'the model got the result of its last call').toHaveLength(1)
  return results[0] as Block
}

// --- the scripted model --------------------------------------------------------------------------

type Action =
  | { kind: 'tool'; name: string; input: JsonObject }
  | { kind: 'host'; host: string; command: string }
  | { kind: 'delegate'; task: string; tools: string[] }

interface Stub {
  server: Server
  origin: string
  /** Actions of a turn of main, by marker; after the last one the model answers `fin <marker>`. */
  scripts: Map<string, Action[]>
  /** Why the stub could not place a logical call onto the tools of a request, by marker. */
  problems: Map<string, string>
  /** What a delegated child tries to run: an exec command and a host_exec command on `prod`. */
  childExec: string
  childHost: string
}

const search = (query: string): Action => ({ kind: 'tool', name: TOOL_SEARCH, input: { query } })
const PURPOSE = 'проверяю карточку подтверждения команды'
const call = (name: string, input: JsonObject = {}): Action => ({
  kind: 'tool',
  name,
  input: name === 'exec' || name === TOOL ? { purpose: PURPOSE, ...input } : input,
})
const host = (alias: string, command: string): Action => ({ kind: 'host', host: alias, command })

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

/** host_exec input for an alias and a command, or the reason it cannot be placed onto the schema. */
function hostInput(schema: Schema, alias: string, command: string): JsonObject | string {
  const props = Object.keys(schema.properties)
  const commandKey = props.find((p) => /^(command|cmd|script|shell|code)$/i.test(p)) ?? props.find((p) => /command|cmd/i.test(p))
  if (commandKey === undefined) return `no command property in ${JSON.stringify(props)}`
  const aliasKey =
    props.find((p) => p !== commandKey && /^(host|alias|target|server|machine|name|hostname|host_alias)$/i.test(p)) ??
    props.find((p) => p !== commandKey && /host|alias|target|server|machine/i.test(p))
  if (aliasKey === undefined) return `no alias property in ${JSON.stringify(props)}`
  return { [commandKey]: command, [aliasKey]: alias, ...(props.includes('purpose') ? { purpose: 'проверяю карточку подтверждения команды' } : {}) }
}

/** delegate input for a task and a list of tools. */
function delegateInput(schema: Schema, task: string, tools: string[]): JsonObject | string {
  const props = Object.keys(schema.properties)
  const toolsKey = props.find((p) => /tool|инструмент/i.test(p)) ?? props.find((p) => schema.properties[p]?.type === 'array')
  const taskKey =
    props.find((p) => p !== toolsKey && /task|задач|prompt|goal|instruction|objective/i.test(p)) ??
    schema.required.find((p) => p !== toolsKey && schema.properties[p]?.type === 'string')
  if (taskKey === undefined || toolsKey === undefined) return `no task or tools property in ${JSON.stringify(props)}`
  return {
    [taskKey]: task,
    [toolsKey]: schema.properties[toolsKey]?.type === 'string' ? tools.join(',') : tools,
  }
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    scripts: new Map(),
    problems: new Map(),
    childExec: 'echo KID-EXEC',
    childHost: 'echo KID-HOST',
  }
  let toolUses = 0

  function answerMain(res: ServerResponse, body: JsonObject, found: { at: number; marker: string }): void {
    const { marker } = found
    const action = (stub.scripts.get(marker) ?? [])[turnStep(body, found.at)]
    if (action === undefined) {
      res.end(textStream(`fin ${marker}`))
      return
    }
    let name: string
    let input: JsonObject | string
    if (action.kind === 'tool') {
      name = action.name
      input = action.input
    } else if (action.kind === 'host') {
      name = TOOL
      const schema = schemaOf(body, TOOL)
      input = schema === undefined ? `${TOOL} is not among the tools of the request` : hostInput(schema, action.host, action.command)
    } else {
      name = 'delegate'
      const schema = schemaOf(body, 'delegate')
      input = schema === undefined ? 'delegate is not among the tools of the request' : delegateInput(schema, action.task, action.tools)
    }
    if (typeof input === 'string') {
      stub.problems.set(marker, input)
      res.end(textStream(`PROBLEM ${marker}: ${input}`))
      return
    }
    toolUses += 1
    res.end(toolUseStream(`toolu_main_${toolUses}`, name, input))
  }

  /** The child asks for exec, then for host_exec, whatever its tools[] say: a model may invent a tool_use. */
  function answerChild(res: ServerResponse, body: JsonObject, kid: string): void {
    const done = allResults(body).length
    if (done >= 2) {
      res.end(textStream(`KID-REPORT ${kid}`))
      return
    }
    toolUses += 1
    if (done === 0) {
      res.end(toolUseStream(`toolu_kid_${toolUses}`, 'exec', { command: stub.childExec }))
      return
    }
    const schema = schemaOf(body, TOOL)
    const placed = schema === undefined ? 'no schema' : hostInput(schema, 'prod', stub.childHost)
    const input = typeof placed === 'string' ? { host: 'prod', alias: 'prod', command: stub.childHost } : placed
    res.end(toolUseStream(`toolu_kid_${toolUses}`, TOOL, input))
  }

  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      const found = markerMessage(body)
      const kid = found === undefined ? CHILD_RE.exec(JSON.stringify(messagesOf(body)))?.[0] : undefined
      if (isModelCall) {
        timeline.seq += 1
        timeline.events.push({ n: timeline.seq, src: 'ds', body, role: kid === undefined ? 'main' : 'child' })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (found !== undefined) answerMain(res, body, found)
      else if (kid !== undefined) answerChild(res, body, kid)
      else res.end(textStream('pong'))
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

/** The words of a sent message, the keyboard left out. */
function textOfEvent(e: TgEvent): string {
  const { reply_markup: _keyboard, ...rest } = e.params
  return deepStrings(rest).join('\n')
}

interface Button {
  text: string
  data: string
}

function buttonsOf(e: TgEvent): Button[] {
  const rows = asObject(e.params.reply_markup).inline_keyboard
  if (!Array.isArray(rows)) return []
  return rows
    .flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
    .map((button) => ({
      text: typeof button.text === 'string' ? button.text : '',
      data: typeof button.callback_data === 'string' ? button.callback_data : '',
    }))
}

/** The label of a button without emoji and punctuation. */
const labelOf = (button: Button): string => button.text.replace(/[^\p{L}]/gu, '')

/** An approval card: a sent message whose keyboard has an allow and a deny button. */
interface Card {
  messageId: number
  text: string
  buttons: Button[]
  allow: string
  deny: string
}

function cardsIn(timeline: Timeline, chatId: number): Card[] {
  const cards: Card[] = []
  for (const e of sentTo(timeline, chatId)) {
    const buttons = buttonsOf(e)
    const allow = buttons.find((b) => labelOf(b).toLowerCase() === 'разрешить')
    const deny = buttons.find((b) => labelOf(b).toLowerCase() === 'отклонить')
    if (allow === undefined || deny === undefined || e.messageId === undefined) continue
    cards.push({ messageId: e.messageId, text: deepStrings(e.params.text).join('\n'), buttons, allow: allow.data, deny: deny.data })
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
  /** The fake ssh is the only file here, and this directory is first in the PATH of the daemon. */
  binDir: string
  sshLog: string
  /** Data of the MCP server of the tests. */
  dataDir: string
  daemons: Daemon[]
}

let scratch: string
let mcpServerFile: string
let world: World

function spawnDaemon(): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [world.binDir, dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    ...TURN_EVENTS_ON,
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
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

function say(chatId: number, text: string): number {
  const update = privateMessage(chatId, text)
  world.tg.push(update)
  return Number(update.update_id)
}

/** Pushes a button press; its update id is the barrier for the handler that follows. */
function press(fromId: number, messageId: number, data: string): number {
  const update = buttonPress(fromId, messageId, data)
  world.tg.push(update)
  return Number(update.update_id)
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

/** A daemon on the state directory of the world; the owner is paired only when asked. */
async function startDaemon(pair: boolean): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  if (pair) await pairOwner(d)
  return d
}

const startOwnerDaemon = (): Promise<Daemon> => startDaemon(true)

/** SIGTERM and wait for the exit: the next daemon starts on the same state directory. */
async function stopDaemon(d: Daemon): Promise<void> {
  d.child.kill('SIGTERM')
  const timer = setTimeout(() => d.child.kill('SIGKILL'), 15_000)
  await d.exit
  clearTimeout(timer)
}

/** Model requests of the main model for one turn, in order. */
function turnCalls(marker: string): DsEvent[] {
  return world.timeline.events.filter(
    (e): e is DsEvent => e.src === 'ds' && e.role === 'main' && markerMessage(e.body)?.marker === marker,
  )
}

function replyEvent(chatId: number, marker: string): TgEvent | undefined {
  const reply = new RegExp(`(?:fin|PROBLEM) ${marker}(?!\\d)`)
  return sentTo(world.timeline, chatId).find((e) => reply.test(JSON.stringify(e.params)))
}

function expectPlaced(marker: string, d: Daemon): void {
  expect(world.stub.problems.get(marker), `the logical call of ${marker} did not fit the tools of the request\n${output(d)}`).toBeUndefined()
}

/** `chatId` opens a turn with `marker` and waits for the turn to finish after its reply. */
async function turnAs(d: Daemon, chatId: number, marker: string): Promise<DsEvent[]> {
  const done = turnCompletions(d)
  say(chatId, `${marker} сделай, пожалуйста`)
  await waitFor(`the reply of turn ${marker}`, () => replyEvent(chatId, marker) !== undefined, d, TURN_WAIT_MS)
  await waitForTurnComplete(d, done, `the turn ${marker}`, TURN_WAIT_MS)
  expectPlaced(marker, d)
  const calls = turnCalls(marker)
  expect(calls.length, `the model was not asked in turn ${marker}\n${output(d)}`).toBeGreaterThan(0)
  return calls
}

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

// --- cards and turns of the owner ------------------------------------------------------------------------

let markerCount = 0

/** A fresh marker `turn-xx-N`, the letters of the prefix being the ones the stub knows. */
const nextMarker = (): string => {
  markerCount += 1
  return `turn-ap-${markerCount}`
}

/** Waits for the next approval card of the owner, the `seen` ones being old. */
async function nextCard(d: Daemon, seen: number): Promise<Card> {
  await waitFor('an approval card for the owner', () => cardsIn(world.timeline, OWNER_CHAT).length > seen, d, TURN_WAIT_MS)
  return cardsIn(world.timeline, OWNER_CHAT)[seen] as Card
}

const ALWAYS_RE = /всегда/i

function alwaysOf(card: Card): Button {
  const button = card.buttons.find((b) => ALWAYS_RE.test(b.text))
  expect(button, `the card has an "Всегда" button: ${JSON.stringify(card.buttons.map((b) => b.text))}`).toBeDefined()
  return button as Button
}

/** One owner turn that ends in a card; the owner presses the button picked by `pick`, the turn is awaited. */
async function turnWithCard(d: Daemon, actions: Action[], pick: 'allow' | 'always' | 'deny'): Promise<{ card: Card; calls: DsEvent[] }> {
  const marker = nextMarker()
  world.stub.scripts.set(marker, actions)
  const seen = cardsIn(world.timeline, OWNER_CHAT).length
  const done = turnCompletions(d)
  say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
  const card = await nextCard(d, seen)
  const data = pick === 'always' ? alwaysOf(card).data : pick === 'allow' ? card.allow : card.deny
  press(OWNER_CHAT, card.messageId, data)
  await waitFor(`the reply after the ${pick} button of ${marker}`, () => replyEvent(OWNER_CHAT, marker) !== undefined, d, TURN_WAIT_MS)
  // The end-of-turn event is the barrier: it comes after every send of the turn, so a caller needs no sleep.
  await waitForTurnComplete(d, done, `the turn ${marker}`, TURN_WAIT_MS)
  expectPlaced(marker, d)
  return { card, calls: turnCalls(marker) }
}

/** An owner turn that must end without any new card; returns the calls of the turn. */
async function turnWithoutCard(d: Daemon, actions: Action[]): Promise<DsEvent[]> {
  const marker = nextMarker()
  world.stub.scripts.set(marker, actions)
  const seen = cardsIn(world.timeline, OWNER_CHAT).length
  const calls = await turnAs(d, OWNER_CHAT, marker)
  expect(cardsIn(world.timeline, OWNER_CHAT).length, `the command of ${marker} asked the owner again`).toBe(seen)
  return calls
}

/** The same turn, whichever way it goes: a card is declined, a plain run is reported. */
async function attempt(d: Daemon, actions: Action[]): Promise<'card' | 'ran'> {
  const marker = nextMarker()
  world.stub.scripts.set(marker, actions)
  const seen = cardsIn(world.timeline, OWNER_CHAT).length
  const done = turnCompletions(d)
  say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
  await waitFor(
    `a card or the reply of ${marker}`,
    () => cardsIn(world.timeline, OWNER_CHAT).length > seen || replyEvent(OWNER_CHAT, marker) !== undefined,
    d,
    TURN_WAIT_MS,
  )
  const opened = cardsIn(world.timeline, OWNER_CHAT).length > seen
  if (opened) {
    const card = cardsIn(world.timeline, OWNER_CHAT)[seen] as Card
    press(OWNER_CHAT, card.messageId, card.deny)
    await waitFor(`the reply after the deny button of ${marker}`, () => replyEvent(OWNER_CHAT, marker) !== undefined, d, TURN_WAIT_MS)
  }
  await waitForTurnComplete(d, done, `the turn ${marker}`, TURN_WAIT_MS)
  expectPlaced(marker, d)
  return opened ? 'card' : 'ran'
}

// --- /approvals -------------------------------------------------------------------------------------------

interface Listing {
  text: string
  /** Revoke buttons with the message they sit on. */
  revoke: Array<{ button: Button; messageId: number }>
}

/** Sends /approvals and reads what the owner gets back after the command is processed. */
async function listApprovals(d: Daemon): Promise<Listing> {
  const mark = world.timeline.seq
  const updateId = say(OWNER_CHAT, '/approvals')
  await waitFor('an answer to /approvals', () => sentTo(world.timeline, OWNER_CHAT).some((e) => e.n > mark), d)
  // The per-update event covers the whole answer of a command, which opens no owner turn.
  await waitForUpdateComplete(d, updateId, 'the answer to /approvals')
  const events = sentTo(world.timeline, OWNER_CHAT).filter((e) => e.n > mark)
  const revoke: Listing['revoke'] = []
  for (const e of events) {
    for (const button of buttonsOf(e)) {
      if (/отозвать/i.test(button.text) && e.messageId !== undefined) revoke.push({ button, messageId: e.messageId })
    }
  }
  return { text: events.map(textOfEvent).join('\n'), revoke }
}

const EMPTY_LIST = /постоянных разрешений нет/i

// --- files of the tests ----------------------------------------------------------------------------------

function writeHosts(): void {
  writeFileSync(join(world.dshbotHome, 'hosts.json'), `${JSON.stringify(HOSTS, null, 2)}\n`)
}

/** The arguments of every call of the fake ssh, in order. */
function sshCalls(): string[][] {
  if (!existsSync(world.sshLog)) return []
  const calls: string[][] = []
  for (const line of readFileSync(world.sshLog, 'utf8').split('\n')) {
    if (line === '--- call') calls.push([])
    else if (line.startsWith('ARG:')) calls[calls.length - 1]?.push(line.slice('ARG:'.length))
  }
  return calls
}

/** A directory in the workspace of the owner for an `rm -rf` of exec; recreated on every call. */
function doomedDir(name: string): string {
  const dir = join(world.dshbotHome, 'workspace', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'keep.txt'), 'keep\n')
  return dir
}

/** The exec command that removes a directory of the workspace (the cwd of exec) by its name; the output `tag` is not in the text of the command. */
const removal = (dir: string, tag: string): string => `rm -rf ${basename(dir)} && echo ${tag.slice(0, 2)}''${tag.slice(2)}`

function writeMcpJson(): void {
  const text = `${JSON.stringify(
    { mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [mcpServerFile, world.dataDir] } } },
    null,
    2,
  )}\n`
  writeFileSync(join(world.dshbotHome, 'mcp.json'), text)
}

/** Every byte of state.db and its journal files, as text. */
function stateDbText(): string {
  return readdirSync(world.dshbotHome)
    .filter((name) => name.startsWith('state.db'))
    .map((name) => readFileSync(join(world.dshbotHome, name)).toString('latin1'))
    .join('\n')
}

/**
 * Rewrites a stored text in state.db (the daemon is stopped): every text value that contains `from` gets `to`
 * instead. Returns the number of rewritten values. Virtual tables and their shadow tables are left alone.
 */
function rewriteStoredText(from: string, to: string): number {
  const db = new DatabaseSync(join(world.dshbotHome, 'state.db'))
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'")
      .all()
      .map((row) => String(asObject(row).name))
      .filter((name) => !/_(content|data|idx|docsize|config|segments|segdir|stat)$/.test(name))
    let changed = 0
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => String(asObject(row).name))
      for (const column of columns) {
        const result = db
          .prepare(`UPDATE "${table}" SET "${column}" = replace("${column}", ?, ?) WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`)
          .run(from, to, from)
        changed += Number(result.changes)
      }
    }
    return changed
  } finally {
    db.close()
  }
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp, so a file under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-approvals-always-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  const dir = join(scratch, 'fixture')
  mkdirSync(dir, { recursive: true })
  mcpServerFile = join(dir, 'server.mjs')
  writeFileSync(mcpServerFile, MCP_FIXTURE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const binDir = mkdtempSync(join(scratch, 'bin-'))
  const data = mkdtempSync(join(scratch, 'data-'))
  const sshLog = join(data, 'ssh.log')
  writeFileSync(join(binDir, 'ssh'), fakeSshScript(sshLog))
  chmodSync(join(binDir, 'ssh'), 0o755)
  world = { timeline, tg, stub, home, dshbotHome, binDir, sshLog, dataDir: mkdtempSync(join(scratch, 'mcp-')), daemons: [] }
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

// --- [c1] the buttons of the card -------------------------------------------------------------------------

test('test_c1_cards_of_exec_and_host_exec_have_allow_always_deny_and_the_card_of_mcp_keeps_two_buttons', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  writeMcpJson()
  const dir = doomedDir('doomed-c1')
  const d = await startOwnerDaemon()
  await waitFor('the MCP server of mcp.json to be launched', () => existsSync(join(world.dataDir, 'launches.jsonl')), d)
  await sleep(1_500) // background: the MCP server starts outside the turn

  const labels = (card: Card): string[] => card.buttons.map(labelOf).sort()
  const threeButtons = ['Всегда', 'Отклонить', 'Разрешить'].sort()

  const exec = await turnWithCard(d, [call('exec', { command: removal(dir, 'c1-exec-ok') })], 'deny')
  expect(labels(exec.card), `exec: allow, always, deny\n${exec.card.text}`).toEqual(threeButtons)

  const remote = await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'deny')
  expect(labels(remote.card), `host_exec on an ssh host: allow, always, deny\n${remote.card.text}`).toEqual(threeButtons)

  const mcp = await turnWithCard(d, [search(WIPE), call(WIPE)], 'deny')
  expect(mcp.card.text, 'the card is the one of the MCP tool').toMatch(/wipe/)
  expect(labels(mcp.card), `the card of an MCP tool keeps two buttons\n${mcp.card.text}`).toEqual(['Отклонить', 'Разрешить'])
  expect(existsSync(join(world.dataDir, 'wiped.txt')), 'the declined tool did not run').toBe(false)
  expect(sshCalls(), 'the declined host command did not run').toEqual([])
  expect(existsSync(dir), 'the declined exec command did not run').toBe(true)
})

// --- [c2] always ----------------------------------------------------------------------------------------

test('test_c2_always_on_a_host_exec_card_runs_the_command_and_the_same_command_on_the_same_host_needs_no_card_later', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const d = await startOwnerDaemon()

  const first = await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'always')
  expect(first.card.text, 'the card shows the command').toContain(RESTART)
  expect(sshCalls(), '"Всегда" runs the command at once').toHaveLength(1)
  expect((sshCalls()[0] as string[]).join(' '), 'ssh got the command').toContain(RESTART)
  const firstResult = finalResult(first.calls)
  expect(firstResult.isError, firstResult.text).toBe(false)
  expect(firstResult.text).toContain('FAKE-SSH')

  for (const round of [2, 3]) {
    const calls = await turnWithoutCard(d, [search(TOOL), host('prod', RESTART)])
    expect(sshCalls(), `round ${round}: the permitted command ran without a card`).toHaveLength(round)
    const result = finalResult(calls)
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('FAKE-SSH')
  }
})

test('test_c2_always_on_an_exec_card_runs_the_command_and_the_same_command_needs_no_card_later', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = doomedDir('doomed-c2')
  const command = removal(dir, 'c2-exec-ok')
  const d = await startOwnerDaemon()

  const first = await turnWithCard(d, [call('exec', { command })], 'always')
  const firstResult = finalResult(first.calls)
  expect(firstResult.isError, firstResult.text).toBe(false)
  expect(firstResult.text).toContain('c2-exec-ok')
  expect(existsSync(dir), '"Всегда" runs the command at once').toBe(false)

  doomedDir('doomed-c2')
  const calls = await turnWithoutCard(d, [call('exec', { command })])
  const result = finalResult(calls)
  expect(result.isError, result.text).toBe(false)
  expect(result.text).toContain('c2-exec-ok')
  expect(existsSync(dir), 'the permitted command ran without a card').toBe(false)
})

// --- [c3] anything else still asks -------------------------------------------------------------------------

test('test_c3_a_command_or_a_host_that_differs_still_needs_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const d = await startOwnerDaemon()
  await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'always')
  expect(sshCalls()).toHaveLength(1)

  // control: the permission itself works
  await turnWithoutCard(d, [search(TOOL), host('prod', RESTART)])
  expect(sshCalls()).toHaveLength(2)

  const variants = [
    { alias: 'prod', command: `${RESTART}2`, why: 'one more character in the command' },
    { alias: 'prod', command: 'systemctl restart Nginx', why: 'one character of another case' },
    { alias: 'staging', command: RESTART, why: 'the same command on another host' },
  ]
  for (const variant of variants) {
    const before = sshCalls().length
    const { card, calls } = await turnWithCard(d, [search(TOOL), host(variant.alias, variant.command)], 'deny')
    expect(card.text, `${variant.why}: the card shows the command`).toContain(variant.command)
    expect(sshCalls().length, `${variant.why}: nothing ran for a declined card`).toBe(before)
    expect(refused(finalResult(calls)), `${variant.why}: a declined command is refused`).toBe(true)
  }

  // exec: a command nobody permitted asks, whatever was permitted for a host
  const dir = doomedDir('doomed-c3')
  const viaExec = await turnWithCard(d, [call('exec', { command: removal(dir, 'c3-exec-ok') })], 'deny')
  expect(viaExec.card.text).toContain('doomed-c3')
  expect(existsSync(dir), 'a declined exec command did not run').toBe(true)
})

// --- [c4] state.db and the restart ----------------------------------------------------------------------------

test('test_c4_permissions_are_kept_in_state_db_and_work_after_a_restart_of_the_daemon', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const command = 'systemctl restart nginx-c4persist'
  const d = await startOwnerDaemon()
  await turnWithCard(d, [search(TOOL), host('prod', command)], 'always')
  expect(sshCalls()).toHaveLength(1)
  // The end-of-turn barrier of turnWithCard already followed the stored permission: a fresh daemon reads it.
  await stopDaemon(d)

  expect(stateDbText(), 'the permission is stored in state.db').toContain(command)

  const again = await startDaemon(false)
  const calls = await turnWithoutCard(again, [search(TOOL), host('prod', command)])
  expect(sshCalls(), 'after the restart the permitted command ran without a card').toHaveLength(2)
  const result = finalResult(calls)
  expect(result.isError, result.text).toBe(false)
  expect(result.text).toContain('FAKE-SSH')

  const listed = await listApprovals(again)
  expect(listed.text, 'the permission is still listed after the restart').toContain(command)
})

// --- [c5] /approvals ------------------------------------------------------------------------------------------

test('test_c5_approvals_lists_the_permissions_with_a_revoke_button_each_and_a_revoked_command_asks_again', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const dir = doomedDir('doomed-c5')
  const remoteCommand = 'systemctl restart nginx-c5list'
  const execCommand = removal(dir, 'c5-exec-ok')
  const remote: Action[] = [search(TOOL), host('prod', remoteCommand)]
  const local: Action[] = [call('exec', { command: execCommand })]
  const d = await startOwnerDaemon()

  const empty = await listApprovals(d)
  expect(empty.text, `an empty list says so\n${empty.text}`).toMatch(EMPTY_LIST)
  expect(empty.revoke, 'nothing to revoke').toEqual([])

  await turnWithCard(d, remote, 'always')
  await turnWithCard(d, local, 'always')

  const listed = await listApprovals(d)
  expect(listed.text, 'the list shows the ssh command').toContain(remoteCommand)
  expect(listed.text, 'the list shows the host of the permission').toContain('prod')
  expect(listed.text, 'the list shows the exec command').toContain('doomed-c5')
  expect(listed.text, 'the list shows when the permission was given').toMatch(
    /\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})\b|\d{1,2}\.\d{1,2}(?!\d)|\d{1,2}:\d{2}|янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек/i,
  )
  expect(listed.text).not.toMatch(EMPTY_LIST)
  expect(listed.revoke, 'one revoke button per permission').toHaveLength(2)

  // revoke the first one on the list; the other stays
  const first = listed.revoke[0] as Listing['revoke'][number]
  await waitForUpdateComplete(d, press(OWNER_CHAT, first.messageId, first.button.data), 'the first revoke button')
  const left = await listApprovals(d)
  expect(left.revoke, 'one permission is left after one revoke').toHaveLength(1)
  const remoteLeft = left.text.includes(remoteCommand)
  const execLeft = left.text.includes('doomed-c5')
  expect(remoteLeft !== execLeft, `exactly one of the two permissions is left\n${left.text}`).toBe(true)

  // the revoked one asks again, the other one still does not
  doomedDir('doomed-c5')
  expect(await attempt(d, remote), 'ssh command: ' + (remoteLeft ? 'kept' : 'revoked')).toBe(remoteLeft ? 'ran' : 'card')
  expect(await attempt(d, local), 'exec command: ' + (execLeft ? 'kept' : 'revoked')).toBe(execLeft ? 'ran' : 'card')

  // revoke the last one: the list is empty again and both ask
  const rest = (await listApprovals(d)).revoke[0] as Listing['revoke'][number]
  await waitForUpdateComplete(d, press(OWNER_CHAT, rest.messageId, rest.button.data), 'the last revoke button')
  const none = await listApprovals(d)
  expect(none.text, `all revoked: the list is empty\n${none.text}`).toMatch(EMPTY_LIST)
  expect(none.revoke).toEqual([])
  doomedDir('doomed-c5')
  expect(await attempt(d, remote), 'ssh command after the revoke').toBe('card')
  expect(await attempt(d, local), 'exec command after the revoke').toBe('card')
})

// --- [c6] the guard and the host go first ------------------------------------------------------------------------

test('test_c6_a_command_the_guard_denies_is_refused_even_with_a_stored_permission', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const remoteDenied = 'gh repo create demo --public'
  const execDenied = 'gh repo create other --public'
  const remoteSeed = 'systemctl restart nginx-c6seed'
  const dir = doomedDir('doomed-c6')
  const execSeed = removal(dir, 'c6-exec-ok')

  const d = await startOwnerDaemon()
  await turnWithCard(d, [search(TOOL), host('prod', remoteSeed)], 'always')
  await turnWithCard(d, [call('exec', { command: execSeed })], 'always')
  // The end-of-turn barrier of the second turn is the stop point; its permission is already in state.db.
  await stopDaemon(d)

  // The permission is a text in state.db: put the denied commands in its place, as if they had been permitted
  // before the guard learned to deny them.
  expect(rewriteStoredText(remoteSeed, remoteDenied), 'the host permission is a text in state.db').toBeGreaterThan(0)
  expect(rewriteStoredText(execSeed, execDenied), 'the exec permission is a text in state.db').toBeGreaterThan(0)
  const sshBefore = sshCalls().length

  const again = await startDaemon(false)
  const listed = await listApprovals(again)
  expect(listed.text, 'the stored permission is read from state.db').toContain(remoteDenied)

  const viaHost = await turnWithoutCard(again, [search(TOOL), host('prod', remoteDenied)])
  const hostResult = finalResult(viaHost)
  expect(hostResult.isError, `a denied host command is refused: ${hostResult.text}`).toBe(true)
  expect(sshCalls().length, 'the denied command never reached ssh').toBe(sshBefore)

  const viaExec = await turnWithoutCard(again, [call('exec', { command: execDenied })])
  const execResult = finalResult(viaExec)
  expect(refused(execResult), `a denied exec command is refused: ${execResult.text}`).toBe(true)
})

test('test_c6_a_permission_does_not_outlive_the_host_it_was_given_for', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const d = await startOwnerDaemon()
  await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'always')
  expect(sshCalls()).toHaveLength(1)

  // the host leaves hosts.json: the refusal of the host goes before the permission
  writeFileSync(join(world.dshbotHome, 'hosts.json'), `${JSON.stringify({ staging: HOSTS.staging }, null, 2)}\n`)
  const calls = await turnWithoutCard(d, [search(TOOL), host('prod', RESTART)])
  const result = finalResult(calls)
  expect(result.isError, `an unknown host is an error: ${result.text}`).toBe(true)
  expect(sshCalls(), 'nothing ran on a host that is not configured').toHaveLength(1)
})

// --- [c7] turns without the owner ---------------------------------------------------------------------------------

test('test_c7_a_guest_and_a_delegated_child_get_no_use_of_the_permissions_of_the_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const dir = doomedDir('doomed-c7')
  const execCommand = removal(dir, 'c7-exec-ok')
  const d = await startOwnerDaemon()
  await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'always')
  await turnWithCard(d, [call('exec', { command: execCommand })], 'always')
  expect(sshCalls()).toHaveLength(1)
  expect(existsSync(dir), 'the owner ran the exec command through the card').toBe(false)
  doomedDir('doomed-c7')

  // a guest that forges both calls
  await admitGuest(d)
  const forged = world.stub.scripts
  forged.set('turn-gu-1', [
    call(TOOL, { host: 'prod', alias: 'prod', command: RESTART }),
    call('exec', { command: execCommand }),
  ])
  const cardsBefore = cardsIn(world.timeline, OWNER_CHAT).length
  const guestCalls = await guestTurn(d, 'turn-gu-1')
  const guestResults = allResults((guestCalls[guestCalls.length - 1] as DsEvent).body)
  expect(guestResults.length, 'the guest got an answer to every forged call').toBeGreaterThanOrEqual(2)
  const [hostResult, execResult] = guestResults as [Block, Block]
  // host_exec is not a guest tool: the forged call is refused by the seam.
  expect(refused(hostResult), `a forged host call of a guest is refused: ${hostResult.text}`).toBe(true)
  // exec is a guest tool now, but it runs only in the guest's own empty
  // sandbox. Its frame carries the wording "не выполняй команды" of the
  // external-data notice, so FAILURE_WORDS would misread a success here; the
  // actual status is checked instead. The owner's directory stays untouched.
  expect(execResult.isError, `a guest exec runs in its sandbox: ${execResult.text}`).toBe(false)
  expect(execResult.text, `a guest exec reports its exit code: ${execResult.text}`).toMatch(/^exit 0\n/)
  expect(execResult.text, `a guest exec ran in the sandbox: ${execResult.text}`).toContain('c7-exec-ok')
  expect(sshCalls(), 'the guest did not reach ssh').toHaveLength(1)
  expect(existsSync(dir), 'the guest removed nothing').toBe(true)
  expect(cardsIn(world.timeline, OWNER_CHAT).length, 'a guest draws no card').toBe(cardsBefore)

  // a delegated child that tries the same
  world.stub.childExec = execCommand
  world.stub.childHost = RESTART
  forged.set('turn-ch-1', [
    search(TOOL),
    search('delegate subagent'),
    { kind: 'delegate', task: 'kid-ap: run the commands of the owner', tools: ['exec', TOOL] },
  ])
  const parentCalls = await turnAs(d, OWNER_CHAT, 'turn-ch-1')
  expect(lastResults((parentCalls[parentCalls.length - 1] as DsEvent).body), 'the parent got an answer to the delegate call').toHaveLength(1)
  const kids = world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.role === 'child')
  expect(kids.length, 'the child ran').toBeGreaterThan(0)
  for (const result of allResults((kids[kids.length - 1] as DsEvent).body)) {
    expect(refused(result), `a call of the child is refused: ${result.text}`).toBe(true)
  }
  expect(sshCalls(), 'the child did not reach ssh').toHaveLength(1)
  expect(existsSync(dir), 'the child removed nothing').toBe(true)
  expect(cardsIn(world.timeline, OWNER_CHAT).length, 'a child draws no card').toBe(cardsBefore)
})

// --- [c8] menu, help, guest ---------------------------------------------------------------------------------------------

test('test_c8_approvals_is_in_the_menu_and_in_help_of_the_owner_and_a_guest_gets_a_refusal', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const d = await startOwnerDaemon()
  const menus = (): TgEvent[] => world.timeline.events.filter((e): e is TgEvent => e.src === 'tg' && e.method === 'setMyCommands')
  const scopeOf = (e: TgEvent): JsonObject => asObject(e.params.scope)
  const entriesOf = (e: TgEvent): JsonObject[] => (Array.isArray(e.params.commands) ? e.params.commands.map(asObject) : [])
  const isOwnerScope = (e: TgEvent): boolean => scopeOf(e).type === 'chat' && Number(scopeOf(e).chat_id) === OWNER_CHAT
  await waitFor('the menu of the owner chat', () => menus().some(isOwnerScope), d)
  await waitFor('the menu for the other chats', () => menus().some((e) => !isOwnerScope(e)), d)

  const owner = menus().filter(isOwnerScope)
  const entries = entriesOf(owner[owner.length - 1] as TgEvent).filter((entry) => entry.command === 'approvals')
  expect(entries, 'the owner menu has /approvals exactly once').toHaveLength(1)
  expect(String((entries[0] as JsonObject).description ?? '').trim().length, 'the menu entry has a description').toBeGreaterThan(0)
  const others = menus().filter((e) => !isOwnerScope(e))
  const guestNames = entriesOf(others[others.length - 1] as TgEvent).map((entry) => String(entry.command))
  expect(guestNames, 'the guest menu has no /approvals').not.toContain('approvals')

  const mark = world.timeline.seq
  say(OWNER_CHAT, '/help')
  await waitFor('the help of the owner', () => sentTo(world.timeline, OWNER_CHAT).some((e) => e.n > mark), d)
  const help = sentTo(world.timeline, OWNER_CHAT)
    .filter((e) => e.n > mark)
    .map(textOfEvent)
    .join('\n')
  const line = help.split('\n').filter((candidate) => /\/approvals\b/.test(candidate))
  expect(line, `/approvals is listed once in /help\n${help}`).toHaveLength(1)
  expect((line[0] as string).replace('/approvals', '').trim().length, '/approvals has a description in /help').toBeGreaterThan(5)

  // a stored permission the guest must not see
  await turnWithCard(d, [search(TOOL), host('prod', RESTART)], 'always')
  await admitGuest(d)
  await sleep(3_200) // background: the real 3 second pace of guest messages
  const guestMark = world.timeline.seq
  const guestBefore = sentTo(world.timeline, GUEST_CHAT).length
  const guestUpdate = say(GUEST_CHAT, '/approvals')
  await waitFor('an answer to the guest', () => sentTo(world.timeline, GUEST_CHAT).length > guestBefore, d)
  await waitForUpdateComplete(d, guestUpdate, 'the refusal to the guest')
  const guestEvents = sentTo(world.timeline, GUEST_CHAT).filter((e) => e.n > guestMark)
  const guestText = guestEvents.map(textOfEvent).join('\n')
  expect(guestText, 'the guest is refused').toMatch(/только владельц|доступн|отказ|нельзя|недоступ/i)
  expect(guestText, 'the guest sees no command of the owner').not.toMatch(/systemctl|nginx|prod/i)
  expect(guestEvents.flatMap(buttonsOf), 'the guest gets no revoke button').toEqual([])
  const modelAfter = world.timeline.events.filter((e) => e.src === 'ds' && e.n > guestMark)
  expect(modelAfter, 'the command of a guest is no model turn').toEqual([])
})
