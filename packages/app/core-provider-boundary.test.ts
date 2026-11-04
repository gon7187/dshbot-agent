// Exercise the public daemon entry point, as notify-http.test.ts and owner-core-tools.test.ts do.
// Only loopback fake Telegram/DeepSeek services are used; no provider account is needed.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'
import { TURN_EVENTS_ON, waitForTurnComplete, type JournalDaemon } from './test-support/turn-events.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TOKEN = 'xiaozhi-test-bearer-0123456789'
const OWNER = 7
const WAIT_MS = 15_000
const TEST_MS = 45_000
const FINAL = 'Задача колонки выполнена: проверочный итог.'
type Json = Record<string, unknown>
type Answer = { text: string } | { tool: string; input: Json; id: string }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return objects(content).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('')
}

function lastUser(body: Json): string {
  return objects(body.messages).filter((m) => m.role === 'user').map((m) => textOf(m.content)).filter(Boolean).at(-1) ?? ''
}

function results(body: Json): Json[] {
  return objects(body.messages).flatMap((m) => objects(m.content)).filter((b) => b.type === 'tool_result')
}

function tools(body: Json): string[] {
  return objects(body.tools).map((t) => String(t.name ?? object(t.function).name ?? '')).sort()
}

function replyModel(res: ServerResponse, body: Json, answer: Answer): void {
  const tool = 'tool' in answer
  const block = tool
    ? { type: 'tool_use', id: answer.id, name: answer.tool, input: answer.input }
    : { type: 'text', text: answer.text }
  const message = {
    id: 'msg_chat_fixture', type: 'message', role: 'assistant', model: body.model,
    content: [block], stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 10 },
  }
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message))
    return
  }
  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end([
    sse('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }),
    sse('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(answer.input) }
        : { type: 'text_delta', text: answer.text },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join(''))
}

interface Daemon {
  child: ChildProcess
  log: string
  exited: boolean
  closed: Promise<void>
}

interface World {
  scratch: string
  home: string
  workspace: string
  calls: Json[]
  telegram: Array<{ method: string; body: Json }>
  updates: Json[]
  polls: number
  updateId: number
  holders: Set<ServerResponse>
  ds: Server
  tg: Server
  daemons: Daemon[]
  plan: (body: Json) => Answer
}

let world: World

function port(server: Server): number {
  return (server.address() as AddressInfo).port
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
}

async function freePort(): Promise<number> {
  const server = createServer()
  await listen(server)
  const value = port(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return value
}

async function waitFor(label: string, condition: () => boolean, daemon?: Daemon): Promise<void> {
  const end = Date.now() + WAIT_MS
  while (!condition() && Date.now() < end && !daemon?.exited) await sleep(40)
  expect(condition(), `${label}\n${daemon?.log.slice(-5000) ?? ''}`).toBe(true)
}

function flushUpdates(): void {
  const res = world.holders.values().next().value as ServerResponse | undefined
  if (!res || world.updates.length === 0) return
  world.holders.delete(res)
  res.end(JSON.stringify({ ok: true, result: world.updates.splice(0) }))
}

function say(text: string): void {
  world.updateId += 1
  world.updates.push({
    update_id: world.updateId,
    message: {
      message_id: world.updateId, date: Math.floor(Date.now() / 1000), text,
      chat: { id: OWNER, type: 'private', first_name: 'Owner' },
      from: { id: OWNER, is_bot: false, first_name: 'Owner' },
    },
  })
  flushUpdates()
}

beforeEach(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-chat-api-'))
  const home = join(scratch, 'state')
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(home, 'app'), { recursive: true })
  const store = openStore(join(home, 'state.db'))
  store.kv.set('telegram.owner_chat_id', String(OWNER))
  store.close()
  world = {
    scratch, home, workspace, calls: [], telegram: [], updates: [], polls: 0, updateId: 100,
    holders: new Set(), ds: createServer(), tg: createServer(), daemons: [],
    plan: (body) => ({ text: lastUser(body).includes('CHAT-') ? FINAL : '[SILENT]' }),
  }
  world.ds.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      const body = object(JSON.parse(raw))
      if (req.method !== 'POST' || !req.url?.split('?')[0]?.endsWith('/messages')) {
        res.writeHead(404).end('{}')
        return
      }
      world.calls.push(body)
      replyModel(res, body, world.plan(body))
    })
  })
  world.tg.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      const method = req.url?.split('?')[0]?.split('/').at(-1) ?? ''
      let body: Json = {}
      try { body = object(JSON.parse(raw)) } catch { /* Non-JSON Telegram calls need no parameters. */ }
      world.telegram.push({ method, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      if (method === 'getUpdates') {
        world.polls += 1
        world.holders.add(res)
        const timer = setTimeout(() => {
          world.holders.delete(res)
          res.end(JSON.stringify({ ok: true, result: [] }))
        }, 20_000)
        res.on('close', () => { clearTimeout(timer); world.holders.delete(res) })
        flushUpdates()
        return
      }
      const result = method === 'getMe'
        ? { id: 4242, is_bot: true, first_name: 'Test', username: 'dshbot_test_bot' }
        : /^(send|editMessage)/.test(method)
          ? { message_id: 9000 + world.telegram.length, date: 1, chat: { id: OWNER, type: 'private' }, text: '' }
          : true
      res.end(JSON.stringify({ ok: true, result }))
    })
  })
  await listen(world.ds)
  await listen(world.tg)
})

async function stop(daemon: Daemon): Promise<void> {
  if (!daemon.exited) daemon.child.kill('SIGKILL')
  await daemon.closed
}

afterEach(async () => {
  for (const daemon of world.daemons) await stop(daemon)
  for (const server of [world.ds, world.tg]) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  rmSync(world.scratch, { recursive: true, force: true })
})

async function start(extra: Record<string, string> = {}): Promise<Daemon> {
  const before = world.polls
  const child = spawn(process.execPath, [
    '--import', join(ROOT, 'packages/app/register.mjs'), join(ROOT, 'packages/app/src/main.ts'),
  ], {
    cwd: ROOT,
    env: {
      HOME: world.scratch, USERPROFILE: world.scratch,
      PATH: [dirname(process.execPath), join(ROOT, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter),
      TELEGRAM_BOT_TOKEN: '7000001:AAHdshbotTestTokenSecretPart0123456789',
      DEEPSEEK_API_KEY: 'sk-chat-api-test-0123456789abcdef',
      DSHBOT_HOME: world.home, TELEGRAM_API_ROOT: `http://127.0.0.1:${port(world.tg)}`,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port(world.ds)}/anthropic`,
      DSHBOT_DREAM_AT: 'off', DSHBOT_AUTONOMY: 'observe',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const daemon: Daemon = { child, log: '', exited: false, closed: Promise.resolve() }
  daemon.closed = new Promise((resolve) => child.on('close', () => { daemon.exited = true; resolve() }))
  child.stdout?.on('data', (chunk: Buffer) => { daemon.log += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { daemon.log += chunk.toString('utf8') })
  world.daemons.push(daemon)
  await waitFor('daemon must reach Telegram polling', () => world.polls > before, daemon)
  expect(daemon.exited, daemon.log).toBe(false)
  return daemon
}

/** The combined journal of a daemon in the shape the turn-events helpers read. */
function journal(daemon: Daemon): JournalDaemon {
  return { get stdout() { return daemon.log }, stderr: '', get exited() { return daemon.exited } }
}

async function connects(host: string, targetPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: targetPort })
    const finish = (connected: boolean): void => { socket.destroy(); resolve(connected) }
    socket.setTimeout(500, () => finish(false))
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
  })
}

async function ready(targetPort: number, daemon: Daemon, host = '127.0.0.1'): Promise<void> {
  const end = Date.now() + 8_000
  let connected = await connects(host, targetPort)
  while (!connected && !daemon.exited && Date.now() < end) {
    await sleep(50)
    connected = await connects(host, targetPort)
  }
  expect(connected, `chat API must listen on ${host}:${targetPort}\n${daemon.log}`).toBe(true)
}

function body(text = 'CHAT-BASIC задача', user = 'u1', extra: Json = {}): Json {
  return { model: 'openclaw/xiaozhi', user, stream: false, messages: [{ role: 'user', content: text }], ...extra }
}

interface Response {
  status: number
  contentType: string
  raw: string
  json: Json
  error?: string
  authorized?: boolean
}

// Convert connection and JSON failures to values so a missing implementation fails an assertion.
async function request(targetPort: number, payload: unknown, options: {
  token?: string | null; path?: string; method?: string; host?: string; tls?: boolean; ca?: string
} = {}): Promise<Response> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return new Promise((resolve) => {
    const send = options.tls ? httpsRequest : httpRequest
    const req = send({
      hostname: options.host ?? '127.0.0.1', port: targetPort,
      path: options.path ?? '/v1/chat/completions', method: options.method ?? 'POST',
      ...(options.tls ? { ca: options.ca, servername: 'xiaozhi.test', rejectUnauthorized: true } : {}),
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? TOKEN}` }),
      },
    }, (res) => {
      const authorized = 'authorized' in res.socket ? Boolean(res.socket.authorized) : undefined
      void readBody(res).then((text) => {
        let json: Json = {}
        try { json = object(JSON.parse(text)) } catch { /* Assert JSON through its expected fields below. */ }
        resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), raw: text, json, authorized })
      })
    })
    req.setTimeout(30_000, () => req.destroy(new Error('local API request timed out')))
    req.on('error', (error) => resolve({ status: 0, contentType: '', raw: '', json: {}, error: error.message }))
    req.end(raw)
  })
}

function completion(response: Response, text = FINAL): void {
  expect(response.status, response.error ?? response.raw).toBe(200)
  expect(response.contentType).toMatch(/application\/json/i)
  expect(response.json).toMatchObject({
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  })
  expect(objects(response.json.choices)).toHaveLength(1)
}

function jsonError(response: Response, status: number): void {
  expect(response.status, response.error ?? response.raw).toBe(status)
  expect(response.contentType).toMatch(/application\/json/i)
  expect(object(response.json.error).message).toEqual(expect.any(String))
  expect(String(object(response.json.error).message).trim()).not.toBe('')
}

async function enabled(extra: Record<string, string> = {}): Promise<{ daemon: Daemon; apiPort: number }> {
  const apiPort = await freePort()
  const daemon = await start({ DSHBOT_OPENAI_PORT: String(apiPort), DSHBOT_OPENAI_TOKEN: TOKEN, ...extra })
  await ready(apiPort, daemon, extra.DSHBOT_OPENAI_HOST)
  return { daemon, apiPort }
}

test('test_c1_authenticated_xiaozhi_request_returns_the_model_final_text', { timeout: TEST_MS }, async () => {
  const { apiPort } = await enabled()
  completion(await request(apiPort, body()))
  expect(world.calls.some((call) => lastUser(call).includes('CHAT-BASIC'))).toBe(true)
})


test('test_c2_missing_or_wrong_bearer_is_401_without_a_model_call', { timeout: TEST_MS }, async () => {
  const { apiPort } = await enabled()
  const before = world.calls.length
  for (const token of [null, 'wrong-token']) jsonError(await request(apiPort, body(), { token }), 401)
  expect(world.calls).toHaveLength(before)
})


test('test_c3_user_sessions_keep_tool_history_and_are_isolated_from_each_other_and_telegram', { timeout: TEST_MS }, async () => {
  const secret = 'FILE-RESULT-unique-context-72931'
  const path = join(world.workspace, 'context-proof.txt')
  writeFileSync(path, secret)
  world.plan = (call) => {
    const text = lastUser(call)
    if (text.includes('CHAT-FIRST')) {
      if (!results(call).some((r) => r.tool_use_id === 'context_read')) return { tool: 'read', input: { path }, id: 'context_read' }
      return { text: 'Первый ход завершён.' }
    }
    if (text.includes('CHAT-SECOND')) return { text: 'Итог по сохранённым результатам.' }
    if (text.includes('CHAT-OTHER')) return { text: 'Отдельная колонка.' }
    return { text: 'TELEGRAM-BASELINE-ANSWER' }
  }
  const apiPort = await freePort()
  const daemon = await start({ DSHBOT_OPENAI_PORT: String(apiPort), DSHBOT_OPENAI_TOKEN: TOKEN, ...TURN_EVENTS_ON })
  say('OWNER-BASELINE-PRIVATE')
  const mainLog = join(world.home, 'dsh/sessions/main/events.jsonl')
  await waitFor('owner turn must finish and persist before checking isolation', () =>
    existsSync(mainLog) && readFileSync(mainLog, 'utf8').includes('TELEGRAM-BASELINE-ANSWER') &&
    world.telegram.some((event) => JSON.stringify(event.body).includes('TELEGRAM-BASELINE-ANSWER')), daemon)
  await waitForTurnComplete(journal(daemon), 0, 'the baseline owner turn')
  const history = readFileSync(mainLog, 'utf8')
  const telegramMark = world.telegram.length
  await ready(apiPort, daemon)
  completion(await request(apiPort, body('CHAT-FIRST прочитай файл', 'u1')), 'Первый ход завершён.')
  completion(await request(apiPort, body('CHAT-SECOND подведи итог', 'u1')), 'Итог по сохранённым результатам.')
  completion(await request(apiPort, body('CHAT-SECOND без новых действий', 'u1', { tool_choice: 'none' })), 'Итог по сохранённым результатам.')
  const second = world.calls.filter((c) => lastUser(c).includes('CHAT-SECOND'))
  expect(second.length).toBeGreaterThanOrEqual(2)
  for (const call of second) {
    const messages = JSON.stringify(call.messages)
    expect(messages).toContain('CHAT-FIRST')
    expect(messages).toContain('Первый ход завершён.')
    expect(objects(call.messages).flatMap((m) => objects(m.content))).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', id: 'context_read', name: 'read' }),
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'context_read' }),
    ]))
    expect(JSON.stringify(results(call))).toContain(secret)
    expect(messages).not.toContain('OWNER-BASELINE-PRIVATE')
  }
  completion(await request(apiPort, body('CHAT-OTHER новая задача', 'u2')), 'Отдельная колонка.')
  const other = world.calls.filter((c) => lastUser(c).includes('CHAT-OTHER'))
  expect(other.length).toBeGreaterThan(0)
  for (const call of other) {
    expect(JSON.stringify(call.messages)).not.toMatch(/CHAT-FIRST|CHAT-SECOND|context_read|OWNER-BASELINE-PRIVATE/)
    expect(JSON.stringify(call.messages)).not.toContain(secret)
  }
  expect(readFileSync(mainLog, 'utf8')).toBe(history)
  expect(world.telegram.slice(telegramMark).filter((e) => /^(send|editMessage|deleteMessage)/.test(e.method))).toEqual([])
})
