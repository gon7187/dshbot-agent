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
const RESULT_MARK = '@@RESULT@@'
const DEFAULT_LIMIT = 30_000

// --- local stub of the DeepSeek Messages API: answers tool_use until a tool_result arrives ----

interface ToolCall {
  name: string
  input: Record<string, unknown>
}

interface StubRequest {
  method: string
  path: string
  raw: string
  body: Record<string, unknown> | undefined
}

interface Stub {
  server: Server
  origin: string
  requests: StubRequest[]
  /** The tool_use the stub answers with while the last message is not a tool_result. */
  toolCall: ToolCall | undefined
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

function toolUseStream(id: string, call: ToolCall): string {
  return [
    messageStart(),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: call.name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
    }),
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

function lastMessageHasToolResult(body: Record<string, unknown> | undefined): boolean {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const content = asRecord(messages[messages.length - 1])?.content
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_result')
}

async function startStub(): Promise<Stub> {
  const requests: StubRequest[] = []
  const stub: Stub = { server: createServer(), origin: '', requests, toolCall: undefined }
  let toolUses = 0
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> | undefined
      try {
        body = asRecord(JSON.parse(raw))
      } catch {
        body = undefined
      }
      requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://stub').pathname, raw, body })
      if (body && body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(textMessage('готово'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (stub.toolCall && !lastMessageHasToolResult(body)) {
        toolUses += 1
        res.end(toolUseStream(`toolu_stub_${toolUses}`, stub.toolCall))
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

type ModelCall = { raw: string; body: Record<string, unknown> }

function modelCalls(stub: Stub, from = 0): ModelCall[] {
  const calls: ModelCall[] = []
  for (const r of stub.requests.slice(from)) {
    if (r.method === 'POST' && r.path.endsWith('/messages') && r.body && Array.isArray(r.body.messages)) {
      calls.push({ raw: r.raw, body: r.body })
    }
  }
  return calls
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

/** Texts of all tool_result blocks in the request, in order. */
function toolResultsOf(body: Record<string, unknown>): string[] {
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

function toolsOf(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.tools) ? body.tools : []
}

function findKey(value: unknown, key: string): unknown {
  const record = asRecord(value)
  if (!record) return undefined
  if (key in record) return record[key]
  for (const inner of Object.values(record)) {
    const found = findKey(inner, key)
    if (found !== undefined) return found
  }
  return undefined
}

/** The serialized `tools` part of the request: this is what lands in the prompt prefix. */
function toolsBytes(body: Record<string, unknown>): string {
  return JSON.stringify(body.tools)
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

// Runs startRunner with tools built from the config, the given prompts and stop() in a plain node process.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const executeCalls = []
const beforeCalls = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ executeCalls, beforeCalls, ...extra }))
function run(spec, args) {
  executeCalls.push({ name: spec.name, args })
  switch (spec.behavior) {
    case 'echo': return String(args.text)
    case 'throw': throw new Error('сломалось')
    case 'big': return 'Ж'.repeat(cfg.bigLength) + 'TAILMARK'
    case 'secret': return 'token=' + cfg.secrets[0] + ' end'
    default: return 'ok'
  }
}
try {
  const { startRunner } = await import(cfg.entry)
  const tools = cfg.tools.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema,
    input_schema: spec.schema,
    schema: spec.schema,
    jsonSchema: spec.schema,
    execute: async (args) => run(spec, args),
  }))
  const options = {
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    tools,
  }
  if (cfg.secrets.length > 0) options.secrets = cfg.secrets
  if (cfg.denyReason !== undefined) {
    options.beforeTool = async (name, args) => {
      beforeCalls.push({ name, args })
      return { kind: 'deny', verdict: 'deny', decision: 'deny', allow: false, allowed: false, reason: cfg.denyReason }
    }
  }
  const runner = await startRunner(options)
  const replies = []
  for (const text of cfg.prompts) replies.push(await runner.prompt(text))
  await runner.stop()
  report({ replies })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

type Behavior = 'echo' | 'throw' | 'big' | 'secret'

interface ToolSpec {
  name: string
  description: string
  schema: Record<string, unknown>
  behavior: Behavior
}

interface ChildConfig {
  dshHome: string
  cwd: string
  baseUrl: string
  prompts: string[]
  tools: ToolSpec[]
  secrets: string[]
  denyReason?: string
  bigLength: number
}

interface ChildReport {
  executeCalls: Array<{ name: string; args: unknown }>
  beforeCalls: Array<{ name: string; args: unknown }>
  replies?: string[]
  error?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

const ECHO_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'what to repeat' } },
  required: ['text'],
}

const EMPTY_SCHEMA = { type: 'object', properties: {} }

function echoTool(): ToolSpec {
  return { name: 'echo', description: 'Повторяет переданный текст', schema: ECHO_SCHEMA, behavior: 'echo' }
}

function alphaTool(): ToolSpec {
  return {
    name: 'alpha',
    description: 'Второй инструмент для проверки порядка',
    schema: {
      type: 'object',
      properties: { zeta: { type: 'number' }, beta: { type: 'string' }, omega: { type: 'boolean' } },
      required: ['zeta', 'beta'],
    },
    behavior: 'echo',
  }
}

function plainTool(name: string, behavior: Behavior): ToolSpec {
  return { name, description: `tool ${name}`, schema: EMPTY_SCHEMA, behavior }
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-tools-test-'))
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

function runChild(overrides: Partial<ChildConfig> & { prompts: string[]; tools: ToolSpec[] }): Promise<ChildRun> {
  const cfg: ChildConfig = {
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    secrets: [],
    bigLength: DEFAULT_LIMIT + 10_000,
    ...overrides,
  }
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

function expectCleanRun(run: ChildRun): ChildReport {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  return run.report as ChildReport
}

/** Model calls that already carry a tool_result, with the tool_result texts. */
function callsWithResults(): Array<{ call: ModelCall; results: string[] }> {
  return modelCalls(stub)
    .map((call) => ({ call, results: toolResultsOf(call.body) }))
    .filter((entry) => entry.results.length > 0)
}

// --- tests -------------------------------------------------------------------------------

test('test_c1_tool_use of echo runs execute once and its result goes back to the model', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.toolCall = { name: 'echo', input: { text: 'hi' } }
  const run = await runChild({ prompts: ['say hi'], tools: [echoTool()] })
  const report = expectCleanRun(run)

  expect(report.executeCalls).toEqual([{ name: 'echo', args: { text: 'hi' } }])
  expect(report.replies).toEqual(['готово'])

  const followUps = callsWithResults()
  expect(followUps.length).toBeGreaterThan(0)
  expect(followUps.some((entry) => entry.results.some((text) => text.includes('hi')))).toBe(true)
})

test('test_c2_first request describes echo with name, description and JSON schema', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.toolCall = { name: 'echo', input: { text: 'hi' } }
  const run = await runChild({ prompts: ['say hi'], tools: [echoTool()] })
  expectCleanRun(run)

  const calls = modelCalls(stub)
  expect(calls.length).toBeGreaterThan(0)
  const first = calls[0]
  const entry = toolsOf(first?.body ?? {}).map(asRecord).find((tool) => tool?.name === 'echo')
  expect(entry, 'echo is listed in the request tools').toBeDefined()
  expect(entry?.description).toContain('Повторяет переданный текст')

  const properties = asRecord(findKey(entry, 'properties'))
  expect(asRecord(properties?.text)?.type).toBe('string')
  const required = findKey(entry, 'required')
  expect(Array.isArray(required) ? required : []).toContain('text')
})

test('test_c3_beforeTool deny skips execute and the model gets the reason', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.toolCall = { name: 'echo', input: { text: 'hi' } }
  const run = await runChild({ prompts: ['say hi'], tools: [echoTool()], denyReason: 'запрещено' })
  const report = expectCleanRun(run)

  expect(report.beforeCalls).toEqual([{ name: 'echo', args: { text: 'hi' } }])
  expect(report.executeCalls).toEqual([])
  expect(report.replies).toEqual(['готово'])

  const followUps = callsWithResults()
  expect(followUps.length).toBeGreaterThan(0)
  expect(followUps.some((entry) => entry.results.some((text) => text.includes('запрещено')))).toBe(true)
})

test('test_c4_throwing tool does not fail the turn and the model gets the error text', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.toolCall = { name: 'boom', input: {} }
  const run = await runChild({ prompts: ['break it'], tools: [plainTool('boom', 'throw')] })
  const report = expectCleanRun(run)

  expect(report.executeCalls).toEqual([{ name: 'boom', args: {} }])
  expect(report.replies).toEqual(['готово'])

  const followUps = callsWithResults()
  expect(followUps.length).toBeGreaterThan(0)
  expect(followUps.some((entry) => entry.results.some((text) => text.includes('сломалось')))).toBe(true)
})

test('test_c5_tool output over the default limit is cut and marked', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.toolCall = { name: 'big', input: {} }
  const run = await runChild({ prompts: ['give me a lot'], tools: [plainTool('big', 'big')], bigLength: DEFAULT_LIMIT + 10_000 })
  const report = expectCleanRun(run)
  expect(report.executeCalls).toHaveLength(1)

  const followUps = callsWithResults()
  expect(followUps.length).toBeGreaterThan(0)
  const result = followUps[0]?.results[0] ?? ''
  const kept = result.split('Ж').length - 1
  // the limit is respected, almost all of it is kept (the note may share the limit) and the cut is marked
  expect(kept).toBeLessThanOrEqual(DEFAULT_LIMIT)
  expect(kept).toBeGreaterThanOrEqual(DEFAULT_LIMIT - 1_000)
  expect(result).not.toContain('TAILMARK')
  expect(result.replaceAll('Ж', '').trim().length).toBeGreaterThan(0)
  expect(result.length).toBeLessThanOrEqual(DEFAULT_LIMIT + 1_000)
})

test('test_c6_secrets are cut out of tool results before they reach the model', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const secret = 'sk-SECRET-1234567890abcdef'
  stub.toolCall = { name: 'leak', input: {} }
  const run = await runChild({ prompts: ['read the token'], tools: [plainTool('leak', 'secret')], secrets: [secret] })
  const report = expectCleanRun(run)
  expect(report.executeCalls).toHaveLength(1)
  expect(report.replies).toEqual(['готово'])

  const followUps = callsWithResults()
  expect(followUps.length).toBeGreaterThan(0)
  const result = followUps[0]?.results[0] ?? ''
  expect(result).toContain('token=')
  expect(result).toContain('end')
  expect(result).not.toContain(secret)
  for (const request of stub.requests) expect(request.raw).not.toContain(secret)
})

test('test_c7_tool schemas are byte-identical across turns, restarts and tool order', { timeout: CHILD_TIMEOUT_MS * 3 }, async () => {
  stub.toolCall = { name: 'echo', input: { text: 'hi' } }
  const forward = [echoTool(), alphaTool()]
  const backward = [alphaTool(), echoTool()]

  const first = await runChild({ prompts: ['turn one', 'turn two'], tools: forward })
  expectCleanRun(first)
  const firstCalls = modelCalls(stub).filter((call) => toolsOf(call.body).length > 0)
  // two turns, each with the tool_use request and the follow-up after the tool_result
  expect(firstCalls.length).toBeGreaterThanOrEqual(4)
  const reference = toolsBytes(firstCalls[0]?.body ?? {})
  const names = toolsOf(firstCalls[0]?.body ?? {}).map((tool) => asRecord(tool)?.name)
  expect(names).toContain('echo')
  expect(names).toContain('alpha')
  for (const call of firstCalls) expect(toolsBytes(call.body)).toBe(reference)

  const seenAfterFirst = stub.requests.length
  const restarted = await runChild({ prompts: ['turn three'], tools: forward })
  expectCleanRun(restarted)
  const restartedCalls = modelCalls(stub, seenAfterFirst).filter((call) => toolsOf(call.body).length > 0)
  expect(restartedCalls.length).toBeGreaterThan(0)
  for (const call of restartedCalls) expect(toolsBytes(call.body)).toBe(reference)

  const seenAfterRestart = stub.requests.length
  const reversed = await runChild({ prompts: ['turn four'], tools: backward })
  expectCleanRun(reversed)
  const reversedCalls = modelCalls(stub, seenAfterRestart).filter((call) => toolsOf(call.body).length > 0)
  expect(reversedCalls.length).toBeGreaterThan(0)
  for (const call of reversedCalls) expect(toolsBytes(call.body)).toBe(reference)
})
