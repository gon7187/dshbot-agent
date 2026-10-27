// Human-readable one-line description of a saved schedule, used by `schedule list`.
//
// Wall-clock times are rendered in the zone the owner reads them in: the owner
// zone (`DSHBOT_TZ`) for the list, the zone of the job for the spec itself.
// Rows written before jobs had a zone keep firing and are described in UTC
// unless the caller asks for the owner zone.

import type { Schedule } from './types.js'
import type { FinishedSchedule, ScheduleRecord } from './jobs.js'
import { localParts } from './timezone.js'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Wall-clock reading of an instant in `timeZone`, e.g. `2031-12-01 12:00`. */
export function formatWallClock(instant: Date, timeZone: string): string {
  const parts = localParts(instant.getTime(), timeZone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

function moment(instant: Date, timeZone: string): string {
  return `${formatWallClock(instant, timeZone)} (${timeZone})`
}

function duration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/** Stable phrase for the spec, without depending on the moment of the call. */
export function describeSchedule(schedule: Schedule, timeZone = 'UTC', displayZone = timeZone): string {
  switch (schedule.kind) {
    case 'cron':
      return `cron ${schedule.expression} (${timeZone})`
    case 'every':
      return `every ${duration(schedule.intervalMs)}`
    case 'after':
      return `once in ${duration(schedule.durationMs)}`
    case 'once':
      // The absolute ISO instant keeps the spec readable; the wall clock is
      // shown in the zone the owner reads the list in.
      return `once at ${schedule.at.toISOString()} (${moment(schedule.at, displayZone)})`
    case 'watch':
      return 'watch the output stream'
    default: {
      const exhaustive: never = schedule
      throw new Error(`Unsupported schedule kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Description of a record including when its next run is due (if any).
 * Wall-clock moments are shown in `displayZone` (the owner's zone in a list);
 * the cron expression itself keeps naming its own zone because that is where
 * its fields are read.
 */
export function formatSchedule(record: ScheduleRecord, displayZone = record.tz): string {
  // A watcher has no next run: its command is supervised while it lives and
  // restarted after it ends, so the line names the watched stream instead.
  if (record.watch !== null) {
    const until = record.until === null ? '' : `; до ${moment(record.until, displayZone)}`
    return (
      `наблюдение за потоком: /${record.watch.pattern}/, ` +
      `окно ${record.watch.windowSec} с, доставка ${record.watch.deliver}${until}`
    )
  }
  const next =
    record.nextRunAt === null
      ? 'выполнено, следующего запуска нет'
      : `следующий ${record.nextRunAt.toISOString()} (${moment(record.nextRunAt, displayZone)})`
  const end =
    record.until !== null
      ? `; до ${moment(record.until, displayZone)}`
      : record.maxRuns !== null
        ? `; не больше ${record.maxRuns} запусков (сделано ${record.runs})`
        : ''
  return `${describeSchedule(record.schedule, record.tz, displayZone)}; ${next}${end}`
}

/** One owner-facing line about a job that removed itself after its end condition. */
export function describeFinish(finished: FinishedSchedule, displayZone = finished.job.tz): string {
  const job = finished.job
  const task = job.task.replace(/\s+/g, ' ').trim()
  const shown = task.length > 200 ? `${task.slice(0, 200)}…` : task
  if (finished.reason === 'max_runs') {
    return `Задание «${shown}» снято: выполнено ${job.runs} из ${job.maxRuns ?? job.runs} запусков.`
  }
  return `Задание «${shown}» снято: истёк срок ${job.until === null ? '' : moment(job.until, displayZone)}`.trimEnd()
}
