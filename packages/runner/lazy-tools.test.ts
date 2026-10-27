import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@LAZY-RESULT@@'

const SEARCH_TRIGGER = 'SEARCH_NOW'
const LAZY_NAME = 'weather_lookup'
const LAZY_DESCRIPTION = 'Прогноз погоды по городу: температура, осадки и ветер на ближайшие семь дней подряд'
const OTHER_LAZY_NAME = 'zz_ledger_export'
const OTHER_LAZY_DESCRIPTION = 'Выгрузка бухгалтерской книги в таблицу за выбранный квартал отчётного года'
const CORE_NAMES = ['alpha_core', 'zeta_core']
const SEARCH_QUERY = 'weather'

// --- local stub of the DeepSeek Messages API: calls tool_search when asked ----------------------

interface StubRequest {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

interface Stub {
  server: Server
  origin: string
  requests: StubRequest[]
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

function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function toolUseStream(id: string, name: string, input: Record<string, unknown>): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const text = asRecord(block)?.text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function lastMessage(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  return asRecord(messages[messages.length - 1])
}

function lastMessageHasToolResult(body: Record<string, unknown> | undefined): boolean {
  const content = lastMessage(body)?.content
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_result')
}

function lastUserText(body: Record<string, unknown> | undefined): string {
  const message = lastMessage(body)
  return message?.role === 'user' ? blockText(message.content) : ''
}

async function startStub(): Promise<Stub> {
  const requests: StubRequest[] = []
  const stub: Stub = { server: createServer(), origin: '', requests }
  let toolUses = 0
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> | undefined
      try {
        body = asRecord(JSON.parse(raw))
      } catch {
        body = undefined
      }
      requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://stub').pathname, body })
      if (body && body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(textMessage('готово'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (!lastMessageHasToolResult(body) && lastUserText(body).includes(SEARCH_TRIGGER)) {
        toolUses += 1
        res.end(toolUseStream(`toolu_stub_${toolUses}`, 'tool_search', { query: SEARCH_QUERY }))
        return
      }
      res.end(textStream('готово'))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- reading what the stub received -------------------------------------------------------

type Body = Record<string, unknown>

/** Model requests (streamed Messages calls) in arrival order. */
function modelCalls(stub: Stub, from = 0): Body[] {
  const calls: Body[] = []
  for (const r of stub.requests.slice(from)) {
    if (r.method !== 'POST' || !r.path.endsWith('/messages') || !r.body || !Array.isArray(r.body.messages)) continue
    if (r.body.stream === false) continue
    calls.push(r.body)
  }
  return calls
}

function toolNames(body: Body): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => String(asRecord(tool)?.name))
}

function systemTextOf(body: Body): string {
  return blockText(body.system)
}

function toolResultsOf(body: Body): string[] {
  const results: string[] = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    const content = asRecord(message)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = asRecord(block)
      if (record?.type === 'tool_result') results.push(blockText(record.content))
    }
  }
  return results
}

/** The request that answers the tool_search call: it ends with that tool_result. */
function afterSearch(calls: Body[]): Body | undefined {
  return calls.find((body) => lastMessageHasToolResult(body))
}

/** The first request of the turn whose user text contains `marker`. */
function firstCallOfTurn(calls: Body[], marker: string): Body | undefined {
  return calls.find((body) => lastUserText(body).includes(marker))
}

// --- child process driver ----------------------------------------------------------------

const HOOKS_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\/.*\\.js$/.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

const REGISTER_SOURCE = `
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

// Registers the configured tools (lazy ones with lazy: true), then sends each prompt to the main session.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
try {
  const { startRunner } = await import(cfg.entry)
  const tools = cfg.tools.map((spec) => ({
    name: spec.name,
    description: spec.description,
    ...(spec.lazy ? { lazy: true } : {}),
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => 'EXEC:' + spec.name,
  }))
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    model: cfg.model,
    tools,
  })
  const replies = []
  for (const text of cfg.turns) replies.push(await runner.prompt(text))
  await runner.stop()
  report({ replies })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ToolSpec {
  name: string
  description: string
  lazy: boolean
}

const TOOLS: ToolSpec[] = [
  ...CORE_NAMES.map((name) => ({ name, description: `Основной инструмент ${name}`, lazy: false })),
  { name: LAZY_NAME, description: LAZY_DESCRIPTION, lazy: true },
  { name: OTHER_LAZY_NAME, description: OTHER_LAZY_DESCRIPTION, lazy: true },
]

interface ChildReport {
  replies?: string[]
  error?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-lazy-tools-test-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  stub = await startStub()
  tmpHome = mkdtempSync(join(scratch, 'home-'))
  dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  workDir = mkdtempSync(join(scratch, 'cwd-'))
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    stub.server.closeAllConnections()
    stub.server.close(() => resolve())
  })
})

function runChild(model: string, turns: string[]): Promise<ChildRun> {
  const cfg = { dshHome, cwd: workDir, baseUrl: `${stub.origin}/anthropic`, model, tools: TOOLS, turns }
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify({ ...cfg, entry: runnerEntry }),
  ]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS - 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK))
      const report = line ? (JSON.parse(line.slice(RESULT_MARK.length)) as ChildReport) : undefined
      resolve({ report, output: `${stdout}\n${stderr}`.slice(-4000) })
    })
  })
}

function expectCleanRun(run: ChildRun): void {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
}

const CORE_WITH_SEARCH = [...CORE_NAMES, 'tool_search'].sort()

test(
  'test_initial_request_has_only_core_tools_and_prefix_index: lazy tools stay out of tools[], the prefix lists them as "name: description"',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild('deepseek-flash', ['просто ответь'])
    expectCleanRun(run)

    const calls = modelCalls(stub)
    expect(calls.length, run.output).toBeGreaterThanOrEqual(1)
    const first = calls[0]!
    expect(toolNames(first)).toEqual(CORE_WITH_SEARCH)

    const system = systemTextOf(first)
    expect(system.startsWith('Ты — тестовый помощник DSHBOT, префикс №1')).toBe(true)
    expect(system).toContain(`${LAZY_NAME}: ${LAZY_DESCRIPTION.slice(0, 55)}`)
    expect(system).toContain(`${OTHER_LAZY_NAME}: ${OTHER_LAZY_DESCRIPTION.slice(0, 55)}`)
    // the index line is capped at 60 characters of description
    expect(system).not.toContain(LAZY_DESCRIPTION.slice(0, 75))
    expect(system).not.toContain(OTHER_LAZY_DESCRIPTION.slice(0, 75))
  },
)

test(
  'test_enable_tool_search_adds_schema_on_flash_prefix_unchanged: the next request declares the found tool, the system prompt stays byte-identical',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild('deepseek-flash', [`${SEARCH_TRIGGER} найди инструмент`, 'просто ответь'])
    expectCleanRun(run)

    const calls = modelCalls(stub)
    const first = calls[0]
    const answered = afterSearch(calls)
    const nextTurn = firstCallOfTurn(calls, 'просто ответь')
    expect(first, run.output).toBeDefined()
    expect(answered, run.output).toBeDefined()
    expect(nextTurn, run.output).toBeDefined()

    expect(toolNames(first!)).toEqual(CORE_WITH_SEARCH)
    for (const body of [answered!, nextTurn!]) {
      const names = toolNames(body)
      expect(names).toContain(LAZY_NAME)
      expect(names).not.toContain(OTHER_LAZY_NAME)
      for (const core of CORE_WITH_SEARCH) expect(names).toContain(core)
      const schema = (body.tools as unknown[]).map(asRecord).find((tool) => tool?.name === LAZY_NAME)
      expect(schema?.description).toBe(LAZY_DESCRIPTION)
      expect(asRecord(schema?.input_schema)?.type).toBe('object')
    }

    const prefix = Buffer.from(systemTextOf(first!), 'utf8')
    for (const body of calls) expect(Buffer.from(systemTextOf(body), 'utf8').equals(prefix)).toBe(true)
  },
)

test(
  'test_leading_tool_search_keeps_tools_and_says_next_session: a leading-only model gets the answer, tools[] does not change',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild('deepseek-v4-pro', [`${SEARCH_TRIGGER} найди инструмент`, 'просто ответь'])
    expectCleanRun(run)

    const calls = modelCalls(stub)
    expect(calls.length, run.output).toBeGreaterThanOrEqual(3)
    const answered = afterSearch(calls)
    expect(answered, run.output).toBeDefined()

    // the model is told the tool comes with the next session
    const results = toolResultsOf(answered!)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatch(/следующ\S*\s+сесс/i)

    // no request of this session ever declares a lazy tool
    for (const body of calls) {
      expect(toolNames(body)).toEqual(CORE_WITH_SEARCH)
      expect(systemTextOf(body)).toBe(systemTextOf(calls[0]!))
    }
  },
)

test(
  'test_persist_enabled_tool_survives_restart: after a new runner on the same home the same session still declares the found tool',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    const first = await runChild('deepseek-flash', [`${SEARCH_TRIGGER} найди инструмент`])
    expectCleanRun(first)
    const firstCalls = modelCalls(stub)
    expect(toolNames(afterSearch(firstCalls)!)).toContain(LAZY_NAME)

    const seen = stub.requests.length
    const second = await runChild('deepseek-flash', ['после перезапуска'])
    expectCleanRun(second)

    const resumedCalls = modelCalls(stub, seen)
    expect(resumedCalls.length, second.output).toBeGreaterThanOrEqual(1)
    const resumed = firstCallOfTurn(resumedCalls, 'после перезапуска')
    expect(resumed, second.output).toBeDefined()
    // the session is the same: its earlier history is still sent
    expect(JSON.stringify(resumed!.messages)).toContain(SEARCH_TRIGGER)
    const names = toolNames(resumed!)
    expect(names).toContain(LAZY_NAME)
    expect(names).not.toContain(OTHER_LAZY_NAME)
    for (const core of CORE_WITH_SEARCH) expect(names).toContain(core)
    expect(systemTextOf(resumed!)).toBe(systemTextOf(firstCalls[0]!))
  },
)
