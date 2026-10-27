import { expect, test } from 'vitest'
import { claim, isSilent, nextRun, parseSchedule, shouldWake } from './src/index.js'

const MIN = 60_000
const HOUR = 60 * MIN

test('test_c1_duration_once_runs_after_30m_and_is_done_after_claim', () => {
  const after = new Date('2026-10-23T10:00:00Z')
  const schedule = parseSchedule('30m')
  const nextRunAt = nextRun(schedule, after, 'UTC')
  expect(nextRunAt).toEqual(new Date(after.getTime() + 30 * MIN))

  const result = claim({ schedule, nextRunAt }, new Date(after.getTime() + 30 * MIN), 'UTC')
  expect(result.run).toBe(true)
  expect(result.job.nextRunAt).toBeNull()
})

test('test_c2_interval_every_2h_runs_two_hours_after', () => {
  const after = new Date('2026-10-23T10:00:00Z')
  expect(nextRun(parseSchedule('every 2h'), after, 'UTC')).toEqual(new Date(after.getTime() + 2 * HOUR))
})

test('test_c3_cron_is_evaluated_in_given_timezone', () => {
  const after = new Date('2026-10-23T10:00:00+03:00')
  expect(nextRun(parseSchedule('0 9 * * *'), after, 'Europe/Moscow')).toEqual(
    new Date('2026-10-24T09:00:00+03:00'),
  )
})

test('test_c4_cron_step_is_strictly_after_after', () => {
  const schedule = parseSchedule('*/15 * * * *')
  expect(nextRun(schedule, new Date('2026-10-23T10:07:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T10:15:00Z'),
  )
  expect(nextRun(schedule, new Date('2026-10-23T10:15:00Z'), 'UTC')).toEqual(
    new Date('2026-10-23T10:30:00Z'),
  )
})

test('test_c5_cron_weekday_range_and_sunday_as_0_or_7', () => {
  // 2026-10-23 is a Friday; the next Monday is 2026-10-26
  const after = new Date('2026-10-23T13:00:00Z')
  expect(nextRun(parseSchedule('0 12 * * 1-5'), after, 'UTC')).toEqual(
    new Date('2026-10-26T12:00:00Z'),
  )
  // Sunday is 2026-10-25
  expect(nextRun(parseSchedule('0 12 * * 7'), after, 'UTC')).toEqual(new Date('2026-10-25T12:00:00Z'))
  expect(nextRun(parseSchedule('0 12 * * 0'), after, 'UTC')).toEqual(new Date('2026-10-25T12:00:00Z'))
})

test('test_c6_cron_day_of_month_and_weekday_are_ored', () => {
  const schedule = parseSchedule('0 0 13 * 5')
  // 2026-10-13 is a Tuesday: matches by day of month, not by weekday
  expect(nextRun(schedule, new Date('2026-10-09T00:00:00Z'), 'UTC')).toEqual(
    new Date('2026-10-13T00:00:00Z'),
  )
  // 2026-10-16 is a Friday: matches by weekday, not by day of month
  expect(nextRun(schedule, new Date('2026-10-13T00:00:00Z'), 'UTC')).toEqual(
    new Date('2026-10-16T00:00:00Z'),
  )
})

test('test_c7_iso_datetime_is_one_shot', () => {
  const schedule = parseSchedule('2026-12-01T09:00:00Z')
  expect(nextRun(schedule, new Date('2026-11-01T00:00:00Z'), 'UTC')).toEqual(
    new Date('2026-12-01T09:00:00Z'),
  )
  expect(nextRun(schedule, new Date('2026-12-01T09:00:00Z'), 'UTC')).toBeNull()
})

test('test_c8_parse_schedule_throws_on_invalid_specs', () => {
  for (const spec of ['every', '61 * * * *', '* * *', 'abc']) {
    expect(() => parseSchedule(spec), spec).toThrow(Error)
  }
})

test('test_c9_claim_runs_only_when_next_run_is_due', () => {
  const now = new Date('2026-10-23T10:05:00Z')
  const schedule = parseSchedule('every 1h')

  const due = { schedule, nextRunAt: new Date('2026-10-23T10:00:00Z') }
  const dueResult = claim(due, now, 'UTC')
  expect(dueResult.run).toBe(true)
  expect((dueResult.job.nextRunAt as Date).getTime()).toBeGreaterThan(now.getTime())

  const equalDue = { schedule, nextRunAt: now }
  const equalResult = claim(equalDue, now, 'UTC')
  expect(equalResult.run).toBe(true)
  expect((equalResult.job.nextRunAt as Date).getTime()).toBeGreaterThan(now.getTime())

  const notDue = { schedule, nextRunAt: new Date('2026-10-23T10:10:00Z') }
  const notDueResult = claim(notDue, now, 'UTC')
  expect(notDueResult.run).toBe(false)
  expect(notDueResult.job).toEqual(notDue)
})

test('test_c10_claim_after_missed_runs_fires_once_without_catch_up', () => {
  // every 1h from 10:00 with now at 15:30: 11:00 .. 15:00 were missed (5 runs)
  const now = new Date('2026-10-23T15:30:00Z')
  const job = { schedule: parseSchedule('every 1h'), nextRunAt: new Date('2026-10-23T10:00:00Z') }

  const result = claim(job, now, 'UTC')
  expect(result.run).toBe(true)
  const delta = (result.job.nextRunAt as Date).getTime() - now.getTime()
  expect(delta).toBeGreaterThan(0)
  expect(delta).toBeLessThanOrEqual(HOUR)
})

test('test_c11_should_wake_is_false_only_for_wake_agent_false_on_last_line', () => {
  expect(shouldWake('{"wakeAgent": false}')).toBe(false)
  expect(shouldWake('check ok\n{"wakeAgent": false}\n\n  \n')).toBe(false)
  expect(shouldWake('')).toBe(true)
  expect(shouldWake('just some text')).toBe(true)
  expect(shouldWake('{"wakeAgent": true}')).toBe(true)
})

test('test_c12_is_silent_matches_only_trimmed_silent_marker', () => {
  expect(isSilent('[SILENT]')).toBe(true)
  expect(isSilent('  [SILENT]\n')).toBe(true)
  expect(isSilent('[SILENT] но вот что')).toBe(false)
  expect(isSilent('')).toBe(false)
})
