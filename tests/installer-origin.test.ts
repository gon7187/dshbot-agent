// The installer harness follows installer.test.ts: disposable HOME, real local
// git fixtures, and doubles for npm/systemd. No dependencies, services or network
// are started. Inspect fixture configuration through git, never checkout metadata.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const installer = join(repo, 'scripts/install.sh')
const roots: string[] = []
const identity = {
  GIT_AUTHOR_NAME: 'Installer origin fixture', GIT_AUTHOR_EMAIL: 'installer@example.invalid',
  GIT_COMMITTER_NAME: 'Installer origin fixture', GIT_COMMITTER_EMAIL: 'installer@example.invalid',
}

interface Fixture {
  root: string; source: string; app: string; log: string; env: NodeJS.ProcessEnv
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function gitResult(f: Fixture, cwd: string, ...args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], {
    env: f.env, encoding: 'utf8', timeout: 10_000,
  })
}

function git(f: Fixture, cwd: string, ...args: string[]): string {
  const result = gitResult(f, cwd, ...args)
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

function config(f: Fixture, cwd: string, ...args: string[]): string | null {
  const result = gitResult(f, cwd, 'config', '--local', ...args)
  expect(result.error, result.stderr).toBeUndefined()
  expect([0, 1], result.stderr).toContain(result.status)
  return result.status === 0 ? result.stdout.trim() : null
}

function origin(f: Fixture, cwd = f.app): string | null {
  return config(f, cwd, '--get', 'remote.origin.url')
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-installer-origin-'))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const source = join(root, 'source')
  const f: Fixture = {
    root, source, app: join(home, '.local/share/dshbot/app'), log: join(root, 'commands.jsonl'),
    env: {
      HOME: home, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'), USER: 'installer-fixture', LOGNAME: 'installer-fixture',
      LANG: 'C.UTF-8', DSHBOT_INSTALL_SRC: source, DSHBOT_ISOLATION: 'container',
      TELEGRAM_BOT_TOKEN: '7000001:AAFixtureToken0123456789', DEEPSEEK_API_KEY: 'sk-fixture-only',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'global-gitconfig'),
      GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', ...identity,
    },
  }
  for (const path of [home, bin, source, f.env.TMPDIR!]) mkdirSync(path, { recursive: true })
  writeFileSync(f.log, '')
  symlinkSync(process.execPath, join(bin, 'node'))
  function fake(name: string, body: string): void {
    writeFileSync(join(bin, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({cmd: ${JSON.stringify(name)}, args, cwd: process.cwd()}) + '\\n');
${body}
`, { mode: 0o755 })
  }
  fake('npm', '')
  fake('systemctl', '')
  fake('loginctl', "console.log(args.includes('--value') ? 'yes' : 'Linger=yes');")
  fake('bwrap', '')
  fake('journalctl', '')
  for (const name of ['sudo', 'curl', 'wget', 'npx']) {
    fake(name, "console.error('unexpected external action in installer fixture'); process.exit(91);")
  }
  // Copy only public product inputs, like the adjacent installer tests.
  for (const entry of ['scripts', 'deploy', 'packages', 'persona', 'prompts', 'package.json', 'package-lock.json', 'tsconfig.json', 'CHARTER.md', 'CHECKLIST.md', 'README.md']) {
    cpSync(join(repo, entry), join(source, entry), {
      recursive: true,
      filter: (path) => !basename(path).startsWith('.env') && basename(path) !== 'node_modules' && !path.endsWith('.test.ts'),
    })
  }
  put(join(source, 'installer-origin-fixture.txt'), 'initial revision\n')
  git(f, source, 'init', '-q', '-b', 'main')
  git(f, source, 'add', '-A')
  git(f, source, 'commit', '-q', '-m', 'initial fixture')
  return f
}

function run(f: Fixture, env: NodeJS.ProcessEnv = {}) {
  expect(existsSync(installer), 'installer entry point exists').toBe(true)
  const result = spawnSync('/bin/bash', [installer, '--yes'], {
    cwd: f.root, env: { ...f.env, ...env }, input: '', encoding: 'utf8', timeout: 20_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  expect(result.error, output).toBeUndefined()
  expect(result.status, output).toBe(0)
  const calls = readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { cmd: string; args: string[]; cwd: string })
  expect(calls.some(({ cmd, args, cwd }) => cmd === 'npm' && args.includes('ci') && cwd === f.app),
    'exercise the installer beyond its git preparation; npm is a no-op double').toBe(true)
  return output
}

function remote(f: Fixture, name = 'remote.git'): string {
  const path = join(f.root, name)
  git(f, f.root, 'clone', '-q', '--bare', f.source, path)
  return path
}

function advance(f: Fixture): string {
  put(join(f.source, 'installer-origin-fixture.txt'), 'new source HEAD\n')
  git(f, f.source, 'add', 'installer-origin-fixture.txt')
  git(f, f.source, 'commit', '-q', '-m', 'source revision after remote main')
  return git(f, f.source, 'rev-parse', 'HEAD')
}

function expectUnavailable(output: string, app: string): void {
  const prose = output.replace(/\s+/g, ' ')
  expect(prose).toMatch(/самообнов|self[- ]updat|\/update/iu)
  expect(prose).toMatch(/недоступ|не (?:буд[а-яё]*|работ[а-яё]*)|unavailable|disabled/iu)
  expect(prose).toMatch(/прав[а-яё]*.{0,120}\bmain\b|\bmain\b.{0,120}прав|push/iu)
  const command = output.split('\n').find((line) => /\bgit\s+-C\s+/.test(line) && /\bremote\s+add\s+origin\s+\S/.test(line))
  expect(command, 'print a ready git -C <app> remote add origin <address> command').toBeDefined()
  expect(command).toContain(app)
}

test('test_c1_new_install_inherits_upstream_origin_and_keeps_source_HEAD_on_live', { timeout: 30_000 }, () => {
  const f = fixture()
  const upstream = remote(f)
  const remoteMain = git(f, upstream, 'rev-parse', 'refs/heads/main')
  git(f, f.source, 'remote', 'add', 'origin', upstream)
  git(f, f.source, 'checkout', '-q', '-b', 'source-checkout')
  const sourceHead = advance(f)
  expect(sourceHead).not.toBe(remoteMain)
  run(f)
  expect(origin(f)).toBe(upstream)
  expect(origin(f)).not.toBe(f.source)
  expect(git(f, f.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sourceHead)
  git(f, f.app, 'fetch', 'origin', 'main')
  expect(git(f, f.app, 'rev-parse', 'refs/remotes/origin/main')).toBe(remoteMain)
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sourceHead)
})

test.each([true, false])('test_c2_explicit_origin_takes_precedence_when_source_has_origin_%s', { timeout: 30_000 }, (hasOrigin) => {
  const f = fixture()
  const explicit = remote(f, 'explicit.git')
  const inherited = 'https://source.example.invalid/dshbot.git'
  if (hasOrigin) git(f, f.source, 'remote', 'add', 'origin', inherited)
  run(f, { DSHBOT_INSTALL_ORIGIN: explicit })
  expect(origin(f)).toBe(explicit)
  expect(origin(f, f.source)).toBe(hasOrigin ? inherited : null)
})

test('test_c3_missing_origin_finishes_with_warning_and_repair_command', { timeout: 30_000 }, () => {
  const f = fixture()
  const output = run(f)
  expect(origin(f)).toBeNull()
  expect(git(f, f.app, 'remote').split('\n')).not.toContain('origin')
  expectUnavailable(output, f.app)
})

test('test_c4_relative_source_origin_is_resolved_from_source_to_an_absolute_path', { timeout: 30_000 }, () => {
  const f = fixture()
  const upstream = remote(f)
  git(f, f.source, 'remote', 'add', 'origin', '../remote.git')
  run(f)
  expect(origin(f)).toBe(upstream)
  git(f, f.app, 'fetch', 'origin', 'main')
  expect(git(f, f.app, 'rev-parse', 'refs/remotes/origin/main'))
    .toBe(git(f, upstream, 'rev-parse', 'refs/heads/main'))
  expect(origin(f, f.source)).toBe('../remote.git')
})

test.each(['source', 'environment'] as const)('test_c5_credentials_from_%s_are_removed_from_app_config_and_output', { timeout: 30_000 }, (location) => {
  const f = fixture()
  const username = 'fixtureCredentialUser9284'
  const password = 'fixtureCredentialToken7351'
  const clean = 'https://example.invalid/organisation/dshbot.git'
  const credentialled = `https://${username}:${password}@example.invalid/organisation/dshbot.git`
  git(f, f.source, 'remote', 'add', 'origin', location === 'source' ? credentialled : 'https://source.example.invalid/dshbot.git')
  const output = run(f, location === 'environment' ? { DSHBOT_INSTALL_ORIGIN: credentialled } : {})
  const appConfig = git(f, f.app, 'config', '--local', '--list')
  for (const text of [appConfig, output]) {
    expect(text).not.toContain(username)
    expect(text).not.toContain(password)
  }
  expect(origin(f)).toBe(clean)
})

test.each(['inherited', 'relative', 'override-with-source', 'override-without-source', 'existing', 'unavailable'] as const)(
  'test_c6_reinstall_repairs_only_missing_standalone_origin_%s', { timeout: 30_000 }, (mode) => {
    const f = fixture()
    run(f)
    expect(origin(f)).toBeNull()
    const upstream = remote(f)
    const explicit = remote(f, 'explicit.git')
    const existing = 'https://owner.example.invalid/custom.git'
    if (mode !== 'override-without-source' && mode !== 'unavailable') {
      git(f, f.source, 'remote', 'add', 'origin', mode === 'relative' ? '../remote.git' : upstream)
    }
    if (mode === 'existing') git(f, f.app, 'remote', 'add', 'origin', existing)
    const overrides = mode.startsWith('override') || mode === 'existing'
      ? { DSHBOT_INSTALL_ORIGIN: explicit } : {}
    const sourceHead = advance(f)
    const output = run(f, overrides)
    const expected = mode === 'existing' ? existing : mode === 'unavailable' ? null : mode.startsWith('override') ? explicit : upstream
    expect(origin(f)).toBe(expected)
    expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sourceHead)
    expect(git(f, f.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
    if (expected === null) expectUnavailable(output, f.app)
  },
)

test.each([
  { live: true, hasOrigin: false }, { live: true, hasOrigin: true },
  { live: false, hasOrigin: false }, { live: false, hasOrigin: true },
])('test_c7_linked_worktree_preserves_shared_remotes_live_$live_origin_$hasOrigin', { timeout: 30_000 }, ({ live, hasOrigin }) => {
  const f = fixture()
  const upstream = remote(f)
  git(f, f.source, 'remote', 'add', 'origin', upstream)
  const parent = join(f.root, 'other-repository')
  mkdirSync(parent)
  git(f, parent, 'init', '-q', '-b', 'main')
  put(join(parent, 'foreign-owner.txt'), 'keep foreign repository\n')
  git(f, parent, 'add', 'foreign-owner.txt')
  git(f, parent, 'commit', '-q', '-m', 'unrelated repository')
  if (hasOrigin) git(f, parent, 'remote', 'add', 'origin', 'https://owner.example.invalid/other.git')
  git(f, parent, 'remote', 'add', 'backup', 'https://backup.example.invalid/other.git')
  const before = config(f, parent, '--get-regexp', '^remote\\.')
  mkdirSync(dirname(f.app), { recursive: true })
  git(f, parent, 'worktree', 'add', '-q', '-b', live ? 'live' : 'old-installation', f.app, 'HEAD')
  if (!live) put(join(f.app, 'owner-local.txt'), 'uncommitted foreign work\n')
  const sourceHead = advance(f)
  const output = run(f, { DSHBOT_INSTALL_ORIGIN: remote(f, 'explicit.git') })
  expect(config(f, parent, '--get-regexp', '^remote\\.')).toBe(before)
  expect(origin(f, parent)).toBe(hasOrigin ? 'https://owner.example.invalid/other.git' : null)
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sourceHead)
  const backups = readdirSync(dirname(f.app)).filter((name) => /^app\.prev-/.test(name))
  if (live) {
    expect(backups).toHaveLength(0)
  } else {
    expect(backups).toHaveLength(1)
    const backup = join(dirname(f.app), backups[0]!)
    expect(output).toContain(backup)
    expect(readFileSync(join(backup, 'foreign-owner.txt'), 'utf8')).toBe('keep foreign repository\n')
    expect(readFileSync(join(backup, 'owner-local.txt'), 'utf8')).toBe('uncommitted foreign work\n')
  }
})

const ghDirs = { space: 'GitHub CLI', apostrophe: "owner's-tools", newline: 'new\nline', dispatcher: 'snap-bin' }
test.each(['space', 'apostrophe', 'newline', 'dispatcher'] as const)('test_github_helper_runs_gh_found_in_PATH_%s', { timeout: 60_000 }, (kind) => {
  const f = fixture()
  const ghDir = join(f.root, ghDirs[kind])
  const gh = join(ghDir, 'gh')
  const ghLog = join(f.root, 'gh-calls.jsonl')
  // Like /snap/bin/gh -> /usr/bin/snap, a dispatcher chooses its program by the
  // name it was started under: its link target run directly is not gh.
  const program = kind === 'dispatcher' ? join(f.root, 'dispatcher', 'snap') : gh
  mkdirSync(ghDir, { recursive: true })
  mkdirSync(dirname(program), { recursive: true })
  writeFileSync(program, `#!${process.execPath}
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({name, args}) + '\\n');
if (name !== 'gh') process.exit(64);
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'auth' && args[1] === 'git-credential' && args[2] === 'get') process.stdout.write('username=fixture-user\\npassword=fixture-token\\n\\n');
process.exit(args[0] === 'auth' && args[1] === 'git-credential' ? 0 : 91);
`, { mode: 0o755 })
  if (kind === 'dispatcher') symlinkSync(program, gh)
  git(f, f.source, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git')
  const env = { PATH: [ghDir, f.env.PATH].join(delimiter) }
  // git runs a "!" helper through sh -c: the path is single-quoted, with each
  // single quote inside it written as '\''.
  const expected = kind === 'dispatcher' ? `!${gh} auth git-credential` : `!'${gh.replaceAll("'", "'\\''")}' auth git-credential`
  for (let round = 0; round < 2; round++) {
    run(f, env)
    expect(config(f, f.app, '--get-all', 'credential.https://github.com.helper'), 'one helper per value after reinstall').toBe(expected)
  }
  writeFileSync(ghLog, '')
  const fill = spawnSync('git', ['-C', f.app, 'credential', 'fill'], {
    env: { ...f.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 10_000,
  })
  expect(fill.error, fill.stderr).toBeUndefined()
  expect(fill.status, fill.stderr).toBe(0)
  expect(fill.stdout).toMatch(/^username=fixture-user$/m)
  const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { name: string; args: string[] })
  expect(calls).toContainEqual({ name: 'gh', args: ['auth', 'git-credential', 'get'] })
})
