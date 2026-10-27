// Scenario checks of the character in the owner's system prefix. The daemon runs as a child process against a
// fake Telegram Bot API and a local DeepSeek stub (same harness as packages/app/turn-rules.test.ts); the test
// reads the system prompt of the first model request of an owner turn and checks that the provisions of
// persona/character.md are in it and that the whole prefix fits the size limit.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 170_000
const WAIT_MS = 45_000
const TURN_WAIT_MS = 150_000
const LONG_POLL_HOLD_MS = 20_000

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7
const MARKER = 'turn-ch-1'
const PREFIX_LIMIT_TOKENS = 6500

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

// --- fake servers ---------------------------------------------------------------------------------------

interface DsCall {
  body: JsonObject
}

interface Seen {
  modelCalls: DsCall[]
  sentTexts: string[]
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
    // garbage: no fields
  }
  return {}
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function textStream(text: string): string {
  return [
    sse('message_start', {
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
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
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
      if (typeof block === 'string') return block
      const b = asObject(block)
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

/** The system prompt of a model request: the `system` field, or the leading system messages. */
function systemTextOf(body: JsonObject): string {
  const field = flatten(body.system)
  if (field) return field
  const leading: string[] = []
  for (const m of messagesOf(body)) {
    if (m.role !== 'system' && m.role !== 'developer') break
    leading.push(flatten(m.content))
  }
  return leading.join('')
}

function ownsMarker(body: JsonObject): boolean {
  return messagesOf(body).some((m) => m.role === 'user' && flatten(m.content).includes(MARKER))
}

async function startStub(seen: Seen): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (isModelCall) seen.modelCalls.push({ body })
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(ownsMarker(body) ? `fin ${MARKER}` : 'pong'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

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

async function startTelegram(seen: Seen): Promise<FakeTelegram> {
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
      if ((method === 'sendMessage' || method === 'sendRichMessage') && params.chat_id === OWNER_CHAT) {
        seen.sentTexts.push(JSON.stringify(params))
      }
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

// --- the daemon as a child process ------------------------------------------------------------------------

interface Daemon {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: Promise<unknown>
  exited: boolean
}

interface World {
  seen: Seen
  tg: FakeTelegram
  stub: { server: Server; origin: string }
  daemon: Daemon
}

let scratch: string
let worldPromise: Promise<World> | undefined

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (npm start entry point of the daemon)').toBe('string')
  return script as string
}

function output(d: Daemon): string {
  return `--- stdout ---\n${d.stdout.slice(-3000)}\n--- stderr ---\n${d.stderr.slice(-3000)}`
}

async function waitFor(what: string, cond: () => boolean, d?: Daemon, timeoutMs = WAIT_MS): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}\n${d ? output(d) : ''}`).toBe(true)
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

async function startWorld(): Promise<World> {
  const seen: Seen = { modelCalls: [], sentTexts: [] }
  const stub = await startStub(seen)
  const tg = await startTelegram(seen)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(mkdtempSync(join(scratch, 'state-')), 'dshbot')
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: dshbotHome,
    DEEPSEEK_BASE_URL: `${stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: tg.origin,
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn('sh', ['-c', `exec ${startScript()}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const daemon: Daemon = {
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exit: new Promise((resolve) => {
      child.on('close', () => {
        daemon.exited = true
        resolve(undefined)
      })
    }),
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    daemon.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  const world: World = { seen, tg, stub, daemon }

  await waitFor('the daemon to start long polling', () => tg.polls > 0 || daemon.exited, daemon)
  expect(daemon.exited, `daemon exited during start\n${output(daemon)}`).toBe(false)
  await sleep(300)

  // the first private chat pairs as the owner with the one-time code from the journal
  tg.push(privateMessage(OWNER_CHAT, 'hello'))
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(daemon.stderr).length > 0 && seen.sentTexts.length > 0,
    daemon,
  )
  const sentBefore = seen.sentTexts.length
  tg.push(privateMessage(OWNER_CHAT, pairingCandidates(daemon.stderr)[0] as string))
  await waitFor('the pairing confirmation', () => seen.sentTexts.length > sentBefore, daemon)

  tg.push(privateMessage(OWNER_CHAT, `${MARKER} привет, как дела?`))
  await waitFor(
    `the reply of turn ${MARKER}`,
    () => seen.sentTexts.some((text) => text.includes(`fin ${MARKER}`)),
    daemon,
    TURN_WAIT_MS,
  )
  return world
}

function world(): Promise<World> {
  worldPromise ??= startWorld()
  return worldPromise
}

/** The system prompt of the first model request of the owner turn. */
async function ownerSystemPrompt(): Promise<string> {
  const w = await world()
  const call = w.seen.modelCalls.find((c) => c.body.stream !== false && ownsMarker(c.body))
  expect(call, `the model was not asked in turn ${MARKER}\n${output(w.daemon)}`).toBeDefined()
  const system = systemTextOf((call as DsCall).body)
  expect(system.length, 'the system prefix must reach the model').toBeGreaterThan(1000)
  return system
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-ch-')))
})

afterAll(async () => {
  if (worldPromise !== undefined) {
    const w = await worldPromise.catch(() => undefined)
    if (w !== undefined) {
      if (!w.daemon.exited) w.daemon.child.kill('SIGKILL')
      await w.daemon.exit
      await closeServer(w.tg.server)
      await closeServer(w.stub.server)
    }
  }
  rmSync(scratch, { recursive: true, force: true })
})

// --- the character file -------------------------------------------------------------------------------------

const characterPath = join(repoRoot, 'persona', 'character.md')

function readCharacter(): string {
  expect(existsSync(characterPath), 'persona/character.md must exist: the character lives there').toBe(true)
  return readFileSync(characterPath, 'utf8')
}

/** Lines of the character file that must reach the model as written (headings are the prefix builder's business). */
function characterLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('<!--'))
}

function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?…\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** The character text, after checking that the owner's prefix carries it line by line. */
async function carriedCharacter(): Promise<string> {
  const character = readCharacter()
  const lines = characterLines(character)
  expect(lines.length, 'persona/character.md must hold a real body').toBeGreaterThan(3)
  const system = await ownerSystemPrompt()
  for (const line of lines) {
    expect(system, `the owner's system prefix must carry the character line: ${line}`).toContain(line)
  }
  return character
}

// --- [c1] dialog --------------------------------------------------------------------------------------------

test('test_c1_prefix_has_dialog_section_message_is_a_replica_and_queue_is_not_a_result', { timeout: TEST_TIMEOUT_MS }, async () => {
  const character = await carriedCharacter()
  expect(character, 'the owner message is a replica in a conversation').toMatch(/реплик\S*/i)
  expect(character).toMatch(/разговор/i)
  expect(character, 'not a task in a queue').toMatch(/задач\S*\s+в\s+очеред/i)
  const banned = sentencesOf(character).filter(
    (s) => /очеред/i.test(s) && /результат|итог|сделан|выполн/i.test(s) && /(?<![а-яё])не(?![а-яё])|нельзя|запрещ|никогда|не\s+выдавай/i.test(s),
  )
  expect(banned.length, 'a sentence must forbid passing "put in the queue" off as a result').toBeGreaterThan(0)
})

// --- [c2] decision loop -------------------------------------------------------------------------------------

test('test_c2_prefix_has_decision_loop_exactly_one_of_five_decisions', { timeout: TEST_TIMEOUT_MS }, async () => {
  const character = await carriedCharacter()
  expect(character, 'exactly one decision per message').toMatch(/ровно\s+(?:одно|один|одну|1)/i)
  expect(character, 'answer at once').toMatch(/(?:ответ\S*|отвеч\S*)\s+сразу/i)
  expect(character, 'do it yourself').toMatch(/(?:сдела\S*|сдела\S*|дела\S*)\s+сам/i)
  expect(character, 'delegate').toMatch(/делегир/i)
  expect(character, 'move to a background task').toMatch(/фонов/i)
  expect(character, 'say what you think').toMatch(/что\s+(?:ты\s+)?дума\S*|высказ\S*|мнени\S*/i)
})

// --- [c3] workmanship and outcome honesty -------------------------------------------------------------------

test('test_c3_prefix_has_workmanship_claims_checked_by_current_evidence_and_explicit_unknown', { timeout: TEST_TIMEOUT_MS }, async () => {
  const character = await carriedCharacter()
  expect(character, 'workmanship').toMatch(/мастерств/i)
  expect(character, 'outcome honesty').toMatch(/честност\S*\s+итог|итог\S*[^.\n]{0,40}честн/i)
  const evidence = sentencesOf(character).filter(
    (s) => /провер/i.test(s) && /доказательств|свидетельств|улик/i.test(s) && /текущ|свеж|актуальн|сейчас|этого\s+хода/i.test(s),
  )
  expect(evidence.length, 'claims are checked with current evidence').toBeGreaterThan(0)
  expect(character, 'the unknown is called unknown').toMatch(/не\s+знаю|неизвестн\S*\s+(?:называй|назови|говори|скажи)/i)
})

// --- [c4] principles and the owner ----------------------------------------------------------------------------

test('test_c4_prefix_has_authenticity_minimalism_becoming_epistemic_stability_and_my_person', { timeout: TEST_TIMEOUT_MS }, async () => {
  const character = await carriedCharacter()
  expect(character, 'authenticity').toMatch(/подлинн/i)
  expect(character, 'minimalism').toMatch(/минимализм|минимальн/i)
  expect(character, 'becoming').toMatch(/становлен/i)
  expect(character, 'becoming runs along three axes').toMatch(/(?:по\s+)?(?:трё?м|трё?х|три)\s+ос\S*/i)
  expect(character, 'epistemic stability').toMatch(/эпистем/i)
  const stability = sentencesOf(character).filter(
    (s) => /identity/i.test(s) && /заметк/i.test(s) && /действи/i.test(s) && /противореч/i.test(s),
  )
  expect(stability.length, 'identity, notes and actions must not contradict each other').toBeGreaterThan(0)

  expect(character, 'a section about my person').toMatch(/мой\s+человек/i)
  const person = sentencesOf(character).filter((s) => /факт/i.test(s) && /приказ|команд|указани/i.test(s) && /(?<![а-яё])не(?![а-яё])/i.test(s))
  expect(person.length, 'about the owner record facts, not orders to yourself').toBeGreaterThan(0)
})

// --- [c5] size ----------------------------------------------------------------------------------------------

test('test_c5_whole_owner_prefix_on_real_files_is_at_most_6500_tokens', { timeout: TEST_TIMEOUT_MS }, async () => {
  readCharacter()
  const system = await ownerSystemPrompt()
  expect(system, 'the real prefix carries the character').toContain('Мой человек')
  const tokens = Math.ceil(Buffer.byteLength(system, 'utf8') / 4)
  expect(tokens, `the whole owner prefix is ${tokens} tokens by bytes/4`).toBeLessThanOrEqual(PREFIX_LIMIT_TOKENS)
})
