// Text files of the persona: the working rules, the status format, honest talk about capabilities and the
// attribution of borrowed prompts. These tests read files only; the daemon-level checks live in
// packages/app/turn-rules.test.ts.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { estimateTokens } from './src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const rulesPath = join(repoRoot, 'persona', 'rules.md')

function readRules(): string {
  expect(existsSync(rulesPath), 'persona/rules.md must exist: the working rules live there').toBe(true)
  return readFileSync(rulesPath, 'utf8')
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
}

function markdownFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...markdownFiles(full))
    else if (entry.name.endsWith('.md')) found.push(full)
  }
  return found
}

// --- [rules] ---------------------------------------------------------------------------------------------

test('test_rules_file_is_a_real_body_of_at_most_1500_tokens', () => {
  const rules = readRules().trim()
  expect(estimateTokens(rules)).toBeLessThanOrEqual(1500)
  expect(estimateTokens(rules), 'the stub is replaced by the working rules').toBeGreaterThanOrEqual(300)
})

// --- [status] --------------------------------------------------------------------------------------------

test('test_status_format_is_limited_to_long_tasks_and_the_final_report', () => {
  const rules = readRules()
  const holders = paragraphsOf(rules).filter((paragraph) => paragraph.includes('этап · сделано · осталось'))
  expect(holders.length, 'the rules keep the status format «этап · сделано · осталось»').toBeGreaterThan(0)
  const limited = holders.some((paragraph) => /длинн|долг/i.test(paragraph) && /итог/i.test(paragraph))
  expect(limited, `the format is for long tasks and the final report only, got: ${JSON.stringify(holders)}`).toBe(true)
  expect(rules).not.toContain('Статус — «этап · сделано · осталось».')
})

// --- [honest] --------------------------------------------------------------------------------------------

const TURN_TOOLS_RE = /(?:текущ\S*|эт(?:ого|ом|от)|данн\S*|нынешн\S*)\s+(?:ход\S*|запрос\S*)/i
const NAMES_ABSENT_RE =
  /отсутств|недоступн|инструмент\S*\s+(?:\S+\s+){0,3}нет|нет\s+(?:\S+\s+){0,3}инструмент|не\s+(?:вижу|видишь|видно|подключен)|нет\s+в\s+списк|(?:прямо|открыто)\s+(?:скаж|назов|говор|призна)|(?:скаж|назов|говор|призна)\S*\s+(?:\S+\s+){0,2}(?:прямо|открыто)/i

test('test_honest_rules_judge_capabilities_by_the_tools_of_the_current_turn_and_name_the_missing_ones', () => {
  const paragraphs = paragraphsOf(readRules()).filter((paragraph) => /инструмент/i.test(paragraph))
  expect(
    paragraphs.some((paragraph) => TURN_TOOLS_RE.test(paragraph)),
    'the rules must tie statements about capabilities to the tools of the current turn',
  ).toBe(true)
  expect(
    paragraphs.some((paragraph) => NAMES_ABSENT_RE.test(paragraph)),
    'the rules must make the bot name the missing capabilities directly',
  ).toBe(true)
})

// A sentence that denies, conditions or postpones a capability is not a claim of it.
const NOT_A_CLAIM_RE =
  /(?:^|[^а-яёa-z])(?:не|нет|ни|без|нельзя|запрещ\S*|если|когда|пока|только|лишь|будет|смогу|появ\S*|нужен|нужн\S*|инструмент\S*|можно)(?![а-яёa-z])/i
const CLAIMS: readonly RegExp[] = [
  // "я коммичу", "бот пушит в main"
  /комми[тч]|commit|пуш|\bpush\b/i,
  // "правлю свой код", "переписываю собственный исходник"
  /(?:переписыва|переписа|правл|править|правк|редактир|менят|изменя)\S*\s+(?:\S+\s+){0,2}(?:свой|свои|свою|собственн\S+|мой|мои|мою)\s+(?:\S+\s+)?(?:код|исходник)/i,
  // "мой код лежит в git, и я могу его переписывать"
  /(?:свой|свои|мой|мои|собственн\S+)\s+(?:\S+\s+)?(?:код|исходник)\S*[^.]*?(?:переписыва|переписа|править|правл|менять|редактир)\S*/i,
  // "могу переписывать"
  /могу\s+(?:\S+\s+){0,2}(?:переписыва|переписа|править)\S*/i,
]

test('test_honest_persona_files_do_not_claim_that_the_bot_commits_or_edits_its_own_code', () => {
  const files = markdownFiles(join(repoRoot, 'persona'))
  expect(files.length, 'persona/ holds the identity seed and the rules').toBeGreaterThan(0)
  const claims: string[] = []
  for (const file of files) {
    const sentences = readFileSync(file, 'utf8')
      .split(/(?<=[.!?…])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== '')
    for (const sentence of sentences) {
      if (NOT_A_CLAIM_RE.test(sentence)) continue
      if (CLAIMS.some((claim) => claim.test(sentence))) claims.push(`${relative(repoRoot, file)}: ${sentence}`)
    }
  }
  expect(claims, 'no tool commits to git or edits the bot code yet: say it only as a condition or a plan').toEqual([])
})

// --- [notice] --------------------------------------------------------------------------------------------

test('test_notice_third_party_file_has_the_three_copyrights_and_the_mit_text', () => {
  const path = join(repoRoot, 'THIRD_PARTY_NOTICES.md')
  expect(existsSync(path), 'THIRD_PARTY_NOTICES.md must exist in the repository root').toBe(true)
  const text = readFileSync(path, 'utf8')
  for (const holder of ['OpenClaw Foundation', 'Nous Research', 'Anton Razzhigaev']) {
    const line = new RegExp(`copyright[^\\n]*${holder}|${holder}[^\\n]*copyright|©[^\\n]*${holder}`, 'i')
    expect(text, `a copyright line for ${holder}`).toMatch(line)
  }
  expect(text).toMatch(/MIT/)
  expect(text).toContain('Permission is hereby granted, free of charge')
  expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  expect(text).toContain('copies or substantial portions of the Software')
})

test('test_notice_charter_stays_the_owners_own_text', () => {
  const charter = readFileSync(join(repoRoot, 'CHARTER.md'), 'utf8')
  for (const heading of ['# Charter', '## Floor', '## Principles', '## Consent protocol', '## Voice', '## Drift detector']) {
    expect(charter, `CHARTER.md keeps its section ${heading}`).toContain(heading)
  }
  expect(Buffer.byteLength(charter, 'utf8'), 'the charter stays within 6 KB').toBeLessThanOrEqual(6144)
  for (const borrowed of ['OpenClaw Foundation', 'Nous Research', 'Anton Razzhigaev', 'Permission is hereby granted']) {
    expect(charter, 'attribution goes to THIRD_PARTY_NOTICES.md, not into the charter').not.toContain(borrowed)
  }
})
