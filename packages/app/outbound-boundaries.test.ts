// Regression checks at the real daemon/runner boundary. The shared wake harness supplies
// pairing, Telegram, model replies, timers and an isolated DSHBOT_HOME for every test.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { chromium as playwright, type BrowserContext } from 'playwright-core'
import { revisionOf } from '../memory/src/identity.js'
import { sandboxProfile } from '../tools-exec/src/index.js'
import {
  OWNER_CHAT, SILENT, TEST_TIMEOUT_MS, asObject, deepStrings, modelRequests,
  ownerTexts, ownerTurn, say, startOwnerDaemon, stopDaemon, toolNames,
  untilAttempt, waitFor, wakeFinished, world,
} from './test-support/wake-harness.js'
import type { Daemon, JsonObject, Plan, Reply, ToolResult } from './test-support/wake-harness.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const READER = 'mcp__boundary__read'
const WRITER = 'mcp__boundary__write'
const PRIVATE = 'PrivateMemoryFragment_0123456789_abcdefghi'
const SECRET = 'sQ8!v'
const REMOTE_ERROR = 'REMOTE-CONTENT-IN-ERROR-RESPONSE'
const PUBLIC_A = '93.184.216.34'
const PUBLIC_B = '93.184.216.35'
const PAGE = 'BOUNDARY-PAGE-CONTROL'

const MCP_SERVER = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const tools = ['read', 'read_error', 'read_throw', 'write'].map(name => ({
  name, description: name, inputSchema: { type: 'object', additionalProperties: true },
  ...(name === 'write' ? {} : { annotations: { readOnlyHint: true } }),
}))
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'boundary', version: '1' } }
  if (method === 'tools/list') result = { tools }
  if (method === 'tools/call') {
    appendFileSync(process.argv[2], JSON.stringify(params) + '\n')
    if (params.name === 'read_throw') {
      send({ id, error: { code: -32000, message: 'REMOTE-CONTENT-IN-ERROR-RESPONSE' } })
      return
    }
    result = { content: [{ type: 'text', text: params.name === 'read_error' ? 'REMOTE-CONTENT-IN-ERROR-RESPONSE' : 'PEER-OK' }], ...(params.name === 'read_error' ? { isError: true } : {}) }
  }
  send({ id, result })
})
`

const call = (tool: string, input: JsonObject = {}): Reply => ({ tool, input })
const search = (query: string): Reply => call('tool_search', { query })
const plan = (tag: string, actions: Reply[]): Plan => ({ step }) => actions[step] ?? { text: `pong-${tag}` }
const logPath = (): string => join(world.home, 'boundary-calls.jsonl')
function peerCalls(): JsonObject[] {
  return existsSync(logPath()) ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map(line => asObject(JSON.parse(line))) : []
}
function result(tag: string, index: number): ToolResult {
  const found = world.stub.results.get(`owner:${tag}`)?.[index]
  expect(found, `the model received result ${index} of ${tag}`).toBeDefined()
  return found!
}
function refused(value: ToolResult): void {
  expect(value.isError || /отказ|не выполн|не подтверд|подтвержден|подтверждён|закрыт|запрещ|denied|refus/i.test(value.text), value.text).toBe(true)
  expect(value.text.trim()).not.toBe('')
}

interface Card { n: number; id: number; text: string; allow: string; deny: string }
function cards(mark: number): Card[] {
  let sent = 0
  return world.timeline.events.flatMap(event => {
    if (event.src !== 'tg' || !['sendMessage', 'sendRichMessage'].includes(event.method)) return []
    sent += 1
    if (event.n <= mark || event.params.chat_id !== OWNER_CHAT) return []
    const data = deepStrings(event.params.reply_markup)
    const allow = data.find(value => /^tga1r?:[^:]+:a:/.test(value))
    const deny = data.find(value => /^tga1r?:[^:]+:d:/.test(value))
    return allow && deny ? [{ n: event.n, id: 9000 + sent, text: deepStrings(event.params.text).join('\n'), allow, deny }] : []
  })
}
let callbackId = 900_000
function decide(card: Card, decision: 'allow' | 'deny'): void {
  callbackId += 1
  world.tg.push({ update_id: callbackId, callback_query: {
    id: `boundary-${callbackId}`, from: { id: OWNER_CHAT, is_bot: false, first_name: 'Owner' },
    chat_instance: 'boundary', data: card[decision], message: {
      message_id: card.id, date: Math.floor(Date.now() / 1000), chat: { id: OWNER_CHAT, type: 'private' }, text: card.text,
    },
  } })
}
async function pendingCard(d: Daemon, tag: string, mark: number): Promise<Card> {
  await waitFor('an approval card or the final owner reply', () => cards(mark).length > 0 || ownerTexts().some(text => text.includes(`pong-${tag}`)), d)
  expect(cards(mark), 'the outgoing call needs exactly one owner card').toHaveLength(1)
  return cards(mark)[0]!
}
async function finish(d: Daemon, tag: string): Promise<void> {
  await waitFor(`the end of ${tag}`, () => ownerTexts().some(text => text.includes(`pong-${tag}`)), d)
}
function begin(tag: string, actions: Reply[]): number {
  world.stub.owner.set(tag, plan(tag, actions))
  const mark = world.timeline.seq
  say(OWNER_CHAT, `own-${tag} inspect boundary`)
  return mark
}

function configure(): Record<string, string> {
  const server = join(world.home, 'boundary-peer.mjs')
  writeFileSync(server, MCP_SERVER)
  writeFileSync(join(world.dshbotHome, 'mcp.json'), JSON.stringify({ mcpServers: {
    boundary: { command: process.execPath, args: [server, logPath()] },
  } }))
  mkdirSync(join(world.dshbotHome, 'memory'), { recursive: true })
  writeFileSync(join(world.dshbotHome, 'memory', 'MEMORY.md'), `Saved fact: ${PRIVATE}\n`)
  mkdirSync(join(world.dshbotHome, 'secrets'), { recursive: true })
  writeFileSync(join(world.dshbotHome, 'secrets', 'BOUNDARY_KEY'), SECRET, { mode: 0o600 })
  const bin = join(world.home, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(world.home, 'ssh.log')}'\necho HOST-CONTROL-OK\n`, { mode: 0o755 })
  writeFileSync(join(world.dshbotHome, 'hosts.json'), JSON.stringify({ fixture: { user: 'test', host: '192.0.2.10', port: 2222 } }))
  // Same socket redirection as exec-network.test.ts. Only the two fixture IPs
  // are mapped; tools and guards see public unicast addresses throughout.
  const shim = join(world.home, 'boundary-transports.mjs')
  writeFileSync(shim, `
import { createRequire, syncBuiltinESMExports } from 'node:module'
const require = createRequire(import.meta.url)
const net = require('node:net')
const original = net.Socket.prototype.connect
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (options && typeof options === 'object' && ['${PUBLIC_A}', '${PUBLIC_B}'].includes(options.host)) {
    options.host = '127.0.0.1'
    delete options.lookup
  }
  return original.apply(this, args)
}
syncBuiltinESMExports()
export * from ${JSON.stringify(pathToFileURL(join(repoRoot, 'packages/tools-web/src/index.ts')).href)}
`)
  return { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), SHIM_WEB: pathToFileURL(shim).href }
}
async function ready(extra: Record<string, string> = {}): Promise<Daemon> {
  return startOwnerDaemon({ fakeTask: false, env: { ...configure(), ...extra } })
}
async function writerControl(d: Daemon): Promise<void> {
  await ownerTurn(d, 'control', plan('control', [search('mcp__boundary'), call(WRITER, { text: 'public control' })]))
  expect(peerCalls().map(entry => entry.name)).toEqual(['write'])
  expect(result('control', 1).text).toContain('PEER-OK')
}

// h1.2: both an MCP isError result and a JSON-RPC exception carry external text.
// The text stays data: a later ordinary call of the same turn runs without a card.
for (const errorTool of ['read_error', 'read_throw']) {
  for (const target of ['mcp', 'host_exec'] as const) {
    test(`test_h1_mcp_${errorTool}_ordinary_call_after_the_error_runs_in_owner_turn`, { timeout: TEST_TIMEOUT_MS }, async () => {
      const d = await ready()
      await writerControl(d)
      await ownerTurn(d, 'hostcontrol', plan('hostcontrol', [search('host_exec'), call('host_exec', { host: 'fixture', command: 'echo HOST-CONTROL' })]))
      expect(result('hostcontrol', 1).text).toContain('HOST-CONTROL-OK')
      const outgoing = target === 'mcp' ? call(WRITER, { text: 'ordinary public text' }) : call('host_exec', { host: 'fixture', command: 'echo AFTER-ERROR' })
      const mark = begin('errorowner', [call(`mcp__boundary__${errorTool}`), outgoing])
      await finish(d, 'errorowner')
      expect(result('errorowner', 0).text, 'the failing server returned content to the model').toContain(REMOTE_ERROR)
      expect(result('errorowner', 1).isError, result('errorowner', 1).text).toBe(false)
      expect(result('errorowner', 1).text).toContain(target === 'mcp' ? 'PEER-OK' : 'HOST-CONTROL-OK')
      if (target === 'mcp') expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(2)
      else expect(readFileSync(join(world.home, 'ssh.log'), 'utf8')).toContain('AFTER-ERROR')
      expect(cards(mark), 'an ordinary call after an external error draws no card').toEqual([])
    })
  }

  for (const target of ['mcp', 'host_exec'] as const) {
    test(`test_h1_mcp_${errorTool}_ordinary_call_after_the_error_runs_in_wakeup`, { timeout: TEST_TIMEOUT_MS }, async () => {
      const d = await ready()
      await writerControl(d)
      const outgoing = target === 'mcp' ? call(WRITER, { text: 'wake public write' }) : call('host_exec', { host: 'fixture', command: 'echo WAKE-EXPORT' })
      world.stub.wake[0] = ({ step }) => [search(target === 'mcp' ? 'mcp__boundary' : 'host_exec'), search('mcp__boundary'), call(`mcp__boundary__${errorTool}`), outgoing][step] ?? { text: SILENT }
      const mark = world.timeline.seq
      await untilAttempt(d, 0)
      await waitFor('the wake-up receives the outgoing result', () => (world.stub.results.get('wake:1')?.length ?? 0) >= 4, d)
      await wakeFinished(d, 1)
      const results = world.stub.results.get('wake:1')!
      expect(results[2]!.text).toContain(REMOTE_ERROR)
      const request = modelRequests('wake').find(event => event.step === 3)
      expect(request).toBeDefined()
      expect(toolNames(request!.body), 'the outgoing tool was available to this wake-up').toContain(target === 'mcp' ? WRITER : 'host_exec')
      expect(results[3]!.isError, results[3]!.text).toBe(false)
      expect(results[3]!.text).toContain(target === 'mcp' ? 'PEER-OK' : 'HOST-CONTROL-OK')
      if (target === 'mcp') expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(2)
      else expect(readFileSync(join(world.home, 'ssh.log'), 'utf8')).toContain('WAKE-EXPORT')
      expect(cards(mark), 'a wake-up draws no card').toEqual([])
    })
  }
}

// h1.3: a JSON key is as much an outgoing string as its value. Each case runs
// in a fresh turn, so the private-data rule alone decides the card.
for (const source of ['memory', 'secret', 'canary'] as const) {
  for (const shape of ['root-key', 'nested-array-key', 'nested-value'] as const) {
    test(`test_h1_recursive_outgoing_${source}_${shape}_is_guarded`, { timeout: TEST_TIMEOUT_MS }, async () => {
      const d = await ready()
      await writerControl(d)
      const first = modelRequests('owner').find(event => event.tag === 'control' && event.step === 0)!
      const snapshot = deepStrings(first.body.messages).join('\n').match(/<context\b[^>]*>([\s\S]*?)<\/context>/)?.[1]
      expect(snapshot).toContain(PRIVATE)
      const value = source === 'memory' ? PRIVATE : source === 'secret' ? SECRET : snapshot!
      const payload = shape === 'root-key' ? { [value]: 'ordinary' }
        : shape === 'nested-array-key' ? { payload: [{ inner: [{ [value]: 'ordinary' }] }] }
        : { payload: [{ inner: [{ safe: `prefix ${value} suffix` }] }] }
      const mark = begin('recursive', [call(WRITER, payload)])
      if (source === 'canary') {
        await waitFor('the canary is refused or produces an approval card', () => cards(mark).length > 0 || ownerTexts().some(text => text.includes('pong-recursive')), d)
        expect(cards(mark), 'canaries in keys and values cannot be approved').toEqual([])
        await finish(d, 'recursive')
        refused(result('recursive', 0))
        expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(1)
        expect(ownerTexts().join('\n'), 'the owner receives a canary/injection warning').toMatch(/инъекц|inject|канаре|canary/i)
        return
      }
      const card = await pendingCard(d, 'recursive', mark)
      expect(card.text).toMatch(source === 'memory' ? /MEMORY\.md|долговременн.*памят/i : /BOUNDARY_KEY|секрет|secret/i)
      expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(1)
      decide(card, 'deny')
      await finish(d, 'recursive')
      refused(result('recursive', 0))
      expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(1)
    })
  }
}

// h1.4: warm the private-fragment cache with a successful host call, mutate
// memory through the real tool, then export the newly written fragment in that same turn.
for (const target of ['memory', 'user', 'identity', 'knowledge'] as const) {
  test(`test_h1_sensitive_cache_refreshes_after_${target}_write_in_same_turn`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const env = configure()
    const identityPath = join(world.dshbotHome, 'memory', 'identity.md')
    const oldIdentity = 'Existing identity with ordinary habits. '.repeat(8)
    writeFileSync(identityPath, oldIdentity)
    const d = await startOwnerDaemon({ fakeTask: false, env })
    await writerControl(d)
    await ownerTurn(d, 'preparemutation', plan('preparemutation', [search(target === 'identity' ? 'update_identity' : target === 'knowledge' ? 'knowledge' : 'memory')]))
    const fresh = `NewlySaved_${target}_Private_0123456789_abcdefghij`
    const replacement = `${fresh}\n${'I keep a concise journal and help the owner. '.repeat(7)}`
    const mutation = target === 'identity'
      ? call('update_identity', { text: replacement, expected_revision: revisionOf(oldIdentity) })
      : target === 'knowledge' ? call('knowledge', { action: 'write', topic: 'boundary', summary: 'Private fixture topic', text: fresh })
      : call('memory', { target, operations: [{ op: 'add', text: fresh }] })
    const mark = begin('refresh', [search('host_exec'), call('host_exec', { host: 'fixture', command: 'echo WARM-CACHE' }), mutation, call(WRITER, { text: fresh })])
    await waitFor('the memory mutation result reaches the model', () => (world.stub.results.get('owner:refresh')?.length ?? 0) >= 3, d)
    expect(result('refresh', 1).text).toContain('HOST-CONTROL-OK')
    expect(result('refresh', 2).isError, result('refresh', 2).text).toBe(false)
    const path = target === 'identity' ? identityPath : target === 'knowledge' ? join(world.dshbotHome, 'memory', 'knowledge', 'boundary.md') : join(world.dshbotHome, 'memory', target === 'user' ? 'USER.md' : 'MEMORY.md')
    expect(readFileSync(path, 'utf8'), 'the mutation actually reached private storage').toContain(fresh)
    const card = await pendingCard(d, 'refresh', mark)
    expect(card.text).toMatch(target === 'identity' ? /identity|личност/i : target === 'knowledge' ? /knowledge|знан/i : target === 'user' ? /USER\.md|профил/i : /MEMORY\.md|долговременн/i)
    expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(1)
    decide(card, 'deny')
    await finish(d, 'refresh')
    refused(result('refresh', 3))
  })
}

test('test_h1_root_identity_actually_loaded_into_prefix_is_protected', { timeout: TEST_TIMEOUT_MS }, async () => {
  const env = configure()
  const fragment = 'RootIdentityPrivate_0123456789_abcdefghijk'
  writeFileSync(join(world.dshbotHome, 'identity.md'), `${fragment}\n${'Identity voice. '.repeat(20)}`)
  expect(existsSync(join(world.dshbotHome, 'memory', 'identity.md'))).toBe(false)
  const d = await startOwnerDaemon({ fakeTask: false, env })
  await writerControl(d)
  const control = modelRequests('owner').find(event => event.tag === 'control')
  expect(deepStrings(control!.body.system).join('\n') + deepStrings(control!.body.messages).join('\n'), 'the real session loaded the root identity').toContain(fragment)
  const mark = begin('rootidentity', [call(WRITER, { text: fragment })])
  const card = await pendingCard(d, 'rootidentity', mark)
  expect(card.text).toMatch(/identity|личност/i)
  expect(peerCalls().filter(entry => entry.name === 'write')).toHaveLength(1)
  decide(card, 'deny')
  await finish(d, 'rootidentity')
  refused(result('rootidentity', 0))
})

function sandboxWorks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'boundary-sandbox-probe-'))
  try {
    const profile = sandboxProfile({ home: directory, workspace: directory, roPaths: [] })
    const probe = spawnSync(profile[0]!, [...profile.slice(1), '/bin/true'], { timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const sandboxAvailable = sandboxWorks()
const servers: Server[] = []
const browsers: BrowserContext[] = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function internet(): Promise<{ url: (path: string, host?: string) => string; hits: string[]; origin: string }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    hits.push(`${url.hostname}${url.pathname}`)
    if (url.pathname === '/redirect') res.writeHead(302, { location: `http://${PUBLIC_A}:${url.port}/middle` }).end()
    else if (url.pathname === '/middle') res.writeHead(302, { location: `http://${PUBLIC_B}:${url.port}/blocked` }).end()
    else res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>${PAGE}</body></html>`)
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { hits, origin: `http://127.0.0.1:${port}`, url: (path, host = PUBLIC_A) => `http://${host}:${port}${path}` }
}

for (const errorTool of ['read_error', 'read_throw']) {
  test.skipIf(!sandboxAvailable)(`test_h1_mcp_${errorTool}_keeps_real_exec_network`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const web = await internet()
    const d = await ready()
    const command = (path: string): Reply => call('exec', { command: `curl -sS --max-time 5 '${web.url(path)}'`, timeout_sec: 15 })
    await ownerTurn(d, 'networkcontrol', plan('networkcontrol', [command('/control')]))
    expect(result('networkcontrol', 0).text).toContain(PAGE)
    await ownerTurn(d, 'networkerror', plan('networkerror', [search('mcp__boundary'), call(`mcp__boundary__${errorTool}`), command('/after-error')]))
    expect(result('networkerror', 1).text).toContain(REMOTE_ERROR)
    expect(web.hits).toContain(`${PUBLIC_A}/control`)
    expect(web.hits).toContain(`${PUBLIC_A}/after-error`)
    expect(result('networkerror', 2).text).toContain(PAGE)
    expect(result('networkerror', 2).text).not.toMatch(/сеть.*закрыт|network.*(?:closed|blocked)/i)
  })
}

// h1.5: a live cat proves stdin works. A memory quote is ordinary input for exec_write
// (#148) and reaches the job without a card. The canary is refused, and the following
// safe line proves the refused text was never buffered and sent to the job afterwards.
for (const mode of ['memory', 'canary'] as const) {
  test.skipIf(!sandboxAvailable)(mode === 'memory' ? 'test_h1_exec_write_memory_quote_reaches_live_stdin_without_a_card' : `test_h1_exec_write_${mode}_never_reaches_live_stdin`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const d = await ready()
    await ownerTurn(d, 'prepareinput', plan('prepareinput', [search('exec_write'), search('exec_status'), search('exec_stop')]))
    let id = ''
    let attempted = ''
    let controlOutput = ''
    let finalOutput = ''
    let sensitiveResult: ToolResult | undefined
    let stage = 'start'
    let statusPolls = 0
    world.stub.owner.set('stdin', ({ step, result: previous }) => {
      if (step === 0) return call('exec', { command: 'cat', background: true })
      if (stage === 'start') {
        id = /"id"\s*:\s*"([^"]+)"/.exec(previous?.text ?? '')?.[1] ?? ''
        if (id === '') return { text: 'pong-stdin' }
        stage = 'control-write'
        return call('exec_write', { id, text: 'PUBLIC-STDIN-CONTROL' })
      }
      if (stage === 'control-write') {
        stage = 'control-status'
        return call('exec_status', { id })
      }
      if (stage === 'control-status') {
        controlOutput = previous?.text ?? ''
        if (!controlOutput.includes('PUBLIC-STDIN-CONTROL')) {
          statusPolls += 1
          return statusPolls < 20 && !previous?.isError ? call('exec_status', { id }) : { text: 'pong-stdin' }
        }
        const first = modelRequests('owner').find(event => event.tag === 'stdin' && event.step === 0)!
        const snapshot = deepStrings(first.body.messages).join('\n').match(/<context\b[^>]*>([\s\S]*?)<\/context>/)?.[1]
        if (snapshot === undefined) return { text: 'pong-stdin' }
        attempted = mode === 'memory' ? PRIVATE : snapshot!
        stage = 'sensitive'
        return call('exec_write', { id, text: attempted })
      }
      if (stage === 'sensitive') {
        sensitiveResult = previous
        stage = 'after-write'
        return call('exec_write', { id, text: 'PUBLIC-AFTER-REFUSAL' })
      }
      if (stage === 'after-write') {
        stage = 'after-status'
        statusPolls = 0
        return call('exec_status', { id })
      }
      if (stage === 'after-status') {
        finalOutput = previous?.text ?? ''
        if (!finalOutput.includes('PUBLIC-AFTER-REFUSAL')) {
          statusPolls += 1
          if (statusPolls < 20 && !previous?.isError) return call('exec_status', { id })
        }
        stage = 'stop'
        return call('exec_stop', { id })
      }
      return { text: 'pong-stdin' }
    })
    const mark = world.timeline.seq
    say(OWNER_CHAT, 'own-stdin check input')
    await waitFor('the stdin control finishes and the sensitive write is attempted', () => attempted !== '' || ownerTexts().some(text => text.includes('pong-stdin')), d)
    expect(id, 'the real background job started').not.toBe('')
    expect(controlOutput, 'the job accepts ordinary input').toContain('PUBLIC-STDIN-CONTROL')
    expect(attempted, 'the outgoing write was reached').toContain(PRIVATE)
    await waitFor('the end of the turn or a forbidden approval card', () => cards(mark).length > 0 || ownerTexts().some(text => text.includes('pong-stdin')), d)
    expect(cards(mark), mode === 'memory' ? 'a memory quote in stdin draws no card' : 'a canary must never offer an approval button').toEqual([])
    await finish(d, 'stdin')
    expect(sensitiveResult).toBeDefined()
    expect(finalOutput).toContain('PUBLIC-AFTER-REFUSAL')
    if (mode === 'memory') {
      expect(sensitiveResult!.isError, sensitiveResult!.text).toBe(false)
      expect(sensitiveResult!.text).not.toMatch(/отказ|фрагмент приватных|нет владельца/i)
      expect(finalOutput, 'the quoted memory reached the job').toContain(PRIVATE)
    } else {
      refused(sensitiveResult!)
      expect(finalOutput).not.toContain(PRIVATE)
      expect(cards(mark), 'canaries cannot be approved').toEqual([])
      expect(ownerTexts().join('\n'), 'the owner receives a canary/injection warning').toMatch(/инъекц|inject|канаре|canary/i)
    }
  })
}

function chromiumPath(): string | undefined {
  const explicit = process.env.DSHBOT_BROWSER_PATH
  if (explicit && existsSync(explicit)) return explicit
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
      if (directory && existsSync(join(directory, name))) return join(directory, name)
    }
  }
  return undefined
}
const chromium = chromiumPath()
for (const mode of ['builtin', 'attached'] as const) {
  test.skipIf(!chromium)(`test_h1_${mode}_browser_redirect_chain_reaches_a_new_public_host`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const web = await internet()
    const executable = join(world.home, 'chromium')
    writeFileSync(executable, `#!/bin/sh\nexec '${chromium!.replaceAll("'", "'\\''")}' --no-sandbox "$@"\n`, { mode: 0o755 })
    const env: Record<string, string> = { DSHBOT_BROWSER_PATH: executable }
    if (mode === 'attached') {
      const profile = join(world.home, 'owner-browser-profile')
      const browser = await playwright.launchPersistentContext(profile, { executablePath: executable, headless: true, args: ['--remote-debugging-port=0'], proxy: { server: web.origin }, env: { ...process.env, HOME: world.home, XDG_CONFIG_HOME: join(world.home, '.config') } })
      browsers.push(browser)
      // The browser exposes its randomly allocated HTTP debugging endpoint in
      // the DevToolsActivePort file; use the same CDP attachment as the daemon tests.
      const portFile = join(profile, 'DevToolsActivePort')
      await waitFor('the attached browser debugging endpoint', () => existsSync(portFile))
      env.DSHBOT_BROWSER_CDP_URL = `http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`
    }
    const d = await ready(env)
    const tag = 'redirect'
    const mark = begin(tag, [search('browser'), call('browser', { action: 'open', url: web.url('/known') }), call('browser', { action: 'open', url: web.url('/redirect') })])
    await finish(d, tag)
    expect(result(tag, 1).text, 'the first page reached the browser').toContain(PAGE)
    expect(web.hits).toContain(`${PUBLIC_A}/redirect`)
    expect(web.hits).toContain(`${PUBLIC_A}/middle`)
    expect(web.hits, 'the redirect target of a public host is reached without a card').toContain(`${PUBLIC_B}/blocked`)
    expect(result(tag, 2).isError, result(tag, 2).text).toBe(false)
    expect(result(tag, 2).text).toContain(PAGE)
    expect(cards(mark), 'a public redirect draws no card').toEqual([])
    await stopDaemon(d)
  })
}
