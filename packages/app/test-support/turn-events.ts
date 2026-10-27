/**
 * Client side of the `DSHBOT_TEST_TURN_EVENTS` seam of the daemon: with the
 * variable set to `1` the daemon prints one `test:turn-complete` journal line
 * after a turn and every Telegram request of that turn are done. A harness that
 * waits for the line sees the whole answer of the turn at once and does not
 * need a quiet window after every step.
 *
 * The line is read from the captured stdout/stderr of the daemon child (the
 * same buffers the harness already keeps for failure output), so a harness only
 * has to enable the variable and count the matching lines.
 */
export const TURN_EVENTS_ENV = 'DSHBOT_TEST_TURN_EVENTS'

/** Environment fragment that turns the seam on for a spawned daemon. */
export const TURN_EVENTS_ON: Record<string, string> = { [TURN_EVENTS_ENV]: '1' }

export const TURN_COMPLETE_RE = /^(?:\[dshbot\] )?test:turn-complete(?:\s|$)/
export const UPDATE_COMPLETE_RE = /^(?:\[dshbot\] )?test:update-complete(?:\s|$)/

/** A spawned daemon whose journal the harness already collects. */
export interface JournalDaemon {
  stdout: string
  stderr: string
  exited: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** How many turns the daemon already reported as complete. */
export function turnCompletions(d: JournalDaemon): number {
  let count = 0
  for (const stream of [d.stdout, d.stderr]) {
    for (const line of stream.split('\n')) {
      if (TURN_COMPLETE_RE.test(line.trim())) count += 1
    }
  }
  return count
}

/**
 * Waits until the daemon reported one turn more than `previous`. Throws with
 * the tail of the journal instead of hanging until the test timeout.
 */
export async function waitForTurnComplete(
  d: JournalDaemon,
  previous: number,
  what: string,
  timeoutMs = 45_000,
): Promise<void> {
  const started = Date.now()
  while (turnCompletions(d) <= previous) {
    if (d.exited || Date.now() - started >= timeoutMs) break
    await sleep(10)
  }
  if (turnCompletions(d) > previous) return
  const tail = `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
  throw new Error(`timed out waiting for the end of ${what}\n${tail}`)
}

/** How many times the daemon reported the worker done with `updateId`. */
export function updateCompletions(d: JournalDaemon, updateId: number): number {
  let count = 0
  for (const stream of [d.stdout, d.stderr]) {
    for (const line of stream.split('\n')) {
      const trimmed = line.trim()
      if (!UPDATE_COMPLETE_RE.test(trimmed)) continue
      if (Number(/\bupdate_id=(\d+)\b/.exec(trimmed)?.[1]) === updateId) count += 1
    }
  }
  return count
}

/**
 * Waits until the worker reports that it is done with `updateId`. Unlike the
 * next `getUpdates` poll this is a proof of processing: an unaddressed group
 * message or a message of a foreign chat opens no turn, yet its row is handled
 * by the worker, and the event is printed after every send of that handling.
 */
export async function waitForUpdateComplete(
  d: JournalDaemon,
  updateId: number,
  what: string,
  timeoutMs = 45_000,
): Promise<void> {
  const started = Date.now()
  while (updateCompletions(d, updateId) === 0) {
    if (d.exited || Date.now() - started >= timeoutMs) break
    await sleep(10)
  }
  if (updateCompletions(d, updateId) > 0) return
  const tail = `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
  throw new Error(`timed out waiting for the end of ${what} (update_id=${updateId})\n${tail}`)
}
