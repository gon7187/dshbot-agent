import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createReadTracker, createSkillStore, createSkillTools } from './src/index.js'

test('M-IMPORT persists an imported document and rejects catalog overwrite or escape atomically', async () => {
  const home = mkdtempSync(join(tmpdir(), 'skill-import-'))
  try {
    const store = createSkillStore({ home })
    const manage = createSkillTools(store, createReadTracker(), { ownerCatalog: true }).find(t => t.name === 'skill_manage')!
    const content = '---\nname: fixture\ndescription: Synthetic import fixture\n---\nFree-form body.\n'
    await manage.execute({ action: 'import', name: 'fixture', content })
    const reopened = createSkillStore({ home })
    expect(reopened.read('fixture')).toBe(content)
    expect(reopened.list()).toContainEqual(expect.objectContaining({ name: 'fixture', imported: true, builtin: false }))
    const originalMeta = readFileSync(join(home, 'skills/fixture/.meta.json'))
    await expect(async () => manage.execute({ action: 'import', name: 'fixture', content })).rejects.toThrow('already exists')
    for (const name of ['../escaped', 'wrong-name']) {
      await expect(async () => manage.execute({ action: 'import', name, content })).rejects.toThrow()
    }
    await expect(async () => manage.execute({ action: 'import', name: 'child', content: content.replace('fixture', 'child') }, {
      sessionId: 'subagent-fixture', signal: new AbortController().signal,
    })).rejects.toThrow('delegated child')
    // Builtins share the catalog, but importing never replaces their bytes or metadata.
    const builtinDir = join(home, 'skills/builtin-fixture')
    mkdirSync(builtinDir)
    writeFileSync(join(builtinDir, 'SKILL.md'), content.replace('fixture', 'builtin-fixture') + '\n## Procedure\nRun fixture.\n## Pitfalls\nNone.\n## Verification\nCheck fixture.\n')
    writeFileSync(join(builtinDir, '.meta.json'), JSON.stringify({ createdAt: 1, lastUsedAt: 1, builtin: true }))
    const builtin = reopened.read('builtin-fixture')
    await expect(async () => manage.execute({ action: 'import', name: 'builtin-fixture', content: content.replace('fixture', 'builtin-fixture') })).rejects.toThrow()
    expect(reopened.read('builtin-fixture')).toBe(builtin)
    expect(readFileSync(join(home, 'skills/fixture/.meta.json'))).toEqual(originalMeta)
    expect(reopened.read('fixture')).toBe(content)
    expect(existsSync(join(home, 'escaped'))).toBe(false)
    expect(reopened.list().map(s => s.name).sort()).toEqual(['builtin-fixture', 'fixture'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
