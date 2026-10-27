// Real unattended turns, using the same fake clock and daemon lifecycle as wake-turns*.test.ts.
// The stdio peer records actual tool calls; no request leaves this test's processes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  OWNER_CHAT,
  SILENT,
  TEST_TIMEOUT_MS,
  advanceClock,
  asObject,
  deepStrings,
  modelRequests,
  ownerTurn,
  startOwnerDaemon,
  toolNames,
  untilAttempt,
  waitFor,
  wakeFinished,
  world,
} from './test-support/wake-harness.js'
import type { Plan } from './test-support/wake-harness.js'

const READER = 'mcp__outbound__read'
const WRITER = 'mcp__outbound__write'
const MEMORY_FRAGMENT = 'wakePrivateAlpha0123456789_secret'

const SERVER = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const schema = { type: 'object', properties: { text: { type: 'string' } } }
const tools = [
  { name: 'read', description: 'Read external text', inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: 'write', description: 'Write external text', inputSchema: schema },
]
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'outbound', version: '1' } }
  if (method === 'tools/list') result = { tools }
  if (method === 'tools/call') {
    appendFileSync(process.argv[2], JSON.stringify(params) + '\n')
    result = { content: [{ type: 'text', text: params.name === 'read' ? 'OUTSIDE-READ-OK' : 'OUTSIDE-WRITE-OK' }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
})
`

function calls(log: string): Array<Record<string, unknown>> {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => asObject(JSON.parse(line))) : []
}

for (const mode of ['external', 'memory'] as const) {
  test(`test_c5_wakeup_${mode}_mcp_write_follows_only_the_private_data_rule`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const server = join(world.home, 'outbound-server.mjs')
    const log = join(world.home, 'outbound-calls.jsonl')
    writeFileSync(server, SERVER)
    mkdirSync(join(world.dshbotHome, 'memory'), { recursive: true })
    writeFileSync(join(world.dshbotHome, 'memory', 'MEMORY.md'), `before:${MEMORY_FRAGMENT}:after\n`)
    writeFileSync(join(world.dshbotHome, 'mcp.json'), JSON.stringify({ mcpServers: {
      outbound: { command: process.execPath, args: [server, log] },
    } }))
    const d = await startOwnerDaemon({ fakeTask: false })
    // A clean owner call verifies the peer and tool discovery, without poisoning the later wake-up.
    await ownerTurn(d, 'outboundcontrol', (turn) => {
      if (turn.step === 0) return { tool: 'tool_search', input: { query: WRITER } }
      if (turn.step === 1) return { tool: WRITER, input: { text: 'ORDINARY-PUBLIC-WRITE' } }
      return { text: 'pong-outboundcontrol' }
    })
    expect(calls(log).map((call) => call.name)).toEqual(['write'])
    const plan: Plan = (turn) => {
      if (turn.step === 0) return { tool: 'tool_search', input: { query: 'mcp__outbound' } }
      if (mode === 'external' && turn.step === 1) return { tool: READER, input: {} }
      if (turn.step === (mode === 'external' ? 2 : 1)) {
        return { tool: WRITER, input: { text: mode === 'memory' ? `prefix ${MEMORY_FRAGMENT} suffix` : 'PUBLIC-AFTER-READ' } }
      }
      return { text: SILENT }
    }
    world.stub.wake[0] = plan
    const mark = world.timeline.seq
    await untilAttempt(d, 0)
    await waitFor('the unattended write result reaches the model', () =>
      (world.stub.results.get('wake:1')?.length ?? 0) >= (mode === 'external' ? 3 : 2), d)
    await wakeFinished(d, 1)
    const requests = modelRequests('wake').filter((event) => event.tag === '1')
    const outgoing = requests.find((event) => event.step === (mode === 'external' ? 2 : 1))
    expect(outgoing, 'the wake-up really reached its outgoing operation').toBeDefined()
    expect(toolNames(outgoing!.body), 'this is an available tool, not an invented tool name').toContain(WRITER)
    const results = world.stub.results.get('wake:1') ?? []
    if (mode === 'external') {
      expect(results[1]?.text, 'external content reached the wake-up first').toContain('OUTSIDE-READ-OK')
      expect(results[2]?.isError, results[2]?.text).toBe(false)
      expect(results[2]?.text).toContain('OUTSIDE-WRITE-OK')
      expect(calls(log).filter((call) => call.name === 'write'), 'the unattended writer reaches the MCP peer').toHaveLength(2)
    } else {
      const refusal = results[results.length - 1]
      expect(refusal?.isError || /отказ|подтвержд|владел|недоступ|запрещ|denied|refus|approval/i.test(refusal?.text ?? ''), refusal?.text).toBe(true)
      expect(refusal?.text.trim()).toBeTruthy()
      expect(calls(log).filter((call) => call.name === 'write'), 'the private export never reaches the MCP peer').toHaveLength(1)
    }
    const cards = world.timeline.events.filter((event) => event.src === 'tg' && event.n > mark && event.params.chat_id === OWNER_CHAT)
      .flatMap((event) => event.src === 'tg' ? deepStrings(event.params.reply_markup) : [])
      .filter((value) => /^tga1r?:/.test(value))
    expect(cards, 'a wake-up must not leave an approval card in owner chat').toEqual([])
  })
}

// Night turns have an explicit tool restriction already. Exercise a forged outbound call
// through the actual night scheduler, rather than pretending a wake-up is a night turn.
test('test_c6_night_turn_refuses_a_forged_memory_export_without_owner_approval', { timeout: TEST_TIMEOUT_MS }, async () => {
  const server = join(world.home, 'night-outbound-server.mjs')
  const log = join(world.home, 'night-outbound-calls.jsonl')
  writeFileSync(server, SERVER)
  mkdirSync(join(world.dshbotHome, 'memory', 'journal'), { recursive: true })
  writeFileSync(join(world.dshbotHome, 'memory', 'MEMORY.md'), `before:${MEMORY_FRAGMENT}:after\n`)
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(join(world.dshbotHome, 'memory', 'journal', `${day}.md`), `A recent event: ${MEMORY_FRAGMENT}\n`)
  writeFileSync(join(world.dshbotHome, 'mcp.json'), JSON.stringify({ mcpServers: {
    outbound: { command: process.execPath, args: [server, log] },
  } }))
  const target = new Date(Date.now() + 2 * 60_000)
  const at = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`
  world.stub.wake[0] = (turn) => turn.step === 0
    ? { tool: WRITER, input: { text: MEMORY_FRAGMENT } }
    : { text: 'Night export was refused.' }
  const d = await startOwnerDaemon({ fakeTask: false, env: { DSHBOT_DREAM_AT: at, DSHBOT_TZ: 'UTC' } })
  const mark = world.timeline.seq
  await advanceClock(3 * 60_000, d)
  // The shared stub labels any non-owner request as wake; inspect the prompt to prove this is a night.
  await waitFor('the scheduled night turn receives the forged tool result', () => (world.stub.results.get('wake:1')?.length ?? 0) > 0, d)
  const first = modelRequests('wake')[0]
  expect(first, 'the night scheduler really invoked the model').toBeDefined()
  expect(deepStrings(first!.body.messages).join('\n')).toContain('Ночная консолидация памяти')
  const result = world.stub.results.get('wake:1')?.[0]
  expect(result?.isError || /отказ|недоступ|запрещ|denied|refus|not available/i.test(result?.text ?? ''), result?.text).toBe(true)
  expect(calls(log), 'the night never called the external peer').toEqual([])
  const callbacks = world.timeline.events.filter((event) => event.n > mark && event.src === 'tg')
    .flatMap((event) => event.src === 'tg' ? deepStrings(event.params.reply_markup) : [])
    .filter((value) => /^tga1r?:/.test(value))
  expect(callbacks, 'no owner card is drawn for a night turn').toEqual([])
})
