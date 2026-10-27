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

test('test_u1_a_row_keeps_the_disjoint_token_split_and_its_cost', () => {
  const store = track(openStore(dbPath()))
  store.usage.record({
    at: NOW - 1_000,
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 1_000_000,
    cacheReadTokens: 4_000_000,
    cacheWriteTokens: 0,
    outputTokens: 100_000,
    costUsd: 0.444,
  })

  const rows = store.usage.rows()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    at: NOW - 1_000,
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 1_000_000,
    cacheReadTokens: 4_000_000,
    cacheWriteTokens: 0,
    outputTokens: 100_000,
    costUsd: 0.444,
  })
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
})

test('test_u3_windows_split_today_seven_and_thirty_days_and_keep_the_cache_share', () => {
  const store = track(openStore(dbPath()))
  const record = (at: number, cacheRead: number, cost: number): void => {
    store.usage.record({
      at,
      sessionId: 'main',
      model: 'deepseek-flash',
      inputTokens: 1_000_000,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
      costUsd: cost,
    })
  }
  record(NOW - 1_000, 4_000_000, 0.444) // today
  record(NOW - 3 * DAY_MS, 4_000_000, 0.444) // inside 7 and 30
  record(NOW - 10 * DAY_MS, 4_000_000, 0.444) // inside 30 only
  record(NOW - 40 * DAY_MS, 4_000_000, 0.444) // outside every window

  const report = store.usage.report(NOW)
  expect(report.today.costUsd).toBeCloseTo(0.444, 9)
  expect(report.today.calls).toBe(1)
  expect(report.last7Days.costUsd).toBeCloseTo(0.888, 9)
  expect(report.last7Days.calls).toBe(2)
  expect(report.last30Days.costUsd).toBeCloseTo(1.332, 9)
  expect(report.last30Days.calls).toBe(3)
  // Every counted call has 4M cacheRead out of 1M + 4M input.
  expect(report.cacheReadShare).toBeCloseTo(0.8, 9)
})

test('test_u4_cache_share_is_null_without_input_tokens', () => {
  const store = track(openStore(dbPath()))
  store.usage.record({
    at: NOW - 1_000,
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  })
  const report = store.usage.report(NOW)
  expect(report.cacheReadShare).toBeNull()
  expect(report.today.costUsd).toBe(0)
  expect(report.today.calls).toBe(1)
})

test('test_u5_rows_and_reports_survive_close_and_reopen', () => {
  const first = openStore(dbPath())
  first.usage.record({
    at: NOW - 1_000,
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 1_000,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 0,
    outputTokens: 3_000,
    costUsd: 0.25,
  })
  first.close()

  const reopened = track(openStore(dbPath()))
  expect(reopened.usage.rows()).toHaveLength(1)
  expect(reopened.usage.report(NOW).last30Days.costUsd).toBe(0.25)
})

test('test_u7_summary_since_reads_the_session_window_without_writing_rows', () => {
  const store = track(openStore(dbPath()))
  const record = (at: number, unit: number, sessionId = 'main'): void => {
    store.usage.record({
      at,
      sessionId,
      model: unit === 2 ? 'model-without-a-price' : 'deepseek-flash',
      inputTokens: unit * 10,
      cacheReadTokens: unit * 20,
      cacheWriteTokens: unit * 30,
      outputTokens: unit * 40,
      costUsd: unit === 2 ? null : unit / 4,
    })
  }
  record(NOW - 1, 1) // before the session mark
  record(NOW, 2, 'subagent-after-reset') // child session at the mark, unpriced
  record(NOW + 1_000, 3) // inside the session

  const before = store.usage.rows()
  const session = store.usage.summarySince(NOW)
  expect(store.usage.rows()).toEqual(before)
  expect(session).toEqual({
    costUsd: 0.75,
    calls: 2,
    unpricedCalls: 1,
    inputTokens: 50,
    cacheReadTokens: 100,
    cacheWriteTokens: 150,
    outputTokens: 200,
  })
  expect(store.usage.summarySince(NOW + 10_000).calls).toBe(0)
})

test('test_u6_record_rejects_malformed_numbers_instead_of_storing_a_hole', () => {
  const store = track(openStore(dbPath()))
  const base = {
    sessionId: 'main',
    model: 'deepseek-flash',
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    costUsd: 0,
  }
  expect(() => store.usage.record({ ...base, sessionId: '' })).toThrow()
  expect(() => store.usage.record({ ...base, model: '' })).toThrow()
  expect(() => store.usage.record({ ...base, inputTokens: -1 })).toThrow()
  expect(() => store.usage.record({ ...base, outputTokens: 1.5 })).toThrow()
  expect(() => store.usage.record({ ...base, costUsd: Number.NaN })).toThrow()
  expect(store.usage.rows()).toHaveLength(0)
})
