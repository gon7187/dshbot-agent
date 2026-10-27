import { expect, test } from 'vitest'

import { buildOwnerSystemPrefix } from '../app/src/system-prompt.js'
import { AUTONOMY_LEVELS, wakePrompt } from './src/index.js'

test('test_c4_wake_rules_allow_brief_honest_mood_sharing_for_a_reason_and_forbid_pressure', () => {
  for (const autonomy of AUTONOMY_LEVELS) {
    const prompt = [
      buildOwnerSystemPrefix({ charter: '', identity: '', rules: '', maxTurnIterations: 40 }),
      wakePrompt({ autonomy, intervalMinutes: 60 }),
    ].join('\n')
    // Check the text returned to the caller, with semantic stems rather than
    // fixing a complete prompt or the exact wording of individual sentences.
    const moodRules = prompt.replace(/\s+/g, ' ')
    expect(moodRules, `${autonomy}: rules explicitly discuss mood`).toMatch(/настроен/i)
    expect(moodRules, `${autonomy}: sharing it with the owner is permitted`).toMatch(/(?:мож|разреш|допуст)[^\n]*(?:подел|делит|сказ|рассказ)|(?:подел|делит)[^\n]*(?:мож|разреш|допуст)/i)
    expect(moodRules, `${autonomy}: sharing is honest`).toMatch(/честн|искрен/i)
    expect(moodRules, `${autonomy}: sharing is brief`).toMatch(/коротк|кратк/i)
    expect(moodRules, `${autonomy}: there must be an occasion`).toMatch(/(?:если|когда|при)[^\n]*(?:повод|причин|основан)/i)
    expect(moodRules, `${autonomy}: pity pressure is forbidden`).toMatch(/(?:не|нельзя|запре)[^\n]*(?:жалост|жалоб)/i)
    expect(moodRules, `${autonomy}: accusations are forbidden`).toMatch(/(?:не|нельзя|запре)[^\n]*обвин/i)
    expect(moodRules, `${autonomy}: bargaining is forbidden`).toMatch(/(?:не|нельзя|запре)[^\n]*торг/i)
    expect(moodRules, `${autonomy}: demanding attention is forbidden`).toMatch(/(?:не|нельзя|запре)[^\n]*(?:треб|вымог)[^\n]*внимани/i)
  }
})
