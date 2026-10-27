import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// A shell started from package code runs on the host with the bot's own rights:
// the owner's HOME, sockets and network. Shell commands go only through the
// sandboxed exec package (bwrap with an allowlist), never through a raw spawn.
const root = fileURLToPath(new URL('../..', import.meta.url))

const SANDBOXED = ['packages/tools-exec/']

const KNOWN_DEBT = new Set<string>()

const IMPORTS_CHILD_PROCESS = /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
const SHELL_PATTERNS: readonly RegExp[] = [
  // exec/execSync always go through /bin/sh.
  /\bexec(?:Sync)?\s*\(/,
  /\bshell\s*:\s*(?:true|['"])/,
  /['"](?:\/(?:usr\/)?bin\/)?(?:ba|da|z)?sh['"]/,
  /['"]-l?c['"]/,
]

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      files.push(...sourceFiles(full))
    } else if (/\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function packageSources(): string[] {
  const packages = join(root, 'packages')
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return sourceFiles(join(packages, entry.name, 'src'))
      } catch {
        return []
      }
    })
}

function shellHits(text: string): string[] {
  if (!IMPORTS_CHILD_PROCESS.test(text)) return []
  // Regex method calls such as /x/.exec(text) are not child_process.exec.
  const code = text.replace(/\/(?:\\.|[^/\n])+\/[a-z]*\.exec\s*\(/g, '')
  return SHELL_PATTERNS.filter((pattern) => pattern.test(code)).map(String)
}

test('no package outside the exec sandbox starts a shell', () => {
  const offenders: string[] = []
  for (const file of packageSources()) {
    const path = relative(root, file)
    if (SANDBOXED.some((prefix) => path.startsWith(prefix)) || KNOWN_DEBT.has(path)) continue
    const hits = shellHits(readFileSync(file, 'utf8'))
    if (hits.length > 0) offenders.push(`${path}: ${hits.join(', ')}`)
  }
  expect(offenders).toEqual([])
})

test('every known debt entry still starts a shell; a fixed one leaves the list', () => {
  for (const path of KNOWN_DEBT) {
    let text = ''
    try {
      text = readFileSync(join(root, path), 'utf8')
    } catch {
      // a deleted file is a paid debt
    }
    expect(shellHits(text), `${path} no longer starts a shell: remove it from KNOWN_DEBT`).not.toEqual([])
  }
})
