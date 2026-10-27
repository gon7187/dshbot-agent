// Black-box contract for the independent recovery unit. Like app/daemon.test.ts,
// this runs a child against local Bot API / Messages API doubles. The launch
// command comes from the shipped unit, not from an assumed doctor module name.
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const OWNER = 7123456
const STRANGER = 8123456
const TOKEN = '7000001:AAHRecoveryFixtureToken0123456789'
const KEY = 'sk-recovery-fixture-deepseek-0123456789'
const EXTRA_SECRET = 'recovery-fixture-archive-credential-987654321'
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Obj = Record<string, unknown>
type Unit = Map<string, string[]>

function object(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
}

function unit(name: string): Unit {
  const path = join(root, 'deploy', name)
  expect(existsSync(path), `recovery requires deploy/${name}`).toBe(true)
  const result: Unit = new Map()
  let section = ''
  for (const raw of readFileSync(path, 'utf8').replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) { section = header[1]!; continue }
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (!pair) continue
    const key = `${section}.${pair[1]!.trim()}`
    const values = result.get(key) ?? []
    if (pair[2] === '') result.set(key, [])
    else result.set(key, [...values, pair[2]!.trim()])
  }
  return result
}

function value(config: Unit, key: string): string {
  return config.get(key)?.at(-1) ?? ''
}

// Sufficient for systemd's quoted arguments, including Environment="KEY=value".
function words(text: string): string[] {
  return (text.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g) ?? [])
    .map((word) => word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, double: string | undefined, single: string | undefined) =>
      double === undefined ? single ?? '' : double.replace(/\\(["\\])/g, '$1')))
}

function environment(config: Unit): Obj {
  return Object.fromEntries((config.get('Service.Environment') ?? []).flatMap(words).map((entry) => {
    const at = entry.indexOf('=')
    return [entry.slice(0, at), entry.slice(at + 1)]
  }))
}

interface TgCall { method: string; params: Obj; id: number; path: string }
interface ModelCall { body: Obj; url: string; authorization: string; apiKey: string }
interface Plan { commands: string[]; answer: string }
interface Card { call: TgCall; allow: string; deny?: string }

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function json(res: ServerResponse, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result))
}

function toolResults(request: Obj): { id: string; text: string; error: boolean }[] {
  const results: { id: string; text: string; error: boolean }[] = []
  for (const raw of Array.isArray(request.messages) ? request.messages : []) {
    const message = object(raw)
    if (message.role === 'tool') results.push({ id: String(message.tool_call_id), text: String(message.content), error: false })
    if (Array.isArray(message.content)) for (const rawBlock of message.content) {
      const block = object(rawBlock)
      if (block.type === 'tool_result') results.push({ id: String(block.tool_use_id), text: JSON.stringify(block.content), error: block.is_error === true })
    }
  }
  return results
}

function bashTool(request: Obj): { name: string; schema: Obj } {
  const tools = (Array.isArray(request.tools) ? request.tools : []).map((raw) => {
    const tool = object(raw)
    const fn = object(tool.function)
    return { name: String(tool.name ?? fn.name ?? ''), schema: object(tool.input_schema ?? tool.parameters ?? fn.parameters) }
  })
  const found = tools.find((tool) => tool.name === 'bash')
  // Leave malformed requests visible to assertions in the test, rather than
  // throwing in an HTTP callback and turning a product failure into a timeout.
  return found ?? { name: 'bash', schema: {} }
}

function commandInput(request: Obj, command: string): Obj {
  const schema = bashTool(request).schema
  const properties = object(schema.properties)
  const key = Object.keys(properties).find((name) => /^(command|cmd|script|code)$/i.test(name))
    ?? Object.keys(properties).find((name) => /command|cmd/i.test(name))
    ?? 'command'
  return { [key]: command }
}

function respondModel(res: ServerResponse, request: Obj, content: Obj[], openai: boolean): void {
  const tool = content.find((block) => block.type === 'tool_use')
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  if (openai) {
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] }
      : { role: 'assistant', content: text }
    if (request.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, ...object((message as { tool_calls: Obj[] }).tool_calls[0]) }] } : { role: 'assistant', content: text }
      res.end(`data: ${JSON.stringify({ id: 'chat_fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } else json(res, { id: 'chat_fixture', object: 'chat.completion', model: 'deepseek-chat', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    return
  }
  const stop = tool ? 'tool_use' : 'end_turn'
  const message = { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-flash', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }
  if (request.stream !== true) { json(res, message); return }
  const event = (name: string, data: Obj) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const events = [event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })]
  content.forEach((block, index) => {
    events.push(event('content_block_start', { type: 'content_block_start', index, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } }))
    events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } }))
    events.push(event('content_block_stop', { type: 'content_block_stop', index }))
  })
  events.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }), event('message_stop', { type: 'message_stop' }))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.join(''))
}

class Recovery {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-recovery-')))
  userHome = join(this.scratch, 'user')
  home = join(this.userHome, '.local/share/dshbot')
  app = join(this.home, 'app')
  bin = join(this.scratch, 'bin')
  state = join(this.scratch, 'unit-state')
  commandLog = join(this.scratch, 'system-commands.jsonl')
  journal = Array.from({ length: 45 }, (_, index) => `journal-line-${String(index + 1).padStart(4, '0')}`)
  calls: TgCall[] = []
  models: ModelCall[] = []
  plans = new Map<string, Plan>()
  queue: Obj[] = []
  holders = new Map<ServerResponse, NodeJS.Timeout>()
  servers: Server[] = []
  outside: string[] = []
  child?: ChildProcess
  exited = false
  exitCode: number | null = null
  output = ''
  tgOrigin = ''
  modelOrigin = ''
  seq = 0
  private marker = 0

  async start(initial = 'failed'): Promise<void> {
    const config = unit('dshbot-doctor.service')
    const launch = value(config, 'Service.ExecStart')
    expect(launch, 'doctor unit provides a runnable ExecStart').not.toBe('')
    mkdirSync(this.app, { recursive: true })
    mkdirSync(this.bin)
    // Copy the deployed application tree with no installed dependencies and
    // no packages/app at all: recovery must survive a broken main daemon.
    cpSync(join(root, 'packages'), join(this.app, 'packages'), {
      recursive: true,
      filter: (source) => {
        const parts = relative(join(root, 'packages'), source).split(sep)
        return parts[0] !== 'app' && !parts.some((part) => part === 'node_modules' || part.startsWith('.') || part.endsWith('.test.ts'))
      },
    })
    for (const name of ['package.json', 'scripts', 'deploy']) {
      cpSync(join(root, name), join(this.app, name), { recursive: true, filter: (source) => !basename(source).startsWith('.env') })
    }
    const db = new DatabaseSync(join(this.home, 'state.db'))
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('telegram.owner_chat_id', String(OWNER))
    db.close()
    writeFileSync(this.state, initial)
    writeFileSync(this.commandLog, '')
    writeFileSync(join(this.scratch, 'journal'), this.journal.join('\n') + '\n')
    this.fakeCommands()
    await this.startServers()
    const expand = (text: string) => text.replaceAll('%h', this.userHome).replaceAll('%t', join(this.scratch, 'runtime'))
    const argv = words(expand(launch))
    expect(argv.length, 'ExecStart contains an executable').toBeGreaterThan(0)
    // The unit can use a machine-specific mise node path. Only its executable
    // location changes; its actual entry point and flags are exercised.
    if (basename(argv[0]!) === 'node') argv[0] = process.execPath
    const cwd = expand(value(config, 'Service.WorkingDirectory'))
    expect(cwd, 'the installed unit runs from the deployed app').toBe(this.app)
    const env: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(environment(config)).map(([key, val]) => [key, expand(String(val))])),
      HOME: this.userHome,
      PATH: [this.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      DSHBOT_HOME: this.home,
      TELEGRAM_BOT_TOKEN: TOKEN,
      DEEPSEEK_API_KEY: KEY,
      // This harness measures the post-window behaviour: the grace window of an
      // intentionally restarting unit is covered by restart-grace-window.test.ts.
      DSHBOT_DOCTOR_GRACE_MS: '1',
      ARCHIVE_CREDENTIAL: EXTRA_SECRET,
      TELEGRAM_API_ROOT: `${this.tgOrigin}/telegram-fixture`,
      DEEPSEEK_BASE_URL: `${this.modelOrigin}/model-fixture/anthropic`,
      NODE_COMPILE_CACHE: join(this.scratch, 'compile-cache'),
    }
    this.child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    this.child.stdout?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.output += chunk.toString() })
    this.child.on('error', (error) => { this.output += String(error); this.exited = true })
    this.child.on('close', (code) => { this.exited = true; this.exitCode = code })
  }

  private fakeCommands(): void {
    const preamble = `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(this.commandLog)}, JSON.stringify({cmd: require('node:path').basename(process.argv[1]), args, cwd: process.cwd()}) + '\\n');\n`
    writeFileSync(join(this.bin, 'systemctl'), preamble + `
const stateFile = ${JSON.stringify(this.state)};
const state = fs.readFileSync(stateFile, 'utf8').trim();
if (args.includes('is-active')) { console.log(state); process.exit(state === 'active' ? 0 : 3); }
if (args.includes('status')) { console.log('dshbot.service: ' + state + '\\nProcess: code=exited, status=23/FAILURE'); process.exit(state === 'active' ? 0 : 3); }
if (args.includes('show')) {
  const props = {ActiveState: state, SubState: state === 'active' ? 'running' : 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '23', StatusErrno: '0'};
  const selected = args.flatMap((a, i) => a === '-p' || a === '--property' ? [args[i + 1]] : a.startsWith('--property=') ? [a.slice(11)] : []).flatMap(a => String(a).split(','));
  console.log((selected.length ? selected : Object.keys(props)).map(p => args.includes('--value') ? (props[p] || '') : p + '=' + (props[p] || '')).join('\\n')); process.exit(0);
}
if (args.includes('reset-failed')) process.exit(0);
if (args.includes('start')) { fs.writeFileSync(stateFile, 'active'); process.exit(0); }
console.error('unexpected systemctl arguments'); process.exit(1);
`, { mode: 0o755 })
    writeFileSync(join(this.bin, 'journalctl'), preamble + `
const lines = fs.readFileSync(${JSON.stringify(join(this.scratch, 'journal'))}, 'utf8').trimEnd().split('\\n');
let count = lines.length;
args.forEach((a, i) => { if (a === '-n' || a === '--lines') count = Number(args[i + 1]); else if (/^--lines=/.test(a)) count = Number(a.slice(8)); else if (/^-n\\d+$/.test(a)) count = Number(a.slice(2)); });
console.log(lines.slice(-count).join('\\n'));
`, { mode: 0o755 })
  }

  private async startServers(): Promise<void> {
    const tg = createServer((req, res) => {
      void body(req).then((raw) => {
        const url = new URL(req.url ?? '/', 'http://fixture')
        let params: Obj = Object.fromEntries(url.searchParams)
        if (raw) {
          try { params = { ...params, ...object(JSON.parse(raw)) } }
          catch { params = { ...params, ...Object.fromEntries(new URLSearchParams(raw)) } }
        }
        const method = url.pathname.split('/').at(-1) ?? ''
        const call = { method, params, id: ++this.seq, path: url.pathname }
        this.calls.push(call)
        if (method === 'getUpdates') {
          if (this.queue.length) { json(res, { ok: true, result: this.queue.splice(0) }); return }
          const timeout = Number(params.timeout ?? 25)
          const timer = setTimeout(() => { this.holders.delete(res); if (!res.destroyed) json(res, { ok: true, result: [] }) }, Math.max(25, Math.min(timeout * 1000, 60_000)))
          this.holders.set(res, timer)
          res.on('close', () => { clearTimeout(timer); this.holders.delete(res) })
          return
        }
        if (method === 'getMe') { json(res, { ok: true, result: { id: 1, is_bot: true, first_name: 'Doctor', username: 'doctor_fixture_bot' } }); return }
        json(res, { ok: true, result: method.startsWith('send') || method.startsWith('edit') ? { message_id: call.id, date: 1, chat: { id: Number(params.chat_id), type: 'private' }, text: params.text ?? '' } : true })
      }).catch((error: unknown) => { this.output += `Telegram fixture: ${String(error)}`; res.destroy() })
    })
    this.servers.push(tg)
    this.tgOrigin = await listen(tg)
    const model = createServer((req, res) => {
      void body(req).then((raw) => {
        const request = object(JSON.parse(raw))
        this.models.push({ body: request, url: req.url ?? '', authorization: String(req.headers.authorization ?? ''), apiKey: String(req.headers['x-api-key'] ?? '') })
        const messages = Array.isArray(request.messages) ? request.messages : []
        const marker = [...messages].reverse().filter((message) => object(message).role === 'user')
          .map((message) => JSON.stringify(object(message).content).match(/doctor-case-\d+/)?.[0]).find(Boolean)
        const plan = marker ? this.plans.get(marker) : undefined
        const results = toolResults(request).filter((result) => result.id.startsWith(`call-${marker}-`))
        const index = results.length
        const command = plan?.commands[index]
        const content: Obj[] = command !== undefined ? [{ type: 'tool_use', id: `call-${marker}-${index}`, name: bashTool(request).name, input: commandInput(request, command) }]
          : [{ type: 'text', text: `${plan?.answer ?? 'doctor-fixture-answer'}\n${results.map((result) => result.text).join('\n')}` }]
        respondModel(res, request, content, (req.url ?? '').includes('chat/completions'))
      }).catch((error: unknown) => { this.output += `Model fixture: ${String(error)}`; res.destroy() })
    })
    this.servers.push(model)
    this.modelOrigin = await listen(model)
  }

  push(update: Obj): void {
    this.queue.push({ update_id: ++this.seq, ...update })
    const holder = this.holders.keys().next().value as ServerResponse | undefined
    if (!holder) return
    clearTimeout(this.holders.get(holder))
    this.holders.delete(holder)
    json(holder, { ok: true, result: this.queue.splice(0) })
  }

  say(text: string, chat = OWNER): void {
    this.push({ message: { message_id: ++this.seq, date: Math.floor(Date.now() / 1000), from: { id: chat, is_bot: false, first_name: 'Fixture' }, chat: { id: chat, type: 'private' }, text } })
  }

  press(card: Card, data = card.allow, chat = OWNER): void {
    this.push({ callback_query: { id: `callback-${++this.seq}`, from: { id: chat, is_bot: false, first_name: 'Fixture' }, chat_instance: 'fixture', data, message: { message_id: Number(card.call.params.message_id ?? card.call.id), date: 1, chat: { id: OWNER, type: 'private' }, text: card.call.params.text ?? '' } } })
  }

  sent(chat = OWNER): TgCall[] {
    return this.calls.filter((call) => /^send|^editMessage/.test(call.method) && Number(call.params.chat_id) === chat)
  }

  text(chat = OWNER): string { return this.sent(chat).map((call) => String(call.params.text ?? '')).join('\n') }

  cards(after = 0): Card[] {
    return this.sent().filter((call) => call.id > after).flatMap((call) => {
      const markup = typeof call.params.reply_markup === 'string' ? object(JSON.parse(call.params.reply_markup)) : object(call.params.reply_markup)
      const buttons = (Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard.flat() : []).map(object)
      const allow = buttons.find((button) => /разрешить|allow/i.test(String(button.text)) && !/не\s*разреш|not\s+allow/i.test(String(button.text)))
      if (!allow || typeof allow.callback_data !== 'string') return []
      const deny = buttons.find((button) => /отказ|отклон|запрет|отмен|не разреш|deny|reject|cancel|^нет$/i.test(String(button.text)) && button !== allow)
      return [{ call, allow: allow.callback_data, deny: typeof deny?.callback_data === 'string' ? deny.callback_data : undefined }]
    })
  }

  plan(commands: string[] = []): string {
    const marker = `doctor-case-${++this.marker}`
    this.plans.set(marker, { commands, answer: `answer-${marker}` })
    this.say(`${marker} Помоги восстановить основной бот`)
    return marker
  }

  results(marker: string): { id: string; text: string; error: boolean }[] {
    const byId = new Map<string, { id: string; text: string; error: boolean }>()
    for (const call of this.models) for (const result of toolResults(call.body)) {
      if (result.id.startsWith(`call-${marker}-`)) byId.set(result.id, result)
    }
    return [...byId.values()]
  }

  async wait(label: string, predicate: () => boolean, timeout = 15_000, allowExited = false): Promise<void> {
    const until = Date.now() + timeout
    while (!predicate() && (!this.exited || allowExited) && Date.now() < until) await sleep(25)
    expect(predicate(), `${label}; exited=${this.exited}, code=${this.exitCode}\n${this.output}`).toBe(true)
  }

  async ready(): Promise<void> { await this.wait('doctor starts polling', () => this.calls.some((call) => call.method === 'getUpdates')) }
  async finished(marker: string): Promise<void> { await this.wait(`model reply for ${marker}`, () => this.text().includes(`answer-${marker}`)) }
  commands(): { cmd: string; args: string[]; cwd: string }[] {
    return readFileSync(this.commandLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { cmd: string; args: string[]; cwd: string })
  }

  async close(): Promise<void> {
    if (this.child?.pid) {
      try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already exited */ }
      if (!this.exited) await new Promise<void>((resolve) => this.child!.once('close', () => resolve()))
    }
    for (const timer of this.holders.values()) clearTimeout(timer)
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    for (const path of this.outside) rmSync(path, { recursive: true, force: true })
    rmSync(this.scratch, { recursive: true, force: true })
  }
}

let recovery: Recovery | undefined
afterEach(async () => { await recovery?.close(); recovery = undefined })

async function start(initial = 'failed'): Promise<Recovery> {
  recovery = new Recovery()
  await recovery.start(initial)
  return recovery
}

function quote(path: string): string { return `'${path.replaceAll("'", "'\\''")}'` }

test('test_c1_units_wire_independent_recovery_with_the_same_home_and_environment', () => {
  const main = unit('dshbot.service')
  expect((main.get('Unit.OnFailure') ?? []).flatMap(words)).toContain('dshbot-doctor.service')
  const doctor = unit('dshbot-doctor.service')
  expect(value(doctor, 'Service.WorkingDirectory')).toBe(value(main, 'Service.WorkingDirectory'))
  expect(value(doctor, 'Service.WorkingDirectory')).not.toBe('')
  expect(doctor.get('Service.EnvironmentFile')).toEqual(main.get('Service.EnvironmentFile'))
  expect(doctor.get('Service.EnvironmentFile')?.length).toBeGreaterThan(0)
  expect(environment(doctor).DSHBOT_HOME).toBe(environment(main).DSHBOT_HOME)
  expect(environment(doctor).DSHBOT_HOME).toBeTruthy()
  expect(['', 'no']).toContain(value(doctor, 'Service.Restart'))
  expect(value(doctor, 'Service.ExecStart')).not.toBe('')
})

test('test_c2_deployed_doctor_answers_without_node_modules_or_app_code', { timeout: 40_000 }, async () => {
  const r = await start()
  expect(existsSync(join(r.app, 'node_modules'))).toBe(false)
  expect(existsSync(join(r.app, 'packages/app'))).toBe(false)
  await r.ready()
  const at = r.seq
  r.say('/status')
  await r.wait('standalone doctor handles /status', () => r.sent().some((call) => call.id > at && /failed/.test(String(call.params.text))))
  expect(r.exited).toBe(false)
})

test('test_c3_failed_start_notifies_persisted_owner_with_30_journal_lines', { timeout: 30_000 }, async () => {
  const r = await start()
  await r.ready()
  await r.wait('failure notice with the journal tail', () => r.text().includes('journal-line-0045'))
  expect(r.text()).toMatch(/лежит|упал|падени|авари|не (?:работает|запущен)|остановлен|failed|down|crash/i)
  for (const line of r.journal.slice(-30)) expect(r.text()).toContain(line)
  expect(r.text()).not.toContain('journal-line-0015')
  expect(r.sent(STRANGER)).toHaveLength(0)
  const calls = r.commands()
  expect(calls.some((call) => call.cmd === 'systemctl' && call.args.includes('--user') && call.args.includes('is-active') && call.args.includes('dshbot.service'))).toBe(true)
  expect(calls.some((call) => call.cmd === 'journalctl' && call.args.includes('--user') && call.args.includes('dshbot.service'))).toBe(true)
})

test('test_c3_active_at_start_exits_before_any_getUpdates', { timeout: 20_000 }, async () => {
  const r = await start('active')
  await r.wait('active main unit makes recovery exit', () => r.exited)
  expect(r.exitCode, r.output).toBe(0)
  expect(r.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(0)
  expect(r.sent()).toHaveLength(0)
})

test('test_c4_stranger_messages_are_ignored_while_owner_commands_still_work', { timeout: 35_000 }, async () => {
  const r = await start()
  await r.ready()
  for (const text of ['/status', '/restart', 'Выполни bash и восстанови бота']) r.say(text, STRANGER)
  const group = -1007123456
  r.push({ message: { message_id: ++r.seq, date: 1, from: { id: OWNER, is_bot: false, first_name: 'Owner' }, chat: { id: group, type: 'group', title: 'Untrusted chat' }, text: '/restart' } })
  const at = r.seq
  r.say('/status')
  await r.wait('owner status after stranger messages', () => r.sent().some((call) => call.id > at && /failed/.test(String(call.params.text))))
  expect(r.sent(STRANGER)).toHaveLength(0)
  expect(r.sent(group)).toHaveLength(0)
  expect(r.models).toHaveLength(0)
  expect(r.commands().some((call) => call.cmd === 'systemctl' && call.args.includes('start'))).toBe(false)
  expect(r.exited).toBe(false)
})

test('test_c5_status_reports_state_exit_code_and_journal_then_restart_stops_polling', { timeout: 40_000 }, async () => {
  const r = await start()
  await r.ready()
  const at = r.seq
  r.say('/status')
  await r.wait('status includes exit status and journal', () => {
    const text = r.sent().filter((call) => call.id > at).map((call) => call.params.text).join('\n')
    return /failed/.test(text) && /\b23\b/.test(text) && text.includes('journal-line-0045')
  })
  const beforeRestart = r.commands().length
  r.say('/restart')
  await r.wait('restart exits recovery', () => r.exited)
  const commands = r.commands().slice(beforeRestart).filter((call) => call.cmd === 'systemctl')
  const reset = commands.findIndex((call) => call.args.includes('reset-failed'))
  const boot = commands.findIndex((call) => call.args.includes('start'))
  expect(reset).toBeGreaterThanOrEqual(0)
  expect(boot).toBeGreaterThan(reset)
  for (const index of [reset, boot]) {
    expect(commands[index]!.args).toContain('--user')
    expect(commands[index]!.args).toContain('dshbot.service')
  }
  expect(r.exitCode, r.output).toBe(0)
  const polls = r.calls.filter((call) => call.method === 'getUpdates').length
  await sleep(150)
  expect(r.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(polls)
})

test('test_c6_owner_text_calls_DeepSeek_with_only_bash_and_delivers_the_answer', { timeout: 40_000 }, async () => {
  const r = await start()
  await r.ready()
  const marker = r.plan()
  await r.finished(marker)
  expect(r.models.length).toBeGreaterThan(0)
  const request = r.models[0]!
  expect(request.authorization === `Bearer ${KEY}` || request.apiKey === KEY, 'the direct API call authenticates with DEEPSEEK_API_KEY').toBe(true)
  expect(request.body.model).toMatch(/deepseek/i)
  expect(JSON.stringify(request.body.messages)).toContain(marker)
  const tools = Array.isArray(request.body.tools) ? request.body.tools : []
  expect(tools).toHaveLength(1)
  expect(bashTool(request.body).name).toBe('bash')
  expect(object(tools[0]).name ?? object(object(tools[0]).function).name).toBe('bash')
})

test('test_c7_read_only_bash_is_immediate_and_mutation_requires_the_owner_allow_button', { timeout: 120_000 }, async () => {
  const r = await start()
  await r.ready()
  writeFileSync(join(r.home, 'diagnostic.txt'), 'read-only-diagnostic-marker\n')
  const reads = [
    'journalctl --user -u dshbot.service -n 2', 'systemctl --user status dshbot.service',
    'systemctl --user is-active dshbot.service', 'cat diagnostic.txt', 'ls',
    'tail -n 1 diagnostic.txt', 'grep marker diagnostic.txt',
  ]
  const cardStart = r.seq
  const expected = ['journal-line-0045', 'failed', 'failed', 'read-only-diagnostic-marker', 'diagnostic.txt',
    'read-only-diagnostic-marker', 'read-only-diagnostic-marker']
  for (const [index, command] of reads.entries()) {
    const readonly = r.plan([command])
    await r.finished(readonly)
    expect(r.results(readonly), command).toHaveLength(1)
    expect(r.results(readonly)[0]!.text, command).toContain(expected[index])
  }
  expect(r.cards(cardStart), 'read-only commands do not ask permission').toHaveLength(0)

  const mutations = [
    (target: string) => `printf approved > ${quote(target)}`,
    (target: string) => `cat diagnostic.txt > ${quote(target)}`,
    (target: string) => `ls; printf approved > ${quote(target)}`,
    (target: string) => `cat "$(printf approved > ${quote(target)}; printf diagnostic.txt)"`,
  ]
  for (const [index, command] of mutations.entries()) {
    const target = join(r.home, `approved-${index}.txt`)
    const before = r.seq
    const marker = r.plan([command(target)])
    await r.wait('mutation confirmation card', () => r.cards(before).length > 0 || existsSync(target))
    expect(existsSync(target), 'no execution before approval, including redirects and nested shell commands').toBe(false)
    expect(r.cards(before)).not.toHaveLength(0)
    const card = r.cards(before)[0]!
    await sleep(300)
    expect(existsSync(target), 'showing the card alone does not execute the command').toBe(false)
    r.press(card, card.allow, STRANGER)
    await sleep(300)
    expect(existsSync(target), 'a stranger cannot grant permission using a valid callback').toBe(false)
    expect(r.sent(STRANGER)).toHaveLength(0)
    r.press(card)
    await r.finished(marker)
    await r.wait('the owner approval executes the proposed command', () => existsSync(target))
    expect(readFileSync(target, 'utf8')).toBe(index === 1 ? 'read-only-diagnostic-marker\n' : 'approved')
  }

  const denied = join(r.home, 'unapproved.txt')
  const beforeDeny = r.seq
  const refused = r.plan([`printf unapproved > ${quote(denied)}`])
  await r.wait('second mutation card', () => r.cards(beforeDeny).length > 0)
  const deniedCard = r.cards(beforeDeny)[0]!
  // A rejection button (when provided) avoids waiting for card expiry. At no
  // point is the allow button pressed for this command.
  if (deniedCard.deny) r.press(deniedCard, deniedCard.deny)
  await r.wait('model receives refusal without an allow click', () => r.results(refused).length > 0, 60_000)
  const result = r.results(refused)[0]!
  expect(result.error || /отказ|отклон|отмен|запрещ|не разреш|не выполн|denied|declin|reject|cancel|not (?:approved|allowed)|expir|ист[её]к|(?:pending|require).{0,30}(?:approv|confirm)|(?:approv|confirm).{0,30}(?:required|pending)|ожида.{0,30}(?:подтверж|разреш)|требуется.{0,20}подтверж/i.test(result.text)).toBe(true)
  expect(existsSync(denied)).toBe(false)
})

test('test_c8_bash_cwd_and_confirmed_writes_stay_inside_home_or_tmp', { timeout: 100_000 }, async () => {
  const r = await start()
  await r.ready()
  writeFileSync(join(r.home, 'relative-cwd.txt'), 'relative-cwd-proof-marker')
  const cwd = r.plan(['cat relative-cwd.txt'])
  await r.finished(cwd)
  expect(r.results(cwd).map((result) => result.text).join('\n')).toContain('relative-cwd-proof-marker')
  const tmpTarget = join(r.scratch, 'allowed-tmp.txt')
  const tmpAt = r.seq
  const tmp = r.plan([`printf tmp-allowed > ${quote(tmpTarget)}`])
  await r.wait('tmp write approval', () => r.cards(tmpAt).length > 0)
  r.press(r.cards(tmpAt)[0]!)
  await r.finished(tmp)
  await r.wait('confirmed command can write in /tmp', () => existsSync(tmpTarget))
  expect(readFileSync(tmpTarget, 'utf8')).toBe('tmp-allowed')

  // A temp directory under /tmp would be an ALLOWED target, so create the
  // protected disposable file on a writable filesystem outside /tmp instead.
  let outside = ''
  for (const candidate of [root, homedir(), '/var/tmp', '/dev/shm']) {
    try {
      const parent = realpathSync(candidate)
      if (parent === '/tmp' || parent.startsWith('/tmp/')) continue
      outside = realpathSync(mkdtempSync(join(parent, '.doctor-recovery-')))
      break
    } catch { /* try the next writable location, as in host-exec-write-protection.test.ts */ }
  }
  expect(outside, 'fixture must be writable and actually outside /tmp').not.toBe('')
  r.outside.push(outside)
  const protectedFile = join(outside, 'keep.txt')
  writeFileSync(protectedFile, 'protected-original')
  const link = join(r.home, 'outside-link')
  symlinkSync(outside, link)
  for (const command of [
    `printf changed > ${quote(protectedFile)}`,
    `rm -f ${quote(protectedFile)}`,
    `printf changed > ${quote(join(link, 'keep.txt'))}`,
    `cat diagnostic-missing 2>/dev/null; printf changed > ${quote(protectedFile)}`,
    `${quote(process.execPath)} -e ${quote(`require('node:fs').writeFileSync(${JSON.stringify(protectedFile)}, 'changed')`)}`,
  ]) {
    const at = r.seq
    const marker = r.plan([command])
    await r.wait('outside write is refused or requires confirmation', () => r.results(marker).length > 0 || r.cards(at).length > 0)
    if (r.cards(at).length) r.press(r.cards(at)[0]!)
    await r.finished(marker)
    expect(existsSync(protectedFile), 'confirmation cannot authorize deleting outside the permitted roots').toBe(true)
    expect(readFileSync(protectedFile, 'utf8'), 'confirmation cannot authorize changing outside the permitted roots').toBe('protected-original')
    const result = r.results(marker)[0]
    expect(result, 'the model receives a tool result for the refused command').toBeDefined()
  }
})

test('test_c9_journal_and_command_output_mask_all_fixture_credentials_before_delivery', { timeout: 45_000 }, async () => {
  // start() writes the journal before starting the child; alter the public
  // fixture lines before it is launched, never read a real env-file.
  recovery = new Recovery()
  recovery.journal[44] = `journal-line-0045 token=${TOKEN} key=${KEY} archive=${EXTRA_SECRET}`
  const r = recovery
  await r.start()
  await r.ready()
  await r.wait('startup journal delivered', () => r.text().includes('journal-line-0045'))
  writeFileSync(join(r.home, 'diagnostic.txt'), `safe-command-output\n${TOKEN}\n${KEY}\n${EXTRA_SECRET}\n`)
  mkdirSync(join(r.home, 'stderr-fixture', KEY), { recursive: true })
  const marker = r.plan(['cat diagnostic.txt', 'journalctl --user -u dshbot.service -n 1', 'cat stderr-fixture/*'])
  await r.finished(marker)
  expect(r.results(marker)).toHaveLength(3)
  expect(r.results(marker)[0]!.text).toContain('safe-command-output')
  expect(r.results(marker)[2]!.text).toContain('stderr-fixture')
  for (const secret of [TOKEN, KEY, EXTRA_SECRET]) {
    expect(JSON.stringify(r.sent().map((call) => call.params)), 'Telegram message payloads are scrubbed').not.toContain(secret)
    expect(JSON.stringify(r.models.map((call) => call.body)), 'model request bodies are scrubbed, authentication stays in headers').not.toContain(secret)
  }
})

test('test_c10_main_recovery_aborts_long_poll_and_exits_within_30_seconds', { timeout: 50_000 }, async () => {
  const r = await start()
  await r.ready()
  await r.wait('an outstanding Telegram long poll', () => r.holders.size > 0)
  const becameActive = Date.now()
  writeFileSync(r.state, 'active')
  await r.wait('doctor exits after main becomes active', () => r.exited, 30_500)
  expect(Date.now() - becameActive).toBeLessThanOrEqual(30_500)
  expect(r.exitCode, r.output).toBe(0)
  await r.wait('long poll connection closes', () => r.holders.size === 0, 5_000, true)
  const polls = r.calls.filter((call) => call.method === 'getUpdates').length
  await sleep(150)
  expect(r.calls.filter((call) => call.method === 'getUpdates')).toHaveLength(polls)
})

test('test_c11_telegram_and_model_use_the_main_daemon_endpoint_variables', { timeout: 40_000 }, async () => {
  const r = await start()
  await r.ready()
  const marker = r.plan()
  await r.finished(marker)
  expect(r.calls.some((call) => call.method === 'getUpdates')).toBe(true)
  expect(r.calls.some((call) => call.method === 'sendMessage')).toBe(true)
  for (const call of r.calls) expect(decodeURIComponent(call.path)).toBe(`/telegram-fixture/bot${TOKEN}/${call.method}`)
  expect(r.models.length).toBeGreaterThan(0)
  for (const call of r.models) expect(call.url).toMatch(/^\/model-fixture\/anthropic\//)
})
