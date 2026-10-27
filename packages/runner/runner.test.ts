import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const EXIT_AFTER_STOP_MS = 5_000
const RESULT_MARK = '@@RESULT@@'
const STOPPED_MARK = '@@STOPPED@@'

// --- local stub of the DeepSeek Messages API (Anthropic style, SSE) -----------------------

interface StubRequest {
  method: string
  path: string
  body: Record<string, unknown> | undefined
}

interface Stub {
  server: Server
  origin: string
  hostPort: string
  requests: StubRequest[]
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
    sse('ping', { type: 'ping' }),
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
  const requests: StubRequest[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      let body: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
      } catch {
        body = undefined
      }
      requests.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://stub').pathname, body })
      if (body && body.stream === false) {
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
  return { server, origin: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}`, requests }
}

// --- reading what the stub received -------------------------------------------------------

interface Msg {
  role: string
  text: string
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text
        return typeof text === 'string' ? text : ''
      }
      return ''
    })
    .join('')
}

function messagesOf(body: Record<string, unknown>): Msg[] {
  const raw = body.messages
  if (!Array.isArray(raw)) return []
  return raw.map((m: unknown) => {
    const message = (m ?? {}) as { role?: unknown; content?: unknown }
    return { role: String(message.role ?? ''), text: flatten(message.content) }
  })
}

// Model calls: POSTs on a path ending in /messages that carry a messages array.
function modelCalls(stub: Stub, from = 0): Array<{ path: string; body: Record<string, unknown> }> {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  for (const r of stub.requests.slice(from)) {
    if (r.method === 'POST' && r.path.endsWith('/messages') && r.body && Array.isArray(r.body.messages)) {
      calls.push({ path: r.path, body: r.body })
    }
  }
  return calls
}

// The system prompt as sent: the `system` field, or leading system/developer messages as a fallback.
function systemTextOf(body: Record<string, unknown>): string {
  const field = flatten(body.system)
  if (field) return field
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(m.text)
  }
  return leading.join('')
}

function hasInOrder(messages: Msg[], wanted: Array<{ role: string; includes: string }>): boolean {
  let at = 0
  for (const m of messages) {
    const w = wanted[at]
    if (w && m.role === w.role && m.text.includes(w.includes)) at += 1
  }
  return at === wanted.length
}

// --- child process driver ----------------------------------------------------------------

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

// Runs startRunner, the given prompts and stop() in a plain node process, and reports what happened.
const DRIVER_SOURCE = `
import net from 'node:net'
const cfg = JSON.parse(process.argv[2])
const fetchUrls = []
const connects = []
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  fetchUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  return realFetch(input, init)
}
const realConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first && typeof first === 'object') {
    if (first.path === undefined) connects.push(String(first.host ?? 'localhost') + ':' + String(first.port))
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\\d+$/.test(first))) {
    connects.push(String(typeof args[1] === 'string' ? args[1] : 'localhost') + ':' + String(first))
  }
  return realConnect.apply(this, args)
}
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ fetchUrls, connects, ...extra }))
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: cfg.systemPrefix,
    ...(cfg.secrets ? { toolNotes: { path: cfg.notesPath, secrets: () => cfg.secrets } } : {}),
  })
  const telemetryEnv = process.env.DSH_TELEMETRY_DISABLED ?? ''
  const replies = []
  for (const text of cfg.prompts) replies.push(await runner.prompt(text))
  await runner.stop()
  console.log('${STOPPED_MARK}')
  report({ replies, telemetryEnv })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildConfig {
  dshHome: string
  cwd: string
  baseUrl: string
  systemPrefix: string
  prompts: string[]
  secrets?: string[]
  notesPath?: string
}

interface ChildReport {
  fetchUrls: string[]
  connects: string[]
  replies?: string[]
  telemetryEnv?: string
  error?: string
}

interface ChildRun {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  msStopToExit: number | undefined
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-test-'))
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

function baseUrl(): string {
  return `${stub.origin}/anthropic`
}

function runChild(overrides: Partial<ChildConfig> & { prompts: string[] }): Promise<ChildRun> {
  const cfg: ChildConfig = {
    dshHome,
    cwd: workDir,
    baseUrl: baseUrl(),
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
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
    let stoppedAt: number | undefined
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, CHILD_TIMEOUT_MS - 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stoppedAt === undefined && stdout.includes(STOPPED_MARK)) stoppedAt = performance.now()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const exitedAt = performance.now()
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK))
      let report: ChildReport | undefined
      if (line) report = JSON.parse(line.slice(RESULT_MARK.length)) as ChildReport
      resolve({
        code,
        signal,
        timedOut,
        msStopToExit: stoppedAt === undefined ? undefined : exitedAt - stoppedAt,
        report,
        output: `${stdout}\n${stderr}`.slice(-4000),
      })
    })
  })
}

function expectCleanRun(run: ChildRun): ChildReport {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  return run.report as ChildReport
}

// --- tests -------------------------------------------------------------------------------

test('test_c2_prompt returns the model answer and the stub receives the ping request', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild({ prompts: ['ping'] })
  const report = expectCleanRun(run)

  expect(report.replies).toHaveLength(1)
  expect(typeof report.replies?.[0]).toBe('string')
  expect(report.replies?.[0]).toContain('pong')

  const calls = modelCalls(stub)
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) expect(call.body.model).toBe('deepseek-flash')
  const withPing = calls.filter((c) => messagesOf(c.body).some((m) => m.role === 'user' && m.text.includes('ping')))
  expect(withPing.length).toBeGreaterThan(0)
  expect(withPing[0]?.path.endsWith('/messages')).toBe(true)
})

test('test_c3_all outgoing requests go only to the stub host and port', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild({ prompts: ['ping'] })
  const report = expectCleanRun(run)
  expect(report.replies?.[0]).toContain('pong')

  // the harness really did talk to the stub through one of the two observed channels
  expect(modelCalls(stub).length).toBeGreaterThan(0)

  const fetchTargets = report.fetchUrls.map((u) => new URL(u).host)
  for (const host of fetchTargets) expect(host).toBe(stub.hostPort)

  expect(report.connects.length).toBeGreaterThan(0)
  for (const target of report.connects) expect(target).toBe(stub.hostPort)
})

test('test_c4_main session history is sent again, also after stop and a new runner on the same dshHome', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const first = await runChild({ prompts: ['ping', 'tell me more'] })
  const firstReport = expectCleanRun(first)
  expect(firstReport.replies).toHaveLength(2)
  for (const reply of firstReport.replies ?? []) expect(reply).toContain('pong')

  const firstCalls = modelCalls(stub)
  const secondTurn = firstCalls.filter((c) => messagesOf(c.body).some((m) => m.role === 'user' && m.text.includes('tell me more')))
  expect(secondTurn.length).toBeGreaterThan(0)
  const history = [
    { role: 'user', includes: 'ping' },
    { role: 'assistant', includes: 'pong' },
    { role: 'user', includes: 'tell me more' },
  ]
  expect(secondTurn.some((c) => hasInOrder(messagesOf(c.body), history))).toBe(true)

  const seen = stub.requests.length
  const resumed = await runChild({ prompts: ['third message'] })
  const resumedReport = expectCleanRun(resumed)
  expect(resumedReport.replies?.[0]).toContain('pong')

  const resumedCalls = modelCalls(stub, seen)
  const thirdTurn = resumedCalls.filter((c) => messagesOf(c.body).some((m) => m.role === 'user' && m.text.includes('third message')))
  expect(thirdTurn.length).toBeGreaterThan(0)
  const resumedHistory = [
    { role: 'user', includes: 'ping' },
    { role: 'assistant', includes: 'pong' },
    { role: 'user', includes: 'third message' },
  ]
  expect(thirdTurn.some((c) => hasInOrder(messagesOf(c.body), resumedHistory))).toBe(true)
})

test('test_c5_system prompt starts with systemPrefix, byte-identical across prompts', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const systemPrefix = 'Ты — тестовый помощник DSHBOT, префикс №1'
  const run = await runChild({ systemPrefix, prompts: ['ping', 'ping again'] })
  expectCleanRun(run)

  const calls = modelCalls(stub)
  expect(calls.length).toBeGreaterThanOrEqual(2)
  for (const call of calls) expect(systemTextOf(call.body).startsWith(systemPrefix)).toBe(true)

  const prefixBytes = Buffer.from(systemPrefix, 'utf8')
  const firstTurn = calls.find((c) => messagesOf(c.body).some((m) => m.text.includes('ping') && !m.text.includes('ping again')))
  const secondTurn = calls.find((c) => messagesOf(c.body).some((m) => m.text.includes('ping again')))
  expect(firstTurn).toBeDefined()
  expect(secondTurn).toBeDefined()
  const a = Buffer.from(systemTextOf(firstTurn?.body ?? {}), 'utf8').subarray(0, prefixBytes.length)
  const b = Buffer.from(systemTextOf(secondTurn?.body ?? {}), 'utf8').subarray(0, prefixBytes.length)
  expect(a.equals(prefixBytes)).toBe(true)
  expect(b.equals(prefixBytes)).toBe(true)
})

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

test('test_c6_harness data lands in dshHome, HOME stays clean, telemetry switch is set', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild({ prompts: ['ping'] })
  const report = expectCleanRun(run)
  expect(report.replies?.[0]).toContain('pong')

  expect(report.telemetryEnv).toBeTruthy()

  const anonymousId = join(dshHome, '.anonymous-user-id')
  expect(existsSync(anonymousId)).toBe(true)
  expect(readFileSync(anonymousId, 'utf8').trim().length).toBeGreaterThan(0)

  const sessionFiles = filesUnder(join(dshHome, 'sessions')).filter((f) => statSync(f).size > 0)
  expect(sessionFiles.length).toBeGreaterThan(0)

  expect(existsSync(join(tmpHome, '.dsh'))).toBe(false)
  expect(readdirSync(tmpHome).filter((name) => name.includes('dsh'))).toEqual([])
})

test('test_c7_child exits by itself with code 0 within 5 seconds after stop', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild({ prompts: ['ping'] })
  expect(run.timedOut, run.output).toBe(false)
  expectCleanRun(run)
  expect(run.msStopToExit, run.output).toBeDefined()
  expect(run.msStopToExit as number).toBeLessThanOrEqual(EXIT_AFTER_STOP_MS)
  expect(run.signal).toBeNull()
  expect(run.code, run.output).toBe(0)
})

test('the session journal masks a secret cut between text fragments and between reasoning fragments', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const secret = 'vault-secret-value-0123456789'
  const halves = [secret.slice(0, 11), secret.slice(11)]
  const stream = [
    sse('message_start', {
      type: 'message_start',
      message: { id: 'msg_cut', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ...halves.map((thinking) => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ...halves.map((text) => sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
  const server = createServer((req, res) => {
    void readBody(req).then(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(stream)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const run = await runChild({
      prompts: ['answer'],
      baseUrl: `http://127.0.0.1:${port}/anthropic`,
      secrets: [secret],
      notesPath: join(scratch, 'notes.json'),
    })
    expectCleanRun(run)
    const journal = filesUnder(join(dshHome, 'sessions')).filter((file) => file.endsWith('events.jsonl'))
    expect(journal).toHaveLength(1)
    const events = readFileSync(journal[0] as string, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      type: string
      data: { stream?: Array<{ type: string; texts?: string[] }> }
    })
    expect(readFileSync(journal[0] as string, 'utf8')).not.toContain(secret)
    const event = events.find((item) => item.type === 'assistant/message')
    expect(event, 'assistant/message').toBeDefined()
    for (const chunkType of ['text-chunks', 'reasoning-chunks']) {
      const record = event?.data.stream?.find((item) => item.type === chunkType)
      expect(record, chunkType).toBeDefined()
      const joined = (record?.texts ?? []).join('')
      expect(joined, chunkType).not.toContain(secret)
      expect(joined, chunkType).toContain('[redacted]')
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
