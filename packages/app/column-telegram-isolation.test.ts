// h1 / c3: Telegram effects of a column turn, including tools and delegated children.
// c4: keep the owner's tool definitions available while refusing Telegram effects.
// Harness follows chat-completions-daemon.test.ts and subagent-background.test.ts:
// real daemon, paired store, local model and Telegram stubs, no external services.
// Covered routes: outgoing-files.ts uploads; message-tool.ts mutations; plan-tool.ts
// cards; learn skill_propose -> sendProposalCard; exec/schedule approval cards;
// owner feedback/draft streams; delegate -> deliverBackgroundSubagent.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TOKEN = 'xiaozhi-test-bearer-0123456789'
const OWNER = 7
const WAIT_MS = 45_000
const TEST_MS = 180_000
const FINAL = 'Задача колонки выполнена: проверочный итог.'
type Json = Record<string, unknown>
type Answer = { text: string; holdMs?: number } | { tool: string; input: Json; id: string }

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
  const chunks = [
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
  ]
  res.write(chunks.slice(0, -2).join(''))
  const finish = (): void => { res.end(chunks.slice(-2).join('')) }
  if (!tool && answer.holdMs !== undefined) setTimeout(finish, answer.holdMs)
  else finish()
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
  store.kv.set('ui.verbose', 'on')
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
      DSHBOT_DREAM_AT: 'off', DSHBOT_AUTONOMY: 'observe', DSHBOT_AUTO_SYNC: 'off',
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
}

// Convert connection and JSON failures to values so a missing implementation fails an assertion.
async function request(targetPort: number, payload: unknown, options: {
  token?: string | null; path?: string; method?: string; host?: string
} = {}): Promise<Response> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return new Promise((resolve) => {
    const req = httpRequest({
      hostname: options.host ?? '127.0.0.1', port: targetPort,
      path: options.path ?? '/v1/chat/completions', method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? TOKEN}` }),
      },
    }, (res) => {
      void readBody(res).then((text) => {
        let json: Json = {}
        try { json = object(JSON.parse(text)) } catch { /* Assert JSON through its expected fields below. */ }
        resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), raw: text, json })
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

async function enabled(extra: Record<string, string> = {}): Promise<{ daemon: Daemon; apiPort: number }> {
  const apiPort = await freePort()
  const daemon = await start({ DSHBOT_OPENAI_PORT: String(apiPort), DSHBOT_OPENAI_TOKEN: TOKEN, ...extra })
  await ready(apiPort, daemon, extra.DSHBOT_OPENAI_HOST)
  return { daemon, apiPort }
}

interface Step {
  tool: string
  input: Json
  id: string
}

// Load lazy tools through the same public tool_search the real model uses.
// A missing schema ends with a diagnostic answer, which completion() rejects.
function script(call: Json, steps: Step[], final: Answer = { text: FINAL }): Answer {
  for (const step of steps) {
    if (results(call).some((result) => result.tool_use_id === step.id)) continue
    if (!tools(call).includes(step.tool)) {
      const searchId = `load_${step.id}`
      if (results(call).some((result) => result.tool_use_id === searchId)) {
        return { text: `MISSING TOOL: ${step.tool}` }
      }
      return { tool: 'tool_search', input: { query: step.tool }, id: searchId }
    }
    return step
  }
  return final
}

function resultOf(id: string): Json {
  const result = world.calls.flatMap(results).find((result) => result.tool_use_id === id)
  expect(result, `the model must receive the result of ${id}`).toBeDefined()
  return result ?? {}
}

function deniedInColumn(id: string, textHint = false): void {
  const result = resultOf(id)
  expect.soft(result.is_error, `${id}: must be a tool error`).toBe(true)
  const text = textOf(result.content)
  expect.soft(text, `${id}: explain the column/Telegram restriction`).toMatch(/колонк|xiaozhi|telegram/i)
  if (textHint) expect.soft(text, `${id}: ask for a text answer`).toMatch(/текст|text/i)
}

// Allow only background polling and read-only startup calls. This catches drafts,
// reactions, chat actions, edits, deletes, pins and every kind of media upload,
// rather than just looking for a sendMessage containing the final answer.
function telegramEffectsSince(mark: number): Array<{ method: string; body: Json }> {
  return world.telegram.slice(mark).filter((event) => !['getUpdates', 'getMe', 'getWebhookInfo'].includes(event.method))
}

test('test_h1_c3_send_file_refuses_all_upload_modes_and_requests_a_text_answer', { timeout: TEST_MS }, async () => {
  const path = join(world.workspace, 'column-result.txt')
  writeFileSync(path, 'valid workspace file, available to the owner')
  const steps = ['document', 'photo', 'audio', 'voice'].map((as): Step => ({
    tool: 'send_file', input: { path, as }, id: `upload_${as}`,
  }))
  world.plan = (call) => lastUser(call).includes('COL-UPLOAD') ? script(call, steps) : { text: '[SILENT]' }
  const { apiPort } = await enabled()
  const mark = world.telegram.length
  completion(await request(apiPort, body('COL-UPLOAD отправь результат файлом')))
  for (const step of steps) deniedInColumn(step.id, true)
  expect(telegramEffectsSince(mark), 'deliverFile must never reach any Telegram upload method').toEqual([])
})

test('test_h1_c3_background_delegate_is_refused_or_returns_its_child_report_synchronously', { timeout: TEST_MS }, async () => {
  const report = 'KID-REPORT-column-background-proof'
  const delegation: Step = {
    tool: 'delegate', input: { task: 'KID-BACKGROUND сделай часть задачи', tools: [], background: true }, id: 'column_background',
  }
  world.plan = (call) => {
    const text = lastUser(call)
    if (text.includes('COL-DELEGATE')) return script(call, [delegation])
    if (text.includes('Фоновый субагент')) return { text: 'BACKGROUND-EVENT-LEAK' }
    if (text.includes('KID-BACKGROUND')) return { text: report }
    return { text: '[SILENT]' }
  }
  const { apiPort } = await enabled()
  const mark = world.telegram.length
  completion(await request(apiPort, body('COL-DELEGATE выполни задачу субагентом')))
  // A local child finishes immediately. Give an incorrectly queued event time
  // to run after the HTTP turn releases withMainTurn, as in subagent-background.
  await sleep(2_500)
  const result = resultOf(delegation.id)
  if (result.is_error === true) {
    expect(textOf(result.content).trim(), 'a refusal must reach the column model').not.toBe('')
  } else {
    expect.soft(textOf(result.content), 'a job id is not the synchronous child report').toContain(report)
    expect.soft(world.calls.some((call) => lastUser(call).includes('KID-BACKGROUND'))).toBe(true)
  }
  expect(telegramEffectsSince(mark), 'no delayed deliverBackgroundSubagent reply may reach the owner').toEqual([])
})

const skillContent = (name: string): string => [
  '---', `name: ${name}`, 'description: Local column isolation proof.', '---',
  '## Procedure', 'Read the local proof file.',
  '## Pitfalls', 'Keep the result in the requesting interface.',
  '## Verification', 'Return the proof as text.',
].join('\n')

test('test_h1_c3_tools_cards_drafts_and_reactions_do_not_modify_the_owner_chat', { timeout: TEST_MS }, async () => {
  const seedText = 'OWNER-MESSAGE-SEED'
  const ownerSteps: Step[] = [
    { tool: 'message', input: { action: 'send', text: seedText }, id: 'owner_message_seed' },
    { tool: 'plan', input: { action: 'set', steps: [{ title: 'OWNER-PLAN-SEED' }] }, id: 'owner_plan_seed' },
    { tool: 'skill_propose', input: { name: 'owner-proof', content: skillContent('owner-proof') }, id: 'owner_proposal_seed' },
  ]
  let columnSteps: Step[] = []
  const ownerFinal = 'OWNER-STREAM-SEED '.repeat(20)
  world.plan = (call) => {
    const text = lastUser(call)
    if (text.includes('OWNER-SEED')) return script(call, ownerSteps, { text: ownerFinal, holdMs: 1_500 })
    if (text.includes('COL-EFFECTS')) return script(call, columnSteps, { text: FINAL, holdMs: 1_500 })
    return { text: '[SILENT]' }
  }
  const { apiPort, daemon } = await enabled()
  say('OWNER-SEED подготовь сообщения и карточки')
  const mainLog = join(world.home, 'dsh/sessions/main/events.jsonl')
  await waitFor('the owner baseline must finish, including streamed delivery', () =>
    existsSync(mainLog) && readFileSync(mainLog, 'utf8').includes(ownerFinal) &&
    world.telegram.some((event) => /^(sendMessage|sendRichMessage)$/.test(event.method) &&
      JSON.stringify(event.body).includes('OWNER-STREAM-SEED')), daemon)
  await sleep(500)
  for (const step of ownerSteps) expect(resultOf(step.id).is_error).not.toBe(true)
  // Prove this harness actually supports the paths that the column must avoid.
  expect(world.telegram.some((event) => event.method === 'setMessageReaction')).toBe(true)
  expect(world.telegram.some((event) => /^(sendRichMessageDraft|sendMessageDraft|editMessageText)$/.test(event.method))).toBe(true)
  expect(world.telegram.some((event) => (JSON.stringify(event.body.reply_markup) ?? '').includes('lp1:'))).toBe(true)
  const seed = world.telegram.findIndex((event) => /^(sendMessage|sendRichMessage)$/.test(event.method) &&
    JSON.stringify(event.body).includes(seedText))
  expect(seed).toBeGreaterThanOrEqual(0)
  // The fake Telegram returns message_id = 9000 + event count.
  const messageId = 9001 + seed
  columnSteps = [
    { tool: 'message', input: { action: 'send', text: 'COLUMN-MUST-NOT-SEND' }, id: 'column_message_send' },
    ...['edit', 'delete', 'pin', 'unpin'].map((action): Step => ({
      tool: 'message', input: { action, message_id: messageId, text: 'COLUMN-MUST-NOT-EDIT' }, id: `column_message_${action}`,
    })),
    { tool: 'plan', input: { action: 'set', steps: [{ title: 'COLUMN-MUST-NOT-PLAN' }] }, id: 'column_plan_set' },
    { tool: 'plan', input: { action: 'update', step: 1, status: 'done' }, id: 'column_plan_update' },
    { tool: 'skill_propose', input: { name: 'column-proof', content: skillContent('column-proof') }, id: 'column_proposal' },
    { tool: 'exec', input: { command: 'rm -rf column-confirm-proof' }, id: 'column_exec_confirm' },
    { tool: 'schedule', input: { action: 'watch', command: 'rm -rf column-watch-proof', pattern: 'proof' }, id: 'column_watch_confirm' },
  ]
  const history = readFileSync(mainLog, 'utf8')
  const mark = world.telegram.length
  completion(await request(apiPort, body('COL-EFFECTS проверь все пути отправки')))
  await sleep(1_300) // Flush a mistaken deferred plan edit as well.
  for (const step of columnSteps) {
    const result = resultOf(step.id)
    expect.soft(textOf(result.content)).not.toMatch(/unknown tool|tool not found|неизвестный инструмент/i)
    if (step.tool === 'message' || step.tool === 'plan') deniedInColumn(step.id)
    if (step.tool === 'exec' || step.tool === 'schedule') {
      expect.soft(result.is_error, 'confirmation must fail without a card or waiting for a button').toBe(true)
      expect.soft(textOf(result.content)).toMatch(/подтвержд|confirm/i)
    }
  }
  expect(telegramEffectsSince(mark), 'tools, proposal cards, feedback and streaming must remain out of Telegram').toEqual([])
  expect(readFileSync(mainLog, 'utf8'), 'column effects must not enter the Telegram session').toBe(history)
})

test('test_h1_c3_synchronous_delegate_cannot_send_to_telegram_through_its_child_tools', { timeout: TEST_MS }, async () => {
  const path = join(world.workspace, 'child-result.txt')
  writeFileSync(path, 'child workspace proof')
  const parent: Step = {
    tool: 'delegate', input: { task: 'KID-EFFECTS верни результат только родителю', tools: ['send_file', 'message'] }, id: 'column_child',
  }
  const childSteps: Step[] = [
    { tool: 'send_file', input: { path }, id: 'child_upload' },
    { tool: 'message', input: { action: 'send', text: 'CHILD-MUST-NOT-SEND' }, id: 'child_message' },
  ]
  world.plan = (call) => {
    const text = lastUser(call)
    if (text.includes('COL-CHILD')) return script(call, [parent])
    if (text.includes('KID-EFFECTS')) {
      // A correct implementation may withhold Telegram tools from the child.
      // Exercise every such tool actually inherited by it.
      return script(call, childSteps.filter((step) => tools(call).includes(step.tool)), { text: 'CHILD-EFFECTS-REPORT' })
    }
    return { text: '[SILENT]' }
  }
  const { apiPort } = await enabled()
  const mark = world.telegram.length
  completion(await request(apiPort, body('COL-CHILD проверь синхронного субагента')))
  const result = resultOf(parent.id)
  // A session may refuse delegation altogether. If it allows the child to
  // run, its tools must inherit the same prohibition on Telegram effects.
  if (result.is_error === true) {
    expect(textOf(result.content).trim()).not.toBe('')
  } else {
    expect.soft(textOf(result.content)).toContain('CHILD-EFFECTS-REPORT')
    expect(world.calls.some((call) => lastUser(call).includes('KID-EFFECTS')), 'the synchronous child must actually run').toBe(true)
    for (const step of childSteps) {
      if (world.calls.flatMap(results).some((result) => result.tool_use_id === step.id)) {
        expect.soft(resultOf(step.id).is_error, `${step.tool} inherited by the child must be refused`).toBe(true)
      }
    }
  }
  expect(telegramEffectsSince(mark)).toEqual([])
})

test('test_c4_owner_tools_remain_visible_and_future_schedules_and_wakeups_are_allowed', { timeout: TEST_MS }, async () => {
  const names = ['message', 'plan', 'send_file', 'delegate', 'skill_propose']
  const searches: Step[] = names.map((name) => ({ tool: 'tool_search', input: { query: name }, id: `visible_${name}` }))
  const path = join(world.workspace, 'read-proof.txt')
  const proof = 'COLUMN-READ-PROOF-8216'
  writeFileSync(path, proof)
  const read: Step = { tool: 'read', input: { path }, id: 'visible_read' }
  const future: Step[] = [
    { tool: 'schedule', input: { action: 'create', schedule: 'every 24h', task: 'FUTURE-COLUMN-REMINDER' }, id: 'future_schedule' },
    { tool: 'schedule', input: { action: 'list' }, id: 'future_list' },
    { tool: 'set_next_wakeup', input: { minutes: 120 }, id: 'future_wakeup' },
  ]
  world.plan = (call) => {
    const text = lastUser(call)
    if (text.includes('WAKE-VISIBLE')) return script(call, [...searches, read], { text: '[SILENT]' })
    if (text.includes('COL-VISIBLE')) return script(call, [...searches, read, ...future])
    return { text: '[SILENT]' }
  }
  const notifyPort = await freePort()
  const { apiPort, daemon } = await enabled({ DSHBOT_NOTIFY_PORT: String(notifyPort), DSHBOT_NOTIFY_TOKEN: TOKEN })
  await ready(notifyPort, daemon)
  expect((await request(notifyPort, 'WAKE-VISIBLE owner tool baseline', { path: '/wake' })).status).toBe(202)
  await waitFor('the wake baseline must load lazy schemas and execute read', () =>
    world.calls.some((call) => lastUser(call).includes('WAKE-VISIBLE') &&
      results(call).some((result) => result.tool_use_id === read.id)), daemon)
  const wake = world.calls.filter((call) => lastUser(call).includes('WAKE-VISIBLE'))
  const mark = world.telegram.length
  completion(await request(apiPort, body('COL-VISIBLE создай напоминание на будущее')))
  const column = world.calls.filter((call) => lastUser(call).includes('COL-VISIBLE'))
  expect(column.length).toBeGreaterThan(0)
  expect(tools(column[0] ?? {})).toEqual(tools(wake[0] ?? {}))
  const definitions = (calls: Json[]): Map<string, Json> => new Map(calls.flatMap((call) =>
    objects(call.tools).map((tool): [string, Json] => [String(tool.name ?? object(tool.function).name), tool])))
  const baseline = definitions(wake)
  const visible = definitions(column)
  for (const name of names) {
    expect(baseline.has(name), `${name} must be available in the owner wake baseline`).toBe(true)
    expect(visible.get(name), `${name} schema must remain available to the column`).toEqual(baseline.get(name))
  }
  const columnResults = column.flatMap(results)
  for (const step of [read, ...future]) {
    const result = columnResults.find((result) => result.tool_use_id === step.id)
    expect(result, `${step.tool} must run in the column`).toBeDefined()
    expect(result?.is_error).not.toBe(true)
  }
  expect(JSON.stringify(columnResults.find((result) => result.tool_use_id === read.id))).toContain(proof)
  expect(JSON.stringify(columnResults.find((result) => result.tool_use_id === 'future_list'))).toContain('FUTURE-COLUMN-REMINDER')
  expect(telegramEffectsSince(mark), 'creating future work must not deliver anything during the request').toEqual([])
})

