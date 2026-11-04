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
