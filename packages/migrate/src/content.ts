// Skills, memory, persona and schedules of an OpenClaw state directory.
//
// The planner (`planContent`) reads the source only, decides a status against
// the destination and keeps the writes as actions. `applyContent` executes the
// actions when `run` is applied; the source is never written.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { createScheduleRegistry } from '../../scheduler/src/index.js'
import { openStore } from '../../store/src/index.js'
import type { OpenClawSource } from './openclaw.js'
import { parseJson5 } from './json5.js'
import type { PlanItem, SecretCandidate, SecretValue } from './types.js'

export type SkillConflict = 'skip' | 'rename' | 'overwrite'

export interface ContentOptions {
  readonly home: string
  readonly dryRun: boolean
  readonly includeSecrets: boolean
  readonly overwrite: boolean
  readonly skillConflict: SkillConflict
}

export interface ContentAction {
  readonly kind: 'skill' | 'file' | 'schedule'
  items: PlanItem[]
  readonly target: string
  readonly sourceDir?: string
  readonly data?: Buffer
  readonly renameTo?: string | null
  readonly overwrite?: boolean
  readonly backup?: boolean
  readonly schedule?: ScheduleInput
  readonly skillName?: string
  /** Existing schedule row that `--overwrite` updates instead of creating another. */
  readonly existingScheduleId?: string
  /** Source job identities that map to the schedule row of this action. */
  readonly scheduleIds?: string[]
  /** Knowledge file key whose written digest is remembered for the next run. */
  readonly knowledgeKey?: string
}

/**
 * What a previous OpenClaw migration wrote, kept next to the reports so a
 * repeated run can recognize its own rows and files after the source changes.
 */
export interface ContentState {
  readonly version: 1
  /**
   * Maps and not plain objects: source identities and knowledge keys are
   * foreign data, so a job named `__proto__`, `constructor` or `toString` must
   * be an ordinary key instead of a prototype member.
   */
  readonly schedules: Map<string, { readonly id: string }>
  readonly knowledge: Map<string, { readonly digest: string }>
}

interface LoadedState {
  state: ContentState
  readonly path: string
  readonly original: ContentState
}

export interface ScheduleInput {
  readonly spec: string
  readonly task: string
  readonly tz?: string
  readonly paused?: boolean
}

export interface ManualEntry {
  readonly name: string
  readonly schedule: string
  readonly detail: string
}

export interface ContentResult {
  readonly items: PlanItem[]
  readonly secrets: SecretCandidate[]
  readonly actions: ContentAction[]
  readonly manual: ManualEntry[]
  /** Every source secret value: redaction and the apply pass use the same set. */
  readonly secretValues: string[]
  /** Identity map of the previous run; the apply pass extends and persists it. */
  readonly state: ContentState
  readonly statePath: string
  readonly stateOriginal: ContentState
}

const REDACTED = '[скрыто]'
const SKILLS_DIR = 'skills'
const META_FILE = '.meta.json'
const STATE_FILE = 'openclaw-state.json'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function item(kind: string, name: string, source: string, target: string, status: PlanItem['status'], reason?: string): PlanItem {
  return { kind, name, source, target, status, ...(reason === undefined ? {} : { reason }) }
}

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function emptyState(): ContentState {
  return { version: 1, schedules: new Map(), knowledge: new Map() }
}

/** Load the identity map of the previous run; a broken file only loses recognition. */
function loadState(home: string): LoadedState {
  const path = join(home, 'migration', STATE_FILE)
  const text = readOptionalText(path)
  const state = emptyState()
  let original = emptyState()
  if (text !== undefined) {
    try {
      const parsed = asRecord(JSON.parse(text))
      if (parsed !== undefined) {
        for (const [key, value] of Object.entries(asRecord(parsed.schedules) ?? {})) {
          const id = asString(asRecord(value)?.id)
          if (id !== undefined && id !== '') state.schedules.set(key, { id })
        }
        for (const [key, value] of Object.entries(asRecord(parsed.knowledge) ?? {})) {
          const hash = asString(asRecord(value)?.digest)
          if (hash !== undefined && hash !== '') state.knowledge.set(key, { digest: hash })
        }
      }
    } catch {
      // An unreadable map means no recognition, not a failed migration.
    }
    // A snapshot, not the live map: the planner and the apply pass extend the
    // live map, and persistState compares it with what was on disk.
    original = structuredClone(state)
  }
  return { state, path, original }
}

/**
 * Deterministic serialization, so an unchanged repeated run never rewrites the
 * map. A prototype-free temporary object keeps keys such as `__proto__` as
 * ordinary own properties in the JSON as well.
 */
function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const result: Record<string, T> = Object.create(null)
  for (const [key, value] of [...entries].sort(([left], [right]) => left.localeCompare(right))) result[key] = value
  return result
}

function stateText(state: ContentState): string {
  return JSON.stringify({
    version: 1,
    schedules: sortedRecord(state.schedules),
    knowledge: sortedRecord(state.knowledge),
  }, null, 2) + '\n'
}

function rememberKnowledge(state: ContentState, key: string, data: Buffer | string): void {
  state.knowledge.set(key, { digest: digest(data) })
}

function persistState(result: ContentResult): void {
  if (stateText(result.state) === stateText(result.stateOriginal)) return
  if (result.state.schedules.size === 0 && result.state.knowledge.size === 0) return
  mkdirSync(dirname(result.statePath), { recursive: true, mode: 0o700 })
  writeFileSync(result.statePath, stateText(result.state), { mode: 0o600 })
}

/** Every file under `dir`, relative and sorted; hidden entries stay in the source. */
function treeFiles(dir: string): string[] {
  if (!isDirectory(dir)) return []
  const result: string[] = []
  const walk = (current: string): void => {
    let names: string[]
    try {
      names = readdirSync(current).sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(current, name)
      if (isDirectory(path)) walk(path)
      else if (isFile(path)) result.push(relative(dir, path))
    }
  }
  walk(dir)
  return result
}

function replaceSecrets(data: Buffer, secrets: readonly string[]): { data: Buffer; changed: boolean } {
  if (secrets.length === 0) return { data, changed: false }
  const text = data.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(data)) return { data, changed: false }
  let next = text
  for (const value of secrets) {
    if (value === '') continue
    next = next.split(value).join(REDACTED)
  }
  return { data: Buffer.from(next, 'utf8'), changed: next !== text }
}

interface SkillSource {
  readonly name: string
  readonly dir: string
  readonly root: string
}

function workspaceOf(config: Record<string, unknown>, stateDir: string): string {
  const agents = asRecord(config.agents)
  const main = asString(asRecord(agents?.entries)?.main && asRecord(asRecord(agents?.entries)?.main)?.workspace)
  const entries = asRecord(agents?.entries)
  const mainWorkspace = asString(asRecord(entries?.main)?.workspace)
  if (mainWorkspace !== undefined && mainWorkspace.trim() !== '') return mainWorkspace
  const defaults = asString(asRecord(agents?.defaults)?.workspace)
  if (defaults !== undefined && defaults.trim() !== '') return defaults
  void main
  return join(stateDir, 'workspace')
}

function frontmatter(content: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  return match?.[1] ?? ''
}

/** The `os` list of `metadata.openclaw`; an absent list means every platform. */
function skillOs(content: string): string[] | undefined {
  const lines = frontmatter(content).split(/\r?\n/)
  let inOpenclaw = false
  for (const line of lines) {
    const indent = /^\s*/.exec(line)?.[0].length ?? 0
    if (/^\s*openclaw:\s*$/.test(line)) {
      inOpenclaw = true
      continue
    }
    if (inOpenclaw && indent <= 2 && /^\s*[A-Za-z]/.test(line)) inOpenclaw = false
    if (!inOpenclaw) continue
    const flow = /^\s*os:\s*\[(.*)\]\s*$/.exec(line)
    if (flow !== null) {
      return (flow[1] ?? '').split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter((entry) => entry !== '')
    }
    if (/^\s*os:\s*$/.test(line)) {
      const index = lines.indexOf(line)
      const values: string[] = []
      for (const next of lines.slice(index + 1)) {
        const trimmed = next.trim()
        if (!trimmed.startsWith('-')) break
        values.push(trimmed.slice(1).trim().replace(/^['"]|['"]$/g, ''))
      }
      return values
    }
  }
  return undefined
}

function skillPrimaryEnv(content: string): string | undefined {
  const lines = frontmatter(content).split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*primaryEnv:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

function skillRoots(config: Record<string, unknown>, source: OpenClawSource): string[] {
  const workspace = workspaceOf(config, source.dir)
  return [
    join(workspace, 'skills'),
    join(workspace, '.agents', 'skills'),
    join(dirname(source.dir), '.agents', 'skills'),
    join(source.dir, 'skills'),
    join(source.dir, 'agents', 'main', 'agent', 'workshop-skills'),
  ]
}

function collectSkillSources(roots: readonly string[]): { skills: SkillSource[]; seen: Set<string> } {
  const skills: SkillSource[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (!isDirectory(root)) continue
    let names: string[]
    try {
      names = readdirSync(root).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const dir = join(root, name)
      if (!isDirectory(dir) || !isFile(join(dir, 'SKILL.md'))) continue
      if (seen.has(name)) continue
      seen.add(name)
      skills.push({ name, dir, root })
    }
  }
  return { skills, seen }
}

function readMeta(dir: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(join(dir, META_FILE), 'utf8'))) ?? {}
  } catch {
    return {}
  }
}

function builtinDir(): string {
  return fileURLToPath(new URL('../../learn/builtin-skills', import.meta.url))
}

function isBuiltinSkill(home: string, name: string): boolean {
  if (readMeta(join(home, SKILLS_DIR, name)).builtin === true) return true
  return isFile(join(builtinDir(), name, 'SKILL.md'))
}

function renameDocument(content: string, name: string): string {
  return content.replace(/^name:.*$/m, `name: ${name}`)
}

function redactedSkill(source: SkillSource, secrets: readonly string[], renameTo: string | null): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const path of treeFiles(source.dir)) {
    if (basename(path) === META_FILE) continue
    const data = replaceSecrets(readFileSync(join(source.dir, path)), secrets).data
    if (path === 'SKILL.md' && renameTo !== null) {
      files.set(path, Buffer.from(renameDocument(data.toString('utf8'), renameTo), 'utf8'))
    } else {
      files.set(path, data)
    }
  }
  if (!files.has('SKILL.md')) files.set('SKILL.md', Buffer.from(''))
  const now = Date.now()
  files.set(META_FILE, Buffer.from(JSON.stringify({ createdAt: now, lastUsedAt: now, imported: true }, null, 2) + '\n', 'utf8'))
  return files
}

function treeMatches(dir: string, files: ReadonlyMap<string, Buffer>): boolean {
  if (!isDirectory(dir)) return false
  // `.meta.json` carries the import time, so only the content files decide
  // whether an existing directory is the copy of this source.
  const expected = [...files].filter(([path]) => path !== META_FILE)
  const present = treeFiles(dir).filter((path) => path !== META_FILE)
  if (present.length !== expected.length) return false
  for (const [path, data] of expected) {
    if (!present.includes(path)) return false
    try {
      if (!readFileSync(join(dir, path)).equals(data)) return false
    } catch {
      return false
    }
  }
  return true
}

function freeRename(base: string, taken: (name: string) => boolean): string | undefined {
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = index === 1 ? `${base}-openclaw` : `${base}-openclaw-${index}`
    if (!taken(candidate)) return candidate
  }
  return undefined
}

interface SkillPlan {
  readonly items: PlanItem[]
  readonly actions: ContentAction[]
  readonly warnings: PlanItem[]
  /** Absolute source SKILL.md path → path in DSHBOT_HOME, including a rename. */
  readonly paths: Map<string, string>
}

function realDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Replace every whole source path in one pass, longest first, so a replaced
 * path is never matched again and `/skills/foo` leaves `/skills/foobar` alone.
 */
function rewriteSkillPaths(text: string, paths: ReadonlyMap<string, string>): string {
  if (paths.size === 0) return text
  const alternatives = [...paths.keys()]
    .sort((left, right) => right.length - left.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(?<![\\w.~-])(?:${alternatives.join('|')})(?![\\w-]|\\.[\\w-])`, 'g')
  return text.replace(pattern, (path) => paths.get(path) ?? path)
}

function planSkills(
  options: ContentOptions,
  source: OpenClawSource,
  config: Record<string, unknown>,
  secretValues: readonly string[],
): SkillPlan {
  const items: PlanItem[] = []
  const actions: ContentAction[] = []
  const warnings: PlanItem[] = []
  const paths = new Map<string, string>()
  const { skills } = collectSkillSources(skillRoots(config, source))
  const reserved = new Set<string>()
  const taken = (name: string): boolean => reserved.has(name) || existsSync(join(options.home, SKILLS_DIR, name))
  const skillsRoot = join(options.home, SKILLS_DIR)
  const existingDirs = isDirectory(skillsRoot) ? readdirSync(skillsRoot).filter((name) => !name.startsWith('.') && isDirectory(join(skillsRoot, name))) : []
  const mapSkill = (skill: SkillSource, targetName: string): void => {
    const targetDir = join(skillsRoot, targetName)
    // A job may name the skill through the real directory when `--from` is a
    // symlink (or the other way round), so both spellings are rewritten.
    for (const dir of new Set([skill.dir, realDir(skill.dir)])) {
      paths.set(join(dir, 'SKILL.md'), join(targetDir, 'SKILL.md'))
      paths.set(dir, targetDir)
    }
  }

  for (const skill of skills) {
    const sourceLabel = relative(source.dir, join(skill.dir, 'SKILL.md')) || join(skill.dir, 'SKILL.md')
    const content = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
    const os = skillOs(content)
    if (os !== undefined && os.length > 0 && !os.includes('linux')) {
      items.push(item('skill', skill.name, sourceLabel, `skills/${skill.name}`, 'skipped', `платформа ${os.join(', ')} не поддерживается: нужен linux`))
      continue
    }

    // A previous run may have renamed the skill; every suffix of this source
    // name is a candidate target and an identical tree means it is ours.
    const candidates = [skill.name, ...existingDirs.filter((name) => name.startsWith(`${skill.name}-openclaw`))]
    let already: string | undefined
    for (const candidate of candidates) {
      if (candidate !== skill.name && !taken(candidate)) continue
      const target = join(skillsRoot, candidate)
      if (treeMatches(target, redactedSkill(skill, secretValues, candidate === skill.name ? null : candidate))) {
        already = candidate
        break
      }
    }
    if (already !== undefined) {
      reserved.add(already)
      mapSkill(skill, already)
      const target = `skills/${already}`
      items.push(item('skill', skill.name, sourceLabel, target, 'skipped', 'уже есть'))
      for (const [path, data] of redactedSkill(skill, secretValues, already === skill.name ? null : already)) {
        const changed = replaceSecrets(data, secretValues).changed
        if (changed) warnings.push(item('skill', `${skill.name}/${path}`, sourceLabel, target, 'warning', 'значение секрета заменено на [скрыто]'))
      }
      continue
    }

    const exists = existsSync(join(skillsRoot, skill.name))
    if (exists && isBuiltinSkill(options.home, skill.name)) {
      items.push(item('skill', skill.name, sourceLabel, `skills/${skill.name}`, 'conflict', 'встроенный навык не заменяется'))
      continue
    }

    let renamed = false
    let targetName = skill.name
    if (exists || reserved.has(skill.name)) {
      if (options.skillConflict === 'overwrite' && exists && !reserved.has(skill.name)) {
        targetName = skill.name
      } else if (options.skillConflict === 'rename') {
        const free = freeRename(skill.name, taken)
        if (free === undefined) {
          items.push(item('skill', skill.name, sourceLabel, `skills/${skill.name}`, 'conflict', 'не удалось подобрать свободное имя'))
          continue
        }
        targetName = free
        renamed = true
      } else {
        const reason = reserved.has(skill.name) ? 'имя уже занято в этом прогоне' : 'навык с таким именем уже есть'
        items.push(item('skill', skill.name, sourceLabel, `skills/${skill.name}`, 'conflict', reason))
        continue
      }
    }

    reserved.add(targetName)
    mapSkill(skill, targetName)
    const target = `skills/${targetName}`
    for (const path of treeFiles(skill.dir)) {
      const raw = readFileSync(join(skill.dir, path))
      if (replaceSecrets(raw, secretValues).changed) {
        warnings.push(item('skill', `${skill.name}/${path}`, sourceLabel, target, 'warning', 'значение секрета заменено на [скрыто]'))
      }
    }
    const conflict = exists && options.skillConflict === 'overwrite'
    const planItem = item('skill', skill.name, sourceLabel, target, 'new', conflict ? 'заменяет существующий навык (--skill-conflict overwrite)' : undefined)
    items.push(planItem)
    actions.push({
      kind: 'skill',
      items: [planItem],
      target: join(skillsRoot, targetName),
      sourceDir: skill.dir,
      renameTo: renamed ? targetName : null,
      overwrite: conflict,
      backup: conflict,
      skillName: skill.name,
    })
  }

  items.push(...warnings)
  return { items, actions, warnings, paths }
}

function skillSecretCandidates(
  options: ContentOptions,
  source: OpenClawSource,
  config: Record<string, unknown>,
  skills: readonly SkillSource[],
): SecretCandidate[] {
  const entries = asRecord(asRecord(config.skills)?.entries)
  if (entries === undefined) return []
  const result: SecretCandidate[] = []
  const primary = new Map<string, string | undefined>()
  for (const skill of skills) {
    try {
      primary.set(skill.name, skillPrimaryEnv(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')))
    } catch {
      primary.set(skill.name, undefined)
    }
  }
  for (const [key, raw] of Object.entries(entries)) {
    const entry = asRecord(raw)
    if (entry === undefined) continue
    const env = asRecord(entry.env)
    if (env !== undefined) {
      for (const [name, value] of Object.entries(env)) {
        if (typeof value === 'string' && value !== '') {
          result.push({ name, value, sources: [`${source.configName}:skills.entries.${key}.env.${name}`], fields: [`skills.entries.${key}.env.${name}`] })
        }
      }
    }
    const apiKey = asString(entry.apiKey)
    if (apiKey !== undefined && apiKey !== '') {
      const name = primary.get(key)
      if (name !== undefined && name !== '') {
        result.push({ name, value: apiKey, sources: [`${source.configName}:skills.entries.${key}.apiKey`], fields: [`skills.entries.${key}.apiKey`] })
      }
    }
  }
  return result
}

function appendParagraphs(existing: string, incoming: string): string {
  const current = new Map<string, string>()
  for (const paragraph of existing.split(/\r?\n\s*\r?\n/)) {
    const key = paragraph.trim()
    if (key !== '') current.set(key, paragraph)
  }
  const missing: string[] = []
  for (const paragraph of incoming.split(/\r?\n\s*\r?\n/)) {
    const key = paragraph.trim()
    if (key === '' || current.has(key)) continue
    current.set(key, paragraph)
    missing.push(key)
  }
  if (missing.length === 0) return existing
  const separator = existing === '' ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${missing.join('\n\n')}\n`
}

function personaSeed(): string {
  try {
    return readFileSync(fileURLToPath(new URL('../../../persona/identity.seed.md', import.meta.url)), 'utf8')
  } catch {
    return ''
  }
}

interface MemoryPlan {
  readonly items: PlanItem[]
  readonly actions: ContentAction[]
}

function planMemory(
  options: ContentOptions,
  source: OpenClawSource,
  workspace: string,
  secrets: readonly string[],
  state: ContentState,
): MemoryPlan {
  const items: PlanItem[] = []
  const actions: ContentAction[] = []
  const memoryDir = join(options.home, 'memory')

  const addFile = (
    from: string,
    to: string,
    label: string,
    append: boolean,
    knowledgeKey?: string,
  ): void => {
    let raw: Buffer
    try {
      raw = readFileSync(from)
    } catch {
      return
    }
    const redacted = replaceSecrets(raw, secrets)
    const sourceLabel = relative(source.dir, from)
    const target = relative(options.home, to)
    if (redacted.changed) {
      items.push(item('memory', label, sourceLabel, target, 'warning', `значение секрета заменено на [скрыто] в ${basename(from)}`))
    }
    const existing = existsSync(to) ? readFileSync(to, 'utf8') : undefined
    let next = redacted.data.toString('utf8')
    if (append && existing !== undefined) next = appendParagraphs(existing, next)
    if (existing !== undefined && existing === next) {
      // The destination already has exactly the incoming bytes; remember them
      // so a later source edit is still recognized as an unedited import.
      if (knowledgeKey !== undefined) rememberKnowledge(state, knowledgeKey, next)
      items.push(item('memory', label, sourceLabel, target, 'skipped', 'уже есть'))
      return
    }
    if (knowledgeKey !== undefined && existing !== undefined) {
      // The knowledge file exists with different text. It is safe to update only
      // when its bytes are exactly what the previous migration wrote; anything
      // else is an owner edit and is preserved as a conflict.
      const previous = state.knowledge.get(knowledgeKey)?.digest
      const ownerChanged = previous === undefined || digest(existing) !== previous
      if (ownerChanged && !options.overwrite) {
        items.push(item('memory', label, sourceLabel, target, 'conflict', 'файл знаний изменён владельцем в DSHBOT; без --overwrite он не заменяется'))
        return
      }
      const planItem = item('memory', label, sourceLabel, target, 'new', ownerChanged ? 'заменяет изменённый владельцем файл знаний (--overwrite)' : undefined)
      items.push(planItem)
      actions.push({ kind: 'file', items: [planItem], target: to, data: Buffer.from(next, 'utf8'), backup: true, knowledgeKey })
      return
    }
    if (existing !== undefined && !append && !options.overwrite) {
      items.push(item('memory', label, sourceLabel, target, 'conflict', 'файл уже есть'))
      return
    }
    const planItem = item('memory', label, sourceLabel, target, 'new')
    items.push(planItem)
    actions.push({
      kind: 'file',
      items: [planItem],
      target: to,
      data: Buffer.from(next, 'utf8'),
      backup: existing !== undefined,
      ...(knowledgeKey === undefined ? {} : { knowledgeKey }),
    })
  }

  addFile(join(workspace, 'MEMORY.md'), join(memoryDir, 'MEMORY.md'), 'MEMORY.md', true)
  addFile(join(workspace, 'USER.md'), join(memoryDir, 'USER.md'), 'USER.md', true)

  const journalDir = join(workspace, 'memory')
  if (isDirectory(journalDir)) {
    for (const name of readdirSync(journalDir).sort()) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      const from = join(journalDir, name)
      const to = join(memoryDir, 'journal', name)
      const rawJournal = readFileSync(from)
      const redactedJournal = replaceSecrets(rawJournal, secrets)
      if (redactedJournal.changed) {
        items.push(item('memory', name, relative(source.dir, from), relative(options.home, to), 'warning', `значение секрета заменено на [скрыто] в ${name}`))
      }
      const text = redactedJournal.data.toString('utf8')
      const existing = existsSync(to) ? readFileSync(to, 'utf8') : undefined
      const target = relative(options.home, to)
      let next = text
      if (existing !== undefined) {
        if (existing.includes(text.trim())) {
          items.push(item('memory', name, relative(source.dir, from), target, 'skipped', 'уже есть'))
          continue
        }
        const separator = existing.endsWith('\n') ? '\n' : '\n\n'
        next = `${existing}${separator}## Из OpenClaw\n\n${text.trim()}\n`
      }
      const planItem = item('memory', name, relative(source.dir, from), target, 'new')
      items.push(planItem)
      actions.push({ kind: 'file', items: [planItem], target: to, data: Buffer.from(next, 'utf8'), backup: existing !== undefined })
    }
  }

  const soul = readOptional(workspace, 'SOUL.md')
  const identity = readOptional(workspace, 'IDENTITY.md')
  const persona = [soul, identity].filter((value): value is string => value !== undefined && value.trim() !== '')
    .map((value) => replaceSecrets(Buffer.from(value), secrets).data.toString('utf8').trim()).join('\n\n')
  if (persona !== '') {
    const identityPath = join(memoryDir, 'identity.md')
    const current = existsSync(identityPath) ? readFileSync(identityPath, 'utf8') : undefined
    const seed = personaSeed()
    const own = current !== undefined && current !== seed
    if (!own || options.overwrite) {
      const planItem = item('persona', 'IDENTITY.md', 'SOUL.md, IDENTITY.md', relative(options.home, identityPath), 'new', own ? 'заменяет личность владельца (--overwrite)' : undefined)
      items.push(planItem)
      actions.push({ kind: 'file', items: [planItem], target: identityPath, data: Buffer.from(`${persona}\n`, 'utf8'), backup: current !== undefined })
    } else {
      const fallback = join(memoryDir, 'knowledge', 'openclaw-persona.md')
      const planItem = item('persona', 'SOUL.md, IDENTITY.md', 'SOUL.md, IDENTITY.md', relative(options.home, fallback), 'conflict', 'в memory/identity.md уже своя личность: текст сохранён отдельным файлом')
      items.push(planItem)
      actions.push({ kind: 'file', items: [planItem], target: fallback, data: Buffer.from(`${persona}\n`, 'utf8') })
    }
  }

  for (const name of ['AGENTS', 'TOOLS', 'HEARTBEAT', 'BOOTSTRAP']) {
    const file = `openclaw-${name.toLowerCase()}.md`
    addFile(join(workspace, `${name}.md`), join(memoryDir, 'knowledge', file), `${name}.md`, false, file)
  }

  return { items, actions }
}

function readOptional(dir: string, name: string): string | undefined {
  try {
    return readFileSync(join(dir, name), 'utf8')
  } catch {
    return undefined
  }
}

interface SourceJob {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly agentId: string
  readonly schedule: Record<string, unknown>
  readonly payload: Record<string, unknown>
}

function readJobs(source: OpenClawSource): { jobs: SourceJob[]; label: string } {
  const sqlite = join(source.dir, 'state', 'openclaw.sqlite')
  if (isFile(sqlite)) {
    try {
      const db = new DatabaseSync(sqlite, { readOnly: true })
      try {
        const rows = db.prepare('SELECT job_json, job_id, name, enabled, agent_id, payload_kind FROM cron_jobs').all() as Record<string, unknown>[]
        const jobs: SourceJob[] = []
        for (const row of rows) {
          const parsed = asRecord(JSON.parse(String(row.job_json ?? '{}'))) ?? {}
          const name = asString(parsed.name) ?? asString(row.name) ?? asString(row.job_id) ?? 'задача'
          const key = [asString(parsed.id), asString(row.job_id)].find((value) => value !== undefined && value !== '')
          jobs.push({
            // The stable identity is the source key (job_id or the JSON id),
            // never the text or the schedule: both may change between runs.
            id: key ?? name,
            name,
            enabled: row.enabled === undefined ? parsed.enabled !== false : Number(row.enabled) !== 0,
            agentId: asString(parsed.agentId) ?? asString(row.agent_id) ?? 'main',
            schedule: asRecord(parsed.schedule) ?? {},
            payload: asRecord(parsed.payload) ?? { kind: asString(row.payload_kind) ?? 'agentTurn' },
          })
        }
        return { jobs, label: 'state/openclaw.sqlite' }
      } finally {
        db.close()
      }
    } catch {
      // Fall through to the old JSON file.
    }
  }
  const jsonFile = join(source.dir, 'cron', 'jobs.json')
  if (isFile(jsonFile)) {
    try {
      const doc = asRecord(JSON.parse(readFileSync(jsonFile, 'utf8'))) ?? {}
      const list = Array.isArray(doc.jobs) ? doc.jobs : []
      const jobs: SourceJob[] = []
      for (const raw of list) {
        const entry = asRecord(raw)
        if (entry === undefined) continue
        const name = asString(entry.name) ?? asString(entry.id) ?? 'задача'
        const key = asString(entry.id)
        jobs.push({
          // jobs.json without an `id` uses its name as the source identity.
          id: key !== undefined && key !== '' ? key : name,
          name,
          enabled: entry.enabled !== false,
          agentId: asString(entry.agentId) ?? 'main',
          schedule: asRecord(entry.schedule) ?? {},
          payload: asRecord(entry.payload) ?? {},
        })
      }
      return { jobs, label: 'cron/jobs.json' }
    } catch {
      return { jobs: [], label: 'cron/jobs.json' }
    }
  }
  return { jobs: [], label: 'cron/jobs.json' }
}

function intervalSpec(everyMs: number): { spec: string; warning?: string } {
  const minutes = Math.ceil(everyMs / 60_000)
  const warning = minutes * 60_000 === everyMs ? undefined : 'интервал округлён вверх до целой минуты'
  if (minutes % 1440 === 0) return { spec: `every ${minutes / 1440}d`, ...(warning === undefined ? {} : { warning }) }
  if (minutes % 60 === 0) return { spec: `every ${minutes / 60}h`, ...(warning === undefined ? {} : { warning }) }
  return { spec: `every ${minutes}m`, ...(warning === undefined ? {} : { warning }) }
}

function scheduleLabel(schedule: Record<string, unknown>): string {
  const kind = asString(schedule.kind)
  if (kind === 'cron') return `cron ${asString(schedule.expr) ?? '?'} (${asString(schedule.tz) ?? 'UTC'})`
  if (kind === 'every') return `every ${String(schedule.everyMs ?? '?')} ms`
  if (kind === 'at') return `at ${asString(schedule.at) ?? '?'}`
  return kind ?? 'unknown'
}

interface SchedulePlan {
  readonly items: PlanItem[]
  readonly actions: ContentAction[]
  readonly manual: ManualEntry[]
}

interface ExistingSchedule {
  readonly id: string
  readonly spec: string
  readonly task: string
}

/**
 * Read the schedules from a temporary copy: opening a WAL database read-only
 * still creates or touches its sidecars, and a repeated unchanged migration
 * must leave DSHBOT_HOME byte for byte unchanged.
 */
function existingSchedules(home: string): ExistingSchedule[] {
  const path = join(home, 'state.db')
  if (!isFile(path)) return []
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'dshbot-migrate-content-'))
    const copy = join(dir, basename(path))
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (isFile(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, spec, task FROM schedules').all() as Record<string, unknown>[]
      return rows.map((row) => ({ id: String(row.id ?? ''), spec: String(row.spec ?? ''), task: String(row.task ?? '') }))
    } finally {
      db.close()
    }
  } catch {
    return []
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

type JobInput =
  | { readonly input: ScheduleInput; readonly warning?: string }
  | { readonly review: string }
  | { readonly internal: string }
  | { readonly past: true }

/** Jobs whose whole text is an OpenClaw-internal marker, e.g. `__openclaw_...__`. */
const INTERNAL_JOB = /^__openclaw_\S+__$/

/** Convert one source job into a DSHBOT schedule, or say why it is not migrated. */
function jobInput(job: SourceJob, rewritePath: (text: string) => string): JobInput {
  const kind = asString(job.payload.kind) ?? 'agentTurn'
  if (job.agentId !== 'main') return { review: 'задача другого агента: решите вручную' }
  if (kind !== 'agentTurn' && kind !== 'systemEvent') return { review: `payload ${kind} не переносится автоматически` }
  const rawText = kind === 'agentTurn' ? asString(job.payload.message) : asString(job.payload.text)
  if (rawText === undefined || rawText.trim() === '') return { review: 'пустой текст задачи' }
  // OpenClaw schedules its own maintenance with marker-only text. Migrating such
  // a job would send the marker to the model every night, so it is not a task.
  if (INTERNAL_JOB.test(rawText.trim())) {
    return { internal: 'служебное задание OpenClaw (внутренняя задача, не текст для модели)' }
  }
  const text = rewritePath(rawText)
  const scheduleKind = asString(job.schedule.kind)
  if (scheduleKind === 'cron') {
    const expr = asString(job.schedule.expr)
    if (expr === undefined) return { review: 'расписание cron без выражения' }
    // The scheduler stores `spec` trimmed; compare and persist the same form so
    // an unchanged source with edge spaces is recognized on a repeated run.
    return { input: { spec: expr.trim(), task: text, tz: asString(job.schedule.tz) ?? 'UTC', paused: job.enabled === false } }
  }
  if (scheduleKind === 'every') {
    const everyMs = Number(job.schedule.everyMs)
    if (!Number.isFinite(everyMs) || everyMs <= 0) return { review: 'интервал every без everyMs' }
    const converted = intervalSpec(everyMs)
    const input = { spec: converted.spec, task: text, paused: job.enabled === false }
    return converted.warning === undefined ? { input } : { input, warning: converted.warning }
  }
  if (scheduleKind === 'at') {
    const at = asString(job.schedule.at)
    const when = at === undefined ? Number.NaN : Date.parse(at)
    if (!Number.isFinite(when)) return { review: 'расписание at без даты' }
    if (when <= Date.now()) return { past: true }
    return { input: { spec: new Date(when).toISOString(), task: text, tz: 'UTC', paused: job.enabled === false } }
  }
  return { review: 'неизвестный вид расписания' }
}

function planSchedules(
  options: ContentOptions,
  source: OpenClawSource,
  state: ContentState,
  skillPaths: ReadonlyMap<string, string>,
): SchedulePlan {
  const items: PlanItem[] = []
  const actions: ContentAction[] = []
  const manual: ManualEntry[] = []
  const { jobs, label } = readJobs(source)
  if (jobs.length === 0) return { items, actions, manual }
  const existing = existingSchedules(options.home)
  const rewritePath = (text: string): string => rewriteSkillPaths(text, skillPaths)
  const converted = jobs.map((job) => ({ job, result: jobInput(job, rewritePath) }))
  const savedRow = (job: SourceJob): ExistingSchedule | undefined => {
    const mapped = state.schedules.get(job.id)
    return mapped === undefined ? undefined : existing.find((entry) => entry.id === mapped.id)
  }

  // Every source job owns its own row by the saved source identity. Rows owned
  // by a current job are never adopted by another one, and rows that this run
  // updates with --overwrite are not shared with an unchanged identical job.
  const owned = new Set<string>()
  const updated = new Set<string>()
  for (const { job, result } of converted) {
    if (!('input' in result)) continue
    const row = savedRow(job)
    if (row === undefined || owned.has(row.id)) continue
    owned.add(row.id)
    if (options.overwrite && (row.task !== result.input.task || row.spec !== result.input.spec)) updated.add(row.id)
  }

  const claimed = new Set<string>()
  for (const { job, result } of converted) {
    if ('internal' in result) {
      items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'skipped', result.internal))
      continue
    }
    if ('review' in result) {
      const kind = asString(job.payload.kind) ?? 'agentTurn'
      items.push(item('schedule', job.id, label, 'manual-review.md', 'skipped', result.review))
      manual.push({
        name: job.name,
        schedule: scheduleLabel(job.schedule),
        detail: kind === 'command'
          ? `команда: ${Array.isArray(job.payload.argv) ? job.payload.argv.map(String).join(' ') : String(job.payload.argv ?? '')}`
          : `текст: ${asString(job.payload.text) ?? asString(job.payload.message) ?? ''}`,
      })
      continue
    }
    if ('past' in result) {
      items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'skipped', 'разовый запуск в прошлом'))
      continue
    }
    const { input } = result
    if (result.warning !== undefined) items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'warning', result.warning))

    // A job this migration imported before is matched by its source identity,
    // not by its text: the owner may have changed either field in OpenClaw.
    const row = savedRow(job)
    if (row !== undefined && !claimed.has(row.id)) {
      claimed.add(row.id)
      const textChanged = row.task !== input.task
      const specChanged = row.spec !== input.spec
      if (!textChanged && !specChanged) {
        items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'skipped', 'уже есть'))
        continue
      }
      const changes = [textChanged ? 'текст задания' : undefined, specChanged ? 'расписание' : undefined]
        .filter((value): value is string => value !== undefined).join(' и ')
      if (options.overwrite) {
        const planItem = item('schedule', job.id, label, 'расписание DSHBOT', 'new', `обновляет существующее расписание (--overwrite): изменил${textChanged && !specChanged ? 'ся' : 'ось'} ${changes}`)
        items.push(planItem)
        actions.push({
          kind: 'schedule',
          items: [planItem],
          target: 'расписание DSHBOT',
          schedule: input,
          existingScheduleId: row.id,
          scheduleIds: [job.id],
        })
      } else {
        items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'conflict', `в OpenClaw изменил${textChanged && !specChanged ? 'ся' : 'ось'} ${changes} задачи ${job.id}; существующее расписание не меняется без --overwrite`))
      }
      continue
    }

    // A row written by an older migration has no saved source identity. An
    // identical text and schedule is adopted, so no second row is created.
    const same = (entry: ExistingSchedule): boolean => entry.spec === input.spec && entry.task === input.task
    const legacy = existing.find((entry) => !claimed.has(entry.id) && !owned.has(entry.id) && same(entry))
    if (legacy !== undefined) {
      claimed.add(legacy.id)
      state.schedules.set(job.id, { id: legacy.id })
      items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'skipped', 'уже есть'))
      continue
    }

    // Older migrations merged identical source jobs into one row, and that row
    // already belongs to another job. It stays shared without saving this
    // identity: once this job changes it gets a row of its own, never the other's.
    if (existing.some((entry) => !updated.has(entry.id) && same(entry))) {
      items.push(item('schedule', job.id, label, 'расписание DSHBOT', 'skipped', 'уже есть'))
      continue
    }

    const planItem = item('schedule', job.id, label, 'расписание DSHBOT', 'new')
    items.push(planItem)
    actions.push({
      kind: 'schedule',
      items: [planItem],
      target: 'расписание DSHBOT',
      schedule: input,
      scheduleIds: [job.id],
    })
  }
  return { items, actions, manual }
}

/** Plan skills, memory, persona and schedules against the destination. */
export function planContent(
  options: ContentOptions,
  source: OpenClawSource,
  sourceSecrets: readonly { name: string; value: SecretValue }[],
): ContentResult {
  let config: Record<string, unknown> = {}
  try {
    config = asRecord(parseJson5(readFileSync(source.configPath, 'utf8'))) ?? {}
  } catch {
    config = {}
  }
  const workspace = workspaceOf(config, source.dir)
  const { skills } = collectSkillSources(skillRoots(config, source))
  const skillSecrets = skillSecretCandidates(options, source, config, skills)
  const secretValues = [...sourceSecrets, ...skillSecrets]
    .map((secret) => secret.value)
    .filter((value): value is string => typeof value === 'string' && value !== '')

  const loaded = loadState(options.home)
  const skillPlan = planSkills(options, source, config, secretValues)
  const memoryPlan = planMemory(options, source, workspace, secretValues, loaded.state)
  const schedulePlan = planSchedules(options, source, loaded.state, skillPlan.paths)

  return {
    items: [...skillPlan.items, ...memoryPlan.items, ...schedulePlan.items],
    secrets: skillSecrets,
    actions: [...skillPlan.actions, ...memoryPlan.actions, ...schedulePlan.actions],
    manual: schedulePlan.manual,
    secretValues,
    state: loaded.state,
    statePath: loaded.path,
    stateOriginal: loaded.original,
  }
}

function backupFile(reportDir: string, path: string, data: Buffer): void {
  const dir = join(reportDir, 'before')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const relativePath = path.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '_')
  let name = relativePath
  let index = 1
  while (existsSync(join(dir, name))) name = `${relativePath}.${index++}`
  writeFileSync(join(dir, name), data, { mode: 0o600 })
}

export function backupTree(reportDir: string, dir: string): void {
  for (const path of treeFiles(dir)) {
    try {
      backupFile(reportDir, join(dir, path), readFileSync(join(dir, path)))
    } catch {
      // A file that vanished between the plan and the write needs no backup.
    }
  }
}

function writeSkill(reportDir: string, action: ContentAction, secrets: readonly string[]): void {
  const source = action.sourceDir
  if (source === undefined) return
  const files = redactedSkill(
    { name: action.skillName ?? basename(source), dir: source, root: source },
    secrets,
    action.renameTo ?? null,
  )
  if (action.overwrite === true && isDirectory(action.target)) {
    backupTree(reportDir, action.target)
    rmSync(action.target, { recursive: true, force: true })
  }
  mkdirSync(action.target, { recursive: true, mode: 0o700 })
  for (const [path, data] of files) {
    const to = join(action.target, path)
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, data)
  }
}

/** Execute the planned writes and schedule creations. */
export function applyContent(
  result: ContentResult,
  reportDir: string | undefined,
  home: string,
  secrets: readonly string[],
): void {
  for (const action of result.actions) {
    try {
      if (action.kind === 'skill') {
        if (action.overwrite === true && isDirectory(action.target)) backupTree(reportDir ?? '', action.target)
        if (action.backup === true && reportDir !== undefined && isDirectory(action.target) && action.overwrite !== true) {
          backupTree(reportDir, action.target)
        }
        if (action.overwrite === true && isDirectory(action.target)) rmSync(action.target, { recursive: true, force: true })
        const files = action.sourceDir === undefined
          ? new Map<string, Buffer>()
          : redactedSkill({ name: action.skillName ?? 'skill', dir: action.sourceDir, root: action.sourceDir }, secrets, action.renameTo ?? null)
        mkdirSync(action.target, { recursive: true, mode: 0o700 })
        for (const [path, data] of files) {
          const to = join(action.target, path)
          mkdirSync(dirname(to), { recursive: true })
          writeFileSync(to, data)
        }
        for (const entry of action.items) entry.status = 'applied'
      } else if (action.kind === 'file') {
        if (action.backup === true && reportDir !== undefined && existsSync(action.target)) {
          backupFile(reportDir, action.target, readFileSync(action.target))
        }
        mkdirSync(dirname(action.target), { recursive: true, mode: 0o700 })
        const data = action.data ?? Buffer.alloc(0)
        writeFileSync(action.target, data)
        if (action.knowledgeKey !== undefined) rememberKnowledge(result.state, action.knowledgeKey, data)
        const conflict = action.items.some((entry) => entry.status === 'conflict')
        for (const entry of action.items) if (!conflict) entry.status = 'applied'
      } else if (action.kind === 'schedule' && action.schedule !== undefined) {
        const id = applySchedule(home, action.schedule, action.existingScheduleId)
        for (const jobId of action.scheduleIds ?? []) result.state.schedules.set(jobId, { id })
        for (const entry of action.items) entry.status = 'applied'
      }
    } catch (error) {
      for (const entry of action.items) {
        entry.status = 'error'
        entry.reason = `не удалось записать: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  // Persist the identity map only when the run actually learned something:
  // an unchanged repeated migration must not create or rewrite a home file.
  persistState(result)

  if (reportDir !== undefined && result.manual.length > 0) {
    const lines = ['# Ручной разбор расписаний OpenClaw', '']
    for (const entry of result.manual) {
      lines.push(`## ${entry.name}`, '', `- расписание: ${entry.schedule}`, `- ${entry.detail}`, '')
    }
    mkdirSync(reportDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(reportDir, 'manual-review.md'), lines.join('\n'))
  }
}

/** Create a schedule or update the row of a previous import; returns its id. */
function applySchedule(home: string, input: ScheduleInput, existingId?: string): string {
  const store = openStore(join(home, 'state.db'))
  try {
    const registry = createScheduleRegistry(store)
    const record = existingId === undefined
      ? registry.create({
          spec: input.spec,
          task: input.task,
          ...(input.tz === undefined ? {} : { tz: input.tz }),
        })
      : registry.update(existingId, {
          spec: input.spec,
          task: input.task,
          ...(input.tz === undefined ? {} : { tz: input.tz }),
        })
    if (record === null) throw new Error(`расписание ${existingId ?? ''} не найдено`)
    // The registry trims the task; the migrated text is the prompt byte for
    // byte, and a repeated run compares exactly this text.
    store.db.prepare('UPDATE schedules SET task = ? WHERE id = ?').run(input.task, record.id)
    if (input.paused === true) registry.pause(record.id)
    else registry.resume(record.id)
    return record.id
  } finally {
    store.close()
  }
}
