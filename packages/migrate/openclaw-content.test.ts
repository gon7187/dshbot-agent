import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createReadTracker, createSkillStore, createSkillTools } from '../learn/src/index.js'
import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'
import { liveOpenClawGateway } from './src/run.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 90_000
type Obj = Record<string, unknown>
interface Item { kind: string; name: string; source: string; target: string; status: string; reason?: string }
interface Reply { items: Item[]; report?: string; [key: string]: unknown }
interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface Job {
  id: string
  name: string
  enabled: boolean
  agentId: string
  schedule: Obj
  payload: Obj
}
let root: string
let source: string
let workspace: string
let home: string
const children = new Set<ChildProcess>()

function put(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }
function config(value: Obj): void { json(join(source, 'openclaw.json'), value) }
function text(path: string): string {
  expect(existsSync(path), `expected migrated file ${path}`).toBe(true)
  return readFileSync(path, 'utf8')
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function snapshot(dir: string): Record<string, { hash: string; mode: number; mtime: number }> {
  return Object.fromEntries(files(dir).map((path) => {
    const stat = statSync(path)
    return [relative(dir, path), {
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mode: stat.mode & 0o777, mtime: stat.mtimeMs,
    }]
  }))
}

// Same subprocess/registration hook and private HOME as openclaw-cli.test.ts.
// No network, real daemon, interactive confirmation or real gateway is needed.
function migrate(flags: string[] = ['--yes'], destination = home): Promise<Run> {
  const child = spawn('/bin/sh', ['-c', 'exec "$@"', 'migration-content-test', cli,
    'openclaw', '--from', source, '--home', destination,
    '--env-file', join(root, 'daemon-vars.conf'), '--json', ...flags], {
    cwd: repoRoot,
    env: {
      HOME: join(root, 'runtime-user'), USERPROFILE: join(root, 'runtime-user'), LANG: 'C.UTF-8',
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
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

function reply(run: Run, conflictsAllowed = false): Reply {
  expect(run.signal, 'migration must terminate normally').toBeNull()
  if (conflictsAllowed) expect([0, 1], 'only a reported conflict may make migration nonzero').toContain(run.code)
  else expect(run.code, 'migration exit code').toBe(0)
  expect(run.stdout.trim(), 'the CLI returns a JSON document').toMatch(/^\{/)
  const value = JSON.parse(run.stdout) as Reply
  expect(Array.isArray(value.items), 'the JSON document contains the plan items').toBe(true)
  return value
}

function item(result: Reply, needle: string, status?: string): Item {
  const found = result.items.find((entry) =>
    [entry.name, entry.source, entry.target].some((field) => field?.includes(needle)) &&
    (status === undefined || entry.status === status))
  expect(found, `expected report item ${needle}${status ? ` (${status})` : ''}`).toBeDefined()
  return found!
}

function report(result: Reply): { dir: string; data: Reply; text: string } {
  expect(typeof result.report, 'an applied migration has a report path').toBe('string')
  const body = text(result.report!)
  return { dir: dirname(result.report!), data: JSON.parse(body) as Reply, text: body }
}

function backedUp(result: Reply, previous: Buffer): void {
  const backups = files(join(report(result).dir, 'before'))
  expect(backups.some((path) => readFileSync(path).equals(previous)), 'before/ preserves the previous bytes').toBe(true)
}

function document(name: string, body = 'Reference from OpenClaw.', metadata: string[] = [], description = 'Imported reference'): string {
  return ['---', `name: ${name}`, `description: ${description}`, ...metadata, '---', '', body, ''].join('\n')
}

function nativeDocument(name: string, body: string): string {
  return document(name, `## Procedure\n${body}\n\n## Pitfalls\nKeep the original.\n\n## Verification\nRead the result.`)
}

function skill(base: string, name: string, body?: string, metadata: string[] = []): string {
  const content = document(name, body, metadata)
  put(join(base, name, 'SKILL.md'), content)
  return content
}

function schedules(destination = home) {
  if (!existsSync(join(destination, 'state.db'))) return []
  const store = openStore(join(destination, 'state.db'))
  try { return createScheduleRegistry(store).list() } finally { store.close() }
}

function job(id: string, schedule: Obj, payload: Obj, extra: Partial<Job> = {}): Job {
  return { id, name: `OpenClaw ${id}`, enabled: true, agentId: 'main', schedule, payload, ...extra }
}

function writeJobs(format: 'sqlite' | 'json', jobs: Job[]): void {
  if (format === 'json') {
    json(join(source, 'cron', 'jobs.json'), { jobs })
    return
  }
  mkdirSync(join(source, 'state'), { recursive: true })
  const db = new DatabaseSync(join(source, 'state', 'openclaw.sqlite'))
  try {
    db.exec(`CREATE TABLE cron_jobs (
      store_key TEXT, job_id TEXT, name TEXT, enabled INTEGER,
      agent_id TEXT, payload_kind TEXT, job_json TEXT)`)
    const insert = db.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const entry of jobs) insert.run('default', entry.id, entry.name, Number(entry.enabled), entry.agentId, String(entry.payload.kind), JSON.stringify(entry))
  } finally { db.close() }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-openclaw-content-'))
  source = join(root, 'openclaw-owner', '.openclaw')
  workspace = join(source, 'workspace')
  home = join(root, 'destination')
  for (const dir of [source, workspace, home, join(root, 'runtime-user')]) mkdirSync(dir, { recursive: true })
  config({})
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

test('test_c1_copies_all_five_skill_roots_in_priority_order_and_exposes_imports_in_the_daemon_index', { timeout: TIMEOUT }, async () => {
  workspace = join(root, 'main-workspace')
  const unused = join(root, 'default-workspace')
  config({ agents: { entries: { main: { workspace } }, defaults: { workspace: unused } } })
  skill(join(unused, 'skills'), 'wrong-workspace')
  skill(join(source, 'workspace', 'skills'), 'wrong-fallback')
  const roots = [
    join(workspace, 'skills'), join(workspace, '.agents', 'skills'),
    join(dirname(source), '.agents', 'skills'), join(source, 'skills'),
    join(source, 'agents', 'main', 'agent', 'workshop-skills'),
  ]
  const expected = new Map<string, Buffer>()
  for (const [index, base] of roots.entries()) {
    const name = `root-${index}`
    skill(base, name, `Unique reference from root ${index}.`)
    put(join(base, name, 'scripts', 'run.sh'), '#!/bin/sh\r\nprintf "fixture"\r\n')
    put(join(base, name, 'references', 'nested', 'reference.md'), `root ${index}\n`)
    put(join(base, name, 'routes.json'), '{"routes":["/fixture"]}\n')
    put(join(base, name, 'asset.bin'), Buffer.from([0, 255, 1, 128, index]))
    for (const path of files(join(base, name))) expected.set(join(name, relative(join(base, name), path)), readFileSync(path))
    skill(base, 'priority-shared', `priority ${index}`)
    skill(base, '.wb-report-before-x', 'Hidden backup must stay in the source.')
  }
  const sourceBefore = snapshot(source)
  const workspaceBefore = snapshot(workspace)
  const destinationBefore = snapshot(home)
  const plan = reply(await migrate(['--dry-run']))
  for (let index = 0; index < roots.length; index += 1) item(plan, `root-${index}`)
  expect(snapshot(home), 'dry-run changes no destination bytes').toEqual(destinationBefore)
  const applied = reply(await migrate())
  for (const [path, bytes] of expected) expect(textBytes(join(home, 'skills', path))).toEqual(bytes)
  expect(text(join(home, 'skills', 'priority-shared', 'SKILL.md'))).toBe(document('priority-shared', 'priority 0'))
  const store = createSkillStore({ home })
  for (let index = 0; index < roots.length; index += 1) {
    expect(store.list().find((entry) => entry.name === `root-${index}`)).toMatchObject({ imported: true })
    expect(store.indexLines().some((line) => line.startsWith(`- root-${index} — `))).toBe(true)
    item(report(applied).data, `root-${index}`, 'applied')
  }
  for (const absent of ['.wb-report-before-x', 'wrong-workspace', 'wrong-fallback']) expect(existsSync(join(home, 'skills', absent))).toBe(false)
  expect(snapshot(source)).toEqual(sourceBefore)
  expect(snapshot(workspace)).toEqual(workspaceBefore)

  // Both fallback paths use the same public command, with independent targets.
  const fallback = join(root, 'fallback-workspace')
  skill(join(fallback, 'skills'), 'defaults-selected')
  config({ agents: { defaults: { workspace: fallback } } })
  const defaultsHome = join(root, 'defaults-destination')
  reply(await migrate(['--yes'], defaultsHome))
  expect(text(join(defaultsHome, 'skills', 'defaults-selected', 'SKILL.md'))).toContain('defaults-selected')
  config({})
  skill(join(source, 'workspace', 'skills'), 'state-selected')
  const stateHome = join(root, 'state-destination')
  reply(await migrate(['--yes'], stateHome))
  expect(text(join(stateHome, 'skills', 'state-selected', 'SKILL.md'))).toContain('state-selected')
})

function textBytes(path: string): Buffer {
  expect(existsSync(path), `expected copied file ${path}`).toBe(true)
  return readFileSync(path)
}

test('test_c2_skill_conflicts_skip_rename_or_overwrite_and_never_overwrite_a_builtin', { timeout: TIMEOUT }, async () => {
  const own = nativeDocument('foo', 'Owner original.')
  const incoming = skill(join(workspace, 'skills'), 'foo', 'Incoming OpenClaw reference.')
  const builtinName = 'untrusted-content'
  const builtin = nativeDocument(builtinName, 'Protected builtin original.')
  const builtinDir = join(root, 'builtin-catalog')
  put(join(builtinDir, builtinName, 'SKILL.md'), builtin)
  skill(join(workspace, 'skills'), builtinName, 'OpenClaw must not replace the builtin.')
  for (const policy of ['skip', 'rename', 'overwrite'] as const) {
    const destination = join(root, `conflict-${policy}`)
    const store = createSkillStore({ home: destination, builtinDir })
    store.create('foo', own)
    put(join(destination, 'skills', 'foo', 'scripts', 'old.sh'), 'old support file\n')
    const flags = policy === 'skip' ? ['--yes'] : ['--yes', '--skill-conflict', policy]
    const result = reply(await migrate(flags, destination), true)
    expect(text(join(destination, 'skills', builtinName, 'SKILL.md'))).toBe(builtin)
    if (policy === 'skip') {
      expect(text(join(destination, 'skills', 'foo', 'SKILL.md'))).toBe(own)
      expect(existsSync(join(destination, 'skills', 'foo-openclaw'))).toBe(false)
      item(result, 'foo', 'conflict')
    } else if (policy === 'rename') {
      expect(text(join(destination, 'skills', 'foo', 'SKILL.md'))).toBe(own)
      expect(text(join(destination, 'skills', 'foo-openclaw', 'SKILL.md'))).toBe(incoming.replace('name: foo\n', 'name: foo-openclaw\n'))
      expect(createSkillStore({ home: destination }).list().find((entry) => entry.name === 'foo-openclaw')).toMatchObject({ imported: true })
    } else {
      expect(text(join(destination, 'skills', 'foo', 'SKILL.md'))).toBe(incoming)
      expect(existsSync(join(destination, 'skills', 'foo', 'scripts', 'old.sh'))).toBe(false)
      item(result, 'foo', 'applied')
      backedUp(result, Buffer.from(own))
      backedUp(result, Buffer.from('old support file\n'))
    }
  }
})

test('test_c3_skips_a_darwin_only_skill_with_a_platform_reason', { timeout: TIMEOUT }, async () => {
  skill(join(workspace, 'skills'), 'darwin-only', 'Uses macOS APIs.', ['metadata:', '  openclaw:', '    os: [darwin]'])
  const result = reply(await migrate())
  expect(existsSync(join(home, 'skills', 'darwin-only'))).toBe(false)
  const skipped = item(result, 'darwin-only', 'skipped')
  expect(skipped.reason).toMatch(/linux|darwin|платформ|platform|операцион/i)
})

test('test_c4_skill_env_and_primary_api_key_use_the_secret_vault_only_with_include_secrets', { timeout: TIMEOUT }, async () => {
  const envValue = 'fixture-content-env-W3u!'
  const apiValue = 'fixture-content-api-P6r!'
  skill(join(workspace, 'skills'), 'secret-reference', 'Pass secrets through exec.', [
    'metadata:', '  openclaw:', '    primaryEnv: SERVICE_API_KEY',
  ])
  config({ skills: { entries: { 'secret-reference': { env: { SERVICE_EXTRA_KEY: envValue }, apiKey: apiValue } } } })
  const skipped = await migrate()
  const first = reply(skipped)
  for (const name of ['SERVICE_EXTRA_KEY', 'SERVICE_API_KEY']) {
    expect(skipped.stdout).toContain(name)
    expect(existsSync(join(home, 'secrets', name))).toBe(false)
    item(first, name, 'skipped')
  }
  const included = await migrate(['--yes', '--include-secrets'])
  const result = reply(included)
  for (const [name, value] of [['SERVICE_EXTRA_KEY', envValue], ['SERVICE_API_KEY', apiValue]]) {
    expect(text(join(home, 'secrets', name!))).toBe(value)
    expect(statSync(join(home, 'secrets', name!)).mode & 0o777).toBe(0o600)
    item(result, name!, 'applied')
  }
  const surfaces = skipped.stdout + skipped.stderr + included.stdout + included.stderr + report(result).text
  for (const value of [envValue, apiValue]) expect(surfaces.includes(value), 'secret values stay out of output and reports').toBe(false)
})

test('test_c5_redacts_source_secrets_from_scripts_memory_and_journal_and_warns_without_leaking', { timeout: TIMEOUT }, async () => {
  const values = ['fixture-script-secret-A7!', 'fixture-memory-secret-B8!', 'fixture-journal-secret-C9!']
  config({ env: { vars: { SCRIPT_KEY: values[0], MEMORY_KEY: values[1], JOURNAL_KEY: values[2] } } })
  skill(join(workspace, 'skills'), 'redacted-reference')
  const script = `#!/bin/sh\nprintf '%s' '${values[0]}'\n`
  put(join(workspace, 'skills', 'redacted-reference', 'scripts', 'run.sh'), script)
  put(join(workspace, 'MEMORY.md'), `Remember ${values[1]}.\n`)
  put(join(workspace, 'memory', '2026-10-01.md'), `Daily note ${values[2]}.\n`)
  const before = snapshot(source)
  const run = await migrate()
  const result = reply(run)
  const saved = report(result)
  for (const [path, expected] of [
    ['skills/redacted-reference/scripts/run.sh', script.replace(values[0]!, '[скрыто]')],
    ['memory/MEMORY.md', 'Remember [скрыто].'],
    ['memory/journal/2026-10-01.md', 'Daily note [скрыто].'],
  ]) {
    expect(text(join(home, path!))).toContain(expected)
    const warnings = saved.data.items.filter((entry) => entry.status === 'warning' || /секрет|secret|скры|redact/i.test(entry.reason ?? ''))
    expect(warnings.some((entry) => JSON.stringify(entry).includes(path!.split('/').at(-1)!)), `redaction warning identifies ${path}`).toBe(true)
  }
  expect(saved.text).toMatch(/exec/)
  expect(saved.text).toMatch(/secrets/)
  const migratedText = files(join(home, 'skills')).concat(files(join(home, 'memory'))).map((path) => readFileSync(path, 'utf8')).join('\n')
  for (const value of values) expect((migratedText + run.stdout + run.stderr + saved.text).includes(value), 'redaction never echoes a secret').toBe(false)
  expect(snapshot(source)).toEqual(before)
})

test('test_c6_appends_only_missing_memory_and_user_paragraphs_and_is_idempotent', { timeout: TIMEOUT }, async () => {
  for (const name of ['MEMORY.md', 'USER.md']) {
    put(join(home, 'memory', name), `Existing ${name}.\n\nShared ${name}.\n`)
    put(join(workspace, name), `Shared ${name}.\n\nImported ${name}.\n\nSecond imported ${name}.\n`)
  }
  reply(await migrate())
  for (const name of ['MEMORY.md', 'USER.md']) {
    const migrated = text(join(home, 'memory', name))
    expect(migrated.startsWith(`Existing ${name}.\n\nShared ${name}.\n`)).toBe(true)
    const paragraphs = migrated.split(/\n\s*\n/).map((paragraph) => paragraph.trim())
    for (const paragraph of [`Shared ${name}.`, `Imported ${name}.`, `Second imported ${name}.`]) {
      expect(paragraphs.filter((entry) => entry === paragraph), `one copy of ${paragraph}`).toHaveLength(1)
    }
  }
  const before = snapshot(join(home, 'memory'))
  const repeated = reply(await migrate())
  expect(repeated.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error')).toEqual([])
  expect(snapshot(join(home, 'memory'))).toEqual(before)
})

test('test_c7_daily_notes_create_a_journal_file_or_append_under_the_openclaw_heading', { timeout: TIMEOUT }, async () => {
  put(join(workspace, 'memory', '2026-10-01.md'), 'Imported first day.\n')
  put(join(workspace, 'memory', '2026-10-02.md'), 'Imported second day.\n')
  put(join(home, 'memory', 'journal', '2026-10-01.md'), 'Owner daily note.\n')
  reply(await migrate())
  const existing = text(join(home, 'memory', 'journal', '2026-10-01.md'))
  expect(existing.startsWith('Owner daily note.\n')).toBe(true)
  expect(existing).toMatch(/^#{1,6}\s+Из OpenClaw\s*$/m)
  expect(existing.indexOf('Imported first day.')).toBeGreaterThan(existing.indexOf('Из OpenClaw'))
  expect(text(join(home, 'memory', 'journal', '2026-10-02.md'))).toContain('Imported second day.')
  const before = snapshot(join(home, 'memory'))
  reply(await migrate())
  expect(snapshot(join(home, 'memory'))).toEqual(before)
})

test('test_c8_persona_replaces_missing_or_seed_identity_preserves_custom_identity_and_backs_up_overwrite', { timeout: TIMEOUT }, async () => {
  const soul = 'OpenClaw personality: curious and careful.\n'
  const identity = 'OpenClaw identity: librarian of project notes.\n'
  const custom = 'Owner custom personality. Keep this exact text.\r\n'
  put(join(workspace, 'SOUL.md'), soul)
  put(join(workspace, 'IDENTITY.md'), identity)
  for (const mode of ['missing', 'seed', 'custom', 'overwrite'] as const) {
    const destination = join(root, `persona-${mode}`)
    const path = join(destination, 'memory', 'identity.md')
    if (mode === 'seed') put(path, readFileSync(join(repoRoot, 'persona', 'identity.seed.md')))
    else if (mode !== 'missing') put(path, custom)
    const flags = mode === 'overwrite' ? ['--yes', '--overwrite'] : ['--yes']
    const result = reply(await migrate(flags, destination), mode === 'custom')
    if (mode === 'custom') {
      expect(text(path)).toBe(custom)
      const fallback = text(join(destination, 'memory', 'knowledge', 'openclaw-persona.md'))
      expect(fallback).toContain(soul.trim())
      expect(fallback).toContain(identity.trim())
      expect(result.items.some((entry) => entry.status === 'conflict' && /SOUL|IDENTITY|persona|identity/.test(JSON.stringify(entry)))).toBe(true)
    } else {
      expect(text(path)).toContain(soul.trim())
      expect(text(path)).toContain(identity.trim())
      if (mode === 'overwrite') backedUp(result, Buffer.from(custom))
    }
  }
})

test('test_c9_workspace_guidance_becomes_named_knowledge_files', { timeout: TIMEOUT }, async () => {
  for (const name of ['AGENTS', 'TOOLS', 'HEARTBEAT']) put(join(workspace, `${name}.md`), `Source ${name} guidance.\n`)
  reply(await migrate())
  for (const name of ['AGENTS', 'TOOLS', 'HEARTBEAT']) {
    expect(text(join(home, 'memory', 'knowledge', `openclaw-${name.toLowerCase()}.md`))).toContain(`Source ${name} guidance.`)
  }
})

test.each(['sqlite', 'json'] as const)('test_c10_%s_imports_cron_interval_future_once_and_paused_jobs_and_skips_past_once', { timeout: TIMEOUT }, async (format) => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
  const past = new Date(Date.now() - 7 * 86_400_000).toISOString()
  writeJobs(format, [
    job('morning', { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Moscow' }, { kind: 'agentTurn', message: 'Morning task', model: 'source-model', timeoutSeconds: 90 }),
    job('interval', { kind: 'every', everyMs: 1_800_000, anchorMs: Date.now() }, { kind: 'systemEvent', text: 'Interval task' }),
    job('future', { kind: 'at', at: future }, { kind: 'agentTurn', message: 'Future task' }),
    job('paused', { kind: 'every', everyMs: 3_600_000 }, { kind: 'agentTurn', message: 'Paused task' }, { enabled: false }),
    job('past', { kind: 'at', at: past }, { kind: 'systemEvent', text: 'Past task' }),
  ])
  const before = snapshot(source)
  const result = reply(await migrate())
  const rows = schedules()
  expect(rows).toHaveLength(4)
  const morning = rows.find((entry) => entry.task === 'Morning task')
  expect(morning).toMatchObject({ spec: '0 9 * * *', tz: 'Europe/Moscow', paused: false, schedule: { kind: 'cron', expression: '0 9 * * *' } })
  expect(rows.find((entry) => entry.task === 'Interval task')).toMatchObject({ spec: 'every 30m', schedule: { kind: 'every', intervalMs: 1_800_000 } })
  expect(rows.find((entry) => entry.task === 'Future task')).toMatchObject({ schedule: { kind: 'once', at: new Date(future) }, nextRunAt: new Date(future) })
  expect(rows.find((entry) => entry.task === 'Paused task')).toMatchObject({ paused: true })
  expect(rows.some((entry) => entry.task === 'Past task')).toBe(false)
  expect(item(result, 'past', 'skipped').reason).toMatch(/прош|past|истек|истёк|expired/i)
  expect(snapshot(source)).toEqual(before)
})

test.each(['sqlite', 'json'] as const)('test_c11_%s_command_script_heartbeat_and_other_agent_jobs_are_only_in_manual_review', { timeout: TIMEOUT }, async (format) => {
  const jobs = [
    job('command', { kind: 'cron', expr: '5 8 * * *', tz: 'UTC' }, { kind: 'command', argv: ['touch', join(root, 'must-not-execute')] }),
    job('script', { kind: 'every', everyMs: 1_200_000 }, { kind: 'script', text: 'Script requires owner review' }),
    job('heartbeat', { kind: 'every', everyMs: 1_800_000 }, { kind: 'heartbeat', text: 'Heartbeat requires owner review' }),
    job('other-agent', { kind: 'cron', expr: '15 11 * * *', tz: 'UTC' }, { kind: 'agentTurn', message: 'Other agent private task' }, { agentId: 'researcher' }),
  ]
  writeJobs(format, jobs)
  const result = reply(await migrate())
  expect(schedules()).toEqual([])
  expect(existsSync(join(root, 'must-not-execute'))).toBe(false)
  const review = text(join(report(result).dir, 'manual-review.md'))
  for (const entry of jobs) {
    expect(review).toContain(entry.name)
    expect(item(result, entry.id).status).not.toBe('applied')
  }
  for (const value of ['5 8 * * *', 'touch', 'must-not-execute', 'Script requires owner review', 'Heartbeat requires owner review', 'Other agent private task', '15 11 * * *']) expect(review).toContain(value)
  // Accept either source schedule notation or the converted interval notation.
  expect(review).toMatch(/1200000|20m|20\s*мин/)
  expect(review).toMatch(/1800000|30m|30\s*мин/)
})

test('test_c12_repeated_import_changes_no_skills_memory_or_schedules_and_returns_zero', { timeout: TIMEOUT }, async () => {
  skill(join(workspace, 'skills'), 'repeat-reference', 'Stable imported reference.')
  put(join(workspace, 'MEMORY.md'), 'A durable fact.\n\nAnother fact.\n')
  put(join(workspace, 'USER.md'), 'Owner preference.\n')
  put(join(workspace, 'memory', '2026-10-01.md'), 'Stable daily note.\n')
  writeJobs('json', [job('repeat', { kind: 'every', everyMs: 1_800_000 }, { kind: 'agentTurn', message: 'Stable recurring task' })])
  reply(await migrate())
  expect(createSkillStore({ home }).list().map((entry) => entry.name)).toContain('repeat-reference')
  expect(text(join(home, 'memory', 'MEMORY.md'))).toContain('Another fact.')
  expect(schedules()).toHaveLength(1)
  const skillBefore = snapshot(join(home, 'skills'))
  const memoryBefore = snapshot(join(home, 'memory'))
  const schedulesBefore = schedules()
  const sourceBefore = snapshot(source)
  const result = reply(await migrate())
  expect(result.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error')).toEqual([])
  expect(snapshot(join(home, 'skills'))).toEqual(skillBefore)
  expect(snapshot(join(home, 'memory'))).toEqual(memoryBefore)
  expect(schedules()).toEqual(schedulesBefore)
  expect(snapshot(source)).toEqual(sourceBefore)
})

test('test_c14_mcp_object_prototype_names_are_applied_once_and_then_reported_as_existing', { timeout: TIMEOUT }, async () => {
  const servers = Object.fromEntries(['constructor', 'toString', '__proto__'].map((name) => [name, { command: 'fixture-mcp', args: [name] }]))
  config({ mcp: { servers } })
  json(join(home, 'mcp.json'), { mcpServers: {} })
  const first = reply(await migrate())
  const path = join(home, 'mcp.json')
  const imported = JSON.parse(text(path)) as { mcpServers: Record<string, unknown> }
  expect(Object.keys(imported.mcpServers).sort()).toEqual(Object.keys(servers).sort())
  for (const name of Object.keys(servers)) {
    expect(Object.hasOwn(imported.mcpServers, name)).toBe(true)
    expect(imported.mcpServers[name]).toEqual(servers[name])
    expect(first.items.find((entry) => entry.kind === 'mcp' && entry.name === name)?.status).toBe('applied')
  }
  const before = textBytes(path)
  const second = reply(await migrate())
  for (const name of Object.keys(servers)) {
    const entry = second.items.find((candidate) => candidate.kind === 'mcp' && candidate.name === name)
    expect(entry).toMatchObject({ status: 'skipped' })
    expect(entry?.reason).toMatch(/уже|exist|already/i)
  }
  expect(textBytes(path)).toEqual(before)
})

test('test_c15_gateway_detection_accepts_a_private_proc_root_without_starting_a_gateway_process', () => {
  const proc = join(root, 'proc')
  const cmdline = (pid: string, args: string[]) => put(join(proc, pid, 'cmdline'), args.join('\0') + '\0')
  cmdline('2147480001', ['node', '/srv/gateway/server.js'])
  cmdline('2147480002', ['/bin/sh', cli, 'openclaw', '--from', '/tmp/gateway'])
  put(join(proc, 'self', 'cmdline'), 'openclaw-gateway\0')
  expect(liveOpenClawGateway(proc)).toBe(false)
  cmdline('2147480003', ['node', '/opt/openclaw/dist/entry.js', 'gateway', '--port', '18789'])
  expect(liveOpenClawGateway(proc)).toBe(true)
  rmSync(join(proc, '2147480003'), { recursive: true })
  expect(liveOpenClawGateway(proc)).toBe(false)
  expect(liveOpenClawGateway(join(root, 'absent-proc'))).toBe(false)
})

test('test_c16_long_openclaw_skill_uses_existing_import_metadata_and_is_listed_indexed_and_viewed', { timeout: TIMEOUT }, async () => {
  const name = `openclaw-${'a'.repeat(53)}`
  const description = 'd'.repeat(300)
  const content = document(name, 'Free form instructions without native skill sections.\n\nRead the reference carefully.', [], description)
  expect(name).toHaveLength(62)
  put(join(workspace, 'skills', name, 'SKILL.md'), content)
  reply(await migrate())
  const store = createSkillStore({ home })
  expect(store.list().find((entry) => entry.name === name)).toMatchObject({ name, description, imported: true })
  expect(store.indexLines().some((line) => line.startsWith(`- ${name} — `))).toBe(true)
  const directory = join(home, 'skills', name)
  expect(text(join(directory, 'SKILL.md'))).toBe(content)
  expect(JSON.parse(text(join(directory, '.meta.json')))).toMatchObject({ imported: true })
  expect(readdirSync(directory).sort(), 'the existing .meta.json is the sole import marker').toEqual(['.meta.json', 'SKILL.md'])
  const view = createSkillTools(store, createReadTracker()).find((entry) => entry.name === 'skill_view')
  expect(view).toBeDefined()
  await expect((async () => String(await view!.execute({ name })))()).resolves.toContain(content)
  expect(createSkillStore({ home }).list().find((entry) => entry.name === name)).toMatchObject({ imported: true })
})

test('test_c17_rename_reserves_planned_skill_names_and_repeated_import_is_unchanged_without_conflicts', { timeout: TIMEOUT }, async () => {
  const own = nativeDocument('foo', 'Owner original foo must survive.')
  createSkillStore({ home }).create('foo', own)
  const sources = new Map([
    ['foo', skill(join(workspace, 'skills'), 'foo', 'Source foo has unique instructions.')],
    ['foo-openclaw', skill(join(workspace, 'skills'), 'foo-openclaw', 'Source foo-openclaw has different instructions.')],
  ])
  for (const name of sources.keys()) put(join(workspace, 'skills', name, 'references', 'origin.txt'), `support files of source ${name}\n`)
  const sourceBefore = snapshot(source)
  const flags = ['--yes', '--skill-conflict', 'rename']
  const first = reply(await migrate(flags))
  const dirs = readdirSync(join(home, 'skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name)
  expect(dirs, 'the owner skill and both source skills have separate directories').toHaveLength(3)
  expect(new Set(dirs).size).toBe(3)
  expect(text(join(home, 'skills', 'foo', 'SKILL.md'))).toBe(own)
  const imports = dirs.filter((name) => name !== 'foo')
  const matched = new Set<string>()
  for (const target of imports) {
    const support = text(join(home, 'skills', target, 'references', 'origin.txt'))
    const origin = [...sources.keys()].find((name) => support === `support files of source ${name}\n`)
    expect(origin, `copied support files identify source for ${target}`).toBeDefined()
    expect(matched.has(origin!), 'each source must be copied exactly once').toBe(false)
    matched.add(origin!)
    const expected = sources.get(origin!)!.replace(`name: ${origin}\n`, `name: ${target}\n`)
    expect(text(join(home, 'skills', target, 'SKILL.md'))).toBe(expected)
    expect(createSkillStore({ home }).list().find((entry) => entry.name === target)).toMatchObject({ imported: true })
  }
  expect([...matched].sort()).toEqual([...sources.keys()].sort())
  const applied = first.items.filter((entry) => entry.status === 'applied' && /skills[/\\]/.test(entry.target))
  expect(applied.length, 'both skills were applied').toBeGreaterThanOrEqual(2)
  expect(new Set(applied.map((entry) => entry.target)).size, 'a target receives at most one applied item').toBe(applied.length)
  const before = snapshot(join(home, 'skills'))
  const second = reply(await migrate(flags))
  expect(second.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error'), 'both renamed imports must be recognized on rerun').toEqual([])
  expect(snapshot(join(home, 'skills'))).toEqual(before)
  expect(snapshot(source)).toEqual(sourceBefore)
})
