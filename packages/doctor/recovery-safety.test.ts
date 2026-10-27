// Regression coverage for h1. The process/SQLite/Bot API/Messages API fixture
// follows doctor-guards.test.ts. Command doubles keep these tests independent
// of the host's bwrap permissions and never invoke a real git repository.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { isReadOnly } from './bin/doctor.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7123468
const TOKEN = '7000068:AAHSafetyFixtureToken0123456789'
const KEY = 'sk-safety-fixture-deepseek-0123456789'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Obj = Record<string, unknown>
type Sandbox = 'working' | 'missing' | 'broken' | 'system'
interface TgCall { method: string; params: Obj; id: number }
interface CommandCall { name: string; args: string[]; cwd: string; env: Record<string, string> }
interface Card { call: TgCall; data: string }

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

// These are inputs to the doctor's command classifier and the fixture executable,
// never queries of the checkout or of changes made by a task.
function gitCommand(...args: string[]): string {
  return ['git', ...args].join(' ')
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function json(res: ServerResponse, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
}

class SafetyWorld {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-doctor-safety-')))
  userHome = join(this.scratch, 'user')
  home = join(this.userHome, '.local/share/dshbot')
  app = join(this.home, 'app')
  bin = join(this.scratch, 'bin')
  state = join(this.scratch, 'unit-state')
  log = join(this.scratch, 'commands.jsonl')
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
  heldNotice?: ServerResponse
  modelSuffix = ''

  async start(options: {
    sandbox?: Sandbox
    envFile?: string
    env?: NodeJS.ProcessEnv
    journal?: string
    holdNotice?: boolean
  } = {}): Promise<void> {
    mkdirSync(this.app, { recursive: true })
    mkdirSync(this.bin)
    mkdirSync(join(this.userHome, '.config/dshbot'), { recursive: true })
    // Only synthetic credentials in a private fixture; never read the user's env file.
    writeFileSync(join(this.userHome, '.config/dshbot/dshbot.env'), options.envFile ?? '')
    writeFileSync(this.state, 'failed')
    writeFileSync(this.log, '')
    const db = new DatabaseSync(join(this.home, 'state.db'))
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('telegram.owner_chat_id', String(OWNER))
    db.close()
    this.commands(options.sandbox ?? 'working', options.journal ?? 'safety-journal-visible')

    const tg = createServer((req, res) => {
      void body(req).then((raw) => {
        const method = new URL(req.url ?? '/', 'http://fixture').pathname.split('/').at(-1) ?? ''
        const call = { method, params: raw ? object(JSON.parse(raw)) : {}, id: ++this.seq }
        this.calls.push(call)
        if (method === 'sendMessage' && options.holdNotice && this.heldNotice === undefined) {
          this.heldNotice = res
          return
        }
        if (method === 'getUpdates') {
          if (this.queue.length) { json(res, { ok: true, result: this.queue.splice(0) }); return }
          this.holders.add(res)
          const timer = setTimeout(() => {
            this.holders.delete(res)
            if (!res.destroyed) json(res, { ok: true, result: [] })
          }, 250)
          res.on('close', () => { clearTimeout(timer); this.holders.delete(res) })
          return
        }
        json(res, { ok: true, result: method === 'sendMessage'
          ? { message_id: call.id, date: 1, chat: { id: OWNER, type: 'private' } } : true })
      }).catch((error: unknown) => { this.output += `Bot fixture: ${String(error)}`; res.destroy() })
    })
    const model = createServer((req, res) => {
      void body(req).then((raw) => {
        const request = object(JSON.parse(raw))
        this.modelBodies.push(request)
        const messages = (Array.isArray(request.messages) ? request.messages : []).map(object)
        const marker = JSON.stringify(messages[0]?.content).match(/safety-case-\d+/)?.[0] ?? ''
        const done = messages.flatMap((message) => Array.isArray(message.content) ? message.content.map(object) : [])
          .filter((block) => block.type === 'tool_result')
        const command = this.plans.get(marker)?.[done.length]
        const content = command !== undefined
          ? [{ type: 'tool_use', id: `call-${marker}-${done.length}`, name: 'bash', input: { command } }]
          : [{ type: 'text', text: `answer-${marker}\n${done.map((block) => String(block.content)).join('\n')}\n${this.modelSuffix}` }]
        json(res, { id: 'msg', type: 'message', role: 'assistant', model: 'deepseek-flash', content,
          stop_reason: command === undefined ? 'end_turn' : 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } })
      }).catch((error: unknown) => { this.output += `Model fixture: ${String(error)}`; res.destroy() })
    })
    this.servers.push(tg, model)
    const origin = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    const env: NodeJS.ProcessEnv = {
      HOME: this.userHome,
      // Deliberately no inherited PATH: "missing" cannot find the host's bwrap.
      PATH: this.bin,
      DSHBOT_HOME: this.home,
      TELEGRAM_BOT_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: KEY,
      // Start the post-window path at once; the grace window itself is covered
      // by restart-grace-window.test.ts.
      DSHBOT_DOCTOR_GRACE_MS: '1',
      TELEGRAM_API_ROOT: `${await origin(tg)}/tg`,
      DEEPSEEK_BASE_URL: `${await origin(model)}/anthropic`,
      ...options.env,
    }
    this.child = spawn(process.execPath, [join(root, 'packages/doctor/bin/doctor.ts')], {
      cwd: this.app, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.on('error', (error) => { this.output += String(error); this.exited = true })
    this.child.on('close', (code) => { this.exited = true; this.exitCode = code })
    await this.wait(options.holdNotice ? 'startup notification is pending' : 'doctor polls Telegram', () =>
      options.holdNotice ? this.heldNotice !== undefined : this.calls.some((call) => call.method === 'getUpdates'))
  }

  private commands(sandbox: Sandbox, journal: string): void {
    const head = `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const name = require('node:path').basename(process.argv[1]);
const keys = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_PAGER'];
fs.appendFileSync(${JSON.stringify(this.log)}, JSON.stringify({name, args, cwd: process.cwd(),
  env: Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))}) + '\\n');
`
    const executable = (name: string, code: string) => writeFileSync(join(this.bin, name), head + code, { mode: 0o755 })
    executable('systemctl', `
const stateFile = ${JSON.stringify(this.state)};
const state = fs.readFileSync(stateFile, 'utf8').trim();
if (args.includes('is-active')) { console.log(state); process.exit(state === 'active' ? 0 : 3); }
if (args.includes('show') || args.includes('status')) { console.log('ActiveState=' + state + '\\nExecMainStatus=23'); process.exit(0); }
if (args.includes('reset-failed')) process.exit(0);
if (args.includes('start') || args.includes('restart')) { fs.writeFileSync(stateFile, 'active'); process.exit(0); }
process.exit(1);
`)
    executable('journalctl', `console.log(${JSON.stringify(journal)});\n`)
    executable('git', "console.log('git-safety-readable');\n")
    symlinkSync('/bin/bash', join(this.bin, 'bash'))
    symlinkSync('/bin/cat', join(this.bin, 'cat'))
    if (sandbox === 'missing') return
    if (sandbox === 'system') {
      const installed = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
        .map((directory) => join(directory, 'bwrap')).find((path) => existsSync(path))
      if (installed !== undefined) symlinkSync(installed, join(this.bin, 'bwrap'))
      return
    }
    if (sandbox === 'broken') { executable('bwrap', "console.error('fixture: namespaces unavailable'); process.exit(1);\n"); return }
    // The double records the real profile and delegates harmless fixture commands.
    // Assertions below inspect mounts; this double does not pretend to isolate writes.
    executable('bwrap', `
let cwd = process.cwd();
const env = {...process.env};
let i = 0;
while (i < args.length) {
  const arg = args[i];
  if (arg === '--') { i++; break; }
  if (!arg.startsWith('--')) break;
  if (arg === '--chdir') { cwd = args[i + 1]; i += 2; continue; }
  if (arg === '--setenv') { env[args[i + 1]] = args[i + 2]; i += 3; continue; }
  if (arg === '--unsetenv') { delete env[args[i + 1]]; i += 2; continue; }
  if (['--ro-bind', '--bind', '--ro-bind-try', '--bind-try', '--dev-bind'].includes(arg)) { i += 3; continue; }
  if (['--dev', '--proc', '--tmpfs', '--dir'].includes(arg)) { i += 2; continue; }
  i++;
}
if (args[i] === 'true' || args[i] === '/bin/true') process.exit(0);
const result = require('node:child_process').spawnSync(args[i], args.slice(i + 1), {cwd, env, stdio: 'inherit'});
if (result.error) console.error(String(result.error));
process.exit(result.status ?? 1);
`)
  }

  commandCalls(): CommandCall[] {
    return readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CommandCall)
  }

  push(update: Obj): void {
    this.queue.push({ update_id: ++this.seq, ...update })
    const holder = this.holders.values().next().value as ServerResponse | undefined
    if (!holder) return
    this.holders.delete(holder)
    json(holder, { ok: true, result: this.queue.splice(0) })
  }

  say(text: string): void {
    this.push({ message: { message_id: ++this.seq, date: 1, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' }, text } })
  }

  cards(after: number): Card[] {
    return this.calls.filter((call) => call.id > after && call.method === 'sendMessage').flatMap((call) => {
      const markup = typeof call.params.reply_markup === 'string'
        ? object(JSON.parse(call.params.reply_markup)) : object(call.params.reply_markup)
      const buttons = (Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard.flat() : []).map(object)
      const allow = buttons.find((button) => /разрешить|allow/i.test(String(button.text)) && !/не\s*разреш|not\s+allow/i.test(String(button.text)))
      return typeof allow?.callback_data === 'string' ? [{ call, data: allow.callback_data }] : []
    })
  }

  text(): string {
    return this.calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.params.text ?? '')).join('\n')
  }

  async turn(commands: string[], confirm = false, ownerTail = ''): Promise<{ marker: string; cards: Card[] }> {
    const marker = `safety-case-${++this.seq}`
    this.plans.set(marker, commands)
    this.say(`${marker} проверь ${ownerTail}`)
    let after = this.seq
    const cards: Card[] = []
    while (!this.text().includes(`answer-${marker}`)) {
      await this.wait('model finishes or asks permission', () => this.text().includes(`answer-${marker}`) || this.cards(after).length > 0)
      if (this.text().includes(`answer-${marker}`)) break
      const card = this.cards(after)[0]!
      cards.push(card)
      expect(confirm, `read-only command unexpectedly needs approval: ${String(card.call.params.text)}`).toBe(true)
      // The command has not run merely because a confirmation card was sent.
      expect(this.commandCalls().some((call) => call.name === 'bwrap' && call.args.some((arg) => commands.includes(arg))),
        'no command in this turn starts before confirmation').toBe(false)
      after = card.call.id
      this.push({ callback_query: { id: `cb-${++this.seq}`, from: { id: OWNER, is_bot: false }, data: card.data,
        message: { message_id: card.call.id, chat: { id: OWNER, type: 'private' } } } })
    }
    return { marker, cards }
  }

  async wait(label: string, predicate: () => boolean, timeout = 12_000): Promise<void> {
    const until = Date.now() + timeout
    while (!predicate() && !this.exited && Date.now() < until) await sleep(25)
    expect(predicate(), `${label}; exited=${this.exited}\n${this.output}`).toBe(true)
  }

  async close(): Promise<void> {
    if (this.child?.pid && !this.exited) {
      const closed = new Promise<void>((resolve) => this.child!.once('close', () => resolve()))
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already exited */ }
      await closed
    }
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })))
    for (const path of this.outside) rmSync(path, { recursive: true, force: true })
    rmSync(this.scratch, { recursive: true, force: true })
  }
}

let world: SafetyWorld | undefined
afterEach(async () => { await world?.close(); world = undefined })

function expectSandboxProfile(call: CommandCall, home: string): void {
  const args = call.args
  expect(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/'])
  expect(args).toContain('--unshare-pid')
  expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])
  expect(args.slice(args.indexOf('--dev'), args.indexOf('--dev') + 2)).toEqual(['--dev', '/dev'])
  const roots = [realpathSync('/tmp'), home]
  const writable = args.flatMap((arg, index) => ['--bind', '--bind-try', '--dev-bind', '--dev-bind-try'].includes(arg)
    ? [args.slice(index + 1, index + 3)] : [])
  for (const mount of writable) {
    expect(roots, 'a writable mount must not open another part of the machine').toContain(mount[1])
    expect(mount[0], 'the writable directory must not alias another host directory').toBe(mount[1])
  }
  for (const root of roots) expect(writable.some((mount) =>
    root === mount[1] || root.startsWith(`${mount[1]}${sep}`)), `${root} must be writable`).toBe(true)
  expect(args.some((arg) => basename(arg) === 'bash')).toBe(true)
}

test('test_h1_c7_git_read_only_subcommands_have_an_explicit_allowlist', () => {
  const reads = [
    ['status'], ['status', '--short'], ['log', '--oneline', '-5'], ['show', 'HEAD'],
    ['diff', '--stat'], ['rev-parse', 'HEAD'], ['branch'], ['branch', '--list'], ['branch', '-a'],
  ]
  const mutations = [
    ['branch', 'new-branch'], ['branch', '-d', 'old-branch'], ['branch', '-D', 'old-branch'],
    ['branch', '-m', 'renamed'], ['branch', '--set-upstream-to=origin/main'],
    ['checkout', 'main'], ['reset', '--hard'], ['clean', '-fd'], ['config', 'core.pager', 'cat'], ['fetch'],
  ]
  for (const args of reads) {
    const command = gitCommand(...args)
    expect(isReadOnly(command), command).toBe(true)
  }
  for (const args of mutations) {
    const command = gitCommand(...args)
    expect(isReadOnly(command), command).toBe(false)
  }
})

test('test_h1_c7_git_flags_that_enable_external_programs_config_or_output_require_confirmation', () => {
  for (const args of [
    ['log', '--ext-diff'], ['log', '--textconv'], ['diff', '--ext-diff'], ['show', '--textconv', 'HEAD'],
    ['-c', 'core.pager=cat', 'log'], ['-ccore.pager=cat', 'log'],
    ['--config-env=core.pager=PAGER', 'log'], ['--exec-path=tools', 'log'],
    ['--git-dir=other', 'log'], ['--work-tree=other', 'log'],
    ['log', '--output=result.txt'], ['log', '--output', 'result.txt'],
    ['log', '--out=result.txt'],
  ]) {
    const command = gitCommand(...args)
    expect(isReadOnly(command), command).toBe(false)
  }
})

test('test_h1_c7_read_only_git_ignores_system_global_config_and_uses_cat_pager', { timeout: 30_000 }, async () => {
  const w = world = new SafetyWorld()
  await w.start({ env: {
    GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_GLOBAL: '/unused-fixture-global-config', GIT_PAGER: 'unused-fixture-pager',
  } })
  const commands = [gitCommand('status'), gitCommand('log', '--oneline', '-1')]
  await w.turn(commands)
  const calls = w.commandCalls().filter((call) => call.name === 'git')
  expect(calls, 'both read-only git commands really executed').toHaveLength(2)
  expect(w.text()).toContain('git-safety-readable')
  for (const command of commands) {
    const wrappers = w.commandCalls().filter((call) => call.name === 'bwrap' && call.args.includes(command))
    expect(wrappers, `${command} also uses the restricted filesystem`).toHaveLength(1)
    expectSandboxProfile(wrappers[0]!, w.home)
  }
  for (const call of calls) expect(call.env).toMatchObject({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat',
  })
})

test('test_h1_c7_external_git_cannot_physically_write_outside_the_allowed_roots', { timeout: 30_000 }, async () => {
  const w = world = new SafetyWorld()
  await w.start({ sandbox: 'system' })
  // Like doctor-guards.test.ts, use the repository for an outside fixture:
  // putting this in /tmp would make the attempted write explicitly allowed.
  const outside = realpathSync(mkdtempSync(join(root, '.doctor-safety-')))
  w.outside.push(outside)
  const victim = join(outside, 'keep.txt')
  writeFileSync(victim, 'protected-original')
  const git = join(w.bin, 'git')
  writeFileSync(git, readFileSync(git, 'utf8') + `
try {
  fs.writeFileSync(${JSON.stringify(victim)}, 'unexpected-write');
  console.log('outside-write-succeeded');
} catch { console.log('outside-write-denied'); }
`)
  await w.turn([gitCommand('status')])
  expect(w.modelBodies.length, 'the model actually requested and received the bash tool result').toBeGreaterThanOrEqual(2)
  expect(readFileSync(victim, 'utf8'), 'even an external executable called git cannot write outside the sandbox').toBe('protected-original')
  const executed = w.commandCalls().filter((call) => call.name === 'git')
  if (executed.length > 0) {
    expect(w.text()).toContain('git-safety-readable')
    expect(w.text()).toContain('outside-write-denied')
  } else {
    // Hosts without usable user namespaces must refuse the tool altogether.
    expect(w.text()).toMatch(/bwrap/i)
    expect(w.text()).toMatch(/отказ|недоступ|не запущ|невозможно/i)
  }
})

test('test_h1_c8_every_read_only_and_confirmed_bash_uses_the_same_restricted_bwrap_profile', { timeout: 30_000 }, async () => {
  const w = world = new SafetyWorld()
  await w.start()
  writeFileSync(join(w.home, 'diagnostic.txt'), 'read-only-safety-visible')
  const read = 'cat diagnostic.txt'
  const write = 'printf confirmed-safety-visible > confirmed.txt'
  const first = await w.turn([read])
  const second = await w.turn([write], true)
  expect(first.cards).toHaveLength(0)
  expect(second.cards).toHaveLength(1)
  expect(w.text()).toContain('read-only-safety-visible')
  const runs = [read, write].map((command) => {
    const calls = w.commandCalls().filter((call) => call.name === 'bwrap' && call.args.includes(command))
    expect(calls, `${command} is executed once through bwrap`).toHaveLength(1)
    return calls[0]!
  })
  for (const call of runs) expectSandboxProfile(call, w.home)
  expect(runs[0]!.args.slice(0, runs[0]!.args.indexOf('--'))).toEqual(runs[1]!.args.slice(0, runs[1]!.args.indexOf('--')))
  expect(readFileSync(join(w.home, 'confirmed.txt'), 'utf8')).toBe('confirmed-safety-visible')
})

test.each<Sandbox>(['missing', 'broken'])('test_h1_c8_unavailable_bwrap_%s_refuses_all_bash_but_status_and_restart_work', { timeout: 30_000 }, async (sandbox) => {
  const w = world = new SafetyWorld()
  await w.start({ sandbox })
  const { marker, cards } = await w.turn([gitCommand('status'), 'printf forbidden > forbidden.txt'])
  const answer = w.calls.filter((call) => String(call.params.text).includes(`answer-${marker}`)).map((call) => String(call.params.text)).join('\n')
  const at = w.seq
  w.say('/status')
  await w.wait('/status still reports the main unit', () => w.calls.some((call) => call.id > at && call.method === 'sendMessage' && /23/.test(String(call.params.text))))
  const modelCalls = w.modelBodies.length
  w.say('/restart')
  await w.wait('/restart still exits the doctor', () => w.exited)
  expect(w.exitCode, w.output).toBe(0)
  expect(w.commandCalls().some((call) => call.name === 'systemctl' && (call.args.includes('start') || call.args.includes('restart')))).toBe(true)
  expect(readFileSync(w.state, 'utf8')).toBe('active')
  expect(w.modelBodies).toHaveLength(modelCalls)
  expect(cards, 'no confirmation can bypass missing isolation').toHaveLength(0)
  expect(answer).toMatch(/bwrap/i)
  expect(answer).toMatch(/отказ|недоступ|не запущ|невозможно/i)
  expect(w.commandCalls().filter((call) => call.name === 'git'), 'read-only git also stays unexecuted').toHaveLength(0)
  expect(existsSync(join(w.home, 'forbidden.txt'))).toBe(false)
})

test('test_h1_c9_env_file_names_mask_actual_process_values_regardless_of_name_or_systemd_escaping', { timeout: 30_000 }, async () => {
  const w = world = new SafetyWorld()
  // The first two represent systemd's continued/escaped assignments. The third
  // also catches a file changed after systemd populated the process environment.
  const secrets = ['northbridge-private-58021', 'folder with spaces-private-58021', 'runtime-neutral-58021', 'Ω']
  const envFile = [
    'CUSTOM_NOTE="north\\\nbridge-private-58021"',
    'CUSTOM_PATH=folder\\ with\\ spaces-private-58021',
    'RELEASE_LABEL=old-file-value-58021',
    'BRIEF_LABEL=old-file-symbol',
    '',
  ].join('\n')
  await w.start({ envFile, env: {
    CUSTOM_NOTE: secrets[0], CUSTOM_PATH: secrets[1], RELEASE_LABEL: secrets[2], BRIEF_LABEL: secrets[3],
  }, journal: `journal-visible\n${secrets.join('\n')}` })
  writeFileSync(join(w.home, 'diagnostic.txt'), `diagnostic-visible\n${secrets.join('\n')}`)
  w.modelSuffix = `model-visible\n${secrets.join('\n')}`
  await w.turn(['cat diagnostic.txt'], false, secrets.join(' '))
  expect(w.text()).toContain('journal-visible')
  expect(w.text()).toContain('diagnostic-visible')
  expect(w.text()).toContain('model-visible')
  expect(w.modelBodies.length, 'the tool result was sent back to the model').toBeGreaterThanOrEqual(2)
  for (const secret of secrets) {
    expect(JSON.stringify(w.calls.map((call) => call.params)), 'no Telegram payload leaks the runtime value').not.toContain(secret)
    expect(JSON.stringify(w.modelBodies), 'neither owner text nor bash output leaks into model requests').not.toContain(secret)
    expect(w.output, 'diagnostic logs do not leak the runtime value').not.toContain(secret)
  }
})

test('test_h1_c10_recovery_monitor_runs_before_a_stalled_startup_notification_is_delivered', { timeout: 20_000 }, async () => {
  const w = world = new SafetyWorld()
  await w.start({ holdNotice: true })
  expect(w.heldNotice?.writableEnded).toBe(false)
  const checks = () => w.commandCalls().filter((call) => call.name === 'systemctl' && call.args.includes('is-active')).length
  const before = checks()
  // Less than the Telegram request timeout: retrying a failed notice cannot
  // accidentally satisfy this check for an independently running monitor.
  await w.wait('active-state monitoring continues while the initial sendMessage is pending', () => checks() > before, 5_000)
  writeFileSync(w.state, 'active')
  await w.wait('the doctor exits without waiting for notice delivery', () => w.exited, 5_000)
  expect(w.exitCode, w.output).toBe(0)
  expect(w.heldNotice?.writableEnded, 'the fixture never delivered the notification').toBe(false)
})
