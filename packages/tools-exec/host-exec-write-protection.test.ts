// host_exec with a local alias runs outside the exec sandbox, so a plain `rm` could delete any file of the
// owner. The rule: such a command may create, change and delete files only inside DSHBOT_HOME, /tmp and the
// directories of DSHBOT_HOST_WRITABLE (a colon-separated list); everywhere else the file stays as it was,
// whatever shape the command takes (a redirect, an interpreter, a variable, a substitution), even when the
// owner presses the allow button. Reading and connecting to an existing unix socket stay possible.
//
// The tests drive createHostExecTools directly. The scratch tree lives under the HOME of the test process
// (or /var/tmp when HOME is unusable), never under /tmp, so «outside» really is outside the three writable
// places. The approval is a spy that always allows: the files must survive the worst case.

import { createServer, type Server } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createExecTools, type ExecApprovalRequest } from './src/index.js'
import { createHostExecTools } from './src/host.js'

const TEST_TIMEOUT_MS = 90_000
const ORIGINAL = 'ORIGINAL-CONTENT-do-not-touch\n'
const ORIGINAL_MODE = 0o640

const TOUCHED = ['DSHBOT_HOME', 'DSHBOT_HOST_WRITABLE'] as const

function underTmp(path: string): boolean {
  const real = existsSync(path) ? realpathSync(path) : path
  return real === '/tmp' || real.startsWith('/tmp/')
}

/** A base directory that is outside /tmp: the HOME of the process first, /var/tmp as the fallback. */
function makeBase(): string {
  const candidates = [process.env.HOME ?? homedir(), '/var/tmp', process.cwd()]
  for (const candidate of candidates) {
    try {
      const parent = realpathSync(resolve(candidate))
      if (underTmp(parent)) continue
      return realpathSync(mkdtempSync(join(parent, '.dshbot-write-guard-')))
    } catch {
      // try the next candidate
    }
  }
  throw new Error('no writable directory outside /tmp for the test')
}

let base = ''
let botHome = ''
let outside = ''
let extra = ''
let tmpDir = ''
let cards: ExecApprovalRequest[] = []
let saved: Record<string, string | undefined> = {}
let socketServer: Server | undefined

beforeEach(() => {
  saved = {}
  for (const name of TOUCHED) saved[name] = process.env[name]
  base = makeBase()
  botHome = join(base, 'home')
  outside = join(base, 'outside')
  extra = join(base, 'extra')
  mkdirSync(botHome)
  mkdirSync(outside)
  mkdirSync(extra)
  tmpDir = realpathSync(mkdtempSync('/tmp/dshbot-write-guard-'))
  writeFileSync(join(botHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))
  process.env.DSHBOT_HOME = botHome
  delete process.env.DSHBOT_HOST_WRITABLE
  cards = []
})

afterEach(async () => {
  for (const name of TOUCHED) {
    const value = saved[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (socketServer !== undefined) {
    const server = socketServer
    socketServer = undefined
    await new Promise<void>((done) => server.close(() => done()))
  }
  rmSync(base, { recursive: true, force: true })
  rmSync(tmpDir, { recursive: true, force: true })
})

interface Outcome {
  text: string
  threw: boolean
}

/** What the model gets: the answer of the tool or the message of the error it threw. */
async function run(command: string, decision: 'allow' | 'deny' = 'allow'): Promise<Outcome> {
  const { tools } = createHostExecTools({
    home: botHome,
    secrets: [],
    timeoutMs: 30_000,
    approval: async (request) => {
      cards.push(request)
      return decision
    },
  })
  const tool = tools[0]
  if (tool === undefined) throw new Error('host_exec is not created')
  try {
    const text = String(await tool.execute({ host: 'box', command }, { signal: new AbortController().signal }))
    return { text, threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

function victim(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, ORIGINAL)
  chmodSync(path, ORIGINAL_MODE)
  return path
}

function expectUntouched(path: string, label: string, outcome: Outcome): void {
  const note = `${label}: ${outcome.text}`
  expect(existsSync(path), `the file still exists (${note})`).toBe(true)
  expect(readFileSync(path, 'utf8'), `the content is unchanged (${note})`).toBe(ORIGINAL)
  expect(statSync(path).mode & 0o777, `the mode is unchanged (${note})`).toBe(ORIGINAL_MODE)
}

const node = (): string => `'${process.execPath}'`

test('test_c1_host_exec_local_does_not_delete_files_or_directories_outside_the_bot_home', { timeout: TEST_TIMEOUT_MS }, async () => {
  // The command starts in HOME, so a path relative to it names the same directory.
  const relativeOutside = relative(realpathSync(resolve(process.env.HOME ?? homedir())), outside)
  const cases: Array<{ label: string; command: (file: string, dir: string) => string }> = [
    { label: 'rm -f', command: (file) => `rm -f '${file}'` },
    { label: 'rm -rf of the directory', command: (_file, dir) => `rm -rf '${dir}'` },
    { label: 'rm after cd', command: (file, dir) => `cd '${dir}' && rm -f ./${file.split(sep).pop()}` },
  ]
  for (const item of cases) {
    const dir = mkdtempSync(join(outside, 'case-'))
    const file = victim(dir, 'precious.txt')
    const outcome = await run(item.command(file, dir))
    expectUntouched(file, item.label, outcome)
    expect(existsSync(dir), `the directory still exists (${item.label}: ${outcome.text})`).toBe(true)
  }
})

test('test_c2_host_exec_local_does_not_overwrite_truncate_move_or_chmod_files_outside_the_bot_home', { timeout: TEST_TIMEOUT_MS }, async () => {
  const cases: Array<{ label: string; command: (file: string, dir: string) => string }> = [
    { label: 'redirect >', command: (file) => `echo HACKED > '${file}'` },
    { label: 'mv away', command: (file, dir) => `mv '${file}' '${dir}/renamed.txt'` },
    { label: 'chmod 777', command: (file) => `chmod 777 '${file}'` },
  ]
  for (const item of cases) {
    const dir = mkdtempSync(join(outside, 'case-'))
    const file = victim(dir, 'precious.txt')
    const outcome = await run(item.command(file, dir))
    expectUntouched(file, item.label, outcome)
    expect(existsSync(join(dir, 'renamed.txt')), `no renamed copy appeared (${item.label})`).toBe(false)
    expect(existsSync(join(botHome, 'stolen.txt')), `nothing was moved into the bot home (${item.label})`).toBe(false)
  }
})

test('test_c3_host_exec_local_blocks_interpreters_variables_and_substitutions_outside_the_bot_home', { timeout: TEST_TIMEOUT_MS }, async () => {
  const cases: Array<{ label: string; command: (file: string) => string }> = [
    { label: 'python3 open w', command: (file) => `python3 -c "open('${file}', 'w').write('HACKED')"` },
    { label: 'node fs.writeFileSync', command: (file) => `${node()} -e "require('fs').writeFileSync('${file}', 'HACKED')"` },
    { label: 'variable holding the command', command: (file) => `CMD=rm; $CMD -f '${file}'` },
    { label: 'command substitution in redirect', command: (file) => `echo HACKED > $(echo '${file}')` },
  ]
  for (const item of cases) {
    const dir = mkdtempSync(join(outside, 'case-'))
    const file = victim(dir, 'precious.txt')
    const outcome = await run(item.command(file))
    expectUntouched(file, item.label, outcome)
  }
})

test('test_c5_host_exec_local_inside_the_bot_home_and_tmp_works_as_before', { timeout: TEST_TIMEOUT_MS }, async () => {
  const places = [
    ['DSHBOT_HOME', botHome],
  ] as const
  for (const [label, dir] of places) {
    const created = join(dir, 'created.txt')
    const made = await run(`echo ONE > '${created}'`)
    expect(readFileSync(created, 'utf8'), `${label} create: ${made.text}`).toBe('ONE\n')

    const appended = await run(`echo TWO >> '${created}'; sed -i 's/ONE/FIRST/' '${created}'`)
    expect(readFileSync(created, 'utf8'), `${label} change: ${appended.text}`).toBe('FIRST\nTWO\n')

    const moved = await run(`mv '${created}' '${dir}/moved.txt'; chmod 600 '${dir}/moved.txt'`)
    expect(existsSync(created), `${label} move: ${moved.text}`).toBe(false)
    expect(statSync(join(dir, 'moved.txt')).mode & 0o777, `${label} chmod: ${moved.text}`).toBe(0o600)

    const removed = await run(`rm -f '${dir}/moved.txt'`)
    expect(existsSync(join(dir, 'moved.txt')), `${label} delete: ${removed.text}`).toBe(false)
  }
  // Local commands ask exactly once even when the guard itself allows them.
  const plain = cards.filter((card) => /^(echo ONE > |rm -f )/.test(card.command))
  expect(plain).toHaveLength(2)

  // After explicit consent, the writable roots still permit these operations.
  for (const [label, dir] of places) {
    const python = await run(`python3 -c "open('${dir}/py.txt', 'w').write('PY')"`)
    expect(readFileSync(join(dir, 'py.txt'), 'utf8'), `${label} python: ${python.text}`).toBe('PY')
    const gone = await run(`X='${dir}/py.txt'; rm -f $X`)
    expect(existsSync(join(dir, 'py.txt')), `${label} variable delete: ${gone.text}`).toBe(false)
  }
  cards = []

  // rm -r still asks the owner, and the answer decides.
  const tree = join(botHome, 'tree')
  mkdirSync(join(tree, 'sub'), { recursive: true })
  writeFileSync(join(tree, 'sub', 'a.txt'), 'A')
  const refused = await run(`rm -r '${tree}'`, 'deny')
  expect(cards.length, `rm -r asks the owner: ${refused.text}`).toBe(1)
  expect(cards[0]?.command).toContain('rm -r')
  expect(existsSync(join(tree, 'sub', 'a.txt')), 'a declined rm -r removes nothing').toBe(true)
  const allowed = await run(`rm -r '${tree}'`, 'allow')
  expect(cards.length, `rm -r asks again: ${allowed.text}`).toBe(2)
  expect(existsSync(tree), `an allowed rm -r inside DSHBOT_HOME removes the tree: ${allowed.text}`).toBe(false)

  const tmpTree = join(tmpDir, 'tree')
  mkdirSync(tmpTree)
  const tmpRemoved = await run(`rm -r '${tmpTree}'`, 'allow')
  expect(cards.length, `rm -r in /tmp asks the owner: ${tmpRemoved.text}`).toBe(3)
  expect(existsSync(tmpTree), `an allowed rm -r in /tmp removes the tree: ${tmpRemoved.text}`).toBe(false)
})

test('test_c7_host_exec_local_host_writable_opens_the_listed_directories_for_writing_and_deleting', { timeout: TEST_TIMEOUT_MS }, async () => {
  // Without the variable the extra directory is read-only.
  const closed = victim(extra, 'closed.txt')
  const before = await run(`rm -f '${closed}'; echo HACKED > '${extra}/new.txt'`)
  expectUntouched(closed, 'no variable', before)
  expect(existsSync(join(extra, 'new.txt')), `no variable, no new file: ${before.text}`).toBe(false)

  // With the variable, the listed directories (colon separated) are open, the others stay closed.
  const second = join(base, 'second')
  mkdirSync(second)
  process.env.DSHBOT_HOST_WRITABLE = `${extra}:${second}`
  const inExtra = victim(extra, 'open.txt')
  const inSecond = victim(second, 'open.txt')
  const guarded = victim(outside, 'guarded.txt')

  const wrote = await run(`echo NEW > '${extra}/new.txt'; echo NEW > '${second}/new.txt'`)
  expect(readFileSync(join(extra, 'new.txt'), 'utf8'), `first listed directory: ${wrote.text}`).toBe('NEW\n')
  expect(readFileSync(join(second, 'new.txt'), 'utf8'), `second listed directory: ${wrote.text}`).toBe('NEW\n')
  const removed = await run(`rm -f '${inExtra}' '${inSecond}'`)
  expect(existsSync(inExtra), `delete in the first listed directory: ${removed.text}`).toBe(false)
  expect(existsSync(inSecond), `delete in the second listed directory: ${removed.text}`).toBe(false)

  const refused = await run(`rm -f '${guarded}'; echo HACKED > '${outside}/new.txt'`)
  expectUntouched(guarded, 'a directory not in the list', refused)
  expect(existsSync(join(outside, 'new.txt')), `a directory not in the list gets no new file: ${refused.text}`).toBe(false)

  // The variable is read when the command runs: removing it closes the directories again.
  delete process.env.DSHBOT_HOST_WRITABLE
  const reclosed = victim(extra, 'again.txt')
  const after = await run(`rm -f '${reclosed}'`)
  expectUntouched(reclosed, 'variable removed', after)
})


test('local host commands never fall back to host when bwrap is missing or broken', async () => {
  const previous = process.env.PATH
  const bin = join(base, 'empty-bin')
  mkdirSync(bin)
  const marker = join(botHome, 'must-not-run')
  try {
    process.env.PATH = bin
    const absent = await run(`echo RAN > '${marker}'`)
    expect(absent.text).toMatch(/bwrap|песочниц/)
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    const broken = await run(`echo RAN > '${marker}'`)
    expect(broken.text).toMatch(/bwrap|песочниц/)
    expect(existsSync(marker)).toBe(false)
    const writableBwrap = join(botHome, 'fake-bwrap')
    writeFileSync(writableBwrap, `#!/bin/sh\necho unsafe > '${marker}'\nexit 0\n`, { mode: 0o755 })
    rmSync(join(bin, 'bwrap'))
    symlinkSync(writableBwrap, join(bin, 'bwrap'))
    const redirected = await run(`echo RAN > '${marker}'`)
    expect(existsSync(marker), redirected.text).toBe(false)
    expect(redirected.text).toMatch(/bwrap|песочниц/)
    writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nprintf \'ssh-route-ran\\n\'\n', { mode: 0o755 })
    writeFileSync(join(botHome, 'hosts.json'), JSON.stringify({ remote: { user: 'test', host: '192.0.2.10' } }))
    const ssh = createHostExecTools({ home: botHome, secrets: [] }).tools[0]!
    expect(String(await ssh.execute({ host: 'remote', command: 'uptime' }, { signal: new AbortController().signal }))).toContain('ssh-route-ran')
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

test('writable mv target options do not make a suppressed outside redirection writable', async () => {
  const source = join(botHome, 'source.txt')
  const target = join(botHome, 'dest')
  const log = victim(outside, 'log')
  mkdirSync(target)
  writeFileSync(source, 'payload')
  const denied = await run(`mv -t '${target}' '${source}' > '${log}' 2>/dev/null; true`)
  expect(readFileSync(log, 'utf8')).toBe(ORIGINAL)
  expect(existsSync(source)).toBe(true)
  expect(existsSync(join(target, 'source.txt'))).toBe(false)
  expect(denied.text).toMatch(/write|запис|измен|доступ|разреш|DSHBOT_HOME/i)
  await run(`mv --target-directory='${target}' '${source}'`)
  expect(readFileSync(join(target, 'source.txt'), 'utf8')).toBe('payload')
  const refused = await run(`mv -t '${outside}' '${join(target, 'source.txt')}'`)
  expect(refused.threw).toBe(true)
  expect(readFileSync(join(target, 'source.txt'), 'utf8')).toBe('payload')
})


test('every local host command needs one consent and readonly PATH remains enforced after approval', { timeout: TEST_TIMEOUT_MS }, async () => {
  const script = join(botHome, 'prepare.mjs')
  const marker = join(botHome, 'approved-script-result')
  writeFileSync(script, "import fs from 'node:fs'; fs.appendFileSync(process.argv[2], 'approved once')\n")
  let decide!: (decision: 'allow' | 'deny') => void
  const { tools } = createHostExecTools({
    home: botHome, secrets: [], timeoutMs: 10_000,
    approval: async (request) => {
      cards.push(request)
      return new Promise<'allow' | 'deny'>((resolve) => { decide = resolve })
    },
  })
  const execute = (command: string) => Promise.resolve(tools[0]!.execute({
    host: 'box', command, purpose: 'Run the harmless approval fixture',
  }, { signal: new AbortController().signal })).then(String, (error: unknown) => String(error))
  const noApproval = createHostExecTools({ home: botHome, secrets: [] }).tools[0]!
  await expect(noApproval.execute({ host: 'box', command: `echo unsafe > '${marker}'` }, { signal: new AbortController().signal })).rejects.toThrow(/подтвержден/)
  expect(existsSync(marker)).toBe(false)
  expect(await execute('gh repo create fixture --public')).toContain('запрещена')
  expect(cards).toHaveLength(0)
  for (const command of ['uname', `${node()} '${script}' '${marker}'`]) {
    const before = cards.length
    const denied = execute(command)
    await vi.waitFor(() => expect(cards).toHaveLength(before + 1))
    expect(existsSync(marker), command).toBe(false)
    decide('deny')
    await denied
    expect(existsSync(marker), command).toBe(false)
    const allowed = execute(command)
    await vi.waitFor(() => expect(cards).toHaveLength(before + 2))
    expect(existsSync(marker), command).toBe(false)
    decide('allow')
    const output = await allowed
    if (command === 'uname') {
      expect(output).toContain('Linux')
      expect(existsSync(marker)).toBe(false)
    } else {
      expect(readFileSync(marker, 'utf8'), `${command}: ${output}`).toBe('approved once')
      rmSync(marker)
    }
  }
  const inherited = process.env.PATH
  try {
    const bin = join(botHome, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'untrusted-host-program'), `#!/bin/sh\necho unsafe > '${marker}'\n`, { mode: 0o755 })
    const alias = join(base, 'path-alias')
    symlinkSync(bin, alias, 'dir')
    process.env.PATH = `:.:${alias}:${inherited ?? '/usr/bin:/bin'}`
    const before = cards.length
    await run('untrusted-host-program')
    expect(existsSync(marker)).toBe(false)
    expect(cards).toHaveLength(before + 1)
    expect((await run('uname')).text).toContain('Linux')
    process.env.PATH = ':.:relative'
    expect((await run('untrusted-host-program')).text).toContain('PATH')
    expect(existsSync(marker)).toBe(false)
    expect(cards).toHaveLength(before + 3)
  } finally {
    if (inherited === undefined) delete process.env.PATH
    else process.env.PATH = inherited
  }
})
