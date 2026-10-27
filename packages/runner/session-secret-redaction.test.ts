import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const vault = 'vault-secret-Q7m2W9x4P6'
const provider = 'provider-secret-B8n3K5z1R7'
const plain = 'ordinary-command-output'
const marker = '@@SESSION-REPORT@@'

const driver = `
const cfg = JSON.parse(process.argv[2])
const { startRunner } = await import(cfg.runner)
const { createExecTools } = await import(cfg.exec)
const exec = await createExecTools({ workspace: cfg.workspace, home: cfg.home })
const seen = []
const runner = await startRunner({
  dshHome: cfg.state, cwd: cfg.workspace, baseUrl: cfg.baseUrl,
  apiKey: 'session-redaction-test-key', systemPrefix: 'Session redaction test.',
  toolNotes: { path: cfg.notes, secrets: () => [cfg.vault] },
  tools: [
    ...exec.tools.map(tool => ({ ...tool, execute: async (...args) => {
      if (tool.name === 'exec') seen.push(args[0])
      return tool.execute(...args)
    } })),
    { name: 'fixture_result', description: 'Return a fixture result.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'result=' + cfg.vault },
  ],
})
try {
  const login = await runner.connectProvider('zai', { prompt: async () => cfg.provider, notify: () => undefined })
  const result = await runner.promptTurn('Run the script.', { principal: 'owner' })
  try { await runner.promptTurn('Trigger an interrupted stream.', { principal: 'owner' }) } catch {}
  console.log('${marker}' + JSON.stringify({ login, result, seen }))
} finally {
  await runner.stop()
  await exec.stop()
}
`

function stream(index: number): string {
  const calls = [
    { name: 'exec', args: { command: `printf '%s' '${vault}' > vault-output.txt` } },
    { name: 'fixture_result', args: {} },
    { name: 'exec', args: { command: `printf '%s' '${provider}' > provider-output.txt` } },
    { name: 'exec', args: { command: `printf '%s' '${plain}' > plain-output.txt` } },
  ]
  const call = calls[index]
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const args = call ? JSON.stringify(call.args) : ''
  const split = index === 0 ? args.indexOf(vault) + Math.floor(vault.length / 2) : args.length
  return [
    sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: `call_${index}`, name: call.name, input: {} } : { type: 'text', text: '' } }),
    ...(call ? [args.slice(0, split), args.slice(split)].filter(Boolean).map(partial_json => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })) : [sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Script finished normally.' } })]),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesNamed(path, name) : entry.name === name ? [path] : []
  })
}

test('c1 c2 c3 c4 c5 session journal masks secrets without changing live tools', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-secret-redaction-'))
  const home = join(dir, 'home')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const index = requests++
    const response = stream(index === 5 ? 0 : index)
    res.end(index === 5 ? response.slice(0, response.indexOf('event: content_block_stop')) : response)
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, driver)
    const cfg = {
      runner: pathToFileURL(join(root, 'packages/runner/src/index.ts')).href,
      exec: pathToFileURL(join(root, 'packages/tools-exec/src/index.ts')).href,
      workspace, home, state: join(dir, 'state'), notes: join(dir, 'notes.json'), vault, provider,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`,
    }
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
    const report = JSON.parse(line!.slice(marker.length)) as { login: { status: string }; result: { text: string; aborted?: string }; seen: Array<{ command: string }> }
    expect(report.login.status).toBe('connected')
    expect(report.result.aborted).toBeUndefined()
    expect(report.result.text).toBe('Script finished normally.')
    expect(requests).toBeGreaterThanOrEqual(6)
    expect(report.seen.map(item => item.command)).toEqual([
      `printf '%s' '${vault}' > vault-output.txt`,
      `printf '%s' '${provider}' > provider-output.txt`,
      `printf '%s' '${plain}' > plain-output.txt`,
    ])
    expect(readFileSync(join(workspace, 'vault-output.txt'), 'utf8')).toBe(vault)
    expect(readFileSync(join(workspace, 'provider-output.txt'), 'utf8')).toBe(provider)
    expect(readFileSync(join(workspace, 'plain-output.txt'), 'utf8')).toBe(plain)
    const files = filesNamed(cfg.state, 'events.jsonl')
    expect(files).toHaveLength(1)
    const events = readFileSync(files[0]!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { type: string })
    const selected = (type: string): string => JSON.stringify(events.filter(event => event.type === type))
    const calls = selected('tool/call')
    const messages = selected('assistant/message')
    const attempts = selected('assistant/attempt')
    const results = selected('tool/result')
    expect(events.some(event => event.type === 'assistant/attempt')).toBe(true)
    expect(JSON.stringify(events)).not.toContain(vault)
    expect(JSON.stringify(events)).not.toContain(provider)
    for (const serialized of [calls, messages, attempts, results]) {
      expect(serialized).not.toContain(vault)
      expect(serialized).not.toContain(provider)
    }
    expect(calls).toContain('[redacted]')
    expect(messages).toContain('[redacted]')
    expect(attempts).toContain('[redacted]')
    expect(results).toContain('result=[redacted]')
    expect(messages).not.toContain(vault.slice(0, Math.floor(vault.length / 2)))
    expect(messages).not.toContain(vault.slice(Math.floor(vault.length / 2)))
    expect(attempts).not.toContain(vault.slice(0, Math.floor(vault.length / 2)))
    expect(attempts).not.toContain(vault.slice(Math.floor(vault.length / 2)))
    expect(calls).toContain(plain)
    expect(calls).toContain('plain-output.txt')
    expect(messages).toContain('Script finished normally.')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('c2 session journal masks secrets split across text and reasoning chunks', { timeout: 45_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-chunk-redaction-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const halves = [vault.slice(0, Math.floor(vault.length / 2)), vault.slice(Math.floor(vault.length / 2))]
  const response = [
    sse('message_start', { type: 'message_start', message: { id: 'msg_chunks', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ...halves.map(thinking => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ...halves.map(text => sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ].join('')
  const ending = [
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(response + (requests++ === 0 ? ending : ''))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const script = join(dir, 'driver.mjs')
    writeFileSync(script, `
const cfg = JSON.parse(process.argv[2])
const { startRunner } = await import(cfg.runner)
const runner = await startRunner({
  dshHome: cfg.state, cwd: cfg.workspace, baseUrl: cfg.baseUrl,
  apiKey: 'session-redaction-test-key', systemPrefix: 'Session redaction test.',
  toolNotes: { path: cfg.notes, secrets: () => [cfg.vault] },
})
try {
  await runner.promptTurn('Complete the response.', { principal: 'owner' })
  try { await runner.promptTurn('Interrupt the response.', { principal: 'owner' }) } catch {}
} finally { await runner.stop() }
`)
    const cfg = {
      runner: pathToFileURL(join(root, 'packages/runner/src/index.ts')).href,
      workspace, state: join(dir, 'state'), notes: join(dir, 'notes.json'), vault,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic`,
    }
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
    expect(requests).toBeGreaterThanOrEqual(2)
    const files = filesNamed(cfg.state, 'events.jsonl')
    expect(files).toHaveLength(1)
    const events = readFileSync(files[0]!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      type: string; data: { stream?: Array<{ type: string; texts?: string[] }> }
    })
    for (const eventType of ['assistant/message', 'assistant/attempt']) {
      const event = events.find(item => item.type === eventType)
      expect(event, eventType).toBeDefined()
      for (const chunkType of ['text-chunks', 'reasoning-chunks']) {
        const record = event!.data.stream?.find(item => item.type === chunkType)
        expect(record, `${eventType} ${chunkType}`).toBeDefined()
        const joined = record!.texts!.join('')
        expect.soft(joined, `${eventType} ${chunkType}`).not.toContain(vault)
        expect.soft(joined, `${eventType} ${chunkType}`).toContain('[redacted]')
      }
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
