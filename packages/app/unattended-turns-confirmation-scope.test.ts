// A turn without the owner (wake-up, planned run, delegated child) after external content: an ordinary MCP
// tool runs, a destructive one is still refused without a card. Same harness as outbound-unattended-policy.test.ts:
// the real daemon on a fake clock, a stdio MCP peer that records every call it gets.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  OWNER_CHAT,
  SILENT,
  TEST_TIMEOUT_MS,
  asObject,
  deepStrings,
  ownerTurn,
  startOwnerDaemon,
  untilAttempt,
  waitFor,
  wakeFinished,
  world,
} from './test-support/wake-harness.js'
import type { Daemon, JsonObject, Plan, Reply } from './test-support/wake-harness.js'

const READER = 'mcp__scope__read'
const WRITER = 'mcp__scope__write'
const WIPER = 'mcp__scope__wipe'

const SERVER = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const schema = { type: 'object', properties: { text: { type: 'string' } } }
const tools = [
  { name: 'read', description: 'Read external text', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Write external text', inputSchema: schema },
  { name: 'wipe', description: 'Wipe the data', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true } },
]
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'scope', version: '1' } }
  if (method === 'tools/list') result = { tools }
  if (method === 'tools/call') {
    appendFileSync(process.argv[2], JSON.stringify(params) + '\n')
    result = { content: [{ type: 'text', text: params.name === 'read' ? 'OUTSIDE-READ-OK' : 'PEER-DONE-' + params.name }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
})
`

const call = (tool: string, input: JsonObject = {}): Reply => ({ tool, input })
const logPath = (): string => join(world.home, 'scope-calls.jsonl')

function peerCalls(): string[] {
  if (!existsSync(logPath())) return []
  return readFileSync(logPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => String(asObject(JSON.parse(line)).name))
}

function installPeer(): void {
  const server = join(world.home, 'scope-server.mjs')
  writeFileSync(server, SERVER)
  mkdirSync(world.dshbotHome, { recursive: true })
  writeFileSync(join(world.dshbotHome, 'mcp.json'), JSON.stringify({ mcpServers: {
    scope: { command: process.execPath, args: [server, logPath()] },
  } }))
}

/** Approval buttons sent to the owner chat since `mark`. */
function cardButtons(mark: number): string[] {
  return world.timeline.events
    .filter((event) => event.src === 'tg' && event.n > mark && event.params.chat_id === OWNER_CHAT)
    .flatMap((event) => (event.src === 'tg' ? deepStrings(event.params.reply_markup) : []))
    .filter((value) => /^tga1r?:/.test(value))
}

/** External content first, then the ordinary writer, then a quiet end. */
const readThenWrite = (text: string): Plan => (turn) => {
  if (turn.step === 0) return call('tool_search', { query: 'mcp__scope' })
  if (turn.step === 1) return call(READER)
  if (turn.step === 2) return call(WRITER, { text })
  return { text: SILENT }
}

async function untilUnattendedResults(d: Daemon, count: number): Promise<void> {
  await waitFor('the unattended turn gets its tool results', () => (world.stub.results.get('wake:1')?.length ?? 0) >= count, d)
}

test('test_c5_wakeup_turn_runs_an_ordinary_mcp_tool_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  installPeer()
  const d = await startOwnerDaemon({ fakeTask: false })
  world.stub.wake[0] = readThenWrite('WAKE-ORDINARY-WRITE')
  const mark = world.timeline.seq
  await untilAttempt(d, 0)
  await untilUnattendedResults(d, 3)
  await wakeFinished(d, 1)
  const results = world.stub.results.get('wake:1') ?? []
  expect(results[1]?.text, 'external content reached the wake-up first').toContain('OUTSIDE-READ-OK')
  expect(results[2]?.isError, results[2]?.text).toBe(false)
  expect(results[2]?.text).toContain('PEER-DONE-write')
  expect(peerCalls()).toEqual(['read', 'write'])
  expect(cardButtons(mark), 'a wake-up draws no card').toEqual([])
})

test('test_c5_planned_turn_runs_an_ordinary_mcp_tool_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  installPeer()
  const d = await startOwnerDaemon({ fakeTask: false })
  world.stub.wake[0] = readThenWrite('PLANNED-ORDINARY-WRITE')
  const mark = world.timeline.seq
  let jobId = ''
  await ownerTurn(d, 'planjob', (turn) => {
    if (turn.step === 0) return call('tool_search', { query: 'schedule' })
    if (turn.step === 1) return call('schedule', { action: 'create', schedule: 'every 6h', task: 'planned job of the scope test' })
    if (turn.step === 2) {
      jobId = String(asObject(JSON.parse(turn.result?.text ?? '{}')).id ?? '')
      return call('schedule', { action: 'run_now', id: jobId })
    }
    return { text: 'pong-planjob' }
  })
  expect(jobId, 'the planned job was created').not.toBe('')
  await untilUnattendedResults(d, 3)
  const results = world.stub.results.get('wake:1') ?? []
  expect(results[1]?.text, 'external content reached the planned turn first').toContain('OUTSIDE-READ-OK')
  expect(results[2]?.isError, results[2]?.text).toBe(false)
  expect(results[2]?.text).toContain('PEER-DONE-write')
  expect(peerCalls()).toEqual(['read', 'write'])
  expect(cardButtons(mark), 'a planned turn draws no card').toEqual([])
})

test('test_c5_delegated_child_runs_an_ordinary_mcp_tool_after_external_content', { timeout: TEST_TIMEOUT_MS }, async () => {
  installPeer()
  const d = await startOwnerDaemon({ fakeTask: false })
  world.stub.wake[0] = (turn) => {
    if (turn.step === 0) return call(READER)
    if (turn.step === 1) return call(WRITER, { text: 'CHILD-ORDINARY-WRITE' })
    return { text: 'child-report-done' }
  }
  const mark = world.timeline.seq
  await ownerTurn(d, 'kidjob', (turn) => {
    if (turn.step === 0) return call('tool_search', { query: 'delegate subagent' })
    if (turn.step === 1) return call('tool_search', { query: 'mcp__scope' })
    if (turn.step === 2) return call('delegate', { task: 'child task of the scope test', tools: [READER, WRITER] })
    return { text: 'pong-kidjob' }
  })
  const results = world.stub.results.get('wake:1') ?? []
  expect(results[0]?.text, 'external content reached the child first').toContain('OUTSIDE-READ-OK')
  expect(results[1]?.isError, results[1]?.text).toBe(false)
  expect(results[1]?.text).toContain('PEER-DONE-write')
  expect(peerCalls()).toEqual(['read', 'write'])
  expect(cardButtons(mark), 'a child draws no card').toEqual([])
})

test('test_c6_wakeup_turn_still_refuses_a_destructive_mcp_tool_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  installPeer()
  const d = await startOwnerDaemon({ fakeTask: false })
  world.stub.wake[0] = (turn) => {
    if (turn.step === 0) return call('tool_search', { query: 'mcp__scope' })
    if (turn.step === 1) return call(WIPER)
    return { text: SILENT }
  }
  const mark = world.timeline.seq
  await untilAttempt(d, 0)
  await untilUnattendedResults(d, 2)
  await wakeFinished(d, 1)
  const refusal = (world.stub.results.get('wake:1') ?? [])[1]
  expect(refusal?.isError || /отказ|подтвержд|автоном|не вызван|denied|refus/i.test(refusal?.text ?? ''), refusal?.text).toBe(true)
  expect(peerCalls(), 'the destructive tool never reaches the peer').toEqual([])
  expect(cardButtons(mark), 'nobody can press a button in a wake-up').toEqual([])
})
