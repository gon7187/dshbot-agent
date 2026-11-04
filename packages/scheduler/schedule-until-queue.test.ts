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
