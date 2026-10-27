import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

// Model providers of the runner: the pi-ai routes of the harness next to deepseek-official, with the sign-in kept in
// the credential store of the harness (a file of 0600 inside the harness home).
//
// The runner API these tests rely on (everything else is open):
//   runner.providers()                      -> [{ id, name, connected, methods: [{ kind: 'api-key' | 'oauth' }] }],
//                                              exactly the twelve pi-ai routes, deepseek-official is not among them;
//   runner.connectProvider(id, interaction) -> { status: 'connected' | 'cancelled' | 'failed' }, where
//                                              interaction = { prompt(request): Promise<string | undefined>,
//                                              notify({ message, url?, code? }): void }; a prompt that rejects or answers
//                                              undefined is a refusal of the owner and ends the sign-in as 'cancelled';
//   runner.disconnectProvider(id)           -> removes the sign-in record of the provider.
// The sign-in file lies below the harness home (`dshHome`) of the runner, no other option is needed.
// A role of the factory runs on its own runner started with { provider, model }, as the app does.
// The route address of zai (https://api.z.ai/api/coding/paas/v4) is redirected to a local server by wrapping
// globalThis.fetch of the child process: the route must keep using the global fetch for its requests.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 120_000
const RESULT_MARK = '@@PROVIDERS-RESULT@@'

const DEEPSEEK_KEY = 'sk-ds-providers-test-0123456789abcdef'
const ZAI_KEY = 'zai-providers-test-Qm7xLpVt29Kd83mXq0'
const ZAI_REPLY = 'ZAI-ROUTE-REPLY-OK'
const DEEPSEEK_REPLY = 'DEEPSEEK-ROUTE-REPLY-OK'

const PI_AI_ROUTES = [
  'zai',
  'openai-codex',
  'openai',
  'anthropic',
  'google',
  'xai',
  'moonshotai',
  'kimi-coding',
  'minimax',
  'openrouter',
  'github-copilot',
  'qwen-token-plan',
]

type Json = Record<string, unknown>

interface Hit {
  path: string
  mode: number
}

interface Step {
  ok?: unknown
  error?: string
}

interface Report {
  steps: Record<string, Step>
  error?: string
}

interface Seen {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Json
}

interface Servers {
  deepseek: Server
  zai: Server
  deepseekOrigin: string
  zaiOrigin: string
  deepseekSeen: Seen[]
  zaiSeen: Seen[]
}

// The child runs the scenario of one `mode` and reports what every step returned.
const DRIVER_SOURCE = `
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const cfg = JSON.parse(process.argv[2])
const out = { steps: {} }
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw)
  if (url.hostname !== 'api.z.ai') return realFetch(input, init)
  const target = cfg.zaiOrigin + url.pathname + url.search
  return realFetch(input instanceof Request ? new Request(target, input) : target, init)
}

const step = async (name, fn) => {
  try {
    out.steps[name] = { ok: await fn() }
  } catch (error) {
    out.steps[name] = { error: String(error && error.stack ? error.stack : error) }
  }
}

const filesWith = (dir, needle) => {
  const hits = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) hits.push(...filesWith(path, needle))
    else if (entry.isFile() && readFileSync(path).includes(needle)) hits.push({ path, mode: statSync(path).mode & 0o777 })
  }
  return hits
}

const scan = () => ({ zai: filesWith(cfg.root, cfg.zaiKey), deepseek: filesWith(cfg.root, cfg.deepseekKey) })

const interaction = (answer) => ({
  prompt: async (request) => answer(request),
  notify: () => undefined,
})

try {
  const { startRunner } = await import(cfg.entry)
  const base = {
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.deepseekKey,
    systemPrefix: 'Provider routes regression.',
  }

  if (cfg.mode === 'fresh') {
    const runner = await startRunner(base)
    await step('models', () => runner.models())
    await step('providers', () => runner.providers())
    await step('mainTurn', () => runner.promptTurn('ping main'))
    await runner.stop()
  } else {
    const first = await startRunner(base)
    await step('declineRejects', () =>
      first.connectProvider('zai', interaction(async () => { throw new Error('declined by the owner') })))
    await step('declineEmpty', () => first.connectProvider('zai', interaction(async () => undefined)))
    await step('providersDeclined', () => first.providers())
    await step('modelsDeclined', () => first.models())
    await step('scanDeclined', async () => scan())
    const asked = []
    await step('login', () =>
      first.connectProvider('zai', interaction(async (request) => { asked.push(JSON.stringify(request ?? null)); return cfg.zaiKey })))
    await step('asked', async () => asked.length)
    await step('providersConnected', () => first.providers())
    await step('modelsConnected', () => first.models())
    await step('mainTurn', () => first.promptTurn('ping main'))
    await first.stop()

    // the role runner of the factory: a fresh runner on the zai route, the sign-in comes from the store alone
    const connected = out.steps.modelsConnected.ok || []
    const zaiModels = connected.filter((model) => model.provider === 'zai')
    const chosen = zaiModels.find((model) => model.id === 'glm-5.3') || zaiModels[0]
    if (chosen) {
      const role = await startRunner({ ...base, provider: 'zai', model: chosen.id })
      await step('roleTurn', () => role.promptTurn('ping role', { sessionId: 'role-zai-1', transient: true }))
      await role.stop()
    }

    const last = await startRunner(base)
    await step('providersRestarted', () => last.providers())
    await step('modelsRestarted', () => last.models())
    await step('scanConnected', async () => scan())
    await step('disconnect', () => last.disconnectProvider('zai'))
    await step('providersDisconnected', () => last.providers())
    await step('modelsDisconnected', () => last.models())
    await step('scanDisconnected', async () => scan())
    await last.stop()
  }
} catch (error) {
  out.error = String(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
console.log('${RESULT_MARK}' + JSON.stringify(out))
setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref()
`

// --- the two local servers: the DeepSeek Messages API and the zai chat completions -------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const piece of req) chunks.push(Buffer.from(piece as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function parse(raw: string): Json {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {}
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
    anthropicEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    anthropicEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    anthropicEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    anthropicEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    anthropicEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function completionsChunk(delta: Json, finish: string | null): string {
  const data = {
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'glm-5.3',
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  return `data: ${JSON.stringify(data)}\n\n`
}

function completionsStream(text: string): string {
  const usage = {
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'glm-5.3',
    choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  }
  return [
    completionsChunk({ role: 'assistant', content: '' }, null),
    completionsChunk({ content: text }, null),
    completionsChunk({}, 'stop'),
    `data: ${JSON.stringify(usage)}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
}

function completionsMessage(text: string): string {
  return JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 1,
    model: 'glm-5.3',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
  })
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function startServers(): Promise<Servers> {
  const deepseekSeen: Seen[] = []
  const zaiSeen: Seen[] = []
  const deepseek = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parse(raw)
      deepseekSeen.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://stub').pathname, headers: req.headers, body })
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [{ type: 'text', text: DEEPSEEK_REPLY }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(anthropicStream(DEEPSEEK_REPLY))
    })
  })
  const zai = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = parse(raw)
      zaiSeen.push({ method: req.method ?? '', path: new URL(req.url ?? '/', 'http://stub').pathname, headers: req.headers, body })
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(completionsStream(ZAI_REPLY))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(completionsMessage(ZAI_REPLY))
    })
  })
  return { deepseek, zai, deepseekOrigin: await listen(deepseek), zaiOrigin: await listen(zai), deepseekSeen, zaiSeen }
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

// --- running the child ----------------------------------------------------------------------------------

let scratch: string
let servers: Servers

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-model-providers-'))
  mkdirSync(join(scratch, 'workspace'), { recursive: true })
  mkdirSync(join(scratch, 'state'), { recursive: true })
  servers = await startServers()
})

afterEach(async () => {
  await closeServer(servers.deepseek)
  await closeServer(servers.zai)
  rmSync(scratch, { recursive: true, force: true })
})

async function runDriver(mode: 'fresh' | 'flow'): Promise<Report> {
  const script = join(scratch, 'driver.mjs')
  writeFileSync(script, DRIVER_SOURCE)
  const cfg = {
    mode,
    entry: runnerEntry,
    root: join(scratch, 'state'),
    dshHome: join(scratch, 'state', 'dsh'),
    cwd: join(scratch, 'workspace'),
    baseUrl: `${servers.deepseekOrigin}/anthropic`,
    zaiOrigin: servers.zaiOrigin,
    zaiKey: ZAI_KEY,
    deepseekKey: DEEPSEEK_KEY,
  }
  // The key of the environment is the one DeepSeek already works with; the store must never receive it.
  const env = { PATH: process.env.PATH ?? '', HOME: scratch, USERPROFILE: scratch, DEEPSEEK_API_KEY: DEEPSEEK_KEY }
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(repoRoot, 'packages/app/register.mjs'), script, JSON.stringify(cfg)], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString('utf8')
    })
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
  const line = result.output.split('\n').find((candidate) => candidate.startsWith(RESULT_MARK))
  expect(line, `the driver reported\n${result.output.slice(-3000)}`).toBeDefined()
  const report = JSON.parse((line as string).slice(RESULT_MARK.length)) as Report
  expect(report.error, `the driver failed\n${result.output.slice(-3000)}`).toBeUndefined()
  return report
}

/** The value a step returned; a step that threw fails the test with its error. */
function value<T>(report: Report, name: string): T {
  const found = report.steps[name]
  expect(found, `step ${name} ran`).toBeDefined()
  expect(found?.error, `step ${name} failed`).toBeUndefined()
  return found?.ok as T
}

interface ModelRow {
  provider: string
  id: string
  name: string
}

interface ProviderRow {
  id: string
  name: string
  connected: boolean
  methods: Array<{ kind: string }>
}

interface Outcome {
  status: string
}

interface Scan {
  zai: Hit[]
  deepseek: Hit[]
}

const providersOf = (models: ModelRow[]): string[] => [...new Set(models.map((model) => model.provider))].sort()

function row(rows: ProviderRow[], id: string): ProviderRow {
  const found = rows.find((candidate) => candidate.id === id)
  expect(found, `provider ${id} is listed`).toBeDefined()
  return found as ProviderRow
}

test('test_c1_c4_c8_empty_store_keeps_only_deepseek_and_lists_the_twelve_routes_to_connect', { timeout: CHILD_TIMEOUT_MS + 30_000 }, async () => {
  const report = await runDriver('fresh')

  // c1: no sign-in saved, the catalogue is the deepseek route alone
  const models = value<ModelRow[]>(report, 'models')
  expect(models.length, 'deepseek models are advertised').toBeGreaterThan(0)
  expect(providersOf(models), 'no model of a pi-ai route without a sign-in').toEqual(['deepseek-official'])

  // c4: the providers that can be connected are exactly the twelve routes, none of them signed in yet
  const providers = value<ProviderRow[]>(report, 'providers')
  expect(providers.map((provider) => provider.id).sort()).toEqual([...PI_AI_ROUTES].sort())
  for (const provider of providers) {
    expect(typeof provider.name === 'string' && provider.name !== '', `${provider.id} has a name`).toBe(true)
    expect(provider.connected, `${provider.id} has no saved sign-in`).toBe(false)
    expect(provider.methods.length, `${provider.id} offers a sign-in method`).toBeGreaterThan(0)
  }
  expect(row(providers, 'openai-codex').methods.map((method) => method.kind), 'ChatGPT sign-in is OAuth').toContain('oauth')
  expect(row(providers, 'zai').methods.map((method) => method.kind), 'zai signs in by key').toContain('api-key')

  // c8: DEEPSEEK_API_KEY of the environment, the main session on the old model through deepseek-official
  expect(value<{ text: string }>(report, 'mainTurn').text).toBe(DEEPSEEK_REPLY)
  const calls = servers.deepseekSeen.filter((seen) => seen.body.stream !== false)
  expect(calls.length, 'main asked the deepseek route').toBeGreaterThan(0)
  for (const call of calls) {
    expect(call.body.model).toBe('deepseek-flash')
    expect(call.headers['x-api-key']).toBe(DEEPSEEK_KEY)
  }
  expect(servers.zaiSeen, 'nothing went to zai').toEqual([])
})

test('test_c2_c3_c5_c6_c7_c8_c9_key_sign_in_adds_zai_models_routes_a_role_and_logout_removes_them', { timeout: CHILD_TIMEOUT_MS + 30_000 }, async () => {
  const report = await runDriver('flow')

  // c5: an owner who refuses the prompt cancels the sign-in and nothing is saved
  expect(value<Outcome>(report, 'declineRejects').status, 'a rejected prompt').toBe('cancelled')
  expect(value<Outcome>(report, 'declineEmpty').status, 'an empty answer').toBe('cancelled')
  expect(row(value<ProviderRow[]>(report, 'providersDeclined'), 'zai').connected).toBe(false)
  expect(providersOf(value<ModelRow[]>(report, 'modelsDeclined')), 'a cancelled sign-in adds no models').toEqual(['deepseek-official'])
  expect(value<Scan>(report, 'scanDeclined').zai, 'no key reached the disk').toEqual([])

  // c5: the key answered to the secret prompt is saved
  expect(value<Outcome>(report, 'login').status).toBe('connected')
  expect(value<number>(report, 'asked'), 'the interaction was asked for the key').toBeGreaterThan(0)
  const connected = value<ProviderRow[]>(report, 'providersConnected')
  expect(row(connected, 'zai').connected, 'zai has a saved sign-in').toBe(true)
  expect(connected.filter((provider) => provider.connected).map((provider) => provider.id), 'only zai is signed in').toEqual(['zai'])

  // c2: the models of zai are in the catalogue, models of providers without a sign-in are not
  const models = value<ModelRow[]>(report, 'modelsConnected')
  expect(providersOf(models)).toEqual(['deepseek-official', 'zai'])
  expect(models.filter((model) => model.provider === 'zai').length, 'zai advertises models').toBeGreaterThan(0)
  expect(models.filter((model) => model.provider === 'deepseek-official').length, 'deepseek models stay').toBeGreaterThan(0)

  // c8: the main session still answers through deepseek-official, with the key of the environment
  expect(value<{ text: string }>(report, 'mainTurn').text).toBe(DEEPSEEK_REPLY)
  const deepseekCalls = servers.deepseekSeen.filter((seen) => seen.body.stream !== false)
  expect(deepseekCalls.length).toBeGreaterThan(0)
  for (const call of deepseekCalls) expect(call.headers['x-api-key']).toBe(DEEPSEEK_KEY)

  // c3: a role runner on a zai model goes to the zai route with the saved key
  expect(report.steps.roleTurn, 'a zai model was chosen for the role').toBeDefined()
  expect(value<{ text: string; aborted?: string }>(report, 'roleTurn').text).toBe(ZAI_REPLY)
  const zaiCalls = servers.zaiSeen.filter((seen) => seen.method === 'POST')
  expect(zaiCalls.length, 'the role asked the zai route').toBeGreaterThan(0)
  for (const call of zaiCalls) {
    expect(call.path, 'the Coding Plan address of the route').toMatch(/^\/api\/coding\/paas\/v4\//)
    expect(call.headers.authorization).toBe(`Bearer ${ZAI_KEY}`)
  }

  // the sign-in outlives the runner: a new runner on the same home sees it
  expect(row(value<ProviderRow[]>(report, 'providersRestarted'), 'zai').connected).toBe(true)
  expect(providersOf(value<ModelRow[]>(report, 'modelsRestarted'))).toEqual(['deepseek-official', 'zai'])

  // c7, c9: one file below the harness home holds the key, outside the workspace, readable by its owner alone
  const stored = value<Scan>(report, 'scanConnected')
  expect(stored.zai.length, 'the key is in exactly one file after the sign-in, the sessions and the turns').toBe(1)
  const file = stored.zai[0] as Hit
  expect(file.path.startsWith(`${join(scratch, 'state')}${sep}`), 'the store is below the harness home').toBe(true)
  expect(file.path.startsWith(`${join(scratch, 'workspace')}${sep}`), 'the store is outside the workspace').toBe(false)
  expect(file.mode.toString(8), 'the store is 0600').toBe('600')
  // c8: the key of the environment is never written to the store
  expect(stored.deepseek.map((hit) => hit.path), 'the deepseek key is not in the store').not.toContain(file.path)

  // c6: logout removes the record and the models of zai
  value<unknown>(report, 'disconnect')
  expect(row(value<ProviderRow[]>(report, 'providersDisconnected'), 'zai').connected).toBe(false)
  expect(providersOf(value<ModelRow[]>(report, 'modelsDisconnected')), 'zai models are gone').toEqual(['deepseek-official'])
  expect(value<Scan>(report, 'scanDisconnected').zai, 'the key is no longer on disk').toEqual([])
})
