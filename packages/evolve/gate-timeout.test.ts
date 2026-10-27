// Follow evolve-gate-responsiveness.test.ts: use the real sandboxedTests and a
// bwrap process double, without executing npm or requiring host namespaces.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as realDelay } from 'node:timers/promises'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { sandboxedTests, type SandboxResult } from './src/index.js'

const TIMEOUT_ENV = 'DSHBOT_EVOLVE_GATE_TIMEOUT_MS'
const DEFAULT_TIMEOUT_MS = 600_000

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 })

let root = ''
let callsFile = ''
let pending: Promise<SandboxResult> | undefined
let result: SandboxResult | undefined

interface Invocation {
  command: string[]
  pid: number
}

function invocation(): Invocation | undefined {
  if (!existsSync(callsFile)) return undefined
  return JSON.parse(readFileSync(callsFile, 'utf8')) as Invocation
}

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 3_000
  while (!condition() && performance.now() < deadline) await realDelay(10)
  expect(condition(), message).toBe(true)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-gate-timeout-')))
  callsFile = join(root, 'test-invocation.json')
  pending = undefined
  result = undefined
  for (const directory of ['bin', 'home', 'candidate', 'live_modules']) {
    mkdirSync(join(root, directory))
  }
  const bwrap = join(root, 'bin', 'bwrap')
  writeFileSync(bwrap, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const command = args.slice(args.indexOf('--') + 1)
if (command.length === 1 && command[0] === '/bin/true') process.exit(0)
fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ command, pid: process.pid }))
// The real gate timer must kill this waiting process. This independent watchdog
// bounds cleanup even when an assertion fails on a broken implementation.
setTimeout(() => process.exit(0), 10_000)
`)
  chmodSync(bwrap, 0o755)
  vi.stubEnv('PATH', [join(root, 'bin'), process.env.PATH ?? ''].join(delimiter))
  vi.stubEnv(TIMEOUT_ENV, undefined)
  // Keep Date/performance real: runProcess protects against calendar jumps.
  // Only its deadline timers advance; the CLI runs in a real child process.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  vi.useRealTimers()
  try {
    const call = invocation()
    if (pending !== undefined && result === undefined && call !== undefined) {
      try {
        process.kill(call.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await pending
  } finally {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})

async function startGate(timeoutMs?: number): Promise<void> {
  pending = Promise.resolve(sandboxedTests({
    ownerHome: join(root, 'home'),
    candidate: join(root, 'candidate'),
    liveModules: join(root, 'live_modules'),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })).then((outcome) => {
    result = outcome
    return outcome
  })
  await until(
    () => invocation() !== undefined || result !== undefined,
    'the gate must reach the test command after its successful sandbox probe',
  )
  expect(result, 'the waiting test command must still be running').toBeUndefined()
  expect(invocation()?.command, 'exercise the default npm test gate command').toEqual(['npm', 'test'])
}

async function expectStillRunningAfter(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds)
  // Allow a wrongly killed real child to close and publish its gate result.
  await realDelay(50)
  expect(result, `the gate must still be running after ${String(milliseconds)} more ms`).toBeUndefined()
}

async function expectTimeoutAfter(milliseconds: number): Promise<SandboxResult> {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await until(() => result !== undefined, 'the gate must interrupt the waiting process at its deadline')
  const outcome = await pending!
  expect(outcome.ok, 'a timeout must fail the gate').toBe(false)
  expect(outcome.timedOut, 'the deadline is distinguishable from a missing sandbox').toBe(true)
  expect(`${outcome.sandboxError ?? ''}\n${outcome.output}`).toMatch(/tim(?:e|ed)\s*out|тайм.?аут|время|превышен/i)
  return outcome
}

test.each([125, 1_800_000])('test_c1_env_sets_the_npm_test_deadline_to_%i_ms', async (timeoutMs) => {
  vi.stubEnv(TIMEOUT_ENV, String(timeoutMs))
  await startGate()
  await expectStillRunningAfter(timeoutMs - 1)
  await expectTimeoutAfter(1)
})

test.each([
  undefined,
  '',
  '0',
  '-100',
  '1.5',
  '0.5',
  'not-a-number',
  '600001ms',
  'NaN',
  'Infinity',
])('test_c2_missing_or_invalid_env_%j_keeps_the_600000_ms_deadline', async (value) => {
  vi.stubEnv(TIMEOUT_ENV, value)
  await startGate()
  await expectStillRunningAfter(DEFAULT_TIMEOUT_MS - 1)
  await expectTimeoutAfter(1)
})

test.each([
  { environment: 100, explicit: 900 },
  { environment: 900, explicit: 100 },
])('test_c3_explicit_timeout ($explicit ms) overrides environment ($environment ms)', async ({ environment, explicit }) => {
  vi.stubEnv(TIMEOUT_ENV, String(environment))
  await startGate(explicit)
  await expectStillRunningAfter(explicit - 1)
  await expectTimeoutAfter(1)
})

test.each([
  { environment: undefined, explicit: undefined, effective: DEFAULT_TIMEOUT_MS },
  { environment: '4200', explicit: undefined, effective: 4200 },
  { environment: '4200', explicit: 1379, effective: 1379 },
])('test_c4_timeout_result_names_limit ($effective ms) and_environment_variable', async ({ environment, explicit, effective }) => {
  vi.stubEnv(TIMEOUT_ENV, environment)
  await startGate(explicit)
  const outcome = await expectTimeoutAfter(effective)
  const diagnostics = `${outcome.sandboxError ?? ''}\n${outcome.output}`
  expect(diagnostics).toContain(TIMEOUT_ENV)
  expect(diagnostics.replace(/[\s_,]/g, '')).toMatch(new RegExp(`(?:^|\\D)${String(effective)}(?:\\D|$)`))
})
