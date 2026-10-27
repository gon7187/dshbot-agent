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
const RESULT_MARK = '@@SESSION-RESULT@@'
const ECHO_PREFIX = 'ECHO-RESULT:'

// --- local stub of the DeepSeek Messages API: answers tool_use until a tool_result arrives ----

interface ToolCall {
  name: string
  input: Record<string, unknown>
}

interface StubRequest {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

interface Stub {
  server: Server
  origin: string
  requests: StubRequest[]
  /** Which tool_use the stub answers with, chosen by the marker found in the conversation's first message. */
  callFor: (marker: string | undefined) => ToolCall | undefined
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

function lastMessageHasToolResult(body: Record<string, unknown> | undefined): boolean {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const content = asRecord(messages[messages.length - 1])?.content
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_result')
}

const MARKERS = ['MARK_MAIN', 'MARK_G1', 'MARK_G2']

/** Which test prompt opened this conversation: the first message carries it. */
function markerOf(body: Record<string, unknown> | undefined): string | undefined {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const text = blockText(asRecord(messages[0])?.content)
  return MARKERS.find((marker) => text.includes(marker))
}

async function startStub(): Promise<Stub> {
  const requests: StubRequest[] = []
  const stub: Stub = { server: createServer(), origin: '', requests, callFor: () => undefined }
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
      const call = stub.callFor(markerOf(body))
      if (call && !lastMessageHasToolResult(body)) {
        toolUses += 1
        res.end(toolUseStream(`toolu_stub_${toolUses}`, call))
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

interface ModelCall {
  body: Record<string, unknown>
}

/** Model requests of one conversation, in order. */
function callsOf(stub: Stub, marker: string): ModelCall[] {
  const calls: ModelCall[] = []
  for (const r of stub.requests) {
    if (r.method !== 'POST' || !r.path.endsWith('/messages') || !r.body || !Array.isArray(r.body.messages)) continue
    if (r.body.stream === false) continue
    if (markerOf(r.body) === marker) calls.push({ body: r.body })
  }
  return calls
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => String(asRecord(tool)?.name))
}

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

// Registers the configured tools, then sends each prompt in its own session, in order.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const executeCalls = []
const beforeCalls = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ executeCalls, beforeCalls, ...extra }))
try {
  const { startRunner } = await import(cfg.entry)
  const tools = cfg.toolNames.map((name) => ({
    name,
    description: 'tool ' + name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args) => {
      executeCalls.push({ name, args })
      return '${ECHO_PREFIX}' + String(args.text)
    },
  }))
  const options = {
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    tools,
  }
  if (cfg.withHook) {
    options.beforeTool = async (name, args, context) => {
      beforeCalls.push({ name, args, sessionId: context && context.sessionId })
      return { kind: 'allow' }
    }
  }
  const runner = await startRunner(options)
  const replies = []
  for (const turn of cfg.turns) replies.push(await runner.prompt(turn.text, turn.session))
  await runner.stop()
  report({ replies })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface Turn {
  text: string
  session?: { sessionId?: string; tools?: string[] }
}

interface ChildConfig {
  dshHome: string
  cwd: string
  baseUrl: string
  toolNames: string[]
  turns: Turn[]
  withHook: boolean
}

interface ChildReport {
  executeCalls: Array<{ name: string; args: unknown }>
  beforeCalls: Array<{ name: string; args: unknown; sessionId: unknown }>
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
  scratch = mkdtempSync(join(tmpdir(), 'runner-session-tools-test-'))
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

function runChild(overrides: Pick<ChildConfig, 'toolNames' | 'turns'> & Partial<ChildConfig>): Promise<ChildRun> {
  const cfg: ChildConfig = {
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    withHook: false,
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

const ECHO_CALL: ToolCall = { name: 'echo', input: { text: 'ping' } }

test(
  'test_c1_default_session_tools: main gets every registered tool, any other session gets none',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    stub.callFor = (marker) => (marker === undefined ? undefined : ECHO_CALL)
    const run = await runChild({
      toolNames: ['echo', 'alpha'],
      turns: [
        { text: 'MARK_MAIN привет' },
        { text: 'MARK_G1 привет', session: { sessionId: 'guest-1' } },
      ],
    })
    const report = expectCleanRun(run)

    const mainCalls = callsOf(stub, 'MARK_MAIN')
    expect(mainCalls.length, run.output).toBeGreaterThanOrEqual(2)
    expect(toolNames(mainCalls[0]!.body)).toEqual(['alpha', 'echo'])
    // main's tool_use was executed and its result went back to the model
    expect(report.executeCalls.filter((c) => c.name === 'echo' && JSON.stringify(c.args) === JSON.stringify({ text: 'ping' }))).toHaveLength(1)
    expect(toolResultsOf(mainCalls[1]!.body).join('\n')).toContain(`${ECHO_PREFIX}ping`)

    const guestCalls = callsOf(stub, 'MARK_G1')
    expect(guestCalls.length, run.output).toBeGreaterThanOrEqual(1)
    for (const call of guestCalls) expect(toolNames(call.body)).toEqual([])
  },
)

test(
  'test_c2_session_request_has_only_allowed_tools_sorted: RunnerSession.tools narrows the request, order stays by name',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    stub.callFor = () => undefined
    const run = await runChild({
      toolNames: ['zed', 'echo', 'alpha'],
      turns: [
        { text: 'MARK_MAIN привет' },
        { text: 'MARK_G1 привет', session: { sessionId: 'guest-1', tools: ['zed', 'alpha'] } },
        { text: 'MARK_G2 привет', session: { sessionId: 'guest-2' } },
      ],
    })
    expectCleanRun(run)

    const mainCalls = callsOf(stub, 'MARK_MAIN')
    expect(mainCalls.length, run.output).toBeGreaterThanOrEqual(1)
    expect(toolNames(mainCalls[0]!.body)).toEqual(['alpha', 'echo', 'zed'])

    const guest1 = callsOf(stub, 'MARK_G1')
    expect(guest1.length, run.output).toBeGreaterThanOrEqual(1)
    expect(toolNames(guest1[0]!.body)).toEqual(['alpha', 'zed'])

    const guest2 = callsOf(stub, 'MARK_G2')
    expect(guest2.length, run.output).toBeGreaterThanOrEqual(1)
    expect(toolNames(guest2[0]!.body)).toEqual([])
  },
)

test(
  'test_c3_disallowed_tool_use_is_rejected_before_execute: invented tool_use does not run execute, the model gets a refusal',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    // every session's model asks for echo, but only main may use it
    stub.callFor = (marker) => (marker === undefined ? undefined : ECHO_CALL)
    const run = await runChild({
      toolNames: ['echo', 'alpha'],
      turns: [
        { text: 'MARK_G1 привет', session: { sessionId: 'guest-1' } },
        { text: 'MARK_G2 привет', session: { sessionId: 'guest-2', tools: ['alpha'] } },
      ],
    })
    const report = expectCleanRun(run)

    expect(report.executeCalls, run.output).toEqual([])
    for (const marker of ['MARK_G1', 'MARK_G2']) {
      const calls = callsOf(stub, marker)
      // the invented tool_use got an answer and the turn went on to a second request
      expect(calls.length, `${marker}: ${run.output}`).toBeGreaterThanOrEqual(2)
      const results = toolResultsOf(calls[1]!.body)
      expect(results, marker).toHaveLength(1)
      expect(results[0]!.trim().length, marker).toBeGreaterThan(0)
      expect(results[0], marker).not.toContain(ECHO_PREFIX)
    }
  },
)

test(
  'test_c4_before_tool_receives_session_id: the hook gets a context with sessionId of the calling session',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    stub.callFor = (marker) => {
      if (marker === 'MARK_MAIN') return { name: 'echo', input: { text: 'from-main' } }
      if (marker === 'MARK_G1') return { name: 'alpha', input: { text: 'from-guest' } }
      return undefined
    }
    const run = await runChild({
      toolNames: ['echo', 'alpha'],
      withHook: true,
      turns: [
        { text: 'MARK_MAIN привет' },
        { text: 'MARK_G1 привет', session: { sessionId: 'guest-1', tools: ['alpha'] } },
      ],
    })
    const report = expectCleanRun(run)

    expect(report.executeCalls.map((c) => c.name).sort()).toEqual(['alpha', 'echo'])
    const bySession = Object.fromEntries(report.beforeCalls.map((c) => [String(c.sessionId), c.name]))
    expect(bySession).toEqual({ main: 'echo', 'guest-1': 'alpha' })
    expect(report.beforeCalls).toHaveLength(2)
  },
)
