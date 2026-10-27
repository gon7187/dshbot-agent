// Public test seam: DSHBOT_TEST_TURN_EVENTS=1 enables one journal line beginning
// `test:turn-complete` (optionally prefixed with `[dshbot] `) per owner turn.
// Metadata after the marker is unrestricted. Both stdout and stderr are observed.
// The child process, seeded owner and local API fixtures follow
// chat-completions-daemon.test.ts; the plan calls follow plan-checklist-tool.test.ts.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { openStore } from '../store/src/index.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7
const WAIT_MS = 45_000
const TEST_MS = 150_000
const EVENT_ENV = 'DSHBOT_TEST_TURN_EVENTS'
const EVENT_LINE = /^(?:\[dshbot\] )?test:turn-complete(?:\s|$)/
type Json = Record<string, unknown>
interface TelegramCall { method: string; body: Json }
interface Completion { telegram: TelegramCall[] }
interface Daemon {
  child: ChildProcess
  log: string
  completions: Completion[]
  exited: boolean
  closed: Promise<void>
}
interface World {
  scratch: string
  home: string
  ds: Server
  tg: Server
  telegram: TelegramCall[]
  model: Json[]
  updates: Json[]
  holders: Set<ServerResponse>
  polls: number
  updateId: number
  daemons: Daemon[]
  rejectDrafts: boolean
  planned: Set<string>
  errors: string[]
}
let world: World

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(text).join('')
  if (value !== null && typeof value === 'object') return Object.values(value).map(text).join('')
  return ''
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  return objects(content).filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('')
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return {} }
}

function origin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function until(condition: () => boolean, daemon?: Daemon): Promise<void> {
  const end = Date.now() + WAIT_MS
  while (!condition() && !daemon?.exited && Date.now() < end) await sleep(20)
}

async function waitFor(label: string, condition: () => boolean, daemon: Daemon): Promise<void> {
  await until(condition, daemon)
  expect(world.errors, 'local API fixture errors').toEqual([])
  expect(condition(), `${label}\n${daemon.log.slice(-5000)}\nModel calls: ${world.model.length}\nTelegram: ${JSON.stringify(world.telegram.slice(-12))}`).toBe(true)
}

function flushUpdates(): void {
  const res = world.holders.values().next().value as ServerResponse | undefined
  if (!res || world.updates.length === 0) return
  world.holders.delete(res)
  res.end(JSON.stringify({ ok: true, result: world.updates.splice(0) }))
}

function say(tag: string): number {
  world.updateId += 1
  world.updates.push({
    update_id: world.updateId,
    message: {
      message_id: world.updateId, date: Math.floor(Date.now() / 1000), text: `own-${tag} выполни задачу`,
      chat: { id: OWNER, type: 'private' },
      from: { id: OWNER, is_bot: false, first_name: 'Owner' },
    },
  })
  flushUpdates()
  return world.updateId
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function message(body: Json, content: Json[], stopReason = 'end_turn'): Json {
  return {
    id: 'msg_completion_fixture', type: 'message', role: 'assistant', model: body.model,
    content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 10 },
  }
}

function endStream(res: ServerResponse, stopReason = 'end_turn'): void {
  res.end(sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', {
      type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 10 },
    }) + sse('message_stop', { type: 'message_stop' }))
}

function delta(res: ServerResponse, value: string): void {
  res.write(sse('content_block_delta', {
    type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value },
  }))
}

function preview(call: TelegramCall): boolean {
  return /^(sendRichMessageDraft|sendMessageDraft|editMessageText)$/.test(call.method) ||
    (call.method === 'sendMessage' && call.body.reply_markup !== undefined)
}

function finalText(tag: string): string {
  return `BEGIN-${tag} MIDDLE-${tag} END-${tag}`
}

async function modelReply(body: Json, res: ServerResponse): Promise<void> {
  world.model.push(body)
  const messages = objects(body.messages)
  let at = -1
  let tag = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    const match = candidate?.role === 'user' ? /^own-([a-z0-9]+)/.exec(messageText(candidate.content)) : null
    if (match) { at = index; tag = match[1] as string; break }
  }
  const step = messages.slice(at + 1).filter((entry) => entry.role === 'assistant').length
  const planned = world.planned.has(tag)
  let tool: string | undefined
  let input: Json = {}
  if (planned && step === 0) { tool = 'tool_search'; input = { query: 'plan' } }
  if (planned && step === 1) {
    tool = 'plan'
    input = { action: 'set', steps: [{ title: `CHECK-${tag}`, status: 'pending' }] }
  }
  if (planned && step === 2) {
    tool = 'plan'
    input = { action: 'update', step: 1, status: 'done' }
  }
  const answer = tag === '' ? '[SILENT]' : finalText(tag)
  const block = tool
    ? { type: 'tool_use', id: `tool_${tag}_${step}`, name: tool, input }
    : { type: 'text', text: answer }
  if (body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(message(body, [block], tool ? 'tool_use' : 'end_turn')))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(sse('message_start', { type: 'message_start', message: { ...message(body, []), stop_reason: null } }))
  res.write(sse('content_block_start', {
    type: 'content_block_start', index: 0,
    content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' },
  }))
  if (tool) {
    res.write(sse('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }))
    endStream(res, 'tool_use')
  } else if (planned) {
    // Release each next chunk on an actual preview request, not a timer. This
    // exercises an in-flight stream and, in fallback mode, editMessageText.
    delta(res, `BEGIN-${tag} `)
    await until(() => world.telegram.some((call) => preview(call) && text(call.body).includes(`BEGIN-${tag}`)))
    delta(res, `MIDDLE-${tag} `)
    await until(() => world.telegram.some((call) =>
      /^(sendRichMessageDraft|sendMessageDraft|editMessageText)$/.test(call.method) &&
      text(call.body).includes(`MIDDLE-${tag}`)))
    delta(res, `END-${tag}`)
    endStream(res)
  } else {
    delta(res, answer)
    endStream(res)
  }
}

beforeEach(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-turn-completion-'))
  const home = join(scratch, 'state')
  mkdirSync(join(home, 'workspace'), { recursive: true })
  mkdirSync(join(home, 'app'), { recursive: true })
  const store = openStore(join(home, 'state.db'))
  store.kv.set('telegram.owner_chat_id', String(OWNER))
  store.close()
  world = {
    scratch, home, ds: createServer(), tg: createServer(), telegram: [], model: [], updates: [],
    holders: new Set(), polls: 0, updateId: 100, daemons: [], rejectDrafts: false, planned: new Set(), errors: [],
  }
  const failed = (error: unknown, res: ServerResponse): void => {
    world.errors.push(String(error))
    res.end('{}')
  }
  world.ds.on('request', (req, res) => {
    void readBody(req).then((body) => modelReply(body, res)).catch((error: unknown) => failed(error, res))
  })
  world.tg.on('request', (req, res) => {
    void readBody(req).then((body) => {
      const method = req.url?.split('?')[0]?.split('/').at(-1) ?? ''
      world.telegram.push({ method, body })
      if (world.rejectDrafts && /^(sendRichMessageDraft|sendMessageDraft)$/.test(method)) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 400, description: 'drafts unsupported by fixture' }))
        return
      }
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
    }).catch((error: unknown) => failed(error, res))
  })
  for (const server of [world.ds, world.tg]) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  }
})

async function stop(daemon: Daemon): Promise<void> {
  if (daemon.exited) return
  daemon.child.kill('SIGTERM')
  const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 10_000)
  await daemon.closed
  clearTimeout(timer)
}

afterEach(async () => {
  for (const daemon of world.daemons) await stop(daemon)
  for (const server of [world.ds, world.tg]) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  rmSync(world.scratch, { recursive: true, force: true })
})

async function start(events: boolean): Promise<Daemon> {
  const before = world.polls
  const child = spawn(process.execPath, [
    '--import', join(ROOT, 'packages/app/register.mjs'), join(ROOT, 'packages/app/src/main.ts'),
  ], {
    cwd: ROOT,
    env: {
      HOME: world.scratch, USERPROFILE: world.scratch,
      PATH: [dirname(process.execPath), join(ROOT, 'node_modules/.bin'), process.env.PATH ?? ''].join(delimiter),
      TELEGRAM_BOT_TOKEN: '7000001:AAHdshbotTestTokenSecretPart0123456789',
      DEEPSEEK_API_KEY: 'sk-turn-completion-test-0123456789abcdef',
      DSHBOT_HOME: world.home, TELEGRAM_API_ROOT: origin(world.tg),
      DEEPSEEK_BASE_URL: `${origin(world.ds)}/anthropic`,
      DSHBOT_DREAM_AT: 'off', DSHBOT_AUTONOMY: 'observe', DSHBOT_DEBOUNCE_MS: '0',
      ...(events ? { [EVENT_ENV]: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const daemon: Daemon = { child, log: '', completions: [], exited: false, closed: Promise.resolve() }
  daemon.closed = new Promise((resolve) => child.on('close', () => { daemon.exited = true; resolve() }))
  for (const stream of [child.stdout, child.stderr]) {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      const value = chunk.toString('utf8')
      daemon.log += value
      pending += value
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        if (EVENT_LINE.test(line)) {
          // Snapshot in the stream callback itself. A later wait/poll must not
          // let Telegram requests that arrived after the signal hide the race.
          daemon.completions.push({ telegram: world.telegram.slice() })
        }
      }
    })
  }
  world.daemons.push(daemon)
  await waitFor('daemon must start Telegram polling', () => world.polls > before, daemon)
  return daemon
}

function hasFinal(calls: TelegramCall[], tag: string): boolean {
  return calls.some((call) => /^(sendMessage|sendRichMessage)$/.test(call.method) &&
    call.body.reply_markup === undefined && text(call.body).includes(finalText(tag)))
}

function hasDone(calls: TelegramCall[], messageId: number): boolean {
  return calls.some((call) => call.method === 'setMessageReaction' &&
    call.body.message_id === messageId && text(call.body.reaction).includes('🎉'))
}

test('test_c1_turn_completion_is_opt_in_and_the_test_variable_is_documented', { timeout: TEST_MS }, async () => {
  const ordinary = await start(false)
  const messageId = say('ordinary')
  await waitFor('ordinary owner turn must actually answer and finish its reaction', () =>
    hasFinal(world.telegram, 'ordinary') && hasDone(world.telegram, messageId), ordinary)
  await stop(ordinary)
  expect(ordinary.completions, 'without the test variable no completion event is emitted, including during shutdown').toEqual([])

  const instrumented = await start(true)
  for (const tag of ['enabledone', 'enabledtwo']) {
    const mark = instrumented.completions.length
    say(tag)
    await waitFor(`completion event of owner turn ${tag}`, () => instrumented.completions.length > mark, instrumented)
    await waitFor(`the instrumented owner turn ${tag} still delivers its answer`, () => hasFinal(world.telegram, tag), instrumented)
  }
  await stop(instrumented)
  expect(instrumented.completions, 'a fresh event is emitted for each of the two owner turns').toHaveLength(2)
  const row = readFileSync(join(ROOT, 'docs/CONFIG.md'), 'utf8').split('\n')
    .find((line) => line.split('|').some((cell) => cell.trim() === `\`${EVENT_ENV}\``))
  expect(row, 'docs/CONFIG.md must describe the new environment variable').toBeDefined()
  const cells = (row ?? '').split('|').map((cell) => cell.trim())
  expect(cells[2], 'the variable must be marked as only for tests').toMatch(/только\s+для\s+тест|tests?[- ]only|only\s+(?:for\s+)?tests?/i)
  expect(cells[3], 'completion instrumentation must be disabled by default').toMatch(/не\s+задан|выключ|отключ|\b(?:off|false|0|unset|disabled)\b/i)
})

test.each([
  { tag: 'nativedraft', rejectDrafts: false },
  { tag: 'editpreview', rejectDrafts: true },
])('test_c2_completion_snapshot_contains_reply_preview_plan_and_final_reaction_$tag', { timeout: TEST_MS }, async ({ tag, rejectDrafts }) => {
  world.rejectDrafts = rejectDrafts
  world.planned.add(tag)
  const daemon = await start(true)
  const mark = daemon.completions.length
  const messageId = say(tag)
  const previewMethod = rejectDrafts ? 'editMessageText' : 'sendRichMessageDraft'
  const hasPreview = (calls: TelegramCall[]): boolean => calls.some((call) =>
    call.method === previewMethod && text(call.body).includes(`MIDDLE-${tag}`))
  const hasPlan = (calls: TelegramCall[]): boolean => calls.some((call) =>
    call.method === 'sendMessage' && text(call.body).includes(`CHECK-${tag}`))
  const hasFinalPlan = (calls: TelegramCall[]): boolean => calls.some((call) => call.method === 'editMessageText' &&
    String(call.body.text).split('\n').some((line) => line.includes(`CHECK-${tag}`) && line.includes('☑')))
  const hasPreviewCleanup = (calls: TelegramCall[]): boolean => {
    if (!rejectDrafts) return true
    const update = calls.find((call) => call.method === 'editMessageText' && text(call.body).includes(`MIDDLE-${tag}`))
    return update !== undefined && ['editMessageReplyMarkup', 'deleteMessage'].every((method) =>
      calls.some((call) => call.method === method && call.body.message_id === update.body.message_id))
  }
  // Validate every exercised path independently of the new event. The current
  // daemon must reach all these actions before failing the missing-event assert.
  await waitFor(`the real owner turn ${tag} delivers its answer, preview, plan and reaction`, () =>
    hasFinal(world.telegram, tag) && hasDone(world.telegram, messageId) && hasPreview(world.telegram) &&
    hasPlan(world.telegram) && hasFinalPlan(world.telegram) && hasPreviewCleanup(world.telegram), daemon)
  await waitFor(`completion event after all sends of ${tag}`, () => daemon.completions.length > mark, daemon)
  const snapshot = daemon.completions[mark]?.telegram ?? []
  expect(hasFinal(snapshot, tag), 'the entire final reply was received before the completion event').toBe(true)
  expect(hasDone(snapshot, messageId), 'the final reaction was received before the completion event').toBe(true)
  expect(hasPreview(snapshot), 'the streamed preview update was already received').toBe(true)
  expect(hasPlan(snapshot), 'the plan card was already received').toBe(true)
  expect(hasFinalPlan(snapshot), 'the last plan state was received before the completion event').toBe(true)
  expect(hasPreviewCleanup(snapshot), 'requests removing the edit preview were received before the completion event').toBe(true)
})
