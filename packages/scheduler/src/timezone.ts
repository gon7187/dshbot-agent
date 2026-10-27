// Calendar helpers for IANA time zones, built only on Intl.DateTimeFormat.
// Cron matching happens in wall-clock space; these helpers translate between a
// wall-clock reading and the absolute instants that produce it, including the
// ambiguous (fall-back) and skipped (spring-forward) cases around DST.

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Validate an IANA zone name; throws the same clear error as the calendar helpers. */
export function assertTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new Error(`Invalid IANA time zone: "${String(timeZone)}"`)
  }
  formatterFor(timeZone)
  return timeZone
}

/** IANA zone of the host process, or `UTC` when the platform cannot name one. */
export function systemTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.trim() !== '') return zone
  } catch {
    // fall through to UTC
  }
  return 'UTC'
}

/**
 * Zone of the owner: `DSHBOT_TZ` (an IANA name) when set, the zone of the host
 * otherwise. A configured zone that the platform does not know is an error:
 * silently falling back would schedule every job at the wrong wall clock.
 */
export function ownerTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.DSHBOT_TZ === 'string' ? env.DSHBOT_TZ.trim() : ''
  if (configured === '') return systemTimeZone()
  return assertTimeZone(configured)
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached

  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    throw new Error(`Invalid IANA time zone: "${timeZone}"`)
  }

  formatters.set(timeZone, formatter)
  return formatter
}

/** Wall-clock reading of an instant in the given time zone. */
export function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instantMs)
  const values = new Map<string, string>()
  for (const part of parts) values.set(part.type, part.value)

  const read = (type: string): number => {
    const value = values.get(type)
    if (value === undefined) throw new Error(`Time zone "${timeZone}" produced no ${type}`)
    return Number(value)
  }

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** Offset of the zone from UTC at the given instant, in milliseconds. */
export function offsetAt(instantMs: number, timeZone: string): number {
  const parts = localParts(instantMs, timeZone)
  const localMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000
  return localMs - wholeSecondMs
}

/** Wall-clock minute (as a naive UTC timestamp) for an instant. */
export function wallMinuteOf(instantMs: number, timeZone: string): number {
  const parts = localParts(instantMs, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

/**
 * All instants whose wall-clock minute equals `wallMs`. Returns two values for
 * an ambiguous fall-back minute and none for a skipped spring-forward minute.
 */
export function instantsForWallMinute(wallMs: number, timeZone: string): number[] {
  const offsets = new Set<number>()
  // Probe both sides of a possible transition so the correct offset is found
  // even when the naive guess lands on the wrong side of it.
  for (const probe of [wallMs - 26 * HOUR_MS, wallMs - 12 * HOUR_MS, wallMs, wallMs + 12 * HOUR_MS, wallMs + 26 * HOUR_MS]) {
    offsets.add(offsetAt(probe, timeZone))
  }

  const instants = new Set<number>()
  for (const offset of offsets) {
    // Refine twice so a DST transition between guess and result is absorbed.
    let instant = wallMs - offset
    instant = wallMs - offsetAt(instant, timeZone)
    if (wallMinuteOf(instant, timeZone) === wallMs) instants.add(instant)
  }

  return [...instants].sort((a, b) => a - b)
}
