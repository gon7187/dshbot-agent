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
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

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
    { label: 'plain rm', command: (file) => `rm '${file}'` },
    { label: 'unlink', command: (file) => `unlink '${file}'` },
    { label: 'find -delete', command: (file, dir) => `find '${dir}' -name '${file.split(sep).pop()}' -delete` },
    { label: 'rm -rf of the directory', command: (_file, dir) => `rm -rf '${dir}'` },
    { label: 'rm -r of the directory', command: (_file, dir) => `rm -r '${dir}'` },
    { label: 'rm with a glob', command: (_file, dir) => `rm -f '${dir}'/*` },
    { label: 'rm -rf with a relative path from HOME', command: (file) => `rm -rf ${relativeOutside}/${file.split(sep).pop()}` },
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
    { label: 'redirect >>', command: (file) => `echo HACKED >> '${file}'` },
    { label: 'empty redirect', command: (file) => `: > '${file}'` },
    { label: 'truncate', command: (file) => `truncate -s 0 '${file}'` },
    { label: 'mv away', command: (file, dir) => `mv '${file}' '${dir}/renamed.txt'` },
    { label: 'mv into the bot home', command: (file) => `mv '${file}' '${botHome}/stolen.txt'` },
    { label: 'mv over it', command: (file, dir) => `echo HACKED > '${dir}/other.txt'; mv '${dir}/other.txt' '${file}'` },
    { label: 'chmod 000', command: (file) => `chmod 000 '${file}'` },
    { label: 'chmod 777', command: (file) => `chmod 777 '${file}'` },
    { label: 'sed -i', command: (file) => `sed -i 's/ORIGINAL/HACKED/' '${file}'` },
    { label: 'dd of=', command: (file) => `echo HACKED | dd of='${file}' 2>/dev/null` },
    { label: 'tee', command: (file) => `echo HACKED | tee '${file}'` },
    { label: 'cp over it', command: (file) => `echo HACKED > '${tmpDir}/src.txt'; cp '${tmpDir}/src.txt' '${file}'` },
    { label: 'shred', command: (file) => `shred -u '${file}'` },
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
    { label: 'python3 os.remove', command: (file) => `python3 -c "import os; os.remove('${file}')"` },
    { label: 'python3 open w', command: (file) => `python3 -c "open('${file}', 'w').write('HACKED')"` },
    { label: 'node fs.rmSync', command: (file) => `${node()} -e "require('fs').rmSync('${file}')"` },
    { label: 'node fs.writeFileSync', command: (file) => `${node()} -e "require('fs').writeFileSync('${file}', 'HACKED')"` },
    { label: 'variable in rm', command: (file) => `X='${file}'; rm -f $X` },
    { label: 'variable in redirect', command: (file) => `X='${file}'; echo HACKED > "$X"` },
    { label: 'variable holding the command', command: (file) => `CMD=rm; $CMD -f '${file}'` },
    { label: 'command substitution path', command: (file) => `rm -f "$(printf %s '${file}')"` },
    { label: 'command substitution in redirect', command: (file) => `echo HACKED > $(echo '${file}')` },
    { label: 'backticks', command: (file) => `rm -f \`echo '${file}'\`` },
    { label: 'eval', command: (file) => `eval "rm -f '${file}'"` },
    { label: 'bash -c', command: (file) => `bash -c "rm -f '${file}'"` },
    { label: 'xargs', command: (file) => `echo '${file}' | xargs rm -f` },
    { label: 'find -exec', command: (file) => `find '${file}' -exec rm -f {} \\;` },
  ]
  for (const item of cases) {
    const dir = mkdtempSync(join(outside, 'case-'))
    const file = victim(dir, 'precious.txt')
    const outcome = await run(item.command(file))
    expectUntouched(file, item.label, outcome)
  }
})

test('test_c4_host_exec_local_explains_in_russian_why_writing_outside_the_bot_home_is_forbidden', { timeout: TEST_TIMEOUT_MS }, async () => {
  const cases: Array<{ label: string; command: (file: string) => string }> = [
    { label: 'rm -f', command: (file) => `rm -f '${file}'` },
    { label: 'redirect', command: (file) => `echo HACKED > '${file}'` },
    { label: 'truncate', command: (file) => `truncate -s 0 '${file}'` },
    { label: 'python3', command: (file) => `python3 -c "import os; os.remove('${file}')"` },
    { label: 'variable', command: (file) => `X='${file}'; rm -f $X` },
    { label: 'substitution', command: (file) => `rm -f "$(printf %s '${file}')"` },
  ]
  for (const item of cases) {
    const dir = mkdtempSync(join(outside, 'case-'))
    const file = victim(dir, 'precious.txt')
    const outcome = await run(item.command(file))
    expectUntouched(file, item.label, outcome)
    const note = `${item.label}: ${outcome.text}`
    expect(outcome.text, `a Russian explanation (${note})`).toMatch(/[а-яё]{4,}/i)
    expect(outcome.text, `the explanation says it is forbidden (${note})`).toMatch(/запрещ|нельзя|отказ/i)
    expect(outcome.text, `names DSHBOT_HOME (${note})`).toContain('DSHBOT_HOME')
    expect(outcome.text, `names /tmp (${note})`).toContain('/tmp')
    expect(outcome.text, `names DSHBOT_HOST_WRITABLE (${note})`).toContain('DSHBOT_HOST_WRITABLE')
  }
})

test('test_c5_host_exec_local_inside_the_bot_home_and_tmp_works_as_before', { timeout: TEST_TIMEOUT_MS }, async () => {
  const places = [
    ['DSHBOT_HOME', botHome],
    ['/tmp', tmpDir],
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
  // A plain redirect and a plain rm raise no card, as the guard rules stand.
  const plain = cards.filter((card) => /^(echo ONE > |rm -f )/.test(card.command))
  expect(plain.map((card) => card.command)).toEqual([])

  // Interpreters and variables work inside the writable places too (they may or may not ask a card).
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

test('test_c6_host_exec_local_still_reads_outside_files_and_connects_to_a_unix_socket', { timeout: TEST_TIMEOUT_MS }, async () => {
  const file = victim(outside, 'readable.txt')
  const cat = await run(`cat '${file}'`)
  expect(cat.text).toContain('ORIGINAL-CONTENT-do-not-touch')
  const ls = await run(`ls '${outside}'`)
  expect(ls.text).toContain('readable.txt')
  const grep = await run(`grep -c ORIGINAL '${file}'`)
  expect(grep.text).toMatch(/\b1\b/)
  const etc = await run('cat /etc/passwd | head -n 1')
  expect(etc.text).toContain('root')

  const socketPath = join(outside, 's.sock')
  const server = createServer((connection) => {
    connection.on('data', () => connection.end('pong-from-outside-socket'))
  })
  socketServer = server
  await new Promise<void>((ready, failed) => {
    server.once('error', failed)
    server.listen(socketPath, () => ready())
  })
  const script =
    "const c=require('net').connect(process.argv[1]);let d='';c.on('connect',()=>c.write('ping'));" +
    "c.on('data',x=>d+=x);c.on('end',()=>console.log(d));c.on('error',e=>{console.log('ERR '+e.message);process.exit(1)})"
  const connected = await run(`${node()} -e "${script}" '${socketPath}'`)
  expect(connected.text, 'the socket answers through host_exec').toContain('pong-from-outside-socket')
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

test('test_c9_exec_sandbox_behaves_as_before', { timeout: TEST_TIMEOUT_MS }, async () => {
  const workspace = join(botHome, 'workspace')
  mkdirSync(workspace)
  const guarded = victim(outside, 'guarded.txt')
  const sandbox = await createExecTools({ workspace, home: botHome })
  try {
    const tool = sandbox.tools.find((candidate) => candidate.name === 'exec')
    expect(tool, 'exec is among the tools').toBeDefined()
    if (tool === undefined) return
    const answer = String(
      await tool.execute(
        { command: `echo SANDBOX-OK > made.txt && cat made.txt; rm -f '${guarded}'; echo HACKED > '${outside}/new.txt'` },
        { signal: new AbortController().signal },
      ),
    )
    expect(answer).toContain('SANDBOX-OK')
    expect(readFileSync(join(workspace, 'made.txt'), 'utf8')).toBe('SANDBOX-OK\n')
    // The sandbox hides the tree of the owner, as before: the file is out of reach there.
    expectUntouched(guarded, 'exec sandbox', { text: answer, threw: false })
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
  } finally {
    await sandbox.stop()
  }
})
