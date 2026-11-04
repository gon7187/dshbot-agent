import { expect, test } from 'vitest'
import { claim, isSilent, nextRun, parseSchedule, shouldWake } from './src/index.js'

test('time computations preserve interval, cron zone, DST and invalid-calendar semantics', () => {
  const after = new Date('2026-10-23T10:00:00Z')
  for (const spec of ['30m', 'every 30m']) expect(nextRun(parseSchedule(spec), after, 'UTC')).toEqual(new Date('2026-10-23T10:30:00Z'))
  expect(nextRun(parseSchedule('0 9 * * *'), after, 'Europe/Moscow')).toEqual(new Date('2026-10-24T06:00:00Z'))
  expect(nextRun(parseSchedule('0 2 * * *'), new Date('2026-03-08T00:00:00Z'), 'America/New_York')).toEqual(new Date('2026-03-09T06:00:00Z'))
  const fold = parseSchedule('30 1 * * *')
  expect(nextRun(fold, new Date('2026-11-01T05:00:00Z'), 'America/New_York')).toEqual(new Date('2026-11-01T05:30:00Z'))
  expect(nextRun(fold, new Date('2026-11-01T05:45:00Z'), 'America/New_York')).toEqual(new Date('2026-11-01T06:30:00Z'))
  expect(nextRun(parseSchedule('0 0 30 2 *'), after, 'UTC')).toBeNull()
  for (const spec of ['every', '61 * * * *', '* * *', '2026-02-30T00:00:00Z']) expect(() => parseSchedule(spec)).toThrow()
})

test('due and overdue claims run once without catchup and one-shot becomes terminal', () => {
  const now = new Date('2026-10-23T10:05:00Z')
  for (const due of ['2026-10-22T10:00:00Z', now.toISOString()]) {
    const job = { schedule: parseSchedule('every 1h'), nextRunAt: new Date(due) }
    const result = claim(job, now, 'UTC')
    expect(result.run).toBe(true)
    expect(result.job.nextRunAt).toEqual(new Date('2026-10-23T11:05:00Z'))
    expect(job.nextRunAt).toEqual(new Date(due))
  }
  expect(claim({ schedule: parseSchedule('every 1h'), nextRunAt: new Date('2026-10-24T00:00:00Z') }, now, 'UTC').run).toBe(false)
  const once = claim({ schedule: parseSchedule('2026-10-23T10:00:00Z'), nextRunAt: new Date('2026-10-23T10:00:00Z') }, now, 'UTC')
  expect(once.run).toBe(true)
  expect(once.job.nextRunAt).toBeNull()
  expect(claim(once.job, now, 'UTC').run).toBe(false)
})

test('wake and silent markers are exact and malformed output fails open', () => {
  expect(shouldWake('text\n{"wakeAgent": false}\n')).toBe(false)
  for (const text of ['', 'plain', '[{"wakeAgent":false}]', '{"wakeAgent":"false"}', '{"wakeAgent":false}\ntrailing', 'null']) expect(shouldWake(text)).toBe(true)
  expect(isSilent('  [SILENT]\n')).toBe(true)
  for (const text of ['', '[silent]', '[SILENT] extra']) expect(isSilent(text)).toBe(false)
})
