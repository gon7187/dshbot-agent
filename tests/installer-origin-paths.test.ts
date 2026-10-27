import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const installer = new URL('../scripts/install.sh', import.meta.url)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Like installer.test.ts, use real disposable git repositories and an isolated
// HOME/config. Run only the installer's git preparation functions: no dependency
// installation, services, credentials or network are needed for this regression.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-origin-paths-')))
  roots.push(root)
  const home = join(root, 'home')
  const source = join(root, 'source')
  const app = join(home, '.local/share/dshbot/app')
  for (const path of [home, source, dirname(app)]) mkdirSync(path, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'global-gitconfig'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Installer path fixture', GIT_AUTHOR_EMAIL: 'installer@example.invalid',
    GIT_COMMITTER_NAME: 'Installer path fixture', GIT_COMMITTER_EMAIL: 'installer@example.invalid',
  }
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout: 10_000 })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git(source, 'init', '-q', '-b', 'main')
  writeFileSync(join(source, 'fixture.txt'), 'source revision\n')
  git(source, 'add', 'fixture.txt')
  git(source, 'commit', '-q', '-m', 'initial fixture')
  return { root, source, app, env, git }
}

test.each([
  { address: './remote:mirror.git', local: true },
  { address: '../remote:mirror.git', local: true },
  { address: 'mirrors/remote:mirror.git', local: true },
  { address: 'user@host:repo.git', local: false },
  { address: 'https://host/repo.git', local: false },
])('test_h1_source_origin_distinguishes_local_colons_from_remote_addresses_$address', { timeout: 20_000 }, ({ address, local }) => {
  const f = fixture()
  const expected = local ? resolve(f.source, address) : address
  if (local) {
    mkdirSync(dirname(expected), { recursive: true })
    f.git(f.root, 'clone', '-q', '--bare', f.source, expected)
  }
  f.git(f.source, 'remote', 'add', 'origin', address)

  // Load the actual top-level shell function declarations without executing the
  // installer entry point. Include helpers so the tested functions use their
  // production dependencies, including source_origin and absolute_origin_path.
  const functions = readFileSync(installer, 'utf8')
    .match(/^[a-zA-Z_][a-zA-Z_0-9]*\(\) \{\r?\n[\s\S]*?^\}/gm)
  expect(functions, 'installer provides its shell functions').not.toBeNull()
  const result = spawnSync('/bin/bash', ['-s', '--', f.source, f.app], {
    cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10_000,
    input: `${functions!.join('\n')}\nset -eu\nsrc=$1\napp_dir=$2\ncreate_app\nconfigure_origin\n`,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  expect(result.error, output).toBeUndefined()
  expect(result.status, output).toBe(0)
  expect(f.git(f.app, 'rev-parse', 'HEAD'), 'git preparation must create the application from the source')
    .toBe(f.git(f.source, 'rev-parse', 'HEAD'))
  expect(f.git(f.app, 'config', '--local', '--get', 'remote.origin.url'),
    'local origin paths must resolve relative to the source; remote addresses must stay intact').toBe(expected)
  expect(f.git(f.source, 'config', '--local', '--get', 'remote.origin.url')).toBe(address)
})
