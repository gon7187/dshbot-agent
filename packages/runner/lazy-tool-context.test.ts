// [h1] Lazy tools and tool_search run with the same RunnerToolContext as core tools: the abort signal of the
// turn (from cancellation) together with the sessionId of the calling session. A child process runs a real
// runner against a local DeepSeek stub. A core tool and a lazy tool (enabled through tool_search in the same
// session) both wait for their abort signal; the driver cancels the turn while each of them runs.

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

const CHILD_TIMEOUT_MS = 90_000
const RESULT_MARK = '@@LAZY-CONTEXT@@'

const CORE_TRIGGER = 'CORE_NOW'
const SEARCH_TRIGGER = 'SEARCH_NOW'
const CORE_NAME = 'core_probe'
const LAZY_NAME = 'weather_lookup'
const LAZY_DESCRIPTION = 'Прогноз погоды по городу: температура, осадки и ветер на ближайшие семь дней подряд'

type Json = Record<string, unknown>

// --- local stub of the DeepSeek Messages API ----------------------------------------------------

interface Stub {
  server: Server
  origin: string
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

function toolUse(id: string, name: string, input: Json): string {
  return streamOf({ type: 'tool_use', id, name, input: {} }, [{ type: 'input_json_delta', partial_json: JSON.stringify(input) }], 'tool_use')
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

function lastIsToolResult(body: Json): boolean {
  const content = messagesOf(body).at(-1)?.content
  return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'tool_result')
}

function lastUserText(body: Json): string {
  const message = messagesOf(body).at(-1)
  return message?.role === 'user' ? blockText(message.content) : ''
}

/** Name of the last tool_use the model made in the history. */
function lastToolUseName(body: Json): string {
  for (const message of messagesOf(body).reverse()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of [...message.content].reverse()) {
      const record = asRecord(block)
      if (record?.type === 'tool_use') return String(record.name)
    }
  }
  return ''
}

/**
 * Core turn: core_probe, then an answer. Search turn: tool_search, then the lazy tool it enabled, then an
 * answer. Every tool_use sits in its own request, after the tool_result of the previous step.
 */
async function startStub(): Promise<Stub> {
  const stub: Stub = { server: createServer(), origin: '' }
  let ids = 0
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
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      ids += 1
      const id = `toolu_stub_${ids}`
      if (lastIsToolResult(body)) {
        res.end(lastToolUseName(body) === 'tool_search' ? toolUse(id, LAZY_NAME, {}) : answer('готово'))
        return
      }
      const text = lastUserText(body)
      if (text.includes(CORE_TRIGGER)) res.end(toolUse(id, CORE_NAME, {}))
      else if (text.includes(SEARCH_TRIGGER)) res.end(toolUse(id, 'tool_search', { query: 'weather' }))
      else res.end(answer('готово'))
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Per tool: what the context carried and how the call ended.
const data = { calls: {}, outcomes: {} }
function probe(name, description, lazy) {
  return {
    name,
    description,
    ...(lazy ? { lazy: true } : {}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (args, context) => {
      const call = {
        hasSignal: Boolean(context && context.signal && typeof context.signal.aborted === 'boolean'),
        sessionId: context && context.sessionId,
        events: ['start'],
      }
      data.calls[name] = call
      return await new Promise((resolve) => {
        const guard = setTimeout(() => { call.events.push('finished'); resolve('finished') }, 20000)
        if (!call.hasSignal) return
        context.signal.addEventListener('abort', () => {
          clearTimeout(guard)
          call.events.push('aborted')
          resolve('aborted')
        }, { once: true })
      })
    },
  }
}

async function turnThenCancel(runner, text, toolName) {
  const turn = runner.promptTurn(text)
  for (let i = 0; i < 400 && !(data.calls[toolName] && data.calls[toolName].events.includes('start')); i += 1) await sleep(50)
  try { runner.cancel() } catch (error) { data.cancelError = String(error) }
  data.outcomes[toolName] = await Promise.race([
    turn.then((outcome) => outcome, (error) => ({ error: String(error && error.message ? error.message : error) })),
    sleep(15000).then(() => 'hang'),
  ])
}

try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    model: 'deepseek-flash',
    tools: [probe(cfg.coreName, 'Основной тестовый инструмент', false), probe(cfg.lazyName, cfg.lazyDescription, true)],
  })
  await turnThenCancel(runner, cfg.coreText, cfg.coreName)
  await turnThenCancel(runner, cfg.searchText, cfg.lazyName)
  await runner.stop()
  report(data)
} catch (error) {
  report({ ...data, error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface CallReport {
  hasSignal: boolean
  sessionId?: string
  events: string[]
}

interface ChildReport {
  calls: Record<string, CallReport>
  outcomes: Record<string, unknown>
  cancelError?: string
  error?: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-lazy-context-test-'))
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

function runChild(): Promise<{ report: ChildReport | undefined; output: string }> {
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const cfg = {
    entry: runnerEntry,
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    coreName: CORE_NAME,
    lazyName: LAZY_NAME,
    lazyDescription: LAZY_DESCRIPTION,
    coreText: CORE_TRIGGER,
    searchText: SEARCH_TRIGGER,
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

test('test_h1_lazy_tools_get_the_same_context_with_signal_and_sessionId_as_core_tools', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild()
  expect(run.report?.error, run.output).toBeUndefined()
  const report = run.report as ChildReport
  expect(report, run.output).toBeDefined()
  expect(report.cancelError, 'runner.cancel must exist (the signal and cancel come from main)').toBeUndefined()

  for (const name of [CORE_NAME, LAZY_NAME]) {
    const call = report.calls[name]
    expect(call, `${name} must be executed (lazy one: enabled through tool_search in the session)\n${run.output}`).toBeDefined()
    expect(call.hasSignal, `${name} must get the abort signal in its context\n${run.output}`).toBe(true)
    expect(call.sessionId, `${name} must get the sessionId of the calling session\n${run.output}`).toBe('main')
    expect(call.events, `cancelling the turn must fire the signal of ${name}\n${run.output}`).toContain('aborted')
    expect(call.events, `${name} must not run to its end\n${run.output}`).not.toContain('finished')
    expect(report.outcomes[name], `promptTurn of ${name} must end after the cancel\n${run.output}`).not.toBe('hang')
  }
})
