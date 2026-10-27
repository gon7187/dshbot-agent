// The Hermes gateway detector against scripts that merely take `hermes
// gateway` as operands, and failures of the report that must not reveal a
// secret value inside the DSHBOT_HOME path. Same private-HOME CLI harness as
// hermes-report-and-gateway.test.ts; every credential is synthetic.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { isHermesGatewayCommand, liveHermesGateway } from './src/hermes.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 120_000
/** A harmless long-lived process: it only reports readiness and waits. */
const IDLE = 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)\n'

interface ReportItem { kind: string; name: string; status: string; reason?: string }

let root: string
let source: string
let home: string
let envFile: string
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HOME: join(root, 'user'), LANG: 'C.UTF-8', TZ: 'UTC', PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), ...extra }
}

function migrate(flags: string[]) {
  return spawnSync(cli, ['hermes', '--from', source, '--home', home, '--env-file', envFile, ...flags], {
    cwd: repoRoot, encoding: 'utf8', timeout: 60_000, env: env(),
  })
}

function reportItems(): ReportItem[] {
  const dir = join(home, 'migration')
  const paths = readdirSync(dir).filter((name) => name.startsWith('hermes-')).map((name) => join(dir, name, 'report.json'))
  expect(paths).toHaveLength(1)
  return (JSON.parse(readFileSync(paths[0] as string, 'utf8')) as { items: ReportItem[] }).items
}

/** An executable named `name` that is really node, so its argv[0] is that name. */
function program(name: string): string {
  const path = join(root, 'bin', name)
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(process.execPath, path)
  return path
}

async function start(executable: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<ChildProcess> {
  const child = spawn(executable, args, { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000)
    child.stdout?.once('data', () => { clearTimeout(timer); resolve(true) })
    child.once('error', () => { clearTimeout(timer); resolve(false) })
  })
  expect(ready, `decoy ${args.join(' ')} must be running`).toBe(true)
  return child
}

function cmdline(child: ChildProcess): string[] {
  return readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0').filter((part) => part !== '')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-hermes-detector-'))
  source = join(root, 'source')
  home = join(root, 'home')
  envFile = join(root, 'config', 'daemon-vars.conf')
  mkdirSync(join(root, 'user'), { recursive: true })
  mkdirSync(source, { recursive: true })
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

test.each([
  { label: 'python script with -m after it', argv: ['python', '/srv/report.py', '-m', 'hermes_cli.main', 'gateway'] },
  { label: 'python script after interpreter options', argv: ['/usr/bin/python3', '-u', '-W', 'ignore', '/srv/report.py', '-m', 'hermes_cli', 'gateway'] },
  { label: 'python inline code with gateway words', argv: ['python3', '-c', 'import sys', 'hermes', 'gateway'] },
  { label: 'node script with hermes operands', argv: ['node', '/srv/report.js', 'hermes', 'gateway'] },
  { label: 'node script after a preload option', argv: ['node', '--require', '/srv/hermes', '/srv/report.js', 'hermes', 'gateway'] },
  { label: 'shell script with hermes operands', argv: ['/bin/bash', '/srv/report.sh', 'hermes', 'gateway'] },
  { label: 'shell command string', argv: ['sh', '-c', 'hermes gateway'] },
  { label: 'gateway outside a Hermes directory', argv: ['/opt/hermesian/bin/gateway'] },
  { label: 'hermes_cli main file without gateway', argv: ['python3', '/opt/hermes/hermes_cli/main.py', 'tui'] },
])('detector rejects $label', ({ argv }) => {
  expect(isHermesGatewayCommand(argv)).toBe(false)
})

test.each([
  { label: 'console script run by its venv python', argv: ['/home/u/.hermes/hermes-agent/venv/bin/python3', '/home/u/.local/bin/hermes', 'gateway', 'run'] },
  { label: 'python options before -m', argv: ['python3', '-u', '-X', 'utf8', '-m', 'hermes_cli.main', 'gateway'] },
  { label: 'attached -m module', argv: ['python3', '-mhermes_cli', 'gateway'] },
  { label: 'hermes_cli main file', argv: ['python3', '/opt/hermes/hermes_cli/main.py', 'gateway'] },
  { label: 'node inline code presenting hermes gateway', argv: ['node', '-e', 'setInterval(() => {}, 1000)', 'hermes', 'gateway'] },
  { label: 'env prefix', argv: ['/usr/bin/env', '-u', 'DISPLAY', 'HERMES_HOME=/srv/h', 'hermes', 'gateway'] },
  { label: 'shell running the hermes-gateway wrapper', argv: ['/bin/sh', '/opt/hermes/bin/hermes-gateway'] },
  { label: 'gateway inside ~/.hermes', argv: ['/home/u/.hermes/bin/gateway', '--profile', 'work'] },
])('detector recognizes $label', ({ argv }) => {
  expect(isHermesGatewayCommand(argv)).toBe(true)
})

test('token detection on a private process table ignores scripts with hermes gateway operands', () => {
  const proc = join(root, 'proc')
  const entry = (pid: string, argv: string[]): void => put(join(proc, pid, 'cmdline'), argv.join('\0') + '\0')
  entry('2147480101', ['python', '/srv/report.py', '-m', 'hermes_cli.main', 'gateway'])
  entry('2147480102', ['node', '/srv/report.js', 'hermes', 'gateway'])
  expect(liveHermesGateway(proc)).toBe(false)
  entry('2147480103', ['/usr/bin/python3', '-m', 'hermes_cli.main', 'gateway'])
  expect(liveHermesGateway(proc), 'positive control on the same table').toBe(true)
})

test('token of Telegram is migrated while python and node scripts take hermes gateway as operands', { timeout: TIMEOUT }, async () => {
  const token = '700011:AAFixtureOperandsAreNotAGateway1111'
  put(join(source, 'config.yaml'), 'mcp_servers: {}\n')
  put(join(source, '.env'), `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_ALLOWED_USERS=111\n`)
  const script = join(root, 'srv', 'report.py')
  const nodeScript = join(root, 'srv', 'report.js')
  put(script, IDLE)
  put(nodeScript, IDLE)
  // node runs both files; only the names in argv differ from a real report job.
  const decoys = [
    await start(program('python'), [script, '-m', 'hermes_cli.main', 'gateway']),
    await start(program('node'), [nodeScript, 'hermes', 'gateway']),
  ]
  expect(cmdline(decoys[0]!)).toEqual([join(root, 'bin', 'python'), script, '-m', 'hermes_cli.main', 'gateway'])
  expect(cmdline(decoys[1]!)).toEqual([join(root, 'bin', 'node'), nodeScript, 'hermes', 'gateway'])
  for (const decoy of decoys) expect(isHermesGatewayCommand(cmdline(decoy))).toBe(false)

  // hermes-cli.test.ts keeps a synthetic real gateway alive for one of its
  // runs, possibly in a parallel worker; the decoys stay alive across every
  // attempt, so a detector that counts them fails each one.
  let migrated = false
  for (let attempt = 0; attempt < 5 && !migrated; attempt += 1) {
    home = join(root, `home-${attempt}`)
    envFile = join(root, `config-${attempt}`, 'daemon-vars.conf')
    const run = migrate(['--yes', '--include-secrets'])
    expect(run.signal).toBeNull()
    expect(run.stdout.includes(token) || run.stderr.includes(token), 'token must not be printed').toBe(false)
    const item = reportItems().find((entry) => entry.name === 'TELEGRAM_BOT_TOKEN')
    migrated = run.status === 0 && item?.status === 'applied' && readFileSync(envFile, 'utf8').includes(`TELEGRAM_BOT_TOKEN=${token}`)
    if (!migrated) await delay(1_000)
  }
  expect(migrated, 'TELEGRAM_BOT_TOKEN must be applied despite the decoys').toBe(true)
  for (const decoy of decoys) expect(decoy.exitCode, 'decoys stayed alive during the runs').toBeNull()
})

test.each(['human', 'json'])('report directory failure masks a secret inside DSHBOT_HOME and writes nothing (%s)', { timeout: TIMEOUT }, (format) => {
  const secret = 'fixture-report-dir-secret-80417'
  home = join(root, `home-${secret}`)
  put(join(source, 'credentials', 'report-key.txt'), secret)
  // A regular file where the report directory goes: mkdir fails with the
  // path in its message for any user, root included.
  put(join(home, 'migration'), 'not a directory\n')
  const run = migrate(['--yes', '--include-secrets', ...(format === 'json' ? ['--json'] : [])])
  expect(run.error).toBeUndefined()
  expect(run.signal).toBeNull()
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('не удалось создать каталог отчёта')
  expect(run.stderr, 'the failing path is printed with the secret replaced').toContain('${secret:')
  expect(run.stderr, 'no stack trace').not.toMatch(/^\s+at /m)
  for (const [surface, output] of [['stdout', run.stdout], ['stderr', run.stderr]] as const) {
    expect(output.includes(secret), `known secret must be masked in ${surface}`).toBe(false)
  }
  if (format === 'json') expect(JSON.parse(run.stdout)).toMatchObject({ applied: false, error: expect.stringContaining('${secret:') })
  expect(existsSync(join(home, 'secrets')), 'nothing is applied without a report directory').toBe(false)
  expect(existsSync(envFile)).toBe(false)
  expect(readFileSync(join(home, 'migration'), 'utf8')).toBe('not a directory\n')
})

test('report of a running daemon masks a secret inside DSHBOT_HOME', { timeout: TIMEOUT }, async () => {
  const secret = 'fixture-running-daemon-secret-62904'
  home = join(root, `home-${secret}`)
  mkdirSync(home, { recursive: true })
  put(join(source, 'credentials', 'daemon-key.txt'), secret)
  // liveDshbot matches `.../bin/dshbot` with this exact DSHBOT_HOME.
  await start(program('dshbot'), ['-e', IDLE], { DSHBOT_HOME: home })
  const run = migrate(['--yes', '--include-secrets'])
  expect(run.signal).toBeNull()
  expect(run.status).toBe(1)
  expect(run.stderr).toContain('DSHBOT уже работает')
  expect(run.stderr).toContain('${secret:')
  expect(run.stdout.includes(secret) || run.stderr.includes(secret), 'known secret must be masked').toBe(false)
  expect(existsSync(join(home, 'secrets'))).toBe(false)
})
