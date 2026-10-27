// Unit coverage of the durable part of the scheduler and of the `schedule` tool:
// the shapes the daemon-level schedule-clock test does not pin down (one-shot
// jobs, rejection of an impossible create, the schema without a gate script).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import { createScheduleRegistry, createScheduleTool } from './src/index.js'

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

test('test_j2_one_shot_runs_once_and_then_has_no_next_run', () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'one-shot' })

  const job = registry.create({ spec: '30m', task: 'проверить один раз' })
  expect(job.nextRunAt).toEqual(new Date(NOW.getTime() + 30 * MINUTE))

  const due = new Date(NOW.getTime() + 30 * MINUTE)
  expect(registry.due(due).map((row) => row.id)).toEqual(['one-shot'])

  const claimed = registry.claim('one-shot', due)
  expect(claimed?.nextRunAt).toBeNull()
  expect(registry.claim('one-shot', due)).toBeNull()
  expect(registry.due(new Date(NOW.getTime() + 120 * MINUTE))).toEqual([])
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

test('test_j6_agent_profile_survives_storage_and_an_unknown_profile_is_refused', async () => {
  const store = open()
  let sequence = 0
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => `prof-job-${(sequence += 1)}` })
  const tool = createScheduleTool({
    registry,
    agents: { has: (name) => name === 'mailer', names: () => ['mailer'] },
  })

  const created = JSON.parse(
    await tool.execute({ action: 'create', schedule: 'every 15m', task: 'inbox', agent: 'mailer' }),
  ) as { id: string; agent: string | null }
  expect(created.agent).toBe('mailer')
  expect(registry.get('prof-job-1')?.agent).toBe('mailer')
  const listed = JSON.parse(await tool.execute({ action: 'list' })) as {
    jobs: Array<{ id: string; agent: string | null }>
  }
  expect(listed.jobs[0]?.agent).toBe('mailer')

  await expect(
    tool.execute({ action: 'create', schedule: 'every 15m', task: 'inbox', agent: 'ghost' }),
  ).rejects.toThrow(/неизвестный профиль агента "ghost".*mailer/s)
  await expect(tool.execute({ action: 'update', id: 'prof-job-1', agent: 'ghost' })).rejects.toThrow(
    /неизвестный профиль агента "ghost"/,
  )
  // A plain job keeps no profile.
  const plain = JSON.parse(await tool.execute({ action: 'create', schedule: 'every 20m', task: 'plain' })) as {
    agent: string | null
  }
  expect(plain.agent).toBeNull()
})

test('test_j5_tool_creates_lists_and_removes_without_a_gate_script_in_the_schema', async () => {
  const store = open()
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => 'tool-job' })
  const tool = createScheduleTool({ registry })

  expect(tool.name).toBe('schedule')
  const schema = JSON.stringify(tool.inputSchema)
  expect(schema).not.toMatch(/wake/i)
  expect(schema).toContain('create')
  expect(schema).toContain('list')
  expect(schema).toContain('remove')

  const created = JSON.parse(await tool.execute({ action: 'create', schedule: 'every 15m', task: 'сводка' })) as {
    id: string
    schedule: string
  }
  expect(created.id).toBe('tool-job')
  expect(created.schedule).toBe('every 15m')

  const listed = JSON.parse(await tool.execute({ action: 'list' })) as { jobs: Array<{ task: string }> }
  expect(listed.jobs.map((job) => job.task)).toEqual(['сводка'])

  await tool.execute({ action: 'remove', id: 'tool-job' })
  const empty = JSON.parse(await tool.execute({ action: 'list' })) as { jobs: unknown[] }
  expect(empty.jobs).toEqual([])
  await expect(tool.execute({ action: 'remove', id: 'tool-job' })).rejects.toThrow(/не найдено/)
})

test('test_j7_history_of_a_removed_job_still_shows_every_skip_through_the_tool', async () => {
  const store = open()
  let sequence = 0
  const registry = createScheduleRegistry(store, { now: () => NOW, id: () => `gone-${(sequence += 1)}` })
  const tool = createScheduleTool({ registry })
  type History = { id: string; runs: Array<{ status: string; output: string }> }

  // A job ended by max_runs: its single claim is skipped, the row goes away.
  registry.create({ spec: 'every 10m', task: 'однократно', maxRuns: 1 })
  const due = new Date(NOW.getTime() + 11 * MINUTE)
  expect(registry.claim('gone-1', due)).not.toBeNull()
  registry.recordRun({ jobId: 'gone-1', startedAt: due, durationMs: 0, status: 'skip', output: 'SKIP-MAX-A' })
  expect(registry.finish(due).map((ended) => [ended.job.id, ended.reason])).toEqual([['gone-1', 'max_runs']])
  expect(registry.get('gone-1')).toBeUndefined()
  registry.recordRun({ jobId: 'gone-1', startedAt: due, durationMs: 0, status: 'skip', output: 'SKIP-MAX-B' })

  const ended = JSON.parse(await tool.execute({ action: 'history', id: 'gone-1' })) as History
  expect(ended.id).toBe('gone-1')
  expect(ended.runs.map((run) => [run.status, run.output]).sort()).toEqual([
    ['skip', 'SKIP-MAX-A'],
    ['skip', 'SKIP-MAX-B'],
  ])

  // A job removed by hand after two skips keeps one row per skip as well.
  registry.create({ spec: 'every 10m', task: 'удалить вручную' })
  for (const output of ['SKIP-HAND-1', 'SKIP-HAND-2']) {
    registry.recordRun({ jobId: 'gone-2', startedAt: due, durationMs: 0, status: 'skip', output })
  }
  await tool.execute({ action: 'remove', id: 'gone-2' })
  expect(registry.get('gone-2')).toBeUndefined()
  const removed = JSON.parse(await tool.execute({ action: 'history', id: 'gone-2' })) as History
  expect(removed.runs.filter((run) => run.status === 'skip')).toHaveLength(2)

  // An id with neither a job nor runs is still unknown.
  await expect(tool.execute({ action: 'history', id: 'never-was' })).rejects.toThrow(/не найдено/)
})
