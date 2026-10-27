import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createTelegramApi } from './client.js'
import { createPoller, TelegramPollerStallError, type TelegramPoller } from './poller.js'

// The stall watchdog against planned waits and hung handlers, on the real
// client/poller boundary. A flood wait longer than the stall threshold, yet
// inside the client's default flood budget (5 min), is the case that used to
// be slept through inside the request while the watchdog counted.
// No external HTTP calls are made.
const STALL_MS = 2 * 60_000
const RETRY_AFTER_SEC = 200
const update = { update_id: 7 }
let poller: TelegramPoller | undefined
let completion: Promise<void> | undefined
let failure: unknown

beforeEach(() => {
  // The watchdog measures monotonic time, so performance.now() moves with the clock.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  failure = undefined
})

afterEach(async () => {
  poller?.stop()
  await completion
  poller = undefined
  completion = undefined
  vi.useRealTimers()
})

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function methodOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1)
}

function run(instance: TelegramPoller): void {
  poller = instance
  completion = instance.start().catch((error: unknown) => {
    failure = error
  })
}

test('test_c1_retry_after_longer_than_the_stall_threshold_is_a_planned_wait_not_a_hang', async () => {
  const requestedAt: number[] = []
  const delivered: unknown[] = []
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async (_url, init) => {
      if (init?.signal?.aborted === true) throw new Error('aborted')
      requestedAt.push(Date.now())
      if (requestedAt.length === 1) {
        return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: RETRY_AFTER_SEC } })
      }
      return reply(200, { ok: true, result: [update] })
    },
  })
  run(createPoller({ api, stallMs: STALL_MS, handle: (message) => { delivered.push(message); poller?.stop() } }))

  await vi.advanceTimersByTimeAsync(0)
  expect(requestedAt).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(RETRY_AFTER_SEC * 1000 - 1)
  expect(requestedAt, 'no request before parameters.retry_after').toHaveLength(1)
  await vi.advanceTimersByTimeAsync(STALL_MS)
  expect(failure, 'a flood wait must not end the daemon as a stall').toBeUndefined()
  expect(delivered, 'the update after the flood pause is handled').toEqual([update])
  expect(requestedAt[1]! - requestedAt[0]!).toBeGreaterThanOrEqual(RETRY_AFTER_SEC * 1000)
})

test('test_c1_a_send_flood_pause_holds_getUpdates_back_without_tripping_the_watchdog', async () => {
  const polledAt: number[] = []
  const delivered: unknown[] = []
  let sends = 0
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async (url) => {
      if (methodOf(String(url)) === 'sendMessage') {
        sends += 1
        if (sends === 1) {
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: RETRY_AFTER_SEC } })
        }
        return reply(200, { ok: true, result: { message_id: 1 } })
      }
      polledAt.push(Date.now())
      return reply(200, { ok: true, result: [update] })
    },
  })
  const startedAt = Date.now()
  // The send waits out its flood pause inside the client; the shared pause
  // holds every other call back, getUpdates included.
  const sent = api.call('sendMessage', { chat_id: 1, text: 'x' })
  await vi.advanceTimersByTimeAsync(0)
  expect(sends).toBe(1)
  run(createPoller({ api, stallMs: STALL_MS, handle: (message) => { delivered.push(message); poller?.stop() } }))

  await vi.advanceTimersByTimeAsync(RETRY_AFTER_SEC * 1000 + STALL_MS)
  await sent
  expect(failure, 'the shared flood pause is a planned wait of the poller').toBeUndefined()
  expect(delivered).toEqual([update])
  expect(polledAt[0]! - startedAt, 'getUpdates still respects the shared pause').toBeGreaterThanOrEqual(RETRY_AFTER_SEC * 1000)
})

test('test_c4_a_handler_that_never_settles_trips_the_watchdog', async () => {
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async () => reply(200, { ok: true, result: [update] }),
  })
  let handled = 0
  run(createPoller({
    api,
    stallMs: 1000,
    handle: () => {
      handled += 1
      // A stuck Bot API call inside the handler (answerCallbackQuery, say).
      return new Promise<void>(() => undefined)
    },
  }))

  await vi.advanceTimersByTimeAsync(2300)
  expect(handled).toBe(1)
  expect(failure, 'start() must reject so the daemon exits for a restart').toBeInstanceOf(TelegramPollerStallError)
})

test('test_c4_a_long_batch_of_handled_updates_is_progress_not_a_stall', async () => {
  const batch = [1, 2, 3, 4, 5].map((id) => ({ update_id: id }))
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async () => reply(200, { ok: true, result: batch }),
  })
  const delivered: unknown[] = []
  run(createPoller({
    api,
    stallMs: 1000,
    handle: async (message) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 600))
      delivered.push(message)
      if (delivered.length === batch.length) poller?.stop()
    },
  }))

  await vi.advanceTimersByTimeAsync(5000)
  expect(failure).toBeUndefined()
  expect(delivered).toEqual(batch)
})
