// The bot and every child daemon of the tests load packages/app/register.mjs first; it turns on Node's
// compile cache so a restart (and each test daemon) does not recompile the whole module graph.
//
// The register file is exercised in child Node processes. NODE_COMPILE_CACHE is set from inside the
// process before register.mjs is imported (not in the child's environment), because Node itself reads
// the variable at startup and that would hide whether register.mjs turns the cache on.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const registerUrl = pathToFileURL(join(repoRoot, 'packages/app/register.mjs')).href

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-cc-test-'))
})

afterEach(() => {
  try {
    chmodSync(join(scratch, 'ro'), 0o700)
  } catch {
    // not created in this test
  }
  rmSync(scratch, { recursive: true, force: true })
})

/** A TypeScript module reached through a `./x.js` specifier, the way the app's sources import each other. */
function writeApp(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dep.ts'), 'export const answer: number = 42\n')
  writeFileSync(
    join(dir, 'main.mjs'),
    [
      "import { getCompileCacheDir } from 'node:module'",
      "import { answer } from './dep.js'",
      'console.log(JSON.stringify({ answer, dir: getCompileCacheDir() ?? null }))',
      '',
    ].join('\n'),
  )
  // Imports register.mjs after the (optional) runtime NODE_COMPILE_CACHE is set, then the app module.
  writeFileSync(
    join(dir, 'boot.mjs'),
    [
      'if (process.env.TEST_CACHE_DIR) process.env.NODE_COMPILE_CACHE = process.env.TEST_CACHE_DIR',
      `await import(${JSON.stringify(registerUrl)})`,
      "await import('./main.mjs')",
      '',
    ].join('\n'),
  )
  return join(dir, 'boot.mjs')
}

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NODE_COMPILE_CACHE
  delete env.NODE_DISABLE_COMPILE_CACHE
  delete env.TEST_CACHE_DIR
  return { ...env, ...extra }
}

function run(boot: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [boot], { env, encoding: 'utf8', timeout: 60_000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(path))
    else out.push(path)
  }
  return out
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

test('test_c1_register_writes_compile_cache_into_node_compile_cache_dir', () => {
  const boot = writeApp(join(scratch, 'app'))
  const cache = join(scratch, 'cache')
  const env = cleanEnv({ HOME: join(scratch, 'home'), TEST_CACHE_DIR: cache })

  const first = run(boot, env)
  expect(first.status).toBe(0)
  const firstOut = JSON.parse(first.stdout.trim()) as { answer: number; dir: string | null }
  expect(firstOut.answer).toBe(42)
  expect(firstOut.dir).not.toBeNull()
  expect(inside(cache, firstOut.dir as string)).toBe(true)
  expect(files(cache).length).toBeGreaterThan(0)

  const second = run(boot, env)
  expect(second.status).toBe(0)
  expect(second.stdout).toBe(first.stdout)
  expect(second.stderr).toBe('')
})

test('test_c2_register_default_cache_dir_is_shared_in_tmpdir_across_homes', () => {
  const boot = writeApp(join(scratch, 'app'))
  const tmp = join(scratch, 'tmp')
  mkdirSync(tmp)
  const homeA = join(scratch, 'homeA')
  const homeB = join(scratch, 'homeB')
  mkdirSync(homeA)
  mkdirSync(homeB)

  const a = run(boot, cleanEnv({ HOME: homeA, TMPDIR: tmp }))
  const b = run(boot, cleanEnv({ HOME: homeB, TMPDIR: tmp }))
  expect(a.status).toBe(0)
  expect(b.status).toBe(0)
  const dirA = (JSON.parse(a.stdout.trim()) as { dir: string | null }).dir
  const dirB = (JSON.parse(b.stdout.trim()) as { dir: string | null }).dir

  expect(dirA).not.toBeNull()
  expect(dirB).toBe(dirA)
  expect(inside(tmp, dirA as string)).toBe(true)
  expect(inside(homeA, dirA as string)).toBe(false)
  expect(inside(homeB, dirA as string)).toBe(false)
  expect(files(tmp).length).toBeGreaterThan(0)
})

test('test_c3_register_starts_without_cache_when_dir_is_unusable', () => {
  const boot = writeApp(join(scratch, 'app'))
  const home = join(scratch, 'home')
  mkdirSync(home)

  // A path below a regular file cannot be created.
  const blocker = join(scratch, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const underFile = run(boot, cleanEnv({ HOME: home, TEST_CACHE_DIR: join(blocker, 'cache') }))
  expect(underFile.status).toBe(0)
  expect((JSON.parse(underFile.stdout.trim()) as { answer: number }).answer).toBe(42)
  expect(underFile.stderr).toBe('')

  // A read-only directory cannot be written to (the check is moot for root, which ignores modes).
  const ro = join(scratch, 'ro')
  mkdirSync(ro)
  chmodSync(ro, 0o500)
  const readOnly = run(boot, cleanEnv({ HOME: home, TEST_CACHE_DIR: join(ro, 'cache') }))
  expect(readOnly.status).toBe(0)
  expect((JSON.parse(readOnly.stdout.trim()) as { answer: number }).answer).toBe(42)
  if (process.getuid?.() !== 0) expect(readOnly.stderr).toBe('')

  // The default location is unusable too: the system temp directory is a regular file.
  const fileTmp = join(scratch, 'file-tmp')
  writeFileSync(fileTmp, 'not a directory')
  const noTmp = run(boot, cleanEnv({ HOME: home, TMPDIR: fileTmp }))
  expect(noTmp.status).toBe(0)
  expect((JSON.parse(noTmp.stdout.trim()) as { answer: number }).answer).toBe(42)
  expect(noTmp.stderr).toBe('')
})

test('test_c4_systemd_unit_has_persistent_compile_cache_dir_in_home', () => {
  const unit = readFileSync(join(repoRoot, 'deploy/dshbot.service'), 'utf8')
  const lines = unit.split('\n').map((line) => line.trim())

  const values = lines
    .filter((line) => line.startsWith('Environment='))
    .map((line) => line.slice('Environment='.length).replace(/^"|"$/g, ''))
    .filter((value) => value.startsWith('NODE_COMPILE_CACHE='))
    .map((value) => value.slice('NODE_COMPILE_CACHE='.length))
  expect(values).toHaveLength(1)
  const dir = values[0] as string

  // In the user's home (%h), below it, and not in any temporary location.
  expect(dir.startsWith('%h/')).toBe(true)
  expect(dir.length).toBeGreaterThan('%h/'.length)
  expect(dir).not.toMatch(/(^|\/)(tmp|\.\.)(\/|$)/)
  expect(dir).not.toMatch(/%[tTV]/)

  // Everything else in the unit stays as it was.
  const kept = [
    '[Unit]',
    'Description=DSHBOT personal agent',
    'After=network-online.target',
    'Wants=network-online.target',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    'OnFailure=dshbot-doctor.service',
    '[Service]',
    'Type=simple',
    'WorkingDirectory=%h/.local/share/dshbot/app',
    'EnvironmentFile=%h/.config/dshbot/dshbot.env',
    'Environment=DSHBOT_HOME=%h/.local/share/dshbot',
    'Environment=DSH_TELEMETRY_DISABLED=1',
    'Environment=NODE_ENV=production',
    'ExecStartPre=/bin/bash %h/.local/share/dshbot/app/scripts/adopt.sh',
    'ExecStart=%h/.local/share/dshbot/app/scripts/dshbot-run.sh %h/.local/share/mise/shims/node --import ./packages/app/register.mjs ./packages/app/src/main.ts',
    'Restart=on-failure',
    'RestartSec=5',
    'SuccessExitStatus=42 75',
    'RestartForceExitStatus=42 75',
    'RestartPreventExitStatus=77 78',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=15',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'ProtectSystem=strict',
    '[Install]',
    'WantedBy=default.target',
  ]
  for (const line of kept) expect(lines).toContain(line)
  const changed = lines.filter(
    (line) => line !== '' && !line.startsWith('#') && !kept.includes(line) && !line.startsWith('Environment=NODE_COMPILE_CACHE='),
  )
  expect(changed).toEqual([])
})
