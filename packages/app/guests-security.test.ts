// Unit tests of the guest bookkeeping that backs the owner-visible counters, the
// daily spend limit and /unlock. The daemon-level behaviour is covered by the
// red-team suite; these checks keep the registry itself honest and fast.

import { expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'
import { GuestRegistry, utcDay } from './src/guests.js'

const DAY = utcDay(Date.UTC(2026, 9, 23, 12))
const CHAT = 5550001

test('test_registry_daily_stats_count_messages_rejections_and_spend_per_day', () => {
  const store = openStore(':memory:')
  try {
    const guests = new GuestRegistry(store)
    expect(guests.dailyStats(CHAT, DAY)).toEqual({ messages: 0, rejected: 0, costUsd: 0 })

    expect(guests.takeDaily(CHAT, DAY, 2)).toBe(true)
    expect(guests.takeDaily(CHAT, DAY, 2)).toBe(true)
    expect(guests.takeDaily(CHAT, DAY, 2)).toBe(false)
    expect(guests.dailyStats(CHAT, DAY).messages).toBe(2)

    expect(guests.recordRejected(CHAT, DAY)).toBe(1)
    expect(guests.recordRejected(CHAT, DAY)).toBe(2)
    expect(guests.dailyStats(CHAT, DAY).rejected).toBe(2)

    guests.addDailyCost(CHAT, DAY, 0.75)
    guests.addDailyCost(CHAT, DAY, 0.5)
    guests.addDailyCost(CHAT, DAY, Number.NaN)
    expect(guests.dailyStats(CHAT, DAY).costUsd).toBeCloseTo(1.25, 10)

    // Another day starts from zero, and another chat has its own counters.
    expect(guests.dailyStats(CHAT, utcDay(Date.UTC(2026, 9, 24, 12)))).toEqual({
      messages: 0,
      rejected: 0,
      costUsd: 0,
    })
    expect(guests.dailyStats(CHAT + 1, DAY)).toEqual({ messages: 0, rejected: 0, costUsd: 0 })
  } finally {
    store.close()
  }
})

test('test_registry_unlock_clears_only_the_wrong_code_lock_of_one_chat', () => {
  const store = openStore(':memory:')
  try {
    const guests = new GuestRegistry(store)
    for (let attempt = 0; attempt < 5; attempt += 1) guests.recordFailure(CHAT, Date.now())
    expect(guests.isLocked(CHAT)).toBe(true)
    guests.recordFailure(CHAT + 1, Date.now())
    guests.recordFailure(CHAT + 1, Date.now())

    expect(guests.unlock(CHAT)).toBe(true)
    expect(guests.isLocked(CHAT)).toBe(false)
    expect(guests.failures(CHAT + 1)).toBe(2)
    expect(guests.unlock(CHAT)).toBe(false)
  } finally {
    store.close()
  }
})
