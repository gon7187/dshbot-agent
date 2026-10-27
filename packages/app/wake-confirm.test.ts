// Confirmations are never requested inside a wake-up (DESIGN §8.2).
//
// The problem this test pins down: a wake-up runs on the same `main` session and
// the same tools as the owner's turn, and all main turns are serialized. If a
// `confirm`-class `exec` command in a wake-up left an approval card and waited
// for `APPROVAL_TTL_MS` (30 minutes), every owner message would queue behind the
// silent wake-up turn. The wake-up must refuse the confirmation at once, leave
// no card, and let the next owner turn start right away.
//
// The daemon runs as a child process against a fake Telegram Bot API and a
// DeepSeek stub (the same pattern as wake-turns.test.ts). The wake-up timer is
// replaced by a module hook that fires one wake-up after WAKE_AFTER_MS, so the
// test does not need the fake clock: everything here is a real wall clock, and a
// blocking approval would simply time the test out.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 150_000
const WAIT_MS = 45_000
/** One wake-up, long enough after the start for the pairing to finish first. */
const WAKE_AFTER_MS = 3_000
const LONG_POLL_HOLD_MS = 20_000
/** A wake-up that was not blocked is over in well under this. */
const OWNER_ANSWER_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7
const SILENT = '[SILENT]'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function parseObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // multipart or garbage: keep the raw text
  }
  return { __raw: raw }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

// --- timeline --------------------------------------------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
}

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
  kind: 'owner' | 'wake'
  step: number
  result: { text: string; isError: boolean } | undefined
}

type Event = TgEvent | DsEvent

interface Timeline {
  events: Event[]
  seq: number
}

// --- the scripted model ----------------------------------------------------------------------

type Reply = { text: string } | { tool: string; input: JsonObject }

type Plan = (step: number) => Reply

interface Stub {
  server: Server
  origin: string
  wake: Plan[]
  wakeCalls: DsEvent[]
  ownerCalls: DsEvent[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function messageStart(): string {
  return sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-flash',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function textStream(text: string): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

function toolUseStream(id: string, name: string, input: JsonObject): string {
  return [
    messageStart(),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('tool_use'),
  ].join('')
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((raw) => {
      const block = asObject(raw)
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .join('')
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

function hasToolResult(message: JsonObject): boolean {
  return Array.isArray(message.content) && message.content.some((part) => asObject(part).type === 'tool_result')
}

function lastToolResult(body: JsonObject): { text: string; isError: boolean } | undefined {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = asObject(part)
      if (block.type !== 'tool_result') continue
      return { text: flatten(block.content), isError: block.is_error === true }
    }
  }
  return undefined
}

const OWNER_PREFIX = /^own-([a-z0-9]+)/

/** Which turn a model request belongs to; the last user text opens it. */
function turnOf(body: JsonObject): { kind: 'owner' | 'wake'; step: number } {
  const messages = messagesOf(body)
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at] as JsonObject
    if (message.role !== 'user') continue
    const text = flatten(message.content)
    if (text.trim() === '' && hasToolResult(message)) continue
    const step = messages.slice(at + 1).filter((m) => m.role === 'assistant').length
    return { kind: OWNER_PREFIX.test(text.trim()) ? 'owner' : 'wake', step }
  }
  return { kind: 'wake', step: 0 }
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    wake: [],
    wakeCalls: [],
    ownerCalls: [],
  }
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [{ type: 'text', text: 'pong' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        )
        return
      }

      const opened = turnOf(body)
      const result = opened.step > 0 ? lastToolResult(body) : undefined
      timeline.seq += 1
      const event: DsEvent = { n: timeline.seq, src: 'ds', body, kind: opened.kind, step: opened.step, result }
      timeline.events.push(event)
      if (opened.kind === 'wake') stub.wakeCalls.push(event)
      else stub.ownerCalls.push(event)

      const plan = opened.kind === 'wake' ? stub.wake[0] : undefined
      const reply: Reply = plan ? plan(opened.step) : { text: opened.kind === 'wake' ? SILENT : 'pong-after' }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if ('text' in reply) res.end(textStream(reply.text))
      else res.end(toolUseStream(`toolu_${event.n}`, reply.tool, reply.input))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API -------------------------------------------------------------------

interface QueuedUpdate {
  update: JsonObject
  delivered: boolean
}

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeTelegram {
  server: Server
  origin: string
  queue: QueuedUpdate[]
  holders: Holder[]
  polls: number
  sentIds: number
  push(update: JsonObject): void
}

function flushQueue(tg: FakeTelegram): void {
  const ready = tg.queue.filter((q) => !q.delivered)
  const holder = ready.length > 0 ? tg.holders.shift() : undefined
  if (!holder) return
  clearTimeout(holder.timer)
  for (const q of ready) q.delivered = true
  holder.res.writeHead(200, { 'content-type': 'application/json' })
  holder.res.end(JSON.stringify({ ok: true, result: ready.map((q) => q.update) }))
}

function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    tg.sentIds += 1
    const chatId = typeof params.chat_id === 'number' ? params.chat_id : OWNER_CHAT
    return {
      message_id: 9000 + tg.sentIds,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      text: '',
    }
  }
  return true
}

async function startTelegram(timeline: Timeline): Promise<FakeTelegram> {
  const tg: FakeTelegram = {
    server: undefined as unknown as Server,
    origin: '',
    queue: [],
    holders: [],
    polls: 0,
    sentIds: 0,
    push(update) {
      tg.queue.push({ update, delivered: false })
      flushQueue(tg)
    },
  }
  tg.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const match = /^\/bot(.+)\/([A-Za-z]+)$/.exec((req.url ?? '').split('?')[0] ?? '')
      const method = match?.[2] ?? ''
      const params = parseObject(raw)
      timeline.seq += 1
      timeline.events.push({ n: timeline.seq, src: 'tg', method, params })

      const reply = (status: number, body: string): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body)
      }
      if (!match || decodeURIComponent(match[1] ?? '') !== BOT_TOKEN) {
        reply(401, JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
        return
      }
      if (method === 'getUpdates') {
        tg.polls += 1
        const offset = typeof params.offset === 'number' ? params.offset : undefined
        tg.queue = tg.queue.filter(
          (q) => !(q.delivered && offset !== undefined && (q.update.update_id as number) < offset),
        )
        if (tg.queue.length > 0) {
          for (const q of tg.queue) q.delivered = true
          reply(200, JSON.stringify({ ok: true, result: tg.queue.map((q) => q.update) }))
          return
        }
        const holder: Holder = {
          res,
          timer: setTimeout(() => {
            const at = tg.holders.indexOf(holder)
            if (at >= 0) tg.holders.splice(at, 1)
            reply(200, JSON.stringify({ ok: true, result: [] }))
          }, LONG_POLL_HOLD_MS),
        }
        tg.holders.push(holder)
        res.on('close', () => {
          clearTimeout(holder.timer)
          const at = tg.holders.indexOf(holder)
          if (at >= 0) tg.holders.splice(at, 1)
        })
        return
      }
      reply(200, JSON.stringify({ ok: true, result: okResult(tg, method, params) }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

let nextMessageId = 100
let updateCounter = 5000

function privateMessage(chatId: number, text: string): JsonObject {
  updateCounter += 1
  nextMessageId += 1
  return {
    update_id: updateCounter,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      text,
    },
  }
}

// --- module hook: one fast wake-up instead of the 15..240 min alarm ---------------

// The app imports the wake package by relative path; the hook reroutes that import
// to a shim that re-exports the real module and replaces only `createWakeScheduler`.
const HOOKS_PRELOAD = `
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.includes('/packages/app/src/') && /consciousness\\/src\\/index\\.js$/.test(specifier)) {
      return { url: process.env.SHIM_CONSCIOUSNESS, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
`

function wakeShim(realUrl: string): string {
  return `
import * as real from ${JSON.stringify(realUrl)}
export * from ${JSON.stringify(realUrl)}

// Fire exactly one wake-up after WAKE_AFTER_MS; no fake clock is needed for the
// approval question. The interval bookkeeping is the real package's business and
// is covered by packages/consciousness/wake.test.ts.
export function createWakeScheduler(options) {
  let interval = 15
  let stopped = false
  let running = false
  let handle
  let fired = false

  async function fire() {
    handle = undefined
    if (stopped || running || fired) return
    fired = true
    running = true
    try {
      await options.runTurn()
    } catch (error) {
      options.onError?.(error)
    } finally {
      running = false
    }
  }

  return {
    start() {
      if (stopped || handle !== undefined) return
      handle = setTimeout(fire, Number(process.env.WAKE_AFTER_MS) || 3000)
    },
    stop() {
      stopped = true
      if (handle !== undefined) clearTimeout(handle)
      handle = undefined
    },
    setNextInterval(minutes) {
      interval = minutes
      return interval
    },
    intervalMinutes: () => interval,
    nextWakeAt: () => undefined,
    isRunning: () => running,
  }
}
`
}

// --- the daemon as a child process -------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  exited: boolean
}

interface World {
  timeline: Timeline
  tg: FakeTelegram
  stub: Stub
  home: string
  dshbotHome: string
  workspace: string
  runtimeDir: string
  daemons: Daemon[]
}

let scratch: string
let hooksPreload: string
let shimConsciousness: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

function spawnDaemon(): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    WAKE_AFTER_MS: String(WAKE_AFTER_MS),
    SHIM_CONSCIOUSNESS: pathToFileURL(shimConsciousness).href,
    NODE_OPTIONS: `--import ${pathToFileURL(hooksPreload).href}`,
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn('sh', ['-c', `exec ${startScript()}`], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const daemon: Daemon = {
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exit: new Promise((resolve) => {
      child.on('close', (code, signal) => {
        daemon.exited = true
        resolve({ code, signal })
      })
    }),
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    daemon.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  world.daemons.push(daemon)
  return daemon
}

function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
}

function sentTo(chatId: number): TgEvent[] {
  return world.timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' &&
      (e.method === 'sendMessage' || e.method === 'sendRichMessage') &&
      e.params.chat_id === chatId,
  )
}

function pairingCandidates(fresh: string): string[] {
  const found: Array<{ token: string; rank: number; hinted: number; at: number }> = []
  let at = 0
  for (const line of fresh.split('\n')) {
    const hinted = /code|код|pair/i.test(line) ? 0 : 1
    for (const token of line.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g) ?? []) {
      at += 1
      if (token.length < 6) continue
      if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
      if ([BOT_TOKEN, DEEPSEEK_KEY, BOT_TOKEN.split(':')[1] ?? ''].some((s) => s.includes(token))) continue
      found.push({ token, rank: /\d/.test(token) ? 0 : /^[a-z]+$/.test(token) ? 2 : 1, hinted, at })
    }
  }
  found.sort((a, b) => a.rank - b.rank || a.hinted - b.hinted || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
}

async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  world.tg.push(privateMessage(OWNER_CHAT, 'hello'))
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  world.tg.push(privateMessage(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string))
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

// --- lifecycle ---------------------------------------------------------------------------------

function makeScratch(): string {
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-wake-confirm-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
  hooksPreload = join(scratch, 'module-hooks.mjs')
  writeFileSync(hooksPreload, HOOKS_PRELOAD)
  shimConsciousness = join(scratch, 'consciousness-shim.mjs')
  writeFileSync(
    shimConsciousness,
    wakeShim(pathToFileURL(join(repoRoot, 'packages', 'consciousness', 'src', 'index.ts')).href),
  )
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  const workspace = join(dshbotHome, 'workspace')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace,
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    daemons: [],
  }
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited) d.child.kill('SIGKILL')
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

// --- [h4] -------------------------------------------------------------------------------------

test('test_wake_confirm_exec_is_refused_without_a_card_and_the_next_owner_turn_does_not_wait', { timeout: TEST_TIMEOUT_MS }, async () => {
  // A directory the confirm-class command would delete if it ever ran.
  const doomed = join(world.workspace, 'keep-me')
  mkdirSync(doomed, { recursive: true })

  // The wake-up calls exec with `rm -rf` (the guard says "confirm") and then ends silently.
  world.stub.wake.push((step) => (step === 0 ? { tool: 'exec', input: { command: 'rm -rf keep-me' } } : { text: SILENT }))

  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > 0 || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  await pairOwner(d)

  // The wake-up turn reaches the model and finishes without ever asking the owner.
  await waitFor('the wake-up to call exec', () => world.stub.wakeCalls.length >= 2, d)
  const wakeStart = world.stub.wakeCalls[0] as DsEvent
  const wakeAfterTool = world.stub.wakeCalls[1] as DsEvent
  expect(wakeAfterTool.result, 'the model got a tool result for the refused exec').toBeDefined()
  expect(wakeAfterTool.result?.isError, 'the confirm-class exec was refused').toBe(true)
  expect(wakeAfterTool.result?.text, 'the refusal explains that wake-ups do not ask for confirmation').toMatch(
    /в пробуждении подтверждения не запрашиваются/i,
  )
  expect(wakeAfterTool.result?.text, 'the command did not run').not.toContain('exit 0')
  expect(existsSync(doomed), 'the confirm-class command did not run in the wake-up').toBe(true)

  // No approval card (a sendMessage with inline buttons) was left for the owner.
  const cards = sentTo(OWNER_CHAT).filter((event) => event.params.reply_markup !== undefined)
  expect(cards, `a wake-up left an approval card: ${JSON.stringify(cards)}`).toEqual([])

  // The wake-up turn is over; the next owner turn must not queue behind an approval.
  const sentBefore = sentTo(OWNER_CHAT).length
  world.tg.push(privateMessage(OWNER_CHAT, 'own-after после пробуждения'))
  const started = Date.now()
  while (Date.now() - started < OWNER_ANSWER_MS && sentTo(OWNER_CHAT).length <= sentBefore) await sleep(50)
  expect(sentTo(OWNER_CHAT).length, `the owner turn did not get an answer\n${output(d)}`).toBeGreaterThan(sentBefore)
  const ownerCalls = world.stub.ownerCalls
  expect(ownerCalls.length, 'the owner turn reached the model').toBeGreaterThan(0)
  const ownerCall = ownerCalls[ownerCalls.length - 1] as DsEvent
  expect(ownerCall.n, 'the owner turn comes after the wake-up turn').toBeGreaterThan(wakeStart.n)
  expect(sentTo(OWNER_CHAT).slice(sentBefore).map((event) => JSON.stringify(event.params)).join('\n')).toContain(
    'pong-after',
  )
})

test('test_wake_confirm_without_a_paired_owner_still_refuses_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  world.stub.wake.push((step) => (step === 0 ? { tool: 'exec', input: { command: 'rm -rf keep-me' } } : { text: SILENT }))
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > 0 || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)

  await waitFor('the wake-up to call exec', () => world.stub.wakeCalls.length >= 2, d)
  const result = world.stub.wakeCalls[1]?.result
  expect(result?.isError, 'the confirm-class exec was refused before an owner existed').toBe(true)
  expect(sentTo(OWNER_CHAT), 'no message and no card is sent into an unpaired chat').toEqual([])
})
