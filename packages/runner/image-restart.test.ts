// [image-restart] The images a model sees in a session live only in the runner's memory, while the
// image block with its attachmentId stays in the saved history. After a daemon restart (a new
// startRunner with the same DSHBOT_HOME and the same session) the next turn must still reach the
// model: a stored image comes back with the same bytes, an image that is nowhere (not in memory,
// not on disk) is replaced in the request and logged once instead of failing the turn as
// TRANSPORT. A child process runs startRunner against a local DeepSeek stub; the Files API of
// the stub refuses uploads, so the adapter takes its inline base64 path.

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const RESULT_MARK = '@@IMAGE-RESTART@@'
// A failing turn of the old code retries a request that never leaves the process, so the child is
// killed well before the vitest timeout and the assertions report the failure.
const CHILD_TIMEOUT_MS = 90_000
const SEED_TEXT = 'первый ход с фото'
const NEXT_TEXT = 'второй ход после рестарта'

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

// One phase = one daemon lifetime: a fresh startRunner on the shared DSHBOT_HOME, one turn, stop.
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
  let turn
  try {
    const session = cfg.imageBase64
      ? { images: [{ data: new Uint8Array(Buffer.from(cfg.imageBase64, 'base64')), mediaType: 'image/png', name: 'photo.png' }] }
      : undefined
    turn = { reply: await runner.prompt(cfg.text, session) }
  } catch (caught) {
    turn = { error: String(caught && caught.message ? caught.message : caught) }
  }
  await runner.stop()
  report({ turn })
  process.exit(0)
} catch (error) {
  report({ crash: String(error && error.stack ? error.stack : error) })
  process.exit(1)
}
`

interface ChildReport {
  turn?: { reply?: string; error?: string }
  crash?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub | undefined

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-image-restart-'))
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

/** A small PNG-shaped payload with distinct bytes, so equality proves the very same picture. */
function pngBytes(): Buffer {
  const data = Buffer.alloc(300)
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 7 + 3) & 0xff
  data.writeUInt32BE(0x89504e47, 0)
  data.writeUInt32BE(12, 16)
  data.writeUInt32BE(12, 20)
  return data
}

async function runPhase(dshHome: string, cwd: string, text: string, imageBase64?: string): Promise<ChildRun> {
  if (stub === undefined) throw new Error('stub is not started')
  const env: Record<string, string> = { HOME: dshHome, USERPROFILE: dshHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify({
      entry: runnerEntry,
      dshHome,
      cwd,
      baseUrl: `${stub.origin}/anthropic`,
      text,
      ...(imageBase64 === undefined ? {} : { imageBase64 }),
    }),
  ]
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS / 2 - 5_000)
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
      resolve({ report, output: `${stdout.replace(/@@IMAGE-RESTART@@.*/u, '')}\n${stderr}` })
    })
  })
}

function modelRequests(): StubRequest[] {
  return (stub?.requests ?? []).filter(isModelRequest)
}

/** Base64 payloads of the image blocks of one request, in request order. */
function wireImages(request: StubRequest | undefined): string[] {
  const images: string[] = []
  const messages = Array.isArray(request?.body?.messages) ? (request?.body?.messages as Json[]) : []
  for (const message of messages) {
    const content = Array.isArray(message.content) ? (message.content as Json[]) : []
    for (const block of content) {
      const source = block.type === 'image' ? (block.source as Json | undefined) : undefined
      if (source?.type === 'base64') images.push(String(source.data))
    }
  }
  return images
}

/** The attachmentId the first turn left in the saved history of the session. */
function savedAttachmentIds(dshHome: string): string[] {
  const ids = new Set<string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else for (const match of readFileSync(path, 'utf8').matchAll(/img_[0-9a-f]{32}/gu)) ids.add(match[0])
    }
  }
  walk(join(dshHome, 'sessions'))
  return [...ids]
}

/** Rewrite the id in the saved history, so the stored picture is not found anywhere under that id. */
function renameAttachmentInHistory(dshHome: string, from: string, to: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else {
        const text = readFileSync(path, 'utf8')
        if (text.includes(from)) writeFileSync(path, text.split(from).join(to))
      }
    }
  }
  walk(join(dshHome, 'sessions'))
}

async function seed(): Promise<{ dshHome: string; cwd: string; imageBase64: string; attachmentId: string }> {
  stub = await startStub()
  const dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  const cwd = mkdtempSync(join(scratch, 'cwd-'))
  const imageBase64 = pngBytes().toString('base64')
  const first = await runPhase(dshHome, cwd, SEED_TEXT, imageBase64)
  expect(first.report?.crash, first.output).toBeUndefined()
  expect(first.report?.turn?.error, first.output).toBeUndefined()
  expect(first.report?.turn?.reply, first.output).toContain('ответ модели')
  expect(wireImages(modelRequests()[0]), 'the first turn sends the photo').toEqual([imageBase64])
  const ids = savedAttachmentIds(dshHome)
  expect(ids, 'the history keeps one image block').toHaveLength(1)
  return { dshHome, cwd, imageBase64, attachmentId: ids[0] as string }
}

test(
  'test_c1_image_in_history_survives_a_daemon_restart_with_the_same_bytes',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const { dshHome, cwd, imageBase64 } = await seed()
    const before = modelRequests().length

    const run = await runPhase(dshHome, cwd, NEXT_TEXT)

    expect(run.report?.crash, run.output).toBeUndefined()
    expect(run.report?.turn?.error, run.output).toBeUndefined()
    expect(run.report?.turn?.reply, run.output).toContain('ответ модели')
    expect(run.output).not.toContain('TRANSPORT')
    const next = modelRequests().slice(before)
    expect(next, run.output).toHaveLength(1)
    expect(JSON.stringify(next[0]?.body?.messages ?? [])).toContain(NEXT_TEXT)
    expect(wireImages(next[0]), 'the request carries the same picture as before the restart').toEqual([imageBase64])
  },
)

test(
  'test_c2_c3_image_missing_everywhere_is_replaced_logged_and_requested_once',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const { dshHome, cwd, imageBase64, attachmentId } = await seed()
    // Neither the memory of the restarted runner nor any file on disk knows this id.
    const lostId = `img_${'f'.repeat(32)}`
    renameAttachmentInHistory(dshHome, attachmentId, lostId)
    const before = modelRequests().length

    const run = await runPhase(dshHome, cwd, NEXT_TEXT)

    expect(run.report?.crash, run.output).toBeUndefined()
    expect(run.report?.turn?.error, run.output).toBeUndefined()
    expect(run.report?.turn?.reply, run.output).toContain('ответ модели')
    const next = modelRequests().slice(before)
    // c3: one request for the step, no model request retry because of the picture.
    expect(next, run.output).toHaveLength(1)
    expect(JSON.stringify(next[0]?.body?.messages ?? [])).toContain(NEXT_TEXT)
    expect(wireImages(next[0]), 'the lost picture is replaced, not sent').not.toContain(imageBase64)
    // c2: the daemon journal names the unavailable picture by its attachmentId.
    const lines = run.output.split('\n').filter((line) => line.includes(lostId))
    expect(lines.length, run.output).toBeGreaterThanOrEqual(1)
  },
)
