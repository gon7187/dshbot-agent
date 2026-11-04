import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'

import { createEvolve, sandboxedTests } from '../../packages/evolve/src/index.js'

// Observe the real invocation, without replacing git or executing a candidate's tests.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('test_h4_sync_replays_an_evolve_commit_without_the_shell_gate_c_flag', async () => {
  // Use the same real live repository and createEvolve seams as candidate-record-adopted.test.ts.
  // The remote is another local directory: no network, dependency installation or test subprocess.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-sync-git-')))
  try {
    const home = join(root, 'home')
    const live = join(home, 'app')
    const origin = join(root, 'origin')
    mkdirSync(live, { recursive: true })
    mkdirSync(origin)
    git(origin, 'init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'notes.md'), 'base notes\n')
    writeFileSync(join(origin, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
    git(origin, 'add', 'notes.md', 'CHECKLIST.md')
    git(origin, 'commit', '-q', '-m', 'base')
    git(live, 'init', '-q', '-b', 'live')
    git(live, 'remote', 'add', 'origin', origin)
    git(live, 'fetch', '-q', 'origin')
    git(live, 'reset', '-q', '--hard', 'origin/main')

    writeFileSync(join(live, 'own.md'), 'preserved evolve change\n')
    git(live, 'add', 'own.md')
    git(live, 'commit', '-q', '-m', 'evolve: preserve own notes')
    const ownSha = git(live, 'rev-parse', 'HEAD')
    writeFileSync(join(origin, 'upstream.md'), 'new main change\n')
    git(origin, 'add', 'upstream.md')
    git(origin, 'commit', '-q', '-m', 'new upstream notes')

    // Signing must stay disabled even when the application's local config requests it.
    git(live, 'config', 'commit.gpgsign', 'true')
    git(live, 'config', 'gpg.program', join(root, 'missing-signing-program'))
    const sandbox = vi.fn(() => ({ ok: true, status: 0, output: '' }))
    const evolve = createEvolve({
      home,
      live,
      ownerHome: root,
      review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
      reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'ok' }),
      sandbox,
      card: async () => undefined,
      log: () => undefined,
    })
    vi.mocked(spawn).mockClear()

    const report = await evolve.syncMain()

    expect(report.state, JSON.stringify(report)).toBe('adopted')
    expect(sandbox).toHaveBeenCalledOnce()
    expect(report.ownChanges).toEqual(['evolve: preserve own notes'])
    // The gate replays asynchronously (spawn), so the daemon keeps polling meanwhile.
    const replays = vi.mocked(spawn).mock.calls.filter(([command, args]) =>
      command === 'git' && Array.isArray(args) && args.includes('cherry-pick') && args.includes(ownSha),
    )
    expect(replays, 'the real sync must execute the evolve cherry-pick').toHaveLength(1)
    for (const [, args] of replays) {
      expect(args, 'git configuration must not use the -c argument rejected by the host-shell gate').not.toContain('-c')
    }
  } finally {
    vi.mocked(spawn).mockClear()
    rmSync(root, { recursive: true, force: true })
  }
})


test.each(['main', 'live'])('sync refuses adoption when %s advances during the gate', async (advanced) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-sync-stale-')))
  try {
    const home = join(root, 'home')
    const live = join(home, 'app')
    const origin = join(root, 'origin')
    mkdirSync(live, { recursive: true })
    mkdirSync(origin)
    git(origin, 'init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'base.md'), 'base\n')
    writeFileSync(join(origin, 'CHECKLIST.md'), '# Review checklist\n- preserve owner data\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-q', '-m', 'base')
    git(live, 'init', '-q', '-b', 'live')
    git(live, 'remote', 'add', 'origin', origin)
    git(live, 'fetch', '-q', 'origin')
    git(live, 'reset', '-q', '--hard', 'origin/main')
    const originalLive = git(live, 'rev-parse', 'HEAD')
    writeFileSync(join(origin, 'incoming.md'), 'incoming\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-q', '-m', 'incoming main')
    let expectedLive = originalLive
    const sandbox = vi.fn(() => {
      const changed = advanced === 'main' ? origin : live
      writeFileSync(join(changed, 'during-gate.md'), 'changed while gates ran\n')
      git(changed, 'add', '.')
      git(changed, 'commit', '-q', '-m', 'concurrent change')
      if (advanced === 'live') expectedLive = git(live, 'rev-parse', 'HEAD')
      return { ok: true, status: 0, output: '' }
    })
    const evolve = createEvolve({
      home, live, ownerHome: root,
      review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
      reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'ok' }),
      sandbox, card: async () => undefined, log: () => undefined,
    })
    const report = await evolve.syncMain()
    expect(sandbox).toHaveBeenCalledOnce()
    expect(report.state, JSON.stringify(report)).toBe('gate-failed')
    expect(report.error).toContain(advanced === 'main' ? 'origin/main' : 'HEAD live')
    expect(existsSync(join(home, 'adopt.json'))).toBe(false)
    expect(git(live, 'rev-parse', 'HEAD')).toBe(expectedLive)
    expect(report.candidate).toBeDefined()
    expect(existsSync(join(home, 'candidates', report.candidate!))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test.skipIf(spawnSync('bwrap', ['--unshare-net', '--ro-bind', '/', '/', '/bin/true']).status !== 0).each(['passes', 'fails'])(
  'sync full gate %s with disposable read-only Git metadata while owner metadata stays hidden',
  { timeout: 30_000 }, async (outcome) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-sync-git-view-')))
    try {
      const home = join(root, 'home')
      const live = join(home, 'app')
      const origin = join(root, 'origin')
      mkdirSync(live, { recursive: true })
      mkdirSync(origin)
      writeFileSync(join(root, 'owner-private'), 'OWNER-PRIVATE-SENTINEL')
      git(origin, 'init', '-q', '-b', 'main')
      writeFileSync(join(origin, 'CHECKLIST.md'), '# Review\n- preserve owner privacy\n')
      writeFileSync(join(origin, 'package.json'), JSON.stringify({ private: true,
        scripts: { test: 'node check.mjs', gate: 'node -e "process.exit(99)"' } }))
      writeFileSync(join(origin, 'check.mjs'), `import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert.equal(process.env.GIT_DIR, undefined)
assert.match(git('ls-files', '--error-unmatch', 'vitest.config.ts'), /vitest.config.ts/)
assert.equal(git('log', '-1', '--format=%s'), 'Engineering candidate snapshot')
assert.equal(git('remote'), '')
assert.equal(existsSync(${JSON.stringify(join(root, 'owner-private'))}), false)
assert.equal(existsSync(${JSON.stringify(join(live, '.git/config'))}), false)
assert.equal(readFileSync('.git', 'utf8').includes(${JSON.stringify(root)}), false)
assert.notEqual(spawnSync('git', ['add', 'package.json']).status, 0)
assert.throws(() => writeFileSync('.git', 'changed'))
console.log('sync-full-git-view-ready')
process.exit(${outcome === 'fails' ? 17 : 0})
`)
      git(origin, 'add', '.')
      git(origin, 'commit', '-q', '-m', 'Owner private history sentinel')
      git(live, 'init', '-q', '-b', 'live')
      git(live, 'remote', 'add', 'origin', origin)
      git(live, 'fetch', '-q', 'origin')
      git(live, 'reset', '-q', '--hard', 'origin/main')
      const liveHead = git(live, 'rev-parse', 'HEAD')
      writeFileSync(join(origin, 'vitest.config.ts'), 'export default {}\n')
      git(origin, 'add', '.')
      git(origin, 'commit', '-q', '-m', 'Main: change test configuration')
      let view: { directory: string; pointerFile: string } | undefined
      let originalPointer = ''
      let gateOutput = ''
      const evolve = createEvolve({
        home, live, ownerHome: root,
        review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
        reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'ok' }),
        sandbox: async (options) => {
          view = options.gitView
          originalPointer = readFileSync(join(options.candidate, '.git'), 'utf8')
          expect(options.command).toEqual(['npm', 'test'])
          const result = await sandboxedTests(options)
          gateOutput = result.output
          expect(readFileSync(join(options.candidate, '.git'), 'utf8')).toBe(originalPointer)
          return result
        },
        card: async () => undefined, log: () => undefined,
      })
      const report = await evolve.syncMain()
      expect(report.state, `${JSON.stringify(report)}\n${gateOutput}`).toBe(outcome === 'passes' ? 'adopted' : 'gate-failed')
      expect(gateOutput).toContain('sync-full-git-view-ready')
      expect(view).toBeDefined()
      expect(existsSync(view!.directory)).toBe(false)
      expect(existsSync(view!.pointerFile)).toBe(false)
      if (outcome === 'passes') expect(readFileSync(join(home, 'candidates', report.candidate!, '.git'), 'utf8')).toBe(originalPointer)
      else expect(existsSync(join(home, 'adopt.json'))).toBe(false)
      expect(git(live, 'rev-parse', 'HEAD')).toBe(liveHead)
      expect(readFileSync(join(root, 'owner-private'), 'utf8')).toBe('OWNER-PRIVATE-SENTINEL')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
