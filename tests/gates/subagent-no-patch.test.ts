import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The subagent tool cancels through the runner (Runner.cancel by session, the agent.cancel of the
// harness) and registers through the tools seam. It never replaces globalThis.fetch, never patches
// a prototype of the harness or of the runner, and never intercepts HTTP to stop a model call.
const root = fileURLToPath(new URL('../..', import.meta.url))

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...sourceFiles(full))
    } else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function packageSources(): string[] {
  const packages = join(root, 'packages')
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => (existsSync(join(packages, entry.name, 'src')) ? sourceFiles(join(packages, entry.name, 'src')) : []))
}

/** Code with comments and string-free noise removed enough for the patterns below. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const PATCHES: ReadonlyArray<[string, RegExp]> = [
  ['an assignment to a global fetch', /\b(?:globalThis|global|window|self)\s*(?:\.\s*fetch\b|\[\s*['"]fetch['"]\s*\])\s*=[^=]/],
  ['an assignment to a prototype member', /\.prototype\s*(?:\.\s*\w+|\[[^\]]+\])\s*=[^=]/],
  ['a replaced prototype', /\.prototype\s*=[^=]/],
  ['defineProperty on a prototype', /(?:defineProperty|defineProperties)\s*\([^)]*prototype/],
  ['setPrototypeOf', /\bsetPrototypeOf\s*\(/],
  ['a global HTTP dispatcher', /\bsetGlobalDispatcher\s*\(/],
  ['a patched request method', /\bhttps?\.(?:request|get)\s*=[^=]/],
]

test('test_nopatch_no_package_patches_fetch_or_harness_prototypes', () => {
  const found: string[] = []
  for (const file of packageSources()) {
    const code = codeOf(file)
    for (const [what, pattern] of PATCHES) {
      if (pattern.test(code)) found.push(`${relative(root, file)}: ${what}`)
    }
  }
  expect(found).toEqual([])
})

test('test_nopatch_subagent_package_exists_and_stops_children_through_the_cancel_api', () => {
  const dir = join(root, 'packages', 'tools-subagent', 'src')
  expect(existsSync(dir), 'packages/tools-subagent/src exists').toBe(true)
  const files = sourceFiles(dir)
  expect(files.length, 'the package has sources').toBeGreaterThan(0)
  const code = files.map(codeOf).join('\n')

  expect(code, 'the tool is named delegate').toMatch(/['"`]delegate['"`]/)
  // Cancellation comes from the AbortSignal of the tool context or from cancel() of the runner.
  expect(code, 'a child stops through the AbortSignal of the tool or cancel()').toMatch(/\bsignal\b|\.cancel\s*\(/)
  expect(code, 'no interception of the HTTP layer').not.toMatch(/\bglobalThis\s*\.\s*fetch\b|\bMockAgent\b|\bregisterHooks\b/)
})
