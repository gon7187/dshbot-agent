// The metadata record of a self-rewrite candidate (DSHBOT_HOME/evolve-candidates.json) must follow the adoption.
//
// A candidate whose commit is already in the history of the live checkout is adopted, whatever the record of the
// previous process says: it must not stay `open` or `passed`, because pendingCandidates() then keeps blocking
// the next /evolve cycle for a card nobody can press any more.
//
// Every test builds a real temporary `live` repository (branch `live`) and a candidate worktree per record the
// way the daemon cuts them, then drives the real packages/evolve through createEvolve() with the usual seams for
// the sandbox and the reviewer. The "previous process" is the metadata file written before createEvolve().

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createEvolve, type Evolve } from '../../packages/evolve/src/index.js'

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

const OPEN_ADOPTED = 'c-recopen1-11111111'
const PASSED_ADOPTED = 'c-recpass1-22222222'
const OPEN_FRESH = 'c-recfresh-33333333'
const PASSED_WAITING = 'c-recwait1-44444444'

let root = ''
let home = ''
let live = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  records = {}
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-candidate-record-')))
  home = join(root, 'home')
  live = join(home, 'app')
  put(join(live, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
  put(join(live, 'notes.md'), 'original notes\n')
  put(join(live, '.gitignore'), 'node_modules/\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeEvolve(): Evolve {
  return createEvolve({
    home,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'looks fine' }),
    sandbox: () => ({ ok: true, status: 0, output: '' }),
    card: async () => undefined,
    log: () => undefined,
  })
}

interface CandidateRecord {
  id: string
  createdAt: number
  status: string
  passedAt?: number
  sha?: string
}

let records: Record<string, CandidateRecord> = {}

/** A candidate worktree cut from the current live; with a file it also carries one commit. */
function cutCandidate(id: string, file?: string): string {
  const path = join(home, 'candidates', id)
  git(live, 'worktree', 'add', '-q', '-b', `candidate-${id}`, path, 'live')
  if (file === undefined) return git(path, 'rev-parse', 'HEAD')
  put(join(path, file), `edited by ${id}\n`)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', `evolve: ${id}`)
  return git(path, 'rev-parse', 'HEAD')
}

function writeRecords(): void {
  put(join(home, 'evolve-candidates.json'), `${JSON.stringify({ version: 1, candidates: records }, null, 2)}\n`)
}

function statusOf(id: string): string | undefined {
  const parsed = JSON.parse(readFileSync(join(home, 'evolve-candidates.json'), 'utf8')) as {
    candidates?: Record<string, { status?: string }>
  }
  return parsed.candidates?.[id]?.status
}

/**
 * The state that the adoption leaves behind (the live case): two candidates whose commits are in live although the
 * metadata still says `open` / `passed`, plus two that must stay pending: a cut worktree without a commit and a
 * card whose commit is not in live.
 */
function prepareRecords(): void {
  const now = Date.now()
  const openSha = cutCandidate(OPEN_ADOPTED, 'a.md')
  git(live, 'merge', '-q', '--ff-only', `candidate-${OPEN_ADOPTED}`)
  const passedSha = cutCandidate(PASSED_ADOPTED, 'b.md')
  git(live, 'merge', '-q', '--ff-only', `candidate-${PASSED_ADOPTED}`)
  // live moves on: the adopted commits are ancestors of HEAD, not HEAD itself
  put(join(live, 'later.md'), 'later\n')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'later')
  cutCandidate(OPEN_FRESH)
  const waitingSha = cutCandidate(PASSED_WAITING, 'c.md')
  records[OPEN_ADOPTED] = { id: OPEN_ADOPTED, createdAt: now - 4_000, status: 'open', sha: openSha }
  records[PASSED_ADOPTED] = { id: PASSED_ADOPTED, createdAt: now - 4_000, status: 'passed', passedAt: now - 3_000, sha: passedSha }
  records[OPEN_FRESH] = { id: OPEN_FRESH, createdAt: now - 2_000, status: 'open' }
  records[PASSED_WAITING] = { id: PASSED_WAITING, createdAt: now - 2_000, status: 'passed', passedAt: now - 1_000, sha: waitingSha }
  writeRecords()
}

function pendingIds(evolve: Evolve): string[] {
  return evolve.pendingCandidates().map((candidate) => candidate.id).sort()
}

const STILL_WAITING = [OPEN_FRESH, PASSED_WAITING].sort()

test('test_record_start_marks_open_and_passed_records_with_a_sha_in_live_as_accepted', () => {
  prepareRecords()

  const evolve = makeEvolve()

  expect(pendingIds(evolve), 'only the candidates that really wait for a decision block the next cycle').toEqual(STILL_WAITING)
  for (const id of [OPEN_ADOPTED, PASSED_ADOPTED]) {
    const status = statusOf(id)
    expect(status === undefined || status === 'accepted', `${id}: the adopted record is accepted (or gone), got ${String(status)}`).toBe(true)
  }
  expect(statusOf(OPEN_FRESH), 'a cut worktree without a commit is still open').toBe('open')
  expect(statusOf(PASSED_WAITING), 'a card whose commit is not in live still waits').toBe('passed')
  expect(existsSync(join(home, 'candidates', PASSED_WAITING)), 'and keeps its worktree').toBe(true)
})

test('test_record_mark_healthy_leaves_no_open_or_passed_record_of_an_adopted_candidate', async () => {
  prepareRecords()
  const evolve = makeEvolve()

  await evolve.markHealthy()

  expect(pendingIds(evolve), 'pendingCandidates() does not return the adopted candidates').toEqual(STILL_WAITING)
  for (const id of [OPEN_ADOPTED, PASSED_ADOPTED]) {
    const status = statusOf(id)
    expect(status === undefined || status === 'accepted', `${id}: after markHealthy the record is accepted or deleted, got ${String(status)}`).toBe(true)
  }
  expect(statusOf(PASSED_WAITING), 'markHealthy does not touch a card that still waits').toBe('passed')
  expect(statusOf(OPEN_FRESH), 'nor a candidate in progress').toBe('open')
})
