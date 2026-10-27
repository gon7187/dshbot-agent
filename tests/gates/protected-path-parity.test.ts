// Label parity for the protected paths.
//
// The guard protects a tree, not a single file: when a protected module is split
// into new files, every leaf stays protected because isProtected matches the
// directory prefix. This test keeps the list honest from the other direction: a
// source file that participates in the guard, starts processes, or touches the
// evolve gate state is either under a protected path or named in the explicit
// exception list below with a reason for every line.
//
// If a new unchecked file starts calling isProtected/spawn/... the real-repository
// test fails. The temporary-copy test proves that this failure is not vacuous: the
// real packages tree is copied, a new unprotected file is added, and the scan
// reports it while the same triggers under packages/guard, packages/evolve and
// packages/tools-exec are accepted.

import type { Dirent } from 'node:fs'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { isProtected } from '../../packages/guard/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

interface Trigger {
  name: string
  pattern: RegExp
}

/** A call or a file name that makes a source file part of the safety mechanism. */
const TRIGGERS: readonly Trigger[] = [
  { name: 'isProtected(', pattern: /isProtected\s*\(/ },
  { name: 'spawn(', pattern: /\bspawn\s*\(/ },
  { name: 'spawnSync(', pattern: /\bspawnSync\s*\(/ },
  { name: 'execFile(', pattern: /\bexecFile\s*\(/ },
  { name: "'bwrap'", pattern: /['"]bwrap['"]/ },
  { name: 'adopt.json', pattern: /adopt\.json/ },
  { name: 'evolve-state', pattern: /evolve-state/ },
]

interface Exclusion {
  /** Repository-relative path, exactly as reported by the scan. */
  file: string
  /** Why this file may hold a trigger without being under a protected path. */
  reason: string
}

// Every line is deliberate: the scan below fails on a new file instead of
// letting a forgotten path slip into the unprotected part of the tree.
const EXCLUSIONS: readonly Exclusion[] = [
  {
    file: 'packages/app/src/index.ts',
    reason:
      'Only uses the evolve API (createEvolve/accept/reject/markHealthy) and passes fsProtectedRoot to tools-fs; ' +
      'the adopt.json/evolve-state/isProtected matches are comments, the file neither writes the state nor checks paths itself.',
  },
  {
    file: 'packages/app/src/video.ts',
    reason:
      'Starts ffmpeg and ffprobe only inside the bwrap profile of tools-exec (one spawn helper, no shell, no network, ' +
      'the video directory read-only and a private work directory) to cut an owner video into frames and a sound track; ' +
      'it reuses the exec sandbox profile instead of being the sandbox or the self-rewrite gate itself.',
  },
  {
    file: 'packages/memory-graph/src/transport.ts',
    reason:
      'Starts the MCP memory server as a child process with an explicit environment; it is not the self-rewrite gate and not the exec sandbox.',
  },
  {
    file: 'packages/tools-mcp/src/transport.ts',
    reason:
      'Starts the MCP servers the owner declared in DSHBOT_HOME/mcp.json; the environment is not inherited (only PATH, HOME, LANG and the server env), so it is not the self-rewrite gate and not the exec sandbox.',
  },
  {
    file: 'packages/tools-fs/src/index.ts',
    reason:
      'Calls guard.isProtected to enforce the protected list in read/edit/list/grep; the guard itself is protected, and the locked gate test requires tools-fs to stay outside the protected set.',
  },
]

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

function isTestFile(path: string): boolean {
  const segments = path.split('/')
  return (
    segments.includes('__tests__') ||
    segments.includes('test') ||
    segments.includes('tests') ||
    /\.(?:test|spec)\.[cm]?tsx?$/.test(path)
  )
}

/** Every non-test TypeScript source file below `packages/<package>/src`. */
function sourceFiles(root: string): string[] {
  const packages = join(root, 'packages')
  const files: string[] = []

  const walk = (directory: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push(full)
    }
  }

  walk(packages)
  return files
    .map((file) => toPosix(relative(root, file)))
    .filter((file) => file.endsWith('.ts') && file.split('/').includes('src') && !isTestFile(file))
    .sort()
}

function triggersOf(text: string): string[] {
  return TRIGGERS.filter((trigger) => trigger.pattern.test(text)).map((trigger) => trigger.name)
}

/** Lines describing files that carry a trigger while staying outside the protected set. */
function parityViolations(root: string, exclusions: readonly Exclusion[] = EXCLUSIONS): string[] {
  const allowed = new Set(exclusions.map((exclusion) => exclusion.file))
  const violations: string[] = []

  for (const file of sourceFiles(root)) {
    const found = triggersOf(readFileSync(join(root, file), 'utf8'))
    if (found.length === 0) continue
    if (allowed.has(file)) continue
    if (isProtected(file, root)) continue
    violations.push(`${file}: ${found.join(', ')}`)
  }

  return violations
}

function put(root: string, path: string, content: string): void {
  const full = join(root, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

test('test_parity_every_trigger_file_is_protected_or_has_an_explicit_reason', () => {
  expect(parityViolations(repoRoot)).toEqual([])
})

test('test_parity_temporary_copy_reports_a_trigger_in_a_new_unprotected_file', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-label-parity-')))

  try {
    // The copy is the real packages tree, so the test measures the same files the
    // repository scan measures and not a hand-built fixture.
    cpSync(join(repoRoot, 'packages'), join(root, 'packages'), { recursive: true })
    expect(parityViolations(root), 'the copy alone has no violations').toEqual([])

    // A new unprotected file with a trigger must be reported, even though it sits
    // next to unrelated packages.
    put(root, 'packages/newpkg/src/spawner.ts', "spawn('git', ['status'])\n")
    expect(parityViolations(root)).toEqual(['packages/newpkg/src/spawner.ts: spawn('])

    // A test file under the same new package is out of scope.
    put(root, 'packages/newpkg/src/index.test.ts', "spawn('git', ['status'])\n")
    expect(parityViolations(root), 'a test file is not a source file').toEqual([
      'packages/newpkg/src/spawner.ts: spawn(',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('test_parity_every_exclusion_names_a_real_triggering_file_with_a_reason', () => {
  expect(new Set(EXCLUSIONS.map((exclusion) => exclusion.file)).size, 'no duplicate exclusions').toBe(EXCLUSIONS.length)

  for (const exclusion of EXCLUSIONS) {
    expect(exclusion.reason.trim(), `${exclusion.file} needs a reason`).not.toBe('')
    expect(isProtected(exclusion.file, repoRoot), `${exclusion.file} is now protected: drop the exclusion`).toBe(false)

    let text: string
    try {
      text = readFileSync(join(repoRoot, exclusion.file), 'utf8')
    } catch {
      throw new Error(`${exclusion.file} is listed as an exclusion but does not exist: drop the line`)
    }
    expect(triggersOf(text), `${exclusion.file} no longer triggers the scan: drop the exclusion`).not.toEqual([])
  }
})
