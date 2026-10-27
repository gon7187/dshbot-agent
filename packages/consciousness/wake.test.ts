import { expect, test } from 'vitest'
import { openStore } from '../store/src/index.js'
import {
  buildWakeWellbeing,
  clampInterval,
  createSetNextWakeupTool,
  createWakeScheduler,
  createWakeUsageStore,
  DEFAULT_WAKE_INTERVAL_MIN,
  DEFAULT_WAKE_JITTER,
  isEveningReflectionDue,
  isFreeMinute,
  isQuietAt,
  MAINTENANCE_CHORES,
  maintenanceChore,
  markEveningReflection,
  MAX_WAKE_INTERVAL_MIN,
  MIN_WAKE_INTERVAL_MIN,
  normalizeWakeJitter,
  ownerDayKey,
  ownerInitiativeHold,
  parseAutonomy,
  parseFreeWakeChance,
  parseProactivePerDay,
  parseQuietHours,
  parseWakeJitter,
  PROACTIVE_COOLDOWN_MS,
  readMaintenanceChorePosition,
  readWakeProactiveLedger,
  saveWakeProactiveLedger,
  SILENCE_AFTER_MS,
  silenceNote,
  takeEveningReflection,
  takeMaintenanceChore,
  WAKE_EVENING_KV_KEY,
  WAKE_MAINTENANCE_KV_KEY,
  wakePrompt,
  wakeSituationNotes,
  type WakeProactiveStorage,
  type WakeTurnOutcome,
} from './src/index.js'

const HOUR = 3_600_000
const TZ = 'Asia/Yekaterinburg'

/**
 * A manual clock for the timer seam: no fake globals, so these tests are
 * independent of the daemon preload used by the process-level wake tests.
 */
function manualClock() {
  let time = 0
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimer(callback: () => void, delayMs: number): unknown {
      sequence += 1
      timers.set(sequence, { at: time + delayMs, callback })
      return sequence
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number)
    },
    async advance(ms: number): Promise<void> {
      time += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > time) continue
        timers.delete(id)
        timer.callback()
      }
      // fire() awaits runTurn; let its continuation arm the next alarm.
      for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve))
    },
    pending: () => timers.size,
  }
}

const MINUTE = 60_000

test('the interval is clamped to the owner bounds', () => {
  expect(clampInterval(5)).toBe(MIN_WAKE_INTERVAL_MIN)
  expect(clampInterval(1000)).toBe(MAX_WAKE_INTERVAL_MIN)
  expect(clampInterval(60)).toBe(60)
  expect(clampInterval(Number.NaN)).toBe(MIN_WAKE_INTERVAL_MIN)
})

test('the first alarm comes after the default interval', async () => {
  const clock = manualClock()
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      return 'ok'
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  expect(scheduler.intervalMinutes()).toBe(DEFAULT_WAKE_INTERVAL_MIN)
  expect(scheduler.nextWakeAt()).toBe(DEFAULT_WAKE_INTERVAL_MIN * MINUTE)

  await clock.advance((DEFAULT_WAKE_INTERVAL_MIN - 1) * MINUTE)
  expect(turns).toBe(0)
  await clock.advance(MINUTE)
  expect(turns).toBe(1)
  scheduler.stop()
})

test('a successful turn without a call keeps the previous interval', async () => {
  const clock = manualClock()
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      return 'ok' satisfies WakeTurnOutcome
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  expect(scheduler.setNextInterval(20)).toBe(20)
  await clock.advance(20 * MINUTE)
  expect(turns).toBe(1)
  expect(scheduler.intervalMinutes()).toBe(20)
  await clock.advance(19 * MINUTE)
  expect(turns).toBe(1)
  await clock.advance(MINUTE)
  expect(turns).toBe(2)
  scheduler.stop()
})

test('a call during the turn applies after it; the next alarm counts from the end', async () => {
  const clock = manualClock()
  let scheduler: ReturnType<typeof createWakeScheduler>
  let turns = 0
  scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      scheduler.setNextInterval(30)
      return 'ok'
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  scheduler.setNextInterval(15)
  await clock.advance(15 * MINUTE)
  expect(turns).toBe(1)
  expect(scheduler.intervalMinutes()).toBe(30)
  await clock.advance(29 * MINUTE)
  expect(turns).toBe(1)
  await clock.advance(MINUTE)
  expect(turns).toBe(2)
  scheduler.stop()
})

test('a failed turn doubles the interval and stops at the upper bound', async () => {
  const clock = manualClock()
  let outcome: WakeTurnOutcome = 'failed'
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      return outcome
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  scheduler.setNextInterval(15)

  await clock.advance(15 * MINUTE)
  expect(turns).toBe(1)
  expect(scheduler.intervalMinutes()).toBe(30)
  await clock.advance(29 * MINUTE)
  expect(turns).toBe(1)
  await clock.advance(MINUTE)
  expect(turns).toBe(2)
  expect(scheduler.intervalMinutes()).toBe(60)

  outcome = 'ok'
  scheduler.setNextInterval(200)
  await clock.advance(200 * MINUTE)
  expect(turns).toBe(3)
  expect(scheduler.intervalMinutes()).toBe(200)
  outcome = 'failed'
  await clock.advance(200 * MINUTE)
  expect(turns).toBe(4)
  expect(scheduler.intervalMinutes()).toBe(MAX_WAKE_INTERVAL_MIN)
  await clock.advance(MAX_WAKE_INTERVAL_MIN * MINUTE)
  expect(turns).toBe(5)
  expect(scheduler.intervalMinutes()).toBe(MAX_WAKE_INTERVAL_MIN)
  scheduler.stop()
})

test('a thrown turn counts as failed', async () => {
  const clock = manualClock()
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      throw new Error('boom')
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: () => undefined,
  })
  scheduler.start()
  scheduler.setNextInterval(15)
  await clock.advance(15 * MINUTE)
  expect(turns).toBe(1)
  expect(scheduler.intervalMinutes()).toBe(30)
  scheduler.stop()
})

test('stop disarms the alarm', async () => {
  const clock = manualClock()
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      return 'ok'
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  scheduler.stop()
  await clock.advance(10 * 60 * MINUTE)
  expect(turns).toBe(0)
  expect(clock.pending()).toBe(0)
})

test('a clock jump far past the alarm does not replay a stale wake-up', async () => {
  const clock = manualClock()
  let turns = 0
  const scheduler = createWakeScheduler({
    runTurn: () => {
      turns += 1
      return 'ok'
    },
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  await clock.advance(24 * 60 * MINUTE)
  expect(turns, 'a day-long suspend does not fire the stale alarm').toBe(0)
  expect(scheduler.nextWakeAt(), 'the next alarm counts from now').toBe(clock.now() + scheduler.intervalMinutes() * MINUTE)
  scheduler.stop()
})

test('autonomy defaults to act and recognizes the three levels', () => {
  expect(parseAutonomy(undefined)).toBe('act')
  expect(parseAutonomy('')).toBe('act')
  expect(parseAutonomy('nonsense')).toBe('act')
  expect(parseAutonomy('observe')).toBe('observe')
  expect(parseAutonomy(' FULL ')).toBe('full')
  expect(parseAutonomy('Act')).toBe('act')
})

test('the wake prompt is the bot\'s own turn, a pause is legitimate, no fake activity', () => {
  const prompt = wakePrompt({ autonomy: 'act', intervalMinutes: 60 })
  expect(prompt).toMatch(/никто не просил/i)
  expect(prompt).toMatch(/пауз/i)
  expect(prompt).toMatch(/не изобретай активность/i)
  expect(prompt).toContain('[SILENT]')
  expect(prompt).toContain('set_next_wakeup')
  expect(prompt).toMatch(/15–240/)
  expect(prompt).not.toMatch(/^own-/)
})

test('observe prompt forbids task and speaking to the owner; act/full allow both', () => {
  expect(wakePrompt({ autonomy: 'observe', intervalMinutes: 60 })).toMatch(/task.*отклон/i)
  expect(wakePrompt({ autonomy: 'observe', intervalMinutes: 60 })).toMatch(/observe/)
  expect(wakePrompt({ autonomy: 'act', intervalMinutes: 60 })).not.toMatch(/уровень автономии — observe/i)
  expect(wakePrompt({ autonomy: 'full', intervalMinutes: 60 })).toMatch(/full/)
})

test('set_next_wakeup clamps and answers without an error', async () => {
  const clock = manualClock()
  const scheduler = createWakeScheduler({
    runTurn: () => 'ok',
    now: clock.now,
    jitter: 0,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  scheduler.start()
  const tool = createSetNextWakeupTool(scheduler)
  expect(tool.name).toBe('set_next_wakeup')
  const applied = await tool.execute({ minutes: 1000 })
  expect(String(applied)).toContain('240')
  expect(scheduler.intervalMinutes()).toBe(MAX_WAKE_INTERVAL_MIN)
  const low = await tool.execute({ minutes: 5 })
  expect(String(low)).toContain('15')
  expect(scheduler.intervalMinutes()).toBe(MIN_WAKE_INTERVAL_MIN)
  await expect(async () => tool.execute({ minutes: 'soon' })).rejects.toThrow()
  scheduler.stop()
})

test('the prompt invites the bot to write first, names the occasions and keeps the pause legitimate', () => {
  const prompt = wakePrompt({ autonomy: 'act', intervalMinutes: 60 }).toLowerCase()
  expect(prompt).toMatch(/пауз/)
  expect(prompt).toMatch(/легитимн|допустим/)
  expect(prompt).toContain('первым')
  expect(prompt).toContain('нормальн')
  expect(prompt).toContain('память')
  expect(prompt).toContain('расписания')
  expect(prompt).toContain('дела')
  expect(prompt).toContain('идея')
  expect(prompt).toContain('вопрос')
  expect(prompt).toContain('напоминание')
  expect(prompt).toContain('голос')
  expect(prompt).toMatch(/характер|character\.md/)
})

test('quiet hours default to 23-9, accept an empty opt-out and a custom window', () => {
  expect(parseQuietHours(undefined)).toEqual({ from: 23, to: 9 })
  expect(parseQuietHours('')).toBeNull()
  expect(parseQuietHours('1-6')).toEqual({ from: 1, to: 6 })
  expect(parseQuietHours('nonsense')).toEqual({ from: 23, to: 9 })

  const night = Date.UTC(2026, 0, 15, 20, 0) // 01:00 in Yekaterinburg
  const day = Date.UTC(2026, 0, 15, 7, 0) // 12:00 in Yekaterinburg
  expect(isQuietAt(night, parseQuietHours(undefined), TZ)).toBe(true)
  expect(isQuietAt(day, parseQuietHours(undefined), TZ)).toBe(false)
  expect(isQuietAt(Date.UTC(2026, 0, 14, 22, 0), parseQuietHours('1-6'), TZ)).toBe(true) // 03:00
  expect(isQuietAt(Date.UTC(2026, 0, 15, 18, 30), parseQuietHours('1-6'), TZ)).toBe(false) // 23:30
  expect(isQuietAt(night, parseQuietHours(''), TZ)).toBe(false)
})

test('the prompt tells about the night inside quiet hours and about the spent daily limit', () => {
  const at = Date.UTC(2026, 0, 15, 20, 0)
  const night = wakePrompt({ autonomy: 'act', intervalMinutes: 60, now: at, timeZone: TZ, quiet: true })
  const day = wakePrompt({ autonomy: 'act', intervalMinutes: 60, now: at, timeZone: TZ, quiet: false })
  expect(night).toContain('ночь')
  expect(day).not.toContain('ночь')

  const spent = wakePrompt({
    autonomy: 'act',
    intervalMinutes: 60,
    now: at,
    timeZone: TZ,
    proactivePerDay: 4,
    proactiveToday: 4,
  })
  expect(spent).toMatch(/лимит/i)
  const free = wakePrompt({ autonomy: 'act', intervalMinutes: 60, now: at, timeZone: TZ, proactivePerDay: 4, proactiveToday: 3 })
  expect(free).not.toMatch(/лимит/i)

  expect(wakePrompt({ autonomy: 'act', intervalMinutes: 60, proactivePerDay: 0 })).toMatch(/лимит/i)
  expect(parseProactivePerDay(undefined)).toBe(6)
  expect(parseProactivePerDay('')).toBe(6)
  expect(parseProactivePerDay('0')).toBe(0)
  expect(() => parseProactivePerDay('-1')).toThrow()
  expect(() => parseProactivePerDay('4.5')).toThrow()
})

test('the silence note needs six silent wake-ups and over twenty hours without an initiative', () => {
  const now = Date.UTC(2026, 0, 15, 20, 0)
  expect(silenceNote({ silentStreak: 5, lastProactiveAt: now - 21 * HOUR, nowMs: now, timeZone: TZ })).toBeUndefined()
  const note = silenceNote({
    silentStreak: 6,
    lastProactiveAt: now - 21 * HOUR,
    nowMs: now,
    timeZone: TZ,
  })
  expect(note).toMatch(/молч/i)
  expect(note).toMatch(/\b6\b/)
  expect(note).toContain('21 ч')
  expect(silenceNote({ silentStreak: 6, lastProactiveAt: now - 3 * HOUR, nowMs: now, timeZone: TZ })).toBeUndefined()
  expect(silenceNote({ silentStreak: 6, nowMs: now, timeZone: TZ })).toMatch(/\b6\b/)
  expect(SILENCE_AFTER_MS).toBe(20 * HOUR)

  const prompt = wakePrompt({
    autonomy: 'act',
    intervalMinutes: 60,
    now,
    timeZone: TZ,
    silentWakeups: 6,
    lastProactiveAt: now - 21 * HOUR,
  })
  expect(prompt.split('\n').some((line) => /молч/i.test(line) && /\b6\b/.test(line))).toBe(true)
  const afterDelivery = wakePrompt({
    autonomy: 'act',
    intervalMinutes: 60,
    now,
    timeZone: TZ,
    silentWakeups: 0,
    lastProactiveAt: now - HOUR,
  })
  expect(afterDelivery.split('\n').some((line) => /молч/i.test(line))).toBe(false)
})

test('the proactive ledger survives a restart and resets the daily counter on a new owner day', () => {
  const values = new Map<string, string>()
  const kv: WakeProactiveStorage = {
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
  }
  const at = Date.UTC(2026, 0, 15, 7, 0) // 12:00 in Yekaterinburg
  expect(ownerDayKey(at, TZ)).toBe('2026-01-15')
  const empty = readWakeProactiveLedger(kv, at, TZ)
  expect(empty).toEqual({ silentStreak: 0, day: '2026-01-15', deliveredToday: 0 })

  saveWakeProactiveLedger(kv, { silentStreak: 5, lastProactiveAt: at - 21 * HOUR, day: '2026-01-15', deliveredToday: 4 })
  const restarted = readWakeProactiveLedger(kv, at, TZ)
  expect(restarted.silentStreak).toBe(5)
  expect(restarted.deliveredToday).toBe(4)
  expect(restarted.lastProactiveAt).toBe(at - 21 * HOUR)

  const nextDay = readWakeProactiveLedger(kv, at + 24 * HOUR, TZ)
  expect(nextDay.deliveredToday).toBe(0)
  expect(nextDay.day).toBe('2026-01-16')
  expect(nextDay.silentStreak).toBe(5)
})

test('a malformed proactive ledger does not break the wake-up', () => {
  const kv: WakeProactiveStorage = { get: () => '{not json', set: () => undefined }
  expect(readWakeProactiveLedger(kv, Date.UTC(2026, 0, 15, 7, 0), TZ)).toEqual({
    silentStreak: 0,
    day: '2026-01-15',
    deliveredToday: 0,
  })
})

test('the situation notes can ride apart from the stable prompt text', () => {
  const at = Date.UTC(2026, 0, 15, 20, 0) // 01:00 in Yekaterinburg
  const options = {
    autonomy: 'act' as const,
    intervalMinutes: 60,
    now: at,
    timeZone: TZ,
    quiet: true,
    proactivePerDay: 4,
    proactiveToday: 4,
  }
  const stable = wakePrompt({ ...options, separateSituation: true })
  expect(stable).not.toContain('ночь')
  expect(stable).not.toMatch(/лимит/i)
  const notes = wakeSituationNotes(options).join('\n')
  expect(notes).toContain('ночь')
  expect(notes).toMatch(/лимит/i)
})

test('the stable wake prompt stays identical after set_next_wakeup changes the interval', async () => {
  const scheduler = createWakeScheduler({ runTurn: () => 'ok', jitter: 0 })
  const prompt = () => wakePrompt({
    autonomy: 'act',
    intervalMinutes: scheduler.intervalMinutes(),
    separateSituation: true,
  })
  const before = prompt()
  expect(scheduler.intervalMinutes()).toBe(60)
  await createSetNextWakeupTool(scheduler).execute({ minutes: 120 })
  expect(scheduler.intervalMinutes()).toBe(120)
  expect(prompt()).toBe(before)
})

test('the wellbeing block is silent at the boundary values and names every deviation otherwise', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0)
  const usage = { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }

  // exactly 72 hours, exactly 200 characters, exactly 50 characters of notes and
  // exactly 80% of the limit are all inside the norm
  const healthy = buildWakeWellbeing({
    now,
    identityText: 'x'.repeat(200),
    identityMtimeMs: now - 72 * HOUR,
    scratchpadText: 'x'.repeat(50),
    scratchpadLimit: 3_000,
    wakeUsage: [],
  })
  expect(healthy).toBe('Самочувствие: в норме')

  const dirty = buildWakeWellbeing({
    now,
    identityText: 'short',
    identityMtimeMs: now - 73 * HOUR,
    scratchpadText: 'x'.repeat(2_401),
    scratchpadLimit: 3_000,
    wakeUsage: [{ at: now - HOUR, ...usage }, { at: now - 25 * HOUR, ...usage }],
  })
  expect(dirty).toContain('identity не обновлялся 73 ч')
  expect(dirty).toContain('identity тонкий: 5 символов')
  expect(dirty).toContain('блокнот почти полон: 2401 из 3000')
  expect(dirty).toContain('knowledge')
  expect(dirty).toContain('journal')
  expect(dirty, 'only the row of the last 24 hours is counted').toContain('пробуждений за 24 ч: 1, токенов: 15')
  expect([...dirty].length).toBeLessThanOrEqual(600)
})

test('the spending line rides alone when the memory has no deviations', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0)
  const block = buildWakeWellbeing({
    now,
    identityText: 'x'.repeat(200),
    identityMtimeMs: now - HOUR,
    scratchpadText: 'x'.repeat(100),
    wakeUsage: [
      { at: now - HOUR, inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 234 },
    ],
  })
  expect(block.split('\n')).toEqual(['Самочувствие:', '- пробуждений за 24 ч: 1, токенов: 1234'])
})

test.each(['\n', ' \t\n'])('wellbeing counts the scratchpad whitespace tail %j against its limit', (tail) => {
  const input = {
    now: Date.UTC(2026, 0, 15, 12, 0),
    identityText: 'x'.repeat(200),
    scratchpadText: 'x'.repeat(2_400),
    scratchpadLimit: 3_000,
  }
  expect(buildWakeWellbeing(input)).toBe('Самочувствие: в норме')
  const text = input.scratchpadText + tail
  expect(buildWakeWellbeing({ ...input, scratchpadText: text })).toContain(
    `блокнот почти полон: ${[...text].length} из 3000, вынеси устойчивое в knowledge или journal`,
  )
})

test('wellbeing counts one wake-up across multiple model calls and keeps all their tokens', () => {
  const store = openStore(':memory:')
  try {
    const now = Date.UTC(2026, 0, 15, 12, 0)
    const ledger = createWakeUsageStore(store)
    const calls = [
      { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 1 },
      { inputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 2, outputTokens: 3 },
    ]
    ledger.record(calls, { at: now - HOUR })
    const input = { now, identityText: 'x'.repeat(200), scratchpadText: 'x'.repeat(100) }
    expect(buildWakeWellbeing({ ...input, wakeUsage: ledger.rows() })).toContain(
      'пробуждений за 24 ч: 1, токенов: 341',
    )
    // Recreating the ledger preserves the stored turn identity. A different
    // wake-up must remain distinct even with the same session and timestamp.
    const reopened = createWakeUsageStore(store)
    expect(reopened.rows()).toEqual(ledger.rows())
    reopened.record([calls[0]!], { at: now - HOUR })
    expect(buildWakeWellbeing({ ...input, wakeUsage: reopened.rows() })).toContain(
      'пробуждений за 24 ч: 2, токенов: 457',
    )
  } finally {
    store.close()
  }
})

test('the usage ledger migrates legacy model calls as one wake-up per recorded batch', () => {  const store = openStore(':memory:')
  try {
    const now = Date.UTC(2026, 0, 15, 12, 0)
    store.migrate('consciousness-wake-usage', [
      `CREATE TABLE wake_usage (
        id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, label TEXT NOT NULL,
        session_id TEXT NOT NULL, input_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL
      )`,
      'CREATE INDEX wake_usage_ts_idx ON wake_usage (ts)',
    ])
    const insert = store.db.prepare('INSERT INTO wake_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(1, now - HOUR, 'wake', 'main', 100, 10, 5, 1)
    insert.run(2, now - HOUR, 'wake', 'main', 200, 20, 2, 3)
    insert.run(3, now - 2 * HOUR, 'wake', 'main', 10, 0, 0, 1)
    const ledger = createWakeUsageStore(store)
    expect(buildWakeWellbeing({
      now,
      identityText: 'x'.repeat(200),
      scratchpadText: 'x'.repeat(100),
      wakeUsage: ledger.rows(),
    })).toContain('пробуждений за 24 ч: 2, токенов: 352')
    // Applying the migration again is safe and does not regroup history.
    expect(createWakeUsageStore(store).rows()).toEqual(ledger.rows())
  } finally {
    store.close()
  }
})

function memoryStorage(): WakeProactiveStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
  }
}

test('the jitter is a relative spread around the base and 0 keeps the exact interval', () => {
  expect(DEFAULT_WAKE_JITTER).toBe(0.3)
  expect(parseWakeJitter(undefined)).toBe(0.3)
  expect(parseWakeJitter('')).toBe(0.3)
  expect(parseWakeJitter('0')).toBe(0)
  expect(parseWakeJitter('0.5')).toBe(0.5)
  expect(() => parseWakeJitter('1.5')).toThrow()
  expect(() => parseWakeJitter('-0.1')).toThrow()
  expect(() => parseWakeJitter('soon')).toThrow()
  expect(normalizeWakeJitter(undefined)).toBe(0.3)
  expect(normalizeWakeJitter(7)).toBe(1)
})

test('the scheduler draws the alarm inside the jitter edges and clamps to the owner bounds', async () => {
  const clock = manualClock()
  const draws = [0, 1, 0.5]
  let draw = 0
  const scheduler = createWakeScheduler({
    runTurn: () => 'ok',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    intervalMinutes: 60,
    jitter: 0.3,
    random: () => draws[draw++] ?? 0.5,
  })
  scheduler.start()
  // ±30% around 60: the lowest and the highest edge, then the middle.
  expect(scheduler.nextWakeAt()).toBe(42 * MINUTE)
  await clock.advance(42 * MINUTE)
  expect(scheduler.nextWakeAt()).toBe(clock.now() + 78 * MINUTE)
  await clock.advance(78 * MINUTE)
  expect(scheduler.nextWakeAt()).toBe(clock.now() + 60 * MINUTE)
  scheduler.stop()
})

test('the jitter never crosses 15 or 240 minutes', async () => {
  const clock = manualClock()
  let draw = 0
  const scheduler = createWakeScheduler({
    runTurn: () => 'ok',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    intervalMinutes: 15,
    jitter: 0.5,
    random: () => (draw++ === 0 ? 0 : 1),
  })
  scheduler.start()
  expect(scheduler.nextWakeAt()).toBe(clock.now() + 15 * MINUTE)
  await clock.advance(15 * MINUTE)
  expect(scheduler.nextWakeAt()).toBe(clock.now() + 23 * MINUTE)
  scheduler.stop()

  const upper = createWakeScheduler({
    runTurn: () => 'ok',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    intervalMinutes: 240,
    jitter: 0.5,
    random: () => 1,
  })
  upper.start()
  expect(upper.nextWakeAt()).toBe(clock.now() + 240 * MINUTE)
  upper.stop()
})

test('the free minute chance is exact at 0 and 1 and defaults to a quarter', () => {
  expect(parseFreeWakeChance(undefined)).toBe(0.25)
  expect(parseFreeWakeChance('')).toBe(0.25)
  expect(parseFreeWakeChance('1')).toBe(1)
  expect(parseFreeWakeChance('0')).toBe(0)
  expect(() => parseFreeWakeChance('2')).toThrow()
  expect(isFreeMinute(0, () => 0)).toBe(false)
  expect(isFreeMinute(1, () => 1)).toBe(true)
  expect(isFreeMinute(0.25, () => 0.2)).toBe(true)
  expect(isFreeMinute(0.25, () => 0.3)).toBe(false)
})

test('the anti-duplicate guard holds while the owner waits or the bot has just written', () => {
  const now = 100 * MINUTE
  expect(ownerInitiativeHold({ now, lastOwnerMessageAt: now - MINUTE, lastBotMessageAt: now - 2 * MINUTE })).toBe(
    'владелец ждёт ответа',
  )
  expect(ownerInitiativeHold({ now, lastBotMessageAt: now - 5 * MINUTE })).toContain('10 минут')
  expect(ownerInitiativeHold({ now, lastBotMessageAt: now - PROACTIVE_COOLDOWN_MS })).toBeUndefined()
  expect(
    ownerInitiativeHold({ now, lastOwnerMessageAt: now - 12 * MINUTE, lastBotMessageAt: now - 11 * MINUTE }),
  ).toBeUndefined()
  expect(ownerInitiativeHold({ now })).toBeUndefined()
})

test('the maintenance chores cycle and the position survives the storage between two takes', () => {
  const kv = memoryStorage()
  expect(MAINTENANCE_CHORES).toHaveLength(4)
  const first = takeMaintenanceChore(kv)
  const second = takeMaintenanceChore(kv)
  const third = takeMaintenanceChore(kv)
  const fourth = takeMaintenanceChore(kv)
  expect([first, second, third, fourth]).toEqual([...MAINTENANCE_CHORES])
  expect(takeMaintenanceChore(kv)).toBe(MAINTENANCE_CHORES[0])
  expect(readMaintenanceChorePosition(kv)).toBe(1)
  expect(kv.values.get(WAKE_MAINTENANCE_KV_KEY)).toBe('1')
  // A fresh object over the same values is a restart: the circle goes on.
  const restarted = memoryStorage()
  restarted.values.set(WAKE_MAINTENANCE_KV_KEY, kv.values.get(WAKE_MAINTENANCE_KV_KEY) as string)
  expect(takeMaintenanceChore(restarted)).toBe(MAINTENANCE_CHORES[1])
  expect(maintenanceChore(-1)).toBe(MAINTENANCE_CHORES[3])
})

test('the prompt of a free minute asks to look back and to choose the owner or the scratchpad', () => {
  const plain = wakePrompt({ autonomy: 'act', intervalMinutes: 60 })
  expect(plain).not.toMatch(/задел/i)
  expect(plain).not.toContain('Свободная минута')
  const free = wakePrompt({ autonomy: 'act', intervalMinutes: 60, freeMinute: true })
  expect(free).toMatch(/задел/i)
  expect(free).toMatch(/порадова|обрадова|радост/i)
  expect(free).toMatch(/сутк|24\s*(?:ч|час)/i)
  expect(free).toMatch(/владельц/i)
  expect(free).toContain('блокнот')
  expect(free).toContain('голос')
  expect(free).toContain('[SILENT]')
  expect(free).toMatch(/не\s+(?:изображай|изобретай|имитируй)\s+активност/i)
  expect(free).toMatch(/сомнева[\s\S]{0,200}блокнот[\s\S]{0,100}не\s+в\s+чат/i)
})

test('the evening reflection is due once per owner day at 19:00 outside quiet hours and survives storage', () => {
  const kv = memoryStorage()
  const evening = Date.UTC(2026, 0, 15, 14, 0) // 19:00 in Yekaterinburg
  const before = evening - 15 * MINUTE
  expect(isEveningReflectionDue({ nowMs: before, timeZone: TZ, quiet: false, kv })).toBe(false)
  expect(isEveningReflectionDue({ nowMs: evening, timeZone: TZ, quiet: true, kv })).toBe(false)
  expect(isEveningReflectionDue({ nowMs: evening, timeZone: TZ, quiet: false, kv })).toBe(true)

  markEveningReflection(kv, evening, TZ)
  expect(isEveningReflectionDue({ nowMs: evening + 15 * MINUTE, timeZone: TZ, quiet: false, kv })).toBe(false)
  // A new object over the same values is a restart: the same owner day stays quiet.
  const restarted: WakeProactiveStorage = { get: kv.get, set: kv.set }
  expect(isEveningReflectionDue({ nowMs: evening + HOUR, timeZone: TZ, quiet: false, kv: restarted })).toBe(false)
  // The next owner day asks again after 19:00.
  expect(isEveningReflectionDue({ nowMs: evening + 24 * HOUR, timeZone: TZ, quiet: false, kv })).toBe(true)
})

test('an evening wake-up aborted after the request does not hand it to the next wake-up of that day', () => {
  const kv = memoryStorage()
  const evening = Date.UTC(2026, 0, 15, 14, 0) // 19:00 in Yekaterinburg
  // The host's order: the reflection is taken while the prompt is built, the
  // notes carry it, and only then does the turn run and possibly abort.
  const wakeNotes = (nowMs: number, quiet: boolean, storage: WakeProactiveStorage = kv): string => {
    const eveningReflection = takeEveningReflection({ nowMs, timeZone: TZ, quiet, kv: storage })
    return wakeSituationNotes({ autonomy: 'act', intervalMinutes: 60, now: nowMs, timeZone: TZ, quiet, eveningReflection })
      .join('\n')
  }

  expect(wakeNotes(evening - 15 * MINUTE, false), 'before 19:00 there is no request').not.toContain('Вечерний итог')
  expect(kv.values.has(WAKE_EVENING_KV_KEY), 'an early wake-up leaves the marker untouched').toBe(false)
  expect(wakeNotes(evening, true), 'a quiet evening wake-up does not ask').not.toContain('Вечерний итог')
  expect(kv.values.has(WAKE_EVENING_KV_KEY), 'a quiet wake-up does not consume the request').toBe(false)

  expect(wakeNotes(evening + 5 * MINUTE, false), 'the first evening wake-up asks').toContain('Вечерний итог')
  // The turn that received the request is stopped or times out (`aborted`):
  // nothing else is written, and the marker is already there.
  expect(kv.values.get(WAKE_EVENING_KV_KEY)).toBe(ownerDayKey(evening, TZ))
  expect(wakeNotes(evening + 20 * MINUTE, false), 'the next wake-up of that day does not ask again').not.toContain(
    'Вечерний итог',
  )
  // A restart over the same values keeps the owner day consumed.
  const restarted: WakeProactiveStorage = { get: kv.get, set: kv.set }
  expect(wakeNotes(evening + 2 * HOUR, false, restarted)).not.toContain('Вечерний итог')
  expect(wakeNotes(evening + 24 * HOUR, false), 'the next owner day asks again').toContain('Вечерний итог')

  // A broken ledger does not break the wake-up: the request still rides.
  const broken: WakeProactiveStorage = {
    get: () => undefined,
    set: () => {
      throw new Error('disk full')
    },
  }
  expect(wakeNotes(evening, false, broken)).toContain('Вечерний итог')
})

test('the evening request names journal, its own words, feelings and a short owner message', () => {
  const notes = wakeSituationNotes({
    autonomy: 'act',
    intervalMinutes: 60,
    now: Date.UTC(2026, 0, 15, 14, 0),
    timeZone: TZ,
    eveningReflection: true,
  }).join('\n')
  expect(notes).toMatch(/вечерн[^\n]{0,30}итог/i)
  expect(notes).toContain('journal')
  expect(notes).toMatch(/своими словами/i)
  expect(notes).toMatch(/что[^\n]{0,30}(?:было|произошло)/i)
  expect(notes).toMatch(/пережил|чувствовал/i)
  expect(notes).toMatch(/владельц/i)
  expect(notes).toMatch(/пар[уы][^\n]*строк/i)

  const stable = wakePrompt({
    autonomy: 'act',
    intervalMinutes: 60,
    now: Date.UTC(2026, 0, 15, 14, 0),
    timeZone: TZ,
    eveningReflection: true,
    separateSituation: true,
  })
  expect(stable, 'the per-day request stays out of the cached stable text').not.toContain('Вечерний итог')
})

