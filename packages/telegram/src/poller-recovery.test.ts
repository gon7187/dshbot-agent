import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createTelegramApi } from './client.js'
import { createPoller, type TelegramPoller } from './poller.js'

// Exercise the real client/poller boundary: a 429 can reach the poller when
// the client's flood budget is exhausted. No external HTTP calls are made.
const update = { update_id: 41 }
let poller: TelegramPoller | undefined
let completion: Promise<void> | undefined
let failure: unknown

beforeEach(() => {
  vi.useFakeTimers()
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

test.each([2, 61])('test_c1_retry_after_%s_seconds_is_respected_even_beyond_the_client_flood_budget', async (seconds) => {
  const requestedAt: number[] = []
  const delivered: unknown[] = []
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    floodBudgetMs: 0,
    fetch: async () => {
      requestedAt.push(Date.now())
      if (requestedAt.length === 1) {
        return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: seconds } })
      }
      return reply(200, { ok: true, result: [update] })
    },
  })
  poller = createPoller({ api, handle: (message) => { delivered.push(message); poller?.stop() } })
  completion = poller.start().catch((error: unknown) => { failure = error })

  await vi.advanceTimersByTimeAsync(0)
  expect(requestedAt).toHaveLength(1)
  expect(failure, '429 must leave the polling loop alive').toBeUndefined()
  await vi.advanceTimersByTimeAsync(seconds * 1000 - 1)
  expect(requestedAt, 'no request before parameters.retry_after').toHaveLength(1)
  await vi.advanceTimersByTimeAsync(60_001)
  expect(failure).toBeUndefined()
  expect(delivered, 'the update after the flood pause is handled').toEqual([update])
  expect(requestedAt[1]! - requestedAt[0]!).toBeGreaterThanOrEqual(seconds * 1000)
})

test('test_c3_server_errors_and_broken_connections_retry_with_a_pause_and_deliver_the_next_update', async () => {
  const requestedAt: number[] = []
  const delivered: unknown[] = []
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async () => {
      requestedAt.push(Date.now())
      if (requestedAt.length === 1) return reply(503, { ok: false, error_code: 503, description: 'Unavailable' })
      if (requestedAt.length === 2) throw new TypeError('connection reset by peer')
      return reply(200, { ok: true, result: [update] })
    },
  })
  poller = createPoller({ api, handle: (message) => { delivered.push(message); poller?.stop() } })
  completion = poller.start().catch((error: unknown) => { failure = error })
  await vi.advanceTimersByTimeAsync(0)
  expect(requestedAt).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(requestedAt, 'server errors must not cause a busy loop').toHaveLength(1)
  await vi.advanceTimersByTimeAsync(120_000)

  expect(failure).toBeUndefined()
  expect(requestedAt).toHaveLength(3)
  expect(requestedAt[1]! - requestedAt[0]!).toBeGreaterThan(0)
  expect(requestedAt[2]! - requestedAt[1]!).toBeGreaterThan(0)
  expect(delivered).toEqual([update])
})

test('test_c2_conflict_backoff_increases_is_capped_at_sixty_seconds_and_recovers', async () => {
  const requestedAt: number[] = []
  const delivered: unknown[] = []
  const api = createTelegramApi({
    token: 'synthetic-test-token',
    fetch: async () => {
      requestedAt.push(Date.now())
      if (requestedAt.length <= 9) return reply(409, { ok: false, error_code: 409, description: 'Conflict: another getUpdates request' })
      return reply(200, { ok: true, result: [update] })
    },
  })
  poller = createPoller({ api, handle: (message) => { delivered.push(message); poller?.stop() } })
  completion = poller.start().catch((error: unknown) => { failure = error })
  await vi.advanceTimersByTimeAsync(0)
  expect(failure, 'a second instance must not terminate this polling loop').toBeUndefined()
  await vi.advanceTimersByTimeAsync(9 * 60_000)

  expect(failure).toBeUndefined()
  expect(requestedAt).toHaveLength(10)
  const pauses = requestedAt.slice(1).map((at, index) => at - requestedAt[index]!)
  expect(pauses[0]).toBeGreaterThan(0)
  expect(pauses[1]).toBeGreaterThan(pauses[0]!)
  expect(pauses[2]).toBeGreaterThan(pauses[1]!)
  for (let index = 1; index < pauses.length; index += 1) expect(pauses[index]).toBeGreaterThanOrEqual(pauses[index - 1]!)
  for (const pause of pauses) expect(pause).toBeLessThanOrEqual(60_000)
  expect(delivered).toEqual([update])
})
