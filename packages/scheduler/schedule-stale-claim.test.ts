// A claimed run waits twice before it starts: behind the earlier runs of its
// batch, and then behind the owner's turn in the main lane. Pause, resume and
// update during either wait replace the reservation. The ticker re-reads the
// row right before runJob, and runJob re-reads it through `claim.isCurrent()`
// inside the lane, the way runPlannedJob of the daemon does; a stale
// reservation starts nothing and leaves no row in schedule_runs.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createScheduleTicker, type ScheduledClaim } from '../app/src/schedule.js'
import { openStore, type Store } from '../store/src/index.js'
import { claimIsCurrent, createScheduleRegistry, type ScheduleRecord, type ScheduleRegistry } from './src/index.js'

const MINUTE = 60_000
const T0 = new Date('2026-10-23T10:00:00Z')

const scratch: string[] = []
const stores: Store[] = []

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sched-stale-'))
  scratch.push(dir)
  const store = openStore(join(dir, 'state.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface World {
  registry: ScheduleRegistry
  setClock(at: number): void
}

function world(ids: string[]): World {
  let clock = new Date(T0.getTime())
  let sequence = 0
  const registry = createScheduleRegistry(open(), {
    now: () => clock,
    id: () => ids[sequence++] ?? `job-${sequence}`,
    timeZone: 'UTC',
  })
  return {
    registry,
    setClock(at) {
      clock = new Date(at)
    },
  }
}

/** The main lane of the daemon: one turn at a time, a planned run queues behind the owner's turn. */
function lane(): { hold(): () => void; run<T>(work: () => Promise<T>): Promise<T> } {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    hold() {
      let release = (): void => undefined
      const turn = new Promise<void>((resolve) => {
        release = resolve
      })
      chain = chain.then(() => turn)
      return release
    },
    run(work) {
      const turn = chain.then(work)
      chain = turn.then(
        () => undefined,
        () => undefined,
      )
      return turn
    },
  }
}

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('test_claimIsCurrent_tracks_pause_resume_update_and_remove_of_the_claimed_row', () => {
  const { registry, setClock } = world(['one'])
  registry.create({ spec: 'every 2m', task: 'проверить' })
  setClock(T0.getTime() + 2 * MINUTE + 10_000)
  const claimed = registry.claim('one', new Date(T0.getTime() + 2 * MINUTE + 10_000))
  expect(claimed, 'the due job is claimed').not.toBeNull()
  const job = claimed as ScheduleRecord
  expect(claimIsCurrent(registry, job), 'a fresh reservation is current').toBe(true)

  registry.pause('one')
  expect(claimIsCurrent(registry, job), 'a paused job is not current').toBe(false)
  registry.resume('one')
  // resume lands on the same next moment the claim wrote; only the generation tells them apart
  expect(registry.get('one')?.nextRunAt?.getTime(), 'resume recomputes the same next moment').toBe(job.nextRunAt?.getTime())
  expect(claimIsCurrent(registry, job), 'pause and resume replace the reservation').toBe(false)

  const again = registry.claim('one', new Date(T0.getTime() + 4 * MINUTE + 10_000)) as ScheduleRecord
  expect(claimIsCurrent(registry, again), 'a new claim is current').toBe(true)
  registry.update('one', { task: 'другое' })
  expect(claimIsCurrent(registry, again), 'update replaces the reservation').toBe(false)

  const third = registry.claim('one', new Date(T0.getTime() + 6 * MINUTE + 10_000)) as ScheduleRecord
  expect(claimIsCurrent(registry, third), 'the claim after update is current').toBe(true)
  registry.remove('one')
  expect(claimIsCurrent(registry, third), 'a removed job is not current').toBe(false)
})

test('test_pause_and_resume_of_the_second_job_during_the_first_run_of_the_batch_drop_its_stale_claim', async () => {
  const { registry, setClock } = world(['first', 'second'])
  registry.create({ spec: 'every 2m', task: 'первое' })
  registry.create({ spec: 'every 2m', task: 'второе' })

  const ran: string[] = []
  let during: (() => void) | undefined
  const ticker = createScheduleTicker({
    registry,
    runJob: async (job: ScheduleRecord, claim: ScheduledClaim) => {
      if (!claim.isCurrent()) return
      ran.push(job.id)
      during?.()
      registry.recordRun({ jobId: job.id, startedAt: new Date(), durationMs: 1, status: 'ok', output: `run ${job.id}` })
    },
    isOwnerBusy: () => false,
    now: () => new Date(T0.getTime() + 2 * MINUTE + 10_000),
  })

  setClock(T0.getTime() + 2 * MINUTE + 10_000)
  during = () => {
    during = undefined
    registry.pause('second')
    registry.resume('second')
  }
  await ticker.tick()
  expect(ran, 'only the first job of the batch runs').toEqual(['first'])
  expect(registry.history('second'), 'the dropped claim leaves no history row').toHaveLength(0)
  expect(registry.history('first'), 'the first run is in the history').toHaveLength(1)

  await ticker.tick()
  expect(ran, 'the second job does not run at once after resume').toEqual(['first'])

  // the next planned moment of the second job runs it as usual
  const later = createScheduleTicker({
    registry,
    runJob: async (job: ScheduleRecord, claim: ScheduledClaim) => {
      if (!claim.isCurrent()) return
      ran.push(job.id)
    },
    isOwnerBusy: () => false,
    now: () => new Date(T0.getTime() + 4 * MINUTE + 10_000),
  })
  await later.tick()
  expect(ran, 'both jobs run at the next planned moment').toEqual(['first', 'first', 'second'])
})

for (const change of ['pause', 'pause+resume', 'update'] as const) {
  test(`test_${change}_during_the_owner_turn_drops_a_claim_waiting_in_the_main_lane`, async () => {
    const { registry, setClock } = world(['waiting'])
    registry.create({ spec: 'every 2m', task: 'ждущее' })
    const main = lane()
    const ran: string[] = []
    const ticker = createScheduleTicker({
      registry,
      // the shape of runPlannedJob: the reservation is read again inside the lane, before the turn
      runJob: (job: ScheduleRecord, claim: ScheduledClaim) =>
        main.run(async () => {
          if (!claim.isCurrent()) return
          ran.push(job.id)
          registry.recordRun({ jobId: job.id, startedAt: new Date(), durationMs: 1, status: 'ok', output: 'run' })
        }),
      isOwnerBusy: () => true,
      now: () => new Date(T0.getTime() + 2 * MINUTE + 10_000),
    })

    setClock(T0.getTime() + 2 * MINUTE + 10_000)
    const release = main.hold()
    const tick = ticker.tick()
    await settle()
    expect(ran, 'the claimed run waits for the owner turn').toEqual([])
    expect(registry.get('waiting')?.nextRunAt?.getTime(), 'the run is already claimed').toBeGreaterThan(
      T0.getTime() + 2 * MINUTE + 10_000,
    )

    if (change === 'update') {
      registry.update('waiting', { task: 'новое' })
    } else {
      registry.pause('waiting')
      if (change === 'pause+resume') registry.resume('waiting')
    }
    release()
    await tick

    expect(ran, 'the stale claim does not start after the owner turn').toEqual([])
    expect(registry.history('waiting'), 'the stale claim leaves no history row').toHaveLength(0)
    expect(registry.get('waiting')?.paused, 'the job keeps the state the owner gave it').toBe(change === 'pause')
  })
}

test('test_a_claim_waiting_in_the_main_lane_without_changes_runs_after_the_owner_turn', async () => {
  const { registry, setClock } = world(['waiting'])
  registry.create({ spec: 'every 2m', task: 'ждущее' })
  const main = lane()
  const ran: string[] = []
  const ticker = createScheduleTicker({
    registry,
    runJob: (job: ScheduleRecord, claim: ScheduledClaim) =>
      main.run(async () => {
        if (!claim.isCurrent()) return
        ran.push(job.id)
        registry.recordRun({ jobId: job.id, startedAt: new Date(), durationMs: 1, status: 'ok', output: 'run' })
      }),
    isOwnerBusy: () => true,
    now: () => new Date(T0.getTime() + 2 * MINUTE + 10_000),
  })

  setClock(T0.getTime() + 2 * MINUTE + 10_000)
  const release = main.hold()
  const tick = ticker.tick()
  await settle()
  expect(ran, 'the claimed run waits for the owner turn').toEqual([])
  release()
  await tick
  expect(ran, 'the untouched claim runs right after the owner turn').toEqual(['waiting'])
  expect(registry.history('waiting'), 'the run is in the history').toHaveLength(1)
})
