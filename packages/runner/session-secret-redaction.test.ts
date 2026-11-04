import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const values = ['type-secret-Q7m2W9x4P6', 'fill-secret-B8n3K5z1R7', 'Shift+X', 'select-secret-C9v5T2k8A1']
const calls = [
  { action: 'type', ref: 'field', text: values[0] },
  { action: 'fill', ref: 'field', text: values[1] },
  { action: 'press', key: values[2] },
  { action: 'select', ref: 'field', value: values[3] },
]
const marker = '@@SESSION-REPORT@@'
const driver = `
const cfg = JSON.parse(process.argv[2])
const { startRunner } = await import(cfg.runner)
const seen = []
const runner = await startRunner({
  dshHome: cfg.state, cwd: cfg.workspace, baseUrl: cfg.baseUrl,
  apiKey: 'session-redaction-test-key', systemPrefix: 'Synthetic persistence boundary.',
  tools: [{ name: 'browser', description: 'Synthetic external boundary.',
    inputSchema: { type: 'object', properties: { action: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } } },
    execute: async input => { seen.push(input); return 'ok' },
  }],
})
try {
  await runner.promptTurn('Use the fixture.', { principal: 'owner' })
  try { await runner.promptTurn('Interrupt the fixture.', { principal: 'owner' }) } catch {}
  console.log('${marker}' + JSON.stringify({ seen }))
} finally { await runner.stop() }
`
function stream(index: number): string {
  const input = calls[index]
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const args = input ? JSON.stringify(input) : ''
  const secret = values[index] ?? ''
  const split = input ? args.indexOf(secret) + Math.floor(secret.length / 2) : 0
  return [
    sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: input ? { type: 'tool_use', id: `call_${index}`, name: 'browser', input: {} } : { type: 'text', text: '' } }),
    ...(input ? [args.slice(0, split), args.slice(split)].filter(Boolean).map(partial_json => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })) : [sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })]),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: input ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesNamed(path, name) : entry.name === name ? [path] : []
  })
}

test('R-SECRET-PERSISTENCE keeps live browser inputs intact and masks every durable argument copy', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-secret-redaction-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain fake provider request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const index = requests++
    const response = stream(index === 5 ? 0 : index)
    res.end(index === 5 ? response.slice(0, response.indexOf('event: content_block_stop')) : response)
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, driver)
    const cfg = { runner: pathToFileURL(join(root, 'packages/runner/src/index.ts')).href,
      workspace, state: join(dir, 'state'), baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic` }
    const child = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--import', join(root, 'packages/app/register.mjs'), script, JSON.stringify(cfg)], {
        cwd: root, env: { PATH: process.env.PATH ?? '', HOME: dir, USERPROFILE: dir }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timer = setTimeout(() => processChild.kill('SIGKILL'), 30_000)
      processChild.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      processChild.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
      processChild.on('error', error => { clearTimeout(timer); reject(error) })
      processChild.on('close', code => { clearTimeout(timer); resolve({ code, output }) })
    })
    expect(child.code, child.output).toBe(0)
    const line = child.output.split('\n').find(value => value.startsWith(marker))
    expect(line, child.output).toBeDefined()
    expect(JSON.parse(line!.slice(marker.length)).seen).toEqual(calls)
    const files = filesNamed(cfg.state, 'events.jsonl')
    expect(files).toHaveLength(1)
    const durable = readFileSync(files[0]!, 'utf8')
    const events = durable.trim().split('\n').map(line => JSON.parse(line) as { type: string })
    for (const type of ['tool/call', 'assistant/message', 'assistant/attempt']) {
      const subset = JSON.stringify(events.filter(event => event.type === type))
      expect(events.some(event => event.type === type), type).toBe(true)
      if (type !== 'assistant/attempt') expect(subset, type).toContain('[redacted]')
      for (const value of values) expect(subset, type).not.toContain(value)
    }
    for (const value of values) expect(durable).not.toContain(value)
    // Input deltas are split in the middle; neither half may survive in a stream snapshot.
    for (const value of [values[0]!, values[1]!, values[3]!]) {
      expect(durable).not.toContain(value.slice(0, Math.floor(value.length / 2)))
      expect(durable).not.toContain(value.slice(Math.floor(value.length / 2)))
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
