// Wake-ups of the bot: the wake-up turn itself, its usage records and the shape of the tool set.
// The harness (fake Telegram, DeepSeek stub, fake clock, daemon) lives in test-support/wake-harness.ts.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { expect, test } from 'vitest'

import {
  TEST_TIMEOUT_MS,
  SILENT,
  OWNER_CHAT,
  OWNER_PREFIX,
  advanceClock,
  asObject,
  callThenText,
  everythingSentByTheBot,
  firstWakeSets,
  flatten,
  hasToolResult,
  messagesOf,
  modelRequests,
  ownerTexts,
  ownerTurn,
  readUsage,
  sleep,
  startOwnerDaemon,
  stateTables,
  stopDaemon,
  taskRuns,
  toolNames,
  untilAttempt,
  waitFor,
  wakeAttempts,
  wakeFinished,
  wakeUsageInFiles,
  wakeUsageInState,
  world,
} from './test-support/wake-harness.js'
import type { Daemon, DsEvent } from './test-support/wake-harness.js'

test('test_wake_due_wakeup_runs_a_main_turn_with_the_wake_prompt_and_a_silent_answer_is_not_sent', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ownerTurn(d, 'first')
  const ownerRequest = modelRequests('owner')[0] as DsEvent
  const sentBefore = ownerTexts().length

  world.stub.wake[0] = () => ({ text: SILENT })
  expect(wakeAttempts(), 'no wake-up before the clock moved').toBe(0)
  await untilAttempt(d, 0)
  await wakeFinished(d, 1)

  const wake = modelRequests('wake')[0] as DsEvent
  expect(wake, 'the wake-up asks the model').toBeDefined()
  const userTexts = messagesOf(wake.body)
    .filter((m) => m.role === 'user' && !hasToolResult(m))
    .map((m) => flatten(m.content))
  const prompt = userTexts[userTexts.length - 1] ?? ''
  expect(prompt, 'the wake-up prompt says nobody asked').toMatch(/никто не просил|nobody asked|no one asked/i)
  expect(prompt, 'the wake-up prompt says a pause is a legitimate decision').toMatch(/пауз|pause/i)
  expect(prompt, 'the wake-up prompt is not an owner message').not.toMatch(OWNER_PREFIX)

  // an ordinary turn of main: the history of the owner is in the request and the persona prefix is the same
  expect(userTexts.join('\n'), 'the turn runs in the session main with the owner history').toContain('own-first')
  expect(JSON.stringify(wake.body.system ?? null), 'the same system prompt as the owner turn').toBe(
    JSON.stringify(ownerRequest.body.system ?? null),
  )

  expect(ownerTexts().length, 'a [SILENT] answer is not sent to the owner').toBe(sentBefore)
  expect(everythingSentByTheBot(), 'no [SILENT] marker leaves the bot').not.toContain(SILENT)
})

test('test_wake_a_spoken_answer_of_the_wakeup_reaches_the_owner_at_the_default_level', { timeout: TEST_TIMEOUT_MS }, async () => {
  // The default quiet hours depend on the wall clock of the run; this test is
  // about delivery, so it takes the night out of the equation.
  const d = await startOwnerDaemon({ env: { DSHBOT_QUIET_HOURS: '' } })
  world.stub.wake[0] = () => ({ text: 'WAKE-IDEA-7 есть мысль для владельца' })
  await untilAttempt(d, 0)
  await waitFor('the spoken answer of the wake-up in the owner chat', () => ownerTexts().some((t) => t.includes('WAKE-IDEA-7')), d)
})

test('test_usage_wake_model_calls_are_recorded_with_the_wake_label', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ownerTurn(d, 'u1')
  world.stub.wake[0] = callThenText({ wakeup: 30 }, SILENT)
  await untilAttempt(d, 0)
  await wakeFinished(d, 1)
  await stopDaemon(d)

  const wakeRequests = modelRequests('wake').length
  expect(wakeRequests, 'the wake-up made model calls').toBeGreaterThan(0)
  // both ways of reading the label: the usage rows of state.db and the usage files under DSHBOT_HOME
  const labelled = wakeUsageInState() + wakeUsageInFiles()
  expect(labelled, 'usage carries records labelled as wake-up calls').toBeGreaterThan(0)
  const usage = readUsage()
  expect(usage.tableWake + usage.kvWake, 'usage carries a record labelled wake').toBeGreaterThan(0)
  if (usage.tableWake > 0) {
    expect(usage.tableWake, 'only the calls of the wake-up carry the label').toBeLessThanOrEqual(wakeRequests)
  }
})

test('test_h1_the_wake_package_has_no_task_tool_of_its_own_and_no_wake_tasks_table', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon({ fakeTask: false })
  await ownerTurn(d, 'h1')
  world.stub.wake[0] = () => ({ text: SILENT })
  await untilAttempt(d, 0)
  await wakeFinished(d, 1)
  await stopDaemon(d)

  for (const request of [...modelRequests('owner'), ...modelRequests('wake')]) {
    const names = toolNames(request.body)
    expect(names, 'the wake tool is offered to every turn').toContain('set_next_wakeup')
    expect(
      names.filter((name) => /wake/i.test(name)),
      'the only wake tool is set_next_wakeup',
    ).toEqual(['set_next_wakeup'])
    for (const tool of Array.isArray(request.body.tools) ? request.body.tools : []) {
      const found = asObject(tool)
      if (found.name !== 'task') continue
      expect(String(found.description), 'a task tool must not be the one of the wake-ups').not.toMatch(/wake|пробужд/i)
    }
  }
  expect(stateTables(), 'no dead-end wake_tasks table').not.toContain('wake_tasks')
})

// --- a wake-up message that Telegram refused is not a message the owner got ------------------------------

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** Telegram refuses every message whose text carries `marker`, as it does for a chat that blocked the bot. */
function refuseMessagesWith(marker: string): void {
  const server = world.tg.server
  const handlers = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>
  server.removeAllListeners('request')
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (/\/send(?:Rich)?Message$/.test((req.url ?? '').split('?')[0] ?? '')) {
      // The fake answers a send in the same tick as it logs it: the last event is this request.
      // The head waits for the body: end() writes it with the status of the verdict.
      const writeHead = res.writeHead.bind(res)
      const end = res.end.bind(res) as (body?: string) => ServerResponse
      res.writeHead = (() => res) as unknown as ServerResponse['writeHead']
      res.end = ((body?: string) => {
        const event = world.timeline.events[world.timeline.events.length - 1]
        const refused = event !== undefined && JSON.stringify(event).includes(marker)
        res.writeHead = writeHead
        writeHead(refused ? 403 : 200, { 'content-type': 'application/json' })
        return end(refused ? JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) : body)
      }) as ServerResponse['end']
    }
    for (const handler of handlers) handler(req, res)
  })
}

function scriptWakes(replies: string[]): void {
  for (let slot = 0; slot < 40; slot += 1) world.stub.wake[slot] = () => ({ text: replies[slot] ?? SILENT })
}

/** The text of the wake-up turn as the model saw it: everything after the last assistant message. */
function wakeTail(attempt: number): string {
  const request = modelRequests('wake').find((e) => e.tag === String(attempt) && e.step === 0)
  expect(request, `the model was asked for wake-up ${attempt}`).toBeDefined()
  const messages = messagesOf(request?.body ?? {})
  const from = messages.map((m) => m.role).lastIndexOf('assistant') + 1
  return messages
    .slice(from)
    .filter((m) => m.role === 'user')
    .map((m) => flatten(m.content))
    .join('\n')
}

function silenceLines(text: string): string[] {
  return text.split('\n').filter((line) => /молч/i.test(line) && /\d/.test(line))
}

async function nextWake(d: Daemon, minutes = 61): Promise<number> {
  const before = wakeAttempts()
  await untilAttempt(d, before, minutes)
  await wakeFinished(d, before + 1)
  return before + 1
}

/** Moves the fake clock to an hour before the next 12:00 UTC (the zone of the owner here), at least 6 h ahead. */
async function toAnHourBeforeNoon(d: Daemon): Promise<void> {
  const now = Date.now() + world.clock.total
  let noon = Math.floor(now / DAY_MS) * DAY_MS + 12 * HOUR_MS
  while (noon < now + 6 * HOUR_MS) noon += DAY_MS
  await advanceClock(noon - HOUR_MS - now, d)
  await sleep(300)
}

test('test_c2_a_refused_wake_up_message_does_not_reset_the_time_of_the_last_initiative', { timeout: TEST_TIMEOUT_MS }, async () => {
  scriptWakes(['WAKE-REACHED-FIRST', 'TG-REFUSED-SECOND'])
  const d = await startOwnerDaemon({ env: { DSHBOT_QUIET_HOURS: '', DSHBOT_TZ: 'UTC', DSHBOT_WAKE_JITTER: '0', DSHBOT_FREE_WAKE_CHANCE: '0' } })
  refuseMessagesWith('TG-REFUSED')
  expect(await nextWake(d, 250)).toBe(1)
  await waitFor('the first wake-up message to reach the owner', () => ownerTexts().some((t) => t.includes('WAKE-REACHED-FIRST')), d)

  // a day later the bot speaks again, but Telegram refuses the message
  await advanceClock(21 * HOUR_MS, d)
  await sleep(300)
  expect(await nextWake(d)).toBe(2)
  expect(
    world.timeline.events.some((e) => e.src === 'tg' && JSON.stringify(e).includes('TG-REFUSED-SECOND')),
    'the second wake-up tried to write to the owner',
  ).toBe(true)

  for (let silent = 0; silent < 6; silent += 1) await nextWake(d)
  const ninth = await nextWake(d)
  expect(ninth).toBe(9)
  const lines = silenceLines(wakeTail(ninth))
  expect(lines.length, 'the last message the owner got is over 20 hours old: the line about the silence is there').toBeGreaterThan(0)
  expect(lines.some((line) => /\b6\b/.test(line)), `the line counts six wake-ups: ${lines.join(' | ')}`).toBe(true)
})

test('test_c7_refused_wake_up_messages_do_not_spend_the_daily_limit', { timeout: TEST_TIMEOUT_MS }, async () => {
  scriptWakes(['TG-REFUSED-ONE', 'TG-REFUSED-TWO', 'LIMIT-REACHED-THREE', 'LIMIT-OVER-FOUR'])
  const d = await startOwnerDaemon({ env: { DSHBOT_QUIET_HOURS: '', DSHBOT_TZ: 'UTC', DSHBOT_PROACTIVE_PER_DAY: '1', DSHBOT_WAKE_JITTER: '0', DSHBOT_FREE_WAKE_CHANCE: '0' } })
  refuseMessagesWith('TG-REFUSED')
  await toAnHourBeforeNoon(d)

  expect(await nextWake(d)).toBe(1)
  expect(await nextWake(d)).toBe(2)
  expect(
    world.timeline.events.filter((e) => e.src === 'tg' && /TG-REFUSED-(?:ONE|TWO)/.test(JSON.stringify(e))).length,
    'both refused wake-ups tried to write to the owner',
  ).toBeGreaterThanOrEqual(2)

  // nothing reached the owner yet: the single message of the day is still there
  expect(await nextWake(d)).toBe(3)
  await waitFor('the third wake-up message to reach the owner', () => ownerTexts().some((t) => t.includes('LIMIT-REACHED-THREE')), d)

  // and the delivered one spent it
  expect(await nextWake(d)).toBe(4)
  expect(everythingSentByTheBot(), 'the limit of one delivered message holds').not.toContain('LIMIT-OVER-FOUR')
})

test('test_h3_wake_tools_and_the_self_rewrite_tools_share_one_tool_set', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await ownerTurn(d, 'h3')
  world.stub.wake[0] = () => ({ text: SILENT })
  await untilAttempt(d, 0)
  await wakeFinished(d, 1)

  for (const request of [...modelRequests('owner'), ...modelRequests('wake')]) {
    const names = toolNames(request.body)
    for (const wanted of ['set_next_wakeup', 'self_change', 'self_submit']) {
      expect(names, `${wanted} is in the tool set of the ${request.kind} turn`).toContain(wanted)
    }
  }
})
