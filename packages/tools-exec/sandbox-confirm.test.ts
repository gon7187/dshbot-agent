import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import { outgoingStrings } from '../app/src/index.js'
import { createHostExecTools } from './src/host.js'
import { createExecTools, type ExecTools } from './src/index.js'

let workspace = ''
let runtime: ExecTools | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

test('exec and live stdin enforce deny/approval before side effects, and allow approved input', { timeout: 30_000 }, async () => {
  workspace = mkdtempSync(join(tmpdir(), 'exec-approval-core-'))
  const victim = join(workspace, 'keep.txt')
  writeFileSync(victim, 'keep')
  let decision: 'allow' | 'deny' = 'deny'
  const approval = vi.fn(async () => decision)
  runtime = await createExecTools({ workspace, home: homedir(), approval })
  const call = async (name: string, args: Record<string, unknown>) => String(await runtime!.tools.find((tool) => tool.name === name)!.execute(args, { signal: new AbortController().signal }))
  expect(await call('exec', { command: 'node -e "console.log(7)"' })).toContain('7')
  expect(approval).not.toHaveBeenCalled()
  await expect(call('exec', { command: 'gh repo create fixture --public; touch denied-marker' })).rejects.toThrow()
  expect(approval).not.toHaveBeenCalled()
  expect(existsSync(join(workspace, 'denied-marker'))).toBe(false)
  await expect(call('exec', { command: 'bash -c "rm -rf keep.txt"' })).rejects.toThrow()
  expect(approval).toHaveBeenCalledOnce()
  expect(existsSync(victim)).toBe(true)
  const started = await call('exec', { command: 'cat', background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(started)?.[1]
  expect(id).toBeDefined()
  approval.mockClear()
  await expect(call('exec_write', { id, text: 'gh repo create fixture --public' })).rejects.toThrow()
  expect(approval).not.toHaveBeenCalled()
  await expect(call('exec_write', { id, text: 'rm -rf keep.txt' })).rejects.toThrow()
  expect(approval).toHaveBeenCalledOnce()
  const refused = await call('exec_status', { id })
  expect(refused).not.toContain('gh repo create')
  expect(refused).not.toContain('rm -rf keep.txt')
  await call('exec_write', { id, text: 'SAFE-STDIN-LINE' })
  await vi.waitFor(async () => expect(await call('exec_status', { id })).toContain('SAFE-STDIN-LINE'))
  expect(approval).toHaveBeenCalledOnce()
  const unapproved = await createExecTools({ workspace, home: homedir() })
  try {
    await expect(unapproved.tools.find((tool) => tool.name === 'exec')!.execute({ command: 'rm -rf keep.txt' }, { signal: new AbortController().signal })).rejects.toThrow()
    expect(existsSync(victim)).toBe(true)
  } finally { await unapproved.stop() }
  decision = 'allow'
  await call('exec_write', { id, text: 'rm -rf keep.txt' })
  await vi.waitFor(async () => expect(await call('exec_status', { id })).toContain('rm -rf keep.txt'))
  expect(existsSync(victim), 'the approved line reached cat, not a host shell').toBe(true)
  decision = 'deny'
  writeFileSync(join(workspace, 'hosts.json'), JSON.stringify({ box: { local: true } }))
  const host = createHostExecTools({ home: workspace, approval })
  await expect(host.tools[0]!.execute({ host: 'box', command: 'python3 -c "print(1)"' }, { signal: new AbortController().signal })).rejects.toThrow()
})

test('extra exec arguments cannot hide outgoing secret-bearing stdin or nested values', () => {
  const fragment = 'PRIVATE-MEMORY-FRAGMENT'
  expect(outgoingStrings('exec_write', { id: 'job', command: 'echo public', text: fragment })).toContain(fragment)
  expect(outgoingStrings('exec', { extra: [{ [fragment]: fragment }] })?.filter((value) => value === fragment)).toHaveLength(2)
})
