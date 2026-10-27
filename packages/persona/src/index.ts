// Stable prompt assembly for the DeepSeek prefix cache.
//
// buildPrefix() renders the part of the system prompt that must stay byte-identical
// between turns: charter, identity, character, working rules and the skills index.
// buildTail() renders everything volatile (time, memory snapshots, active tasks) as a
// single <context> block appended at the end. Nothing in the prefix may depend on the
// clock, random values or input ordering (skills are always sorted by name).

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Skill {
  name: string
  description: string
}

export interface Task {
  id: string
  status: string
  title: string
}

export interface PrefixInput {
  charter: string
  identity: string
  /** Owner-only character: DSHBOT_HOME/persona/character.md or the repository fallback; guests never receive it. */
  character?: string
  rules: string
  skills: Skill[]
}

export interface TailInput {
  now: string
  memory: string
  user: string
  tasks: Task[]
}

export interface BudgetResult {
  ok: boolean
  tokens: number
  maxTokens: number
}

/** Longest skill description kept in the index, in characters. */
export const SKILL_DESCRIPTION_LIMIT = 60

/**
 * Generic stable-prefix budget. The owner's full prefix has its own, larger
 * limit (`OWNER_PREFIX_BUDGET`, docs/DESIGN.md §4 and §9); this default stays
 * for callers that build a shorter prefix without the character.
 */
export const DEFAULT_PREFIX_BUDGET = 5000

/**
 * Budget of the owner's whole stable prefix, character included (docs/DESIGN.md
 * §4 and §9). The generic default stays 5000 so unrelated callers keep the old
 * limit; the owner path names its own number explicitly.
 */
export const OWNER_PREFIX_BUDGET = 6500

/** Name of the working-rules file inside the persona directory. */
export const RULES_FILE = 'rules.md'

/** Name of the owner's character file inside the persona directory. */
export const CHARACTER_FILE = 'character.md'

/**
 * Absolute path of the working rules. They live in the repository, in
 * `persona/rules.md` (docs/DESIGN.md §6.1), so the owner can review them in git
 * and the evolve gate can change them like code.
 */
export function rulesPath(personaDir: string): string {
  return join(personaDir, RULES_FILE)
}

/**
 * Read the working rules exactly as committed. The stable prefix carries these
 * bytes on every turn; trimming is the prefix builder's job, not the loader's,
 * so the caller cannot accidentally introduce rule-dependent whitespace.
 */
export function loadRules(personaDir: string): string {
  return readFileSync(rulesPath(personaDir), 'utf8')
}

/**
 * Absolute path of the neutral repository character. Like the rules it lives
 * in the repository (`persona/character.md`, docs/DESIGN.md §6.1), so the owner
 * can review it in git and the evolve gate can change it like code. The file
 * is owner-only: `buildPrefix` carries it only when the caller passes it, and
 * the guest prefix never does. The owner's own non-empty
 * `DSHBOT_HOME/persona/character.md` is read by `loadOwnerCharacter` and wins.
 */
export function characterPath(personaDir: string): string {
  return join(personaDir, CHARACTER_FILE)
}

/** Read the character exactly as committed; trimming stays the builder's job. */
export function loadCharacter(personaDir: string): string {
  return readFileSync(characterPath(personaDir), 'utf8')
}

/** Subdirectory of DSHBOT_HOME that holds the owner's own persona files. */
export const HOME_PERSONA_DIR = 'persona'

/**
 * Read the character the owner's prefix carries. A non-empty
 * `DSHBOT_HOME/persona/character.md` wins over the neutral repository file;
 * an absent or blank file falls back to `persona/character.md`. The result is
 * owner-only: the guest prefix is built from guest-only text and never calls
 * this loader.
 */
export function loadOwnerCharacter(personaDir: string, homeDir: string): string {
  const ownPath = characterPath(join(homeDir, HOME_PERSONA_DIR))
  if (existsSync(ownPath) && statSync(ownPath).isFile()) {
    const own = readFileSync(ownPath, 'utf8')
    if (own.trim() !== '') return own
  }
  return loadCharacter(personaDir)
}

// Explicitly marked so the model does not mistake reference data for a new owner
// message. The trailing "context_не_owner" marker keeps the block machine-identifiable.
const TAIL_MARKER =
  'Справочный контекст: это не новое сообщение владельца, а данные для работы (context_не_owner).'

function normalize(text: string): string {
  return text.trim()
}

/**
 * Truncate by Unicode code points, never splitting a surrogate pair. The limit is
 * counted in characters, matching the skills index rule in docs/DESIGN.md.
 */
function truncateDescription(description: string): string {
  return Array.from(description.trim()).slice(0, SKILL_DESCRIPTION_LIMIT).join('')
}

function compareSkills(a: Skill, b: Skill): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  if (a.description !== b.description) return a.description < b.description ? -1 : 1
  return 0
}

function pushSection(parts: string[], heading: string, body: string): void {
  const text = normalize(body)
  if (text === '') return
  parts.push(`# ${heading}\n\n${text}`)
}

function renderSkillsIndex(skills: Skill[]): string {
  const sorted = skills
    .map((skill) => ({ name: skill.name.trim(), description: skill.description.trim() }))
    .sort(compareSkills)
  const lines = sorted.map((skill) => {
    const description = truncateDescription(skill.description)
    return description === '' ? `- ${skill.name}` : `- ${skill.name} — ${description}`
  })
  return lines.join('\n')
}

/**
 * Assemble the byte-stable prefix. Section order is fixed: charter, identity,
 * character, rules, skills index. Equal inputs always produce an equal string;
 * reversing the skills array does not change it. Empty sections are omitted,
 * which keeps the prefix small without introducing volatility. The character is
 * optional because the guest prefix is assembled from guest-only text.
 */
export function buildPrefix(input: PrefixInput): string {
  const parts: string[] = []
  pushSection(parts, 'Устав', input.charter)
  pushSection(parts, 'Личность', input.identity)
  pushSection(parts, 'Характер', input.character ?? '')
  pushSection(parts, 'Правила работы', input.rules)
  pushSection(parts, 'Индекс навыков', renderSkillsIndex(input.skills))
  return parts.join('\n\n')
}

/** UTF-8 byte length divided by 4, rounded up. An empty string costs zero tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/** Compare the prefix estimate against the budget; ok means it fits. */
export function checkPrefixBudget(prefix: string, maxTokens: number = DEFAULT_PREFIX_BUDGET): BudgetResult {
  const tokens = estimateTokens(prefix)
  return { ok: tokens <= maxTokens, tokens, maxTokens }
}

function renderTasks(tasks: Task[]): string {
  return tasks.map((task) => `- ${task.id} · ${task.status} · ${task.title}`).join('\n')
}

/**
 * Assemble the volatile tail. The block is always delimited by <context> tags, its
 * first line states that this is reference data rather than a new owner message,
 * and empty sections (memory, user profile, tasks) are omitted entirely.
 */
export function buildTail(input: TailInput): string {
  const lines: string[] = ['<context>', TAIL_MARKER, `Время: ${input.now}`]

  const memory = normalize(input.memory)
  if (memory !== '') lines.push('', '## Память', '', memory)

  const user = normalize(input.user)
  if (user !== '') lines.push('', '## Профиль владельца', '', user)

  const tasks = renderTasks(input.tasks)
  if (tasks !== '') lines.push('', '## Активные задачи', '', tasks)

  lines.push('</context>')
  return lines.join('\n')
}
