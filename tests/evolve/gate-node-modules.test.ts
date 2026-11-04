// Gate of self-rewriting: node_modules of a candidate inside the bwrap sandbox.
//
// A candidate is a git worktree of `live` and has no node_modules of its own. The sandbox of the gate has
// to show it the node_modules of live: read from live, writes (vite's .vite-temp, the vitest cache) go to a
// throw-away layer, and nothing of it is left on the host. These tests use the real bwrap and the real
// sandboxedTests of packages/evolve (no stub runner); they are skipped, with the reason, only when bwrap
// cannot start on the machine.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

import { createEvolve, sandboxArgs, sandboxedTests, type Evolve } from '../../packages/evolve/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TEST_TIMEOUT_MS = 280_000

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let scratch = ''
let bwrapProblem: string | undefined

interface World {
  /** HOME of the daemon: an empty tmpfs inside the sandbox */
  ownerHome: string
  /** DSHBOT_HOME */
  dshbotHome: string
  /** the live repository on the branch live */
  live: string
  evolve: Evolve
}

let world: World

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
}

function probeBwrap(): string | undefined {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '/usr/bin/true'], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (probe.error !== undefined) return `bwrap does not start on this machine: ${probe.error.message}`
  if (probe.status !== 0) return `bwrap does not start on this machine (exit ${String(probe.status)}): ${probe.stderr}`
  return undefined
}

// A small TypeScript project: the first stage of `full` resolves @types/node from node_modules, the second
// one makes vitest bundle its config file, which is when vite writes node_modules/.vite-temp. The light
// `gate` script of self_submit runs check.mjs: the fixture live has no tsc or vitest of its own.
const PROJECT_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'live-fixture',
      private: true,
      type: 'module',
      scripts: { test: 'node check.mjs', gate: 'node check.mjs', full: 'tsc --noEmit && vitest run' },
    },
    null,
    2,
  )}\n`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        types: ['node'],
        skipLibCheck: true,
      },
      include: ['*.ts'],
    },
    null,
    2,
  )}\n`,
  'vitest.config.ts': "import { defineConfig } from 'vitest/config'\n\nexport default defineConfig({ test: { include: ['sum.test.ts'] } })\n",
  'sum.ts': 'export const sum = (a: number, b: number): number => a + b\n',
  'sum.test.ts':
    "import { expect, test } from 'vitest'\n\nimport { sum } from './sum.js'\n\ntest('sum', () => {\n  expect(sum(1, 2)).toBe(3)\n})\n",
  'check.mjs':
    // what a test run may do with node_modules; the outcome of the write is of no interest here
    "import { mkdirSync, writeFileSync } from 'node:fs'\n" +
    "try { mkdirSync('node_modules/.vite-temp', { recursive: true }); writeFileSync('node_modules/.vite-temp/probe.txt', 'x') } catch { /* read-only is fine */ }\n" +
    'process.exit(0)\n',
  'CHECKLIST.md': '# Review checklist\n- no secrets in code\n',
  'notes.md': 'original notes\n',
  '.gitignore': 'node_modules/\n',
}

function makeLive(live: string): void {
  mkdirSync(live, { recursive: true })
  for (const [name, content] of Object.entries(PROJECT_FILES)) put(join(live, name), content)
  put(join(live, 'node_modules', 'live-dep', 'index.js'), 'module.exports = 1\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
}

beforeAll(() => {
  bwrapProblem = probeBwrap()
  // /var/tmp first: a sandbox gets its own /tmp
  for (const base of ['/var/tmp', tmpdir()]) {
    try {
      scratch = realpathSync(mkdtempSync(join(base, 'dshbot-gate-modules-')))
      return
    } catch {
      // try the next base
    }
  }
  throw new Error('no writable temporary directory')
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  const ownerHome = mkdtempSync(join(scratch, 'home-'))
  const dshbotHome = join(ownerHome, '.local', 'share', 'dshbot')
  const live = join(dshbotHome, 'app')
  makeLive(live)
  const evolve = createEvolve({
    home: dshbotHome,
    live,
    ownerHome,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => '{"verdict":"approve","summary":"ok"}',
    card: async () => {},
  })
  world = { ownerHome, dshbotHome, live, evolve }
})

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const found = world.evolve.tools.find((candidate) => candidate.name === name)
  expect(found, `the tool ${name} must be offered`).toBeDefined()
  return String(await found?.execute(args))
}

/** self_change from the clean live; returns the candidate path and id */
async function newCandidate(): Promise<{ path: string; id: string }> {
  const text = await tool('self_change', { description: 'change a constant' })
  const id = /^id: (\S+)/m.exec(text)?.[1]
  expect(id, `self_change must return the candidate id\n${text}`).toBeDefined()
  const path = join(world.dshbotHome, 'candidates', id as string)
  expect(existsSync(path), 'the candidate worktree exists').toBe(true)
  return { path, id: id as string }
}

function requireBwrap(skip: (note?: string) => void): void {
  if (bwrapProblem !== undefined) skip(bwrapProblem)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Put a bwrap first on PATH that refuses overlay mounts, as builds without user-space
 * overlayfs do, so the gate takes its fallback profile; every other call runs the real
 * bwrap and is logged. Returns the log: one JSON array of arguments per line.
 */
function bwrapWithoutOverlay(): string {
  const realBwrap = spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).stdout.trim() || 'bwrap'
  const bin = mkdtempSync(join(scratch, 'no-overlay-bin-'))
  const calls = join(bin, 'calls.jsonl')
  put(
    join(bin, 'bwrap'),
    `#!${process.execPath}
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('--overlay-src') || args.includes('--tmp-overlay')) process.exit(1)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
const result = spawnSync(${JSON.stringify(realBwrap)}, args, { stdio: 'inherit' })
if (result.error) { console.error(result.error.message); process.exit(1) }
process.exit(result.status ?? 1)
`,
  )
  chmodSync(join(bin, 'bwrap'), 0o755)
  vi.stubEnv('PATH', [bin, process.env.PATH ?? ''].join(delimiter))
  return calls
}

// --- [real] -----------------------------------------------------------------------------------------------

test('test_c_real_candidate_without_changes_passes_tsc_and_vitest_in_the_gate_sandbox', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
  requireBwrap((note) => ctx.skip(note))
  const liveModules = join(repoRoot, 'node_modules')
  expect(existsSync(join(liveModules, 'vitest')), 'the installed node_modules of this checkout serve as the live ones').toBe(true)
  const candidate = await newCandidate()
  expect(existsSync(join(candidate.path, 'node_modules')), 'the fresh candidate has no node_modules of its own').toBe(false)

  const result = await sandboxedTests({
    ownerHome: world.ownerHome,
    candidate: candidate.path,
    liveModules,
    command: ['npm', 'run', 'full'],
    timeoutMs: 240_000,
  })

  expect(result.sandboxError, `the sandbox must start\n${result.output}`).toBeUndefined()
  expect(result.status, `tsc --noEmit and vitest run in the candidate\n${result.output}`).toBe(0)
  expect(result.ok).toBe(true)
})

// --- [write] ----------------------------------------------------------------------------------------------

test('test_c_write_vite_temp_is_writable_in_the_sandbox_and_live_node_modules_stay_unchanged', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
  requireBwrap((note) => ctx.skip(note))
  const liveModules = join(world.live, 'node_modules')
  const treeBefore = listTree(liveModules)
  const depBefore = readFileSync(join(liveModules, 'live-dep', 'index.js'), 'utf8')
  const candidate = await newCandidate()

  const script = [
    'set -e',
    'mkdir -p node_modules/.vite-temp',
    'echo bundled > node_modules/.vite-temp/config.timestamp.mjs',
    'test "$(cat node_modules/.vite-temp/config.timestamp.mjs)" = bundled',
    // reads come from live; a write over a live file stays in the overlay layer or,
    // in the fallback profile without overlay, is refused as read-only
    'test -f node_modules/live-dep/index.js',
    '(echo changed-in-sandbox > node_modules/live-dep/index.js) 2>/dev/null || true',
    '(echo cache > node_modules/live-dep/cache.tmp) 2>/dev/null || true',
  ].join('\n')
  const result = await sandboxedTests({
    ownerHome: world.ownerHome,
    candidate: candidate.path,
    liveModules,
    command: ['sh', '-c', script],
    timeoutMs: 60_000,
  })

  expect(result.sandboxError, `the sandbox must start\n${result.output}`).toBeUndefined()
  expect(result.status, `writing into <candidate>/node_modules/.vite-temp inside the sandbox\n${result.output}`).toBe(0)
  expect(listTree(liveModules), 'live node_modules has no new files').toEqual(treeBefore)
  expect(readFileSync(join(liveModules, 'live-dep', 'index.js'), 'utf8'), 'a live file is not rewritten').toBe(depBefore)
  expect(existsSync(join(liveModules, '.vite-temp')), 'no .vite-temp in live node_modules').toBe(false)
  expect(existsSync(join(candidate.path, 'node_modules', '.vite-temp')), 'no .vite-temp in the candidate on the host').toBe(false)
  expect(existsSync(join(candidate.path, 'node_modules', 'live-dep', 'cache.tmp')), 'the throw-away layer is discarded').toBe(false)
})

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// --- [profile] --------------------------------------------------------------------------------------------

test('test_c_profile_gate_sandbox_keeps_no_network_empty_home_and_read_only_system', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
  const candidatePath = join(world.dshbotHome, 'candidates', 'c-profile')
  const liveModules = join(world.live, 'node_modules')
  const args = sandboxArgs({ ownerHome: world.ownerHome, candidate: candidatePath, liveModules })

  const has = (...sequence: string[]): boolean => args.some((_, index) => sequence.every((part, offset) => args[index + offset] === part))
  expect(args, 'the network namespace is unshared').toContain('--unshare-net')
  expect(args, 'the pid namespace is unshared').toContain('--unshare-pid')
  expect(args, 'the network is never shared back').not.toContain('--share-net')
  expect(has('--tmpfs', world.ownerHome), 'HOME is an empty tmpfs').toBe(true)
  expect(has('--ro-bind', '/usr', '/usr'), 'the system is mounted read-only').toBe(true)
  expect(has('--ro-bind', '/', '/'), 'the root is not mounted wholesale').toBe(false)
  expect(has('--bind', '/', '/'), 'the root is not mounted writable').toBe(false)
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === '--bind' || args[index] === '--ro-bind') {
      expect(args[index + 1], 'the owner HOME is not bound into the sandbox').not.toBe(world.ownerHome)
    }
  }

  requireBwrap((note) => ctx.skip(note))
  const candidate = await newCandidate()
  put(join(world.ownerHome, 'secret.txt'), 'owner secret\n')
  const script = [
    'if cat "$HOME/secret.txt" >/dev/null 2>&1; then echo HOME-LEAK; exit 11; fi',
    'if touch /usr/gate-write-probe 2>/dev/null; then echo SYSTEM-WRITABLE; exit 12; fi',
    // only the loopback interface may exist
    'for name in $(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " "); do [ "$name" = lo ] || { echo "NETWORK $name"; exit 13; }; done',
    'exit 0',
  ].join('\n')
  const result = await sandboxedTests({
    ownerHome: world.ownerHome,
    candidate: candidate.path,
    liveModules,
    command: ['sh', '-c', script],
    timeoutMs: 60_000,
  })
  expect(result.sandboxError, `the sandbox must start\n${result.output}`).toBeUndefined()
  expect(result.status, `the profile is not weakened\n${result.output}`).toBe(0)
})


test('fallback resolves plain/scoped siblings and discards private writable caches', { timeout: TEST_TIMEOUT_MS }, async (ctx) => {
  requireBwrap((note) => ctx.skip(note))
  const candidate = await newCandidate()
  const liveModules = join(world.live, 'node_modules')
  put(join(liveModules, 'a/package.json'), '{"name":"a","main":"lib/index.js"}\n')
  put(join(liveModules, 'a/lib/index.js'), "module.exports = [require('b'), require('@platform/native')]\n")
  put(join(liveModules, 'b/index.js'), "module.exports = 'plain'\n")
  put(join(liveModules, '@platform/native/index.js'), "module.exports = 'scoped'\n")
  put(join(liveModules, '.vite-temp/live-cache'), 'preserve cache')
  const before = listTree(liveModules)
  bwrapWithoutOverlay()
  const result = await sandboxedTests({ ownerHome: world.ownerHome, candidate: candidate.path, liveModules,
    command: [process.execPath, '-e', `const fs=require('node:fs'),assert=require('node:assert/strict'); assert.deepEqual(require('a'),['plain','scoped']); for(const cache of ['.vite-temp','.vite','.vitest','.cache']) {fs.mkdirSync('node_modules/'+cache+'/private',{recursive:true});fs.writeFileSync('node_modules/'+cache+'/private/probe','cache')} assert.throws(()=>fs.writeFileSync('node_modules/a/lib/index.js','modified')); console.log('fallback-ready')`],
  })
  expect(result.ok, result.output).toBe(true)
  expect(result.output).toContain('fallback-ready')
  expect(listTree(liveModules)).toEqual(before)
  expect(readFileSync(join(liveModules, 'a/lib/index.js'), 'utf8')).toContain("require('b')")
  expect(readFileSync(join(liveModules, '.vite-temp/live-cache'), 'utf8')).toBe('preserve cache')
  expect(existsSync(join(candidate.path, 'node_modules'))).toBe(false)
})
