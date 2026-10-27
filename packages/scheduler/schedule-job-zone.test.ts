// The zone of a saved job: a cron given with tz Europe/Moscow fires at the Moscow wall clock, and a row written
// before jobs had a zone keeps firing in UTC. The clock is a variable handed to the registry and to the ticker.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createScheduleTicker } from '../app/src/schedule.js'
import { openStore, type Store } from '../store/src/index.js'
import {
  createScheduleRegistry,
  createScheduleTool,
  parseSchedule,
  SCHEDULER_NAMESPACE,
  type ScheduleRecord,
} from './src/index.js'

// Friday 2026-10-23, 13:00 in Moscow; the next weekday 09:00 is Monday.
const CREATED = new Date('2026-10-23T10:00:00Z')
const CRON = '0 9 * * 1-5'

const scratch: string[] = []
const stores: Store[] = []
const savedZone = process.env.DSHBOT_TZ

function newPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sched-zone-'))
  scratch.push(dir)
  return join(dir, 'state.db')
}

function open(path: string): Store {
  const store = openStore(path)
  stores.push(store)
  return store
}

afterEach(() => {
  if (savedZone === undefined) delete process.env.DSHBOT_TZ
  else process.env.DSHBOT_TZ = savedZone
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Ticks the daemon ticker at each given instant and returns the ids that ran, per instant. */
async function runsAt(
  registry: ReturnType<typeof createScheduleRegistry>,
  instants: string[],
): Promise<string[][]> {
  let clock = new Date(instants[0] as string)
  const ran: string[] = []
  const ticker = createScheduleTicker({
    registry,
    runJob: async (job: ScheduleRecord) => {
      ran.push(job.id)
    },
    isOwnerBusy: () => false,
    now: () => clock,
  })
  const result: string[][] = []
  for (const instant of instants) {
    clock = new Date(instant)
    ran.length = 0
    await ticker.tick()
    result.push([...ran])
  }
  return result
}

test('test_tz_cron_with_the_moscow_zone_fires_at_06_00_utc', async () => {
  const registry = createScheduleRegistry(open(newPath()), { now: () => CREATED, id: () => 'moscow' })
  const tool = createScheduleTool({ registry })

  await tool.execute({ action: 'create', schedule: CRON, task: 'курс доллара', tz: 'Europe/Moscow' })

  const job = registry.get('moscow')!
  expect(job.nextRunAt, '09:00 in Moscow on Monday is 06:00 UTC').toEqual(new Date('2026-10-26T06:00:00Z'))

  const ran = await runsAt(registry, [
    '2026-10-26T05:59:00Z',
    '2026-10-26T06:00:00Z',
    // the UTC reading of the same expression must not fire it a second time
    '2026-10-26T09:00:00Z',
    '2026-10-27T05:59:00Z',
    '2026-10-27T06:00:00Z',
  ])
  expect(ran).toEqual([[], ['moscow'], [], [], ['moscow']])
  expect(registry.get('moscow')!.nextRunAt).toEqual(new Date('2026-10-28T06:00:00Z'))
})

test('test_tz_row_saved_before_jobs_had_a_zone_keeps_firing_in_utc', async () => {
  const path = newPath()

  // The scheduler tables as they were before the zone: two migration steps, no tz column.
  const legacy = open(path)
  legacy.migrate(SCHEDULER_NAMESPACE, [
    `CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      schedule TEXT NOT NULL,
      task TEXT NOT NULL,
      idle_only INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      last_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (next_run_at) WHERE next_run_at IS NOT NULL`,
  ])
  legacy
    .db.prepare(
      'INSERT INTO schedules (id, spec, schedule, task, idle_only, next_run_at, created_at, last_error) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)',
    )
    .run(
      'old-utc',
      CRON,
      JSON.stringify(parseSchedule(CRON)),
      'старое задание',
      Date.parse('2026-10-26T09:00:00Z'),
      CREATED.getTime(),
    )
  legacy.close()

  // The owner now lives in Moscow; the old row must not move with them.
  process.env.DSHBOT_TZ = 'Europe/Moscow'
  const registry = createScheduleRegistry(open(path), { now: () => CREATED })

  expect(registry.get('old-utc')!.nextRunAt).toEqual(new Date('2026-10-26T09:00:00Z'))
  const ran = await runsAt(registry, [
    '2026-10-26T06:00:00Z',
    '2026-10-26T09:00:00Z',
    '2026-10-27T06:00:00Z',
    '2026-10-27T09:00:00Z',
  ])
  expect(ran).toEqual([[], ['old-utc'], [], ['old-utc']])
})
