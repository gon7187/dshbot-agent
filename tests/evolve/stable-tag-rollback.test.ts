// Rollback after a plain rollout (DESIGN §8.3): `stable` must never become an unverified HEAD.
//
// `live` is a temporary git repository on the branch `live`, DSHBOT_HOME a temporary directory. The
// adoption script of the repository is copied into the live repo and run the way ExecStartPre runs it
// (one run = one service start, no adopt.json). A healthy start is marked by the real `markHealthy` of
// packages/evolve, so the state file is the one the daemon writes, not a hand-made one.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createEvolve } from '../../packages/evolve/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let root = ''
let home = ''
let live = ''
/** the first commit of live */
let commitA = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: root, ...GIT_IDENTITY },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** A new commit on the branch live, the way a fast-forward rollout brings new code. */
function commitOnLive(text: string): string {
  writeFileSync(join(live, 'notes.md'), text)
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', text.trim())
  return git(live, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-stable-test-')))
  home = join(root, 'dshbot-home')
  live = join(home, 'app')
  mkdirSync(join(live, 'scripts'), { recursive: true })
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'config', 'user.name', 'Test')
  git(live, 'config', 'user.email', 'test@example.invalid')
  cpSync(join(repoRoot, 'scripts', 'adopt.sh'), join(live, 'scripts', 'adopt.sh'))
  commitA = commitOnLive('code A\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** One service start: ExecStartPre runs the adoption script in the live directory. */
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

/** The daemon's own health marker, bound to the temporary home and live checkout. */
async function markHealthy(): Promise<void> {
  const evolve = createEvolve({
    home,
    live,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    card: async () => {},
    reviewer: async () => '',
  })
  await evolve.markHealthy()
}

function stateValue(key: string): string | undefined {
  const text = readFileSync(join(home, 'evolve-state'), 'utf8')
  const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`))
  return line === undefined ? undefined : line.slice(key.length + 1).trim()
}

// --- [keep] ----------------------------------------------------------------------------------------

test('test_c1_keep_mark_healthy_writes_stable_sha_into_evolve_state', async () => {
  const first = startPre()
  expect(first.status, `adopt.sh must succeed\n${first.output}`).toBe(0)

  await markHealthy()

  const tagged = git(live, 'rev-parse', 'stable^{commit}')
  expect(tagged, 'markHealthy tags the healthy HEAD as stable').toBe(commitA)
  expect(stateValue('healthy'), 'a healthy start is recorded').toBe('1')
  expect(stateValue('stable'), 'evolve-state keeps stable = the sha that markHealthy tagged').toBe(tagged)
})

// --- [deploy] --------------------------------------------------------------------------------------

test('test_c2_deploy_plain_rollout_that_keeps_crashing_rolls_back_to_the_healthy_commit', async () => {
  const first = startPre()
  expect(first.status, `the start of A must succeed\n${first.output}`).toBe(0)
  await markHealthy()

  // rollout of B: live is fast-forwarded, no adopt.json
  const commitB = commitOnLive('code B\n')
  expect(commitB).not.toBe(commitA)
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)

  // B starts and dies three times before the health timer; the next start must roll back
  for (let start = 1; start <= 4; start += 1) {
    const run = startPre()
    expect(run.status, `start ${start} must not fail\n${run.output}`).toBe(0)
    if (start < 4) expect(git(live, 'rev-parse', 'HEAD'), `start ${start}: B is not rolled back yet`).toBe(commitB)
  }

  expect(git(live, 'rev-parse', 'HEAD'), 'live goes back to the healthy commit A, not to B').toBe(commitA)
  expect(git(live, 'symbolic-ref', 'HEAD'), 'live stays a branch').toBe('refs/heads/live')

  const rollback = JSON.parse(readFileSync(join(home, 'rollback.json'), 'utf8')) as Record<string, unknown>
  expect(rollback.from, 'the rollback notice names the broken commit').toBe(commitB)
  expect(rollback.stable, 'the rollback notice names the healthy commit').toBe(commitA)
})

// --- [tag] -----------------------------------------------------------------------------------------

test('test_c3_tag_missing_stable_in_state_is_taken_from_the_git_tag_not_head', () => {
  git(live, 'tag', '-f', 'stable', commitA)
  const commitB = commitOnLive('code B\n')
  // a state of a start that lost its stable line
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'evolve-state'), `started_at=${Math.floor(Date.now() / 1000)}\nhealthy=1\ncrashes=\n`)

  const run = startPre()

  expect(run.status, `adopt.sh must succeed\n${run.output}`).toBe(0)
  expect(git(live, 'rev-parse', 'HEAD'), 'a plain start does not move live').toBe(commitB)
  expect(stateValue('stable'), 'stable comes from the git tag, not from HEAD').toBe(commitA)
  expect(git(live, 'rev-parse', 'stable^{commit}'), 'the stable tag is not moved to the unverified HEAD').toBe(commitA)
})
