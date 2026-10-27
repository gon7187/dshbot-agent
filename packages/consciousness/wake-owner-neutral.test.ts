// The wake-up prompt is for any owner: it names no business of one of them, only where to look
// for what matters to the owner (memory, schedules, affairs).
import { expect, test } from 'vitest'

import { AUTONOMY_LEVELS, wakePrompt, type WakePromptOptions } from './src/index.js'

const VARIANTS: Array<Partial<WakePromptOptions>> = [
  {},
  { freeMinute: true },
  { eveningReflection: true, quiet: true },
  { proactivePerDay: 0, silentWakeups: 3, lastProactiveAt: 1_700_000_000_000 },
  { separateSituation: true },
]

test('test_c4_wake_prompt_names_no_business_and_points_to_memory_schedules_and_affairs', () => {
  for (const autonomy of AUTONOMY_LEVELS) {
    for (const extra of VARIANTS) {
      const prompt = wakePrompt({ autonomy, intervalMinutes: 60, now: 1_700_000_000_000, timeZone: 'UTC', ...extra })
      const label = `${autonomy} ${JSON.stringify(extra)}`
      expect(prompt, `${label}: Wildberries`).not.toMatch(/wildberries/i)
      expect(prompt, `${label}: WB`).not.toMatch(/(^|[^a-z])wb([^a-z]|$)/i)
      expect(prompt, `${label}: advertising`).not.toMatch(/реклам/i)
      expect(prompt, `${label}: stock`).not.toMatch(/остатк/i)
      const pointer = prompt
        .split('\n')
        .find((line) => /памят/i.test(line) && /расписани/i.test(line) && /дел/i.test(line))
      expect(pointer, `${label}: a line sends the bot to memory, schedules and affairs`).toBeDefined()
    }
  }
})
