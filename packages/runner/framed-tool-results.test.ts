import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

import type { ToolNote } from './src/tool-notes.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const REPORT = '@@FRAMED-RESULTS@@'
const MCP = 'mcp__fixture__report'
const DIAGNOSTIC = 'period must be at most 60 days'
const LATER_LINE = 'SECOND-DIAGNOSTIC-LINE'
type JsonObject = Record<string, unknown>

interface Call {
  name: string
  args: JsonObject
}

// Same isolated runner + scripted localhost model as tool-notes-learning.test.ts.
// The outputs here come from the real exec, MCP and filesystem tools, so a
// model-facing frame accidentally consumed by a service hook is observable.
const driver = `
const cfg = JSON.parse(process.argv[2])
const { startRunner, readToolNotes, LOOP_WARNING_TEXT } = await import(cfg.runner)
const { createFsTools } = await import(cfg.fs)
const { createMcpTools } = await import(cfg.mcp)
const mcp = createMcpTools({ home: cfg.home })
await mcp.ready()
let exec
let runner
const executions = []
try {
  const tools = [...createFsTools({ home: cfg.home }), ...mcp.tools().map(tool => ({ ...tool, lazy: false }))]
  if (cfg.useExec) {
    const { createExecTools } = await import(cfg.exec)
    exec = await createExecTools({ workspace: cfg.workspace, home: cfg.home })
    tools.push(...exec.tools)
  }
  runner = await startRunner({
    dshHome: cfg.state,
    cwd: cfg.workspace,
    baseUrl: cfg.baseUrl,
    apiKey: 'framed-results-test-key',
    systemPrefix: 'Tool result service consumer regression.',
    toolNotes: { path: cfg.notes },
    tools: tools.map(tool => ({
      ...tool,
      execute: async (...args) => {
        executions.push({ name: tool.name, args: args[0] })
        return tool.execute(...args)
      },
    })),
  })
  const result = await runner.promptTurn('Run the regression script.', { principal: 'owner' })
  console.log('${REPORT}' + JSON.stringify({ result, executions, notes: readToolNotes(cfg.notes), warning: LOOP_WARNING_TEXT }))
} finally {
  if (runner) await runner.stop()
  if (exec) await exec.stop()
  await mcp.stop()
}
`

// Minimal stdio MCP peer, like the peer in tool-notes-daemon.test.ts. A real
// isError response exercises tools-mcp's error conversion before the runner.
const mcpServer = `
import { createInterface } from 'node:readline'
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') {
    send(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } })
  } else if (method === 'tools/list') {
    send(id, { tools: [{ name: 'report', description: 'Report for a period.', inputSchema: { type: 'object', properties: { period: { type: 'number' } } } }] })
  } else if (method === 'tools/call') {
    const bad = params.arguments.period > 60
    send(id, { content: [{ type: 'text', text: bad ? '${DIAGNOSTIC}\\n${LATER_LINE}' : 'REPORT-OK' }], isError: bad })
  } else {
    send(id, {})
  }
})
`

function stream(call: Call | undefined, index: number): string {
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${index}`, type: 'message', role: 'assistant', model: 'deepseek-flash',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    sse('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: call === undefined
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: `call_${index}`, name: call.name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: call === undefined
        ? { type: 'text_delta', text: 'Regression finished.' }
        : { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  return typeof object(value).text === 'string' ? object(value).text as string : ''
}

function resultsOf(body: JsonObject): Array<{ text: string; isError: boolean }> {
  return (Array.isArray(body.messages) ? body.messages : []).flatMap((message) => {
    const content = object(message).content
    return (Array.isArray(content) ? content : [])
      .map(object)
      .filter(block => block.type === 'tool_result')
      .map(block => ({ text: textOf(block.content), isError: block.is_error === true }))
  })
}

function frameBody(text: string): string {
  const match = /<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>\n[^\n]*\n([\s\S]*?)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/u.exec(text)
  expect(match, `a complete data frame with matching boundaries:\n${text}`).not.toBeNull()
  return match![2]!
}

async function run(calls: Call[], useExec = false): Promise<{
  notes: ToolNote[]
  results: Array<{ text: string; isError: boolean }>
  warning: string
}> {
  const dir = mkdtempSync(join(tmpdir(), 'framed-tool-results-'))
  const home = join(dir, 'home')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'ok.txt'), 'FILE-BODY-ALPHA\nFILE-BODY-BETA\n')
  writeFileSync(join(home, 'peer.mjs'), mcpServer)
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [join(home, 'peer.mjs')] } },
  }))
  const requests: JsonObject[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const index = requests.length
    requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(stream(calls[index], index))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const notes = join(dir, 'tool-notes.json')
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, driver)
    const entry = (path: string): string => pathToFileURL(join(repoRoot, path)).href
    const cfg = {
      runner: entry('packages/runner/src/index.ts'), fs: entry('packages/tools-fs/src/index.ts'),
      mcp: entry('packages/tools-mcp/src/index.ts'), exec: entry('packages/tools-exec/src/index.ts'),
      home, workspace, state: join(dir, 'state'), notes, useExec,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`,
    }
    const execution = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', join(repoRoot, 'packages/app/register.mjs'), script, JSON.stringify(cfg),
      ], {
        cwd: repoRoot, env: { PATH: process.env.PATH ?? '', HOME: dir, USERPROFILE: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(execution.code, execution.output).toBe(0)
    const line = execution.output.split('\n').find(line => line.startsWith(REPORT))
    expect(line, execution.output).toBeDefined()
    const report = JSON.parse(line!.slice(REPORT.length)) as {
      result: { text: string; aborted?: string }
      executions: Call[]
      notes: ToolNote[]
      warning: string
    }
    expect(report.result.aborted, execution.output).toBeUndefined()
    expect(report.result.text).toBe('Regression finished.')
    expect(report.executions, 'the real tool paths executed every scripted call').toEqual(calls)
    expect(requests).toHaveLength(calls.length + 1)
    if (report.notes.length > 0) {
      expect(JSON.parse(readFileSync(notes, 'utf8')).notes).toEqual(report.notes)
    }
    return { notes: report.notes, warning: report.warning, results: resultsOf(requests.at(-1)!) }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

test.each([
  { label: 'stderr', bad: 'cat missing-framed.txt', good: 'cat ok.txt', status: 'exit 1', error: 'cat: missing-framed.txt: No such file or directory' },
  { label: 'stdout', bad: "printf 'stdout diagnostic\\nSECOND-DIAGNOSTIC-LINE\\n'; exit 7", good: "printf 'FILE-BODY-ALPHA\\n'", status: 'exit 7', error: 'stdout diagnostic' },
])('test_h1_exec_note_uses_the_diagnostic_inside_the_frame_and_keeps_status_outside: $label', { timeout: 45_000 }, async ({ bad, good, status, error }) => {
  const { notes, results } = await run([
    { name: 'exec', args: { command: bad } },
    { name: 'exec', args: { command: good } },
  ], true)
  expect(results).toHaveLength(2)
  expect(results[0]!.text.split('\n')[0]).toBe(status)
  expect(results[1]!.text.split('\n')[0]).toBe('exit 0')
  expect(frameBody(results[0]!.text)).toContain(error)
  expect(frameBody(results[1]!.text)).toContain('FILE-BODY-ALPHA')
  expect(notes).toHaveLength(1)
  expect(notes[0]!.error).toBe(error)
  expect(notes[0]!.change).toContain(bad)
  expect(notes[0]!.change).toContain(good)
})

test('test_h1_mcp_note_uses_only_the_first_data_line_after_a_real_isError_response', { timeout: 45_000 }, async () => {
  const { notes, results } = await run([
    { name: MCP, args: { period: 90 } },
    { name: MCP, args: { period: 30 } },
  ])
  expect(results).toHaveLength(2)
  expect(results[0]!.isError).toBe(true)
  expect(frameBody(results[0]!.text)).toContain(`${DIAGNOSTIC}\n${LATER_LINE}`)
  expect(frameBody(results[1]!.text)).toContain('REPORT-OK')
  expect(notes).toHaveLength(1)
  expect(notes[0]!.error.replace(/^Error:\s*/u, '')).toBe(DIAGNOSTIC)
  expect(notes[0]!.error).not.toContain(LATER_LINE)
  expect(notes[0]!.change).toBe('period: 90 → 30')
})

test('test_h1_third_identical_read_keeps_its_framed_data_and_a_visible_loop_warning', { timeout: 45_000 }, async () => {
  const call = { name: 'read', args: { path: 'ok.txt' } }
  const { results, warning } = await run([call, call, call])
  expect(results).toHaveLength(3)
  const bodies = results.map(result => frameBody(result.text))
  expect(bodies[0]).toContain('FILE-BODY-ALPHA')
  expect(bodies[1]).toBe(bodies[0])
  expect(bodies[2]).toBe(bodies[0])
  expect(results[0]!.text).not.toContain(warning)
  expect(results[1]!.text).not.toContain(warning)
  expect(results[2]!.text).toContain(warning)
  expect(bodies[2], 'the service warning is outside the external data').not.toContain(warning)
})
