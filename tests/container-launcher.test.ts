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
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const launcher = join(repoRoot, 'scripts', 'dshbot-run.sh')
const serviceFile = join(repoRoot, 'deploy', 'dshbot.service')

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

test('test_c4_container_runs_a_node_binary_given_as_the_first_argument', { timeout: TEST_TIMEOUT_MS }, () => {
  const r = launch([process.execPath, '-e', NODE_PROBE], { isolation: 'container' })
  expect(r.status, `node must run inside\n${describeRun(r)}`).toBe(0)
  const probe = nodeProbe(r)
  expect(probe.uid, 'node runs as fake root').toBe(0)
  expect(probe.ok, 'the node binary exists inside').toBe(true)
})

test('test_c4_container_resolves_a_node_shim_to_the_real_binary', { timeout: TEST_TIMEOUT_MS }, () => {
  // a shim like mise's: a program outside every system directory that only forwards to the real node
  const shimDir = mkdtempSync(join(scratch, 'shims-'))
  const shim = join(shimDir, 'node')
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  chmodSync(shim, 0o755)

  const r = launch([shim, '-e', NODE_PROBE], { isolation: 'container' })
  expect(r.status, `the shim must work inside\n${describeRun(r)}`).toBe(0)
  const probe = nodeProbe(r)
  expect(probe.uid, 'node behind the shim runs as fake root').toBe(0)
  expect(probe.ok, 'the real node binary exists inside').toBe(true)
})

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
function unitValues(text: string, section: string, key: string): string[] {
  const values: string[] = []
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header !== null) {
      current = header[1] as string
      continue
    }
    if (current !== section) continue
    const eq = line.indexOf('=')
    if (eq > 0 && line.slice(0, eq).trim() === key) values.push(line.slice(eq + 1).trim())
  }
  return values
}

test('test_c10_service_starts_the_daemon_through_the_launcher_and_keeps_the_adopt_step', { timeout: TEST_TIMEOUT_MS }, () => {
  const text = readFileSync(serviceFile, 'utf8')

  const start = unitValues(text, 'Service', 'ExecStart')
  expect(start, 'one ExecStart').toHaveLength(1)
  const tokens = (start[0] as string).replace(/^[-@:+!]+/, '').split(/\s+/)
  expect(
    tokens.slice(0, 2).some((token) => token.endsWith('scripts/dshbot-run.sh')),
    `ExecStart must run scripts/dshbot-run.sh: ${start[0]}`,
  ).toBe(true)
  expect(start[0], 'the daemon entry point is still started').toContain('packages/app/src/main.ts')

  const pre = unitValues(text, 'Service', 'ExecStartPre')
  expect(pre, 'ExecStartPre keeps the adopt step as it was').toContain('/bin/bash %h/.local/share/dshbot/app/scripts/adopt.sh')
})
