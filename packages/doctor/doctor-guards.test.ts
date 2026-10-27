// Guards of the recovery doctor that recovery.test.ts does not reach: quoting
// tricks around the read-only list, normalized paths and the bwrap sandbox for
// confirmed commands, masking of every env-file value, and the exit while a
// confirmed command is still running.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { createScrubber, isReadOnly, readEnvFileNames, unsafePathReason } from './bin/doctor.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7123457
const TOKEN = '7000002:AAHGuardFixtureToken0123456789'
const KEY = 'sk-guard-fixture-deepseek-0123456789'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Obj = Record<string, unknown>

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

test('read-only list rejects quoting, escapes, abbreviations and option tricks', () => {
  for (const command of [
    'journalctl --user -u dshbot.service -n 30 --no-pager',
    'journalctl -xeu dshbot.service',
    'journalctl --user -n5',
    'systemctl --user status dshbot.service',
    'systemctl --user is-active dshbot.service',
    'git status',
    'git -C app log --oneline -5',
    'cat diagnostic.txt',
    'ls -la',
    'tail -n 1 diagnostic.txt',
    'grep marker diagnostic.txt',
    'cat stderr-fixture/*',
  ]) {
    expect(isReadOnly(command), command).toBe(true)
  }
  for (const command of [
    'git log "--output=/home/doctor-review-victim"',
    "git log '--output=/home/doctor-review-victim'",
    'git log \\--output=/home/doctor-review-victim',
    'git log --output=/home/doctor-review-victim',
    'git log --out=/home/doctor-review-victim',
    'git log --outp=victim',
    'git -c core.pager=touch log',
    'git --git-dir=/elsewhere log',
    'journalctl "--rotate"',
    "journalctl '--vacuum-size=1'",
    'journalctl --rotate',
    'journalctl --rot',
    'journalctl --vacuum-time=1s',
    'journalctl --flush',
    'journalctl --cursor-file=cursor',
    'journalctl -u dshbot.service --vacuum-files=1',
    'journalctl *',
    'git log *',
    'systemctl --user restart dshbot.service',
    'systemctl --user start dshbot.service',
    'systemctl --user "status" dshbot.service',
    'systemctl --user status dshbot.service --now',
    'cat diagnostic.txt > copy.txt',
    'cat $HOME/x',
    'ls; touch x',
    'FOO=1 cat x',
    './cat x',
    '/tmp/x/cat x',
    'cat a\nrm -rf b',
  ]) {
    expect(isReadOnly(command), command).toBe(false)
  }
})

test('confirmed paths are normalized before the root check', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-doctor-paths-')))
  try {
    const home = join(scratch, 'home')
    mkdirSync(home)
    expect(unsafePathReason('printf changed > //home/doctor-review-victim', home)).toBeDefined()
    expect(unsafePathReason('printf changed >//etc/doctor-review-victim', home)).toBeDefined()
    expect(unsafePathReason('printf changed > /tmp/../home/doctor-review-victim', home)).toBeDefined()
    expect(unsafePathReason(`printf ok > ${quote(join(home, 'inside.txt'))}`, home)).toBeUndefined()
    expect(unsafePathReason(`printf ok > ${quote(join(scratch, 'tmp.txt'))}`, home)).toBeUndefined()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the runtime value of every env-file name is masked, whatever its name or length', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-doctor-env-')))
  try {
    const file = join(scratch, 'dshbot.env')
    writeFileSync(file, '# comment\nCUSTOM_VALUE=file-only\nAPI_TOKEN=abc\nQUOTED="two words"\nEMPTY=\n')
    const names = readEnvFileNames(file)
    expect(names).toEqual(['CUSTOM_VALUE', 'API_TOKEN', 'QUOTED', 'EMPTY'])
    expect(readEnvFileNames(join(scratch, 'missing.env'))).toEqual([])
    const clean = createScrubber({ CUSTOM_VALUE: 'demo-secret', API_TOKEN: 'abc', QUOTED: 'two words', OTHER: 'public' }, names)
    const masked = clean('custom demo-secret token abc quoted two words, other public, file file-only')
    for (const secret of ['demo-secret', 'abc', 'two words']) expect(masked).not.toContain(secret)
    expect(masked).toContain('[скрыто]')
    // Only process values are masked: the file's own text is not a secret source.
    expect(masked).toContain('public')
    expect(masked).toContain('file-only')
    expect(clean('nothing to hide')).toBe('nothing to hide')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

interface TgCall { method: string; params: Obj; id: number }

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
}

/** The doctor straight from the repository, against Bot API / Messages API doubles. */
class World {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-doctor-guard-')))
  userHome = join(this.scratch, 'user')
  home = join(this.userHome, '.local/share/dshbot')
  bin = join(this.scratch, 'bin')
  state = join(this.scratch, 'unit-state')
  calls: TgCall[] = []
  modelBodies: Obj[] = []
  plans = new Map<string, string[]>()
  queue: Obj[] = []
  holders = new Set<ServerResponse>()
  servers: Server[] = []
  outside: string[] = []
  child?: ChildProcess
  exited = false
  exitCode: number | null = null
  output = ''
  seq = 0

  /** `exported` stands for what systemd puts into the process from the env-file. */
  async start(envFile = '', exported: NodeJS.ProcessEnv = {}): Promise<void> {
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.bin)
    mkdirSync(join(this.userHome, '.config/dshbot'), { recursive: true })
    writeFileSync(join(this.userHome, '.config/dshbot/dshbot.env'), envFile)
    const db = new DatabaseSync(join(this.home, 'state.db'))
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('telegram.owner_chat_id', String(OWNER))
    db.close()
    writeFileSync(this.state, 'failed')
    const head = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n`
    writeFileSync(join(this.bin, 'systemctl'), head + `
const state = fs.readFileSync(${JSON.stringify(this.state)}, 'utf8').trim();
console.log(state); process.exit(state === 'active' ? 0 : 3);
`, { mode: 0o755 })
    writeFileSync(join(this.bin, 'journalctl'), head + `console.log('journal-line-guard');\n`, { mode: 0o755 })

    const tg = createServer((req, res) => {
      void body(req).then((raw) => {
        const method = new URL(req.url ?? '/', 'http://fixture').pathname.split('/').at(-1) ?? ''
        const call = { method, params: raw ? object(JSON.parse(raw)) : {}, id: ++this.seq }
        this.calls.push(call)
        if (method === 'getUpdates') {
          if (this.queue.length) { json(res, { ok: true, result: this.queue.splice(0) }); return }
          this.holders.add(res)
          const timer = setTimeout(() => { this.holders.delete(res); if (!res.destroyed) json(res, { ok: true, result: [] }) }, 1_500)
          res.on('close', () => { clearTimeout(timer); this.holders.delete(res) })
          return
        }
        json(res, { ok: true, result: method === 'sendMessage' ? { message_id: call.id, date: 1, chat: { id: OWNER, type: 'private' } } : true })
      }).catch(() => res.destroy())
    })
    const model = createServer((req, res) => {
      void body(req).then((raw) => {
        const request = object(JSON.parse(raw))
        this.modelBodies.push(request)
        const messages = (Array.isArray(request.messages) ? request.messages : []).map(object)
        const marker = JSON.stringify(messages[0]?.content).match(/guard-case-\d+/)?.[0] ?? ''
        const done = messages.flatMap((message) => Array.isArray(message.content) ? message.content.map(object) : [])
          .filter((block) => block.type === 'tool_result')
        const command = this.plans.get(marker)?.[done.length]
        const content = command !== undefined
          ? [{ type: 'tool_use', id: `call-${marker}-${done.length}`, name: 'bash', input: { command } }]
          : [{ type: 'text', text: `answer-${marker}\n${done.map((block) => JSON.stringify(block.content)).join('\n')}` }]
        json(res, { id: 'msg', type: 'message', role: 'assistant', model: 'deepseek-flash', content, stop_reason: command === undefined ? 'end_turn' : 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } })
      }).catch(() => res.destroy())
    })
    this.servers.push(tg, model)
    const origin = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    const env: NodeJS.ProcessEnv = {
      ...exported,
      HOME: this.userHome,
      PATH: [this.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      DSHBOT_HOME: this.home,
      TELEGRAM_BOT_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: KEY,
      // These guards measure the post-window doctor; the grace window is
      // covered by restart-grace-window.test.ts.
      DSHBOT_DOCTOR_GRACE_MS: '1',
      TELEGRAM_API_ROOT: `${await origin(tg)}/tg`,
      DEEPSEEK_BASE_URL: `${await origin(model)}/anthropic`,
    }
    this.child = spawn(process.execPath, [join(root, 'packages/doctor/bin/doctor.ts')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.on('close', (code) => { this.exited = true; this.exitCode = code })
    await this.wait('doctor polls Telegram', () => this.calls.some((call) => call.method === 'getUpdates'))
  }

  push(update: Obj): void {
    this.queue.push({ update_id: ++this.seq, ...update })
    const holder = this.holders.values().next().value as ServerResponse | undefined
    if (!holder) return
    this.holders.delete(holder)
    json(holder, { ok: true, result: this.queue.splice(0) })
  }

  plan(commands: string[]): string {
    const marker = `guard-case-${++this.seq}`
    this.plans.set(marker, commands)
    this.push({ message: { message_id: ++this.seq, date: 1, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, text: `${marker} проверь` } })
    return marker
  }

  /** Press "Разрешить" on the next card after `after`. */
  async allow(after: number): Promise<void> {
    await this.wait('confirmation card', () => this.card(after) !== undefined)
    const card = this.card(after)!
    this.push({ callback_query: { id: `cb-${++this.seq}`, from: { id: OWNER, is_bot: false }, data: card, message: { message_id: 1, chat: { id: OWNER, type: 'private' } } } })
  }

  card(after: number): string | undefined {
    for (const call of this.calls) {
      if (call.id <= after || call.method !== 'sendMessage') continue
      const buttons = (object(call.params.reply_markup).inline_keyboard as Obj[][] | undefined)?.flat() ?? []
      const allow = buttons.find((button) => button.text === 'Разрешить')
      if (typeof allow?.callback_data === 'string') return allow.callback_data
    }
    return undefined
  }

  text(): string {
    return this.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.params.text ?? '')).join('\n')
  }

  async wait(label: string, predicate: () => boolean, timeout = 15_000, allowExited = false): Promise<void> {
    const until = Date.now() + timeout
    while (!predicate() && (!this.exited || allowExited) && Date.now() < until) await sleep(25)
    expect(predicate(), `${label}; exited=${this.exited}\n${this.output}`).toBe(true)
  }

  async close(): Promise<void> {
    if (this.child?.pid && !this.exited) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already exited */ }
      await new Promise<void>((resolve) => this.child!.once('close', () => resolve()))
    }
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    for (const path of this.outside) rmSync(path, { recursive: true, force: true })
    rmSync(this.scratch, { recursive: true, force: true })
  }
}

let world: World | undefined
afterEach(async () => { await world?.close(); world = undefined })

test('confirmed commands run in a sandbox: no write outside DSHBOT_HOME and /tmp via //, variables or cd', { timeout: 60_000 }, async () => {
  const w = world = new World()
  await w.start()
  const inside = join(w.home, 'inside.txt')
  let at = w.seq
  const ok = w.plan([`printf inside > ${quote(inside)}`])
  await w.allow(at)
  await w.wait('confirmed write inside DSHBOT_HOME', () => w.text().includes(`answer-${ok}`))
  expect(readFileSync(inside, 'utf8'), 'the sandbox keeps DSHBOT_HOME writable').toBe('inside')

  // A writable directory outside /tmp: /tmp itself is an allowed root.
  const outside = realpathSync(mkdtempSync(join(root, '.doctor-guard-')))
  w.outside.push(outside)
  const victim = join(outside, 'keep.txt')
  writeFileSync(victim, 'protected-original')
  // Octal escapes keep every `/` of the path out of the command text, so only
  // the sandbox can stop these writes.
  const hidden = `'${[...outside].map((char) => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('')}'`
  expect(hidden).not.toContain('/')
  for (const command of [
    `printf changed > /${victim}`,
    `D=$(printf ${hidden}); printf changed > "$D/keep.txt"`,
    `cd "$(printf ${hidden})" && printf changed > keep.txt`,
    `cd "$(printf ${hidden})" && rm -f keep.txt`,
  ]) {
    at = w.seq
    const marker = w.plan([command])
    await w.wait('refusal or card', () => w.text().includes(`answer-${marker}`) || w.card(at) !== undefined)
    if (w.card(at) !== undefined) await w.allow(at)
    await w.wait(`answer for ${command}`, () => w.text().includes(`answer-${marker}`))
    expect(existsSync(victim), command).toBe(true)
    expect(readFileSync(victim, 'utf8'), command).toBe('protected-original')
  }
})

test('main unit recovery kills a running confirmed command and exits within 30 s', { timeout: 60_000 }, async () => {
  const w = world = new World()
  await w.start()
  const started = join(w.home, 'started.txt')
  const late = join(w.home, 'late.txt')
  const at = w.seq
  w.plan([`printf started > ${quote(started)}; sleep 8; printf late > ${quote(late)}`])
  await w.allow(at)
  await w.wait('the confirmed command is running', () => existsSync(started))
  const becameActive = Date.now()
  writeFileSync(w.state, 'active')
  await w.wait('doctor exits while the command runs', () => w.exited, 30_000)
  expect(Date.now() - becameActive).toBeLessThan(30_000)
  expect(w.exitCode, w.output).toBe(0)
  const polls = w.calls.filter((call) => call.method === 'getUpdates').length
  await sleep(9_000)
  expect(existsSync(late), 'the command did not outlive the doctor').toBe(false)
  expect(w.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(polls)
})

test('short and neutrally named env-file values never reach the owner or the model', { timeout: 40_000 }, async () => {
  const w = world = new World()
  await w.start('CUSTOM_VALUE=demo-secret\nAPI_TOKEN=abc\n', { CUSTOM_VALUE: 'demo-secret', API_TOKEN: 'abc' })
  writeFileSync(join(w.home, 'diagnostic.txt'), 'visible-line\ndemo-secret\nabc\n')
  const marker = w.plan(['cat diagnostic.txt'])
  await w.wait('model answer', () => w.text().includes(`answer-${marker}`))
  expect(w.text()).toContain('visible-line')
  expect(w.text()).toContain('[скрыто]')
  for (const secret of ['demo-secret', 'abc']) {
    expect(JSON.stringify(w.calls.map((call) => call.params)), secret).not.toContain(secret)
    expect(JSON.stringify(w.modelBodies), secret).not.toContain(secret)
  }
})
