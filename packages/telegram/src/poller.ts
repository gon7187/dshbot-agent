import { TelegramApiError, type TelegramApi } from './api.js'
import type { TelegramUpdate } from './update.js'

export const DEFAULT_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'message_reaction',
  'stopped_message_generation',
] as const

const DEFAULT_POLL_TIMEOUT_SEC = 30
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 30_000
/** Extra time over the long poll before the request itself is aborted. */
const POLL_REQUEST_RESERVE_MS = 15_000
/** First pause after a 409; every further attempt of the series doubles it. */
const CONFLICT_BASE_MS = 2_000
/** A second instance deserves patience, but a conflict series never waits longer than this. */
const CONFLICT_MAX_MS = 60_000

/** A second poller is already consuming getUpdates for this token. */
export class TelegramPollerConflictError extends Error {
  readonly errorCode = 409

  constructor(description: string) {
    super(`Telegram poller conflict (409): ${description}`)
    this.name = 'TelegramPollerConflictError'
  }
}

/**
 * Telegram rejected the bot token; the daemon should exit with the config code.
 * Still a {@link TelegramApiError}: callers that only know the API error keep working.
 */
export class TelegramPollerAuthError extends TelegramApiError {
  constructor(description: string, errorCode = 401) {
    super('getUpdates', errorCode, description)
    this.name = 'TelegramPollerAuthError'
  }
}

/**
 * No getUpdates cycle completed within the stall threshold. Thrown by
 * `start()` so the daemon can exit non-zero and let systemd restart it; a hung
 * long poll would otherwise leave the process alive but unreachable.
 */
export class TelegramPollerStallError extends Error {
  readonly stallMs: number

  constructor(stallMs: number) {
    super(`Telegram polling made no progress for ${stallMs} ms`)
    this.name = 'TelegramPollerStallError'
    this.stallMs = stallMs
  }
}

export interface CreatePollerOptions {
  api: TelegramApi
  /** Must be durable before returning: the offset only advances after this resolves. */
  handle: (update: TelegramUpdate) => void | Promise<void>
  allowedUpdates?: readonly string[]
  timeoutSec?: number
  /**
   * Longest time without a settled getUpdates request before `start()` rejects
   * with {@link TelegramPollerStallError}. Absent or 0 disables the watchdog.
   */
  stallMs?: number
  /** Journal seam of recoverable conditions; a 409 series is one line, not one per attempt. */
  log?: (message: string) => void
}

export interface TelegramPoller {
  /** Runs the polling loop; resolves on stop(), rejects on a fatal error. */
  start(): Promise<void>
  /** Ends the loop as soon as possible; no further getUpdates requests are made. */
  stop(): void
}

function retryDelay(failures: number): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(RETRY_BASE_MS * 2 ** exponent, RETRY_MAX_MS)
}

function conflictDelay(conflicts: number): number {
  const exponent = Math.max(0, conflicts - 1)
  return Math.min(CONFLICT_BASE_MS * 2 ** exponent, CONFLICT_MAX_MS)
}

export function createPoller(options: CreatePollerOptions): TelegramPoller {
  const { api, handle } = options
  const allowedUpdates = options.allowedUpdates ?? DEFAULT_ALLOWED_UPDATES
  const timeoutSec = options.timeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC
  const stallMs = options.stallMs ?? 0
  const journal = options.log ?? (() => undefined)
  // A long poll may legitimately stay silent for `timeout` seconds; the request
  // deadline gives it a bounded reserve, and the stall watchdog gives the whole
  // loop a second, longer bound independent of a single request.
  const requestTimeoutMs = Math.max(30_000, timeoutSec * 1000 + POLL_REQUEST_RESERVE_MS)

  let offset: number | undefined
  let stopped = false
  let running = false
  let wakeSleep: (() => void) | undefined

  let stallCheck: ReturnType<typeof setInterval> | undefined
  /** Monotonic start of the current no-progress window; the wall clock may jump. */
  let progressAt = 0
  let stalled = false
  let activeRequest: AbortController | undefined

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (stopped) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        wakeSleep = undefined
        resolve()
      }, ms)
      wakeSleep = () => {
        clearTimeout(timer)
        wakeSleep = undefined
        resolve()
      }
    })
  }

  function clearStall(): void {
    if (stallCheck !== undefined) {
      clearInterval(stallCheck)
      stallCheck = undefined
    }
  }

  /**
   * A planned pause (flood wait, conflict or error backoff) is not a hang: the
   * watchdog is disarmed until the loop is about to make a request again.
   */
  async function pause(ms: number): Promise<void> {
    clearStall()
    try {
      await sleep(Math.max(0, ms))
    } finally {
      if (!stopped && !stalled) armStall()
    }
  }

  function stop(): void {
    stopped = true
    clearStall()
    activeRequest?.abort()
    wakeSleep?.()
  }

  function fatalError(error: unknown): Error {
    if (error instanceof TelegramApiError && error.errorCode === 409) {
      return new TelegramPollerConflictError(error.description)
    }
    if (error instanceof TelegramApiError && error.errorCode === 401) {
      return new TelegramPollerAuthError(error.description, error.errorCode)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  let rejectStall: ((error: Error) => void) | undefined
  // The rejection must be observed even while the loop is between requests.
  const stallFailure = new Promise<never>((_, reject) => {
    rejectStall = reject
  })
  void stallFailure.catch(() => undefined)

  function armStall(): void {
    if (stallMs <= 0) return
    // Monotonic time, not the wall clock: a host or a test that moves the clock
    // by days did not hang the poll, while a real silent request did.
    progressAt = performance.now()
    if (stallCheck !== undefined) return
    const period = Math.max(50, Math.min(30_000, Math.floor(stallMs / 4)))
    stallCheck = setInterval(() => {
      if (stopped || stalled) return
      if (performance.now() - progressAt < stallMs) return
      clearStall()
      stalled = true
      // Close the in-flight request too: the loop must leave `await` promptly.
      activeRequest?.abort()
      rejectStall?.(new TelegramPollerStallError(stallMs))
    }, period)
    // The daemon owns other handles; the watchdog alone must not keep it alive.
    stallCheck.unref?.()
  }

  async function callGetUpdates(params: Record<string, unknown>): Promise<TelegramUpdate[]> {
    const controller = new AbortController()
    activeRequest = controller
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    timer.unref?.()
    try {
      // A silent peer is aborted by the deadline; a hung loop is rejected by the
      // stall watchdog even when the request never returns.
      const result = await Promise.race([
        api.call<unknown>('getUpdates', params, undefined, {
          signal: controller.signal,
          // A flood wait comes back here as a 429 and is slept through by
          // pause(), with the watchdog off: a planned wait is not a hang.
          throwOnFloodWait: true,
        }),
        stallFailure,
      ])
      return Array.isArray(result) ? (result as TelegramUpdate[]) : []
    } finally {
      clearTimeout(timer)
      activeRequest = undefined
      // Any settled request, successful or not, is progress: a conflict or a
      // server error is a live peer, not a hang.
      if (!stopped && !stalled) armStall()
    }
  }

  async function start(): Promise<void> {
    if (running) return
    running = true
    let failures = 0
    let conflicts = 0
    armStall()

    try {
      while (!stopped) {
        const params: Record<string, unknown> = {
          allowed_updates: [...allowedUpdates],
          timeout: timeoutSec,
        }
        if (offset !== undefined) params.offset = offset

        let updates: TelegramUpdate[]
        try {
          updates = await callGetUpdates(params)
          failures = 0
          // A successful poll ends a conflict series, so a later 409 is logged
          // as a new series instead of disappearing into the old counter.
          conflicts = 0
        } catch (error) {
          if (stopped) return
          if (stalled || error instanceof TelegramPollerStallError) {
            throw error instanceof TelegramPollerStallError ? error : new TelegramPollerStallError(stallMs)
          }
          if (error instanceof TelegramApiError) {
            if (error.errorCode === 409) {
              // Another instance owns the token. Waiting is the only sane
              // answer; one journal line names the whole series.
              conflicts += 1
              failures = 0
              if (conflicts === 1) {
                journal(
                  'Telegram getUpdates 409: another instance is polling this bot; ' +
                    'retrying with a growing pause',
                )
              }
              await pause(conflictDelay(conflicts))
              continue
            }
            if (error.errorCode === 429) {
              // The client hands every flood wait of getUpdates to the poller,
              // and retry_after is Telegram's explicit answer. The wait runs
              // with the watchdog off, however long it is; never fatal.
              failures = 0
              await pause(error.retryAfterMs ?? retryDelay(1))
              continue
            }
            // 401 means the token is gone: restarting cannot fix it, the
            // daemon must stop with the configuration exit code. Other 4xx
            // answers are request errors and are fatal too. 5xx and errors
            // without an HTTP response (code 0) are retried.
            if (error.errorCode >= 400 && error.errorCode < 500) throw fatalError(error)
          }
          failures += 1
          await pause(retryDelay(failures))
          continue
        }

        if (stopped) return

        let handleFailed = false
        for (const update of updates) {
          if (stopped) return
          try {
            // A handler that never settles is a hang of the loop as much as a
            // silent request: the watchdog bounds this phase too.
            await Promise.race([handle(update), stallFailure])
          } catch (error) {
            if (stopped) return
            if (stalled || error instanceof TelegramPollerStallError) {
              throw error instanceof TelegramPollerStallError ? error : new TelegramPollerStallError(stallMs)
            }
            // durable-before-ack: leave the offset on the failed update and replay it.
            handleFailed = true
            break
          }
          if (typeof update.update_id === 'number') offset = update.update_id + 1
          // Each handled update is progress: a long batch is not a hang.
          if (!stopped && !stalled) armStall()
        }

        if (handleFailed) {
          failures += 1
          await pause(retryDelay(failures))
        }
      }
    } finally {
      running = false
      clearStall()
    }
  }

  return { start, stop }
}
