// Public CLI contract, using the private-HOME subprocess harness of the
// neighbouring OpenClaw tests. Every credential here is synthetic; the only
// .env files the harness creates or snapshots belong to its temporary fixture.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createSkillStore } from '../learn/src/skills.js'
import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 180_000
const APPLY = ['--yes', '--include-secrets']
type Obj = Record<string, unknown>
interface Destination { home: string; envFile: string }
interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface Fixture extends Destination { root: string; userHome: string; source: string }
let f: Fixture
const children = new Set<ChildProcess>()

function put(path: string, text: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }
function text(path: string): string {
  expect(existsSync(path), `expected output ${path}`).toBe(true)
  return readFileSync(path, 'utf8')
}
function object(value: unknown): Obj {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object').toBe(true)
  return value as Obj
}
function load(path: string): Obj { return object(JSON.parse(text(path))) }
function target(label: string): Destination {
  return { home: join(f.root, label, 'home'), envFile: join(f.root, label, 'daemon-vars.conf') }
}
function install(dir: string, variables: Record<string, string> = {}): void {
  put(join(dir, 'config.yaml'), 'mcp_servers: {}\n')
  put(join(dir, '.env'), Object.entries(variables).map(([key, value]) => `${key}=${value}\n`).join(''))
}
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: f.userHome, USERPROFILE: f.userHome, LANG: 'C.UTF-8', TZ: 'UTC', DSHBOT_TZ: 'UTC',
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), ...extra,
  }
}
function collect(child: ChildProcess): Promise<Run> {
  children.add(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { stderr += error.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin?.end()
  })
}
function command(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return collect(spawn('/bin/sh', ['-c', 'exec "$@"', 'hermes-migration-test', cli, ...args], {
    cwd: repoRoot, env: environment(extra), stdio: ['pipe', 'pipe', 'pipe'],
  }))
}
function migrate(flags = APPLY, dest: Destination = f, source = f.source): Promise<Run> {
  return command(['hermes', '--from', source, '--home', dest.home, '--env-file', dest.envFile, ...flags])
}
function ok(run: Run): void {
  expect(run.signal, 'CLI must complete without a timeout or signal').toBeNull()
  // Raw output is deliberately excluded from diagnostics in case it leaks.
  expect(run.code, 'migration command exit code').toBe(0)
}
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) {
        result[relative(dir, path) + '/'] = 'directory'
        walk(path)
      } else result[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return result
}
function vault(home = f.home): Record<string, string> {
  const dir = join(home, 'secrets')
  return Object.fromEntries(files(dir).map((path) => [relative(dir, path), readFileSync(path, 'utf8')]))
}
function expectSecret(name: string, value: string, home = f.home): void {
  const path = join(home, 'secrets', name)
  expect(existsSync(path), `expected vault entry ${name}`).toBe(true)
  expect(readFileSync(path).equals(Buffer.from(value)), `exact bytes of ${name}`).toBe(true)
  expect(statSync(path).mode & 0o777, `permissions of ${name}`).toBe(0o600)
}
function secretName(value: string, home = f.home): string {
  const names = Object.entries(vault(home)).filter(([, stored]) => stored === value).map(([name]) => name)
  expect(names.length, 'one vault entry for a synthetic credential').toBe(1)
  expect(names[0]).toMatch(/^[A-Z0-9_]{1,64}$/)
  return names[0]
}
// The independent decoder is also used by openclaw-edge.test.ts. Keys are
// fixed test literals, and the file is generated by this migration only.
function envValue(key: string, dest: Destination = f): string {
  expect(existsSync(dest.envFile), 'expected daemon environment file').toBe(true)
  const run = spawnSync('/bin/sh', ['-c', `. "$1"; printf %s "$${key}"`, 'sh', dest.envFile], {
    encoding: 'utf8', env: environment(),
  })
  expect(run.status, 'decode generated environment assignment').toBe(0)
  return run.stdout
}
function report(dest: Destination = f): { dir: string; text: string; items: Obj[] } {
  const paths = files(join(dest.home, 'migration')).filter((path) => path.endsWith('/report.json')).sort()
  expect(paths.length, 'application must produce a migration report').toBeGreaterThan(0)
  const path = paths.at(-1)!
  expect(relative(join(dest.home, 'migration'), path)).toMatch(/^hermes-[^/]+\/report\.json$/)
  const raw = text(path)
  const doc = object(JSON.parse(raw))
  expect(Array.isArray(doc.items), 'report contains per-item results').toBe(true)
  return { dir: dirname(path), text: raw, items: (doc.items as unknown[]).map(object) }
}
function reportItem(items: Obj[], needle: string, status?: string): Obj {
  const found = items.find((item) => JSON.stringify(item).includes(needle) && (status === undefined || item.status === status))
  expect(found, `report item for ${needle}${status ? ` (${status})` : ''}`).toBeDefined()
  return found!
}
function expectSkipped(items: Obj[], needle: string, reason: RegExp): void {
  const item = reportItem(items, needle)
  expect(item.status).toMatch(/^(skipped|warning)$/)
  expect(String(item.reason ?? ''), `reason for skipping ${needle}`).toMatch(reason)
}
function owner(dest: Destination = f): string | undefined {
  const path = join(dest.home, 'state.db')
  expect(existsSync(path), 'owner must be persisted in state.db').toBe(true)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get('telegram.owner_chat_id') as { value: string } | undefined
    return row?.value
  } finally { db.close() }
}
function skill(source: string, path: string, name: string, platforms?: string[]): void {
  put(join(source, 'skills', path, 'SKILL.md'), `---\nname: ${name}\ndescription: A synthetic imported skill\n${platforms ? `platforms: ${JSON.stringify(platforms)}\n` : ''}---\n\nFollow the fixture instructions for ${path}.\n`)
  put(join(source, 'skills', path, 'scripts', 'check.sh'), '#!/bin/sh\nprintf fixture-check\n')
  put(join(source, 'skills', path, 'references', 'notes.txt'), `Support material: ${path}\n`)
}
function jobs(source: string, values: unknown[]): void { json(join(source, 'cron', 'jobs.json'), { jobs: values }) }
function identity(dest: Destination): string | undefined {
  const path = join(dest.home, 'memory', 'identity.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}
function noLeaks(run: Run, values: string[], reportText: string): void {
  for (const [index, value] of values.entries()) {
    for (const [surface, content] of [['stdout', run.stdout], ['stderr', run.stderr], ['report', reportText]]) {
      const escaped = JSON.stringify(value).slice(1, -1)
      expect(content.includes(value) || content.includes(escaped), `synthetic secret #${index} leaked in ${surface}`).toBe(false)
    }
  }
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-hermes-cli-'))
  f = { root, userHome: join(root, 'user'), source: join(root, 'hermes'), home: join(root, 'destination'), envFile: join(root, 'config', 'daemon-vars.conf') }
  mkdirSync(f.userHome, { recursive: true })
  mkdirSync(f.home, { recursive: true })
  install(f.source)
})
afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  }))
  children.clear()
  rmSync(f.root, { recursive: true, force: true })
})

test('test_c1_dry_run_preserves_bytes_and_selects_from_environment_default_and_profile', { timeout: TIMEOUT }, async () => {
  const envHome = join(f.root, 'environment-hermes')
  const defaultHome = join(f.userHome, '.hermes')
  const roots = [f.source, envHome, defaultHome]
  const names: string[] = []
  for (const [index, root] of roots.entries()) {
    for (const profile of [false, true]) {
      const dir = profile ? join(root, 'profiles', 'work') : root
      const key = `PLAN_${index}_${profile ? 'WORK' : 'MAIN'}_KEY`
      names.push(key)
      install(dir, { [key]: `fixture-plan-${index}-${profile}`, TELEGRAM_ALLOWED_USERS: '111,222' })
      put(join(dir, 'config.yaml'), `mcp_servers:\n  planserver:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["--version"]\n`)
    }
  }
  put(join(f.home, 'keep.txt'), 'existing home bytes\r\n')
  put(f.envFile, '# existing daemon settings\r\nOTHER=unchanged\r\n')
  const before = snapshot(f.home)
  const envBefore = readFileSync(f.envFile)
  const cases: Array<{ args: string[]; env: NodeJS.ProcessEnv; key: string }> = [
    { args: ['--from', f.source], env: { HERMES_HOME: envHome }, key: names[0] },
    { args: [], env: { HERMES_HOME: envHome }, key: names[2] },
    { args: [], env: {}, key: names[4] },
    { args: ['--from', f.source, '--profile', 'work'], env: { HERMES_HOME: envHome }, key: names[1] },
    { args: ['--profile', 'work'], env: { HERMES_HOME: envHome }, key: names[3] },
    { args: ['--profile', 'work'], env: {}, key: names[5] },
  ]
  for (const entry of cases) {
    const run = await command(['hermes', ...entry.args, '--home', f.home, '--env-file', f.envFile, '--dry-run'], entry.env)
    ok(run)
    const rows = run.stdout.split(/\r?\n/)
    for (const [name, destination] of [[entry.key, 'secrets'], ['telegram.owner_chat_id', 'state.db'], ['planserver', 'mcp.json']]) {
      const row = rows.find((line) => line.includes(name) && line.includes(destination))
      expect(row, `plan row for ${name}`).toBeDefined()
      expect(row).toMatch(/plan|new|ready|pending|skip|would|план|пропу|перен|нов|готов/i)
    }
    for (const other of names.filter((name) => name !== entry.key)) expect(run.stdout).not.toContain(other)
    expect(snapshot(f.home)).toEqual(before)
    expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  }
})

test('test_c2_imports_only_secret_environment_variables_and_whole_credentials_with_private_modes', { timeout: TIMEOUT }, async () => {
  const values = {
    SERVICE_API_KEY: 'fixture-hermes-service-2A!', SERVICE_TOKEN: 'fixture-hermes-token-2B!',
    APP_SECRET: 'fixture-hermes-secret-2C!', DB_PASSWORD: 'fixture-hermes-password-2D!',
    ANTHROPIC_API_KEY: 'fixture-hermes-anthropic-2E!', ANTHROPIC_BASE_URL: 'https://fixture-provider.invalid/v1',
  }
  const daemon = { TELEGRAM_BOT_TOKEN: '700002:AAFixtureHermesTokenOnly222222222222', DEEPSEEK_API_KEY: 'fixture-hermes-deepseek-2F!', DEEPSEEK_BASE_URL: 'https://fixture-deepseek.invalid/v1' }
  const lowerCaseSecret = 'fixture-hermes-lowercase-2G!'
  install(f.source, { ...values, ...daemon, mixed_case_token: lowerCaseSecret, TERMINAL_TIMEOUT: '987654321987', WEB_TOOLS_DEBUG: 'fixture-hermes-debug-setting' })
  const credential = '{\n  "client_secret": "fixture-hermes-file-2H!",\n  "client_id": "test-client"\n}\n'
  put(join(f.source, 'credentials', 'service-account.json'), credential)
  const run = await migrate()
  ok(run)
  for (const [name, value] of Object.entries(values)) expectSecret(name, value)
  expectSecret(secretName(lowerCaseSecret), lowerCaseSecret)
  const fileName = secretName(credential)
  expect(fileName).toMatch(/SERVICE.*ACCOUNT/)
  expectSecret(fileName, credential)
  reportItem(report().items, 'credentials/service-account.json', 'applied')
  for (const [name, value] of Object.entries(daemon)) {
    expect(envValue(name) === value, `exact daemon value for ${name}`).toBe(true)
    expect(existsSync(join(f.home, 'secrets', name))).toBe(false)
  }
  expect(statSync(f.envFile).mode & 0o777).toBe(0o600)
  for (const name of ['TERMINAL_TIMEOUT', 'WEB_TOOLS_DEBUG']) {
    expect(existsSync(join(f.home, 'secrets', name))).toBe(false)
    expect(text(f.envFile)).not.toContain(name + '=')
    expectSkipped(report().items, name, /не перенос|не поддерж|hermes|setting|unsupported|skip|настрой/i)
  }
})

test('test_c3_skips_oauth_and_deduplicates_api_key_pool_references_to_dotenv', { timeout: TIMEOUT }, async () => {
  const key = 'fixture-hermes-pool-deepseek-3A!'
  const access = 'fixture-hermes-oauth-access-3B!'
  const refresh = 'fixture-hermes-oauth-refresh-3C!'
  install(f.source, { DEEPSEEK_API_KEY: key })
  json(join(f.source, 'auth.json'), { credential_pool: {
    deepseek: [{ auth_type: 'api_key', source: 'env:DEEPSEEK_API_KEY' }],
    anthropic: [{ auth_type: 'oauth', source: 'hermes', access_token: access, refresh_token: refresh }],
  } })
  const run = await migrate()
  ok(run)
  expect(envValue('DEEPSEEK_API_KEY') === key).toBe(true)
  expect(text(f.envFile).split(/\r?\n/).filter((line) => /^(?:export\s+)?DEEPSEEK_API_KEY=/.test(line))).toHaveLength(1)
  expect(Object.values(vault()).some((value) => [key, access, refresh].includes(value))).toBe(false)
  expect(text(f.envFile).includes(access) || text(f.envFile).includes(refresh), 'OAuth is not written to daemon settings').toBe(false)
  const result = report()
  expect(result.items.filter((item) => item.name === 'DEEPSEEK_API_KEY' && item.status === 'applied')).toHaveLength(1)
  const oauth = result.items.find((item) => /oauth/i.test(JSON.stringify(item)))
  expect(oauth, 'OAuth omission must be reported').toBeDefined()
  expect(oauth?.status).toMatch(/^(skipped|warning)$/)
  noLeaks(run, [key, access, refresh], result.text)
})

test('test_c4_owner_precedence_is_allowed_users_then_pairing_then_home_channel', { timeout: TIMEOUT }, async () => {
  const cases = [
    { label: 'allowed', allowed: '111,222', pairing: true, channel: '-100555', expected: '111' },
    { label: 'pairing', allowed: undefined, pairing: true, channel: '-100555', expected: '333' },
    { label: 'home-channel', allowed: undefined, pairing: false, channel: '-100555', expected: '-100555' },
  ]
  for (const entry of cases) {
    const source = join(f.root, entry.label, 'hermes')
    const dest = target(entry.label)
    install(source, { TELEGRAM_HOME_CHANNEL: entry.channel, ...(entry.allowed ? { TELEGRAM_ALLOWED_USERS: entry.allowed } : {}) })
    if (entry.pairing) json(join(source, 'telegram-pairing', 'telegram-approved.json'), {
      '333': { user_id: '333', approved_at: '2026-01-01T00:00:00Z' },
      '444': { user_id: '444', approved_at: '2026-01-02T00:00:00Z' },
    })
    ok(await migrate(APPLY, dest, source))
    expect(owner(dest), entry.label).toBe(entry.expected)
  }
})

test('test_c5_live_hermes_gateway_conflicts_only_the_telegram_token', { timeout: TIMEOUT }, async () => {
  const token = '700005:AAFixtureHermesTokenOnly555555555555'
  const otherKey = 'fixture-hermes-other-5A!'
  const deepseek = 'fixture-hermes-deepseek-5B!'
  install(f.source, { TELEGRAM_BOT_TOKEN: token, OTHER_API_KEY: otherKey, DEEPSEEK_API_KEY: deepseek, TELEGRAM_ALLOWED_USERS: '111,222' })
  put(join(f.source, 'config.yaml'), `mcp_servers:\n  gatewaytest:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["--version"]\n`)
  // Same readiness handshake as the OpenClaw CLI test; no service or Telegram
  // connection is involved. Other test files have no live Hermes processes.
  const gateway = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', 'hermes', 'gateway'], {
    env: environment(), stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(gateway)
  let ready = false
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 10_000)
    gateway.stdout?.once('data', () => { ready = true; clearTimeout(timer); resolve() })
    gateway.once('error', () => { clearTimeout(timer); resolve() })
  })
  expect(ready, 'synthetic gateway must complete its readiness handshake').toBe(true)
  expect(gateway.exitCode, 'synthetic gateway must still be running').toBeNull()
  expect(gateway.pid, 'synthetic gateway must have a process id').toBeDefined()
  const run = await migrate()
  expect(run.signal).toBeNull()
  expect(run.code).toBe(1)
  expect(text(f.envFile)).not.toContain('TELEGRAM_BOT_TOKEN=')
  expect(Object.values(vault()).includes(token)).toBe(false)
  expectSecret('OTHER_API_KEY', otherKey)
  expect(envValue('DEEPSEEK_API_KEY') === deepseek).toBe(true)
  expect(owner()).toBe('111')
  expect(object(load(join(f.home, 'mcp.json')).mcpServers)).toHaveProperty('gatewaytest')
  const result = report()
  const conflict = reportItem(result.items, 'TELEGRAM_BOT_TOKEN', 'conflict')
  expect(String(conflict.reason)).toContain('409')
  expect(String(conflict.reason)).toMatch(/токен|token/i)
  expect(String(conflict.reason)).toMatch(/дв|two|одновремен|simultan/i)
  noLeaks(run, [token, otherKey, deepseek], result.text)
})

test('test_c6_yaml_mcp_preserves_connection_and_tool_policy_and_replaces_secret_values', { timeout: TIMEOUT }, async () => {
  const envSecret = 'fixture-hermes-mcp-key-6A!'
  const headerSecret = 'Bearer fixture-hermes-mcp-header-6B!'
  const cwd = join(f.root, 'mcp-work')
  mkdirSync(cwd)
  put(join(f.source, 'config.yaml'), `# Hermes YAML, not a JSON document\nmcp_servers:\n  local:\n    command: ${JSON.stringify(process.execPath)}\n    args:\n      - "--version"\n    cwd: ${JSON.stringify(cwd)}\n    enabled: false\n    tools:\n      include: ["read", "write"]\n      exclude: ["write"]\n    env:\n      API_KEY: ${JSON.stringify(envSecret)}\n      REGION: eu\n  remote:\n    url: "https://fixture-mcp.invalid/rpc"\n    enabled: true\n    tools:\n      include: ["search"]\n      exclude: ["delete"]\n    headers:\n      Authorization: ${JSON.stringify(headerSecret)}\n      X-Region: eu\n`)
  const run = await migrate()
  ok(run)
  const servers = object(load(join(f.home, 'mcp.json')).mcpServers)
  const local = object(servers.local)
  const remote = object(servers.remote)
  expect(local).toMatchObject({ command: process.execPath, args: ['--version'], cwd, enabled: false, include: ['read', 'write'], exclude: ['write'] })
  expect(remote).toMatchObject({ url: 'https://fixture-mcp.invalid/rpc', enabled: true, include: ['search'], exclude: ['delete'] })
  expect(object(local.env).REGION).toBe('eu')
  expect(object(remote.headers)['X-Region']).toBe('eu')
  for (const [value, expected] of [[object(local.env).API_KEY, envSecret], [object(remote.headers).Authorization, headerSecret]]) {
    expect(value).toMatch(/^\$\{secret:[A-Z0-9_]{1,64}\}$/)
    const name = /^\$\{secret:([A-Z0-9_]{1,64})\}$/.exec(String(value))![1]
    expectSecret(name, String(expected))
  }
  noLeaks(run, [envSecret, headerSecret], report().text)
})

test('test_c7_imports_flat_and_categorized_skills_renames_collisions_and_skips_disabled_or_non_linux', { timeout: TIMEOUT }, async () => {
  skill(f.source, 'devops/deploy-check', 'deploy-check', ['linux', 'macos'])
  skill(f.source, 'notes', 'notes')
  skill(f.source, 'devops/toolbox', 'toolbox')
  skill(f.source, 'docs/toolbox', 'toolbox')
  skill(f.source, 'disabled-skill', 'disabled-skill')
  skill(f.source, 'apple-only', 'apple-only', ['macos'])
  put(join(f.source, 'skills', 'notes', 'assets', 'sample.bin'), Uint8Array.from([0, 255, 13, 10, 128, 42]))
  put(join(f.source, 'config.yaml'), 'skills:\n  disabled: ["disabled-skill"]\n')
  const run = await migrate()
  ok(run)
  const expected = new Map([
    ['deploy-check', 'devops/deploy-check'], ['notes', 'notes'],
    ['devops-toolbox', 'devops/toolbox'], ['docs-toolbox', 'docs/toolbox'],
  ])
  const library = createSkillStore({ home: f.home })
  const imported = library.list()
  for (const [name, sourcePath] of expected) {
    const destination = join(f.home, 'skills', name)
    expect(existsSync(join(destination, 'SKILL.md')), `copied ${name}`).toBe(true)
    expect(imported.find((entry) => entry.name === name), `usable imported skill ${name}`).toMatchObject({ imported: true })
    expect(text(join(destination, 'SKILL.md'))).toContain(`Follow the fixture instructions for ${sourcePath}.`)
    for (const path of files(join(f.source, 'skills', sourcePath)).filter((path) => !path.endsWith('/SKILL.md'))) {
      const copied = join(destination, relative(join(f.source, 'skills', sourcePath), path))
      expect(existsSync(copied), `support file of ${name}`).toBe(true)
      expect(readFileSync(copied).equals(readFileSync(path)), `support bytes of ${name}`).toBe(true)
    }
  }
  expect(imported.map((entry) => entry.name).sort()).toEqual([...expected.keys()].sort())
  for (const name of ['toolbox', 'disabled-skill', 'apple-only']) expect(existsSync(join(f.home, 'skills', name))).toBe(false)
  expectSkipped(report().items, 'disabled-skill', /disabled|отключ|запрещ/i)
  expectSkipped(report().items, 'apple-only', /platform|linux|macos|платформ/i)
})

test('test_c8_merges_section_delimited_memory_without_duplicates_ignores_backups_and_matches_openclaw_identity', { timeout: TIMEOUT }, async () => {
  const existingMemory = 'Existing complete memory entry.\nIts second line.'
  const newMemory = 'New complete memory entry.\nIts second line.'
  const existingUser = 'The owner prefers concise answers.'
  const newUser = 'The owner uses Linux.'
  put(join(f.home, 'memory', 'MEMORY.md'), existingMemory + '\n')
  put(join(f.home, 'memory', 'USER.md'), existingUser + '\n')
  put(join(f.source, 'memories', 'MEMORY.md'), `${existingMemory}\n§\n${newMemory}\n§\n${newMemory}\n`)
  put(join(f.source, 'memories', 'USER.md'), `${existingUser}\n§\n${newUser}\n§\n${newUser}\n`)
  put(join(f.source, 'memories', 'MEMORY.md.lock'), 'LOCK-CONTENT-MUST-NOT-BE-IMPORTED')
  put(join(f.source, 'memories', 'MEMORY.md.bak-x'), 'BACKUP-CONTENT-MUST-NOT-BE-IMPORTED')
  const soul = '# Imported identity\n\n' + 'I keep the owner informed and preserve useful knowledge. '.repeat(12) + '\n'
  put(join(f.source, 'SOUL.md'), soul)
  const run = await migrate()
  ok(run)
  for (const [name, previous, added] of [['MEMORY.md', existingMemory, newMemory], ['USER.md', existingUser, newUser]]) {
    const result = text(join(f.home, 'memory', name))
    expect(result.startsWith(previous)).toBe(true)
    expect(result.split(previous).length - 1).toBe(1)
    expect(result.split(added).length - 1).toBe(1)
  }
  const memoryOutput = files(join(f.home, 'memory')).map(text).join('\n')
  expect(memoryOutput).not.toContain('LOCK-CONTENT-MUST-NOT-BE-IMPORTED')
  expect(memoryOutput).not.toContain('BACKUP-CONTENT-MUST-NOT-BE-IMPORTED')
  expect(run.stdout, 'SOUL must be considered by the Hermes plan').toMatch(/SOUL|identity/i)

  // The identity policy is deliberately the same public contract for both
  // sources. Exercise a real OpenClaw workspace and compare decisions both
  // with an absent identity and with a populated one. This leaves the shared
  // identity opt-in/replacement policy to the OpenClaw migration contract.
  const openclaw = join(f.root, 'openclaw-reference')
  const workspace = join(openclaw, 'workspace')
  json(join(openclaw, 'openclaw.json'), { agents: { defaults: { workspace } } })
  put(join(workspace, 'SOUL.md'), soul)
  const referenceEmpty = target('openclaw-empty')
  const emptyRun = await command(['openclaw', '--from', openclaw, '--home', referenceEmpty.home, '--env-file', referenceEmpty.envFile, ...APPLY])
  ok(emptyRun)
  expect(emptyRun.stdout, 'SOUL must be considered by the OpenClaw plan').toMatch(/SOUL|identity/i)
  expect(identity(f)).toBe(identity(referenceEmpty))
  for (const overwrite of [false, true]) {
    const hermesDest = target(`hermes-identity-${overwrite}`)
    const clawDest = target(`claw-identity-${overwrite}`)
    const previous = '# Current identity\n\n' + 'This existing identity belongs to DSHBOT and its owner. '.repeat(12) + '\n'
    for (const dest of [hermesDest, clawDest]) put(join(dest.home, 'memory', 'identity.md'), previous)
    const flags = [...APPLY, ...(overwrite ? ['--overwrite'] : [])]
    const hermesRun = await migrate(flags, hermesDest)
    const clawRun = await command(['openclaw', '--from', openclaw, '--home', clawDest.home, '--env-file', clawDest.envFile, ...flags])
    expect(hermesRun.signal).toBeNull()
    expect(clawRun.signal).toBeNull()
    expect([0, 1]).toContain(clawRun.code)
    expect(hermesRun.code).toBe(clawRun.code)
    expect(identity(hermesDest)).toBe(identity(clawDest))
    expect(hermesRun.stdout).toMatch(/SOUL|identity/i)
    expect(clawRun.stdout).toMatch(/SOUL|identity/i)
  }
})

test('test_c9_imports_cron_interval_and_future_once_with_limits_and_pause_and_reviews_scripts', { timeout: TIMEOUT }, async () => {
  // Both dates are relative to the real subprocess clock; no fixed calendar
  // date can turn a future fixture into a past one on a later branch.
  const future = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString()
  const past = new Date(Date.now() - 365 * 24 * 60 * 60_000).toISOString()
  const job = (id: string, schedule: unknown, extra: Obj = {}): Obj => ({ id, name: `Hermes ${id}`, prompt: `Exact task from Hermes: ${id}\nKeep this second line.`, schedule, enabled: true, state: 'active', ...extra })
  const sourceJobs = [
    job('morning', { kind: 'cron', expr: '0 9 * * *' }),
    job('interval', { kind: 'interval', minutes: 90 }, { repeat: { times: 3, completed: 0 } }),
    job('future', { kind: 'once', run_at: future }),
    job('past', { kind: 'once', run_at: past }),
    job('disabled', { kind: 'interval', minutes: 30 }, { enabled: false }),
    job('paused', { kind: 'cron', expr: '0 12 * * *' }, { state: 'paused' }),
    job('script', { kind: 'interval', minutes: 60 }, { script: 'printf hermes-script-review' }),
    job('no-agent', { kind: 'interval', minutes: 60 }, { no_agent: true }),
  ]
  jobs(f.source, sourceJobs)
  ok(await migrate())
  expect(existsSync(join(f.home, 'state.db'))).toBe(true)
  // Reopen through the daemon's own registry, as schedule-jobs.test.ts does;
  // rows that are JSON-shaped but unusable by DSHBOT cannot satisfy this test.
  const store = openStore(join(f.home, 'state.db'))
  try {
    const registry = createScheduleRegistry(store, { timeZone: 'UTC' })
    const imported = registry.list()
    expect(imported).toHaveLength(5)
    const find = (id: string) => {
      const source = sourceJobs.find((entry) => entry.id === id)!
      const found = imported.find((entry) => entry.task === source.prompt)
      expect(found, `schedule with the exact prompt of ${id}`).toBeDefined()
      return found!
    }
    expect(find('morning').spec).toBe('0 9 * * *')
    expect(find('morning').schedule).toMatchObject({ kind: 'cron', expression: '0 9 * * *' })
    expect(find('interval')).toMatchObject({ spec: 'every 90m', maxRuns: 3, paused: false })
    expect(find('interval').schedule).toEqual({ kind: 'every', intervalMs: 90 * 60_000 })
    expect(find('future').schedule).toEqual({ kind: 'once', at: new Date(future) })
    expect(find('future').nextRunAt).toEqual(new Date(future))
    for (const id of ['disabled', 'paused']) {
      const saved = find(id)
      expect(saved.paused, `${id} remains paused`).toBe(true)
      expect(registry.claim(saved.id, new Date(Date.now() + 7 * 24 * 60 * 60_000))).toBeNull()
    }
    for (const id of ['past', 'script', 'no-agent']) expect(imported.some((entry) => entry.task === sourceJobs.find((source) => source.id === id)!.prompt)).toBe(false)
  } finally { store.close() }
  const result = report()
  expectSkipped(result.items, 'past', /past|прош|ист[её]к/i)
  const manual = files(f.home).filter((path) => path.endsWith('/manual-review.md')).map(text).join('\n')
  expect(manual).toContain('Hermes script')
  expect(manual).toContain('printf hermes-script-review')
  expect(manual).toContain('Hermes no-agent')
})

test('test_c10_redacts_secrets_preserves_source_bytes_and_repeated_application_changes_nothing', { timeout: TIMEOUT }, async () => {
  const secrets = {
    SAMPLE_KEY: 'fixture-hermes-repeat-key-10A!', SERVICE_PASSWORD: 'fixture-hermes-repeat-password-10B!',
    TELEGRAM_BOT_TOKEN: '700010:AAFixtureHermesTokenOnly101010101010', DEEPSEEK_API_KEY: 'fixture-hermes-repeat-deepseek-10C!',
    DEEPSEEK_BASE_URL: 'https://fixture-private-deepseek-10.invalid/v1',
    ANTHROPIC_API_KEY: 'fixture-hermes-repeat-anthropic-10G!', ANTHROPIC_BASE_URL: 'https://fixture-private-anthropic-10.invalid/v1',
  }
  install(f.source, { ...secrets, TELEGRAM_ALLOWED_USERS: '111,222' })
  const credential = '{"client_secret":"fixture-hermes-repeat-file-10D!"}\n'
  put(join(f.source, 'credentials', 'repeat-account.json'), credential)
  const header = 'Bearer fixture-hermes-repeat-header-10E!'
  put(join(f.source, 'config.yaml'), `mcp_servers:\n  repeatserver:\n    url: "https://fixture-repeat-mcp.invalid/rpc"\n    headers:\n      Authorization: ${JSON.stringify(header)}\n`)
  const oauth = 'fixture-hermes-repeat-oauth-10F!'
  json(join(f.source, 'auth.json'), { credential_pool: { anthropic: [{ auth_type: 'oauth', source: 'hermes', access_token: oauth, refresh_token: oauth }] } })
  skill(f.source, 'notes', 'notes')
  put(join(f.source, 'memories', 'MEMORY.md'), 'Remember the fixture.\n§\nRemember the second entry.\n')
  put(join(f.source, 'memories', 'USER.md'), 'The fixture owner uses Linux.\n')
  put(join(f.source, 'SOUL.md'), '# Fixture identity\n\n' + 'Keep useful memories and explain decisions. '.repeat(12) + '\n')
  jobs(f.source, [{ id: 'repeat', name: 'Repeat fixture', prompt: 'Repeatable imported task.', schedule: { kind: 'interval', minutes: 90 }, repeat: { times: 3, completed: 0 }, enabled: true, state: 'active' }])
  const sourceBefore = snapshot(f.source)
  const sensitive = [...Object.values(secrets), credential, 'fixture-hermes-repeat-file-10D!', header, oauth]
  const preview = await migrate(['--dry-run', '--include-secrets'])
  ok(preview)
  noLeaks(preview, sensitive, '')
  const first = await migrate()
  ok(first)
  expectSecret('SAMPLE_KEY', secrets.SAMPLE_KEY)
  expectSecret(secretName(credential), credential)
  expect(envValue('TELEGRAM_BOT_TOKEN') === secrets.TELEGRAM_BOT_TOKEN).toBe(true)
  const firstReport = report()
  noLeaks(first, sensitive, firstReport.text)
  expect(snapshot(f.source), 'source bytes and directory entries after application').toEqual(sourceBefore)
  const destinationBefore = snapshot(f.home)
  const envBefore = readFileSync(f.envFile)
  const second = await migrate()
  ok(second)
  expect(snapshot(f.source), 'source bytes after repeated application').toEqual(sourceBefore)
  expect(snapshot(f.home), 'repeat does not rewrite data or create another report').toEqual(destinationBefore)
  expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  noLeaks(second, sensitive, files(join(f.home, 'migration')).filter((path) => path.endsWith('/report.json')).map(text).join('\n'))
})
