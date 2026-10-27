import { expect, test } from 'vitest'

import { AUTONOMY_LEVELS, wakePrompt } from './src/index.js'

test('test_c5_wake_mood_may_justify_charter_refusal_but_please_and_urgent_get_done', () => {
  for (const autonomy of AUTONOMY_LEVELS) {
    const prompt = wakePrompt({ autonomy, intervalMinutes: 60 })
    expect(prompt, `${autonomy}: remove the old blanket obedience rule`).not.toMatch(
      /не\s+отменяют\s+поручение|независимо\s+от\s+настроения|настроение\s+не\s+должно\s+менять\s+выполнение\s+просьб/iu,
    )
    // Use the returned mood paragraph, allowing wording changes and line wrapping.
    const paragraphs = prompt.split('\n').filter((line) => /настроен|отказ|пожалуйста|срочно/iu.test(line))
    const rules = paragraphs.join(' ').replace(/\s+/gu, ' ')
    expect(rules, `${autonomy}: mood may cause refusal`).toMatch(
      /настроен[^.!?]*(?:мож|вправе|допустим|основан|причин|повод)[^.!?]*отказ|(?:можешь|вправе)[^.!?]*отказ[^.!?]*настроен/iu,
    )
    expect(rules, `${autonomy}: the charter governs that refusal`).toMatch(/отказ[^.!?]*устав|устав[^.!?]*отказ/iu)
    expect(rules, `${autonomy}: please and urgent requests are carried out`).toMatch(
      /пожалуйста[^.!?]*срочно[^.!?]*(?:выполн|дела|сдела)|(?:выполн|дела|сдела)[^.!?]*пожалуйста[^.!?]*срочно/iu,
    )
  }
})
