import { expect, test } from 'vitest'

import { spawn, type ChildProcess } from 'node:child_process'

import { createHash } from 'node:crypto'

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AddressInfo } from 'node:net'

import { tmpdir } from 'node:os'

import { delimiter, dirname, join } from 'node:path'

import { fileURLToPath, pathToFileURL } from 'node:url'

import type {
  Action,
  Block,
  Clock,
  Daemon,
  DsEvent,
  Event,
  FakeTelegram,
  Holder,
  JsonObject,
  QueuedUpdate,
  Said,
  SecretFile,
  SseServer,
  Stub,
  TgEvent,
  Timeline,
  World,
} from './test-support/owner-secret-vault-harness.js'

import {
  API_VALUE,
  API_VALUE_NEW,
  BAD_SERVER,
  BOT_TOKEN,
  CLOCK_PRELOAD,
  DEEPSEEK_KEY,
  ECHO,
  ENVLEAK,
  FIXTURE_SERVER,
  GUEST_CHAT,
  LANG_VALUE,
  LONG_POLL_HOLD_MS,
  MARKER_RE,
  OWNER_CHAT,
  QUOTE,
  SECRET_A,
  SECRET_B,
  SSE_SERVER,
  STDIO_SERVER,
  TEST_TIMEOUT_MS,
  TURN_WAIT_MS,
  WAIT_MS,
  WHOAMI,
  WINDOWS,
  WORD_VALUE,
  admitGuest,
  asObject,
  backgroundJobKeepsTheOldValueScrubbed,
  blocksOf,
  call,
  clockPreload,
  closeServer,
  commandReply,
  deepStrings,
  deletedIn,
  expectCommandSaw,
  expectNoLeak,
  expectOldValueScrubbed,
  exportHistory,
  filesUnder,
  flatten,
  flushQueue,
  jobIdOf,
  jsonLines,
  lastResultText,
  lastResults,
  lastTurnMessage,
  launchesOf,
  leakedPieces,
  leaksOf,
  makeScratch,
  markerMessage,
  messageEnd,
  messageStart,
  messagesOf,
  nextMessageId,
  okResult,
  output,
  ownerTurn,
  pairOwner,
  pairingCandidates,
  parseObject,
  pieces,
  plainMessage,
  privateMessage,
  readAck,
  readBody,
  replyEvent,
  repoRoot,
  restartWithMcp,
  saveSecret,
  say,
  scratch,
  scripted,
  search,
  secretFiles,
  secretNamed,
  secretsDir,
  sentTo,
  serverFile,
  shaOf,
  sleep,
  spawnDaemon,
  sse,
  sseTools,
  startDaemon,
  startOwnerDaemon,
  startScript,
  startServersWithSecret,
  startSse,
  startStub,
  startTelegram,
  stdioEntry,
  stopDaemon,
  surfaces,
  textStream,
  textsSince,
  tokenOf,
  toolUseStream,
  toolsOf,
  turnAs,
  turnCalls,
  turnStep,
  updateCounter,
  valueOf,
  visiblePiece,
  waitFor,
  world,
  writeClock,
  writeMcpJson,
} from './test-support/owner-secret-vault-harness.js'

test('test_c1_secret_command_then_value_message_is_stored_0600_deleted_from_the_chat_and_answered_by_name', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const mark = world.timeline.seq

  say(OWNER_CHAT, '/secret DEPLOYKEY')
  await sleep(700)
  const valueMessage = say(OWNER_CHAT, WORD_VALUE)

  await waitFor('the file of the secret', () => valueOf(secretNamed('DEPLOYKEY')) === WORD_VALUE, d)
  const file = secretNamed('DEPLOYKEY') as SecretFile
  expect(file.mode.toString(8), 'the file of a secret is readable by the owner of the process alone').toBe('600')
  expect(existsSync(secretsDir()), 'the vault is DSHBOT_HOME/secrets').toBe(true)

  await waitFor('the bot to delete the message with the value', () => deletedIn(OWNER_CHAT).includes(valueMessage), d)
  await waitFor('the answer that the secret is saved', () => /сохран/i.test(textsSince(mark, OWNER_CHAT)) && textsSince(mark, OWNER_CHAT).includes('DEPLOYKEY'), d)
  expect(textsSince(mark, OWNER_CHAT), 'the answer names the secret and never shows the value').not.toContain(WORD_VALUE)
  expect(deletedIn(OWNER_CHAT), 'the message with the value is deleted').toContain(valueMessage)
})
test('test_c3_secrets_lists_names_only_and_unsecret_removes_the_secret', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'ALPHAKEY', WORD_VALUE)
  await saveSecret(d, 'BETAKEY', API_VALUE)

  const listed = await commandReply(d, '/secrets')
  expect(listed, 'the list names the first secret').toContain('ALPHAKEY')
  expect(listed, 'the list names the second secret').toContain('BETAKEY')
  expect(listed, 'the list never shows a value').not.toContain(WORD_VALUE)
  expect(listed).not.toContain(API_VALUE)

  await commandReply(d, '/unsecret ALPHAKEY')
  await waitFor('the file of the removed secret to disappear', () => secretNamed('ALPHAKEY') === undefined, d)
  expect(valueOf(secretNamed('BETAKEY')), 'the other secret stays').toBe(API_VALUE)

  const after = await commandReply(d, '/secrets')
  expect(after, 'the removed secret is no longer listed').not.toContain('ALPHAKEY')
  expect(after, 'the other secret is still listed').toContain('BETAKEY')
  expect(after).not.toContain(API_VALUE)
  expectNoLeak(WORD_VALUE, 'removed secret')
  expectNoLeak(API_VALUE, 'listed secret')
})
test('test_c4_cancel_ends_the_wait_and_the_next_message_is_handled_as_usual', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  say(OWNER_CHAT, '/secret CANCELKEY')
  await sleep(700)
  say(OWNER_CHAT, '/cancel')
  await sleep(1_500)

  await ownerTurn(d, 'turn-cx-1', ` ${SECRET_A}`)
  expect(secretNamed('CANCELKEY'), 'the cancelled secret has no file').toBeUndefined()
  expect(secretFiles().filter((file) => file.text.includes(SECRET_A)), 'the message after /cancel was not stored').toEqual([])
  expect(deletedIn(OWNER_CHAT), 'the message after /cancel stays in the chat').not.toContain(lastTurnMessage)
  expect(turnCalls('turn-cx-1').length, 'the model got the message after /cancel').toBeGreaterThan(0)

  // the vault still works after a cancelled wait
  await saveSecret(d, 'AFTERCANCEL', API_VALUE)
  expect(valueOf(secretNamed('AFTERCANCEL'))).toBe(API_VALUE)
})
test('test_c5_mcp_env_and_headers_get_the_secret_and_a_missing_secret_is_a_problem_of_its_server_alone', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.sse = await startSse()
  const d0 = await startOwnerDaemon()
  const d = await restartWithMcp(
    d0,
    { APITOKEN: API_VALUE },
    {
      [STDIO_SERVER]: stdioEntry(STDIO_SERVER, { TOKEN: '${secret:APITOKEN}', API_AUTH: 'Bearer ${secret:APITOKEN}', PLAIN: 'plain' }),
      [BAD_SERVER]: stdioEntry(BAD_SERVER, { TOKEN: '${secret:MISSINGKEY}' }),
      [SSE_SERVER]: { type: 'sse', url: `${world.sse.origin}/sse`, headers: { Authorization: 'Bearer ${secret:APITOKEN}' } },
    },
  )
  await waitFor('the servers of mcp.json to start', () => launchesOf(STDIO_SERVER).length > 0 && (world.sse?.streams ?? 0) > 0, d)
  await sleep(2_000)

  const env = asObject(launchesOf(STDIO_SERVER)[0]?.env)
  expect(env.TOKEN, 'the stdio server gets the value of the secret in env').toBe(API_VALUE)
  expect(env.API_AUTH, 'a reference inside a string is replaced inside it').toBe(`Bearer ${API_VALUE}`)
  expect(env.PLAIN, 'a plain value is left alone').toBe('plain')
  expect(world.sse.authorizations.length, 'the SSE server was reached').toBeGreaterThan(0)
  for (const authorization of world.sse.authorizations) {
    expect(authorization, 'the headers of the SSE server carry the value of the secret').toBe(`Bearer ${API_VALUE}`)
  }
  expect(launchesOf(BAD_SERVER), 'the server with a missing secret is not started').toEqual([])

  const report = await commandReply(d, '/mcp')
  expect(report, 'the report names the healthy server').toContain(STDIO_SERVER)
  expect(report, 'the report names the server with the problem').toContain(BAD_SERVER)
  expect(report, 'the problem of that server is the missing secret').toContain('секрет MISSINGKEY не найден')

  const results = await scripted(d, 'turn-cm-1', [search(ECHO), call(ECHO, { text: 'PING-C5' })])
  expect(results[1], 'the healthy server answers although another one could not start').toContain('ECHO:PING-C5')
  expect(results[1]).not.toContain(API_VALUE)

  expectNoLeak(API_VALUE, 'a secret in mcp.json')
})
test('test_c7_a_guest_is_refused_the_secret_commands_and_the_next_message_of_a_guest_is_not_a_secret', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'OWNERKEY', API_VALUE)
  await admitGuest(d)

  const guestSays = async (text: string): Promise<string> => {
    await sleep(3_200)
    const mark = world.timeline.seq
    say(GUEST_CHAT, text)
    await waitFor(`an answer for the guest to ${text.slice(0, 20)}`, () => sentTo(world.timeline, GUEST_CHAT).some((e) => e.n > mark), d, TURN_WAIT_MS)
    await sleep(500)
    return textsSince(mark, GUEST_CHAT)
  }

  const refusal = await guestSays('/secret GUESTKEY')
  expect(refusal.length, 'the guest gets an answer to /secret').toBeGreaterThan(0)
  await guestSays(SECRET_A)
  expect(secretNamed('GUESTKEY'), 'the command of a guest made no secret').toBeUndefined()
  expect(secretFiles().filter((file) => file.text.includes(SECRET_A)), 'the next message of a guest is no value').toEqual([])
  expect(deletedIn(GUEST_CHAT), 'nothing a guest wrote is deleted by the vault').toEqual([])

  const listed = await guestSays('/secrets')
  expect(listed, 'a guest sees no name of the owner').not.toContain('OWNERKEY')
  const removed = await guestSays('/unsecret OWNERKEY')
  expect(removed).not.toContain(API_VALUE)
  expect(valueOf(secretNamed('OWNERKEY')), 'a guest cannot remove a secret of the owner').toBe(API_VALUE)

  // the owner waits for a value, a guest writes first: the value is the one of the owner
  say(OWNER_CHAT, '/secret SECONDKEY')
  await sleep(700)
  await guestSays(SECRET_B)
  say(OWNER_CHAT, API_VALUE_NEW)
  await waitFor('the value of the owner to be stored', () => valueOf(secretNamed('SECONDKEY')) === API_VALUE_NEW, d)
  expect(secretFiles().filter((file) => file.text.includes(SECRET_B)), 'the message of the guest was not stored as the secret of the owner').toEqual([])
  expect(
    secretFiles().some((file) => file.text.includes(SECRET_A)),
    'the earlier message of the guest is still no secret',
  ).toBe(false)
})
test('test_c9_replaced_secret_keeps_the_old_value_scrubbed_while_the_server_lives', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startServersWithSecret()
  await expectOldValueScrubbed(d, 'cc')

  const launched = launchesOf(STDIO_SERVER).length
  await saveSecret(d, 'APITOKEN', API_VALUE_NEW)
  expect(valueOf(secretNamed('APITOKEN')), 'the secret holds the new value').toBe(API_VALUE_NEW)
  expect(launchesOf(STDIO_SERVER).length, 'a new value does not restart the server').toBe(launched)

  await expectOldValueScrubbed(d, 'cd')
  expectNoLeak(API_VALUE_NEW, 'the new value of the secret')
})
test('test_c10_background_exec_deleted_secret_is_scrubbed_in_every_status_window_tail_and_end_message', { timeout: TEST_TIMEOUT_MS }, async () => {
  await backgroundJobKeepsTheOldValueScrubbed('delete')
})
test('test_h1_c10_overflow_of_the_output_ring_leaves_no_suffix_of_the_secret_in_status_or_end_message', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'BIGKEY', SECRET_A)
  const done = join(world.workspace, 'done.flag')

  // The ring keeps the last 4 MiB of a stream. The stream is the value and a newline over and over, cut so that
  // the retained part begins 12 characters inside a copy: 20 characters of the value would be left at its head.
  const ring = 4 * 1024 * 1024
  const total = ring + 12
  const command = `printf %s "$BIGKEY" | sha256sum | cut -c1-16 > hash.txt; yes "$BIGKEY" | head -c ${total}; touch done.flag`
  const started = await scripted(d, 'turn-ya-1', [call('exec', { command, secrets: ['BIGKEY'], background: true })])
  const id = jobIdOf(started[0] as string)
  await waitFor('the job to finish', () => existsSync(done), d, 90_000)
  expectCommandSaw(SECRET_A)
  await sleep(3_000)

  const windows = [
    { offset: 0, limit: 400 },
    { offset: 12, limit: 40 },
    { offset: 5, limit: 10 },
    { offset: 20, limit: 30 },
    { offset: total - 120, limit: 100 },
  ]
  const reads: Action[] = [
    call('exec_status', { id }),
    ...windows.map(({ offset, limit }) => call('exec_status', { id, offset, limit })),
  ]
  const pages = (await scripted(d, 'turn-yb-1', [search('exec_status'), ...reads])).slice(1)
  expect(pages[0], 'the tail of the job shows its state').toMatch(/completed|failed|killed|running/)
  expect(pages[0].length, 'the tail is there').toBeGreaterThan(100)
  for (const [i, page] of pages.entries()) {
    expect(page.length, `status call ${i} answered`).toBeGreaterThan(0)
    expect(visiblePiece(page, SECRET_A), `status call ${i} shows a piece of the value:\n${page.slice(0, 600)}`).toBeUndefined()
  }
  expect(leaksOf(SECRET_A), 'the value is on no surface').toEqual([])
  expect(leakedPieces(SECRET_A), 'no piece of the value on any surface, the message about the end of the job included').toEqual([])
})
