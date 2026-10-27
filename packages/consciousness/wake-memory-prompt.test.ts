import { expect, test } from 'vitest'

import { AUTONOMY_LEVELS, wakePrompt } from './src/index.js'

test('test_c10_the_wake_prompt_names_journal_for_the_results_and_knowledge_for_lasting_facts', () => {
  for (const autonomy of AUTONOMY_LEVELS) {
    const prompt = wakePrompt({ autonomy, intervalMinutes: 60 })
    expect(prompt, `${autonomy}: the prompt names the journal tool`).toContain('journal')
    expect(prompt, `${autonomy}: the prompt names the knowledge tool`).toContain('knowledge')
  }
})
