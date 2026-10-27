// Adoption and rollback of the bot's live code (DESIGN §8.3), without systemd and without the daemon.
//
// `live` is a temporary git repository on the branch `live`; it stands where DSHBOT_HOME/app stands in a
// real install, and DSHBOT_HOME itself is a temporary directory (the substituted state). The adoption
// script of the repository is copied into that live repo and run the way ExecStartPre runs it: working
// directory = live, DSHBOT_HOME in the environment, one run per service start.
//
// The crash fuse is observed from the outside: every run of the script is one service start, and a
// service that keeps dying right after the adopted start is simulated by running the script again and
// again with nothing marking the bot healthy in between.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

interface Fixture {
  root: string
  /** DSHBOT_HOME */
  home: string
  /** the live repository: DSHBOT_HOME/app */
  live: string
  /** the commit on which `live` and `stable` start */
  base: string
}

let fixture: Fixture

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: fixture.root, ...GIT_IDENTITY },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-adopt-test-')))
  const home = join(root, 'dshbot-home')
  const live = join(home, 'app')
  mkdirSync(live, { recursive: true })
  fixture = { root, home, live, base: '' }

  git(live, 'init', '-q', '-b', 'live')
  git(live, 'config', 'user.name', 'Test')
  git(live, 'config', 'user.email', 'test@example.invalid')
  // the code of the repository that ExecStartPre depends on, as it sits in a real live checkout
  for (const entry of ['scripts', 'packages', 'persona', 'package.json', 'tsconfig.json', 'CHARTER.md', 'CHECKLIST.md']) {
    const from = join(repoRoot, entry)
    if (existsSync(from)) cpSync(from, join(live, entry), { recursive: true })
  }
  put(join(live, '.gitignore'), 'node_modules/\n')
  put(join(live, 'notes.md'), 'base notes\n')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
  fixture.base = git(live, 'rev-parse', 'HEAD')
  git(live, 'tag', 'stable', fixture.base)
  return fixture
}

beforeEach(() => {
  makeFixture()
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

/** A candidate worktree off `live` with one commit; returns the commit. */
function makeCandidate(id: string, file: string, content: string): string {
  const path = join(fixture.home, 'candidates', id)
  git(fixture.live, 'worktree', 'add', '-q', '-b', `candidate-${id}`, path, 'live')
  put(join(path, file), content)
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', `candidate ${id}`)
  return git(path, 'rev-parse', 'HEAD')
}

function writeAdopt(sha: string): void {
  writeFileSync(join(fixture.home, 'adopt.json'), `${JSON.stringify({ sha })}\n`)
}

/** One service start: ExecStartPre runs the adoption script in the live directory. */
function startPre(): { status: number | null; output: string } {
  const script = join(fixture.live, 'scripts', 'adopt.sh')
  const result = spawnSync('bash', [script], {
    cwd: fixture.live,
    encoding: 'utf8',
    env: {
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      HOME: fixture.root,
      DSHBOT_HOME: fixture.home,
      ...GIT_IDENTITY,
    },
    timeout: 60_000,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const head = (): string => git(fixture.live, 'rev-parse', 'HEAD')

// --- [adopt] ---------------------------------------------------------------------------------------

test('test_adopt_switches_live_to_the_candidate_sha_and_removes_adopt_json', () => {
  const sha = makeCandidate('c1', 'notes.md', 'candidate notes\n')
  writeAdopt(sha)

  const run = startPre()

  expect(run.status, `adopt.sh must succeed\n${run.output}`).toBe(0)
  expect(head(), 'live must stand on the candidate sha').toBe(sha)
  expect(readFileSync(join(fixture.live, 'notes.md'), 'utf8'), 'the working tree of live must hold the candidate files').toBe(
    'candidate notes\n',
  )
  expect(existsSync(join(fixture.home, 'adopt.json')), 'adopt.json is consumed by the adoption').toBe(false)
  expect(git(fixture.live, 'status', '--porcelain'), 'live stays clean').toBe('')
})

test('test_adopt_without_adopt_json_leaves_live_alone', () => {
  const sha = makeCandidate('c2', 'notes.md', 'candidate notes\n')

  const run = startPre()

  expect(run.status, `adopt.sh must succeed when there is nothing to adopt\n${run.output}`).toBe(0)
  expect(head(), 'live is not switched without adopt.json').toBe(fixture.base)
  expect(head()).not.toBe(sha)
  expect(readFileSync(join(fixture.live, 'notes.md'), 'utf8')).toBe('base notes\n')
})

// --- [h1] adoption keeps HEAD of live on the branch live -------------------------------------------

test('test_h1_adopt_moves_the_live_branch_to_the_sha_instead_of_detaching_head', () => {
  const sha = makeCandidate('c3', 'notes.md', 'candidate notes\n')
  writeAdopt(sha)

  const run = startPre()

  expect(run.status, `adopt.sh must succeed\n${run.output}`).toBe(0)
  expect(git(fixture.live, 'symbolic-ref', 'HEAD'), 'HEAD of live is always the branch live').toBe('refs/heads/live')
  expect(git(fixture.live, 'rev-parse', 'refs/heads/live'), 'the branch live points to the adopted sha').toBe(sha)
  expect(head()).toBe(sha)
})

// --- [rollback] ------------------------------------------------------------------------------------

test('test_rollback_three_crashes_in_a_row_return_live_to_the_stable_tag', () => {
  const bad = makeCandidate('c4', 'notes.md', 'broken candidate\n')
  expect(bad).not.toBe(fixture.base)
  writeAdopt(bad)

  const first = startPre()
  expect(first.status, `the adopting start must succeed\n${first.output}`).toBe(0)
  expect(head(), 'the first start adopts the candidate').toBe(bad)

  // the adopted code dies right after each start, nothing marks it healthy: restarts within 120 s
  const second = startPre()
  expect(second.status, second.output).toBe(0)
  expect(head(), 'one crash is not enough to roll back').toBe(bad)

  let rolledBackAt = 0
  for (let start = 3; start <= 6; start += 1) {
    const run = startPre()
    expect(run.status, `start ${start} must not fail\n${run.output}`).toBe(0)
    if (head() === fixture.base) {
      rolledBackAt = start
      break
    }
  }

  expect(rolledBackAt, 'the crash fuse must roll live back to the stable tag').toBeGreaterThan(0)
  expect(head(), 'live stands on the stable sha').toBe(git(fixture.live, 'rev-parse', 'stable^{commit}'))
  expect(readFileSync(join(fixture.live, 'notes.md'), 'utf8'), 'the files of live are the stable ones').toBe('base notes\n')
  expect(existsSync(join(fixture.home, 'adopt.json'))).toBe(false)
})

// --- [unit] ----------------------------------------------------------------------------------------

interface Unit {
  /** values of every occurrence of a key, in file order */
  values(section: string, key: string): string[]
}

function parseUnit(text: string): Unit {
  const sections = new Map<string, Map<string, string[]>>()
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = header[1] as string
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    const keys = sections.get(current) ?? new Map<string, string[]>()
    keys.set(key, [...(keys.get(key) ?? []), value])
    sections.set(current, keys)
  }
  return { values: (section, key) => sections.get(section)?.get(key) ?? [] }
}

test('test_unit_runs_adopt_sh_before_start_and_restarts_on_exit_42', () => {
  const unit = parseUnit(readFileSync(join(repoRoot, 'deploy', 'dshbot.service'), 'utf8'))

  const pre = unit.values('Service', 'ExecStartPre')
  expect(
    pre.some((value) => value.includes('scripts/adopt.sh')),
    `ExecStartPre must run scripts/adopt.sh, got ${JSON.stringify(pre)}`,
  ).toBe(true)

  const tokens = (key: string): string[] => unit.values('Service', key).flatMap((value) => value.split(/\s+/)).filter((t) => t !== '')
  const prevent = tokens('RestartPreventExitStatus')
  expect(prevent, '/panic (77) keeps the service down').toContain('77')
  expect(prevent, 'exit 42 is the adoption restart: it must not be prevented').not.toContain('42')
  // An intentional restart (adoption 42, /restart 75) is a successful exit for
  // OnFailure, but RestartForceExitStatus must still bring the daemon back.
  for (const code of ['42', '75']) {
    expect(tokens('SuccessExitStatus'), `exit ${code} is an intentional restart`).toContain(code)
    expect(tokens('RestartForceExitStatus'), `exit ${code} still restarts the daemon`).toContain(code)
    expect(prevent, `exit ${code} must not keep the service down`).not.toContain(code)
  }
  expect(unit.values('Service', 'Restart')).toEqual(['on-failure'])
})
