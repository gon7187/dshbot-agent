// Reasoning level on the models of connected providers, through the real daemon, the real runner and the real
// dsh-llm-pi-ai routes. Only the network is replaced: Telegram by a fetch double, the DeepSeek Messages API by a local
// server, and the route addresses of zai and qwen-token-plan by a wrapper of globalThis.fetch that sends them to a local
// completions server. The sign-in is the one a runner stores in DSHBOT_HOME/dsh, as the «Провайдеры» screen does.
//
// The levels of each model are read from the adapter (runner.modelLevels), never written down here: the test depends
// only on zai/glm-4.7 having no `max`, and on qwen3.8-flash offering medium and xhigh but no max or high; its wire
// spells the level, so the request shows which one was sent (glm-4.7 collapses every level to «thinking enabled»).
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
import { OWNER_KV_KEY, SESSION_EFFORT_KV_KEY, startDshbot } from './src/index.js'

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
const MODEL_WITHOUT_MAX = 'glm-4.7'
const QWEN_MODEL = 'qwen3.8-flash'
const ZAI_KEY = 'zai-effort-test-Qm7xLpVt29Kd83mXq0'
const QWEN_KEY = 'qwen-effort-test-Wx58Rt21Lm90Qd34'
const ZAI_REPLY = 'ZAI-EFFORT-ROUTE-REPLY-OK'
const DEEPSEEK_REPLY = 'DEEPSEEK-EFFORT-ROUTE-REPLY-OK'
const ANALYSIS = { criteria: ['value() возвращает 2.'], footprint: ['src/value.mjs'], risk: 'low' }

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
/** Every key and string value of a request body, at any depth. */
function wordsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(wordsOf)
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...wordsOf(entry)])
  }
  return []
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
const REDIRECTED_HOST = /^(api\.z\.ai|token-plan[\w.-]*\.aliyuncs\.com)$/
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
    const result = await runner.connectProvider(provider, { prompt: async () => key, notify: () => undefined })
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

// The words of a reply that name reasoning levels.
const LEVEL_WORDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function levelsNamed(text: string): string[] {
  return LEVEL_WORDS.filter((level) => new RegExp(`(^|[^A-Za-z0-9])${level}($|[^A-Za-z0-9])`, 'i').test(text))
}

/** A turn of main: the owner message and the requests that reached the route of the current model. */
async function mainTurn(text: string, route: 'completions' | 'deepseek'): Promise<{ shown: string; seen: Seen[] }> {
  const all = route === 'completions' ? world.completionsSeen : world.deepseekSeen
  const mark = all.length
  const shown = await say(text)
  return { shown, seen: all.slice(mark) }
}

test('c1 c2 c3 c4: main on a provider model never sends a level the model lacks, /effort lists and accepts the levels of the current model, DeepSeek keeps its four', async () => {
  await signIn('zai', ZAI_KEY)
  await signIn('qwen-token-plan', QWEN_KEY)
  await start()

  // The adapter's own description of the model: no max, but the middle levels DeepSeek has no name for.
  const probe = await levelsOf('zai', MODEL_WITHOUT_MAX)
  expect(probe, `${MODEL_WITHOUT_MAX} describes its levels`).toBeDefined()
  expect(probe).not.toContain('max')
  expect(probe).toContain('medium')
  const offered = probe!

  // c1 setup: the saved level of main is max (a level DeepSeek has), then main moves to the provider model.
  await say('/effort max')
  expect(stored(SESSION_EFFORT_KV_KEY), 'max is saved while main is on DeepSeek').toBe('max')
  const switched = await say(`/model zai/${MODEL_WITHOUT_MAX}`)
  expect(switched, '/model accepts the model of a connected provider').toMatch(/zai/)

  // c2: /effort without an argument lists the levels of the current model and says the saved one is unavailable.
  const report = await say('/effort')
  for (const level of offered) expect(levelsNamed(report), `/effort lists ${level} of the model`).toContain(level)
  expect(report, 'the saved level is named').toMatch(/max/)
  expect(report, 'the report says the saved level is unavailable on this model').toMatch(/недоступн/i)
  expect(report, 'and that the turn runs on the default level of the model').toMatch(/по умолчанию/i)

  // c1: the turn does not fail on the saved max; the request goes out without it.
  const first = await mainTurn('привет, модель провайдера', 'completions')
  expect(first.seen.length, 'the turn reached the zai route').toBeGreaterThan(0)
  expect(first.shown, 'the answer of the route reached the owner').toContain(ZAI_REPLY)
  for (const request of first.seen) {
    expect(wordsOf(request.body), 'the request carries no max').not.toContain('max')
  }
  expect(stored(SESSION_EFFORT_KV_KEY), 'the saved level is kept as the owner set it').toBe('max')

  // c3: on a model whose wire carries the level (qwen3.8), a level it offers is accepted, saved and sent with the
  // next request. The saved max is not offered there either.
  await say(`/model qwen-token-plan/${QWEN_MODEL}`)
  const qwenOffered = await levelsOf('qwen-token-plan', QWEN_MODEL)
  expect(qwenOffered, `${QWEN_MODEL} describes its levels`).toContain('medium')
  expect(qwenOffered).not.toContain('max')
  const accepted = await say('/effort medium')
  expect(accepted, '/effort medium is accepted').toMatch(/medium/)
  expect(stored(SESSION_EFFORT_KV_KEY)).toBe('medium')
  const second = await mainTurn('ещё один ход', 'completions')
  expect(second.seen.length, 'the turn reached the qwen route').toBeGreaterThan(0)
  expect(second.shown).toContain(ZAI_REPLY)
  expect(second.seen.some((request) => wordsOf(request.body).includes('medium')), 'the next request carries medium').toBe(true)

  // c3: a level the model does not offer is refused with the list of the model; the saved level stays.
  for (const missing of ['max', 'high', 'xhigh', 'minimal'].filter((level) => !qwenOffered!.includes(level)).slice(0, 2)) {
    const refused = await say(`/effort ${missing}`)
    expect(stored(SESSION_EFFORT_KV_KEY), `a refused ${missing} changes nothing`).toBe('medium')
    for (const level of qwenOffered!) expect(levelsNamed(refused), `the refusal of ${missing} lists ${level}`).toContain(level)
  }
  const third = await mainTurn('и после отказов', 'completions')
  expect(third.seen.some((request) => wordsOf(request.body).includes('medium')), 'the refused levels left medium in force').toBe(true)

  // c4: back on DeepSeek, off, low, high and max are accepted and max goes out in the request.
  await say('/model flash')
  for (const level of ['off', 'low', 'high', 'max']) {
    await say(`/effort ${level}`)
    expect(stored(SESSION_EFFORT_KV_KEY), `/effort ${level} on DeepSeek`).toBe(level)
  }
  const deepseek = await mainTurn('ход на DeepSeek', 'deepseek')
  expect(deepseek.shown).toContain(DEEPSEEK_REPLY)
  expect(
    deepseek.seen.some((request) => wordsOf(object(request.body.output_config)).includes('max')),
    'max goes out in the request of main on DeepSeek',
  ).toBe(true)
})

/** The levels the adapter reports for one model, from a runner on the same harness home. */
async function levelsOf(provider: string, model: string): Promise<string[] | undefined> {
  const runner = await startRunner({
    dshHome: join(world.home, 'dsh'),
    cwd: join(world.root, 'workspace'),
    baseUrl: `${world.deepseekOrigin}/anthropic`,
    apiKey: 'sk-provider-effort-test-0123456789abcdef',
    systemPrefix: 'Levels.',
  })
  try {
    return await runner.modelLevels(provider, model)
  } finally {
    await runner.stop()
  }
}

// --- the role screen ---------------------------------------------------------------------------------------

async function home(): Promise<Screen> {
  const mark = world.calls.length
  await say('/factory')
  await vi.waitFor(() => expect(rendered(mark).length).toBeGreaterThan(0), { timeout: WAIT })
  const screen = screenOf(rendered(mark).at(-1)!)
  button(screen, 'Новая задача')
  return screen
}
async function press(screen: Screen, entry: Json): Promise<void> {
  const data = String(entry.callback_data)
  expect(Buffer.byteLength(data, 'utf8'), 'Telegram callback limit').toBeLessThanOrEqual(64)
  const id = ++world.sequence
  await seam.handle!({
    update_id: id,
    callback_query: {
      id: `provider-effort-callback-${id}`, from: { id: OWNER, is_bot: false, first_name: 'Owner' },
      chat_instance: 'provider-effort', data,
      message: { message_id: screen.id, date: 1, chat: { id: OWNER, type: 'private' }, text: plain(screen.call) },
    },
  } as unknown as TelegramUpdate)
}
async function tapButton(screen: Screen, entry: Json): Promise<Screen> {
  const mark = world.calls.length
  await press(screen, entry)
  await vi.waitFor(() => expect(rendered(mark).some((call) => call.method === 'editMessageText' &&
    call.params.message_id === screen.id), 'a press edits its message').toBe(true), { timeout: WAIT })
  const edits = rendered(mark).filter((call) => call.method === 'editMessageText' && call.params.message_id === screen.id)
  return { id: screen.id, call: edits.at(-1)! }
}
function tap(screen: Screen, label: string | RegExp): Promise<Screen> {
  return tapButton(screen, button(screen, label))
}

const LEVEL_BUTTON = /^(✅|⬜) (off|minimal|low|medium|high|xhigh|max)$/i
function levelButtons(screen: Screen): Json[] {
  return buttons(screen.call).filter((entry) => LEVEL_BUTTON.test(String(entry.text)))
}
function levelsShown(screen: Screen): string[] {
  return levelButtons(screen).map((entry) => LEVEL_BUTTON.exec(String(entry.text))![2]!.toLowerCase())
}
function levelsMarked(screen: Screen): string[] {
  return levelButtons(screen).filter((entry) => String(entry.text).startsWith('✅'))
    .map((entry) => LEVEL_BUTTON.exec(String(entry.text))![2]!.toLowerCase())
}
/** Model buttons of a role screen: marked or unmarked, neither a level nor a way back. */
function modelButtons(screen: Screen): Json[] {
  return buttons(screen.call).filter((entry) => /^(✅|⬜) /.test(String(entry.text)) && !LEVEL_BUTTON.test(String(entry.text)))
}

test('c5: a level beyond off, low, high, max on the role screen is chosen, marked, and sent with the next turn of the role', async () => {
  await signIn('qwen-token-plan', QWEN_KEY)
  await start()

  let screen = await tap(await tap(await home(), 'Модели'), 'разбор')
  // The first model of the priority decides the row: put each qwen model first in turn until one offers xhigh.
  const provider = /^qwen-token-plan \d+\/\d+$/
  const page = await tap(screen, provider)
  const names = modelButtons(page).map((entry) => String(entry.text).replace(/^(✅|⬜) /, ''))
  expect(names.length, 'the qwen provider lists its models').toBeGreaterThan(0)
  for (const name of names) {
    if (levelsShown(screen).includes('xhigh')) break
    let opened = await tap(screen, provider)
    opened = await tap(opened, `⬜ ${name}`)
    screen = await tap(opened, 'Назад')
    for (;;) {
      const priority = buttons(screen.call).filter((entry) => /^✅ \d+\. /.test(String(entry.text)))
      const position = priority.findIndex((entry) => String(entry.text).endsWith(`. ${name}`))
      expect(position, `${name} is among the enabled models`).toBeGreaterThanOrEqual(0)
      if (position === 0) break
      // Row `position` has «⬆️» (the first row has none), so it is the (position - 1)th of them.
      screen = await tapButton(screen, buttons(screen.call).filter((entry) => entry.text === '⬆️')[position - 1]!)
    }
    if (!levelsShown(screen).includes('xhigh')) {
      opened = await tap(screen, provider)
      screen = await tap(await tap(opened, `✅ ${name}`), 'Назад')
    }
  }
  const shown = levelsShown(screen)
  expect(shown, 'the first enabled model offers xhigh').toContain('xhigh')
  expect(shown.some((level) => !['off', 'low', 'high', 'max'].includes(level)), 'levels beyond the four of DeepSeek').toBe(true)

  // Every shown level is selectable, not only the four of DeepSeek.
  screen = await tap(screen, /^(✅|⬜) xhigh$/i)
  expect(levelsMarked(screen), 'xhigh is chosen and marked').toEqual(['xhigh'])
  expect(levelsShown(screen)).toEqual(shown)
  screen = await tap(await tap(await home(), 'Модели'), 'разбор')
  expect(levelsMarked(screen), 'the choice is kept on a fresh screen').toEqual(['xhigh'])

  // The next turn of the role carries it: the analysis of a new task runs on the qwen route.
  world.completionsReply = JSON.stringify(ANALYSIS)
  await tap(await home(), 'Новая задача')
  const seen = world.completionsSeen.length
  const done = say('Показать правильное значение value')
  world.pending.push(done.then(() => undefined))
  void done.catch(() => undefined)
  await vi.waitFor(() => expect(world.completionsSeen.length, 'the analysis role asked the model').toBeGreaterThan(seen), { timeout: 60_000 })
  const requests = world.completionsSeen.slice(seen)
  expect(requests.some((request) => wordsOf(request.body).includes('xhigh')), 'the role request carries xhigh').toBe(true)
})
