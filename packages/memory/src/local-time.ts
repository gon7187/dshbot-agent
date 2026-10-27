// Calendar readings in the owner's IANA time zone (DESIGN §7).
//
// The journal file and the `updated` date of a knowledge topic follow the
// owner's wall clock, not UTC and not the zone of the host process. Only
// `Intl.DateTimeFormat` is used, so no time-zone database of our own is needed.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

function partsOf(instantMs: number, timeZone: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    values.set(part.type, part.value)
  }
  return values
}

function read(values: Map<string, string>, type: string, timeZone: string): string {
  const value = values.get(type)
  if (value === undefined) throw new Error(`time zone ${JSON.stringify(timeZone)} produced no ${type}`)
  return value
}

/** `YYYY-MM-DD` of the instant in `timeZone` (UTC when the zone is absent). */
export function localDate(instantMs: number, timeZone = 'UTC'): string {
  const values = partsOf(instantMs, timeZone)
  return `${read(values, 'year', timeZone)}-${read(values, 'month', timeZone)}-${read(values, 'day', timeZone)}`
}

/** `HH:MM` of the instant in `timeZone` (UTC when the zone is absent). */
export function localTime(instantMs: number, timeZone = 'UTC'): string {
  const values = partsOf(instantMs, timeZone)
  return `${read(values, 'hour', timeZone)}:${read(values, 'minute', timeZone)}`
}
