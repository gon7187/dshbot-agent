// Pure scheduling primitives for dshbot. No storage, no timers, no external deps:
// callers persist nextRunAt and hand it back to claim() when the daemon wakes up.

/** Parsed cron field: sorted matching values plus whether the field was unrestricted. */
export interface CronFields {
  /** 0-59 */
  readonly minutes: readonly number[]
  /** 0-23 */
  readonly hours: readonly number[]
  /** 1-31 */
  readonly daysOfMonth: readonly number[]
  /** 1-12 */
  readonly months: readonly number[]
  /** 0-6, Sunday = 0 (7 in the expression is normalised to 0) */
  readonly daysOfWeek: readonly number[]
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

export type Schedule =
  /** One-shot at a fixed instant. */
  | { readonly kind: 'once'; readonly at: Date }
  /** One-shot relative to the moment nextRun() is evaluated. */
  | { readonly kind: 'after'; readonly durationMs: number }
  /** Repeating interval anchored at the moment nextRun() is evaluated. */
  | { readonly kind: 'every'; readonly intervalMs: number }
  /** Five-field cron expression evaluated in an IANA time zone. */
  | { readonly kind: 'cron'; readonly cron: CronFields; readonly expression: string }
  /**
   * A stream watcher: a long-lived command files its matching output to the
   * owner instead of starting timed runs. Such a row has no `nextRunAt`.
   */
  | { readonly kind: 'watch' }

export interface ScheduledJob {
  schedule: Schedule
  nextRunAt: Date | null
}

export interface ClaimResult<J extends ScheduledJob> {
  run: boolean
  job: J
}
