// The tool seam of packages/runner seen from the guest side: a fake owner tool is registered through the
// seam, a stub of DeepSeek plays a model that asks for it in every conversation. The runner runs in a child
// process (plain Node cannot resolve the repository's `.js` specifiers without the hook written below).
// A guest session is opened the way the app opens it: its own session id and no tools.

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
const RESULT_MARK = '@@SEAM-RESULT@@'
const OWNER_TOOL = 'owner_fake_tool'
/** What the fake owner tool returns; it reaches the model only when the handler ran. */
const HANDLER_ANSWER = 'OWNER-HANDLER-RAN'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

interface Stub {
  server: Server
  origin: string
  bodies: JsonObject[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function start(): string {
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

function end(reason: string): string {
  return [
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function textStream(text: string): string {
  return [
    start(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    end('end_turn'),
  ].join('')
}

function toolUseStream(id: string): string {
  return [
    start(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: OWNER_TOOL, input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: 'ping' }) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    end('tool_use'),
  ].join('')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => (typeof block === 'string' ? block : String(asObject(block).text ?? ''))).join('')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function lastIsToolResult(body: JsonObject): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const content = asObject(messages[messages.length - 1]).content
  return Array.isArray(content) && content.some((block) => asObject(block).type === 'tool_result')
}

/** The conversation marker: the first message of every conversation carries MARK_x. */
function markerOf(body: JsonObject): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return /MARK_[A-Z0-9]+/.exec(blockText(asObject(messages[0]).content))?.[0]
}

async function startStub(): Promise<Stub> {
  const bodies: JsonObject[] = []
  const stub: Stub = { server: createServer(), origin: '', bodies }
  let sent = 0
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: JsonObject = {}
      try {
        body = asObject(JSON.parse(raw))
      } catch {
        body = {}
      }
      const isModelCall = req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }))
        return
      }
      if (isModelCall) bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if (isModelCall && !lastIsToolResult(body) && markerOf(body) !== undefined) {
        sent += 1
        res.end(toolUseStream(`toolu_seam_${sent}`))
        return
      }
      res.end(textStream('done'))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

function toolNames(body: JsonObject): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => String(asObject(tool).name))
}

function toolResults(body: JsonObject): string[] {
  const results: string[] = []
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    const content = asObject(message).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (asObject(block).type === 'tool_result') results.push(blockText(asObject(block).content))
    }
  }
  return results
}

/** Model requests of one conversation. */
function callsOf(stub: Stub, marker: string): JsonObject[] {
  return stub.bodies.filter((body) => markerOf(body) === marker)
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

// Registers one fake owner tool, then sends each prompt in order; reports every run of its handler.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const executeCalls = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ executeCalls, ...extra }))
try {
  const { startRunner } = await import(cfg.entry)
  const tools = [{
    name: cfg.toolName,
    description: 'a tool of the owner',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async (args) => {
      executeCalls.push({ session: cfg.currentSession, args })
      return '${HANDLER_ANSWER}'
    },
  }]
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT',
    tools,
  })
  for (const turn of cfg.turns) {
    cfg.currentSession = turn.label
    await runner.prompt(turn.text, turn.session)
  }
  await runner.stop()
  report({})
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface Turn {
  label: string
  text: string
  session?: { sessionId?: string; tools?: string[] }
}

interface ChildReport {
  executeCalls: Array<{ session: string; args: unknown }>
  error?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'guest-seam-test-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  stub = await startStub()
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    stub.server.closeAllConnections()
    stub.server.close(() => resolve())
  })
})

function runChild(turns: Turn[]): Promise<ChildRun> {
  const home = mkdtempSync(join(scratch, 'home-'))
  const config = {
    dshHome: join(mkdtempSync(join(scratch, 'dsh-')), 'state'),
    cwd: mkdtempSync(join(scratch, 'cwd-')),
    baseUrl: `${stub.origin}/anthropic`,
    toolName: OWNER_TOOL,
    turns,
    entry: runnerEntry,
  }
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = ['--import', pathToFileURL(join(scratch, 'register.mjs')).href, join(scratch, 'driver.mjs'), JSON.stringify(config)]
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

const GUEST_TURNS: Turn[] = [
  { label: 'guest-1', text: 'MARK_G1 привет', session: { sessionId: 'guest-1' } },
  { label: 'guest-2', text: 'MARK_G2 привет', session: { sessionId: 'guest-2', tools: [] } },
]

test('test_schema_seam_fake_owner_tool_is_in_the_owner_request_and_not_in_any_guest_request', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const run = await runChild([{ label: 'main', text: 'MARK_MAIN привет' }, ...GUEST_TURNS])
  expectCleanRun(run)

  const owner = callsOf(stub, 'MARK_MAIN')
  expect(owner.length, run.output).toBeGreaterThan(0)
  expect(toolNames(owner[0] as JsonObject)).toEqual([OWNER_TOOL])

  for (const marker of ['MARK_G1', 'MARK_G2']) {
    const calls = callsOf(stub, marker)
    expect(calls.length, `${marker}: ${run.output}`).toBeGreaterThan(0)
    for (const call of calls) expect(toolNames(call), `${marker} was offered a tool`).toEqual([])
  }
})

test('test_forged_seam_guest_tool_use_with_the_name_of_an_owner_tool_does_not_run_its_handler', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const run = await runChild([{ label: 'main', text: 'MARK_MAIN привет' }, ...GUEST_TURNS])
  const report = expectCleanRun(run)

  // the owner's own call ran the handler once: the tool works, so a missing run for a guest is the seam's doing
  expect(report.executeCalls.map((call) => call.session), run.output).toEqual(['main'])
  const ownerResults = callsOf(stub, 'MARK_MAIN').flatMap(toolResults)
  expect(ownerResults.join('\n')).toContain(HANDLER_ANSWER)

  for (const marker of ['MARK_G1', 'MARK_G2']) {
    const calls = callsOf(stub, marker)
    // the forged tool_use got an answer and the turn went on to a second request
    expect(calls.length, `${marker}: ${run.output}`).toBeGreaterThanOrEqual(2)
    const results = calls.flatMap(toolResults)
    expect(results.length, marker).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.trim().length, `${marker}: empty refusal`).toBeGreaterThan(0)
      expect(result, marker).not.toContain(HANDLER_ANSWER)
    }
  }
})
