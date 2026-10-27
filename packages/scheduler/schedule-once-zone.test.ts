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

test.each([
  ['2031-12-01T09:00:00', 'Europe/Moscow', '2031-12-01T06:00:00.000Z'],
  ['2031-12-01T09:00', 'Europe/Moscow', '2031-12-01T06:00:00.000Z'],
  ['2031-12-01T09:00:12.345678', 'Europe/Moscow', '2031-12-01T06:00:12.345Z'],
  ['2031-12-01T09:00:00', 'Asia/Kathmandu', '2031-12-01T03:15:00.000Z'],
  ['2031-01-01T09:00:00', 'Europe/Berlin', '2031-01-01T08:00:00.000Z'],
  ['2031-07-01T09:00:00', 'Europe/Berlin', '2031-07-01T07:00:00.000Z'],
  ['2031-12-01T09:00:00', 'UTC', '2031-12-01T09:00:00.000Z'],
])('one-shot %s in %s resolves to %s', (spec, tz, expected) => {
  const schedule = parseSchedule(spec, tz)
  expect(schedule).toEqual({ kind: 'once', at: new Date(expected) })
  expect(nextRun(schedule, new Date('2030-01-01T00:00:00Z'), tz)).toEqual(new Date(expected))
})

test.each([
  ['2031-12-01T09:00:00Z', '2031-12-01T09:00:00.000Z'],
  ['2031-12-01T09:00:00+05:30', '2031-12-01T03:30:00.000Z'],
  ['2031-12-01T09:00:00-0430', '2031-12-01T13:30:00.000Z'],
])('an explicit offset in %s is preserved regardless of the job zone', (spec, expected) => {
  for (const tz of ['Europe/Moscow', 'America/New_York']) {
    const registry = createScheduleRegistry(open(), { now: () => BEFORE, timeZone: tz })
    const job = registry.create({ spec, task: 'absolute instant', tz })
    expect(job.schedule).toEqual({ kind: 'once', at: new Date(expected) })
    expect(job.nextRunAt).toEqual(new Date(expected))
  }
})

test('a missing job zone uses DSHBOT_TZ, while an explicit job zone overrides it', async () => {
  vi.stubEnv('DSHBOT_TZ', 'Europe/Moscow')
  const registry = createScheduleRegistry(open(), { now: () => BEFORE })
  const tool = createScheduleTool({ registry })
  const ownerJob = JSON.parse(await tool.execute({
    action: 'create',
    schedule: '2031-12-01T09:00:00',
    task: 'owner wall clock',
  }))
  expect(ownerJob.timeZone).toBe('Europe/Moscow')
  expect(ownerJob.nextRunAt).toBe('2031-12-01T06:00:00.000Z')

  const overrideJob = JSON.parse(await tool.execute({
    action: 'create',
    schedule: '2031-12-01T09:00:00',
    task: 'job wall clock',
    tz: 'America/New_York',
  }))
  expect(overrideJob.timeZone).toBe('America/New_York')
  expect(overrideJob.nextRunAt).toBe('2031-12-01T14:00:00.000Z')
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

test('a local one-shot already past in its zone is rejected without saving', () => {
  const registry = createScheduleRegistry(open(), {
    now: () => new Date('2031-12-01T07:00:00Z'),
    timeZone: 'Europe/Moscow',
  })
  expect(() => registry.create({ spec: '2031-12-01T09:00:00', task: 'too late' })).toThrow(/прошлом/)
  expect(registry.list()).toEqual([])
})

test('a skipped DST wall clock is rejected, while an explicit offset still identifies an instant', () => {
  expect(() => parseSchedule('2031-03-09T02:30:00', 'America/New_York')).toThrow(/ISO 8601/)
  expect(parseSchedule('2031-03-09T02:30:00-05:00', 'America/New_York')).toEqual({
    kind: 'once',
    at: new Date('2031-03-09T07:30:00Z'),
  })
})

test('a repeated DST wall clock resolves to its first occurrence without losing sub-minute precision', () => {
  expect(parseSchedule('2031-11-02T01:30:12.345', 'America/New_York')).toEqual({
    kind: 'once',
    at: new Date('2031-11-02T05:30:12.345Z'),
  })
})
