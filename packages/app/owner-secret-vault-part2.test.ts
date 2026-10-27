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

test('test_c2_value_message_reaches_no_history_journal_recall_export_or_model_request', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'DEPLOYKEY', WORD_VALUE)
  await sleep(1_000)

  // an ordinary turn after the secret: recall and the search of sessions find nothing of the value
  world.stub.scripts.set('turn-sv-1', [
    search('session_search'),
    call('session_search', { query: 'zebrawolf' }),
    search('recall'),
    call('recall', { query: 'zebrawolf' }),
  ])
  const calls = await ownerTurn(d, 'turn-sv-1')
  const hits = calls.slice(1).map(lastResultText)
  expect(hits.join('\n').length, 'the searches really answered').toBeGreaterThan(0)
  for (const hit of hits) expect(hit, 'recall and the search of sessions find no trace of the value').not.toContain('48Qm7xLpVt29')

  // the history of the session as the owner can export it
  await exportHistory(d)

  expectNoLeak(WORD_VALUE, 'the value message')
})
test('test_c4_invalid_name_is_an_error_and_the_next_message_is_handled_as_usual', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const bad = ['lower', 'BAD-NAME', 'A'.repeat(65), 'ИМЯ']
  for (const [i, name] of bad.entries()) {
    const marker = `turn-sn-${i + 1}`
    const mark = world.timeline.seq
    say(OWNER_CHAT, `/secret ${name}`)
    await waitFor(`an error for the name ${name}`, () => sentTo(world.timeline, OWNER_CHAT).some((e) => e.n > mark), d)
    // the bot is not waiting for a value: this message is an ordinary one and reaches the model
    await ownerTurn(d, marker, ` ${SECRET_A}`)
    expect(textsSince(mark, OWNER_CHAT), 'the value never comes back').not.toContain(SECRET_A)
    expect(secretFiles().filter((file) => file.text.includes(SECRET_A)), `nothing was stored after the name ${name}`).toEqual([])
  }
  expect(secretNamed('lower'), 'no file for the lowercase name').toBeUndefined()
  expect(secretNamed('A'.repeat(65)), 'no file for the name of 65 characters').toBeUndefined()

  // the longest valid name still works
  const longest = 'A'.repeat(64)
  await saveSecret(d, longest, API_VALUE)
  expect(valueOf(secretNamed(longest))).toBe(API_VALUE)
})
test('test_c4_five_minutes_without_a_value_end_the_wait_but_four_do_not', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon(true)
  const advance = async (minutes: number): Promise<void> => {
    for (let step = 0; step < minutes; step += 1) {
      world.clock.total += 60_000
      writeClock(world.clock, true)
      const seq = world.clock.seq
      await waitFor('the fake clock of the daemon to acknowledge', () => readAck(world.clock) >= seq || d.exited, d)
      await sleep(250)
    }
    expect(d.exited, `daemon exited while the clock moved\n${output(d)}`).toBe(false)
  }

  // four minutes are still inside the wait
  say(OWNER_CHAT, '/secret EARLYKEY')
  await sleep(700)
  await advance(4)
  say(OWNER_CHAT, API_VALUE)
  await waitFor('the value sent after four minutes to be stored', () => valueOf(secretNamed('EARLYKEY')) === API_VALUE, d)

  // after five minutes the wait is over and the message is an ordinary one
  say(OWNER_CHAT, '/secret LATEKEY')
  await sleep(700)
  await advance(6)
  await ownerTurn(d, 'turn-ct-1', ` ${SECRET_A}`)
  expect(secretNamed('LATEKEY'), 'the expired secret has no file').toBeUndefined()
  expect(secretFiles().filter((file) => file.text.includes(SECRET_A)), 'the late message was not stored').toEqual([])
  expect(turnCalls('turn-ct-1').length, 'the model got the late message').toBeGreaterThan(0)
})
test('test_c6_exec_gets_secrets_by_name_as_environment_and_the_output_is_scrubbed_for_the_model', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await saveSecret(d, 'DEPLOYKEY', SECRET_A)
  const sha = shaOf(SECRET_A)

  const command =
    'echo "len=${#DEPLOYKEY}"; printf "%s" "$DEPLOYKEY" | sha256sum | cut -c1-16; echo "out=$DEPLOYKEY"; printf "err=%s\\n" "$DEPLOYKEY" >&2'
  world.stub.scripts.set('turn-ce-1', [
    call('exec', { command, secrets: ['DEPLOYKEY'] }),
    call('exec', { command: 'echo "without=${DEPLOYKEY:-none}"' }),
  ])
  const calls = await ownerTurn(d, 'turn-ce-1')

  const first = calls[0] as DsEvent
  const execTool = toolsOf(first.body).find((tool) => tool.name === 'exec')
  expect(JSON.stringify(execTool ?? {}), 'the exec tool offers the parameter secrets').toContain('"secrets"')
  const seen = JSON.stringify(first.body)
  expect(seen, 'the model sees the names of the available secrets').toContain('DEPLOYKEY')
  expect(seen, 'the model never sees a value').not.toContain(SECRET_A)

  const withSecret = lastResultText(calls[1] as DsEvent)
  expect(withSecret, 'the command saw the variable with the right length').toContain(`len=${SECRET_A.length}`)
  expect(withSecret, 'the command saw exactly the value of the secret').toContain(sha)
  expect(withSecret, 'the output of stdout is kept apart from the value').toContain('out=')
  expect(withSecret, 'the output of stderr is kept apart from the value').toContain('err=')
  expect(visiblePiece(withSecret, SECRET_A), 'no piece of the value reaches the model').toBeUndefined()

  const without = lastResultText(calls[2] as DsEvent)
  expect(without, 'a secret that was not asked for is not in the environment').toContain('without=none')

  expectNoLeak(SECRET_A, 'exec with a secret')
  expect(leakedPieces(SECRET_A), 'no piece of the value on any surface').toEqual([])
})
test('test_c9_deleted_secret_stays_scrubbed_from_results_tools_report_and_journal_while_the_server_lives', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startServersWithSecret()
  await expectOldValueScrubbed(d, 'ca')

  const launched = launchesOf(STDIO_SERVER).length
  await commandReply(d, '/unsecret APITOKEN')
  await waitFor('the secret to be removed', () => secretNamed('APITOKEN') === undefined, d)
  expect(
    launchesOf(STDIO_SERVER).length,
    'the removal does not restart the server: its process keeps the old value',
  ).toBe(launched)

  await expectOldValueScrubbed(d, 'cb')
})
test('test_h1_a_tool_that_quotes_a_secret_is_offered_masked_and_a_tool_with_it_in_the_name_is_hidden', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.sse = await startSse()
  const d0 = await startOwnerDaemon()
  const d = await restartWithMcp(
    d0,
    { APITOKEN: API_VALUE },
    { [SSE_SERVER]: { type: 'sse', url: `${world.sse.origin}/sse`, headers: { Authorization: 'Bearer ${secret:APITOKEN}' } } },
  )
  await waitFor('the SSE server to be reached', () => (world.sse?.streams ?? 0) > 0, d)
  await sleep(2_000)

  const check = async (tag: string): Promise<void> => {
    const results = await scripted(d, `turn-${tag}-1`, [
      search(QUOTE),
      call(QUOTE, { text: 'x' }),
      // the descriptions of the two hidden tools say "credential"
      search('credential'),
    ])
    expect(results[1], 'the quoting tool is offered and can be called').toContain('QUOTE:')
    expect(results[2], 'the tools with the value in the name or in a key of the schema cannot be found').not.toContain('A tool whose')
    const offered = turnCalls(`turn-${tag}-1`)
      .flatMap((c) => toolsOf(c.body))
      .find((tool) => tool.name === QUOTE)
    expect(offered, `the tool ${QUOTE} is offered to the model although it quotes the secret`).toBeDefined()
    const text = JSON.stringify(offered)
    expect(text, 'the description and the schema of the offered tool keep no value').not.toContain(API_VALUE)
    expect(text, 'the schema keeps its property').toContain('"text"')
    for (const request of world.timeline.events) {
      if (request.src !== 'ds') continue
      const body = JSON.stringify(request.body)
      expect(body, 'the tool with the value in its name is neither offered nor listed').not.toContain('peek_')
      expect(body, 'the tool with the value in a key of its schema is neither offered nor listed').not.toContain(`${SSE_SERVER}__keyed`)
      expect(body, 'the hidden tools are not described to the model').not.toContain('A tool whose')
    }
    const report = await commandReply(d, '/mcp')
    expect(report, 'the report lists the server').toContain(SSE_SERVER)
    expect(report, 'a hidden tool is a problem of its server that names the secret and not its value').toContain('APITOKEN')
    expect(report).not.toContain(API_VALUE)
    expect(report, 'the report does not list the hidden tools by their names').not.toContain('peek_')
    expectNoLeak(API_VALUE, 'a tool that quotes a secret')
  }

  await check('ha')
  await commandReply(d, '/unsecret APITOKEN')
  await waitFor('the secret to be removed', () => secretNamed('APITOKEN') === undefined, d)
  await check('hb')
})
test('test_c10_background_exec_replaced_secret_is_scrubbed_in_every_status_window_tail_and_end_message', { timeout: TEST_TIMEOUT_MS }, async () => {
  await backgroundJobKeepsTheOldValueScrubbed('replace')
})
