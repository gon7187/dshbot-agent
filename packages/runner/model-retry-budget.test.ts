// [retry-budget] A retryable model failure is repeated six times after the first request, with the
// pause 500 ms * 2^(k-1) +-20%, and only then the turn fails with the owner notice of seven
// attempts. A stream that closed before any content shares the same limit, a stream that already
// said something is not repeated, and a cancelled turn stops waiting without new requests. A child
// process runs startRunner against a local DeepSeek stub, so Node executes the repository sources.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const RESULT_MARK = '@@RETRY-BUDGET@@'
// Six pauses of 500 ms doubling with up to +20% jitter wait up to about 38 s in total.
const CHILD_TIMEOUT_MS = 90_000
const CHILD_KILL_MS = 85_000

type Json = Record<string, unknown>

interface StubRequest {
  path: string
  body: Json | undefined
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

/** What every streamed model request gets: a dropped connection, an empty stream or a broken partial one. */
type Failure = 'drop' | 'empty-stream' | 'partial-stream'

async function startStub(failure: Failure): Promise<Stub> {
  const requests: StubRequest[] = []
  const stub: Stub = { server: createServer(), origin: '', requests }
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Json | undefined
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') body = parsed as Json
      } catch {
        body = undefined
      }
      const path = new URL(req.url ?? '/', 'http://stub').pathname
      requests.push({ path, body })
      if (body?.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      if (failure === 'drop') {
        // The provider is unreachable: the connection dies before any answer.
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (failure === 'partial-stream') {
        res.write(messageStart())
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        )
        res.write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'частичный ответ' },
          }),
        )
      }
      res.end()
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  const { port } = stub.server.address() as AddressInfo
  stub.origin = `http://127.0.0.1:${port}`
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

// With cfg.cancelOnFirstRetry the driver cancels the turn as soon as the journal announces the
// first pause, then keeps the process alive past the longest first pause (600 ms) so a request
// sent by a pause that ignored the cancellation would reach the stub before the child exits.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
  })
  let cancelled = false
  if (cfg.cancelOnFirstRetry) {
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk, ...rest) => {
      if (!cancelled && String(chunk).includes('model request retry 1/')) {
        cancelled = true
        setTimeout(() => runner.cancel(), 100)
      }
      return write(chunk, ...rest)
    }
  }
  let reply
  let error
  try {
    reply = await runner.prompt('ping')
  } catch (caught) {
    error = String(caught && caught.message ? caught.message : caught)
  }
  if (cfg.cancelOnFirstRetry) await new Promise((resolve) => setTimeout(resolve, 2500))
  await runner.stop()
  report({ reply, error, cancelled })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildRun {
  code: number | null
  report: { reply?: string; error?: string; cancelled?: boolean } | undefined
  output: string
}

let scratch: string
let stub: Stub | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-retry-budget-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

afterEach(async () => {
  if (stub === undefined) return
  const closing = stub.server
  stub = undefined
  await new Promise<void>((resolve) => {
    closing.closeAllConnections()
    closing.close(() => resolve())
  })
})

async function runChild(failure: Failure, cancelOnFirstRetry = false): Promise<ChildRun> {
  stub = await startStub(failure)
  const dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  const cwd = mkdtempSync(join(scratch, 'cwd-'))
  const env: Record<string, string> = { HOME: dshHome, USERPROFILE: dshHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify({ entry: runnerEntry, dshHome, cwd, baseUrl: `${stub.origin}/anthropic`, cancelOnFirstRetry }),
  ]
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((value) => value.startsWith(RESULT_MARK))
      const report = line === undefined ? undefined : (JSON.parse(line.slice(RESULT_MARK.length)) as ChildRun['report'])
      resolve({ code, report, output: `${stdout}\n${stderr}` })
    })
  })
}

function modelRequests(): StubRequest[] {
  return (stub?.requests ?? []).filter(
    (request) => request.path.endsWith('/messages') && request.body?.stream !== false,
  )
}

/** Journal lines "retry k/N ...: pause P ms" in the order the child wrote them. */
function retryLines(output: string): Array<{ retry: number; max: number; pauseMs: number }> {
  const lines: Array<{ retry: number; max: number; pauseMs: number }> = []
  for (const match of output.matchAll(/model request retry (\d+)\/(\d+) .*?pause (\d+) ms/g)) {
    lines.push({ retry: Number(match[1]), max: Number(match[2]), pauseMs: Number(match[3]) })
  }
  return lines
}

test('test_c1_c2_transport_failure_is_retried_six_times_with_doubling_pauses', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild('drop')

  expect(modelRequests(), run.output).toHaveLength(7)
  const lines = retryLines(run.output)
  expect(lines.map((line) => `${line.retry}/${line.max}`), run.output).toEqual([
    '1/6',
    '2/6',
    '3/6',
    '4/6',
    '5/6',
    '6/6',
  ])
  expect(run.output).toMatch(/retry 1\/6 .*TRANSPORT/)
  for (const line of lines) {
    const base = 500 * 2 ** (line.retry - 1)
    // One millisecond of slack for the rounding of the journalled pause.
    expect(line.pauseMs, `pause of retry ${line.retry}`).toBeGreaterThanOrEqual(Math.floor(base * 0.8) - 1)
    expect(line.pauseMs, `pause of retry ${line.retry}`).toBeLessThanOrEqual(Math.ceil(base * 1.2) + 1)
  }
  expect(run.report?.reply).toBeUndefined()
  expect(run.report?.error, run.output).toContain(
    'DeepSeek недоступен (TRANSPORT), ход прерван после 7 попыток; напиши "продолжи"',
  )
})

test('test_c3_stream_closed_before_content_shares_the_limit_of_six_retries', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild('empty-stream')

  expect(modelRequests(), run.output).toHaveLength(7)
  const lines = retryLines(run.output)
  expect(lines.map((line) => `${line.retry}/${line.max}`), run.output).toEqual([
    '1/6',
    '2/6',
    '3/6',
    '4/6',
    '5/6',
    '6/6',
  ])
  expect(run.output).toMatch(/retry 6\/6 .*STREAM_CLOSED/)
  expect(run.report?.error, run.output).toContain('ход прерван после 7 попыток')
})

test('test_c3_stream_closed_after_content_is_still_not_retried', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild('partial-stream')

  expect(run.report?.error, run.output).toBeDefined()
  expect(run.report?.reply).toBeUndefined()
  expect(modelRequests(), run.output).toHaveLength(1)
  expect(retryLines(run.output), run.output).toHaveLength(0)
})

test('test_c4_cancel_during_the_pause_stops_waiting_without_new_requests', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild('drop', true)

  expect(run.report?.cancelled, run.output).toBe(true)
  expect(retryLines(run.output).map((line) => line.retry), run.output).toEqual([1])
  expect(modelRequests(), run.output).toHaveLength(1)
})
