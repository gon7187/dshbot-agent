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
const RESULT = '@@EXEC-ERROR-NOTES@@'

interface Call {
  command: string
  output: string
}

interface Report {
  results: Array<{ text: string; aborted?: string }>
  executions: Array<{ command: string }>
  snapshots: ToolNote[][]
}

// Same isolated runner + local scripted model seam as tool-notes-learning.test.ts.
// Only exec's returned text is a fixture: nonzero exits are ordinary string
// results, not thrown errors. Pairing, the owner post-execute hook and durable
// note writes all run through the real runner in both single and adjacent turns.
const driver = `
const cfg = JSON.parse(process.argv[2])
const { startRunner, readToolNotes } = await import(cfg.entry)
const calls = cfg.turns.flat()
const executions = []
const runner = await startRunner({
  dshHome: cfg.home,
  cwd: cfg.cwd,
  baseUrl: cfg.baseUrl,
  apiKey: 'exec-error-notes-test-key',
  systemPrefix: 'Exec error note regression test.',
  toolNotes: { path: cfg.file },
  tools: [{
    name: 'exec',
    description: 'Returns scripted foreground exec results.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    execute: async args => {
      const call = calls[executions.length]
      executions.push(args)
      if (!call || args.command !== call.command) throw new Error('Unexpected exec command')
      return call.output
    },
  }],
})
try {
  const results = []
  const snapshots = []
  for (let i = 0; i < cfg.turns.length; i += 1) {
    results.push(await runner.promptTurn('Run exec regression turn ' + i, { principal: 'owner' }))
    snapshots.push(readToolNotes(cfg.file))
  }
  console.log('${RESULT}' + JSON.stringify({ results, executions, snapshots }))
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
        : { type: 'tool_use', id: `tool_${index}`, name: 'exec', input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: call === undefined
        ? { type: 'text_delta', text: 'Exec regression finished.' }
        : { type: 'input_json_delta', partial_json: JSON.stringify({ command: call.command }) },
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

async function learn(turns: Call[][]): Promise<Report> {
  const dir = mkdtempSync(join(tmpdir(), 'exec-error-notes-'))
  const responses = turns.flatMap((calls) => [...calls, undefined])
  let modelCalls = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request before answering */ }
    const index = modelCalls++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(stream(responses[index], index))
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const file = join(dir, 'tool-notes.json')
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, driver)
    const config = {
      entry: pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href,
      home: join(dir, 'state'), cwd: dir, file, turns,
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
    const report = JSON.parse(line!.slice(RESULT.length)) as Report
    expect(report.results).toHaveLength(turns.length)
    for (const result of report.results) {
      expect(result.aborted, run.output).toBeUndefined()
      expect(result.text, run.output).toBe('Exec regression finished.')
    }
    expect(report.executions).toEqual(turns.flat().map(({ command }) => ({ command })))
    expect(modelCalls).toBe(responses.length)
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { notes: ToolNote[] }
    expect(stored.notes, 'the final snapshot is persisted, not only held in memory').toEqual(report.snapshots.at(-1))
    return report
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}

const CAT_ERROR = "cat: missing.txt: No such file or directory"

test.each([
  { label: 'stderr only', output: `exit 1\n--- stderr ---\n${CAT_ERROR}\nSECOND-ERROR-LINE` },
  { label: 'stdout before stderr', output: `exit 1\nprogress output\n--- stderr ---\n\n${CAT_ERROR}\nSECOND-ERROR-LINE` },
  { label: 'both labeled streams', output: `exit 1\r\n--- stdout ---\r\nprogress output\r\n--- stderr ---\r\n \r\n${CAT_ERROR}\r\nSECOND-ERROR-LINE` },
])('test_h1_exec_keeps_the_first_stderr_line_instead_of_exit_status: $label', { timeout: 30_000 }, async ({ output }) => {
  const { snapshots } = await learn([[
    { command: 'cat missing.txt', output },
    { command: 'cat ok.txt', output: 'exit 0\nfile contents' },
  ]])
  const notes = snapshots[0]!
  expect(notes).toHaveLength(1)
  expect(notes[0]?.tool).toBe('exec')
  expect(notes[0]?.change).toContain('cat missing.txt')
  expect(notes[0]?.change).toContain('cat ok.txt')
  expect(notes[0]?.error, 'keep the actual diagnostic, excluding status, headers, stdout and later lines').toBe(CAT_ERROR)
  expect(notes[0]?.error).not.toContain('exit 1')
})

test.each(['same turn', 'adjacent turns'] as const)(
  'test_h1_exec_pairs_with_distinct_errors_and_the_same_exit_code_keep_both_notes: %s',
  { timeout: 30_000 },
  async (placement) => {
    const first: Call[] = [
      { command: 'cat missing.txt', output: `exit 1\n--- stderr ---\n${CAT_ERROR}` },
      { command: 'cat ok.txt', output: 'exit 0\nfirst file' },
    ]
    // Two cat failures have the same real exit code but distinct diagnostics.
    // Using ls's usual exit 2 here would miss replacement keyed by `exit N`.
    const otherError = "cat: missing-other.txt: No such file or directory"
    const second: Call[] = [
      { command: 'cat missing-other.txt', output: `exit 1\n--- stderr ---\n${otherError}` },
      { command: 'cat ok-other.txt', output: 'exit 0\nsecond file' },
    ]
    const { snapshots } = await learn(placement === 'same turn' ? [[...first, ...second]] : [first, second])
    if (placement === 'adjacent turns') expect(snapshots[0]).toHaveLength(1)
    const notes = snapshots.at(-1)!
    expect(notes, 'different diagnostics must not replace each other merely because both are exit 1').toHaveLength(2)
    for (const [error, failed, passed] of [
      [CAT_ERROR, 'cat missing.txt', 'cat ok.txt'],
      [otherError, 'cat missing-other.txt', 'cat ok-other.txt'],
    ]) {
      const note = notes.find((item) => item.error === error)
      expect(note, `the durable note for ${error} remains present`).toBeDefined()
      expect(note?.tool).toBe('exec')
      expect(note?.change).toContain(failed)
      expect(note?.change).toContain(passed)
    }
  },
)

test.each([
  { label: 'plain stdout', output: 'exit 1\n\nstdout diagnostic\nSECOND-ERROR-LINE', error: 'stdout diagnostic' },
  { label: 'labeled stdout', output: 'exit 1\n--- stdout ---\n\nstdout diagnostic\nSECOND-ERROR-LINE', error: 'stdout diagnostic' },
  { label: 'no output', output: 'exit 1\n', error: 'exit 1' },
])('test_h1_exec_uses_stdout_when_stderr_is_absent_and_status_only_without_output: $label', { timeout: 30_000 }, async ({ output, error }) => {
  const { snapshots } = await learn([[
    { command: 'cat missing.txt', output },
    { command: 'cat ok.txt', output: 'exit 0\nOK' },
  ]])
  expect(snapshots[0]).toHaveLength(1)
  expect(snapshots[0]?.[0]?.error).toBe(error)
})
