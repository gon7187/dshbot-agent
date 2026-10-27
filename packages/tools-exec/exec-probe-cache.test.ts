// The probe of the bwrap sandbox (the same profile run with /bin/true) is remembered for 60 seconds per
// profile: commands inside the window go without a new probe, a failed probe is never remembered, and a
// sandbox that broke inside the window still never runs a command outside bwrap. The tests put a fake
// `bwrap` first on the PATH of the process: it logs every call (a probe is the call whose last argument is
// /bin/true), can be switched to «broken» with a flag file, and otherwise runs the command after the
// profile's `--` itself, so the tests need no real bwrap. The clock of the 60 seconds is the fake one.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const FAKE_BWRAP = `#!/bin/sh
dir=$(dirname "$0")
last=
for a; do last=$a; done
if [ "$last" = /bin/true ]; then printf 'PROBE %s\\n' "$*" >> "$dir/calls.log"; else printf 'RUN\\n' >> "$dir/calls.log"; fi
if [ -e "$dir/broken" ]; then echo "bwrap: boom" >&2; exit 1; fi
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
if [ "$1" = bash ] && [ "$2" = -c ] && [ "$4" = dshbot-exec ]; then exec bash -c "$5"; fi
exec "$@"
`

const originalPath = process.env.PATH
const originalExecPath = process.execPath
const scratchDirs: string[] = []
let fakeDir = ''
const created: ExecTools[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** The fake bwrap goes first on the PATH of the probe and of the command; `node` beside it keeps the node directory ours. */
function installFake(withBwrap: boolean): void {
  fakeDir = scratch('dshbot-exec-probe-fake-')
  if (withBwrap) {
    writeFileSync(join(fakeDir, 'bwrap'), FAKE_BWRAP)
    chmodSync(join(fakeDir, 'bwrap'), 0o755)
  }
  symlinkSync(originalExecPath, join(fakeDir, 'node'))
  if (withBwrap) {
    process.env.PATH = [fakeDir, originalPath ?? ''].join(delimiter)
  } else {
    // no bwrap anywhere on the PATH; the fake (installed later) still finds the two programs it needs
    const binDir = scratch('dshbot-exec-probe-bin-')
    for (const name of ['dirname', 'bash']) {
      const found = (originalPath ?? '').split(delimiter).map((entry) => join(entry, name)).find((path) => existsSync(path))
      if (found !== undefined) symlinkSync(found, join(binDir, name))
    }
    process.env.PATH = [fakeDir, binDir].join(delimiter)
  }
  Object.defineProperty(process, 'execPath', { value: join(fakeDir, 'node'), configurable: true, writable: true })
}

beforeEach(() => {
  installFake(true)
})

afterEach(async () => {
  vi.useRealTimers()
  for (const tools of created.splice(0)) await tools.stop()
  process.env.PATH = originalPath
  Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true })
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function makeExec(workspace: string): Promise<ExecTools> {
  const tools = await createExecTools({ workspace, home: HOME })
  created.push(tools)
  return tools
}

async function call(tools: ExecTools, args: Record<string, unknown>): Promise<string> {
  const tool = tools.tools.find((candidate) => candidate.name === 'exec')
  expect(tool, 'the tool exec is among the tools of exec').toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

/** The answer of a call, or the message of the error it threw. */
async function answerOrError(tools: ExecTools, command: string): Promise<{ text: string; threw: boolean }> {
  try {
    return { text: await call(tools, { command }), threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

function callLog(): string[] {
  const file = join(fakeDir, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : []
}

/** Probes of the profile that works in `workspace`, or of all profiles. */
function probes(workspace?: string): number {
  return callLog().filter((line) => line.startsWith('PROBE ') && (workspace === undefined || line.includes(` --chdir ${workspace} `))).length
}

const runs = (): number => callLog().filter((line) => line === 'RUN').length

const setBroken = (broken: boolean): void => {
  const flag = join(fakeDir, 'broken')
  if (broken) writeFileSync(flag, '')
  else rmSync(flag, { force: true })
}

test('test_c1_five_commands_in_the_window_probe_once_and_all_run_inside_bwrap', { timeout: 120_000 }, async () => {
  const tools = await makeExec(scratch('dshbot-exec-probe-c1-'))
  for (let index = 1; index <= 5; index += 1) {
    const answer = await call(tools, { command: `echo probe-c1-${index}` })
    expect(answer, `the command ${index} ran`).toMatch(/^exit 0\b/)
    expect(answer).toContain(`probe-c1-${index}`)
  }
  expect(probes(), 'the profile is probed with /bin/true exactly once').toBe(1)
  expect(runs(), 'all five commands went through bwrap').toBe(5)
})

test('test_c2_a_command_after_61_seconds_probes_again', { timeout: 120_000 }, async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'hrtime'] })
  const tools = await makeExec(scratch('dshbot-exec-probe-c2-'))
  expect(await call(tools, { command: 'echo probe-c2-first' })).toMatch(/^exit 0\b/)
  expect(probes()).toBe(1)

  vi.advanceTimersByTime(30_000)
  expect(await call(tools, { command: 'echo probe-c2-inside' })).toMatch(/^exit 0\b/)
  expect(probes(), '30 seconds after the probe the window is still open').toBe(1)

  vi.advanceTimersByTime(31_000)
  const late = await call(tools, { command: 'echo probe-c2-late' })
  expect(late).toMatch(/^exit 0\b/)
  expect(late).toContain('probe-c2-late')
  expect(probes(), '61 seconds after the probe it is made again').toBe(2)
  expect(runs()).toBe(3)
})

test('test_c3_a_failed_probe_rejects_the_command_and_is_not_remembered', { timeout: 120_000 }, async () => {
  const workspace = scratch('dshbot-exec-probe-c3-')
  const marker = join(workspace, 'ran-outside-c3')
  const tools = await makeExec(workspace)
  setBroken(true)

  for (const attempt of [1, 2]) {
    const refused = await answerOrError(tools, `touch ${marker}`)
    expect(refused.text, `attempt ${attempt} names the broken sandbox`).toContain('песочница bwrap не запускается')
    expect(existsSync(marker), `attempt ${attempt} did not run the command outside bwrap`).toBe(false)
    expect(probes(), `attempt ${attempt} probes again`).toBe(attempt)
  }
  expect(runs(), 'no command was started inside the broken sandbox').toBe(0)

  setBroken(false)
  const answer = await call(tools, { command: 'echo probe-c3-repaired' })
  expect(answer).toMatch(/^exit 0\b/)
  expect(answer).toContain('probe-c3-repaired')
  expect(probes(), 'the repaired sandbox is probed once more').toBe(3)
})

test('test_c3_a_missing_bwrap_rejects_the_command_and_every_next_one_probes_again', { timeout: 120_000 }, async () => {
  scratchDirs.pop()
  rmSync(fakeDir, { recursive: true, force: true })
  installFake(false)
  const workspace = scratch('dshbot-exec-probe-c3-missing-')
  const marker = join(workspace, 'ran-outside-c3-missing')
  const tools = await makeExec(workspace)

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const refused = await answerOrError(tools, `touch ${marker}`)
    expect(refused.text, `attempt ${attempt} names the broken sandbox`).toContain('песочница bwrap не запускается')
    expect(existsSync(marker), `attempt ${attempt} did not run the command outside bwrap`).toBe(false)
  }

  // bwrap appears: the failure was not remembered
  writeFileSync(join(fakeDir, 'bwrap'), FAKE_BWRAP)
  chmodSync(join(fakeDir, 'bwrap'), 0o755)
  const answer = await call(tools, { command: 'echo probe-c3-appeared' })
  expect(answer).toMatch(/^exit 0\b/)
  expect(answer).toContain('probe-c3-appeared')
  expect(probes()).toBe(1)
})

test('test_c4_a_sandbox_broken_inside_the_window_fails_one_command_and_the_next_one_probes', { timeout: 120_000 }, async () => {
  const workspace = scratch('dshbot-exec-probe-c4-')
  const marker = join(workspace, 'ran-outside-c4')
  const tools = await makeExec(workspace)
  expect(await call(tools, { command: 'echo probe-c4-first' })).toMatch(/^exit 0\b/)
  expect(probes()).toBe(1)

  setBroken(true)
  const failed = await answerOrError(tools, `touch ${marker}`)
  expect(existsSync(marker), 'the command did not run outside bwrap').toBe(false)
  expect(failed.threw || !/^exit 0\b/.test(failed.text), `the command ends with an error, got: ${failed.text}`).toBe(true)
  expect(probes(), 'the window was still open: no probe before this command').toBe(1)

  const next = await answerOrError(tools, `touch ${marker}`)
  expect(next.text, 'the next command gets the clear error').toContain('песочница bwrap не запускается')
  expect(existsSync(marker), 'the next command did not run outside bwrap either').toBe(false)
  expect(probes(), 'the next command probes again').toBe(2)
})

test('test_c5_each_profile_has_its_own_probe', { timeout: 120_000 }, async () => {
  const workspaceA = scratch('dshbot-exec-probe-c5-a-')
  const workspaceB = scratch('dshbot-exec-probe-c5-b-')
  const toolsA = await makeExec(workspaceA)
  const toolsB = await makeExec(workspaceB)

  expect(await call(toolsA, { command: 'echo probe-c5-a1' })).toMatch(/^exit 0\b/)
  expect(probes(workspaceA)).toBe(1)
  expect(probes(workspaceB), 'the probe of A does not stand for B').toBe(0)

  expect(await call(toolsB, { command: 'echo probe-c5-b1' })).toMatch(/^exit 0\b/)
  expect(probes(workspaceB), 'B is probed with its own profile').toBe(1)

  expect(await call(toolsA, { command: 'echo probe-c5-a2' })).toMatch(/^exit 0\b/)
  expect(await call(toolsB, { command: 'echo probe-c5-b2' })).toMatch(/^exit 0\b/)
  expect(probes(workspaceA), 'A stays remembered').toBe(1)
  expect(probes(workspaceB), 'B stays remembered').toBe(1)
  expect(runs()).toBe(4)
})
