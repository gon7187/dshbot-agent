import { afterEach, expect, test, vi } from 'vitest'

import { createScheduleTicker } from '../app/src/schedule.js'
import { openStore, type Store } from '../store/src/index.js'
import { createScheduleRegistry, createScheduleTool, nextRun, parseSchedule } from './src/index.js'

const stores: Store[] = []
const BEFORE = new Date('2031-12-01T00:00:00Z')

function open(): Store {
  const store = openStore(':memory:')
  stores.push(store)
  return store
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const store of stores.splice(0)) store.close()
})

test('a Moscow one-shot fires once at 06:00Z and survives reopening under another owner zone', async () => {
  let clock = new Date('2031-12-01T05:59:59.999Z')
  const store = open()
  const initial = createScheduleRegistry(store, { now: () => clock, timeZone: 'Europe/Moscow' })
  const job = initial.create({ spec: '2031-12-01T09:00:00', task: 'run once' })
  const registry = createScheduleRegistry(store, { now: () => clock, timeZone: 'America/New_York' })
  expect(registry.get(job.id)?.schedule).toEqual({ kind: 'once', at: new Date('2031-12-01T06:00:00Z') })
  expect(registry.get(job.id)?.tz).toBe('Europe/Moscow')

  const ran: string[] = []
  const ticker = createScheduleTicker({
    registry,
    now: () => clock,
    isOwnerBusy: () => false,
    runJob: async (row) => {
      ran.push(row.id)
    },
  })
  await ticker.tick()
  expect(ran).toEqual([])
  clock = new Date('2031-12-01T06:00:00Z')
  await ticker.tick()
  expect(ran).toEqual([job.id])
  expect(registry.get(job.id)?.nextRunAt).toBeNull()
  clock = new Date('2031-12-01T09:00:00Z')
  await ticker.tick()
  expect(ran).toEqual([job.id])
})

test('a skipped DST wall clock is rejected, while an explicit offset still identifies an instant', () => {
  expect(() => parseSchedule('2031-03-09T02:30:00', 'America/New_York')).toThrow(/ISO 8601/)
  expect(parseSchedule('2031-03-09T02:30:00-05:00', 'America/New_York')).toEqual({
    kind: 'once',
    at: new Date('2031-03-09T07:30:00Z'),
  })
  expect(parseSchedule('2031-11-02T01:30:12.345', 'America/New_York')).toEqual({
    kind: 'once',
    at: new Date('2031-11-02T05:30:12.345Z'),
  })
})
