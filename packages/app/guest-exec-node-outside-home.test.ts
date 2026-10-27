// The guest relay and `node` of a guest command run on a Node outside the
// owner's directories. deploy/dshbot.service starts the daemon on the mise
// install under HOME, which the guest namespace masks: a relay started from
// there would not exist, and every guest command would fail before it runs.
// The daemon node here is a stand-in under a scratch HOME; the real node of
// the test run, put on PATH outside it, plays the system Node. The daemon
// red-team of the same profile is guest-sandbox-behavior.test.ts.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { checkCommand } from '../guard/src/index.js'
import {
  createExecTools,
  guestNodeBinary,
  guestSandboxProfile,
  type ExecApprovalRequest,
  type ExecTools,
} from '../tools-exec/src/index.js'

const CONTEXT = { signal: new AbortController().signal, sessionId: 'guest-4242' }
const SYSTEM_NODES = ['/usr/local/bin/node', '/usr/bin/node', '/bin/node']

let scratch = ''
let ownerHome = ''
let workspace = ''
let miseNode = ''
let exec: ExecTools | undefined
const savedPath = process.env.PATH

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-guest-node-')))
  ownerHome = join(scratch, 'home')
  workspace = join(scratch, 'workspace')
  miseNode = join(ownerHome, '.local', 'share', 'mise', 'installs', 'node', '26.8.1', 'bin', 'node')
  mkdirSync(dirname(miseNode), { recursive: true })
  mkdirSync(workspace)
  // If the relay ever ran on this file, the proxy would not come up and the
  // wrapper would stop before the command.
  writeFileSync(miseNode, '#!/bin/sh\necho owner-node-was-used >&2\nexit 97\n', { mode: 0o755 })
})

afterEach(async () => {
  process.env.PATH = savedPath
  if (exec !== undefined) await exec.stop()
  exec = undefined
  rmSync(scratch, { recursive: true, force: true })
})

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

async function run(tools: ExecTools, command: string): Promise<string> {
  const tool = tools.tools.find((item) => item.name === 'exec')
  expect(tool, 'exec is a guest tool').toBeDefined()
  return String(await tool!.execute({ command }, CONTEXT))
}

test('a daemon node under the owner HOME is skipped: the guest relay and node run outside it', { timeout: 60_000 }, async () => {
  const outside = realpathSync(process.execPath)
  expect(within(outside, ownerHome), 'the stand-in system Node lies outside the owner HOME').toBe(false)
  const searchPath = [join(ownerHome, '.local', 'share', 'mise', 'shims'), dirname(miseNode), dirname(outside), savedPath ?? ''].join(delimiter)

  const chosen = guestNodeBinary([ownerHome], miseNode, searchPath)
  expect(chosen, 'a Node outside the owner HOME is chosen').toBe(outside)
  const profile = guestSandboxProfile({ masks: [ownerHome], ownerRoots: [ownerHome], node: chosen! })
  for (let at = 0; at < profile.indexOf('--'); at += 1) {
    if (profile[at] !== '--ro-bind') continue
    for (const path of [profile[at + 1]!, profile[at + 2]!]) {
      expect(within(path, ownerHome), `guest bind under owner HOME: ${path}`).toBe(false)
    }
  }
  const masks = profile.flatMap((arg, index) => (arg === '--tmpfs' ? [profile[index + 1]] : []))
  expect(masks, 'the owner HOME is masked').toContain(ownerHome)

  const command = 'mkdir -p doomed; echo temporary > doomed/file; rm -rf doomed; test ! -e doomed && echo c5-exec-ok'
  expect(checkCommand(command, { sandbox: true }).verdict).toBe('confirm')
  const cards: ExecApprovalRequest[] = []
  process.env.PATH = searchPath
  exec = await createExecTools({
    workspace,
    home: ownerHome,
    guest: true,
    guestMasks: [ownerHome, workspace],
    daemonNode: miseNode,
    approval: async (request) => {
      cards.push(request)
      return 'allow'
    },
  })
  process.env.PATH = savedPath

  const confirmed = await run(exec, command)
  expect(confirmed.split('\n')[0], confirmed).toBe('exit 0')
  expect(confirmed).toContain('c5-exec-ok')
  expect(cards, 'a confirm command of a guest shows no owner card').toEqual([])

  // Inside: the owner HOME is an empty tmpfs (the stand-in is not there), and
  // `node` on PATH is the mounted Node outside it. Running it is a matter of
  // the RLIMIT_DATA cap, not of this file.
  const probe = [
    `test -d ${ownerHome} && test -z "$(ls -A ${ownerHome})" || exit 41`,
    `test ! -e ${miseNode} || exit 42`,
    `grep -F " ${ownerHome} " /proc/self/mountinfo | grep -q " - tmpfs " || exit 43`,
    `test "$(command -v node)" = ${outside} && test -x ${outside} || exit 44`,
    `printf 'guest-node-%s\\n' "$((6 * 7))"`,
  ].join('\n')
  const inside = await run(exec, probe)
  expect(inside.split('\n')[0], inside).toBe('exit 0')
  expect(inside).toContain('guest-node-42')
  expect(inside).not.toContain('owner-node-was-used')
})

test.skipIf(SYSTEM_NODES.some((path) => {
  try {
    realpathSync(path)
    return true
  } catch {
    return false
  }
}))('without a Node outside the owner directories every guest command is refused with a clear error', { timeout: 30_000 }, async () => {
  expect(guestNodeBinary([ownerHome], miseNode, dirname(miseNode))).toBeUndefined()
  process.env.PATH = dirname(miseNode)
  exec = await createExecTools({ workspace, home: ownerHome, guest: true, daemonNode: miseNode })
  process.env.PATH = savedPath
  await expect(run(exec, 'echo NO_NODE_BYPASS')).rejects.toThrow(/нет Node вне каталогов владельца/)
})
