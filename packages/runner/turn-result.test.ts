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
const RESULT_MARK = '@@TURN-RESULT@@'
const API_KEY = 'sk-turn-result-secret-key-0123456789abcdef'
const DEFER_ERROR = 'tools: at least one tool must have defer_loading=false. All tools cannot be deferred'
const FAIL_REASON = 'upstream-reason-marker-7731'

// --- local stub of the DeepSeek Messages API ----------------------------------------------------

type Json = Record<string, unknown>

type Answer = { kind: 'text'; text: string } | { kind: 'error'; status: number; message: string }

interface Stub {
  server: Server
  origin: string
  /** Streamed model requests, in order. */
  calls: Json[]
  /** Decides the answer to the n-th (0-based) streamed model request. */
  answer: (n: number, body: Json) => Answer
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function textStream(text: string): string {
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
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function asRecord(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

/** True when the request declares tools and every one of them is deferred. */
function allToolsDeferred(body: Json): boolean {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.length > 0 && tools.every((tool) => asRecord(tool)?.defer_loading === true)
}

async function startStub(): Promise<Stub> {
  const stub: Stub = {
    server: createServer(),
    origin: '',
    calls: [],
    answer: (n) => ({ kind: 'text', text: `ответ-${n}` }),
  }
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Json = {}
      try {
        body = asRecord(JSON.parse(raw)) ?? {}
      } catch {
        body = {}
      }
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      if (allToolsDeferred(body)) {
        stub.calls.push(body)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: DEFER_ERROR } }))
        return
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
      const answer = stub.answer(stub.calls.length, body)
      stub.calls.push(body)
      if (answer.kind === 'error') {
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: answer.message } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(answer.text))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- child process driver ------------------------------------------------------------------------

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

// Starts a runner with the configured tools and sends each prompt in order; a failing prompt is
// recorded, not fatal, so later turns still run.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const outcomes = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ outcomes, ...extra }))
try {
  if (cfg.emptyFailure) {
    // Keep the real failed turn, but expose an empty terminal reason to the runner.
    const { Session } = await import(cfg.sessionEntry)
    const eventAt = Session.prototype.eventAt
    Session.prototype.eventAt = function (...args) {
      const event = eventAt.apply(this, args)
      if (event?.type !== 'turn/end' || event.data.reason.kind !== 'error') return event
      return { ...event, data: { ...event.data, reason: { ...event.data.reason, error: { code: '', message: '' } } } }
    }
  }
  const { startRunner } = await import(cfg.entry)
  const tools = cfg.toolNames.map((name) => ({
    name,
    description: 'tool ' + name,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => 'ok',
  }))
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    tools,
  })
  for (const text of cfg.turns) {
    try {
      outcomes.push({ ok: true, reply: await runner.prompt(text) })
    } catch (error) {
      outcomes.push({ ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
  await runner.stop()
  report({})
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

type Outcome = { ok: true; reply: string } | { ok: false; error: string }

interface ChildReport {
  outcomes: Outcome[]
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
  scratch = mkdtempSync(join(tmpdir(), 'runner-turn-result-test-'))
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

/** One runner process over the shared `dshHome`; call twice to simulate a restart. */
function runChild(toolNames: string[], turns: string[], emptyFailure = false): Promise<ChildRun> {
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const cfg = {
    entry: runnerEntry,
    sessionEntry: pathToFileURL(join(repoRoot, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href,
    emptyFailure,
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    apiKey: API_KEY,
    toolNames,
    turns,
  }
  const args = ['--import', pathToFileURL(join(scratch, 'register.mjs')).href, join(scratch, 'driver.mjs'), JSON.stringify(cfg)]
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

function outcomesOf(run: ChildRun, expected: number): Outcome[] {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  const outcomes = (run.report as ChildReport).outcomes
  expect(outcomes, run.output).toHaveLength(expected)
  return outcomes
}

test(
  'test_fresh_each_prompt_returns_the_reply_of_its_own_turn',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    stub.answer = (n) => ({ kind: 'text', text: n === 0 ? 'первый-ответ-ALPHA' : 'второй-ответ-BETA' })
    const run = await runChild([], ['вопрос один', 'вопрос два'])
    const outcomes = outcomesOf(run, 2)
    expect(outcomes[0], run.output).toEqual({ ok: true, reply: 'первый-ответ-ALPHA' })
    expect(outcomes[1], run.output).toEqual({ ok: true, reply: 'второй-ответ-BETA' })
  },
)

test(
  'test_error: a failed turn makes prompt throw with the reason, never the previous reply or the API key',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    stub.answer = (n) =>
      n === 0
        ? { kind: 'text', text: 'старое-приветствие-GAMMA' }
        : { kind: 'error', status: 400, message: `${FAIL_REASON}: rejected key ${API_KEY}` }
    const run = await runChild([], ['привет', 'вопрос, который упадёт'])
    const outcomes = outcomesOf(run, 2)
    expect(outcomes[0], run.output).toEqual({ ok: true, reply: 'старое-приветствие-GAMMA' })

    const failed = outcomes[1] as Outcome
    expect(failed.ok, `prompt must throw on a failed turn, got ${JSON.stringify(failed)}\n${run.output}`).toBe(false)
    if (failed.ok) return
    expect(failed.error).not.toContain('старое-приветствие-GAMMA')
    expect(failed.error.trim().length).toBeGreaterThan(0)
    expect(failed.error).toContain(FAIL_REASON)
    // test_secrets: the error text handed to callers never carries the API key
    expect(failed.error).not.toContain(API_KEY)
    expect(failed.error).not.toContain(API_KEY.slice(3))
  },
)

test(
  'test_resume: a main session created without tools survives a restart with tools and answers the turn',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    stub.answer = (n) => ({ kind: 'text', text: n === 0 ? 'приветствие-без-инструментов' : 'ответ-после-перезапуска-DELTA' })

    const first = await runChild([], ['привет'])
    expect(outcomesOf(first, 1)[0], first.output).toEqual({ ok: true, reply: 'приветствие-без-инструментов' })

    const second = await runChild(['edit', 'read'], ['продолжим'])
    const outcome = outcomesOf(second, 1)[0] as Outcome
    expect(
      stub.calls.some((body) => allToolsDeferred(body)),
      `the resumed session sent a request with only deferred tools (${DEFER_ERROR})\n${second.output}`,
    ).toBe(false)
    expect(outcome, second.output).toEqual({ ok: true, reply: 'ответ-после-перезапуска-DELTA' })
  },
)

test(
  'test_secrets: the error text of a failed turn does not quote the API key from the upstream message',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    stub.answer = () => ({ kind: 'error', status: 400, message: `${FAIL_REASON} authorization failed for x-api-key ${API_KEY}` })
    const run = await runChild([], ['вопрос'])
    const outcome = outcomesOf(run, 1)[0] as Outcome
    expect(outcome.ok, `prompt must throw on a failed turn, got ${JSON.stringify(outcome)}\n${run.output}`).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toContain(FAIL_REASON)
    expect(outcome.error).not.toContain(API_KEY)
    expect(outcome.error).not.toContain(API_KEY.slice(3))
  },
)

function assistantNotes(body: Json): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages.flatMap((value) => {
    const message = asRecord(value)
    if (message?.role !== 'assistant') return []
    const content = message.content
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []
    return content.flatMap((block) => {
      const text = asRecord(block)?.text
      return typeof text === 'string' ? [text] : []
    })
  }).filter((text) => text.startsWith('[ход не выполнен: ошибка провайдера'))
}

test('c1 c2 provider failure reason is redacted in the session and sent on the next turn', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const reason = `Insufficient balance or no resource package. Please recharge. key ${API_KEY}`
  stub.answer = (n) => n === 0 ? { kind: 'error', status: 401, message: reason } : { kind: 'text', text: 'готово' }
  const run = await runChild([], ['первый вопрос', 'почему?'])
  const outcomes = outcomesOf(run, 2)
  expect(outcomes[0]?.ok, run.output).toBe(false)
  expect(outcomes[1]?.ok, run.output).toBe(true)
  const notes = assistantNotes(stub.calls.at(-1) ?? {})
  expect(notes, run.output).toHaveLength(1)
  expect(notes[0]).toContain('401')
  expect(notes[0]).toContain('Insufficient balance or no resource package. Please recharge.')
  expect(notes[0]).toContain('[redacted]')
  expect(notes[0]).not.toContain(API_KEY)
  const { readdirSync, readFileSync } = await import('node:fs')
  const readTree = (dir: string): string => readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? readTree(path) : readFileSync(path, 'utf8')
  }).join('\n')
  const journal = readTree(join(dshHome, 'sessions'))
  expect(journal).toContain('Insufficient balance or no resource package')
  expect(journal).not.toContain(API_KEY)
})

test('c3 a long multiline provider reason becomes a bounded single-line note', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.answer = (n) => n === 0
    ? { kind: 'error', status: 400, message: `first line\nsecond line ${'x'.repeat(800)}` }
    : { kind: 'text', text: 'готово' }
  const run = await runChild([], ['первый вопрос', 'почему?'])
  const outcomes = outcomesOf(run, 2)
  expect(outcomes[0]?.ok, run.output).toBe(false)
  expect(outcomes[1]?.ok, run.output).toBe(true)
  const notes = assistantNotes(stub.calls.at(-1) ?? {})
  expect(notes, run.output).toHaveLength(1)
  const note = notes[0] ?? ''
  expect(note).toContain('first line')
  expect(note).toContain('second line')
  expect(note).not.toMatch(/[\r\n]/)
  expect(note.length).toBeLessThanOrEqual(600)
  expect(note).toMatch(/…\]?$/)
})

test('c4 a failed turn without error text keeps the original note', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.answer = (n) => n === 0
    ? { kind: 'error', status: 400, message: 'failure used to produce a terminal event' }
    : { kind: 'text', text: 'готово' }
  const run = await runChild([], ['первый вопрос', 'почему?'], true)
  const outcomes = outcomesOf(run, 2)
  expect(outcomes[0]?.ok, run.output).toBe(false)
  expect(outcomes[1]?.ok, run.output).toBe(true)
  expect(assistantNotes(stub.calls.at(-1) ?? {}), run.output).toEqual(['[ход не выполнен: ошибка провайдера]'])
})

test('h1 provider failure note bounds UTF-16 length without splitting emoji', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.answer = (n) => n === 0
    ? { kind: 'error', status: 400, message: '😀'.repeat(800) }
    : { kind: 'text', text: 'готово' }
  const run = await runChild([], ['первый вопрос', 'почему?'])
  const outcomes = outcomesOf(run, 2)
  expect(outcomes[0]?.ok, run.output).toBe(false)
  expect(outcomes[1]?.ok, run.output).toBe(true)
  const notes = assistantNotes(stub.calls.at(-1) ?? {})
  expect(notes, run.output).toHaveLength(1)
  const note = notes[0] ?? ''
  expect(note).toContain('😀')
  expect(note.length).toBeLessThanOrEqual(600)
  expect(note).toMatch(/😀…\]$/u)
  expect(note).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
})
