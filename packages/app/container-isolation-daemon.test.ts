// The whole daemon inside the container: scripts/dshbot-run.sh with DSHBOT_ISOLATION=container starts the same
// entry point as `npm start`, but in bwrap with fake root. Same harness as exec-tool.test.ts, cut down: the daemon
// runs as a child process (here: the launcher) against a fake Telegram Bot API and a local DeepSeek stub. The stub
// answers `run-tool-N` with one exec call and everything else with `pong`. The exec runs in the nested sandbox of
// the tool; its effects are checked on disk and in the tool result.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const launcher = join(repoRoot, 'scripts', 'dshbot-run.sh')

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'

const OWNER_CHAT = 7

const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

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
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

// --- timeline of everything the two fake servers saw ---------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
}

interface Timeline {
  events: TgEvent[]
  seq: number
}

// --- the scripted model --------------------------------------------------------------------------

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
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  })
}

function messageEnd(stopReason: string): string {
  return [
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function pongStream(): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('end_turn'),
  ].join('')
}

function toolUseStream(id: string, name: string, input: JsonObject): string {
  return [
    messageStart(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    messageEnd('tool_use'),
  ].join('')
}

function pongMessage(): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  })
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      const b = asObject(block)
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/** Names of the properties of the input schema of the tool `name` in a model request. */
function inputProps(body: JsonObject, name: string): string[] | undefined {
  const tools = Array.isArray(body.tools) ? body.tools : []
  for (const raw of tools) {
    const tool = asObject(raw)
    const fn = asObject(tool.function)
    if ((tool.name ?? fn.name) !== name) continue
    const schema = asObject(tool.input_schema ?? tool.parameters ?? fn.parameters)
    return Object.keys(asObject(schema.properties))
  }
  return undefined
}

function lastToolResult(body: JsonObject): { id: string; text: string; isError: boolean } | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const raw of messages.slice(-2).reverse()) {
    const message = asObject(raw)
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      const block = asObject(part)
      if (block.type !== 'tool_result') continue
      return { id: String(block.tool_use_id ?? ''), text: flatten(block.content), isError: block.is_error === true }
    }
  }
  return undefined
}

function lastUserText(body: JsonObject): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = asObject(messages[messages.length - 1])
  return last.role === 'user' ? flatten(last.content) : ''
}

interface Outcome {
  /** the tool is not among the tools[] of the model request */
  missing?: string
  result?: { text: string; isError: boolean }
}

interface Stub {
  server: Server
  origin: string
  commands: Map<number, string>
  outcomes: Map<number, Outcome>
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', commands: new Map(), outcomes: new Map() }
  const pending = new Map<string, number>()
  stub.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      const result = lastToolResult(body)
      if (result !== undefined) {
        const n = pending.get(result.id)
        const outcome = n === undefined ? undefined : stub.outcomes.get(n)
        if (outcome !== undefined) outcome.result = { text: result.text, isError: result.isError }
        res.end(pongStream())
        return
      }

      const marker = /run-tool-(\d+)/.exec(lastUserText(body))
      const n = marker === null ? undefined : Number(marker[1])
      const command = n === undefined ? undefined : stub.commands.get(n)
      if (n === undefined || command === undefined || stub.outcomes.has(n)) {
        res.end(pongStream())
        return
      }
      const outcome: Outcome = {}
      stub.outcomes.set(n, outcome)
      const props = inputProps(body, 'exec')
      if (props === undefined) {
        outcome.missing = 'tool "exec" is not in tools[]'
        res.end(pongStream())
        return
      }
      const key = ['command', 'cmd', 'script', 'shell', 'code'].find((name) => props.includes(name)) ?? 'command'
      pending.set(`toolu_${n}`, n)
      res.end(toolUseStream(`toolu_${n}`, 'exec', { [key]: command }))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP -------------------------------------------------------

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeTelegram {
  server: Server
  origin: string
  queue: Array<{ update: JsonObject; delivered: boolean }>
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
    return { message_id: 9000 + tg.sentIds, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, text: '' }
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
        tg.queue = tg.queue.filter((q) => !(q.delivered && offset !== undefined && (q.update.update_id as number) < offset))
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

function sentTo(timeline: Timeline, chatId: number): TgEvent[] {
  return timeline.events.filter(
    (e) => (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId,
  )
}

function pongsTo(timeline: Timeline, chatId: number): TgEvent[] {
  return sentTo(timeline, chatId).filter((e) => JSON.stringify(e.params).includes('pong'))
}

// --- the daemon behind the launcher ---------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exited: boolean
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
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
  callSeq: number
}

let scratch: string
let world: World

function makeScratch(): string {
  // /var/tmp first: the container and the sandbox get their own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-container-daemon-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

beforeAll(() => {
  scratch = makeScratch()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  const timeline: Timeline = { events: [], seq: 0 }
  const stub = await startStub()
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    workspace: join(dshbotHome, 'workspace'),
    runtimeDir: mkdtempSync(join(scratch, 'run-')),
    daemons: [],
    callSeq: 0,
  }
  mkdirSync(world.workspace, { recursive: true })
})

afterEach(async () => {
  for (const d of world.daemons) {
    if (!d.exited && d.child.pid !== undefined) {
      try {
        process.kill(-d.child.pid, 'SIGKILL')
      } catch {
        d.child.kill('SIGKILL')
      }
    }
    await d.exit
  }
  await closeServer(world.tg.server)
  await closeServer(world.stub.server)
})

function startScript(): string[] {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  // "node --import ./packages/app/register.mjs ./packages/app/src/main.ts": the unit passes the same argv to the launcher
  const [, ...args] = (script as string).split(/\s+/)
  return [process.execPath, ...args]
}

function spawnLauncher(): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    NODE_ENV: 'production',
    NODE_COMPILE_CACHE: join(world.dshbotHome, 'compile-cache'),
    DSHBOT_ISOLATION: 'container',
    // The gate's fallback node_modules links to a source outside the application root.
    DSHBOT_CONTAINER_RO: dirname(realpathSync(join(repoRoot, 'node_modules', '.bin'))),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn(BASH, [launcher, ...startScript()], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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

function say(chatId: number, text: string): void {
  world.tg.push(privateMessage(chatId, text))
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

/** The first private chat pairs as the owner with the one-time code from the journal (stderr of the daemon). */
async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(world.timeline, OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(world.timeline, OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnLauncher()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `the daemon behind the launcher exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  await pairOwner(d)
  return d
}

/** The owner asks the model to run `command` in exec; resolves with what the tool answered. */
async function useExec(d: Daemon, command: string): Promise<{ text: string; isError: boolean }> {
  world.callSeq += 1
  const n = world.callSeq
  world.stub.commands.set(n, command)
  const pongs = pongsTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, `run-tool-${n}`)
  await waitFor(
    `a pong answer to call ${n}`,
    () => pongsTo(world.timeline, OWNER_CHAT).length > pongs || world.stub.outcomes.get(n)?.missing !== undefined,
    d,
  )
  const outcome = world.stub.outcomes.get(n)
  expect(outcome?.missing, 'the tool exec must be offered to the owner').toBeUndefined()
  await waitFor(`the result of call ${n} to reach the model`, () => world.stub.outcomes.get(n)?.result !== undefined, d)
  return (world.stub.outcomes.get(n) as Outcome).result as { text: string; isError: boolean }
}

// --- c6 -------------------------------------------------------------------------------------------------

test('test_c6_daemon_in_the_container_answers_the_owner_and_exec_runs_in_its_nested_sandbox', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  // the owner gets an answer from the model through the fake API: the daemon works inside
  const pongs = pongsTo(world.timeline, OWNER_CHAT).length
  say(OWNER_CHAT, 'ping')
  await waitFor('a pong answer to the plain message', () => pongsTo(world.timeline, OWNER_CHAT).length > pongs, d)

  // exec: the workspace is writable, the rest of DSHBOT_HOME is not, and the sandbox is the nested one
  const outside = join(world.dshbotHome, 'outside-workspace.txt')
  const command = [
    `echo ws-ok > '${join(world.workspace, 'written.txt')}'`,
    `echo x > '${outside}' 2>/dev/null; true`,
    'echo "EXEC-UID=$(id -u)"',
    'echo EXEC-DONE',
  ].join('; ')
  const result = await useExec(d, command)

  expect(result.text, `the exec must run its command\n${result.text}`).toContain('EXEC-DONE')
  expect(readFileSync(join(world.workspace, 'written.txt'), 'utf8'), 'the workspace is writable from the exec sandbox').toBe('ws-ok\n')
  expect(existsSync(outside), 'what the sandbox writes outside the workspace stays in the sandbox').toBe(false)
  // the daemon is fake root in the container, and the sandbox of the exec keeps that uid
  expect(result.text, 'the daemon runs as fake root inside the container').toContain('EXEC-UID=0')
})
