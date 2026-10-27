import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore } from '../store/src/index.js'
import type { TelegramUpdate } from '../telegram/src/index.js'
import type { CreatePollerOptions } from '../telegram/src/poller.js'
import { markdownToPlain } from '../telegram/src/rich/index.js'
import { startRunner } from '../runner/src/index.js'
import { OWNER_KV_KEY, SESSION_MODEL_KV_KEY, startDshbot } from './src/index.js'

const seam = vi.hoisted(() => ({
  handle: undefined as CreatePollerOptions['handle'] | undefined,
}))

vi.mock('../telegram/src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telegram/src/index.js')>()),
  createPoller: (options: CreatePollerOptions) => {
    seam.handle = options.handle
    return { start: async () => undefined, stop: () => undefined }
  },
}))
vi.mock('../tools-exec/src/index.js', () => ({
  createExecTools: async () => ({ tools: [], stop: async () => undefined }),
}))

const OWNER = 7
const WAIT = 20_000
const ZAI_REPLY = 'ZAI-EFFORT-ROUTE-REPLY-OK'
const DEEPSEEK_REPLY = 'DEEPSEEK-EFFORT-ROUTE-REPLY-OK'

type Json = Record<string, unknown>
interface Call { method: string; params: Json; messageId?: number }
interface Screen { id: number; call: Call }
interface Seen { host: string; path: string; body: Json }
interface World {
  root: string
  home: string
  calls: Call[]
  sequence: number
  messageId: number
  completions: Server
  deepseek: Server
  completionsOrigin: string
  deepseekOrigin: string
  completionsSeen: Seen[]
  deepseekSeen: Seen[]
  completionsReply: string
  bot?: Awaited<ReturnType<typeof startDshbot>>
  pending: Promise<void>[]
}
let world: World

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}
function markdown(call: Call): string {
  return String(object(call.params.rich_message).markdown ?? '')
}
function plain(call: Call): string {
  return markdown(call) ? markdownToPlain(markdown(call)) : String(call.params.text ?? '').replace(/<[^>]+>/g, '')
}
function buttons(call: Call): Json[] {
  const rows = object(call.params.reply_markup).inline_keyboard
  return Array.isArray(rows) ? rows.flatMap((row: unknown) => Array.isArray(row) ? row.map(object) : []) : []
}
function button(screen: Screen, label: string | RegExp): Json {
  const found = buttons(screen.call).find((entry) => typeof label === 'string'
    ? String(entry.text).toLowerCase().includes(label.toLowerCase())
    : label.test(String(entry.text)))
  expect(found, `button ${String(label)} on ${plain(screen.call)}`).toBeDefined()
  expect(typeof found?.callback_data).toBe('string')
  return found!
}
function rendered(mark = 0): Call[] {
  return world.calls.slice(mark).filter((call) => call.params.chat_id === OWNER &&
    ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(call.method))
}
function screenOf(call: Call): Screen {
  const id = call.messageId ?? call.params.message_id
  expect(typeof id, 'the message can be addressed by its buttons').toBe('number')
  return { id: Number(id), call }
}
const telegramFetch: typeof fetch = async (input, init) => {
  const method = String(input).split('/').at(-1) ?? ''
  const params = object(JSON.parse(String(init?.body ?? '{}')) as unknown)
  const call: Call = { method, params }
  world.calls.push(call)
  if (method === 'getMe') return Response.json({ ok: true, result: { id: 4242, username: 'provider_effort_bot' } })
  if (['sendMessage', 'sendRichMessage'].includes(method)) {
    call.messageId = ++world.messageId
    return Response.json({ ok: true, result: { message_id: call.messageId, chat: { id: params.chat_id } } })
  }
  if (method.startsWith('editMessage')) {
    return Response.json({ ok: true, result: { message_id: params.message_id, chat: { id: params.chat_id } } })
  }
  return Response.json({ ok: true, result: true })
}

// --- the local servers -----------------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const piece of req) chunks.push(Buffer.from(piece as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}
function parse(raw: string): Json {
  try {
    return object(JSON.parse(raw) as unknown)
  } catch {
    return {}
  }
}
function anthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
function anthropicStream(text: string): string {
  return [
    anthropicEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stub', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 },
    }),
    anthropicEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}
function completionsChunk(delta: Json, finish: string | null, model: string): string {
  const data = {
    id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  return `data: ${JSON.stringify(data)}\n\n`
}
function completionsStream(text: string, model: string): string {
  const usage = {
    id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model, choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  }
  return [
    completionsChunk({ role: 'assistant', content: '' }, null, model),
    completionsChunk({ content: text }, null, model),
    completionsChunk({}, 'stop', model),
    `data: ${JSON.stringify(usage)}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}
function completionsMessage(text: string, model: string): string {
  return JSON.stringify({
    id: 'chatcmpl-stub', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  })
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

// The routes of zai and qwen-token-plan keep their own addresses; the wrapper sends them to the local server.
const REDIRECTED_HOST = /^(openrouter\.ai|api\.z\.ai)$/
const realFetch = globalThis.fetch
function routedFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    if (REDIRECTED_HOST.test(url.hostname)) {
      const target = world.completionsOrigin + url.pathname + url.search
      return realFetch(input instanceof Request ? new Request(target, input) : target, init)
    }
    if (url.hostname === '127.0.0.1') return realFetch(input, init)
    throw new Error(`Unexpected external fetch to ${url.hostname}`)
  }) as typeof fetch
}

// --- the world ---------------------------------------------------------------------------------------------

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function makeProject(path: string): void {
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, 'src/value.mjs'), 'export function value() { return 1 }\n')
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name: 'effort-fixture', private: true, type: 'module', scripts: { test: 'node --test' },
  }))
  gitAt(path, 'init', '-q')
  gitAt(path, 'add', '--', 'src/value.mjs', 'package.json')
  gitAt(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-provider-effort-'))
  const home = join(root, 'bot')
  world = {
    root, home, calls: [], sequence: 6000, messageId: 9000, pending: [],
    completionsSeen: [], deepseekSeen: [], completionsReply: ZAI_REPLY,
    completionsOrigin: '', deepseekOrigin: '',
    completions: createServer((req, res) => {
      void readBody(req).then((raw) => {
        const body = parse(raw)
        world.completionsSeen.push({
          host: String(req.headers.host ?? ''), path: new URL(req.url ?? '/', 'http://stub').pathname, body,
        })
        const model = String(body.model ?? 'stub')
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.end(completionsStream(world.completionsReply, model))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(completionsMessage(world.completionsReply, model))
      })
    }),
    deepseek: createServer((req, res) => {
      void readBody(req).then((raw) => {
        const body = parse(raw)
        world.deepseekSeen.push({
          host: String(req.headers.host ?? ''), path: new URL(req.url ?? '/', 'http://stub').pathname, body,
        })
        if (body.stream === false) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_stub', type: 'message', role: 'assistant', model: 'deepseek-flash',
            content: [{ type: 'text', text: DEEPSEEK_REPLY }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(anthropicStream(DEEPSEEK_REPLY))
      })
    }),
  }
  world.completionsOrigin = await listen(world.completions)
  world.deepseekOrigin = await listen(world.deepseek)
  seam.handle = undefined
  for (const [key, value] of Object.entries({
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    HOME: root, DSH_HOME: '', DSHBOT_UPSTREAM: 'off', DSHBOT_AUTO_SYNC: 'off',
    DSHBOT_DREAM_AT: 'off', DSHBOT_BACKUP_AT: '', DSH_TELEMETRY_DISABLED: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  })) vi.stubEnv(key, value)
  makeProject(join(home, 'app'))
  const store = openStore(join(home, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER))
    store.kv.set('factory.autoaccept', '0')
  } finally { store.close() }
  vi.stubGlobal('fetch', routedFetch())
})
afterEach(async () => {
  try {
    await Promise.allSettled(world.pending)
    await world.bot?.stop()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await closeServer(world.completions)
    await closeServer(world.deepseek)
    rmSync(world.root, { recursive: true, force: true })
  }
})
vi.setConfig({ testTimeout: 150_000, hookTimeout: 30_000 })

/** The sign-in of a provider by key, written by a runner into the harness home of the daemon. */
async function signIn(provider: string, key: string): Promise<void> {
  mkdirSync(join(world.home, 'dsh'), { recursive: true })
  mkdirSync(join(world.root, 'workspace'), { recursive: true })
  const runner = await startRunner({
    dshHome: join(world.home, 'dsh'),
    cwd: join(world.root, 'workspace'),
    baseUrl: `${world.deepseekOrigin}/anthropic`,
    apiKey: 'sk-provider-effort-test-0123456789abcdef',
    systemPrefix: 'Provider sign-in.',
  })
  try {
    const result = await runner.connectProvider(provider, { prompt: async () => key, notify: () => undefined }, 'api-key')
    expect(result.status, `the sign-in to ${provider}`).toBe('connected')
  } finally {
    await runner.stop()
  }
}
async function start(): Promise<void> {
  world.bot = await startDshbot({
    dshbotHome: world.home,
    telegramBotToken: 'provider-effort-test-token',
    deepseekApiKey: 'sk-provider-effort-test-0123456789abcdef',
    deepseekBaseUrl: `${world.deepseekOrigin}/anthropic`,
    fetch: telegramFetch,
    ownerDebounceMs: 0,
    exitProcess: () => undefined,
  })
  expect(seam.handle, 'the daemon installed its real update handler').toBeDefined()
}
/** One owner message; resolves when the daemon has finished with it. Returns what the bot showed meanwhile. */
async function say(text: string): Promise<string> {
  const mark = world.calls.length
  const id = ++world.sequence
  await seam.handle!({
    update_id: id,
    message: { message_id: id, chat: { id: OWNER, type: 'private' }, text },
  } as TelegramUpdate)
  await vi.waitFor(() => {
    const store = openStore(join(world.home, 'state.db'))
    try {
      expect(store.ingress.pending().some((row) => row.externalId === String(id))).toBe(false)
    } finally {
      store.close()
    }
  }, { timeout: WAIT })
  return rendered(mark).map(plain).join('\n')
}
function stored(key: string): string | undefined {
  const store = openStore(join(world.home, 'state.db'))
  try {
    return store.kv.get(key)
  } finally {
    store.close()
  }
}

async function catalogue(): Promise<{ provider: string; id: string; name: string }[]> {
  const runner = await startRunner({
    dshHome: join(world.home, 'dsh'), cwd: join(world.root, 'workspace'),
    baseUrl: `${world.deepseekOrigin}/anthropic`, apiKey: 'sk-provider-effort-test-0123456789abcdef',
    systemPrefix: 'Catalogue.',
  })
  try { return await runner.models() } finally { await runner.stop() }
}

async function menu(): Promise<Screen> {
  const mark = world.calls.length
  await say('/model')
  await vi.waitFor(() => expect(rendered(mark).length).toBeGreaterThan(0), { timeout: WAIT })
  return screenOf(rendered(mark).at(-1)!)
}
function checkCallbacks(screen: Screen): void {
  for (const entry of buttons(screen.call)) {
    expect(typeof entry.callback_data).toBe('string')
    expect(Buffer.byteLength(String(entry.callback_data), 'utf8')).toBeLessThanOrEqual(64)
  }
}
async function press(screen: Screen, entry: Json, user = OWNER): Promise<Screen> {
  const mark = world.calls.length
  const id = ++world.sequence
  await seam.handle!({
    update_id: id,
    callback_query: {
      id: `model-menu-${id}`, from: { id: user, is_bot: false, first_name: 'User' },
      chat_instance: 'model-menu', data: entry.callback_data,
      message: { message_id: screen.id, date: 1, chat: { id: OWNER, type: 'private' }, text: plain(screen.call) },
    },
  } as unknown as TelegramUpdate)
  if (user !== OWNER) {
    await vi.waitFor(() => expect(world.calls.slice(mark).some((call) => call.method === 'answerCallbackQuery' &&
      String(call.params.text).includes('Недостаточно прав'))).toBe(true), { timeout: WAIT })
    return screen
  }
  await vi.waitFor(() => expect(rendered(mark).some((call) => call.method === 'editMessageText' &&
    call.params.message_id === screen.id)).toBe(true), { timeout: WAIT })
  const edits = rendered(mark).filter((call) => call.method === 'editMessageText' && call.params.message_id === screen.id)
  const result = { id: screen.id, call: edits.at(-1)! }
  checkCallbacks(result)
  return result
}
function modelButton(screen: Screen, model: { id: string; name: string }): Json | undefined {
  return buttons(screen.call).find((entry) => {
    const label = String(entry.text).replace(/^✅\s*/, '')
    return label === model.id || label === model.name || label.endsWith(`/${model.id}`)
  })
}

test('c1 c2 c3 c4 c5 c6 c8: connected catalogue pages, owner selection and persistence', async () => {
  await signIn('openrouter', 'openrouter-test-key-0123456789abcdef')
  await signIn('zai', 'zai-test-key-0123456789abcdef')
  const all = (await catalogue()).filter((entry) => entry.provider !== 'deepseek')
  const models = all.filter((entry) => entry.provider === 'openrouter')
  expect(models.length).toBeGreaterThan(40)
  await start()
  let screen = await menu()
  checkCallbacks(screen)
  expect(plain(screen.call)).toMatch(/main/i)
  expect(plain(screen.call)).toMatch(/flash/i)
  for (const alias of ['flash', 'lite', 'pro']) button(screen, new RegExp(`\\b${alias}\\b`, 'i'))
  expect(String(button(screen, /flash/i).text)).toMatch(/^✅ /)
  for (const provider of new Set(all.map((entry) => entry.provider))) {
    const row = button(screen, provider)
    expect(String(row.text)).toContain(String(all.filter((entry) => entry.provider === provider).length))
  }
  expect(plain(screen.call)).not.toContain(models.slice(0, 3).map((entry) => `openrouter/${entry.id}`).join(', '))

  const initial = stored(SESSION_MODEL_KV_KEY)
  await press(screen, button(screen, /pro/i), 888)
  expect(stored(SESSION_MODEL_KV_KEY)).toBe(initial)
  screen = await press(screen, button(screen, /pro/i))
  expect(String(button(screen, /pro/i).text)).toMatch(/^✅ /)
  expect(stored(SESSION_MODEL_KV_KEY)).toBe('deepseek-v4-pro')
  const deepseekBefore = world.deepseekSeen.length
  await say('Проверка модели pro')
  await vi.waitFor(() => expect(world.deepseekSeen.length).toBeGreaterThan(deepseekBefore), { timeout: WAIT })
  expect(world.deepseekSeen.slice(deepseekBefore).some((request) => request.body.model === 'deepseek-v4-pro')).toBe(true)
  await say('/model flash')
  expect(stored(SESSION_MODEL_KV_KEY)).toBe('deepseek-flash')
  screen = await menu()
  screen = await press(screen, button(screen, /openrouter/i))
  const seen = new Set<string>()
  let lastPage = screen
  for (let page = 0; page <= models.length; page += 1) {
    const shown = models.filter((entry) => modelButton(screen, entry))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThanOrEqual(20)
    for (const entry of shown) seen.add(entry.id)
    expect(plain(screen.call)).not.toMatch(/(?:набер|введите|командой).{0,60}\/model/i)
    const back = buttons(screen.call).find((entry) => String(entry.text).includes('◀️'))
    const next = buttons(screen.call).find((entry) => String(entry.text).includes('▶️'))
    expect(Boolean(back)).toBe(page > 0)
    lastPage = screen
    if (!next) break
    screen = await press(screen, next)
    expect(page).toBeLessThan(models.length)
  }
  expect(seen).toEqual(new Set(models.map((entry) => entry.id)))
  screen = await press(lastPage, button(lastPage, 'Назад'))
  expect(button(screen, /openrouter/i)).toBeDefined()
  // Select from the last page so the persisted choice also exercises later pages.
  const chosen = models.find((entry) => modelButton(lastPage, entry))!
  expect(chosen).toBeDefined()
  screen = await press(lastPage, modelButton(lastPage, chosen)!)
  expect(stored(SESSION_MODEL_KV_KEY)).toBe(`openrouter/${chosen.id}`)
  const backToHome = buttons(screen.call).find((entry) => String(entry.text).includes('Назад'))
  if (backToHome) screen = await press(screen, backToHome)
  expect(String(button(screen, /openrouter/i).text)).toMatch(/^✅ /)
  screen = await press(screen, button(screen, /openrouter/i))
  expect(String(modelButton(screen, chosen)?.text)).toMatch(/^✅ /)
  await world.bot!.stop()
  world.bot = undefined
  await start()
  screen = await menu()
  expect(plain(screen.call).includes(chosen.id) || plain(screen.call).includes(chosen.name)).toBe(true)
  expect(stored(SESSION_MODEL_KV_KEY)).toBe(`openrouter/${chosen.id}`)
  const before = world.completionsSeen.length
  await say('Проверка выбранной модели')
  await vi.waitFor(() => expect(world.completionsSeen.length).toBeGreaterThan(before), { timeout: WAIT })
  expect(world.completionsSeen.slice(before).some((request) => request.body.model === chosen.id)).toBe(true)
  const other = models.find((entry) => entry.id !== chosen.id)!
  await say(`/model openrouter/${other.id}`)
  expect(stored(SESSION_MODEL_KV_KEY)).toBe(`openrouter/${other.id}`)
})

test('c7: without connected providers the menu offers only DeepSeek and an invitation to connect', async () => {
  await start()
  const screen = await menu()
  checkCallbacks(screen)
  expect(buttons(screen.call)).toHaveLength(3)
  for (const alias of ['flash', 'lite', 'pro']) button(screen, new RegExp(`\\b${alias}\\b`, 'i'))
  expect(plain(screen.call)).toMatch(/после входа в провайдер/i)
})
