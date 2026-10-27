import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The supply-chain guard of the whole dependency set: exact versions, the public
// registry with integrity, no install scripts beyond the reviewed ones (and those
// never run), no telemetry or rejected packages. Why each package was chosen is
// recorded in docs/research/*-deps-review.md.
const root = fileURLToPath(new URL('../..', import.meta.url))

interface LockEntry {
  resolved?: string
  integrity?: string
  link?: boolean
  hasInstallScript?: boolean
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> }
const entries = Object.entries(lock.packages).filter(([path, entry]) => path !== '' && entry.link !== true)
const nameOf = (path: string): string => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)

/**
 * Reviewed packages with install scripts; `ignore-scripts` keeps them from running.
 *
 * `@google/genai` ships `preinstall`/`prepare`/`prepack` hooks in its manifest
 * (the prepare step only matters for git installs; `scripts/prepare.js` is not
 * in the published tarball). `protobufjs` runs its shipped `scripts/postinstall.js`,
 * which only reads its own and the parent `package.json` and prints a stderr
 * warning about a mismatched `versionScheme`; it writes no files, spawns nothing
 * and is not needed at runtime. Both arrive transitively with the pi-ai provider
 * tree, and neither hook can run while `.npmrc` keeps `ignore-scripts=true`.
 */
const INSTALL_SCRIPTS_ALLOWED = new Set([
  '@deepseek-ai/dsh-subprocess-local',
  '@google/genai',
  'koffi',
  'node-pty',
  'protobufjs',
])

/** Telemetry, the full dsh CLI, the vulnerable `xlsx` parser and the rejected Exa provider. */
const BANNED = /^(?:@deepseek-ai\/dsh|.*dsh-base.*|.*dsh-headless.*|.*otel.*|.*opentelemetry.*|.*analytics.*|.*session-log.*|.*inventory.*|xlsx|.*web-search-exa.*)$/

test('every declared dependency pins an exact version', () => {
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/)
  }
})

test('every locked package comes from the public registry with an integrity hash', () => {
  const foreign = entries.filter(([, entry]) => !entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity)
  expect(foreign.map(([path]) => path)).toEqual([])
})

test('install scripts stay off and only the reviewed packages carry one', () => {
  expect(readFileSync(join(root, '.npmrc'), 'utf8')).toMatch(/^\s*ignore-scripts\s*=\s*true\s*$/m)
  const scripted = entries.filter(([, entry]) => entry.hasInstallScript === true).map(([path]) => nameOf(path))
  expect(scripted.filter((name) => !INSTALL_SCRIPTS_ALLOWED.has(name))).toEqual([])
})

test('no banned package is locked', () => {
  expect(entries.map(([path]) => nameOf(path)).filter((name) => BANNED.test(name))).toEqual([])
})
