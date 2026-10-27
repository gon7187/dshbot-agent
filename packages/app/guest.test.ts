import { expect, test } from 'vitest'

import { spawn, type ChildProcess } from 'node:child_process'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AddressInfo } from 'node:net'

import { tmpdir } from 'node:os'

import { delimiter, dirname, join } from 'node:path'

import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  GUEST_CHARTER,
  GUEST_IDENTITY,
} from './test-support/guest-harness.js'

import type {
  Daemon,
  DsEvent,
  Event,
  FakeTelegram,
  Holder,
  JsonObject,
  Msg,
  QueuedUpdate,
  Stub,
  TgEvent,
  Timeline,
  World,
} from './test-support/guest-harness.js'

import {
  BOT_TOKEN,
  CLOCK_PRELOAD,
  DEEPSEEK_KEY,
  GROUP_CHAT,
  GUEST_A,
  GUEST_B,
  GUEST_C,
  GUEST_GAP_MS,
  HOUR_MS,
  LONG_POLL_HOLD_MS,
  OWNER_CHAT,
  QUIET_MS,
  SUPERGROUP_CHAT,
  TEST_TIMEOUT_MS,
  WAIT_MS,
  ask,
  askGuest,
  buttonPress,
  callsMentioning,
  clockPreload,
  closeServer,
  codeLike,
  costCancelToolStream,
  deepStrings,
  flatten,
  flushQueue,
  groupMessage,
  invite,
  joinGuest,
  lastMessageHasToolResult,
  listGuests,
  messagesOf,
  modelCalls,
  newTimeline,
  nextMessageId,
  noonUtcOffset,
  okResult,
  output,
  pairOwner,
  pairingCandidates,
  parseObject,
  pongMessage,
  pongStream,
  pongsTo,
  privateMessage,
  readBody,
  repoRoot,
  say,
  scratch,
  sendCode,
  sentTo,
  setClockOffset,
  settle,
  sleep,
  spawnDaemon,
  sse,
  startDaemon,
  startScript,
  startStub,
  startTelegram,
  stopCallbackOf,
  stopDaemon,
  systemTextOf,
  textsSince,
  updateCounter,
  userTexts,
  waitFor,
  world,
} from './test-support/guest-harness.js'

test('test_c1_invite_gives_a_code_of_8_plus_characters_and_only_one_chat_can_use_it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)

  const code = await invite(d)
  expect(code.length).toBeGreaterThanOrEqual(8)

  // the first chat becomes a guest: the model answers it
  await sendCode(d, GUEST_A, code)
  await askGuest(d, 'first-chat-text-aaa', GUEST_A)

  // the second chat with the same code does not
  say(GUEST_B, code)
  await settle() // absence: the update must produce no answer
  say(GUEST_B, 'second-chat-text-bbb')
  await settle() // absence: the update must produce no answer

  expect(callsMentioning(world.timeline, 'second-chat-text-bbb')).toHaveLength(0)
  expect(pongsTo(world.timeline, GUEST_B)).toHaveLength(0)
  expect(callsMentioning(world.timeline, code)).toHaveLength(0)
})
test('test_c2_private_chat_with_a_valid_code_becomes_a_guest_and_is_greeted', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const code = await invite(d)

  const callsBefore = modelCalls(world.timeline).length
  await sendCode(d, GUEST_A, code)
  await settle() // absence: the update must produce no answer
  // the greeting is not a model answer
  expect(modelCalls(world.timeline).length).toBe(callsBefore)
  expect(pongsTo(world.timeline, GUEST_A)).toHaveLength(0)

  await askGuest(d, 'guest-hello-text', GUEST_A)
  expect(callsMentioning(world.timeline, 'guest-hello-text').length).toBeGreaterThan(0)
})
test('test_c2_guests_survive_a_restart_with_the_same_home', { timeout: TEST_TIMEOUT_MS }, async () => {
  const first = await startDaemon()
  await pairOwner(first)
  await joinGuest(first, GUEST_A)
  await askGuest(first, 'before-restart-text', GUEST_A)
  await stopDaemon(first)

  const second = await startDaemon()
  await askGuest(second, 'after-restart-text', GUEST_A)
  expect(callsMentioning(world.timeline, 'after-restart-text').length).toBeGreaterThan(0)
  expect(await listGuests(second)).toContain(String(GUEST_A))
})
test('test_c4_guest_system_prompt_starts_with_the_guest_charter_and_says_the_peer_is_a_guest', { timeout: TEST_TIMEOUT_MS }, async () => {
  // The owner's charter and identity describe the owner's machine; a guest gets
  // the guest-only pair instead, and the prompt must say the peer is not the owner.
  const charter = readFileSync(join(repoRoot, 'CHARTER.md'), 'utf8').trim()
  const identity = readFileSync(join(repoRoot, 'persona', 'identity.seed.md'), 'utf8').trim()
  const guestWords = /гост|guest/i

  const d = await startDaemon()
  await pairOwner(d)
  await ask(d, 'owner-prompt-text-aaa', OWNER_CHAT)
  await joinGuest(d, GUEST_A)
  await askGuest(d, 'guest-prompt-text-bbb', GUEST_A)

  const guestCalls = callsMentioning(world.timeline, 'guest-prompt-text-bbb')
  expect(guestCalls.length).toBeGreaterThan(0)
  for (const call of guestCalls) {
    const system = systemTextOf(call.body)
    const charterAt = system.indexOf(GUEST_CHARTER.trim())
    expect(charterAt, 'the guest system prompt must contain the guest charter').toBeGreaterThanOrEqual(0)
    expect(charterAt).toBeLessThanOrEqual(20)
    expect(system.indexOf(GUEST_IDENTITY.trim()), 'the guest system prompt must contain the guest identity').toBeGreaterThan(charterAt)
    expect(system, 'the owner charter leaked into the guest prompt').not.toContain(charter)
    expect(system, 'the owner identity leaked into the guest prompt').not.toContain(identity)
    const rest = system.replace(GUEST_CHARTER.trim(), '').replace(GUEST_IDENTITY.trim(), '')
    expect(rest, 'a mark that the interlocutor is a guest').toMatch(guestWords)
    expect(rest, 'a mark that the interlocutor is not the owner').toMatch(/владел|owner/i)
  }

  const ownerCalls = callsMentioning(world.timeline, 'owner-prompt-text-aaa')
  expect(ownerCalls.length).toBeGreaterThan(0)
  for (const call of ownerCalls) {
    const system = systemTextOf(call.body)
    expect(system, 'the owner prompt lost CHARTER.md').toContain(charter)
    expect(system, 'the owner prompt lost the seed identity').toContain(identity)
    const rest = system.replace(charter, '').replace(identity, '')
    expect(rest).not.toMatch(guestWords)
  }
})
test('test_c6_guest_over_the_daily_limit_gets_a_short_refusal_without_a_model_call', { timeout: TEST_TIMEOUT_MS }, async () => {
  setClockOffset(noonUtcOffset())
  const d = await startDaemon({ DSHBOT_GUEST_DAILY_LIMIT: '2' })
  await pairOwner(d)
  await joinGuest(d, GUEST_A)

  await askGuest(d, 'limit-text-one', GUEST_A)
  await askGuest(d, 'limit-text-two', GUEST_A)

  const calls = modelCalls(world.timeline).length
  const mark = world.timeline.seq
  say(GUEST_A, 'limit-text-three')
  await waitFor('a refusal for the third message', () => textsSince(mark, GUEST_A).length > 0, d)
  await settle() // absence: the update must produce no answer

  expect(modelCalls(world.timeline).length).toBe(calls)
  expect(callsMentioning(world.timeline, 'limit-text-three')).toHaveLength(0)
  const refusal = textsSince(mark, GUEST_A).join('\n')
  expect(refusal).not.toContain('pong')
  expect(refusal.length).toBeLessThan(400)

  // the limit is per guest and does not touch the owner
  await joinGuest(d, GUEST_B)
  await askGuest(d, 'other-guest-text', GUEST_B)
  for (const text of ['owner-one', 'owner-two', 'owner-three', 'owner-four']) await ask(d, text, OWNER_CHAT)
})
test('test_c8_a_code_sent_from_a_group_or_supergroup_does_not_make_it_a_guest', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startDaemon()
  await pairOwner(d)
  const code = await invite(d)

  world.tg.push(groupMessage(GROUP_CHAT, 'group', GUEST_C, code))
  world.tg.push(groupMessage(SUPERGROUP_CHAT, 'supergroup', GUEST_C, code))
  await settle() // absence: the update must produce no answer
  world.tg.push(groupMessage(GROUP_CHAT, 'group', GUEST_C, 'group-text-after-code'))
  world.tg.push(groupMessage(SUPERGROUP_CHAT, 'supergroup', GUEST_C, 'supergroup-text-after-code'))
  await settle() // absence: the update must produce no answer

  expect(modelCalls(world.timeline)).toHaveLength(0)
  expect(pongsTo(world.timeline, GROUP_CHAT)).toHaveLength(0)
  expect(pongsTo(world.timeline, SUPERGROUP_CHAT)).toHaveLength(0)

  // the user who posted the code in a group is not a guest in a private chat either
  say(GUEST_C, 'private-text-of-group-user')
  await settle() // absence: the update must produce no answer
  expect(callsMentioning(world.timeline, 'private-text-of-group-user')).toHaveLength(0)

  const guests = await listGuests(d)
  expect(guests).not.toContain(String(GROUP_CHAT))
  expect(guests).not.toContain(String(SUPERGROUP_CHAT))
  expect(guests).not.toContain(String(GUEST_C))
})
