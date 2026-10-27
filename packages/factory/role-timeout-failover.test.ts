// Reasoning level of every factory role, through the real daemon, SQLite store,
// factory menu and harness. The ingress/model fixture follows
// factory/execution-flow.test.ts; bwrap is a child-process double that executes
// no project command. All repositories are disposable fixtures.
//
// Only the provider adapter is replaced: `listModels` returns bare identities
// (the SDK never carries reasoning there), `resolveModel` carries the levels of
// each model, and the real `resolveCallConfig` / `prepareCall` of the SDK still
// reject a level the model does not support, so a wrong request level fails the
// turn instead of passing through a stub.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import LlmRuntime, {
  ReasoningEffortId,
  resolveRetryPolicy,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore } from '../store/src/index.js'
import type { TelegramUpdate } from '../telegram/src/index.js'
import type { CreatePollerOptions } from '../telegram/src/poller.js'
import { markdownToPlain } from '../telegram/src/rich/index.js'
import { OWNER_KV_KEY, startDshbot } from '../app/src/index.js'
import type { Runner, RunnerOptions, RunnerSession } from '../runner/src/index.js'

const seam = vi.hoisted(() => ({
  handle: undefined as CreatePollerOptions['handle'] | undefined,
  sessions: [] as Session[],
  runners: [] as Runner[],
  pending: [] as Promise<unknown>[],
  timeoutWriter: false,
  attempts: [] as Array<{ model: string; prompt: string }>,
}))

vi.mock('../telegram/src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telegram/src/index.js')>()),
  createPoller: (options: CreatePollerOptions) => {
    seam.handle = options.handle
    return { start: async () => undefined, stop: () => undefined }
  },
}))
// Observe session identity without replacing the agent loop or the tools.
vi.mock('../runner/src/index.js', async (original) => {
  const actual = await original<typeof import('../runner/src/index.js')>()
  return { ...actual, startRunner: async (options: RunnerOptions) => {
    const runner = await actual.startRunner(options)
    seam.runners.push(runner)
    const promptTurn = runner.promptTurn.bind(runner)
    runner.promptTurn = (text: string, session?: RunnerSession) => {
      const system = session?.systemPrefix ?? options.systemPrefix
      const role = roleOf(system)
      if (role) seam.sessions.push({ role, id: session?.sessionId ?? 'main', cwd: options.cwd, system })
      if (role === 'test_writer' && seam.timeoutWriter) {
        seam.attempts.push({ model: String(options.model), prompt: text })
        if (seam.attempts.length === 1) return Promise.resolve({ text: '', aborted: 'timeout' as const })
      }
      const pending = promptTurn(text, session)
      seam.pending.push(pending)
      return pending
    }
    return runner
  } }
})
vi.mock('../tools-exec/src/index.js', () => ({
  createExecTools: async () => ({ tools: [], stop: async () => undefined }),
}))

const OWNER = 7
const WAIT = 5_000
const MAIN = 'main'
const LEVELS = ['off', 'low', 'high', 'max']
const DEFAULT_ANALYSIS = { criteria: ['value() возвращает 2.'], footprint: ['src/value.mjs'], risk: 'low' }
const TEST_PATH = 'tests/value.test.mjs'
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const RED_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('value returns two', () => assert.equal(value(), 2))\n"
type Role = 'analysis' | 'test_writer' | 'executor' | 'reviewer'
interface Session { role: Role; id: string; cwd: string; system: string }
function roleOf(system: string): Role | undefined {
  const word = /тестопис|test.writer|исполнител|executor|ревью|reviewer|разбор|analysis/i.exec(system)?.[0].toLowerCase()
  if (!word) return undefined
  if (/тестопис|test.writer/.test(word)) return 'test_writer'
  if (/исполнител|executor/.test(word)) return 'executor'
  if (/ревью|reviewer/.test(word)) return 'reviewer'
  return 'analysis'
}

// The three models of the harness. `alpha` is a DeepSeek-like route with all
// four levels; `beta` offers only low and high and defaults to low; `gamma`
// advertises nothing about reasoning.
interface FixtureModel { provider: string; id: string; name: string; levels?: string[]; defaultLevel?: string }
const ALPHA: FixtureModel = {
  provider: 'factory-provider-alpha', id: 'analysis-alpha', name: 'Analysis Alpha',
  levels: ['off', 'low', 'high', 'max'], defaultLevel: 'high',
}
const BETA: FixtureModel = {
  provider: 'factory-provider-beta', id: 'analysis-beta', name: 'Analysis Beta',
  levels: ['low', 'high'], defaultLevel: 'low',
}
const GAMMA: FixtureModel = { provider: 'factory-provider-gamma', id: 'analysis-gamma', name: 'Analysis Gamma' }
const MODELS = [ALPHA, BETA, GAMMA]

type Json = Record<string, unknown>
interface Call { method: string; params: Json; messageId?: number }
interface Screen { id: number; call: Call }
interface TaskRow { id: number; body: string; status: string }
type ModelReply = string | ContentBlock[]
interface World {
  root: string
  home: string
  project: string
  bin: string
  scripted: Map<string, number>
  calls: Call[]
  requests: GenerateOptions[]
  sequence: number
  messageId: number
  bot?: Awaited<ReturnType<typeof startDshbot>>
  pending: Promise<void>[]
}
let world: World
let savedEnv: Record<string, string | undefined>

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
  if (method === 'getMe') return Response.json({ ok: true, result: { id: 4242, username: 'factory_effort_bot' } })
  if (['sendMessage', 'sendRichMessage'].includes(method)) {
    call.messageId = ++world.messageId
    return Response.json({ ok: true, result: { message_id: call.messageId, chat: { id: params.chat_id } } })
  }
  if (method.startsWith('editMessage')) {
    return Response.json({ ok: true, result: { message_id: params.message_id, chat: { id: params.chat_id } } })
  }
  return Response.json({ ok: true, result: true })
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
function tasks(): TaskRow[] {
  const store = openStore(join(world.home, 'state.db'))
  try {
    return store.db.prepare('SELECT id, body, status FROM factory_tasks ORDER BY id').all() as unknown as TaskRow[]
  } finally {
    store.close()
  }
}
function status(id: number): string | undefined {
  return tasks().find((task) => task.id === id)?.status
}
async function expectStatus(id: number, wanted: string): Promise<void> {
  await vi.waitFor(() => expect(status(id), `status of task #${id}`).toBe(wanted), { timeout: WAIT })
}

// The adapter replaces only the provider boundary of the real LlmRuntime. The
// DeepSeek route of the owner's main session offers all four levels, high by default.
function levelsOf(provider: string, id: string): { levels: string[]; defaultLevel: string } | undefined {
  const model = MODELS.find((entry) => entry.provider === provider && entry.id === id)
  if (model === undefined) return { levels: LEVELS, defaultLevel: 'high' }
  return model.levels === undefined ? undefined : { levels: model.levels, defaultLevel: model.defaultLevel ?? model.levels[0]! }
}
function resolveFixtureModel(provider: string, id: string) {
  const reasoning = levelsOf(provider, id)
  return {
    provider, id, name: id,
    ...(reasoning === undefined ? {} : {
      reasoning: {
        efforts: reasoning.levels.map((level) => ({ id: ReasoningEffortId(level), name: level })),
        defaultEffort: ReasoningEffortId(reasoning.defaultLevel),
      },
    }),
  }
}
const fixtureAdapter = {
  listModels: async (provider: string) => MODELS
    .filter((model) => model.provider === provider)
    .map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
  resolveModel: async (provider: string, id: string) => resolveFixtureModel(provider, id),
  prepareCall: async (provider: string, id: string) => ({ model: resolveFixtureModel(provider, id), stream: modelStream }),
  imageRequestPricing: () => undefined,
  imageRequestTarget: () => { throw new Error('the fixture routes carry no images') },
  stream: modelStream,
}

async function* modelStream(request: GenerateOptions): AsyncIterable<StreamChunk> {
  world.requests.push(structuredClone(request))
  const reply = scriptedReply(request)
  const blocks: ContentBlock[] = typeof reply === 'string' ? [{ type: 'text', text: reply }] : reply
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    if (block.type === 'tool-call') yield {
      type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments,
    }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 20 } }
  yield { type: 'finish', reason: { kind: blocks.some((block) => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
}

// Discover the simple file-write capability by its advertised JSON schema.
function writeTool(request: GenerateOptions): { tool: ToolSchema; path: string; many: boolean; content?: string } {
  for (const tool of request.tools ?? []) {
    if (!/write|запис|созда/i.test(`${tool.name} ${tool.description}`)) continue
    const props = object(tool.parameters.properties)
    const path = Object.keys(props).find((key) => /path|file/i.test(key) && ['string', 'array'].includes(String(object(props[key]).type)))
    const content = Object.keys(props).find((key) => /content|text|body/i.test(key) && object(props[key]).type === 'string')
    if (path && content) return { tool, path, content, many: object(props[path]).type === 'array' }
  }
  return expect.fail('the role needs a write file capability')
}
function writeCalls(request: GenerateOptions, files: Array<[string, string]>): ContentBlock[] {
  const cap = writeTool(request)
  return files.map(([path, content], index) => ({
    type: 'tool-call', id: ToolCallId(`file-${world.requests.length}-write-${index}`), name: cap.tool.name,
    arguments: JSON.stringify({ [cap.path]: cap.many ? [path] : path, [cap.content!]: content }),
  }))
}
function scriptedReply(request: GenerateOptions): ModelReply {
  const id = String(request.sessionId)
  if (id === MAIN) return 'ответ main'
  const session = seam.sessions.findLast((entry) => entry.id === id)
  if (session === undefined) return 'ответ'
  const step = world.scripted.get(id) ?? 0
  world.scripted.set(id, step + 1)
  if (session.role === 'analysis') return JSON.stringify(DEFAULT_ANALYSIS)
  if (session.role === 'test_writer') {
    return step === 0
      ? writeCalls(request, [[TEST_PATH, RED_TEST]])
      : JSON.stringify({ tests: [TEST_PATH], summary: 'Добавлен тест value returns two' })
  }
  if (session.role === 'executor') {
    return step === 0
      ? writeCalls(request, [['src/value.mjs', FIXED_SOURCE]])
      : JSON.stringify({ summary: 'готово', files: ['src/value.mjs'] })
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'Критерии выполнены', issues: [], comments: [] })
}

function makeProject(path: string): void {
  put(join(path, 'src/value.mjs'), BASE_SOURCE)
  put(join(path, 'package.json'), JSON.stringify({
    name: 'factory-fixture', private: true, type: 'module', scripts: { test: 'node --test' },
  }))
  gitAt(path, 'init', '-q')
  gitAt(path, 'add', '--', 'src/value.mjs', 'package.json')
  gitAt(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
}
// A bwrap double: it reports red while the fixed source is absent and green after.
function installBwrap(): void {
  put(join(world.bin, 'bwrap'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
const cwd = args[args.indexOf('--chdir') + 1] || process.cwd()
const command = args.slice(args.indexOf('--') + 1)
if (command.length === 1 && (command[0] === '/bin/true' || command[0] === '/usr/bin/true')) process.exit(0)
const source = fs.readFileSync(path.join(cwd, 'src/value.mjs'), 'utf8')
const testExists = fs.existsSync(path.join(cwd, ${JSON.stringify(TEST_PATH)}))
const code = testExists && !source.includes('return 2') ? 1 : 0
console.log(code === 0 ? 'fixture tests passed' : 'AssertionError: value returns two')
process.exitCode = code
`)
  chmodSync(join(world.bin, 'bwrap'), 0o755)
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-effort-')))
  const home = join(root, 'bot')
  world = {
    root, home, project: join(home, 'app'), bin: join(root, 'bin'),
    scripted: new Map(), calls: [], requests: [], sequence: 4000, messageId: 9000, pending: [],
  }
  seam.handle = undefined
  seam.sessions = []
  seam.runners = []
  seam.pending = []
  seam.timeoutWriter = false
  seam.attempts = []
  savedEnv = Object.fromEntries(['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'DEEPSEEK_API_KEY'].map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries({
    PATH: [world.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    HOME: root, DSHBOT_UPSTREAM: 'off', DSHBOT_AUTO_SYNC: 'off',
    DSHBOT_DREAM_AT: 'off', DSHBOT_BACKUP_AT: '',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  })) vi.stubEnv(key, value)
  makeProject(world.project)
  installBwrap()
  const store = openStore(join(home, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER))
    // Execution stops at «ждёт человека»; acceptance has its own tests.
    store.kv.set('factory.autoaccept', '0')
  } finally { store.close() }

  vi.spyOn(LlmRuntime.prototype, 'listProviders').mockImplementation(() =>
    MODELS.map((model) => ({ id: model.provider, name: model.provider })))
  // Every route is served by the fixture adapter; the SDK validation above it is real.
  vi.spyOn(LlmRuntime.prototype as unknown as { registration: (provider: string) => unknown }, 'registration')
    .mockImplementation((provider: string) => ({
      adapter: fixtureAdapter,
      provider: { id: provider, name: provider },
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test-provider'),
    }))
  // Any accidental provider HTTP call fails locally instead of using the network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external fetch in factory test') }))
})
afterEach(async () => {
  try {
    await Promise.allSettled(world.pending)
    await Promise.allSettled(seam.runners.map((runner) => runner.stop()))
    await Promise.allSettled(seam.pending)
    await world.bot?.stop()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(world.root, { recursive: true, force: true })
  }
})
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

async function start(): Promise<void> {
  world.bot = await startDshbot({
    dshbotHome: world.home,
    telegramBotToken: 'factory-effort-test-token',
    deepseekApiKey: 'factory-effort-test-key',
    fetch: telegramFetch,
    ownerDebounceMs: 0,
    exitProcess: () => undefined,
  })
  expect(seam.handle, 'the daemon installed its real update handler').toBeDefined()
}
async function say(text: string): Promise<void> {
  const id = ++world.sequence
  await seam.handle!({
    update_id: id,
    message: { message_id: id, chat: { id: OWNER, type: 'private' }, text },
  } as TelegramUpdate)
  // Durable-ingress drain: the queued owner turn is over when its row is gone.
  await vi.waitFor(() => {
    const store = openStore(join(world.home, 'state.db'))
    try {
      expect(store.ingress.pending().some((row) => row.externalId === String(id))).toBe(false)
    } finally {
      store.close()
    }
  }, { timeout: WAIT })
}
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
      id: `effort-callback-${id}`, from: { id: OWNER, is_bot: false, first_name: 'Owner' },
      chat_instance: 'factory-effort', data,
      message: { message_id: screen.id, date: 1, chat: { id: OWNER, type: 'private' }, text: plain(screen.call) },
    },
  } as unknown as TelegramUpdate)
}
async function tap(screen: Screen, label: string | RegExp): Promise<Screen> {
  const mark = world.calls.length
  await press(screen, button(screen, label))
  await vi.waitFor(() => expect(rendered(mark).some((call) => call.method === 'editMessageText' &&
    call.params.message_id === screen.id), `menu navigation ${String(label)} edits its message`).toBe(true), { timeout: WAIT })
  const edits = rendered(mark).filter((call) => call.method === 'editMessageText' && call.params.message_id === screen.id)
  return { id: screen.id, call: edits.at(-1)! }
}
async function section(label: string): Promise<Screen> {
  return tap(await home(), label)
}
async function createTask(body: string): Promise<number> {
  await section('Новая задача')
  const count = tasks().length
  const done = say(body)
  world.pending.push(done)
  void done.catch(() => undefined)
  await vi.waitFor(() => expect(tasks().length).toBe(count + 1), { timeout: WAIT })
  return tasks().at(-1)!.id
}
async function runTask(): Promise<number> {
  const mark = world.calls.length
  const id = await createTask('Показать правильное значение value')
  const approvals = (): Screen[] => rendered(mark).filter((call) => {
    const labels = buttons(call).map((entry) => String(entry.text))
    return labels.some((label) => /Одобрить/i.test(label)) && labels.some((label) => /Править/i.test(label))
  }).map(screenOf)
  await vi.waitFor(() => expect(approvals().length, 'owner receives an analysis approval card').toBeGreaterThan(0), { timeout: WAIT })
  await expectStatus(id, 'awaiting_approval')
  const card = approvals().at(-1)!
  const pending = press(card, button(card, 'Одобрить'))
  world.pending.push(pending)
  void pending.catch(() => undefined)
  await expectStatus(id, 'awaiting_human')
  return id
}

test('c2 timeout outcome retries the same role prompt on the next model', async () => {
  await start()
  const store = openStore(join(world.home, 'state.db'))
  try {
    store.kv.set('factory.role_models.test_writer', JSON.stringify([ALPHA, BETA].map((m) => `${m.provider}\u0000${m.id}`)))
  } finally { store.close() }
  seam.timeoutWriter = true
  const pending = runTask()
  world.pending.push(pending.then(() => undefined, () => undefined))
  void pending.catch(() => undefined)
  await vi.waitFor(() => expect(seam.attempts.map((attempt) => attempt.model)).toEqual([ALPHA.id, BETA.id]), { timeout: WAIT })
  expect(seam.attempts[1]!.prompt).toBe(seam.attempts[0]!.prompt)
  const id = await pending
  expect(status(id)).toBe('awaiting_human')
})
