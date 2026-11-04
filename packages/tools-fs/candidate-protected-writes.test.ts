import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isProtected } from '../guard/src/index.js'
import { createFsTools, EDIT_TOOL_NAME, WRITE_TOOL_NAME } from './src/index.js'

test('c6 h1 c8 candidate roots refuse protected writes through files and symlinks', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-write-')))
  try {
    const home = join(root, 'home')
    const live = join(home, 'app')
    const workspace = join(home, 'workspace')
    const candidates = join(home, 'candidates')
    const candidate = join(candidates, 'c-example')
    const docs = join(candidate, 'docs/CONFIG.md')
    const workflow = join(candidate, '.github/workflows/ci.yml')
    mkdirSync(join(candidate, 'docs'), { recursive: true })
    mkdirSync(join(candidate, '.github/workflows'), { recursive: true })
    mkdirSync(live, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(docs, 'original docs\n')
    writeFileSync(workflow, 'original workflow\n')
    const tools = createFsTools({ home, roots: [{ path: workspace }, { path: live, readOnly: true }, { path: candidates }] })
    const write = tools.find((tool) => tool.name === WRITE_TOOL_NAME)!
    const edit = tools.find((tool) => tool.name === EDIT_TOOL_NAME)!
    const attempt = async (action: () => unknown): Promise<boolean> => {
      try { await action(); return false } catch { return true }
    }
    expect(isProtected(workflow, candidate)).toBe(true)
    expect(await attempt(() => write.execute({ path: workflow, content: 'forbidden' }))).toBe(true)
    expect(await attempt(() => edit.execute({ path: workflow, old_string: 'original', new_string: 'forbidden' }))).toBe(true)
    expect(readFileSync(workflow, 'utf8')).toBe('original workflow\n')
    rmSync(workflow)
    symlinkSync('../../docs/CONFIG.md', workflow)
    expect(isProtected(workflow, candidate)).toBe(true)
    expect(await attempt(() => write.execute({ path: workflow, content: 'forbidden' }))).toBe(true)
    expect(await attempt(() => edit.execute({ path: workflow, old_string: 'original', new_string: 'forbidden' }))).toBe(true)
    expect(readFileSync(docs, 'utf8')).toBe('original docs\n')
    await write.execute({ path: docs, content: 'allowed docs\n' })
    expect(readFileSync(docs, 'utf8')).toBe('allowed docs\n')
    rmSync(workflow)
    writeFileSync(workflow, 'protected target\n')
    const alias = join(candidate, 'docs/alias.md')
    symlinkSync('../.github/workflows/ci.yml', alias)
    expect(isProtected(alias, candidate)).toBe(true)
    expect(await attempt(() => write.execute({ path: alias, content: 'forbidden' }))).toBe(true)
    expect(readFileSync(workflow, 'utf8')).toBe('protected target\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('h2 daemon candidate roots refuse writes through a protected parent symlink', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-parent-')))
  try {
    const home = join(root, 'home')
    const live = join(home, 'app')
    const workspace = join(home, 'workspace')
    const candidates = join(home, 'candidates')
    const candidate = join(candidates, 'c-example')
    mkdirSync(join(candidate, '.github'), { recursive: true })
    mkdirSync(join(candidate, 'docs'), { recursive: true })
    mkdirSync(live, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    const target = join(candidate, 'docs/ci.yml')
    const path = join(candidate, '.github/workflows/ci.yml')
    writeFileSync(target, 'original\n')
    symlinkSync('../docs', join(candidate, '.github/workflows'))
    const tools = createFsTools({ home, roots: [{ path: workspace }, { path: live, readOnly: true }, { path: candidates }] })
    const write = tools.find((tool) => tool.name === WRITE_TOOL_NAME)!
    const edit = tools.find((tool) => tool.name === EDIT_TOOL_NAME)!
    const refused = async (action: () => unknown): Promise<boolean> => {
      try { await action(); return false } catch { return true }
    }
    expect(await refused(() => write.execute({ path, content: 'forbidden' }))).toBe(true)
    expect(await refused(() => edit.execute({ path, old_string: 'original', new_string: 'forbidden' }))).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('original\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
