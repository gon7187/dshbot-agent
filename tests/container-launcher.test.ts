import { sandboxProfile } from '../packages/tools-exec/src/index.js'
// Container mode of the install: scripts/dshbot-run.sh starts the whole daemon inside bwrap with a user
// namespace (fake root inside, the ordinary user outside) when DSHBOT_ISOLATION=container, and runs the command
// directly for host or an empty value. The launcher is run the way the unit runs it: the command with its
// arguments after the script, the environment carrying DSHBOT_HOME, working directory = the application root.
//
// The probes are tiny `sh -c` scripts that print what they can see; effects are also checked on the host side.
// The fake HOME lives under /var/tmp when it can (the container gets its own /tmp), and DSHBOT_HOME sits inside
// it, as it does for a real install.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, describe, vi } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const launcher = join(repoRoot, 'scripts', 'dshbot-run.sh')

const TEST_TIMEOUT_MS = 60_000
const EXIT_UNAVAILABLE = 77

const SH = existsSync('/bin/sh') ? '/bin/sh' : '/usr/bin/sh'
const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

interface World {
  home: string
  dshbotHome: string
  /** files that live outside DSHBOT_HOME and must stay out of the container */
  decoys: string[]
  /** a directory of the host /tmp with a marker file in it */
  hostTmp: string
  hostTmpMarker: string
}

let scratch: string
let world: World
let noBwrapBin: string | undefined

function makeScratch(): string {
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      return realpathSync(mkdtempSync(join(base, 'dshbot-container-test-')))
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
}

function putFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeAll(() => {
  scratch = makeScratch()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  const home = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(home, '.local', 'share', 'dshbot')
  mkdirSync(dshbotHome, { recursive: true })
  const decoys = [join(home, '.ssh', 'id_test'), join(home, 'secret.txt')]
  for (const decoy of decoys) putFile(decoy, 'HOME-DECOY-SECRET-77\n')
  const hostTmp = mkdtempSync('/tmp/dshbot-container-test-')
  const hostTmpMarker = join(hostTmp, 'host-tmp-marker.txt')
  writeFileSync(hostTmpMarker, 'HOST-TMP-MARKER-77\n')
  world = { home, dshbotHome, decoys, hostTmp, hostTmpMarker }
})

afterEach(() => {
  rmSync(world.hostTmp, { recursive: true, force: true })
})

interface LaunchOptions {
  /** DSHBOT_ISOLATION; undefined leaves it out of the environment */
  isolation?: string
  /** other variables of the environment, undefined removes one */
  env?: Record<string, string | undefined>
  /** replaces PATH */
  path?: string
}

function launch(command: string[], options: LaunchOptions = {}): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = {
    PATH: options.path ?? process.env.PATH ?? '',
    HOME: world.home,
    DSHBOT_HOME: world.dshbotHome,
    ...(options.isolation === undefined ? {} : { DSHBOT_ISOLATION: options.isolation }),
    ...(options.env ?? {}),
  }
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value
  return spawnSync(BASH, [launcher, ...command], { cwd: repoRoot, env: clean, encoding: 'utf8', timeout: 45_000 })
}

function describeRun(r: SpawnSyncReturns<string>): string {
  return `status=${String(r.status)} signal=${String(r.signal)} error=${String(r.error)}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`
}

/** A directory with a link to every program of PATH except bwrap. */
function pathWithoutBwrap(): string {
  if (noBwrapBin !== undefined) return noBwrapBin
  const bin = mkdtempSync(join(scratch, 'nobwrap-'))
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '' || !existsSync(dir)) continue
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === 'bwrap') continue
      try {
        symlinkSync(join(dir, name), join(bin, name))
      } catch {
        // already linked from an earlier directory of PATH
      }
    }
  }
  noBwrapBin = bin
  return bin
}

/** A `bwrap` that records its use in `marker` and then fails the way a host without user namespaces does. */
function fakeBwrap(marker: string, exitCode: number, message: string): string {
  const bin = mkdtempSync(join(scratch, 'fakebwrap-'))
  const fake = join(bin, 'bwrap')
  writeFileSync(fake, `#!/bin/sh\necho called >> '${marker}'\necho '${message}' >&2\nexit ${exitCode}\n`)
  chmodSync(fake, 0o755)
  return bin
}

const CYRILLIC = /[А-Яа-яЁё]/

// --- c1 -------------------------------------------------------------------------------------------------

test('test_c1_container_command_runs_as_fake_root_and_the_process_belongs_to_the_launching_user', { timeout: TEST_TIMEOUT_MS }, () => {
  const probe = join(world.dshbotHome, 'owner-probe.txt')
  const r = launch(
    [SH, '-c', 'echo "UID=$(id -u)"; cat /proc/self/uid_map; touch "$1"; printf "ARGS=%s|%s\\n" "$2" "$3"', 'sh', probe, 'a b', "c'd"],
    { isolation: 'container' },
  )

  expect(r.status, `the command must run\n${describeRun(r)}`).toBe(0)
  expect(r.stdout, 'inside, the uid is 0').toContain('UID=0\n')
  // the user namespace maps inside 0 to the one user outside: "0 <outer uid> 1"
  const outer = process.getuid?.() ?? -1
  expect(r.stdout, `uid_map must map 0 to the launching user (${outer})\n${r.stdout}`).toMatch(new RegExp(`^\\s*0\\s+${outer}\\s+1\\s*$`, 'm'))
  expect(existsSync(probe), 'the file made inside DSHBOT_HOME is on the host').toBe(true)
  expect(statSync(probe).uid, 'outside, the fake root is the user who launched').toBe(outer)
  expect(r.stdout, 'arguments reach the command intact').toContain("ARGS=a b|c'd")
})

// --- c2 -------------------------------------------------------------------------------------------------

test('test_c2_container_dshbot_home_is_writable_and_the_app_directory_is_read_only', { timeout: TEST_TIMEOUT_MS }, () => {
  writeFileSync(join(world.dshbotHome, 'seed.txt'), 'SEED-77\n')
  const appProbe = join(repoRoot, `.container-write-probe-${process.pid}`)
  const r = launch(
    [
      SH,
      '-c',
      [
        'cat "$1/seed.txt"',
        'echo written-inside > "$1/new.txt" && echo HOME-WRITE-OK',
        'if [ -r "$2/package.json" ]; then echo APP-READABLE; fi',
        'if touch "$3" 2>/dev/null; then echo APP-WRITE-OK; else echo APP-WRITE-DENIED; fi',
        'if echo x > "$2/package.json.probe" 2>/dev/null; then echo APP-WRITE-OK; fi',
      ].join('; '),
      'sh',
      world.dshbotHome,
      repoRoot,
      appProbe,
    ],
    { isolation: 'container' },
  )
  try {
    expect(r.status, `the command must run\n${describeRun(r)}`).toBe(0)
    expect(r.stdout).toContain('SEED-77')
    expect(r.stdout, 'DSHBOT_HOME is writable').toContain('HOME-WRITE-OK')
    expect(readFileSync(join(world.dshbotHome, 'new.txt'), 'utf8'), 'the write inside lands in the real DSHBOT_HOME').toBe('written-inside\n')
    expect(r.stdout, 'the app directory is readable').toContain('APP-READABLE')
    expect(r.stdout, 'writing into the app directory fails').toContain('APP-WRITE-DENIED')
    expect(r.stdout, 'writing into the app directory must never succeed').not.toContain('APP-WRITE-OK')
    expect(existsSync(appProbe), 'no file may appear in the app directory').toBe(false)
    expect(existsSync(join(repoRoot, 'package.json.probe'))).toBe(false)
  } finally {
    rmSync(appProbe, { force: true })
    rmSync(join(repoRoot, 'package.json.probe'), { force: true })
  }
})

// --- c3 -------------------------------------------------------------------------------------------------

test('test_c3_container_does_not_see_home_outside_dshbot_home_and_has_its_own_tmp', { timeout: TEST_TIMEOUT_MS }, () => {
  writeFileSync(join(world.dshbotHome, 'control.txt'), 'CONTROL-77\n')
  const insideTmp = `/tmp/dshbot-container-inside-${process.pid}-${Date.now()}`
  const r = launch(
    [
      SH,
      '-c',
      [
        'cat "$1/control.txt"',
        'for p in "$2" "$3" "$4"; do if [ -e "$p" ]; then echo "VISIBLE $p"; else echo "ABSENT $p"; fi; done',
        'echo "=== HOME-LS ==="',
        'ls -A "$5" 2>&1',
        'echo "=== TMP-LS ==="',
        'ls -A /tmp 2>&1',
        'echo "=== END ==="',
        'echo inside > "$6" && echo TMP-WRITE-OK',
      ].join('; '),
      'sh',
      world.dshbotHome,
      ...world.decoys,
      world.hostTmpMarker,
      world.home,
      insideTmp,
    ],
    { isolation: 'container' },
  )
  try {
    expect(r.status, `the command must run\n${describeRun(r)}`).toBe(0)
    expect(r.stdout, 'the command ran and DSHBOT_HOME is visible').toContain('CONTROL-77')
    for (const decoy of [...world.decoys, world.hostTmpMarker]) {
      expect(r.stdout, `${decoy} must not exist inside`).toContain(`ABSENT ${decoy}`)
    }
    expect(r.stdout).not.toContain('VISIBLE ')
    expect(r.stdout).not.toContain('HOME-DECOY-SECRET-77')
    const homeListing = r.stdout.split('=== HOME-LS ===')[1]?.split('=== TMP-LS ===')[0] ?? ''
    const homeNames = homeListing.split('\n').map((line) => line.trim())
    expect(homeNames, '~/.ssh is not listed in the home inside').not.toContain('.ssh')
    expect(homeNames, '~/secret.txt is not listed in the home inside').not.toContain('secret.txt')
    const tmpListing = r.stdout.split('=== TMP-LS ===')[1]?.split('=== END ===')[0] ?? ''
    expect(tmpListing, 'the host /tmp is not visible').not.toContain(world.hostTmp.split('/').pop() as string)
    expect(r.stdout, 'the container has a writable /tmp of its own').toContain('TMP-WRITE-OK')
    expect(existsSync(insideTmp), 'a file written to /tmp inside must not reach the host /tmp').toBe(false)
  } finally {
    rmSync(insideTmp, { force: true })
  }
})

// --- c4 -------------------------------------------------------------------------------------------------

const NODE_PROBE = "console.log(JSON.stringify({ uid: process.getuid(), exec: process.execPath, ok: require('node:fs').existsSync(process.execPath) }))"

function nodeProbe(r: SpawnSyncReturns<string>): { uid: number; exec: string; ok: boolean } {
  const line = r.stdout.split('\n').find((l) => l.startsWith('{')) ?? ''
  return JSON.parse(line) as { uid: number; exec: string; ok: boolean }
}

// --- c5 -------------------------------------------------------------------------------------------------

test('test_c5_container_ro_mounts_listed_paths_read_only_and_warns_about_missing_ones', { timeout: TEST_TIMEOUT_MS }, () => {
  const roOne = join(scratch, `ro-one-${process.pid}`)
  const roTwo = join(scratch, `ro-two-${process.pid}`)
  const missing = join(scratch, `ro-missing-${process.pid}`)
  putFile(join(roOne, 'a.txt'), 'RO-ONE-77\n')
  putFile(join(roTwo, 'b.txt'), 'RO-TWO-77\n')
  const script = [
    'if [ -r "$1/a.txt" ]; then cat "$1/a.txt"; else echo ONE-ABSENT; fi',
    'if [ -r "$2/b.txt" ]; then cat "$2/b.txt"; else echo TWO-ABSENT; fi',
    'if echo x > "$1/w.txt" 2>/dev/null; then echo RO-WRITE-OK; else echo RO-WRITE-DENIED; fi',
    'if [ -e "$3" ]; then echo MISSING-EXISTS; fi',
    'echo SCRIPT-DONE',
  ].join('; ')

  const before = launch([SH, '-c', script, 'sh', roOne, roTwo, missing], { isolation: 'container' })
  expect(before.status, `the command must run\n${describeRun(before)}`).toBe(0)
  expect(before.stdout, 'without DSHBOT_CONTAINER_RO the directory is not mounted').toContain('ONE-ABSENT')
  expect(before.stdout).not.toContain('RO-ONE-77')

  const r = launch([SH, '-c', script, 'sh', roOne, roTwo, missing], {
    isolation: 'container',
    env: { DSHBOT_CONTAINER_RO: [roOne, missing, roTwo].join(':') },
  })
  expect(r.status, `a missing path in the list must not stop the launch\n${describeRun(r)}`).toBe(0)
  expect(r.stdout, 'the command ran').toContain('SCRIPT-DONE')
  expect(r.stdout, 'the first path is mounted').toContain('RO-ONE-77')
  expect(r.stdout, 'the path after the missing one is mounted too').toContain('RO-TWO-77')
  expect(r.stdout, 'the mount is read-only').toContain('RO-WRITE-DENIED')
  expect(r.stdout).not.toContain('RO-WRITE-OK')
  expect(existsSync(join(roOne, 'w.txt')), 'nothing was written to the host directory').toBe(false)
  expect(r.stderr, 'the missing path is named in a warning on stderr').toContain(missing)
})

// --- c7 -------------------------------------------------------------------------------------------------

test('test_c7_host_or_empty_isolation_runs_the_command_directly_without_bwrap', { timeout: TEST_TIMEOUT_MS }, () => {
  const outer = process.getuid?.() ?? -1
  const variants: Array<string | undefined> = [undefined, '', 'host']
  for (const isolation of variants) {
    const label = JSON.stringify(isolation)
    const calls = join(scratch, `bwrap-spy-${Math.random().toString(36).slice(2)}`)
    const spyBin = fakeBwrap(calls, 99, 'bwrap must not be used in host mode')
    const r = launch(
      [
        SH,
        '-c',
        [
          'echo "UID=$(id -u)"',
          'head -n 1 /proc/self/uid_map',
          'if [ -e "$1" ]; then echo HOME-VISIBLE; fi',
          'if [ -e "$2" ]; then echo TMP-VISIBLE; fi',
        ].join('; '),
        'sh',
        world.decoys[0] as string,
        world.hostTmpMarker,
      ],
      // the spy stands in front of the real bwrap, so any use of bwrap is seen
      { ...(isolation === undefined ? {} : { isolation }), path: `${spyBin}${delimiter}${process.env.PATH ?? ''}` },
    )
    expect(r.status, `${label}: the command must run\n${describeRun(r)}`).toBe(0)
    expect(r.stdout, `${label}: the uid is the user's own`).toContain(`UID=${outer}\n`)
    expect(r.stdout, `${label}: no user namespace with fake root`).not.toMatch(new RegExp(`^\\s*0\\s+${outer}\\s+1\\s*$`, 'm'))
    expect(r.stdout, `${label}: HOME is visible as usual`).toContain('HOME-VISIBLE')
    expect(r.stdout, `${label}: the host /tmp is visible`).toContain('TMP-VISIBLE')
    expect(existsSync(calls), `${label}: bwrap must not be called in host mode`).toBe(false)
  }
})

// --- c8 -------------------------------------------------------------------------------------------------

test('test_c8_container_without_bwrap_fails_loudly_in_russian_and_runs_nothing', { timeout: TEST_TIMEOUT_MS }, () => {
  const ran = join(world.dshbotHome, 'must-not-exist.txt')
  const r = launch([SH, '-c', 'echo ran > "$1"; echo RAN-4"2"', 'sh', ran], { isolation: 'container', path: pathWithoutBwrap() })

  expect(r.status, `exit code when bwrap is missing\n${describeRun(r)}`).toBe(EXIT_UNAVAILABLE)
  expect(r.stderr, 'the error is in Russian').toMatch(CYRILLIC)
  expect(r.stderr, 'the error names bwrap').toMatch(/bwrap/i)
  expect(r.stdout, 'the command must not run').not.toContain('RAN-42')
  expect(existsSync(ran), 'nothing may run without the container').toBe(false)
})

test('test_c8_container_with_bwrap_that_cannot_make_a_user_namespace_fails_loudly_in_russian', { timeout: TEST_TIMEOUT_MS }, () => {
  const ran = join(world.dshbotHome, 'must-not-exist.txt')
  const calls = join(scratch, `bwrap-calls-${Math.random().toString(36).slice(2)}`)
  const broken = fakeBwrap(calls, 1, 'bwrap: No permissions to create new namespace')
  const r = launch([SH, '-c', 'echo ran > "$1"; echo RAN-4"2"', 'sh', ran], {
    isolation: 'container',
    path: `${broken}${delimiter}${process.env.PATH ?? ''}`,
  })

  expect(existsSync(calls), 'the launcher must try bwrap before it gives up').toBe(true)
  expect(r.status, `exit code when bwrap cannot make a user namespace\n${describeRun(r)}`).toBe(EXIT_UNAVAILABLE)
  expect(r.stderr, 'the error is in Russian').toMatch(CYRILLIC)
  expect(r.stdout, 'the command must not run').not.toContain('RAN-42')
  expect(existsSync(ran), 'no silent fallback to the host').toBe(false)
})

// --- c9 -------------------------------------------------------------------------------------------------

test('test_c9_unknown_isolation_value_is_refused_with_the_list_of_valid_ones', { timeout: TEST_TIMEOUT_MS }, () => {
  for (const value of ['docker', 'bogus']) {
    const ran = join(world.dshbotHome, `must-not-exist-${value}.txt`)
    const r = launch([SH, '-c', 'echo ran > "$1"; echo RAN-4"2"', 'sh', ran], { isolation: value })

    expect(r.status, `${value}: exit code\n${describeRun(r)}`).toBe(EXIT_UNAVAILABLE)
    expect(r.stderr, `${value}: the error lists the valid values`).toContain('container')
    expect(r.stderr, `${value}: the error lists the valid values`).toContain('host')
    expect(r.stdout, `${value}: the command must not run`).not.toContain('RAN-42')
    expect(existsSync(ran), `${value}: the command must not run`).toBe(false)
  }
})

// --- c10 ------------------------------------------------------------------------------------------------

/** Values of a key in a section of a systemd unit file, in file order. */

describe('nested container execution boundaries', () => {


const repoRoot = fileURLToPath(new URL('..', import.meta.url))
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
})



test('container resolver symlink remains read-only without exposing unrelated runtime state', { timeout: 60_000 }, () => {
  const link = '../run/systemd/resolve/stub-resolv.conf'
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-resolver-test-')))
  try {
    const home = join(scratch, 'owner')
    const dshbotHome = join(home, '.local', 'share', 'dshbot')
    const app = join(dshbotHome, 'app')
    const launcher = join(app, 'scripts', 'dshbot-run.sh')
    const etc = join(scratch, 'host-etc')
    const run = join(scratch, 'host-run')
    const target = link.replace(/^(?:\.\.)?\/run\//, '')
    const resolver = join(run, target)
    const contents = '# resolver fixture\nnameserver 127.0.0.53\nsearch owner.example\noptions edns0 trust-ad\n'
    mkdirSync(dirname(launcher), { recursive: true })
    mkdirSync(etc, { recursive: true })
    mkdirSync(dirname(resolver), { recursive: true })
    mkdirSync(join(run, 'unrelated-service'), { recursive: true })
    copyFileSync(join(repoRoot, 'scripts', 'dshbot-run.sh'), launcher)
    symlinkSync(link, join(etc, 'resolv.conf'))
    writeFileSync(resolver, contents)
    writeFileSync(join(run, 'unrelated-service', 'private'), 'UNRELATED-RUN-SECRET\n')

    const probe = [
      'echo CONTAINER-RESOLVER-BEGIN',
      'cat /etc/resolv.conf',
      'echo CONTAINER-RESOLVER-END',
      'if printf "unexpected-write\\n" >> /etc/resolv.conf 2>/dev/null; then echo RESOLVER-WRITABLE; else echo RESOLVER-READ-ONLY; fi',
      'if [ -e /run/unrelated-service/private ]; then echo UNRELATED-RUN-VISIBLE; fi',
      'echo "CONTAINER-UID=$(id -u)"',
      'echo CONTAINER-PROBE-DONE',
    ].join('\n')
    const launch = (resolverMount?: string) => spawnSync('bwrap', [
      '--unshare-user', '--uid', '0', '--gid', '0',
      // Linux >= 5.12 requires this to map the outer fake root into the launcher's user namespace.
      '--cap-add', 'CAP_SETFCAP',
      '--die-with-parent',
      // The evolve sandbox has no /run; its read-only root cannot create that mount point.
      ...['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/opt', '/nix']
        .filter((path) => existsSync(path))
        .flatMap((path) => ['--ro-bind', path, path]),
      '--dev', '/dev', '--proc', '/proc',
      '--bind', scratch, scratch,
      '--ro-bind', etc, '/etc',
      '--bind', run, '/run',
      '--', BASH, '-c', [
        'echo HOST-RESOLVER-BEGIN',
        'cat /etc/resolv.conf || exit 91',
        'echo HOST-RESOLVER-END',
        '[ -r /run/unrelated-service/private ] || exit 92',
        'echo HOST-RUN-CONTROL-READABLE',
        'exec "$@"',
      ].join('\n'),
      'host-probe', BASH, launcher, '/bin/sh', '-c', probe,
    ], {
      cwd: app,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        DSHBOT_HOME: dshbotHome,
        DSHBOT_ISOLATION: 'container',
        ...(resolverMount === undefined ? {} : { DSHBOT_CONTAINER_RO: resolverMount }),
      },
      encoding: 'utf8',
      timeout: 45_000,
    })
    // The same fixture works when the resolver directory is explicitly allowed through the existing
    // read-only mount option. This distinguishes the missing automatic mount from a broken nested sandbox.
    const control = launch(dirname(`/run/${target}`))
    const controlDetails = `status=${String(control.status)} error=${String(control.error)}\n${control.stdout}\n${control.stderr}`
    expect(control.status, controlDetails).toBe(0)
    expect(control.stdout, controlDetails).toContain(`CONTAINER-RESOLVER-BEGIN\n${contents}CONTAINER-RESOLVER-END`)
    expect(control.stdout, controlDetails).toContain('RESOLVER-READ-ONLY')
    expect(control.stdout, controlDetails).not.toContain('UNRELATED-RUN-VISIBLE')

    const result = launch()
    const details = `status=${String(result.status)} error=${String(result.error)}\n${result.stdout}\n${result.stderr}`
    expect(result.status, details).toBe(0)
    expect(result.stdout, `the outer host fixture resolves the symlink\n${details}`).toContain(`HOST-RESOLVER-BEGIN\n${contents}HOST-RESOLVER-END`)
    expect(result.stdout, details).toContain('HOST-RUN-CONTROL-READABLE')
    expect(result.stdout, `the real container probe must execute\n${details}`).toContain('CONTAINER-PROBE-DONE')
    expect(result.stdout, details).toContain('CONTAINER-UID=0')
    expect(result.stdout, `resolv.conf must retain the host contents for ${link}\n${details}`).toContain(`CONTAINER-RESOLVER-BEGIN\n${contents}CONTAINER-RESOLVER-END`)
    expect(result.stdout, 'the resolver is mounted read-only').toContain('RESOLVER-READ-ONLY')
    expect(result.stdout).not.toContain('RESOLVER-WRITABLE')
    expect(result.stdout, 'fixing DNS must not expose all of /run').not.toContain('UNRELATED-RUN-VISIBLE')
    expect(readFileSync(resolver, 'utf8'), 'the host resolver is unchanged').toBe(contents)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
