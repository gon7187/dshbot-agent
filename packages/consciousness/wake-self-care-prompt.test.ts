import { expect, test } from 'vitest'

import { wakePrompt } from './src/index.js'

test('test_c1_wake_prompt_allows_idleness_and_occasional_self_improvement_without_inventing_work', () => {
  const prompt = wakePrompt({ autonomy: 'act', intervalMinutes: 60 }).toLowerCase()

  for (const capability of ['identity.md', 'knowledge', 'self_change', 'self_submit']) {
    expect(prompt, `the wake-up explicitly offers ${capability} for work on itself`).toContain(capability)
  }
  expect(prompt, 'doing nothing is usually legitimate').toMatch(/чаще всего|большую часть|большинств|обычно/iu)
  expect(prompt, 'a pause is allowed').toMatch(/пауз[^\n]*(?:легитим|допустим|нормальн)|(?:можно|законно)[^\n]*ничего не дел/iu)
  expect(prompt, 'self-improvement is occasional').toMatch(/время от времени|иногда|изредка/iu)
  expect(prompt, 'read the identity again').toMatch(/перечит|прочит[^\n]*identity|identity[^\n]*прочит/iu)
  expect(prompt, 'rewrite an identity that no longer fits').toMatch(/перепиш|перепис|обнови[^\n]*identity/iu)
  expect(prompt, 'the identity can lag behind the bot').toMatch(/отстал|устарел|нынешн|больше не описыва|не соответств/iu)
  expect(prompt, 'repair or improve a skill').toMatch(/(?:почин|исправ|улучш)[^\n]*навык|навык[^\n]*(?:почин|исправ|улучш)/iu)
  expect(prompt, 'keep a lesson in knowledge').toMatch(/урок[^\n]*knowledge|knowledge[^\n]*урок/iu)
  expect(prompt, 'do not manufacture work').toMatch(/не (?:изобретай|выдумывай|придумывай)[^\n]*(?:работ|активност|задач)/iu)
})
