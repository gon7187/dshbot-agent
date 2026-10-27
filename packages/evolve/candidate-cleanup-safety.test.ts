// Safety of the self-rewrite candidate cleanup (packages/evolve): removing a
// candidate must never delete a worktree that is checked out on anything but the
// exact `candidate-<id>` branch, and every removal performed by the sweep — even
// a branch whose candidate directory is already gone — must be one log line with
// the candidate id and a reason.
//
// Every test builds a real temporary repository (branch `live`, neighbouring
// branches) and drives the public seam of createEvolve: self_change, reject, the
// start/daily sweep on fake clocks. The sandboxed gate and the reviewer are seams.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createEvolve, type Evolve } from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

const TEST_TIMEOUT_MS = 30_000
const HOUR = 3_600_000

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let root = ''
let home = ''
let live = ''
let candidatesDir = ''
let logLines: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-candidate-safety-')))
  home = join(root, 'home')
  live = join(home, 'app')
  candidatesDir = join(home, 'candidates')
  logLines = []
  put(join(live, 'notes.md'), 'original notes\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
})

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}

function makeEvolve(): Evolve {
  return createEvolve({
    home,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'looks fine' }),
    sandbox: () => ({ ok: true, status: 0, output: '' }),
    card: async () => undefined,
    log: (message) => {
      logLines.push(message)
    },
  })
}

interface Made {
  id: string
  path: string
}

function tool(evolve: Evolve, name: string): RunnerTool {
  const found = evolve.tools.find((entry) => entry.name === name)
  expect(found, `evolve has no tool ${name}`).toBeDefined()
  return found as RunnerTool
}

/** self_change plus an uncommitted edit and a module layer, like a candidate in progress. */
async function openCandidate(evolve: Evolve): Promise<Made> {
  const started = String(await tool(evolve, 'self_change').execute({ description: 'tidy the notes' }))
  const id = /^id:\s*(\S+)/m.exec(started)?.[1]
  const path = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
  if (id === undefined || path === undefined) throw new Error(`self_change gave no candidate: ${started}`)
  put(join(path, 'notes.md'), `edited by ${id}\n`)
  put(join(path, 'node_modules', 'layer-dep', 'index.js'), 'module.exports = 1\n')
  return { id, path }
}

function worktreePaths(): string[] {
  return git(live, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

function hasBranch(name: string): boolean {
  return git(live, 'branch', '--list', name) !== ''
}

function linesAbout(id: string): string[] {
  return logLines.filter((line) => line.includes(id))
}

function expectIntact(made: Made, what: string): void {
  expect(worktreePaths(), `${what}: ${made.id} lost its worktree`).toContain(made.path)
  expect(hasBranch(`candidate-${made.id}`), `${what}: ${made.id} lost its branch`).toBe(true)
  expect(existsSync(join(made.path, 'node_modules', 'layer-dep', 'index.js')), `${what}: ${made.id} lost its files`).toBe(
    true,
  )
}

async function attempt(run: () => unknown): Promise<{ threw: boolean; text: string }> {
  try {
    return { threw: false, text: String(await run()) }
  } catch (error) {
    return { threw: true, text: error instanceof Error ? error.message : String(error) }
  }
}

/** Real time (not the faked clock) for work that the background sweep finishes after the timers fired. */
async function until(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = performance.now()
  while (!condition() && performance.now() - started < timeoutMs) await new Promise((resolve) => setImmediate(resolve))
  expect(condition(), `timed out waiting for: ${what}`).toBe(true)
}

// --- [safe] a candidate switched away from its own branch ----------------------------------------

test(
  'test_safe_reject_and_sweep_leave_a_candidate_switched_to_main_or_a_foreign_feature_branch_alone',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    fakeClock()
    const start = Date.now()
    git(live, 'branch', 'main', 'live')
    git(live, 'branch', 'feature-foreign', 'live')
    const mainSha = git(live, 'rev-parse', 'main')
    const featureSha = git(live, 'rev-parse', 'feature-foreign')

    const evolve = makeEvolve()
    const onMain = await openCandidate(evolve)
    const onFeature = await openCandidate(evolve)

    // The model (or an editor) switches the candidate worktrees away from the
    // branch of the candidate: the commit is the same, so git allows it.
    git(onMain.path, 'checkout', '-q', 'main')
    git(onFeature.path, 'checkout', '-q', 'feature-foreign')

    // Owner rejects: the worktree with a foreign branch is not the candidate's any more.
    const rejected = await attempt(() => evolve.reject(onMain.id))
    expect(
      rejected.threw || /отмен|отказ|refus|ветк|branch/i.test(rejected.text),
      `reject must refuse a worktree on main: ${rejected.text}`,
    ).toBe(true)
    expectIntact(onMain, 'reject with main checked out')
    expectIntact(onFeature, 'reject of another candidate with a foreign branch')
    expect(git(live, 'rev-parse', 'main'), 'main did not move').toBe(mainSha)
    expect(git(live, 'rev-parse', 'feature-foreign'), 'the foreign branch did not move').toBe(featureSha)
    expect(linesAbout(onMain.id).some((line) => /отмен|отказ|ветк|branch/i.test(line)), JSON.stringify(logLines)).toBe(true)

    // A later process starts after the 24 h TTL: the sweep must also refuse.
    vi.clearAllTimers()
    vi.setSystemTime(start + 25 * HOUR)
    makeEvolve()
    await until(
      () => linesAbout(onMain.id).some((line) => /отмен|отказ|ветк|branch/i.test(line)),
      'the background sweep to log its refusal',
    )

    expectIntact(onMain, 'sweep with main checked out')
    expectIntact(onFeature, 'sweep with a foreign branch checked out')
    expect(worktreePaths(), 'feature worktree survives the sweep').toContain(onFeature.path)
    expect(git(live, 'rev-parse', 'main'), 'main survives the sweep').toBe(mainSha)
    expect(git(live, 'rev-parse', 'feature-foreign'), 'the foreign branch survives the sweep').toBe(featureSha)
    expect(
      linesAbout(onMain.id).some((line) => /отмен|отказ|ветк|branch/i.test(line)),
      `the sweep refusal is logged with the id: ${JSON.stringify(logLines)}`,
    ).toBe(true)
  },
)

test('test_safe_discard_refuses_a_candidate_switched_to_main', { timeout: TEST_TIMEOUT_MS }, async () => {
  git(live, 'branch', 'main', 'live')
  const evolve = makeEvolve()
  const made = await openCandidate(evolve)
  git(made.path, 'checkout', '-q', 'main')

  const outcome = await attempt(() => tool(evolve, 'self_discard').execute({ id: made.id }))
  expect(
    outcome.threw || /отмен|отказ|refus|ветк|branch/i.test(outcome.text),
    `self_discard must refuse a worktree on main: ${outcome.text}`,
  ).toBe(true)
  expectIntact(made, 'self_discard with main checked out')
  expect(hasBranch('main'), 'main survives').toBe(true)
  expect(
    linesAbout(made.id).some((line) => /отмен|отказ|ветк|branch/i.test(line)),
    `the refusal is logged with the id: ${JSON.stringify(logLines)}`,
  ).toBe(true)
})

// --- [log] branch left without a candidate directory ------------------------------------------------

test(
  'test_log_branch_left_after_the_candidate_directory_was_removed_is_deleted_and_logged',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    fakeClock()
    const start = Date.now()
    const evolve = makeEvolve()
    const made = await openCandidate(evolve)

    // The directory is removed separately (the way an operator would do it); the
    // branch and the metadata of the candidate are still there.
    git(live, 'worktree', 'remove', '--force', made.path)
    expect(existsSync(made.path), 'fixture: the candidate directory is gone').toBe(false)
    expect(hasBranch(`candidate-${made.id}`), 'fixture: the branch is still there').toBe(true)

    vi.clearAllTimers()
    vi.setSystemTime(start + 25 * HOUR)
    makeEvolve()
    await until(
      () => !hasBranch(`candidate-${made.id}`) && linesAbout(made.id).length > 0,
      'the background sweep to remove the leftover branch',
    )

    expect(hasBranch(`candidate-${made.id}`), 'the sweep removed the leftover branch').toBe(false)
    const lines = linesAbout(made.id)
    expect(lines.length, `the removal is logged with the id: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
    expect(lines.some((line) => /ветк|каталог|удал|remov|delet/i.test(line)), JSON.stringify(lines)).toBe(true)
    expect(
      lines.some((line) => /ветк|каталог|ttl|истёк|истек|старше|отсутств/i.test(line)),
      `the log line carries the reason: ${JSON.stringify(lines)}`,
    ).toBe(true)
  },
)

test(
  'test_log_stale_worktree_entry_and_branch_without_a_directory_are_pruned_and_logged',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    fakeClock()
    const start = Date.now()
    const evolve = makeEvolve()
    const made = await openCandidate(evolve)

    // A plain directory removal leaves the git worktree admin entry (prunable).
    rmSync(made.path, { recursive: true, force: true })
    expect(worktreePaths(), 'fixture: git still lists the prunable worktree').toContain(made.path)
    expect(hasBranch(`candidate-${made.id}`), 'fixture: the branch is still there').toBe(true)

    vi.clearAllTimers()
    vi.setSystemTime(start + 25 * HOUR)
    makeEvolve()
    await until(
      () => !hasBranch(`candidate-${made.id}`) && linesAbout(made.id).length > 0,
      'the background sweep to prune the stale entry',
    )

    expect(hasBranch(`candidate-${made.id}`), 'the sweep removed the leftover branch').toBe(false)
    expect(worktreePaths(), 'the stale worktree entry is pruned').not.toContain(made.path)
    const lines = linesAbout(made.id)
    expect(lines.length, `the removal is logged with the id: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
    expect(lines.some((line) => /ветк|worktree|каталог|удал|remov|delet/i.test(line)), JSON.stringify(lines)).toBe(true)
  },
)

test('test_safe_cleanup_keeps_live_stable_main_and_foreign_worktrees', { timeout: TEST_TIMEOUT_MS }, async () => {
  fakeClock()
  const start = Date.now()
  git(live, 'branch', 'main', 'live')
  git(live, 'branch', 'stable', 'live')
  const foreign = join(root, 'foreign-wt')
  git(live, 'worktree', 'add', '-q', '-b', 'feature-x', foreign, 'live')
  put(join(foreign, 'work.txt'), 'uncommitted work\n')
  const shas = Object.fromEntries(['live', 'main', 'stable', 'feature-x'].map((b) => [b, git(live, 'rev-parse', b)]))

  const evolve = makeEvolve()
  const stale = await openCandidate(evolve)

  vi.clearAllTimers()
  vi.setSystemTime(start + 30 * 24 * HOUR)
  const restarted = makeEvolve()
  await restarted.markHealthy()
  await until(() => !hasBranch(`candidate-${stale.id}`), 'the background startup sweep to remove the stale candidate')

  for (const [branch, sha] of Object.entries(shas)) {
    expect(hasBranch(branch), `branch ${branch} survives`).toBe(true)
    expect(git(live, 'rev-parse', branch), `branch ${branch} did not move`).toBe(sha)
  }
  expect(worktreePaths(), 'the foreign worktree survives').toContain(foreign)
  expect(readFileSync(join(foreign, 'work.txt'), 'utf8'), 'the foreign files stay').toBe('uncommitted work\n')
  expect(hasBranch(`candidate-${stale.id}`), 'the stale candidate itself is removed').toBe(false)
})

test.each([
  { action: 'reject', missing: false, locked: true },
  { action: 'reject', missing: true, locked: true },
  { action: 'sweep', missing: true, locked: false },
  { action: 'sweep', missing: true, locked: true },
])(
  'test_safe_$action_preserves_an_unavailable_foreign_worktree_with_missing_$missing_locked_$locked_candidate',
  { timeout: TEST_TIMEOUT_MS },
  async ({ action, missing, locked }) => {
    fakeClock()
    const start = Date.now()
    const foreign = join(root, 'foreign-unavailable')
    const parked = join(root, 'foreign-parked')
    git(live, 'worktree', 'add', '-q', '-b', 'feature-unavailable', foreign, 'live')
    put(join(foreign, 'work.txt'), 'keep this uncommitted work\n')
    const foreignSha = git(foreign, 'rev-parse', 'HEAD')

    const evolve = makeEvolve()
    const made = await openCandidate(evolve)
    if (locked) git(live, 'worktree', 'lock', made.path)
    if (missing) rmSync(made.path, { recursive: true, force: true })

    // Simulate an unmounted worktree: git now considers this unrelated record
    // prunable. Its registration must survive every candidate-cleanup path.
    renameSync(foreign, parked)
    const foreignRecord = () =>
      git(live, 'worktree', 'list', '--porcelain')
        .split('\n\n')
        .find((record) => record.startsWith(`worktree ${foreign}\n`))
    const before = foreignRecord()
    expect(before).toContain('branch refs/heads/feature-unavailable')
    expect(before).toContain('prunable ')

    if (action === 'reject') {
      await evolve.reject(made.id)
    } else {
      vi.clearAllTimers()
      vi.setSystemTime(start + 25 * HOUR)
      makeEvolve()
      await until(
        () => !hasBranch(`candidate-${made.id}`) && linesAbout(made.id).some((line) => /удал/.test(line)),
        'the background sweep to remove the candidate',
      )
    }

    expect(worktreePaths()).not.toContain(made.path)
    expect(hasBranch(`candidate-${made.id}`)).toBe(false)
    expect(existsSync(made.path)).toBe(false)
    expect(foreignRecord(), 'unavailable foreign registration must remain unchanged').toBe(before)
    expect(git(live, 'rev-parse', 'feature-unavailable')).toBe(foreignSha)
    const reason = action === 'reject' ? /reject/ : /отсутствует/
    expect(linesAbout(made.id).some((line) => /удал/.test(line) && reason.test(line))).toBe(true)
    if (locked) {
      expect(linesAbout(made.id).some((line) => /удалена запись worktree/.test(line) && reason.test(line))).toBe(true)
    }

    renameSync(parked, foreign)
    expect(git(foreign, 'rev-parse', 'HEAD')).toBe(foreignSha)
    expect(git(foreign, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature-unavailable')
    expect(git(foreign, 'status', '--porcelain')).toContain('?? work.txt')
    expect(readFileSync(join(foreign, 'work.txt'), 'utf8')).toBe('keep this uncommitted work\n')
  },
)
