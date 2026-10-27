import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'
import { makeSnapshot } from './src/backup.js'

// Same subprocess/HTTP/seeded-owner seams as daemon.test.ts,
// backup-snapshots.test.ts and turn-cancel.test.ts. Each test owns its HOME,
// DSHBOT_HOME and servers; no account, external service or real token is used.
const root = fileURLToPath(new URL('../..', import.meta.url))
const token = '7000001:AAHdshbotResilienceSyntheticToken0123456789'
const key = 'sk-dshbot-resilience-synthetic-key'
const owner = 7
const ownerKey = 'telegram.owner_chat_id'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
type Json = Record<string, unknown>
type Exit = { code: number | null; signal: NodeJS.Signals | null }
interface Daemon {
  child: ChildProcess
  log: string
  exited: boolean
  result?: Exit
  exit: Promise<Exit>
  messages: Json[]
}
interface World {
  scratch: string
  home: string
  state: string
  preload: string
  fixtureLog: string
  tg: Server
  model: Server
  tgRoot: string
  modelRoot: string
  polls: { at: number; timeout: number }[]
  abortedPolls: number
  pollReply?: (response: ServerResponse) => void
  queue: Json[]
  holders: ServerResponse[]
  sent: Json[]
  modelCalls: number
  reactions: { messageId: number; emoji: string; at: number }[]
  lastSaid?: { id: number }
  holdModel: boolean
  daemons: Daemon[]
}
let world: World
let nextUpdate = 1000

async function bodyOf(request: IncomingMessage): Promise<Json> {
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part as Uint8Array))
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as Json } catch { return {} }
}

function json(response: ServerResponse, result: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(status === 200 ? { ok: true, result } : result))
}

function telegramError(response: ServerResponse, code: number): void {
  json(response, { ok: false, error_code: code, description: code === 409 ? 'Conflict: another getUpdates request' : 'Unauthorized' }, code)
}

function flush(): void {
  const holder = world.queue.length > 0 ? world.holders.shift() : undefined
  if (holder) json(holder, world.queue.splice(0))
}

function say(text: string): number {
  nextUpdate += 1
  world.lastSaid = { id: nextUpdate }
  world.queue.push({
    update_id: nextUpdate,
    message: {
      message_id: nextUpdate, date: Math.floor(Date.now() / 1000),
      chat: { id: owner, type: 'private', first_name: 'Owner' },
      from: { id: owner, is_bot: false, first_name: 'Owner' }, text,
    },
  })
  flush()
  return nextUpdate
}

function ownerTexts(from = 0): string {
  // Native rich messages carry text in blocks rather than params.text.
  return world.sent.slice(from).filter((params) => params.chat_id === owner).map((params) => JSON.stringify(params)).join('\n')
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
}

function modelMessage(): Json {
  return {
    id: 'msg_resilience', type: 'message', role: 'assistant', model: 'deepseek-flash',
    content: [{ type: 'text', text: 'resilience-pong' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3 },
  }
}

function modelStream(): string {
  return [
    sse('message_start', { type: 'message_start', message: { ...modelMessage(), content: [], stop_reason: null } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'resilience-pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// The runner seam in turn-cancel.test.ts uses registerHooks in just this way.
// Here the wrapper observes handler installation at subsystem startup and can
// schedule genuine out-of-turn faults. It never installs an error handler.
function writePreload(directory: string): string {
  const original = pathToFileURL(join(root, 'packages/tools-exec/src/index.ts')).href
  const fsOriginal = pathToFileURL(join(root, 'packages/tools-fs/src/index.ts')).href
  const fsWrapper = join(directory, 'observe-first-subsystem.mjs')
  writeFileSync(fsWrapper, `
import { appendFileSync } from 'node:fs'
import { createFsTools as realCreate } from ${JSON.stringify(fsOriginal)}
export * from ${JSON.stringify(fsOriginal)}
export function createFsTools(options) {
  appendFileSync(process.env.RESILIENCE_FIXTURE_LOG, JSON.stringify({
    exception: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  }) + '\\n')
  return realCreate(options)
}
`)
  const wrapper = join(directory, 'observe-exec.mjs')
  writeFileSync(wrapper, `
import { appendFileSync } from 'node:fs'
import { createExecTools as realCreate } from ${JSON.stringify(original)}
export * from ${JSON.stringify(original)}
// The daemon builds one exec runtime for the owner and, since the guest tools
// landed, a second one for the guest. Early faults describe the run, not the
// runtime: schedule them once per process so the two startups cannot push the
// fault budget over FAULT_LIMIT. The promise lives on globalThis, not in this
// module: a second instance of the wrapper would otherwise schedule the same
// pair again. Every caller waits for the same scheduled faults, so no exec
// subsystem is returned before they have fired.
const earlyFaultsKey = Symbol.for('dshbot.resilience.earlyFaults')
export async function createExecTools(options) {
  appendFileSync(process.env.RESILIENCE_FIXTURE_LOG, JSON.stringify({
    exception: process.listenerCount('uncaughtException'),
    rejection: process.listenerCount('unhandledRejection'),
  }) + '\\n')
  if (process.env.RESILIENCE_EARLY_FAULTS === '1') {
    globalThis[earlyFaultsKey] ??= (async () => {
      setTimeout(() => { throw new Error('resilience-early-timer') }, 0)
      setTimeout(() => { void Promise.reject(new Error('resilience-early-promise')) }, 5)
      await new Promise(resolve => setTimeout(resolve, 30))
    })()
    await globalThis[earlyFaultsKey]
  }
  const runtime = await realCreate(options)
  process.on('message', message => {
    if (message?.fault !== 'exec-probe') return
    void (async () => {
      let answer
      try {
        const tool = runtime.tools.find(tool => tool.name === 'exec')
        answer = String(await tool.execute({ command: 'echo resilience-exec', timeout_sec: 1 }, { signal: new AbortController().signal }))
      } catch (error) { answer = String(error) }
      process.send?.({ kind: 'exec-result', answer })
    })()
  })
  return runtime
}
`)
  const preload = join(directory, 'fault-preload.mjs')
  writeFileSync(preload, `
import { registerHooks } from 'node:module'
import net from 'node:net'
const wrapper = ${JSON.stringify(pathToFileURL(wrapper).href)}
const fsWrapper = ${JSON.stringify(pathToFileURL(fsWrapper).href)}
registerHooks({ resolve(specifier, context, nextResolve) {
  if (/tools-fs\\/src\\/index\\.js$/.test(specifier) && context.parentURL?.includes('/packages/app/src/')) {
    return { url: fsWrapper, shortCircuit: true }
  }
  if (/tools-exec\\/src\\/index\\.js$/.test(specifier) && context.parentURL?.includes('/packages/app/src/')) {
    return { url: wrapper, shortCircuit: true }
  }
  return nextResolve(specifier, context)
} })
if (process.env.RESILIENCE_PROXY_FAULT === '1') {
  const realListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...args) {
    if (typeof args[0] === 'string' && args[0].endsWith('/proxy.sock')) {
      process.stderr.write('[fixture] proxy-listen-fault\\n')
      queueMicrotask(() => this.emit('error', Object.assign(new Error('EADDRINUSE: exec proxy address occupied'), { code: 'EADDRINUSE' })))
      return this
    }
    return realListen.apply(this, args)
  }
}
process.on('message', message => {
  const marker = 'resilience-fault-' + message?.id
  if (message?.fault === 'timer') setTimeout(() => { throw new Error(marker) }, 0)
  if (message?.fault === 'rejection') setTimeout(() => { void Promise.reject(new Error(marker)) }, 0)
})
`)
  return preload
}

beforeEach(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-resilience-'))
  const state = join(scratch, 'state')
  mkdirSync(state)
  world = {
    scratch, state, home: join(scratch, 'home'), preload: writePreload(scratch), fixtureLog: join(scratch, 'listeners.jsonl'),
    tg: createServer(), model: createServer(), tgRoot: '', modelRoot: '', polls: [], abortedPolls: 0,
    queue: [], holders: [], sent: [], modelCalls: 0, reactions: [], holdModel: false, daemons: [],
  }
  mkdirSync(world.home)
  world.tg.on('request', (request, response) => {
    void bodyOf(request).then((params) => {
      const method = (request.url ?? '').split('/').at(-1)
      if (method === 'getUpdates') {
        world.polls.push({ at: Date.now(), timeout: Number(params.timeout) })
        response.on('close', () => { if (!response.writableEnded) world.abortedPolls += 1 })
        if (world.pollReply) { world.pollReply(response); return }
        if (world.queue.length > 0) { json(response, world.queue.splice(0)); return }
        world.holders.push(response)
        const timer = setTimeout(() => json(response, []), 20_000)
        response.on('close', () => {
          clearTimeout(timer)
          world.holders = world.holders.filter((holder) => holder !== response)
        })
        return
      }
      if (method === 'getMe') { json(response, { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'resilience_test_bot' }); return }
      if (method === 'setMessageReaction') {
        const reaction = Array.isArray(params.reaction) ? params.reaction[0] as Json | undefined : undefined
        world.reactions.push({ messageId: Number(params.message_id), emoji: String(reaction?.emoji ?? ''), at: Date.now() })
        json(response, true)
        return
      }
      if (method === 'sendMessage' || method === 'sendRichMessage') {
        world.sent.push(params)
        json(response, { message_id: 9000 + world.sent.length, date: Math.floor(Date.now() / 1000), chat: { id: params.chat_id, type: 'private' }, text: params.text ?? '' })
        return
      }
      json(response, true)
    })
  })
  world.model.on('request', (request, response) => {
    void bodyOf(request).then((body) => {
      if (Array.isArray(body.messages)) world.modelCalls += 1
      if (world.holdModel) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(sse('ping', { type: 'ping' }))
        return
      }
      if (body.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(modelMessage()))
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(modelStream())
      }
    })
  })
  world.tgRoot = await listen(world.tg)
  world.modelRoot = await listen(world.model)
})

afterEach(async () => {
  for (const daemon of world.daemons) {
    if (!daemon.exited) daemon.child.kill('SIGKILL')
    await daemon.exit
  }
  for (const server of [world.tg, world.model]) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  rmSync(world.scratch, { recursive: true, force: true })
})

function seedOwner(): void {
  const store = openStore(join(world.state, 'state.db'))
  try { store.kv.set(ownerKey, String(owner)) } finally { store.close() }
}

function spawnDaemon(extra: Record<string, string | undefined> = {}): Daemon {
  const env: NodeJS.ProcessEnv = {
    HOME: world.home, USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(root, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key, DSHBOT_HOME: world.state,
    TELEGRAM_API_ROOT: world.tgRoot, DEEPSEEK_BASE_URL: `${world.modelRoot}/anthropic`,
    DSHBOT_DREAM_AT: 'off', DSHBOT_DEBOUNCE_MS: '0', DSHBOT_TZ: 'UTC',
    RESILIENCE_FIXTURE_LOG: world.fixtureLog, ...extra,
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn(process.execPath, [
    '--import', join(root, 'packages/app/register.mjs'), '--import', world.preload, join(root, 'packages/app/src/main.ts'),
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const daemon: Daemon = {
    child, log: '', exited: false, messages: [],
    exit: new Promise((resolve) => {
      child.on('close', (code, signal) => {
        daemon.exited = true
        daemon.result = { code, signal }
        resolve(daemon.result)
      })
    }),
  }
  child.stdout?.on('data', (chunk: Buffer) => { daemon.log += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { daemon.log += chunk.toString('utf8') })
  child.on('message', (message) => { daemon.messages.push(message as Json) })
  world.daemons.push(daemon)
  return daemon
}

async function waitFor(daemon: Daemon, label: string, done: () => boolean, ms = 45_000): Promise<void> {
  const until = Date.now() + ms
  while (!done() && !daemon.exited && Date.now() < until) await sleep(25)
  expect(done(), `${label}\npolls=${world.polls.length} modelCalls=${world.modelCalls} sent=${JSON.stringify(world.sent.slice(-5))}\n${daemonDiagnostic(daemon)}`).toBe(true)
}

function daemonDiagnostic(daemon: Daemon): string {
  // These frames belong to another process. Vitest must not treat them as the
  // assertion's own stack and try to open temporary preloads after teardown.
  // Keep the complete journal: trimming its start can hide the first faults.
  return daemon.log.split('\n').map((line) => `[daemon] ${line}`).join('\n')
}

function faultLines(daemon: Daemon): string[] {
  return daemon.log.split('\n').filter((line) => /^\[dshbot\] (?:uncaught exception|unhandled rejection):/.test(line))
}

async function start(extra: Record<string, string> = {}): Promise<Daemon> {
  const polls = world.polls.length
  const daemon = spawnDaemon(extra)
  await waitFor(daemon, 'daemon starts polling Telegram', () => world.polls.length > polls)
  expect(daemon.exited, daemonDiagnostic(daemon)).toBe(false)
  return daemon
}

async function turnSettled(daemon: Daemon, id: number): Promise<void> {
  // The final status reaction is sent after the answer and after the turn stops
  // accepting steering; without this wait the next question can race a turn
  // that is still finishing and be swallowed by its steering lane.
  await waitFor(daemon, 'the turn finished with its final reaction',
    () => world.reactions.some((reaction) => reaction.messageId === id && reaction.emoji === '🎉'))
}

async function ask(daemon: Daemon): Promise<void> {
  const previous = world.lastSaid
  if (previous !== undefined) await turnSettled(daemon, previous.id)
  const mark = world.sent.length
  const calls = world.modelCalls
  const id = say('проверка ответа после сбоя')
  await waitFor(daemon, 'owner receives the model reply', () => ownerTexts(mark).includes('resilience-pong'))
  expect(world.modelCalls, 'a real owner turn reached the model').toBeGreaterThan(calls)
  expect(daemon.exited, daemonDiagnostic(daemon)).toBe(false)
  await turnSettled(daemon, id)
}

function serviceValues(): Map<string, string> {
  const values = new Map<string, string>()
  let section = ''
  for (const raw of readFileSync(join(root, 'deploy/dshbot.service'), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { section = line; continue }
    if (section !== '[Service]' || line.startsWith('#') || line.startsWith(';')) continue
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  return values
}

test('test_c2_conflict_is_logged_once_per_series_and_owner_turns_resume_between_series', { timeout: 120_000 }, async () => {
  seedOwner()
  let attempts = 0
  world.pollReply = (response) => {
    attempts += 1
    if (attempts <= 3) telegramError(response, 409)
    else { world.pollReply = undefined; json(response, world.queue.splice(0)) }
  }
  // Queue a message before start so the first successful poll delivers it.
  say('ответь после конфликта')
  const daemon = await start()
  await waitFor(daemon, 'recovery after three conflicting polls', () => ownerTexts().includes('resilience-pong'), 65_000)
  const conflicts = (): string[] => daemon.log.split('\n').filter((line) => /409|conflict|конфликт/i.test(line))
  expect(conflicts(), daemonDiagnostic(daemon)).toHaveLength(1)
  expect(attempts).toBeGreaterThanOrEqual(4)

  // Restore ordinary long polling before making the next series, avoiding
  // a fake server that spins on immediate empty successful responses.
  world.pollReply = undefined
  await ask(daemon)
  attempts = 0
  world.pollReply = (response) => {
    attempts += 1
    if (attempts <= 2) telegramError(response, 409)
    else { world.pollReply = undefined; json(response, world.queue.splice(0)) }
  }
  const mark = world.sent.length
  say('разбудить текущий длинный опрос')
  await waitFor(daemon, 'second conflict series starts', () => attempts >= 1)
  say('ответь после второго конфликта')
  await waitFor(daemon, 'second series recovers', () => attempts >= 3 && ownerTexts(mark).includes('resilience-pong'), 65_000)
  expect(conflicts(), 'a later conflict gets one new journal line').toHaveLength(2)
  await ask(daemon)
  expect(daemon.exited).toBe(false)
})

test('test_c4_a_silent_getUpdates_is_aborted_after_long_poll_plus_reserve_and_retried', { timeout: 100_000 }, async () => {
  seedOwner()
  // The peer accepts the HTTP request but never sends even the headers.
  world.pollReply = (response) => {
    if (world.polls.length === 1) return
    world.pollReply = undefined
    json(response, world.queue.splice(0))
  }
  say('ответь после таймаута опроса')
  const daemon = await start({ DSHBOT_POLL_STALL_MS: '65000' })
  expect(world.polls[0]?.timeout, 'fixture exercises the production long poll').toBe(30)
  const first = world.polls[0]!.at
  await waitFor(daemon, 'silent request is aborted and another getUpdates is sent', () => world.abortedPolls >= 1 && world.polls.length >= 2, 62_000)
  expect(world.polls[1]!.at - first, 'the request deadline must allow a full long poll').toBeGreaterThanOrEqual(30_000)
  expect(world.polls[1]!.at - first, 'deadline includes long polling plus a bounded reserve').toBeLessThanOrEqual(60_000)
  await waitFor(daemon, 'message queued during the timeout reaches the owner', () => ownerTexts().includes('resilience-pong'))
  expect(daemon.exited, daemonDiagnostic(daemon)).toBe(false)
})

test('test_c4_a_poll_with_no_completed_cycle_exits_nonzero_at_the_configured_stall_threshold', { timeout: 70_000 }, async () => {
  seedOwner()
  world.pollReply = () => undefined
  // A deliberately small stall threshold exercises the watchdog independently
  // of request timeout/retry, without waiting five real minutes in every run.
  const launched = Date.now()
  const daemon = await start({ DSHBOT_POLL_STALL_MS: '1000' })
  await waitFor(daemon, 'a stalled poll trips the process watchdog', () => daemon.exited, 15_000)
  expect(daemon.result?.signal).toBeNull()
  expect(daemon.result?.code).not.toBe(0)
  expect(daemon.result?.code).toBeTypeOf('number')
  expect(Date.now() - launched, 'the configured threshold elapses before the exit').toBeGreaterThanOrEqual(1000)
})

test('test_c5_unauthorized_getUpdates_exits_78_with_a_russian_token_diagnostic_and_no_token', { timeout: 70_000 }, async () => {
  seedOwner()
  world.pollReply = (response) => telegramError(response, 401)
  const daemon = spawnDaemon()
  await waitFor(daemon, 'invalid Telegram credential stops the daemon', () => daemon.exited, 60_000)
  expect(world.polls.length, '401 must come from getUpdates rather than another method').toBeGreaterThan(0)
  expect(daemon.result).toEqual({ code: 78, signal: null })
  expect(daemon.log.split('\n').some((line) =>
    /Telegram|телеграм/i.test(line) && /токен/i.test(line) && /неверн|недействител|некоррект|неправильн|ошиб/i.test(line)),
  'one Russian journal line explains the invalid Telegram token').toBe(true)
  expect(daemon.log).not.toContain(token)
  expect(daemon.log).not.toContain(token.split(':')[1])
})

const invalidEnvironments: { env: Record<string, string | undefined>; field: string }[] = [
  { env: { TELEGRAM_BOT_TOKEN: undefined }, field: 'TELEGRAM_BOT_TOKEN (missing)' },
  { env: { TELEGRAM_BOT_TOKEN: '' }, field: 'TELEGRAM_BOT_TOKEN' },
  { env: { DSHBOT_BACKUP_AT: '25:99' }, field: 'DSHBOT_BACKUP_AT' },
]
test.each(invalidEnvironments)('test_c6_bad_environment_$field exits_78_and_systemd_preserves_77_and_78', { timeout: 60_000 }, async ({ env, field }) => {
  const daemon = spawnDaemon(env)
  await waitFor(daemon, 'configuration failure exits', () => daemon.exited)
  expect(daemon.result).toEqual({ code: 78, signal: null })
  expect(daemon.log).toContain(field.split(' ')[0])
  expect(daemon.log).toMatch(/required|must|invalid|обязател|зада|укаж|отсутств|ошиб|неверн|некоррект|пуст/i)
  expect(daemon.log).not.toContain(token)
  const prevented = serviceValues().get('RestartPreventExitStatus')?.split(/\s+/)
  expect(prevented).toContain('77')
  expect(prevented).toContain('78')
})

test('test_c7_handlers_exist_before_subsystem_startup_and_real_timer_and_promise_faults_allow_owner_replies', { timeout: 100_000 }, async () => {
  seedOwner()
  const daemon = await start({ RESILIENCE_EARLY_FAULTS: '1' })
  expect(existsSync(world.fixtureLog), 'subsystem startup seam was reached').toBe(true)
  const counts = JSON.parse(readFileSync(world.fixtureLog, 'utf8').trim().split('\n')[0]!) as { exception: number; rejection: number }
  expect(counts.exception, 'uncaughtException handler precedes subsystem startup').toBeGreaterThan(0)
  expect(counts.rejection, 'unhandledRejection handler precedes subsystem startup').toBeGreaterThan(0)
  expect(daemon.log).toContain('resilience-early-timer')
  expect(daemon.log).toContain('resilience-early-promise')
  expect(faultLines(daemon), daemonDiagnostic(daemon)).toHaveLength(2)
  await ask(daemon)
  expect(faultLines(daemon), daemonDiagnostic(daemon)).toHaveLength(2)
  for (const [index, fault] of ['timer', 'rejection'].entries()) {
    daemon.child.send({ fault, id: index })
    await waitFor(daemon, 'out-of-turn fault is recorded', () => daemon.log.includes(`resilience-fault-${index}`))
    await ask(daemon)
    expect(faultLines(daemon), daemonDiagnostic(daemon)).toHaveLength(3 + index)
  }
})

test('test_c7_five_uncaught_faults_in_ten_minutes_survive_and_the_sixth_exits_1', { timeout: 120_000 }, async () => {
  seedOwner()
  const daemon = await start()
  for (let index = 1; index <= 5; index += 1) {
    daemon.child.send({ fault: index % 2 === 0 ? 'timer' : 'rejection', id: index })
    await waitFor(daemon, `fault ${index} logged`, () => daemon.log.includes(`resilience-fault-${index}`))
    await ask(daemon)
    expect(faultLines(daemon), daemonDiagnostic(daemon)).toHaveLength(index)
  }
  daemon.child.send({ fault: 'rejection', id: 6 })
  await waitFor(daemon, 'six faults trip the recovery fuse', () => daemon.exited, 20_000)
  expect(daemon.result).toEqual({ code: 1, signal: null })
  expect(daemon.log).toContain('resilience-fault-6')
  expect(faultLines(daemon), daemonDiagnostic(daemon)).toHaveLength(6)
})

function damageState(mode: 'not-sqlite' | 'integrity'): Buffer {
  const path = join(world.state, 'state.db')
  if (mode === 'not-sqlite') {
    writeFileSync(path, 'this is a damaged state database, not SQLite\n')
  } else {
    // Borrow the overflow-chain fixture from backup-snapshots.test.ts: normal
    // app tables still open, but quick_check must detect the damaged blob.
    const store = openStore(path)
    try { store.kv.set('resilience.blob', 'Z'.repeat(300_000)) } finally { store.close() }
    const bytes = readFileSync(path)
    const declared = bytes.readUInt16BE(16)
    const pageSize = declared === 1 ? 65536 : declared
    const overflow: number[] = []
    for (let at = pageSize; at + pageSize <= bytes.length; at += pageSize) {
      if (bytes.subarray(at + 4, at + pageSize).every((byte) => byte === 0x5a)) overflow.push(at)
    }
    expect(overflow.length, 'fixture contains overflow pages to corrupt').toBeGreaterThan(8)
    bytes.writeUInt32BE(0x7fffffff, overflow[Math.floor(overflow.length / 2)]!)
    writeFileSync(path, bytes)
    const probe = new DatabaseSync(path, { readOnly: true })
    let verdict: unknown
    try { verdict = probe.prepare('PRAGMA quick_check').all() } catch (error) { verdict = String(error) } finally { probe.close() }
    expect(JSON.stringify(verdict), 'the integrity fixture is actually broken').not.toBe('[{"quick_check":"ok"}]')
  }
  return readFileSync(path)
}

function assertQuarantined(bytes: Buffer): void {
  const names = readdirSync(world.state).filter((name) => /^state\.db\.corrupt-.+/.test(name))
  expect(names, 'the damaged state.db is kept for diagnosis').toHaveLength(1)
  expect(readFileSync(join(world.state, names[0]!)), 'quarantine preserves the damaged bytes').toEqual(bytes)
}

function storedValue(name: string): unknown {
  const db = new DatabaseSync(join(world.state, 'state.db'), { readOnly: true })
  try {
    expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
    return (db.prepare('SELECT value FROM kv WHERE key = ?').get(name) as { value: unknown } | undefined)?.value
  } finally { db.close() }
}

test.each(['not-sqlite', 'integrity'] as const)('test_c8_%s_state_is_quarantined_latest_snapshot_restores_owner_and_announces_its_date', { timeout: 100_000 }, async (mode) => {
  seedOwner()
  const store = openStore(join(world.state, 'state.db'))
  try {
    store.kv.set('resilience.marker', 'older')
    makeSnapshot({ home: world.state, db: store.db, timeZone: 'UTC', now: () => Date.UTC(2026, 0, 1, 4) })
    store.kv.set('resilience.marker', 'latest')
    makeSnapshot({ home: world.state, db: store.db, timeZone: 'UTC', now: () => Date.UTC(2026, 0, 2, 4) })
    store.kv.set('resilience.marker', 'lost-after-snapshot')
  } finally { store.close() }
  const damaged = damageState(mode)
  const daemon = await start()
  assertQuarantined(damaged)
  expect(storedValue('resilience.marker'), 'the latest snapshot wins').toBe('latest')
  expect(storedValue(ownerKey), 'restored owner can receive the recovery notice').toBe(String(owner))
  await waitFor(daemon, 'owner is told about restoration and the snapshot date', () =>
    /восстанов|restor|recover/i.test(ownerTexts()) && /2026-01-02|02[./]01[./]2026/.test(ownerTexts()))
  await ask(daemon)
})

test('test_c8_without_a_snapshot_quarantines_corruption_starts_a_new_database_and_logs_the_loss', { timeout: 70_000 }, async () => {
  const damaged = damageState('not-sqlite')
  const daemon = await start()
  assertQuarantined(damaged)
  expect(storedValue(ownerKey), 'a fresh database has no paired owner').toBeUndefined()
  expect(daemon.log).toMatch(/(?:нов[а-яё]*|пуст[а-яё]*|new|empty|fresh)[^\n]*(?:баз[а-яё]*|state\.db|database)|(?:баз[а-яё]*|state\.db|database)[^\n]*(?:создан|нов[а-яё]*|пуст[а-яё]*|new|empty|fresh)/i)
  expect(daemon.exited).toBe(false)
})

test('test_c9_exec_proxy_socket_error_is_reported_by_exec_and_does_not_stop_owner_turns', { timeout: 90_000 }, async () => {
  seedOwner()
  const daemon = await start({ RESILIENCE_PROXY_FAULT: '1' })
  expect(daemon.log, 'the socket error fixture ran').toContain('[fixture] proxy-listen-fault')
  daemon.child.send({ fault: 'exec-probe' })
  await waitFor(daemon, 'real exec returns a tool error', () => daemon.messages.some((message) => message.kind === 'exec-result'))
  const result = String(daemon.messages.find((message) => message.kind === 'exec-result')?.answer)
  expect(result).toMatch(/proxy|прокси/i)
  expect(result).toMatch(/недоступ|не запущ|ошиб|EADDRINUSE|адрес.*занят|address.*(?:occupied|in use)|unavailable|failed|cannot/i)
  await ask(daemon)
})

test('test_c10_sigterm_during_a_model_stream_exits_zero_within_ten_seconds_inside_the_service_timeout', { timeout: 90_000 }, async () => {
  seedOwner()
  const daemon = await start()
  await ask(daemon)
  const calls = world.modelCalls
  world.holdModel = true
  say('долгий ход модели для проверки SIGTERM')
  await waitFor(daemon, 'model turn is in flight against an unfinished SSE stream', () => world.modelCalls > calls)
  const sentAt = Date.now()
  daemon.child.kill('SIGTERM')
  await waitFor(daemon, 'SIGTERM completes within ten seconds', () => daemon.exited, 10_000)
  expect(daemon.result).toEqual({ code: 0, signal: null })
  expect(Date.now() - sentAt).toBeLessThanOrEqual(10_000)
  const configured = serviceValues().get('TimeoutStopSec') ?? ''
  expect(configured).toMatch(/^15(?:s)?$/)
})
