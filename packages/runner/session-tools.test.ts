import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

describe('own runner tool authority', () => {
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
  flush: boolean
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
  const stub: Stub = { server: createServer(), origin: '', requests, callFor: () => undefined, flush: false }
  let toolUses = 0
  let flushStep = 0
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
      const messages = Array.isArray(body?.messages) ? body.messages : []
      const lastText = [...messages].reverse().map(asRecord).filter(message => message?.role === 'user')
        .map(message => blockText(message?.content)).find(text => text.trim() !== '') ?? ''
      if (stub.flush && body && toolNames(body).length > 0 && !MARKERS.some(marker => lastText.includes(marker)) && !lastText.includes('Output only the checkpoint text')) {
        const call = [
          { name: 'exec', input: { text: 'forbidden-side-effect' } },
          { name: 'memory', input: { text: 'saved-fact' } },
        ][flushStep++]
        res.end(call ? toolUseStream(`flush_${flushStep}`, call) : textStream('flush done'))
        return
      }
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
    guestAllowed: name === 'alpha',
    description: 'tool ' + name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args, context) => {
      executeCalls.push({ name, args, sessionId: context?.sessionId })
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
  if (cfg.compact) await runner.compact()
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
  session?: { sessionId?: string; tools?: string[]; principal?: 'owner' | 'guest' }
}

interface ChildConfig {
  dshHome: string
  cwd: string
  baseUrl: string
  toolNames: string[]
  turns: Turn[]
  withHook: boolean
  compact?: boolean
}

interface ChildReport {
  executeCalls: Array<{ name: string; args: unknown; sessionId?: string }>
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


test('R-TOOL-SCOPE principal tools and context are enforced before execution', { timeout: 60_000 }, async () => {
  {
    stub.flush = true
    stub.callFor = (marker) => {
      if (marker === 'MARK_MAIN') return { name: 'echo', input: { text: 'from-main' } }
      if (marker === 'MARK_G1') return { name: 'alpha', input: { text: 'from-guest' } }
      if (marker === 'MARK_G2') return { name: 'echo', input: { text: 'forbidden' } }
      return undefined
    }
    const run = await runChild({
      toolNames: ['echo', 'alpha', 'exec', 'memory'],
      compact: true,
      withHook: true,
      turns: [
        { text: 'MARK_MAIN привет', session: { principal: 'owner' } },
        { text: 'MARK_G1 привет', session: { sessionId: 'guest-1', principal: 'guest', tools: ['alpha'] } },
        { text: 'MARK_G2 привет', session: { sessionId: 'guest-2', principal: 'guest', tools: ['echo'] } },
      ],
    })
    const report = expectCleanRun(run)

    expect(report.executeCalls.map((c) => c.name).sort()).toEqual(['alpha', 'echo', 'memory'])
    const ordinary = report.beforeCalls.filter(c => !String(c.sessionId).startsWith('compact-flush-'))
    const bySession = Object.fromEntries(ordinary.map((c) => [String(c.sessionId), c.name]))
    expect(bySession).toEqual({ main: 'echo', 'guest-1': 'alpha' })
    expect(ordinary).toHaveLength(2)
    expect(report.executeCalls.some(c => c.name === 'exec')).toBe(false)
    expect(report.executeCalls.find(c => c.name === 'memory')).toMatchObject({ args: { text: 'saved-fact' }, sessionId: expect.stringMatching(/^compact-flush-/) })

  }
})

})
describe('own transient session cleanup', () => {
// A transient runner session is deleted with rmSync after its turn, so its id must never be able to
// name the owner's history, a guest or child session, or anything outside the sessions directory.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@TRANSIENT-RESULT@@'
const KEEP_FILE = 'keep.txt'
const KEEP_TEXT = 'must survive'
const OWNER_TEXT = 'owner history marker'
const GUEST_TEXT = 'guest history marker'

// --- local stub of the DeepSeek Messages API -----------------------------------------------

interface Stub {
  server: Server
  origin: string
  bodies: string[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function pongStream(): string {
  return [
    sse('message_start', {
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
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function startStub(): Promise<Stub> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      bodies.push(raw)
      let streaming = true
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && (parsed as { stream?: unknown }).stream === false) streaming = false
      } catch {
        streaming = true
      }
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(pongStream())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}`, bodies }
}

// --- child process driver ------------------------------------------------------------------

// Resolves './x.js' specifiers to './x.ts' so Node can run the TypeScript sources of the repo directly.
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

// Opens the owner session and one real guest session, plants files for the ids under attack, then asks
// for a transient turn on each attempted id and reports whether the call was refused.
const DRIVER_SOURCE = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT',
  })
  await runner.prompt(cfg.ownerText)
  await runner.prompt(cfg.guestText, { sessionId: 'guest-555', principal: 'guest' })
  for (const dir of cfg.plant) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, cfg.keepFile), cfg.keepText)
  }
  const results = []
  for (const attempt of cfg.attempts) {
    try {
      const outcome = await runner.promptTurn(attempt.text, { sessionId: attempt.id, transient: true })
      results.push({ id: attempt.id, refused: false, text: outcome.text })
    } catch (error) {
      results.push({ id: attempt.id, refused: true, error: String(error && error.message ? error.message : error) })
    }
  }
  await runner.stop()
  report({ results })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface Attempt {
  id: string
  text: string
}

interface AttemptResult {
  id: string
  refused: boolean
  text?: string
  error?: string
}

interface ChildReport {
  results?: AttemptResult[]
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
  scratch = mkdtempSync(join(tmpdir(), 'transient-guard-'))
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

function sessionsDir(): string {
  return join(dshHome, 'sessions')
}

function attemptsFor(ids: string[]): Attempt[] {
  return ids.map((id, index) => ({ id, text: `TRANSIENT-ATTEMPT-${index}-QUESTION` }))
}

/** Directories planted with a keep file before the attempts; `.` and `..` already hold real data. */
function plantedDirs(ids: string[], extra: string[] = []): string[] {
  const dirs = ids.filter((id) => id !== '.' && id !== '..').map((id) => join(sessionsDir(), id))
  return [...dirs, ...extra]
}

function runChild(attempts: Attempt[], plant: string[]): Promise<ChildRun> {
  const cfg = {
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    ownerText: OWNER_TEXT,
    guestText: GUEST_TEXT,
    attempts,
    plant,
    keepFile: KEEP_FILE,
    keepText: KEEP_TEXT,
    entry: runnerEntry,
  }
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify(cfg),
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
      resolve({
        report: line ? (JSON.parse(line.slice(RESULT_MARK.length)) as ChildReport) : undefined,
        output: `${stdout}\n${stderr}`.slice(-4000),
      })
    })
  })
}

function resultsOf(run: ChildRun): AttemptResult[] {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.results, run.output).toBeDefined()
  return run.report?.results ?? []
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full))
    else found.push(full)
  }
  return found
}

/** True when some file of the session directory holds the text. */
function sessionHolds(id: string, text: string): boolean {
  return filesUnder(join(sessionsDir(), id)).some((file) => statSync(file).size > 0 && readFileSync(file, 'utf8').includes(text))
}

function expectRefusedBeforeOpening(results: AttemptResult[], attempts: Attempt[]): void {
  expect(results).toHaveLength(attempts.length)
  for (const result of results) expect(result.refused, `transient turn on "${result.id}" must be refused`).toBe(true)
  // Refused before the session is opened: the model never saw any of the attempted questions.
  for (const attempt of attempts) {
    expect(stub.bodies.some((body) => body.includes(attempt.text)), `"${attempt.id}" reached the model`).toBe(false)
  }
}

function expectKeepFiles(dirs: string[]): void {
  for (const dir of dirs) {
    const keep = join(dir, KEEP_FILE)
    expect(existsSync(keep), `${keep} was deleted`).toBe(true)
    expect(readFileSync(keep, 'utf8')).toBe(KEEP_TEXT)
  }
}

// --- tests ---------------------------------------------------------------------------------


test('R-TRANSIENT reserved histories survive and only owned transient state is removed', { timeout: 60_000 }, async () => {
  {
  const ids = ['main']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, [join(sessionsDir(), 'main')])
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)
  expect(existsSync(join(sessionsDir(), 'main'))).toBe(true)
  expectKeepFiles([join(sessionsDir(), 'main')])
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  }
  {
  const ids = ['..', '.', '../victim', '../../escape', 'a/b', 'side-question/../main', '..\\up', 'a\\b', 'bad id', 'id;x', 'ünï', 'side:question']
  // Made of allowed characters only, yet they carry "..": nothing is planted, so a missing guard would answer and delete them.
  const dotted = ['a..b', '...', 'side-question..']
  const attempts = attemptsFor([...ids, ...dotted])
  const run = await runChild(attempts, plantedDirs(ids, [join(dshHome, 'victim')]))
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)

  // The state directory and its siblings of sessions are intact.
  expect(existsSync(dshHome), 'DSHBOT_HOME was deleted').toBe(true)
  expect(existsSync(sessionsDir()), 'sessions directory was deleted').toBe(true)
  expectKeepFiles(plantedDirs(ids, [join(dshHome, 'victim')]))
  // Neither the owner nor the guest session lost their history.
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
  }
  {
  const ids = ['guest-555', 'guest-777', 'guest--1001234', 'subagent-abc', 'subagent-1700000000-1']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, plantedDirs(ids))
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)
  for (const id of ids) expect(existsSync(join(sessionsDir(), id)), `${id} directory was deleted`).toBe(true)
  expectKeepFiles(plantedDirs(ids))
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  }
  {
  const ids = ['side-question-abc', 'side_question.1-X']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, [])
  const results = resultsOf(run)

  expect(results).toHaveLength(ids.length)
  for (const result of results) {
    expect(result.refused, `"${result.id}" was refused: ${result.error ?? ''}`).toBe(false)
    expect(result.text).toContain('pong')
    expect(existsSync(join(sessionsDir(), result.id)), `${result.id} directory is left behind`).toBe(false)
  }
  for (const attempt of attempts) {
    expect(stub.bodies.some((body) => body.includes(attempt.text)), `"${attempt.id}" never reached the model`).toBe(true)
  }
  // The deletion touches only the transient session.
  expect(existsSync(sessionsDir())).toBe(true)
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
  }
})

})
describe('own usage attribution', () => {
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href
const storeEntry = pathToFileURL(join(repoRoot, 'packages/store/src/index.ts')).href
const usageEntry = pathToFileURL(join(repoRoot, 'packages/app/src/usage.ts')).href
const delegateEntry = pathToFileURL(join(repoRoot, 'packages/tools-subagent/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@DELEGATE-SCOPE@@'
const CHILD_REPORT = 'KID-REPORT-DONE'
const CHILD_TASK_LINE = 'Задача субагента:'
const PARENT_MARK = 'PAR_RUN'

type Json = Record<string, unknown>

interface ToolCall {
  name: string
  input: Json
}

interface Seen {
  role: 'parent' | 'child' | 'other'
  body: Json
}

interface Stub {
  server: Server
  origin: string
  seen: Seen[]
  /** Parent steps: the n-th model call of the parent answers with steps[n], then with text. */
  steps: ToolCall[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamOf(block: Json, deltas: Json[], stopReason: string): string {
  return [
    sse('message_start', {
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
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    ...deltas.map((delta) => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function toolUse(id: string, call: ToolCall): string {
  return streamOf({ type: 'tool_use', id, name: call.name, input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(call.input) }], 'tool_use')
}

function answer(text: string): string {
  return streamOf({ type: 'text', text: '' }, [{ type: 'text_delta', text }], 'end_turn')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
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

function messagesOf(body: Json): Json[] {
  return Array.isArray(body.messages) ? body.messages.map((message) => asRecord(message) ?? {}) : []
}

function userText(body: Json): string {
  return messagesOf(body)
    .filter((message) => message.role === 'user')
    .map((message) => blockText(message.content))
    .join('\n')
}

function classify(body: Json): Seen['role'] {
  const text = userText(body)
  if (text.includes(CHILD_TASK_LINE)) return 'child'
  if (text.includes(PARENT_MARK)) return 'parent'
  return 'other'
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { server: createServer(), origin: '', seen: [], steps: [] }
  let ids = 0
  let parentCalls = 0
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Json = {}
      try {
        body = JSON.parse(raw) as Json
      } catch {
        body = {}
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [{ type: 'text', text: 'готово' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          }),
        )
        return
      }
      const role = classify(body)
      stub.seen.push({ role, body })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      ids += 1
      if (role === 'child') {
        res.end(answer(CHILD_REPORT))
        return
      }
      const step = role === 'parent' && parentCalls++ % 2 === 0 ? stub.steps[0] : undefined
      res.end(step === undefined ? answer('готово') : toolUse(`toolu_stub_${ids}`, step))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

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

const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (data) => console.log('${RESULT_MARK}' + JSON.stringify(data))
try {
  const { startRunner } = await import(cfg.entry)
  const { createDelegateTool } = await import(cfg.delegateEntry)
  const { openStore } = await import(cfg.storeEntry)
  const { createUsageRecorder, createUsageSummaryTool } = await import(cfg.usageEntry)
  const store = openStore(cfg.db)
  let runner
  let delegated = 0
  const delegate = createDelegateTool({
    lazy: false,
    run: async (request) => {
      delegated++
      return runner.runChild(request)
    },
  })
  runner = await startRunner({
    dshHome: cfg.dshHome, cwd: cfg.cwd, baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real', systemPrefix: 'Тестовый помощник',
    model: 'deepseek-flash', tools: [delegate], onUsage: createUsageRecorder(store),
  })
  await runner.prompt('PAR_RUN scheduled', { usageJobId: 'job-x' })
  await runner.prompt('PAR_RUN owner')
  const rows = store.usage.rows()
  const summary = JSON.parse(await createUsageSummaryTool({ usage: store.usage, sessionStart: () => 0 }).execute({}))
  await runner.stop()
  store.close()
  report({ delegated, rows, summary })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface UsageRow {
  sessionId: string
  jobId?: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  costUsd: number | null
}

interface DriverReport {
  error?: string
  delegated: number
  rows: UsageRow[]
  summary: { scheduleJobsLast7Days: Array<UsageRow & { calls: number; unpricedCalls: number }> }
}


test('R-USAGE-SCOPE scheduled child usage retains only its own job', { timeout: 60_000 }, async () => {
  {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-usage-delegate-'))
  const stub = await startStub()
  stub.steps = [{ name: 'delegate', input: { task: 'KID_TASK calculate', tools: [] } }]
  try {
    writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
    writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
    writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
    const cfg = {
      entry: runnerEntry, delegateEntry, storeEntry, usageEntry,
      dshHome: join(scratch, 'state'), cwd: scratch, db: join(scratch, 'usage.db'),
      baseUrl: `${stub.origin}/anthropic`,
    }
    const args = ['--import', pathToFileURL(join(scratch, 'register.mjs')).href, join(scratch, 'driver.mjs'), JSON.stringify(cfg)]
    const result = await new Promise<{ report?: DriverReport; output: string }>((resolve) => {
      const env = { HOME: scratch, USERPROFILE: scratch, PATH: process.env.PATH ?? '' }
      const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS - 5_000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.on('close', () => {
        clearTimeout(timer)
        const line = output.split('\n').find((value) => value.startsWith(RESULT_MARK))
        resolve({ ...(line ? { report: JSON.parse(line.slice(RESULT_MARK.length)) as DriverReport } : {}), output })
      })
    })
    expect(result.report?.error, result.output).toBeUndefined()
    expect(result.report, result.output).toBeDefined()
    const { delegated, rows, summary } = result.report!
    expect(delegated).toBe(2)
    expect(stub.seen.filter((entry) => entry.role === 'child')).toHaveLength(2)
    const children = rows.filter((row) => row.sessionId !== 'main')
    expect(children).toHaveLength(2)
    expect(children[0]?.jobId).toBe('job-x')
    expect(children[1]?.jobId).toBeUndefined()
    expect(rows.filter((row) => row.sessionId === 'main').map((row) => row.jobId)).toEqual(['job-x', 'job-x', undefined, undefined])
    const jobRows = rows.filter((row) => row.jobId === 'job-x')
    expect(jobRows).toHaveLength(3)
    expect(summary.scheduleJobsLast7Days).toHaveLength(1)
    const job = summary.scheduleJobsLast7Days[0]!
    expect(job).toMatchObject({ jobId: 'job-x', calls: 3, unpricedCalls: 0 })
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const) {
      expect(job[key]).toBe(jobRows.reduce((sum, row) => sum + row[key], 0))
    }
    expect(jobRows.every((row) => row.costUsd !== null && row.costUsd > 0)).toBe(true)
    expect(job.costUsd).toBeCloseTo(jobRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0), 12)
  } finally {
    await new Promise<void>((resolve) => { stub.server.closeAllConnections(); stub.server.close(() => resolve()) })
    rmSync(scratch, { recursive: true, force: true })
  }
  }
})

})
