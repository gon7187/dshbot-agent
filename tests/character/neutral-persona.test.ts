// File-level checks of the neutral starting persona of the repository: the Voice section of the charter
// speaks the owner's language, and the persona files carry no profanity and no tie to a person or a machine.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

function read(relative: string): string {
  const path = join(repoRoot, relative)
  expect(existsSync(path), `${relative} must exist`).toBe(true)
  return readFileSync(path, 'utf8')
}

/** Lines of the `## <title>` section, up to the next second-level heading. */
function sectionLines(text: string, title: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${title}`)
  expect(start, `the section "${title}" must exist`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).map((line) => line.trim()).filter((line) => line !== '')
}

const PROFANITY_STEMS =
  /хуй|хуё|хуев|хуит|пизд|говн|говен|ебан|ёбан|ебат|ебал|ёбыв|блядь|бляд|блят|пидор|пидар|залуп|мудак|мудил|дерьм|fuck|shit|bitch|asshole/
const PROFANITY_WORDS = /(?<![а-яёa-z])(?:сука|суки|суку|хер|хрен|бля|жопа|жопу|нахер|нахрен)(?![а-яёa-z])/

function profanityIn(text: string): string[] {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (const pattern of [PROFANITY_STEMS, PROFANITY_WORDS]) {
    const match = pattern.exec(lower)
    if (match) found.push(match[0])
  }
  return found
}

test('test_c1_charter_voice_speaks_the_owner_language_with_a_neutral_engineer_tone', () => {
  const charter = read('CHARTER.md')
  const voice = sectionLines(charter, 'Voice').map((line) => line.replace(/^[-*]\s+/, ''))

  expect(voice, 'the owner is answered in the language the owner writes in').toContain(
    'Speak the owner’s language: reply in the language the owner writes in.',
  )
  expect(voice, 'the chat tone line is neutral and points at the character file').toContain(
    'In chat you are a seasoned engineer: direct, dry and to the point. Tone and style details live in the character file.',
  )
  expect(charter).not.toContain('Speak Russian with the owner.')
  expect(charter).not.toContain('idiomatic Russian profanity')

  // the rest of the Voice section and of the charter stays as it was
  const joined = voice.join('\n')
  expect(joined).toContain('Lead with the point.')
  expect(joined).toContain('Code, commits, pull requests, documentation and anything public stay clean.')
  expect(joined).toContain('Security warnings, irreversible operations and step-by-step recovery are stated plainly and without jokes.')
  expect(joined).toContain('Status reads as "stage · done · left".')
  const headings = charter.split('\n').filter((line) => line.startsWith('#'))
  expect(headings).toEqual(['# Charter', '## Floor', '## Principles', '## Consent protocol', '## Voice', '## Drift detector'])
  for (const id of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']) {
    expect(charter, `CHARTER.md keeps ${id}`).toContain(`**${id} `)
  }
})

test('test_c2_persona_files_and_charter_have_no_profanity_and_no_tie_to_a_machine', () => {
  for (const name of ['persona/identity.seed.md', 'persona/character.md', 'CHARTER.md']) {
    expect(profanityIn(read(name)), `${name} must carry no profanity`).toEqual([])
  }
  const identity = read('persona/identity.seed.md')
  expect(identity).not.toContain('говно')
  expect(identity).not.toContain('хуёво')
  expect(identity).not.toMatch(/Linux-машин\S*\s+своего\s+человека/i)
  expect(identity, 'the working name stays').toContain('DSHBOT')
  expect(identity, 'the engine stays').toContain('DeepSeek Harness')
})
