// Extra spec-driven coverage beyond the locked acceptance tests: parsing forms,
// field bounds, time zones, cron calendar corners, claim immutability and the
// wake gate's fail-open behaviour.

import { expect, test } from 'vitest'
import { claim, isSilent, nextRun, parseSchedule, shouldWake } from './src/index.js'

test('cron accepts a-b/n steps', () => {
  const schedule = parseSchedule('10-20/5 * * * *')
  expect(nextRun(schedule, new Date('2026-10-23T10:00:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T10:10:00Z'),
  )
  expect(nextRun(schedule, new Date('2026-10-23T10:10:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T10:15:00Z'),
  )
  expect(nextRun(schedule, new Date('2026-10-23T10:20:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T11:10:00Z'),
  )
})

test('cron accepts a/n steps and comma lists', () => {
  const stepped = parseSchedule('5/20 * * * *')
  expect(nextRun(stepped, new Date('2026-10-23T10:06:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T10:25:00Z'),
  )

  const list = parseSchedule('30 8,20 * * *')
  expect(nextRun(list, new Date('2026-10-23T08:45:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T20:30:00Z'),
  )
})

test('cron accepts month lists and weekday ranges ending in 7', () => {
  const months = parseSchedule('0 0 1 1,7 *')
  expect(nextRun(months, new Date('2026-02-01T00:00:00Z'), 'UTC')).toEqual(
    new Date('2026-07-01T00:00:00Z'),
  )

  const weekend = parseSchedule('0 0 * * 6-7')
  // 2026-10-23 is a Friday; the next Saturday is 2026-10-24.
  expect(nextRun(weekend, new Date('2026-10-23T12:00:00Z'), 'UTC')).toEqual(
    new Date('2026-10-24T00:00:00Z'),
  )
})

test('cron rejects out-of-range values, reversed ranges and zero steps', () => {
  for (const spec of [
    '0 0 0 * *',
    '0 0 * 13 *',
    '0 0 * * 8',
    '0 24 * * *',
    '60 * * * *',
    '10-5 * * * *',
    '*/0 * * * *',
    '1,,2 * * * *',
    '* * * * * *',
  ]) {
    expect(() => parseSchedule(spec), spec).toThrow(Error)
  }

  expect(() => parseSchedule('61 * * * *')).toThrow(/minute/)
  expect(() => parseSchedule('0 0 0 * *')).toThrow(/day of month/)
  expect(() => parseSchedule('0 0 * * 8')).toThrow(/day of week/)
})

test('ISO 8601 with an explicit offset is one-shot at that instant', () => {
  const schedule = parseSchedule('2026-12-01T12:00:00+03:00')
  expect(nextRun(schedule, new Date('2026-11-01T00:00:00Z'), 'UTC')).toEqual(
    new Date('2026-12-01T09:00:00Z'),
  )
  expect(nextRun(schedule, new Date('2026-12-01T09:00:00Z'), 'UTC')).toBeNull()
})

test('invalid ISO-like specs are rejected instead of being parsed loosely', () => {
  expect(() => parseSchedule('2026-02-30T00:00:00Z')).toThrow(/ISO 8601/)
  expect(() => parseSchedule('2026-12-01T25:00:00Z')).toThrow(/ISO 8601/)
  expect(() => parseSchedule('2026-12-01')).toThrow(Error)
})

test('durations support days and survive surrounding whitespace', () => {
  const after = new Date('2026-12-31T22:00:00Z')
  expect(nextRun(parseSchedule('1d'), after, 'UTC')).toEqual(new Date('2027-01-01T22:00:00Z'))
  expect(nextRun(parseSchedule('  every 2h  '), after, 'UTC')).toEqual(
    new Date('2027-01-01T00:00:00Z'),
  )
})

test('cron honours fixed non-hour offsets', () => {
  // Asia/Kathmandu is UTC+05:45. 09:00 local on 2026-10-23 is 03:15Z.
  expect(
    nextRun(parseSchedule('0 9 * * *'), new Date('2026-10-23T00:00:00Z'), 'Asia/Kathmandu'),
  ).toEqual(new Date('2026-10-23T03:15:00Z'))
})

test('cron skips the DST spring-forward gap and takes both fall-back occurrences', () => {
  // US DST starts on 2026-03-08 at 02:00 local; that wall minute never happens.
  const skipped = parseSchedule('0 2 * * *')
  expect(nextRun(skipped, new Date('2026-03-08T00:00:00Z'), 'America/New_York')).toEqual(
    new Date('2026-03-09T06:00:00Z'),
  )

  // US DST ends on 2026-11-01; 01:30 local happens at 05:30Z and again at 06:30Z.
  const repeated = parseSchedule('30 1 * * *')
  expect(nextRun(repeated, new Date('2026-11-01T05:00:00Z'), 'America/New_York')).toEqual(
    new Date('2026-11-01T05:30:00Z'),
  )
  expect(nextRun(repeated, new Date('2026-11-01T05:45:00Z'), 'America/New_York')).toEqual(
    new Date('2026-11-01T06:30:00Z'),
  )
})

test('ISO 8601 without a zone designator is read as UTC', () => {
  expect(
    nextRun(parseSchedule('2026-12-01T09:00:00'), new Date('2026-11-01T00:00:00Z'), 'UTC'),
  ).toEqual(new Date('2026-12-01T09:00:00Z'))
})

test('impossible calendar combinations resolve to null without hanging', () => {
  expect(nextRun(parseSchedule('0 0 30 2 *'), new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull()
})

test('an invalid IANA time zone is reported clearly', () => {
  expect(() =>
    nextRun(parseSchedule('0 9 * * *'), new Date('2026-10-23T00:00:00Z'), 'Mars/Olympus'),
  ).toThrow(/time zone/i)
})

test('claim never mutates the job and leaves a finished one-shot idle', () => {
  const schedule = parseSchedule('2026-12-01T09:00:00Z')
  const job = { schedule, nextRunAt: new Date('2026-12-01T09:00:00Z'), label: 'nightly' }

  const result = claim(job, new Date('2026-12-01T09:00:00Z'), 'UTC')
  expect(result.run).toBe(true)
  expect(result.job).not.toBe(job)
  expect(result.job.label).toBe('nightly')
  expect(result.job.nextRunAt).toBeNull()
  expect(job.nextRunAt).toEqual(new Date('2026-12-01T09:00:00Z'))

  const finished = claim(result.job, new Date('2026-12-02T00:00:00Z'), 'UTC')
  expect(finished.run).toBe(false)
  expect(finished.job).toBe(result.job)
})

test('wake gate fails open on arrays, non-boolean flags and malformed lines', () => {
  expect(shouldWake('[{"wakeAgent": false}]')).toBe(true)
  expect(shouldWake('{"wakeAgent": "false"}')).toBe(true)
  expect(shouldWake('{"wakeAgent": false}\nnot json')).toBe(true)
  expect(shouldWake('{"wakeAgent": false}\r\n\r\n')).toBe(false)
  expect(shouldWake('null')).toBe(true)
})

test('silent marker is exact and case-sensitive', () => {
  expect(isSilent('\t[SILENT]  ')).toBe(true)
  expect(isSilent('[SILENT]\nextra')).toBe(false)
  expect(isSilent('[silent]')).toBe(false)
})
