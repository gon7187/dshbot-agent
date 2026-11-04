import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

let workspace = ''
let runtime: ExecTools | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

async function tool(name: string, args: Record<string, unknown>, signal = new AbortController().signal): Promise<string> {
  const entry = runtime!.tools.find((candidate) => candidate.name === name)!
  return String(await entry.execute(args, { signal }))
}

function spillFiles(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-subprocess-')).flatMap((name) => {
    try { return readdirSync(join(tmpdir(), name)).filter((file) => file.startsWith(`dsh-subprocess-${process.pid}-`)).map((file) => join(tmpdir(), name, file)) }
    catch { return [] }
  })
}

test('background stdin, status pages and abort waiting preserve the running job', { timeout: 30_000 }, async () => {
  workspace = mkdtempSync(join(tmpdir(), 'exec-background-core-'))
  runtime = await createExecTools({ workspace, home: homedir() })
  const started = await tool('exec', { command: 'cat', background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(started)?.[1]
  expect(id).toBeDefined()
  await tool('exec_write', { id, text: 'first-line' })
  await vi.waitFor(async () => expect(await tool('exec_status', { id, offset: 0, limit: 5 })).toContain('first'))
  const page = await tool('exec_status', { id, offset: 5, limit: 100 })
  expect(page).toContain('-line')
  const abort = new AbortController()
  const waiting = tool('exec_status', { id, wait_sec: 30 }, abort.signal)
  abort.abort()
  await waiting
  expect(await tool('exec_status', { id })).toMatch(/Статус:\s*running/)
  await tool('exec_stop', { id })
  await vi.waitFor(async () => expect(await tool('exec_status', { id })).toMatch(/Статус:\s*killed/))
  await expect(tool('exec_write', { id, text: 'after-stop' })).rejects.toThrow()
})

test('a masked secret cannot satisfy a background wait pattern', { timeout: 30_000 }, async () => {
  workspace = mkdtempSync(join(tmpdir(), 'exec-pattern-core-'))
  const secret = 'PRIVATE-BACKGROUND-SECRET'
  let current = secret
  runtime = await createExecTools({ workspace, home: homedir(), secrets: { get: () => current, names: () => ['KEY'], known: () => [{ name: 'KEY', value: current }] } })
  const started = await tool('exec', { command: 'printf "%s" "$KEY"; sleep 1; printf "%s finished" "$KEY"', secrets: ['KEY'], background: true })
  current = 'ROTATED-SECRET-VALUE'
  const id = /"id"\s*:\s*"([^"]+)"/.exec(started)?.[1]
  const status = await tool('exec_status', { id, wait_sec: 10, pattern: secret })
  expect(status).not.toContain(secret)
  expect(status).toMatch(/Статус:\s*completed/)
  expect(status).toContain('finished')
})

test('foreground abort settles the real child and removes its spill without late side effects', { timeout: 30_000 }, async () => {
  workspace = mkdtempSync(join(tmpdir(), 'exec-spill-core-'))
  runtime = await createExecTools({ workspace, home: homedir() })
  const before = spillFiles()
  const abort = new AbortController()
  const ready = join(workspace, 'child-ready')
  const late = join(workspace, 'late-effect')
  const pending = tool('exec', { command: 'seq 1 30000; echo ready > child-ready; sleep 30; echo LATE > late-effect', timeout_sec: 3 }, abort.signal)
  await vi.waitFor(() => {
    expect(existsSync(ready)).toBe(true)
    expect(spillFiles().some((path) => !before.includes(path))).toBe(true)
  }, { timeout: 10_000 })
  abort.abort()
  const output = await pending
  const status = output.split('\n')[0]
  expect(status).toMatch(/^Команда прервана/)
  expect(status).not.toMatch(/^Таймаут/)
  expect(output).toContain('30000')
  expect(existsSync(late)).toBe(false)
  expect(spillFiles().filter((path) => !before.includes(path) && existsSync(path))).toEqual([])
})
