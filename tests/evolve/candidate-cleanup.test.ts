// Cleanup of self-rewrite candidates (DESIGN §8.3): a candidate is a git worktree DSHBOT_HOME/candidates/<id>, a
// branch candidate-<id> in the shared repository and a node_modules layer inside the worktree. Nothing removed them.
//
// Every test builds a real temporary `live` repository (branch `live`, plus neighbours that must never be touched)
// and drives the real packages/evolve through its public seam: the tools self_change / self_submit /
// self_discard, reject(), accept(), markHealthy(). The sandboxed `npm test` and the reviewer are the usual seams,
// so no bwrap and no network are needed.
//
// Contract the tests rely on:
//   - createEvolve() sweeps the candidates directory once when it is called ("at process start") and then every
//     24 hours on the global timer functions; the tests fake setInterval / setTimeout / Date, nothing else;
//   - a candidate that was never submitted (or failed the gate) is removed by the sweep when it is older than 24 h;
//     a candidate that passed the gate and waits for the owner's decision stays until it is 7 days old;
//   - reject(id) and the tool self_discard({ id }) remove the candidate; reject() returns a promise for the
//     removal, after an adoption (adopt.json -> scripts/adopt.sh -> a new process) markHealthy() returns one too;
//   - every removal is one line in the `log` option that holds the candidate id and the reason;
//   - rejection, the daily TTL sweep, the cleanup after markHealthy, the removal after a red synchronization
//     gate and self_discard never block the event loop, even when `git worktree remove` of a candidate with
//     installed node_modules is slow.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createEvolve, type Evolve, type OwnerCard } from '../../packages/evolve/src/index.js'
import type { RunnerTool } from '../../packages/runner/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  ...GIT_IDENTITY,
}

let root = ''
let home = ''
let live = ''
let candidatesDir = ''
let logLines: string[] = []
let cards: OwnerCard[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-candidate-cleanup-')))
  home = join(root, 'home')
  live = join(home, 'app')
  candidatesDir = join(home, 'candidates')
  logLines = []
  cards = []
  put(join(live, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
  put(join(live, 'notes.md'), 'original notes\n')
  put(join(live, '.gitignore'), 'node_modules/\n')
  mkdirSync(join(live, 'scripts'), { recursive: true })
  cpSync(join(repoRoot, 'scripts', 'adopt.sh'), join(live, 'scripts', 'adopt.sh'))
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

/** A process of the daemon: its own createEvolve bound to the temporary home and live checkout. */
function makeEvolve(): Evolve {
  return createEvolve({
    home,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'looks fine' }),
    sandbox: () => ({ ok: true, status: 0, output: '' }),
    card: async (card) => {
      cards.push(card)
    },
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
  expect(found, `evolve has no tool ${name}: ${evolve.tools.map((entry) => entry.name).join(', ')}`).toBeDefined()
  return found as RunnerTool
}

/** self_change plus a node_modules layer and an uncommitted edit, the state of a candidate in progress. */
async function openCandidate(evolve: Evolve): Promise<Made> {
  const started = String(await tool(evolve, 'self_change').execute({ description: 'tidy the notes' }))
  const id = /^id:\s*(\S+)/m.exec(started)?.[1]
  const path = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
  if (id === undefined || path === undefined) throw new Error(`self_change gave no candidate: ${started}`)
  put(join(path, 'notes.md'), `edited by ${id}\n`)
  put(join(path, 'node_modules', 'layer-dep', 'index.js'), 'module.exports = 1\n')
  return { id, path }
}

/** A candidate that passed the gate: committed, the card is out, the owner has not answered. */
async function passedCandidate(evolve: Evolve): Promise<Made> {
  const made = await openCandidate(evolve)
  await tool(evolve, 'self_submit').execute({ id: made.id })
  expect(evolve.candidate(made.id)?.status, 'the gate passed').toBe('passed')
  return made
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

function isGone(made: Made): boolean {
  return !worktreePaths().includes(made.path) && !hasBranch(`candidate-${made.id}`) && !existsSync(made.path)
}

/** True when the persisted metadata of the candidate is still there. */
function hasRecord(id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'evolve-candidates.json'), 'utf8')) as {
      candidates?: Record<string, unknown>
    }
    return parsed.candidates?.[id] !== undefined
  } catch {
    return false
  }
}

function expectGone(made: Made, what: string): void {
  expect(worktreePaths(), `${what}: git worktree list still has ${made.id}`).not.toContain(made.path)
  expect(hasBranch(`candidate-${made.id}`), `${what}: branch candidate-${made.id} is still there`).toBe(false)
  expect(existsSync(made.path), `${what}: ${made.path} is still there`).toBe(false)
  expect(existsSync(join(candidatesDir, made.id)), `${what}: the candidate directory is still there`).toBe(false)
}

function expectIntact(made: Made, what: string): void {
  expect(worktreePaths(), `${what}: ${made.id} lost its worktree`).toContain(made.path)
  expect(hasBranch(`candidate-${made.id}`), `${what}: ${made.id} lost its branch`).toBe(true)
  expect(existsSync(join(made.path, 'node_modules', 'layer-dep', 'index.js')), `${what}: ${made.id} lost its files`).toBe(true)
}

/** Real time (not the faked one) for work that finishes after the timers fired. */
async function until(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const started = performance.now()
  while (!condition() && performance.now() - started < timeoutMs) await new Promise((resolve) => setImmediate(resolve))
  expect(condition(), `timed out waiting for: ${what}`).toBe(true)
}

async function settle(ms = 400): Promise<void> {
  const started = performance.now()
  while (performance.now() - started < ms) await new Promise((resolve) => setImmediate(resolve))
}

function linesAbout(id: string): string[] {
  return logLines.filter((line) => line.includes(id))
}

function withoutId(line: string, id: string): string {
  return line.split(id).join('<id>')
}

async function attempt(run: () => unknown): Promise<{ threw: boolean; text: string }> {
  try {
    return { threw: false, text: String(await run()) }
  } catch (error) {
    return { threw: true, text: error instanceof Error ? error.message : String(error) }
  }
}

function startPre(): { status: number | null; output: string } {
  const result = spawnSync('bash', [join(live, 'scripts', 'adopt.sh')], {
    cwd: live,
    encoding: 'utf8',
    env: {
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      HOME: root,
      DSHBOT_HOME: home,
      ...GIT_IDENTITY,
    },
    timeout: 60_000,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// --- [reject] --------------------------------------------------------------------------------------

test('test_reject_owner_reject_removes_worktree_branch_directory_and_module_layer', { timeout: TEST_TIMEOUT_MS }, async () => {
  const evolve = makeEvolve()
  const passed = await passedCandidate(evolve)
  const open = await openCandidate(evolve)
  expect(existsSync(join(passed.path, 'node_modules', 'layer-dep', 'index.js')), 'fixture: the module layer exists').toBe(true)
  expect(worktreePaths(), 'fixture: the worktree is registered').toContain(passed.path)
  expect(hasBranch(`candidate-${passed.id}`), 'fixture: the branch exists').toBe(true)

  await evolve.reject(passed.id)

  expectGone(passed, 'reject of a candidate with a card')
  expectIntact(open, 'reject of another candidate')
  expect(hasBranch('live'), 'live stays').toBe(true)
  expect(git(live, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')

  await evolve.reject(open.id)
  expectGone(open, 'reject of a candidate that never reached the gate')
})

// --- [adopted] -------------------------------------------------------------------------------------

test('test_adopted_branch_and_worktree_are_removed_after_mark_healthy_and_the_commit_stays_in_live', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = makeEvolve()
  const adopted = await passedCandidate(first)
  const inProgress = await openCandidate(first)

  const sha = first.accept(adopted.id)
  expect(existsSync(join(home, 'adopt.json')), 'accept writes adopt.json').toBe(true)

  // the daemon exits 42, systemd runs ExecStartPre, and a new process starts
  const pre = startPre()
  expect(pre.status, `adopt.sh must succeed\n${pre.output}`).toBe(0)
  expect(git(live, 'rev-parse', 'live'), 'live moved to the adopted sha').toBe(sha)
  const restarted = makeEvolve()
  logLines = []

  await restarted.markHealthy()

  await until(() => isGone(adopted), 'the adopted candidate to be removed after markHealthy')
  expectGone(adopted, 'adopted candidate after markHealthy')
  expect(git(live, 'rev-list', 'live').split('\n'), 'the adopted commit is reachable from live').toContain(sha)
  expect(git(live, 'rev-parse', 'live'), 'live still points at the adopted commit').toBe(sha)
  expect(git(live, 'symbolic-ref', 'HEAD'), 'live is still a branch').toBe('refs/heads/live')
  expect(readFileSync(join(live, 'notes.md'), 'utf8'), 'the adopted change is in live').toBe(`edited by ${adopted.id}\n`)
  expectIntact(inProgress, 'markHealthy must only remove the adopted candidate')

  const lines = linesAbout(adopted.id)
  expect(lines.length, `the removal is logged: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
  expect(lines.some((line) => /adopt|адопт|принят/i.test(line)), `the reason is logged: ${JSON.stringify(lines)}`).toBe(true)
})

// --- [ttl] -----------------------------------------------------------------------------------------

test('test_ttl_start_removes_candidates_without_a_decision_older_than_24h_and_keeps_younger_ones', { timeout: TEST_TIMEOUT_MS }, async () => {
  fakeClock()
  const start = Date.now()
  const stale = await openCandidate(makeEvolve())

  // the process dies; the next one starts 23 hours after the candidate was cut: too early for the TTL
  vi.clearAllTimers()
  vi.setSystemTime(start + 23 * HOUR)
  makeEvolve()
  await settle()
  expectIntact(stale, 'a 23 hour old candidate at start')

  // and the one after that starts 25 hours after
  vi.clearAllTimers()
  vi.setSystemTime(start + 25 * HOUR)
  makeEvolve()
  await until(() => isGone(stale) && !hasRecord(stale.id), 'the 25 hour old candidate to be removed at start')
  expectGone(stale, 'stale candidate at start')
})

test('test_ttl_daily_tick_removes_open_candidates_after_24h_and_a_waiting_card_only_after_7_days', { timeout: TEST_TIMEOUT_MS }, async () => {
  fakeClock()
  const evolve = makeEvolve()
  const open = await openCandidate(evolve)
  const waiting = await passedCandidate(evolve)
  expect(cards.map((card) => card.id), 'the card of the passed candidate went to the owner').toContain(waiting.id)

  // two days: the candidate without a decision goes, the one with a card waits
  await vi.advanceTimersByTimeAsync(49 * HOUR)
  await until(() => isGone(open) && !hasRecord(open.id), 'the 2 day old candidate without a decision to be removed by the daily sweep')
  expectGone(open, 'candidate without a decision, 2 days')
  expectIntact(waiting, 'candidate with a waiting card, 2 days')

  // 6.5 days: still waiting for the owner
  await vi.advanceTimersByTimeAsync(107 * HOUR)
  await settle()
  expectIntact(waiting, 'candidate with a waiting card, 6.5 days')

  // 8.5 days: the card has waited too long
  await vi.advanceTimersByTimeAsync(48 * HOUR)
  await until(() => isGone(waiting) && !hasRecord(waiting.id), 'the 8.5 day old candidate with a card to be removed by the daily sweep')
  expectGone(waiting, 'candidate with a waiting card, 8.5 days')
})

// --- [discard] -------------------------------------------------------------------------------------

test('test_discard_tool_removes_own_open_and_passed_candidates_and_is_not_guest_allowed', { timeout: TEST_TIMEOUT_MS }, async () => {
  const evolve = makeEvolve()
  const discard = tool(evolve, 'self_discard')
  const schema = (discard.inputSchema ?? discard.input_schema ?? discard.schema ?? discard.jsonSchema ?? {}) as {
    properties?: Record<string, unknown>
    required?: string[]
  }
  expect(Object.keys(schema.properties ?? {}), 'self_discard takes the candidate id').toContain('id')
  expect(schema.required ?? [], 'the id is required').toContain('id')
  expect(discard.guestAllowed === true, 'self_discard is an owner tool, never opened to guests').toBe(false)

  const open = await openCandidate(evolve)
  const passed = await passedCandidate(evolve)
  const bystander = await openCandidate(evolve)

  await discard.execute({ id: open.id })
  expectGone(open, 'discard of a candidate in progress')
  expectIntact(passed, 'discard of another candidate')

  await discard.execute({ id: passed.id })
  expectGone(passed, 'discard of a candidate with a card')
  expectIntact(bystander, 'discard of another candidate')
})

test('test_discard_refuses_ids_with_separators_dots_or_without_the_candidate_prefix', { timeout: TEST_TIMEOUT_MS }, async () => {
  const evolve = makeEvolve()
  const discard = tool(evolve, 'self_discard')
  const mine = await openCandidate(evolve)
  const victim = join(root, 'victim')
  put(join(victim, 'precious.txt'), 'do not touch\n')
  put(join(home, 'candidates-sibling', 'precious.txt'), 'do not touch\n')
  git(live, 'branch', 'main', 'live')
  git(live, 'branch', 'stable', 'live')
  const liveSha = git(live, 'rev-parse', 'live')

  const bad = ['', '.', '..', 'a/b', '../victim', '../candidates-sibling', join(victim), 'foo', 'live', 'main', 'stable']
  for (const id of bad) {
    const outcome = await attempt(() => discard.execute({ id }))
    expect(
      outcome.threw || /не |нет|недопуст|invalid|refus|reject|отклон|unknown|not found|denied/i.test(outcome.text),
      `id ${JSON.stringify(id)} must be refused, got: ${outcome.text}`,
    ).toBe(true)
  }
  const missing = await attempt(() => discard.execute({}))
  expect(missing.threw || /не |нет|invalid|id/i.test(missing.text), 'a call without an id is refused').toBe(true)

  expectIntact(mine, 'refused ids')
  expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('do not touch\n')
  expect(readFileSync(join(home, 'candidates-sibling', 'precious.txt'), 'utf8')).toBe('do not touch\n')
  for (const branch of ['live', 'main', 'stable']) expect(hasBranch(branch), `branch ${branch} survives`).toBe(true)
  expect(git(live, 'rev-parse', 'live'), 'live did not move').toBe(liveSha)
  expect(existsSync(join(live, 'notes.md')), 'the live checkout is intact').toBe(true)
})

// --- [safe] ----------------------------------------------------------------------------------------

test('test_safe_cleanup_never_touches_live_stable_main_foreign_worktrees_or_paths_outside_candidates', { timeout: TEST_TIMEOUT_MS }, async () => {
  fakeClock()
  const start = Date.now()

  // neighbours: other branches of the repo, worktrees that are not candidates, a link out of the candidates dir
  git(live, 'branch', 'main', 'live')
  git(live, 'branch', 'stable', 'live')
  git(live, 'tag', 'stable-tag', 'live')
  const foreign = join(root, 'foreign-wt')
  git(live, 'worktree', 'add', '-q', '-b', 'feature-x', foreign, 'live')
  const outsidePrefix = join(root, 'outside-wt')
  git(live, 'worktree', 'add', '-q', '-b', 'candidate-c-outside', outsidePrefix, 'live')
  mkdirSync(candidatesDir, { recursive: true })
  const handMade = join(candidatesDir, 'hand-made')
  git(live, 'worktree', 'add', '-q', '-b', 'hand-made', handMade, 'live')
  const victim = join(root, 'victim')
  put(join(victim, 'precious.txt'), 'do not touch\n')
  git(live, 'branch', 'candidate-c-link', 'live')
  symlinkSync(victim, join(candidatesDir, 'c-link'))
  for (const dir of [foreign, outsidePrefix, handMade]) put(join(dir, 'work.txt'), 'uncommitted work\n')
  const shas = Object.fromEntries(
    ['live', 'main', 'stable', 'feature-x', 'hand-made', 'candidate-c-outside', 'candidate-c-link'].map((branch) => [
      branch,
      git(live, 'rev-parse', branch),
    ]),
  )

  const previous = makeEvolve()
  const stale = await openCandidate(previous)

  vi.clearAllTimers()
  vi.setSystemTime(start + 30 * DAY)
  const evolve = makeEvolve()
  await until(() => isGone(stale) && !hasRecord(stale.id), 'the 30 day old candidate to be removed at start')
  await vi.advanceTimersByTimeAsync(3 * DAY)
  await settle()

  const refused = ['main', 'live', 'stable', 'feature-x', 'hand-made', 'c-outside', 'c-link', '../foreign-wt', '../victim', 'candidate-c-outside']
  for (const id of refused) {
    await attempt(() => evolve.reject(id))
    await attempt(() => tool(evolve, 'self_discard').execute({ id }))
  }
  await vi.advanceTimersByTimeAsync(3 * DAY)
  await settle()

  for (const [branch, sha] of Object.entries(shas)) {
    expect(hasBranch(branch), `branch ${branch} survives the cleanup`).toBe(true)
    expect(git(live, 'rev-parse', branch), `branch ${branch} did not move`).toBe(sha)
  }
  expect(git(live, 'rev-parse', 'stable-tag')).toBe(shas.live)
  expect(git(live, 'symbolic-ref', 'HEAD'), 'the live checkout is still on live').toBe('refs/heads/live')
  expect(worktreePaths(), 'the live checkout stays a worktree').toContain(live)
  for (const dir of [foreign, outsidePrefix, handMade]) {
    expect(worktreePaths(), `${dir} stays a worktree`).toContain(dir)
    expect(readFileSync(join(dir, 'work.txt'), 'utf8'), `${dir} keeps its files`).toBe('uncommitted work\n')
  }
  expect(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'a link out of the candidates directory is not followed').toBe(
    'do not touch\n',
  )
  expect(existsSync(join(live, 'notes.md')), 'the live files stay').toBe(true)
})

// --- [log] -----------------------------------------------------------------------------------------

test('test_log_every_removal_is_a_line_with_the_candidate_id_and_the_reason', { timeout: TEST_TIMEOUT_MS }, async () => {
  fakeClock()
  const evolve = makeEvolve()
  const rejected = await passedCandidate(evolve)
  const discarded = await openCandidate(evolve)
  const expired = await openCandidate(evolve)
  const kept = await passedCandidate(evolve)
  logLines = []

  await evolve.reject(rejected.id)
  await tool(evolve, 'self_discard').execute({ id: discarded.id })
  expectGone(rejected, 'reject')
  expectGone(discarded, 'discard')
  expect(
    linesAbout(expired.id).filter((line) => /удал|remov|delet/i.test(line)),
    'a candidate that is still alive is not logged as removed',
  ).toEqual([])

  await vi.advanceTimersByTimeAsync(49 * HOUR)
  await until(
    () => isGone(expired) && !hasRecord(expired.id) && linesAbout(expired.id).length > 0,
    'the expired candidate to be removed',
  )

  const rejectLines = linesAbout(rejected.id)
  const discardLines = linesAbout(discarded.id)
  const ttlLines = linesAbout(expired.id)
  expect(rejectLines.length, `reject is logged: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
  expect(discardLines.length, `discard is logged: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
  expect(ttlLines.length, `the TTL removal is logged: ${JSON.stringify(logLines)}`).toBeGreaterThan(0)
  expect(rejectLines.some((line) => /reject|отклон|отказ|отверг/i.test(line)), JSON.stringify(rejectLines)).toBe(true)
  expect(discardLines.some((line) => /discard|отказ|отмен|сброс|отброш|убра|удал/i.test(line)), JSON.stringify(discardLines)).toBe(true)
  expect(
    ttlLines.some((line) => /ttl|суток|сутки|час|истёк|истек|протух|устар|stale|expire|старше|давн/i.test(line)),
    JSON.stringify(ttlLines),
  ).toBe(true)

  const reasons = new Set([
    withoutId(rejectLines.join('\n'), rejected.id),
    withoutId(discardLines.join('\n'), discarded.id),
    withoutId(ttlLines.join('\n'), expired.id),
  ])
  expect(reasons.size, 'the three reasons are told apart in the log').toBe(3)
  expect(linesAbout(kept.id).filter((line) => /удал|remov|delet/i.test(line)), 'a waiting card is not removed or logged').toEqual([])
  expectIntact(kept, 'the candidate with a waiting card')
})

// --- [async] ---------------------------------------------------------------------------------------

const SLOW_REMOVE_MS = 1_500
const MAX_TIMER_GAP_MS = 500

/** The real git binary, found before PATH points at the slow double. */
function realGitPath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, 'git'))) return join(dir, 'git')
  }
  throw new Error('git is not on PATH')
}

/**
 * A git double for the evolve process only (the helpers above keep their own PATH): `worktree remove` waits
 * SLOW_REMOVE_MS and records that it ran, everything is then the real git.
 */
function slowWorktreeRemove(): { bin: string; marker: string } {
  const bin = join(root, 'slow-bin')
  const marker = join(root, 'slow-remove.log')
  put(
    join(bin, 'git'),
    `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process')
const args = process.argv.slice(2)
async function main() {
  if (args[0] === 'worktree' && args[1] === 'remove') {
    await new Promise((resolve) => setTimeout(resolve, ${SLOW_REMOVE_MS}))
    fs.appendFileSync(${JSON.stringify(marker)}, args.join(' ') + '\\n')
  }
  const result = cp.spawnSync(${JSON.stringify(realGitPath())}, args, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
main().catch((error) => { console.error(error); process.exit(1) })
`,
  )
  chmodSync(join(bin, 'git'), 0o755)
  return { bin, marker }
}

/** Run one step with a 100 ms timer beside it; the longest pause between its ticks. */
async function longestTimerGap<T>(run: () => Promise<T>): Promise<{ result: T; gap: number; elapsed: number }> {
  const started = performance.now()
  let last = started
  let gap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    gap = Math.max(gap, now - last)
    last = now
  }, 100)
  try {
    const result = await run()
    gap = Math.max(gap, performance.now() - last)
    return { result, gap, elapsed: performance.now() - started }
  } finally {
    clearInterval(timer)
  }
}

async function withPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH
  process.env.PATH = [bin, previous ?? ''].join(delimiter)
  try {
    return await run()
  } finally {
    process.env.PATH = previous
  }
}

test('test_async_a_slow_worktree_remove_after_a_red_sync_gate_does_not_block_the_event_loop', { timeout: TEST_TIMEOUT_MS }, async () => {
  // origin/main is live plus one commit, so the synchronization cuts a candidate; its tests are red.
  const origin = join(root, 'origin.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(live, 'remote', 'add', 'origin', origin)
  const upstream = git(live, 'commit-tree', '-p', 'live', '-m', 'upstream change', 'live^{tree}')
  git(live, 'push', '-q', 'origin', `${upstream}:refs/heads/main`)
  const evolve = createEvolve({
    home,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'looks fine' }),
    sandbox: () => ({ ok: false, status: 1, output: 'fixture: candidate tests are red' }),
    card: async (card) => {
      cards.push(card)
    },
    log: (message) => {
      logLines.push(message)
    },
  })
  const slow = slowWorktreeRemove()

  const { result: report, gap, elapsed } = await withPath(slow.bin, () => longestTimerGap(() => evolve.syncMain()))

  expect(report.state, JSON.stringify(report)).toBe('gate-failed')
  const id = report.candidate as string
  expect(readFileSync(slow.marker, 'utf8'), 'the slow worktree remove of the candidate ran').toContain(join(candidatesDir, id))
  expect(elapsed, 'the synchronization waited for the slow removal').toBeGreaterThanOrEqual(SLOW_REMOVE_MS)
  expect(gap, `a 100 ms timer paused for ${Math.round(gap)} ms during the removal`).toBeLessThan(MAX_TIMER_GAP_MS)
  expectGone({ id, path: join(candidatesDir, id) }, 'red synchronization gate')
  expect(linesAbout(id).some((line) => line.includes('кандидат синхронизации не прошёл гейт')), JSON.stringify(logLines)).toBe(true)
  expect(git(live, 'rev-parse', 'live'), 'live did not move').not.toBe(upstream)
})

test('test_async_self_discard_of_a_slow_worktree_does_not_block_the_event_loop', { timeout: TEST_TIMEOUT_MS }, async () => {
  const evolve = makeEvolve()
  const made = await openCandidate(evolve)
  const slow = slowWorktreeRemove()

  const { gap, elapsed } = await withPath(slow.bin, () =>
    longestTimerGap(async () => tool(evolve, 'self_discard').execute({ id: made.id })),
  )

  expect(readFileSync(slow.marker, 'utf8'), 'the slow worktree remove of the candidate ran').toContain(made.path)
  expect(elapsed, 'self_discard waited for the slow removal').toBeGreaterThanOrEqual(SLOW_REMOVE_MS)
  expect(gap, `a 100 ms timer paused for ${Math.round(gap)} ms during the removal`).toBeLessThan(MAX_TIMER_GAP_MS)
  expectGone(made, 'self_discard with a slow worktree remove')
})
