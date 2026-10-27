// Black-box migration contract. All credentials below are synthetic and live
// inside this test's private temporary directory; no operator env file is read.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const OWNER_KEY = 'telegram.owner_chat_id'
const TIMEOUT = 180_000
type Obj = Record<string, unknown>
interface Fixture { root: string; userHome: string; source: string; home: string; envFile: string }
interface Run { code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }
let f: Fixture
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }
function object(value: unknown): Obj {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected a JSON object').toBe(true)
  return value as Obj
}
function load(path: string): Obj {
  expect(existsSync(path), `expected migration output ${path}`).toBe(true)
  return object(JSON.parse(readFileSync(path, 'utf8')))
}
function config(value: Obj, source = f.source, name = 'openclaw.json'): void { json(join(source, name), value) }
function target(label: string): Pick<Fixture, 'home' | 'envFile'> {
  return { home: join(f.root, label, 'home'), envFile: join(f.root, label, 'daemon-vars.conf') }
}
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: f.userHome, USERPROFILE: f.userHome, LANG: 'C.UTF-8',
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    XDG_RUNTIME_DIR: join(f.root, 'runtime'), ...extra,
  }
}

// Like the neighbouring script and daemon tests, execute the public command in
// a subprocess with a private HOME. The shell handles a not-yet-created script:
// it produces an ordinary exit code, so baseline failures are assertions.
async function command(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return await collect(spawn('/bin/sh', ['-c', 'exec "$@"', 'migration-test', cli, ...args], {
    cwd: repoRoot, env: env(extra), stdio: ['pipe', 'pipe', 'pipe'],
  }))
}
async function migrate(flags: string[], dest = { home: f.home, envFile: f.envFile }, extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return await command(['openclaw', '--from', f.source, '--home', dest.home, '--env-file', dest.envFile, ...flags], extra)
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
    child.stdin?.end() // deliberately non-TTY, never an implicit confirmation
  })
}
function ok(run: Run): void {
  expect(run.signal, 'migration command must finish without a timeout or signal').toBeNull()
  // Do not include raw output in assertion messages: it may contain a leak.
  expect(run.code, 'migration command exit code').toBe(0)
}
function output(run: Run): string { return run.stdout + '\n' + run.stderr }
function mode(path: string): number { return statSync(path).mode & 0o777 }
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
      } else {
        result[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  walk(dir)
  return result
}
function vault(home = f.home): Record<string, string> {
  return Object.fromEntries(files(join(home, 'secrets')).map((path) => [relative(join(home, 'secrets'), path), readFileSync(path, 'utf8')]))
}
function expectSecret(name: string, value: string, home = f.home): void {
  const path = join(home, 'secrets', name)
  expect(existsSync(path), `secret ${name} must be migrated`).toBe(true)
  expect(readFileSync(path).equals(Buffer.from(value)), `exact bytes of ${name}`).toBe(true)
  expect(mode(path), `permissions of ${name}`).toBe(0o600)
}
function expectNoLeaks(run: Run, values: string[], reportText = ''): void {
  for (const [index, value] of values.entries()) {
    for (const [surface, text] of [['stdout', run.stdout], ['stderr', run.stderr], ['report', reportText]]) {
      const escaped = JSON.stringify(value).slice(1, -1)
      expect(text.includes(value) || text.includes(escaped), `synthetic secret #${index} leaked in ${surface}`).toBe(false)
    }
  }
}

// Report field spelling is intentionally flexible: the contract specifies the
// information in an item, not a TypeScript API or a particular nesting scheme.
function objects(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.flatMap(objects)
  if (value === null || typeof value !== 'object') return []
  const obj = value as Obj
  return [obj, ...Object.values(obj).flatMap(objects)]
}
function items(report: Obj): Obj[] { return objects(report).filter((entry) => typeof entry.status === 'string' && typeof entry.name === 'string') }
function hasText(entry: Obj, text: string): boolean { return JSON.stringify(entry).includes(text) }
function itemWith(report: Obj, text: string, status?: string): Obj {
  const found = items(report).find((entry) => hasText(entry, text) && (status === undefined || entry.status === status))
  expect(found, `report item for ${text}${status ? ` (${status})` : ''}`).toBeDefined()
  return found!
}
function reportAt(home = f.home): { path: string; dir: string; text: string; data: Obj } {
  const reports = files(join(home, 'migration')).filter((path) => path.endsWith('/report.json'))
  expect(reports.length, 'an application must create a migration report').toBeGreaterThan(0)
  const path = reports.sort().at(-1)!
  expect(relative(join(home, 'migration'), path)).toMatch(/^openclaw-[^/]+\/report\.json$/)
  const text = readFileSync(path, 'utf8')
  return { path, dir: dirname(path), text, data: object(JSON.parse(text)) }
}
function hasField(entry: Obj, names: string[]): boolean {
  return names.some((name) => entry[name] !== undefined && String(entry[name]).length > 0)
}
function owner(home = f.home): string | undefined {
  const path = join(home, 'state.db')
  expect(existsSync(path), 'migration must create state.db for the owner').toBe(true)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(OWNER_KEY) as { value: string } | undefined
    return row?.value
  } finally { db.close() }
}
function seedOwner(id: string, home = f.home): void {
  mkdirSync(home, { recursive: true })
  const db = new DatabaseSync(join(home, 'state.db'))
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv VALUES (?, ?)').run(OWNER_KEY, id)
  } finally { db.close() }
}
function sourceDb(source = f.source): DatabaseSync {
  mkdirSync(join(source, 'state'), { recursive: true })
  const db = new DatabaseSync(join(source, 'state', 'openclaw.sqlite'))
  db.exec(`CREATE TABLE secret_store_entries (
    scope_kind TEXT, scope_id TEXT, name TEXT, value TEXT, kind TEXT, deleted_at_ms INTEGER);
    CREATE TABLE channel_pairing_allow_entries (channel_key TEXT, account_id TEXT, entry TEXT);`)
  return db
}

const secrets = {
  env: 'fixture-env-Ex9V2!raw', exported: 'fixture-exported-R7x!', shared: 'fixture-shared-T4v!',
  vars: 'fixture-vars-P5y!', zhipu: 'fixture-zhipu-Q9z!', reference: 'fixture-reference-Z6u!',
  process: 'fixture-process-A8r!', db: 'fixture-db-M4s!', dbEnv: 'fixture-db-env-W2n!',
  legacy: 'fixture-legacy-J8c!', current: 'fixture-current-Y1a!', oauth: 'fixture-oauth-C7h!',
  deleted: 'fixture-deleted-F9b!', credential: '{"access_token":"fixture-credential-L3g!"}\n',
  pluginToken: 'fixture-plugin-token-H2q!', pluginKey: 'fixture-plugin-key-U5d!',
  pluginSecret: 'fixture-plugin-secret-E4w!', pluginPassword: 'fixture-plugin-password-B7k!',
  fileReference: 'fixture-file-reference-must-not-resolve-K8f!',
}
function fullSource(): void {
  put(join(f.source, '.env'), `ENV_DIRECT=${secrets.env}\nexport EXPORTED_KEY=${secrets.exported}\nSHARED_KEY=${secrets.shared}\nREF_KEY=${secrets.reference}\n`)
  put(join(f.root, 'unresolved-secret.txt'), secrets.fileReference)
  config({
    env: { vars: { VAR_KEY: secrets.vars, SHARED_KEY: secrets.shared } },
    models: { providers: {
      zhipu: { apiKey: secrets.zhipu },
      moonshot: { apiKey: { source: 'env', provider: 'default', id: 'REF_KEY' } },
      fireworks: { apiKey: { source: 'env', provider: 'default', id: 'PROCESS_REF_KEY' } },
    } },
    plugins: { entries: { sample: { config: {
      token: secrets.pluginToken, apiKey: secrets.pluginKey, secret: secrets.pluginSecret, password: secrets.pluginPassword,
      fileSecret: { source: 'file', provider: 'default', id: join(f.root, 'unresolved-secret.txt') },
      execSecret: { source: 'exec', provider: 'default', id: 'not-to-be-executed' },
    } } } },
  })
  const db = sourceDb()
  try {
    const insert = db.prepare('INSERT INTO secret_store_entries VALUES (?, ?, ?, ?, ?, ?)')
    insert.run('global', '', 'DB_SECRET', secrets.db, 'secret', null)
    insert.run('global', '', 'DB_ENV', secrets.dbEnv, 'env', null)
    insert.run('global', '', 'SHARED_KEY', secrets.shared, 'secret', null)
    insert.run('global', '', 'DELETED_KEY', secrets.deleted, 'secret', 123)
  } finally { db.close() }
  json(join(f.source, 'agents', 'legacy', 'agent', 'auth-profiles.json'), { profiles: {
    'anthropic:default': { type: 'api_key', provider: 'anthropic', key: secrets.legacy },
    'oauth:default': { type: 'oauth', provider: 'oauth', access: secrets.oauth, refresh: secrets.oauth },
  } })
  const agentDir = join(f.source, 'agents', 'current', 'agent')
  mkdirSync(agentDir, { recursive: true })
  const agentDb = new DatabaseSync(join(agentDir, 'openclaw-agent.sqlite'))
  try {
    agentDb.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL)')
    agentDb.prepare('INSERT INTO auth_profile_store VALUES (?, ?)').run('default', JSON.stringify({ profiles: {
      'groq:default': { type: 'api_key', provider: 'groq', key: secrets.current },
    } }))
  } finally { agentDb.close() }
  put(join(f.source, 'credentials', 'service-account.json'), secrets.credential)
  json(join(f.source, 'credentials', 'telegram-default-allowFrom.json'), { version: 1, allowFrom: ['telegram:606'] })
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-migrate-cli-'))
  f = { root, userHome: join(root, 'user'), source: join(root, 'openclaw'), home: join(root, 'destination'), envFile: join(root, 'config', 'daemon-vars.conf') }
  for (const dir of [f.userHome, f.source, f.home, join(root, 'runtime')]) mkdirSync(dir, { recursive: true })
  chmodSync(join(root, 'runtime'), 0o700)
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

test('test_c1_dry_run_prints_one_plan_row_per_item_and_preserves_destination_bytes', { timeout: TIMEOUT }, async () => {
  config({ env: { vars: { PLAN_KEY: secrets.vars } }, commands: { ownerAllowFrom: [101] }, mcp: { servers: { planserver: { command: process.execPath, args: ['--version'] } } } })
  put(join(f.home, 'keep.txt'), 'existing home bytes\r\n')
  put(f.envFile, '# keep these exact bytes\r\nOTHER=untouched\r\n')
  const before = snapshot(f.home)
  const envBefore = readFileSync(f.envFile)
  const run = await migrate(['--dry-run'])
  ok(run)
  expect(snapshot(f.home)).toEqual(before)
  expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  const rows = run.stdout.split(/\r?\n/).filter((line) => line.trim())
  for (const [name, destination] of [['PLAN_KEY', 'secrets'], [OWNER_KEY, 'state.db'], ['planserver', 'mcp.json']]) {
    const row = rows.find((line) => line.includes(name) && line.includes(destination))
    expect(row, `plan row must identify ${name} and its destination`).toBeDefined()
    expect(row).toMatch(/secret|key|owner|telegram|mcp|ключ|секрет|владел/i)
    expect(row).toMatch(/plan|ready|pending|skip|exist|conflict|would|план|готов|пропу|перен|ожида|нов|конфликт/i)
  }
  expectNoLeaks(run, [secrets.vars])
})

test('test_c2_non_tty_requires_yes_and_then_applies_the_same_plan', { timeout: TIMEOUT }, async () => {
  config({ commands: { ownerAllowFrom: ['telegram:123'] } })
  put(f.envFile, '# unchanged\n')
  const before = snapshot(f.home)
  const run = await migrate([])
  ok(run)
  expect(run.stdout).toContain(OWNER_KEY)
  expect(output(run)).toContain('--yes')
  expect(snapshot(f.home)).toEqual(before)
  expect(readFileSync(f.envFile, 'utf8')).toBe('# unchanged\n')
  ok(await migrate(['--yes']))
  expect(owner()).toBe('123')
})

test('test_c3_imports_all_secret_sources_with_exact_values_permissions_and_stable_names', { timeout: TIMEOUT }, async () => {
  fullSource()
  const run = await migrate(['--yes', '--include-secrets'], undefined, { PROCESS_REF_KEY: secrets.process })
  ok(run)
  const named = {
    ENV_DIRECT: secrets.env, EXPORTED_KEY: secrets.exported, SHARED_KEY: secrets.shared, REF_KEY: secrets.reference,
    VAR_KEY: secrets.vars, ZHIPU_API_KEY: secrets.zhipu, MOONSHOT_API_KEY: secrets.reference,
    FIREWORKS_API_KEY: secrets.process, DB_SECRET: secrets.db, DB_ENV: secrets.dbEnv,
    ANTHROPIC_API_KEY: secrets.legacy, GROQ_API_KEY: secrets.current,
  }
  for (const [name, value] of Object.entries(named)) expectSecret(name, value)
  const report = reportAt()
  const stored = vault()
  const derived: Record<string, string> = {}
  for (const [field, value] of Object.entries({
    'plugins.entries.sample.config.token': secrets.pluginToken,
    'plugins.entries.sample.config.apiKey': secrets.pluginKey,
    'plugins.entries.sample.config.secret': secrets.pluginSecret,
    'plugins.entries.sample.config.password': secrets.pluginPassword,
    'credentials/service-account.json': secrets.credential,
  })) {
    const names = Object.keys(stored).filter((name) => stored[name] === value)
    expect(names.length, `one vault entry for ${field}`).toBe(1)
    const name = names[0]
    expect(name).toMatch(/^[A-Z0-9_]{1,64}$/)
    expectSecret(name, value)
    const entry = itemWith(report.data, name, 'applied')
    expect(hasText(entry, field), `report must show field path → derived name for ${field}`).toBe(true)
    derived[field] = name
  }
  expect(Object.values(stored).includes(secrets.deleted), 'deleted SQLite secrets are ignored').toBe(false)
  expect(Object.values(stored).includes(secrets.oauth), 'OAuth credentials are not imported').toBe(false)
  expect(Object.values(stored).includes(secrets.fileReference), 'file SecretRefs must not be resolved automatically').toBe(false)
  expect(Object.keys(stored).some((name) => /ALLOWFROM/i.test(name)), 'Telegram allowFrom files are not secrets').toBe(false)
  expect(items(report.data).filter((entry) => entry.name === 'SHARED_KEY' && entry.status === 'applied')).toHaveLength(1)
  itemWith(report.data, 'plugins.entries.sample.config.fileSecret', 'warning')
  itemWith(report.data, 'plugins.entries.sample.config.execSecret', 'warning')
  expect(report.text).toMatch(/oauth/i)
  expectNoLeaks(run, Object.values(secrets), report.text)
  const second = target('stable-names')
  ok(await migrate(['--yes', '--include-secrets'], second, { PROCESS_REF_KEY: secrets.process }))
  for (const name of Object.values(derived)) expect(vault(second.home)[name] === stored[name], `derived name ${name} is deterministic`).toBe(true)
})

test('test_c4_daemon_environment_appends_absent_keys_and_requires_overwrite_for_conflicts', { timeout: TIMEOUT }, async () => {
  const token = '7000002:AAFixtureOnlyToken_c4_123456789012345'
  const deepseek = 'fixture-deepseek-c4-new-value'
  const base = 'https://api.deepseek.com'
  config({ channels: { telegram: { botToken: token } }, env: { vars: { DEEPSEEK_API_KEY: deepseek, DEEPSEEK_BASE_URL: base } } })
  const original = '# original comment\r\nUNRELATED="spaces stay here"\r\n\r\n'
  put(f.envFile, original)
  chmodSync(f.envFile, 0o644)
  ok(await migrate(['--yes', '--include-secrets']))
  const appended = readFileSync(f.envFile, 'utf8')
  expect(appended.startsWith(original), 'preexisting env bytes remain a prefix').toBe(true)
  expectEnvValue(appended, 'TELEGRAM_BOT_TOKEN', token)
  expectEnvValue(appended, 'DEEPSEEK_API_KEY', deepseek)
  expectEnvValue(appended, 'DEEPSEEK_BASE_URL', base)
  expect(mode(f.envFile)).toBe(0o600)
  for (const name of ['TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) expect(existsSync(join(f.home, 'secrets', name))).toBe(false)
  const dest = target('conflicting-env')
  const prior = '# keep this comment\nexport DEEPSEEK_API_KEY=fixture-existing-c4-key\nUNRELATED=preserved\n'
  put(dest.envFile, prior)
  const conflict = await migrate(['--yes', '--include-secrets'], dest)
  expect(conflict.code).toBe(1)
  expectEnvValue(readFileSync(dest.envFile, 'utf8'), 'DEEPSEEK_API_KEY', 'fixture-existing-c4-key')
  itemWith(reportAt(dest.home).data, 'DEEPSEEK_API_KEY', 'conflict')
  ok(await migrate(['--yes', '--include-secrets', '--overwrite'], dest))
  const replaced = readFileSync(dest.envFile, 'utf8')
  expectEnvValue(replaced, 'DEEPSEEK_API_KEY', deepseek)
  expect(replaced).toContain('# keep this comment\n')
  expect(replaced).toContain('UNRELATED=preserved\n')
  expect(mode(dest.envFile)).toBe(0o600)
})

function expectEnvValue(text: string, key: string, value: string): void {
  const rows = text.split(/\r?\n/).filter((line) => new RegExp(`^(?:export\\s+)?${key}=`).test(line))
  expect(rows.length, `exactly one assignment of ${key}`).toBe(1)
  const raw = rows[0].slice(rows[0].indexOf('=') + 1)
  const unquoted = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw
  expect(unquoted === value, `value of ${key}`).toBe(true)
}

test('test_c5_without_include_secrets_applies_owner_and_mcp_but_leaves_all_secrets_untouched', { timeout: TIMEOUT }, async () => {
  const token = '7000003:AAFixtureOnlyToken_c5_123456789012345'
  config({
    env: { vars: { OMITTED_KEY: secrets.vars, DEEPSEEK_API_KEY: secrets.zhipu } },
    channels: { telegram: { botToken: token } }, commands: { ownerAllowFrom: [321] },
    mcp: { servers: { publicserver: { command: process.execPath, args: ['--version'], env: { API_TOKEN: secrets.pluginToken, REGION: 'test' } } } },
  })
  put(f.envFile, '# no secret writes\r\nUNRELATED=same\r\n')
  const before = readFileSync(f.envFile)
  const run = await migrate(['--yes'])
  ok(run)
  expect(files(join(f.home, 'secrets'))).toEqual([])
  expect(readFileSync(f.envFile).equals(before)).toBe(true)
  expect(owner()).toBe('321')
  const server = object(object(load(join(f.home, 'mcp.json')).mcpServers).publicserver)
  expect(server.command).toBe(process.execPath)
  expect(object(server.env).API_TOKEN).toMatch(/^\$\{secret:[A-Z0-9_]{1,64}\}$/)
  for (const name of ['OMITTED_KEY', 'DEEPSEEK_API_KEY', 'TELEGRAM_BOT_TOKEN']) expect(run.stdout).toContain(name)
  expect(output(run)).toContain('--include-secrets')
  expectNoLeaks(run, [token, secrets.vars, secrets.zhipu, secrets.pluginToken], reportAt().text)
  const fresh = target('no-env-file')
  ok(await migrate(['--yes'], fresh))
  expect(existsSync(fresh.envFile), 'without secrets an absent env file stays absent').toBe(false)
  expect(files(join(fresh.home, 'secrets'))).toEqual([])
  expect(owner(fresh.home)).toBe('321')
})

test('test_c6_owner_precedence_active_account_pairing_credentials_and_existing_owner_conflict', { timeout: TIMEOUT }, async () => {
  const cases: Array<{ config: Obj; expected: string; pairing?: boolean; credentials?: boolean }> = [
    { config: { commands: { ownerAllowFrom: ['telegram:123', 124] }, channels: { telegram: { defaultAccount: 'work', accounts: { other: { allowFrom: [999] }, work: { allowFrom: [222] } }, allowFrom: [333] } } }, expected: '123', pairing: true, credentials: true },
    { config: { commands: { ownerAllowFrom: [123, 'telegram:124'] } }, expected: '123' },
    { config: { channels: { telegram: { defaultAccount: 'work', accounts: { other: { allowFrom: [999] }, work: { allowFrom: ['telegram:222'] } }, allowFrom: [333] } } }, expected: '222', pairing: true, credentials: true },
    { config: { channels: { telegram: { accounts: { sole: { allowFrom: [223] } } } } }, expected: '223', pairing: true },
    { config: { channels: { telegram: { allowFrom: [333] } } }, expected: '333', pairing: true, credentials: true },
    { config: {}, expected: '444', pairing: true, credentials: true },
    { config: {}, expected: '555', credentials: true },
  ]
  for (const [index, sample] of cases.entries()) {
    rmSync(f.source, { recursive: true, force: true })
    config(sample.config)
    if (sample.pairing) {
      const db = sourceDb()
      try {
        db.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?)').run('discord', 'default', '999')
        db.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?)').run('telegram', 'default', 'telegram:444')
      } finally { db.close() }
    }
    if (sample.credentials) json(join(f.source, 'credentials', 'telegram-default-allowFrom.json'), { version: 1, allowFrom: ['telegram:555', 556] })
    const dest = target(`owner-${index}`)
    ok(await migrate(['--yes'], dest))
    expect(owner(dest.home), `owner fallback case ${index}`).toBe(sample.expected)
  }
  config({ commands: { ownerAllowFrom: [123] } })
  seedOwner('987')
  const conflict = await migrate(['--yes'])
  expect(conflict.code).toBe(1)
  expect(owner()).toBe('987')
  itemWith(reportAt().data, OWNER_KEY, 'conflict')
})

test('test_c7_telegram_token_forms_and_live_gateway_conflict_do_not_block_other_items', { timeout: TIMEOUT }, async () => {
  const token = '7000004:AAFixtureOnlyToken_c7_123456789012345'
  put(join(f.source, '.env'), `TG_SOURCE_TOKEN=${token}\n`)
  const forms: Obj[] = [
    { botToken: token },
    { botToken: '${TG_SOURCE_TOKEN}' },
    { botToken: { source: 'env', provider: 'default', id: 'TG_SOURCE_TOKEN' } },
    { defaultAccount: 'work', accounts: { unused: { botToken: '7000099:AAUnusedFixtureToken_c7_123456789' }, work: { botToken: '${TG_SOURCE_TOKEN}' } } },
    { accounts: { sole: { botToken: token } } },
  ]
  for (const [index, telegram] of forms.entries()) {
    config({ channels: { telegram } })
    const dest = target(`token-${index}`)
    ok(await migrate(['--yes', '--include-secrets'], dest))
    expectEnvValue(readFileSync(dest.envFile, 'utf8'), 'TELEGRAM_BOT_TOKEN', token)
  }
  // A harmless live process with exactly the advertised gateway argv. Do not
  // mock detection or depend on a real OpenClaw installation being present.
  const gateway = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', 'openclaw', 'gateway'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(gateway)
  let ready = false
  gateway.stdout?.on('data', () => { ready = true })
  await waitFor(() => ready, 'synthetic gateway must be running')
  config({ channels: { telegram: { botToken: token } }, env: { vars: { OTHER_KEY: secrets.env } }, commands: { ownerAllowFrom: [123] } })
  const dest = target('live-gateway')
  const run = await migrate(['--yes', '--include-secrets'], dest)
  expect(run.code).toBe(1)
  if (existsSync(dest.envFile)) expect(readFileSync(dest.envFile, 'utf8')).not.toContain('TELEGRAM_BOT_TOKEN=')
  expectSecret('OTHER_KEY', secrets.env, dest.home)
  expect(owner(dest.home)).toBe('123')
  const entry = itemWith(reportAt(dest.home).data, 'TELEGRAM_BOT_TOKEN', 'conflict')
  const explanation = JSON.stringify(entry) + output(run)
  expect(explanation).toContain('409')
  expect(explanation).toMatch(/останов|stop/i)
  expect(explanation).toMatch(/@BotFather/i)
  expectNoLeaks(run, [token], reportAt(dest.home).text)
})

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40))
  expect(predicate(), message).toBe(true)
}

test('test_c8_mcp_preserves_fields_merges_servers_redacts_secrets_and_honours_overwrite', { timeout: TIMEOUT }, async () => {
  const envSecrets = { token: secrets.pluginToken, API_KEY: secrets.pluginKey, Client_Secret: secrets.pluginSecret, PASSWORD: secrets.pluginPassword, Authorization: 'Bearer fixture-mcp-env-c8' }
  const headerSecrets = { Authorization: 'Bearer fixture-mcp-header-c8', 'X-Api-Key': 'fixture-mcp-key-c8' }
  const missing = 'dshbot-test-nonexistent-executable-c8'
  const cwd = join(f.root, 'mcp-work')
  mkdirSync(cwd)
  const servers = {
    local: { command: process.execPath, args: ['--version'], cwd, transport: 'stdio', enabled: false, env: { ...envSecrets, REGION: 'eu' } },
    remote: { url: 'https://mcp.example.invalid/rpc', transport: 'sse', enabled: true, headers: { ...headerSecrets, 'X-Region': 'eu' } },
    missing: { command: missing, args: [] },
    missingabs: { command: join(f.root, 'nonexistent-absolute-executable'), args: [] },
    same: { command: process.execPath, args: ['--version'] },
  }
  config({ mcp: { servers } })
  const existing = { keep: { command: process.execPath, args: ['keep-me'] }, same: { command: process.execPath, args: ['old-value'] } }
  json(join(f.home, 'mcp.json'), { mcpServers: existing })
  const run = await migrate(['--yes', '--include-secrets'])
  expect(run.code).toBe(1)
  const imported = object(load(join(f.home, 'mcp.json')).mcpServers)
  expect(imported.keep).toEqual(existing.keep)
  expect(imported.same).toEqual(existing.same)
  expect(object(imported.local)).toMatchObject({ command: process.execPath, args: ['--version'], cwd, transport: 'stdio', enabled: false })
  expect(object(imported.remote)).toMatchObject({ url: servers.remote.url, transport: 'sse', enabled: true })
  expect(object(imported.missing).command).toBe(missing)
  expect(object(imported.missingabs).command).toBe(servers.missingabs.command)
  const report = reportAt()
  itemWith(report.data, 'same', 'conflict')
  itemWith(report.data, missing, 'warning')
  itemWith(report.data, servers.missingabs.command, 'warning')
  for (const [serverName, field, sourceValues] of [['local', 'env', envSecrets], ['remote', 'headers', headerSecrets]] as const) {
    const values = object(object(imported[serverName])[field])
    for (const [key, value] of Object.entries(sourceValues)) {
      expect(values[key], `MCP ${serverName}.${field}.${key} is a secret reference`).toMatch(/^\$\{secret:([A-Z0-9_]{1,64})\}$/)
      const name = /^\$\{secret:([A-Z0-9_]{1,64})\}$/.exec(values[key] as string)![1]
      expectSecret(name, value)
      expect(hasText(itemWith(report.data, name), `mcp.servers.${serverName}.${field}.${key}`)).toBe(true)
    }
  }
  expect(object(object(imported.local).env).REGION).toBe('eu')
  expect(object(object(imported.remote).headers)['X-Region']).toBe('eu')
  expectNoLeaks(run, [...Object.values(envSecrets), ...Object.values(headerSecrets)], report.text)
  ok(await migrate(['--yes', '--include-secrets', '--overwrite']))
  const after = object(load(join(f.home, 'mcp.json')).mcpServers)
  expect(object(after.same)).toMatchObject(servers.same)
  expect(after.keep).toEqual(existing.keep)
})

test('test_c9_live_dshbot_refuses_application_without_writes_but_allows_preview', { timeout: TIMEOUT }, async () => {
  // Same real entry point and Telegram readiness condition as the adjacent
  // daemon tests. No messages are submitted, so no model endpoint is needed.
  let polls = 0
  const held = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    req.resume()
    const method = req.url?.split('?')[0].split('/').at(-1)
    if (method === 'getUpdates') {
      polls++
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 7000042, is_bot: true, first_name: 'Fixture', username: 'migration_fixture_bot' } : true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let daemon: ChildProcess | undefined
  let daemonOutput = ''
  try {
    config({ env: { vars: { BUSY_KEY: secrets.vars } }, commands: { ownerAllowFrom: [123] } })
    const manifest = load(join(repoRoot, 'package.json'))
    const start = object(manifest.scripts).start
    expect(typeof start, 'existing daemon entry point').toBe('string')
    daemon = spawn('/bin/sh', ['-c', `exec ${start as string}`], {
      cwd: repoRoot, env: env({ DSHBOT_HOME: f.home, TELEGRAM_BOT_TOKEN: '7000042:AAFixtureDaemonToken123456789012345', DEEPSEEK_API_KEY: 'fixture-daemon-deepseek-key', TELEGRAM_API_ROOT: origin, DEEPSEEK_BASE_URL: origin + '/anthropic', DSHBOT_DREAM_AT: 'off' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(daemon)
    daemon.stdout?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString('utf8') })
    daemon.stderr?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString('utf8') })
    await waitFor(() => polls > 0 || daemon!.exitCode !== null, 'daemon must start long polling')
    expect(daemon.exitCode, `daemon must stay alive: ${daemonOutput.slice(-1500)}`).toBeNull()
    expect(polls).toBeGreaterThan(0)
    put(f.envFile, '# busy destination\n')
    // Leave startup and its asynchronous menu writes time to settle.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = snapshot(f.home)
    const envBefore = readFileSync(f.envFile)
    const refused = await migrate(['--yes', '--include-secrets'])
    expect(refused.code).toBe(1)
    expect(output(refused)).toMatch(/DSHBOT|dshbot/)
    expect(output(refused)).toMatch(/работает|запущен|останов|running|stop|active|busy/i)
    expect(snapshot(f.home)).toEqual(before)
    expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
    const preview = await migrate(['--dry-run', '--include-secrets'])
    ok(preview)
    expect(preview.stdout).toContain('BUSY_KEY')
    expect(snapshot(f.home)).toEqual(before)
    expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = new Promise<void>((resolve) => daemon!.once('close', () => resolve()))
      daemon.kill('SIGTERM')
      const killTimer = setTimeout(() => daemon!.kill('SIGKILL'), 10_000)
      for (const res of held) res.end(JSON.stringify({ ok: true, result: [] }))
      await closed
      clearTimeout(killTimer)
    }
    if (daemon) children.delete(daemon)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('test_c10_private_report_backup_and_exit_status_expose_names_and_never_secret_values', { timeout: TIMEOUT }, async () => {
  fullSource()
  // Add a conflicting name in the same source and existing destination files
  // which must be backed up before merging the unaffected items.
  const cfg = load(join(f.source, 'openclaw.json'))
  object(object(cfg.env).vars).SHARED_KEY = 'fixture-conflicting-shared-c10'
  object(cfg).channels = { telegram: { botToken: '7000010:AAFixtureToken_c10_12345678901234567' } }
  cfg.mcp = { servers: { added: { command: process.execPath, args: ['--version'] } } }
  config(cfg)
  const oldEnv = '# preserve original bytes\r\nOTHER=value\r\n'
  const oldMcp = '{"mcpServers":{"keep":{"command":"node","args":["old"]}}}\n'
  put(f.envFile, oldEnv)
  put(join(f.home, 'mcp.json'), oldMcp)
  const run = await migrate(['--yes', '--include-secrets'], undefined, { PROCESS_REF_KEY: secrets.process })
  expect(run.code).toBe(1)
  const report = reportAt()
  expect(mode(report.path)).toBe(0o600)
  const entries = items(report.data)
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.some((entry) => entry.status === 'applied')).toBe(true)
  itemWith(report.data, 'SHARED_KEY', 'conflict')
  for (const entry of entries) {
    expect(['applied', 'skipped', 'conflict', 'error', 'warning']).toContain(entry.status)
    expect(hasField(entry, ['kind', 'type']), `item ${String(entry.name)} needs a kind`).toBe(true)
    expect(hasField(entry, ['source', 'from', 'sourcePath']), `item ${String(entry.name)} needs a source`).toBe(true)
    expect(hasField(entry, ['target', 'destination', 'to', 'targetPath']), `item ${String(entry.name)} needs a target`).toBe(true)
    if (entry.status !== 'applied') expect(hasField(entry, ['reason', 'message', 'detail']), `item ${String(entry.name)} needs a reason`).toBe(true)
  }
  const backups = files(join(report.dir, 'before'))
  for (const original of [oldEnv, oldMcp]) {
    const matching = backups.filter((path) => readFileSync(path).equals(Buffer.from(original)))
    expect(matching.length, 'an exact before-copy of each modified existing file').toBe(1)
    expect(mode(matching[0])).toBe(0o600)
  }
  const sensitive = [...Object.values(secrets), 'fixture-conflicting-shared-c10', '7000010:AAFixtureToken_c10_12345678901234567']
  expectNoLeaks(run, sensitive, report.text)
  for (const path of files(f.home).filter((path) => /(?:\.log|\.jsonl)$/.test(path))) {
    expectNoLeaks({ code: 0, signal: null, stdout: readFileSync(path, 'utf8'), stderr: '' }, sensitive)
  }
  config({ env: { vars: { JSON_REPORT_KEY: secrets.env } } })
  const stdoutJson = await migrate(['--dry-run', '--json', '--include-secrets'], target('json-report'))
  ok(stdoutJson)
  expect(() => JSON.parse(stdoutJson.stdout), '--json produces machine-readable JSON').not.toThrow()
  expectNoLeaks(stdoutJson, sensitive)
})

test('test_c11_repeat_application_is_byte_identical_and_reports_already_imported_items', { timeout: TIMEOUT }, async () => {
  config({ env: { vars: { REPEAT_KEY: secrets.env, DEEPSEEK_API_KEY: secrets.zhipu } }, commands: { ownerAllowFrom: [123] }, mcp: { servers: { repeatserver: { command: process.execPath, args: ['--version'] } } } })
  ok(await migrate(['--yes', '--include-secrets']))
  const before = snapshot(f.home)
  const envBefore = readFileSync(f.envFile)
  const run = await migrate(['--yes', '--include-secrets'])
  ok(run)
  expect(snapshot(f.home), 'including reports, a repeated application adds or changes no home files').toEqual(before)
  expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  for (const name of ['REPEAT_KEY', 'DEEPSEEK_API_KEY', OWNER_KEY, 'repeatserver']) {
    const line = run.stdout.split(/\r?\n/).find((row) => row.includes(name))
    expect(line, `repeat plan item ${name}`).toBeDefined()
    expect(line).toMatch(/already|unchanged|skip|exist|уже|без изменений|пропу|совпад/i)
  }
})

test('test_c12_source_files_and_both_sqlite_databases_remain_byte_identical', { timeout: TIMEOUT }, async () => {
  fullSource()
  const before = snapshot(f.source)
  expect(Object.keys(before)).toContain('state/openclaw.sqlite')
  expect(Object.keys(before)).toContain('agents/current/agent/openclaw-agent.sqlite')
  const run = await migrate(['--yes', '--include-secrets'], undefined, { PROCESS_REF_KEY: secrets.process })
  ok(run)
  expectSecret('DB_SECRET', secrets.db)
  expectSecret('GROQ_API_KEY', secrets.current)
  expect(snapshot(f.source), 'source is read-only, including SQLite sidecars and credential files').toEqual(before)
})

test('test_c13_discovers_current_and_legacy_state_paths_reads_json5_and_lists_missing_paths', { timeout: TIMEOUT }, async () => {
  const candidates = [join(f.root, 'env-openclaw'), join(f.userHome, '.openclaw'), join(f.userHome, '.clawdbot'), join(f.userHome, '.moltbot')]
  const configNames = ['openclaw.json', 'clawdbot.json', 'moltbot.json', 'moltbot.json']
  for (const [index, candidate] of candidates.entries()) {
    // A real JSON5 document: comments, unquoted keys and trailing commas.
    put(join(candidate, configNames[index]), `// private synthetic installation\n{\n env: { vars: { DISCOVER_KEY_${index}: 'fixture-discover-${index}', }, },\n commands: { ownerAllowFrom: [${100 + index},], },\n}\n`)
  }
  for (let index = 0; index < candidates.length; index++) {
    const dest = target(`discovery-${index}`)
    const run = await command(['openclaw', '--home', dest.home, '--env-file', dest.envFile, '--yes', '--include-secrets'], { OPENCLAW_STATE_DIR: candidates[0] })
    ok(run)
    expectSecret(`DISCOVER_KEY_${index}`, `fixture-discover-${index}`, dest.home)
    expect(owner(dest.home)).toBe(String(100 + index))
    // Existing directories without any of the known configs must be skipped.
    rmSync(join(candidates[index], configNames[index]))
  }
  const notFound = await command(['openclaw', '--dry-run'], { OPENCLAW_STATE_DIR: candidates[0] })
  expect(notFound.code).toBe(1)
  for (const candidate of candidates) expect(output(notFound)).toContain(candidate)
})
