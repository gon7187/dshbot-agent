// Money accounting of the `usage` table: one row per model call, an unknown
// price stored as SQL NULL (never zero), and window aggregates for /budget.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore } from '../src/index.js'

const DAY_MS = 86_400_000
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0)

let dir = ''
const opened: Array<ReturnType<typeof openStore>> = []

function dbPath(): string {
  return join(dir, 'state.db')
}

function track(store: ReturnType<typeof openStore>): ReturnType<typeof openStore> {
  opened.push(store)
  return store
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-usage-test-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('test_u2_an_unknown_price_is_null_and_never_summed_as_zero', () => {
  const store = track(openStore(dbPath()))
  store.usage.record({
    at: NOW - 1_000,
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    costUsd: 0.5,
  })
  store.usage.record({
    at: NOW - 2_000,
    sessionId: 'main',
    model: 'model-without-a-price',
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    costUsd: null,
  })

  // The stored value stays NULL: reading back must not turn it into a number.
  expect(store.usage.rows().map((row) => row.costUsd)).toEqual([0.5, null])

  const report = store.usage.report(NOW)
  expect(report.today.costUsd).toBe(0.5)
  expect(report.today.calls).toBe(2)
  expect(report.today.unpricedCalls).toBe(1)
  expect(report.last7Days.unpricedCalls).toBe(1)
  expect(report.last30Days.unpricedCalls).toBe(1)
  const input = { sessionId: 'main', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0 }
  for (const invalid of [{ ...input, inputTokens: -1 }, { ...input, costUsd: NaN }]) expect(() => store.usage.record(invalid)).toThrow()
  const reopened = track(openStore(dbPath()))
  expect(reopened.usage.rows().map((row) => row.costUsd)).toEqual([0.5, null])
})
