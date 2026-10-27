import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 180_000
const FORMATS = ['sqlite', 'json-id', 'json-name'] as const
const GUIDANCE = ['AGENTS', 'TOOLS', 'HEARTBEAT', 'BOOTSTRAP'] as const
type Format = typeof FORMATS[number]
type Guidance = typeof GUIDANCE[number]
interface Item { kind: string; name: string; source: string; target: string; status: string; reason?: string }
interface Reply { items: Item[]; report?: string }
interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface ScheduleRow { id: string; spec: string; task: string; [key: string]: unknown }
let root: string
let source: string
let home: string
const children = new Set<ChildProcess>()
const originalTask = 'Read the weekly migration notes.\nSummarize decisions for the owner.'
const changedTask = 'Read the updated migration notes.\nSummarize risks for the owner.'
const originalSpec = '0 9 * * *'
const changedSpec = '30 11 * * *'

function put(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function bytes(path: string): Buffer {
  expect(existsSync(path), `expected migration output ${path}`).toBe(true)
  return readFileSync(path)
}

function snapshot(dir: string) {
  return Object.fromEntries(files(dir).map((path) => {
    const stat = statSync(path)
    return [relative(dir, path), {
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      mode: stat.mode & 0o777,
      // SQLite touches the shared-memory cache even when opening read-only.
      // Its bytes are still compared; its access-related mtime is not data.
      mtime: relative(dir, path) === 'state.db-shm' ? undefined : stat.mtimeMs,
    }]
  }))
}

// The public CLI, registration hook and isolated HOME are the same harness as
// openclaw-content.test.ts. Every reimport starts a fresh process, so source
// identity and the previous imported file contents must survive on disk.
function migrate(flags: string[] = [], adapter: 'openclaw' | 'hermes' = 'openclaw'): Promise<Run> {
  const child = spawn('/bin/sh', ['-c', 'exec "$@"', 'content-reconciliation-test', cli,
    adapter, '--from', source, '--home', home, '--env-file', join(root, 'daemon-vars.conf'),
    '--json', '--yes', ...flags], {
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

function reply(run: Run, conflictsAllowed = false): Reply {
  expect(run.signal, 'CLI must finish normally').toBeNull()
  if (conflictsAllowed) expect([0, 1], 'only a reported conflict may make migration nonzero').toContain(run.code)
  else expect(run.code, run.stderr).toBe(0)
  expect(run.stdout.trim(), 'CLI must return a JSON plan').toMatch(/^\{/)
  const result = JSON.parse(run.stdout) as Reply
  expect(Array.isArray(result.items)).toBe(true)
  return result
}

function onlyScheduleItem(result: Reply): Item {
  const found = result.items.filter((entry) => entry.kind === 'schedule' && entry.status !== 'warning')
  expect(found, 'the source cron job must reach the schedule migration path').toHaveLength(1)
  return found[0]
}

function guidanceItem(result: Reply, name: Guidance): Item {
  const found = result.items.filter((entry) => entry.target.endsWith(`knowledge/openclaw-${name.toLowerCase()}.md`) && entry.status !== 'warning')
  expect(found, `${name} must reach the knowledge migration path`).toHaveLength(1)
  return found[0]
}

function reportItems(result: Reply): Reply {
  expect(typeof result.report, 'a changed or conflicting migration must write a report').toBe('string')
  const report = JSON.parse(bytes(result.report!).toString('utf8')) as Reply
  expect(Array.isArray(report.items)).toBe(true)
  return report
}

function backups(result: Reply): Buffer[] {
  reportItems(result)
  return files(join(dirname(result.report!), 'before')).map((path) => readFileSync(path))
}

function schedules(): ScheduleRow[] {
  const path = join(home, 'state.db')
  expect(existsSync(path), 'first migration must create the schedule database').toBe(true)
  // Read directly, without running schema migrations or mutating the registry.
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare('SELECT * FROM schedules ORDER BY id').all() as ScheduleRow[] } finally { db.close() }
}

function onlySchedule(): ScheduleRow {
  const rows = schedules()
  expect(rows, 'the source job must have exactly one destination row').toHaveLength(1)
  return rows[0]
}

function writeJob(format: Format, task = originalTask, spec = originalSpec): void {
  const job = {
    name: 'Weekly migration notes', enabled: true, agentId: 'main',
    schedule: { kind: 'cron', expr: spec, tz: 'UTC' },
    payload: { kind: 'agentTurn', message: task },
  }
  if (format !== 'sqlite') {
    json(join(source, 'cron', 'jobs.json'), { jobs: [{ ...job, ...(format === 'json-id' ? { id: 'weekly-notes' } : {}) }] })
    return
  }
  mkdirSync(join(source, 'state'), { recursive: true })
  const db = new DatabaseSync(join(source, 'state', 'openclaw.sqlite'))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
      store_key TEXT, job_id TEXT, name TEXT, enabled INTEGER,
      agent_id TEXT, payload_kind TEXT, job_json TEXT)`)
    db.exec('DELETE FROM cron_jobs')
    // Deliberately keep the identity in job_id, rather than a duplicate JSON id.
    db.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('default', 'weekly-notes', job.name, 1, 'main', 'agentTurn', JSON.stringify(job))
  } finally { db.close() }
}

function guidancePath(name: Guidance): string {
  return join(home, 'memory', 'knowledge', `openclaw-${name.toLowerCase()}.md`)
}

function sourceGuidance(name: Guidance, revision = 'original'): string {
  return `# ${name}\n\n${revision} guidance imported from OpenClaw.\n`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-content-reconciliation-'))
  source = join(root, 'source')
  home = join(root, 'destination')
  for (const dir of [source, home, join(root, 'runtime-user')]) mkdirSync(dir, { recursive: true })
  json(join(source, 'openclaw.json'), {})
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

test.each(FORMATS)('test_c1_%s_changed_source_task_conflicts_without_creating_a_second_schedule', { timeout: TIMEOUT }, async (format) => {
  writeJob(format)
  expect(onlyScheduleItem(reply(await migrate())).status).toBe('applied')
  const previous = onlySchedule()
  expect(previous).toMatchObject({ task: originalTask, spec: originalSpec })
  writeJob(format, changedTask)
  const result = reply(await migrate(), true)
  const conflict = onlyScheduleItem(result)
  expect(conflict.status).toBe('conflict')
  expect(conflict.reason).toMatch(/текст|text|prompt|message|содержим/i)
  expect(conflict.reason).toMatch(/измен|отлич|друг|change|differ|modif|mismatch/i)
  expect(onlyScheduleItem(reportItems(result)).status).toBe('conflict')
  expect(schedules()).toEqual([previous])
})

test.each(FORMATS)('test_c2_%s_overwrite_updates_the_imported_task_in_the_same_row', { timeout: TIMEOUT }, async (format) => {
  writeJob(format)
  reply(await migrate())
  const previous = onlySchedule()
  expect(previous.task).toBe(originalTask)
  writeJob(format, changedTask)
  const result = reply(await migrate(['--overwrite']))
  expect(onlyScheduleItem(result).status).toBe('applied')
  expect(onlySchedule()).toMatchObject({ id: previous.id, task: changedTask, spec: originalSpec })
})

test.each(FORMATS)('test_c3_%s_changed_spec_conflicts_then_overwrite_updates_the_same_row', { timeout: TIMEOUT }, async (format) => {
  writeJob(format)
  reply(await migrate())
  const previous = onlySchedule()
  expect(previous).toMatchObject({ task: originalTask, spec: originalSpec })
  writeJob(format, originalTask, changedSpec)
  const conflict = reply(await migrate(), true)
  expect(onlyScheduleItem(conflict).status).toBe('conflict')
  expect(onlyScheduleItem(conflict).reason?.trim()).toBeTruthy()
  expect(schedules()).toEqual([previous])
  const replaced = reply(await migrate(['--overwrite']))
  expect(onlyScheduleItem(replaced).status).toBe('applied')
  expect(onlySchedule()).toMatchObject({ id: previous.id, task: originalTask, spec: changedSpec })
})

test.each(FORMATS)('test_c4_%s_adopts_an_identical_legacy_schedule_without_source_metadata', { timeout: TIMEOUT }, async (format) => {
  writeJob(format)
  // Seed through the scheduler, as neighbouring schedule tests do. No migration
  // has run, so this row has neither a migration report nor source identity.
  const store = openStore(join(home, 'state.db'))
  try { createScheduleRegistry(store).create({ spec: originalSpec, task: originalTask, tz: 'UTC' }) } finally { store.close() }
  const previous = onlySchedule()
  const result = reply(await migrate())
  expect(onlyScheduleItem(result).status).toMatch(/^(skipped|applied)$/)
  expect(result.items.filter((entry) => entry.status === 'conflict')).toEqual([])
  expect(onlySchedule()).toMatchObject({ id: previous.id, spec: originalSpec, task: originalTask })
})

const ownerEditCases = GUIDANCE.flatMap((name) => [false, true].map((changedSource) => ({ name, changedSource })))

test.each(ownerEditCases)('test_c5_$name preserves owner edits, source changed=$changedSource', { timeout: TIMEOUT }, async ({ name, changedSource }) => {
  put(join(source, 'workspace', `${name}.md`), sourceGuidance(name))
  expect(guidanceItem(reply(await migrate()), name).status).toBe('applied')
  expect(bytes(guidancePath(name)).toString('utf8')).toBe(sourceGuidance(name))
  const owned = Buffer.from(`# ${name}\r\n\r\nOwner correction: keep this private local procedure.\r\n`)
  put(guidancePath(name), owned)
  if (changedSource) put(join(source, 'workspace', `${name}.md`), sourceGuidance(name, 'revised'))
  const previous = snapshot(join(home, 'memory', 'knowledge'))
  const result = reply(await migrate(), true)
  expect(guidanceItem(result, name).status).toBe('conflict')
  expect(guidanceItem(result, name).reason?.trim()).toBeTruthy()
  expect(guidanceItem(reportItems(result), name).status).toBe('conflict')
  expect(bytes(guidancePath(name))).toEqual(owned)
  expect(snapshot(join(home, 'memory', 'knowledge'))).toEqual(previous)
})

test.each(ownerEditCases)('test_c6_$name overwrite backs up owner edits, source changed=$changedSource', { timeout: TIMEOUT }, async ({ name, changedSource }) => {
  put(join(source, 'workspace', `${name}.md`), sourceGuidance(name))
  expect(guidanceItem(reply(await migrate()), name).status).toBe('applied')
  const owned = Buffer.from(`# ${name}\r\n\r\nOwner changes that must survive in before/.\r\n`)
  put(guidancePath(name), owned)
  const incoming = sourceGuidance(name, changedSource ? 'revised' : 'original')
  put(join(source, 'workspace', `${name}.md`), incoming)
  const result = reply(await migrate(['--overwrite']))
  expect(guidanceItem(result, name).status).toBe('applied')
  expect(bytes(guidancePath(name)).toString('utf8')).toBe(incoming)
  expect(backups(result).some((value) => value.equals(owned)), 'before/ must preserve the exact owner bytes').toBe(true)
})

test.each(GUIDANCE)('test_c7_%s_unedited_knowledge_tracks_source_updates_without_overwrite', { timeout: TIMEOUT }, async (name) => {
  put(join(source, 'workspace', `${name}.md`), sourceGuidance(name))
  expect(guidanceItem(reply(await migrate()), name).status).toBe('applied')
  expect(bytes(guidancePath(name)).toString('utf8')).toBe(sourceGuidance(name))
  const incoming = sourceGuidance(name, 'revised')
  put(join(source, 'workspace', `${name}.md`), incoming)
  const result = reply(await migrate())
  expect(guidanceItem(result, name).status).toBe('applied')
  expect(result.items.filter((entry) => entry.status === 'conflict')).toEqual([])
  expect(bytes(guidancePath(name)).toString('utf8')).toBe(incoming)
})

test.each(FORMATS)('test_c8_%s_unchanged_reimport_preserves_every_home_file_and_schedule_row', { timeout: TIMEOUT }, async (format) => {
  writeJob(format)
  for (const name of GUIDANCE) put(join(source, 'workspace', `${name}.md`), sourceGuidance(name))
  const first = reply(await migrate())
  expect(onlyScheduleItem(first).status).toBe('applied')
  for (const name of GUIDANCE) expect(guidanceItem(first, name).status).toBe('applied')
  const rows = schedules()
  expect(rows).toHaveLength(1)
  const previous = snapshot(home)
  const result = reply(await migrate())
  expect(result.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error')).toEqual([])
  expect(onlyScheduleItem(result).status).toBe('skipped')
  for (const name of GUIDANCE) expect(guidanceItem(result, name).status).toBe('skipped')
  expect(schedules()).toEqual(rows)
  expect(snapshot(home), 'an unchanged run must not rewrite files or create another report').toEqual(previous)
})

test('test_c9_hermes_skill_conflict_overwrite_preserves_the_entire_previous_tree_in_before', { timeout: TIMEOUT }, async () => {
  const name = 'migration-reference'
  const destination = join(home, 'skills', name)
  const imported = join(source, 'skills', name)
  const document = (body: string): string => `---\nname: ${name}\ndescription: Migration reference\n---\n\n${body}\n`
  put(join(source, 'config.yaml'), '{}\n')
  put(join(destination, 'SKILL.md'), document('Owner instructions to preserve.'))
  put(join(destination, '.meta.json'), '{"imported":false,"note":"owner metadata"}\n')
  put(join(destination, 'references', 'notes.txt'), 'Owner reference notes.\r\n')
  put(join(destination, 'references', 'nested', 'notes.txt'), 'A different nested owner reference.\n')
  put(join(destination, '.hidden', 'asset.bin'), Buffer.from([0, 255, 128, 13, 10, 42]))
  const previous = files(destination).map((path) => readFileSync(path).toString('base64')).sort()
  put(join(imported, 'SKILL.md'), document('Replacement instructions from Hermes.'))
  put(join(imported, 'scripts', 'check.sh'), '#!/bin/sh\nprintf hermes-fixture\n')
  put(join(imported, 'references', 'new.txt'), 'New Hermes supporting material.\n')
  const expected = Object.fromEntries(files(imported).map((path) => [relative(imported, path), readFileSync(path).toString('base64')]))
  // This policy flag alone must authorize replacement; do not also pass the
  // generic --overwrite, which would hide a broken Hermes policy route.
  const result = reply(await migrate(['--skill-conflict', 'overwrite'], 'hermes'))
  const skill = result.items.find((entry) => entry.kind === 'skill' && entry.name === name)
  expect(skill, 'Hermes must collect the conflicting skill').toBeDefined()
  expect(skill!.status).toBe('applied')
  const actual = Object.fromEntries(files(destination).filter((path) => relative(destination, path) !== '.meta.json')
    .map((path) => [relative(destination, path), readFileSync(path).toString('base64')]))
  expect(actual).toEqual(expected)
  // OpenClaw may flatten backup paths. Compare every file's exact bytes,
  // including hidden files, nested same-name files and the previous metadata.
  expect(backups(result).map((value) => value.toString('base64'))).toEqual(expect.arrayContaining(previous))
})
