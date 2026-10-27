// tool_search on a missed query: the closest tools (most shared words) are enabled in the same call, words match
// regardless of their endings, an exact query keeps its old strict behaviour. A real runner runs in a child process
// against a local DeepSeek stub whose model calls tool_search once per configured query inside a single turn; what
// the model was told and which tools it was offered are read from the requests the stub received.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@LAZY-CLOSEST@@'
const SEARCH_TRIGGER = 'SEARCH_NOW'

type Body = Record<string, unknown>

interface ToolSpec {
  name: string
  description: string
  lazy: boolean
  optIn?: boolean
}

interface Stub {
  server: Server
  origin: string
  models: Body[]
  /** The n-th model call of the search turn answers with a tool_search for queries[n], then with text. */
  queries: string[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamOf(block: Body, deltas: Body[], stopReason: string): string {
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
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: block }),
    ...deltas.map((delta) => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta })),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function asRecord(value: unknown): Body | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Body) : undefined
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block === 'string') return block
      const text = asRecord(block)?.text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function messagesOf(body: Body): Body[] {
  return Array.isArray(body.messages) ? body.messages.map((message) => asRecord(message) ?? {}) : []
}

function toolResultsOf(body: Body): string[] {
  const results: string[] = []
  for (const message of messagesOf(body)) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      const record = asRecord(block)
      if (record?.type === 'tool_result') results.push(blockText(record.content))
    }
  }
  return results
}

function lastIsToolResult(body: Body): boolean {
  const last = messagesOf(body).at(-1)
  return Array.isArray(last?.content) && last.content.some((block) => asRecord(block)?.type === 'tool_result')
}

function lastUserText(body: Body): string {
  const last = messagesOf(body).at(-1)
  return last?.role === 'user' ? blockText(last.content) : ''
}

function toolNames(body: Body): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.map((tool) => String(asRecord(tool)?.name))
}

async function startStub(): Promise<Stub> {
  const stub: Stub = { server: createServer(), origin: '', models: [], queries: [] }
  let ids = 0
  stub.server.on('request', (req, res) => {
    void readBody(req).then((raw) => {
      let body: Body = {}
      try {
        body = JSON.parse(raw) as Body
      } catch {
        body = {}
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [{ type: 'text', text: 'готово' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 },
          }),
        )
        return
      }
      stub.models.push(body)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const step = lastIsToolResult(body) ? toolResultsOf(body).length : lastUserText(body).includes(SEARCH_TRIGGER) ? 0 : -1
      const query = step >= 0 ? stub.queries[step] : undefined
      if (query === undefined) {
        res.end(streamOf({ type: 'text', text: '' }, [{ type: 'text_delta', text: 'готово' }], 'end_turn'))
        return
      }
      ids += 1
      res.end(
        streamOf(
          { type: 'tool_use', id: `toolu_stub_${ids}`, name: 'tool_search', input: {} },
          [{ type: 'input_json_delta', partial_json: JSON.stringify({ query }) }],
          'tool_use',
        ),
      )
    })
  })
  await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve))
  stub.origin = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

// --- child process driver ------------------------------------------------------------------------

const HOOKS_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\/.*\\.js$/.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

const REGISTER_SOURCE = `
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
try {
  const { startRunner } = await import(cfg.entry)
  const tools = cfg.tools.map((spec) => ({
    name: spec.name,
    description: spec.description,
    ...(spec.lazy ? { lazy: true } : {}),
    ...(spec.optIn ? { optIn: true } : {}),
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    execute: async () => 'EXEC:' + spec.name,
  }))
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT, префикс №1',
    model: cfg.model,
    tools,
  })
  for (const text of cfg.turns) await runner.prompt(text)
  await runner.stop()
  report({})
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface ChildRun {
  report: { error?: string } | undefined
  output: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-lazy-closest-test-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  stub = await startStub()
  tmpHome = mkdtempSync(join(scratch, 'home-'))
  dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  workDir = mkdtempSync(join(scratch, 'cwd-'))
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    stub.server.closeAllConnections()
    stub.server.close(() => resolve())
  })
})

function runChild(model: string, tools: ToolSpec[], turns: string[]): Promise<ChildRun> {
  const cfg = { entry: runnerEntry, dshHome, cwd: workDir, baseUrl: `${stub.origin}/anthropic`, model, tools, turns }
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = ['--import', pathToFileURL(join(scratch, 'register.mjs')).href, join(scratch, 'driver.mjs'), JSON.stringify(cfg)]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS - 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK))
      const report = line ? (JSON.parse(line.slice(RESULT_MARK.length)) as { error?: string }) : undefined
      resolve({ report, output: `${stdout}\n${stderr}`.slice(-4000) })
    })
  })
}

function expectCleanRun(run: ChildRun): void {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
}

const core = (name: string): ToolSpec => ({ name, description: `Основной инструмент ${name}`, lazy: false })
const lazy = (name: string, description: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name,
  description,
  lazy: true,
  ...extra,
})

/** What tool_search answered to each query of the turn, in order. */
function searchAnswers(run: ChildRun): string[] {
  const answered = stub.models.filter((body) => lastIsToolResult(body))
  expect(answered.length, run.output).toBe(stub.queries.length)
  return toolResultsOf(answered.at(-1) as Body)
}

/** The request that follows the n-th (1-based) tool_search answer of the turn. */
function requestAfterAnswer(count: number): Body | undefined {
  return stub.models.find((body) => lastIsToolResult(body) && toolResultsOf(body).length === count)
}

const HASS_TURN_ON = 'mcp__homeassistant__intent__HassTurnOn'
const HASS_LIGHT_SET = 'mcp__homeassistant__light__HassLightSet'
const HOME_ASSISTANT = [
  core('alpha_core'),
  lazy(HASS_TURN_ON, 'Turns on a device or entity, for example a light'),
  lazy(HASS_LIGHT_SET, 'Sets brightness or color of a light'),
  lazy('weather_now', 'Текущая погода'),
]

test(
  'test_c1_c7_missed_query_enables_the_closest_tool_in_the_same_call_and_only_allowed_ones',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    // c1: no tool holds all six words; HassTurnOn shares the most. c7: opt_ledger_export is an `optIn` tool that main
    // may not load, plain_ledger_export has the same words and is loaded.
    stub.queries = ['homeassistant light turn on kitchen кухня', 'ledger export quarterly']
    const run = await runChild(
      'deepseek-flash',
      [
        ...HOME_ASSISTANT,
        lazy('opt_ledger_export', 'Ledger export', { optIn: true }),
        lazy('plain_ledger_export', 'Ledger export'),
      ],
      [`${SEARCH_TRIGGER} найди инструмент`],
    )
    expectCleanRun(run)

    const [first, second] = searchAnswers(run)
    expect(first).toMatch(/Подключены[^.]*HassTurnOn/)
    expect(first).not.toContain('HassLightSet')
    expect(first).not.toContain('weather_now')
    expect(first).not.toContain('Ничего не найдено')
    // available to the model on the very next step, without another tool_search
    const next = requestAfterAnswer(1)
    expect(next, run.output).toBeDefined()
    expect(toolNames(next as Body)).toContain(HASS_TURN_ON)
    expect(toolNames(next as Body)).not.toContain(HASS_LIGHT_SET)

    expect(second).toMatch(/Подключены[^.]*plain_ledger_export/)
    expect(second).not.toContain('opt_ledger_export')
    const names = toolNames(stub.models.at(-1) as Body)
    expect(names).toContain(HASS_TURN_ON)
    expect(names).toContain('plain_ledger_export')
    for (const absent of [HASS_LIGHT_SET, 'weather_now', 'opt_ledger_export']) expect(names).not.toContain(absent)
  },
)

test('test_c2_words_match_across_endings_but_not_across_different_words', { timeout: CHILD_TIMEOUT_MS }, async () => {
  stub.queries = ['кампании статистика', 'campaigns', 'погода']
  const run = await runChild(
    'deepseek-flash',
    [
      core('alpha_core'),
      lazy('stats_tool', 'Статистика рекламных кампаний за период'),
      lazy('wb_get_campaign_stats', 'Returns advertising totals'),
      lazy('warehouse_load', 'Погрузка товара на склад'),
    ],
    [`${SEARCH_TRIGGER} найди инструмент`],
  )
  expectCleanRun(run)

  const [russian, english, different] = searchAnswers(run)
  expect(russian).toContain('Подключены')
  expect(russian).toContain('stats_tool')
  expect(english).toContain('Подключены')
  expect(english).toContain('wb_get_campaign_stats')
  expect(different).toContain('Ничего не найдено')
  expect(different).not.toContain('Подключены')

  const afterRussian = requestAfterAnswer(1)
  expect(afterRussian, run.output).toBeDefined()
  expect(toolNames(afterRussian as Body)).toContain('stats_tool')
  const names = toolNames(stub.models.at(-1) as Body)
  expect(names).toContain('stats_tool')
  expect(names).toContain('wb_get_campaign_stats')
  expect(names).not.toContain('warehouse_load')
})

test(
  'test_c3_c4_c5_c6_exact_query_stays_strict_and_weak_or_empty_overlap_enables_nothing',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    const fillers = Array.from({ length: 39 }, (_, index) =>
      lazy(`mcp__testsrv__filler_${index + 1}`, `Filler tool number ${index + 1}`),
    )
    const ties = 'abcdefg'.split('').map((letter) => lazy(`tie_${letter}`, 'report daily spend'))
    stub.queries = [
      'mcp__testsrv__filler_39', // c3: exact
      'delegate subagent', // c3: exact, the partial match subagent_log stays out
      'погода на завтра', // c4: no shared word
      'mcp__shadow__echo', // c4: unknown server
      'wb кампании бюджет', // c5: best tool shares one word only
      'report spend weekly', // c6: seven tools tie, five are enabled
    ]
    const run = await runChild(
      'deepseek-flash',
      [
        core('alpha_core'),
        ...fillers,
        lazy('delegate', 'Delegate a task to a subagent'),
        lazy('subagent_log', 'Reads the subagent log'),
        lazy('wb_orders', 'Wildberries orders list'),
        ...ties,
      ],
      [`${SEARCH_TRIGGER} найди инструмент`],
    )
    expectCleanRun(run)

    const [filler, delegate, weather, shadow, budget, tie] = searchAnswers(run)
    expect(filler).toContain('mcp__testsrv__filler_39')
    expect(filler).not.toMatch(/filler_(?!39\b)\d/)
    expect(delegate).toContain('delegate')
    expect(delegate).not.toContain('subagent_log')
    for (const answer of [weather, shadow]) {
      expect(answer).toContain('Ничего не найдено по запросу')
      expect(answer).not.toContain('Подключены')
    }
    expect(budget).toContain('Ничего не найдено')
    expect(budget).not.toContain('Подключены')
    expect(budget).toContain('wb_orders')
    for (const letter of 'abcde') expect(tie).toContain(`tie_${letter}`)
    for (const letter of 'fg') expect(tie).not.toContain(`tie_${letter}`)

    const names = toolNames(stub.models.at(-1) as Body)
    const enabled = names.filter((name) => name !== 'alpha_core' && name !== 'tool_search').sort()
    expect(enabled).toEqual(['delegate', 'mcp__testsrv__filler_39', 'tie_a', 'tie_b', 'tie_c', 'tie_d', 'tie_e'])
  },
)

test(
  'test_c8_closest_tool_on_a_leading_only_route_waits_for_the_next_session',
  { timeout: CHILD_TIMEOUT_MS * 2 },
  async () => {
    stub.queries = ['homeassistant light turn on kitchen кухня']
    const first = await runChild('deepseek-v4-pro', HOME_ASSISTANT, [`${SEARCH_TRIGGER} найди инструмент`])
    expectCleanRun(first)

    const [answer] = searchAnswers(first)
    expect(answer).toMatch(/следующ\S*\s+сесс/i)
    expect(answer).toContain('HassTurnOn')
    // no request of this session declares the tool
    for (const body of stub.models) expect(toolNames(body)).not.toContain(HASS_TURN_ON)

    const seen = stub.models.length
    stub.queries = []
    const second = await runChild('deepseek-v4-pro', HOME_ASSISTANT, ['после перезапуска'])
    expectCleanRun(second)

    const resumed = stub.models.slice(seen).find((body) => lastUserText(body).includes('после перезапуска'))
    expect(resumed, second.output).toBeDefined()
    const names = toolNames(resumed as Body)
    expect(names).toContain(HASS_TURN_ON)
    expect(names).not.toContain(HASS_LIGHT_SET)
    expect(names).not.toContain('weather_now')
  },
)

test(
  'test_h1_english_words_ending_in_e_match_their_plural_and_short_words_keep_their_form',
  { timeout: CHILD_TIMEOUT_MS },
  async () => {
    // h1: message/messages, update/updates, file/files meet in both directions; "the" and "one" are not cut to
    // "th" and "on", so they never meet the unrelated words "th" and "on".
    stub.queries = [
      'write files',
      'edit messages',
      'apply updates',
      'bulk update file message',
      'one switch',
      'the marker',
    ]
    const run = await runChild(
      'deepseek-flash',
      [
        core('alpha_core'),
        lazy('file_writer', 'Write a file'),
        lazy('message_editor', 'Edit a sent message'),
        lazy('update_applier', 'Apply an update'),
        lazy('bulk_changer', 'Changes files, messages and updates in bulk'),
        lazy('power_switch', 'Switch on'),
        lazy('ordinal_marker', 'Marker th'),
      ],
      [`${SEARCH_TRIGGER} найди инструмент`],
    )
    expectCleanRun(run)

    const [files, messages, updates, reverse, one, the] = searchAnswers(run)
    expect(files).toMatch(/Подключены[^.]*file_writer/)
    expect(messages).toMatch(/Подключены[^.]*message_editor/)
    expect(updates).toMatch(/Подключены[^.]*update_applier/)
    expect(reverse).toMatch(/Подключены[^.]*bulk_changer/)
    for (const answer of [one, the]) {
      expect(answer).toContain('Ничего не найдено')
      expect(answer).not.toContain('Подключены')
    }

    const names = toolNames(stub.models.at(-1) as Body)
    for (const present of ['file_writer', 'message_editor', 'update_applier', 'bulk_changer']) {
      expect(names).toContain(present)
    }
    for (const absent of ['power_switch', 'ordinal_marker']) expect(names).not.toContain(absent)
  },
)
