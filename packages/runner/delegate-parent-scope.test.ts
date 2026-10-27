// delegate: the child is bound to the calling (parent) session. A real runner runs in a child process against a
// local DeepSeek stub; the delegate tool is wired exactly as the app wires it (`run` hands the request straight to
// `runner.runChild`). The stub tells the roles apart by the text of the request: a parent turn carries `PAR_`, a
// child turn starts with the runner's "Задача субагента:" line. What the child request offered is read from the
// stub, so the checks do not depend on how the runner names its internal fields.

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
const delegateEntry = pathToFileURL(join(repoRoot, 'packages/tools-subagent/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@DELEGATE-SCOPE@@'
const CHILD_REPORT = 'KID-REPORT-DONE'
const CHILD_TASK_LINE = 'Задача субагента:'
const PARENT_MARK = 'PAR_RUN'
const PARENT_SESSION = 'owner-parent-174'

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

function toolResultsOf(body: Json): string[] {
  const results: string[] = []
  for (const message of messagesOf(body)) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const record = asRecord(block)
      if (record?.type === 'tool_result') results.push(blockText(record.content))
    }
  }
  return results
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
      const step = role === 'parent' ? stub.steps[toolResultsOf(body).length] : undefined
      res.end(step === undefined ? answer('готово') : toolUse(`toolu_stub_${ids}`, step))
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
const delegated = []
try {
  const { startRunner } = await import(cfg.entry)
  const { createDelegateTool } = await import(cfg.delegateEntry)
  let runner
  const probe = (name, description, lazy) => ({
    name,
    description,
    ...(lazy ? { lazy: true } : {}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => name + ' ran',
  })
  const delegate = createDelegateTool({
    lazy: false,
    run: async (request) => {
      const { signal, ...rest } = request
      delegated.push(JSON.parse(JSON.stringify(rest)))
      return runner.runChild(request)
    },
  })
  const tools = [
    cfg.guestDelegate ? { ...delegate, guestAllowed: true } : delegate,
    probe('read_probe', 'Читает пробный файл', false),
    probe('self_discard', 'Снимает кандидата', false),
    probe('update_identity', 'Обновляет личность', false),
    probe('lazy_enabled', 'Прогноз погоды по городу', true),
    probe('lazy_hidden', 'Курс валют на сегодня', true),
  ]
  runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    model: 'deepseek-flash',
    tools,
  })
  const reply = await runner.prompt(cfg.text, cfg.session)
  await runner.stop()
  report({ delegated, reply })
} catch (error) {
  report({ delegated, error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface DriverReport {
  delegated: Json[]
  reply?: string
  error?: string
}

interface DriverRun {
  report: DriverReport | undefined
  output: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-delegate-scope-test-'))
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

function runDriver(extra: { session?: Json; guestDelegate?: boolean }): Promise<DriverRun> {
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const cfg = {
    entry: runnerEntry,
    delegateEntry,
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    text: `${PARENT_MARK} go`,
    ...extra,
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
      const report = line ? (JSON.parse(line.slice(RESULT_MARK.length)) as DriverReport) : undefined
      resolve({ report, output: `${stdout}\n${stderr}`.slice(-4000) })
    })
  })
}

function expectCleanRun(run: DriverRun): DriverReport {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  return run.report as DriverReport
}

function childRequests(): Json[] {
  return stub.seen.filter((entry) => entry.role === 'child').map((entry) => entry.body)
}

/** Everything one child request offered to the model: tool schemas and the system prompt. */
function offeredText(body: Json): string {
  return JSON.stringify({ tools: body.tools ?? [], system: body.system ?? '' })
}

test('test_guest_delegate_from_a_guest_session_is_refused_and_no_child_starts', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.steps = [{ name: 'delegate', input: { task: 'KID_TASK guest', tools: [] } }]
  const run = await runDriver({
    guestDelegate: true,
    session: { sessionId: 'guest-174', principal: 'guest', tools: ['delegate'] },
  })
  expectCleanRun(run)

  // The guest model did call delegate (the tool is artificially granted), so the parent saw its result.
  const parentCalls = stub.seen.filter((entry) => entry.role === 'parent')
  const withResult = parentCalls.filter((entry) => toolResultsOf(entry.body).length > 0)
  expect(withResult.length, `the guest must have called delegate\n${run.output}`).toBeGreaterThan(0)
  for (const entry of withResult) {
    for (const result of toolResultsOf(entry.body)) expect(result).not.toContain(CHILD_REPORT)
  }
  // No child session: no request of a child ever reached the model.
  expect(childRequests(), `a child must not start for a guest parent\n${run.output}`).toHaveLength(0)
})

test('test_inherit_run_child_receives_the_id_of_the_parent_session', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.steps = [{ name: 'delegate', input: { task: 'KID_TASK inherit', tools: ['read_probe'] } }]
  const run = await runDriver({
    session: { sessionId: PARENT_SESSION, principal: 'owner', tools: ['delegate', 'read_probe'] },
  })
  const report = expectCleanRun(run)

  expect(report.delegated, run.output).toHaveLength(1)
  const { task, tools, ...rest } = report.delegated[0] as Json
  expect(task).toBe('KID_TASK inherit')
  expect(tools).toEqual(['read_probe'])
  expect(JSON.stringify(rest), `the request must carry the id of the calling session\n${run.output}`).toContain(PARENT_SESSION)
  // The owner parent is allowed to delegate: the child ran.
  expect(childRequests(), run.output).toHaveLength(1)
})

test('test_subset_child_of_main_gets_only_lazy_tools_the_parent_enabled', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.steps = [
    { name: 'tool_search', input: { query: 'lazy_enabled' } },
    { name: 'delegate', input: { task: 'KID_TASK subset', tools: ['read_probe', 'lazy_enabled', 'lazy_hidden'] } },
  ]
  const run = await runDriver({})
  expectCleanRun(run)

  const children = childRequests()
  expect(children, `the child must start\n${run.output}`).toHaveLength(1)
  const offered = offeredText(children[0] as Json)
  expect(offered).toContain('read_probe')
  expect(offered, 'a lazy tool enabled by the parent through tool_search goes to the child').toContain('lazy_enabled')
  expect(JSON.stringify(children[0]), 'a lazy tool the parent never enabled must not reach the child').not.toContain('lazy_hidden')
})

test('test_forbidden_child_never_gets_self_discard_or_update_identity', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.steps = [
    {
      name: 'delegate',
      input: { task: 'KID_TASK forbidden', tools: ['read_probe', 'self_discard', 'update_identity'] },
    },
  ]
  const run = await runDriver({})
  expectCleanRun(run)

  const children = childRequests()
  expect(children, `the child must start\n${run.output}`).toHaveLength(1)
  expect(offeredText(children[0] as Json)).toContain('read_probe')
  const body = JSON.stringify(children[0])
  expect(body, 'self_discard must not be offered to a child').not.toContain('self_discard')
  expect(body, 'update_identity must not be offered to a child').not.toContain('update_identity')
})
