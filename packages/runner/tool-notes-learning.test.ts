import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

import type { ToolNote } from './src/tool-notes.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const RESULT = '@@TOOL-NOTES@@'
const MCP = 'mcp__fixture__report'

interface Call {
  name: string
  args: Record<string, unknown>
  output: string
  isError?: boolean
}

// Run the actual post-execute hook in an isolated runner, with a scripted local
// model and deterministic tool results. No daemon, database or external API.
const driver = `
const cfg = JSON.parse(process.argv[2])
const { startRunner, readToolNotes } = await import(cfg.entry)
const executions = []
const runner = await startRunner({
  dshHome: cfg.home,
  cwd: cfg.cwd,
  baseUrl: cfg.baseUrl,
  apiKey: 'tool-notes-regression-key',
  systemPrefix: 'Tool note regression test.',
  toolNotes: { path: cfg.file, secrets: () => cfg.secrets },
  tools: [...new Set(cfg.calls.map(call => call.name))].map(name => ({
    name,
    description: 'Deterministic fixture tool.',
    inputSchema: { type: 'object', additionalProperties: true },
    execute: async args => {
      const call = cfg.calls[executions.length]
      executions.push({ name, args })
      if (!call || call.name !== name) throw new Error('Unexpected tool execution')
      if (call.isError) throw new Error(call.output)
      return call.output
    },
  })),
})
try {
  const result = await runner.promptTurn('Run the regression script.', { principal: 'owner' })
  console.log('${RESULT}' + JSON.stringify({ result, executions, notes: readToolNotes(cfg.file) }))
} finally {
  await runner.stop()
}
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
        : { type: 'tool_use', id: `tool_${index}`, name: call.name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: call === undefined
        ? { type: 'text_delta', text: 'Regression script finished.' }
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

async function learn(calls: Call[], secrets: string[] = []): Promise<{ notes: ToolNote[]; stored: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'tool-notes-learning-'))
  let modelCalls = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request before answering */ }
    const index = modelCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(stream(calls[index], index))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const file = join(dir, 'tool-notes.json')
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, driver)
    const config = {
      entry: pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href,
      home: join(dir, 'state'), cwd: dir, file, calls, secrets,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`,
    }
    const run = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', join(repoRoot, 'packages/app/register.mjs'), script, JSON.stringify(config),
      ], {
        cwd: repoRoot,
        env: { PATH: process.env.PATH ?? '', HOME: dir, USERPROFILE: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(run.code, run.output).toBe(0)
    const line = run.output.split('\n').find((line) => line.startsWith(RESULT))
    expect(line, run.output).toBeDefined()
    const report = JSON.parse(line!.slice(RESULT.length)) as {
      result: { text: string; aborted?: string }
      executions: Array<{ name: string; args: Record<string, unknown> }>
      notes: ToolNote[]
    }
    expect(report.result.aborted, run.output).toBeUndefined()
    expect(report.result.text, run.output).toBe('Regression script finished.')
    expect(report.executions).toEqual(calls.map(({ name, args }) => ({ name, args })))
    expect(modelCalls).toBe(calls.length + 1)
    return { notes: report.notes, stored: report.notes.length === 0 ? '' : readFileSync(file, 'utf8') }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

function trial(kind: 'MCP' | 'exec', mode: string, failed = false, error = 'temporary repeated error'): Call {
  return kind === 'exec'
    ? { name: 'exec', args: { command: `python script.py --mode=${mode}` }, output: failed ? `exit 1\n${error}` : 'exit 0' }
    : { name: MCP, args: { mode }, output: failed ? error : 'ok', isError: failed }
}

test.each(['MCP', 'exec'] as const)('transient retries: %s clears every duplicate and still learns a later fix', { timeout: 30_000 }, async (kind) => {
  const laterFailure = trial(kind, 'C', true, 'later argument error')
  if (kind === 'exec') laterFailure.output = 'exit 2\nlater argument error'
  const { notes } = await learn([
    trial(kind, 'A', true), trial(kind, 'A', true), trial(kind, 'A'), trial(kind, 'B'),
    laterFailure, trial(kind, 'D'),
  ])
  // The later real fix is a positive control for this negative regression.
  expect(notes).toHaveLength(1)
  // An exec note keeps the first output line, not the `exit N` status (h1).
  expect(notes[0]?.error).toBe(kind === 'exec' ? 'later argument error' : 'Error: later argument error')
  expect(notes[0]?.change).toContain(kind === 'exec' ? '--mode=C' : 'C → D')
})

test.each(['MCP', 'exec'] as const)('transient retries: %s finds an identical retry behind another pending failure', { timeout: 30_000 }, async (kind) => {
  const { notes } = await learn([
    trial(kind, 'A', true, 'first temporary error'), trial(kind, 'B', true, 'second temporary error'),
    trial(kind, 'A'), trial(kind, 'B'), trial(kind, 'C'),
  ])
  expect(notes).toEqual([])
})

test('nested secrets: quoted vault values are masked in objects, arrays and JSON error text', { timeout: 30_000 }, async () => {
  const secret = 'vault-"quoted\\value\nsecond-line'
  const options = { token: secret, attempts: [{ token: secret, mode: 'bad' }], [secret]: 'old' }
  const { notes, stored } = await learn([
    { name: MCP, args: { options }, output: `rejected ${JSON.stringify(options)}\nDETAIL`, isError: true },
    { name: MCP, args: { options: { token: 'working', attempts: [{ token: 'working', mode: 'good' }], [secret]: 'new' } }, output: 'ok' },
  ], [secret])
  expect(notes).toHaveLength(1)
  const note = notes[0]!
  expect(note.change).toContain('"token":"[redacted]"')
  expect(note.change).toContain('"token":"working"')
  expect(note.change).toContain('"mode":"bad"')
  expect(note.error).toContain('[redacted]')
  expect(note.error).not.toContain('DETAIL')
  for (const text of [note.change, note.error, stored]) {
    expect(text).not.toContain(secret)
    expect(text).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(text).not.toContain('vault-')
  }
})

test('built-in tools: browser input and skill documents of another action leave no note', { timeout: 30_000 }, async () => {
  // Only MCP tools and exec are observed: a built-in tool that passes with other
  // arguments did another action, and its arguments may be the history-masked
  // input of the browser or a whole skill document.
  const text = 'private-"typed-value'
  const value = 'private-"nested-value'
  const document = '---\nname: shipped\ndescription: overwritten-probe\n---\n'
  const { notes, stored } = await learn([
    {
      name: 'browser', args: { action: 'fill', text, options: { value, selector: '#old' } },
      output: `rejected ${JSON.stringify({ text, options: { value } })}`, isError: true,
    },
    { name: 'browser', args: { action: 'fill', text: 'other-private-input', options: { value: 'other-private-value', selector: '#new' } }, output: 'ok' },
    { name: 'skill_manage', args: { action: 'create', name: 'shipped', content: document }, output: 'shipped skill', isError: true },
    { name: 'skill_manage', args: { action: 'create', name: 'valid', content: document.replace('shipped', 'valid') }, output: 'ok' },
    // Positive control: an MCP pair of the same turn is still learned.
    trial('MCP', 'A', true, 'mode A is not supported'), trial('MCP', 'B'),
  ])
  expect(notes).toHaveLength(1)
  expect(notes[0]?.tool).toBe(MCP)
  expect(notes[0]?.change).toBe('mode: A → B')
  expect(stored).not.toContain('private-')
  expect(stored).not.toContain('overwritten-probe')
  expect(stored).not.toContain('browser')
  expect(stored).not.toContain('skill_manage')
})

test('long values: a note keeps cut values and a long pair does not push the other notes out', { timeout: 30_000 }, async () => {
  const long = 'x'.repeat(5_000)
  const command = `python script.py --data=${'y'.repeat(5_000)}`
  const { notes } = await learn([
    trial('MCP', 'A', true, 'mode A is not supported'), trial('MCP', 'B'),
    { name: MCP, args: { mode: `${long}-old` }, output: 'too long', isError: true },
    { name: MCP, args: { mode: `${long}-new` }, output: 'ok' },
    { name: 'exec', args: { command: `${command} --bad` }, output: 'exit 1\nbad flag' },
    { name: 'exec', args: { command: `${command} --good` }, output: 'exit 0' },
  ])
  expect(notes).toHaveLength(3)
  expect(notes[0]?.change).toBe('mode: A → B')
  for (const note of notes) {
    expect([...note.change].length).toBeLessThanOrEqual(1_000)
    expect(note.change).not.toContain('x'.repeat(201))
    expect(note.change).not.toContain('y'.repeat(201))
  }
  expect(notes[1]?.change).toMatch(/^mode: x+… → x+…$/u)
  expect(notes[2]?.change).toMatch(/^было: python script\.py --data=y+…, сработало: python script\.py --data=y+…$/u)
  expect(notes[2]?.error).toBe('bad flag')
})

test('nested secrets: exec program metadata is masked before program normalization', { timeout: 30_000 }, async () => {
  const secret = 'private-program99'
  const { notes, stored } = await learn([
    { name: 'exec', args: { command: `${secret} --bad` }, output: 'exit 1' },
    { name: 'exec', args: { command: `${secret} --good` }, output: 'exit 0' },
  ], [secret])
  expect(notes).toHaveLength(1)
  expect(notes[0]?.subject).toBe('[redacted]')
  expect(notes[0]?.change).toContain('[redacted] --bad')
  expect(notes[0]?.change).toContain('[redacted] --good')
  expect(stored).not.toContain('private-program')
})
