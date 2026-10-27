import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createReadTracker, createSkillStore, createSkillTools } from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-skill-import-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

// Keep description and sections strict so create can only reject this document
// because of its name, rather than another difference between the formats.
function document(name: string, requirements: readonly string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    'description: Imported command reference',
    ...requirements,
    '---',
    '',
    '## Procedure',
    'Read the command reference.',
    '## Pitfalls',
    'Commands may need installation.',
    '## Verification',
    'Check the command output.',
    '',
  ].join('\n')
}

function install(name: string, content: string, meta: Record<string, unknown>): string {
  const base = join(home, 'skills', name)
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'SKILL.md'), content)
  writeFileSync(join(base, '.meta.json'), JSON.stringify({ createdAt: 1, lastUsedAt: 1, ...meta }))
  return base
}

function toolNamed(tools: readonly RunnerTool[], name: string): RunnerTool {
  const tool = tools.find((entry) => entry.name === name)
  expect(tool, `the ${name} tool is available`).toBeDefined()
  return tool as RunnerTool
}

test('test_c1_imported_64_character_names_work_in_directory_list_index_and_view_but_create_stays_at_60', async () => {
  const name = `imported-${'a'.repeat(55)}`
  expect(name).toHaveLength(64)
  const content = document(name)
  const base = install(name, content, { imported: true })
  const store = createSkillStore({ home })
  const tools = createSkillTools(store, createReadTracker(), { readBeforeWrite: false })

  await expect.soft(
    (async () => store.skillDir(name))(),
    'the directory lookup accepts the imported name',
  ).resolves.toBe(base)
  expect.soft(store.list().map((skill) => skill.name), 'inspect uses the imported name limit').toContain(name)
  expect.soft(store.indexLines(), 'the index uses the imported name limit').toContain(
    `- ${name} — Imported command reference`,
  )
  await expect.soft(
    (async () => String(await toolNamed(tools, 'skill_view').execute({ name })))(),
    'skill_view reads the complete imported document',
  ).resolves.toContain(content)
  expect.soft(store.indexLines(), 'touching a skill preserves its imported status').toContain(
    `- ${name} — Imported command reference`,
  )

  // Use a separate empty catalog: rejection must be the strict name limit,
  // rather than an error that the imported skill already exists.
  const writerHome = join(home, 'writer')
  const writer = createSkillStore({ home: writerHome })
  const manage = toolNamed(createSkillTools(writer, createReadTracker()), 'skill_manage')
  const strictName = 'b'.repeat(60)
  await expect((async () => manage.execute({ action: 'create', name: strictName, content: document(strictName) }))())
    .resolves.toBeDefined()
  await expect((async () => manage.execute({ action: 'create', name, content }))()).rejects.toThrow(/60/)
  expect(existsSync(join(writerHome, 'skills', name))).toBe(false)

  for (const [origin, meta] of [
    ['own', {}],
    ['builtin', { builtin: true }],
  ] as const) {
    const strictLongName = `${origin}-${'c'.repeat(64 - origin.length - 1)}`
    install(strictLongName, document(strictLongName), meta)
    expect(() => store.skillDir(strictLongName), `${origin} names keep the strict limit`).toThrow(/60/)
    expect(store.list().map((skill) => skill.name)).not.toContain(strictLongName)
    expect(store.indexLines().some((line) => line.startsWith(`- ${strictLongName} — `))).toBe(false)
  }

  for (const invalidName of ['d'.repeat(65), 'Uppercase-import', 'import_with_underscore', 'import.with.dot']) {
    install(invalidName, document(invalidName), { imported: true })
    expect.soft(() => store.skillDir(invalidName), `invalid standard name: ${invalidName}`).toThrow()
    expect.soft(store.list().map((skill) => skill.name)).not.toContain(invalidName)
    expect.soft(store.indexLines().some((line) => line.startsWith(`- ${invalidName} — `))).toBe(false)
  }
})

test.each([
  ['OpenClaw bins', ['metadata:', '  openclaw:', '    requires:', '      bins: [missing-tool-alpha, missing-tool-beta]']],
  ['OpenClaw anyBins', ['metadata:', '  openclaw:', '    requires:', '      anyBins: [missing-tool-alpha, missing-tool-beta]']],
  ['Hermes commands', ['prerequisites:', '  commands: [missing-tool-alpha, missing-tool-beta]']],
] as const)('test_c6_skill_view_reports_two_missing_commands_on_separate_lines_from_%s', async (_source, requirements) => {
  // An isolated PATH makes absence independent of tools installed on the host.
  const pathDir = join(home, 'empty-bin')
  mkdirSync(pathDir)
  vi.stubEnv('PATH', pathDir)
  const name = 'command-requirements'
  const content = document(name, requirements)
  install(name, content, { imported: true })
  const store = createSkillStore({ home })
  const tools = createSkillTools(store, createReadTracker())

  const result = String(await toolNamed(tools, 'skill_view').execute({ name }))
  expect(result, 'requirements do not prevent the skill from being read').toContain(content)
  const missingLines = result.split('\n').filter((line) => /не найдено/i.test(line))
  const missingCommands = ['missing-tool-alpha', 'missing-tool-beta']
  expect.soft(missingLines, 'each missing binary has its own diagnostic line').toHaveLength(2)
  for (const command of missingCommands) {
    const lines = missingLines.filter((line) => line.includes(command))
    expect.soft(lines, `${command} is reported exactly once`).toHaveLength(1)
    for (const other of missingCommands.filter((entry) => entry !== command)) {
      expect.soft(lines[0] ?? '', `${command} and ${other} are not grouped on one line`).not.toContain(other)
    }
  }
  expect(store.list().map((skill) => skill.name), 'missing commands leave the skill visible').toContain(name)
  expect(store.indexLines()).toContain(`- ${name} — Imported command reference`)
})
