// Five-field cron expression: minute hour day-of-month month day-of-week.
// Supports `*`, single values, `a-b` ranges, comma lists, `*/n`, `a-b/n` and `a/n`.
// Day of week accepts 0-7 with both 0 and 7 meaning Sunday.
// As in classic cron, when both day-of-month and day-of-week are restricted the
// day matches if either field matches.

import { DAY_MS, HOUR_MS, MINUTE_MS, instantsForWallMinute, localParts } from './timezone.js'
import type { CronFields } from './types.js'

interface FieldSpec {
  readonly name: string
  readonly min: number
  readonly max: number
}

const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 }
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 }
const DAY_OF_MONTH: FieldSpec = { name: 'day of month', min: 1, max: 31 }
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12 }
const DAY_OF_WEEK: FieldSpec = { name: 'day of week', min: 0, max: 7 }

const FIELD_SPECS = [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK] as const

/** DST folds repeat at most a couple of hours, so this window covers reordering. */
const DST_WINDOW_MS = 3 * HOUR_MS

/** Cron has no year field; nine years covers any day-of-month/month combination, leap days included. */
const MAX_SCAN_DAYS = 366 * 9

function cronError(expression: string, message: string): Error {
  return new Error(`Invalid cron expression "${expression}": ${message}`)
}

function isIntegerToken(token: string): boolean {
  return /^\d+$/.test(token)
}

interface ParsedField {
  values: number[]
  restricted: boolean
}

function parseField(text: string, spec: FieldSpec, expression: string): ParsedField {
  if (text === '') throw cronError(expression, `empty ${spec.name} field`)

  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (part === '') throw cronError(expression, `empty entry in ${spec.name} field "${text}"`)

    const stepParts = part.split('/')
    if (stepParts.length > 2) {
      throw cronError(expression, `invalid step in ${spec.name} field "${part}"`)
    }

    const base = stepParts[0] as string
    const stepText = stepParts[1]
    let step = 1
    if (stepText !== undefined) {
      if (!isIntegerToken(stepText) || Number(stepText) < 1) {
        throw cronError(expression, `${spec.name} step must be a positive integer, got "${stepText}"`)
      }
      step = Number(stepText)
    }

    let start: number
    let end: number
    if (base === '*') {
      start = spec.min
      end = spec.max
    } else if (base.includes('-')) {
      const bounds = base.split('-')
      if (bounds.length !== 2 || !isIntegerToken(bounds[0] as string) || !isIntegerToken(bounds[1] as string)) {
        throw cronError(expression, `invalid range "${base}" in ${spec.name} field`)
      }
      start = Number(bounds[0])
      end = Number(bounds[1])
      if (start > end) {
        throw cronError(expression, `${spec.name} range "${base}" starts after it ends`)
      }
    } else {
      if (!isIntegerToken(base)) {
        throw cronError(expression, `invalid value "${base}" in ${spec.name} field`)
      }
      start = Number(base)
      end = stepText === undefined ? start : spec.max
    }

    for (const value of [start, end]) {
      if (value < spec.min || value > spec.max) {
        throw cronError(expression, `${spec.name} value ${value} is outside ${spec.min}-${spec.max}`)
      }
    }

    for (let value = start; value <= end; value += step) values.add(value)
  }

  if (values.size === 0) throw cronError(expression, `${spec.name} field "${text}" matches no values`)

  return { values: [...values].sort((a, b) => a - b), restricted: !text.startsWith('*') }
}

/** Parse the five whitespace-separated cron fields. Throws on malformed input. */
export function parseCron(expression: string, fields: readonly string[]): CronFields {
  if (fields.length !== 5) {
    throw cronError(expression, `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`)
  }

  const parsed = FIELD_SPECS.map((spec, index) => parseField(fields[index] as string, spec, expression))
  const minutes = parsed[0] as ParsedField
  const hours = parsed[1] as ParsedField
  const daysOfMonth = parsed[2] as ParsedField
  const months = parsed[3] as ParsedField
  const daysOfWeek = parsed[4] as ParsedField

  // 0 and 7 both mean Sunday; normalise so matching only ever sees 0-6.
  const weekdays = new Set<number>()
  for (const day of daysOfWeek.values) weekdays.add(day === 7 ? 0 : day)

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: [...weekdays].sort((a, b) => a - b),
    dayOfMonthRestricted: daysOfMonth.restricted,
    dayOfWeekRestricted: daysOfWeek.restricted,
  }
}

function dayMatches(cron: CronFields, dayOfMonth: number, dayOfWeek: number): boolean {
  const byMonthDay = cron.daysOfMonth.includes(dayOfMonth)
  const byWeekday = cron.daysOfWeek.includes(dayOfWeek)

  // Classic cron rule: a restricted day-of-month and a restricted day-of-week
  // are ORed; if either is `*`, only the restricted one applies.
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return byMonthDay || byWeekday
  if (cron.dayOfMonthRestricted) return byMonthDay
  if (cron.dayOfWeekRestricted) return byWeekday
  return true
}

/** Next matching instant strictly after `after`, or null if the calendar never matches within the scan horizon. */
export function nextCronRun(cron: CronFields, after: Date, timeZone: string): Date | null {
  const afterMs = after.getTime()
  const start = localParts(afterMs, timeZone)
  const startWallMinute = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute)
  const startDayWall = Date.UTC(start.year, start.month - 1, start.day)
  const earliestWall = startWallMinute - DST_WINDOW_MS

  let best: number | null = null
  let wallLimit = Number.POSITIVE_INFINITY

  for (let dayOffset = 0; dayOffset <= MAX_SCAN_DAYS; dayOffset += 1) {
    const dayWall = startDayWall + dayOffset * DAY_MS
    const calendarDay = new Date(dayWall)

    if (!cron.months.includes(calendarDay.getUTCMonth() + 1)) continue
    if (!dayMatches(cron, calendarDay.getUTCDate(), calendarDay.getUTCDay())) continue

    for (const hour of cron.hours) {
      if (dayWall + hour * HOUR_MS > wallLimit) break
      for (const minute of cron.minutes) {
        const wall = dayWall + hour * HOUR_MS + minute * MINUTE_MS
        if (wall < earliestWall) continue
        if (wall > wallLimit) break

        for (const instant of instantsForWallMinute(wall, timeZone)) {
          if (instant > afterMs && (best === null || instant < best)) {
            best = instant
            // A fall-back can make a later wall minute happen earlier in real
            // time; keep looking for a short window before committing.
            if (wallLimit === Number.POSITIVE_INFINITY) wallLimit = wall + DST_WINDOW_MS
          }
        }
      }
    }

    if (best !== null) return new Date(best)
  }

  return null
}
