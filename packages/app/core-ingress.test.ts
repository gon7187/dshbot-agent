// Our ingress/runner/Telegram wiring. External HTTP is fake; daemon and SDK are real.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { expect, test } from 'vitest'
import * as g from './test-support/guest-harness.js'
import { TURN_EVENTS_ON, waitForTurnComplete, turnCompletions } from './test-support/turn-events.js'

type Json = g.JsonObject
const object = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const objects = (v: unknown): Json[] => Array.isArray(v) ? v.map(object) : []
const calls = (): Json[] => g.modelCalls(g.world.timeline).map(c => c.body)
const lastUser = (body: Json): string => g.userTexts(body).filter(Boolean).at(-1) ?? ''
const results = (body: Json): Json[] => objects(body.messages).flatMap(m => objects(m.content)).filter(b => b.type === 'tool_result')
const textOf = (v: unknown): string => typeof v === 'string' ? v : objects(v).map(b => String(b.text ?? '')).join('')
const sent = (text: string): number => g.sentTo(g.world.timeline, g.OWNER_CHAT).filter(e => JSON.stringify(e.params).includes(text)).length
const options = { ...TURN_EVENTS_ON, DSHBOT_DEBOUNCE_MS: '0', DSHBOT_AUTO_SYNC: 'off', DSHBOT_DREAM: 'off' }
async function owner(): Promise<g.Daemon> {
  const d = await g.startDaemon(options)
  await g.pairOwner(d)
  return d
}
function answer(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(g.pongStream(text))
}
interface Step { tool: string; input: Json; id: string }
function script(body: Json, steps: Step[], res: ServerResponse): void {
  const available = objects(body.tools).map(t => String(t.name ?? object(t.function).name ?? ''))
  let next: Step | undefined
  for (const step of steps) {
    if (results(body).some(r => r.tool_use_id === step.id)) continue
    next = available.includes(step.tool) ? step : { tool: 'tool_search', input: { query: step.tool }, id: `load_${step.id}` }
    break
  }
  if (!next) { answer(res, 'OWNER-DONE'); return }
  const stream = [
    g.sse('message_start', { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    g.sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: next.id, name: next.tool, input: {} } }),
    g.sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) } }),
    g.sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    g.sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    g.sse('message_stop', { type: 'message_stop' }),
  ].join('')
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(stream)
}

test('pairing and guest invitation persist; foreign chats do not reach the model', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  let d = await g.startDaemon(options)
  const mark = d.stderr.length
  g.say(g.OWNER_CHAT, 'hello')
  await g.waitFor('initial pairing challenge', () => g.pairingCandidates(d.stderr.slice(mark)).length > 0, d)
  const code = g.pairingCandidates(d.stderr.slice(mark))[0]!
  g.say(g.OWNER_CHAT, 'wrong-code')
  await g.settle()
  expect(calls()).toEqual([])
  g.say(g.OWNER_CHAT, code)
  await g.settle()
  g.say(g.GUEST_B, 'UNAUTHORIZED-PRIVATE')
  g.world.tg.push(g.groupMessage(g.GROUP_CHAT, 'group', g.GUEST_B, 'UNAUTHORIZED-GROUP'))
  await g.ask(d, 'AUTHORIZED-OWNER', g.OWNER_CHAT)
  expect(JSON.stringify(calls())).not.toContain('UNAUTHORIZED-')
  await g.joinGuest(d, g.GUEST_A)
  await g.stopDaemon(d)
  d = await g.startDaemon({ ...options, DSHBOT_GUEST_MIN_INTERVAL_MS: '0' })
  await g.ask(d, 'PERSISTED-OWNER', g.OWNER_CHAT)
  await g.ask(d, 'PERSISTED-GUEST', g.GUEST_A)
  expect(g.callsMentioning(g.world.timeline, 'PERSISTED-OWNER')).not.toHaveLength(0)
  expect(g.callsMentioning(g.world.timeline, 'PERSISTED-GUEST')).not.toHaveLength(0)
})

test('a durable Telegram update produces one real model turn and reply across restart', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  let d = await owner()
  const update = g.privateMessage(g.OWNER_CHAT, 'DURABLE-ORIGINAL')
  const before = turnCompletions(d)
  g.world.tg.push(update)
  await g.waitFor('final reply', () => g.pongsTo(g.world.timeline, g.OWNER_CHAT).length === 1, d)
  await waitForTurnComplete(d, before, 'durable original')
  await g.stopDaemon(d)
  d = await g.startDaemon(options)
  g.world.tg.push(update)
  await g.ask(d, 'AFTER-RESTART', g.OWNER_CHAT)
  await g.settle()
  expect(g.pongsTo(g.world.timeline, g.OWNER_CHAT)).toHaveLength(2)
  const original = calls().filter(c => lastUser(c).includes('DURABLE-ORIGINAL'))
  expect(original).toHaveLength(1)
  expect(g.userTexts(calls().at(-1)!).filter(t => t.includes('DURABLE-ORIGINAL'))).toHaveLength(1)
})

test('owner corrections interrupt the active request in order; stop does not replay it', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  const d = await owner()
  const held = new Map<string, { closed: boolean }>()
  g.world.stub.respond = (body, res) => {
    const user = lastUser(body)
    const tag = user.includes('CORRECT-TWO') ? 'two' : user.includes('CORRECT-ONE') ? 'one' : user.includes('ORIGINAL-WORK') ? 'original' : ''
    if (tag) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      const state = { closed: false }; held.set(tag, state)
      res.on('close', () => { state.closed = true })
    } else answer(res, 'AFTER-STOP-OK')
    return true
  }
  g.say(g.OWNER_CHAT, 'ORIGINAL-WORK investigate the existing task')
  await g.waitFor('original HTTP request', () => held.has('original'), d)
  g.say(g.OWNER_CHAT, 'CORRECT-ONE refine the same task')
  await g.waitFor('first correction resumes', () => held.has('one'), d)
  g.say(g.OWNER_CHAT, 'CORRECT-TWO refine it again')
  await g.waitFor('second correction resumes', () => held.has('two'), d)
  expect(held.get('original')?.closed).toBe(true)
  expect(held.get('one')?.closed).toBe(true)
  const context = JSON.stringify(calls().at(-1)!.messages)
  for (const marker of ['ORIGINAL-WORK', 'CORRECT-ONE', 'CORRECT-TWO']) expect(context.split(marker)).toHaveLength(2)
  expect(context.indexOf('CORRECT-ONE')).toBeLessThan(context.indexOf('CORRECT-TWO'))
  g.say(g.OWNER_CHAT, '/stop')
  await g.waitFor('stopped HTTP request', () => held.get('two')?.closed === true, d)
  const count = calls().length
  g.say(g.OWNER_CHAT, 'AFTER-STOP ordinary new request')
  await g.waitFor('new task reply', () => sent('AFTER-STOP-OK') === 1, d)
  expect(calls()).toHaveLength(count + 1)
})

test('correction cancels current-task background children and preserves older unrelated work', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  const d = await owner()
  const children = new Map<string, { closed: boolean }>()
  const priorSteps: Step[] = [{ tool: 'delegate', input: { task: 'CHILD-HOLD prior-task', tools: [], background: true }, id: 'delegate_prior' }]
  const currentSteps: Step[] = [
    { tool: 'delegate', input: { task: 'CHILD-HOLD current-task', tools: [], background: true }, id: 'delegate_current' },
    { tool: 'delegate_wait', input: { all: true, timeout_sec: 600 }, id: 'wait_current' },
  ]
  g.world.stub.respond = (body, res) => {
    const user = lastUser(body)
    if (user.includes('CHILD-HOLD')) {
      const key = user.includes('prior-task') ? 'prior' : 'current'
      const child = { closed: false }; children.set(key, child)
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      res.on('close', () => { child.closed = true })
    } else if (user.includes('OWNER-CORRECTION')) answer(res, 'CORRECTION-DONE')
    else if (user.includes('OWNER-CURRENT')) script(body, currentSteps, res)
    else if (user.includes('OWNER-START')) script(body, priorSteps, res)
    else answer(res, '[SILENT]')
    return true
  }
  g.say(g.OWNER_CHAT, 'OWNER-START start independent work')
  await g.waitFor('older child and completed parent', () => children.has('prior') && sent('OWNER-DONE') === 1, d)
  g.say(g.OWNER_CHAT, 'OWNER-CURRENT continue parallel work')
  await g.waitFor('current child and waiting parent', () => children.has('current') && calls().some(c => results(c).some(r => r.tool_use_id === 'delegate_current')), d)
  const id = (tool: string): string => textOf(calls().flatMap(results).find(r => r.tool_use_id === tool)?.content).match(/bg-[a-z0-9-]+/)?.[0] ?? ''
  const prior = id('delegate_prior'), current = id('delegate_current')
  expect(prior).not.toBe(''); expect(current).not.toBe('')
  g.say(g.OWNER_CHAT, 'OWNER-CORRECTION change the current task')
  await g.waitFor('correction delivered and current child cancelled', () => sent('CORRECTION-DONE') === 1 && children.get('current')?.closed === true, d)
  expect(children.get('prior')?.closed).toBe(false)
  const corrected = calls().filter(c => lastUser(c).includes('OWNER-CORRECTION'))
  expect(corrected).toHaveLength(1)
  expect(lastUser(corrected[0]!)).toContain(prior)
  expect(lastUser(corrected[0]!)).toContain(current)
})

test('provider failure cannot replay the previous answer and the next request succeeds', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  const d = await owner()
  const beforeFirst = turnCompletions(d)
  await g.ask(d, 'FIRST-SUCCESS', g.OWNER_CHAT)
  await waitForTurnComplete(d, beforeFirst, 'first successful turn')
  const before = turnCompletions(d)
  g.world.stub.respond = (body, res) => {
    if (!lastUser(body).includes('PROVIDER-FAILURE')) return false
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture provider refusal' } }))
    return true
  }
  g.say(g.OWNER_CHAT, 'PROVIDER-FAILURE')
  await waitForTurnComplete(d, before, 'provider refusal')
  expect(g.pongsTo(g.world.timeline, g.OWNER_CHAT)).toHaveLength(1)
  await g.ask(d, 'RECOVERY-SUCCESS', g.OWNER_CHAT)
  expect(g.pongsTo(g.world.timeline, g.OWNER_CHAT)).toHaveLength(2)
  const surfaces = g.output(d) + JSON.stringify(g.world.timeline.events)
  expect(surfaces).not.toContain(g.DEEPSEEK_KEY)
  expect(surfaces).not.toContain(g.BOT_TOKEN)
})


test('container daemon answers and nested exec writes only its allowed workspace', { timeout: g.TEST_TIMEOUT_MS }, async () => {
  const workspace = join(g.world.dshbotHome, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const d = await g.startDaemon({ ...options, DSHBOT_ISOLATION: 'container' })
  await g.pairOwner(d)
  await g.ask(d, 'CONTAINER-PING', g.OWNER_CHAT)
  const target = join(workspace, 'written.txt')
  const forbidden = join(g.world.dshbotHome, 'outside-workspace.txt')
  const command = `printf ws-ok > '${target}'; printf forbidden > '${forbidden}' 2>/dev/null; printf 'EXEC-UID=%s\\n' "$(id -u)"; printf 'NESTED-EXEC-DONE\\n'`
  g.world.stub.respond = (body, res) => {
    if (!lastUser(body).includes('CONTAINER-EXEC')) return false
    script(body, [{ tool: 'exec', input: { command }, id: 'nested_exec' }], res)
    return true
  }
  g.say(g.OWNER_CHAT, 'CONTAINER-EXEC')
  await g.waitFor('nested execution final answer', () => sent('OWNER-DONE') === 1, d)
  const result = textOf(calls().flatMap(results).find(r => r.tool_use_id === 'nested_exec')?.content)
  expect(result).toContain('NESTED-EXEC-DONE')
  expect(result).toContain('EXEC-UID=0')
  expect(readFileSync(target, 'utf8')).toBe('ws-ok')
  expect(existsSync(forbidden)).toBe(false)
})
