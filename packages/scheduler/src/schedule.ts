// parseSchedule() and nextRun(): turning a human spec into a Schedule and
// resolving the next strictly-future instant. All functions are pure.

import { nextCronRun, parseCron } from './cron.js'
import { DAY_MS, HOUR_MS, instantsForWallMinute, MINUTE_MS } from './timezone.js'
import type { Schedule } from './types.js'

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/

const DURATION = /^(\d+)([mhd])$/i

function scheduleError(spec: string, message: string): Error {
  return new Error(`Invalid schedule "${spec}": ${message}`)
}

function looksLikeIsoDateTime(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[Tt ]/.test(text)
}

function parseIsoDateTime(text: string, timeZone: string): Date | null {
  const match = ISO_DATE_TIME.exec(text)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])
  const fraction = match[7] === undefined ? 0 : Number((match[7] + '000').slice(0, 3))

  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, second, fraction)
  // setUTC* rolls overflow (2026-02-30, 24:00, second 60) instead of rejecting it.
  if (
    wall.getUTCFullYear() !== year ||
    wall.getUTCMonth() !== month - 1 ||
    wall.getUTCDate() !== day ||
    wall.getUTCHours() !== hour ||
    wall.getUTCMinutes() !== minute ||
    wall.getUTCSeconds() !== second
  ) {
    return null
  }
  const wallMs = wall.getTime()

  // Without an explicit offset, the input is a wall-clock reading in the job
  // zone. Resolve it once to an absolute instant before storing the schedule.
  // Reject skipped DST times; choose the earlier instant for a repeated time.
  if (match[8] === undefined && match[9] === undefined && timeZone !== 'UTC') {
    const subMinuteMs = second * 1000 + fraction
    const [instant] = instantsForWallMinute(wallMs - subMinuteMs, timeZone)
    return instant === undefined ? null : new Date(instant + subMinuteMs)
  }

  // An explicit Z or numeric offset always identifies its own instant.
  let offsetMs = 0
  const sign = match[9]
  if (sign !== undefined) {
    const offsetHours = Number(match[10])
    const offsetMinutes = Number(match[11])
    if (offsetHours > 23 || offsetMinutes > 59) return null
    offsetMs = (sign === '-' ? -1 : 1) * (offsetHours * HOUR_MS + offsetMinutes * MINUTE_MS)
  }

  const instant = wallMs - offsetMs
  const result = new Date(instant)
  return Number.isNaN(result.getTime()) ? null : result
}

function parseDurationMs(text: string): number | null {
  const match = DURATION.exec(text)
  if (!match) return null

  const amount = Number(match[1])
  const unit = (match[2] as string).toLowerCase()
  const factor = unit === 'm' ? MINUTE_MS : unit === 'h' ? HOUR_MS : DAY_MS
  if (!Number.isSafeInteger(amount) || amount <= 0) return null
  const durationMs = amount * factor
  return Number.isSafeInteger(durationMs) ? durationMs : null
}

/**
 * Parse a schedule spec:
 *   - `"30m" | "2h" | "1d"`              one-shot, relative to evaluation time
 *   - `"every 30m" | "every 2h"`         repeating interval
 *   - `"0 9 * * 1-5"`                    five-field cron
 *   - `"2026-12-01T09:00:00Z"`           one-shot ISO 8601 date-time
 * ISO dates without an offset use `timeZone` (default UTC for pure callers).
 * Explicit offsets are preserved; stored one-shots always contain an instant.
 */
export function parseSchedule(spec: string, timeZone = 'UTC'): Schedule {
  if (typeof spec !== 'string') throw new Error('Invalid schedule: expected a string')
  const text = spec.trim()
  if (text === '') throw scheduleError(spec, 'the spec is empty')

  if (looksLikeIsoDateTime(text)) {
    const at = parseIsoDateTime(text, timeZone)
    if (at === null) {
      throw scheduleError(spec, 'not a valid ISO 8601 date-time (expected e.g. "2026-12-01T09:00:00Z")')
    }
    return { kind: 'once', at }
  }

  const every = /^every(?:\s+(.*))?$/i.exec(text)
  if (every) {
    const body = (every[1] ?? '').trim()
    if (body === '') {
      throw scheduleError(spec, 'expected a duration after "every", e.g. "every 30m"')
    }
    const intervalMs = parseDurationMs(body)
    if (intervalMs === null) {
      throw scheduleError(spec, `"${body}" is not a valid interval (expected e.g. "30m", "2h" or "1d")`)
    }
    return { kind: 'every', intervalMs }
  }

  const onceMs = parseDurationMs(text)
  if (onceMs !== null) return { kind: 'after', durationMs: onceMs }

  const fields = text.split(/\s+/)
  if (fields.length === 5) {
    return { kind: 'cron', cron: parseCron(text, fields), expression: text }
  }

  throw scheduleError(
    spec,
    'expected a duration ("30m"), an interval ("every 2h"), a 5-field cron expression, or an ISO 8601 date-time',
  )
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`)
  }
}

/**
 * Nearest instant strictly after `after`. Cron is evaluated in `timeZone`
 * (IANA name, default UTC); intervals are anchored at `after`. A one-shot was
 * already resolved to an absolute instant by parseSchedule().
 * Returns null when a one-shot schedule is already in the past.
 */
export function nextRun(schedule: Schedule, after: Date, timeZone = 'UTC'): Date | null {
  assertValidDate(after, 'after')

  switch (schedule.kind) {
    case 'once':
      return schedule.at.getTime() > after.getTime() ? new Date(schedule.at.getTime()) : null
    case 'after':
      return new Date(after.getTime() + schedule.durationMs)
    case 'every':
      return new Date(after.getTime() + schedule.intervalMs)
    case 'cron':
      return nextCronRun(schedule.cron, after, timeZone)
    case 'watch':
      // A watcher has no timed run: its command is kept alive by the watcher
      // supervisor, not by the schedule ticker.
      return null
    default: {
      const exhaustive: never = schedule
      throw new Error(`Unsupported schedule kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
