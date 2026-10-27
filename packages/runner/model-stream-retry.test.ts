// [retry] A stream that closes before the model produced any visible content is transient and the
// same step is asked again; a stream that already delivered text is not repeated. A child process
// runs startRunner against a local DeepSeek stub, so Node executes the repository sources directly.

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

const RESULT_MARK = '@@STREAM-RETRY@@'
const CHILD_TIMEOUT_MS = 60_000

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

function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

/** Answer of the n-th streamed model request (0-based). */
type Answer = { kind: 'empty-stream' } | { kind: 'partial-stream' } | { kind: 'text'; text: string }

async function startStub(answer: (n: number) => Answer): Promise<Stub> {
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
      const index = requests.filter((request) => request.path.endsWith('/messages') && request.body?.stream !== false).length - 1
      const scripted = answer(index)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (scripted.kind === 'empty-stream') {
        // Headers arrived, then the stream closed without a single event.
        res.end()
        return
      }
      if (scripted.kind === 'partial-stream') {
        // The model already said something, then the stream broke.
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
        res.end()
        return
      }
      res.end(textStream(scripted.text))
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
  let reply
  let error
  try {
    reply = await runner.prompt('ping')
  } catch (caught) {
    error = String(caught && caught.message ? caught.message : caught)
  }
  await runner.stop()
  report({ reply, error })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildRun {
  code: number | null
  report: { reply?: string; error?: string } | undefined
  output: string
}

let scratch: string
let stub: Stub | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-stream-retry-'))
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

async function runChild(answer: (n: number) => Answer): Promise<ChildRun> {
  stub = await startStub(answer)
  const dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  const cwd = mkdtempSync(join(scratch, 'cwd-'))
  const env: Record<string, string> = { HOME: dshHome, USERPROFILE: dshHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify({ entry: runnerEntry, dshHome, cwd, baseUrl: `${stub.origin}/anthropic` }),
  ]
  return await new Promise((resolve) => {
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
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((value) => value.startsWith(RESULT_MARK))
      const report = line === undefined ? undefined : (JSON.parse(line.slice(RESULT_MARK.length)) as { reply?: string; error?: string })
      resolve({ code, report, output: `${stdout}\n${stderr}` })
    })
  })
}

function modelRequests(): StubRequest[] {
  return (stub?.requests ?? []).filter(
    (request) => request.path.endsWith('/messages') && request.body?.stream !== false,
  )
}

test('test_stream_closed_before_the_first_token_is_retried_and_the_turn_finishes', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild((index) => (index === 0 ? { kind: 'empty-stream' } : { kind: 'text', text: 'pong after retry' }))

  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.reply, run.output).toContain('pong after retry')
  expect(modelRequests(), run.output).toHaveLength(2)
  expect(run.output, 'the journal names the failure, the attempt and the pause').toMatch(/retry 1\/6 .*STREAM_CLOSED/)
})

test('test_stream_closed_after_a_token_is_not_retried', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild(() => ({ kind: 'partial-stream' }))

  expect(run.report?.error, run.output).toBeDefined()
  expect(run.report?.reply).toBeUndefined()
  expect(modelRequests(), run.output).toHaveLength(1)
  expect(run.output).not.toMatch(/retry 1\/6/)
})
