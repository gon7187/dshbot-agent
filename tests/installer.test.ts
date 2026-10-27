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
    DSHBOT_INSTALL_SRC: f.source, TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key, DSHBOT_ISOLATION: 'container',
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
if (args.includes('enable')) { state.enabled = true; if (args.includes('--now')) state.active = true; }
if (args.includes('disable')) { state.enabled = false; if (args.includes('--now')) state.active = false; }
if (args.includes('start') || args.includes('restart')) state.active = true;
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
const line = 'Oct 25 12:00:00 host dshbot[42]: pairing code for private chat 987654321: ${pairingCode}';
if (process.env.TEST_JOURNAL_DELAY === 'yes') {
  const counter = ${JSON.stringify(join(root, 'journal-count'))};
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(n));
  console.log('Oct 25 12:00:00 host dshbot[42]: polling started');
  if (args.includes('-f') || args.includes('--follow')) setTimeout(() => console.log(line), 300);
  else if (n >= 2) console.log(line);
} else console.log(line);
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
  for (const entry of ['scripts', 'deploy', 'packages', 'persona', 'prompts', 'package.json', 'package-lock.json', 'tsconfig.json', 'CHARTER.md', 'CHECKLIST.md', 'README.md']) {
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

test('test_c1_yes_installs_from_local_source_without_input_and_configures_user_service', { timeout: 30_000 }, () => {
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
})

test('test_c2_installed_units_use_process_execPath_instead_of_the_mise_shim', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  for (const name of units) {
    const commands = unitValues(join(f.unitDir, name)).get('Service.ExecStart') ?? []
    expect(commands).toHaveLength(1)
    expect(words(commands[0]!)).toContain(process.execPath)
    expect(commands[0]).not.toMatch(/mise\/shims\/node|__DSHBOT_NODE__/)
    expect(words(commands[0]!)).not.toContain(join(f.bin, 'node'))
  }
})

test('test_c2_installed_main_unit_starts_the_pinned_node_through_the_launch_shim', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  const start = unitValues(join(f.unitDir, 'dshbot.service')).get('Service.ExecStart') ?? []
  expect(start).toHaveLength(1)
  const argv = words(start[0]!)
  expect(argv[0]).toBe(process.execPath)
  expect(start[0]).toContain('/dshbot-launch.mjs')
  expect(existsSync(join(f.data, 'dshbot-launch.mjs')), 'launch shim is installed outside the app tree').toBe(true)
  const doctor = unitValues(join(f.unitDir, 'dshbot-doctor.service')).get('Service.ExecStart') ?? []
  expect(words(doctor[0]!)[0]).toBe(process.execPath)
})

test('test_c3_reinstall_updates_code_runs_ci_restarts_and_preserves_env_and_memory', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
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

test.each(['old-node', 'missing-git', 'missing-bwrap'] as const)(
  'test_c4_%s_fails_in_russian_before_installing_anything', { timeout: 30_000 }, (problem) => {
    const f = fixture()
    if (problem === 'old-node') {
      const pkg = JSON.parse(readFileSync(join(f.source, 'package.json'), 'utf8')) as { engines: { node: string } }
      const version = /([0-9]+)\.([0-9]+)(?:\.([0-9]+))?/.exec(pkg.engines.node)
      expect(version, 'engines.node specifies a minimum version').not.toBeNull()
      const [major, minor, patch] = [Number(version![1]), Number(version![2]), Number(version![3] ?? 0)]
      const old = patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.999` : `${major - 1}.999.999`
      const preload = join(f.root, 'old-node.cjs')
      put(preload, `Object.defineProperty(process, 'version', {value: 'v${old}'}); Object.defineProperty(process.versions, 'node', {value: '${old}'}); Object.defineProperty(process, 'execPath', {value: ${JSON.stringify(join(f.bin, 'node'))}});`)
      unlinkSync(join(f.bin, 'node'))
      writeFileSync(join(f.bin, 'node'), `#!/bin/sh\ncase "$1" in --version|-v) printf '%s\\n' 'v${old}'; exit 0;; esac\nexec ${quote(process.execPath)} --require ${quote(preload)} "$@"\n`, { mode: 0o755 })
    } else unlinkSync(join(f.bin, problem === 'missing-git' ? 'git' : 'bwrap'))
    const result = run(f)
    expect(result.error, result.output).toBeUndefined()
    expect(result.status, result.output).not.toBe(0)
    expect(result.output).toMatch(russian)
    expect(result.output).toMatch(problem === 'old-node' ? /node/i : problem === 'missing-git' ? /git/i : /bwrap/i)
    expect(existsSync(f.app)).toBe(false)
    expect(existsSync(f.envFile)).toBe(false)
    for (const name of units) expect(existsSync(join(f.unitDir, name))).toBe(false)
    expect(calls(f, 'npm')).toHaveLength(0)
    expect(calls(f, 'systemctl').filter(({ args }) => args.includes('enable') || args.includes('start') || args.includes('restart'))).toHaveLength(0)
  },
)

test('test_c4_host_without_bwrap_installs_with_a_russian_warning', { timeout: 30_000 }, () => {
  const f = fixture()
  unlinkSync(join(f.bin, 'bwrap'))
  const result = run(f, ['--yes'], { env: { DSHBOT_ISOLATION: 'host' } })
  success(result)
  expect(result.output).toMatch(/bwrap/i)
  expect(result.output).toMatch(russian)
  expect(result.output).toMatch(/предупреж|внимани|недоступ|не (?:найден|установлен)|без.*bwrap/i)
  expect(envValues(f).DSHBOT_ISOLATION).toBe('host')
  expect(system(f, 'enable', 'dshbot.service')).toBe(true)
})

test.each(['container', 'host'])('test_c5_stdin_prompts_accept_%s_and_never_echo_credentials', { timeout: 30_000 }, (mode) => {
  const f = fixture()
  const result = run(f, [], {
    env: { TELEGRAM_BOT_TOKEN: undefined, DEEPSEEK_API_KEY: undefined, DSHBOT_ISOLATION: undefined },
    input: `${token}\n${key}\n${mode}\n`,
  })
  success(result)
  expect(envValues(f)).toMatchObject({ TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key, DSHBOT_ISOLATION: mode })
  expect(result.output).not.toContain(token)
  expect(result.output).not.toContain(key)
  expect(result.output).toMatch(/токен|token/i)
  expect(result.output).toMatch(/deepseek|ключ/i)
  expect(result.output).toMatch(/container/)
  expect(result.output).toMatch(/host/)
})

test('test_c6_linger_no_prints_the_sudo_command_with_an_explanation_without_executing_it', { timeout: 30_000 }, () => {
  const f = fixture()
  const result = run(f, ['--yes'], { env: { TEST_LINGER: 'no' } })
  success(result)
  expect(calls(f, 'loginctl').some(({ args }) => args.includes('show-user'))).toBe(true)
  expect(result.output).toMatch(/sudo\s+loginctl\s+enable-linger\s+/)
  expect(result.output).toContain(userInfo().username)
  expect(result.output).toMatch(russian)
  expect(result.output).toMatch(/сесси|выход|вход|после|фонов|постоян|linger/i)
  expect(calls(f, 'sudo')).toHaveLength(0)
  expect(calls(f, 'loginctl').some(({ args }) => args.includes('enable-linger'))).toBe(false)
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
  expect(result.output).toContain(pairingCode)
  expect(result.output).toMatch(/личк|личн|private/i)
  expect(result.output).toMatch(/напиш|отправ|пришл|send/i)
  expect(result.output).toMatch(/код|code/i)
  expect(startedBeforePrompt, 'request a private message after starting the service').toBe(true)
  expect(result.output.search(privatePrompt), 'request the message before displaying the resulting code').toBeLessThan(result.output.indexOf(pairingCode))
})

test('test_c7_yes_prints_a_journal_command_for_pairing_and_returns_without_user_input', { timeout: 30_000 }, () => {
  const f = fixture()
  const result = run(f)
  success(result)
  expect(result.output).toMatch(/journalctl\b[^\n]*--user[^\n]*dshbot\.service|journalctl\b[^\n]*dshbot\.service[^\n]*--user/)
  expect(result.output).toMatch(/личк|личн|private/i)
  expect(result.output).toMatch(/код|code/i)
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
})

test('test_c9_purge_lists_exact_paths_and_requires_the_word_udalit', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  memory(f)
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

test.each(['default', 'custom'])('test_c9_purge_yes_deletes_only_the_selected_%s_memory_and_env', { timeout: 30_000 }, (kind) => {
  const f = fixture()
  installed(f)
  const data = kind === 'custom' ? join(f.root, 'custom-memory') : f.data
  memory(f, data)
  put(join(f.home, 'keep-outside-memory.txt'), 'outside data directory\n')
  const result = run(f, ['--purge', '--yes'], { env: { DSHBOT_HOME: data } })
  success(result)
  expect(result.output).toContain(data)
  expect(result.output).toContain(f.envFile)
  expect(existsSync(data)).toBe(false)
  expect(existsSync(f.envFile)).toBe(false)
  expect(readFileSync(join(f.home, 'keep-outside-memory.txt'), 'utf8')).toBe('outside data directory\n')
})

test.each(['empty', 'root', 'home', 'without-state'] as const)(
  'test_c9_purge_refuses_%s_memory_path_even_with_yes', { timeout: 30_000 }, (kind) => {
    const f = fixture()
    const data = kind === 'empty' ? '' : kind === 'root' ? '/' : kind === 'home' ? f.home : join(f.root, 'not-bot-data')
    // The HOME case has state.db so passing the existence check cannot excuse
    // deleting HOME. The other writable paths contain independent keep files.
    const keepDir = kind === 'home' ? f.home : kind === 'without-state' ? data : f.data
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

test.each(['directory', 'linked-worktree'])('test_h1_foreign_%s_is_preserved_in_a_reported_app_prev_directory', { timeout: 30_000 }, (kind) => {
  const f = fixture()
  mkdirSync(dirname(f.app), { recursive: true })
  if (kind === 'linked-worktree') git(f, f.source, 'worktree', 'add', '-q', '-b', 'old-installation', f.app, 'HEAD')
  else mkdirSync(f.app)
  put(join(f.app, 'owner-local.txt'), 'uncommitted work in a foreign directory\n')
  const sha = updateSource(f)
  const result = run(f)
  success(result)
  const backups = readdirSync(f.data).filter((name) => /^app\.prev-.+/.test(name))
  expect(backups).toHaveLength(1)
  const backup = join(f.data, backups[0]!)
  expect(readFileSync(join(backup, 'owner-local.txt'), 'utf8')).toBe('uncommitted work in a foreign directory\n')
  if (kind === 'linked-worktree') expect(readFileSync(join(backup, 'installer-fixture.txt'), 'utf8')).toBe('initial product revision\n')
  expect(result.output).toContain(backup)
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sha)
  expect(git(f, f.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
})

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

test('test_h2_shipped_units_remain_runnable_mise_templates_while_installed_copies_use_real_node', { timeout: 30_000 }, () => {
  const f = fixture()
  installed(f)
  for (const name of units) {
    for (const base of [join(repo, 'deploy'), join(f.source, 'deploy')]) {
      const text = readFileSync(join(base, name), 'utf8')
      expect(text).not.toContain('__DSHBOT_NODE__')
      const start = unitValues(join(base, name)).get('Service.ExecStart') ?? []
      expect(start).toHaveLength(1)
      expect(words(start[0]!)).toContain('%h/.local/share/mise/shims/node')
    }
    const deployed = unitValues(join(f.unitDir, name)).get('Service.ExecStart') ?? []
    expect(deployed).toHaveLength(1)
    expect(words(deployed[0]!)).toContain(process.execPath)
  }
})

test('test_h3_updating_a_linked_worktree_does_not_mutate_the_source_repositories_remotes', { timeout: 30_000 }, () => {
  const f = fixture()
  const origin = 'https://example.invalid/dshbot.git'
  git(f, f.source, 'remote', 'add', 'origin', origin)
  mkdirSync(dirname(f.app), { recursive: true })
  git(f, f.source, 'worktree', 'add', '-q', '-b', 'live', f.app, 'HEAD')
  const upstream = updateSource(f)
  const remotes = git(f, f.source, 'config', '--local', '--get-regexp', '^remote\\.')
  success(run(f))
  expect(git(f, f.source, 'config', '--local', '--get', 'remote.origin.url')).toBe(origin)
  expect(git(f, f.source, 'config', '--local', '--get-regexp', '^remote\\.')).toBe(remotes)
  expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(upstream)
  expect(git(f, f.app, 'symbolic-ref', 'HEAD')).toBe('refs/heads/live')
})

function appOrigin(f: Fixture): string | null {
  const result = spawnSync(realGit, ['config', '--local', '--get', 'remote.origin.url'], { cwd: f.app, env: f.env, encoding: 'utf8' })
  expect(result.status, result.stderr).not.toBeNull()
  return result.status === 0 ? result.stdout.trim() : null
}

// Credentials live only in the URL authority: @ in the path is part of the address.
test.each(['source', 'environment', 'reinstall'] as const)(
  'test_h4_origin_with_at_sign_in_path_reaches_the_app_unchanged_from_%s', { timeout: 30_000 }, (kind) => {
    const f = fixture()
    const mirror = join(f.root, 'upstream@mirror.git')
    git(f, f.root, 'clone', '-q', '--bare', f.source, mirror)
    const address = `file://${mirror}`
    let sha = git(f, f.source, 'rev-parse', 'HEAD')
    if (kind === 'reinstall') {
      installed(f)
      expect(appOrigin(f)).toBeNull()
      sha = updateSource(f)
    }
    git(f, f.source, 'remote', 'add', 'origin', kind === 'environment' ? 'https://source.example.invalid/dshbot.git' : address)
    const result = run(f, ['--yes'], { env: kind === 'environment' ? { DSHBOT_INSTALL_ORIGIN: address } : {} })
    success(result)
    expect(appOrigin(f)).toBe(address)
    expect(result.output).toContain(address)
    git(f, f.app, 'fetch', '-q', 'origin', 'main')
    expect(git(f, f.app, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(f, mirror, 'rev-parse', 'refs/heads/main'))
    expect(git(f, f.app, 'rev-parse', 'refs/heads/live')).toBe(sha)
  },
)

test.each([
  ['ssh://git@example.invalid/owner/dshbot.git', 'ssh://git@example.invalid/owner/dshbot.git'],
  ['git@example.invalid:owner/dshbot.git', 'git@example.invalid:owner/dshbot.git'],
  ['https://example.invalid/owner@team/dshbot.git?ref=a@b', 'https://example.invalid/owner@team/dshbot.git?ref=a@b'],
  ['ssh://git:fixtureSshSecret4417@example.invalid/owner/dshbot.git', 'ssh://git@example.invalid/owner/dshbot.git'],
])('test_h4_origin_%s_keeps_the_ssh_login_and_path_but_not_secrets', { timeout: 30_000 }, (address, expected) => {
  const f = fixture()
  git(f, f.source, 'remote', 'add', 'origin', address)
  const result = run(f)
  success(result)
  expect(appOrigin(f)).toBe(expected)
  expect(result.output).not.toContain('fixtureSshSecret4417')
  expect(git(f, f.app, 'config', '--local', '--list')).not.toContain('fixtureSshSecret4417')
})

// A colon does not make an address remote on its own: git treats
// ./remote:mirror.git and mirrors/remote:mirror.git as local paths, while
// scp-like user@host:repo.git and URLs stay intact. Mirror that split.
test.each([
  { address: './remote:mirror.git', local: true },
  { address: 'human@example.invalid:dshbot.git', local: false },
  { address: 'https://example.invalid/owner/dshbot.git', local: false },
])('test_h1_origin_$address_is_resolved_like_git_resolves_local_paths_and_remote_addresses', { timeout: 30_000 }, ({ address, local }) => {
  const f = fixture()
  const expected = local ? join(f.source, 'remote:mirror.git') : address
  if (local) git(f, f.root, 'clone', '-q', '--bare', f.source, expected)
  git(f, f.source, 'remote', 'add', 'origin', address)
  success(run(f))
  expect(appOrigin(f)).toBe(expected)
  if (local) {
    git(f, f.app, 'fetch', '-q', 'origin', 'main')
    expect(git(f, f.app, 'rev-parse', 'refs/remotes/origin/main'))
      .toBe(git(f, expected, 'rev-parse', 'refs/heads/main'))
  }
})

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

test.each(['openclaw', 'hermes'])('test_h4_explicit_%s_without_a_terminal_shows_the_plan_and_leaves_apply_to_a_manual_command', { timeout: 30_000 }, (source) => {
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
