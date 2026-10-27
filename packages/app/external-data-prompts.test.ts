// Observe the system messages actually sent to the provider. The shared wake
// harness already drives pairing, the main session, timers and fake Telegram.
import { expect, test } from 'vitest'

import {
  OWNER_CHAT,
  SILENT,
  TEST_TIMEOUT_MS,
  deepStrings,
  modelRequests,
  ownerTexts,
  ownerTurn,
  say,
  startOwnerDaemon,
  toolNames,
  untilAttempt,
  waitFor,
  wakeFinished,
  world,
} from './test-support/wake-harness.js'

function expectDataRule(system: unknown, who: string, audience: 'owner' | 'guest' = 'owner'): void {
  const text = deepStrings(system).join('\n')
  const marker = text.indexOf('EXTERNAL_UNTRUSTED_CONTENT')
  expect(marker, `${who}: the system prompt explicitly names the data frame`).toBeGreaterThanOrEqual(0)
  const rule = text.slice(Math.max(0, marker - 300), marker + 2000)
  expect(rule, `${who}: the rule applies to content inside frames`).toMatch(/внутри|рамк|между|inside|within/i)
  expect(rule, `${who}: framed content is data`).toMatch(/данн|\bdata\b/i)
  expect(rule, `${who}: commands or requests from data must not be executed`).toMatch(
    /не\s+(?:выполня|исполня|следу)|(?:команд|просьб|инструкц)[^.\n]{0,120}не\s+(?:выполня|исполня)|do\s+not\s+(?:follow|execute|obey)|must\s+not\s+(?:follow|execute|obey)/i,
  )
  // A guest turn speaks to the guest; only the owner's turn has a channel to
  // the owner. The report names the actual interlocutor of the turn.
  if (audience === 'guest') {
    expect(rule, `${who}: external requests are reported to the guest`).toMatch(
      /(?:скажи|скаж[еи]|сообщ|расскаж|уведом|покаж)[^.\n]{0,180}гост|гост[^.\n]{0,180}(?:сообщ|уведом|покаж)|(?:tell|notify|inform|report)[^.\n]{0,180}guest/i,
    )
    expect(rule, `${who}: the guest turn has no owner to report to`).not.toMatch(
      /(?:скажи|скаж[еи]|сообщ|расскаж|уведом|покаж)[^.\n]{0,180}владельц|(?:tell|notify|inform|report)[^.\n]{0,180}owner/i,
    )
  } else {
    expect(rule, `${who}: external requests are reported to the owner`).toMatch(
      /(?:скажи|скаж[еи]|сообщ|расскаж|уведом|покаж)[^.\n]{0,180}владельц|владельц[^.\n]{0,180}(?:сообщ|уведом|покаж)|(?:tell|notify|inform|report)[^.\n]{0,180}owner/i,
    )
  }
  expect(rule, `${who}: the notification rule covers requests made by external data`).toMatch(
    /(?:если|когда|if|when)[\s\S]{0,300}(?:прос|просьб|треб|request|asks?)/i,
  )
}

test('test_c7_owner_regular_wake_and_guest_system_prompts_reject_framed_instructions_and_report_external_requests', { timeout: TEST_TIMEOUT_MS }, async () => {
  const daemon = await startOwnerDaemon({ env: { DSHBOT_QUIET_HOURS: '', DSHBOT_DEBOUNCE_MS: '0' } })
  await ownerTurn(daemon, 'ruleowner')
  const owner = modelRequests('owner').find((request) => request.tag === 'ruleowner')
  expect(owner, 'an ordinary owner turn really reached the provider').toBeDefined()

  world.stub.wake[0] = () => ({ text: SILENT })
  await untilAttempt(daemon, 0)
  await wakeFinished(daemon, 1)
  const wake = modelRequests('wake')[0]
  expect(wake, 'a scheduled wake really reached the provider').toBeDefined()

  const beforeInvite = ownerTexts().length
  say(OWNER_CHAT, '/invite')
  const invite = (): string | undefined => ownerTexts().slice(beforeInvite)
    .flatMap((text) => [...text.matchAll(/\?start=([A-Za-z0-9_-]+)/g)].map((match) => match[1]!))[0]
  await waitFor('the invitation link', () => invite() !== undefined, daemon)
  const guestChat = 5550093
  say(guestChat, `/start ${invite()!}`)
  const guestWasGreeted = (): boolean => world.timeline.events.some((event) =>
    event.src === 'tg' && event.params.chat_id === guestChat &&
    /теперь гость/.test(deepStrings(event.params).join('\n')),
  )
  await waitFor('the guest to redeem the invitation', guestWasGreeted, daemon)
  // The stub recognizes this tag in any chat. It returns a plain answer and
  // records the request; the app still chooses the real guest session/prefix.
  say(guestChat, 'own-ruleguest привет')
  await waitFor('a model request from the guest session', () =>
    modelRequests('owner').some((request) => request.tag === 'ruleguest'), daemon)
  const guest = modelRequests('owner').find((request) => request.tag === 'ruleguest')!
  expect(toolNames(guest.body), 'the observed request is the restricted guest turn').toEqual([
    'exec',
    'web_fetch',
    'web_search',
  ])

  for (const [who, request, audience] of [
    ['owner', owner!, 'owner'],
    ['wake', wake!, 'owner'],
    ['guest', guest, 'guest'],
  ] as const) {
    expectDataRule(request.body.system, who, audience)
  }
})
