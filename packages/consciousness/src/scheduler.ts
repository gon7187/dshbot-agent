// The wake-up alarm: one timer, bounded interval, doubling after a failed turn.
//
// The scheduler owns no model and no Telegram API. It calls `runTurn` and treats
// a resolved `'failed'` or a rejection as an unsuccessful wake-up. While a turn is
// in flight (including a turn queued behind the owner, because `runTurn` itself
// waits for the main-session lock) the next alarm is not armed: the interval is
// counted from the end of the turn, never from its scheduled time.
//
// The interval the model asked for is the base. The actual alarm is drawn around
// it with `DSHBOT_WAKE_JITTER` so the bot does not live on a metronome: a base of
// 60 min with the default 0.3 rings between 42 and 78 min. `intervalMinutes()`
// keeps reporting the base, so the prompt and the model stay about the rhythm,
// not about one random draw. The owner bounds 15..240 min apply to the draw too.
//
// The deadline and the base interval survive a restart of the daemon: with a
// `storage` the scheduler writes `{dueAt, intervalMinutes}` whenever it arms the
// alarm and continues the count after `start()`. A deadline missed during the
// downtime (up to 4 hours) rings once, shortly after the start; an older one is
// dropped and the next alarm counts from the start. A missing or unreadable
// record starts the scheduler as a fresh one.

import { MINUTE_MS } from '../../scheduler/src/index.js'

/** Owner bounds of one wake-up interval. */
export const MIN_WAKE_INTERVAL_MIN = 15
export const MAX_WAKE_INTERVAL_MIN = 240

/** First wake-up when the model has not chosen an interval yet. */
export const DEFAULT_WAKE_INTERVAL_MIN = 60

/** Default relative spread of the alarm, `DSHBOT_WAKE_JITTER`: ±30% of the base. */
export const DEFAULT_WAKE_JITTER = 0.3

/** A machine that slept for longer than this does not get a stale wake-up burst. */
const MAX_STALE_WAKE_MS = 4 * 60 * MINUTE_MS

/** A deadline missed during a restart rings this long after the start, once. */
const CATCH_UP_DELAY_MS = 2 * MINUTE_MS

/** Where the scheduler keeps its deadline and interval between processes. */
export interface WakeScheduleStorage {
  /** The stored text, or undefined when nothing is stored. */
  read: () => string | undefined
  write: (value: string) => void
}

/** The persisted state: the planned moment of the next alarm and the base interval. */
interface StoredWakeSchedule {
  dueAt: number
  intervalMinutes: number
}

/**
 * Parse a stored record; undefined when the deadline is not a finite moment or the
 * interval is not inside the owner bounds. Such a record is damaged: it is never
 * silently repaired into some other interval.
 */
function parseStoredSchedule(text: string): StoredWakeSchedule | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { dueAt, intervalMinutes } = value as Record<string, unknown>
  if (typeof dueAt !== 'number' || !Number.isFinite(dueAt) || dueAt < 0) return undefined
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes)) return undefined
  if (intervalMinutes < MIN_WAKE_INTERVAL_MIN || intervalMinutes > MAX_WAKE_INTERVAL_MIN) return undefined
  return { dueAt, intervalMinutes }
}

/** How one wake-up turn ended. */
export type WakeTurnOutcome = 'ok' | 'failed'

export interface WakeSchedulerOptions {
  /** Runs one wake-up turn; a throw is a failed wake-up. */
  runTurn: () => Promise<WakeTurnOutcome> | WakeTurnOutcome
  /** Clock used for the due check; defaults to the wall clock. */
  now?: () => number
  /** Timer seam; defaults to the process `setTimeout`. */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  /** Timer seam; defaults to the process `clearTimeout`. */
  clearTimer?: (handle: unknown) => void
  /** Starting interval in minutes; defaults to {@link DEFAULT_WAKE_INTERVAL_MIN}. */
  intervalMinutes?: number
  /**
   * Relative jitter of the actual alarm around the base interval, `0..1`
   * (default {@link DEFAULT_WAKE_JITTER}). `0` rings exactly at the base.
   */
  jitter?: number
  /** Random seam for the jitter; defaults to `Math.random`. */
  random?: () => number
  /** Keeps the deadline and the interval across restarts; without it the alarm lives in memory only. */
  storage?: WakeScheduleStorage
  /** Reported once per failed turn; a broken handler never breaks the alarm. */
  onError?: (error: unknown) => void
}

export interface WakeScheduler {
  /** Arm the first alarm; a no-op when already started. */
  start(): void
  /** Disarm the alarm and do not arm another one after the turn in flight. */
  stop(): void
  /**
   * The model's `set_next_wakeup`. Clamps to the owner bounds and returns the
   * applied value. Outside a wake-up turn it also reschedules the alarm from now;
   * inside one the new interval is applied after the turn ends.
   */
  setNextInterval(minutes: number): number
  /** Base interval currently in force, in minutes (without the jitter draw). */
  intervalMinutes(): number
  /** Planned time of the next alarm, or undefined when none is armed. */
  nextWakeAt(): number | undefined
  /** True from the fire of the alarm until its turn settled. */
  isRunning(): boolean
}

/** Clamp a requested interval to the owner bounds; non-finite input keeps the minimum. */
export function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return MIN_WAKE_INTERVAL_MIN
  const whole = Math.round(minutes)
  return Math.min(MAX_WAKE_INTERVAL_MIN, Math.max(MIN_WAKE_INTERVAL_MIN, whole))
}

/** Jitter in `0..1`; an unreadable value keeps the default instead of removing the spread. */
export function normalizeWakeJitter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_WAKE_JITTER
  return Math.min(1, Math.max(0, value))
}

/**
 * Parse `DSHBOT_WAKE_JITTER`. Absent or empty keeps the default; a value that is
 * not a finite number in `0..1` stops the start instead of silently becoming 0.
 */
export function parseWakeJitter(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_WAKE_JITTER
  const text = value.trim()
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`DSHBOT_WAKE_JITTER must be a number between 0 and 1, got ${JSON.stringify(value)}`)
  }
  return parsed
}

export function createWakeScheduler(options: WakeSchedulerOptions): WakeScheduler {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const reportError = options.onError ?? (() => undefined)
  const random = options.random ?? Math.random
  const jitter = normalizeWakeJitter(options.jitter)

  let interval = clampInterval(options.intervalMinutes ?? DEFAULT_WAKE_INTERVAL_MIN)
  let started = false
  let stopped = false
  let running = false
  let requestedDuringTurn: number | undefined
  let dueAt: number | undefined
  /** The deadline last written to the storage; it outlives `dueAt` while a turn runs. */
  let savedDueAt: number | undefined
  let handle: unknown

  function persist(): void {
    if (options.storage === undefined || savedDueAt === undefined) return
    try {
      options.storage.write(JSON.stringify({ dueAt: savedDueAt, intervalMinutes: interval }))
    } catch (error) {
      reportError(error)
    }
  }

  /** The stored state of a previous process, or undefined for a fresh start. */
  function restore(): StoredWakeSchedule | undefined {
    let text: string | undefined
    try {
      text = options.storage?.read()
    } catch (error) {
      reportError(error)
      return undefined
    }
    if (text === undefined) return undefined
    const stored = parseStoredSchedule(text)
    if (stored === undefined) reportError(new Error('stored wake-up schedule is unreadable, starting with the default interval'))
    return stored
  }

  /** The actual alarm interval: the base with the configured spread, still inside the owner bounds. */
  function drawnInterval(minutes: number): number {
    const base = clampInterval(minutes)
    if (jitter <= 0) return base
    const factor = 1 + jitter * (2 * random() - 1)
    return clampInterval(base * factor)
  }

  function clear(): void {
    if (handle !== undefined) {
      clearTimer(handle)
      handle = undefined
    }
    dueAt = undefined
  }

  function armAfter(delay: number): void {
    if (!started || stopped || running) return
    clear()
    dueAt = now() + delay
    savedDueAt = dueAt
    handle = setTimer(onTimer, delay)
    persist()
  }

  function arm(minutes: number): void {
    armAfter(drawnInterval(minutes) * MINUTE_MS)
  }

  /** Continue the count of a previous process; false when the record is of no use. */
  function resume(stored: StoredWakeSchedule): boolean {
    // The chosen interval stays in force even when the deadline itself is dropped.
    interval = clampInterval(stored.intervalMinutes)
    const late = now() - stored.dueAt
    if (late > MAX_STALE_WAKE_MS) return false
    if (late >= 0) {
      armAfter(CATCH_UP_DELAY_MS)
      return true
    }
    // A deadline farther away than any interval can draw is a clock that moved back.
    if (-late > MAX_WAKE_INTERVAL_MIN * MINUTE_MS) return false
    armAfter(-late)
    return true
  }

  function onTimer(): void {
    handle = undefined
    const at = now()
    const due = dueAt
    dueAt = undefined
    if (!started || stopped || running) return
    if (due === undefined) return
    // A shortened real timer (tests, host timer scaling) is not a due alarm yet:
    // keep the virtual due time and wait for the rest.
    if (at + 1_000 < due) {
      const remaining = due - at
      dueAt = due
      handle = setTimer(onTimer, remaining)
      return
    }
    // The host slept or the clock jumped far past the alarm. A stale wake-up is
    // not replayed at once; the next one counts from now.
    if (at - due > MAX_STALE_WAKE_MS) {
      arm(interval)
      return
    }
    void fire()
  }

  async function fire(): Promise<void> {
    if (stopped || running) return
    running = true
    requestedDuringTurn = undefined
    let outcome: WakeTurnOutcome = 'failed'
    try {
      outcome = await options.runTurn()
    } catch (error) {
      reportError(error)
      outcome = 'failed'
    } finally {
      running = false
    }
    if (!started || stopped) return
    interval =
      outcome === 'ok'
        ? clampInterval(requestedDuringTurn ?? interval)
        : clampInterval(interval * 2)
    arm(interval)
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      const stored = restore()
      if (stored !== undefined && resume(stored)) return
      arm(interval)
    },
    stop() {
      stopped = true
      started = false
      clear()
    },
    setNextInterval(minutes: number): number {
      interval = clampInterval(minutes)
      if (!running) arm(interval)
      else {
        requestedDuringTurn = interval
        persist()
      }
      return interval
    },
    intervalMinutes: () => interval,
    nextWakeAt: () => dueAt,
    isRunning: () => running,
  }
}
