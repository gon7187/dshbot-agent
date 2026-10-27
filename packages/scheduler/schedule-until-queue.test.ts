// End conditions that must not fire early or leak a run past the deadline:
// a repeating job is removed when `until` has passed, not when its next run
// would be after it; a claimed batch is re-checked before every actual run,
// because the whole batch waits behind the first one.

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
  type FinishedSchedule,
  type ScheduleRecord,
} from './src/index.js'

const MINUTE = 60_000
const T0 = new Date('2026-10-23T10:00:00Z')

const scratch: string[] = []
const stores: Store[] = []

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sched-until-'))
  scratch.push(dir)
  const store = openStore(join(dir, 'state.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('test_until_keeps_a_repeating_job_until_the_deadline_actually_passes', async () => {
  let clock = new Date(T0.getTime())
  let sequence = 0
  const registry = createScheduleRegistry(open(), {
    now: () => clock,
    id: () => (sequence += 1) === 1 ? 'early' : `job-${sequence}`,
    timeZone: 'UTC',
  })
  const tool = createScheduleTool({ registry })
  const created = await tool.execute({
    action: 'create',
    schedule: 'every 2m',
    task: 'проверить страницу',
    until: new Date(T0.getTime() + 5 * MINUTE).toISOString(),
  })
  expect(created, 'the job with an end condition is created').toContain('early')

  const ran: string[] = []
  const notices: FinishedSchedule[] = []
  const ticker = createScheduleTicker({
    registry,
    runJob: async (job: ScheduleRecord) => {
      ran.push(job.id)
    },
    isOwnerBusy: () => false,
    now: () => clock,
    onFinished: (finished) => {
      notices.push(finished)
    },
  })

  clock = new Date(T0.getTime() + 2 * MINUTE + 10_000)
  await ticker.tick()
  expect(ran, 'the first run before the deadline happens').toEqual(['early'])

  clock = new Date(T0.getTime() + 4 * MINUTE + 10_000)
  await ticker.tick()
  expect(ran, 'the second run before the deadline happens').toEqual(['early', 'early'])
  // The next run (after 6m) would be later than the deadline, but the job must
  // stay until the deadline itself; the old code removed it right here.
  expect(notices, 'no notice before the deadline').toHaveLength(0)
  expect(registry.get('early'), 'the job is still saved before the deadline').toBeDefined()

  clock = new Date(T0.getTime() + 5 * MINUTE + 10_000)
  await ticker.tick()
  expect(notices, 'exactly one notice after the deadline').toHaveLength(1)
  expect(notices[0]?.reason, 'the job ended because the deadline passed').toBe('until')
  expect(registry.get('early'), 'the job is gone after the deadline').toBeUndefined()
  expect(ran, 'nothing runs after the deadline').toEqual(['early', 'early'])
})

test('test_until_stops_a_claimed_job_that_waited_for_the_previous_run', async () => {
  let clock = new Date(T0.getTime())
  let sequence = 0
  const registry = createScheduleRegistry(open(), {
    now: () => clock,
    id: () => (sequence += 1) === 1 ? 'a-first' : 'b-second',
    timeZone: 'UTC',
  })
  const tool = createScheduleTool({ registry })
  const until = new Date(T0.getTime() + 3 * MINUTE).toISOString()
  await tool.execute({ action: 'create', schedule: 'every 2m', task: 'первое задание' })
  await tool.execute({ action: 'create', schedule: 'every 2m', task: 'второе задание', until })

  const ran: string[] = []
  const notices: FinishedSchedule[] = []
  const ticker = createScheduleTicker({
    registry,
    runJob: async (job: ScheduleRecord) => {
      ran.push(job.id)
      if (job.id === 'a-first') {
        // The first run is slow enough for the deadline of the second one.
        clock = new Date(T0.getTime() + 3 * MINUTE + 1_000)
      }
    },
    isOwnerBusy: () => false,
    now: () => clock,
    onFinished: (finished) => {
      notices.push(finished)
    },
  })

  clock = new Date(T0.getTime() + 2 * MINUTE)
  await ticker.tick()

  expect(ran, 'only the job whose deadline has not passed runs').toEqual(['a-first'])
  expect(notices, 'the second job is removed with exactly one notice').toHaveLength(1)
  expect(notices[0]?.job.id).toBe('b-second')
  expect(notices[0]?.reason).toBe('until')
  expect(registry.get('b-second'), 'the expired job leaves the table').toBeUndefined()
})

test('test_list_renders_the_next_run_in_the_zone_of_the_owner', async () => {
  const store = open()
  const registry = createScheduleRegistry(store, {
    now: () => T0,
    id: () => 'utc-cron',
    timeZone: 'Europe/Moscow',
  })
  const tool = createScheduleTool({ registry })
  await tool.execute({ action: 'create', schedule: '0 9 * * *', task: 'курс доллара', tz: 'UTC' })

  // A row saved before jobs had a zone: 09:00 UTC is 12:00 in Moscow.
  store.db
    .prepare(
      'INSERT INTO schedules (id, spec, schedule, task, idle_only, next_run_at, created_at, last_error) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)',
    )
    .run(
      'legacy',
      '0 9 * * *',
      JSON.stringify(parseSchedule('0 9 * * *')),
      'старое задание',
      Date.parse('2026-10-24T09:00:00Z'),
      T0.getTime(),
    )

  const listed = JSON.parse(await tool.execute({ action: 'list' })) as {
    jobs: Array<{ id: string; description: string; timeZone: string }>
  }
  const legacy = listed.jobs.find((job) => job.id === 'legacy')
  expect(legacy, 'the legacy row is listed').toBeDefined()
  expect(legacy?.description, 'the next run is shown in the owner zone (12:00)').toContain('12:00 (Europe/Moscow)')
  expect(legacy?.description, 'the cron expression still names the zone it is read in').toContain('(UTC)')

  const created = listed.jobs.find((job) => job.id === 'utc-cron')
  expect(created?.description, 'a new job with an explicit UTC zone is shown in the owner zone too').toContain(
    '12:00 (Europe/Moscow)',
  )
})
