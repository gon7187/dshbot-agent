// Public CLI contracts, using the same private HOME and subprocess fixture as
// openclaw-content.test.ts. Credentials are synthetic; no operator env is read.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 90_000
interface Item { kind: string; name: string; source: string; target: string; field?: string; status: string; reason?: string }
interface Reply { items: Item[]; report?: string }
interface Run { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
let root: string
let source: string
let home: string
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }
function config(value: unknown): void { json(join(source, 'openclaw.json'), value) }
function text(path: string): string {
  expect(existsSync(path), 'expected migration output file').toBe(true)
  return readFileSync(path, 'utf8')
}

function migrate(flags: string[]): Promise<Run> {
  const child = spawn('/bin/sh', ['-c', 'exec "$@"', 'openclaw-portability-test', cli,
    'openclaw', '--from', source, '--home', home,
    '--env-file', join(root, 'daemon-vars.conf'), '--json', ...flags], {
    cwd: repoRoot,
    env: {
      HOME: join(root, 'runtime-user'), USERPROFILE: join(root, 'runtime-user'), LANG: 'C.UTF-8',
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { stderr += error.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin?.end()
  })
}

function reply(run: Run): Reply {
  expect(run.signal, 'migration must finish without a signal or timeout').toBeNull()
  // Never attach raw CLI output to a failure: that output may contain a leak.
  expect(run.code, 'migration exit code').toBe(0)
  expect(run.stdout.trim().startsWith('{'), 'CLI must return a JSON plan').toBe(true)
  const result = JSON.parse(run.stdout) as Reply
  expect(Array.isArray(result.items), 'JSON plan must contain items').toBe(true)
  return result
}

function noLeaks(run: Run, values: string[], reportText = ''): void {
  for (const value of values) {
    for (const surface of [run.stdout, run.stderr, reportText]) {
      const escaped = JSON.stringify(value).slice(1, -1)
      expect(surface.includes(value) || surface.includes(escaped), 'secret must not appear in plan, stderr or report').toBe(false)
    }
  }
}

function reportText(result: Reply): string {
  expect(typeof result.report, 'applied migration must create a report').toBe('string')
  return text(result.report!)
}

function secretForField(result: Reply, field: string): string {
  const entry = result.items.find((item) => item.kind === 'secret' &&
    (item.field === field || item.source.includes(field)) && item.status === 'applied')
  expect(entry, `field ${field} must reach the vault`).toBeDefined()
  return text(join(home, 'secrets', entry!.name))
}

function writeJobs(jobs: { id: string; payload: Record<string, string> }[]): void {
  json(join(source, 'cron', 'jobs.json'), { jobs: jobs.map((job) => ({
    ...job, name: job.id, enabled: true, agentId: 'main',
    schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' },
  })) })
}

function tasks(): string[] {
  const path = join(home, 'state.db')
  expect(existsSync(path), 'ordinary source jobs must create the destination database').toBe(true)
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('SELECT task FROM schedules ORDER BY task').all() as { task: string }[]
    return rows.map((row) => row.task)
  } finally { db.close() }
}

function skillDocument(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Imported reference\n---\n\n${body}\n`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-openclaw-portability-'))
  source = join(root, 'openclaw-owner', '.openclaw')
  home = join(root, 'destination')
  for (const dir of [source, home, join(root, 'runtime-user')]) mkdirSync(dir, { recursive: true })
  config({})
})

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  }))
  children.clear()
  rmSync(root, { recursive: true, force: true })
})

test('test_c1_expands_dotenv_inside_mcp_authorization_and_keeps_plan_and_report_secret_free', { timeout: TIMEOUT }, async () => {
  const token = 'fixture-homeassistant-token-R8k4Q2'
  // Only create this fixture; neither helpers nor assertions open any .env file.
  put(join(source, '.env'), `HA_TOKEN=${token}\n`)
  config({ mcp: { servers: { homeassistant: {
    url: 'https://homeassistant.invalid/mcp', transport: 'streamable-http',
    headers: { Authorization: 'Bearer ${HA_TOKEN}' },
  } } } })

  const dry = await migrate(['--dry-run', '--include-secrets'])
  reply(dry)
  noLeaks(dry, [token])
  const applied = await migrate(['--yes', '--include-secrets'])
  const result = reply(applied)
  noLeaks(applied, [token], reportText(result))
  const stored = secretForField(result, 'mcp.servers.homeassistant.headers.Authorization')
  expect(stored === `Bearer ${token}`, 'vault must contain the complete expanded Authorization value').toBe(true)

  const mcp = JSON.parse(text(join(home, 'mcp.json'))) as { mcpServers: { homeassistant: { headers: { Authorization: string } } } }
  const reference = /^\$\{secret:([^}]+)\}$/.exec(mcp.mcpServers.homeassistant.headers.Authorization)
  expect(reference, 'MCP header must reference a vault entry').not.toBeNull()
  expect(text(join(home, 'secrets', reference![1])) === stored, 'MCP must use the expanded header secret').toBe(true)
})

test('test_c2_expands_plugin_and_env_values_from_openclaw_config_env', { timeout: TIMEOUT }, async () => {
  const token = 'fixture-workshop-token-K6m3V9'
  config({
    env: { vars: { WB_API_TOKEN: token, WB_ALIAS_TOKEN: '${WB_API_TOKEN}' } },
    plugins: { entries: { workshop: { config: { apiToken: '${WB_API_TOKEN}' } } } },
  })
  const run = await migrate(['--yes', '--include-secrets'])
  const result = reply(run)
  noLeaks(run, [token], reportText(result))
  expect(secretForField(result, 'plugins.entries.workshop.config.apiToken') === token,
    'plugin secret must be expanded using config env.vars').toBe(true)
  expect(text(join(home, 'secrets', 'WB_ALIAS_TOKEN')) === token,
    'env alias must contain the variable value instead of a placeholder').toBe(true)
})

test('test_c3_warns_about_an_unknown_variable_with_its_name_and_config_field', { timeout: TIMEOUT }, async () => {
  config({ mcp: { servers: { missingvariable: {
    url: 'https://missingvariable.invalid/mcp',
    headers: { Authorization: 'Bearer ${NO_SUCH_VAR}' },
  } } } })
  const result = reply(await migrate(['--dry-run', '--include-secrets']))
  const warning = result.items.find((item) => item.status === 'warning' &&
    JSON.stringify(item).includes('NO_SUCH_VAR') &&
    JSON.stringify(item).includes('missingvariable') &&
    JSON.stringify(item).includes('Authorization'))
  expect(warning, 'unknown variable warning must identify NO_SUCH_VAR and its affected field').toBeDefined()
})

test.each([false, true])('test_c4_rewrites_workshop_and_workspace_skill_paths_in_schedules_collision_%s', { timeout: TIMEOUT }, async (collision) => {
  const name = 'portable-workshop'
  const workshopPath = join(source, 'agents', 'main', 'agent', 'workshop-skills', name, 'SKILL.md')
  const workspacePath = join(source, 'workspace', 'skills', 'portable-workspace', 'SKILL.md')
  const workshopBody = 'Imported workshop procedure.'
  const workspaceBody = 'Imported workspace procedure.'
  put(workshopPath, skillDocument(name, workshopBody))
  put(workspacePath, skillDocument('portable-workspace', workspaceBody))
  if (collision) {
    put(join(home, 'skills', name, 'SKILL.md'), skillDocument(name,
      '## Procedure\nOwner procedure.\n\n## Pitfalls\nKeep it.\n\n## Verification\nRead it.'))
  }
  const prompt = `Read "${workshopPath}".\nThen read ${workspacePath} and prepare a report.`
  writeJobs([{ id: 'portable-skill-report', payload: { kind: 'agentTurn', message: prompt } }])
  const result = reply(await migrate(['--yes', '--skill-conflict', 'rename']))
  expect(result.items.some((item) => item.kind === 'schedule' && item.name === 'portable-skill-report' && item.status === 'applied')).toBe(true)

  const skillFiles = readdirSync(join(home, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(home, 'skills', entry.name, 'SKILL.md')))
    .map((entry) => join(home, 'skills', entry.name, 'SKILL.md'))
  const workshopTarget = skillFiles.find((path) => text(path).includes(workshopBody))
  const workspaceTarget = skillFiles.find((path) => text(path).includes(workspaceBody))
  expect(workshopTarget, 'workshop skill must actually be imported').toBeDefined()
  expect(workspaceTarget, 'workspace skill must actually be imported').toBeDefined()
  if (collision) expect(workshopTarget).not.toBe(join(home, 'skills', name, 'SKILL.md'))
  else expect(workshopTarget).toBe(join(home, 'skills', name, 'SKILL.md'))
  const saved = tasks()
  expect(saved).toEqual([prompt.replace(workshopPath, workshopTarget!).replace(workspacePath, workspaceTarget!)])
  expect(saved[0]).not.toContain(source)
})

test.each(['agentTurn', 'systemEvent'])('test_c5_skips_internal_openclaw_jobs_with_a_reason_payload_%s', { timeout: TIMEOUT }, async (kind) => {
  const marker = '__openclaw_memory_core_short_term_promotion_dream__'
  const internalJobs = [
    { id: 'internal-memory-promotion', marker },
    { id: 'internal-maintenance', marker: '__openclaw_fixture_internal_maintenance__' },
  ]
  const ordinary = `Explain the meaning of ${marker} to the owner.`
  const payload = (value: string): Record<string, string> => kind === 'agentTurn'
    ? { kind, message: value } : { kind, text: value }
  writeJobs([
    ...internalJobs.map((job) => ({ id: job.id, payload: payload(job.marker) })),
    { id: 'ordinary-marker-explanation', payload: payload(ordinary) },
  ])
  const dry = reply(await migrate(['--dry-run']))
  // Check database behavior as well as the plan; the ordinary job ensures the
  // importer and schedules table are exercised even when the marker is skipped.
  reply(await migrate(['--yes']))
  expect(tasks(), 'internal markers must never become scheduled model prompts').toEqual([ordinary])
  for (const job of internalJobs) {
    const skipped = dry.items.find((item) => item.kind === 'schedule' && item.name === job.id)
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.reason).toMatch(/openclaw/i)
    expect(skipped?.reason).toMatch(/служеб|внутрен|internal|service|maintenance/i)
  }
})

// Root bypasses Unix directory permissions. Match the existing permission-test
// convention in scratchpad-daemon.test.ts instead of asserting a false EACCES.
test.skipIf(process.getuid?.() === 0)('test_c6_warns_with_server_name_and_inaccessible_command_path', { timeout: TIMEOUT }, async () => {
  const locked = join(root, 'private-openclaw-runtime')
  const command = join(locked, 'bin', 'mcp-launcher')
  put(command, '#!/bin/sh\nexit 0\n')
  chmodSync(command, 0o755)
  config({ mcp: { servers: { privateworkshop: { command, args: [] } } } })
  chmodSync(locked, 0o000)
  try {
    expect(() => readdirSync(locked), 'fixture directory must really be inaccessible').toThrow()
    const result = reply(await migrate(['--dry-run']))
    const warning = result.items.find((item) => item.status === 'warning' &&
      JSON.stringify(item).includes('privateworkshop') && JSON.stringify(item).includes(command))
    expect(warning, 'plan must warn with the server name and inaccessible executable path').toBeDefined()
  } finally { chmodSync(locked, 0o700) }
})
