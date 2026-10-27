// host_exec through the daemon: the owner runs a command on a host of DSHBOT_HOME/hosts.json (ssh, or the machine
// of the bot itself outside the sandbox of exec, under its own write guard), the guard verdicts and the buttons of
// the owner apply, the output is cut and scrubbed, the tool is lazy and belongs to the owner alone.
// Same harness as mcp-owner-daemon.test.ts: the daemon runs as a child process against a fake Telegram Bot API
// and a local DeepSeek stub. The stub plays the main model from a script per turn marker (`turn-xx-N`: tool
// calls first, then the answer `fin <marker>`) and the child of delegate (a request that carries `kid-xx`).
// A logical call of host_exec is mapped onto the property names of its input schema found in tools[].
// ssh is a fake executable first in the PATH of the daemon: it writes its arguments to a log and prints them.
//
// Format of hosts.json: an object, alias -> entry. An ssh entry has `user`, `host` and `port`; a local entry
// (the machine of the bot, no ssh, the write guard of host_exec instead of the exec sandbox) is `{ "local": true }`.

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

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
const CHILD_RE = /kid-[a-z]+/

const TOOL = 'host_exec'
const TOOL_SEARCH = 'tool_search'

const PROD_USER = 'deploy'
const PROD_ADDRESS = '192.0.2.10'
const PROD_PORT = '2222'

const HOSTS = {
  prod: { user: PROD_USER, host: PROD_ADDRESS, port: Number(PROD_PORT) },
  staging: { user: 'ops', host: 'staging.example.test', port: 22 },
  box: { local: true },
}

const FAILURE_WORDS = /отказ|запрещ|нельзя|не выполн|refus|denied|declin|forbid|not allowed|error|ошибк|expired|истек|истёк/i
const TIMEOUT_WORDS = /time(?:d)?[\s_-]?out|таймаут|time limit|превыш|истёк|истек/i
const TRUNCATION_WORDS = /обрез|truncat|показан|хвост|сокращ|limit|лимит|cut/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- the fake ssh -----------------------------------------------------------------------------------------

/**
 * ssh of the tests: appends `--- call` and one `ARG:<argument>` line per argument to the log, then acts on a
 * word in the arguments: BIGOUT prints a lot, HANGFOREVER writes its pid and sleeps, SECRETS prints the keys
 * of the bot (baked in, not taken from the environment), `RC=n` is the exit code. Anything else prints the
 * arguments and exits with 0.
 */
function fakeSshScript(logFile: string, pidFile: string): string {
  return `#!/bin/sh
{
  echo '--- call'
  for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
} >> '${logFile}'
all="$*"
case "$all" in
  *BIGOUT*)
    echo BIG-HEAD
    yes 'BIGLINE-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' | head -n 40000
    echo BIG-TAIL
    exit 0
    ;;
  *HANGFOREVER*)
    echo $$ > '${pidFile}'
    echo HANG-STARTED
    exec sleep 120
    ;;
  *SECRETS*)
    echo SECRET-LINE-OK
    echo 'token=${BOT_TOKEN}'
    echo 'key=${DEEPSEEK_KEY}'
    exit 0
    ;;
esac
echo FAKE-SSH
for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
rc=$(printf '%s' "$all" | sed -n 's/.*RC=\\([0-9][0-9]*\\).*/\\1/p')
exit "\${rc:-0}"
`
}

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

function lastResultText(call: DsEvent): string {
  return lastResults(call.body)
    .map((block) => block.text)
    .join('\n')
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
  | { kind: 'text'; text: string }
  | { kind: 'host'; host: string; command: string; timeoutSec?: number }
  | { kind: 'delegate'; task: string; tools: string[] }

interface Stub {
  server: Server
  origin: string
  /** Actions of a turn of main, by marker; after the last one the model answers `fin <marker>`. */
  scripts: Map<string, Action[]>
  /** Why the stub could not place a logical call onto the tools of a request, by marker. */
  problems: Map<string, string>
}

const search = (query: string): Action => ({ kind: 'tool', name: TOOL_SEARCH, input: { query } })
const call = (name: string, input: JsonObject = {}): Action => ({ kind: 'tool', name, input })
const host = (alias: string, command: string, timeoutSec?: number): Action => ({
  kind: 'host',
  host: alias,
  command,
  ...(timeoutSec === undefined ? {} : { timeoutSec }),
})

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
function hostInput(schema: Schema, alias: string, command: string, timeoutSec?: number): JsonObject | string {
  const props = Object.keys(schema.properties)
  const commandKey = props.find((p) => /^(command|cmd|script|shell|code)$/i.test(p)) ?? props.find((p) => /command|cmd/i.test(p))
  if (commandKey === undefined) return `no command property in ${JSON.stringify(props)}`
  const aliasKey =
    props.find((p) => p !== commandKey && /^(host|alias|target|server|machine|name|hostname|host_alias)$/i.test(p)) ??
    props.find((p) => p !== commandKey && /host|alias|target|server|machine/i.test(p))
  if (aliasKey === undefined) return `no alias property in ${JSON.stringify(props)}`
  const input: JsonObject = { [commandKey]: command, [aliasKey]: alias }
  if (props.includes('purpose')) input.purpose = 'проверяю поведение host_exec через карточку подтверждения'
  if (timeoutSec !== undefined) {
    const timeoutKey = props.find((p) => /timeout/i.test(p))
    if (timeoutKey === undefined) return `no timeout property in ${JSON.stringify(props)}`
    const description = String(schema.properties[timeoutKey]?.description ?? '')
    const milliseconds = /ms$|milli/i.test(timeoutKey) || /millisecond|миллисек|\bms\b/i.test(description)
    input[timeoutKey] = milliseconds ? timeoutSec * 1000 : timeoutSec
  }
  return input
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
  const stub: Stub = { server: undefined as unknown as Server, origin: '', scripts: new Map(), problems: new Map() }
  let toolUses = 0

  function answerMain(res: ServerResponse, body: JsonObject, found: { at: number; marker: string }): void {
    const { marker } = found
    const action = (stub.scripts.get(marker) ?? [])[turnStep(body, found.at)]
    if (action === undefined) {
      res.end(textStream(`fin ${marker}`))
      return
    }
    if (action.kind === 'text') {
      res.end(textStream(action.text))
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
      input = schema === undefined ? `${TOOL} is not among the tools of the request` : hostInput(schema, action.host, action.command, action.timeoutSec)
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

  function answerChild(res: ServerResponse, body: JsonObject, kid: string): void {
    const results = lastResults(body)
    if (results.length > 0) {
      res.end(textStream(`KID-REPORT ${kid}`))
      return
    }
    // the child asks for host_exec whatever its tools[] say: a model may invent a tool_use
    const schema = schemaOf(body, TOOL)
    const placed = schema === undefined ? 'no schema' : hostInput(schema, 'prod', 'echo KID-FORGED')
    const input = typeof placed === 'string' ? { host: 'prod', alias: 'prod', command: 'echo KID-FORGED' } : placed
    toolUses += 1
    res.end(toolUseStream(`toolu_kid_${toolUses}`, TOOL, input))
  }

  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (body.stream === false) {
        // the judge of /goal asks without streaming
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
  /** A directory outside the workspace and outside everything the sandbox of exec shows. */
  outside: string
  /** The fake ssh is the only file here, and this directory is first in the PATH of the daemon. */
  binDir: string
  sshLog: string
  sshPid: string
  clockFile: string
  daemons: Daemon[]
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
    FAKE_CLOCK_FILE: world.clockFile,
    NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href}`,
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
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  await pairOwner(d)
  return d
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

/** `chatId` opens a turn with `marker` and waits for the reply of the model to arrive in the chat. */
async function turnAs(d: Daemon, chatId: number, marker: string): Promise<DsEvent[]> {
  say(chatId, `${marker} сделай, пожалуйста`)
  await waitFor(`the reply of turn ${marker}`, () => replyEvent(chatId, marker) !== undefined, d, TURN_WAIT_MS)
  expectPlaced(marker, d)
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

/** Waits for the next approval card of the owner, the `seen` ones being old. */
async function nextCard(d: Daemon, seen: number): Promise<Card> {
  await waitFor('an approval card for the owner', () => cardsIn(world.timeline, OWNER_CHAT).length > seen, d, TURN_WAIT_MS)
  return cardsIn(world.timeline, OWNER_CHAT)[seen] as Card
}

// --- the files of the tests ---------------------------------------------------------------------------

function writeHosts(hosts: Record<string, unknown> = HOSTS): string {
  const file = join(world.dshbotHome, 'hosts.json')
  writeFileSync(file, `${JSON.stringify(hosts, null, 2)}\n`)
  return file
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

const doomedDir = (name: string): string => {
  const dir = join(world.outside, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'keep.txt'), 'keep\n')
  return dir
}

// --- harness lifecycle ----------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp, so a file under /tmp would be hidden for a trivial reason
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-host-exec-')))
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
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  const binDir = mkdtempSync(join(scratch, 'bin-'))
  const data = mkdtempSync(join(scratch, 'data-'))
  const sshLog = join(data, 'ssh.log')
  const sshPid = join(data, 'ssh.pid')
  writeFileSync(join(binDir, 'ssh'), fakeSshScript(sshLog, sshPid))
  chmodSync(join(binDir, 'ssh'), 0o755)
  const clockFile = join(data, 'clock-offset')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    outside: mkdtempSync(join(scratch, 'outside-')),
    binDir,
    sshLog,
    sshPid,
    clockFile,
    daemons: [],
  }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
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

// --- [c1] ssh alias ---------------------------------------------------------------------------------------

test('test_c1_ssh_alias_runs_ssh_in_batch_mode_to_the_target_and_the_model_gets_output_and_exit_code', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-sa-1', [search(TOOL), host('prod', 'echo c1-hello RC=7')])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-sa-1')
  const issued = sshCalls()
  expect(issued, `ssh was started once\n${output(d)}`).toHaveLength(1)
  const args = issued[0] as string[]
  const joined = args.join(' ')

  expect(joined, 'non-interactive: BatchMode=yes').toMatch(/BatchMode=yes/)
  const target = `${PROD_USER}@${PROD_ADDRESS}`
  const targetAt = args.findIndex((a) => a === target)
  const hostAt = args.findIndex((a) => a === PROD_ADDRESS)
  if (targetAt === -1) {
    expect(hostAt, `the address of the alias is an argument: ${joined}`).toBeGreaterThanOrEqual(0)
    const userGiven = args.some((a, i) => (a === '-l' && args[i + 1] === PROD_USER) || a === `-l${PROD_USER}` || a === `User=${PROD_USER}`)
    expect(userGiven, `the user of the alias is given: ${joined}`).toBe(true)
  }
  const portGiven = args.some((a, i) => (a === '-p' && args[i + 1] === PROD_PORT) || a === `-p${PROD_PORT}` || a === `Port=${PROD_PORT}`)
  expect(portGiven, `the port of the alias is given: ${joined}`).toBe(true)
  const commandAt = args.findIndex((a) => a.includes('c1-hello'))
  expect(commandAt, `the command is an argument: ${joined}`).toBeGreaterThanOrEqual(0)
  expect(commandAt, 'the command comes after the target').toBeGreaterThan(Math.max(targetAt, hostAt))
  expect(args.join('\n'), 'the staging alias was not used').not.toContain('staging.example.test')

  const result = finalResult(calls)
  expect(result.text, 'the model gets the output of ssh').toContain('FAKE-SSH')
  expect(result.text).toContain('BatchMode=yes')
  expect(result.text, 'the model gets the exit code').toMatch(/(?:exit|код|code)[^\n]{0,30}\b7\b|\b7\b[^\n]{0,20}(?:exit|код)/i)
  expect(cardsIn(world.timeline, OWNER_CHAT), 'an ordinary command needs no card').toEqual([])
})

// --- [c2] local alias -------------------------------------------------------------------------------------

test('test_c2_local_alias_runs_on_the_machine_of_the_bot_outside_the_sandbox_of_exec_and_without_ssh', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const secret = join(world.outside, 'outside-note.txt')
  writeFileSync(secret, 'LOCAL-OUTSIDE-SECRET-42\n')
  const read = `cat '${secret}'`
  world.stub.scripts.set('turn-lo-1', [call('exec', { command: read }), search(TOOL), host('box', read)])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-lo-1')
  expect(calls.length, 'the turn went through every scripted call').toBeGreaterThanOrEqual(4)
  expect(lastResultText(calls[1] as DsEvent), 'control: the sandbox of exec does not see the file').not.toContain('LOCAL-OUTSIDE-SECRET-42')
  const result = lastResultText(calls[3] as DsEvent)
  expect(result, `the local alias sees a file outside the workspace and outside exec\n${result}`).toContain('LOCAL-OUTSIDE-SECRET-42')
  expect(sshCalls(), 'a local alias does not use ssh').toEqual([])
})

// --- [c3] unknown alias, no hosts.json ----------------------------------------------------------------------

test('test_c3_unknown_alias_is_an_error_with_the_known_aliases_and_nothing_runs', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const marker = join(world.outside, 'unknown-ran.txt')
  world.stub.scripts.set('turn-ua-1', [search(TOOL), host('nosuchhost', `touch '${marker}' && echo c3-ran`)])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-ua-1')
  const result = finalResult(calls)
  expect(result.isError, `an unknown alias is an error: ${result.text}`).toBe(true)
  for (const alias of Object.keys(HOSTS)) expect(result.text, `the error lists the known alias ${alias}`).toContain(alias)
  expect(result.text).not.toContain('c3-ran')
  expect(sshCalls(), 'no process was started').toEqual([])
  expect(existsSync(marker), 'nothing ran on the machine of the bot').toBe(false)
})

test('test_c3_missing_hosts_json_says_the_hosts_are_not_configured_and_names_the_expected_path', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = join(world.dshbotHome, 'hosts.json')
  expect(existsSync(expected), 'the test starts without hosts.json').toBe(false)
  world.stub.scripts.set('turn-nh-1', [search(TOOL), host('prod', 'echo c3-ran')])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-nh-1')
  const result = finalResult(calls)
  expect(result.text, `the answer names the file the owner has to create\n${result.text}`).toContain(expected)
  expect(result.text, 'the answer says the hosts are not configured').toMatch(/не настро|не найден|нет файла|отсутств|not configured|not found|missing|no hosts/i)
  expect(result.text).not.toContain('c3-ran')
  expect(sshCalls(), 'no process was started').toEqual([])
})

// --- [c4] guard verdicts and the buttons of the owner ----------------------------------------------------------

test('test_c4_command_denied_by_the_guard_is_refused_without_running_and_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-gd-1', [search(TOOL), host('prod', 'df -h')])
  world.stub.scripts.set('turn-gd-2', [search(TOOL), host('prod', 'gh repo create demo --public')])
  const d = await startOwnerDaemon()

  // control: an ordinary command goes through without any card
  await ownerTurn(d, 'turn-gd-1')
  expect(sshCalls(), 'the control command reached ssh').toHaveLength(1)
  expect(cardsIn(world.timeline, OWNER_CHAT), 'an ordinary command needs no card').toEqual([])

  const calls = await ownerTurn(d, 'turn-gd-2')
  const result = finalResult(calls)
  expect(result.isError, `a command the guard denies is refused: ${result.text}`).toBe(true)
  expect(result.text.trim().length, 'the refusal says something').toBeGreaterThan(0)
  expect(sshCalls(), 'a denied command never reached ssh').toHaveLength(1)
  expect(cardsIn(world.timeline, OWNER_CHAT), 'a denied command asks nobody').toEqual([])
})

test('test_c4_dangerous_commands_run_only_after_the_allow_button_of_the_owner', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const dangerous = [
    { command: 'rm -r /srv/old-c4', shown: 'old-c4' },
    { command: 'systemctl stop nginx', shown: 'nginx' },
    { command: 'systemctl restart nginx', shown: 'nginx' },
    { command: 'reboot', shown: 'reboot' },
    { command: 'shutdown -h now', shown: 'shutdown' },
    { command: 'kill 4242', shown: '4242' },
  ]
  dangerous.forEach((item, i) => world.stub.scripts.set(`turn-dc-${i + 1}`, [search(TOOL), host('prod', item.command)]))
  const d = await startOwnerDaemon()

  for (const [i, item] of dangerous.entries()) {
    const marker = `turn-dc-${i + 1}`
    const cardsBefore = cardsIn(world.timeline, OWNER_CHAT).length
    say(OWNER_CHAT, `${marker} сделай, пожалуйста`)
    const card = await nextCard(d, cardsBefore)
    expect(card.text, `the card of "${item.command}" shows what is going to run`).toContain(item.shown)

    await sleep(1_500)
    expect(sshCalls(), `"${item.command}" did not run before the button`).toHaveLength(i)
    expect(replyEvent(OWNER_CHAT, marker), 'the turn waits for the owner').toBeUndefined()

    world.tg.push(buttonPress(OWNER_CHAT, card.messageId, card.allow))
    await waitFor(`the reply after the allow button of ${marker}`, () => replyEvent(OWNER_CHAT, marker) !== undefined, d, TURN_WAIT_MS)
    expectPlaced(marker, d)
    const issued = sshCalls()
    expect(issued, `"${item.command}" ran after the allow button`).toHaveLength(i + 1)
    expect((issued[i] as string[]).join(' '), 'ssh got the command that was confirmed').toContain(item.command)
    const result = finalResult(turnCalls(marker))
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain('FAKE-SSH')
  }
})

test('test_c4_local_alias_rm_r_waits_for_the_button_and_a_denied_card_removes_nothing', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const refused = doomedDir('refused')
  // A local command may delete only inside DSHBOT_HOME (outside it the write
  // guard refuses even an allowed card), so the allowed case lives there.
  const allowed = join(world.dshbotHome, 'allowed-c4')
  mkdirSync(allowed, { recursive: true })
  writeFileSync(join(allowed, 'keep.txt'), 'keep\n')
  world.stub.scripts.set('turn-lc-1', [search(TOOL), host('box', `rm -rf '${refused}' && echo c4-removed`)])
  world.stub.scripts.set('turn-lc-2', [search(TOOL), host('box', `rm -rf '${allowed}' && echo c4-removed`)])
  const d = await startOwnerDaemon()

  say(OWNER_CHAT, 'turn-lc-1 сотри каталог')
  const first = await nextCard(d, 0)
  await sleep(1_500)
  expect(existsSync(refused), 'nothing is removed before the button').toBe(true)
  world.tg.push(buttonPress(OWNER_CHAT, first.messageId, first.deny))
  await waitFor('the reply after the deny button', () => replyEvent(OWNER_CHAT, 'turn-lc-1') !== undefined, d, TURN_WAIT_MS)
  expectPlaced('turn-lc-1', d)
  const denied = finalResult(turnCalls('turn-lc-1'))
  expect(denied.isError, `the denied command is an error: ${denied.text}`).toBe(true)
  expect(denied.text).not.toContain('c4-removed')
  expect(existsSync(refused), 'a denied command removes nothing').toBe(true)

  say(OWNER_CHAT, 'turn-lc-2 сотри каталог')
  const second = await nextCard(d, 1)
  await sleep(1_500)
  expect(existsSync(allowed), 'nothing is removed before the button').toBe(true)
  world.tg.push(buttonPress(OWNER_CHAT, second.messageId, second.allow))
  await waitFor('the reply after the allow button', () => replyEvent(OWNER_CHAT, 'turn-lc-2') !== undefined, d, TURN_WAIT_MS)
  expectPlaced('turn-lc-2', d)
  expect(finalResult(turnCalls('turn-lc-2')).text).toContain('c4-removed')
  expect(existsSync(allowed), 'the confirmed command ran').toBe(false)
  expect(sshCalls(), 'a local alias does not use ssh').toEqual([])
})

test('test_c4_expired_card_does_not_run_the_command', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  const doomed = doomedDir('expired')
  world.stub.scripts.set('turn-le-1', [search(TOOL), host('box', `rm -rf '${doomed}' && echo c4-removed`)])
  world.stub.scripts.set('turn-le-2', [search(TOOL), host('prod', 'systemctl restart nginx')])
  const d = await startOwnerDaemon()

  // One turn per card: a typed text during an open card joins that same turn
  // through steering, so the second turn starts only after the first ended.
  // The deadline of each card passes; a late press of the allow button must
  // not run anything.
  say(OWNER_CHAT, 'turn-le-1 сотри каталог')
  const local = await nextCard(d, 0)
  setClockOffset(25 * 60 * 60 * 1000)
  world.tg.push(buttonPress(OWNER_CHAT, local.messageId, local.allow))
  await waitFor('the reply of the local turn', () => replyEvent(OWNER_CHAT, 'turn-le-1') !== undefined, d, TURN_WAIT_MS)

  say(OWNER_CHAT, 'turn-le-2 перезапусти nginx')
  const remote = await nextCard(d, 1)
  setClockOffset(50 * 60 * 60 * 1000)
  world.tg.push(buttonPress(OWNER_CHAT, remote.messageId, remote.allow))
  await waitFor('the reply of the ssh turn', () => replyEvent(OWNER_CHAT, 'turn-le-2') !== undefined, d, TURN_WAIT_MS)

  for (const marker of ['turn-le-1', 'turn-le-2']) {
    const result = finalResult(turnCalls(marker))
    expect(result.isError || FAILURE_WORDS.test(result.text), `a command whose approval expired is refused: ${result.text}`).toBe(true)
    expect(result.text).not.toContain('c4-removed')
    expect(result.text).not.toContain('FAKE-SSH')
  }
  expect(existsSync(doomed), 'an expired approval must not run the command').toBe(true)
  expect(sshCalls(), 'an expired approval must not start ssh').toEqual([])
})

// --- [c5] limit, timeout, secrets ---------------------------------------------------------------------------

test('test_c5_output_over_the_limit_is_cut_with_a_mark', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-ol-1', [search(TOOL), host('prod', 'cat /var/log/big BIGOUT')])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-ol-1')
  expect(sshCalls(), 'ssh ran').toHaveLength(1)
  const result = finalResult(calls)
  // the fake printed about 2.5 MB
  expect(result.text.length, 'the output the model gets is far shorter than what ssh printed').toBeLessThan(400_000)
  expect(result.text, 'the output is not lost altogether').toMatch(/BIGLINE|BIG-HEAD|BIG-TAIL/)
  expect(result.text, `the cut is marked\n${result.text.slice(0, 300)}`).toMatch(TRUNCATION_WORDS)
})

test('test_c5_command_over_the_timeout_is_killed_and_the_model_gets_a_timeout_mark', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-ot-1', [search(TOOL), host('prod', 'sleep-on-the-host HANGFOREVER', 3)])
  const d = await startOwnerDaemon()

  const started = Date.now()
  const calls = await ownerTurn(d, 'turn-ot-1')
  expect(Date.now() - started, 'the call did not wait for the 120 s of the fake ssh').toBeLessThan(90_000)
  expect(existsSync(world.sshPid), 'ssh was started').toBe(true)
  const pid = Number(readFileSync(world.sshPid, 'utf8').trim())
  expect(Number.isInteger(pid) && pid > 0, 'the fake ssh wrote its pid').toBe(true)

  const result = finalResult(calls)
  expect(result.text, `the result of a timed out command is marked\n${result.text}`).toMatch(TIMEOUT_WORDS)

  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  await waitFor('the ssh process of the timed out command to end', () => !alive(), d, 10_000)
})

test('test_c5_values_of_the_telegram_token_and_the_deepseek_key_are_replaced_in_the_output', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-os-1', [search(TOOL), host('prod', 'env-of-the-host SECRETS')])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-os-1')
  expect(sshCalls(), 'ssh ran').toHaveLength(1)
  const result = finalResult(calls)
  expect(result.text, `the output reached the model\n${result.text}`).toContain('SECRET-LINE-OK')
  expect(result.text, 'the token of the bot is scrubbed').not.toContain(BOT_TOKEN)
  expect(result.text, 'the DeepSeek key is scrubbed').not.toContain(DEEPSEEK_KEY)
  expect(result.text, 'a placeholder stands in the place of a value').toMatch(/token=\S*[^\s=]/)
  // nothing of it reaches the owner chat or any later request either
  for (const event of world.timeline.events) {
    if (event.src === 'tg') expect(JSON.stringify(event.params)).not.toContain(DEEPSEEK_KEY)
    else expect(JSON.stringify(event.body)).not.toContain(DEEPSEEK_KEY)
  }
})

// --- [c6] lazy, owner only, no delegate -----------------------------------------------------------------------

test('test_c6_host_exec_is_lazy_for_the_owner_and_a_guest_gets_nothing_of_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-lz-1', [search(TOOL), host('prod', 'echo c6-owner')])
  world.stub.scripts.set('turn-lz-2', [call(TOOL, { host: 'prod', alias: 'prod', command: 'echo GUEST-FORGED' })])
  const d = await startOwnerDaemon()

  const calls = await ownerTurn(d, 'turn-lz-1')
  expect(toolNames((calls[0] as DsEvent).body), 'host_exec is not in tools[] of the first request of the owner').not.toContain(TOOL)
  expect(toolNames((calls[0] as DsEvent).body), 'the owner finds tools through tool_search').toContain(TOOL_SEARCH)
  expect(lastResultText(calls[1] as DsEvent), 'tool_search finds host_exec').toContain(TOOL)
  expect(toolNames((calls[1] as DsEvent).body), 'after tool_search host_exec is among the tools').toContain(TOOL)
  expect(sshCalls(), 'the owner ran a command through the loaded tool').toHaveLength(1)

  await admitGuest(d)
  const guestCalls = await guestTurn(d, 'turn-lz-2')
  for (const guestCall of guestCalls) {
    expect(toolNames(guestCall.body), 'the request of a guest turn declares the three guest tools').toEqual([
      'exec',
      'web_fetch',
      'web_search',
    ])
    expect(systemTextOf(guestCall.body), 'the guest is told nothing of host_exec').not.toContain(TOOL)
  }
  const forged = lastResults((guestCalls[guestCalls.length - 1] as DsEvent).body)
  for (const result of forged) {
    expect(refused(result), `a forged call of the guest is refused: ${result.text}`).toBe(true)
    expect(result.text).not.toContain('GUEST-FORGED')
  }
  expect(sshCalls(), 'the forged call of the guest did not reach ssh').toHaveLength(1)
})

test('test_c6_delegate_child_cannot_call_host_exec', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeHosts()
  world.stub.scripts.set('turn-ld-1', [search(TOOL), host('prod', 'echo c6-parent')])
  world.stub.scripts.set('turn-ld-2', [
    search(TOOL),
    search('delegate subagent'),
    { kind: 'delegate', task: 'kid-hx: run a command on the host prod', tools: [TOOL, 'read'] },
  ])
  const d = await startOwnerDaemon()

  // control: the parent itself may use the tool
  await ownerTurn(d, 'turn-ld-1')
  expect(sshCalls(), 'the parent ran a command through host_exec').toHaveLength(1)

  const calls = await ownerTurn(d, 'turn-ld-2')
  const delegated = lastResults((calls[calls.length - 1] as DsEvent).body)
  expect(delegated, `the parent got an answer to the delegate call\n${output(d)}`).toHaveLength(1)

  const kids = world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.role === 'child')
  for (const kid of kids) expect(toolNames(kid.body), 'a child never holds host_exec').not.toContain(TOOL)
  for (const kid of kids) {
    for (const result of lastResults(kid.body)) {
      expect(refused(result), `a call of host_exec by a child is refused: ${result.text}`).toBe(true)
      expect(result.text).not.toContain('KID-FORGED')
      expect(result.text).not.toContain('FAKE-SSH')
    }
  }
  expect(sshCalls(), 'no child reached ssh').toHaveLength(1)
  expect(cardsIn(world.timeline, OWNER_CHAT), 'a child asks the owner nothing: no approval card').toEqual([])
  expect(d.exited, `the daemon survives\n${output(d)}`).toBe(false)
})
