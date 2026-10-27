// The owner's `main` session is told to send independent tool calls in one
// model answer; a guest turn does not get that rule.
import { expect, test } from 'vitest'

import { buildOwnerSystemPrefix, FILE_SEND_HINT } from './src/system-prompt.js'
import {
  OWNER_CHAT,
  TEST_TIMEOUT_MS,
  deepStrings,
  modelRequests,
  ownerTexts,
  ownerTurn,
  say,
  startOwnerDaemon,
  waitFor,
  world,
} from './test-support/wake-harness.js'

const input = {
  charter: 'Устав теста',
  identity: 'Личность теста',
  rules: 'Правила теста',
  maxTurnIterations: 12,
}

/** The prompt section (heading to the next heading) that holds the batching rule. */
function batchingRule(prefix: string): string {
  const at = prefix.search(/независим/i)
  expect(at, 'the owner prefix has a rule about independent tool calls').toBeGreaterThanOrEqual(0)
  const start = prefix.lastIndexOf('\n# ', at) + 1
  const next = prefix.indexOf('\n# ', at)
  return prefix.slice(start, next === -1 ? undefined : next)
}

test('test_parallel_tool_calls_rule_c1_c2_c3_c5_c7_owner_prefix', () => {
  const prefix = buildOwnerSystemPrefix(input)
  const rule = batchingRule(prefix)
  // c1: imperative, independent calls go in one answer
  expect(rule, 'c1 the rule is imperative').toMatch(/отправляй/)
  expect(rule, 'c1 names the independent call kinds').toMatch(/exec/)
  expect(rule, 'c1 names reads').toMatch(/чтени/i)
  expect(rule, 'c1 names searches').toMatch(/поиск/i)
  expect(rule, 'c1 one model answer').toMatch(/одним\s+ответом/)
  // c2: a dependent call waits for the previous result
  expect(rule, 'c2 dependent call goes to the next step').toMatch(/результат/i)
  expect(rule, 'c2 dependent call goes to the next step').toMatch(/следующ\S*\s+шаг/i)
  // c3: long independent commands run in the background
  expect(rule, 'c3 background exec').toMatch(/background:\s*true/)
  expect(rule, 'c3 collected via exec_status').toMatch(/exec_status/)
  // c5: byte-stable across builds
  expect(buildOwnerSystemPrefix(input), 'c5 same inputs give the same bytes').toBe(prefix)
  expect(batchingRule(buildOwnerSystemPrefix({ ...input })), 'c5 the rule itself is stable').toBe(rule)
  // c7: the file hint names the voice message among send_file contents
  expect(FILE_SEND_HINT, 'c7 send_file hint lists the voice message').toMatch(/голосов/i)
  expect(prefix, 'c7 the owner prefix carries the file hint with the voice message').toContain(FILE_SEND_HINT)
})

test('test_parallel_tool_calls_rule_c4_guest_prompt_has_no_batching_rule', { timeout: TEST_TIMEOUT_MS }, async () => {
  const daemon = await startOwnerDaemon({ env: { DSHBOT_QUIET_HOURS: '', DSHBOT_DEBOUNCE_MS: '0' } })
  await ownerTurn(daemon, 'batchowner')
  const owner = modelRequests('owner').find((request) => request.tag === 'batchowner')
  expect(owner, 'an ordinary owner turn really reached the provider').toBeDefined()
  expect(deepStrings(owner!.body.system).join('\n'), 'the owner turn carries the rule').toMatch(/независим/i)

  const beforeInvite = ownerTexts().length
  say(OWNER_CHAT, '/invite')
  const invite = (): string | undefined => ownerTexts().slice(beforeInvite)
    .flatMap((text) => [...text.matchAll(/\?start=([A-Za-z0-9_-]+)/g)].map((match) => match[1]!))[0]
  await waitFor('the invitation link', () => invite() !== undefined, daemon)
  const guestChat = 5550094
  say(guestChat, `/start ${invite()!}`)
  const guestWasGreeted = (): boolean => world.timeline.events.some((event) =>
    event.src === 'tg' && event.params.chat_id === guestChat &&
    /теперь гость/.test(deepStrings(event.params).join('\n')),
  )
  await waitFor('the guest to redeem the invitation', guestWasGreeted, daemon)
  say(guestChat, 'own-batchguest привет')
  await waitFor('a model request from the guest session', () =>
    modelRequests('owner').some((request) => request.tag === 'batchguest'), daemon)
  const guest = modelRequests('owner').find((request) => request.tag === 'batchguest')!
  const text = deepStrings(guest.body.system).join('\n')
  expect(text.length, 'c4 the guest system prompt is really observed').toBeGreaterThan(0)
  expect(text, 'c4 no independent-calls rule').not.toMatch(/независим/i)
  expect(text, 'c4 no exec_status collection rule').not.toMatch(/exec_status/)
  expect(text, 'c4 no background exec rule').not.toMatch(/background:\s*true/)
})
