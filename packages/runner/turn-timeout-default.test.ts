import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

describe('own continuation and child cancellation', () => {
// Real runner continuation with a local fake provider and an abortable tool.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 90_000
const RESULT_MARK = '@@TIMEOUT-DEFAULT@@'
const API_KEY = 'sk-turn-timeout-secret-key-0123456789abcdef'

type Json = Record<string, unknown>

// --- local stub of the DeepSeek Messages API ----------------------------------------------------

interface Stub {
  server: Server
  origin: string
  calls: Json[]
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function lastIsToolResult(body: Json): boolean {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : []
  const content = messages[messages.length - 1]?.content
  return Array.isArray(content) && (content as Json[]).some((block) => block.type === 'tool_result')
}

/** The first streamed request asks for the slow tool; once it has a tool_result the model answers. */
async function startStub(): Promise<Stub> {
  const stub: Stub = { server: createServer(), origin: '', calls: [] }
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
      stub.calls.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (JSON.stringify(body.messages).includes('correction-one')) {
        res.end(streamOf({ type: 'text', text: '' }, [{ type: 'text_delta', text: 'continued-original-task' }], 'end_turn'))
        return
      }
      if (lastIsToolResult(body)) {
        res.end(streamOf({ type: 'text', text: '' }, [{ type: 'text_delta', text: 'late-answer' }], 'end_turn'))
        return
      }
      res.end(
        streamOf(
          { type: 'tool_use', id: 'toolu_stub_1', name: Array.isArray(body.tools) && (body.tools as Json[]).some(tool => tool.name === 'delegate_sync')
            ? 'delegate_sync' : 'slow_probe', input: {} },
          [{ type: 'input_json_delta', partial_json: '{}' }],
          'tool_use',
        ),
      )
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

const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (data) => console.log('${RESULT_MARK}' + JSON.stringify(data))
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

// The fake clock: timers of 10 minutes and longer are kept, not armed.
const held = new Set()
globalThis.setTimeout = function (callback, delay, ...args) {
  if (typeof delay === 'number' && delay >= 600000) {
    const timer = {
      callback, delay, args,
      unref() { return timer }, ref() { return timer }, hasRef() { return false }, refresh() { return timer },
      [Symbol.toPrimitive]() { return 0 },
    }
    held.add(timer)
    return timer
  }
  return realSetTimeout(callback, delay, ...args)
}
globalThis.clearTimeout = function (timer) {
  if (held.delete(timer)) return
  realClearTimeout(timer)
}
function advance(from, to) {
  for (const timer of [...held]) {
    if (timer.delay >= from && timer.delay < to) {
      held.delete(timer)
      timer.callback(...timer.args)
    }
  }
}

const data = { toolEvents: [], turnsEnded: 0 }
try {
  const runnerModule = await import(cfg.entry)
  let runner
  const slow = {
    name: 'slow_probe',
    description: 'Test probe that works for a very long time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (args, context) => {
      data.toolEvents.push('start')
      if (context === undefined || !context.signal) data.toolEvents.push('nosignal')
      return await new Promise((resolve) => {
        const guard = realSetTimeout(() => { data.toolEvents.push('finished'); resolve('finished') }, 25000)
        context?.signal?.addEventListener('abort', () => {
          realClearTimeout(guard)
          data.toolEvents.push('aborted')
          resolve('aborted')
        }, { once: true })
      })
    },
  }
  data.defaultMs = runnerModule.DEFAULT_TURN_TIMEOUT_MS
  const delegated = {
    name: 'delegate_sync', description: 'Run one synchronous child.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (args, context) => {
      data.childResult = await runner.runChild({ task: 'child-original-task', parentSessionId: 'main', tools: ['slow_probe'], signal: context.signal })
      return data.childResult
    },
  }
  runner = await runnerModule.startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    tools: cfg.child ? [slow, delegated] : [slow],
    onTurnEnd: () => { data.turnsEnded++ },
  })
  const turn = runner.promptTurn('сделай медленное дело')
  for (let i = 0; i < 400 && !data.toolEvents.includes('start'); i += 1) await sleep(50)
  data.armed = [...held].map((timer) => timer.delay).sort((a, b) => a - b)

  if (cfg.corrections) {
    data.accepted = cfg.corrections.map(text => runner.steer(text))
    if (cfg.stopAfterCorrection) data.stopped = runner.cancel()
  } else {
  advance(900000, 1800000)
  await sleep(800)
  data.abortedAt15 = data.toolEvents.includes('aborted')

  advance(1800000, Infinity)
  }
  let deadline
  data.outcome = await Promise.race([turn.then((outcome) => outcome, (error) => ({ error: String(error && error.message ? error.message : error) })), new Promise(resolve => { deadline = realSetTimeout(() => resolve('hang'), 15000) })])
  realClearTimeout(deadline)
  data.lateSteer = runner.steer('late correction')
  await runner.stop()
  report(data)
} catch (error) {
  report({ ...data, error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  realSetTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildReport {
  toolEvents: string[]
  defaultMs?: number
  armed?: number[]
  abortedAt15?: boolean
  outcome?: unknown
  error?: string
  accepted?: boolean[]
  turnsEnded?: number
  stopped?: boolean
  lateSteer?: boolean
  childResult?: { text: string; aborted?: string }
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-timeout-default-test-'))
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

function runChild(options: { corrections?: string[]; stopAfterCorrection?: boolean; child?: boolean } = {}): Promise<{ report: ChildReport | undefined; output: string }> {
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const cfg = { entry: runnerEntry, dshHome, cwd: workDir, baseUrl: `${stub.origin}/anthropic`, apiKey: API_KEY, ...options }
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


test('R-CORRECTION preserves goal and ordered corrections once', { timeout: 60_000 }, async () => {
  {
  const run = await runChild({ corrections: ['correction-one: inspect partial side effects', 'correction-two: preserve the original goal'] })
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.accepted).toEqual([true, true])
  expect(run.report?.toolEvents).toEqual(['start', 'aborted'])
  expect(run.report?.outcome, run.output).toMatchObject({ text: 'continued-original-task' })
  expect(run.report?.turnsEnded).toBe(1)
  expect(run.report?.lateSteer).toBe(false)
  expect(stub.calls.length).toBeGreaterThanOrEqual(2)
  expect(stub.calls.length).toBeLessThanOrEqual(3)
  const resumed = JSON.stringify(stub.calls.at(-1)?.messages)
  expect(resumed).toContain('сделай медленное дело')
  expect(resumed.split('correction-one')).toHaveLength(2)
  expect(resumed.split('correction-two')).toHaveLength(2)
  expect(resumed.indexOf('correction-one')).toBeLessThan(resumed.indexOf('correction-two'))
  expect(resumed).toMatch(/partial|частичн/u)
  }
})

test('R-STOP cancels without replay', { timeout: 60_000 }, async () => {
  {
  const run = await runChild({ corrections: ['correction-one'], stopAfterCorrection: true })
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.stopped).toBe(true)
  expect(run.report?.toolEvents).toEqual(['start', 'aborted'])
  expect(run.report?.outcome).toEqual({ text: '', aborted: 'stop' })
  expect(run.report?.turnsEnded).toBe(1)
  expect(stub.calls).toHaveLength(1)
  }
})

test('R-SYNC-CHILD propagates cancellation', { timeout: 60_000 }, async () => {
  {
  const run = await runChild({ corrections: ['correction-one'], child: true })
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.toolEvents).toEqual(['start', 'aborted'])
  expect(run.report?.childResult).toMatchObject({ text: '', aborted: 'stop' })
  expect(run.report?.outcome, run.output).toMatchObject({ text: 'continued-original-task' })
  expect(run.report?.turnsEnded).toBe(1)
  expect(stub.calls).toHaveLength(3)
  }
})

})
