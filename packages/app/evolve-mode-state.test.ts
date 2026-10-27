// The durable state of `/evolve`: parsing, the status text and the prompt of a
// cycle. The end-to-end behaviour of the mode is in evolve-mode.test.ts; this
// file keeps the pure part fast to verify.

import { expect, test } from 'vitest'

import {
  createEvolveModeStore,
  DEFAULT_EVOLVE_INTERVAL_MS,
  defaultEvolveState,
  evolveCyclePrompt,
  formatEvolveStatus,
  MAX_EVOLVE_OUTCOMES,
  MIN_EVOLVE_INTERVAL_MS,
  normalizeEvolveState,
  parseEvolveInterval,
  type EvolveModeState,
  type EvolveOutcome,
} from './src/evolve-mode.js'

function memoryStorage(): { values: Map<string, string>; get(key: string): string | undefined; set(key: string, value: string): void } {
  const values = new Map<string, string>()
  return {
    values,
    get(key) {
      return values.get(key)
    },
    set(key, value) {
      values.set(key, value)
    },
  }
}

test('test_parse_evolve_interval_accepts_minutes_hours_and_days', () => {
  expect(parseEvolveInterval('30m')).toBe(MIN_EVOLVE_INTERVAL_MS)
  expect(parseEvolveInterval('2h')).toBe(2 * 60 * 60 * 1_000)
  expect(parseEvolveInterval('1d')).toBe(24 * 60 * 60 * 1_000)
  expect(parseEvolveInterval('10m')).toBe(10 * 60 * 1_000)
  expect(parseEvolveInterval('soon')).toBeUndefined()
  expect(parseEvolveInterval('0m')).toBeUndefined()
})

test('test_evolve_state_round_trips_and_keeps_the_last_three_outcomes', () => {
  const storage = memoryStorage()
  const store = createEvolveModeStore(storage, DEFAULT_EVOLVE_INTERVAL_MS)
  expect(store.load()).toEqual(defaultEvolveState(DEFAULT_EVOLVE_INTERVAL_MS))

  const outcomes: EvolveOutcome[] = []
  for (let index = 1; index <= 5; index += 1) {
    outcomes.push({ at: index, candidateId: `c-${index}`, submitted: true, decision: 'waiting' })
  }
  const state: EvolveModeState = {
    enabled: true,
    intervalMs: MIN_EVOLVE_INTERVAL_MS,
    nextAt: 1_000,
    outcomes: outcomes.slice(-MAX_EVOLVE_OUTCOMES),
  }
  store.save(state)
  expect(store.load()).toEqual(state)
  expect(store.load().outcomes.map((outcome) => outcome.candidateId)).toEqual(['c-3', 'c-4', 'c-5'])
})

test('test_evolve_state_ignores_garbage_instead_of_failing', () => {
  const storage = memoryStorage()
  storage.set('evolve.mode', JSON.stringify({ enabled: true, intervalMs: -1, outcomes: 'nope' }))
  const store = createEvolveModeStore(storage, DEFAULT_EVOLVE_INTERVAL_MS)
  expect(store.load()).toEqual({ enabled: true, intervalMs: DEFAULT_EVOLVE_INTERVAL_MS, outcomes: [] })
  storage.set('evolve.mode', '{not json')
  expect(store.load()).toEqual(defaultEvolveState(DEFAULT_EVOLVE_INTERVAL_MS))
  expect(normalizeEvolveState(null, MIN_EVOLVE_INTERVAL_MS).enabled).toBe(false)
})

test('test_evolve_state_keeps_the_waiting_candidate_of_the_mode', () => {
  const storage = memoryStorage()
  const store = createEvolveModeStore(storage, DEFAULT_EVOLVE_INTERVAL_MS)
  const state: EvolveModeState = {
    enabled: true,
    intervalMs: MIN_EVOLVE_INTERVAL_MS,
    nextAt: 1_000,
    openCandidateId: 'c-open-one',
    outcomes: [{ at: 1, candidateId: 'c-open-one', submitted: true, decision: 'waiting' }],
  }
  store.save(state)
  expect(store.load()).toEqual(state)

  storage.set('evolve.mode', JSON.stringify({ enabled: true, openCandidateId: 42, outcomes: [] }))
  expect(store.load().openCandidateId, 'a non-string marker is ignored').toBeUndefined()
})

test('test_evolve_status_names_the_switch_the_next_cycle_and_the_outcomes', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0)
  const on = formatEvolveStatus(
    {
      enabled: true,
      intervalMs: MIN_EVOLVE_INTERVAL_MS,
      nextAt: now + 25 * 60_000,
      outcomes: [
        { at: 1, candidateId: 'c-one', submitted: true, decision: 'waiting' },
        { at: 2, candidateId: 'c-two', submitted: true, decision: 'rejected' },
        { at: 3, submitted: false, decision: 'none' },
      ],
    },
    now,
  )
  expect(on).toMatch(/включён/)
  expect(on).not.toMatch(/выключен/)
  expect(on).toContain('через 25 мин')
  expect(on).toContain('c-one: карточка отправлена')
  expect(on).toContain('c-two: отклонён')
  expect(on).toContain('кандидата нет')

  const off = formatEvolveStatus(defaultEvolveState(), now)
  expect(off).toMatch(/выключен/)
  expect(off).toContain('не запланирован')
})

test('test_evolve_cycle_prompt_names_the_fix_flow_the_factory_and_silence', () => {
  const prompt = evolveCyclePrompt()
  expect(prompt).toContain('self_change')
  expect(prompt).toContain('self_submit')
  expect(prompt).toMatch(/zavod|завод/i)
  expect(prompt).toContain('[SILENT]')
  expect(prompt).toMatch(/один открытый кандидат/i)
  expect(prompt, 'an unfinished candidate has a way out').toContain('self_discard')
})
