// exec, exec_write and host_exec are local: a quote from the private memory in their arguments draws no card and
// no refusal (also in a turn without the owner). What stays: the canary of the memory snapshot is refused without a
// card, an exact vault value draws a card, a destructive exec command draws a card, and the other outgoing tools
// (here an MCP writer; web_fetch, browser and mail are covered by outbound-content-policy.test.ts) still hold a
// quote of the memory behind a card, or a refusal when nobody can answer it.
// Real daemon on the shared wake harness: the stub plays the model, the stdio MCP peer records what reaches it.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { sandboxProfile } from '../tools-exec/src/index.js'
import {
  OWNER_CHAT,
  SILENT,
  TEST_TIMEOUT_MS,
  asObject,
  deepStrings,
  modelRequests,
  ownerTexts,
  say,
  startOwnerDaemon,
  untilAttempt,
  waitFor,
  wakeFinished,
  world,
} from './test-support/wake-harness.js'
import type { Daemon, JsonObject, Plan, Reply, ToolResult } from './test-support/wake-harness.js'

const WRITER = 'mcp__fragpeer__write'
const MEMORY_FRAGMENT = 'execMemoryAlpha0123456789_private'
const USER_FRAGMENT = 'execUserBravo0123456789_private_x'
const IDENTITY_FRAGMENT = 'execIdentityDelta0123456789_priva'
const KNOWLEDGE_FRAGMENT = 'execKnowledgeFox0123456789_secret'
const VAULT_VALUE = 'vault-Z9!q' // shorter than 32: a vault value has no fragment-length exemption
const FRAGMENTS = [MEMORY_FRAGMENT, USER_FRAGMENT, IDENTITY_FRAGMENT, KNOWLEDGE_FRAGMENT]

const SERVER = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const schema = { type: 'object', properties: { text: { type: 'string' } } }
const tools = [{ name: 'write', description: 'Write external text', inputSchema: schema }]
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fragpeer', version: '1' } }
  if (method === 'tools/list') result = { tools }
  if (method === 'tools/call') {
    appendFileSync(process.argv[2], JSON.stringify(params) + '\n')
    result = { content: [{ type: 'text', text: 'PEER-DONE-' + params.name }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
})
`

function sandboxWorks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'exec-fragments-sandbox-probe-'))
  try {
    const profile = sandboxProfile({ home: directory, workspace: directory, roPaths: [] })
    const probe = spawnSync(profile[0]!, [...profile.slice(1), '/bin/true'], { timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const sandboxAvailable = sandboxWorks()

const call = (tool: string, input: JsonObject = {}): Reply => ({ tool, input })
const logPath = (): string => join(world.home, 'fragpeer-calls.jsonl')
function peerWrites(): JsonObject[] {
  return existsSync(logPath())
    ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map((line) => asObject(JSON.parse(line)))
    : []
}

/** Private files, a vault value, a local host and the MCP peer, written before the daemon starts. */
function seed(): void {
  const memory = join(world.dshbotHome, 'memory')
  mkdirSync(join(memory, 'knowledge'), { recursive: true })
  writeFileSync(join(memory, 'MEMORY.md'), `# Memory\nleft:${MEMORY_FRAGMENT}:right\n`)
  writeFileSync(join(memory, 'USER.md'), `# User\nleft:${USER_FRAGMENT}:right\n`)
  writeFileSync(join(memory, 'identity.md'), `# Identity\n${IDENTITY_FRAGMENT}\n${'I keep private facts. '.repeat(20)}`)
  writeFileSync(join(memory, 'knowledge', 'private-topic.md'), `---\nsummary: Private topic\nupdated: 2026-10-25\n---\nleft:${KNOWLEDGE_FRAGMENT}:right\n`)
  mkdirSync(join(world.dshbotHome, 'secrets'), { recursive: true })
  writeFileSync(join(world.dshbotHome, 'secrets', 'EXPORT_KEY'), VAULT_VALUE, { mode: 0o600 })
  writeFileSync(join(world.dshbotHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))
  const server = join(world.home, 'fragpeer-server.mjs')
  writeFileSync(server, SERVER)
  writeFileSync(join(world.dshbotHome, 'mcp.json'), JSON.stringify({ mcpServers: {
    fragpeer: { command: process.execPath, args: [server, logPath()] },
  } }))
}

// --- approval cards -------------------------------------------------------------------------------------------

interface Card { id: number; text: string; allow: string; deny: string }

/** Approval cards sent to the owner chat after `mark`. */
function cards(mark: number): Card[] {
  let sent = 0
  return world.timeline.events.flatMap((event) => {
    if (event.src !== 'tg' || !['sendMessage', 'sendRichMessage'].includes(event.method)) return []
    sent += 1
    if (event.n <= mark || event.params.chat_id !== OWNER_CHAT) return []
    const data = deepStrings(event.params.reply_markup)
    const allow = data.find((value) => /^tga1r?:[^:]+:a:/.test(value))
    const deny = data.find((value) => /^tga1r?:[^:]+:d:/.test(value))
    // the fake API numbers the sent messages 9001, 9002, ... in the order it saw them
    return allow && deny ? [{ id: 9000 + sent, text: deepStrings({ ...event.params, reply_markup: undefined }).join('\n'), allow, deny }] : []
  })
}

let callbackId = 910_000
function deny(card: Card): void {
  callbackId += 1
  world.tg.push({ update_id: callbackId, callback_query: {
    id: `frag-${callbackId}`, from: { id: OWNER_CHAT, is_bot: false, first_name: 'Owner' },
    chat_instance: 'frag', data: card.deny, message: {
      message_id: card.id, date: Math.floor(Date.now() / 1000), chat: { id: OWNER_CHAT, type: 'private' }, text: card.text,
    },
  } })
}

const finished = (tag: string): boolean => ownerTexts().some((text) => text.includes(`pong-${tag}`))

/** Starts an owner turn driven by `steps` (one action per step); the last answer is `pong-<tag>`. */
function begin(tag: string, steps: Array<(results: ToolResult[]) => Reply>): number {
  world.stub.owner.set(tag, ({ step }) => {
    const next = steps[step]
    return next === undefined ? { text: `pong-${tag}` } : next(world.stub.results.get(`owner:${tag}`) ?? [])
  })
  const mark = world.timeline.seq
  say(OWNER_CHAT, `own-${tag} run`)
  return mark
}

/** Waits for the end of the turn, or for a card: a card where none is expected fails here, not by a timeout. */
async function untilEndOrCard(d: Daemon, tag: string, mark: number): Promise<void> {
  await waitFor(`the end of ${tag} or an approval card`, () => finished(tag) || cards(mark).length > 0, d)
}

function resultsOf(tag: string): ToolResult[] {
  return world.stub.results.get(`owner:${tag}`) ?? []
}

function expectRan(value: ToolResult | undefined, what: string): void {
  expect(value, `${what}: the model got a result`).toBeDefined()
  expect(value!.isError, `${what}: ${value!.text}`).toBe(false)
  expect(value!.text, what).not.toMatch(/фрагмент приватных данных|нет владельца|Отказ/i)
}

function expectRefused(value: ToolResult | undefined, what: string): void {
  expect(value, `${what}: the model got a result`).toBeDefined()
  expect(value!.isError || /отказ|не подтверд|не выполн|denied|refus/i.test(value!.text), `${what}: ${value!.text}`).toBe(true)
}

const canaryIn = (): string => {
  for (const event of modelRequests('owner')) {
    const found = /DSHBOT-CANARY-[0-9a-f-]+/.exec(deepStrings(event.body.messages).join('\n'))
    if (found !== null) return found[0]
  }
  return ''
}

/** Loads the lazy tools the owner turns below call. */
const preload = (): Array<(results: ToolResult[]) => Reply> =>
  ['exec_write', 'exec_stop', 'host_exec', 'mcp__fragpeer'].map((query) => () => call('tool_search', { query }))

// c1: a quote of any private source in exec, exec_write (stdin) and host_exec runs without a card or a refusal.
// c3: the canary of the snapshot in the same three tools is refused without a card, and the owner is warned.
test.skipIf(!sandboxAvailable)('test_c1_c3_exec_tools_run_with_a_memory_quote_and_refuse_the_canary_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  seed()
  const d = await startOwnerDaemon({ fakeTask: false })

  let jobId = ''
  const mark = begin('fragquote', [
    ...preload(),
    ...FRAGMENTS.map((fragment) => () => call('exec', { command: `echo 'left:${fragment}:right'` })),
    () => call('host_exec', { host: 'box', command: `echo 'left:${MEMORY_FRAGMENT}:right'` }),
    () => call('exec', { command: 'cat', background: true }),
    (results) => {
      jobId = /"id"\s*:\s*"([^"]+)"/.exec(results[results.length - 1]?.text ?? '')?.[1] ?? ''
      return call('exec_write', { id: jobId, text: `quote ${MEMORY_FRAGMENT} ${USER_FRAGMENT}\n` })
    },
    () => call('exec_stop', { id: jobId }),
  ])
  await untilEndOrCard(d, 'fragquote', mark)
  expect(cards(mark), 'a private quote in exec arguments draws no card').toEqual([])
  await waitFor('the end of fragquote', () => finished('fragquote'), d)
  const quoted = resultsOf('fragquote')
  FRAGMENTS.forEach((fragment, index) => {
    const value = quoted[4 + index]
    expectRan(value, `exec quoting ${fragment}`)
    expect(value!.text, 'the command really ran').toContain(fragment)
  })
  expectRan(quoted[8], 'host_exec quoting the memory')
  expect(quoted[8]!.text).toContain(MEMORY_FRAGMENT)
  expect(jobId, 'the background job started').not.toBe('')
  expectRan(quoted[10], 'exec_write quoting the memory to stdin')

  const canary = canaryIn()
  expect(canary, 'the snapshot of the memory carries a canary').not.toBe('')
  const markCanary = begin('fragcanary', [
    () => call('exec', { command: 'cat', background: true }),
    (results) => {
      jobId = /"id"\s*:\s*"([^"]+)"/.exec(results[results.length - 1]?.text ?? '')?.[1] ?? ''
      return call('exec', { command: `echo ${canary}` })
    },
    () => call('host_exec', { host: 'box', command: `echo ${canary}` }),
    () => call('exec_write', { id: jobId, text: `${canary}\n` }),
    () => call('exec_stop', { id: jobId }),
  ])
  await untilEndOrCard(d, 'fragcanary', markCanary)
  expect(cards(markCanary), 'a canary has no allow button').toEqual([])
  await waitFor('the end of fragcanary', () => finished('fragcanary'), d)
  const refused = resultsOf('fragcanary')
  expectRefused(refused[1], 'exec with the canary')
  expectRefused(refused[2], 'host_exec with the canary')
  expectRefused(refused[3], 'exec_write with the canary')
  for (const value of refused.slice(1, 4)) {
    expect(value.text, 'the refusal names the canary').toMatch(/канарейк/i)
    expect(value.text, 'the refusal does not echo the canary back').not.toContain(canary)
  }
  await waitFor('the injection warning to the owner', () => ownerTexts().some((text) => /инъекц/i.test(text) && text.includes('exec')), d)
})

// c4 c5 c6: the cards that stay. An exact vault value in exec, a memory quote in an MCP writer and a recursive
// removal in exec each need the owner; every card is declined, so none of the three calls runs.
test.skipIf(!sandboxAvailable)('test_c4_c5_c6_vault_value_mcp_memory_quote_and_destructive_exec_still_draw_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  seed()
  const d = await startOwnerDaemon({ fakeTask: false })
  const mark = begin('fragcards', [
    () => call('tool_search', { query: 'mcp__fragpeer' }),
    () => call('exec', { command: `echo '${VAULT_VALUE}'` }),
    () => call(WRITER, { text: `prefix ${MEMORY_FRAGMENT} suffix` }),
    () => call('exec', { command: 'rm -rf frag-build', purpose: 'проверяю карточку подтверждения команды' }),
  ])
  const expected = [/EXPORT_KEY|секрет|secret/i, /MEMORY\.md|долговременн.*памят/i, /frag-build|rm|удал/i]
  for (const [index, source] of expected.entries()) {
    await waitFor(`approval card ${index + 1} or the end of the turn`, () => cards(mark).length > index || finished('fragcards'), d)
    const found = cards(mark)
    expect(found.length, `card ${index + 1} was drawn`).toBe(index + 1)
    expect(found[index]!.text).toMatch(source)
    deny(found[index]!)
  }
  await waitFor('the end of fragcards', () => finished('fragcards'), d)
  const results = resultsOf('fragcards')
  expectRefused(results[1], 'exec with the vault value')
  expectRefused(results[2], 'the MCP writer with a memory quote')
  expectRefused(results[3], 'the recursive removal')
  expect(peerWrites(), 'the declined MCP write never reaches the peer').toEqual([])
})

// c2 c5: a turn without the owner. exec and host_exec with a memory quote run (no «нет владельца» refusal), while an
// MCP writer with the same quote is refused and no card is drawn.
test.skipIf(!sandboxAvailable)('test_c2_c5_wakeup_runs_exec_with_a_memory_quote_and_still_refuses_the_mcp_writer', { timeout: TEST_TIMEOUT_MS }, async () => {
  seed()
  const d = await startOwnerDaemon({ fakeTask: false })
  const steps: Reply[] = [
    call('tool_search', { query: 'mcp__fragpeer' }),
    call('tool_search', { query: 'host_exec' }),
    call('exec', { command: `echo 'left:${MEMORY_FRAGMENT}:right'` }),
    call('host_exec', { host: 'box', command: `echo 'left:${MEMORY_FRAGMENT}:right'` }),
    call(WRITER, { text: `prefix ${MEMORY_FRAGMENT} suffix` }),
  ]
  const plan: Plan = (turn) => steps[turn.step] ?? { text: SILENT }
  world.stub.wake[0] = plan
  const mark = world.timeline.seq
  await untilAttempt(d, 0)
  await waitFor('the unattended turn gets all its tool results', () => (world.stub.results.get('wake:1')?.length ?? 0) >= steps.length, d)
  await wakeFinished(d, 1)
  const results = world.stub.results.get('wake:1') ?? []
  expectRan(results[2], 'exec with a memory quote in a turn without the owner')
  expect(results[2]!.text).toContain(MEMORY_FRAGMENT)
  expectRan(results[3], 'host_exec with a memory quote in a turn without the owner')
  expect(results[3]!.text).toContain(MEMORY_FRAGMENT)
  expectRefused(results[4], 'the MCP writer with a memory quote in a turn without the owner')
  expect(results[4]!.text).toMatch(/владел/i)
  expect(peerWrites(), 'the refused write never reaches the peer').toEqual([])
  expect(cards(mark), 'a turn without the owner draws no card').toEqual([])
})
