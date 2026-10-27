// The old actions of the `schedule` tool keep working as before the management actions (update, pause, resume,
// run_now, history) were added: create, list, remove and their synonyms, the shape of their answers and their errors.

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
  const dir = mkdtempSync(join(tmpdir(), 'sched-compat-'))
  scratch.push(dir)
  const store = openStore(join(dir, 'state.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function toolOver(): { tool: ReturnType<typeof createScheduleTool>; registry: ReturnType<typeof createScheduleRegistry> } {
  let sequence = 0
  const registry = createScheduleRegistry(open(), { now: () => NOW, id: () => `job-${(sequence += 1)}`, timeZone: 'UTC' })
  return { tool: createScheduleTool({ registry }), registry }
}

test('test_c6_create_list_and_remove_and_their_synonyms_work_as_before', async () => {
  const { tool, registry } = toolOver()

  // every old synonym of create makes a job with the same shape of answer
  const createSynonyms = ['create', 'add', 'new', 'set', 'schedule', 'CREATE']
  for (const [index, action] of createSynonyms.entries()) {
    const created = JSON.parse(await tool.execute({ action, schedule: 'every 30m', task: `job number ${index}` })) as Record<string, unknown>
    expect(created.id, `create via "${action}" gives the id`).toBe(`job-${index + 1}`)
    expect(created.schedule).toBe('every 30m')
    expect(created.task).toBe(`job number ${index}`)
    expect(created.idleOnly).toBe(false)
    expect(created.nextRunAt).toBe(new Date(NOW.getTime() + 30 * MINUTE).toISOString())
    expect(typeof created.description, 'create keeps its human description').toBe('string')
  }
  expect(registry.list()).toHaveLength(createSynonyms.length)

  // cron, a one-shot and idleOnly are still accepted
  const cron = JSON.parse(await tool.execute({ action: 'create', schedule: '*/10 * * * *', task: 'cron job', idleOnly: true })) as Record<string, unknown>
  expect(cron.idleOnly).toBe(true)
  const once = JSON.parse(await tool.execute({ action: 'create', schedule: '45m', task: 'one-shot job' })) as Record<string, unknown>
  expect(once.nextRunAt).toBe(new Date(NOW.getTime() + 45 * MINUTE).toISOString())

  // every old synonym of list shows all jobs in the old shape
  for (const action of ['list', 'ls', 'show', 'all', 'get']) {
    const listed = JSON.parse(await tool.execute({ action })) as { timeZone: string; jobs: Array<Record<string, unknown>> }
    expect(listed.timeZone, `list via "${action}"`).toBe('UTC')
    expect(listed.jobs.map((job) => job.id), `list via "${action}" shows every job`).toEqual([
      'job-1',
      'job-2',
      'job-3',
      'job-4',
      'job-5',
      'job-6',
      'job-7',
      'job-8',
    ])
    const first = listed.jobs[0] as Record<string, unknown>
    for (const key of ['id', 'schedule', 'task', 'idleOnly', 'timeZone', 'nextRunAt', 'until', 'maxRuns', 'runs', 'check', 'deliver', 'description']) {
      expect(first, `a listed job keeps the field ${key}`).toHaveProperty(key)
    }
    expect(first.task).toBe('job number 0')
  }

  // every old synonym of remove deletes by id and reports what is left
  const removeSynonyms = ['remove', 'delete', 'rm', 'del', 'cancel', 'unschedule']
  let left = 8
  for (const [index, action] of removeSynonyms.entries()) {
    const removed = JSON.parse(await tool.execute({ action, id: `job-${index + 1}` })) as Record<string, unknown>
    left -= 1
    expect(removed, `remove via "${action}"`).toEqual({ removed: `job-${index + 1}`, remaining: left })
  }
  expect(registry.list().map((job) => job.id)).toEqual(['job-7', 'job-8'])

  // the old errors stay errors
  await expect(tool.execute({ action: 'remove', id: 'job-missing' })).rejects.toThrow(/не найден/)
  await expect(tool.execute({ action: 'remove' })).rejects.toThrow(/id/)
  await expect(tool.execute({ action: 'create', task: 'no time' })).rejects.toThrow(/schedule/)
  await expect(tool.execute({ action: 'create', schedule: 'every 5m' })).rejects.toThrow(/task/)
  await expect(tool.execute({ action: 'frobnicate' })).rejects.toThrow(/frobnicate/)
})
