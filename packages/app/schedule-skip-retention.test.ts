// Skips of planned runs and real runs share the table schedule_runs, but not the retention: a monitor that has no work
// every 15 minutes must not push the ok and error runs out of the history. Real runs keep the last 20 per job, skips
// have their own limit of 200 per job, `schedule history` shows up to 20 runs of each kind, and the wake-up summary
// reads every skip of the period from the table.
//
// The tests drive the registry, the schedule tool and the wake-up summary on a real store database (no daemon): this
// is the code the daemon calls for a planned run, a skip, `schedule history` and a wake-up.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createScheduleRegistry, createScheduleTool, type ScheduleRegistry } from '../scheduler/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import { buildWakeSummary, currentWakeBoundary } from './src/wake-summary.js'

const MINUTE = 60_000
const NOW = new Date('2026-10-23T10:00:00Z')

const scratch: string[] = []
const stores: Store[] = []

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sched-skip-retention-'))
  scratch.push(dir)
  const store = openStore(join(dir, 'state.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Status = 'ok' | 'error' | 'skip'

let clock = 0

function record(registry: ScheduleRegistry, jobId: string, status: Status, output: string): void {
  clock += 1
  registry.recordRun({
    jobId,
    startedAt: new Date(NOW.getTime() + clock * MINUTE),
    durationMs: 5,
    status,
    output,
  })
}

const label = (prefix: string, index: number): string => `${prefix}-${String(index).padStart(3, '0')}`

interface Row {
  status: string
  output: string
}

function tableRows(store: Store, jobId: string): Row[] {
  return store.db
    .prepare('SELECT status, output FROM schedule_runs WHERE job_id = ? ORDER BY id')
    .all(jobId) as unknown as Row[]
}

async function historyRuns(registry: ScheduleRegistry, jobId: string): Promise<Row[]> {
  const tool = createScheduleTool({ registry })
  const parsed = JSON.parse(await tool.execute({ action: 'history', id: jobId })) as { runs: Row[] }
  return parsed.runs
}

test('test_c1_fifty_skips_after_two_ok_runs_do_not_push_the_ok_runs_out_of_history', async () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'mon' })
  registry.create({ spec: 'every 15m', task: 'монитор' })

  record(registry, 'mon', 'ok', 'OK-A')
  record(registry, 'mon', 'ok', 'OK-B')
  for (let i = 0; i < 50; i += 1) record(registry, 'mon', 'skip', label('SKIP', i))

  const runs = await historyRuns(registry, 'mon')
  expect(runs.filter((run) => run.status === 'ok').map((run) => run.output).sort()).toEqual(['OK-A', 'OK-B'])
  expect(registry.history('mon').filter((run) => run.status === 'ok').map((run) => run.output).sort()).toEqual([
    'OK-A',
    'OK-B',
  ])

  // Real runs still keep only the last 20 per job, in the table and in the history, with skips in between.
  for (let i = 0; i < 30; i += 1) {
    record(registry, 'mon', i % 3 === 0 ? 'error' : 'ok', label('REAL', i))
    record(registry, 'mon', 'skip', label('MORE', i))
  }
  const expected = Array.from({ length: 20 }, (_, index) => label('REAL', 10 + index))

  const stored = tableRows(store, 'mon').filter((row) => row.status !== 'skip')
  expect(stored.map((row) => row.output)).toEqual(expected)

  const shown = (await historyRuns(registry, 'mon')).filter((run) => run.status !== 'skip')
  expect(shown.map((run) => run.output).sort()).toEqual([...expected].sort())
})

test('test_c2_skips_have_their_own_limit_of_200_and_never_delete_ok_or_error_runs', () => {
  const store = open()
  const ids = ['mon', 'other']
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => ids.shift() ?? 'extra' })
  registry.create({ spec: 'every 15m', task: 'монитор' })

  record(registry, 'mon', 'ok', 'OK-A')
  record(registry, 'mon', 'error', 'ERR-B')
  record(registry, 'mon', 'ok', 'OK-C')
  for (let i = 0; i < 250; i += 1) record(registry, 'mon', 'skip', label('SKIP', i))

  // Another job's skips are counted separately.
  registry.create({ spec: 'every 20m', task: 'второй' })
  record(registry, 'other', 'skip', 'OTHER-SKIP')

  const rows = tableRows(store, 'mon')
  const skips = rows.filter((row) => row.status === 'skip')
  expect(skips).toHaveLength(200)
  expect(skips.map((row) => row.output)).toEqual(Array.from({ length: 200 }, (_, index) => label('SKIP', 50 + index)))
  expect(rows.filter((row) => row.status !== 'skip').map((row) => [row.status, row.output])).toEqual([
    ['ok', 'OK-A'],
    ['error', 'ERR-B'],
    ['ok', 'OK-C'],
  ])
  expect(tableRows(store, 'other')).toHaveLength(1)
})

test('test_c3_history_shows_at_most_20_latest_skips_with_the_real_runs_and_for_a_removed_job_too', async () => {
  const store = open()
  let sequence = 0
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => `job-${(sequence += 1)}` })
  registry.create({ spec: 'every 15m', task: 'монитор' })

  record(registry, 'job-1', 'ok', 'OK-A')
  record(registry, 'job-1', 'error', 'ERR-B')
  for (let i = 0; i < 50; i += 1) record(registry, 'job-1', 'skip', label('SKIP', i))

  const runs = await historyRuns(registry, 'job-1')
  expect(runs.filter((run) => run.status !== 'skip').map((run) => [run.status, run.output]).sort()).toEqual([
    ['error', 'ERR-B'],
    ['ok', 'OK-A'],
  ])
  expect(
    runs
      .filter((run) => run.status === 'skip')
      .map((run) => run.output)
      .sort(),
  ).toEqual(Array.from({ length: 20 }, (_, index) => label('SKIP', 30 + index)))

  // A removed job keeps its skips in the history, still capped at the 20 latest.
  registry.create({ spec: 'every 15m', task: 'удаляемый' })
  for (let i = 0; i < 30; i += 1) record(registry, 'job-2', 'skip', label('GONE', i))
  const tool = createScheduleTool({ registry })
  await tool.execute({ action: 'remove', id: 'job-2' })
  expect(registry.get('job-2')).toBeUndefined()

  const gone = await historyRuns(registry, 'job-2')
  expect(gone.every((run) => run.status === 'skip')).toBe(true)
  expect(gone.map((run) => run.output).sort()).toEqual(Array.from({ length: 20 }, (_, index) => label('GONE', 10 + index)))
})

test('test_c4_wake_summary_reports_all_50_skips_of_one_job_since_the_boundary', () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'mon' })
  registry.create({ spec: 'every 15m', task: 'монитор' })

  record(registry, 'mon', 'ok', 'OK-BEFORE')
  const boundary = currentWakeBoundary(store.db, NOW.getTime())
  for (let i = 0; i < 50; i += 1) record(registry, 'mon', 'skip', 'нет работы')

  const summary = buildWakeSummary({
    db: store.db,
    boundary,
    now: NOW.getTime() + 120 * MINUTE,
    ownerChatId: null,
    timeZone: 'UTC',
  })
  const lines = summary.split('\n').filter((line) => line.includes('mon'))
  expect(lines.length, `the job is named in the summary\n${summary}`).toBeGreaterThan(0)
  const counted = lines.reduce((sum, line) => sum + Number(/[×x*]\s*(\d+)/.exec(line)?.[1] ?? 1), 0)
  expect(counted, `all 50 skips are counted\n${summary}`).toBe(50)
})
