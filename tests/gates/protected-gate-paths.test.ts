// The gate of self-rewriting and the tool sandbox are protected paths: the bot cannot loosen its own checks.
//
// guard.isProtected is checked on a temporary repository (the same way packages/guard/src/guard.test.ts does it,
// with the bypasses by ./, .. and symlinks). The gate is the real createEvolve of packages/evolve with spies on
// the sandbox, reviewer and owner-card seams, over a real git worktree of a temporary `live` repository, the way
// tests/evolve/review-verdict.test.ts builds it. CHECKLIST.md is read as text and its section 1 is parsed.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createEvolve, type OwnerCard, type SandboxOptions } from '../../packages/evolve/src/index.js'
import { isProtected } from '../../packages/guard/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let root = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-protected-gate-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// --- [dirs] ---------------------------------------------------------------------------------------------

test('test_dirs_isProtected_covers_packages_evolve_and_packages_tools_exec', () => {
  const protectedPaths = [
    'packages/evolve/src/index.ts',
    'packages/evolve/new-file.ts',
    'packages/evolve/deeper/new/module.ts',
    'packages/tools-exec/src/index.ts',
    'packages/tools-exec/src/sandbox.ts',
    'packages/tools-exec/src/brand-new.ts',
  ]
  for (const path of protectedPaths) {
    expect(isProtected(path, root), `${path} is protected`).toBe(true)
    expect(isProtected(join(root, path), root), `${path} (absolute) is protected`).toBe(true)
  }

  // neighbours are not swallowed by a prefix match
  expect(isProtected('packages/evolve-extra/src/index.ts', root)).toBe(false)
  expect(isProtected('packages/tools-exec-extra/src/index.ts', root)).toBe(false)
  expect(isProtected('packages/tools-fs/src/index.ts', root)).toBe(false)
  expect(isProtected('packages/app/src/index.ts', root)).toBe(false)
})

test('test_dirs_isProtected_resists_dot_dotdot_and_symlink_bypasses_on_the_new_paths', () => {
  put(join(root, 'packages', 'evolve', 'src', 'index.ts'), 'export {}\n')
  put(join(root, 'packages', 'tools-exec', 'src', 'index.ts'), 'export {}\n')
  put(join(root, 'README.md'), '# readme\n')
  symlinkSync(join(root, 'packages', 'evolve'), join(root, 'e'))
  symlinkSync(join(root, 'packages', 'tools-exec', 'src'), join(root, 'x'))
  symlinkSync(join(root, 'packages', 'tools-exec', 'src', 'index.ts'), join(root, 'file-link.ts'))
  symlinkSync(join(root, 'README.md'), join(root, 'plain-link.md'))

  expect(isProtected('./packages/evolve/src/index.ts', root)).toBe(true)
  expect(isProtected('packages/./tools-exec/./src/index.ts', root)).toBe(true)
  expect(isProtected('packages/guard/../evolve/src/index.ts', root)).toBe(true)
  expect(isProtected('packages/app/../tools-exec/src/index.ts', root)).toBe(true)
  expect(isProtected('packages/store/../../packages/evolve/new.ts', root)).toBe(true)

  // symlinks to existing and not yet existing targets
  expect(isProtected('e/src/index.ts', root)).toBe(true)
  expect(isProtected('e/src/not-created-yet.ts', root)).toBe(true)
  expect(isProtected('e/brand-new/dir/file.ts', root)).toBe(true)
  expect(isProtected('x/index.ts', root)).toBe(true)
  expect(isProtected('x/not-created-yet.ts', root)).toBe(true)
  expect(isProtected('file-link.ts', root)).toBe(true)
  expect(isProtected('plain-link.md', root)).toBe(false)

  // leaving the repository root is still not "protected"
  expect(isProtected('../packages/evolve/src/index.ts', root)).toBe(false)
})

// --- [gate] ---------------------------------------------------------------------------------------------

interface Spies {
  sandboxCalls: SandboxOptions[]
  reviewCalls: number
  cards: OwnerCard[]
}

interface World {
  dshbotHome: string
  spies: Spies
  /** self_change, one write to a file of the candidate, self_submit; rejects with the error of the gate */
  submit: (file: string, content: string) => Promise<string>
}

function makeWorld(): World {
  const dshbotHome = join(root, 'home')
  const live = join(dshbotHome, 'app')
  put(join(live, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
  put(join(live, 'notes.md'), 'original notes\n')
  put(join(live, 'packages', 'evolve', 'src', 'index.ts'), 'export const gate = 1\n')
  put(join(live, 'packages', 'tools-exec', 'src', 'index.ts'), 'export const sandbox = 1\n')
  put(join(live, 'packages', 'tools-exec', 'src', 'extra.ts'), 'export const extra = 1\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')

  const spies: Spies = { sandboxCalls: [], reviewCalls: 0, cards: [] }
  const evolve = createEvolve({
    home: dshbotHome,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-protected-gate-test-key-0123456789' },
    sandbox: (options) => {
      spies.sandboxCalls.push(options)
      return { ok: true, status: 0, output: '' }
    },
    reviewer: async () => {
      spies.reviewCalls += 1
      return '{"verdict":"approve","summary":"ok"}'
    },
    card: async (card) => {
      spies.cards.push(card)
    },
  })

  const tools = new Map(evolve.tools.map((tool) => [tool.name, tool]))
  const submit = async (file: string, content: string): Promise<string> => {
    const started = String(await tools.get('self_change')?.execute({ description: 'edit a file' }))
    const id = /^id:\s*(\S+)/m.exec(started)?.[1]
    const path = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
    if (id === undefined || path === undefined) throw new Error(`self_change gave no candidate: ${started}`)
    put(join(path, file), content)
    return String(await tools.get('self_submit')?.execute({ id }))
  }
  return { dshbotHome, spies, submit }
}

async function gateError(world: World, file: string, content: string): Promise<string> {
  try {
    await world.submit(file, content)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`the gate was expected to reject ${file}, but it passed`)
}

test('test_gate_control_an_ordinary_candidate_reaches_the_sandbox_and_the_review', async () => {
  const world = makeWorld()

  await world.submit('notes.md', 'edited notes\n')

  expect(world.spies.sandboxCalls, 'the sandbox ran for an unprotected change').toHaveLength(1)
  expect(world.spies.reviewCalls, 'the review ran for an unprotected change').toBeGreaterThan(0)
  expect(world.spies.cards).toHaveLength(1)
})

for (const file of [
  'packages/evolve/src/index.ts',
  'packages/evolve/src/brand-new.ts',
  'packages/tools-exec/src/index.ts',
  'packages/tools-exec/src/extra.ts',
  'packages/tools-exec/src/brand-new.ts',
]) {
  test(`test_gate_self_submit_of_a_change_to_${file.replaceAll(/[^A-Za-z0-9]+/g, '_')}_is_rejected_before_the_sandbox`, async () => {
    const world = makeWorld()

    const message = await gateError(world, file, 'export const loosened = true\n')

    expect(message, 'the rejection is about protected paths').toMatch(/защищ|protected/i)
    expect(message, 'the rejection names the path').toContain(file)
    expect(world.spies.sandboxCalls, 'npm test (the sandbox) was not started').toHaveLength(0)
    expect(world.spies.reviewCalls, 'the review was not asked').toBe(0)
    expect(world.spies.cards, 'the owner gets no card').toHaveLength(0)
    expect(existsSync(join(world.dshbotHome, 'adopt.json')), 'adopt.json is not written').toBe(false)
  })
}

// --- [checklist] ----------------------------------------------------------------------------------------
