// The exec sandbox under the fake root of container mode: scripts/dshbot-run.sh with DSHBOT_ISOLATION=container
// runs the daemon as uid 0 of a user namespace that keeps no capability but CAP_SETFCAP, so the profile must ask
// bwrap for a user namespace of its own and drop the capabilities itself. The same container must leave the fake
// root no way to make its read-only binds writable: no remount, no unmount, nothing through a nested user namespace.
// The launcher is copied into an application directory inside DSHBOT_HOME, the layout of deploy/dshbot.service.
// Where bwrap cannot start the tests are skipped.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { sandboxProfile } from './src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'
const TEST_TIMEOUT_MS = 60_000

function bwrapWorks(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-fake-root-probe-'))
  try {
    const profile = sandboxProfile({ home: scratch, workspace: scratch, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const sandboxed = bwrapWorks()

interface Layout {
  scratch: string
  owner: string
  dshbotHome: string
  app: string
  launcher: string
  workspace: string
  readOnly: string
}

let layout: Layout

beforeEach(() => {
  let scratch = ''
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      scratch = realpathSync(mkdtempSync(join(base, 'dshbot-exec-fake-root-')))
      break
    } catch {
      // try the next base
    }
  }
  const owner = join(scratch, 'owner')
  const dshbotHome = join(owner, '.local', 'share', 'dshbot')
  const app = join(dshbotHome, 'app')
  const launcher = join(app, 'scripts', 'dshbot-run.sh')
  const workspace = join(dshbotHome, 'workspace')
  const readOnly = join(scratch, 'owner-tools')
  mkdirSync(dirname(launcher), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(readOnly, { recursive: true })
  copyFileSync(join(repoRoot, 'scripts', 'dshbot-run.sh'), launcher)
  writeFileSync(join(app, 'code.txt'), 'APP-CODE\n')
  writeFileSync(join(readOnly, 'code.txt'), 'OWNER-TOOL\n')
  layout = { scratch, owner, dshbotHome, app, launcher, workspace, readOnly }
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(layout.scratch, { recursive: true, force: true })
})

function launchContainer(command: string[]): SpawnSyncReturns<string> {
  return spawnSync(BASH, [layout.launcher, ...command], {
    cwd: layout.app,
    encoding: 'utf8',
    timeout: 45_000,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: layout.owner,
      DSHBOT_HOME: layout.dshbotHome,
      DSHBOT_ISOLATION: 'container',
      // the nested profile binds the daemon's node binary, so the container has to see it
      DSHBOT_CONTAINER_RO: [layout.readOnly, dirname(process.execPath)].join(':'),
    },
  })
}

function describeRun(r: SpawnSyncReturns<string>): string {
  return `status=${String(r.status)} signal=${String(r.signal)} error=${String(r.error)}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
}

test.skipIf(!sandboxed)('test_exec_profile_under_the_container_fake_root_starts_the_nested_sandbox', { timeout: TEST_TIMEOUT_MS }, () => {
  const probe = [
    '/bin/sh',
    '-c',
    'echo "UID=$(id -u)"; grep CapEff /proc/self/status; echo inside > "$1/made.txt" && echo WORKSPACE-WRITE-OK',
    'sh',
    layout.workspace,
  ]

  // control: the profile of an ordinary user leaves the user namespace to bwrap, which uid 0 does not get
  if (process.getuid?.() !== 0) {
    const plain = sandboxProfile({ home: layout.owner, workspace: layout.workspace, roPaths: [] })
    expect(plain, 'an ordinary user needs no explicit user namespace').not.toContain('--unshare-user')
    const failed = launchContainer([...plain, ...probe])
    expect(failed.status, `without its own user namespace the nested sandbox cannot start\n${describeRun(failed)}`).not.toBe(0)
    expect(failed.stdout).not.toContain('WORKSPACE-WRITE-OK')
  }

  vi.spyOn(process, 'getuid').mockReturnValue(0)
  const profile = sandboxProfile({ home: layout.owner, workspace: layout.workspace, roPaths: [] })
  vi.restoreAllMocks()
  const at = profile.indexOf('--cap-drop')
  expect(profile, 'uid 0 asks for a user namespace').toContain('--unshare-user')
  expect(at >= 0 && profile[at + 1] === 'ALL', `uid 0 drops every capability: ${profile.join(' ')}`).toBe(true)

  const r = launchContainer([...profile, ...probe])
  expect(r.status, `the nested sandbox must start under the fake root\n${describeRun(r)}`).toBe(0)
  expect(r.stdout).toContain('UID=0\n')
  expect(r.stdout, 'the command in the nested sandbox has no capabilities').toMatch(/^CapEff:\s+0+$/m)
  expect(r.stdout).toContain('WORKSPACE-WRITE-OK')
  expect(readFileSync(join(layout.workspace, 'made.txt'), 'utf8'), 'the write lands in the real workspace').toBe('inside\n')
})

test.skipIf(!sandboxed)('test_container_fake_root_cannot_make_its_read_only_binds_writable', { timeout: TEST_TIMEOUT_MS }, () => {
  // Every successful bypass prints a marker ending in -BYPASS; the control write into DSHBOT_HOME must succeed.
  const attack = [
    'grep CapEff /proc/self/status',
    'echo control > "$3/control.txt" && echo HOME-WRITE-OK',
    'for t in "$1" "$2"; do',
    '  if mount -o remount,rw,bind "$t" 2>/dev/null; then echo "REMOUNT-BYPASS $t"; fi',
    '  if umount -l "$t" 2>/dev/null; then echo "UMOUNT-BYPASS $t"; fi',
    '  if echo x >> "$t/code.txt" 2>/dev/null; then echo "WRITE-BYPASS $t"; fi',
    'done',
    // a nested user namespace gets every capability over a copy of the mounts; the kernel keeps them locked
    "unshare -Urm sh -c '",
    '  for t in \"$0\" \"$1\"; do',
    '    if mount -o remount,rw,bind \"$t\" 2>/dev/null; then echo \"NESTED-REMOUNT-BYPASS $t\"; fi',
    '    if umount -l \"$t\" 2>/dev/null; then echo \"NESTED-UMOUNT-BYPASS $t\"; fi',
    '    if echo x >> \"$t/code.txt\" 2>/dev/null; then echo \"NESTED-WRITE-BYPASS $t\"; fi',
    '  done',
    '  mkdir -p /tmp/peek /tmp/rpeek',
    '  if mount --bind \"$2\" /tmp/peek 2>/dev/null && echo x >> /tmp/peek/app/code.txt 2>/dev/null; then echo BIND-BYPASS; fi',
    '  if mount --rbind \"$2\" /tmp/rpeek 2>/dev/null; then',
    '    umount -l /tmp/rpeek/app 2>/dev/null',
    '    if echo x >> /tmp/rpeek/app/code.txt 2>/dev/null; then echo RBIND-BYPASS; fi',
    '  fi',
    '  echo NESTED-DONE',
    `' "$1" "$2" "$3"`,
    'echo ATTACK-DONE',
  ].join('\n')

  const r = launchContainer(['/bin/sh', '-c', attack, 'sh', layout.app, layout.readOnly, layout.dshbotHome])
  expect(r.status, `the attack script must run to the end\n${describeRun(r)}`).toBe(0)
  expect(r.stdout, 'the probe ran').toContain('ATTACK-DONE')
  expect(r.stdout, 'the control write into DSHBOT_HOME works').toContain('HOME-WRITE-OK')
  expect(r.stdout, 'the fake root keeps no CAP_SYS_ADMIN (only CAP_SETFCAP)').toMatch(/^CapEff:\s+0*80000000$/m)
  expect(r.stdout, 'no read-only bind became writable').not.toContain('-BYPASS')
  expect(readFileSync(join(layout.app, 'code.txt'), 'utf8'), 'the application directory is unchanged').toBe('APP-CODE\n')
  expect(readFileSync(join(layout.readOnly, 'code.txt'), 'utf8'), 'the DSHBOT_CONTAINER_RO path is unchanged').toBe('OWNER-TOOL\n')
})
