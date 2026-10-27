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
  let handle: unknown

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

  function arm(minutes: number): void {
    if (!started || stopped || running) return
    clear()
    const delay = drawnInterval(minutes) * MINUTE_MS
    dueAt = now() + delay
    handle = setTimer(onTimer, delay)
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
      else requestedDuringTurn = interval
      return interval
    },
    intervalMinutes: () => interval,
    nextWakeAt: () => dueAt,
    isRunning: () => running,
  }
}
