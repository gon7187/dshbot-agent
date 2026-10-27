// Like gate-node-modules.test.ts, exercise the real bwrap and sandboxedTests.
// The CLI shim only rejects overlay mounts; fallback commands run in real bwrap.
// c2 is a command-success criterion for the gate: do not nest tsc/vitest runs here.
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'

import { sandboxedTests } from '../../packages/evolve/src/index.js'

interface World {
  root: string
  ownerHome: string
  candidate: string
  liveModules: string
  calls: string
}

let scratch = ''
let realBwrap = ''
let bwrapProblem: string | undefined
let world: World

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map((path) => {
    const absolute = join(root, path)
    return [path, lstatSync(absolute).isDirectory() ? 'directory' : readFileSync(absolute).toString('base64')]
  }))
}

beforeAll(() => {
  // Probe the machine, not the profile under test: a broken fallback must fail assertions.
  const lookup = spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' })
  realBwrap = lookup.stdout.trim()
  const probe = spawnSync(realBwrap || 'bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '/usr/bin/true'], {
    encoding: 'utf8', timeout: 20_000,
  })
  if (probe.error !== undefined || probe.status !== 0) {
    bwrapProblem = `bwrap cannot start on this machine: ${probe.error?.message ?? probe.stderr}`
  }
  // The gate mounts a private /tmp; candidate and live fixtures live below HOME.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-gate-fallback-')))
})

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  const root = mkdtempSync(join(scratch, 'run-'))
  const ownerHome = join(root, 'home')
  world = {
    root,
    ownerHome,
    candidate: join(ownerHome, '.local/share/dshbot/candidates/candidate'),
    liveModules: join(ownerHome, '.local/share/dshbot/app/node_modules'),
    calls: join(root, 'fallback-calls.jsonl'),
  }
  mkdirSync(world.candidate, { recursive: true })
  put(join(world.candidate, 'package.json'), '{"name":"candidate","private":true}\n')
  // Resolve from a nested file, as TypeScript's lib/getExePath.js does. Include
  // both ordinary and scoped sibling dependencies to catch scope traversal bugs.
  put(join(world.liveModules, 'a/package.json'), '{"name":"a","main":"lib/getExePath.js"}\n')
  put(join(world.liveModules, 'a/lib/getExePath.js'), "module.exports = { plain: require('b'), native: require('@platform/native') }\n")
  put(join(world.liveModules, 'b/index.js'), "module.exports = 'sibling-export'\n")
  put(join(world.liveModules, '@platform/native/index.js'), "module.exports = 'platform-export'\n")
  // Existing caches must be hidden by writable, disposable directories too.
  for (const cache of ['.vite-temp', '.vite', '.vitest', '.cache']) {
    put(join(world.liveModules, cache, 'live-cache.txt'), 'live cache must survive\n')
  }

  const bin = join(root, 'bin')
  put(join(bin, 'bwrap'), `#!${process.execPath}
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (args.includes('--overlay-src') || args.includes('--tmp-overlay')) process.exit(1)
fs.appendFileSync(${JSON.stringify(world.calls)}, JSON.stringify(args) + '\\n')
const result = spawnSync(${JSON.stringify(realBwrap || 'bwrap')}, args, { stdio: 'inherit' })
if (result.error) { console.error(result.error.message); process.exit(1) }
process.exit(result.status ?? 1)
`)
  chmodSync(join(bin, 'bwrap'), 0o755)
  vi.stubEnv('PATH', [bin, process.env.PATH ?? ''].join(delimiter))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(world.root, { recursive: true, force: true })
})

async function runFallback(script: string): Promise<Awaited<ReturnType<typeof sandboxedTests>>> {
  const result = await sandboxedTests({
    ownerHome: world.ownerHome,
    candidate: world.candidate,
    liveModules: world.liveModules,
    command: [process.execPath, '-e', script],
    timeoutMs: 30_000,
  })
  expect(result.sandboxError, `the real fallback sandbox starts\n${result.output}`).toBeUndefined()
  const calls = readFileSync(world.calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[])
  expect(calls.some((args) => args.includes(script)), 'the command reaches bwrap after the fallback probe').toBe(true)
  for (const args of calls) {
    expect(args, 'overlay is unavailable in this fixture').not.toContain('--overlay-src')
    expect(args).not.toContain('--tmp-overlay')
  }
  return result
}

test('test_c1_fallback_package_loads_plain_and_scoped_sibling_exports', { timeout: 90_000 }, async (ctx) => {
  if (bwrapProblem !== undefined) ctx.skip(bwrapProblem)
  const result = await runFallback("console.log(JSON.stringify(require('a')))")

  expect(result.status, `require('a') resolves its sibling packages in fallback\n${result.output}`).toBe(0)
  expect(result.ok).toBe(true)
  expect(JSON.parse(result.output.trim())).toEqual({ plain: 'sibling-export', native: 'platform-export' })
})

test('test_c3_fallback_keeps_live_read_only_and_discards_writable_toolchain_caches', { timeout: 90_000 }, async (ctx) => {
  if (bwrapProblem !== undefined) ctx.skip(bwrapProblem)
  const liveBefore = snapshot(world.liveModules)
  const candidateBefore = snapshot(world.candidate)
  const result = await runFallback(`
const fs = require('node:fs')
const path = require('node:path')
const report = { writableCaches: [], deniedWrites: [] }
for (const cache of ['.vite-temp', '.vite', '.vitest', '.cache']) {
  const file = path.join('node_modules', cache, 'vitest', 'probe.txt')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'private toolchain cache')
  if (fs.readFileSync(file, 'utf8') === 'private toolchain cache') report.writableCaches.push(cache)
}
for (const file of ['node_modules/a/lib/getExePath.js', 'node_modules/a/host-write.txt']) {
  try { fs.writeFileSync(file, 'must not reach live') }
  catch (error) {
    if (['EROFS', 'EACCES', 'EPERM'].includes(error.code)) report.deniedWrites.push(file)
    else throw error
  }
}
console.log(JSON.stringify(report))
`)

  expect(result.status, `cache writes work inside fallback\n${result.output}`).toBe(0)
  expect(result.ok).toBe(true)
  expect(JSON.parse(result.output.trim())).toEqual({
    writableCaches: ['.vite-temp', '.vite', '.vitest', '.cache'],
    deniedWrites: ['node_modules/a/lib/getExePath.js', 'node_modules/a/host-write.txt'],
  })
  expect(snapshot(world.liveModules), 'all live package and cache contents are unchanged').toEqual(liveBefore)
  expect(snapshot(world.candidate), 'no module mount point, symlinks or cache paths remain on the host').toEqual(candidateBefore)
})
