// Exercise the installer against disposable local repositories, as adopt-script.test.ts does.
// npm/systemd/Telegram are doubles: no dependencies are installed, no daemon or network is started.
// Env-files below are created by these fixtures; no developer credentials are read.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const installer = join(repo, 'scripts/install.sh')
const bash = '/bin/bash'
const token = '7000001:AAInstallerFixtureToken0123456789'
const key = 'sk-installer-fixture-deepseek-0123456789'
const pairingCode = '7A2B9C'
const oldPairingCode = 'A1B2C3'
const oldInvocation = '11111111111111111111111111111111'
const currentInvocation = '22222222222222222222222222222222'
const units = ['dshbot.service', 'dshbot-doctor.service']
const russian = /[А-Яа-яЁё]/
const privatePrompt = /(?:напиш|отправ|пришл)[^\n]{0,150}(?:бот|лич)|(?:бот|лич)[^\n]{0,150}(?:напиш|отправ|пришл)|(?:send|write)[^\n]{0,100}(?:bot|private)/i
const identity = {
  GIT_AUTHOR_NAME: 'Installer test', GIT_AUTHOR_EMAIL: 'installer@example.invalid',
  GIT_COMMITTER_NAME: 'Installer test', GIT_COMMITTER_EMAIL: 'installer@example.invalid',
}

interface Call { cmd: string; args: string[]; cwd: string; active?: boolean }
interface Fixture {
  root: string; home: string; data: string; app: string; source: string; bin: string
  envFile: string; unitDir: string; log: string; env: NodeJS.ProcessEnv
}
interface RunOptions { input?: string; env?: NodeJS.ProcessEnv }

let suite: string
let tools: string
let realGit: string
let realRm: string
const fixtures: Fixture[] = []
const children = new Set<ChildProcess>()

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function quote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'` }

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-installer-test-')))
  tools = join(suite, 'tools')
  mkdirSync(tools)
  realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  realRm = execFileSync('/bin/sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).trim()
  // Like container-launcher.test.ts: construct a PATH where a missing prerequisite
  // really is absent, even on hosts with several toolchain directories.
  const replaced = new Set(['node', 'npm', 'npx', 'git', 'bwrap', 'sudo', 'systemctl', 'journalctl', 'loginctl', 'rm', 'curl', 'wget'])
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), '/usr/bin', '/bin']) {
    if (!dir || !existsSync(dir)) continue
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (replaced.has(name)) continue
      try { symlinkSync(join(dir, name), join(tools, name)) } catch { /* earlier PATH entry wins */ }
    }
  }
})

afterEach(() => {
  for (const child of children) {
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
  }
  children.clear()
  for (const f of fixtures.splice(0)) rmSync(f.root, { recursive: true, force: true })
})

afterAll(() => { if (suite) rmSync(suite, { recursive: true, force: true }) })

function fake(f: Fixture, name: string, body: string): void {
  writeFileSync(join(f.bin, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({cmd: ${JSON.stringify(name)}, args, cwd: process.cwd()}) + '\\n');
${body}
`, { mode: 0o755 })
}

function git(f: Fixture, cwd: string, ...args: string[]): string {
  return execFileSync(realGit, args, { cwd, env: f.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function fixture(): Fixture {
  const root = mkdtempSync(join(suite, 'case-'))
  const home = join(root, 'home')
  const data = join(home, '.local/share/dshbot')
  const f: Fixture = {
    root, home, data, app: join(data, 'app'), source: join(root, 'source'), bin: join(root, 'bin'),
    envFile: join(home, '.config/dshbot/dshbot.env'), unitDir: join(home, '.config/systemd/user'),
    log: join(root, 'commands.jsonl'), env: {},
  }
  fixtures.push(f)
  for (const dir of [home, f.source, f.bin, join(root, 'tmp')]) mkdirSync(dir, { recursive: true })
  writeFileSync(f.log, '')
  f.env = {
    PATH: [f.bin, tools].join(delimiter), HOME: home, TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    USER: userInfo().username, LOGNAME: userInfo().username, LANG: 'C.UTF-8',
    DSHBOT_INSTALL_SRC: f.source, TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key, DSHBOT_ISOLATION: 'container', DSHBOT_SANDBOX_TOOLKIT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'global-gitconfig'),
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', ...identity,
  }
  symlinkSync(realGit, join(f.bin, 'git'))
  // realpath(node) points to a shim, while node -p process.execPath points to Node.
  writeFileSync(join(f.bin, 'mise'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 })
  symlinkSync(join(f.bin, 'mise'), join(f.bin, 'node'))
  fake(f, 'npm', "if (args.includes('--version') || args.includes('-v')) console.log('11.0.0');")
  fake(f, 'systemctl', `
const stateFile = ${JSON.stringify(join(root, 'service-state.json'))};
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {active: false, enabled: false};
if (args.includes('is-active')) { console.log(state.active ? 'active' : 'inactive'); process.exit(state.active ? 0 : 3); }
if (args.includes('is-enabled')) { console.log(state.enabled ? 'enabled' : 'disabled'); process.exit(state.enabled ? 0 : 1); }
if (args.includes('enable')) { state.enabled = true; if (args.includes('--now')) { state.active = true; state.started = true; state.invocation = ${JSON.stringify(currentInvocation)}; } }
if (args.includes('disable')) { state.enabled = false; if (args.includes('--now')) state.active = false; }
if (args.includes('start') || args.includes('restart')) { state.active = true; state.started = true; state.invocation = ${JSON.stringify(currentInvocation)}; }
if (args.includes('show') && args.includes('dshbot.service')) console.log(args.includes('--value') ? (state.invocation || ${JSON.stringify(oldInvocation)}) : 'InvocationID=' + (state.invocation || ${JSON.stringify(oldInvocation)}));
if (args.includes('stop')) {
  if (process.env.TEST_STOP === 'fail') { console.error('Failed to stop dshbot.service'); process.exit(1); }
  if (process.env.TEST_STOP !== 'ignored') state.active = false;
}
fs.writeFileSync(stateFile, JSON.stringify(state));
if (args.includes('show-environment')) console.log('');
`)
  fake(f, 'loginctl', `
if (args.includes('show-user')) {
  const v = process.env.TEST_LINGER || 'yes';
  console.log(args.includes('--value') ? v : 'Linger=' + v);
}
`)
  fake(f, 'journalctl', `
const stateFile = ${JSON.stringify(join(root, 'service-state.json'))};
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.reads += 1;
fs.writeFileSync(stateFile, JSON.stringify(state));
// The old process's journal survives removal of the app and its data. The new
// process has no pairing code on the first read (no private message yet).
const old = {invocation: ${JSON.stringify(oldInvocation)}, time: Date.UTC(2000, 0, 1), code: ${JSON.stringify(oldPairingCode)}};
const current = {invocation: state.invocation, time: Date.now(), code: ${JSON.stringify(pairingCode)}};
const field = args.find(a => a.startsWith('_SYSTEMD_INVOCATION_ID='));
const invocationOption = args.find(a => a.startsWith('--invocation='));
const invocationIndex = args.findIndex(a => a === '--invocation' || a === '-I');
const invocation = field ? field.split('=')[1] : invocationOption ? invocationOption.split('=')[1] :
  invocationIndex >= 0 ? args[invocationIndex + 1] : undefined;
const sinceOption = args.find(a => a.startsWith('--since='));
const sinceIndex = args.findIndex(a => a === '--since' || a === '-S');
const since = sinceOption ? sinceOption.slice('--since='.length) : sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;
const cutoff = since === undefined ? -Infinity : since === 'now' ? Date.now() :
  since.startsWith('@') ? Number(since.slice(1)) * 1000 : Date.parse(since);
function emit(row) {
  if (invocation !== undefined && invocation !== row.invocation) return;
  if (!(row.time >= cutoff)) return;
  console.log('host dshbot[42]: pairing code for private chat 987654321: ' + row.code);
}
emit(old);
if (state.started && state.reads >= 2) emit(current);
else if (state.started && (args.includes('-f') || args.includes('--follow'))) {
  setTimeout(() => emit({...current, time: Date.now()}), 50);
}
`)
  fake(f, 'bwrap', "if (args.includes('--version')) console.log('bubblewrap 0.11.0');")
  for (const name of ['sudo', 'curl', 'wget']) fake(f, name, "console.error('unexpected external action in installer fixture'); process.exit(91);")
  // Guard the harness itself when testing rejected purge paths. Any attempted
  // deletion is logged; the tests assert that unsafe targets never reach rm.
  fake(f, 'rm', `
const path = require('node:path');
for (const arg of args.filter(a => a && !a.startsWith('-'))) {
  const target = path.resolve(arg);
  if (!target.startsWith(${JSON.stringify(root + sep)})) {
    console.error('fixture refuses removal outside its temporary directory'); process.exit(92);
  }
}
const r = require('node:child_process').spawnSync(${JSON.stringify(realRm)}, args, {stdio: 'inherit'});
process.exit(r.status === null ? 93 : r.status);
`)
  // Copy product sources explicitly, never the checkout's metadata, env-files,
  // installed dependencies or the factory's files. Git belongs to this fixture.
  for (const entry of ['scripts', 'deploy', 'packages/app/register.mjs', 'package.json', 'package-lock.json']) {
    cpSync(join(repo, entry), join(f.source, entry), {
      recursive: true,
      filter: (path) => !basename(path).startsWith('.env') && basename(path) !== 'node_modules' && !path.endsWith('.test.ts'),
    })
  }
  put(join(f.source, '.gitignore'), 'node_modules/\n')
  put(join(f.source, 'installer-fixture.txt'), 'initial product revision\n')
  git(f, f.source, 'init', '-q', '-b', 'main')
  git(f, f.source, 'add', '-A')
  git(f, f.source, 'commit', '-q', '-m', 'initial fixture')
  return f
}

function run(f: Fixture, args: string[] = ['--yes'], options: RunOptions = {}) {
  // Missing implementation must be an assertion failure, never ENOENT/import failure.
  expect(existsSync(installer), 'installer must implement the command exercised below').toBe(true)
  const result = spawnSync(bash, [installer, ...args], {
    cwd: f.root, env: { ...f.env, ...options.env }, input: options.input ?? '',
    encoding: 'utf8', timeout: 125_000,
  })
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function success(result: { error?: Error; status: number | null; output: string }): void {
  expect(result.error, result.output).toBeUndefined()
  expect(result.status, result.output).toBe(0)
}

function calls(f: Fixture, cmd?: string): Call[] {
  const all = readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call)
  return cmd === undefined ? all : all.filter((call) => call.cmd === cmd)
}

function system(f: Fixture, action: string, unit?: string): boolean {
  return calls(f, 'systemctl').some(({ args }) => args.includes('--user') &&
    (args.includes(action) || (action === 'stop' && args.includes('disable') && args.includes('--now')) ||
      (action === 'start' && args.includes('enable') && args.includes('--now'))) &&
    (unit === undefined || args.includes(unit)))
}

// Systemd accepts bare, single-quoted and double-quoted values. Fixture secrets
// deliberately need no exotic escaping; don't source the generated file in a shell.
function envValues(f: Fixture): Record<string, string> {
  expect(existsSync(f.envFile), 'installer writes its own env-file').toBe(true)
  return Object.fromEntries(readFileSync(f.envFile, 'utf8').split(/\r?\n/).flatMap((raw) => {
    const match = /^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/.exec(raw)
    if (!match) return []
    let value = match[2]!
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return [[match[1]!, value.replace(/\\([\\"])/g, '$1')]]
  }))
}

function unitValues(path: string): Map<string, string[]> {
  expect(existsSync(path), `unit exists: ${path}`).toBe(true)
  let section = ''
  const result = new Map<string, string[]>()
  for (const raw of readFileSync(path, 'utf8').replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header) { section = header[1]!; continue }
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (pair) {
      const name = `${section}.${pair[1]!.trim()}`
      result.set(name, [...(result.get(name) ?? []), pair[2]!.trim()])
    }
  }
  return result
}

function words(text: string): string[] {
  return (text.match(/(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'])+/g) ?? []).map((word) =>
    word.replace(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g, (_, double: string | undefined, single: string | undefined) =>
      double === undefined ? single ?? '' : double.replace(/\\(["\\])/g, '$1')))
}

function installed(f: Fixture): void { success(run(f)) }

function updateSource(f: Fixture): string {
  put(join(f.source, 'upstream.txt'), 'new upstream product revision\n')
  put(join(f.source, 'installer-fixture.txt'), 'updated product revision\n')
  git(f, f.source, 'add', '-A')
  git(f, f.source, 'commit', '-q', '-m', 'upstream update')
  return git(f, f.source, 'rev-parse', 'HEAD')
}

function memory(f: Fixture, data = f.data): void {
  put(join(data, 'state.db'), 'fixture database bytes\n')
  put(join(data, 'memory/keep.txt'), 'irreplaceable fixture memory\n')
}

test('test_c3_reinstall_updates_code_runs_ci_restarts_and_preserves_env_and_memory', { timeout: 30_000 }, () => {
  const f = fixture()
  success(run(f))
  expect(readFileSync(join(f.app, 'installer-fixture.txt'), 'utf8')).toBe('initial product revision\n')
  expect(calls(f, 'npm').some((call) => call.cwd === f.app && call.args.includes('ci'))).toBe(true)
  expect(envValues(f)).toMatchObject({ TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key, DSHBOT_ISOLATION: 'container' })
  expect(statSync(f.envFile).mode & 0o777).toBe(0o600)
  for (const name of units) {
    const source = unitValues(join(f.source, 'deploy', name))
    const deployed = unitValues(join(f.unitDir, name))
    for (const field of ['Unit.Description', 'Service.Type', 'Service.WorkingDirectory', 'Service.EnvironmentFile']) {
      expect(deployed.get(field), `${name}: ${field}`).toEqual(source.get(field))
    }
  }
  expect(system(f, 'daemon-reload')).toBe(true)
  expect(calls(f, 'systemctl').some(({ args }) =>
    args.includes('--user') && args.includes('enable') && args.includes('--now') && args.includes('dshbot.service'))).toBe(true)
  const commands = calls(f)
  const reload = commands.findIndex(({ cmd, args }) => cmd === 'systemctl' && args.includes('daemon-reload'))
  const enable = commands.findIndex(({ cmd, args }) => cmd === 'systemctl' && args.includes('enable') && args.includes('dshbot.service'))
  expect(reload).toBeLessThan(enable)
  memory(f)
  const original = readFileSync(f.envFile, 'utf8') + '\n# owner customisation\nOWNER_SETTING=keep-me\n'
  writeFileSync(f.envFile, original)
  const npmBefore = calls(f, 'npm').length
  writeFileSync(f.log, '')
  const sha = updateSource(f)
  success(run(f, ['--yes'], { env: { TELEGRAM_BOT_TOKEN: 'replacement-token', DEEPSEEK_API_KEY: 'replacement-key', DSHBOT_ISOLATION: 'host' } }))
  expect(git(f, f.app, 'rev-parse', 'HEAD')).toBe(sha)
  expect(readFileSync(join(f.app, 'upstream.txt'), 'utf8')).toBe('new upstream product revision\n')
  expect(npmBefore).toBeGreaterThan(0)
  expect(calls(f, 'npm').filter((call) => call.cwd === f.app && call.args.includes('ci'))).not.toHaveLength(0)
  expect(system(f, 'restart', 'dshbot.service') || (system(f, 'stop', 'dshbot.service') && system(f, 'start', 'dshbot.service'))).toBe(true)
  expect(readFileSync(f.envFile, 'utf8')).toBe(original)
  expect(statSync(f.envFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(join(f.data, 'state.db'), 'utf8')).toBe('fixture database bytes\n')
  expect(readFileSync(join(f.data, 'memory/keep.txt'), 'utf8')).toBe('irreplaceable fixture memory\n')
})

test('test_c7_interactive_waits_for_a_new_pairing_log_and_explains_what_to_send', { timeout: 130_000 }, async () => {
  const f = fixture()
  expect(existsSync(installer), 'interactive installer must exist').toBe(true)
  let output = ''
  let startedBeforePrompt = false
  let sawPrompt = false
  const child = spawn(bash, [installer], {
    cwd: f.root, env: { ...f.env, TEST_JOURNAL_DELAY: 'yes' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const collect = (chunk: Buffer) => {
    output += chunk.toString()
    if (!sawPrompt && privatePrompt.test(output)) {
      sawPrompt = true
      startedBeforePrompt = system(f, 'enable', 'dshbot.service')
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.stdin.end()
  const result = await new Promise<{ status: number | null; output: string; error?: Error }>((resolve) => {
    let error: Error | undefined
    child.on('error', (value) => { error = value })
    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
    }, 125_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      children.delete(child)
      resolve({ status, output, error })
    })
  })
  success(result)
  const journal = calls(f, 'journalctl')
  expect(journal.length).toBeGreaterThan(0)
  expect(journal.every(({ args }) => args.includes('--user') && (args.includes('-u') || args.includes('--unit') || args.includes('--unit=dshbot.service')) && args.some((arg) => arg === 'dshbot.service' || arg === '--unit=dshbot.service'))).toBe(true)
  expect(journal.length >= 2 || journal.some(({ args }) => args.includes('-f') || args.includes('--follow')),
    'the first snapshot has no code; installer must keep watching').toBe(true)
  expect(result.output).not.toContain(oldPairingCode)
  expect(result.output).toContain(pairingCode)
  expect(result.output).toMatch(/личк|личн|private/i)
  expect(result.output).toMatch(/напиш|отправ|пришл|send/i)
  expect(result.output).toMatch(/код|code/i)
  expect(startedBeforePrompt, 'request a private message after starting the service').toBe(true)
  expect(result.output.search(privatePrompt), 'request the message before displaying the resulting code').toBeLessThan(result.output.indexOf(pairingCode))
})

test('test_c8_uninstall_stops_both_units_and_removes_app_but_keeps_env_and_memory', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  memory(f)
  const env = readFileSync(f.envFile, 'utf8')
  writeFileSync(f.log, '')
  success(run(f, ['--uninstall']))
  for (const name of units) {
    expect(system(f, 'stop', name), `${name} is stopped`).toBe(true)
    expect(system(f, 'disable', name), `${name} is disabled`).toBe(true)
    expect(existsSync(join(f.unitDir, name))).toBe(false)
  }
  expect(system(f, 'daemon-reload')).toBe(true)
  expect(existsSync(f.app)).toBe(false)
  expect(readFileSync(f.envFile, 'utf8')).toBe(env)
  expect(readFileSync(join(f.data, 'state.db'), 'utf8')).toBe('fixture database bytes\n')
  expect(readFileSync(join(f.data, 'memory/keep.txt'), 'utf8')).toBe('irreplaceable fixture memory\n')
  const original = readFileSync(f.envFile, 'utf8')
  const refused = run(f, ['--purge'], { input: 'нет\n' })
  expect(refused.output).toContain(f.data)
  expect(refused.output).toContain(f.envFile)
  expect(refused.output).toContain('удалить')
  expect(readFileSync(join(f.data, 'memory/keep.txt'), 'utf8')).toBe('irreplaceable fixture memory\n')
  expect(readFileSync(f.envFile, 'utf8')).toBe(original)
  const accepted = run(f, ['--purge'], { input: 'удалить\n' })
  success(accepted)
  expect(accepted.output).toContain(f.data)
  expect(accepted.output).toContain(f.envFile)
  expect(existsSync(f.data)).toBe(false)
  expect(existsSync(f.envFile)).toBe(false)
})

test.each(['home', 'without-state'] as const)(
  'test_c9_purge_refuses_%s_memory_path_even_with_yes', { timeout: 30_000 }, (kind) => {
    const f = fixture()
    const data = kind === 'home' ? f.home : join(f.root, 'not-bot-data')
    // The HOME case has state.db so passing the existence check cannot excuse
    // deleting HOME. The other writable paths contain independent keep files.
    const keepDir = data
    put(join(keepDir, 'keep.txt'), 'must survive refused purge\n')
    if (kind === 'home') put(join(f.home, 'state.db'), 'fixture database\n')
    const result = run(f, ['--purge', '--yes'], { env: { DSHBOT_HOME: data } })
    expect(result.error, result.output).toBeUndefined()
    expect(result.status, result.output).not.toBe(0)
    expect(readFileSync(join(keepDir, 'keep.txt'), 'utf8')).toBe('must survive refused purge\n')
    expect(calls(f, 'rm').some(({ args }) => args.includes(data) || args.includes(`${data}/`)),
      'installer rejects the path itself, before invoking rm on it').toBe(false)
  },
)

test.each(['tracked', 'untracked'])('test_h1_%s_edits_in_installer_clone_refuse_update_without_changing_files_or_running_ci', { timeout: 30_000 }, (kind) => {
  const f = fixture()
  installed(f)
  const head = git(f, f.app, 'rev-parse', 'HEAD')
  const env = readFileSync(f.envFile, 'utf8')
  const editedPath = join(f.app, kind === 'tracked' ? 'installer-fixture.txt' : 'untracked-owner.txt')
  put(editedPath, 'owner uncommitted edits\n')
  updateSource(f)
  writeFileSync(f.log, '')
  const result = run(f)
  expect(result.status, result.output).not.toBe(0)
  expect(result.output).toMatch(russian)
  expect(result.output).toMatch(/изменени|незакоммич|несохран|рабоч.{0,20}(?:дерев|каталог)/i)
  expect(git(f, f.app, 'rev-parse', 'HEAD')).toBe(head)
  expect(readFileSync(editedPath, 'utf8')).toBe('owner uncommitted edits\n')
  expect(readFileSync(f.envFile, 'utf8')).toBe(env)
  expect(calls(f, 'npm')).toHaveLength(0)
  expect(calls(f, 'systemctl').some(({ args }) => ['stop', 'restart', 'enable', 'daemon-reload'].some((action) => args.includes(action)))).toBe(false)
})

test('test_h1_clean_local_evolution_gets_a_reported_pre_install_tag_before_update', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  put(join(f.app, 'installer-fixture.txt'), 'self-evolved product code\n')
  git(f, f.app, 'add', 'installer-fixture.txt')
  git(f, f.app, 'commit', '-q', '-m', 'bot self evolution')
  const evolved = git(f, f.app, 'rev-parse', 'HEAD')
  const upstream = updateSource(f)
  const result = run(f)
  success(result)
  const tags = git(f, f.app, 'tag', '--list', 'pre-install-*').split('\n').filter(Boolean)
  const preserved = tags.filter((tag) => git(f, f.app, 'rev-parse', `${tag}^{commit}`) === evolved)
  expect(preserved).toHaveLength(1)
  expect(result.output).toContain(preserved[0]!)
  expect(git(f, f.app, 'show', `${preserved[0]}:installer-fixture.txt`)).toBe('self-evolved product code')
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(upstream)
  expect(git(f, f.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
})

function appOrigin(f: Fixture): string | null {
  const result = spawnSync(realGit, ['config', '--local', '--get', 'remote.origin.url'], { cwd: f.app, env: f.env, encoding: 'utf8' })
  expect(result.status, result.stderr).not.toBeNull()
  return result.status === 0 ? result.stdout.trim() : null
}

// Replace only the migration engine with a recorder that notes whether the main
// service was running; the real launcher, register hook and pinned node stay.
function migrationEngine(f: Fixture): void {
  const stateFile = join(f.root, 'service-state.json')
  put(join(f.source, 'packages/migrate/src/cli.ts'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
const state = fs.existsSync(${JSON.stringify(stateFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8')) : {active: false};
fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({cmd: 'migrate', args, cwd: process.cwd(), active: state.active}) + '\\n');
console.log(args.includes('--dry-run') ? 'FIXTURE_MIGRATION_PLAN' : 'FIXTURE_MIGRATION_APPLIED');
`)
  git(f, f.source, 'add', '-A')
  git(f, f.source, 'commit', '-q', '-m', 'fixture migration engine')
}

function manualMigration(f: Fixture, output: string, source: string): boolean {
  return output.split('\n').some((line) => line.includes(join(f.app, 'scripts/dshbot-migrate')) && line.includes(source))
}

test.each(['openclaw'])('test_h4_explicit_%s_without_a_terminal_shows_the_plan_and_leaves_apply_to_a_manual_command', { timeout: 30_000 }, (source) => {
  const f = fixture()
  migrationEngine(f)
  mkdirSync(join(f.home, `.${source}`))
  // Piped answers are not a terminal: the apply question stays unanswered.
  const result = run(f, [`--migrate=${source}`], { input: 'да\nда\n' })
  success(result)
  const migrations = calls(f, 'migrate')
  expect(migrations, result.output).toHaveLength(1)
  expect(migrations[0]!.args).toContain(source)
  expect(migrations[0]!.args).toContain('--dry-run')
  expect(result.output).toContain('FIXTURE_MIGRATION_PLAN')
  expect(result.output).not.toContain('FIXTURE_MIGRATION_APPLIED')
  expect(manualMigration(f, result.output, source), result.output).toBe(true)
  expect(JSON.parse(readFileSync(join(f.root, 'service-state.json'), 'utf8')).active).toBe(true)
})

test.each(['stops', 'fail', 'ignored'])('test_h5_apply_needs_a_stopped_service_when_stop_%s', { timeout: 60_000 }, (mode) => {
  const f = fixture()
  migrationEngine(f)
  installed(f)
  expect(calls(f, 'migrate')).toHaveLength(0)
  mkdirSync(join(f.home, '.openclaw'))
  const result = run(f, ['--migrate=openclaw', '--yes'], { env: mode === 'stops' ? {} : { TEST_STOP: mode } })
  success(result)
  const migrations = calls(f, 'migrate')
  expect(migrations[0]!.args).toContain('--dry-run')
  if (mode === 'stops') {
    // Positive control: the same fixture does reach the apply call, with the service stopped.
    expect(migrations, result.output).toHaveLength(2)
    expect(migrations[1]!.args).not.toContain('--dry-run')
    expect(migrations[1]!.active).toBe(false)
    expect(result.output).toContain('FIXTURE_MIGRATION_APPLIED')
  } else {
    expect(migrations, result.output).toHaveLength(1)
    expect(result.output).not.toContain('FIXTURE_MIGRATION_APPLIED')
    expect(result.output).toContain('не удалось остановить dshbot.service')
    expect(manualMigration(f, result.output, 'openclaw'), result.output).toBe(true)
  }
  expect(JSON.parse(readFileSync(join(f.root, 'service-state.json'), 'utf8')).active).toBe(true)
})

test('implicit migration discovery never treats --yes or piped answers as apply consent', { timeout: 30_000 }, () => {
  const f = fixture()
  migrationEngine(f)
  mkdirSync(join(f.home, '.openclaw'))
  for (const args of [['--yes'], []]) {
    writeFileSync(f.log, '')
    const result = run(f, args, { input: 'да\nда\n' })
    success(result)
    expect(calls(f, 'migrate'), result.output).toEqual([])
    expect(manualMigration(f, result.output, 'openclaw')).toBe(true)
    expect(result.output).not.toContain('FIXTURE_MIGRATION_APPLIED')
  }
})
