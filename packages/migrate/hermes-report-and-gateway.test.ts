// Uses the private-HOME CLI harness from hermes-edge.test.ts and the direct
// command-line detector harness from openclaw-edge.test.ts. All secrets are
// synthetic credentials files; no environment files are opened by these tests.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { isHermesGatewayCommand } from './src/hermes.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 120_000

interface ReportItem {
  kind: string
  name: string
  source: string
  target: string
  status: string
  reason?: string
}

let root: string
let source: string
let home: string
let envFile: string

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function migrate(flags: string[], interactive = false) {
  let executable = cli
  const argv = ['hermes', '--from', source, '--home', home, '--env-file', envFile, ...flags]
  if (interactive) {
    // Keep the real CLI and pipe a negative answer, but mark stdin as a TTY
    // so --json actually exercises the human plan written to stderr.
    const ttyHook = join(root, 'interactive.mjs')
    put(ttyHook, "Object.defineProperty(process.stdin, 'isTTY', { value: true })\n")
    executable = process.execPath
    argv.unshift('--import', join(repoRoot, 'packages', 'app', 'register.mjs'), '--import', ttyHook, '--',
      join(repoRoot, 'packages', 'migrate', 'src', 'cli.ts'))
  }
  return spawnSync(executable, argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    ...(interactive ? { input: 'n\n' } : {}),
    env: {
      HOME: join(root, 'user'), LANG: 'C.UTF-8', TZ: 'UTC',
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    },
  })
}

function report(): { raw: string; items: ReportItem[] } {
  const dir = join(home, 'migration')
  expect(existsSync(dir), 'migration must create its report directory').toBe(true)
  const paths = readdirSync(dir)
    .filter((name) => name.startsWith('hermes-'))
    .map((name) => join(dir, name, 'report.json'))
    .filter((path) => existsSync(path))
  expect(paths, 'one report for this application').toHaveLength(1)
  const raw = readFileSync(paths[0], 'utf8')
  const doc = JSON.parse(raw) as { source: string; items: ReportItem[] }
  expect(doc.source).toBe('hermes')
  expect(Array.isArray(doc.items)).toBe(true)
  return { raw, items: doc.items }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-hermes-report-'))
  source = join(root, 'hermes')
  home = join(root, 'home')
  envFile = join(root, 'config', 'daemon-vars.conf')
  mkdirSync(join(root, 'user'), { recursive: true })
  mkdirSync(source, { recursive: true })
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test.each(['human', 'json'])('test_c10_masks_known_secrets_in_names_paths_and_reasons_in_%s_output_and_report', { timeout: TIMEOUT }, (format) => {
  const secret = 'fixture-public-report-key-73598'
  // Paths, an MCP name, a cron name and a skipped YAML section all contain a
  // known value. Redaction must apply to every public string, not just values.
  source = join(root, `hermes-${secret}`)
  home = join(root, `destination-${secret}`)
  envFile = join(root, `daemon-${secret}`, 'daemon-vars.conf')
  put(join(source, 'credentials', 'report-key.txt'), secret)
  const serverName = `mcp-${secret}`
  put(join(source, 'config.yaml'), [
    'mcp_servers:',
    `  ${serverName}:`,
    '    command: fixture-mcp-command',
    '    args: ["--stdio"]',
    `unsupported-${secret}: {enabled: true}`,
    '',
  ].join('\n'))
  put(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs: [{
    id: 'report-job', name: `cron-${secret}`, prompt: 'Summarize the fixture.',
    schedule: { kind: 'interval', minutes: 15 }, enabled: true,
  }] }))

  const outputFlags = format === 'json' ? ['--json'] : []
  const dry = migrate(['--dry-run', '--include-secrets', ...outputFlags])
  expect(dry.error, 'dry run starts successfully').toBeUndefined()
  expect(dry.signal).toBeNull()
  expect(dry.status).toBe(0)
  expect(existsSync(home), 'dry run must not create the destination').toBe(false)

  const surfaces: Array<[string, string]> = [['dry stdout', dry.stdout], ['dry stderr', dry.stderr]]
  if (format === 'json') {
    const interactive = migrate(['--include-secrets', '--json'], true)
    expect(interactive.error).toBeUndefined()
    expect(interactive.signal).toBeNull()
    expect(interactive.status).toBe(0)
    expect(interactive.stderr, 'interactive JSON mode must send the human plan to stderr').toContain('mcp ')
    expect(interactive.stderr).toContain('schedule ')
    expect(JSON.parse(interactive.stdout)).toMatchObject({ applied: false })
    expect(existsSync(home), 'declining the interactive plan must not apply it').toBe(false)
    surfaces.push(['interactive stdout', interactive.stdout], ['interactive stderr', interactive.stderr])
  }

  const applied = migrate(['--yes', '--include-secrets', ...outputFlags])
  expect(applied.error, 'application starts successfully').toBeUndefined()
  expect(applied.signal).toBeNull()
  expect(applied.status).toBe(0)
  const result = report()
  // Ensure both paths under review were actually planned and applied.
  expect(result.items.filter((item) => item.kind === 'mcp')).toHaveLength(1)
  expect(result.items.filter((item) => item.kind === 'schedule')).toHaveLength(1)
  expect(result.items.find((item) => item.kind === 'mcp')?.status).toBe('applied')
  expect(result.items.find((item) => item.kind === 'schedule')?.status).toBe('applied')
  const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
  expect(Object.hasOwn(mcp.mcpServers, serverName), 'redacting output must preserve the imported server name').toBe(true)
  if (format === 'json') {
    for (const output of [dry.stdout, applied.stdout]) {
      const doc = JSON.parse(output) as { items: ReportItem[] }
      expect(doc.items.some((item) => item.kind === 'mcp')).toBe(true)
      expect(doc.items.some((item) => item.kind === 'schedule')).toBe(true)
    }
  }
  surfaces.push(['apply stdout', applied.stdout], ['apply stderr', applied.stderr], ['report.json', result.raw])
  for (const [surface, output] of surfaces) {
    expect.soft(output.includes(secret), `known secret must be masked in ${surface}`).toBe(false)
  }
})

test('test_c10_reports_unsupported_hermes_sessions_database_kanban_and_webhook_as_skipped', { timeout: TIMEOUT }, () => {
  put(join(source, 'credentials', 'report-trigger.txt'), 'fixture-unsupported-report-trigger')
  put(join(source, 'sessions', 'session.json'), '{"messages": []}\n')
  put(join(source, 'state.db'), 'opaque Hermes state fixture\n')
  put(join(source, 'kanban', 'board.json'), '{"tasks": []}\n')
  put(join(source, 'webhook', 'config.json'), '{"enabled": false}\n')
  const run = migrate(['--yes', '--include-secrets'])
  expect(run.error).toBeUndefined()
  expect(run.signal).toBeNull()
  expect(run.status).toBe(0)
  const result = report()
  for (const name of ['sessions', 'state.db', 'kanban', 'webhook']) {
    const item = result.items.find((entry) => entry.name === name || entry.source === name || entry.source.startsWith(name + '/'))
    expect.soft(item, `${name} must be listed in the migration report`).toBeDefined()
    expect.soft(item?.status, `${name} must be reported as skipped`).toBe('skipped')
    expect.soft(item?.reason?.trim().length ?? 0, `${name} must have a skip reason`).toBeGreaterThan(0)
    expect(existsSync(join(home, name)), `${name} must not be copied`).toBe(false)
  }
})

test.each([
  { label: 'hermes-gateway executable', argv: ['hermes-gateway'] },
  { label: 'absolute hermes-gateway executable', argv: ['/usr/local/bin/hermes-gateway', '--verbose'] },
  { label: 'hermes gateway subcommand', argv: ['hermes', 'gateway'] },
  { label: 'absolute hermes executable', argv: ['/opt/hermes/bin/hermes', 'gateway'] },
  { label: 'gateway executable inside Hermes', argv: ['/opt/hermes/bin/gateway'] },
  { label: 'python hermes_cli.main module', argv: ['/usr/bin/python3', '-m', 'hermes_cli.main', 'gateway'] },
  { label: 'python hermes_cli module', argv: ['python', '-m', 'hermes_cli', 'gateway'] },
])('test_c5_recognizes_$label', ({ argv }) => {
  expect(isHermesGatewayCommand(argv)).toBe(true)
})

test.each([
  { label: 'unrelated gateway', argv: ['node', '/srv/gateway/server.js'] },
  { label: 'other Hermes subcommand', argv: ['hermes', 'tui'] },
  { label: 'other Python module', argv: ['python', '-m', 'unrelated_cli', 'gateway'] },
  { label: 'Hermes module without gateway', argv: ['python', '-m', 'hermes_cli.main', 'tui'] },
  { label: 'quoted text', argv: ['python', '-c', 'print("hermes gateway")'] },
  { label: 'words passed to printf', argv: ['/usr/bin/printf', '%s %s', 'hermes', 'gateway'] },
  { label: 'migration invocation', argv: ['/bin/sh', '/repo/scripts/dshbot-migrate', 'hermes', '--from', '/tmp/gateway'] },
])('test_c5_rejects_$label', ({ argv }) => {
  expect(isHermesGatewayCommand(argv)).toBe(false)
})

test.each(['constructor', 'toString'])('test_c6_imports_own_mcp_server_%s_into_an_empty_destination', { timeout: TIMEOUT }, (name) => {
  put(join(home, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
  put(join(source, 'config.yaml'), [
    'mcp_servers:',
    `  ${name}:`,
    '    command: fixture-prototype-server',
    '    args: ["--stdio"]',
    '    enabled: true',
    '',
  ].join('\n'))
  const run = migrate(['--yes', '--include-secrets'])
  expect(run.error).toBeUndefined()
  expect(run.signal).toBeNull()
  const item = report().items.find((entry) => entry.kind === 'mcp' && entry.name === name)
  expect(item, 'source server must be present in the report').toBeDefined()
  expect(item?.status, 'Object.prototype must not cause a destination conflict').toBe('applied')
  expect(run.status).toBe(0)
  const doc = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
  expect(Object.keys(doc.mcpServers)).toEqual([name])
  expect(Object.hasOwn(doc.mcpServers, name)).toBe(true)
  expect(doc.mcpServers[name]).toMatchObject({ command: 'fixture-prototype-server', args: ['--stdio'], enabled: true })
})
