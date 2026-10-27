// The WB skills of the owner are optional: they live in examples/skills and are no longer shipped as
// built-in. A copy that an earlier start put into the owner catalog stays there as an ordinary skill,
// and a skill the owner copies from examples works like any other skill of the catalog.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { builtinSkillsDir, createLearning, createSkillStore, type KvStore } from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXAMPLES = join(ROOT, 'examples', 'skills')

// sha256 of the SKILL.md files as they were shipped in packages/learn/builtin-skills.
const WB_SKILLS = {
  'wb-ads-anomalies': '1c734abe5464863c6839c39635efb7e5f8bad848efb7ec35babce6601846becf',
  'wb-budget-forecast': '5deb2701f67b1ae08d69dd191b568b1f302de2257d96749ed7927200ea722094',
} as const

let home: string
let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-optional-skills-'))
  home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function document(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    '## Procedure',
    'Check the figures of the day.',
    '## Pitfalls',
    'A missing report is not a zero.',
    '## Verification',
    'Compare with the previous report.',
    '',
  ].join('\n')
}

function learningOf(builtinDir: string): ReturnType<typeof createLearning> {
  const map = new Map<string, string>()
  const kv: KvStore = {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value)
    },
  }
  return createLearning({ home, kv, now: () => 5_000, launchReview: () => undefined, builtinDir })
}

function toolNamed(tools: readonly RunnerTool[], name: string): RunnerTool {
  const tool = tools.find((entry) => entry.name === name)
  expect(tool, `the ${name} tool is available`).toBeDefined()
  return tool as RunnerTool
}

test('test_c2_a_skill_copied_as_builtin_and_no_longer_shipped_stays_an_ordinary_owner_skill', async () => {
  const name = 'wb-ads-anomalies'
  const oldShipment = join(scratch, 'old-shipment')
  mkdirSync(join(oldShipment, name), { recursive: true })
  writeFileSync(join(oldShipment, name, 'SKILL.md'), document(name, 'Anomalies of the ads'))

  // The earlier start: the skill rides in the shipment and is copied as a built-in one.
  expect(createSkillStore({ home, builtinDir: oldShipment }).list()).toContainEqual(
    expect.objectContaining({ name, builtin: true }),
  )

  // The restart on a shipment without it.
  const tools = learningOf(builtinSkillsDir()).mainTools()
  const listed = String(await toolNamed(tools, 'skills_list').execute({}))
  expect(listed, 'skills_list still shows the skill').toContain(`- ${name} — Anomalies of the ads`)
  expect(String(await toolNamed(tools, 'skill_view').execute({ name }))).toContain('Check the figures of the day.')

  const outcome = await toolNamed(tools, 'skill_manage').execute({
    action: 'patch',
    name,
    old_string: 'Check the figures of the day.',
    new_string: 'Check the figures of the week.',
  })
  expect(String(outcome)).not.toContain('встроенный')
  expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toContain('Check the figures of the week.')
  expect(createSkillStore({ home, builtinDir: builtinSkillsDir() }).list()).toContainEqual(
    expect.objectContaining({ name, builtin: false }),
  )

  // A skill that is still shipped stays read-only.
  const stillShipped = readdirSync(builtinSkillsDir(), { withFileTypes: true }).find((entry) => entry.isDirectory())
  expect(stillShipped).toBeDefined()
  await expect(
    Promise.resolve().then(() =>
      toolNamed(tools, 'skill_manage').execute({
        action: 'patch',
        name: (stillShipped as { name: string }).name,
        old_string: '## Procedure',
        new_string: '## Procedure ',
      }),
    ),
  ).rejects.toThrow('встроенный')
})

test('test_c3_a_skill_copied_from_examples_works_as_an_ordinary_owner_skill', async () => {
  const copied = Object.keys(WB_SKILLS)
  for (const name of copied) {
    expect(existsSync(join(EXAMPLES, name, 'SKILL.md')), `examples/skills/${name} exists`).toBe(true)
    cpSync(join(EXAMPLES, name), join(home, 'skills', name), { recursive: true })
  }

  const learning = learningOf(builtinSkillsDir())
  const tools = learning.mainTools()
  const listed = String(await toolNamed(tools, 'skills_list').execute({}))
  const store = createSkillStore({ home, builtinDir: builtinSkillsDir() })
  for (const name of copied) {
    expect(listed, `skills_list shows ${name}`).toContain(`- ${name} — `)
    expect(learning.skillsIndex(), `the owner index shows ${name}`).toContain(`- ${name} — `)
    expect(store.list()).toContainEqual(expect.objectContaining({ name, builtin: false, imported: false }))
    const text = String(await toolNamed(tools, 'skill_view').execute({ name }))
    expect(text, `skill_view returns the document of ${name}`).toContain(`name: ${name}`)
  }
})
