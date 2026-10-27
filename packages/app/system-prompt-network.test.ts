// [honest-prompt] The stable system prompt of the owner's `main` session tells
// the truth about the network of `exec`: the public internet is reached through
// the daemon proxy, the local network and service addresses stay closed, and a
// refusal of `web_fetch` is not a gap to route around with a command.

import { expect, test } from 'vitest'

import { buildOwnerSystemPrefix, EXEC_NETWORK_HINT } from './src/system-prompt.js'

const input = {
  charter: 'Устав теста',
  identity: 'Личность теста',
  rules: 'Правила теста',
  maxTurnIterations: 12,
}

test('test_honest_prompt_system_prefix_describes_the_exec_network', () => {
  const prefix = buildOwnerSystemPrefix(input)
  expect(prefix, 'the persona prefix is part of the system prompt').toContain('Устав теста')
  expect(prefix, 'the iteration cap is part of the system prompt').toContain('12')
  expect(prefix, 'the network rule is part of the system prompt').toContain(EXEC_NETWORK_HINT)
  expect(prefix, 'the public internet is reached through a proxy').toMatch(/прокси/i)
  expect(prefix, 'the local network is closed').toMatch(/локальн\S*\s+сеть|loopback|частн|link-local/i)
  expect(prefix, 'service addresses are named').toMatch(/169\.254\.169\.254/)
  expect(prefix, 'the model is told not to route a web_fetch refusal around').toMatch(/web_fetch/i)
  expect(prefix, 'the model is told that a direct socket does not bypass the rule').toMatch(/сокет/i)
})

test('test_honest_prompt_does_not_claim_an_absent_or_unrestricted_network', () => {
  const prefix = buildOwnerSystemPrefix(input)
  expect(prefix).not.toMatch(
    /shared network|unrestricted network|full network access|has no network|no network access|without network|нет сети|без сети|общая сеть/i,
  )
})

test('test_honest_prompt_system_prefix_is_stable', () => {
  expect(buildOwnerSystemPrefix(input), 'same inputs give the same prefix bytes').toBe(buildOwnerSystemPrefix(input))
})
