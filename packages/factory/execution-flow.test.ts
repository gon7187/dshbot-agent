// Execution contracts through the real daemon, SQLite store, factory and harness.
// The ingress/model fixture follows app/factory-analysis-flow.test.ts; the CLI
// boundary follows app/evolve-gate-responsiveness.test.ts. bwrap is a child-process
// double: it records the real evolve sandbox arguments but executes no project
// command. All repositories and file canaries are disposable fixtures.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, sep } from 'node:path'
import LlmRuntime, {
  isAgentLoopRequest,
  resolveRetryPolicy,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
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
}))

vi.mock('../telegram/src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telegram/src/index.js')>()),
  createPoller: (options: CreatePollerOptions) => {
    seam.handle = options.handle
    return { start: async () => undefined, stop: () => undefined }
  },
}))
// Observe session identity and cwd without replacing the agent loop or tools.
vi.mock('../runner/src/index.js', async (original) => {
  const actual = await original<typeof import('../runner/src/index.js')>()
  return { ...actual, startRunner: async (options: RunnerOptions) => {
    const runner = await actual.startRunner(options)
    seam.runners.push(runner)
    const promptTurn = runner.promptTurn.bind(runner)
    runner.promptTurn = (text: string, session?: RunnerSession) => {
      const system = session?.systemPrefix ?? options.systemPrefix
      const role = roleOf(system)
      if (role) seam.sessions.push({
        role, id: session?.sessionId ?? 'main', cwd: options.cwd, system,
      })
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
const CRITERIA = ['value() возвращает 2.']
const FOOTPRINT = ['src/value.mjs']
const DEFAULT_ANALYSIS = { criteria: CRITERIA, footprint: FOOTPRINT, risk: 'low' }
const TEST_PATH = 'tests/value.test.mjs'
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const RED_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('value returns two', () => assert.equal(value(), 2))\n"
const PRIVATE_EXECUTOR = 'EXECUTOR-PRIVATE-CONVERSATION-72164'
const TEST_FAILURE = 'AssertionError: value returns two, actual 1 expected 2'
type Role = 'analysis' | 'test_writer' | 'executor' | 'reviewer'
interface Session { role: Role; id: string; cwd: string; system: string }
interface GateEvent { edge: 'start' | 'end' | 'probe' | 'host'; at: number; cwd: string; args: string[]; code?: number }
interface GatePlan { codes?: number[]; delay?: number; unavailable?: boolean }
function roleOf(system: string): Role | undefined {
  const word = /тестопис|test.writer|исполнител|executor|ревью|reviewer|разбор|analysis/i.exec(system)?.[0].toLowerCase()
  if (!word) return undefined
  if (/тестопис|test.writer/.test(word)) return 'test_writer'
  if (/исполнител|executor/.test(word)) return 'executor'
  if (/ревью|reviewer/.test(word)) return 'reviewer'
  return 'analysis'
}
const MODELS: LlmModelInfo[] = [
  { provider: 'factory-provider-alpha', id: 'analysis-alpha', name: 'Analysis Alpha' },
  { provider: 'factory-provider-beta', id: 'analysis-beta', name: 'Analysis Beta' },
]
type Json = Record<string, unknown>
interface Call { method: string; params: Json; messageId?: number }
interface Screen { id: number; call: Call }
interface TaskRow { id: number; body: string; status: string }
interface Request { body: GenerateOptions; harness: boolean }
type ModelReply = string | ContentBlock[]
interface World {
  root: string
  home: string
  project: string
  bin: string
  events: string
  plan: string
  scripted: Map<string, number>
  executorWrite: (attempt: number) => Array<[string, string]>
  review: (attempt: number) => string
  intercept?: (request: GenerateOptions, session: Session, step: number) => ModelReply | undefined | Promise<ModelReply | undefined>
  calls: Call[]
  requests: Request[]
  sequence: number
  messageId: number
  bot?: Awaited<ReturnType<typeof startDshbot>>
  script: (request: GenerateOptions) => ModelReply | Promise<ModelReply>
  releases: Array<() => void>
  pending: Promise<void>[]
  active: number
  maxActive: number
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
  if (method === 'getMe') return Response.json({ ok: true, result: { id: 4242, username: 'factory_analysis_bot' } })
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
function git(...args: string[]): string { return gitAt(world.project, ...args) }
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
function requestText(request: GenerateOptions): string {
  return JSON.stringify({ system: request.system, messages: request.messages })
}
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((resolve) => { release = resolve })
  world.releases.push(release)
  return { wait, release }
}
async function* modelStream(request: GenerateOptions): AsyncIterable<StreamChunk> {
  world.requests.push({ body: structuredClone(request), harness: isAgentLoopRequest(request) })
  world.active++
  world.maxActive = Math.max(world.maxActive, world.active)
  try {
    const reply = await Promise.race([
      Promise.resolve(world.script(request)),
      new Promise<never>((_resolve, reject) => {
        if (request.signal?.aborted) reject(new Error('fixture model aborted'))
        else request.signal?.addEventListener('abort', () => reject(new Error('fixture model aborted')), { once: true })
      }),
    ])
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
  } finally {
    world.active--
  }
}
async function start(): Promise<void> {
  world.bot = await startDshbot({
    dshbotHome: world.home,
    telegramBotToken: 'factory-execution-test-token',
    deepseekApiKey: 'factory-analysis-test-key',
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
  // Same durable-ingress drain as factory-menu-flow: do not race a queued
  // owner turn when checking that remarks stayed out of main.
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
      id: `analysis-callback-${id}`, from: { id: OWNER, is_bot: false, first_name: 'Owner' },
      chat_instance: 'factory-analysis', data,
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
async function createTask(body: string): Promise<{ id: number; done: Promise<void> }> {
  await section('Новая задача')
  const count = tasks().length
  const done = say(body)
  // A task submission may return while analysis runs, or await its completion.
  // Both are allowed. Capture creation separately so a held model cannot deadlock.
  world.pending.push(done)
  void done.catch(() => undefined)
  await vi.waitFor(() => expect(tasks().length).toBe(count + 1), { timeout: WAIT })
  return { id: tasks().at(-1)!.id, done }
}
function approvalCards(mark = 0): Screen[] {
  return rendered(mark).filter((call) => {
    const labels = buttons(call).map((entry) => String(entry.text))
    return labels.some((label) => /Одобрить/i.test(label)) && labels.some((label) => /Править/i.test(label))
  }).map(screenOf)
}
async function cardAfter(mark: number): Promise<Screen> {
  await vi.waitFor(() => expect(approvalCards(mark).length, 'owner receives an analysis approval card').toBeGreaterThan(0), { timeout: WAIT })
  return approvalCards(mark).at(-1)!
}
async function analysed(body = 'Показать правильное значение value'): Promise<{ id: number; card: Screen }> {
  const mark = world.calls.length
  const task = await createTask(body)
  const card = await cardAfter(mark)
  await expectStatus(task.id, 'awaiting_approval')
  await task.done
  return { id: task.id, card }
}
async function detail(id: number): Promise<Screen> {
  return tap(await section('Задачи'), new RegExp(`^#${id}\\b`))
}
beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-execution-')))
  const home = join(root, 'bot')
  world = {
    root, home, project: join(home, 'app'), bin: join(root, 'bin'),
    events: join(root, 'gate-events.jsonl'), plan: join(root, 'gate-plan.json'),
    scripted: new Map(), executorWrite: () => [['src/value.mjs', FIXED_SOURCE]],
    review: () => JSON.stringify({ verdict: 'approve', approved: true, summary: 'Критерии выполнены', issues: [], comments: [] }),
    calls: [], requests: [], sequence: 4000, messageId: 9000,
    script: scriptedReply, releases: [], pending: [], active: 0, maxActive: 0,
  }
  seam.handle = undefined
  seam.sessions = []
  seam.runners = []
  seam.pending = []
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
  put(world.events, '')
  configureGate({})
  installCli()
  const store = openStore(join(home, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER))
    // Execution tests stop at «ждёт человека»; acceptance has its own file.
    store.kv.set('factory.autoaccept', '0')
  } finally { store.close() }

  vi.spyOn(LlmRuntime.prototype, 'listProviders').mockImplementation(() =>
    MODELS.map((model) => ({ id: model.provider, name: model.provider })))
  vi.spyOn(LlmRuntime.prototype, 'listModels').mockImplementation(async (provider) =>
    MODELS.filter((model) => model.provider === provider))
  vi.spyOn(LlmRuntime.prototype, 'resolveModelInfo').mockImplementation(async (provider, model) =>
    ({ provider, id: model, name: model }))
  vi.spyOn(LlmRuntime.prototype, 'resolveCallConfig').mockImplementation(async (config) => config)
  vi.spyOn(LlmRuntime.prototype, 'prepareCall').mockImplementation(async (config, _signal, configure) => ({
    config: configure ? {
      ...config, ...configure(config, { provider: config.provider, id: config.model, name: config.model }),
    } : config,
    retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test-provider'),
    adapterDefaults: {},
    stream: modelStream,
  }))
  vi.spyOn(LlmRuntime.prototype, 'stream').mockImplementation(modelStream)
  // Any accidental provider HTTP call fails locally instead of using the network.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external fetch in factory test') }))
})
afterEach(async () => {
  try {
    for (const release of world.releases) release()
    cancelRoleTurns()
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

function makeProject(path: string): void {
  put(join(path, 'src/value.mjs'), BASE_SOURCE)
  put(join(path, 'notes.md'), 'owner notes\n')
  put(join(path, 'package.json'), JSON.stringify({
    name: 'factory-fixture', private: true, type: 'module', scripts: { test: 'node --test' },
  }))
  gitAt(path, 'init', '-q')
  gitAt(path, 'add', '--', 'src/value.mjs', 'notes.md', 'package.json')
  gitAt(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
}

function configureGate(plan: GatePlan): void { put(world.plan, JSON.stringify(plan)) }
function gateEvents(): GateEvent[] {
  return readFileSync(world.events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as GateEvent)
}
function gateRuns(): GateEvent[] { return gateEvents().filter((event) => event.edge === 'start') }

// Use the existing evolve sandbox runner. Only its executable boundary is fake,
// so a host fallback, missing namespace or wrong cwd is still observable.
function installCli(): void {
  put(join(world.bin, 'bwrap'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(world.plan)}, 'utf8'))
const eventFile = ${JSON.stringify(world.events)}
const cwd = args[args.indexOf('--chdir') + 1] || process.cwd()
const command = args.slice(args.indexOf('--') + 1)
const record = (edge, code) => fs.appendFileSync(eventFile, JSON.stringify({edge, code, cwd, args, at: Date.now()}) + '\\n')
async function main() {
  if (command.length === 1 && (command[0] === '/bin/true' || command[0] === '/usr/bin/true')) {
    record('probe')
    if (plan.unavailable) { console.error('bwrap unavailable in fixture'); process.exitCode = 127 }
    return
  }
  if (plan.unavailable) { console.error('bwrap unavailable in fixture'); process.exitCode = 127; return }
  const index = fs.readFileSync(eventFile, 'utf8').split('\\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => event.edge === 'start').length
  record('start')
  await new Promise(resolve => setTimeout(resolve, plan.delay || 0))
  const source = fs.readFileSync(path.join(cwd, 'src/value.mjs'), 'utf8')
  const testExists = fs.existsSync(path.join(cwd, ${JSON.stringify(TEST_PATH)}))
  const code = plan.codes?.[index] ?? (testExists && !source.includes('return 2') ? 1 : 0)
  console.log(code === 0 ? 'fixture tests passed' : ${JSON.stringify(TEST_FAILURE)})
  record('end', code)
  process.exitCode = code
}
main().catch(error => { console.error(error); process.exitCode = 1 })
`)
  // Accidental host execution must be visible, but never run a package manager.
  for (const name of ['npm', 'fixture-tests']) {
    put(join(world.bin, name), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(world.events)}, JSON.stringify({
  edge: 'host', at: Date.now(), cwd: process.cwd(), args: process.argv.slice(2)
}) + '\\n')
process.exitCode = 91
`)
  }
  for (const name of ['bwrap', 'npm', 'fixture-tests']) chmodSync(join(world.bin, name), 0o755)
}

function sessions(role?: Role): Session[] {
  return seam.sessions.filter((session) => role ? session.role === role : session.role !== 'analysis')
}
function cancelRoleTurns(): void {
  for (const runner of seam.runners) {
    for (const session of seam.sessions) runner.cancel(session.id)
  }
}
function sessionFor(request: GenerateOptions): Session {
  const session = seam.sessions.findLast((entry) => entry.id === String(request.sessionId))
  expect(session, 'every role request belongs to an observed harness session').toBeDefined()
  return session!
}
function requestsFor(session: Session): Request[] {
  return world.requests.filter((request) => String(request.body.sessionId) === session.id)
}

// Discover the simple file capability by its advertised JSON schema, as the
// neighboring analysis test does for read_file. Tool names are not a contract.
function fileTool(request: GenerateOptions, mode: 'read' | 'write'): { tool: ToolSchema; path: string; many: boolean; content?: string } {
  for (const tool of request.tools ?? []) {
    if (!(mode === 'read' ? /read|чтен/i : /write|запис|созда/i).test(`${tool.name} ${tool.description}`)) continue
    const props = object(tool.parameters.properties)
    const path = Object.keys(props).find((key) => /path|file/i.test(key) && ['string', 'array'].includes(String(object(props[key]).type)))
    const content = Object.keys(props).find((key) => /content|text|body/i.test(key) && object(props[key]).type === 'string')
    if (path && (mode === 'read' || content)) return { tool, path, content, many: object(props[path]).type === 'array' }
  }
  expect.fail(`the ${sessionFor(request).role} role needs a ${mode} file capability`)
}
function fileCalls(request: GenerateOptions, mode: 'read' | 'write', files: Array<[string, string]>): ContentBlock[] {
  const cap = fileTool(request, mode)
  return files.map(([path, content], index) => ({
    type: 'tool-call', id: ToolCallId(`file-${world.requests.length}-${mode}-${index}`), name: cap.tool.name,
    arguments: JSON.stringify({ [cap.path]: cap.many ? [path] : path, ...(cap.content ? { [cap.content]: content } : {}) }),
  }))
}
function writerReply(): string {
  return JSON.stringify({ tests: [TEST_PATH], summary: 'Добавлен тест value returns two' })
}
function executorReply(): string {
  return JSON.stringify({ summary: PRIVATE_EXECUTOR, files: ['src/value.mjs'] })
}
async function scriptedReply(request: GenerateOptions): Promise<ModelReply> {
  const session = sessionFor(request)
  const step = world.scripted.get(session.id) ?? 0
  world.scripted.set(session.id, step + 1)
  const intercepted = await world.intercept?.(request, session, step)
  if (intercepted !== undefined) return intercepted
  if (session.role === 'analysis') return JSON.stringify(DEFAULT_ANALYSIS)
  if (session.role === 'test_writer') {
    if (step === 0) return fileCalls(request, 'write', [[TEST_PATH, RED_TEST]])
    return writerReply()
  }
  if (session.role === 'executor') {
    if (step === 0) return fileCalls(request, 'write', world.executorWrite(sessions('executor').length))
    return executorReply()
  }
  return world.review(sessions('reviewer').length)
}

async function approve(task: { id: number; card: Screen }): Promise<void> {
  // The update handler may finish before the execution worker. Do not await an
  // entire held model turn merely to observe that approval has been accepted.
  const pending = press(task.card, button(task.card, 'Одобрить'))
  world.pending.push(pending)
  void pending.catch(() => undefined)
  await vi.waitFor(() => expect(status(task.id)).not.toBe('awaiting_approval'), { timeout: WAIT })
}
async function roleStarted(role: Role, count = 1): Promise<Session> {
  await vi.waitFor(() => expect(sessions(role).length, `${role} starts after approval`).toBeGreaterThanOrEqual(count), { timeout: WAIT })
  return sessions(role)[count - 1]!
}
async function finished(id: number): Promise<Screen> {
  await expectStatus(id, 'awaiting_human')
  return detail(id)
}
async function waitForGate(count: number): Promise<GateEvent> {
  await vi.waitFor(() => expect(gateRuns().length, 'the real sandbox runner starts its child').toBeGreaterThanOrEqual(count), { timeout: WAIT })
  return gateRuns()[count - 1]!
}
async function stableRequests(): Promise<void> {
  const mark = world.requests.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(world.requests, 'terminal tasks schedule no further model requests').toHaveLength(mark)
}
// Models are switched on the page of their provider. The wanted model goes on
// first, so the role never has to drop its last model.
async function selectModel(role: string, wanted: number): Promise<void> {
  let screen = await tap(await section('Модели'), role)
  for (const index of [wanted, ...MODELS.keys()].filter((entry, position, all) => all.indexOf(entry) === position)) {
    const model = MODELS[index]!
    screen = await tap(screen, `${model.provider} `)
    const enabled = /✅/.test(String(button(screen, model.name).text))
    if (enabled !== (index === wanted)) screen = await tap(screen, model.name)
    screen = await tap(screen, 'Назад')
  }
}
function treeSnapshot(root: string): Array<[string, string]> {
  const result: Array<[string, string]> = []
  for (const name of readdirSync(root).sort()) {
    // Never open repository metadata or environment files, even in a fixture.
    if (name === '.git' || name.startsWith('.env')) continue
    const path = join(root, name)
    if (lstatSync(path).isDirectory()) {
      for (const [child, content] of treeSnapshot(path)) result.push([`${name}/${child}`, content])
    } else if (!lstatSync(path).isSymbolicLink()) result.push([name, readFileSync(path, 'utf8')])
  }
  return result
}
function assertRound(text: string, round: number): void {
  expect(text).toMatch(new RegExp(`круг\\s*:?\\s*${round}\\s*(?:из|/)\\s*3`, 'i'))
}

test('test_c1_approval_runs_roles_in_a_separate_worktree_and_preserves_the_owner_copy', async () => {
  await start()
  const task = await analysed()
  const before = treeSnapshot(world.project)
  const head = git('log', '-1', '--format=%H')
  // These refs belong only to the temporary project, never to this checkout.
  const ownerRef = git('symbolic-ref', 'HEAD')
  const writer = gate()
  world.intercept = async (_request, session, step) => {
    if (session.role === 'test_writer' && step === 0) await writer.wait
    return undefined
  }
  await approve(task)
  const session = await roleStarted('test_writer')
  expect(status(task.id)).toBe('running')
  expect(session.cwd).not.toBe(world.project)
  expect(relative(world.project, session.cwd).split(sep)[0], 'worktree is outside the owner project').toBe('..')
  expect(gitAt(session.cwd, 'rev-parse', '--show-toplevel')).toBe(realpathSync(session.cwd))
  expect(gitAt(session.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    .toBe(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
  writer.release()
  await finished(task.id)
  expect(sessions().map((entry) => entry.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  for (const role of sessions()) expect(role.cwd).toBe(session.cwd)
  expect(readFileSync(join(session.cwd, TEST_PATH), 'utf8')).toBe(RED_TEST)
  expect(readFileSync(join(session.cwd, 'src/value.mjs'), 'utf8')).toBe(FIXED_SOURCE)
  expect(treeSnapshot(world.project)).toEqual(before)
  expect(git('log', '-1', '--format=%H')).toBe(head)
  expect(git('symbolic-ref', 'HEAD')).toBe(ownerRef)
  expect(git('ls-files', '--modified', '--others', '--exclude-standard')).toBe('')
})

test.each([false, true])('test_c2_roles_use_menu_models_and_separate_clean_sessions_same_model_%s', async (sameModel) => {
  await start()
  await selectModel('тестописец', 0)
  await selectModel('исполнитель', sameModel ? 0 : 1)
  await selectModel('ревьюер', sameModel ? 0 : 1)
  const task = await analysed()
  await approve(task)
  await roleStarted('reviewer')
  await finished(task.id)
  const roles = sessions()
  expect(roles.map((session) => session.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(new Set(roles.map((session) => session.id)).size).toBe(3)
  expect(new Set(roles.map((session) => session.system)).size).toBe(3)
  for (const [index, session] of roles.entries()) {
    const expected = MODELS[sameModel || index === 0 ? 0 : 1]!
    expect(session.id).not.toBe('main')
    const requests = requestsFor(session)
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request.harness).toBe(true)
      expect(request.body.provider).toBe(expected.provider)
      expect(request.body.model).toBe(expected.id)
    }
  }
  expect(requestsFor(roles[2]!).map((request) => requestText(request.body)).join('\n')).not.toContain(PRIVATE_EXECUTOR)
})

test('test_c3_green_writer_tests_retry_once_then_wait_for_a_human_without_an_executor', async () => {
  configureGate({ codes: [0, 0] })
  await start()
  const task = await analysed()
  await approve(task)
  await roleStarted('test_writer', 2)
  const card = await finished(task.id)
  expect(sessions('test_writer')).toHaveLength(2)
  expect(gateRuns()).toHaveLength(2)
  expect(sessions('executor')).toHaveLength(0)
  expect(sessions('reviewer')).toHaveLength(0)
  const retry = requestsFor(sessions('test_writer')[1]!).map((request) => requestText(request.body)).join('\n')
  expect(retry).toMatch(/не красн|зел[её]н|(?:not|must|expected).{0,40}(?:red|fail)|(?:passed|green)/i)
  expect(plain(card.call)).toMatch(/тесты тестописца не красные/i)
  await stableRequests()
})

test('test_c4_executor_outside_scope_and_locked_test_edits_are_rejected_with_the_paths_next_round', async () => {
  await start()
  const task = await analysed()
  const next = gate()
  world.intercept = async (_request, session, step) => {
    // Model providers are untrusted. Plant actual writes at that boundary so
    // this also tests the post-turn guard when file tools reject such edits.
    if (session.role === 'executor' && sessions('executor').length === 1 && step === 0) {
      put(join(session.cwd, 'notes.md'), 'out of scope\n')
      put(join(session.cwd, TEST_PATH), RED_TEST.replace('value(), 2', 'value(), 1'))
    }
    if (session.role === 'executor' && sessions('executor').length === 2 && step === 0) await next.wait
    return undefined
  }
  await approve(task)
  const second = await roleStarted('executor', 2)
  await vi.waitFor(() => expect(requestsFor(second).length).toBeGreaterThan(0), { timeout: WAIT })
  const text = requestText(requestsFor(second)[0]!.body)
  expect(text).toContain('notes.md')
  expect(text).toContain(TEST_PATH)
  expect(text).toMatch(/footprint|вне|запрещ|тестопис|locked|protected|scope/i)
  expect(sessions('reviewer'), 'an invalid executor round is never reviewed as a success').toHaveLength(0)
  assertRound(plain((await detail(task.id)).call), 2)
  next.release()
  await finished(task.id)
})

test('test_c5_evolve_sandbox_uses_project_command_and_keeps_help_and_factory_buttons_responsive', async () => {
  configureGate({ delay: 2_200 })
  await start()
  const external = join(world.root, 'sample')
  makeProject(external)
  await tap(await section('Проекты'), 'Добавить')
  await say(`${external}\nfixture-tests --unit`)
  world.project = external
  let create = await section('Новая задача')
  create = await tap(create, 'sample')
  const mark = world.calls.length
  const done = say('Показать правильное значение value')
  world.pending.push(done)
  await vi.waitFor(() => expect(tasks()).toHaveLength(1), { timeout: WAIT })
  const task = { id: tasks()[0]!.id, card: await cardAfter(mark) }
  await done
  await approve(task)
  const event = await waitForGate(1)
  const ticks: number[] = [Date.now()]
  const timer = setInterval(() => { ticks.push(Date.now()) }, 50)
  try {
    const helpMark = world.calls.length
    const helpStart = performance.now()
    await say('/help')
    await vi.waitFor(() => expect(rendered(helpMark).some((call) => /Команды владельца/.test(plain(call)))).toBe(true), { timeout: 1_000 })
    expect(performance.now() - helpStart).toBeLessThan(1_000)
    expect(gateEvents().some((entry) => entry.edge === 'end'), 'help arrives while the child is waiting').toBe(false)
    const menu = await home()
    const buttonStart = performance.now()
    const list = await tap(menu, 'Задачи')
    expect(performance.now() - buttonStart).toBeLessThan(1_000)
    expect(plain(list.call)).toContain('Задачи')
    expect(gateEvents().some((entry) => entry.edge === 'end'), 'menu callback arrives while tests are running').toBe(false)
    await vi.waitFor(() => expect(gateEvents().filter((entry) => entry.edge === 'end').length).toBeGreaterThan(0), { timeout: WAIT })
    const ended = gateEvents().find((entry) => entry.edge === 'end')!
    expect(ended.at - event.at).toBeGreaterThanOrEqual(2_000)
    const during = [event.at, ...ticks.filter((tick) => tick > event.at && tick < ended.at), ended.at]
    expect(Math.max(...during.slice(1).map((tick, index) => tick - during[index]!))).toBeLessThan(500)
    const args = event.args
    const command = args.slice(args.indexOf('--') + 1).join(' ')
    expect(command).toContain('fixture-tests --unit')
    expect(args).toContain('--unshare-net')
    expect(args).not.toContain('--share-net')
    expect(event.cwd).not.toBe(external)
    const sequence = (...parts: string[]): boolean => args.some((_, index) => parts.every((part, offset) => args[index + offset] === part))
    expect(sequence('--chdir', event.cwd)).toBe(true)
    expect(sequence('--bind', event.cwd, event.cwd)).toBe(true)
    expect(sequence('--tmpfs', world.root)).toBe(true)
    for (let index = 0; index < args.length - 2; index++) {
      if (args[index] !== '--bind' && args[index] !== '--ro-bind') continue
      expect([world.root, world.home, external, '/'], 'owner directories are never mounted into the test sandbox').not.toContain(args[index + 1])
    }
    expect(gateEvents().filter((entry) => entry.edge === 'host')).toHaveLength(0)
  } finally { clearInterval(timer) }
  await finished(task.id)
})

test('test_c6_unavailable_bwrap_waits_for_a_human_and_never_falls_back_to_host_tests', async () => {
  configureGate({ unavailable: true })
  await start()
  const task = await analysed()
  await approve(task)
  const card = await finished(task.id)
  expect(plain(card.call)).toMatch(/песочниц|sandbox/i)
  expect(plain(card.call)).toMatch(/недоступ|не запуска|не найден|unavailable|bwrap/i)
  expect(gateRuns()).toHaveLength(0)
  expect(gateEvents().filter((event) => event.edge === 'host')).toHaveLength(0)
  expect(sessions('executor')).toHaveLength(0)
  await stableRequests()
})

test.each(['gate', 'review'] as const)('test_c7_%s_failure_reaches_the_next_executor_and_increments_the_round', async (failure) => {
  const remark = 'REVIEW-REMARK-68142: проверить пустое значение'
  configureGate({ codes: failure === 'gate' ? [1, 1, 0] : [1, 0, 0] })
  world.review = (attempt) => JSON.stringify({
    verdict: failure === 'review' && attempt === 1 ? 'reject' : 'approve',
    approved: !(failure === 'review' && attempt === 1),
    summary: remark, issues: failure === 'review' && attempt === 1 ? [remark] : [],
    comments: failure === 'review' && attempt === 1 ? [remark] : [],
  })
  const held = gate()
  world.intercept = async (_request, session, step) => {
    if (session.role === 'executor' && sessions('executor').length === 2 && step === 0) await held.wait
    return undefined
  }
  await start()
  const task = await analysed()
  await approve(task)
  const second = await roleStarted('executor', 2)
  await vi.waitFor(() => expect(requestsFor(second).length).toBeGreaterThan(0), { timeout: WAIT })
  expect(requestText(requestsFor(second)[0]!.body)).toContain(failure === 'gate' ? TEST_FAILURE : remark)
  assertRound(plain((await detail(task.id)).call), 2)
  held.release()
  expect(plain((await finished(task.id)).call)).toMatch(/готово к при[её]мке/i)
})

test.each(['gate', 'review'])('test_c8_three_%s_failures_stop_with_the_last_reason_and_no_more_model_calls', async (failure) => {
  configureGate({ codes: failure === 'gate' ? [1, 1, 1, 1] : [1, 0, 0, 0] })
  if (failure === 'gate') world.executorWrite = (attempt) => [['src/value.mjs', `export function value() { return ${attempt + 2} }\n`]]
  else world.review = (attempt) => JSON.stringify({
    verdict: 'reject', approved: false, summary: `REVIEW-FAILURE-${attempt}`,
    issues: [`REVIEW-FAILURE-${attempt}`], comments: [`REVIEW-FAILURE-${attempt}`],
  })
  await start()
  const task = await analysed()
  await approve(task)
  const card = await finished(task.id)
  expect(sessions('test_writer')).toHaveLength(1)
  expect(sessions('executor')).toHaveLength(3)
  expect(gateRuns()).toHaveLength(4)
  expect(sessions('reviewer')).toHaveLength(failure === 'gate' ? 0 : 3)
  expect(plain(card.call)).toContain(failure === 'gate' ? TEST_FAILURE : 'REVIEW-FAILURE-3')
  await stableRequests()
})

test('test_c9_green_gate_and_review_commit_the_result_and_list_files_on_the_acceptance_card', async () => {
  await start()
  const task = await analysed()
  const original = git('log', '-1', '--format=%H')
  await approve(task)
  const card = await finished(task.id)
  expect(sessions().map((session) => session.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  const worktree = sessions('executor')[0]!.cwd
  expect(gateEvents().filter((event) => event.edge === 'end').map((event) => event.code)).toEqual([1, 0])
  expect(gitAt(worktree, 'log', '-1', '--format=%H')).not.toBe(original)
  expect(gitAt(worktree, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/factory/${task.id}`)
  expect(gitAt(worktree, 'show', 'HEAD:src/value.mjs')).toBe(FIXED_SOURCE.trim())
  expect(gitAt(worktree, 'show', `HEAD:${TEST_PATH}`)).toBe(RED_TEST.trim())
  expect(gitAt(worktree, 'ls-files', '--modified', '--others', '--exclude-standard')).toBe('')
  expect(plain(card.call)).toMatch(/готово к при[её]мке/i)
  expect(plain(card.call)).toContain('src/value.mjs')
  expect(plain(card.call)).toContain(TEST_PATH)
})

test('test_c10_open_task_card_edits_in_place_for_each_stage_and_round_without_new_messages', async () => {
  configureGate({ codes: [1, 1, 0], delay: 150 })
  const writer = gate(), executor = gate(), retry = gate(), reviewer = gate()
  world.intercept = async (_request, session, step) => {
    if (step !== 0) return undefined
    if (session.role === 'test_writer') await writer.wait
    if (session.role === 'executor') await (sessions('executor').length === 1 ? executor.wait : retry.wait)
    if (session.role === 'reviewer') await reviewer.wait
    return undefined
  }
  await start()
  const task = await analysed()
  const executionMark = world.calls.length
  await approve(task)
  await roleStarted('test_writer')
  const opened = await detail(task.id)
  expect(plain(opened.call)).toMatch(/этап[^\n]*тест|тесты/i)
  assertRound(plain(opened.call), 1)
  const mark = world.calls.length
  async function progress(stage: RegExp, round: number): Promise<void> {
    await vi.waitFor(() => {
      const edits = rendered(mark).filter((call) => call.method === 'editMessageText' && call.params.message_id === opened.id)
      const latest = edits.at(-1)
      expect(latest, 'the open task card updates without another owner callback').toBeDefined()
      expect(plain(latest!)).toMatch(stage)
      assertRound(plain(latest!), round)
    }, { timeout: WAIT })
  }
  writer.release()
  await progress(/исполнени/i, 1)
  executor.release()
  await progress(/исполнени/i, 2)
  const gateEdits = rendered(mark).filter((call) => call.method === 'editMessageText' && call.params.message_id === opened.id && /гейт/i.test(plain(call)))
  expect(gateEdits.length, 'the gate stage is also rendered').toBeGreaterThan(0)
  retry.release()
  await progress(/ревью/i, 2)
  reviewer.release()
  await expectStatus(task.id, 'awaiting_human')
  const sends = rendered(mark).filter((call) => call.method.startsWith('send'))
  expect(sends, 'the finished task opens exactly one acceptance card').toHaveLength(1)
  expect(plain(sends[0]!)).toContain(`#${task.id}`)
  expect(buttons(sends[0]!).some((entry) => String(entry.text).includes('Принять')), 'the acceptance card can be accepted').toBe(true)
  expect(rendered(executionMark).filter((call) => call.method.startsWith('send')),
    'the new messages are the owner-requested /factory menu and the acceptance card').toHaveLength(2)
})

test('test_c11_second_approved_task_stays_queued_until_the_first_waits_for_a_human', async () => {
  const firstHeld = gate(), secondHeld = gate()
  world.intercept = async (_request, session, step) => {
    if (session.role === 'test_writer' && step === 0) await (sessions('test_writer').length === 1 ? firstHeld.wait : secondHeld.wait)
    return undefined
  }
  await start()
  const first = await analysed('FIRST: правильное значение')
  const second = await analysed('SECOND: правильное значение')
  await approve(first)
  const firstSession = await roleStarted('test_writer')
  await approve(second)
  expect(status(first.id)).toBe('running')
  expect(status(second.id)).toBe('queued')
  expect(sessions('test_writer')).toHaveLength(1)
  firstHeld.release()
  const secondSession = await roleStarted('test_writer', 2)
  expect(status(first.id)).toBe('awaiting_human')
  expect(status(second.id)).toBe('running')
  expect(secondSession.cwd).not.toBe(firstSession.cwd)
  expect(sessions().map((session) => session.role)).toEqual(['test_writer', 'executor', 'reviewer', 'test_writer'])
  secondHeld.release()
  await finished(second.id)
})

// Preserve the interrupted durable row rather than relying on what a graceful
// stop chooses to mark. The row and worktree come from real execution. This is
// the same SQLite seeding boundary used by the neighboring menu tests.
async function restartWithInterruptedRow(id: number): Promise<void> {
  let saved: Record<string, unknown>
  const store = openStore(join(world.home, 'state.db'))
  try { saved = store.db.prepare('SELECT * FROM factory_tasks WHERE id = ?').get(id) as Record<string, unknown> }
  finally { store.close() }
  cancelRoleTurns()
  await Promise.allSettled(seam.runners.map((runner) => runner.stop()))
  await Promise.allSettled(seam.pending)
  await world.bot!.stop()
  world.bot = undefined
  const reopened = openStore(join(world.home, 'state.db'))
  try {
    const keys = Object.keys(saved).filter((key) => key !== 'id')
    reopened.db.prepare(`UPDATE factory_tasks SET ${keys.map((key) => `"${key}" = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((key) => saved[key] as string | number | null), id)
  } finally { reopened.close() }
  seam.handle = undefined
  world.scripted.clear()
  await start()
}

test('test_c12_restart_resumes_running_work_in_the_same_worktree_and_restarts_analysis', async () => {
  configureGate({ codes: [1, 1, 0] })
  const held = gate(), resumed = gate(), analysisHeld = gate()
  world.intercept = async (_request, session, step) => {
    if (step !== 0) return undefined
    if (session.role === 'executor' && sessions('executor').length === 2) await held.wait
    return undefined
  }
  await start()
  const task = await analysed()
  await approve(task)
  const interrupted = await roleStarted('executor', 2)
  const old = interrupted.cwd
  assertRound(plain((await detail(task.id)).call), 2)
  const writersBefore = sessions('test_writer').length
  world.intercept = async (_request, session, step) => {
    if (session.role === 'executor' && step === 0 && sessions('executor').length === 3) await resumed.wait
    return undefined
  }
  configureGate({})
  await restartWithInterruptedRow(task.id)
  const continued = await roleStarted('executor', 3)
  expect(continued.cwd, 'the executor goes on in the recorded worktree').toBe(old)
  expect(sessions('test_writer'), 'the writer is not run again').toHaveLength(writersBefore)
  expect(existsSync(old), 'the recorded task worktree is kept on restart').toBe(true)
  expect(status(task.id)).toBe('running')
  assertRound(plain((await detail(task.id)).call), 1)
  resumed.release()
  await finished(task.id)

  world.intercept = async (_request, session, step) => {
    if (session.role === 'analysis' && step === 0) await analysisHeld.wait
    return undefined
  }
  const before = seam.sessions.filter((session) => session.role === 'analysis').length
  const interruptedAnalysis = await createTask('RESTART-ANALYSIS: правильное значение')
  await vi.waitFor(() => expect(seam.sessions.filter((session) => session.role === 'analysis')).toHaveLength(before + 1), { timeout: WAIT })
  expect(status(interruptedAnalysis.id)).toBe('analysis')
  world.intercept = undefined
  await restartWithInterruptedRow(interruptedAnalysis.id)
  await expectStatus(interruptedAnalysis.id, 'awaiting_approval')
  expect(seam.sessions.filter((session) => session.role === 'analysis')).toHaveLength(before + 2)
})

test('test_c13_role_tools_reject_outside_and_secret_paths_for_reads_and_writes', async () => {
  // The environment filename is a synthetic symlink; the test never opens it.
  const outside = join(world.home, 'outside-canary.txt')
  const canary = 'FORBIDDEN-READ-CONTENT-49215'
  put(outside, canary)
  for (const file of ['config/my-secret-key.txt', 'secrets/settings.txt', 'config/SECRETS.json']) {
    put(join(world.project, file), canary)
  }
  for (const [name, target] of [
    ['linked-outside', outside], ['linked-dir', world.home], ['.env.local', outside],
    ['alias.txt', 'config/my-secret-key.txt'],
  ]) symlinkSync(target, join(world.project, name))
  git('add', '-f', '--', 'notes.md', 'config', 'secrets', 'linked-outside', 'linked-dir', '.env.local', 'alias.txt')
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture file access canaries')
  await start()
  const task = await analysed()
  const probed = new Set<Role>()
  const probeFiles = new Map<string, string[]>()
  world.intercept = (request, session, step) => {
    if (session.role === 'analysis') return undefined
    expect((request.tools ?? []).map((tool) => tool.name).join(' ')).not.toMatch(/host_exec|(?:^|[_ ])(?:mail|browser|fetch|http|network|web)(?:[_ ]|$)/i)
    if (step === 0) {
      put(join(dirname(session.cwd), 'outside-canary.txt'), canary)
      const files = ['../outside-canary.txt', 'src/../../outside-canary.txt', outside, join(world.project, 'notes.md'),
        'linked-outside', 'linked-dir/outside-canary.txt', '.env.local',
        'config/my-secret-key.txt', 'secrets/settings.txt', 'config/SECRETS.json', 'alias.txt']
      probeFiles.set(session.id, files)
      return fileCalls(request, 'read', [['src/value.mjs', '']])
    }
    if (step === 1) {
      const files = probeFiles.get(session.id)!
      return fileCalls(request, 'read', files.map((file) => [file, '']))
    }
    if (step === 2) {
      probed.add(session.role)
      // Reviewers may be read-only. Exercise every offered write capability.
      const writable = (request.tools ?? []).some((tool) => /write|запис/i.test(`${tool.name} ${tool.description}`))
      if (writable) return fileCalls(request, 'write', probeFiles.get(session.id)!.map((file) => [file, 'FORBIDDEN-WRITE-61239']))
    }
    if (step === 3 || step === 2) {
      if (session.role === 'test_writer') return fileCalls(request, 'write', [[TEST_PATH, RED_TEST]])
      if (session.role === 'executor') return fileCalls(request, 'write', [['src/value.mjs', FIXED_SOURCE]])
      return world.review(1)
    }
    if (session.role === 'test_writer') return writerReply()
    if (session.role === 'executor') return executorReply()
    return world.review(1)
  }
  await approve(task)
  await roleStarted('reviewer')
  await finished(task.id)
  expect([...probed].sort()).toEqual(['executor', 'reviewer', 'test_writer'])
  for (const role of sessions()) {
    const text = requestsFor(role).map((request) => requestText(request.body)).join('\n')
    expect(text, `${role.role} really receives a safe file read`).toContain('export function value()')
    expect(text, `${role.role} never receives forbidden file content`).not.toContain(canary)
    for (const file of ['config/my-secret-key.txt', 'secrets/settings.txt', 'config/SECRETS.json']) {
      expect(readFileSync(join(role.cwd, file), 'utf8')).toBe(canary)
    }
    for (const link of ['linked-outside', 'linked-dir', '.env.local', 'alias.txt']) {
      expect(lstatSync(join(role.cwd, link)).isSymbolicLink(), `${role.role} cannot replace a forbidden symlink`).toBe(true)
    }
    expect(readFileSync(join(dirname(role.cwd), 'outside-canary.txt'), 'utf8')).toBe(canary)
  }
  expect(readFileSync(outside, 'utf8')).toBe(canary)
  expect(readFileSync(join(world.project, 'notes.md'), 'utf8')).toBe('owner notes\n')
})

