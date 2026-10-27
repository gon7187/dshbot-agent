// Durable schedule rows in the daemon's SQLite store.
//
// The pure primitives in schedule.ts/claim.ts decide *when* a job runs. This
// module owns the table, the parsed schedule of every row and the at-most-once
// claim: the next run is written before a planned turn starts, so a crash in
// the middle of a turn cannot replay it.
//
// Every job carries the IANA zone its wall clock is read in. New jobs get the
// owner zone (`DSHBOT_TZ`, host zone by default); rows written before the zone
// column keep UTC and fire exactly as they did. A job may also carry an end
// condition — a moment (`until`) and/or a number of runs (`max_runs`) — and is
// removed from the table as soon as the condition is reached.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { claim } from './claim.js'
import { nextRun, parseSchedule } from './schedule.js'
import { assertTimeZone, ownerTimeZone } from './timezone.js'
import type { Schedule } from './types.js'

/** Migration namespace of the schedules table inside the shared store database. */
export const SCHEDULER_NAMESPACE = 'scheduler'

/** Zone of rows saved before jobs had a zone: they keep firing in UTC. */
export const SCHEDULER_TIME_ZONE = 'UTC'

/** The subset of packages/store the registry needs; keeps the scheduler package decoupled. */
export interface SchedulerStorage {
  readonly db: DatabaseSync
  migrate(namespace: string, steps: readonly string[]): void
}

const SCHEDULER_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    spec TEXT NOT NULL,
    schedule TEXT NOT NULL,
    task TEXT NOT NULL,
    idle_only INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (next_run_at) WHERE next_run_at IS NOT NULL`,
  // The zone and the end condition. A row without a zone was written before
  // the column existed and keeps firing in UTC.
  `ALTER TABLE schedules ADD COLUMN tz TEXT`,
  `ALTER TABLE schedules ADD COLUMN until_at INTEGER`,
  `ALTER TABLE schedules ADD COLUMN max_runs INTEGER`,
  `ALTER TABLE schedules ADD COLUMN runs INTEGER NOT NULL DEFAULT 0`,
  // A deterministic shell check runs before the planned turn; a raw entry
  // sends its stdout to the owner without a model. Rows without a check keep
  // the old behaviour and start the planned turn on every tick.
  `ALTER TABLE schedules ADD COLUMN check_command TEXT`,
  `ALTER TABLE schedules ADD COLUMN deliver TEXT`,
  `ALTER TABLE schedules ADD COLUMN last_skip_at INTEGER`,
  // Management of a saved job: a paused job stays in the table but never runs;
  // the generation is bumped by pause, resume and update so a batch claimed
  // before one of those actions cannot start the job on its stale reservation.
  `ALTER TABLE schedules ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE schedules ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`,
  // History of the last runs of a job. It lives in the same database as the
  // schedules and is shared by `schedule history` and the wake-up summary.
  `CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    output TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS schedule_runs_job_idx ON schedule_runs (job_id, id)`,
  // The named agent profile of a planned turn. A row without one runs its turn
  // in `main`, exactly as before profiles existed.
  `ALTER TABLE schedules ADD COLUMN agent TEXT`,
  // A stream watcher: a long-lived command whose matching output lines reach
  // the owner. Such a row has no next_run_at, so the ticker never fires it; the
  // watcher supervisor keeps its process alive.
  `ALTER TABLE schedules ADD COLUMN watch_command TEXT`,
  `ALTER TABLE schedules ADD COLUMN watch_pattern TEXT`,
  `ALTER TABLE schedules ADD COLUMN watch_window_sec INTEGER`,
]

/** How many last real (ok and error) runs of a job `schedule history` and the table keep. */
export const SCHEDULE_RUNS_LIMIT = 20

/**
 * How many last skips of a job the table keeps. Skips have their own retention:
 * a monitor that finds no work every few minutes must not push the real runs
 * out of the history.
 */
export const SCHEDULE_SKIP_LIMIT = 200

/** How many latest skips `schedule history` shows next to the real runs. */
export const SCHEDULE_HISTORY_SKIP_LIMIT = 20

/** How much of the output of one run is kept. */
export const SCHEDULE_RUN_OUTPUT_LIMIT = 300

/** Default batch window of a stream watcher, in seconds. */
export const DEFAULT_WATCH_WINDOW_SEC = 30

/** Smallest accepted batch window of a stream watcher, in seconds. */
export const MIN_WATCH_WINDOW_SEC = 1

/** Largest accepted batch window of a stream watcher, in seconds. */
export const MAX_WATCH_WINDOW_SEC = 86_400

/** One saved job as the rest of the daemon sees it. */
export interface ScheduleRecord {
  id: string
  /** The text the owner (or the model) gave to `schedule create`. */
  spec: string
  schedule: Schedule
  task: string
  idleOnly: boolean
  /** IANA zone of the wall clock of this job; `UTC` for rows saved before the zone. */
  tz: string
  nextRunAt: Date | null
  createdAt: number
  /** Signature of the last failed planned turn; null after a success. */
  lastError: string | null
  /** Moment after which the job is removed; null when it has no deadline. */
  until: Date | null
  /** Number of planned runs after which the job is removed; null when unlimited. */
  maxRuns: number | null
  /** Planned runs claimed so far (a run cancelled later still counts). */
  runs: number
  /** Shell command run before the planned turn; null for a plain entry. */
  check: string | null
  /** `raw` sends the check stdout without a model; `turn` is the planned turn. */
  deliver: ScheduleDelivery
  /** The long command of a stream watcher; null for an ordinary timed job. */
  watch: ScheduleWatch | null
  /** Moment of the last tick the check skipped as "no work"; null when none. */
  lastSkipAt: Date | null
  /** A paused job stays saved and visible but never starts a planned run. */
  paused: boolean
  /**
   * Named agent profile whose instructions, tools and model run the planned
   * turn; null means the ordinary turn of `main` with the owner tools.
   */
  agent: string | null
  /**
   * Incremented by pause, resume and update. A claimed batch remembers the
   * generation it reserved; a mismatch means the reservation is stale.
   */
  generation: number
}

/** One finished run of a job, as stored in `schedule_runs`. */
export interface ScheduleRun {
  id: number
  jobId: string
  startedAt: Date
  durationMs: number
  status: ScheduleRunStatus
  /** First {@link SCHEDULE_RUN_OUTPUT_LIMIT} characters of the run output. */
  output: string
}

/** `skip` is a scheduled tick whose check reported no work; every tick gets its own row. */
export type ScheduleRunStatus = 'ok' | 'error' | 'skip'

export interface RecordScheduleRunInput {
  jobId: string
  startedAt: Date
  durationMs: number
  status: ScheduleRunStatus
  output: string
}

/** Fields an `update` may change; omitted fields keep their stored value. */
export interface UpdateScheduleInput {
  spec?: string
  task?: string
  idleOnly?: boolean
  tz?: string
  until?: Date | number | string
  maxRuns?: number
  check?: string
  deliver?: ScheduleDelivery
  /** Named agent profile of the planned turn; omitted keeps `main`. */
  agent?: string
  /** Fields of a stream watcher; omitted fields keep their stored value. */
  watch?: Partial<ScheduleWatch>
}

/** How the result of a checked entry reaches the owner. */
export type ScheduleDelivery = 'turn' | 'raw'

/** The long command of a stream watcher and how its matching lines are delivered. */
export interface ScheduleWatch {
  /** Shell command kept alive in the exec sandbox. */
  command: string
  /** Regular expression; only matching output lines are delivered. */
  pattern: string
  /** Matches inside this many seconds are collected into one delivery. */
  windowSec: number
  /** `raw` sends the lines without a model; `turn` starts a planned turn. */
  deliver: ScheduleDelivery
}

export interface CreateScheduleInput {
  spec: string
  task: string
  idleOnly?: boolean
  /** IANA zone; defaults to the owner zone of the registry. */
  tz?: string
  /** Moment after which the job must not run (Date, epoch ms or ISO 8601 string). */
  until?: Date | number | string
  /** Number of planned runs after which the job is removed. */
  maxRuns?: number
  /** Optional shell check run before the planned turn. */
  check?: string
  /** Delivery of a checked entry; `raw` requires `check`. Defaults to `turn`. */
  deliver?: ScheduleDelivery
  /** Named agent profile whose instructions, tools and model run the turn. */
  agent?: string
  /**
   * A stream watcher instead of a timed job: a long command runs in the exec
   * sandbox and its matching lines are delivered to the owner. A watcher row
   * has no next run, so the schedule ticker never fires it.
   */
  watch?: ScheduleWatch
}

/** Why a job removed itself. */
export type ScheduleEndReason = 'max_runs' | 'until'

/** A job that reached its end condition and was removed from the table. */
export interface FinishedSchedule {
  job: ScheduleRecord
  reason: ScheduleEndReason
}

export interface ScheduleRegistry {
  /** Zone of the owner right now; the default zone of a new job. */
  readonly timeZone: string
  list(): ScheduleRecord[]
  get(id: string): ScheduleRecord | undefined
  create(input: CreateScheduleInput): ScheduleRecord
  remove(id: string): boolean
  /** Rows whose next run is due, in running order. Read-only: claim() advances them. */
  due(now: Date): ScheduleRecord[]
  /**
   * At-most-once claim of one due row: moves next_run_at before the run starts
   * and counts the run. Returns null when the row is no longer due (someone
   * else claimed it first).
   */
  claim(id: string, now: Date): ScheduleRecord | null
  /**
   * Removes every row whose end condition is reached (the deadline has passed
   * or max_runs claimed) and returns the removed rows once. A repeating job is
   * never removed early just because its next run would be after the deadline:
   * it leaves the table when the deadline itself has passed.
   */
  finish(now: Date): FinishedSchedule[]
  /**
   * Removes one row whose deadline has already passed, returning it exactly
   * once. Used right before a claimed run starts: a run may wait in a queue
   * long enough for the deadline to pass, and it must not start then.
   */
  expire(id: string, now: Date): FinishedSchedule | null
  /** A planned turn finished cleanly: a later identical error is news again. */
  recordSuccess(id: string): void
  /** Records an error signature; false when it repeats the previous one. */
  recordError(id: string, signature: string): boolean
  /** A check found no work: remembers the skip time and clears a stale error. */
  recordSkip(id: string, at: Date): void
  /**
   * Changes the fields of a saved job in place, keeping its id. The next run is
   * recomputed from the new schedule; returns null for an unknown id.
   */
  update(id: string, input: UpdateScheduleInput): ScheduleRecord | null
  /** Stops a job from running, keeping it saved and visible; null for an unknown id. */
  pause(id: string): ScheduleRecord | null
  /**
   * Resumes a paused job at its next scheduled moment. Missed runs are not
   * caught up: the next run is recomputed from the current moment.
   */
  resume(id: string): ScheduleRecord | null
  /** Appends one finished run and drops rows older than the retention of its kind. */
  recordRun(input: RecordScheduleRunInput): void
  /**
   * The last {@link SCHEDULE_RUNS_LIMIT} real runs of a job and its last
   * {@link SCHEDULE_HISTORY_SKIP_LIMIT} skips, newest first.
   */
  history(id: string): ScheduleRun[]
}

interface ScheduleRow {
  id: string
  spec: string
  schedule: string
  task: string
  idle_only: number
  next_run_at: number | null
  created_at: number
  last_error: string | null
  tz: string | null
  until_at: number | null
  max_runs: number | null
  runs: number | null
  check_command: string | null
  deliver: string | null
  last_skip_at: number | null
  paused: number | null
  generation: number | null
  agent: string | null
  watch_command: string | null
  watch_pattern: string | null
  watch_window_sec: number | null
}

interface ScheduleRunRow {
  id: number
  job_id: string
  started_at: number
  duration_ms: number
  status: string
  output: string
}

function changesOf(result: { changes?: number | bigint }): number {
  const value = result.changes ?? 0
  return typeof value === 'bigint' ? Number(value) : value
}

function toRecord(row: ScheduleRow): ScheduleRecord {
  let schedule: Schedule
  try {
    schedule = JSON.parse(row.schedule) as Schedule
    // JSON stores an absolute one-shot's Date as a string. Restore it before
    // passing the schedule to the formatter or the scheduling primitives.
    if (schedule.kind === 'once') schedule = { ...schedule, at: new Date(schedule.at) }
  } catch {
    throw new Error(`schedule ${row.id}: stored schedule is not valid JSON`)
  }
  return {
    id: row.id,
    spec: row.spec,
    schedule,
    task: row.task,
    idleOnly: row.idle_only !== 0,
    tz: typeof row.tz === 'string' && row.tz !== '' ? row.tz : SCHEDULER_TIME_ZONE,
    nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at),
    createdAt: row.created_at,
    lastError: row.last_error,
    until: row.until_at === null ? null : new Date(row.until_at),
    maxRuns: row.max_runs,
    runs: row.runs ?? 0,
    check: typeof row.check_command === 'string' && row.check_command !== '' ? row.check_command : null,
    deliver: row.deliver === 'raw' ? 'raw' : 'turn',
    lastSkipAt: row.last_skip_at === null ? null : new Date(row.last_skip_at),
    paused: (row.paused ?? 0) !== 0,
    agent: typeof row.agent === 'string' && row.agent !== '' ? row.agent : null,
    generation: row.generation ?? 0,
    watch:
      typeof row.watch_command === 'string' &&
      row.watch_command !== '' &&
      typeof row.watch_pattern === 'string' &&
      row.watch_pattern !== ''
        ? {
            command: row.watch_command,
            pattern: row.watch_pattern,
            windowSec:
              typeof row.watch_window_sec === 'number' && Number.isFinite(row.watch_window_sec)
                ? row.watch_window_sec
                : DEFAULT_WATCH_WINDOW_SEC,
            deliver: row.deliver === 'raw' ? 'raw' : 'turn',
          }
        : null,
  }
}

function toRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: new Date(row.started_at),
    durationMs: row.duration_ms,
    status: row.status === 'error' ? 'error' : row.status === 'skip' ? 'skip' : 'ok',
    output: row.output,
  }
}

function runOutput(text: string): string {
  return text.length > SCHEDULE_RUN_OUTPUT_LIMIT ? text.slice(0, SCHEDULE_RUN_OUTPUT_LIMIT) : text
}

/** Compile the pattern once, so a broken expression is refused before anything is saved. */
function assertWatchPattern(pattern: string, action: 'create' | 'update'): void {
  try {
    new RegExp(pattern)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`schedule ${action}: регулярное выражение наблюдателя некорректно: ${detail}`)
  }
}

/** Normalise and validate the fields of a stream watcher. */
function validateWatch(input: ScheduleWatch, action: 'create' | 'update'): ScheduleWatch {
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (command === '') throw new Error(`schedule ${action}: у наблюдателя пустая команда`)
  const pattern = typeof input.pattern === 'string' ? input.pattern.trim() : ''
  if (pattern === '') throw new Error(`schedule ${action}: у наблюдателя пустое регулярное выражение`)
  assertWatchPattern(pattern, action)
  const windowSec = input.windowSec
  if (
    !Number.isSafeInteger(windowSec) ||
    windowSec < MIN_WATCH_WINDOW_SEC ||
    windowSec > MAX_WATCH_WINDOW_SEC
  ) {
    throw new Error(
      `schedule ${action}: окно наблюдателя должно быть целым числом секунд от ${MIN_WATCH_WINDOW_SEC} до ${MAX_WATCH_WINDOW_SEC}`,
    )
  }
  if (input.deliver !== 'raw' && input.deliver !== 'turn') {
    throw new Error(`schedule ${action}: доставка наблюдателя должна быть "raw" или "turn"`)
  }
  return { command, pattern, windowSec, deliver: input.deliver }
}

function pastError(spec: string, at: Date): Error {
  return new Error(
    `Расписание "${spec}" уже в прошлом (${at.toISOString()}): разовый запуск в прошлом не создать.`,
  )
}

function tooLateError(spec: string, until: Date, firstRun: Date): Error {
  return new Error(
    `Расписание "${spec}": срок окончания ${until.toISOString()} раньше первого запуска ${firstRun.toISOString()} — ` +
      'ни одного запуска не будет. Укажи более поздний until или более частый интервал.',
  )
}

function parseMoment(value: Date | number | string, field: string): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'number'
        ? new Date(value)
        : (() => {
            const parsed = parseSchedule(value)
            if (parsed.kind !== 'once') throw new Error(`schedule create: ${field} должен быть моментом времени`)
            return parsed.at
          })()
  if (Number.isNaN(date.getTime())) throw new Error(`schedule create: ${field} — некорректный момент времени`)
  return date
}

/**
 * True while a claimed run may still start: the row exists, is not paused, and
 * pause, resume or update have not replaced the reservation since the claim
 * (same generation and the next run the claim wrote). Read fresh from the table
 * every time, because a claimed run waits behind other runs and the owner's turn.
 */
export function claimIsCurrent(registry: Pick<ScheduleRegistry, 'get'>, claimed: ScheduleRecord): boolean {
  const fresh = registry.get(claimed.id)
  if (fresh === undefined || fresh.paused || fresh.generation !== claimed.generation) return false
  if (fresh.nextRunAt === null || claimed.nextRunAt === null) return fresh.nextRunAt === claimed.nextRunAt
  return fresh.nextRunAt.getTime() === claimed.nextRunAt.getTime()
}

/** End condition of a row at `now`, or null while the job should keep running. */
function endReason(record: ScheduleRecord, now: Date): ScheduleEndReason | null {
  if (record.maxRuns !== null && record.runs >= record.maxRuns) return 'max_runs'
  const until = record.until
  if (until === null) return null
  // A repeating job leaves the table when the deadline has actually passed, not
  // earlier: a run before the deadline is still due even when the run after it
  // would be too late. A one-shot is removed after the deadline too, so a row
  // with an end condition never lingers past it.
  if (now.getTime() > until.getTime()) return 'until'
  return null
}

/**
 * Open (and migrate) the schedules table. Options exist for deterministic tests:
 * the wall clock, the id generator and the default (owner) zone.
 */
export function createScheduleRegistry(
  storage: SchedulerStorage,
  options: { now?: () => Date; id?: () => string; timeZone?: string } = {},
): ScheduleRegistry {
  storage.migrate(SCHEDULER_NAMESPACE, SCHEDULER_STEPS)

  const now = options.now ?? (() => new Date())
  const newId = options.id ?? (() => `sched-${randomUUID()}`)
  // The owner zone is resolved once, at startup, from DSHBOT_TZ or the host.
  const defaultZone = options.timeZone === undefined ? ownerTimeZone() : assertTimeZone(options.timeZone)

  const db = storage.db
  const COLUMNS =
    'id, spec, schedule, task, idle_only, next_run_at, created_at, last_error, tz, until_at, max_runs, runs, ' +
    'check_command, deliver, last_skip_at, paused, generation, agent, watch_command, watch_pattern, watch_window_sec'
  const selectAll = db.prepare(`SELECT ${COLUMNS} FROM schedules ORDER BY created_at, id`)
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM schedules WHERE id = ?`)
  const selectDue = db.prepare(
    `SELECT ${COLUMNS}
     FROM schedules WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, created_at, id`,
  )
  const insert = db.prepare(
    `INSERT INTO schedules (id, spec, schedule, task, idle_only, next_run_at, created_at, last_error, tz, until_at, max_runs, runs, check_command, deliver, last_skip_at, agent, watch_command, watch_pattern, watch_window_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?)`,
  )
  const removeStatement = db.prepare('DELETE FROM schedules WHERE id = ?')
  const advance = db.prepare(
    'UPDATE schedules SET next_run_at = ?, runs = runs + 1 WHERE id = ? AND next_run_at IS ?',
  )
  const setLastError = db.prepare('UPDATE schedules SET last_error = ? WHERE id = ?')
  const setLastSkip = db.prepare('UPDATE schedules SET last_skip_at = ?, last_error = NULL WHERE id = ?')
  const pauseRow = db.prepare('UPDATE schedules SET paused = 1, generation = generation + 1 WHERE id = ?')
  const resumeRow = db.prepare(
    'UPDATE schedules SET paused = 0, generation = generation + 1, next_run_at = ? WHERE id = ?',
  )
  const updateRow = db.prepare(
    'UPDATE schedules SET spec = ?, schedule = ?, task = ?, idle_only = ?, tz = ?, until_at = ?, max_runs = ?, ' +
      'check_command = ?, deliver = ?, agent = ?, next_run_at = ?, last_error = NULL, generation = generation + 1 ' +
      'WHERE id = ?',
  )
  // A watcher keeps next_run_at NULL: only the command, the expression, the
  // window and the delivery mode change, and the generation bump restarts the
  // supervised process with the new command.
  const updateWatchRow = db.prepare(
    'UPDATE schedules SET spec = ?, task = ?, watch_command = ?, watch_pattern = ?, watch_window_sec = ?, ' +
      'deliver = ?, next_run_at = NULL, last_error = NULL, generation = generation + 1 WHERE id = ?',
  )
  const insertRun = db.prepare(
    'INSERT INTO schedule_runs (job_id, started_at, duration_ms, status, output) VALUES (?, ?, ?, ?, ?)',
  )
  // Keep the newest 20 real runs and the newest 200 skips of each job; ids are
  // monotonic, so ordering by id is the order of the runs even for two runs in
  // the same millisecond. The two kinds have separate retention: an idle
  // monitor writes a skip on every tick and must not evict its real runs.
  const trimRuns = db.prepare(
    `DELETE FROM schedule_runs WHERE job_id = ? AND status <> 'skip' AND id NOT IN (
       SELECT id FROM schedule_runs WHERE job_id = ? AND status <> 'skip' ORDER BY id DESC LIMIT ${SCHEDULE_RUNS_LIMIT}
     )`,
  )
  const trimSkips = db.prepare(
    `DELETE FROM schedule_runs WHERE job_id = ? AND status = 'skip' AND id NOT IN (
       SELECT id FROM schedule_runs WHERE job_id = ? AND status = 'skip' ORDER BY id DESC LIMIT ${SCHEDULE_SKIP_LIMIT}
     )`,
  )
  const selectRealRuns = db.prepare(
    'SELECT id, job_id, started_at, duration_ms, status, output FROM schedule_runs WHERE job_id = ? ' +
      `AND status <> 'skip' ORDER BY id DESC LIMIT ${SCHEDULE_RUNS_LIMIT}`,
  )
  const selectSkipRuns = db.prepare(
    'SELECT id, job_id, started_at, duration_ms, status, output FROM schedule_runs WHERE job_id = ? ' +
      `AND status = 'skip' ORDER BY id DESC LIMIT ${SCHEDULE_HISTORY_SKIP_LIMIT}`,
  )

  function list(): ScheduleRecord[] {
    return (selectAll.all() as unknown as ScheduleRow[]).map(toRecord)
  }

  function get(id: string): ScheduleRecord | undefined {
    const row = selectOne.get(id) as ScheduleRow | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  function create(input: CreateScheduleInput): ScheduleRecord {
    const spec = typeof input.spec === 'string' ? input.spec.trim() : ''
    if (spec === '') throw new Error('schedule create: пустое расписание')
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (task === '') throw new Error('schedule create: пустой текст задания')

    const tz = input.tz === undefined ? defaultZone : assertTimeZone(input.tz)
    const until = input.until === undefined ? null : parseMoment(input.until, 'until')
    const maxRuns = input.maxRuns ?? null
    if (maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 1)) {
      throw new Error('schedule create: max_runs должен быть целым числом не меньше 1')
    }
    const check = typeof input.check === 'string' ? input.check.trim() : ''
    if (check === '' && input.check !== undefined) throw new Error('schedule create: пустая команда проверки')
    const deliver: ScheduleDelivery = input.deliver ?? 'turn'
    if (deliver !== 'turn' && deliver !== 'raw') {
      throw new Error('schedule create: deliver должен быть "turn" или "raw"')
    }
    const agent = typeof input.agent === 'string' ? input.agent.trim() : ''
    if (agent === '' && input.agent !== undefined) throw new Error('schedule create: пустое имя профиля агента')
    if (input.watch === undefined && deliver === 'raw' && check === '') {
      throw new Error('schedule create: режим raw требует check — без команды проверки отправлять нечего')
    }

    // A watcher is not a timed job: it has no next run, so the ticker never
    // claims it; the watcher supervisor starts its command right away.
    if (input.watch !== undefined) {
      if (input.check !== undefined && check !== '') {
        throw new Error('schedule create: у наблюдателя не бывает check — его команда и есть наблюдатель')
      }
      const watch = validateWatch(input.watch, 'create')
      const record: ScheduleRecord = {
        id: newId(),
        spec: spec === '' ? `watch ${watch.windowSec}s` : spec,
        schedule: { kind: 'watch' },
        task: task === '' ? `Наблюдение за потоком: ${watch.command}` : task,
        idleOnly: input.idleOnly === true,
        tz,
        nextRunAt: null,
        createdAt: now().getTime(),
        lastError: null,
        until,
        maxRuns,
        runs: 0,
        check: null,
        deliver: watch.deliver,
        watch,
        lastSkipAt: null,
        paused: false,
        agent: agent === '' ? null : agent,
        generation: 0,
      }
      insert.run(
        record.id,
        record.spec,
        JSON.stringify(record.schedule),
        record.task,
        record.idleOnly ? 1 : 0,
        null,
        record.createdAt,
        record.tz,
        until === null ? null : until.getTime(),
        maxRuns,
        record.check,
        record.deliver,
        record.agent,
        watch.command,
        watch.pattern,
        watch.windowSec,
      )
      return record
    }

    const createdAt = now()
    if (until !== null && until.getTime() <= createdAt.getTime()) {
      throw new Error(
        `schedule create: until ${until.toISOString()} уже в прошлом — задание не успеет ни разу запуститься`,
      )
    }

    const schedule = parseSchedule(spec, tz)
    const nextRunAt = nextRun(schedule, createdAt, tz)
    if (nextRunAt === null) throw pastError(spec, schedule.kind === 'once' ? schedule.at : createdAt)
    if (until !== null && nextRunAt.getTime() > until.getTime()) throw tooLateError(spec, until, nextRunAt)

    const record: ScheduleRecord = {
      id: newId(),
      spec,
      schedule,
      task,
      idleOnly: input.idleOnly === true,
      tz,
      nextRunAt,
      createdAt: createdAt.getTime(),
      lastError: null,
      until,
      maxRuns,
      runs: 0,
      check: check === '' ? null : check,
      deliver,
      watch: null,
      lastSkipAt: null,
      paused: false,
      agent: agent === '' ? null : agent,
      generation: 0,
    }
    insert.run(
      record.id,
      record.spec,
      JSON.stringify(record.schedule),
      record.task,
      record.idleOnly ? 1 : 0,
      nextRunAt.getTime(),
      record.createdAt,
      record.tz,
      until === null ? null : until.getTime(),
      maxRuns,
      record.check,
      record.deliver,
      record.agent,
      null,
      null,
      null,
    )
    return record
  }

  function remove(id: string): boolean {
    return changesOf(removeStatement.run(id)) > 0
  }

  function pause(id: string): ScheduleRecord | null {
    const record = get(id)
    if (record === undefined) return null
    if (record.paused) return record
    pauseRow.run(id)
    return get(id) ?? record
  }

  function resume(id: string): ScheduleRecord | null {
    const record = get(id)
    if (record === undefined) return null
    if (!record.paused) return record
    const current = now()
    // Resume means "the next scheduled moment from now", not a replay of every
    // interval that passed while the job was paused.
    const next = nextRun(record.schedule, current, record.tz)
    resumeRow.run(next === null ? null : next.getTime(), id)
    return get(id) ?? record
  }

  function update(id: string, input: UpdateScheduleInput): ScheduleRecord | null {
    const record = get(id)
    if (record === undefined) return null

    const spec = input.spec === undefined ? record.spec : typeof input.spec === 'string' ? input.spec.trim() : ''
    if (spec === '') throw new Error('schedule update: пустое расписание')
    const task = input.task === undefined ? record.task : typeof input.task === 'string' ? input.task.trim() : ''
    if (task === '') throw new Error('schedule update: пустой текст задания')

    // A watcher keeps its own fields; a change bumps the generation so the
    // supervisor stops the old process and starts the command again.
    if (record.watch !== null) {
      const merged: ScheduleWatch = { ...record.watch }
      if (input.watch !== undefined) {
        if (input.watch.command !== undefined) merged.command = input.watch.command
        if (input.watch.pattern !== undefined) merged.pattern = input.watch.pattern
        if (input.watch.windowSec !== undefined) merged.windowSec = input.watch.windowSec
        if (input.watch.deliver !== undefined) merged.deliver = input.watch.deliver
      }
      if (input.deliver !== undefined) merged.deliver = input.deliver
      const watch = validateWatch(merged, 'update')
      updateWatchRow.run(spec, task, watch.command, watch.pattern, watch.windowSec, watch.deliver, id)
      return get(id) ?? record
    }

    const tz = input.tz === undefined ? record.tz : assertTimeZone(input.tz)
    const until = input.until === undefined ? record.until : parseMoment(input.until, 'until')
    const maxRuns = input.maxRuns === undefined ? record.maxRuns : input.maxRuns
    if (maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 1)) {
      throw new Error('schedule update: max_runs должен быть целым числом не меньше 1')
    }
    let check = record.check
    if (input.check !== undefined) {
      const raw = typeof input.check === 'string' ? input.check.trim() : ''
      if (raw === '' && input.check !== '') throw new Error('schedule update: пустая команда проверки')
      check = raw === '' ? null : raw
    }
    const deliver: ScheduleDelivery = input.deliver ?? record.deliver
    if (deliver !== 'turn' && deliver !== 'raw') {
      throw new Error('schedule update: deliver должен быть "turn" или "raw"')
    }
    if (deliver === 'raw' && check === null) {
      throw new Error('schedule update: режим raw требует check — без команды проверки отправлять нечего')
    }
    let agent = record.agent
    if (input.agent !== undefined) {
      const raw = typeof input.agent === 'string' ? input.agent.trim() : ''
      agent = raw === '' ? null : raw
    }

    const current = now()
    if (until !== null && until.getTime() <= current.getTime()) {
      throw new Error(`schedule update: until ${until.toISOString()} уже в прошлом — задание не успеет ни разу запуститься`)
    }
    const schedule = parseSchedule(spec, tz)
    const next = nextRun(schedule, current, tz)
    if (next === null) throw pastError(spec, schedule.kind === 'once' ? schedule.at : current)
    if (until !== null && next.getTime() > until.getTime()) throw tooLateError(spec, until, next)

    const idleOnly = input.idleOnly === undefined ? record.idleOnly : input.idleOnly === true
    updateRow.run(
      spec,
      JSON.stringify(schedule),
      task,
      idleOnly ? 1 : 0,
      tz,
      until === null ? null : until.getTime(),
      maxRuns,
      check,
      deliver,
      agent,
      next.getTime(),
      id,
    )
    return get(id) ?? record
  }

  function recordRun(input: RecordScheduleRunInput): void {
    if (!(input.startedAt instanceof Date) || Number.isNaN(input.startedAt.getTime())) return
    const duration = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0
    const status: ScheduleRunStatus = input.status === 'error' ? 'error' : input.status === 'skip' ? 'skip' : 'ok'
    insertRun.run(input.jobId, input.startedAt.getTime(), duration, status, runOutput(input.output))
    if (status === 'skip') trimSkips.run(input.jobId, input.jobId)
    else trimRuns.run(input.jobId, input.jobId)
  }

  function history(id: string): ScheduleRun[] {
    // Both kinds keep their own newest rows, then the union is shown newest
    // first: 20 real runs and 20 skips at most.
    const rows = [
      ...(selectRealRuns.all(id) as unknown as ScheduleRunRow[]),
      ...(selectSkipRuns.all(id) as unknown as ScheduleRunRow[]),
    ]
    rows.sort((left, right) => right.id - left.id)
    return rows.map(toRun)
  }

  function due(at: Date): ScheduleRecord[] {
    return (selectDue.all(at.getTime()) as unknown as ScheduleRow[]).map(toRecord)
  }

  function claimRow(id: string, at: Date): ScheduleRecord | null {
    const row = selectOne.get(id) as ScheduleRow | undefined
    if (row === undefined) return null
    const record = toRecord(row)
    if (record.paused || record.nextRunAt === null) return null

    const result = claim({ schedule: record.schedule, nextRunAt: record.nextRunAt }, at, record.tz)
    if (!result.run) return null
    const nextAt = result.job.nextRunAt === null ? null : result.job.nextRunAt.getTime()
    // Conditional on the old due time: a second tick cannot claim the same run.
    const updated = advance.run(nextAt, id, row.next_run_at)
    if (changesOf(updated) !== 1) return null
    return { ...record, nextRunAt: result.job.nextRunAt, runs: record.runs + 1 }
  }

  function finish(at: Date): FinishedSchedule[] {
    const finished: FinishedSchedule[] = []
    for (const record of list()) {
      const reason = endReason(record, at)
      if (reason === null) continue
      // A concurrent tick may have removed the row between the read and the
      // delete; only the caller that removed it reports the owner once.
      if (!remove(record.id)) continue
      finished.push({ job: record, reason })
    }
    return finished
  }

  function expire(id: string, at: Date): FinishedSchedule | null {
    const row = selectOne.get(id) as ScheduleRow | undefined
    if (row === undefined) return null
    const record = toRecord(row)
    if (record.until === null || at.getTime() <= record.until.getTime()) return null
    // The conditional delete keeps the notification single even when finish()
    // removed the same row a moment earlier.
    if (!remove(id)) return null
    return { job: record, reason: 'until' }
  }

  function recordSuccess(id: string): void {
    setLastError.run(null, id)
  }

  function recordError(id: string, signature: string): boolean {
    const row = selectOne.get(id) as ScheduleRow | undefined
    const repeat = row !== undefined && row.last_error === signature
    setLastError.run(signature, id)
    return !repeat
  }

  function recordSkip(id: string, at: Date): void {
    setLastSkip.run(at.getTime(), id)
  }

  return {
    timeZone: defaultZone,
    list,
    get,
    create,
    remove,
    due,
    claim: claimRow,
    finish,
    expire,
    recordSuccess,
    recordError,
    recordSkip,
    update,
    pause,
    resume,
    recordRun,
    history,
  }
}
