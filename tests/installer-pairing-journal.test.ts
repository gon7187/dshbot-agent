// Like installer.test.ts, run the interactive shell entry point with a disposable
// HOME and command doubles. No real git, npm, systemd, daemon or network is used.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const installer = join(repo, 'scripts/install.sh')
const oldCode = 'A1B2C3'
const currentCode = 'D4E5F6'
const oldInvocation = '11111111111111111111111111111111'
const currentInvocation = '22222222222222222222222222222222'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Call { cmd: string; args: string[] }

function fixture(mode: 'start' | 'restart') {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-pairing-journal-'))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const source = join(root, 'source')
  const app = join(home, '.local/share/dshbot/app')
  const log = join(root, 'commands.jsonl')
  const stateFile = join(root, 'service.json')
  for (const dir of [home, bin, source]) mkdirSync(dir, { recursive: true })
  // Only public product inputs are copied; no checkout metadata or env-files.
  for (const entry of ['package.json', 'deploy']) {
    cpSync(join(repo, entry), join(source, entry), { recursive: true })
  }
  if (mode === 'restart') cpSync(source, app, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(stateFile, JSON.stringify({
    invocation: oldInvocation, started: false, active: mode === 'restart', reads: 0,
  }))

  function fake(name: string, body: string): void {
    writeFileSync(join(bin, name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = ${JSON.stringify(stateFile)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cmd: ${JSON.stringify(name)}, args}) + '\\n');
${body}
`, { mode: 0o755 })
  }

  symlinkSync(process.execPath, join(bin, 'node'))
  fake('git', `
// Emulate the local source transfer, without running git or inspecting metadata.
if (args.includes('init')) {
  fs.cpSync(${JSON.stringify(source)}, args[args.length - 1], {recursive: true});
} else if (args.includes('--is-inside-work-tree')) {
  console.log('true');
} else if (args.includes('rev-parse')) {
  console.log('0123456789012345678901234567890123456789');
}
`)
  fake('npm', '')
  fake('bwrap', '')
  fake('loginctl', "console.log(args.includes('--value') ? 'yes' : 'Linger=yes');")
  fake('systemctl', `
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (args.includes('is-active')) {
  console.log(state.active ? 'active' : 'inactive');
  process.exit(state.active ? 0 : 3);
}
if (args.includes('show') && args.includes('dshbot.service')) {
  console.log(args.includes('--value') ? state.invocation : 'InvocationID=' + state.invocation);
}
if (args.includes('dshbot.service') &&
    (args.includes('start') || args.includes('restart') ||
     (args.includes('enable') && args.includes('--now')))) {
  state.started = true;
  state.active = true;
  state.invocation = ${JSON.stringify(currentInvocation)};
}
fs.writeFileSync(stateFile, JSON.stringify(state));
`)
  fake('journalctl', `
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.reads += 1;
fs.writeFileSync(stateFile, JSON.stringify(state));
// The old process's journal survives removal of the app and its data. The new
// process has no pairing code on the first read (no private message yet).
const old = {invocation: ${JSON.stringify(oldInvocation)}, time: Date.UTC(2000, 0, 1), code: ${JSON.stringify(oldCode)}};
const current = {invocation: state.invocation, time: Date.now(), code: ${JSON.stringify(currentCode)}};
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
  for (const name of ['sudo', 'curl', 'wget', 'npx']) {
    fake(name, "console.error('unexpected external action in pairing fixture'); process.exit(91);")
  }

  return {
    root, log,
    env: {
      HOME: home, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
      USER: 'installer-fixture', LOGNAME: 'installer-fixture', LANG: 'C.UTF-8', TZ: 'UTC',
      DSHBOT_INSTALL_SRC: source, DSHBOT_ISOLATION: 'container',
      TELEGRAM_BOT_TOKEN: '7000001:AAFixtureToken0123456789', DEEPSEEK_API_KEY: 'sk-fixture-only',
    },
  }
}

test.each(['start', 'restart'] as const)(
  'test_h4_pairing_waits_for_current_service_invocation_after_%s',
  { timeout: 20_000 },
  (mode) => {
    const f = fixture(mode)
    expect(existsSync(installer), 'interactive installer must exist').toBe(true)
    // No --yes: that mode only prints instructions and never polls the journal.
    // Credentials in the fixture environment avoid prompts blocking this path.
    const result = spawnSync('/bin/bash', [installer], {
      cwd: f.root, env: f.env, input: '', encoding: 'utf8', timeout: 15_000,
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.error, output).toBeUndefined()
    expect(result.status, output).toBe(0)
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Call)
    const serviceStart = calls.findIndex(({ cmd, args }) => cmd === 'systemctl' &&
      args.includes('dshbot.service') && (mode === 'restart' ? args.includes('restart') :
        args.includes('start') || (args.includes('enable') && args.includes('--now'))))
    const journalRead = calls.findIndex(({ cmd }) => cmd === 'journalctl')
    expect(serviceStart, 'fixture must reach the real service start/restart path').toBeGreaterThanOrEqual(0)
    expect(journalRead, 'interactive pairing must read the journal after starting the service').toBeGreaterThan(serviceStart)
    expect(output, 'a pairing code from the previous process must never be offered').not.toContain(oldCode)
    expect(output, 'wait for the code generated by the current process').toContain(currentCode)
    const journalCalls = calls.filter(({ cmd }) => cmd === 'journalctl')
    expect(journalCalls.length >= 2 || journalCalls.some(({ args }) =>
      args.includes('-f') || args.includes('--follow')),
    'the current process has no code in the first snapshot; keep waiting').toBe(true)
  },
)
