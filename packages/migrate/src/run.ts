// Plan, apply, report. The planner compares every candidate of the source with
// the destination and gives it a status; the applier writes only items marked
// `new`, keeps backup copies of changed existing files and records the run in
// `<DSHBOT_HOME>/migration/openclaw-<time>/report.json`.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { archiveIdentity, checkIdentityShrink } from '../../memory/src/identity.js'
import { parseYamlDocument } from '../../learn/src/skills.js'
import { createScheduleRegistry } from '../../scheduler/src/index.js'
import { openStore } from '../../store/src/index.js'
import { applyContent, backupTree, planContent, type ContentResult, type SkillConflict } from './content.js'
import { collectHermes, discoverHermes, liveHermesGateway, memoryEntries } from './hermes.js'
import { collectOpenClaw, discover, sameSecretValue } from './openclaw.js'
import type { Collected, ItemStatus, ManualCandidate, PlanItem, PlannedStatus, ScheduleCandidate, SkillCandidate } from './types.js'

/** kv key of the owner chat in `state.db` (same as `OWNER_KV_KEY` of the daemon). */
const OWNER_KV_KEY = 'telegram.owner_chat_id'
const STATE_DB_FILE = 'state.db'
const MCP_FILE = 'mcp.json'
const SECRETS_DIR = 'secrets'

export interface Options {
  readonly from?: string
  /** Hermes profile under `<root>/profiles/<name>`. */
  readonly profile?: string
  /** Source adapter: `openclaw` (default) or `hermes`. */
  readonly sourceName?: 'openclaw' | 'hermes'
  readonly home: string
  readonly envFile: string
  readonly dryRun: boolean
  readonly yes: boolean
  readonly includeSecrets: boolean
  readonly overwrite: boolean
  readonly skillConflict: SkillConflict
  readonly json: boolean
}

export interface MigrationResult {
  readonly code: number
  readonly reportDir?: string
}

interface Plan {
  readonly items: PlanItem[]
  readonly envPath: string
  readonly envOriginal?: string
  readonly envNext: string
  readonly envChanged: boolean
  readonly mcpPath: string
  readonly mcpOriginal?: string
  readonly mcpDoc?: Record<string, unknown>
  readonly mcpChanged: boolean
  readonly ownerPath: string
  readonly ownerValue?: string
  readonly source: { readonly dir: string }
  readonly sourceName: 'openclaw' | 'hermes'
  readonly profile?: string
  /** Values of the migrated keys, longest first; never printed, only replaced. */
  readonly redactions: readonly Redaction[]
  /** Skills, memory and schedules of OpenClaw; Hermes plans them in `items`. */
  readonly content?: ContentResult
}

/** A secret value and the `${secret:NAME}` reference that replaces it in copied text. */
interface Redaction {
  readonly name: string
  readonly value: string
}

/** Shorter values (`1`, `true`) would rewrite ordinary words of a copied file. */
const REDACTION_MIN_LENGTH = 8

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch {
    return undefined
  }
}

/** The text of `bytes` when they are valid UTF-8; binary content is copied as is. */
function utf8Text(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8')
  return Buffer.from(text).equals(bytes) ? text : undefined
}

/** Every key of the run that can appear in copied text: vault and daemon environment. */
function redactionsOf(collected: Collected): Redaction[] {
  const seen = new Set<string>()
  const result: Redaction[] = []
  const add = (name: string, raw: string | Buffer): void => {
    const value = typeof raw === 'string' ? raw : utf8Text(raw)
    if (value === undefined || value.length < REDACTION_MIN_LENGTH || seen.has(value)) return
    seen.add(value)
    result.push({ name, value })
  }
  for (const candidate of collected.secrets) add(candidate.name, candidate.value)
  for (const candidate of collected.env) add(candidate.name, candidate.value)
  return result.sort((left, right) => right.value.length - left.value.length)
}

/** Replace every migrated secret value with its `${secret:NAME}` reference (same rule as mcp.json). */
function redact(text: string, redactions: readonly Redaction[]): string {
  let result = text
  for (const { name, value } of redactions) result = result.split(value).join(`\${secret:${name}}`)
  return result
}

/** Secret values found by the last `prepare`: unexpected failures are masked with them too. */
let knownRedactions: readonly Redaction[] = []

/** The message of an unexpected failure without the secret values of this run (no stack). */
export function maskedFailure(error: unknown): string {
  return redact(messageOf(error), knownRedactions)
}

/** One assignment of an environment file, with the offsets it occupies. */
interface EnvEntry {
  readonly key: string
  /** The value decoded by the rules of systemd `EnvironmentFile=`. */
  readonly value: string
  /** `export ` when the line has it (a shell-style file); kept on replace. */
  readonly exportPrefix: string
  /** From the first character of the assignment to the end of its value. */
  readonly start: number
  readonly end: number
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_BLANK = ' \t'
const ENV_NEWLINE = '\n\r'
/** Characters a backslash escapes inside double quotes (systemd and POSIX sh). */
const ENV_DOUBLE_ESCAPED = '"\\`$'

/**
 * Parse an environment file the way systemd does for `EnvironmentFile=`:
 * `#`/`;` comment lines, unquoted values with backslash escapes and trimmed
 * trailing blanks, single quotes verbatim, double quotes with `\"`, `\\`,
 * `\$`, `\``, and line continuations. A quoted value may span lines.
 */
function parseEnvFile(text: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  let index = 0
  const at = (offset: number): string => text[offset] ?? ''
  while (index < text.length) {
    while (index < text.length && (ENV_BLANK + ENV_NEWLINE).includes(at(index))) index += 1
    if (index >= text.length) break
    const start = index
    if (at(index) === '#' || at(index) === ';') {
      while (index < text.length && !ENV_NEWLINE.includes(at(index))) index += 1
      continue
    }
    while (index < text.length && at(index) !== '=' && !ENV_NEWLINE.includes(at(index))) index += 1
    if (at(index) !== '=') continue
    let key = text.slice(start, index).trim()
    let exportPrefix = ''
    const exported = /^export[ \t]+(.*)$/.exec(key)
    if (exported !== null) {
      exportPrefix = 'export '
      key = exported[1] ?? ''
    }
    index += 1
    let value = ''
    let trailing = -1
    let state: 'pre' | 'plain' | 'single' | 'double' = 'pre'
    while (index < text.length) {
      const char = at(index)
      if (state === 'single') {
        if (char === "'") state = 'pre'
        else value += char
        index += 1
        continue
      }
      if (state === 'double') {
        if (char === '"') state = 'pre'
        else if (char === '\\') {
          const next = at(index + 1)
          if (next !== '' && ENV_DOUBLE_ESCAPED.includes(next)) value += next
          else if (next !== '\n') value += char + next
          index += 1
        } else value += char
        index += 1
        continue
      }
      if (ENV_NEWLINE.includes(char)) break
      if (state === 'pre' && ENV_BLANK.includes(char)) {
        index += 1
        continue
      }
      if (char === "'" && state === 'pre') {
        state = 'single'
        trailing = -1
      } else if (char === '"' && state === 'pre') {
        state = 'double'
        trailing = -1
      } else if (char === '\\') {
        state = 'plain'
        const next = at(index + 1)
        if (next !== '' && !ENV_NEWLINE.includes(next)) value += next
        trailing = -1
        index += 1
      } else {
        state = 'plain'
        if (!ENV_BLANK.includes(char)) trailing = -1
        else if (trailing < 0) trailing = value.length
        value += char
      }
      index += 1
    }
    if (trailing >= 0) value = value.slice(0, trailing)
    if (ENV_KEY_RE.test(key)) entries.push({ key, value, exportPrefix, start, end: index })
  }
  return entries
}

/** The effective value of `key`: systemd applies assignments in order, so the last one wins. */
function envValueOf(text: string | undefined, key: string): string | undefined {
  if (text === undefined) return undefined
  return parseEnvFile(text).findLast((entry) => entry.key === key)?.value
}

/** Encode a value so that systemd (and a POSIX shell) read back exactly the same bytes. */
function formatEnvValue(value: string): string {
  if (value === '' || /[\s#;"'\\$`]/.test(value)) return `"${value.replace(/["\\`$]/g, (char) => `\\${char}`)}"`
  return value
}

/** Append or replace one assignment without touching the other lines. */
function setEnvValue(text: string, key: string, value: string, replace: boolean): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (replace) {
    const entry = parseEnvFile(text).findLast((candidate) => candidate.key === key)
    if (entry !== undefined) return `${text.slice(0, entry.start)}${entry.exportPrefix}${key}=${formatEnvValue(value)}${text.slice(entry.end)}`
  }
  const addition = `${key}=${formatEnvValue(value)}`
  if (text === '') return addition + eol
  return (text.endsWith('\n') ? text : text + eol) + addition + eol
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right)
}

function readOwner(path: string): { value?: string; error?: string } {
  if (!existsSync(path)) return {}
  let dir: string | undefined
  try {
    // A read-only WAL connection still creates `-shm`/`-wal` next to the real
    // database, so the migration reads a temporary copy and leaves the
    // destination byte-identical on a repeated run.
    dir = mkdtempSync(join(tmpdir(), 'dshbot-migrate-owner-'))
    const copy = join(dir, basename(path))
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(OWNER_KV_KEY) as { value?: string } | undefined
      return { value: row?.value }
    } finally {
      db.close()
    }
  } catch (error) {
    return { error: messageOf(error) }
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

function readMcp(path: string): { doc: Record<string, unknown>; original?: string; error?: string } {
  const original = readText(path)
  if (original === undefined) return { doc: { mcpServers: {} } }
  let parsed: unknown
  try {
    parsed = JSON.parse(original)
  } catch {
    return { doc: { mcpServers: {} }, original, error: 'mcp.json не является корректным JSON' }
  }
  if (!isRecord(parsed)) return { doc: { mcpServers: {} }, original, error: 'mcp.json должен содержать объект' }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    return { doc: { ...parsed, mcpServers: {} }, original, error: 'mcp.json: поле mcpServers должно быть объектом' }
  }
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : {}
  return { doc: { ...parsed, mcpServers: { ...servers } }, original }
}

function newItem(kind: string, name: string, source: string, target: string, status: PlannedStatus, reason?: string, field?: string): PlanItem {
  return { kind, name, source, target, status, ...(reason === undefined ? {} : { reason }), ...(field === undefined ? {} : { field }) }
}

interface ScheduleSummary {
  readonly id: string
  readonly task: string
  readonly spec: string
  readonly maxRuns: number | null
  readonly paused: boolean
}

/** Read the schedules of the destination from a temporary copy; never touches the real database. */
function readScheduleSummaries(path: string): ScheduleSummary[] {
  if (!existsSync(path)) return []
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'dshbot-migrate-schedules-'))
    const copy = join(dir, basename(path))
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, task, spec, max_runs, paused FROM schedules').all() as Record<string, unknown>[]
      return rows.map((row) => ({
        id: String(row.id),
        task: String(row.task),
        spec: String(row.spec),
        maxRuns: typeof row.max_runs === 'number' ? row.max_runs : null,
        paused: Number(row.paused) === 1,
      }))
    } finally {
      db.close()
    }
  } catch {
    return []
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

function frontmatterName(frontmatter: string): unknown {
  try {
    const root = parseYamlDocument(frontmatter)
    return Object.prototype.hasOwnProperty.call(root, 'name') ? root.name : undefined
  } catch {
    return undefined
  }
}

/** A top-level `name` key in any YAML spelling: plain, single- or double-quoted. */
const NAME_KEY_RE = /^(?:name|"name"|'name')[ \t]*:(?:[ \t]|$)/

/**
 * Rename the frontmatter of a copied skill when a collision changed its
 * directory name. The YAML decides: a document whose `name` already matches
 * is kept byte for byte; otherwise every top-level `name` entry (with the
 * indented lines of a multi-line value) is replaced by one plain `name:` line.
 */
function rewriteSkillName(text: string, name: string): string {
  const match = /^(\uFEFF?---(\r?\n))([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text)
  if (match === null) return text
  const frontmatter = match[3] as string
  if (frontmatterName(frontmatter) === name) return text
  const kept: string[] = []
  let inName = false
  for (const line of frontmatter.split(/\r?\n/)) {
    if (inName && (line.trim() === '' || /^[ \t]/.test(line))) continue
    inName = NAME_KEY_RE.test(line)
    if (!inName) kept.push(line)
  }
  const renamed = [`name: ${name}`, ...kept].join(match[2] as string)
  if (frontmatterName(renamed) !== name) return text
  return `${match[1]}${renamed}${match[4]}${text.slice((match[0] as string).length)}`
}

/**
 * Every regular file of a skill to copy: secret values of the run in text
 * files become `${secret:NAME}`, and SKILL.md carries the destination name.
 */
function skillFiles(candidate: SkillCandidate, redactions: readonly Redaction[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>()
  const walk = (dir: string, prefix: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        walk(absolute, rel)
        continue
      }
      if (!entry.isFile() || entry.name === '.meta.json') continue
      const value = readFileSync(absolute)
      const text = utf8Text(value)
      if (text === undefined) {
        result.set(rel, value)
        continue
      }
      const clean = redact(text, redactions)
      const next = rel === 'SKILL.md' ? rewriteSkillName(clean, candidate.name) : clean
      result.set(rel, next === text ? value : Buffer.from(next))
    }
  }
  walk(candidate.dir, '')
  return result
}

function sameSkill(files: Map<string, Buffer>, dest: string): boolean {
  if (!existsSync(join(dest, '.meta.json'))) return false
  const found = new Set<string>()
  const walk = (dir: string, prefix: string): boolean => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const entry of entries) {
      if (entry.name === '.meta.json') continue
      const absolute = join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!walk(absolute, rel)) return false
        continue
      }
      if (!entry.isFile()) return false
      found.add(rel)
      const expected = files.get(rel)
      if (expected === undefined || !readFileSync(absolute).equals(expected)) return false
    }
    return true
  }
  return walk(dest, '') && found.size === files.size
}

function mergedMemory(existing: string | undefined, entries: readonly string[]): string | undefined {
  const current = memoryEntries(existing ?? '')
  const next = [...current]
  for (const entry of entries) {
    if (!next.includes(entry)) next.push(entry)
  }
  if (next.length === current.length) return undefined
  return next.join('\n§\n') + '\n'
}

/** A fenced block that no backtick run of the text can close early. */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, text.replace(/\r\n/g, '\n').replace(/\n$/, ''), fence]
}

function manualText(items: readonly ManualCandidate[], redactions: readonly Redaction[]): string {
  const lines = ['# Ручная проверка после миграции', '']
  for (const item of items) {
    lines.push(`## ${redact(item.name, redactions)}`)
    lines.push(item.reason)
    if (item.prompt !== undefined) lines.push('', 'Текст задания:', ...fenced(redact(item.prompt, redactions)))
    if (item.detail !== undefined) lines.push('', 'Скрипт:', ...fenced(redact(item.detail, redactions)))
    lines.push('')
  }
  return lines.join('\n')
}

function sameScheduleSettings(entry: ScheduleSummary, candidate: ScheduleCandidate): boolean {
  return entry.spec === candidate.spec && entry.maxRuns === (candidate.maxRuns ?? null) && entry.paused === candidate.paused
}

function buildPlan(options: Options, source: { dir: string }, collected: Collected, gatewayAlive: boolean, content?: ContentResult): Plan {
  const sourceName = options.sourceName ?? 'openclaw'
  const items: PlanItem[] = []
  const home = options.home
  const secretsDir = join(home, SECRETS_DIR)
  const redactions = redactionsOf(collected)

  for (const candidate of collected.secrets) {
    const target = `${SECRETS_DIR}/${candidate.name}`
    const field = candidate.fields[0]
    if (candidate.conflict !== undefined) {
      items.push({ ...newItem('secret', candidate.name, candidate.sources.join(', '), target, 'conflict', candidate.conflict, field), value: candidate.value })
      continue
    }
    if (!options.includeSecrets) {
      items.push({ ...newItem('secret', candidate.name, candidate.sources.join(', '), target, 'skipped', 'нужен --include-secrets', field), value: candidate.value })
      continue
    }
    const path = join(secretsDir, candidate.name)
    const existing = readBytes(path)
    if (existing === undefined) {
      items.push({ ...newItem('secret', candidate.name, candidate.sources.join(', '), target, 'new', undefined, field), value: candidate.value })
      continue
    }
    if (sameSecretValue(existing, candidate.value)) {
      items.push(newItem('secret', candidate.name, candidate.sources.join(', '), target, 'skipped', 'уже есть', field))
      continue
    }
    if (options.overwrite) {
      items.push({ ...newItem('secret', candidate.name, candidate.sources.join(', '), target, 'new', 'заменяет другое значение (--overwrite)', field), value: candidate.value })
      continue
    }
    items.push({ ...newItem('secret', candidate.name, candidate.sources.join(', '), target, 'conflict', 'в хранилище уже другое значение', field), value: candidate.value })
  }

  const envPath = options.envFile
  const envOriginal = readText(envPath)
  const envItems: PlanItem[] = []
  for (const candidate of collected.env) {
    const target = envPath
    if (candidate.conflict !== undefined) {
      envItems.push({ ...newItem('env', candidate.name, candidate.sources.join(', '), target, 'conflict', candidate.conflict), value: candidate.value })
      continue
    }
    if (!options.includeSecrets) {
      envItems.push({ ...newItem('env', candidate.name, candidate.sources.join(', '), target, 'skipped', 'нужен --include-secrets'), value: candidate.value })
      continue
    }
    if (candidate.name === 'TELEGRAM_BOT_TOKEN' && gatewayAlive) {
      envItems.push({
        ...newItem(
          'env',
          candidate.name,
          candidate.sources.join(', '),
          target,
          'conflict',
          `живой процесс ${sourceName === 'hermes' ? 'Hermes' : 'OpenClaw'} gateway: один токен на двух ботах даёт 409 Conflict. Остановите ${sourceName === 'hermes' ? 'Hermes' : 'OpenClaw'} или заведите нового бота в @BotFather.`,
        ),
        value: candidate.value,
      })
      continue
    }
    const existing = envValueOf(envOriginal, candidate.name)
    if (existing === undefined) {
      envItems.push({ ...newItem('env', candidate.name, candidate.sources.join(', '), target, 'new'), value: candidate.value })
      continue
    }
    if (existing === candidate.value) {
      envItems.push(newItem('env', candidate.name, candidate.sources.join(', '), target, 'skipped', 'уже есть'))
      continue
    }
    if (options.overwrite) {
      const item = { ...newItem('env', candidate.name, candidate.sources.join(', '), target, 'new', 'заменяет другое значение (--overwrite)'), value: candidate.value, replace: true }
      envItems.push(item)
      continue
    }
    envItems.push({ ...newItem('env', candidate.name, candidate.sources.join(', '), target, 'conflict', 'в файле окружения уже другое значение'), value: candidate.value })
  }
  items.push(...envItems)
  let envNext = envOriginal ?? ''
  for (const item of envItems) {
    if (item.status === 'new') envNext = setEnvValue(envNext, item.name, typeof item.value === 'string' ? item.value : '', item.replace === true)
  }
  const envChanged = envItems.some((item) => item.status === 'new')

  const ownerPath = join(home, STATE_DB_FILE)
  let ownerValue: string | undefined
  if (collected.owner !== undefined) {
    const current = readOwner(ownerPath)
    const item = newItem('owner', OWNER_KV_KEY, collected.owner.source, STATE_DB_FILE, 'new')
    if (current.error !== undefined) {
      items.push(newItem('owner', OWNER_KV_KEY, collected.owner.source, STATE_DB_FILE, 'error', `state.db не читается: ${current.error}`))
    } else if (current.value === undefined) {
      items.push(item)
      ownerValue = collected.owner.id
    } else if (current.value === collected.owner.id) {
      items.push(newItem('owner', OWNER_KV_KEY, collected.owner.source, STATE_DB_FILE, 'skipped', 'уже есть'))
    } else if (options.overwrite) {
      items.push(newItem('owner', OWNER_KV_KEY, collected.owner.source, STATE_DB_FILE, 'new', 'заменяет другого владельца (--overwrite)'))
      ownerValue = collected.owner.id
    } else {
      items.push(newItem('owner', OWNER_KV_KEY, collected.owner.source, STATE_DB_FILE, 'conflict', 'в state.db уже записан другой владелец'))
    }
  }

  const mcpPath = join(home, MCP_FILE)
  const existingMcp = readMcp(mcpPath)
  const servers: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    isRecord(existingMcp.doc.mcpServers) ? existingMcp.doc.mcpServers : {},
  )
  let mcpChanged = false
  const mcpItems: PlanItem[] = []
  if (existingMcp.error !== undefined) {
    mcpItems.push(newItem('mcp', MCP_FILE, mcpPath, MCP_FILE, 'error', existingMcp.error))
  } else {
    for (const candidate of collected.mcp) {
      const target = `${MCP_FILE}#mcpServers.${candidate.name}`
      const item = { ...newItem('mcp', candidate.name, candidate.source, target, 'new'), server: candidate.server }
      const existing = Object.hasOwn(servers, candidate.name) ? servers[candidate.name] : undefined
      if (existing === undefined) {
        mcpItems.push(item)
        servers[candidate.name] = candidate.server
        mcpChanged = true
      } else if (sameValue(existing, candidate.server)) {
        mcpItems.push(newItem('mcp', candidate.name, candidate.source, target, 'skipped', 'уже есть'))
      } else if (options.overwrite) {
        mcpItems.push({ ...newItem('mcp', candidate.name, candidate.source, target, 'new', 'заменяет существующий сервер (--overwrite)'), server: candidate.server })
        servers[candidate.name] = candidate.server
        mcpChanged = true
      } else {
        mcpItems.push(newItem('mcp', candidate.name, candidate.source, target, 'conflict', 'сервер с таким именем уже есть в mcp.json'))
      }
      mcpItems.push(...candidate.warnings)
    }
  }
  items.push(...mcpItems, ...collected.warnings, ...(content?.items ?? []))

  // OpenClaw skills, memory, persona and schedules come from `content.ts`
  // (`content`); Hermes collects the same shapes into `collected` and they are
  // planned here with the shared writes of `apply`.
  if (collected.identity !== undefined) {
    const identityPath = join(home, 'memory', 'identity.md')
    const target = 'memory/identity.md'
    const current = readText(identityPath)
    const text = collected.identity.text
    if (current === undefined || current.trim() === '') {
      items.push({ ...newItem('identity', 'identity', collected.identity.source, target, 'new'), identity: text })
    } else if (current === text) {
      items.push(newItem('identity', 'identity', collected.identity.source, target, 'skipped', 'уже есть'))
    } else if (!options.overwrite) {
      items.push(newItem('identity', 'identity', collected.identity.source, target, 'conflict', 'в memory/identity.md уже есть другая личность; используйте --overwrite'))
    } else {
      const shrink = checkIdentityShrink(current, text)
      if (shrink.blocked) {
        items.push(newItem('identity', 'identity', collected.identity.source, target, 'conflict', 'новая личность короче прежней (порог identity); замена отклонена'))
      } else {
        items.push({ ...newItem('identity', 'identity', collected.identity.source, target, 'new', 'заменяет личность (--overwrite)'), identity: text })
      }
    }
  }

  for (const candidate of collected.memory ?? []) {
    const target = `memory/${candidate.name}`
    const next = mergedMemory(readText(join(home, 'memory', candidate.name)), candidate.entries)
    if (next === undefined) items.push(newItem('memory', candidate.name, candidate.source, target, 'skipped', 'уже есть'))
    else items.push({ ...newItem('memory', candidate.name, candidate.source, target, 'new'), memory: candidate })
  }

  // The skill policy is the same for both sources: `--skill-conflict
  // overwrite` alone authorizes a replacement, and the whole previous tree is
  // preserved in `before/` before the copy starts. `--overwrite` stays an
  // additional way to request it for Hermes.
  const replaceSkill = options.skillConflict === 'overwrite' || options.overwrite
  for (const candidate of collected.skills ?? []) {
    const target = `skills/${candidate.name}`
    const dest = join(home, 'skills', candidate.name)
    const files = skillFiles(candidate, redactions)
    if (!existsSync(dest)) items.push({ ...newItem('skill', candidate.name, candidate.source, target, 'new'), skill: candidate })
    else if (sameSkill(files, dest)) items.push(newItem('skill', candidate.name, candidate.source, target, 'skipped', 'уже есть'))
    else if (replaceSkill) items.push({ ...newItem('skill', candidate.name, candidate.source, target, 'new', 'заменяет существующий навык (--skill-conflict overwrite)'), skill: candidate })
    else items.push(newItem('skill', candidate.name, candidate.source, target, 'conflict', 'навык с таким именем уже есть и отличается'))
  }

  // Each row of the destination answers one job: exact matches (task and
  // settings) are claimed first, so two jobs with one prompt keep their own
  // rows on a repeated run; only then a row with the same task but other
  // settings is a conflict (or the row --overwrite updates).
  const scheduleSummaries = readScheduleSummaries(ownerPath)
  const scheduleCandidates = collected.schedules ?? []
  const claimed = new Set<string>()
  const claim = (match: (entry: ScheduleSummary) => boolean): ScheduleSummary | undefined => {
    const found = scheduleSummaries.find((entry) => !claimed.has(entry.id) && match(entry))
    if (found !== undefined) claimed.add(found.id)
    return found
  }
  const exactRows = scheduleCandidates.map((candidate) =>
    claim((entry) => entry.task === candidate.task && sameScheduleSettings(entry, candidate)),
  )
  for (const [index, candidate] of scheduleCandidates.entries()) {
    const target = 'state.db#schedules'
    const current = exactRows[index] === undefined ? claim((entry) => entry.task === candidate.task) : undefined
    if (exactRows[index] !== undefined) {
      items.push(newItem('schedule', candidate.name, candidate.source, target, 'skipped', 'уже есть'))
    } else if (current === undefined) {
      items.push({ ...newItem('schedule', candidate.name, candidate.source, target, 'new'), schedule: candidate })
    } else if (options.overwrite) {
      items.push({
        ...newItem('schedule', candidate.name, candidate.source, target, 'new', 'заменяет существующее расписание (--overwrite)'),
        schedule: candidate,
        existingScheduleId: current.id,
      })
    } else {
      items.push(newItem('schedule', candidate.name, candidate.source, target, 'conflict', 'расписание с тем же текстом задания уже есть и отличается'))
    }
  }

  if ((collected.manual ?? []).length > 0) {
    const target = 'migration/manual-review.md'
    const path = join(home, 'migration', 'manual-review.md')
    const next = manualText(collected.manual ?? [], redactions)
    if (readText(path) === next) items.push(newItem('manual', 'manual-review.md', 'cron/jobs.json', target, 'skipped', 'уже есть'))
    else items.push({ ...newItem('manual', 'manual-review.md', 'cron/jobs.json', target, 'new'), manual: collected.manual })
  }

  const mcpDoc = { ...existingMcp.doc, mcpServers: servers }
  return {
    items,
    envPath,
    ...(envOriginal === undefined ? {} : { envOriginal }),
    envNext,
    envChanged,
    mcpPath,
    ...(existingMcp.original === undefined ? {} : { mcpOriginal: existingMcp.original }),
    ...(existingMcp.error === undefined && mcpChanged ? { mcpDoc } : {}),
    mcpChanged: existingMcp.error === undefined && mcpChanged,
    ownerPath,
    ...(ownerValue === undefined ? {} : { ownerValue }),
    source,
    sourceName,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    redactions,
    ...(content === undefined ? {} : { content }),
  }
}

function finalStatus(item: PlanItem, applied: boolean): ItemStatus {
  if (item.status === 'new') return applied ? 'applied' : 'skipped'
  return item.status
}

function masked(text: string, redactions: readonly Redaction[]): string {
  return redact(text, redactions)
}

function publicItem(item: PlanItem, applied: boolean, redactions: readonly Redaction[] = []): Record<string, unknown> {
  return {
    kind: item.kind,
    name: masked(item.name, redactions),
    source: masked(item.source, redactions),
    target: masked(item.target, redactions),
    status: finalStatus(item, applied),
    ...(item.field === undefined ? {} : { field: masked(item.field, redactions) }),
    ...(item.reason === undefined ? {} : { reason: masked(item.reason, redactions) }),
  }
}

function secretNamesToMention(plan: Plan): string[] {
  return plan.items
    .filter((item) => (item.kind === 'secret' || item.kind === 'env') && item.status === 'skipped' && item.reason === 'нужен --include-secrets')
    .map((item) => item.name)
}

function label(item: PlanItem, applied: boolean): string {
  if (item.status === 'new') return applied ? 'применено' : 'план'
  if (item.status === 'applied') return 'применено'
  if (item.status === 'skipped') return 'пропущено'
  if (item.status === 'conflict') return 'конфликт'
  if (item.status === 'error') return 'ошибка'
  return 'предупреждение'
}

function humanLines(plan: Plan, applied: boolean): string[] {
  const lines: string[] = []
  for (const item of plan.items) {
    const reason = item.reason === undefined ? '' : ` — ${masked(item.reason, plan.redactions)}`
    lines.push(`  ${item.kind} ${masked(item.name, plan.redactions)} → ${masked(item.target, plan.redactions)} — ${label(item, applied)}${reason}`)
  }
  const counts = new Map<string, number>()
  for (const item of plan.items) {
    const key = finalStatus(item, applied)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  lines.push('')
  lines.push(
    'Итого: ' +
      ['applied', 'skipped', 'conflict', 'error', 'warning']
        .map((key) => `${key}: ${counts.get(key) ?? 0}`)
        .join(', '),
  )
  const names = secretNamesToMention(plan)
  if (names.length > 0) {
    lines.push(`Секреты не перенесены без --include-secrets: ${names.map((name) => masked(name, plan.redactions)).join(', ')}`)
    lines.push('Повторите запуск с --include-secrets, чтобы сохранить эти ключи.')
  }
  return lines
}

function writePrivate(path: string, text: string | Buffer): void {
  writeFileSync(path, text, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function backup(reportDir: string, path: string, content: Buffer, index: number): void {
  mkdirSync(join(reportDir, 'before'), { recursive: true, mode: 0o700 })
  writePrivate(join(reportDir, 'before', `${String(index).padStart(2, '0')}-${basename(path)}`), content)
}

function writeOwner(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(OWNER_KV_KEY, value)
  } finally {
    db.close()
  }
}

function isPid(name: string): boolean {
  return /^\d+$/.test(name)
}

function processTokens(pid: string, procRoot = '/proc'): string[] | undefined {
  try {
    return readFileSync(join(procRoot, pid, 'cmdline'), 'utf8').split('\0').filter((part) => part !== '')
  } catch {
    return undefined
  }
}

/** Is a DSHBOT daemon alive with this exact DSHBOT_HOME? */
export function liveDshbot(home: string): boolean {
  if (process.platform !== 'linux') return false
  const target = resolve(home)
  let pids: string[]
  try {
    pids = readdirSync('/proc')
  } catch {
    return false
  }
  for (const pid of pids) {
    if (!isPid(pid) || Number(pid) === process.pid) continue
    const tokens = processTokens(pid)
    if (tokens === undefined) continue
    if (!tokens.some((token) => /packages[\\/]app[\\/]src[\\/]main\.(?:ts|js)$/.test(token) || /dshbot-run\.sh$/.test(token) || /[\\/]bin[\\/]dshbot$/.test(token))) continue
    let env: string
    try {
      env = readFileSync(`/proc/${pid}/environ`, 'utf8')
    } catch {
      continue
    }
    const match = /(?:^|\0)DSHBOT_HOME=([^\0]*)/.exec(env)
    if (match?.[1] !== undefined && resolve(match[1]) === target) return true
  }
  return false
}

/**
 * Does this command line look like an OpenClaw gateway? Both words anywhere,
 * so `openclaw gateway`, `openclaw-gateway` and a path such as
 * `/opt/openclaw/bin/gateway` all count. Another run of this migration tool
 * (its `openclaw` argument and a path with `gateway`) is not a gateway.
 */
export function isOpenClawGatewayCommand(tokens: readonly string[]): boolean {
  if (tokens.some((token) => /packages[\\/]migrate[\\/]src[\\/]cli\.(?:ts|js)$/.test(token) || /(?:^|[\\/])dshbot-migrate$/.test(token))) return false
  // A harness may put its whole instruction text into one argument; that is
  // not a command line of a gateway, so only short single-line tokens count.
  const line = tokens.filter((token) => token.length <= 200 && !token.includes('\n')).join(' ').toLowerCase()
  return line.includes('openclaw') && line.includes('gateway')
}

/**
 * Is an OpenClaw gateway process alive? A second bot on its token gets 409.
 * `procRoot` is for tests: a synthetic process table, unlike a real gateway
 * process, is not seen by migrations of parallel test files.
 */
function parentPid(pid: string, procRoot: string): string | undefined {
  try {
    const stat = readFileSync(join(procRoot, pid, 'stat'), 'utf8')
    const match = /^\(.*\)\s+\S+\s+(\d+)/.exec(stat)
    return match?.[1]
  } catch {
    return undefined
  }
}

/** Pids of our own process and its ancestors: the harness that started us. */
function ancestorPids(procRoot: string): Set<string> {
  const result = new Set<string>()
  let current: string | undefined = String(process.pid)
  while (current !== undefined && current !== '0' && !result.has(current)) {
    result.add(current)
    current = parentPid(current, procRoot)
  }
  return result
}

export function liveOpenClawGateway(procRoot = '/proc'): boolean {
  if (process.platform !== 'linux') return false
  let pids: string[]
  try {
    pids = readdirSync(procRoot)
  } catch {
    return false
  }
  const ancestors = ancestorPids(procRoot)
  for (const pid of pids) {
    if (!isPid(pid) || ancestors.has(pid)) continue
    const tokens = processTokens(pid, procRoot)
    if (tokens !== undefined && isOpenClawGatewayCommand(tokens)) return true
  }
  return false
}

function createReportDir(home: string, sourceId: string): string {
  const base = join(home, 'migration')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let dir = join(base, `${sourceId}-${stamp}`)
  if (existsSync(dir)) dir = `${dir}-${process.pid}`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

interface Applied {
  readonly code: number
  readonly reportDir?: string
  /** No report directory (and so no backups): nothing was written. */
  readonly aborted?: string
  /** The items are applied, the report is not written. */
  readonly reportError?: string
}

function apply(plan: Plan, options: Options): Applied {
  const needsReport =
    plan.items.some((item) => item.status === 'new' || item.status === 'conflict' || item.status === 'error') ||
    (plan.content?.manual.length ?? 0) > 0
  let reportDir: string | undefined
  if (needsReport) {
    try {
      reportDir = createReportDir(options.home, plan.sourceName)
    } catch (error) {
      return { code: 1, aborted: `не удалось создать каталог отчёта: ${messageOf(error)}; изменения не применены` }
    }
  }

  for (const item of plan.items) {
    if (item.status !== 'new' || item.kind !== 'secret') continue
    const path = join(options.home, SECRETS_DIR, item.name)
    try {
      mkdirSync(join(options.home, SECRETS_DIR), { recursive: true, mode: 0o700 })
      writePrivate(path, item.value ?? '')
      item.status = 'applied'
    } catch (error) {
      item.status = 'error'
      item.reason = `не удалось записать секрет: ${messageOf(error)}`
    }
  }

  const envNew = plan.items.filter((item) => item.kind === 'env' && item.status === 'new')
  if (envNew.length > 0) {
    try {
      if (reportDir !== undefined && plan.envOriginal !== undefined) backup(reportDir, plan.envPath, Buffer.from(plan.envOriginal), 1)
      mkdirSync(dirname(plan.envPath), { recursive: true })
      writePrivate(plan.envPath, plan.envNext)
      for (const item of envNew) item.status = 'applied'
    } catch (error) {
      for (const item of envNew) {
        item.status = 'error'
        item.reason = `не удалось записать файл окружения: ${messageOf(error)}`
      }
    }
  }

  if (plan.ownerValue !== undefined) {
    const ownerItem = plan.items.find((item) => item.kind === 'owner' && item.status === 'new')
    try {
      writeOwner(plan.ownerPath, plan.ownerValue)
      if (ownerItem !== undefined) ownerItem.status = 'applied'
    } catch (error) {
      if (ownerItem !== undefined) {
        ownerItem.status = 'error'
        ownerItem.reason = `не удалось записать владельца в state.db: ${messageOf(error)}`
      }
    }
  }

  if (plan.mcpChanged && plan.mcpDoc !== undefined) {
    const mcpNew = plan.items.filter((item) => item.kind === 'mcp' && item.status === 'new')
    try {
      if (reportDir !== undefined && plan.mcpOriginal !== undefined) backup(reportDir, plan.mcpPath, Buffer.from(plan.mcpOriginal), 2)
      mkdirSync(options.home, { recursive: true })
      writePrivate(plan.mcpPath, JSON.stringify(plan.mcpDoc, null, 2) + '\n')
      for (const item of mcpNew) item.status = 'applied'
    } catch (error) {
      for (const item of mcpNew) {
        item.status = 'error'
        item.reason = `не удалось записать mcp.json: ${messageOf(error)}`
      }
    }
  }

  if (plan.content === undefined) {
  for (const item of plan.items) {
    if (item.status !== 'new' || item.kind !== 'identity') continue
    const path = join(options.home, 'memory', 'identity.md')
    try {
      const current = readText(path)
      if (current !== undefined && current.trim() !== '') {
        archiveIdentity(path, current, `миграция ${plan.sourceName}: --overwrite`)
      }
      mkdirSync(dirname(path), { recursive: true })
      writePrivate(path, item.identity ?? '')
      item.status = 'applied'
    } catch (error) {
      item.status = 'error'
      item.reason = `не удалось записать identity: ${messageOf(error)}`
    }
  }

  for (const item of plan.items) {
    if (item.status !== 'new' || item.kind !== 'memory' || item.memory === undefined) continue
    const path = join(options.home, 'memory', item.memory.name)
    try {
      const next = mergedMemory(readText(path), item.memory.entries)
      if (next === undefined) {
        item.status = 'skipped'
        item.reason = 'уже есть'
        continue
      }
      mkdirSync(dirname(path), { recursive: true })
      writePrivate(path, next)
      item.status = 'applied'
    } catch (error) {
      item.status = 'error'
      item.reason = `не удалось записать память: ${messageOf(error)}`
    }
  }

  for (const item of plan.items) {
    if (item.status !== 'new' || item.kind !== 'skill' || item.skill === undefined) continue
    const dest = join(options.home, 'skills', item.skill.name)
    try {
      if (existsSync(dest)) {
        if (reportDir !== undefined) backupTree(reportDir, dest)
        rmSync(dest, { recursive: true, force: true })
      }
      for (const [rel, value] of skillFiles(item.skill, plan.redactions)) {
        const path = join(dest, ...rel.split('/'))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, value)
      }
      const stamp = Date.now()
      writePrivate(join(dest, '.meta.json'), `${JSON.stringify({ createdAt: stamp, lastUsedAt: stamp, imported: true })}\n`)
      item.status = 'applied'
    } catch (error) {
      item.status = 'error'
      item.reason = `не удалось скопировать навык: ${messageOf(error)}`
    }
  }

  const scheduleItems = plan.items.filter((item) => item.status === 'new' && item.kind === 'schedule' && item.schedule !== undefined)
  if (scheduleItems.length > 0) {
    let store
    try {
      store = openStore(plan.ownerPath)
      const registry = createScheduleRegistry(store, { timeZone: 'UTC' })
      for (const item of scheduleItems) {
        const candidate = item.schedule as NonNullable<PlanItem['schedule']>
        try {
          let record
          if (item.existingScheduleId !== undefined) {
            record = registry.update(item.existingScheduleId, {
              spec: candidate.spec,
              task: candidate.task,
              ...(candidate.maxRuns === undefined ? {} : { maxRuns: candidate.maxRuns }),
            })
          } else {
            record = registry.create({
              spec: candidate.spec,
              task: candidate.task,
              tz: 'UTC',
              ...(candidate.maxRuns === undefined ? {} : { maxRuns: candidate.maxRuns }),
            })
          }
          if (record !== null) {
            // The registry trims the task; the migrated text is the prompt
            // byte for byte, and a repeated run compares exactly this text.
            store.db.prepare('UPDATE schedules SET task = ? WHERE id = ?').run(candidate.task, record.id)
            if (candidate.paused) registry.pause(record.id)
            else registry.resume(record.id)
          }
          item.status = 'applied'
        } catch (error) {
          item.status = 'error'
          item.reason = `не удалось создать расписание: ${messageOf(error)}`
        }
      }
    } catch (error) {
      for (const item of scheduleItems) {
        if (item.status !== 'new') continue
        item.status = 'error'
        item.reason = `не удалось открыть state.db: ${messageOf(error)}`
      }
    } finally {
      try {
        store?.close()
      } catch {
        // Keep the original failure.
      }
    }
  }

  const manualItem = plan.items.find((item) => item.status === 'new' && item.kind === 'manual')
  if (manualItem !== undefined && manualItem.manual !== undefined) {
    const path = join(options.home, 'migration', 'manual-review.md')
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writePrivate(path, manualText(manualItem.manual, plan.redactions))
      manualItem.status = 'applied'
    } catch (error) {
      manualItem.status = 'error'
      manualItem.reason = `не удалось записать manual-review.md: ${messageOf(error)}`
    }
  }
  } else {
    // Also called without a report: adopting an identical legacy schedule only
    // records its source identity, which must not need a second migration.
    applyContent(plan.content, reportDir, options.home, plan.content.secretValues)
  }

  const items = plan.items.map((item) => publicItem(item, true, plan.redactions))
  if (reportDir !== undefined) {
    const report = {
      version: 1,
      source: plan.sourceName,
      sourceRoot: masked(plan.source.dir, plan.redactions),
      ...(plan.profile === undefined ? {} : { profile: masked(plan.profile, plan.redactions) }),
      home: masked(options.home, plan.redactions),
      envFile: masked(options.envFile, plan.redactions),
      createdAt: new Date().toISOString(),
      recommendation: 'Передавайте ключи через secrets инструмента exec, а не текстом навыка.',
      items: items.map((item) => stripInternal(item)),
    }
    try {
      writePrivate(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    } catch (error) {
      return { code: 1, reportError: `не удалось записать отчёт: ${messageOf(error)}` }
    }
  }
  const failed = items.some((item) => item.status === 'conflict' || item.status === 'error')
  return { code: failed ? 1 : 0, ...(reportDir === undefined ? {} : { reportDir }) }
}

export interface Prepared {
  readonly plan: Plan
  readonly gatewayAlive: boolean
}

/** Discover the source and collect the plan without writing anything. */
export function prepare(options: Options): { ok: true; prepared: Prepared } | { ok: false; message: string } {
  const sourceName = options.sourceName ?? 'openclaw'
  if (sourceName === 'hermes') {
    const discovery = discoverHermes(options.from, options.profile, process.env)
    if (!discovery.ok) return { ok: false, message: discovery.message }
    const gatewayAlive = liveHermesGateway()
    const collected = collectHermes(discovery.source)
    knownRedactions = redactionsOf(collected)
    const plan = buildPlan(options, { dir: discovery.source.dir }, collected, gatewayAlive)
    knownRedactions = plan.redactions
    return { ok: true, prepared: { plan, gatewayAlive } }
  }
  const discovery = discover(options.from, process.env)
  if (!discovery.ok) return { ok: false, message: discovery.message }
  const gatewayAlive = liveOpenClawGateway()
  const collected = collectOpenClaw(discovery.source)
  knownRedactions = redactionsOf(collected)
  const content = planContent(
    {
      home: options.home,
      dryRun: options.dryRun,
      includeSecrets: options.includeSecrets,
      overwrite: options.overwrite,
      skillConflict: options.skillConflict,
    },
    discovery.source,
    collected.secrets,
  )
  collected.secrets.push(...content.secrets)
  knownRedactions = redactionsOf(collected)
  const plan = buildPlan(options, discovery.source, collected, gatewayAlive, content)
  knownRedactions = plan.redactions
  return { ok: true, prepared: { plan, gatewayAlive } }
}

export function defaultHome(env: NodeJS.ProcessEnv): string {
  const configured = env.DSHBOT_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.local', 'share', 'dshbot')
}

export function defaultEnvFile(): string {
  return join(homedir(), '.config', 'dshbot', 'dshbot.env')
}

/**
 * The one JSON document of `--json`. `extra` carries what the text mode prints
 * as separate lines (the `--yes` hint, the report path), so stdout stays a
 * single parseable document on every path.
 */
export function planJson(plan: Plan, options: Options, applied: boolean, extra: Record<string, unknown> = {}): string {
  const names = secretNamesToMention(plan)
  return JSON.stringify(
    {
      source: plan.sourceName,
      sourceRoot: masked(plan.source.dir, plan.redactions),
      ...(plan.profile === undefined ? {} : { profile: masked(plan.profile, plan.redactions) }),
      home: masked(options.home, plan.redactions),
      envFile: masked(options.envFile, plan.redactions),
      dryRun: options.dryRun,
      includeSecrets: options.includeSecrets,
      applied,
      items: plan.items.map((item) => publicItem(item, applied, plan.redactions)),
      ...(names.length === 0 ? {} : { secretsRequireInclude: names.map((name) => masked(name, plan.redactions)) }),
      ...extra,
    },
    null,
    2,
  )
}

function sourceLabel(plan: Plan): string {
  return plan.sourceName === 'hermes' ? 'Hermes' : 'OpenClaw'
}

/** The report never carries values or internal candidate objects. */
function stripInternal(item: Record<string, unknown>): Record<string, unknown> {
  const { value: _value, server: _server, skill: _skill, memory: _memory, identity: _identity, schedule: _schedule, ...rest } = item
  return rest
}

function planHeader(plan: Plan, options: Options, title: string): string {
  return `${title}\nИсточник: ${masked(plan.source.dir, plan.redactions)}\nDSHBOT_HOME: ${masked(options.home, plan.redactions)}\nФайл окружения: ${masked(options.envFile, plan.redactions)}\n\n`
}

const YES_HINT = 'Ничего не записано. Для применения повторите запуск с --yes.'
const CANCELLED = 'Отменено, ничего не записано.'

function daemonRunning(plan: Plan, options: Options): number {
  process.stderr.write(
    `dshbot-migrate: DSHBOT уже работает с этим DSHBOT_HOME (${masked(options.home, plan.redactions)}); миграция ничего не записала. ` +
      'Остановите демон и повторите запуск.\n',
  )
  return 1
}

/** Every failure ends with a masked message and code 1, never with a stack trace. */
export function run(options: Options): number {
  knownRedactions = []
  try {
    return migrate(options)
  } catch (error) {
    process.stderr.write(`dshbot-migrate: ошибка миграции: ${maskedFailure(error)}\n`)
    return 1
  }
}

function migrate(options: Options): number {
  const prepared = prepare(options)
  if (!prepared.ok) {
    process.stderr.write(`dshbot-migrate: ${prepared.message}\n`)
    return 1
  }
  const { plan } = prepared.prepared
  // Reading the source writes nothing; the check comes after it so that the
  // message can mask a secret value inside the DSHBOT_HOME path.
  if (!options.dryRun && options.yes && liveDshbot(options.home)) return daemonRunning(plan, options)

  if (options.dryRun) {
    if (options.json) process.stdout.write(planJson(plan, options, false) + '\n')
    else {
      process.stdout.write(planHeader(plan, options, `DSHBOT: план миграции ${sourceLabel(plan)} (--dry-run)`))
      process.stdout.write(humanLines(plan, false).join('\n') + '\n')
      process.stdout.write('\nНичего не записано: это план.\n')
    }
    return plan.items.some((item) => item.status === 'conflict' || item.status === 'error') ? 1 : 0
  }

  if (!options.yes) {
    const interactive = process.stdin.isTTY === true
    if (!interactive) {
      if (options.json) process.stdout.write(planJson(plan, options, false, { hint: YES_HINT }) + '\n')
      else {
        process.stdout.write(planHeader(plan, options, `DSHBOT: план миграции ${sourceLabel(plan)}`))
        process.stdout.write(humanLines(plan, false).join('\n') + '\n')
        process.stdout.write(`\n${YES_HINT}\n`)
      }
      return 0
    }
    // With --json the plan and the question go to stderr: stdout carries only
    // the final document.
    const human = options.json ? process.stderr : process.stdout
    human.write(planHeader(plan, options, `DSHBOT: план миграции ${sourceLabel(plan)}`))
    human.write(humanLines(plan, false).join('\n') + '\n')
    human.write('\nПрименить изменения? [y/N] ')
    const buffer = Buffer.alloc(64)
    let read = 0
    try {
      read = readSync(0, buffer, 0, buffer.length, null)
    } catch {
      read = 0
    }
    const answer = buffer.subarray(0, read).toString('utf8').trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes' && answer !== 'д' && answer !== 'да') {
      if (options.json) process.stdout.write(planJson(plan, options, false, { hint: CANCELLED }) + '\n')
      else process.stdout.write(`${CANCELLED}\n`)
      return 0
    }
  }

  if (liveDshbot(options.home)) return daemonRunning(plan, options)

  const result = apply(plan, options)
  if (result.aborted !== undefined) {
    const aborted = masked(result.aborted, plan.redactions)
    if (options.json) process.stdout.write(planJson(plan, options, false, { error: aborted }) + '\n')
    process.stderr.write(`dshbot-migrate: ${aborted}\n`)
    return result.code
  }
  const reportPath = result.reportDir === undefined ? undefined : join(result.reportDir, 'report.json')
  const reportError = result.reportError === undefined ? undefined : masked(result.reportError, plan.redactions)
  if (options.json) {
    const extra = reportError !== undefined ? { error: reportError } : reportPath === undefined ? {} : { report: masked(reportPath, plan.redactions) }
    process.stdout.write(planJson(plan, options, true, extra) + '\n')
  } else {
    process.stdout.write(planHeader(plan, options, `DSHBOT: миграция ${sourceLabel(plan)} применена`))
    process.stdout.write(humanLines(plan, true).join('\n') + '\n')
    if (reportPath !== undefined && reportError === undefined) process.stdout.write(`\nОтчёт: ${masked(reportPath, plan.redactions)}\n`)
  }
  if (reportError !== undefined) process.stderr.write(`dshbot-migrate: ${reportError}\n`)
  return result.code
}
