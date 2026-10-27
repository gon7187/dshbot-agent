// Edge cases of the OpenClaw migration found in review: daemon keys from every
// source, the one-word gateway command line, `--json` without `--yes`,
// escaped values in the env file and JSON5 numbers. All values are synthetic.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { parseJson5 } from './src/json5.js'
import { isOpenClawGatewayCommand, liveOpenClawGateway } from './src/run.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 120_000
interface Run { code: number | null; stdout: string; stderr: string }
interface Dest { home: string; envFile: string }
let root: string
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function dest(label: string): Dest {
  return { home: join(root, label, 'home'), envFile: join(root, label, 'dshbot.env') }
}

function source(label: string): string {
  const dir = join(root, label, 'openclaw')
  mkdirSync(dir, { recursive: true })
  return dir
}

function migrate(from: string, to: Dest, flags: string[]): Promise<Run> {
  const child = spawn(cli, ['openclaw', '--from', from, '--home', to.home, '--env-file', to.envFile, ...flags], {
    cwd: repoRoot,
    env: { HOME: join(root, 'user'), LANG: 'C.UTF-8', PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => {
      children.delete(child)
      resolve({ code, stdout, stderr })
    })
    child.stdin?.end()
  })
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else result[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return result
}

/** The value a POSIX shell sees after sourcing the env file: an independent decoder. */
function shellValue(envFile: string, key: string): string {
  const result = spawnSync('/bin/sh', ['-c', `. "$1"; printf %s "$${key}"`, 'sh', envFile], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return result.stdout
}

function expectNoLeak(run: Run, values: string[]): void {
  for (const value of values) expect(run.stdout.includes(value) || run.stderr.includes(value), 'secret value leaked').toBe(false)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-migrate-edge-'))
  mkdirSync(join(root, 'user'), { recursive: true })
})

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  }))
  children.clear()
  rmSync(root, { recursive: true, force: true })
})

function authProfiles(provider: string, key: string): string {
  return JSON.stringify({ profiles: { [`${provider}:default`]: { type: 'api_key', provider, key } } })
}

test('c4: DEEPSEEK_API_KEY from a provider, the vault and both auth profile stores goes to the env file', { timeout: TIMEOUT }, async () => {
  const value = 'fixture-deepseek-edge-K1!'
  const sources: Array<[string, (dir: string) => void]> = [
    ['provider', (dir) => put(join(dir, 'openclaw.json'), JSON.stringify({ models: { providers: { deepseek: { apiKey: value } } } }))],
    ['vault', (dir) => {
      put(join(dir, 'openclaw.json'), '{}')
      mkdirSync(join(dir, 'state'), { recursive: true })
      const db = new DatabaseSync(join(dir, 'state', 'openclaw.sqlite'))
      try {
        db.exec('CREATE TABLE secret_store_entries (scope_kind TEXT, scope_id TEXT, name TEXT, value TEXT, kind TEXT, deleted_at_ms INTEGER)')
        db.prepare('INSERT INTO secret_store_entries VALUES (?, ?, ?, ?, ?, ?)').run('global', '', 'DEEPSEEK_API_KEY', value, 'env', null)
      } finally { db.close() }
    }],
    ['legacy-profile', (dir) => {
      put(join(dir, 'openclaw.json'), '{}')
      put(join(dir, 'agents', 'main', 'agent', 'auth-profiles.json'), authProfiles('deepseek', value))
    }],
    ['sqlite-profile', (dir) => {
      put(join(dir, 'openclaw.json'), '{}')
      mkdirSync(join(dir, 'agents', 'main', 'agent'), { recursive: true })
      const db = new DatabaseSync(join(dir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
      try {
        db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)')
        db.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('default', authProfiles('deepseek', value))
      } finally { db.close() }
    }],
  ]
  for (const [label, build] of sources) {
    const from = source(label)
    build(from)
    const to = dest(label)
    const run = await migrate(from, to, ['--yes', '--include-secrets'])
    expect(run.code, label).toBe(0)
    expect(shellValue(to.envFile, 'DEEPSEEK_API_KEY'), label).toBe(value)
    expect(existsSync(join(to.home, 'secrets', 'DEEPSEEK_API_KEY')), `${label}: not in the vault`).toBe(false)
    expectNoLeak(run, [value])
  }
})

test('c7: the gateway command line is matched by substrings, the migration tool itself is not', () => {
  expect(isOpenClawGatewayCommand(['/usr/local/bin/openclaw-gateway'])).toBe(true)
  expect(isOpenClawGatewayCommand(['node', '/opt/openclaw/dist/entry.js', 'gateway', '--port', '18789'])).toBe(true)
  expect(isOpenClawGatewayCommand(['OpenClaw', 'Gateway'])).toBe(true)
  expect(isOpenClawGatewayCommand(['node', '/srv/gateway/server.js'])).toBe(false)
  expect(isOpenClawGatewayCommand(['/usr/bin/openclaw', 'tui'])).toBe(false)
  expect(isOpenClawGatewayCommand(['node', '--import', '/r/packages/app/register.mjs', '--', '/r/packages/migrate/src/cli.ts', 'openclaw', '--home', '/tmp/gateway'])).toBe(false)
  expect(isOpenClawGatewayCommand(['/bin/sh', '/r/scripts/dshbot-migrate', 'openclaw', '--from', '/tmp/live-gateway'])).toBe(false)
})

// A synthetic process table rather than a real `openclaw-gateway` process: a
// real one is visible system-wide and would turn the token of a parallel test
// file (openclaw-cli.test.ts expects it applied) into a conflict.
test('c7: a process named openclaw-gateway in the process table counts as a live gateway', () => {
  const proc = join(root, 'proc')
  const processEntry = (pid: string, argv: string[]): void => put(join(proc, pid, 'cmdline'), argv.join('\0') + '\0')
  processEntry('2147480001', ['/usr/bin/node', '/srv/gateway/server.js'])
  processEntry('2147480002', ['/bin/sh', '/r/scripts/dshbot-migrate', 'openclaw', '--from', '/tmp/live-gateway'])
  put(join(proc, 'self', 'cmdline'), 'openclaw-gateway\0')
  expect(liveOpenClawGateway(proc)).toBe(false)
  processEntry('2147480003', ['openclaw-gateway', '--port', '18789'])
  expect(liveOpenClawGateway(proc)).toBe(true)
  expect(liveOpenClawGateway(join(root, 'missing'))).toBe(false)
})

test('c10: --json without --yes and without --dry-run prints one JSON document and writes nothing', { timeout: TIMEOUT }, async () => {
  const from = source('json')
  put(join(from, 'openclaw.json'), JSON.stringify({ env: { vars: { JSON_EDGE_KEY: 'fixture-json-edge-Z3!' } }, commands: { ownerAllowFrom: [7] } }))
  const to = dest('json')
  const run = await migrate(from, to, ['--json', '--include-secrets'])
  expect(run.code).toBe(0)
  const document = JSON.parse(run.stdout) as { applied?: unknown; hint?: unknown; items?: unknown }
  expect(document.applied).toBe(false)
  expect(String(document.hint)).toContain('--yes')
  expect(Array.isArray(document.items)).toBe(true)
  expect(existsSync(to.home)).toBe(false)
  expect(existsSync(to.envFile)).toBe(false)
  expectNoLeak(run, ['fixture-json-edge-Z3!'])
  const applied = await migrate(from, to, ['--json', '--yes'])
  expect(applied.code).toBe(0)
  const result = JSON.parse(applied.stdout) as { applied?: unknown; report?: unknown }
  expect(result.applied).toBe(true)
  expect(String(result.report)).toMatch(/report\.json$/)
})

test('c11: values with quotes, backslashes, $ and backticks round-trip through the env file', { timeout: TIMEOUT }, async () => {
  const value = 'fixture-"quoted"\\back\\\\slash$HOME`tick` x#y;z\'s'
  const base = 'https://fixture.invalid/a b'
  const from = source('escaped')
  put(join(from, 'openclaw.json'), JSON.stringify({ env: { vars: { DEEPSEEK_API_KEY: value, DEEPSEEK_BASE_URL: base } } }))
  const to = dest('escaped')
  put(to.envFile, '# owner line\nOTHER="kept \\" as is"\n')
  const first = await migrate(from, to, ['--yes', '--include-secrets'])
  expect(first.code).toBe(0)
  expect(shellValue(to.envFile, 'DEEPSEEK_API_KEY')).toBe(value)
  expect(shellValue(to.envFile, 'DEEPSEEK_BASE_URL')).toBe(base)
  expect(readFileSync(to.envFile, 'utf8').startsWith('# owner line\nOTHER="kept \\" as is"\n')).toBe(true)
  const home = snapshot(to.home)
  const envBytes = readFileSync(to.envFile)
  const second = await migrate(from, to, ['--yes', '--include-secrets'])
  expect(second.code).toBe(0)
  expect(snapshot(to.home)).toEqual(home)
  expect(readFileSync(to.envFile).equals(envBytes)).toBe(true)
  expect(second.stdout.split('\n').find((row) => row.includes('DEEPSEEK_API_KEY'))).toMatch(/уже есть/)
  expectNoLeak(second, [value])

  // An owner-written line in another quoting style with the same value is the same key, not a conflict.
  const other = dest('owner-quoting')
  put(other.envFile, "DEEPSEEK_API_KEY='plain \"value\" \\ here'\nDEEPSEEK_BASE_URL=https://fixture.invalid/a\\ b\n")
  const owned = source('owner-quoting')
  put(join(owned, 'openclaw.json'), JSON.stringify({ env: { vars: { DEEPSEEK_API_KEY: 'plain "value" \\ here', DEEPSEEK_BASE_URL: base } } }))
  const before = readFileSync(other.envFile)
  const same = await migrate(owned, other, ['--yes', '--include-secrets'])
  expect(same.code).toBe(0)
  expect(readFileSync(other.envFile).equals(before)).toBe(true)
})

test('c11: --overwrite replaces a multi-line quoted assignment without touching neighbours', { timeout: TIMEOUT }, async () => {
  const from = source('multiline')
  put(join(from, 'openclaw.json'), JSON.stringify({ env: { vars: { DEEPSEEK_API_KEY: 'fixture-new-M2!' } } }))
  const to = dest('multiline')
  put(to.envFile, 'A=1\nDEEPSEEK_API_KEY="old\nsecond line"\nB=2\n')
  expect((await migrate(from, to, ['--yes', '--include-secrets'])).code).toBe(1)
  expect((await migrate(from, to, ['--yes', '--include-secrets', '--overwrite'])).code).toBe(0)
  expect(readFileSync(to.envFile, 'utf8')).toBe('A=1\nDEEPSEEK_API_KEY=fixture-new-M2!\nB=2\n')
})

test('c13: JSON5 numbers, quotes and identifiers parse like the reference grammar', () => {
  const parsed = parseJson5(`// numbers
  {
    hex: 0x7b, negHex: -0X1F, plus: +123, lead: .5, trail: 5., exp: +1e2,
    inf: Infinity, negInf: -Infinity, plusInf: +Infinity, nan: NaN,
    'single': 'it\\'s', "double": "a\\"b", $id_1: 'x', ключ: 1, \\u0061b: 2,
    esc: '\\x41\\u0042\\0\\v\\
c', /* block */ list: [1, 2,],
  }`) as Record<string, unknown>
  expect(parsed).toMatchObject({ hex: 123, negHex: -31, plus: 123, lead: 0.5, trail: 5, exp: 100, inf: Infinity, negInf: -Infinity, plusInf: Infinity })
  expect(Number.isNaN(parsed.nan)).toBe(true)
  expect(parsed).toMatchObject({ single: "it's", double: 'a"b', $id_1: 'x', ключ: 1, ab: 2, esc: 'AB\0\vc', list: [1, 2] })
  expect(Object.getPrototypeOf(parseJson5('{ __proto__: { polluted: true } }'))).toBe(Object.prototype)
  for (const bad of ['{a: 01}', '{a: 1 b: 2}', '[1,,]', "'open", '/* open', '{a: 0x}', '{a: 1.2.3}', '{} extra']) {
    expect(() => parseJson5(bad), bad).toThrow()
  }
})

test('c13: an owner id written as 0x7b or +123 is migrated', { timeout: TIMEOUT }, async () => {
  for (const [label, list] of [['hex', '[0x7b]'], ['plus', "[+123, 'telegram:9']"]] as const) {
    const from = source(label)
    put(join(from, 'openclaw.json'), `{ commands: { ownerAllowFrom: ${list}, }, ratio: .5, limit: Infinity, }\n`)
    const to = dest(label)
    const run = await migrate(from, to, ['--yes'])
    expect(run.code, label).toBe(0)
    const db = new DatabaseSync(join(to.home, 'state.db'), { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('telegram.owner_chat_id') as { value?: string } | undefined
      expect(row?.value, label).toBe('123')
    } finally { db.close() }
  }
})
