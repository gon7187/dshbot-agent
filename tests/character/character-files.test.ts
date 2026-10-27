// File-level checks of the character: the size limits of the persona text and the untouched charter. The
// checks of what the owner's system prefix carries live in character-prefix.test.ts.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const personaDir = join(repoRoot, 'persona')

const CHARACTER_LIMIT_CHARS = 3500
const CHARACTER_PLUS_RULES_LIMIT_CHARS = 9000

function read(path: string): string {
  expect(existsSync(path), `${path} must exist`).toBe(true)
  return readFileSync(path, 'utf8')
}

test('test_c5_character_text_is_at_most_3500_chars_and_with_rules_at_most_9000', () => {
  const character = read(join(personaDir, 'character.md'))
  const rules = read(join(personaDir, 'rules.md'))
  expect(character.trim().length, 'the character is a real body, not a stub').toBeGreaterThanOrEqual(1200)
  expect(character.length, `persona/character.md is ${character.length} chars`).toBeLessThanOrEqual(CHARACTER_LIMIT_CHARS)
  const together = character.length + rules.length
  expect(together, `character.md and rules.md together are ${together} chars`).toBeLessThanOrEqual(
    CHARACTER_PLUS_RULES_LIMIT_CHARS,
  )
})

test('test_c6_character_scenario_tests_exist_and_charter_keeps_its_own_principles', () => {
  const dir = join(repoRoot, 'tests', 'character')
  expect(existsSync(dir) && statSync(dir).isDirectory(), 'tests/character/ must exist').toBe(true)
  const scenarios = readdirSync(dir).filter((name) => name.endsWith('.test.ts'))
  expect(scenarios.length, 'tests/character/ holds scenario tests').toBeGreaterThan(0)
  const bodies = scenarios.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
  expect(bodies, 'the scenarios check the character in the system prefix').toContain('persona/character.md')

  // The charter is the owner's file: P0-P5 and the drift detector stay as they are, P6-P13 live in persona/.
  const charter = read(join(repoRoot, 'CHARTER.md'))
  for (const id of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']) {
    expect(charter, `CHARTER.md keeps ${id}`).toContain(`**${id} `)
  }
  expect(charter).toContain('## Drift detector')
  expect(charter, 'P6-P13 are not moved into the charter').not.toMatch(/\*\*P(?:6|7|8|9|10|11|12|13) /)
  expect(charter, 'the charter points at the scenario tests').toMatch(/character scenario tests/i)
})
