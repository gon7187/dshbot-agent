// host_exec with a local alias is protected by bwrap (writes only inside DSHBOT_HOME, /tmp and the directories
// of DSHBOT_HOST_WRITABLE). When the protection cannot be switched on (no bwrap on the PATH, or a bwrap that
// does not start) the command is not run at all and the model gets a clear Russian error: there is no run
// without the protection. An ssh target does not depend on bwrap and behaves as before.
//
// The tests put a fake `bwrap` (or no bwrap at all) on the PATH of the process. The command is a shell
// builtin that creates a marker file inside DSHBOT_HOME, so a run without the protection is visible, and no
// external program is needed on the PATH to make it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createHostExecTools } from './src/host.js'

const TEST_TIMEOUT_MS = 60_000

const BROKEN_BWRAP = `#!/bin/sh
echo "bwrap: No permissions to create new namespace" >&2
exit 1
`

// Prints the arguments it was started with; a shell builtin only, so it works with an almost empty PATH.
const FAKE_SSH = `#!/bin/sh
for a in "$@"; do printf 'ARG:%s\\n' "$a"; done
`

let scratch = ''
let botHome = ''
let emptyBin = ''
let brokenBin = ''
let sshBin = ''
let savedPath: string | undefined
let savedHome: string | undefined
let approvals = 0

beforeEach(() => {
  savedPath = process.env.PATH
  savedHome = process.env.DSHBOT_HOME
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-host-bwrap-required-'))
  botHome = join(scratch, 'home')
  emptyBin = join(scratch, 'empty-bin')
  brokenBin = join(scratch, 'broken-bin')
  sshBin = join(scratch, 'ssh-bin')
  for (const dir of [botHome, emptyBin, brokenBin, sshBin]) mkdirSync(dir)
  writeFileSync(join(brokenBin, 'bwrap'), BROKEN_BWRAP)
  chmodSync(join(brokenBin, 'bwrap'), 0o755)
  writeFileSync(join(sshBin, 'ssh'), FAKE_SSH)
  chmodSync(join(sshBin, 'ssh'), 0o755)
  writeFileSync(
    join(botHome, 'hosts.json'),
    JSON.stringify({ box: { local: true }, prod: { user: 'deploy', host: '192.0.2.10', port: 2222 } }),
  )
  process.env.DSHBOT_HOME = botHome
  approvals = 0
})

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  if (savedHome === undefined) delete process.env.DSHBOT_HOME
  else process.env.DSHBOT_HOME = savedHome
  rmSync(scratch, { recursive: true, force: true })
})

async function run(host: string, command: string): Promise<{ text: string; threw: boolean }> {
  const { tools } = createHostExecTools({
    home: botHome,
    secrets: [],
    timeoutMs: 20_000,
    approval: async () => {
      approvals += 1
      return 'allow'
    },
  })
  const tool = tools[0]
  if (tool === undefined) throw new Error('host_exec is not created')
  try {
    const text = String(await tool.execute({ host, command }, { signal: new AbortController().signal }))
    return { text, threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

function expectRefusedWithoutProtection(outcome: { text: string }, marker: string): void {
  expect(existsSync(marker), `the command did not run: ${outcome.text}`).toBe(false)
  expect(outcome.text, 'an explanation in Russian').toMatch(/[а-яё]{4,}/i)
  expect(outcome.text, 'the explanation names the protection').toMatch(/bwrap|песочниц|защит/i)
}

test('test_c8_host_exec_local_does_not_run_when_bwrap_is_not_found', { timeout: TEST_TIMEOUT_MS }, async () => {
  process.env.PATH = emptyBin
  const marker = join(botHome, 'ran.txt')
  const outcome = await run('box', `echo RAN > '${marker}'`)
  expectRefusedWithoutProtection(outcome, marker)
})

test('test_c8_host_exec_local_does_not_run_when_bwrap_does_not_start', { timeout: TEST_TIMEOUT_MS }, async () => {
  process.env.PATH = [brokenBin, emptyBin].join(delimiter)
  const marker = join(botHome, 'ran.txt')
  const outcome = await run('box', `echo RAN > '${marker}'`)
  expectRefusedWithoutProtection(outcome, marker)

  // The refusal is not remembered as a success: the next command is refused too.
  const again = await run('box', `echo RAN > '${marker}'`)
  expectRefusedWithoutProtection(again, marker)
})

test('test_c9_host_exec_ssh_target_runs_as_before_and_needs_no_bwrap', { timeout: TEST_TIMEOUT_MS }, async () => {
  process.env.PATH = [sshBin, emptyBin].join(delimiter)
  const outcome = await run('prod', "rm -f '/var/lib/service/old.log'")
  expect(outcome.threw, outcome.text).toBe(false)
  expect(outcome.text).toContain('exit 0')
  for (const line of ['ARG:-o', 'ARG:BatchMode=yes', 'ARG:-p', 'ARG:2222', 'ARG:deploy@192.0.2.10']) {
    expect(outcome.text).toContain(line)
  }
  // The command goes to the remote side untouched: no bwrap wrapper in front of it.
  expect(outcome.text).toContain("ARG:rm -f '/var/lib/service/old.log'")
  expect(approvals, 'a plain rm over ssh asks no card, as before').toBe(0)
})
