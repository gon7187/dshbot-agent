// At-most-once claim: the schedule is advanced before the run starts, so a
// crash mid-run cannot replay it. Missed runs are not replayed as a burst:
// after a downtime only one run happens, then the schedule continues from now.

import { nextRun } from './schedule.js'
import type { ClaimResult, Schedule, ScheduledJob } from './types.js'

function isOneShot(schedule: Schedule): boolean {
  return schedule.kind === 'once' || schedule.kind === 'after'
}

/**
 * If `job.nextRunAt` is due (<= now), move it to the next run strictly after
 * `now` (null for a one-shot) and report `run: true`. Otherwise return the job
 * untouched. Never mutates the input.
 */
export function claim<J extends ScheduledJob>(job: J, now: Date, timeZone = 'UTC'): ClaimResult<J> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date')
  }

  const dueAt = job.nextRunAt
  if (dueAt === null || dueAt.getTime() > now.getTime()) {
    return { run: false, job }
  }

  const nextRunAt = isOneShot(job.schedule) ? null : nextRun(job.schedule, now, timeZone)
  return { run: true, job: { ...job, nextRunAt } }
}
