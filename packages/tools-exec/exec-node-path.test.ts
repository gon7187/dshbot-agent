// The exec sandbox must carry the node of the daemon: PATH starts with the directory of the binary
// that runs the daemon, and the mise shims (which need a mise config that an empty HOME does not
// have) are not on it. The tests drive createExecTools directly against the real bwrap; the daemon
// PATH is seeded with the shims first, the way a mise-managed host has it. Where bwrap cannot start
// at all, the tests that need a sandbox are skipped.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, sandboxProfile, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const MISE_SHIMS = join(HOME, '.local/share/mise/shims')
const MISE_DIR = join(HOME, '.local/share/mise')
const NODE_DIR = dirname(process.execPath)

/** True when the profile the tool builds can start on this machine. */
function bwrapWorks(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-probe-'))
  try {
    const profile = sandboxProfile({ home: HOME, workspace: scratch, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The node directory has to be visible inside the sandbox for the node test to mean anything. */
function nodeIsMounted(): boolean {
  const roots = ['/usr', '/bin', '/opt', '/nix', join(HOME, '.local/share/mise'), join(HOME, '.local/bin')]
  const real = existsSync(process.execPath) ? realpathSync(process.execPath) : process.execPath
  return [process.execPath, real].some((path) => roots.some((root) => path === root || path.startsWith(root + sep)))
}

const sandboxed = bwrapWorks()
const nodeVisible = nodeIsMounted()

let workspace = ''
let exec: ExecTools
let previousPath: string | undefined

async function run(command: string): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec')
  if (tool === undefined) throw new Error('exec tool is missing')
  return String(await tool.execute({ command, timeout_sec: 60 }, { signal: new AbortController().signal }))
}

/** Text after the `exit N` status line, without the untrusted frame around the output. */
function stdoutOf(answer: string): string {
  const open = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>$/m.exec(answer)
  if (open === null) return answer.slice(answer.indexOf('\n') + 1)
  const closing = `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${open[1]}">>>`
  const afterOpen = answer.indexOf('\n', open.index) + 1
  const noticeEnd = answer.indexOf('\n', afterOpen)
  const body = answer.slice(noticeEnd + 1, answer.lastIndexOf(closing))
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

beforeAll(async () => {
  if (!sandboxed) return
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-node-'))
  previousPath = process.env.PATH
  // A mise host: the shims come before everything, the node directory is not on PATH on its own.
  process.env.PATH = [MISE_SHIMS, '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter)
  try {
    exec = await createExecTools({ workspace, home: HOME })
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

test.skipIf(!sandboxed || !nodeVisible)(
  'test_node_node_and_npm_and_npx_resolve_to_the_daemon_node',
  { timeout: 120_000 },
  async () => {
    const answer = await run(['node -v', 'npm -v', 'npx' + ' --version'].join(' && '))
    expect(answer.startsWith('exit 0\n'), `the chain exits with 0\n${answer}`).toBe(true)
    const lines = stdoutOf(answer)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    expect(lines[0], `node prints the version of the daemon node\n${answer}`).toBe(process.version)
    expect(lines[1], `npm prints a version\n${answer}`).toMatch(/^\d+\.\d+\.\d+/)
    expect(lines[2], `the third tool prints a version\n${answer}`).toMatch(/^\d+\.\d+\.\d+/)
  },
)

test.skipIf(!sandboxed || !nodeVisible)(
  'test_path_starts_with_the_daemon_node_dir_and_has_no_mise_shims',
  { timeout: 120_000 },
  async () => {
    const answer = await run('echo "PATH=[$PATH]"')
    expect(answer.startsWith('exit 0\n'), `the command exits with 0\n${answer}`).toBe(true)
    const match = /PATH=\[([^\]\n]*)\]/.exec(answer)
    expect(match, `the PATH is printed\n${answer}`).not.toBeNull()
    const entries = (match?.[1] ?? '').split(delimiter).filter((entry) => entry !== '')
    expect(entries[0], `the first PATH entry is the directory of the daemon node\n${entries.join('\n')}`).toBe(NODE_DIR)
    const shims = entries.filter((entry) => /(^|\/)mise\/shims\/?$/.test(entry) || entry === MISE_SHIMS)
    expect(shims, `no mise shims directory on the sandbox PATH\n${entries.join('\n')}`).toEqual([])
  },
)

test('test_profile_keeps_empty_home_read_only_system_and_writable_workspace_only', () => {
  const ws = '/tmp/dshbot-profile-workspace'
  const args = sandboxProfile({ home: HOME, workspace: ws, roPaths: [] })

  const tmpfsTargets = args.flatMap((arg, index) => (arg === '--tmpfs' ? [args[index + 1]] : []))
  expect(tmpfsTargets, 'HOME is an empty tmpfs').toContain(HOME)

  const roSources = args.flatMap((arg, index) => (arg === '--ro-bind' ? [args[index + 1]] : []))
  expect(roSources, 'the root is never mounted whole').not.toContain('/')
  expect(args.includes('--ro-bind-try') && args.includes('/')).toBe(false)

  const rwSources = args.flatMap((arg, index) => (arg === '--bind' ? [args[index + 1]] : []))
  expect(rwSources, 'the workspace is the only writable bind').toEqual([ws])
  expect(args.indexOf('--chdir')).toBeGreaterThan(-1)
  expect(args[args.length - 1]).toBe('--')
})

test.skipIf(!sandboxed)('test_profile_runtime_writes_only_in_workspace', { timeout: 120_000 }, async () => {
  const probeFile = join(workspace, 'writable.txt')
  const answer = await run(
    `echo ok > "${probeFile}"; touch /usr/should-not-exist 2>/dev/null && echo USR-WRITABLE; ` +
      `touch "${MISE_DIR}/should-not-exist" 2>/dev/null && echo MISE-WRITABLE; echo done`,
  )
  expect(answer, `the command finishes\n${answer}`).toContain('done')
  expect(answer, `the system stays read-only\n${answer}`).not.toContain('USR-WRITABLE')
  expect(answer, `the toolchain stays read-only\n${answer}`).not.toContain('MISE-WRITABLE')
  expect(readFileSync(probeFile, 'utf8').trim(), 'the workspace is writable').toBe('ok')
})
