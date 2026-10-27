// Per-server tool policy of mcp.json (include, exclude, enabled) at the seam of the MCP client: no daemon, a
// real stdio MCP server written next to the test. The server writes its pid and environment to launches.jsonl at
// every start, so the test sees whether a process was started and whether it is still alive. The daemon side of
// the same fields (the confirmation card, /mcp, the reload command) is in mcp-tool-policy-daemon.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createMcpTools, readMcpConfig, type McpSecretSource, type McpTools } from '../tools-mcp/src/index.js'

const SERVER = 'testsrv'
const name = (tool: string): string => `mcp__${SERVER}__${tool}`
const ALL_TOOLS = ['configure', 'echo', 'leak', 'list_items', 'price_set', 'stock_set', 'wipe']

const ENV_TOKEN = 'tok-lqzx'
const VAULT_VALUE = 'vaultval-77'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A stdio MCP server in plain Node. Argument: the data directory. Seven tools; `configure` has an enum and a
 * default that look like the values of env, `leak` answers with an error that quotes the env of the process.
 */
const FIXTURE_SERVER = `
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.argv[2]
appendFileSync(join(dir, 'launches.jsonl'), JSON.stringify({ pid: process.pid }) + '\\n')

const plain = { type: 'object', properties: {} }
const tools = [
  { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'list_items', description: 'Lists the items of the shop.', inputSchema: plain },
  { name: 'price_set', description: 'Sets the price of an item.', inputSchema: { type: 'object', properties: { nm_id: { type: 'string' }, price: { type: 'number' } } } },
  { name: 'stock_set', description: 'Sets the stock of an item.', inputSchema: plain },
  { name: 'wipe', description: 'Wipes the shop.', inputSchema: plain, annotations: { destructiveHint: true } },
  { name: 'leak', description: 'Always fails and quotes its settings.', inputSchema: plain },
  {
    name: 'configure',
    description: 'Switch the mode: on or off. Debug level 1. Key=' + (process.env.API_KEY || ''),
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['on', 'off'], default: '1', description: 'Mode: on or off' } },
    },
  },
]

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = request
  if (id === undefined) return
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'testsrv', version: '1.0.0' } } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else if (method === 'tools/list') {
    send({ id, result: { tools } })
  } else if (method === 'tools/call') {
    if (params.name === 'leak') {
      send({ id, result: { isError: true, content: [{ type: 'text', text: 'denied: mode=' + process.env.MODE + ' token=' + process.env.TESTSRV_TOKEN }] } })
    } else {
      send({ id, result: { content: [{ type: 'text', text: 'ok ' + params.name }] } })
    }
  } else {
    send({ id, error: { code: -32601, message: 'method not found: ' + method } })
  }
})
`

let scratch: string
let serverFile: string
const running: McpTools[] = []

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-mcp-policy-')))
  serverFile = join(scratch, 'server.mjs')
  writeFileSync(serverFile, FIXTURE_SERVER)
})

afterAll(async () => {
  for (const mcp of running) await mcp.stop()
  rmSync(scratch, { recursive: true, force: true })
})

interface Fixture {
  home: string
  dataDir: string
}

/** A fresh DSHBOT_HOME with a data directory for the server `dir`. */
function fixture(dir = 'data'): Fixture {
  const home = mkdtempSync(join(scratch, 'home-'))
  const dataDir = join(home, dir)
  mkdirSync(dataDir, { recursive: true })
  return { home, dataDir }
}

function serverEntry(dataDir: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [serverFile, dataDir], ...extra }
}

function writeMcpJson(home: string, servers: Record<string, unknown>): void {
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2))
}

async function start(home: string, options: { secrets?: McpSecretSource; log?: (line: string) => void } = {}): Promise<McpTools> {
  const mcp = createMcpTools({ home, ...options })
  running.push(mcp)
  await mcp.ready()
  return mcp
}

const toolNames = (mcp: McpTools): string[] => mcp.tools().map((tool) => tool.name).sort()

const expected = (...tools: string[]): string[] => tools.map(name).sort()

function pids(dataDir: string): number[] {
  const file = join(dataDir, 'launches.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => Number((JSON.parse(line) as { pid: number }).pid))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(what: string, cond: () => boolean): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < 15_000) await sleep(40)
  expect(cond(), `timed out waiting for: ${what}`).toBe(true)
}

// --- [c2] ------------------------------------------------------------------------------------------------

test('test_c2_exclude_hides_the_listed_tools_and_include_is_applied_before_exclude', async () => {
  const cases: Array<{ policy: Record<string, unknown>; tools: string[]; why: string }> = [
    { policy: {}, tools: ALL_TOOLS, why: 'the control: no policy, every tool' },
    {
      policy: { exclude: ['price_set', 'stock_set', 'wipe'] },
      tools: ['configure', 'echo', 'leak', 'list_items'],
      why: 'exclude alone hides the listed tools and nothing else',
    },
    {
      policy: { include: ['echo', 'price_set', 'list_items'], exclude: ['price_set'] },
      tools: ['echo', 'list_items'],
      why: 'include first, then exclude takes price_set out of what include left',
    },
    {
      policy: { include: ['echo'], exclude: ['list_items'] },
      tools: ['echo'],
      why: 'an exclude outside of include changes nothing',
    },
    { policy: { include: ['echo'], exclude: ['echo'] }, tools: [], why: 'a tool in both lists is hidden' },
    { policy: { include: ['echo', 'wipe'] }, tools: ['echo', 'wipe'], why: 'include alone shows only the listed tools' },
  ]
  for (const item of cases) {
    const { home, dataDir } = fixture()
    writeMcpJson(home, { [SERVER]: serverEntry(dataDir, item.policy) })
    const mcp = await start(home)
    expect(toolNames(mcp), item.why).toEqual(expected(...item.tools))
    await mcp.stop()
  }
})

// --- [c3] ------------------------------------------------------------------------------------------------

test('test_c3_disabled_server_is_not_started_has_no_tools_and_is_not_an_error', async () => {
  const { home, dataDir } = fixture('live')
  const offDir = join(home, 'off')
  mkdirSync(offDir, { recursive: true })
  writeMcpJson(home, {
    [SERVER]: serverEntry(dataDir),
    offsrv: serverEntry(offDir, { enabled: false }),
  })
  expect(readMcpConfig(home).problems, 'enabled: false is a valid file').toEqual([])

  const mcp = await start(home)
  await sleep(1_000)
  expect(pids(dataDir), 'the control: the enabled server was started').toHaveLength(1)
  expect(existsSync(join(offDir, 'launches.jsonl')), 'a disabled server is never launched').toBe(false)
  expect(
    mcp.tools().filter((tool) => tool.name.startsWith('mcp__offsrv__')),
    'a disabled server has no tools',
  ).toEqual([])
  expect(
    mcp.status().filter((state) => state.name === 'offsrv' && state.state === 'failed'),
    'a disabled server is not reported as failed',
  ).toEqual([])
  expect(
    mcp.problems().filter((problem) => problem.name.startsWith('offsrv')),
    'a disabled server is not a problem of the file',
  ).toEqual([])
})

// --- [c5] ------------------------------------------------------------------------------------------------

test('test_c5_reload_applies_include_exclude_and_enabled_and_a_disabled_server_is_stopped', async () => {
  const { home, dataDir } = fixture()
  writeMcpJson(home, { [SERVER]: serverEntry(dataDir) })
  const mcp = await start(home)
  expect(toolNames(mcp), 'the control: every tool before the change').toEqual(expected(...ALL_TOOLS))
  const first = pids(dataDir)
  expect(first, 'the server runs').toHaveLength(1)
  expect(alive(first[0] as number)).toBe(true)

  writeMcpJson(home, { [SERVER]: serverEntry(dataDir, { include: ['echo', 'price_set', 'list_items'] }) })
  const included = await mcp.reload()
  expect(included.ok, JSON.stringify(included)).toBe(true)
  expect(toolNames(mcp), 'include applies at the reload').toEqual(expected('echo', 'price_set', 'list_items'))

  writeMcpJson(home, { [SERVER]: serverEntry(dataDir, { include: ['echo', 'price_set', 'list_items'], exclude: ['price_set'] }) })
  await mcp.reload()
  expect(toolNames(mcp), 'exclude applies at the reload').toEqual(expected('echo', 'list_items'))

  writeMcpJson(home, { [SERVER]: serverEntry(dataDir) })
  await mcp.reload()
  expect(toolNames(mcp), 'removing the fields shows every tool again').toEqual(expected(...ALL_TOOLS))

  writeMcpJson(home, { [SERVER]: serverEntry(dataDir, { enabled: false }) })
  const disabled = await mcp.reload()
  expect(disabled.ok, JSON.stringify(disabled)).toBe(true)
  expect(toolNames(mcp), 'a server switched off has no tools').toEqual([])
  await waitUntil('every process of the switched off server to end', () => pids(dataDir).every((pid) => !alive(pid)))
  expect(
    mcp.status().filter((state) => state.name === SERVER && state.state === 'failed'),
    'switching off is not a failure',
  ).toEqual([])

  const launched = pids(dataDir).length
  writeMcpJson(home, { [SERVER]: serverEntry(dataDir, { enabled: true }) })
  await mcp.reload()
  expect(pids(dataDir).length, 'enabled: true starts the server again').toBeGreaterThan(launched)
  expect(toolNames(mcp), 'its tools are back').toEqual(expected(...ALL_TOOLS))
})

// --- [c6] ------------------------------------------------------------------------------------------------

test('test_c6_wrong_type_of_a_policy_field_is_a_config_problem_with_the_field_name_and_the_server_is_not_started', async () => {
  const wrong: Array<{ id: string; field: string; value: unknown }> = [
    { id: 'inc_string', field: 'include', value: 'echo' },
    { id: 'inc_numbers', field: 'include', value: [1, 2] },
    { id: 'exc_object', field: 'exclude', value: { echo: true } },
    { id: 'exc_mixed', field: 'exclude', value: ['echo', null] },
    { id: 'con_string', field: 'confirm', value: 'price_set' },
    { id: 'con_number', field: 'confirm', value: [7] },
    { id: 'ena_string', field: 'enabled', value: 'false' },
    { id: 'ena_number', field: 'enabled', value: 0 },
  ]
  const { home, dataDir } = fixture('good')
  const servers: Record<string, unknown> = { [SERVER]: serverEntry(dataDir) }
  for (const item of wrong) {
    const dir = join(home, item.id)
    mkdirSync(dir, { recursive: true })
    servers[item.id] = serverEntry(dir, { [item.field]: item.value })
  }
  writeMcpJson(home, servers)

  const config = readMcpConfig(home)
  expect(config.servers.map((server) => server.name), 'only the healthy server is accepted').toEqual([SERVER])
  for (const item of wrong) {
    const problem = config.problems.find((candidate) => candidate.name === item.id)
    expect(problem, `${item.id}: the wrong type of "${item.field}" is a problem of the entry`).toBeDefined()
    expect(problem?.message, `${item.id}: the message names the field`).toContain(item.field)
  }

  const mcp = await start(home)
  await sleep(1_000)
  expect(toolNames(mcp), 'the healthy server is not affected by the broken ones').toEqual(expected(...ALL_TOOLS))
  for (const item of wrong) {
    expect(existsSync(join(home, item.id, 'launches.jsonl')), `${item.id}: a server with a wrong field is not started`).toBe(false)
  }
})

// --- [c8] ------------------------------------------------------------------------------------------------

test('test_c8_schema_is_masked_by_the_values_of_the_vault_only_while_errors_mask_every_value_of_env', async () => {
  const { home, dataDir } = fixture()
  writeMcpJson(home, {
    [SERVER]: serverEntry(dataDir, {
      env: { DEBUG: '1', MODE: 'on', TESTSRV_TOKEN: ENV_TOKEN, API_KEY: '${secret:API}' },
    }),
  })
  const secrets: McpSecretSource = {
    resolve: (text) => ({ text: text.split('${secret:API}').join(VAULT_VALUE), missing: [] }),
    known: () => [{ name: 'API', value: VAULT_VALUE }],
  }
  const journal: string[] = []
  const mcp = await start(home, { secrets, log: (line) => journal.push(line) })

  const configure = mcp.tools().find((tool) => tool.name === name('configure'))
  expect(configure, `the tool configure is published: ${toolNames(mcp).join(', ')}`).toBeDefined()
  const mode = ((configure?.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>).mode ?? {}
  expect(mode.enum, 'enum [on, off] reaches the model as it is, MODE=on is no secret of the vault').toEqual(['on', 'off'])
  expect(mode.default, 'default "1" reaches the model as it is, DEBUG=1 is no secret of the vault').toBe('1')
  expect(mode.description, 'the description of a property is not touched').toBe('Mode: on or off')
  expect(configure?.description, 'words of the description stay').toContain('on or off')
  expect(configure?.description, 'digits of the description stay').toContain('level 1')
  expect(configure?.description, 'the value of the vault is masked').not.toContain(VAULT_VALUE)
  expect(configure?.description, 'the rest of that line stays').toContain('Key=')

  // errors of the server and the journal still hide every value of env
  const leak = mcp.tools().find((tool) => tool.name === name('leak'))
  expect(leak).toBeDefined()
  let message = ''
  try {
    await leak?.execute({})
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message.trim().length, 'the call of leak is an error').toBeGreaterThan(0)
  expect(message, 'the token of env is masked in the error').not.toContain(ENV_TOKEN)
  expect(message, 'a short value of env is masked in the error too').not.toContain('mode=on')
  expect(journal.join('\n'), 'the journal never quotes a value of env').not.toContain(ENV_TOKEN)
  expect(journal.join('\n')).not.toContain(VAULT_VALUE)
})
