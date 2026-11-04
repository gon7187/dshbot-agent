// Black-box migration contract. All credentials below are synthetic and live
// inside this test's private temporary directory; no operator env file is read.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 180_000
type Obj = Record<string, unknown>
interface Fixture { root: string; userHome: string; source: string; home: string; envFile: string }
interface Run { code: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null }
let f: Fixture
const children = new Set<ChildProcess>()

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function json(path: string, value: unknown): void { put(path, JSON.stringify(value, null, 2) + '\n') }
function object(value: unknown): Obj {
  expect(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected a JSON object').toBe(true)
  return value as Obj
}
function load(path: string): Obj {
  expect(existsSync(path), `expected migration output ${path}`).toBe(true)
  return object(JSON.parse(readFileSync(path, 'utf8')))
}
function config(value: Obj, source = f.source, name = 'openclaw.json'): void { json(join(source, name), value) }
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: f.userHome, USERPROFILE: f.userHome, LANG: 'C.UTF-8',
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    XDG_RUNTIME_DIR: join(f.root, 'runtime'), ...extra,
  }
}

// Like the neighbouring script and daemon tests, execute the public command in
// a subprocess with a private HOME. The shell handles a not-yet-created script:
// it produces an ordinary exit code, so baseline failures are assertions.
async function command(args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return await collect(spawn('/bin/sh', ['-c', 'exec "$@"', 'migration-test', cli, ...args], {
    cwd: repoRoot, env: env(extra), stdio: ['pipe', 'pipe', 'pipe'],
  }))
}
async function migrate(flags: string[], dest = { home: f.home, envFile: f.envFile }, extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return await command(['openclaw', '--from', f.source, '--home', dest.home, '--env-file', dest.envFile, ...flags], extra)
}
function collect(child: ChildProcess): Promise<Run> {
  children.add(child)
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => { stderr += error.message })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ code, signal, stdout, stderr })
    })
    child.stdin?.end() // deliberately non-TTY, never an implicit confirmation
  })
}
function ok(run: Run): void {
  expect(run.signal, 'migration command must finish without a timeout or signal').toBeNull()
  // Do not include raw output in assertion messages: it may contain a leak.
  expect(run.code, 'migration command exit code').toBe(0)
}
function output(run: Run): string { return run.stdout + '\n' + run.stderr }
function mode(path: string): number { return statSync(path).mode & 0o777 }
function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}
function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) {
        result[relative(dir, path) + '/'] = 'directory'
        walk(path)
      } else {
        result[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  walk(dir)
  return result
}
function expectSecret(name: string, value: string, home = f.home): void {
  const path = join(home, 'secrets', name)
  expect(existsSync(path), `secret ${name} must be migrated`).toBe(true)
  expect(readFileSync(path).equals(Buffer.from(value)), `exact bytes of ${name}`).toBe(true)
  expect(mode(path), `permissions of ${name}`).toBe(0o600)
}
function expectNoLeaks(run: Run, values: string[], reportText = ''): void {
  for (const [index, value] of values.entries()) {
    for (const [surface, text] of [['stdout', run.stdout], ['stderr', run.stderr], ['report', reportText]]) {
      const escaped = JSON.stringify(value).slice(1, -1)
      expect(text.includes(value) || text.includes(escaped), `synthetic secret #${index} leaked in ${surface}`).toBe(false)
    }
  }
}

function reportAt(home = f.home): { path: string; dir: string; text: string; data: Obj } {
  const reports = files(join(home, 'migration')).filter((path) => path.endsWith('/report.json'))
  expect(reports.length, 'an application must create a migration report').toBeGreaterThan(0)
  const path = reports.sort().at(-1)!
  expect(relative(join(home, 'migration'), path)).toMatch(/^openclaw-[^/]+\/report\.json$/)
  const text = readFileSync(path, 'utf8')
  return { path, dir: dirname(path), text, data: object(JSON.parse(text)) }
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-migrate-cli-'))
  f = { root, userHome: join(root, 'user'), source: join(root, 'openclaw'), home: join(root, 'destination'), envFile: join(root, 'config', 'daemon-vars.conf') }
  for (const dir of [f.userHome, f.source, f.home, join(root, 'runtime')]) mkdirSync(dir, { recursive: true })
  chmodSync(join(root, 'runtime'), 0o700)
})
afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGKILL')
    await closed
  }))
  children.clear()
  rmSync(f.root, { recursive: true, force: true })
})

test('C1 CLI import is read-only by default and preserves secrets, backups and repeat bytes', { timeout: TIMEOUT }, async () => {
  const secret = "fixture-quote-\"-single-'-dollar-$-tick-`-slash-\\-end"
  config({ env: { vars: { DEEPSEEK_API_KEY: secret, EXTRA_KEY: secret } } })
  put(f.envFile, '# existing\nOTHER=unchanged\n')
  const originalEnv = readFileSync(f.envFile)
  const originalSource = snapshot(f.source)
  const before = snapshot(f.home)
  const preview = await migrate(['--dry-run', '--include-secrets', '--json'])
  ok(preview)
  expect(snapshot(f.home)).toEqual(before)
  expect(readFileSync(f.envFile)).toEqual(originalEnv)
  const defaults = await migrate(['--yes'])
  ok(defaults)
  expect(files(join(f.home, 'secrets'))).toEqual([])
  expect(readFileSync(f.envFile)).toEqual(originalEnv)
  const applied = await migrate(['--yes', '--include-secrets'])
  ok(applied)
  expectSecret('EXTRA_KEY', secret)
  const roundTrip = spawnSync('/bin/sh', ['-c', '. "$1"; printf %s "$DEEPSEEK_API_KEY"', 'env-roundtrip', f.envFile], { encoding: 'utf8', env: {} })
  expect(roundTrip.status).toBe(0)
  expect(roundTrip.stdout).toBe(secret)
  expect(mode(f.envFile)).toBe(0o600)
  const report = reportAt()
  expect(mode(report.path)).toBe(0o600)
  const backups = files(join(report.dir, 'before'))
  expect(backups.some(path => readFileSync(path).equals(originalEnv))).toBe(true)
  for (const path of backups) expect(mode(path)).toBe(0o600)
  for (const run of [preview, defaults, applied]) expectNoLeaks(run, [secret], report.text)
  for (const path of files(f.home).filter(path => /(?:\.log|\.jsonl)$/.test(path))) expect(readFileSync(path, 'utf8')).not.toContain(secret)
  const after = snapshot(f.home)
  const envAfter = readFileSync(f.envFile)
  ok(await migrate(['--yes', '--include-secrets']))
  expect(snapshot(f.home)).toEqual(after)
  expect(readFileSync(f.envFile)).toEqual(envAfter)
  expect(snapshot(f.source)).toEqual(originalSource)
})

test('C2 daemon ownership and unavailable report storage prevent destructive import', { timeout: TIMEOUT }, async () => {

  // Same real entry point and Telegram readiness condition as the adjacent
  // daemon tests. No messages are submitted, so no model endpoint is needed.
  let polls = 0
  const held = new Set<ServerResponse>()
  const server = createServer((req, res) => {
    req.resume()
    const method = req.url?.split('?')[0].split('/').at(-1)
    if (method === 'getUpdates') {
      polls++
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: method === 'getMe' ? { id: 7000042, is_bot: true, first_name: 'Fixture', username: 'migration_fixture_bot' } : true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let daemon: ChildProcess | undefined
  let daemonOutput = ''
  try {
    config({ env: { vars: { BUSY_KEY: 'fixture-busy-secret' } }, commands: { ownerAllowFrom: [123] } })
    const manifest = load(join(repoRoot, 'package.json'))
    const start = object(manifest.scripts).start
    expect(typeof start, 'existing daemon entry point').toBe('string')
    daemon = spawn('/bin/sh', ['-c', `exec ${start as string}`], {
      cwd: repoRoot, env: env({ DSHBOT_HOME: f.home, TELEGRAM_BOT_TOKEN: '7000042:AAFixtureDaemonToken123456789012345', DEEPSEEK_API_KEY: 'fixture-daemon-deepseek-key', TELEGRAM_API_ROOT: origin, DEEPSEEK_BASE_URL: origin + '/anthropic', DSHBOT_DREAM_AT: 'off' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(daemon)
    daemon.stdout?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString('utf8') })
    daemon.stderr?.on('data', (chunk: Buffer) => { daemonOutput += chunk.toString('utf8') })
    await waitFor(() => polls > 0 || daemon!.exitCode !== null, 'daemon must start long polling')
    expect(daemon.exitCode, `daemon must stay alive: ${daemonOutput.slice(-1500)}`).toBeNull()
    expect(polls).toBeGreaterThan(0)
    put(f.envFile, '# busy destination\n')
    // Leave startup and its asynchronous menu writes time to settle.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = snapshot(f.home)
    const envBefore = readFileSync(f.envFile)
    const refused = await migrate(['--yes', '--include-secrets'])
    expect(refused.code).toBe(1)
    expect(output(refused)).toMatch(/DSHBOT|dshbot/)
    expect(output(refused)).toMatch(/работает|запущен|останов|running|stop|active|busy/i)
    expect(snapshot(f.home)).toEqual(before)
    expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
    const preview = await migrate(['--dry-run', '--include-secrets'])
    ok(preview)
    expect(preview.stdout).toContain('BUSY_KEY')
    expect(snapshot(f.home)).toEqual(before)
    expect(readFileSync(f.envFile).equals(envBefore)).toBe(true)
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = new Promise<void>((resolve) => daemon!.once('close', () => resolve()))
      daemon.kill('SIGTERM')
      const killTimer = setTimeout(() => daemon!.kill('SIGKILL'), 10_000)
      for (const res of held) res.end(JSON.stringify({ ok: true, result: [] }))
      await closed
      clearTimeout(killTimer)
    }
    if (daemon) children.delete(daemon)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const sensitive = 'fixture-report-path-secret'
  config({ env: { vars: { DEEPSEEK_API_KEY: sensitive } } })
  const blockedHome = join(f.root, sensitive, 'home')
  mkdirSync(blockedHome, { recursive: true })
  put(join(blockedHome, 'migration'), 'not a directory')
  const beforeFailure = snapshot(blockedHome)
  const envBeforeFailure = readFileSync(f.envFile)
  const failed = await migrate(['--yes', '--include-secrets'], { home: blockedHome, envFile: f.envFile })
  expect(failed.code).toBe(1)
  expect(snapshot(blockedHome)).toEqual(beforeFailure)
  expect(readFileSync(f.envFile)).toEqual(envBeforeFailure)
  expectNoLeaks(failed, [sensitive])
})
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40))
  expect(predicate(), message).toBe(true)
}
