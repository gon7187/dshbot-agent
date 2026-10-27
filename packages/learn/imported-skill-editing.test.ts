import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createLearning, createSkillStore, type KvStore } from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-skill-editing-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function document(name: string, description: string, body: string): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n')
}

const strictBody = [
  '## Procedure',
  'Read the command reference.',
  '## Pitfalls',
  'Commands may need installation.',
  '## Verification',
  'Check the command output.',
].join('\n')

function installImported(name: string): string {
  const base = join(home, 'skills', name)
  const content = document(name, 'Imported reference', 'Original free-form reference.')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'SKILL.md'), content)
  writeFileSync(join(base, '.meta.json'), JSON.stringify({ imported: true, createdAt: 1, lastUsedAt: 1 }))
  return content
}

function learningOf(): ReturnType<typeof createLearning> {
  const map = new Map<string, string>()
  const kv: KvStore = {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value)
    },
  }
  return createLearning({ home, kv, now: () => 5_000, launchReview: () => undefined })
}

function toolNamed(tools: readonly RunnerTool[], name: string): RunnerTool {
  const tool = tools.find((entry) => entry.name === name)
  expect(tool, `the ${name} tool is available`).toBeDefined()
  return tool as RunnerTool
}

async function patch(tool: RunnerTool, name: string, before: string, after: string): Promise<unknown> {
  return tool.execute({ action: 'patch', name, old_string: before, new_string: after })
}

function expectImported(name: string, description: string): void {
  const meta: unknown = JSON.parse(readFileSync(join(home, 'skills', name, '.meta.json'), 'utf8'))
  expect(meta).toMatchObject({ imported: true })
  // A fresh store also proves the origin survives reloading from disk.
  expect(createSkillStore({ home }).list()).toContainEqual(expect.objectContaining({
    name,
    description,
    imported: true,
  }))
}

test('test_c1_owner_patch_accepts_imported_format_and_preserves_the_full_name_and_origin', async () => {
  const name = `imported-${'a'.repeat(53)}`
  expect(name).toHaveLength(62)
  const before = installImported(name)
  const description = 'd'.repeat(300)
  const after = document(name, description, 'Updated owner reference without mandatory sections.')
  const tools = learningOf().mainTools()

  // Owner tools accept the patch without a preceding skill_view.
  await expect(patch(toolNamed(tools, 'skill_manage'), name, before, after)).resolves.toBeDefined()

  expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(after)
  expectImported(name, description)
  expect(String(await toolNamed(tools, 'skill_view').execute({ name }))).toContain(after)
  expect(String(await toolNamed(tools, 'skills_list').execute({}))).toContain(`- ${name} — `)
  expectImported(name, description)
})

test('test_c2_review_patch_after_skill_view_uses_import_rules_and_keeps_imported_metadata', async () => {
  const name = `imported-${'b'.repeat(53)}`
  expect(name).toHaveLength(62)
  const before = installImported(name)
  const description = 'r'.repeat(300)
  const after = document(name, description, 'Updated background reference without mandatory sections.')
  const tools = learningOf().reviewTools()
  const manage = toolNamed(tools, 'skill_manage')

  await expect(patch(manage, name, before, after)).rejects.toThrow(/read-before-write/)
  expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(before)
  expect(String(await toolNamed(tools, 'skill_view').execute({ name }))).toContain(before)

  await expect(patch(manage, name, before, after)).resolves.toBeDefined()

  expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(after)
  expectImported(name, description)
  expect(String(await toolNamed(tools, 'skill_view').execute({ name }))).toContain(after)
  expect(String(await toolNamed(tools, 'skills_list').execute({}))).toContain(`- ${name} — `)
  expectImported(name, description)
})

test('test_c3_imported_patch_rejects_overlong_description_and_uppercase_frontmatter_without_writing', async () => {
  // A short directory name isolates document validation from the name-length limit.
  const name = 'imported-reference'
  const before = installImported(name)
  const manage = toolNamed(learningOf().mainTools(), 'skill_manage')
  const invalidDocuments = [
    {
      content: document(name, 'd'.repeat(1025), strictBody),
      error: /description.*1024/i,
    },
    {
      content: document('Imported-reference', 'Imported reference', strictBody),
      error: /name.*(?:match|lowercase)/i,
    },
  ]

  for (const invalid of invalidDocuments) {
    await expect.soft(patch(manage, name, before, invalid.content)).rejects.toThrow(invalid.error)
    expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(before)
    expectImported(name, 'Imported reference')
  }
})

test('test_c4_own_patch_and_create_keep_strict_description_and_section_rules', async () => {
  const name = 'owner-reference'
  const before = document(name, 'Owner reference', strictBody)
  const tools = learningOf().mainTools()
  const manage = toolNamed(tools, 'skill_manage')
  await manage.execute({ action: 'create', name, content: before })
  const file = join(home, 'skills', name, 'SKILL.md')
  expect(readFileSync(file, 'utf8')).toBe(before)

  const after = document(name, 'd'.repeat(300), 'Free-form body without mandatory sections.')
  await expect(patch(manage, name, before, after)).rejects.toThrow(/description.*60/i)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(createSkillStore({ home }).list()).toContainEqual(expect.objectContaining({ name, imported: false }))

  const newName = 'another-owner-reference'
  const content = document(newName, 'd'.repeat(300), 'Free-form body without mandatory sections.')
  await expect((async () => manage.execute({ action: 'create', name: newName, content }))())
    .rejects.toThrow(/description.*60/i)
  expect(existsSync(join(home, 'skills', newName))).toBe(false)
})
