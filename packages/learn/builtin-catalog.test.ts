// The skills shipped with the daemon: the nine recipes of the owner scenarios
// are present in packages/learn/builtin-skills, valid as owner skills, synced into
// the catalog marked built-in, visible to skills_list and to the owner turn index,
// readable in full with skill_view and read-only for skill_manage.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  builtinSkillsDir,
  createLearning,
  createReadTracker,
  createSkillStore,
  createSkillTools,
  SKILL_DESCRIPTION_LIMIT,
  type KvStore,
  validateSkillDocument,
} from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

const SHIPPED = [
  'youtube-summary',
  'action-items',
  'weekly-review',
  'news-monitor',
  'cited-answer',
  'github-gh',
  'blocked-page',
  'docker-ops',
  'watermark-watcher',
] as const

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-builtin-skills-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function shippedText(name: string): string {
  const file = join(builtinSkillsDir(), name, 'SKILL.md')
  expect(existsSync(file), `${name}/SKILL.md is shipped`).toBe(true)
  return readFileSync(file, 'utf8')
}

function toolNamed(tools: readonly RunnerTool[], name: string): RunnerTool {
  const found = tools.find((tool) => tool.name === name)
  expect(found, `tool ${name}`).toBeDefined()
  return found as RunnerTool
}

function ownerTools(): { tools: RunnerTool[]; store: ReturnType<typeof createSkillStore> } {
  const store = createSkillStore({ home, builtinDir: builtinSkillsDir() })
  const tools = createSkillTools(store, createReadTracker(), {
    readBeforeWrite: false,
    allowDelete: true,
    ownerCatalog: true,
  })
  return { tools, store }
}

describe('built-in skills', () => {
  test('test_c1_every_shipped_skill_passes_validateSkillDocument', () => {
    for (const name of SHIPPED) {
      const content = shippedText(name)
      const parsed = validateSkillDocument(name, content)
      expect(parsed.name).toBe(name)
      expect(parsed.description.length).toBeGreaterThan(0)
      expect([...parsed.description].length).toBeLessThanOrEqual(SKILL_DESCRIPTION_LIMIT)
      for (const section of ['Procedure', 'Pitfalls', 'Verification']) {
        expect(content, `${name}: ${section}`).toMatch(new RegExp(`^#{1,6}\\s*${section}\\s*$`, 'm'))
      }
    }
  })

  test('test_c2_shipped_skills_are_synced_as_builtin_and_visible_in_list_and_owner_index', () => {
    const map = new Map<string, string>()
    const kv: KvStore = { get: (key) => map.get(key), set: (key, value) => void map.set(key, value) }
    const learning = createLearning({
      home,
      kv,
      now: () => Date.now(),
      launchReview: () => undefined,
      builtinDir: builtinSkillsDir(),
    })

    const store = createSkillStore({ home, builtinDir: builtinSkillsDir() })
    const byName = new Map(store.list().map((skill) => [skill.name, skill]))
    for (const name of SHIPPED) {
      const info = byName.get(name)
      expect(info, `${name} is in the catalog`).toBeDefined()
      expect(info?.builtin, `${name} is marked built-in`).toBe(true)
      expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(shippedText(name))
    }

    const { tools } = ownerTools()
    const listed = String(toolNamed(tools, 'skills_list').execute({}))
    const index = learning.skillsIndex()
    for (const name of SHIPPED) {
      expect(listed, `skills_list shows ${name}`).toContain(`- ${name} — `)
      expect(index, `owner turn index shows ${name}`).toContain(`- ${name} — `)
    }
  })

  test('test_c3_skill_view_returns_full_text_and_skill_manage_cannot_change_or_delete', () => {
    const { tools } = ownerTools()
    const view = toolNamed(tools, 'skill_view')
    const manage = toolNamed(tools, 'skill_manage')

    for (const name of SHIPPED) {
      const original = shippedText(name).replace(/\r\n/g, '\n')
      expect(String(view.execute({ name }))).toBe(original)

      expect(() =>
        manage.execute({ action: 'patch', name, old_string: `name: ${name}`, new_string: 'name: hijacked' }),
      ).toThrow(/встроенный/)
      expect(() => manage.execute({ action: 'write_file', name, path: 'notes.md', content: 'x' })).toThrow(/встроенный/)
      expect(() => manage.execute({ action: 'delete', name })).toThrow(/встроенный/)
      expect(() => manage.execute({ action: 'create', name, content: original })).toThrow(/встроенный/)

      expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toBe(original)
      expect(String(view.execute({ name }))).toBe(original)
    }
  })
})
