// Unit coverage of the durable part of the scheduler and of the `schedule` tool:
// the shapes the daemon-level schedule-clock test does not pin down (one-shot
// jobs, rejection of an impossible create, the schema without a gate script).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import { createScheduleRegistry, createScheduleTool, SCHEDULER_NAMESPACE } from './src/index.js'

const MINUTE = 60_000
const NOW = new Date('2026-10-23T10:00:00Z')

const scratch: string[] = []
const stores: Store[] = []

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'sched-jobs-'))
  scratch.push(dir)
  const store = openStore(join(dir, 'state.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('test_j1_interval_and_cron_rows_survive_closing_and_reopening_the_store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-jobs-'))
  scratch.push(dir)
  const path = join(dir, 'state.db')

  const first = openStore(path)
  let sequence = 0
  const registry = createScheduleRegistry(first, { now: () => NOW, id: () => `job-${(sequence += 1)}` })
  registry.create({ spec: 'every 30m', task: 'interval job' })
  registry.create({ spec: '*/10 * * * *', task: 'cron job' })
  first.close()

  const second = openStore(path)
  stores.push(second)
  const reopened = createScheduleRegistry(second, { now: () => NOW })
  const jobs = reopened.list()
  expect(jobs.map((job) => job.task)).toEqual(['interval job', 'cron job'])
  expect(jobs[0]?.schedule.kind).toBe('every')
  expect(jobs[1]?.schedule.kind).toBe('cron')
  expect(jobs[0]?.nextRunAt).toEqual(new Date(NOW.getTime() + 30 * MINUTE))
})

test('absolute one-shot keeps its Date through storage and can be listed after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-jobs-'))
  scratch.push(dir)
  const path = join(dir, 'state.db')
  const store = openStore(path)
  const due = new Date(NOW.getTime() + 30 * MINUTE)
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'absolute' })
  const tool = createScheduleTool({ registry })

  await tool.execute({ action: 'create', schedule: due.toISOString(), task: 'once at a fixed time' })
  store.close()
  const reopenedStore = openStore(path)
  stores.push(reopenedStore)
  const reopened = createScheduleRegistry(reopenedStore, { now: () => NOW })
  const job = reopened.get('absolute')!
  expect(job.schedule).toEqual({ kind: 'once', at: due })
  const listed = JSON.parse(await createScheduleTool({ registry: reopened }).execute({ action: 'list' }))
  expect(listed.jobs[0].description).toContain(`once at ${due.toISOString()}`)
  expect(reopened.claim(job.id, due)?.nextRunAt).toBeNull()
  expect(reopened.claim(job.id, due)).toBeNull()
})

test('test_j3_claim_is_at_most_once_for_two_ticks_at_the_same_instant', () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'repeating' })
  registry.create({ spec: 'every 10m', task: 'повтор' })

  const due = new Date(NOW.getTime() + 11 * MINUTE)
  expect(registry.due(due)).toHaveLength(1)
  expect(registry.claim('repeating', due)).not.toBeNull()
  // A second tick fired at the same moment finds no due row left.
  expect(registry.due(due)).toEqual([])
  expect(registry.claim('repeating', due)).toBeNull()

  const next = registry.get('repeating')?.nextRunAt
  expect(next).not.toBeUndefined()
  expect(next?.getTime()).toBeGreaterThan(due.getTime())
})

test('test_j4_create_rejects_a_past_one_shot_and_a_broken_spec_without_saving', () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW })

  expect(() => registry.create({ spec: '2020-01-01T00:00:00Z', task: 'в прошлом' })).toThrow(/прошлом/)
  expect(() => registry.create({ spec: 'every', task: 'плохой интервал' })).toThrow()
  expect(() => registry.create({ spec: 'every 30m', task: '   ' })).toThrow(/пустой/)
  expect(registry.list()).toEqual([])
})

test('cron delay tasks are refused on create/update while real one-shots remain valid', async () => {
  const registry = createScheduleRegistry(open(), { now: () => NOW, timeZone: 'UTC' })
  const tool = createScheduleTool({ registry })
  await expect(tool.execute({ action: 'create', schedule: '* * * * *', task: 'Send report через 2 минуты' })).rejects.toThrow()
  expect(registry.list()).toEqual([])
  const created = JSON.parse(await tool.execute({ action: 'create', schedule: '2m', task: 'Send report' })) as { id: string }
  expect(registry.get(created.id)?.nextRunAt).toEqual(new Date(NOW.getTime() + 2 * MINUTE))
  await expect(tool.execute({ action: 'update', id: created.id, schedule: '* * * * *', task: 'Send report через 2 минуты' })).rejects.toThrow()
  expect(registry.get(created.id)?.task).toBe('Send report')
})
