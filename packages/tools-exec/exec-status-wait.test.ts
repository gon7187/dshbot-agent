// exec_status with wait_sec (and pattern): the call waits for a background job instead of the model sleeping in
// exec. The tests drive createExecTools against the real sandbox (same wiring as exec-status-chars.test.ts) and
// measure the time of each call. The wording of the answers is not fixed beyond the existing status line
// («Статус: <status> (exit code: N)») and the output frame, so the checks are on times, status words and the
// presence of the output. Long-running jobs are stopped in afterAll by exec.stop().
//   c12: the schema of exec_status declares wait_sec and pattern; the prose of the descriptions is left to review.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const SECRET_NAME = 'WAIT_SECRET_TOKEN'
const SECRET_VALUE = 'wsk9Qz7LmTn4VbX2'

let workspace = ''
let exec: ExecTools

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-wait-'))
  exec = await createExecTools({
    workspace,
    home: HOME,
    secrets: {
      get: (name) => (name === SECRET_NAME ? SECRET_VALUE : undefined),
      names: () => [SECRET_NAME],
      known: () => [{ name: SECRET_NAME, value: SECRET_VALUE }],
    },
  })
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

type Args = Record<string, unknown>

interface Context {
  signal: AbortSignal
  extendTimeout?: (extraMs: number) => boolean
}

async function callTool(name: string, args: Args, context?: Partial<Context>): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal, ...context }))
}

/** The call with its duration; a thrown error is returned as the message the model reads. */
async function timed(
  name: string,
  args: Args,
  context?: Partial<Context>,
): Promise<{ text: string; threw: boolean; ms: number }> {
  const from = Date.now()
  try {
    const text = await callTool(name, args, context)
    return { text, threw: false, ms: Date.now() - from }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true, ms: Date.now() - from }
  }
}

async function startJob(command: string, extra: Args = {}): Promise<string> {
  const answer = await callTool('exec', { command, background: true, ...extra })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1]
  expect(id, `a background start names the job id: ${answer}`).toBeDefined()
  return id as string
}

async function waitFinished(id: string): Promise<string> {
  const from = Date.now()
  let last = ''
  while (Date.now() - from < 60_000) {
    last = await callTool('exec_status', { id })
    if (/Статус:\s*(completed|failed|killed)/.test(last)) return last
    await sleep(150)
  }
  throw new Error(`the job ${id} did not finish: ${last.slice(0, 300)}`)
}

test('c12 exec_status declares wait_sec and pattern in its input schema', () => {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec_status')
  const properties = ((tool?.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {}
  expect(Object.keys(properties)).toEqual(expect.arrayContaining(['wait_sec', 'pattern']))
})

test('c1 c5 c6 c2 wait_sec ends with the job, returns at once for a finished job or without wait_sec, and times out for a running one', { timeout: 120_000 }, async () => {
  // c1: the job ends in about a second; the answer of wait_sec=30 comes soon after and equals the plain answer.
  const quick = await startJob('echo quick-output-line; sleep 1')
  const waited = await timed('exec_status', { id: quick, wait_sec: 30 })
  expect(waited.threw, waited.text).toBe(false)
  expect(waited.ms, 'the answer comes right after the job ends, not after wait_sec').toBeLessThan(10_000)
  expect(waited.text).toMatch(/Статус:\s*completed/)
  expect(waited.text).toMatch(/exit code: 0/)
  expect(waited.text).toContain('quick-output-line')
  const plain = await callTool('exec_status', { id: quick })
  expect(waited.text, 'the same text as exec_status without wait_sec').toBe(plain)

  // c5: a finished job answers at once at any wait_sec.
  const again = await timed('exec_status', { id: quick, wait_sec: 60 })
  expect(again.threw, again.text).toBe(false)
  expect(again.ms, 'a finished job needs no waiting').toBeLessThan(1500)
  expect(again.text).toBe(plain)

  // c6: without wait_sec a running job answers at once.
  const slow = await startJob('echo early-output-line; sleep 120')
  const immediate = await timed('exec_status', { id: slow })
  expect(immediate.threw, immediate.text).toBe(false)
  expect(immediate.ms, 'no wait_sec, no waiting').toBeLessThan(1500)
  expect(immediate.text).toMatch(/Статус:\s*running/)

  // c2: the job outlives the wait; the answer comes after about wait_sec and shows it running with its output.
  const timedOut = await timed('exec_status', { id: slow, wait_sec: 2 })
  expect(timedOut.threw, timedOut.text).toBe(false)
  expect(timedOut.ms, 'waits for wait_sec when the job keeps running').toBeGreaterThanOrEqual(1800)
  expect(timedOut.ms).toBeLessThan(6000)
  expect(timedOut.text).toMatch(/Статус:\s*running/)
  expect(timedOut.text).toContain('early-output-line')
  await callTool('exec_stop', { id: slow })
})

test('c3 c4 c11 pattern ends the wait on a new matching line only, and the wait extends the turn timeout', { timeout: 120_000 }, async () => {
  // c3: READY appears in about a second; the answer comes soon after, the job keeps running.
  const id = await startJob('sleep 1; echo READY; sleep 120')
  const extended: number[] = []
  const ready = await timed(
    'exec_status',
    { id, wait_sec: 30, pattern: 'READY' },
    { extendTimeout: (extraMs: number) => (extended.push(extraMs), true) },
  )
  expect(ready.threw, ready.text).toBe(false)
  expect(ready.ms, 'the line ends the wait long before wait_sec').toBeLessThan(10_000)
  expect(ready.text).toContain('READY')
  expect(ready.text).toMatch(/Статус:\s*running/)

  // c11: the wait pushes the turn deadline by at least the time it may take.
  expect(extended.length, 'extendTimeout is called for the wait').toBeGreaterThan(0)
  expect(extended.reduce((sum, extra) => sum + extra, 0), 'the extension covers wait_sec').toBeGreaterThanOrEqual(30_000)

  // c4: READY was printed before this call and nothing new matches: the old line does not end the wait.
  const old = await timed('exec_status', { id, wait_sec: 2, pattern: 'READY' })
  expect(old.threw, old.text).toBe(false)
  expect(old.ms, 'an old match does not end the wait').toBeGreaterThanOrEqual(1800)
  expect(old.ms).toBeLessThan(6000)
  expect(old.text).toMatch(/Статус:\s*running/)
  await callTool('exec_stop', { id })
})

test('c7 c8 a wrong wait_sec or pattern is a tool error without waiting', { timeout: 60_000 }, async () => {
  const id = await startJob('sleep 120')
  const wrong: Args[] = [
    { id, wait_sec: 0 },
    { id, wait_sec: 601 },
    { id, wait_sec: 'abc' },
    { id, wait_sec: 5, pattern: '(' },
    { id, wait_sec: 5, pattern: 'a'.repeat(513) },
    { id, pattern: 'READY' },
  ]
  for (const args of wrong) {
    const result = await timed('exec_status', args)
    const label = JSON.stringify(args).slice(0, 80)
    expect(result.threw, `${label} is a tool error`).toBe(true)
    expect(result.text.trim(), `${label} has a message`).not.toBe('')
    expect(result.ms, `${label} fails without waiting`).toBeLessThan(1500)
  }
  await callTool('exec_stop', { id })
})

test('c9 the abort signal ends the wait within a second and leaves the job running', { timeout: 60_000 }, async () => {
  const id = await startJob('sleep 120')
  const controller = new AbortController()
  const pending = timed('exec_status', { id, wait_sec: 60 }, { signal: controller.signal })
  await sleep(500) // let the wait begin; the abort must come while the call is waiting
  const abortedAt = Date.now()
  controller.abort()
  const result = await pending
  expect(Date.now() - abortedAt, 'the call ends within a second of the abort').toBeLessThan(1000)
  expect(result.ms, 'the call did not run to wait_sec').toBeLessThan(10_000)

  const after = await callTool('exec_status', { id })
  expect(after, 'the job is not killed by the abort').toMatch(/Статус:\s*running/)
  await callTool('exec_stop', { id })
})

test('c10 pattern is matched against the masked output: a secret value never matches and never shows', { timeout: 60_000 }, async () => {
  const id = await startJob(`sleep 1; echo "$${SECRET_NAME}"; sleep 120`, { secrets: [SECRET_NAME] })
  const result = await timed('exec_status', { id, wait_sec: 3, pattern: SECRET_VALUE })
  expect(result.threw, result.text).toBe(false)
  expect(result.ms, 'the masked output does not match, so the wait runs to wait_sec').toBeGreaterThanOrEqual(2500)
  expect(result.ms).toBeLessThan(8000)
  expect(result.text, 'the value of the secret is not in the answer').not.toContain(SECRET_VALUE)
  expect(result.text).toMatch(/Статус:\s*running/)
  await callTool('exec_stop', { id })
  expect(await waitFinished(id)).not.toContain(SECRET_VALUE)
})
