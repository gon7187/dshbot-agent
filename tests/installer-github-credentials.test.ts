import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const installer = new URL('../scripts/install.sh', import.meta.url)
const credentialKey = 'credential.https://github.com.helper'
const githubOrigin = 'https://github.com/owner/repo.git'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function executable(name: string): string {
  const result = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'fixture', name], {
    encoding: 'utf8', timeout: 10_000,
  })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, `fixture requires ${name}: ${result.stderr}`).toBe(0)
  return realpathSync(result.stdout.trim())
}

function fixture(auth: 'authorized' | 'unauthorized' | 'missing' = 'authorized') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-github-credentials-')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const source = join(root, 'source')
  const app = join(home, '.local/share/dshbot/app')
  const gh = join(bin, 'gh')
  const log = join(root, 'gh-calls.jsonl')
  const npmLog = join(root, 'npm-calls')
  for (const path of [home, bin, source, dirname(app)]) mkdirSync(path, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(npmLog, '')

  // An allowlisted PATH makes "gh missing" independent of the host's tools.
  // The real Git and ordinary shell utilities operate only on our fixtures.
  for (const name of ['git', 'mkdir', 'dirname', 'basename', 'readlink', 'realpath', 'date', 'sed', 'head', 'cat']) {
    symlinkSync(executable(name), join(bin, name))
  }
  symlinkSync(process.execPath, join(bin, 'node'))
  if (auth !== 'missing') {
    writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[0] === 'auth' && args[1] === 'git-credential' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, input}) + '\\n');
if (args[0] === 'auth' && args[1] === 'status') process.exit(${auth === 'authorized' ? 0 : 1});
if (args[0] === 'auth' && args[1] === 'git-credential') {
  if (args[2] === 'get') process.stdout.write('username=fixture-user\\npassword=fixture-token\\n\\n');
  process.exit(0);
}
process.exit(91);
`, { mode: 0o755 })
  }

  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: bin, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'global-gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Installer credential fixture', GIT_AUTHOR_EMAIL: 'installer@example.invalid',
    GIT_COMMITTER_NAME: 'Installer credential fixture', GIT_COMMITTER_EMAIL: 'installer@example.invalid',
    TELEGRAM_BOT_TOKEN: 'fixture-token', DEEPSEEK_API_KEY: 'fixture-key', DSHBOT_ISOLATION: 'host',
  }
  function gitResult(cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
    return spawnSync(join(bin, 'git'), ['-C', cwd, ...args], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000,
    })
  }
  function git(cwd: string, ...args: string[]): string {
    const result = gitResult(cwd, args)
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  function helpers(cwd = app): string[] {
    const result = gitResult(cwd, ['config', '--local', '--get-all', credentialKey])
    expect(result.error, result.stderr).toBeUndefined()
    expect([0, 1], result.stderr).toContain(result.status)
    return result.status === 0 ? result.stdout.trimEnd().split('\n') : []
  }
  function calls(): { args: string[]; input: string }[] {
    return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  git(source, 'init', '-q', '-b', 'main')
  writeFileSync(join(source, 'fixture.txt'), 'source revision\n')
  git(source, 'add', 'fixture.txt')
  git(source, 'commit', '-q', '-m', 'initial fixture')
  return { root, home, bin, source, app, gh, log, npmLog, env, gitResult, git, helpers, calls }
}

type Fixture = ReturnType<typeof fixture>

function prepareApp(f: Fixture): string {
  // Follow installer-origin-paths.test.ts: load production shell functions,
  // without executing the installer entry point. Like installer-guest-runtime,
  // retain orchestration but replace dependency/service/settings side effects.
  // This exercises both install_app and any credential setup in do_install;
  // no dependency installation, daemon, env-file access or network takes place.
  const functions = readFileSync(installer, 'utf8')
    .match(/^[a-zA-Z_][a-zA-Z_0-9]*\(\) \{\r?\n[\s\S]*?^\}/gm)
  expect(functions, 'load the installer shell functions').not.toBeNull()
  const result = spawnSync('/bin/bash', ['-s', '--', f.source, f.app, f.npmLog], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000,
    input: `${functions!.join('\n')}
set -u
src=$1
app_dir=$2
fixture_npm_log=$3
data_dir=$(dirname -- "$app_dir")
default_data=$data_dir
home_dir=$HOME
assume_yes=true
check_prerequisites() { :; }
npm() { printf '%s\\n' "$*" >> "$fixture_npm_log"; }
write_env_file() { :; }
install_launch_shim() { :; }
install_units() { :; }
offer_migration() { :; }
start_service() { :; }
service_invocation() { :; }
print_linger_hint() { :; }
show_pairing() { :; }
do_install
`,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  expect(result.error, output).toBeUndefined()
  expect(result.status, output).toBe(0)
  expect(readFileSync(f.npmLog, 'utf8').trim().split('\n'),
    'the real application preparation reaches its dependency-installation double').toContain('ci')
  expect(f.git(f.app, 'rev-parse', 'HEAD'), 'prepare the application from the fixture source')
    .toBe(f.git(f.source, 'rev-parse', 'HEAD'))
  return output
}

test('test_c1_github_helper_is_local_absolute_and_idempotent', { timeout: 30_000 }, () => {
  const f = fixture()
  f.git(f.source, 'remote', 'add', 'origin', githubOrigin)
  prepareApp(f)
  expect(f.git(f.app, 'config', '--local', '--get', 'remote.origin.url')).toBe(githubOrigin)
  const expected = [`!${f.gh} auth git-credential`]
  expect(f.helpers()).toEqual(expected)
  prepareApp(f)
  expect(f.helpers(), 'reinstallation must not append duplicate helpers').toEqual(expected)
})

test.each(['unauthorized', 'missing'] as const)(
  'test_c2_github_without_usable_gh_finishes_and_explains_login_%s', { timeout: 30_000 }, (auth) => {
    const f = fixture(auth)
    f.git(f.source, 'remote', 'add', 'origin', githubOrigin)
    const output = prepareApp(f)
    expect(f.git(f.app, 'config', '--local', '--get', 'remote.origin.url')).toBe(githubOrigin)
    expect(f.helpers()).toEqual([])
    expect(output).toMatch(/\bgh\s+auth\s+login\b/)
  },
)

test.each((['local', 'other-host'] as const).flatMap((kind) =>
  (['authorized', 'unauthorized'] as const).map((auth) => ({ kind, auth })),
))(
  'test_c3_non_github_origin_needs_no_helper_or_login_hint_$kind_$auth', { timeout: 30_000 }, ({ kind, auth }) => {
    const f = fixture(auth)
    const origin = kind === 'local' ? join(f.root, 'upstream.git') : 'https://example.invalid/owner/repo.git'
    if (kind === 'local') f.git(f.root, 'clone', '-q', '--bare', f.source, origin)
    f.git(f.source, 'remote', 'add', 'origin', origin)
    const output = prepareApp(f)
    expect(f.git(f.app, 'config', '--local', '--get', 'remote.origin.url')).toBe(origin)
    expect(f.helpers()).toEqual([])
    expect(output).not.toMatch(/\bgh\s+auth\s+login\b/)
  },
)

test('test_c4_linked_application_worktree_preserves_shared_config', { timeout: 30_000 }, () => {
  const f = fixture()
  f.git(f.source, 'remote', 'add', 'origin', githubOrigin)
  f.git(f.source, 'worktree', 'add', '-q', '-b', 'live', f.app, 'HEAD')
  const before = f.git(f.source, 'config', '--local', '--list')
  prepareApp(f)
  expect(f.git(f.app, 'rev-parse', '--show-toplevel')).toBe(f.app)
  expect(f.helpers(f.source), 'do not install a helper into the shared repository').toEqual([])
  expect(f.git(f.source, 'config', '--local', '--list')).toBe(before)
})

test('test_c5_fetch_uses_gh_credentials_with_global_and_system_config_disabled', { timeout: 30_000 }, () => {
  const f = fixture()
  f.git(f.source, 'remote', 'add', 'origin', githubOrigin)
  prepareApp(f)
  writeFileSync(f.log, '')

  // A transport double replaces the HTTP authentication challenge without a
  // socket. Git fetch starts it as git-remote-https; it asks Git's real credential
  // machinery for the remote's credentials, then stops before transferring data.
  const transport = join(f.root, 'transport')
  const transportLog = join(f.root, 'transport-calls.jsonl')
  mkdirSync(transport)
  writeFileSync(transportLog, '')
  writeFileSync(join(transport, 'git-remote-https'), `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify(args) + '\\n');
const url = new URL(args[1]);
spawnSync(${JSON.stringify(join(f.bin, 'git'))}, ['credential', 'fill'], {
  env: process.env,
  input: 'protocol=' + url.protocol.slice(0, -1) + '\\nhost=' + url.host + '\\n\\n',
  encoding: 'utf8', timeout: 5000,
});
process.exit(1);
`, { mode: 0o755 })

  const result = f.gitResult(f.app, ['fetch', 'origin'], {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https', GIT_EXEC_PATH: transport,
  })
  expect(result.error, result.stderr).toBeUndefined()
  const transports = readFileSync(transportLog, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
  expect(transports, 'fetch must reach the isolated HTTPS transport').toContainEqual(['origin', githubOrigin])
  const credentialCalls = f.calls().filter(({ args }) =>
    args.length === 3 && args[0] === 'auth' && args[1] === 'git-credential' && args[2] === 'get')
  expect(credentialCalls, 'fetch must invoke the locally configured gh credential helper').not.toHaveLength(0)
  expect(credentialCalls[0]!.input).toMatch(/^protocol=https$/m)
  expect(credentialCalls[0]!.input).toMatch(/^host=github\.com$/m)
})
