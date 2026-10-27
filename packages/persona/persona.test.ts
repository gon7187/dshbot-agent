import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

type Skill = { name: string; description: string }
type Task = { id: string; status: string; title: string }

type Persona = {
  buildPrefix: (input: { charter: string; identity: string; character?: string; rules: string; skills: Skill[] }) => string
  buildTail: (input: { now: string; memory: string; user: string; tasks: Task[] }) => string
  estimateTokens: (text: string) => number
  checkPrefixBudget: (prefix: string, maxTokens?: number) => { ok: boolean; tokens: number; maxTokens: number }
  loadCharacter: (personaDir: string) => string
}

// Путь держим в переменной с типом string: пока модуля нет, падает assert в loadExport, а не импорт или tsc
const MODULE: string = './src/index.ts'

async function loadExport<K extends keyof Persona>(name: K): Promise<Persona[K]> {
  const mod: Record<string, unknown> = await import(MODULE).catch(() => ({}))
  expect(typeof mod[name], `${name} должен экспортироваться из packages/persona`).toBe('function')
  return mod[name] as Persona[K]
}

const NOW = '2026-10-23T14:05:00+03:00'
const TASK: Task = { id: 'task-42', status: 'in_progress', title: 'TASK_TITLE_MARK' }
const SKILLS: Skill[] = [
  { name: 'zeta-skill', description: 'Z skill' },
  { name: 'alpha-skill', description: 'A skill' },
  { name: 'mid-skill', description: 'M skill' },
]

test('test_c1_buildPrefix_same_input_gives_identical_string', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const first = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', rules: 'RULES_MARK', skills: SKILLS.map((s) => ({ ...s })) })
  const second = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', rules: 'RULES_MARK', skills: SKILLS.map((s) => ({ ...s })) })
  expect(first).toBe(second)
})

test('test_c2_buildPrefix_ignores_skills_order', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const direct = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', rules: 'RULES_MARK', skills: SKILLS })
  const shuffled = buildPrefix({
    charter: 'CHARTER_MARK',
    identity: 'IDENTITY_MARK',
    rules: 'RULES_MARK',
    skills: [SKILLS[2], SKILLS[0], SKILLS[1]],
  })
  expect(shuffled).toBe(direct)
})

test('test_c3_buildPrefix_sections_follow_charter_identity_rules_skills_order', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const prefix = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', rules: 'RULES_MARK', skills: SKILLS })
  const positions = ['CHARTER_MARK', 'IDENTITY_MARK', 'RULES_MARK', 'alpha-skill'].map((m) => prefix.indexOf(m))
  expect(Math.min(...positions), 'каждая секция должна присутствовать в префиксе').toBeGreaterThanOrEqual(0)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
})

test('test_c4_buildPrefix_truncates_long_skill_description_to_60_chars_keeps_name', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const prefix = buildPrefix({
    charter: 'CHARTER_MARK',
    identity: 'IDENTITY_MARK',
    rules: 'RULES_MARK',
    skills: [{ name: 'long-skill', description: 'я'.repeat(80) }],
  })
  expect(prefix).toContain('long-skill')
  expect(prefix).toContain('я'.repeat(60))
  expect(prefix).not.toContain('я'.repeat(61))
})

test('test_c5_buildTail_wraps_in_context_tag_and_carries_time_memory_user_tasks', async () => {
  const buildTail = await loadExport('buildTail')
  const tail = buildTail({ now: NOW, memory: 'MEMORY_MARK', user: 'USER_MARK', tasks: [TASK] })
  expect(tail.startsWith('<context>')).toBe(true)
  expect(tail.endsWith('</context>')).toBe(true)
  expect(tail).toContain(NOW)
  expect(tail).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/)
  expect(tail).toContain('MEMORY_MARK')
  expect(tail).toContain('USER_MARK')
  expect(tail).toContain(TASK.id)
  expect(tail).toContain(TASK.status)
  expect(tail).toContain(TASK.title)
})

test('test_c6_buildTail_first_line_says_reference_context_not_owner_message', async () => {
  const buildTail = await loadExport('buildTail')
  const tail = buildTail({ now: NOW, memory: 'MEMORY_MARK', user: 'USER_MARK', tasks: [TASK] })
  const inner = tail.slice('<context>'.length, -'</context>'.length)
  const firstLine = inner.split('\n').find((l) => l.trim() !== '') ?? ''
  expect(firstLine).toMatch(/справочн/i)
  expect(firstLine).toMatch(/\bне\b/i)
  expect(firstLine).toMatch(/сообщени/i)
  expect(firstLine).toMatch(/владельц/i)
})

test('test_c7_buildTail_omits_empty_memory_user_tasks_sections', async () => {
  const buildTail = await loadExport('buildTail')
  const lineCount = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length

  const allEmpty = buildTail({ now: NOW, memory: '', user: '', tasks: [] })
  const body = allEmpty.replace('<context>', '').replace('</context>', '')
  const leftovers = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .filter((l) => !l.includes(NOW) && !/справочн/i.test(l))
  expect(leftovers, 'при пустых разделах в блоке не должно остаться ничего, кроме пометки и времени').toEqual([])

  const full = { now: NOW, memory: 'MEMORY_MARK', user: 'USER_MARK', tasks: [TASK] }
  const fullLines = lineCount(buildTail(full))

  const noMemory = buildTail({ ...full, memory: '' })
  expect(noMemory).not.toContain('MEMORY_MARK')
  expect(lineCount(noMemory)).toBeLessThan(fullLines)

  const noUser = buildTail({ ...full, user: '' })
  expect(noUser).not.toContain('USER_MARK')
  expect(lineCount(noUser)).toBeLessThan(fullLines)

  const noTasks = buildTail({ ...full, tasks: [] })
  expect(noTasks).not.toContain(TASK.title)
  expect(lineCount(noTasks)).toBeLessThan(fullLines)
})

test('test_c8_estimateTokens_bytes_divided_by_4_rounded_up', async () => {
  const estimateTokens = await loadExport('estimateTokens')
  expect(estimateTokens('abcd')).toBe(1)
  expect(estimateTokens('abcde')).toBe(2)
  // 'привет' — 12 байт UTF-8
  expect(estimateTokens('привет')).toBe(3)
})

test('test_c9_checkPrefixBudget_fails_only_when_estimate_exceeds_max', async () => {
  const checkPrefixBudget = await loadExport('checkPrefixBudget')
  expect(checkPrefixBudget('abcde', 1)).toEqual({ ok: false, tokens: 2, maxTokens: 1 })
  expect(checkPrefixBudget('abcd', 1)).toEqual({ ok: true, tokens: 1, maxTokens: 1 })
  expect(checkPrefixBudget('abcd')).toEqual({ ok: true, tokens: 1, maxTokens: 5000 })
})

test('test_c10_real_charter_and_identity_prefix_fits_5000_token_budget', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const checkPrefixBudget = await loadExport('checkPrefixBudget')
  const charter = readFileSync(new URL('../../CHARTER.md', import.meta.url), 'utf8')
  const identity = readFileSync(new URL('../../persona/identity.seed.md', import.meta.url), 'utf8')
  const prefix = buildPrefix({ charter, identity, rules: '', skills: [] })
  const result = checkPrefixBudget(prefix)
  expect(result.ok).toBe(true)
  expect(result.tokens).toBeLessThanOrEqual(5000)
})

// --- [character] -----------------------------------------------------------------------------------------

test('test_c11_loadCharacter_reads_the_committed_character_verbatim', async () => {
  const loadCharacter = await loadExport('loadCharacter')
  const expected = readFileSync(new URL('../../persona/character.md', import.meta.url), 'utf8')
  const personaDir = fileURLToPath(new URL('../../persona', import.meta.url))
  expect(loadCharacter(personaDir)).toBe(expected)
})

test('test_c12_character_section_sits_between_identity_and_rules_and_is_owner_only', async () => {
  const buildPrefix = await loadExport('buildPrefix')
  const owner = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', character: 'CHARACTER_MARK', rules: 'RULES_MARK', skills: [] })
  const positions = ['CHARTER_MARK', 'IDENTITY_MARK', 'CHARACTER_MARK', 'RULES_MARK'].map((m) => owner.indexOf(m))
  expect(Math.min(...positions), 'the character section must be present').toBeGreaterThanOrEqual(0)
  expect(positions).toEqual([...positions].sort((a, b) => a - b))

  // The guest prefix is built from guest-only text: no character argument, no character bytes.
  const guest = buildPrefix({ charter: 'CHARTER_MARK', identity: 'IDENTITY_MARK', rules: 'RULES_MARK', skills: [] })
  expect(guest).not.toContain('CHARACTER_MARK')
  expect(guest).not.toContain('# Характер')
})
