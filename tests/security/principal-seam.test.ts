// The principal seam of packages/runner, seen from the tool author's side.
//
// The daemon-level guest surface is covered by tests/security. This file covers
// the contract that a future tool author relies on:
//   - a tool is invisible to a non-owner principal unless it is explicitly marked
//     `guestAllowed: true`;
//   - a `guestAllowed` tool becomes visible to the guest and to nobody else
//     beyond what the principal says;
//   - a session list can only narrow the guest-visible set, never widen it;
//   - a `tool_use` whose name is outside the principal schema is denied before
//     `execute` runs, and the denial is reported.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@PRINCIPAL-RESULT@@'
const HANDLER_ANSWER = 'HANDLER-RAN'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
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

function toolUseStream(id: string, name: string): string {
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
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: 'ping' }) } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
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

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: unknown) => (typeof block === 'string' ? block : String(asObject(block).text ?? ''))).join('')
}

/** The conversation marker: the first message of every conversation carries MARK_x. */
function markerOf(body: JsonObject): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return /MARK_[A-Z0-9_]+/.exec(blockText(asObject(messages[0]).content))?.[0]
}

interface Stub {
  server: Server
  origin: string
  bodies: JsonObject[]
}

async function startStub(): Promise<Stub> {
  const bodies: JsonObject[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      let body: JsonObject = {}
      try {
        body = asObject(JSON.parse(raw))
      } catch {
        body = {}
      }
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }))
        return
      }
      if (isModelCall) bodies.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      // The stub asks for the tool of the marker whenever the conversation has no
      // tool result yet. In a guest turn it asks for the owner's tool by name:
      // that is the forged call the seam has to refuse.
      const marker = markerOf(body)
      const wanted = marker === 'MARK_GUEST_ALLOWED' ? 'guest_visible_tool' : 'owner_only_tool'
      if (isModelCall && !lastIsToolResult(body) && marker !== undefined) {
        res.end(toolUseStream('toolu_principal_1', wanted))
        return
      }
      res.end(textStream('done'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { server, origin, bodies }
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

// One tool of the owner (not marked), one tool a guest may call (marked).
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const executeCalls = []
const denied = []
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify({ executeCalls, denied, ...extra }))
try {
  const { startRunner } = await import(cfg.entry)
  const tools = [
    {
      name: 'owner_only_tool',
      description: 'a tool of the owner',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (args) => {
        executeCalls.push({ name: 'owner_only_tool', session: cfg.currentSession })
        return '${HANDLER_ANSWER}-owner'
      },
    },
    {
      name: 'guest_visible_tool',
      description: 'a tool a guest may call',
      guestAllowed: true,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      execute: async (args) => {
        executeCalls.push({ name: 'guest_visible_tool', session: cfg.currentSession })
        return '${HANDLER_ANSWER}-guest'
      },
    },
  ]
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT',
    tools,
    onToolDenied: (event) => denied.push(event),
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
  session?: { sessionId?: string; tools?: string[]; principal?: string }
}

interface DeniedEvent {
  sessionId?: string
  principal?: string
  tool: string
}

interface ChildReport {
  executeCalls: Array<{ name: string; session: string }>
  denied: DeniedEvent[]
  error?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'principal-seam-test-'))
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

function runChild(turns: Turn[]): Promise<ChildRun> {
  const home = mkdtempSync(join(scratch, 'home-'))
  const config = {
    dshHome: join(mkdtempSync(join(scratch, 'dsh-')), 'state'),
    cwd: mkdtempSync(join(scratch, 'cwd-')),
    baseUrl: `${stub.origin}/anthropic`,
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

test('test_principal_only_a_tool_marked_guestAllowed_reaches_a_guest_session', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const run = await runChild([
    { label: 'main', text: 'MARK_MAIN привет' },
    { label: 'guest-1', text: 'MARK_GUEST_ALLOWED привет', session: { sessionId: 'guest-1', principal: 'guest' } },
  ])
  const report = expectCleanRun(run)

  const owner = callsOf(stub, 'MARK_MAIN')
  expect(owner.length, run.output).toBeGreaterThan(0)
  expect(toolNames(owner[0] as JsonObject).sort()).toEqual(['guest_visible_tool', 'owner_only_tool'])

  const guest = callsOf(stub, 'MARK_GUEST_ALLOWED')
  expect(guest.length, run.output).toBeGreaterThan(0)
  for (const call of guest) {
    expect(toolNames(call), 'the guest sees a tool that is not marked guestAllowed').toEqual(['guest_visible_tool'])
  }

  // the marked tool really ran for the guest, the unmarked one never did
  const ranFor = report.executeCalls.map((call) => `${call.name}@${call.session}`)
  expect(ranFor, run.output).toContain('guest_visible_tool@guest-1')
  expect(ranFor, run.output).not.toContain('owner_only_tool@guest-1')
})

test('test_principal_a_session_tool_list_can_only_narrow_the_guest_visible_set', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const run = await runChild([
    {
      label: 'guest-narrow',
      text: 'MARK_GUEST привет',
      // The session asks for the owner's tool as well: the seam must not widen.
      session: { sessionId: 'guest-narrow', principal: 'guest', tools: ['owner_only_tool', 'guest_visible_tool'] },
    },
  ])
  expectCleanRun(run)

  const guest = callsOf(stub, 'MARK_GUEST')
  expect(guest.length, run.output).toBeGreaterThan(0)
  for (const call of guest) expect(toolNames(call), run.output).toEqual(['guest_visible_tool'])
})

test('test_principal_a_forged_tool_use_is_denied_before_execute_and_reported', { timeout: CHILD_TIMEOUT_MS * 2 }, async () => {
  const run = await runChild([
    { label: 'guest-1', text: 'MARK_GUEST привет', session: { sessionId: 'guest-1', principal: 'guest' } },
  ])
  const report = expectCleanRun(run)

  // the stub asked for the owner's tool by name; the seam refused it
  expect(report.executeCalls.map((call) => call.name), run.output).not.toContain('owner_only_tool')
  expect(report.denied, `no denial was reported\n${run.output}`).toEqual([
    expect.objectContaining({ tool: 'owner_only_tool', principal: 'guest' }),
  ])

  const guest = callsOf(stub, 'MARK_GUEST')
  const results = guest.flatMap(toolResults)
  expect(results.length, 'the forged call got no answer').toBeGreaterThan(0)
  for (const result of results) {
    expect(result.trim().length, 'the refusal is empty').toBeGreaterThan(0)
    expect(result).not.toContain(HANDLER_ANSWER)
  }
})
