// Intentional restarts (exit 42 / 75) must not page the owner: the unit keeps
// restarting on them without OnFailure, and a doctor that does start waits a
// grace window for the unit to come back before it sends anything to Telegram.
// Like recovery.test.ts this runs the real doctor against a fake systemctl and
// a local Bot API double, but with its own small harness.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7123456
const TOKEN = '7000001:AAHGraceFixtureToken0123456789'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function unitValues(name: string, section: string, key: string): string[] {
  const path = join(root, 'deploy', name)
  expect(existsSync(path), `deploy/${name} exists`).toBe(true)
  const values: string[] = []
  let current = ''
  for (const raw of readFileSync(path, 'utf8').replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) { current = header[1]!; continue }
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (!pair || current !== section || pair[1]!.trim() !== key) continue
    if (pair[2]!.trim() === '') values.length = 0
    else values.push(...pair[2]!.trim().split(/\s+/))
  }
  return values
}

interface Call { method: string; at: number }

class Grace {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-grace-')))
  home = join(this.scratch, 'home')
  bin = join(this.scratch, 'bin')
  state = join(this.scratch, 'unit-state')
  calls: Call[] = []
  texts: string[] = []
  server?: Server
  child?: ChildProcess
  exited = false
  exitCode: number | null = null
  output = ''
  startedAt = 0

  setState(value: string): void { writeFileSync(this.state, value) }

  async start(initial: string, grace: string | undefined): Promise<void> {
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.bin)
    const db = new DatabaseSync(join(this.home, 'state.db'))
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('telegram.owner_chat_id', String(OWNER))
    db.close()
    this.setState(initial)
    writeFileSync(join(this.scratch, 'journal'), 'grace-journal-line-1\ngrace-journal-line-2\n')
    const preamble = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n`
    writeFileSync(join(this.bin, 'systemctl'), preamble + `
const state = fs.readFileSync(${JSON.stringify(this.state)}, 'utf8').trim();
if (args.includes('is-active')) { console.log(state); process.exit(state === 'active' ? 0 : 3); }
if (args.includes('show')) { console.log('ActiveState=' + state); process.exit(0); }
if (args.includes('status')) { console.log('dshbot.service: ' + state); process.exit(state === 'active' ? 0 : 3); }
process.exit(0);
`, { mode: 0o755 })
    writeFileSync(join(this.bin, 'journalctl'), preamble + `console.log(fs.readFileSync(${JSON.stringify(join(this.scratch, 'journal'))}, 'utf8').trimEnd());\n`, { mode: 0o755 })

    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://fixture')
        const method = url.pathname.split('/').at(-1) ?? ''
        this.calls.push({ method, at: Date.now() })
        let params: Record<string, unknown> = {}
        try { params = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> } catch { /* form or empty */ }
        if (method === 'sendMessage') this.texts.push(String(params.text ?? ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        if (method === 'getUpdates') {
          // Hold the long poll briefly, then answer empty, like Telegram does.
          setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ ok: true, result: [] })) }, 300)
          return
        }
        res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: this.calls.length, date: 1, chat: { id: OWNER, type: 'private' }, text: '' } : true }))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    const env: NodeJS.ProcessEnv = {
      HOME: this.scratch,
      PATH: [this.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      DSHBOT_HOME: this.home,
      TELEGRAM_BOT_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: 'sk-grace-fixture-0123456789',
      TELEGRAM_API_ROOT: `${origin}/telegram-fixture`,
      DEEPSEEK_BASE_URL: `${origin}/model-fixture/anthropic`,
    }
    if (grace !== undefined) env.DSHBOT_DOCTOR_GRACE_MS = grace
    this.startedAt = Date.now()
    this.child = spawn(process.execPath, ['./packages/doctor/bin/doctor.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.on('error', (error) => { this.output += String(error); this.exited = true })
    this.child.on('close', (code) => { this.exited = true; this.exitCode = code })
  }

  async wait(label: string, predicate: () => boolean, timeout: number): Promise<void> {
    const until = Date.now() + timeout
    while (!predicate() && Date.now() < until) await sleep(25)
    expect(predicate(), `${label}; exited=${this.exited}, code=${this.exitCode}\n${this.output}`).toBe(true)
  }

  async close(): Promise<void> {
    if (this.child?.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already exited */ }
      if (!this.exited) await new Promise<void>((resolve) => this.child!.once('close', () => resolve()))
    }
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve() })
    rmSync(this.scratch, { recursive: true, force: true })
  }
}

const open: Grace[] = []
afterEach(async () => { await Promise.all(open.splice(0).map((grace) => grace.close())) })

async function launch(initial: string, grace: string | undefined): Promise<Grace> {
  const g = new Grace()
  open.push(g)
  await g.start(initial, grace)
  return g
}

test('test_c1_unit_treats_intentional_restart_codes_as_success_and_keeps_restarting', () => {
  const success = unitValues('dshbot.service', 'Service', 'SuccessExitStatus')
  const force = unitValues('dshbot.service', 'Service', 'RestartForceExitStatus')
  const prevent = unitValues('dshbot.service', 'Service', 'RestartPreventExitStatus')
  for (const code of ['42', '75']) {
    expect(success, `SuccessExitStatus has ${code}`).toContain(code)
    expect(force, `RestartForceExitStatus has ${code}`).toContain(code)
    expect(prevent, `RestartPreventExitStatus has no ${code}`).not.toContain(code)
  }
  for (const code of ['77', '78']) expect(prevent).toContain(code)
  expect(unitValues('dshbot.service', 'Service', 'Restart')).toEqual(['on-failure'])
  expect(unitValues('dshbot.service', 'Unit', 'OnFailure')).toContain('dshbot-doctor.service')
})

test('test_c2_c4_unit_returning_inside_the_window_ends_the_doctor_silently', { timeout: 30_000 }, async () => {
  const g = await launch('activating', '6000')
  await sleep(900)
  // Still inside the window: nothing may reach Telegram yet.
  expect(g.calls).toHaveLength(0)
  expect(g.exited, g.output).toBe(false)
  g.setState('active')
  await g.wait('doctor exits once the unit is active', () => g.exited, 12_000)
  expect(g.exitCode, g.output).toBe(0)
  expect(g.calls.map((call) => call.method)).toEqual([])
})

test('test_c3_c4_unit_still_down_after_the_window_gets_the_failure_notice_and_polling', { timeout: 30_000 }, async () => {
  const g = await launch('failed', '2500')
  await sleep(1200)
  expect(g.calls).toHaveLength(0)
  await g.wait('failure notice and getUpdates after the window', () => g.texts.length > 0 && g.calls.some((call) => call.method === 'getUpdates'), 12_000)
  const first = g.calls[0]!
  // The window was honoured (small allowance for timer granularity).
  expect(first.at - g.startedAt).toBeGreaterThanOrEqual(2000)
  expect(g.texts[0]).toMatch(/лежит|упал|падени|failed|down/i)
  expect(g.texts[0]).toContain('grace-journal-line-2')
  expect(g.exited).toBe(false)
})

test('test_c4_missing_empty_or_invalid_window_value_falls_back_to_a_long_default', { timeout: 40_000 }, async () => {
  const values: (string | undefined)[] = [undefined, '', 'abc', '0', '-100']
  const runs = await Promise.all(values.map((value) => launch('failed', value)))
  // A fallback of zero or NaN would notify at once; the 30 s default must not.
  await sleep(2500)
  for (const g of runs) expect(g.calls.map((call) => call.method), g.output).toEqual([])
  for (const g of runs) g.setState('active')
  for (const g of runs) await g.wait('doctor exits when the unit returns', () => g.exited, 12_000)
  for (const g of runs) {
    expect(g.exitCode, g.output).toBe(0)
    expect(g.calls.map((call) => call.method)).toEqual([])
  }
})

test('test_c5_active_unit_ends_the_doctor_at_once_without_telegram', { timeout: 20_000 }, async () => {
  const g = await launch('active', '30000')
  await g.wait('doctor exits immediately for an active unit', () => g.exited, 5_000)
  expect(g.exitCode, g.output).toBe(0)
  expect(g.calls).toHaveLength(0)
})
