// ExecStartPre contract, with the same temporary live/candidate layout as
// adopt-script.test.ts. npm is a local recording double: no install or network.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
interface World { root: string; home: string; live: string; bin: string; log: string; base: string; modulesInode: number }
interface NpmCall { args: string[]; cwd: string; head: string; modulesPresent: boolean }
let world: World
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: world.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY },
  }).trim()
}
beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-adoption-modules-')))
  const home = join(root, 'dshbot')
  world = { root, home, live: join(home, 'app'), bin: join(root, 'bin'), log: join(root, 'npm.jsonl'), base: '', modulesInode: 0 }
  put(join(world.live, '.gitignore'), 'node_modules/\nnode_modules.prev/\n')
  put(join(world.live, 'package.json'), '{"name":"adopt-fixture","private":true}\n')
  put(join(world.live, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n')
  put(join(world.live, 'notes.md'), 'base\n')
  git(world.live, 'init', '-q', '-b', 'live')
  git(world.live, 'add', '-A')
  git(world.live, 'commit', '-q', '-m', 'base')
  world.base = git(world.live, 'rev-parse', 'HEAD')
  git(world.live, 'tag', 'stable')
  // The last healthy tag can lag behind accepted evolve commits. Dependency
  // failure must restore the exact previous HEAD, including those changes.
  put(join(world.live, 'notes.md'), 'accepted evolve change after stable\n')
  git(world.live, 'add', 'notes.md')
  git(world.live, 'commit', '-q', '-m', 'evolve: accepted after stable')
  world.base = git(world.live, 'rev-parse', 'HEAD')
  put(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'original modules, work without network\n')
  world.modulesInode = statSync(join(world.live, 'node_modules')).ino
  writeFileSync(world.log, '')
})
afterEach(() => { rmSync(world.root, { recursive: true, force: true }) })
function candidate(changeLock: boolean): string {
  const path = join(world.home, 'candidates', 'dependencies')
  git(world.live, 'worktree', 'add', '-q', '-b', 'candidate-dependencies', path, 'live')
  put(join(path, 'notes.md'), 'candidate\n')
  if (changeLock) put(join(path, 'package-lock.json'), '{"lockfileVersion":3,"name":"new-dependencies","packages":{}}\n')
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', 'Main: dependencies')
  const sha = git(path, 'rev-parse', 'HEAD')
  put(join(world.home, 'adopt.json'), JSON.stringify({ sha }))
  return sha
}
function npmDouble(fail: boolean | 'new-only'): void {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  put(join(world.bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const args = process.argv.slice(2)
const live = ${JSON.stringify(world.live)}
fs.appendFileSync(${JSON.stringify(world.log)}, JSON.stringify({ args, cwd: process.cwd(),
  head: cp.execFileSync(${JSON.stringify(realGit)}, ['rev-parse','HEAD'], { encoding: 'utf8' }).trim(),
  modulesPresent: fs.existsSync(path.join(live, 'node_modules')) }) + '\\n')
if (!args.includes('ci')) process.exit(0)
fs.rmSync('node_modules', { recursive: true, force: true })
fs.mkdirSync('node_modules', { recursive: true })
fs.writeFileSync('node_modules/new-dependency', 'new or partial installation')
if (${JSON.stringify(fail)} === true || (${JSON.stringify(fail)} === 'new-only' &&
  cp.execFileSync(${JSON.stringify(realGit)}, ['rev-parse','HEAD'], { encoding: 'utf8' }).trim() !== ${JSON.stringify(world.base)})) {
  console.error('fixture dependency installation: offline'); process.exit(1)
}
`)
  chmodSync(join(world.bin, 'npm'), 0o755)
}
function startPre(): void {
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'adopt.sh')], {
    cwd: world.live, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: [world.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      HOME: world.root, DSHBOT_HOME: world.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY,
    },
  })
  expect(result.status, `ExecStartPre must allow the daemon to start\n${result.stdout}${result.stderr}`).toBe(0)
}
function calls(): NpmCall[] {
  return readFileSync(world.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as NpmCall)
}

test('test_c8_changed_lock_installs_new_dependencies_in_live_before_start', () => {
  const sha = candidate(true)
  npmDouble(false)
  startPre()
  const installs = calls().filter((call) => call.args.includes('ci'))
  expect(installs, 'lock change requires dependency installation').toHaveLength(1)
  expect(installs[0], 'old modules are moved aside before the installer starts').toMatchObject({ cwd: world.live, head: sha, modulesPresent: false })
  expect(git(world.live, 'rev-parse', 'live')).toBe(sha)
  expect(readFileSync(join(world.live, 'node_modules', 'new-dependency'), 'utf8')).toContain('installation')
  const backups = readdirSync(world.live, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' &&
    existsSync(join(world.live, entry.name, 'old-dependency', 'index.js')))
  expect(backups, 'successful install discards the saved modules').toEqual([])
  expect(existsSync(join(world.home, 'adopt.json'))).toBe(false)
  expect(existsSync(join(world.home, 'rollback.json'))).toBe(false)
})

test('test_c8_unchanged_lock_skips_installation_and_keeps_modules', () => {
  const sha = candidate(false)
  npmDouble(true)
  startPre()
  expect(git(world.live, 'rev-parse', 'live')).toBe(sha)
  expect(calls()).toEqual([])
  expect(readFileSync(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'utf8')).toBe('original modules, work without network\n')
})

test('test_h1_every_installation_fails_but_saved_modules_restore_offline_and_rollback_is_recorded', () => {
  const sha = candidate(true)
  npmDouble(true)
  startPre()
  expect(git(world.live, 'rev-parse', 'live'), 'failed candidate is rolled back before service start').toBe(world.base)
  expect(calls().filter((call) => call.args.includes('ci')), 'restoring saved modules does not require npm or network').toHaveLength(1)
  expect(calls()[0]).toMatchObject({ head: sha, modulesPresent: false })
  const old = join(world.live, 'node_modules', 'old-dependency', 'index.js')
  expect(existsSync(old), 'the original modules are put back').toBe(true)
  expect(readFileSync(old, 'utf8')).toBe('original modules, work without network\n')
  expect(statSync(join(world.live, 'node_modules')).ino, 'the saved directory itself is restored').toBe(world.modulesInode)
  expect(existsSync(join(world.live, 'node_modules', 'new-dependency')), 'partial new installation is removed').toBe(false)
  expect(existsSync(join(world.home, 'adopt.json'))).toBe(false)
  expect(existsSync(join(world.home, 'adopt-notice.json')), 'rollback cannot be announced as a successful adoption').toBe(false)
  const marker = join(world.home, 'rollback.json')
  expect(existsSync(marker), 'startup notification marker').toBe(true)
  expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ from: sha, stable: world.base })
})


test('test_c8_missing_saved_modules_falls_back_to_installing_previous_commit', () => {
  const sha = candidate(true)
  rmSync(join(world.live, 'node_modules'), { recursive: true })
  npmDouble('new-only')
  startPre()
  expect(git(world.live, 'rev-parse', 'live')).toBe(world.base)
  expect(calls().filter((call) => call.args.includes('ci')).map((call) => call.head)).toEqual([sha, world.base])
  expect(existsSync(join(world.live, 'node_modules', 'new-dependency')), 'fallback installation completes').toBe(true)
  expect(existsSync(join(world.home, 'rollback.json'))).toBe(true)
})
