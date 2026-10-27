// Guest isolation uses the same daemon/file-download/model harness as attachments-main-context.test.ts.
// Match the opening boundary of a data frame; the marker name alone can occur in the system rule.
import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 240_000
const WAIT_MS = 45_000
const LONG_WAIT_MS = 90_000
const LONG_POLL_HOLD_MS = 20_000
/** A little over the real-time pace limit of a guest. */
const GUEST_GAP_MS = 3_200
/** The gap between "the result went to the owner" and the next owner turn. */
const SETTLE_MS = 600

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7
const GUEST_CHAT = 5550001

const FILE_NAME = 'zzreport.pdf'
const FILE_MIME = 'application/pdf'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A PDF with one page of text. */
function buildPdf(text: string): Buffer {
  const stream = `BT /F1 14 Tf 72 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// --- timeline of everything the two fakes saw ---------------------------------------------------------

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
  /** message_id the fake handed out for a send */
  messageId?: number
}

type Kind = 'main' | 'guest' | 'intake' | 'other'

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
  kind: Kind
  /** tag of an `own-<tag>` or `gst-<tag>` turn */
  tag: string
  /** the whole request as JSON */
  json: string
}

type Event = TgEvent | DsEvent

interface Timeline {
  events: Event[]
  seq: number
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

// --- the scripted model --------------------------------------------------------------------------------

type Script = (call: DsEvent) => { text: string } | Promise<{ text: string }>

interface Stub {
  server: Server
  origin: string
  /** script of the analysis sessions; the default ends at once */
  intake: Script
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
        usage: { input_tokens: 4321, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('ping', { type: 'ping' }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 77 },
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

/** Text of a message content: text blocks and the text inside tool results. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const b = asObject(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'tool_result') return textOfContent(b.content)
      return ''
    })
    .join('\n')
}

function messagesOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body.messages) ? body.messages.map(asObject) : []
}

/** What the model is told in this turn: the messages after its last answer. */
function tailOf(body: JsonObject): string {
  const messages = messagesOf(body)
  let from = 0
  messages.forEach((message, i) => {
    if (message.role === 'assistant') from = i + 1
  })
  return messages
    .slice(from)
    .filter((message) => message.role === 'user')
    .map((message) => textOfContent(message.content))
    .join('\n')
}

const OWNER_TURN = /\bown-([a-z0-9]+)/
const GUEST_TURN = /\bgst-([a-z0-9]+)/

function classify(body: JsonObject): { kind: Kind; tag: string } {
  const tail = tailOf(body)
  const owner = OWNER_TURN.exec(tail)
  if (owner !== null) return { kind: 'main', tag: owner[1] as string }
  const guest = GUEST_TURN.exec(tail)
  if (guest !== null) return { kind: 'guest', tag: guest[1] as string }
  const history = messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => textOfContent(m.content))
  if (history.some((text) => OWNER_TURN.test(text) || GUEST_TURN.test(text))) return { kind: 'other', tag: '' }
  if (/<file |zz[a-z0-9]/i.test(JSON.stringify(messagesOf(body)))) return { kind: 'intake', tag: '' }
  return { kind: 'other', tag: '' }
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = {
    server: undefined as unknown as Server,
    origin: '',
    intake: () => ({ text: 'INTAKE-DONE' }),
  }
  stub.server = createServer((req, res) => {
    void readBody(req).then(async (raw) => {
      const body = parseObject(raw)
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      const { kind, tag } = classify(body)
      timeline.seq += 1
      const event: DsEvent = { n: timeline.seq, src: 'ds', body, kind, tag, json: JSON.stringify(body) }
      timeline.events.push(event)

      let text: string
      if (kind === 'intake') text = (await stub.intake(event)).text
      else if (kind === 'main' || kind === 'guest') text = `pong-${tag}`
      else text = '[SILENT]'

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(text))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP ----------------------------------------------------------------

interface QueuedUpdate {
  update: JsonObject
  delivered: boolean
}

interface Holder {
  res: ServerResponse
  timer: NodeJS.Timeout
}

interface FakeFile {
  path: string
  data: Buffer
}

interface FakeTelegram {
  server: Server
  origin: string
  queue: QueuedUpdate[]
  holders: Holder[]
  polls: number
  sentIds: number
  /** files the bot may fetch, by file_id */
  files: Map<string, FakeFile>
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

/** A field of a Bot API call: from the JSON body or from a multipart form. */
function fieldOf(params: JsonObject, name: string): string | undefined {
  const direct = params[name]
  if (direct !== undefined) return typeof direct === 'object' ? JSON.stringify(direct) : String(direct)
  const raw = params.__raw
  if (typeof raw !== 'string') return undefined
  const form = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)
  return form?.[1]
}

function chatOf(params: JsonObject): number {
  const chat = Number(fieldOf(params, 'chat_id'))
  return Number.isFinite(chat) ? chat : OWNER_CHAT
}

const SEND_METHODS = new Set(['sendMessage', 'sendRichMessage', 'sendDocument', 'sendPhoto'])

function okResult(tg: FakeTelegram, method: string, params: JsonObject): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
  if (SEND_METHODS.has(method)) {
    tg.sentIds += 1
    return {
      message_id: 9000 + tg.sentIds,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatOf(params), type: 'private' },
      text: '',
    }
  }
  if (method === 'getFile') {
    const id = String(params.file_id ?? '')
    const file = tg.files.get(id)
    return file === undefined
      ? undefined
      : { file_id: id, file_unique_id: `u-${id}`, file_size: file.data.length, file_path: file.path }
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
    files: new Map(),
    push(update) {
      tg.queue.push({ update, delivered: false })
      flushQueue(tg)
    },
  }
  tg.server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const url = (req.url ?? '').split('?')[0] ?? ''
      const reply = (status: number, body: string | Buffer, type = 'application/json'): void => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }

      const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(url)
      if (download !== null) {
        const path = decodeURIComponent(download[2] ?? '')
        const file = [...tg.files.values()].find((f) => f.path === path)
        if (decodeURIComponent(download[1] ?? '') !== BOT_TOKEN || file === undefined) {
          reply(404, JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }))
          return
        }
        reply(200, file.data, 'application/octet-stream')
        return
      }

      const match = /^\/bot(.+)\/([A-Za-z]+)$/.exec(url)
      const method = match?.[2] ?? ''
      const params = parseObject(raw)
      timeline.seq += 1
      const event: TgEvent = { n: timeline.seq, src: 'tg', method, params }
      timeline.events.push(event)

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
      if (method === 'getFile' && !tg.files.has(String(params.file_id ?? ''))) {
        reply(400, JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file_id' }))
        return
      }
      const result = okResult(tg, method, params)
      if (SEND_METHODS.has(method)) event.messageId = (result as { message_id: number }).message_id
      reply(200, JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

// --- update builders -----------------------------------------------------------------------------------------

let nextMessageId = 100
let updateCounter = 5000
let fileCounter = 0

function privateMessage(chatId: number, text: string, replyTo?: number): JsonObject {
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
      ...(replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: replyTo,
              date: Math.floor(Date.now() / 1000),
              chat: { id: chatId, type: 'private', first_name: 'T' },
              from: { id: 4242, is_bot: true, first_name: 'DSHBOT' },
              text: 'bot message',
            },
          }),
    },
  }
}

/** The owner sends a document; the fake serves it by getFile. Returns the id of the message. */
function sendFile(data: Buffer, caption = 'что по файлу?'): number {
  fileCounter += 1
  const id = `zzfile${fileCounter}`
  world.tg.files.set(id, { path: `documents/${id}`, data })
  updateCounter += 1
  nextMessageId += 1
  const messageId = nextMessageId
  world.tg.push({
    update_id: updateCounter,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      document: {
        file_id: id,
        file_unique_id: `u-${id}`,
        file_name: FILE_NAME,
        mime_type: FILE_MIME,
        file_size: data.length,
      },
      caption,
    },
  })
  return messageId
}

// --- reading what the fakes received ----------------------------------------------------------------------------

function sentTo(chatId: number): TgEvent[] {
  return world.timeline.events.filter(
    (e): e is TgEvent =>
      e.src === 'tg' && (e.method === 'sendMessage' || e.method === 'sendRichMessage') && e.params.chat_id === chatId,
  )
}

function textOf(event: TgEvent): string {
  return deepStrings(event.params).join('\n')
}

function ownerSaid(needle: string | RegExp): boolean {
  return sentTo(OWNER_CHAT).some((e) => (typeof needle === 'string' ? textOf(e).includes(needle) : needle.test(textOf(e))))
}

function ownerEvent(needle: string | RegExp): TgEvent | undefined {
  return sentTo(OWNER_CHAT).find((e) => (typeof needle === 'string' ? textOf(e).includes(needle) : needle.test(textOf(e))))
}

function guestSaid(needle: string): boolean {
  return sentTo(GUEST_CHAT).some((e) => textOf(e).includes(needle))
}

function modelCalls(kind: Kind): DsEvent[] {
  return world.timeline.events.filter((e): e is DsEvent => e.src === 'ds' && e.kind === kind)
}

/** What main was told in the owner turn `own-<tag>`. */
function mainTail(tag: string): string {
  const call = modelCalls('main').find((c) => c.tag === tag)
  expect(call, `main got a request for the turn own-${tag}`).toBeDefined()
  return tailOf((call as DsEvent).body)
}

function mainCall(tag: string): DsEvent {
  const call = modelCalls('main').find((c) => c.tag === tag)
  expect(call, `main got a request for the turn own-${tag}`).toBeDefined()
  return call as DsEvent
}

// --- the daemon as a child process ---------------------------------------------------------------------------------

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
  runtimeDir: string
  daemons: Daemon[]
}

let scratch: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (entry point of the daemon)').toBe('string')
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
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  // `exec` makes the node process the direct child, so signals and exit codes are the daemon's own.
  const child = spawn('sh', ['-c', `exec ${startScript()}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

async function startDaemon(): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon()
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

function say(chatId: number, text: string, replyTo?: number): void {
  world.tg.push(privateMessage(chatId, text, replyTo))
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

/** The first private chat pairs as the owner with the one-time code from the journal. */
async function pairOwner(d: Daemon): Promise<void> {
  const mark = d.stderr.length
  say(OWNER_CHAT, 'hello')
  await waitFor(
    'a pairing code in the daemon journal (stderr)',
    () => pairingCandidates(d.stderr.slice(mark)).length > 0 && sentTo(OWNER_CHAT).length > 0,
    d,
  )
  const sentBefore = sentTo(OWNER_CHAT).length
  say(OWNER_CHAT, pairingCandidates(d.stderr.slice(mark))[0] as string)
  await waitFor('the pairing confirmation', () => sentTo(OWNER_CHAT).length > sentBefore, d)
}

async function startOwnerDaemon(): Promise<Daemon> {
  const d = await startDaemon()
  await pairOwner(d)
  return d
}

/** The owner writes `own-<tag> <text>` to main (optionally as a reply) and waits for `pong-<tag>`. */
async function ownerTurn(d: Daemon, tag: string, replyTo?: number): Promise<void> {
  say(OWNER_CHAT, `own-${tag} Что можешь сказать по файлу в целом?`, replyTo)
  await waitFor(`the answer pong-${tag}`, () => ownerSaid(`pong-${tag}`), d)
}

function codeLike(texts: string[]): string[] {
  const found: Array<{ token: string; rank: number; at: number }> = []
  let at = 0
  for (const token of texts.join('\n').match(/[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g) ?? []) {
    at += 1
    if (token.length < 8) continue
    if (/^[a-z_]+$/.test(token)) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^1[67]\d{11}$/.test(token)) continue
    found.push({ token, rank: /\d/.test(token) ? 0 : 1, at })
  }
  found.sort((a, b) => a.rank - b.rank || a.at - b.at)
  return [...new Set(found.map((f) => f.token))]
}

/** The owner invites a guest chat; returns once the guest chat has been greeted. */
async function joinGuest(d: Daemon, chatId: number): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  const invitation = (): string[] =>
    codeLike(
      sentTo(OWNER_CHAT)
        .filter((e) => e.n > mark)
        .map(textOf),
    )
  await waitFor('an invitation code in the owner chat', () => invitation().length > 0, d)
  const code = invitation()[0] as string
  const before = sentTo(chatId).length
  say(chatId, code)
  await waitFor(`a greeting in chat ${chatId}`, () => sentTo(chatId).length > before, d)
}

// --- the file system of the daemon ------------------------------------------------------------------------------------

function walk(dir: string): string[] {
  const found: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

function inboxFiles(): string[] {
  return walk(join(world.dshbotHome, 'workspace', 'inbox'))
}

/** The only file of the inbox: the absolute path main has to be told about. */
function inboxPath(): string {
  const files = inboxFiles()
  expect(files, 'the file of the owner lies in the inbox').toHaveLength(1)
  return files[0] as string
}

/** Sends the PDF, waits until the analysis reaches the model (so the intake is surely running). */
async function sendReport(d: Daemon, bodyMarker = 'PDFBODY-AB1'): Promise<{ data: Buffer; messageId: number }> {
  const data = buildPdf(`${bodyMarker} text of the report`)
  const before = modelCalls('intake').length
  const messageId = sendFile(data)
  await waitFor('the analysis to reach the model', () => modelCalls('intake').length > before, d, LONG_WAIT_MS)
  return { data, messageId }
}

// --- harness lifecycle ---------------------------------------------------------------------------------------------------

function makeScratch(): string {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-attach-ctx-test-')))
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
  const stub = await startStub(timeline)
  const tg = await startTelegram(timeline)
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  world = { timeline, tg, stub, home, dshbotHome, runtimeDir: mkdtempSync(join(scratch, 'run-')), daemons: [] }
  mkdirSync(join(dshbotHome, 'workspace'), { recursive: true })
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

test('test_h1_guest_requests_have_no_owner_attachment_frame_even_when_the_system_rule_names_the_marker', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  await joinGuest(d, GUEST_CHAT)
  const gate = deferred()
  world.stub.intake = async () => {
    await gate.promise
    return { text: 'GSTSUM-2M итог для владельца' }
  }

  await sendReport(d)
  const path = inboxPath()

  // a guest turn while the analysis runs, and one after it has ended
  say(GUEST_CHAT, 'gst-a привет, расскажи о себе')
  await waitFor('the answer to the guest', () => guestSaid('pong-a'), d)
  gate.resolve()
  await waitFor('the result of the analysis', () => ownerSaid('GSTSUM-2M'), d, LONG_WAIT_MS)
  await sleep(GUEST_GAP_MS)
  say(GUEST_CHAT, 'gst-b а что у владельца за файлы?')
  await waitFor('the second answer to the guest', () => guestSaid('pong-b'), d)

  const guestCalls = modelCalls('guest')
  expect(guestCalls.length, 'the guest turns reached the model').toBeGreaterThanOrEqual(2)
  for (const call of guestCalls) {
    const system = [
      textOfContent(call.body.system),
      ...messagesOf(call.body)
        .filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => textOfContent(message.content)),
    ].join('\n')
    expect(system, 'the guest rule may name the marker without carrying a data frame').toContain('EXTERNAL_UNTRUSTED_CONTENT')
    expect(call.json, 'no file name in a guest request').not.toContain(FILE_NAME)
    expect(call.json, 'no path of the inbox in a guest request').not.toContain(path)
    expect(call.json, 'no result of the analysis in a guest request').not.toContain('GSTSUM-2M')
    expect(call.json, 'no word about the running analysis in a guest request').not.toMatch(/идёт разбор/i)
    expect(call.json, 'no untrusted frame of the owner files in a guest request').not.toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id=')
  }

  // the guest did not take the insertion away from the owner
  await sleep(SETTLE_MS) // background: the attachment analysis runs in the background
  await ownerTurn(d, 'gs1')
  const tail = mainTail('gs1')
  expect(tail, 'the owner still gets the insertion').toContain('GSTSUM-2M')
  expect(tail).toContain(path)
  expect(tail, 'the owner receives the actual frame, not only its name').toContain('<<<EXTERNAL_UNTRUSTED_CONTENT id=')
})
