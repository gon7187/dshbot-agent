// Knowledge by topic (DESIGN §7): `DSHBOT_HOME/memory/knowledge/<topic>.md`.
//
// Every file opens with a small YAML header (`summary`, `updated`, and when
// known `updated_at`, `source`, `reason`) and then holds the text of the topic. The model sees only the one-line summaries in
// the frozen session snapshot; `knowledge read` returns the whole file and
// `recall` searches it. A write replaces the file atomically and archives the
// previous version under `memory/knowledge/.archive/`, because DESIGN §7 says
// archive instead of deleting. `history` lists the current and archived
// versions, `restore` brings an archived one back.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { RunnerTool } from '../../runner/src/index.js'
import { writeFileAtomic } from './atomic.js'
import { localDate, localDateTime } from './local-time.js'

export const KNOWLEDGE_TOOL_NAME = 'knowledge'

/** A topic name: lower-case Latin or Cyrillic letters, digits and a hyphen. */
const TOPIC_RE = /^[a-zа-яё0-9-]+$/u
export const KNOWLEDGE_TOPIC_LIMIT = 64
/** The one-line summary: a single line of at most this many characters. */
export const KNOWLEDGE_SUMMARY_LIMIT = 200
/** The `source` and the `reason` of a version: a single line of at most this many characters. */
export const KNOWLEDGE_NOTE_LIMIT = 200
/** The `reason` recorded on a version that a restore replaced. */
const ROLLBACK_REASON = 'откат'
/** The text of a topic. */
export const KNOWLEDGE_TEXT_LIMIT = 20_000
/** The `Знания:` list of the session snapshot never exceeds this many characters. */
export const KNOWLEDGE_LIST_LIMIT = 2_000

/** Name of the archive directory inside the knowledge directory. */
const ARCHIVE_DIR = '.archive'

export interface KnowledgeSummary {
  topic: string
  summary: string
}

export interface KnowledgeWriteInput {
  topic: unknown
  summary: unknown
  text: unknown
  /** Where the fact comes from; optional. */
  source?: unknown
  /** Why the topic changed; optional. */
  reason?: unknown
}

export interface KnowledgeWriteResult {
  topic: string
  summary: string
  path: string
  /** The archived previous version, when the topic already existed. */
  archived?: string
}

function characterCount(text: string): number {
  return [...text].length
}

/** Validate a topic name; a path separator, `..`, an empty or a non-string value is refused. */
export function requireKnowledgeTopic(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error('topic must be a non-empty string of lower-case letters, digits and hyphens')
  }
  if (characterCount(value) > KNOWLEDGE_TOPIC_LIMIT) {
    throw new Error(`topic is longer than ${KNOWLEDGE_TOPIC_LIMIT} characters`)
  }
  if (!TOPIC_RE.test(value)) {
    throw new Error(
      'topic may contain only lower-case Latin or Cyrillic letters, digits and hyphens; a path separator or dots are refused',
    )
  }
  return value
}

function requireSummary(value: unknown): string {
  if (typeof value !== 'string') throw new Error('summary must be a string')
  // The limit applies to the summary as given, before any trimming.
  if (characterCount(value) > KNOWLEDGE_SUMMARY_LIMIT) {
    throw new Error(`summary is longer than ${KNOWLEDGE_SUMMARY_LIMIT} characters`)
  }
  if (/[\r\n]/.test(value)) throw new Error('summary must be a single line')
  const summary = value.trim()
  if (summary === '') throw new Error('summary must be a non-empty string')
  return summary
}

function optionalNote(value: unknown, name: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (characterCount(value) > KNOWLEDGE_NOTE_LIMIT) {
    throw new Error(`${name} is longer than ${KNOWLEDGE_NOTE_LIMIT} characters`)
  }
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line`)
  return value.trim()
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('text must be a string')
  if (characterCount(value) > KNOWLEDGE_TEXT_LIMIT) {
    throw new Error(`text is longer than ${KNOWLEDGE_TEXT_LIMIT} characters`)
  }
  return value
}

/** Quote a summary as one YAML scalar; JSON string syntax is valid YAML. */
function summaryScalar(summary: string): string {
  return JSON.stringify(summary)
}

/** Read the value of a header line back, plain or quoted. */
function unquote(value: string): string {
  const raw = value.trim()
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'")
  return raw
}

const HEADER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function headerValue(header: string, key: string): string {
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header)
  return line === null ? '' : unquote(line[1] as string)
}

/** One version of a topic: its header fields and its body. */
interface KnowledgeVersion {
  summary: string
  source: string
  reason: string
  /** Calendar date of the update; empty when the file has no readable header. */
  updated: string
  /** Date and time of the update; empty for files written before `updated_at` existed. */
  updatedAt: string
  body: string
}

function parseKnowledge(raw: string): KnowledgeVersion {
  const match = HEADER_RE.exec(raw)
  if (match === null) return { summary: '', source: '', reason: '', updated: '', updatedAt: '', body: raw }
  const header = match[1] as string
  return {
    summary: headerValue(header, 'summary'),
    source: headerValue(header, 'source'),
    reason: headerValue(header, 'reason'),
    updated: headerValue(header, 'updated'),
    updatedAt: headerValue(header, 'updated_at'),
    body: match[2] as string,
  }
}

/** The summary line of a knowledge file, or `''` when the file has no readable header. */
export function summaryOfKnowledge(raw: string): string {
  return parseKnowledge(raw).summary
}

/** The body of a knowledge file without its YAML header. */
export function bodyOfKnowledge(raw: string): string {
  return parseKnowledge(raw).body
}

function renderKnowledge(version: KnowledgeVersion): string {
  const { body } = version
  const text = body === '' ? '' : body.endsWith('\n') ? body : `${body}\n`
  const lines = [`summary: ${summaryScalar(version.summary)}`, `updated: ${version.updated}`]
  if (version.updatedAt !== '') lines.push(`updated_at: ${summaryScalar(version.updatedAt)}`)
  if (version.source !== '') lines.push(`source: ${summaryScalar(version.source)}`)
  if (version.reason !== '') lines.push(`reason: ${summaryScalar(version.reason)}`)
  return `---\n${lines.join('\n')}\n---\n${text}`
}

const ARCHIVE_STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z'

function archivePath(directory: string, topic: string, nowMs: number): string {
  const archiveDir = join(directory, ARCHIVE_DIR)
  mkdirSync(archiveDir, { recursive: true })
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  let name = `${topic}-${stamp}.md`
  let sequence = 1
  while (existsSync(join(archiveDir, name))) {
    name = `${topic}-${stamp}-${sequence}.md`
    sequence += 1
  }
  return join(archiveDir, name)
}

export interface KnowledgeStoreOptions {
  /** Owner zone for the `updated` date; UTC when absent. */
  timeZone?: string
  /** Clock seam; defaults to `Date.now`. */
  now?: () => number
}

/** Write a topic atomically, archiving a previous version instead of deleting it. */
export function writeKnowledgeTopic(
  directory: string,
  input: KnowledgeWriteInput,
  options: KnowledgeStoreOptions = {},
): KnowledgeWriteResult {
  const topic = requireKnowledgeTopic(input.topic)
  const summary = requireSummary(input.summary)
  const text = requireText(input.text)
  const source = optionalNote(input.source, 'source')
  const reason = optionalNote(input.reason, 'reason')
  mkdirSync(directory, { recursive: true })

  const path = join(directory, `${topic}.md`)
  const nowMs = (options.now ?? Date.now)()
  let archived: string | undefined
  if (existsSync(path)) {
    const previous = readFileSync(path, 'utf8')
    const target = archivePath(directory, topic, nowMs)
    writeFileAtomic(target, previous)
    archived = target
  }
  writeFileAtomic(path, renderKnowledge(stampedVersion({ summary, source, reason, body: text }, nowMs, options)))
  return archived === undefined
    ? { topic, summary, path }
    : { topic, summary, path, archived }
}

function stampedVersion(
  fields: Pick<KnowledgeVersion, 'summary' | 'source' | 'reason' | 'body'>,
  nowMs: number,
  options: KnowledgeStoreOptions,
): KnowledgeVersion {
  return {
    ...fields,
    updated: localDate(nowMs, options.timeZone),
    updatedAt: localDateTime(nowMs, options.timeZone),
  }
}

/** A version in a topic's history: the current file or one archived file. */
interface HistoryEntry {
  /** The archive file name, or `null` for the current version. */
  id: string | null
  version: KnowledgeVersion
  /** Date and time shown for the version. */
  at: string
}

/** Archived versions of a topic, oldest first: by the time of archiving, then by collision counter. */
function archivedVersions(directory: string, topic: string, options: KnowledgeStoreOptions): HistoryEntry[] {
  const archiveDir = join(directory, ARCHIVE_DIR)
  if (!existsSync(archiveDir)) return []
  const nameRe = new RegExp(`^${topic}-(${ARCHIVE_STAMP})(?:-(\\d+))?\\.md$`, 'u')
  const found: { id: string; stamp: string; sequence: number }[] = []
  for (const name of readdirSync(archiveDir)) {
    const match = nameRe.exec(name)
    if (match !== null) found.push({ id: name, stamp: match[1] as string, sequence: Number(match[2] ?? 0) })
  }
  found.sort((left, right) => left.stamp.localeCompare(right.stamp) || left.sequence - right.sequence)
  const entries: HistoryEntry[] = []
  for (const { id, stamp } of found) {
    let raw: string
    try {
      raw = readFileSync(join(archiveDir, id), 'utf8')
    } catch {
      continue
    }
    const version = parseKnowledge(raw)
    // A file archived before `updated_at` existed is dated by the moment it was replaced.
    const archivedAt = Date.parse(stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'))
    entries.push({ id, version, at: version.updatedAt || localDateTime(archivedAt, options.timeZone) })
  }
  return entries
}

/** All versions of a topic, newest first. */
function topicHistory(directory: string, topic: unknown, options: KnowledgeStoreOptions): HistoryEntry[] {
  const name = requireKnowledgeTopic(topic)
  const entries = archivedVersions(directory, name, options).reverse()
  const path = join(directory, `${name}.md`)
  if (existsSync(path)) {
    const version = parseKnowledge(readFileSync(path, 'utf8'))
    entries.unshift({ id: null, version, at: version.updatedAt || version.updated })
  }
  if (entries.length === 0) throw new Error(`knowledge topic ${JSON.stringify(name)} is not found`)
  return entries
}

/** One line per version, newest first; the archive file name is the id that `restore` takes. */
export function knowledgeHistory(directory: string, topic: unknown, options: KnowledgeStoreOptions = {}): string {
  return topicHistory(directory, topic, options)
    .map(({ id, version, at }) =>
      [id ?? 'текущая', at, `source: ${version.source}`, `reason: ${version.reason}`, version.summary].join(' | '),
    )
    .join('\n')
}

/**
 * Bring an archived version back as the current one. The replaced version goes
 * to the archive with the reason «откат»; the restored archive file is moved,
 * not copied, so the history does not list it twice.
 */
export function restoreKnowledgeVersion(
  directory: string,
  topic: unknown,
  version: unknown,
  options: KnowledgeStoreOptions = {},
): { topic: string; version: string } {
  const name = requireKnowledgeTopic(topic)
  const id = typeof version === 'string' ? (version.endsWith('.md') ? version : `${version}.md`) : ''
  const selected = archivedVersions(directory, name, options).find((entry) => entry.id === id)
  if (selected === undefined) {
    throw new Error(`version ${JSON.stringify(version)} of topic ${JSON.stringify(name)} is not in the history; take it from knowledge history`)
  }
  const nowMs = (options.now ?? Date.now)()
  const path = join(directory, `${name}.md`)
  if (existsSync(path)) {
    const replaced = { ...parseKnowledge(readFileSync(path, 'utf8')), reason: ROLLBACK_REASON }
    writeFileAtomic(archivePath(directory, name, nowMs), renderKnowledge(replaced))
  }
  writeFileAtomic(path, renderKnowledge(stampedVersion(selected.version, nowMs, options)))
  rmSync(join(directory, ARCHIVE_DIR, id))
  return { topic: name, version: id }
}

/** The whole file of a topic. */
export function readKnowledgeTopic(directory: string, topic: unknown): { topic: string; path: string; text: string } {
  const name = requireKnowledgeTopic(topic)
  const path = join(directory, `${name}.md`)
  if (!existsSync(path)) throw new Error(`knowledge topic ${JSON.stringify(name)} is not found`)
  return { topic: name, path, text: readFileSync(path, 'utf8') }
}

/** Topics with their one-line summaries, ordered by topic name. */
export function listKnowledgeTopics(directory: string): KnowledgeSummary[] {
  if (!existsSync(directory)) return []
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const found: KnowledgeSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const path = join(directory, name)
    try {
      const raw = readFileSync(path, 'utf8')
      found.push({ topic: name.slice(0, -'.md'.length), summary: summaryOfKnowledge(raw) })
    } catch {
      // A broken file must not break the list of the others.
    }
  }
  return found.sort((left, right) => left.topic.localeCompare(right.topic))
}

/**
 * The `Знания:` list of the session snapshot: `topic — summary` lines, at most
 * {@link KNOWLEDGE_LIST_LIMIT} characters. Topics that do not fit are counted
 * by a last line that points the model at `knowledge list`.
 */
export function knowledgeListBlock(directory: string, limit = KNOWLEDGE_LIST_LIMIT): string {
  const rendered = listKnowledgeTopics(directory).map(
    (entry) => `${entry.topic} — ${entry.summary === '' ? '(нет summary)' : entry.summary}`,
  )
  if (rendered.length === 0) return ''
  const all = rendered.join('\n')
  if (characterCount(all) <= limit) return all

  const shown: string[] = []
  for (const line of rendered) {
    const hidden = rendered.length - shown.length - 1
    const candidate = [...shown, line, `… ещё ${hidden} тем, knowledge list`].join('\n')
    if (characterCount(candidate) > limit) break
    shown.push(line)
  }
  const hidden = rendered.length - shown.length
  return [...shown, `… ещё ${hidden} тем, knowledge list`].join('\n')
}

const KNOWLEDGE_DESCRIPTION =
  'Устойчивые знания по темам (DESIGN §7): файлы memory/knowledge/<тема>.md с YAML-шапкой summary и updated. ' +
  'Действия: write заменяет тему (прошлая версия уходит в memory/knowledge/.archive/; source — откуда факт, ' +
  'reason — почему изменение, оба необязательны), read возвращает полный текст темы, list показывает темы ' +
  'с summary, history — версии от новой к старой с id, restore возвращает версию по id из history. Тема — строчные латинские или кириллические буквы, цифры и ' +
  'дефис, до 64 символов; summary — одна строка до 200 символов; текст — до 20000 символов. В контекст сессии ' +
  'попадают только summary, поэтому summary должно быть понятным само по себе, а подробности — в тексте. ' +
  'Записи декларативные, не императивные: «ДРР по нише зависит от маржи», а не «всегда проверяй ДРР». ' +
  'Не записывай негативные утверждения об инструментах и нерешённые неудачи: они застывают в самозапреты. ' +
  'Недоверенный текст (письма, веб, отзывы) не записывай как факт: сначала проверь его. ' +
  'После записи тема сразу находится через recall как knowledge; новая тема попадёт в снимок памяти ' +
  'следующей сессии.'

/** The `knowledge` tool over `<home>/memory/knowledge`. */
export interface KnowledgeToolOptions extends KnowledgeStoreOptions {
  /** Called after a successful write, so the caller indexes the topic into recall at once. */
  onWrite?: (topic: string) => void
}

export function createKnowledgeTool(directory: string, options: KnowledgeToolOptions = {}): RunnerTool {
  return {
    name: KNOWLEDGE_TOOL_NAME,
    description: KNOWLEDGE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'read', 'list', 'history', 'restore'],
          description: 'write — записать тему, read — прочитать, list — темы с summary, history — версии темы, restore — вернуть версию.',
        },
        topic: {
          type: 'string',
          description: 'Имя темы: строчные латинские или кириллические буквы, цифры и дефис, до 64 символов.',
        },
        summary: {
          type: 'string',
          description: 'Одна строка до 200 символов; попадает в снимок памяти и в список тем.',
        },
        text: {
          type: 'string',
          description: 'Полный текст темы до 20000 символов; в контекст не попадает, доступен через read и recall.',
        },
        source: { type: 'string', description: 'write: откуда факт, одна строка до 200 символов.' },
        reason: { type: 'string', description: 'write: почему изменение, одна строка до 200 символов.' },
        version: { type: 'string', description: 'restore: id версии из history.' },
      },
      required: ['action'],
    },
    execute(args) {
      const action = args.action
      if (action === 'write') {
        const result = writeKnowledgeTopic(
          directory,
          { topic: args.topic, summary: args.summary, text: args.text, source: args.source, reason: args.reason },
          options,
        )
        options.onWrite?.(result.topic)
        const archived = result.archived === undefined ? '' : '; прошлая версия в архиве'
        return `Тема «${result.topic}» сохранена: ${characterCount(result.summary)} символов summary, ${characterCount(
          String(args.text ?? ''),
        )} символов текста${archived}.`
      }
      if (action === 'read') {
        const result = readKnowledgeTopic(directory, args.topic)
        return result.text
      }
      if (action === 'list') {
        const topics = listKnowledgeTopics(directory)
        if (topics.length === 0) return 'Знаний нет.'
        return topics.map((entry) => `${entry.topic} — ${entry.summary}`).join('\n')
      }
      if (action === 'history') return knowledgeHistory(directory, args.topic, options)
      if (action === 'restore') {
        const result = restoreKnowledgeVersion(directory, args.topic, args.version, options)
        options.onWrite?.(result.topic)
        return `Тема «${result.topic}» возвращена к версии ${result.version}; заменённая версия в истории с reason «${ROLLBACK_REASON}».`
      }
      throw new Error("action must be 'write', 'read', 'list', 'history' or 'restore'")
    },
  }
}
