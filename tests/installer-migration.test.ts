// The disposable HOME and command doubles follow installer-pairing-journal.test.ts.
// No real dependency installation, git repository, systemd, daemon or network is used.
// Only fixture-owned settings are written; developer env-files are never opened.
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000 })

const repo = fileURLToPath(new URL('..', import.meta.url))
const installer = join(repo, 'scripts/install.sh')
const token = '7000012:AAInstallMigrationFixtureToken12345'
const key = 'sk-install-migration-fixture-key-12345'
const storedToken = '7000013:AAExistingMigrationFixtureToken67890'
const storedKey = 'sk-existing-migration-fixture-key-67890'
const extraSecret = 'fixture-extra-provider-secret-54321'
const planMarker = 'FIXTURE_MIGRATION_PLAN: TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY'
const applyMarker = 'FIXTURE_MIGRATION_APPLIED'
type Source = 'openclaw' | 'hermes'
interface Call {
  cmd: string
  args: string[]
  active?: boolean
  execPath?: string
  entry?: string
  from?: string
}
interface Fixture {
  root: string
  home: string
  app: string
  bin: string
  log: string
  stateFile: string
  env: NodeJS.ProcessEnv
}
interface Result {
  status: number | null
  output: string
  questions: { text: string; offset: number }[]
  error?: Error
}
interface Options {
  existing?: boolean
  dropNode?: boolean
  dryExit?: number
  applyExit?: number
}

let suite: string
let tools: string
const fixtures: Fixture[] = []

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-installer-offer-')))
  tools = join(suite, 'tools')
  mkdirSync(tools)
  // As in installer.test.ts, make absence of node in PATH real, including on
  // hosts with more than one toolchain. Replaced commands cannot reach the host.
  const replaced = new Set(['node', 'nodejs', 'npm', 'npx', 'git', 'bwrap', 'systemctl',
    'journalctl', 'loginctl', 'sudo', 'curl', 'wget', 'dshbot-migrate'])
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), '/usr/bin', '/bin']) {
    if (!dir || !existsSync(dir)) continue
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (replaced.has(name)) continue
      try { symlinkSync(join(dir, name), join(tools, name)) } catch { /* first PATH entry wins */ }
    }
  }
})

afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.root, { recursive: true, force: true })
})
afterAll(() => { if (suite) rmSync(suite, { recursive: true, force: true }) })

function fixture(options: Options = {}): Fixture {
  const root = mkdtempSync(join(suite, 'case-'))
  const home = join(root, 'home')
  const source = join(root, 'source')
  const f: Fixture = {
    root, home, app: join(home, '.local/share/dshbot/app'), bin: join(root, 'bin'),
    log: join(root, 'commands.jsonl'), stateFile: join(root, 'service.json'), env: {},
  }
  fixtures.push(f)
  for (const dir of [home, source, f.bin]) mkdirSync(dir, { recursive: true })
  writeFileSync(f.log, '')
  writeFileSync(f.stateFile, JSON.stringify({ active: options.existing ?? false }))
  for (const entry of ['package.json', 'deploy', 'scripts', 'packages/app/register.mjs']) {
    cpSync(join(repo, entry), join(source, entry), {
      recursive: true, filter: (path) => !basename(path).startsWith('.env'),
    })
  }
  // Keep the real public migration launcher and register hook. Replace only the
  // migration engine, so node resolution and shell quoting remain observable.
  put(join(source, 'packages/migrate/src/cli.ts'), `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(f.stateFile)}, 'utf8'));
const fromIndex = args.indexOf('--from');
const from = args.find(arg => arg.startsWith('--from='))?.slice('--from='.length) ??
  (fromIndex < 0 ? undefined : args[fromIndex + 1]) ??
  (args.includes('openclaw') ? process.env.OPENCLAW_STATE_DIR : process.env.HERMES_HOME) ??
  path.join(process.env.HOME, args.includes('openclaw') ? '.openclaw' : '.hermes');
fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({cmd: 'migrate', args,
  active: state.active, execPath: process.execPath, entry: process.argv[1], from}) + '\\n');
if (args.includes('--dry-run')) {
  console.log(${JSON.stringify(planMarker)});
  process.exit(${options.dryExit ?? 0});
}
console.log(${JSON.stringify(applyMarker)});
process.exit(${options.applyExit ?? 0});
`)
  if (options.existing) {
    cpSync(source, f.app, { recursive: true })
    // These values are invented fixture data, never read from a real env-file.
    put(join(home, '.config/dshbot/dshbot.env'),
      `TELEGRAM_BOT_TOKEN=${storedToken}\nDEEPSEEK_API_KEY=${storedKey}\nEXTRA_PROVIDER_KEY=${extraSecret}\nDSHBOT_ISOLATION=container\n`)
  }

  function fake(name: string, body: string): void {
    writeFileSync(join(f.bin, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({cmd: ${JSON.stringify(name)}, args}) + '\\n');
${body}
`, { mode: 0o755 })
  }
  // Resolve a shim to the real Node, just as the existing installer tests do.
  writeFileSync(join(f.bin, 'node'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 })
  fake('git', `
if (args.includes('init')) fs.cpSync(${JSON.stringify(source)}, args[args.length - 1], {recursive: true});
else if (args.includes('--is-inside-work-tree')) console.log('true');
else if (args.includes('rev-parse')) console.log('0123456789012345678901234567890123456789');
`)
  fake('npm', options.dropNode ? `if (args.includes('ci')) fs.rmSync(${JSON.stringify(join(f.bin, 'node'))}, {force: true});` : '')
  fake('bwrap', '')
  fake('loginctl', "console.log(args.includes('--value') ? 'yes' : 'Linger=yes');")
  fake('systemctl', `
const stateFile = ${JSON.stringify(f.stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (args.includes('is-active')) {
  console.log(state.active ? 'active' : 'inactive'); process.exit(state.active ? 0 : 3);
}
if (args.includes('show')) console.log(args.includes('--value') ? '12345678901234567890123456789012' : 'InvocationID=12345678901234567890123456789012');
if (args.includes('dshbot.service')) {
  if (args.includes('stop') || (args.includes('disable') && args.includes('--now'))) state.active = false;
  if (args.includes('start') || args.includes('restart') || (args.includes('enable') && args.includes('--now'))) state.active = true;
}
fs.writeFileSync(stateFile, JSON.stringify(state));
`)
  fake('journalctl', "console.log('host dshbot[42]: pairing code for private chat 987654321: A1B2C3');")
  for (const name of ['sudo', 'curl', 'wget', 'npx']) {
    fake(name, "console.error('unexpected external action in migration fixture'); process.exit(91);")
  }
  f.env = {
    HOME: home, PATH: [f.bin, tools].join(delimiter), TMPDIR: root,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    USER: 'installer-fixture', LOGNAME: 'installer-fixture', LANG: 'C.UTF-8', TERM: 'dumb',
    DSHBOT_INSTALL_SRC: source, DSHBOT_ISOLATION: 'container',
    TELEGRAM_BOT_TOKEN: token, DEEPSEEK_API_KEY: key,
  }
  return f
}

function addSource(f: Fixture, source: Source, custom = false): string {
  // Spaces and an apostrophe exercise the ready-to-copy command's shell quoting.
  const path = custom ? join(f.root, `owner's ${source} state`) : join(f.home, `.${source}`)
  mkdirSync(path, { recursive: true })
  if (custom) f.env[source === 'openclaw' ? 'OPENCLAW_STATE_DIR' : 'HERMES_HOME'] = path
  return path
}

function calls(f: Fixture, cmd?: string): Call[] {
  const all = readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call)
  return cmd === undefined ? all : all.filter((call) => call.cmd === cmd)
}

function run(f: Fixture, args: string[] = ['--yes'], input = ''): Result {
  expect(existsSync(installer), 'installer entry point exists').toBe(true)
  const result = spawnSync('/bin/bash', [installer, ...args], {
    cwd: f.root, env: f.env, input, encoding: 'utf8', timeout: 12_000,
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    questions: [], error: result.error }
}

function isMigrationQuestion(line: string): boolean {
  return /перен|миграц|выбер|выбор|источник|примен|подтверд|продолж|migrat|choose|select|source|apply|confirm|proceed/i.test(line) &&
    (/\?|\[[^\]]*(?:да|нет|[yYnNдДнН]\/|\/|none)[^\]]*\]|(?:да|yes)\s*\/\s*(?:нет|no)/i.test(line) ||
      (/(?:выбер|выбор|choose|select)/i.test(line) && /[:>]\s*$/.test(line)))
}

async function interactive(f: Fixture, args: string[], answers: (string | null)[], enterCredentials = false): Promise<Result> {
  // node-pty is already supplied by the runner's terminal dependency. A real
  // PTY is required here: piped stdin must intentionally skip migration prompts.
  const { spawn } = await import('node-pty')
  return new Promise((resolve) => {
    const terminal = spawn('/bin/bash', [installer, ...args], {
      cwd: f.root, env: f.env, cols: 300, rows: 40, name: 'dumb',
    })
    const result: Result = { status: null, output: '', questions: [] }
    let cursor = 0
    let credential = 0
    const timer = setTimeout(() => {
      result.error = new Error('installer did not finish the scripted terminal conversation')
      terminal.kill()
    }, 12_000)
    terminal.onData((chunk) => {
      result.output += chunk.replaceAll('\r', '')
      const pending = result.output.slice(cursor)
      if (enterCredentials && credential < 2) {
        const prompt = credential === 0 ? /(?:токен|token)[^\n]*:\s*$/i : /(?:ключ|deepseek)[^\n]*:\s*$/i
        if (prompt.test(pending)) {
          cursor = result.output.length
          const value = credential++ === 0 ? token : key
          // Let read -s disable terminal echo before delivering fixture secrets.
          setTimeout(() => terminal.write(`${value}\n`), 10)
          return
        }
      }
      const line = pending.split('\n').find(isMigrationQuestion)
      if (line !== undefined) {
        result.questions.push({ text: pending, offset: result.output.length })
        cursor = result.output.length
        const answer = answers[result.questions.length - 1]
        terminal.write(answer === null || answer === undefined ? '\x04' : `${answer}\n`)
      }
    })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      result.status = exitCode
      resolve(result)
    })
  })
}

function success(result: Result): void {
  expect(result.error, result.output).toBeUndefined()
  expect(result.status, result.output).toBe(0)
}

function installed(f: Fixture): void {
  expect(existsSync(join(f.app, 'package.json')), 'application remains installed').toBe(true)
  expect(existsSync(join(f.home, '.config/systemd/user/dshbot.service')), 'service unit remains installed').toBe(true)
  expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).active, 'main service ends active').toBe(true)
}

function selected(call: Call, source: Source, path: string): void {
  expect(call.args, 'migration receives the chosen source').toContain(source)
  expect(call.from, 'migration uses the detected directory').toBe(path)
}

function manualCommand(output: string, source: Source): string {
  // Allow prose, a shell prompt, a bullet or Markdown fencing around a command;
  // do not require a particular quoting style or implementation of the launcher.
  const line = output.replace(/\\\n\s*/g, ' ').split('\n').find((candidate) =>
    candidate.includes('dshbot-migrate') && new RegExp(`\\b${source}\\b`).test(candidate))
  expect(line, `ready-to-run ${source} command must be printed`).toBeDefined()
  return line!.trim().replace(/^(?:\$\s+|[-*]\s+)/, '').replace(/^`(.*)`$/, '$1')
}

function manual(f: Fixture, result: Result, source: Source, path: string): string {
  const command = manualCommand(result.output, source)
  // Execute the advertised command against the fixture engine; this checks
  // arguments and quoting rather than comparing shell source text.
  const before = calls(f, 'migrate').length
  const execution = spawnSync('/bin/bash', ['-c', command], {
    cwd: f.root, env: { ...f.env, OPENCLAW_STATE_DIR: undefined, HERMES_HOME: undefined },
    encoding: 'utf8', input: '', timeout: 5_000,
  })
  expect(execution.error, `${execution.stdout}${execution.stderr}`).toBeUndefined()
  expect(execution.status, `${execution.stdout}${execution.stderr}`).toBe(0)
  const invoked = calls(f, 'migrate').slice(before)
  expect(invoked, 'copying the command reaches the migration engine').toHaveLength(1)
  selected(invoked[0]!, source, path)
  return command
}

test.each([
  ['openclaw', false], ['openclaw', true], ['hermes', false], ['hermes', true],
] as const)('test_c1_detects_%s_custom_path_%s_after_installation', (source, custom) => {
  const f = fixture()
  const path = addSource(f, source, custom)
  const result = run(f)
  success(result)
  installed(f)
  expect(result.output.toLowerCase()).toContain(source)
  expect(result.output).toContain(path)
  expect(result.output).toMatch(/найден|обнаруж|found|detect/i)
})

test.each([false, true])('test_c1_no_source_directory_means_no_migration_offer_files_only_%s', async (filesOnly) => {
  const f = fixture()
  if (filesOnly) {
    put(join(f.home, '.openclaw'), 'a file is not a state directory')
    put(join(f.home, '.hermes'), 'a file is not a state directory')
  }
  const result = await interactive(f, [], [])
  success(result)
  installed(f)
  expect(result.output).not.toMatch(/миграц|перенос|перенести|migrat|openclaw|hermes/i)
  expect(result.questions).toHaveLength(0)
  expect(calls(f, 'migrate')).toHaveLength(0)
})

test.each([
  ['openclaw', 'yes'], ['hermes', 'yes'], ['openclaw', 'no-tty'], ['hermes', 'no-tty'],
] as const)('test_c2_%s_%s_only_prints_a_working_manual_command', async (source, mode) => {
  const f = fixture()
  const path = addSource(f, source, true)
  const result = mode === 'yes' ? await interactive(f, ['--yes'], []) : run(f, [], 'да\nда\n')
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(0)
  expect(result.output.split('\n').filter(isMigrationQuestion)).toHaveLength(0)
  expect(calls(f, 'migrate'), 'neither --yes nor piped answers opt into migration').toHaveLength(0)
  manual(f, result, source, path)
})

test.each(['нет', '', null])('test_c3_declining_or_ending_input_%s_leaves_a_manual_command', async (answer) => {
  const f = fixture()
  const path = addSource(f, 'openclaw', true)
  const result = await interactive(f, [], [answer])
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(1)
  expect(calls(f, 'migrate')).toHaveLength(0)
  manual(f, result, 'openclaw', path)
})

test.each([
  ['openclaw', 'да'], ['hermes', 'да'], ['openclaw', 'нет'], ['hermes', null],
] as const)('test_c4_%s_dry_run_precedes_second_confirmation_%s', async (source, secondAnswer) => {
  const f = fixture()
  const path = addSource(f, source, true)
  const result = await interactive(f, [], ['да', secondAnswer])
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(2)
  expect(result.output).toContain(planMarker)
  expect(result.output.indexOf(planMarker)).toBeLessThan(result.questions[1]!.offset)
  const migrations = calls(f, 'migrate')
  expect(migrations).toHaveLength(secondAnswer === 'да' ? 2 : 1)
  selected(migrations[0]!, source, path)
  expect(migrations[0]!.args).toContain('--dry-run')
  if (secondAnswer === 'да') {
    selected(migrations[1]!, source, path)
    expect(migrations[1]!.args).not.toContain('--dry-run')
    expect(migrations[1]!.args.some((arg) => arg === '--yes' || arg === '-y')).toBe(true)
    expect(result.output).toContain(applyMarker)
  } else expect(result.output).not.toContain(applyMarker)
})

test.each(['openclaw', 'hermes', 'none'] as const)(
  'test_c5_both_sources_offer_a_choice_and_honor_%s', async (choice) => {
    const f = fixture()
    const paths = { openclaw: addSource(f, 'openclaw', true), hermes: addSource(f, 'hermes', true) }
    const result = await interactive(f, [], [choice === 'none' ? 'нет' : choice, 'да'])
    success(result)
    installed(f)
    expect(result.questions).toHaveLength(choice === 'none' ? 1 : 2)
    const question = result.questions[0]!.text
    expect(question).toMatch(/openclaw/i)
    expect(question).toMatch(/hermes/i)
    expect(question).toMatch(/none|нет|отказ|не перенос|не мигр|skip|no\b/i)
    const migrations = calls(f, 'migrate')
    expect(migrations).toHaveLength(choice === 'none' ? 0 : 2)
    if (choice === 'none') {
      manual(f, result, 'openclaw', paths.openclaw)
      manual(f, result, 'hermes', paths.hermes)
    } else {
      for (const call of migrations) selected(call, choice, paths[choice])
      expect(migrations[0]!.args).toContain('--dry-run')
      expect(migrations[1]!.args).not.toContain('--dry-run')
    }
  },
)

test.each([
  ['openclaw', false], ['hermes', false], ['openclaw', true], ['hermes', true],
] as const)('test_c6_explicit_%s_skips_first_question_yes_%s', async (source, yes) => {
  const f = fixture()
  const path = addSource(f, source, true)
  addSource(f, source === 'openclaw' ? 'hermes' : 'openclaw')
  const result = await interactive(f, [`--migrate=${source}`, ...(yes ? ['--yes'] : [])], ['да'])
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(yes ? 0 : 1)
  expect(result.output).toContain(planMarker)
  if (!yes) expect(result.output.indexOf(planMarker)).toBeLessThan(result.questions[0]!.offset)
  const migrations = calls(f, 'migrate')
  expect(migrations).toHaveLength(2)
  for (const call of migrations) selected(call, source, path)
  expect(migrations[0]!.args).toContain('--dry-run')
  expect(migrations[1]!.args).not.toContain('--dry-run')
  expect(migrations[1]!.args.some((arg) => arg === '--yes' || arg === '-y')).toBe(true)
})

test('test_c6_explicit_source_can_decline_only_the_apply_question', async () => {
  const f = fixture()
  addSource(f, 'hermes')
  const result = await interactive(f, ['--migrate=hermes'], ['нет'])
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(1)
  const migrations = calls(f, 'migrate')
  expect(migrations).toHaveLength(1)
  expect(migrations[0]!.args).toContain('--dry-run')
})

test.each(['none', 'missing-openclaw', 'missing-hermes'] as const)(
  'test_c6_%s_never_invokes_migration_or_asks', async (mode) => {
    const f = fixture()
    const source = mode === 'missing-hermes' ? 'hermes' : 'openclaw'
    addSource(f, source === 'openclaw' ? 'hermes' : 'openclaw')
    if (mode === 'none') addSource(f, source)
    const result = await interactive(f, [`--migrate=${mode === 'none' ? 'none' : source}`], [])
    success(result)
    installed(f)
    expect(result.questions).toHaveLength(0)
    expect(calls(f, 'migrate')).toHaveLength(0)
    if (mode !== 'none') {
      expect(result.output.toLowerCase()).toContain(source)
      expect(result.output).toMatch(/предупреж|warning|не найден|не обнаруж|отсутств|not found|missing/i)
    }
  },
)

test('test_c7_invalid_source_is_rejected_with_allowed_values_before_changes', () => {
  const f = fixture()
  addSource(f, 'openclaw')
  const result = run(f, ['--yes', '--migrate=foo'])
  expect(result.error, result.output).toBeUndefined()
  expect(result.status, result.output).not.toBe(0)
  for (const value of ['openclaw', 'hermes', 'none']) expect(result.output).toContain(value)
  expect(existsSync(f.app)).toBe(false)
  expect(existsSync(join(f.home, '.config/dshbot'))).toBe(false)
  expect(existsSync(join(f.home, '.config/systemd/user'))).toBe(false)
  expect(calls(f).filter(({ cmd, args }) => cmd === 'npm' || cmd === 'migrate' ||
    (cmd === 'systemctl' && args.some((arg) => ['enable', 'start', 'restart', 'stop'].includes(arg))))).toHaveLength(0)
})

test('test_c7_help_lists_migrate_and_each_supported_choice_without_installing', () => {
  const f = fixture()
  const result = run(f, ['--help'])
  success(result)
  expect(result.output).toContain('--migrate')
  for (const value of ['openclaw', 'hermes', 'none']) expect(result.output).toContain(value)
  expect(existsSync(f.app)).toBe(false)
  expect(calls(f)).toHaveLength(0)
})

test.each(['да', 'нет'])('test_c8_dry_run_conflicts_exit_1_still_show_plan_and_ask_%s', async (answer) => {
  const f = fixture({ dryExit: 1 })
  addSource(f, 'openclaw')
  const result = await interactive(f, ['--migrate=openclaw'], [answer])
  success(result)
  installed(f)
  expect(result.output).toContain(planMarker)
  expect(result.questions).toHaveLength(1)
  expect(result.output.indexOf(planMarker)).toBeLessThan(result.questions[0]!.offset)
  const migrations = calls(f, 'migrate')
  expect(migrations).toHaveLength(answer === 'да' ? 2 : 1)
  expect(migrations[0]!.args).toContain('--dry-run')
  if (answer === 'да') expect(migrations[1]!.args).not.toContain('--dry-run')
})

test.each([
  ['dry-run', 7], ['apply', 9], ['apply', 1],
] as const)('test_c8_%s_failure_exit_%s_preserves_a_running_installation', async (stage, code) => {
  const f = fixture(stage === 'dry-run' ? { dryExit: code } : { applyExit: code })
  addSource(f, 'hermes')
  const result = await interactive(f, ['--migrate=hermes', '--yes'], [])
  success(result)
  installed(f)
  expect(result.questions).toHaveLength(0)
  expect(result.output).toMatch(/миграц|migrat/i)
  expect(result.output).toMatch(/не удалась|не удалось|ошиб|fail|error/i)
  expect(result.output).toMatch(new RegExp(`(?:код|code|exit|status|статус)[^\\n]{0,50}\\b${code}\\b`, 'i'))
  expect(calls(f, 'migrate')).toHaveLength(stage === 'dry-run' ? 1 : 2)
})

test.each([false, true])('test_c9_apply_runs_with_main_service_stopped_existing_%s', (existing) => {
  const f = fixture({ existing })
  addSource(f, 'openclaw')
  const result = run(f, ['--migrate=openclaw', '--yes'])
  success(result)
  installed(f)
  const sequence = calls(f)
  const apply = sequence.findIndex(({ cmd, args }) => cmd === 'migrate' && !args.includes('--dry-run'))
  expect(apply, 'the apply path must actually execute').toBeGreaterThanOrEqual(0)
  expect(sequence[apply]!.active, 'main service must be inactive at the actual apply call').toBe(false)
  let active = existing
  for (const [index, call] of sequence.entries()) {
    if (call.cmd === 'systemctl' && call.args.includes('dshbot.service')) {
      if (call.args.includes('stop') || (call.args.includes('disable') && call.args.includes('--now'))) active = false
      if (call.args.includes('start') || call.args.includes('restart') ||
        (call.args.includes('enable') && call.args.includes('--now'))) active = true
    }
    if (index === apply) expect(active, 'recorded systemctl order protects the migration').toBe(false)
  }
  expect(active, 'recorded systemctl order ends with the service running').toBe(true)
})

function unitNode(f: Fixture): string {
  const unit = readFileSync(join(f.home, '.config/systemd/user/dshbot.service'), 'utf8')
  const exec = /^ExecStart\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/m.exec(unit)
  expect(exec, 'installed unit declares ExecStart').not.toBeNull()
  return exec![1] ?? exec![2] ?? exec![3]!
}

test.each(['openclaw', 'hermes'] as const)(
  'test_c10_%s_manual_command_uses_installed_path_and_pinned_node_without_node_in_PATH', (source) => {
    const f = fixture({ dropNode: true })
    const path = addSource(f, source, true)
    const result = run(f)
    success(result)
    expect(calls(f, 'migrate')).toHaveLength(0)
    const absent = spawnSync('/bin/sh', ['-c', 'command -v node'], { env: f.env, encoding: 'utf8' })
    expect(absent.status, 'node is really absent after the installer resolves its binary').not.toBe(0)
    const command = manual(f, result, source, path)
    expect(command).toContain(join(f.app, 'scripts/dshbot-migrate'))
    const migration = calls(f, 'migrate')[0]!
    expect(migration.execPath).toBe(unitNode(f))
    expect(migration.execPath).toBe(process.execPath)
  },
)

test('test_c10_automatic_migration_uses_pinned_node_after_PATH_node_disappears', () => {
  const f = fixture({ dropNode: true })
  const path = addSource(f, 'hermes', true)
  const result = run(f, ['--migrate=hermes', '--yes'])
  success(result)
  installed(f)
  const migrations = calls(f, 'migrate')
  expect(migrations).toHaveLength(2)
  for (const call of migrations) {
    selected(call, 'hermes', path)
    expect(call.execPath).toBe(unitNode(f))
    expect(call.entry).toBe(join(f.app, 'packages/migrate/src/cli.ts'))
  }
})

test.each(['manual', 'decline', 'dry-only', 'apply', 'dry-error', 'apply-error', 'none'] as const)(
  'test_c11_%s_never_discloses_entered_or_existing_settings', async (mode) => {
    const f = fixture({ existing: true, dryExit: mode === 'dry-error' ? 7 : 0,
      applyExit: mode === 'apply-error' ? 9 : 0 })
    addSource(f, 'openclaw', true)
    f.env.TELEGRAM_BOT_TOKEN = undefined
    f.env.DEEPSEEK_API_KEY = undefined
    const args = mode === 'none' ? ['--migrate=none'] : mode === 'manual' || mode === 'decline' ? [] : ['--migrate=openclaw']
    const answers = mode === 'decline' ? ['нет'] : mode === 'dry-only' ? ['нет'] : ['да']
    // Manual mode uses no TTY but still feeds install credentials. Other modes
    // exercise secret prompts and the migration conversation in a real terminal.
    const result = mode === 'manual' ? run(f, args, `${token}\n${key}\n`) :
      await interactive(f, args, answers, true)
    success(result)
    installed(f)
    for (const secret of [token, key, storedToken, storedKey, extraSecret]) expect(result.output).not.toContain(secret)
    if (mode === 'manual' || mode === 'decline' || mode === 'none') expect(calls(f, 'migrate')).toHaveLength(0)
    else {
      expect(result.output).toContain(planMarker)
      expect(calls(f, 'migrate')).toHaveLength(mode === 'dry-only' || mode === 'dry-error' ? 1 : 2)
    }
  },
)
