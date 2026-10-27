import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 180_000
const originalSpec = '0 9 * * *'
const changedSpec = '30 11 * * *'
const originalTask = 'Read the migration notes.\nSummarize decisions for the owner.'
const changedTask = 'Read the revised migration notes.\nSummarize risks for the owner.'
const FORMATS = ['sqlite', 'json-id', 'json-name'] as const
type Format = typeof FORMATS[number]
const identityCases = FORMATS.flatMap((format) =>
  ['weekly-notes', '__proto__', 'constructor', 'toString'].map((identity) => ({ format, identity })))
interface Item { kind: string; name: string; status: string; reason?: string }
interface Reply { items: Item[]; report?: string }
interface ScheduleRow { id: string; spec: string; task: string }
let root: string
let source: string
let home: string
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function writeJobs(format: Format, identities: string[], task = originalTask, spec = originalSpec): void {
  const jobs = identities.map((identity) => ({
    ...(format === 'json-id' ? { id: identity } : {}),
    name: format === 'json-name' ? identity : `Job ${identity}`,
    enabled: true, agentId: 'main',
    schedule: { kind: 'cron', expr: spec, tz: 'UTC' },
    payload: { kind: 'agentTurn', message: task },
  }))
  if (format !== 'sqlite') {
    put(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs }, null, 2) + '\n')
    return
  }
  mkdirSync(join(source, 'state'), { recursive: true })
  const db = new DatabaseSync(join(source, 'state', 'openclaw.sqlite'))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
      store_key TEXT, job_id TEXT, name TEXT, enabled INTEGER,
      agent_id TEXT, payload_kind TEXT, job_json TEXT)`)
    db.exec('DELETE FROM cron_jobs')
    const insert = db.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
    for (const [index, job] of jobs.entries()) {
      // The SQLite identity is only in job_id, just as in the neighbouring tests.
      insert.run('default', identities[index], job.name, 1, 'main', 'agentTurn', JSON.stringify(job))
    }
  } finally { db.close() }
}

// Use the public CLI in a fresh process on every import, as in
// content-reconciliation.test.ts: identity must survive serialization to disk.
async function migrate(flags: string[] = [], conflictAllowed = false): Promise<Reply> {
  const child = spawn('/bin/sh', ['-c', 'exec "$@"', 'schedule-identity-test', cli,
    'openclaw', '--from', source, '--home', home, '--env-file', join(root, 'daemon-vars.conf'),
    '--json', '--yes', ...flags], {
    cwd: repoRoot,
    env: {
      HOME: join(root, 'runtime-user'), USERPROFILE: join(root, 'runtime-user'), LANG: 'C.UTF-8',
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const run = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
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
  expect(run.signal, 'migration must finish normally').toBeNull()
  if (conflictAllowed) expect([0, 1], run.stderr).toContain(run.code)
  else expect(run.code, run.stderr).toBe(0)
  expect(run.stdout.trim(), 'CLI must return a JSON plan').toMatch(/^\{/)
  const result = JSON.parse(run.stdout) as Reply
  expect(Array.isArray(result.items)).toBe(true)
  return result
}

function scheduleItem(result: Reply, identity: string): Item {
  const found = result.items.filter((entry) => entry.kind === 'schedule' && entry.name === identity && entry.status !== 'warning')
  expect(found, 'the source job must reach schedule migration').toHaveLength(1)
  return found[0]
}

function rows(): ScheduleRow[] {
  const path = join(home, 'state.db')
  expect(existsSync(path), 'first migration must create the schedule database').toBe(true)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT id, spec, task FROM schedules ORDER BY id').all() as ScheduleRow[]
  } finally { db.close() }
}

function onlyRow(): ScheduleRow {
  const result = rows()
  expect(result, 'reimport must retain exactly one schedule row').toHaveLength(1)
  return result[0]
}

function expectSavedIdentity(identity: string, rowId: string): void {
  const path = join(home, 'migration', 'openclaw-state.json')
  expect(existsSync(path), 'migration must persist the source identity').toBe(true)
  const state = JSON.parse(readFileSync(path, 'utf8')) as { schedules: Record<string, { id: string }> }
  expect(Object.hasOwn(state.schedules, identity), 'special names must serialize as own keys').toBe(true)
  expect(state.schedules[identity]).toEqual({ id: rowId })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-schedule-identity-'))
  source = join(root, 'source')
  home = join(root, 'destination')
  for (const dir of [source, home, join(root, 'runtime-user')]) mkdirSync(dir, { recursive: true })
  put(join(source, 'openclaw.json'), '{}\n')
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

test.each(identityCases)('test_c1_[$format][$identity]_changed_text_conflicts_without_a_duplicate', { timeout: TIMEOUT }, async ({ format, identity }) => {
  writeJobs(format, [identity])
  expect(scheduleItem(await migrate(), identity).status).toBe('applied')
  const previous = onlyRow()
  expect(previous).toMatchObject({ task: originalTask, spec: originalSpec })

  writeJobs(format, [identity], changedTask)
  const conflict = scheduleItem(await migrate([], true), identity)
  expect(conflict.status).toBe('conflict')
  expect(conflict.reason).toMatch(/текст|text|prompt|message|содержим/i)
  expect(conflict.reason).toMatch(/измен|отлич|друг|change|differ|modif|mismatch/i)
  expect(rows()).toEqual([previous])
  expectSavedIdentity(identity, previous.id)
})

test.each(identityCases)('test_c2_[$format][$identity]_overwrite_updates_text_in_the_same_row', { timeout: TIMEOUT }, async ({ format, identity }) => {
  writeJobs(format, [identity])
  expect(scheduleItem(await migrate(), identity).status).toBe('applied')
  const previous = onlyRow()

  writeJobs(format, [identity], changedTask)
  expect(scheduleItem(await migrate(['--overwrite']), identity).status).toBe('applied')
  expect(onlyRow()).toEqual({ id: previous.id, spec: originalSpec, task: changedTask })
  expectSavedIdentity(identity, previous.id)
  expect(scheduleItem(await migrate(), identity).status).toBe('skipped')
  expect(onlyRow()).toEqual({ id: previous.id, spec: originalSpec, task: changedTask })
})

test.each(identityCases)('test_c3_[$format][$identity]_changed_spec_conflicts_then_updates_the_same_row', { timeout: TIMEOUT }, async ({ format, identity }) => {
  writeJobs(format, [identity])
  expect(scheduleItem(await migrate(), identity).status).toBe('applied')
  const previous = onlyRow()

  writeJobs(format, [identity], originalTask, changedSpec)
  const conflict = scheduleItem(await migrate([], true), identity)
  expect(conflict.status).toBe('conflict')
  expect(conflict.reason?.trim()).toBeTruthy()
  expect(rows()).toEqual([previous])
  expect(scheduleItem(await migrate(['--overwrite']), identity).status).toBe('applied')
  expect(onlyRow()).toEqual({ id: previous.id, spec: changedSpec, task: originalTask })
  expectSavedIdentity(identity, previous.id)
})

test.each(FORMATS)('test_c8_%s_unchanged_spec_with_edge_spaces_is_skipped_with_exit_zero', { timeout: TIMEOUT }, async (format) => {
  const identity = 'spaced-cron'
  writeJobs(format, [identity], originalTask, ` ${originalSpec} `)
  expect(scheduleItem(await migrate(), identity).status).toBe('applied')
  const previous = onlyRow()
  expect(previous).toMatchObject({ spec: originalSpec, task: originalTask })
  const statePath = join(home, 'migration', 'openclaw-state.json')
  expect(existsSync(statePath)).toBe(true)
  const stateBefore = readFileSync(statePath)

  const repeated = await migrate()
  expect(scheduleItem(repeated, identity).status).toBe('skipped')
  expect(repeated.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error')).toEqual([])
  expect(rows()).toEqual([previous])
  expect(readFileSync(statePath)).toEqual(stateBefore)
})
