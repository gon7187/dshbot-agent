import { mkdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'
import { GroupRegistry } from './src/groups.js'
import {
  GROUP_CHAT,
  OWNER_CHAT,
  SUPERGROUP_CHAT,
  deepStrings,
  groupMessage,
  parseObject,
  pongMessage,
  pongStream,
  privateMessage,
  readBody,
  sentTo,
  startDaemon,
  waitFor,
  world,
  type Daemon,
  type Event,
  type JsonObject,
} from './test-support/guest-harness.js'
import { TURN_COMPLETE_RE, TURN_EVENTS_ON, turnCompletions } from './test-support/turn-events.js'

// Use the existing daemon fixtures, including their lifecycle hooks. Seed the
// same owner key as turn-completion-signal.test.ts so pairing is outside these
// checks. All HTTP traffic stays on the two local fake API servers.
beforeEach(() => {
  mkdirSync(join(world.dshbotHome, 'workspace'), { recursive: true })
  mkdirSync(join(world.dshbotHome, 'app'), { recursive: true })
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    store.kv.set('telegram.owner_chat_id', String(OWNER_CHAT))
    new GroupRegistry(store).allow(GROUP_CHAT, Date.now())
  } finally {
    store.close()
  }
})

function ingressPending(): string[] {
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    return store.ingress.pending().map((row) => row.externalId)
  } finally {
    store.close()
  }
}

function reply(res: ServerResponse, body: JsonObject, text = 'pong'): void {
  const streamed = body.stream !== false
  res.writeHead(200, { 'content-type': streamed ? 'text/event-stream' : 'application/json' })
  // Both existing fixtures contain exactly one text block whose value is pong.
  res.end((streamed ? pongStream() : pongMessage()).replace('"text":"pong"', `"text":${JSON.stringify(text)}`))
}

function completedUpdateIds(d: Daemon): number[] {
  // The marker's spelling is not significant; the event must identify the
  // update and describe completion, rather than receipt by the poller.
  return `${d.stdout}\n${d.stderr}`.split('\n').flatMap((line) => {
    if (!/test:\S*(?:complete|processed|handled)/.test(line)) return []
    const id = /\bupdate_id["']?\s*[=:]\s*(\d+)/.exec(line)?.[1]
    return id === undefined ? [] : [Number(id)]
  })
}

function observeTurnDeliveries(d: Daemon): Event[][] {
  const deliveries: Event[][] = []
  for (const stream of [d.child.stdout, d.child.stderr]) {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (TURN_COMPLETE_RE.test(line)) deliveries.push(world.timeline.events.slice())
      }
    })
  }
  return deliveries
}

const daemonEnv = {
  ...TURN_EVENTS_ON,
  DSHBOT_DREAM_AT: 'off',
  DSHBOT_AUTONOMY: 'observe',
  DSHBOT_DEBOUNCE_MS: '0',
  DSHBOT_GUEST_MIN_INTERVAL_MS: '0',
}

test('test_h1_each_ignored_update_completes_after_worker_processing_even_without_a_turn', { timeout: 80_000 }, async () => {
  let held: { body: JsonObject; res: ServerResponse } | undefined
  let modelCalls = 0
  world.stub.server.removeAllListeners('request')
  world.stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      modelCalls += 1
      held = { body, res }
    })
  })
  const d = await startDaemon(daemonEnv)
  const owner = privateMessage(OWNER_CHAT, 'hold the worker for the update completion check')
  world.tg.push(owner)
  await waitFor('the owner model request to hold the ingress worker', () => held !== undefined, d)

  const unmentioned = groupMessage(GROUP_CHAT, 'group', 5550011, 'UNMENTIONED-COMPLETION-CHECK')
  const forbidden = groupMessage(SUPERGROUP_CHAT, 'supergroup', 5550012, '@dshbot_test_bot FORBIDDEN-COMPLETION-CHECK')
  const message = forbidden.message as JsonObject
  message.entities = [{ type: 'mention', offset: 0, length: '@dshbot_test_bot'.length }]
  const ignoredIds = [Number(unmentioned.update_id), Number(forbidden.update_id)]
  const polls = world.tg.polls
  world.tg.push(unmentioned)
  world.tg.push(forbidden)

  // This is deliberately NOT the completion barrier: demonstrate that polling
  // has advanced while both updates are still waiting behind the owner turn.
  await waitFor('both ignored updates to be durable while polling continues', () =>
    world.tg.polls > polls && ignoredIds.every((id) => ingressPending().includes(String(id))), d)
  expect(completedUpdateIds(d).filter((id) => ignoredIds.includes(id)),
    'receipt by getUpdates must not be reported as completion of worker processing').toEqual([])
  expect(held, 'the worker is actually blocked in the local model fixture').toBeDefined()
  reply(held!.res, held!.body)

  // First verify the old code really traversed the two no-turn paths. A missing
  // test event then fails an assertion, not fixture startup or a missing import.
  await waitFor('the worker to finish both ignored ingress rows', () =>
    ignoredIds.every((id) => !ingressPending().includes(String(id))), d)
  await waitFor('a completion event carrying each ignored update_id', () =>
    ignoredIds.every((id) => completedUpdateIds(d).includes(id)), d, 30_000)
  for (const id of ignoredIds) {
    expect(completedUpdateIds(d).filter((value) => value === id), `one completion for update_id=${id}`).toHaveLength(1)
  }
  expect(modelCalls, 'neither an unmentioned allowed group nor a forbidden group opens a model turn').toBe(1)
  expect(sentTo(world.timeline, GROUP_CHAT), 'the unmentioned update stays unanswered after processing').toEqual([])
  expect(sentTo(world.timeline, SUPERGROUP_CHAT), 'the forbidden update stays unanswered after processing').toEqual([])
})

test('test_h1_promised_work_continuation_has_one_completion_after_the_final_delivery', { timeout: 80_000 }, async () => {
  let calls = 0
  let continuation: { body: JsonObject; res: ServerResponse } | undefined
  world.stub.server.removeAllListeners('request')
  world.stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      calls += 1
      if (calls === 1) reply(res, body, 'Принято, сделаю позже')
      else continuation = { body, res }
    })
  })
  const d = await startDaemon(daemonEnv)
  const before = turnCompletions(d)
  const deliveries = observeTurnDeliveries(d)
  const update = privateMessage(OWNER_CHAT, 'выполни работу PROMISE-COMPLETION-CHECK')
  world.tg.push(update)
  await waitFor('the promised-work nudge to actually ask the model again', () => continuation !== undefined, d)
  expect(turnCompletions(d), 'withMainTurn returning for the promise does not complete the logical owner turn').toBe(before)
  expect(continuation).toBeDefined()
  reply(continuation!.res, continuation!.body, 'Готово PROMISE-COMPLETION-RESULT')

  await waitFor('the completed owner turn event', () => turnCompletions(d) > before, d)
  // Snapshot in the pipe callback: polling later must not hide a send that
  // arrived after an incorrectly early completion event.
  const delivered = deliveries[0] ?? []
  expect(delivered.some((event) => event.src === 'tg' &&
    ['sendMessage', 'sendRichMessage'].includes(event.method) && event.params.chat_id === OWNER_CHAT &&
    deepStrings(event.params).join('\n').includes('PROMISE-COMPLETION-RESULT')),
  'the event is a barrier for the final reply of the continuation').toBe(true)
  const messageId = (update.message as JsonObject).message_id
  expect(delivered.some((event) => event.src === 'tg' && event.method === 'setMessageReaction' &&
    event.params.message_id === messageId && deepStrings(event.params.reaction).includes('🎉')),
  'the event is a barrier for the final Telegram reaction as well').toBe(true)
  expect(calls, 'the promise is corrected exactly once').toBe(2)
  expect(turnCompletions(d), 'both withMainTurn invocations belong to a single completion').toBe(before + 1)
})
