// The service turn before a compaction (memory flush): its prompt and the tools it may run.
// Same harness as session-tools.test.ts: a child process starts the runner against a local stub of the
// DeepSeek Messages API, with tools whose `execute` is reported back to the test. The stub plays:
//   - a request without tools or with the checkpoint instruction (the summary of a compaction): a fixed short text;
//   - a request with tools whose last user text carries `MARK_OWNER`: an owner turn, answered with a text;
//   - a request with tools whose last user text has no marker: the service turn before the compaction. It records
//     the prompt and calls the tools of `FLUSH_SCRIPT` one after another, then ends with a text.

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
const RESULT_MARK = '@@FLUSH-GUARD-RESULT@@'
const ECHO_PREFIX = 'ECHO-RESULT:'
const OWNER_MARKER = 'MARK_OWNER'
const SUMMARY_TEXT = 'SUMMARY-STUB of the earlier talk'
const DONE_TEXT = 'FLUSH-DONE-STUB'

type JsonObject = Record<string, unknown>

interface ToolCall {
  name: string
  input: JsonObject
}

/** Tools the service turn tries, in order: four that must be refused, then the memory. */
const FORBIDDEN_TOOLS = ['exec', 'host_exec', 'edit', 'mail']
const FLUSH_SCRIPT: ToolCall[] = [
  ...FORBIDDEN_TOOLS.map((name) => ({ name, input: { text: `forbidden-${name}` } })),
  { name: 'memory', input: { text: 'saved-fact' } },
]

// --- local stub of the DeepSeek Messages API ---------------------------------------------------

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

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
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

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map((m) => asRecord(m) ?? {}) : []
}

function toolNamesOf(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => String(asRecord(tool)?.name))
}

/** Text of the last user message that carries text (a message with tool results alone does not count). */
function lastUserText(body: JsonObject): string {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const text = blockText(message.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** Texts of all tool results in the history of a request, in order. */
function toolResultsOf(body: JsonObject): string[] {
  const results: string[] = []
  for (const message of messagesOf(body)) {
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = asRecord(block)
      if (record?.type === 'tool_result') results.push(blockText(record.content))
    }
  }
  return results
}

function isSummaryRequest(body: JsonObject): boolean {
  return toolNamesOf(body).length === 0 || lastUserText(body).includes('Output only the checkpoint text')
}

/** The request of the service turn: tools on offer and a last user text that is not the owner's. */
function isFlushRequest(body: JsonObject): boolean {
  return !isSummaryRequest(body) && !lastUserText(body).includes(OWNER_MARKER)
}

interface Stub {
  server: Server
  origin: string
  requests: JsonObject[]
}

async function startStub(): Promise<Stub> {
  const requests: JsonObject[] = []
  const stub: Stub = { server: createServer(), origin: '', requests }
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: JsonObject = {}
      try {
        body = asRecord(JSON.parse(raw)) ?? {}
      } catch {
        body = {}
      }
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) requests.push(body)
      const streaming = body.stream !== false
      const answerText = (text: string): void => {
        if (!streaming) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(textMessage(text))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(textStream(text))
      }
      if (!isModelCall) {
        answerText(SUMMARY_TEXT)
        return
      }
      if (isSummaryRequest(body)) {
        answerText(SUMMARY_TEXT)
        return
      }
      if (!isFlushRequest(body)) {
        answerText('ok owner turn')
        return
      }
      const step = toolResultsOf(body).length
      const call = FLUSH_SCRIPT[step]
      if (call === undefined || !streaming) {
        answerText(DONE_TEXT)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(toolUseStream(`toolu_flush_${step}`, call))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
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

// Registers the tools as spies, talks a few owner turns to main, then runs the manual /compact.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const executeCalls = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ executeCalls, ...extra }))
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
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    tools,
  })
  for (const text of cfg.turns) await runner.prompt(text)
  let compactError
  try {
    await runner.compact()
  } catch (error) {
    compactError = String(error && error.message ? error.message : error)
  }
  await runner.stop()
  report({ compactError })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildReport {
  executeCalls: Array<{ name: string; args: unknown }>
  compactError?: string
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
  scratch = mkdtempSync(join(tmpdir(), 'runner-flush-guard-test-'))
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

const FILLER = 'длинное описание задачи без особого смысла '.repeat(100)

/** Four long owner turns, then `/compact`; the service turn runs on a fork before the summary. */
function runCompaction(): Promise<ChildRun> {
  const cfg = {
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    toolNames: [...FORBIDDEN_TOOLS, 'memory'],
    turns: [1, 2, 3, 4].map((n) => `${OWNER_MARKER} ${n} ${FILLER}`),
    entry: runnerEntry,
  }
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
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

function expectCleanRun(run: ChildRun): ChildReport {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  return run.report as ChildReport
}

/** Requests of the service turn, in order. */
function flushRequests(): JsonObject[] {
  return stub.requests.filter((body) => body.stream !== false && isFlushRequest(body))
}

test(
  'test_h1_flush_prompt_does_not_ask_for_credentials_and_forbids_secrets',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    const run = await runCompaction()
    expectCleanRun(run)

    const flushes = flushRequests()
    expect(flushes.length, `the model got a service turn before /compact\n${run.output}`).toBeGreaterThanOrEqual(1)
    const prompt = lastUserText(flushes[0] as JsonObject)
    expect(prompt, 'the service turn has a prompt').not.toBe('')

    // the list of facts to save no longer names the credentials of services
    expect(prompt, 'no request to save credentials of services').not.toMatch(/учётн\p{L}*\s+данн\p{L}*\s+сервис/iu)
    expect(prompt, 'no request to save credentials of services').not.toMatch(/учетн\p{L}*\s+данн\p{L}*\s+сервис/iu)
    expect(prompt, 'no request to save credentials').not.toMatch(/credentials/i)

    // an explicit ban: passwords, tokens, API keys and other secrets are never written to the memory
    expect(prompt, 'the ban names passwords').toMatch(/парол/i)
    expect(prompt, 'the ban names tokens').toMatch(/токен/i)
    expect(prompt, 'the ban names API keys').toMatch(/ключ\p{L}*\s+API/iu)
    expect(prompt, 'the ban names secrets').toMatch(/секрет/i)
    expect(prompt, 'the ban is unconditional').toMatch(/никогда/i)
    expect(prompt, 'the ban says not to write to the memory').toMatch(/не\s+(записыва|сохраня|пиш)/i)
  },
)

test(
  'test_h1_flush_turn_runs_only_the_memory_tool_and_refuses_every_other_call_before_execute',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    const run = await runCompaction()
    const report = expectCleanRun(run)

    const flushes = flushRequests()
    expect(flushes.length, `the model got a service turn before /compact\n${run.output}`).toBeGreaterThanOrEqual(1)

    // the service turn went through the whole script: the last request carries every result
    const last = flushes[flushes.length - 1] as JsonObject
    const results = toolResultsOf(last)
    expect(results, `every call of the service turn got a result\n${run.output}`).toHaveLength(FLUSH_SCRIPT.length)

    // exec, host_exec, edit and mail were refused before execute, with a text the model can read
    const executed = report.executeCalls.map((call) => call.name)
    for (const name of FORBIDDEN_TOOLS) {
      expect(executed, `${name} is not executed in the service turn`).not.toContain(name)
    }
    FORBIDDEN_TOOLS.forEach((name, index) => {
      const result = results[index] ?? ''
      expect(result.trim(), `the refusal of ${name} says something`).not.toBe('')
      expect(result, `the result of ${name} is a refusal, not the output of the tool`).not.toContain(ECHO_PREFIX)
    })

    // the memory call passes
    expect(executed.filter((name) => name === 'memory'), 'memory is executed once').toHaveLength(1)
    const memoryCall = report.executeCalls.find((call) => call.name === 'memory')
    expect(memoryCall?.args, 'memory gets the arguments of the model').toEqual({ text: 'saved-fact' })
    expect(results[FORBIDDEN_TOOLS.length] ?? '', 'the result of memory is the output of the tool').toContain(`${ECHO_PREFIX}saved-fact`)
  },
)
