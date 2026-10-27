// Spoken answers of the bot: local speech synthesis, an OGG/Opus voice message after the text of the turn. The daemon
// runs as a child process against a fake Telegram Bot API (getFile, file downloads, multipart uploads) and a DeepSeek
// stub; the owner chat is seeded into the store before the start (same harness as session-commands.test.ts and
// speech-recognition.test.ts).
//
// Contract the tests rely on (everything else is left to the implementation):
//   - recognition of the incoming voice is swappable exactly as in speech-recognition.test.ts: with
//     DSHBOT_VOICE_TEST_STUB=<dir> the recognized text of a file is <dir>/<sha256 of the file>.txt;
//   - synthesis is swappable: when DSHBOT_VOICE_TTS_TEST_STUB=<dir> is set, the code that would load the TTS model and
//     run it (in a worker or whatever runs off the main thread) does this instead and touches neither the model files
//     nor the network (the model is not downloaded, ensureModel-like code is not called):
//       1. it appends one JSON line {"text": "<the text handed to the synthesizer>"} to <dir>/tts-calls.jsonl;
//       2. if <dir>/block_ms exists, it blocks the thread running the synthesis synchronously for that many ms
//          (a stand-in for a CPU-bound model);
//       3. if <dir>/fail exists, the synthesis fails (throws);
//       4. otherwise it returns one second of silence: mono, 22050 Hz, all samples zero. Everything after that
//          (the conversion to OGG/Opus with ffmpeg, sendVoice) is the real code;
//   - the voice message is the Bot API method sendVoice with the file in the multipart part `voice`, the bytes are an
//     Ogg stream with an Opus head; the owner gets it after the text of the answer;
//   - the model of the speech is downloaded with the global `fetch` (the tests serve huggingface.co and hf-mirror.com
//     from a preload); the mode of the preload is "tamper": the right size of the pinned file, zero bytes;
//   - a failure of any kind is a plain text answer without a voice message and a line in the journal (stdout or
//     stderr) that names the speech and the failure.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

import { TURN_EVENTS_ON, turnCompletions, waitForTurnComplete, waitForUpdateComplete } from './test-support/turn-events.js'

import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 300_000
const WAIT_MS = 60_000
const LONG_WAIT_MS = 120_000
const LONG_POLL_HOLD_MS = 20_000
/** A little over the real-time guest pace limit. */
/** How long the absence of a voice message is watched: the stand-in synthesis plus ffmpeg takes far less. */
const QUIET_MS = 1_500

const BOT_TOKEN = '7000001:AAHdshbotTestTokenSecretPart0123456789'
const DEEPSEEK_KEY = 'sk-dshbot-test-secret-key-0123456789abcdef'
const OWNER_CHAT = 7
const GUEST_CHAT = 5550001
const OWNER_KV_KEY = 'telegram.owner_chat_id'

const TTS_REPOSITORY = 'csukuangfj/vits-piper-ru_RU-irina-medium'
const TTS_REVISION = 'b095bed45c39813266edf14ffa2bade5ebfc929c'
const TTS_MODEL_FILE = 'ru_RU-irina-medium.onnx'
const TTS_MODEL_SIZE = 63201422

const SPEECH_LIMIT = 600

const ON_RE = /\bon\b|включ/i
const OFF_RE = /\boff\b|выключ|отключ/i
const AUTO_RE = /\bauto\b|авто/i

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

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// --- Ogg Opus fixture of the incoming voice message ----------------------------------------------------------------

const OGG_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let r = (i << 24) >>> 0
    for (let k = 0; k < 8; k += 1) r = ((r & 0x80000000) !== 0 ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0
    table[i] = r
  }
  return table
})()

function oggCrc(data: Buffer): number {
  let crc = 0
  for (const byte of data) crc = (((crc << 8) >>> 0) ^ (OGG_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0
  return crc
}

function oggPage(type: number, granule: bigint, serial: number, sequence: number, packet: Buffer): Buffer {
  const header = Buffer.alloc(28)
  header.write('OggS', 0, 'latin1')
  header[4] = 0
  header[5] = type
  header.writeBigUInt64LE(granule, 6)
  header.writeUInt32LE(serial, 14)
  header.writeUInt32LE(sequence, 18)
  header[26] = 1
  header[27] = packet.length
  const page = Buffer.concat([header, packet])
  page.writeUInt32LE(oggCrc(page), 22)
  return page
}

/** A tiny but well-formed Ogg Opus stream that claims `seconds` of audio; `serial` makes the bytes unique. */
function makeOgg(seconds: number, serial: number): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'latin1')
  head[8] = 1
  head[9] = 1
  head.writeUInt16LE(312, 10)
  head.writeUInt32LE(48000, 12)
  head.writeUInt16LE(0, 16)
  head[18] = 0
  const tags = Buffer.alloc(20)
  tags.write('OpusTags', 0, 'latin1')
  tags.writeUInt32LE(4, 8)
  tags.write('test', 12, 'latin1')
  tags.writeUInt32LE(0, 16)
  const frame = Buffer.from([0xf8])
  return Buffer.concat([
    oggPage(0x02, 0n, serial, 0, head),
    oggPage(0x00, 0n, serial, 1, tags),
    oggPage(0x04, BigInt(Math.round(seconds * 48000) + 312), serial, 2, frame),
  ])
}

// --- timeline of everything the two fakes saw ---------------------------------------------------------------------

interface Part {
  name: string
  filename?: string
  data: Buffer
}

interface TgEvent {
  n: number
  src: 'tg'
  method: string
  params: JsonObject
  parts: Part[]
}

interface DsEvent {
  n: number
  src: 'ds'
  body: JsonObject
}

type Event = TgEvent | DsEvent

interface Timeline {
  events: Event[]
  seq: number
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

function parseObject(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonObject
  } catch {
    // not json
  }
  return {}
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

/** The parts of a multipart body, bytes untouched. */
function parseMultipart(body: Buffer, contentType: string): Part[] {
  const found = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = found?.[1] ?? found?.[2]
  if (boundary === undefined) return []
  const opening = Buffer.from(`--${boundary}`)
  const parts: Part[] = []
  let at = body.indexOf(opening)
  while (at >= 0) {
    const start = at + opening.length
    if (body.subarray(start, start + 2).toString('latin1') === '--') break
    const headEnd = body.indexOf('\r\n\r\n', start)
    if (headEnd < 0) break
    const next = body.indexOf(`\r\n--${boundary}`, headEnd + 4)
    if (next < 0) break
    const head = body.subarray(start, headEnd).toString('utf8')
    const name = /[ ;]name="([^"]*)"/.exec(head)?.[1] ?? ''
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename }),
      data: Buffer.from(body.subarray(headEnd + 4, next)),
    })
    at = next + 2
  }
  return parts
}

// --- the scripted model ----------------------------------------------------------------------------------------------

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

/** The tag of the turn: `own-<tag>` (owner text), `vt-<tag>` (recognized voice) or `gt-<tag>` (guest text). */
function tagOf(body: JsonObject): string | undefined {
  const users = messagesOf(body)
    .filter((m) => m.role === 'user')
    .map((m) => textOfContent(m.content).trim())
    .filter((text) => text !== '')
  const lastUser = users[users.length - 1] ?? ''
  return /\b(?:own|vt|gt)-([a-z0-9]+)/.exec(lastUser)?.[1]
}

/** The answer of the model to a tag unless the test scripted another one. */
function defaultReply(tag: string): string {
  return `Привет, это ответ-${tag} на ваш вопрос.`
}

interface Stub {
  server: Server
  origin: string
  replies: Map<string, string>
}

async function startStub(timeline: Timeline): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, origin: '', replies: new Map() }
  stub.server = createServer((req, res) => {
    void readBody(req).then((buffer) => {
      const body = parseObject(buffer.toString('utf8'))
      const isModelCall =
        req.method === 'POST' && (req.url ?? '').split('?')[0]?.endsWith('/messages') && Array.isArray(body.messages)
      if (!isModelCall || body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      timeline.seq += 1
      timeline.events.push({ n: timeline.seq, src: 'ds', body })
      const tag = tagOf(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(tag === undefined ? '[SILENT]' : (stub.replies.get(tag) ?? defaultReply(tag))))
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- fake Telegram Bot API over local HTTP ----------------------------------------------------------------------------

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

function chatOf(params: JsonObject): number {
  const chat = Number(params.chat_id)
  return Number.isFinite(chat) ? chat : OWNER_CHAT
}

const SEND_METHODS = new Set(['sendMessage', 'sendRichMessage', 'sendDocument', 'sendPhoto', 'sendAudio', 'sendVoice'])

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
    void readBody(req).then((buffer) => {
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
      const contentType = String(req.headers['content-type'] ?? '')
      const multipart = contentType.includes('multipart/')
      const parts = multipart ? parseMultipart(buffer, contentType) : []
      const params: JsonObject = multipart
        ? Object.fromEntries(parts.filter((p) => p.filename === undefined).map((p) => [p.name, p.data.toString('utf8')]))
        : parseObject(buffer.toString('utf8'))
      timeline.seq += 1
      timeline.events.push({ n: timeline.seq, src: 'tg', method, params, parts })

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
      if (method === 'getFile') {
        const id = String(params.file_id ?? '')
        const file = tg.files.get(id)
        if (file === undefined) {
          reply(400, JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: wrong file_id' }))
          return
        }
        reply(
          200,
          JSON.stringify({
            ok: true,
            result: { file_id: id, file_unique_id: `u-${id}`, file_size: file.data.length, file_path: file.path },
          }),
        )
        return
      }
      let result: unknown = true
      if (method === 'getMe') result = { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_test_bot' }
      else if (SEND_METHODS.has(method)) {
        tg.sentIds += 1
        result = {
          message_id: 9000 + tg.sentIds,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatOf(params), type: 'private' },
          text: '',
        }
      }
      reply(200, JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => tg.server.listen(0, '127.0.0.1', resolve))
  tg.origin = `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}`
  return tg
}

// --- update builders ----------------------------------------------------------------------------------------------------

let nextMessageId = 100
let updateCounter = 5000
let fileCounter = 0
let oggSerial = 100

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

function say(chatId: number, text: string): number {
  const update = privateMessage(chatId, text)
  world.tg.push(update)
  return Number(update.update_id)
}

/** The owner sends a voice message whose recognized text is `vt-<tag> ...`. */
function sendVoiceNote(tag: string): number {
  oggSerial += 1
  const data = makeOgg(5, oggSerial)
  writeFileSync(join(world.sttDir, `${sha256(data)}.txt`), `vt-${tag} расскажи что-нибудь`)
  fileCounter += 1
  const id = `zzvoice${fileCounter}`
  world.tg.files.set(id, { path: `voice/${id}.oga`, data })
  updateCounter += 1
  nextMessageId += 1
  world.tg.push({
    update_id: updateCounter,
    message: {
      message_id: nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      voice: { file_id: id, file_unique_id: `u-${id}`, duration: 5, file_size: data.length, mime_type: 'audio/ogg' },
    },
  })
  return updateCounter
}

// --- reading what the fakes received ---------------------------------------------------------------------------------------

const TEXT_METHOD_RE = /^(?:send|edit)\w*(?:Message|Text|Draft)\w*$/

function tgEvents(): TgEvent[] {
  return world.timeline.events.filter((e): e is TgEvent => e.src === 'tg')
}

/** Everything with text that went to a chat: sends, edits, drafts. */
function textEvents(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => TEXT_METHOD_RE.test(e.method) && chatOf(e.params) === chatId)
}

function textOf(event: TgEvent): string {
  return deepStrings(event.params).join('\n')
}

function voicesTo(chatId: number): TgEvent[] {
  return tgEvents().filter((e) => e.method === 'sendVoice' && chatOf(e.params) === chatId)
}

function textsSince(chatId: number, mark: number): string[] {
  return textEvents(chatId)
    .filter((e) => e.n > mark)
    .map(textOf)
}

function said(chatId: number, needle: string): boolean {
  return textEvents(chatId).some((e) => textOf(e).includes(needle))
}

function firstSaying(chatId: number, needle: string): TgEvent | undefined {
  return textEvents(chatId).find((e) => textOf(e).includes(needle))
}

// --- the stand-ins for synthesis and the model download -----------------------------------------------------------------

function makeDir(prefix: string): string {
  return mkdtempSync(join(scratch, prefix))
}

function ttsTexts(dir: string): string[] {
  try {
    return readFileSync(join(dir, 'tts-calls.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => String((JSON.parse(line) as { text?: unknown }).text ?? ''))
  } catch {
    return []
  }
}

/** The text of a spoken answer with the white space of a line break and of a space made equal. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// A preload for the daemon: huggingface.co and hf-mirror.com are served by the global fetch (mode "tamper": the pinned
// file has the right size and zero bytes, every other file is a few bytes of junk) or are unreachable (mode
// "offline"); other hosts pass through.
const HF_PRELOAD = `
import { appendFileSync } from 'node:fs'
import dns from 'node:dns'

const HOSTS = /(^|\\.)(huggingface\\.co|hf-mirror\\.com)$/i
const SIZES = JSON.parse(process.env.FAKE_HF_SIZES || '{}')
const mode = process.env.FAKE_HF_MODE || 'offline'
const log = (entry) => appendFileSync(process.env.FAKE_HF_LOG, JSON.stringify(entry) + '\\n')

const realLookup = dns.lookup
dns.lookup = function (hostname, ...rest) {
  if (HOSTS.test(String(hostname))) {
    log({ lookup: String(hostname) })
    const callback = rest[rest.length - 1]
    const error = Object.assign(new Error('getaddrinfo ENOTFOUND ' + hostname), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname })
    if (typeof callback === 'function') process.nextTick(() => callback(error))
    return undefined
  }
  return realLookup.call(this, hostname, ...rest)
}

function zeros(size) {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close()
        return
      }
      const n = Math.min(65536, size - sent)
      controller.enqueue(new Uint8Array(n))
      sent += n
    },
  })
}

const realFetch = globalThis.fetch
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
  if (!HOSTS.test(url.hostname)) return realFetch(input, init)
  const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase()
  log({ url: url.href, method })
  if (mode === 'offline') throw new TypeError('fetch failed')
  const name = url.pathname.split('/').pop()
  const size = SIZES[name]
  if (typeof size !== 'number') return new Response('junk\\n', { status: 200, headers: { 'content-type': 'application/octet-stream' } })
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(size) }
  if (method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(zeros(size), { status: 200, headers })
}
`

// --- the daemon as a child process -------------------------------------------------------------------------------------------

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
  hfLog: string
  /** recognition stand-in: the recognized text of the voice messages of the tests */
  sttDir: string
  daemons: Daemon[]
}

let scratch: string
let hfPreload: string
let world: World

function startScript(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const script = manifest.scripts?.start
  expect(typeof script, 'package.json must define scripts.start (entry point of the daemon)').toBe('string')
  return script as string
}

interface SpawnOptions {
  /** directory of the synthesis stand-in; without it the real synthesis path runs */
  tts?: string
  /** serve or block the model hosts */
  hf?: 'offline' | 'tamper'
  /** a directory put before everything else in PATH */
  pathPrefix?: string
}

function spawnDaemon(options: SpawnOptions = {}): Daemon {
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    PATH: [
      ...(options.pathPrefix === undefined ? [] : [options.pathPrefix]),
      dirname(process.execPath),
      join(repoRoot, 'node_modules', '.bin'),
      process.env.PATH ?? '',
    ].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    DSHBOT_VOICE_TEST_STUB: world.sttDir,
    ...TURN_EVENTS_ON,
    // Every turn of this harness is one message: the debounce series would only add 1.5 s to it.
    DSHBOT_DEBOUNCE_MS: '0',
    // The 3 second pace of a guest chat is not what these tests check; the
    // guest messages are spaced by the turn of the owner in between anyway.
    DSHBOT_GUEST_MIN_INTERVAL_MS: '0',
    ...(options.tts === undefined ? {} : { DSHBOT_VOICE_TTS_TEST_STUB: options.tts }),
    ...(options.hf === undefined
      ? {}
      : {
          NODE_OPTIONS: `--import ${pathToFileURL(hfPreload).href}`,
          FAKE_HF_MODE: options.hf,
          FAKE_HF_LOG: world.hfLog,
          FAKE_HF_SIZES: JSON.stringify({ [TTS_MODEL_FILE]: TTS_MODEL_SIZE }),
        }),
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

async function startDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  const before = world.tg.polls
  const d = spawnDaemon(options)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  await sleep(300)
  return d
}

/** The store of the daemon knows the owner chat before the first start: no pairing round. */
function seedOwner(): void {
  const store = openStore(join(world.dshbotHome, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER_CHAT))
  } finally {
    store.close()
  }
}

async function startOwnerDaemon(options: SpawnOptions = {}): Promise<Daemon> {
  seedOwner()
  return startDaemon(options)
}

async function stopDaemon(d: Daemon): Promise<void> {
  d.child.kill('SIGTERM')
  const killer = setTimeout(() => d.child.kill('SIGKILL'), 20_000)
  await d.exit
  clearTimeout(killer)
}

/** A daemon command: the answer of the bot as one text. */
async function command(d: Daemon, text: string, chatId = OWNER_CHAT): Promise<string> {
  const mark = world.timeline.seq
  say(chatId, text)
  await waitFor(`an answer to ${JSON.stringify(text)}`, () => textsSince(chatId, mark).length > 0, d)
  await sleep(300)
  return textsSince(chatId, mark).join('\n')
}

/** The owner writes `own-<tag>` and waits for the text of the answer and the end of the turn. */
async function ownerText(d: Daemon, tag: string): Promise<void> {
  const turns = turnCompletions(d)
  say(OWNER_CHAT, `own-${tag} привет`)
  await waitFor(`the text answer ответ-${tag}`, () => said(OWNER_CHAT, `ответ-${tag}`), d)
  await waitForTurnComplete(d, turns, `the owner turn own-${tag}`, WAIT_MS)
}

/** The owner sends a voice message and waits for the text of the answer and the end of the turn. */
async function ownerVoice(d: Daemon, tag: string): Promise<void> {
  const turns = turnCompletions(d)
  sendVoiceNote(tag)
  await waitFor(`the text answer ответ-${tag} to the voice message`, () => said(OWNER_CHAT, `ответ-${tag}`), d)
  await waitForTurnComplete(d, turns, `the voice turn ${tag}`, WAIT_MS)
}

/** The spoken answer of the turn does not come: the text is there, nothing else follows. */
async function expectNoVoice(chatId: number, voicesBefore: number, context: string): Promise<void> {
  await sleep(QUIET_MS)
  expect(voicesTo(chatId).length, `${context}: no voice message`).toBe(voicesBefore)
}

/** Waits for one more voice message to the chat and returns it. */
async function nextVoice(d: Daemon, chatId: number, voicesBefore: number, timeoutMs = WAIT_MS): Promise<TgEvent> {
  await waitFor('a voice message', () => voicesTo(chatId).length > voicesBefore, d, timeoutMs)
  return voicesTo(chatId)[voicesBefore] as TgEvent
}

function voiceBytes(event: TgEvent): Buffer {
  const part = event.parts.find((p) => p.name === 'voice')
  expect(part, 'the voice message carries the file in the multipart part "voice"').toBeDefined()
  return (part as Part).data
}

function hfUrls(): string[] {
  try {
    return readFileSync(world.hfLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { url?: string }).url)
      .filter((url): url is string => url !== undefined)
  } catch {
    return []
  }
}

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
    if (lstatSync(full).isSymbolicLink()) continue
    if (lstatSync(full).isDirectory()) found.push(...walk(full))
    else found.push(full)
  }
  return found
}

/** Journal lines that name the speech and a failure, written after `mark` characters of the journal. */
function speechErrorLines(d: Daemon, mark: number): string[] {
  const journal = `${d.stdout}\n${d.stderr}`.slice(mark)
  return journal
    .split('\n')
    .filter(
      (line) =>
        /tts|synth|синтез|озвуч|голосов|voice|speech|речь|речи|ffmpeg|opus/i.test(line) &&
        /fail|error|ошиб|не удал|не смог|нет сети|network|unavailable|недоступ|ffmpeg|opus|не загруз|exception|timeout/i.test(line),
    )
}

function journalLength(d: Daemon): number {
  return `${d.stdout}\n${d.stderr}`.length
}

/** The owner invites a guest chat and the guest enters with the code. */
async function inviteGuest(d: Daemon): Promise<void> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/invite')
  await waitFor('an invitation link', () => textsSince(OWNER_CHAT, mark).some((t) => /start=[A-Za-z0-9_-]+/.test(t)), d)
  const code = /start=([A-Za-z0-9_-]+)/.exec(textsSince(OWNER_CHAT, mark).join('\n'))?.[1] as string
  const greeted = textEvents(GUEST_CHAT).length
  const updateId = say(GUEST_CHAT, code)
  await waitFor('the greeting of the guest', () => textEvents(GUEST_CHAT).length > greeted, d)
  await waitForUpdateComplete(d, updateId, 'the guest code message', WAIT_MS)
}

// --- harness lifecycle ----------------------------------------------------------------------------------------------------------

beforeAll(() => {
  // /var/tmp first: the sandbox of exec gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      scratch = realpathSync(mkdtempSync(join(base, 'dshbot-voice-reply-')))
      break
    } catch {
      // try the next base
    }
  }
  expect(scratch, 'a writable temporary directory').toBeDefined()
  hfPreload = join(scratch, 'hf-preload.mjs')
  writeFileSync(hfPreload, HF_PRELOAD)
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
  world = {
    timeline,
    tg,
    stub,
    home,
    dshbotHome,
    hfLog: join(home, 'hf.log'),
    sttDir: makeDir('stt-'),
    daemons: [],
  }
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

// --- [c1] a voice message is answered with a voice message ------------------------------------------------------------------------

test('test_c1_voice_message_in_auto_mode_gets_the_text_answer_and_then_an_ogg_opus_voice_message_with_the_spoken_text', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  await ownerVoice(d, 'c1a')
  const voice = await nextVoice(d, OWNER_CHAT, 0)

  const answer = firstSaying(OWNER_CHAT, 'ответ-c1a') as TgEvent
  expect(voice.n, 'the voice message comes after the text of the answer').toBeGreaterThan(answer.n)
  const bytes = voiceBytes(voice)
  expect(bytes.subarray(0, 4).toString('latin1'), 'the voice message is an Ogg stream').toBe('OggS')
  expect(bytes.includes(Buffer.from('OpusHead')), 'the Ogg stream carries Opus').toBe(true)

  const spoken = ttsTexts(tts)
  expect(spoken.length, 'one synthesis for one answer').toBe(1)
  expect(spoken[0], 'the answer of the model is what is spoken').toContain('c1a')
  expect(spoken[0], 'the recognized text of the owner is not spoken back').not.toContain('расскажи что-нибудь')
  await sleep(QUIET_MS) // absence: no second voice message
  expect(voicesTo(OWNER_CHAT), 'one answer, one voice message').toHaveLength(1)
})

// --- [c2] a text message is answered with text only ---------------------------------------------------------------------------------

test('test_c2_text_message_in_auto_mode_gets_a_text_answer_and_no_voice_message', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  await ownerText(d, 'c2a')
  await expectNoVoice(OWNER_CHAT, 0, 'a text message in the auto mode')
  expect(ttsTexts(tts), 'nothing is synthesized for a text message').toEqual([])
  expect(d.exited).toBe(false)
})

// --- [c3] /voice on | off | auto and its persistence ---------------------------------------------------------------------------------

test('test_c3_voice_on_voices_text_messages_and_voice_off_silences_even_voice_messages', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  const on = await command(d, '/voice on')
  expect(on, `the bot confirms the mode\n${on}`).toMatch(ON_RE)
  expect(on, 'the confirmation of on does not read like off').not.toMatch(OFF_RE)
  await ownerText(d, 'c3a')
  const voice = await nextVoice(d, OWNER_CHAT, 0)
  expect(voiceBytes(voice).subarray(0, 4).toString('latin1')).toBe('OggS')
  expect(ttsTexts(tts)[0], 'the text answer is spoken').toContain('c3a')

  const off = await command(d, '/voice off')
  expect(off, `the bot confirms the mode\n${off}`).toMatch(OFF_RE)
  await ownerVoice(d, 'c3b')
  await expectNoVoice(OWNER_CHAT, 1, 'a voice message with /voice off')
  await ownerText(d, 'c3c')
  await expectNoVoice(OWNER_CHAT, 1, 'a text message with /voice off')
  expect(ttsTexts(tts), 'nothing was synthesized after /voice off').toHaveLength(1)
})

test('test_c3_voice_with_no_argument_and_voice_auto_return_to_auto', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  await command(d, '/voice on')
  const bare = await command(d, '/voice')
  expect(bare, `/voice without an argument confirms auto\n${bare}`).toMatch(AUTO_RE)
  await ownerText(d, 'c3d')
  await expectNoVoice(OWNER_CHAT, 0, 'a text message after bare /voice')
  await ownerVoice(d, 'c3e')
  await nextVoice(d, OWNER_CHAT, 0)

  await command(d, '/voice off')
  const auto = await command(d, '/voice auto')
  expect(auto, `/voice auto confirms auto\n${auto}`).toMatch(AUTO_RE)
  await ownerText(d, 'c3f')
  await expectNoVoice(OWNER_CHAT, 1, 'a text message after /voice auto')
  await ownerVoice(d, 'c3g')
  await nextVoice(d, OWNER_CHAT, 1)
})

test('test_c3_the_mode_survives_a_restart_of_the_daemon', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const first = await startOwnerDaemon({ tts })
  await command(first, '/voice on')
  await stopDaemon(first)

  const second = await startDaemon({ tts })
  await ownerText(second, 'c3h')
  await nextVoice(second, OWNER_CHAT, 0)
  await command(second, '/voice off')
  await stopDaemon(second)

  const third = await startDaemon({ tts })
  await ownerVoice(third, 'c3i')
  await expectNoVoice(OWNER_CHAT, 1, 'a voice message after a restart in the off mode')
  await command(third, '/voice auto')
  await stopDaemon(third)

  const fourth = await startDaemon({ tts })
  await ownerText(fourth, 'c3j')
  await expectNoVoice(OWNER_CHAT, 1, 'a text message after a restart in the auto mode')
  await ownerVoice(fourth, 'c3k')
  await nextVoice(fourth, OWNER_CHAT, 1)
})

// --- [c4] what is spoken -----------------------------------------------------------------------------------------------------------

test('test_c4_code_tables_and_links_are_not_read_aloud_but_stay_in_the_text_answer', { timeout: TEST_TIMEOUT_MS }, async () => {
  const reply = [
    'Это ответ-c4a. Сначала короткое вступление про погоду.',
    '',
    '```python',
    'print("CODEMARKER")',
    '```',
    '',
    '| город | градусы |',
    '|-------|---------|',
    '| Москва | TABLEMARKER |',
    '',
    'Подробности смотрите на https://example.com/URLMARKER?q=1 сегодня вечером.',
    '',
    'Ещё есть [документация](https://example.org/LINKMARKER) для любопытных.',
    '',
    'Итог: завтра будет тепло.',
  ].join('\n')
  world.stub.replies.set('c4a', reply)
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  await ownerVoice(d, 'c4a')
  await nextVoice(d, OWNER_CHAT, 0)
  const spokenAll = ttsTexts(tts)
  expect(spokenAll, 'one synthesis').toHaveLength(1)
  const spoken = spokenAll[0] as string

  expect(spoken, 'the prose is spoken').toContain('вступление про погоду')
  expect(spoken, 'the prose after the code is spoken').toContain('завтра будет тепло')
  for (const forbidden of ['CODEMARKER', 'TABLEMARKER', 'URLMARKER', 'LINKMARKER', 'example.com', 'example.org', 'http', '```', '|', 'print(']) {
    expect(spoken, `${forbidden} is not read aloud`).not.toContain(forbidden)
  }

  const written = textEvents(OWNER_CHAT).map(textOf).join('\n')
  for (const kept of ['CODEMARKER', 'TABLEMARKER', 'URLMARKER']) {
    expect(written, `${kept} stays in the text answer`).toContain(kept)
  }
})

test('test_c4_a_long_answer_is_spoken_from_its_start_up_to_600_characters_cut_at_a_sentence_and_the_text_is_whole', { timeout: TEST_TIMEOUT_MS }, async () => {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const sentences = Array.from({ length: 40 }, (_, i) => `Это предложение про погоду с кодом q${letters.charAt(Math.floor(i / 26))}${letters.charAt(i % 26)}.`)
  const full = `Это ответ-c4b. ${sentences.join(' ')}`
  expect(squash(full).length, 'the scripted answer is longer than the limit').toBeGreaterThan(SPEECH_LIMIT * 2)
  world.stub.replies.set('c4b', full)
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })

  await ownerVoice(d, 'c4b')
  await nextVoice(d, OWNER_CHAT, 0)
  const spokenAll = ttsTexts(tts)
  expect(spokenAll, 'one synthesis').toHaveLength(1)
  const spoken = squash(spokenAll[0] as string)

  expect(spoken.length, 'the spoken part is within the limit').toBeLessThanOrEqual(SPEECH_LIMIT)
  expect(spoken.length, 'the beginning is spoken, not a stub').toBeGreaterThan(400)
  expect(squash(full).startsWith(spoken), `what is spoken is the beginning of the answer\n${spoken}`).toBe(true)
  expect(spoken, 'the cut is at the end of a sentence').toMatch(/кодом q[a-z]{2}\.$/)
  expect(spoken, 'the end of the answer is not spoken').not.toContain(`q${letters.charAt(1)}${letters.charAt(13)}`)

  const written = textEvents(OWNER_CHAT).map(textOf).join('\n')
  expect(written, 'the first sentence is in the text').toContain('qaa')
  expect(written, 'the last sentence is in the text, the text is whole').toContain(`q${letters.charAt(1)}${letters.charAt(13)}`)
})

// --- [c5] the model is fetched on the first spoken answer, pinned -----------------------------------------------------------------------

test('test_c5_the_tts_model_is_fetched_at_the_first_spoken_answer_from_the_pinned_revision_and_a_file_with_a_wrong_hash_is_refused', { timeout: TEST_TIMEOUT_MS * 2 }, async () => {
  const d = await startOwnerDaemon({ hf: 'tamper' })
  await sleep(2_000)
  await ownerText(d, 'c5a')
  await sleep(1_500)
  expect(hfUrls(), 'nothing is fetched at the start and for a text answer').toEqual([])

  await ownerVoice(d, 'c5b')
  await waitFor('the model to be requested', () => hfUrls().length > 0, d, LONG_WAIT_MS)
  await sleep(6_000)

  const urls = hfUrls()
  for (const url of urls) {
    const parsed = new URL(url)
    expect(['huggingface.co', 'hf-mirror.com'], `the host of ${url}`).toContain(parsed.hostname)
    expect(url, 'the repository of the Russian voice').toContain(TTS_REPOSITORY)
    expect(url, 'the pinned revision, never the moving main').toContain(TTS_REVISION)
  }
  expect(urls.some((url) => /\/main\/|revision=main/.test(url)), 'never the moving main').toBe(false)

  const modelsDir = join(world.dshbotHome, 'models')
  const files = walk(modelsDir)
  expect(
    files.filter((file) => basename(file).startsWith(TTS_MODEL_FILE)),
    'a model file that does not match the pinned hash does not stay on disk',
  ).toEqual([])
  expect(
    files.filter((file) => dirname(file) === modelsDir),
    'the voice lives in its own subdirectory of models',
  ).toEqual([])

  expect(voicesTo(OWNER_CHAT), 'no voice message from an unverified model').toEqual([])
  expect(said(OWNER_CHAT, 'ответ-c5b'), 'the answer came as text').toBe(true)
  expect(d.exited, `the daemon survives a bad model\n${output(d)}`).toBe(false)
  await ownerText(d, 'c5c')
})

// --- [c6] failures end as a text answer ------------------------------------------------------------------------------------------------

test('test_c6_no_network_for_the_model_gives_a_text_answer_a_journal_line_and_the_next_turn_is_answered', { timeout: TEST_TIMEOUT_MS * 2 }, async () => {
  const d = await startOwnerDaemon({ hf: 'offline' })
  const mark = journalLength(d)

  await ownerVoice(d, 'c6a')
  await waitFor('the download to be attempted', () => hfUrls().length > 0, d, LONG_WAIT_MS)
  await waitFor('the failure in the journal', () => speechErrorLines(d, mark).length > 0, d, LONG_WAIT_MS)
  await expectNoVoice(OWNER_CHAT, 0, 'no model and no network')
  expect(said(OWNER_CHAT, 'ответ-c6a'), 'the text answer came').toBe(true)

  expect(d.exited, `the daemon survives\n${output(d)}`).toBe(false)
  await ownerVoice(d, 'c6b')
  await ownerText(d, 'c6c')
})

test('test_c6_ffmpeg_without_opus_gives_a_text_answer_a_journal_line_and_the_next_turn_is_answered', { timeout: TEST_TIMEOUT_MS }, async () => {
  const shadow = makeDir('no-ffmpeg-')
  for (const name of ['ffmpeg', 'ffprobe']) {
    const path = join(shadow, name)
    writeFileSync(path, "#!/bin/sh\necho 'Unknown encoder libopus' >&2\nexit 1\n")
    chmodSync(path, 0o755)
  }
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts, pathPrefix: shadow })
  const mark = journalLength(d)

  await ownerVoice(d, 'c6d')
  await waitFor('the failure in the journal', () => speechErrorLines(d, mark).length > 0, d)
  await expectNoVoice(OWNER_CHAT, 0, 'ffmpeg cannot make Opus')
  expect(said(OWNER_CHAT, 'ответ-c6d'), 'the text answer came').toBe(true)

  expect(d.exited, `the daemon survives\n${output(d)}`).toBe(false)
  await ownerVoice(d, 'c6e')
  await ownerText(d, 'c6f')
})

test('test_c6_a_failed_synthesis_gives_a_text_answer_a_journal_line_and_the_next_turn_is_voiced', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  writeFileSync(join(tts, 'fail'), '')
  const d = await startOwnerDaemon({ tts })
  const mark = journalLength(d)

  await ownerVoice(d, 'c6g')
  await waitFor('the synthesis to be attempted', () => ttsTexts(tts).length > 0, d)
  await waitFor('the failure in the journal', () => speechErrorLines(d, mark).length > 0, d)
  await expectNoVoice(OWNER_CHAT, 0, 'a failed synthesis')
  expect(said(OWNER_CHAT, 'ответ-c6g'), 'the text answer came').toBe(true)

  expect(d.exited, `the daemon survives\n${output(d)}`).toBe(false)
  rmSync(join(tts, 'fail'))
  await ownerVoice(d, 'c6h')
  await nextVoice(d, OWNER_CHAT, 0)
})

// --- [c7] a guest never gets a spoken answer ----------------------------------------------------------------------------------------------

test('test_c7_a_guest_never_gets_a_voice_message_in_any_mode_and_cannot_switch_the_mode', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  const d = await startOwnerDaemon({ tts })
  await inviteGuest(d)

  // the auto mode: a guest asks for /voice on, nothing changes for the owner
  say(GUEST_CHAT, '/voice on')
  await sleep(300)
  await ownerText(d, 'c7a')
  await expectNoVoice(OWNER_CHAT, 0, 'the owner after a guest /voice on')

  // the on mode of the owner: the guest still gets text only
  await command(d, '/voice on')
  say(GUEST_CHAT, 'gt-c7b привет')
  await waitFor('the text answer to the guest', () => said(GUEST_CHAT, 'ответ-c7b'), d)
  await expectNoVoice(GUEST_CHAT, 0, 'a guest with /voice on of the owner')

  await ownerText(d, 'c7c')
  await nextVoice(d, OWNER_CHAT, 0)
  expect(voicesTo(GUEST_CHAT), 'no voice message ever went to the guest').toEqual([])
  expect(ttsTexts(tts).join('\n'), 'the answer to the guest is never synthesized').not.toContain('c7b')
})

// --- [c8] /status while the synthesis runs ----------------------------------------------------------------------------------------------------

test('test_c8_status_is_answered_while_the_voice_answer_is_being_synthesized', { timeout: TEST_TIMEOUT_MS }, async () => {
  const tts = makeDir('tts-')
  writeFileSync(join(tts, 'block_ms'), '15000')
  const d = await startOwnerDaemon({ tts })

  sendVoiceNote('c8a')
  await waitFor('the synthesis to start', () => ttsTexts(tts).length > 0, d)
  expect(voicesTo(OWNER_CHAT), 'the synthesis is still running').toEqual([])

  const started = Date.now()
  const status = await command(d, '/status')
  expect(Date.now() - started, 'the command is answered while the synthesis is busy').toBeLessThan(9_000)
  expect(status.trim().length, '/status says something').toBeGreaterThan(0)
  expect(voicesTo(OWNER_CHAT), 'the synthesis has not finished yet').toEqual([])

  await nextVoice(d, OWNER_CHAT, 0, LONG_WAIT_MS)
  expect(d.exited).toBe(false)
})

// --- [c9] /voice is in /help and in the menu ------------------------------------------------------------------------------------------------------

test('test_c9_help_and_the_owner_menu_list_voice_with_a_description', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  const help = await command(d, '/help')
  const line = help.split('\n').find((candidate) => candidate.includes('/voice'))
  expect(line, `/voice is in /help\n${help}`).toBeDefined()
  expect((line as string).replace('/voice', '').trim().length, '/voice has a description on its line').toBeGreaterThan(5)

  const menus = (): TgEvent[] => tgEvents().filter((e) => e.method === 'setMyCommands')
  const isOwnerScope = (e: TgEvent): boolean => {
    const scope = asObject(e.params.scope)
    return scope.type === 'chat' && Number(scope.chat_id) === OWNER_CHAT
  }
  await waitFor('the menu of the owner chat', () => menus().some(isOwnerScope), d)
  const owner = menus().filter(isOwnerScope)
  const entries = (Array.isArray((owner[owner.length - 1] as TgEvent).params.commands)
    ? ((owner[owner.length - 1] as TgEvent).params.commands as unknown[])
    : []
  ).map(asObject)
  const entry = entries.find((candidate) => candidate.command === 'voice')
  expect(entry, 'the owner menu has /voice').toBeDefined()
  expect(String((entry as JsonObject).description).trim().length, '/voice has a description in the menu').toBeGreaterThan(0)
})
