// [image-offload] A route that rejects a request as over its image budget fails with
// IMAGE_OFFLOAD_REQUIRED; the runner must answer by replacing the oldest images with a text
// placeholder, repeating the request and keeping that choice for later turns. A child process
// runs startRunner against a local DeepSeek stub, so Node executes the repository sources
// directly. The Files API of the stub refuses uploads, so the adapter takes its inline path,
// where two 9 MB images exceed the 20 MB budget and exactly the older one has to go.

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

const RESULT_MARK = '@@IMAGE-OFFLOAD@@'
const CHILD_TIMEOUT_MS = 90_000
const IMAGE_BYTES = 9 * 1024 * 1024
const OLD_FILL = 0x11
const NEW_FILL = 0x22
const PLACEHOLDER = 'image omitted to fit request image limits'

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

function isModelRequest(request: StubRequest): boolean {
  return request.path.endsWith('/messages') && request.body?.stream !== false
}

async function startStub(): Promise<Stub> {
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
      if (!path.endsWith('/messages')) {
        // No Files API: the adapter falls back to inline base64 images.
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'files unavailable' } }))
        return
      }
      if (body?.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(plainMessage('pong'))
        return
      }
      const index = requests.filter(isModelRequest).length
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(`ответ модели №${index}`))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  const { port } = stub.server.address() as AddressInfo
  stub.origin = `http://127.0.0.1:${port}`
  return stub
}

// With FORCE_OFFLOAD the adapter of the child rejects every model request of the turn the way a
// route does when nothing fits: the only way to reach "nothing left to replace" through the real
// runner, because the adapter itself never asks for more than the images that remain.
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

const MARKER = 'async *request(options, connection, signal, activity) {'
const FORCED =
  MARKER +
  'if (globalThis.__forceImageOffload) { globalThis.__forcedAttempts = (globalThis.__forcedAttempts ?? 0) + 1;' +
  ' throw new LlmError("forced image offload", IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 1 }) }'

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (process.env.FORCE_OFFLOAD !== '1' || !url.endsWith('/dsh-llm-deepseek/lib/index.js')) return result
  const source = String(result.source)
  if (!source.includes(MARKER)) throw new Error('adapter request() not found for the forced offload')
  return { ...result, source: source.replace(MARKER, () => FORCED) }
}
`

const REGISTER_SOURCE = `
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))

function png(fill) {
  const data = new Uint8Array(cfg.imageBytes).fill(fill)
  const view = Buffer.from(data.buffer)
  view.writeUInt32BE(0x89504e47, 0)
  view.writeUInt32BE(1000, 16)
  view.writeUInt32BE(1000, 20)
  return data
}

const attempt = async (runner, text, session) => {
  try {
    return { reply: await runner.prompt(text, session) }
  } catch (caught) {
    return { error: String(caught && caught.message ? caught.message : caught) }
  }
}

try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
  })
  const images = [
    { data: png(cfg.oldFill), mediaType: 'image/png', name: 'old.png' },
    { data: png(cfg.newFill), mediaType: 'image/png', name: 'new.png' },
  ]
  if (cfg.force) globalThis.__forceImageOffload = true
  const first = await attempt(runner, 'первый ход с двумя фото', { images })
  const second = cfg.second ? await attempt(runner, 'второй ход без фото') : undefined
  await runner.stop()
  report({ first, second, forcedAttempts: globalThis.__forcedAttempts ?? 0 })
} catch (error) {
  report({ crash: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface TurnReport {
  reply?: string
  error?: string
}

interface ChildReport {
  first?: TurnReport
  second?: TurnReport
  forcedAttempts?: number
  crash?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-image-offload-'))
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

async function runChild(scenario: { second: boolean; force: boolean }): Promise<ChildRun> {
  stub = await startStub()
  const dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  const cwd = mkdtempSync(join(scratch, 'cwd-'))
  const env: Record<string, string> = { HOME: dshHome, USERPROFILE: dshHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  if (scenario.force) env.FORCE_OFFLOAD = '1'
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify({
      entry: runnerEntry,
      dshHome,
      cwd,
      baseUrl: `${stub.origin}/anthropic`,
      imageBytes: IMAGE_BYTES,
      oldFill: OLD_FILL,
      newFill: NEW_FILL,
      second: scenario.second,
      force: scenario.force,
    }),
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
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((value) => value.startsWith(RESULT_MARK))
      const report = line === undefined ? undefined : (JSON.parse(line.slice(RESULT_MARK.length)) as ChildReport)
      resolve({ report, output: `${stdout.replace(/@@IMAGE-OFFLOAD@@.*/u, '')}\n${stderr}` })
    })
  })
}

function modelRequests(): StubRequest[] {
  return (stub?.requests ?? []).filter(isModelRequest)
}

interface Wire {
  images: Buffer[]
  placeholders: string[]
}

/** Image blocks and placeholder texts of the user messages of one request, in request order. */
function wireOf(request: StubRequest | undefined): Wire {
  const wire: Wire = { images: [], placeholders: [] }
  const messages = Array.isArray(request?.body?.messages) ? (request?.body?.messages as Json[]) : []
  for (const message of messages) {
    const content = Array.isArray(message.content) ? (message.content as Json[]) : []
    for (const block of content) {
      if (block.type === 'image') {
        const source = block.source as Json | undefined
        // Only the head of the base64 payload is needed to tell the two images apart.
        if (source?.type === 'base64') wire.images.push(Buffer.from(String(source.data).slice(0, 400), 'base64'))
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.includes(PLACEHOLDER)) {
        wire.placeholders.push(block.text)
      }
    }
  }
  return wire
}

function expectOnlyNewImageLeft(wire: Wire, context: string): void {
  expect(wire.placeholders, context).toHaveLength(1)
  expect(wire.placeholders[0], context).toContain('old.png')
  expect(wire.images, context).toHaveLength(1)
  expect(wire.images[0]?.[100], 'the image that stays is the new one').toBe(NEW_FILL)
}

test(
  'test_c1_over_budget_image_is_replaced_by_placeholder_and_the_turn_finishes',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild({ second: false, force: false })

    expect(run.report?.crash, run.output).toBeUndefined()
    expect(run.report?.first?.error, run.output).toBeUndefined()
    expect(run.report?.first?.reply, run.output).toContain('ответ модели')
    const requests = modelRequests()
    expect(requests, run.output).toHaveLength(1)
    expectOnlyNewImageLeft(wireOf(requests[0]), 'the retried request')
  },
)

test(
  'test_c2_next_turn_keeps_the_old_image_as_placeholder',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild({ second: true, force: false })

    expect(run.report?.crash, run.output).toBeUndefined()
    expect(run.report?.first?.error, run.output).toBeUndefined()
    expect(run.report?.second?.error, run.output).toBeUndefined()
    expect(run.report?.second?.reply, run.output).toContain('ответ модели')
    const requests = modelRequests()
    expect(requests, run.output).toHaveLength(2)
    const last = requests[1]
    expect(JSON.stringify(last?.body?.messages ?? []), 'the request is the one of the second turn').toContain('второй ход без фото')
    expectOnlyNewImageLeft(wireOf(last), 'the request of the next turn')
  },
)

test(
  'test_c3_nothing_left_to_offload_ends_the_turn_with_an_error_without_endless_retry',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const run = await runChild({ second: false, force: true })

    expect(run.report?.crash, run.output).toBeUndefined()
    expect(run.report?.first?.reply, run.output).toBeUndefined()
    expect(run.report?.first?.error, run.output).toBeDefined()
    // Two images: the first rejection offloads the old one, the second the new one, the third
    // finds nothing to replace and the turn ends instead of asking again.
    expect(run.report?.forcedAttempts, run.output).toBe(3)
    expect(modelRequests(), run.output).toHaveLength(0)
  },
)
