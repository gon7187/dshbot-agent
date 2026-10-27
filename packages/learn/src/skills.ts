// Skill library of the bot: `skills/<name>/SKILL.md` under DSHBOT_HOME.
//
// The on-disk format is the one agents already use in `~/.agents/skills`:
// YAML frontmatter with `name` and `description`, then a markdown body with the
// Procedure / Pitfalls / Verification sections. The linter below is the only
// gate between the review model and the library:
//
//   * `name` and `description` are at most 60 characters (DESIGN §8.1);
//   * the body must keep all three sections, so a lesson has a procedure, the
//     pitfall that cost time and a way to check the result;
//   * a name is one path segment: no separators, no `..`, no leading dot;
//   * create validates the whole document before the directory appears, so a
//     rejected skill never leaves a half-made directory;
//   * patch validates the result and writes atomically; the read-before-write
//     rule itself is enforced by the skill tools (see `createSkillTools`).
//
// An imported skill (`.meta.json: {"imported": true}`) is read by the Agent
// Skills format OpenClaw and Hermes use: lowercase-hyphen `name` up to 64
// characters, `description` up to 1024, a free-form body and support files in
// `scripts/`, `references/`, `templates/` and `assets/`. New skills the bot
// writes itself (skill_manage create, /learn, skill_propose) and every shipped
// skill stay strict, and so does a patch of an owner skill. A patch of an
// imported skill is checked by the import linter, because the origin lives in
// `.meta.json`: the imported flag decides which linter runs, never the file.

import { randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Dirent } from 'node:fs'

import type { RunnerTool } from '../../runner/src/index.js'

/** Directory with the library, relative to DSHBOT_HOME. */
export const SKILLS_DIR = 'skills'

/** Recoverable archive of the curator, relative to the library. */
export const SKILLS_ARCHIVE_DIR = '.archive'

/** Name of the skill document inside its directory. */
export const SKILL_FILE = 'SKILL.md'

/** Hidden metadata file (created/last used timestamps, stale flag). */
export const SKILL_META_FILE = '.meta.json'

/** Frontmatter limits from DESIGN §8.1. */
export const SKILL_NAME_LIMIT = 60
export const SKILL_DESCRIPTION_LIMIT = 60

/** Limits of an imported skill in the Agent Skills format (OpenClaw, Hermes). */
export const IMPORTED_SKILL_NAME_LIMIT = 64
export const IMPORTED_SKILL_DESCRIPTION_LIMIT = 1024

/** Sections every skill body must keep. */
export const REQUIRED_SKILL_SECTIONS = ['Procedure', 'Pitfalls', 'Verification'] as const

/** Placeholders OpenClaw (`{baseDir}`) and Hermes (`${HERMES_SKILL_DIR}`) use for the skill directory. */
export const SKILL_BASE_DIR_TOKEN = '{baseDir}'
export const HERMES_SKILL_DIR_TOKEN = '${HERMES_SKILL_DIR}'

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const IMPORTED_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillInfo {
  name: string
  description: string
  createdAt: number
  lastUsedAt: number
  stale: boolean
  /** A shipped skill: readable and listed, never changed or archived. */
  builtin: boolean
  /** Copied from OpenClaw/Hermes: accepted in the Agent Skills format. */
  imported: boolean
}

export interface SkillMeta {
  createdAt: number
  lastUsedAt: number
  stale?: boolean
  builtin?: boolean
  imported?: boolean
}

export interface SkillStoreOptions {
  /** DSHBOT_HOME. The library lives in `<home>/skills`. */
  home: string
  /** Injected clock; tests use fake time. */
  now?: () => number
  /**
   * Directory with the skills shipped by the daemon (`<name>/SKILL.md`).
   * They are copied into the owner catalog on every start and marked as
   * built-in: listed and readable, but create/patch/delete refuse them.
   */
  builtinDir?: string
}

/** Directory with the built-in skills of this package. */
export function builtinSkillsDir(): string {
  return fileURLToPath(new URL('../builtin-skills', import.meta.url))
}

export interface SkillStore {
  /** Absolute path of the library. */
  readonly dir: string
  /** Valid skills, sorted by name. Malformed documents are skipped. */
  list(): SkillInfo[]
  /** Compact index lines `- name — description`, sorted by name. */
  indexLines(): string[]
  /** Absolute directory of one skill. */
  skillDir(name: string): string
  /** Full document of one skill; marks the skill as used. */
  read(name: string): string
  /** Text of one file inside the skill directory; a path that escapes it is refused. */
  readFile(name: string, path: string): string
  /** Relative paths of the support files of a skill, sorted. */
  listFiles(name: string): string[]
  /** Validates and creates `<name>/SKILL.md`; refuses an existing skill. */
  create(name: string, content: string): SkillInfo
  /** Replaces exactly one occurrence of `oldText`; validates the result. */
  patch(name: string, oldText: string, newText: string): SkillInfo
  /** Writes a support file under the skill directory. */
  writeFile(name: string, path: string, content: string): void
  /** Removes a support file; `SKILL.md` itself is never removed. */
  removeFile(name: string, path: string): boolean
  /** Deletes an owner skill. Built-in skills are refused. */
  remove(name: string): void
  /** Copies or refreshes the shipped skills in the catalog. */
  syncBuiltins(): void
  /** Marks a skill used (skill_view) without a full read. */
  touch(name: string): void
  /** Deterministic curator pass; see `createCurator` in curator.ts. */
  setMeta(name: string, meta: SkillMeta): void
}

/** One review's evidence of what it has read; never shared between reviews. */
export interface ReadTracker {
  mark(name: string): void
  has(name: string): boolean
}

export function createReadTracker(): ReadTracker {
  const seen = new Set<string>()
  return {
    mark(name: string): void {
      seen.add(name)
    },
    has(name: string): boolean {
      return seen.has(name)
    },
  }
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function truncate(text: string, limit: number): string {
  return Array.from(text.trim()).slice(0, limit).join('')
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const normalized = normalizeNewlines(text).replace(/^\uFEFF/, '')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (match === null) throw new Error('SKILL.md must start with a --- frontmatter block')
  return { frontmatter: match[1] as string, body: normalized.slice((match[0] as string).length) }
}

/** The line reader of the strict format: one top-level `name:` and `description:` line each. */
function parseFrontmatter(text: string): { name: string; description: string; body: string; frontmatter: string } {
  const { frontmatter, body } = splitFrontmatter(text)
  const name: string[] = []
  const description: string[] = []
  for (const line of frontmatter.split('\n')) {
    const field = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (field === null) continue
    const key = field[1] as string
    const value = (field[2] as string).trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    if (key === 'name') name.push(value)
    if (key === 'description') description.push(value)
  }
  if (name.length !== 1) throw new Error('frontmatter must contain exactly one name')
  if (description.length !== 1) throw new Error('frontmatter must contain exactly one description')
  return { name: name[0] as string, description: description[0] as string, body, frontmatter }
}

/** The YAML reader of the Agent Skills format used by imported skills. */
function parseStandardFrontmatter(text: string): { name: string; description: string } {
  const root = parseYamlDocument(splitFrontmatter(text).frontmatter)
  const field = (key: 'name' | 'description'): string => {
    if (!Object.prototype.hasOwnProperty.call(root, key)) throw new Error(`frontmatter must contain exactly one ${key}`)
    const value = root[key]
    if (typeof value !== 'string') throw new Error(`frontmatter ${key} must be a string`)
    // A block scalar ends with its line break; that break is YAML syntax, not text.
    return value.replace(/\n+$/, '')
  }
  return { name: field('name'), description: field('description') }
}

function hasSection(body: string, section: string): boolean {
  return new RegExp(`^#{1,6}\\s*${section}\\s*$`, 'im').test(body)
}

// --- the YAML of a skill frontmatter --------------------------------------------
//
// No declared dependency of this package parses YAML, and other tools write the
// frontmatter of an imported skill in any YAML style: comments, quoted and
// multi-line scalars, block scalars (| and >), block and flow collections, the
// one-line JSON-like metadata of OpenClaw:
//
//   name: wb-report # report skill
//   description: >
//     Folded text of up to 1024 characters.
//   metadata: {"openclaw": {"requires": {"bins": ["rg", "sh"]}}}
//
// This parser builds mappings, sequences and string scalars. It resolves no
// types and no aliases, drops tags and anchors, and throws on a malformed
// document; the requirements reader below only looks at the known keys.

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue }

/** The flow collection or quoted scalar continues on the next line. */
class YamlIncomplete extends Error {}

const YAML_DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: '\u2028',
  P: '\u2029',
}

const YAML_BLOCK_KEY_RE =
  /^("(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s#'"[\]{},&*!|>%@`-](?:[^:#\n]|:(?=\S)|(?<=\S)#)*?)[ \t]*:(?=[ \t]|$)/

function setYamlKey(target: Record<string, YamlValue>, key: string, value: YamlValue): void {
  if (Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`frontmatter repeats the key "${key}"`)
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

function unescapeYamlDouble(text: string): string {
  return text.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (_all, escape: string) => {
    if (escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
    const mapped = YAML_DOUBLE_QUOTE_ESCAPES[escape]
    if (mapped === undefined) throw new Error(`frontmatter has an unknown escape \\${escape}`)
    return mapped
  })
}

/** Folds the lines of a flow scalar: one line break is a space, each empty line a newline. */
function foldYamlLines(lines: readonly string[]): string {
  let out = lines[0] ?? ''
  let empty = 0
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (line === '' && index < lines.length - 1) {
      empty += 1
      continue
    }
    out += empty === 0 ? ' ' : '\n'.repeat(empty)
    out += line
    empty = 0
  }
  return out
}

function foldYamlQuoted(raw: string, double: boolean): string {
  const lines = raw.split('\n').map((line, index, all) => {
    let next = index === 0 ? line : line.replace(/^[ \t]+/, '')
    if (index < all.length - 1) next = next.replace(/[ \t]+$/, '')
    return next
  })
  if (double) {
    // An odd backslash at the end of a line escapes the line break itself.
    for (let index = lines.length - 2; index >= 0; index -= 1) {
      const line = lines[index] as string
      if (/(?:^|[^\\])(?:\\\\)*\\$/.test(line)) lines.splice(index, 2, line.slice(0, -1) + (lines[index + 1] as string))
    }
  }
  const folded = foldYamlLines(lines)
  return double ? unescapeYamlDouble(folded) : folded.replace(/''/g, "'")
}

/** Index of the quote closing the scalar opened at `start`, or undefined when the text ends first. */
function closingYamlQuote(source: string, start: number): number | undefined {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (quote === '"' && char === '\\') {
      index += 2
      continue
    }
    if (char === quote) {
      if (quote === "'" && source[index + 1] === "'") {
        index += 2
        continue
      }
      return index
    }
    index += 1
  }
  return undefined
}

function parseYamlFlow(source: string): { value: YamlValue; end: number } {
  let pos = 0
  const fail = (message: string): never => {
    throw new Error(`frontmatter flow collection: ${message}`)
  }
  const skip = (): void => {
    while (pos < source.length) {
      const char = source[pos] as string
      if (char === ' ' || char === '\t' || char === '\n') {
        pos += 1
        continue
      }
      if (char === '#' && (pos === 0 || /\s/.test(source[pos - 1] as string))) {
        const newline = source.indexOf('\n', pos)
        pos = newline === -1 ? source.length : newline
        continue
      }
      break
    }
    if (pos >= source.length) throw new YamlIncomplete()
  }
  const quoted = (): string => {
    const end = closingYamlQuote(source, pos)
    if (end === undefined) throw new YamlIncomplete()
    const value = foldYamlQuoted(source.slice(pos + 1, end), source[pos] === '"')
    pos = end + 1
    return value
  }
  const plain = (): string => {
    const start = pos
    while (pos < source.length) {
      const char = source[pos] as string
      if (',[]{}'.includes(char)) break
      if (char === ':' && (pos + 1 >= source.length || /[\s,[\]{}]/.test(source[pos + 1] as string))) break
      if (char === '#' && /\s/.test(source[pos - 1] ?? ' ')) break
      pos += 1
    }
    if (pos >= source.length) throw new YamlIncomplete()
    return foldYamlLines(source.slice(start, pos).trim().split('\n').map((line) => line.trim()))
  }
  const scalar = (): string => (source[pos] === '"' || source[pos] === "'" ? quoted() : plain())
  const node = (): YamlValue => {
    skip()
    while (source[pos] === '!' || source[pos] === '&') {
      while (pos < source.length && !/[\s,[\]{}]/.test(source[pos] as string)) pos += 1
      skip()
    }
    if (source[pos] === '*') fail('aliases are not supported')
    if (source[pos] === '[') return sequence()
    if (source[pos] === '{') return mapping()
    return scalar()
  }
  const pairValue = (): YamlValue => {
    skip()
    if (source[pos] !== ':') return ''
    pos += 1
    skip()
    if (source[pos] === ',' || source[pos] === '}' || source[pos] === ']') return ''
    return node()
  }
  const mapping = (): Record<string, YamlValue> => {
    pos += 1
    const result: Record<string, YamlValue> = {}
    for (;;) {
      skip()
      if (source[pos] === '}') break
      const key = source[pos] === '[' || source[pos] === '{' ? fail('a collection cannot be a key') : scalar()
      setYamlKey(result, key, pairValue())
      skip()
      if (source[pos] === ',') {
        pos += 1
        continue
      }
      if (source[pos] !== '}') fail(`unexpected "${source[pos]}" in a mapping`)
    }
    pos += 1
    return result
  }
  const sequence = (): YamlValue[] => {
    pos += 1
    const result: YamlValue[] = []
    for (;;) {
      skip()
      if (source[pos] === ']') break
      const item = node()
      skip()
      if (source[pos] === ':' && typeof item === 'string') {
        const pair: Record<string, YamlValue> = {}
        setYamlKey(pair, item, pairValue())
        result.push(pair)
        skip()
      } else {
        result.push(item)
      }
      if (source[pos] === ',') {
        pos += 1
        continue
      }
      if (source[pos] !== ']') fail(`unexpected "${source[pos]}" in a sequence`)
    }
    pos += 1
    return result
  }
  const value = node()
  return { value, end: pos }
}

function foldYamlBlock(lines: readonly string[]): string {
  let out = ''
  let previous: 'none' | 'normal' | 'indented' = 'none'
  let empty = 0
  for (const line of lines) {
    if (line === '') {
      empty += 1
      continue
    }
    const indented = /^[ \t]/.test(line)
    if (previous === 'none') out += '\n'.repeat(empty)
    else if (previous === 'normal' && !indented) out += empty === 0 ? ' ' : '\n'.repeat(empty)
    else out += '\n'.repeat(empty + 1)
    out += line
    previous = indented ? 'indented' : 'normal'
    empty = 0
  }
  return out
}

function isYamlSequenceLine(text: string): boolean {
  return /^-(?:[ \t]|$)/.test(text)
}

/** Parses a frontmatter block into its root mapping; throws on a malformed document. */
export function parseYamlDocument(source: string): Record<string, YamlValue> {
  const lines = source.split('\n')
  let index = 0

  const indentOf = (line: string): number => {
    const indent = line.length - line.replace(/^ +/, '').length
    if (line[indent] === '\t') throw new Error('frontmatter must be indented with spaces')
    return indent
  }

  const nextContent = (): number | undefined => {
    let probe = index
    while (probe < lines.length) {
      const text = (lines[probe] as string).trim()
      if (text !== '' && !text.startsWith('#')) return probe
      probe += 1
    }
    return undefined
  }

  const continueOnNextLine = (source: string): string => {
    if (index >= lines.length) throw new Error('frontmatter ends inside a quoted value or flow collection')
    const next = `${source}\n${lines[index] as string}`
    index += 1
    return next
  }

  const checkTail = (tail: string): void => {
    const rest = tail.trim()
    if (rest !== '' && !(rest.startsWith('#') && /^\s/.test(tail))) throw new Error(`unexpected text "${rest}" in frontmatter`)
  }

  const flowValue = (text: string): YamlValue => {
    let source = text
    for (;;) {
      try {
        const parsed = parseYamlFlow(source)
        checkTail(source.slice(parsed.end))
        return parsed.value
      } catch (error) {
        if (!(error instanceof YamlIncomplete)) throw error
        source = continueOnNextLine(source)
      }
    }
  }

  const quotedValue = (text: string): string => {
    let source = text
    for (;;) {
      const end = closingYamlQuote(source, 0)
      if (end !== undefined) {
        checkTail(source.slice(end + 1))
        return foldYamlQuoted(source.slice(1, end), source[0] === '"')
      }
      source = continueOnNextLine(source)
    }
  }

  const plainValue = (first: string, parent: number): string => {
    const comment = /(?:^|[ \t])#/
    const head = comment.exec(first)
    const parts = [(head === null ? first : first.slice(0, head.index)).trim()]
    if (head !== null) return parts[0] as string
    const empty: string[] = []
    while (index < lines.length) {
      const line = lines[index] as string
      if (line.trim() === '') {
        empty.push('')
        index += 1
        continue
      }
      if (indentOf(line) <= parent || line.trim().startsWith('#')) break
      const match = comment.exec(line)
      parts.push(...empty, (match === null ? line : line.slice(0, match.index)).trim())
      empty.length = 0
      index += 1
      if (match !== null) break
    }
    return foldYamlLines(parts)
  }

  const blockScalar = (header: string, parent: number): string => {
    const match = /^([|>])(?:([1-9])([-+])?|([-+])([1-9])?)?(?:[ \t]+#.*)?[ \t]*$/.exec(header)
    if (match === null) throw new Error(`cannot read the block scalar header "${header}"`)
    const explicit = match[2] ?? match[5]
    const chomp = match[3] ?? match[4] ?? ''
    let contentIndent = explicit === undefined ? undefined : parent + Number(explicit)
    const body: string[] = []
    while (index < lines.length) {
      const line = lines[index] as string
      if (line.trim() === '') {
        body.push('')
        index += 1
        continue
      }
      const indent = line.length - line.replace(/^ +/, '').length
      if (contentIndent === undefined) {
        if (indent <= parent) break
        contentIndent = indent
      }
      if (indent < contentIndent) break
      body.push(line.slice(contentIndent))
      index += 1
    }
    let end = body.length
    while (end > 0 && body[end - 1] === '') end -= 1
    const kept = body.slice(0, end)
    const trailing = body.length - end
    if (kept.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : ''
    const text = match[1] === '>' ? foldYamlBlock(kept) : kept.join('\n')
    if (chomp === '-') return text
    return chomp === '+' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`
  }

  const blockValue = (rest: string, parent: number, keyed: boolean): YamlValue => {
    let text = rest.trim()
    // Tags and anchors decorate a node; this parser keeps only the node.
    while (/^[!&]\S*(?:\s|$)/.test(text)) text = text.replace(/^[!&]\S*\s*/, '')
    if (text === '' || text.startsWith('#')) {
      const probe = nextContent()
      if (probe === undefined) return ''
      const line = lines[probe] as string
      const indent = indentOf(line)
      if (indent > parent || (keyed && indent === parent && isYamlSequenceLine(line.slice(indent)))) {
        index = probe
        return blockNode(indent)
      }
      return ''
    }
    if (text.startsWith('*')) throw new Error('frontmatter aliases are not supported')
    if (text.startsWith('|') || text.startsWith('>')) return blockScalar(text, parent)
    if (text.startsWith('[') || text.startsWith('{')) return flowValue(text)
    if (text.startsWith('"') || text.startsWith("'")) return quotedValue(text)
    return plainValue(text, parent)
  }

  const blockMapping = (indent: number): Record<string, YamlValue> => {
    const result: Record<string, YamlValue> = {}
    for (;;) {
      const probe = nextContent()
      if (probe === undefined) break
      const line = lines[probe] as string
      if (indentOf(line) !== indent) break
      const text = line.slice(indent)
      if (isYamlSequenceLine(text)) break
      const match = YAML_BLOCK_KEY_RE.exec(text)
      if (match === null) throw new Error(`cannot read the frontmatter line "${text.trim()}"`)
      const raw = match[1] as string
      const key = raw.startsWith('"') || raw.startsWith("'") ? foldYamlQuoted(raw.slice(1, -1), raw.startsWith('"')) : raw.trim()
      index = probe + 1
      setYamlKey(result, key, blockValue(text.slice(match[0].length), indent, true))
    }
    return result
  }

  const blockSequence = (indent: number): YamlValue[] => {
    const result: YamlValue[] = []
    for (;;) {
      const probe = nextContent()
      if (probe === undefined) break
      const line = lines[probe] as string
      if (indentOf(line) !== indent || !isYamlSequenceLine(line.slice(indent))) break
      const after = line.slice(indent + 1)
      const item = after.trimStart()
      index = probe
      if (item === '' || item.startsWith('#')) {
        index += 1
        result.push(blockValue('', indent, false))
        continue
      }
      // The item is a node of its own at the column after the dash.
      const column = indent + 1 + after.length - item.length
      lines[index] = ' '.repeat(column) + item
      result.push(blockNode(column))
    }
    return result
  }

  function blockNode(indent: number): YamlValue {
    const text = (lines[index] as string).slice(indent)
    if (isYamlSequenceLine(text)) return blockSequence(indent)
    if (YAML_BLOCK_KEY_RE.test(text)) return blockMapping(indent)
    index += 1
    return blockValue(text, indent - 1, false)
  }

  const first = nextContent()
  if (first === undefined) return {}
  index = first
  const root = blockNode(indentOf(lines[first] as string))
  if (nextContent() !== undefined) throw new Error('frontmatter has a line with unexpected indentation')
  if (typeof root !== 'object' || Array.isArray(root)) throw new Error('frontmatter must be a mapping of keys')
  return root
}

function yamlObject(value: YamlValue | undefined): Record<string, YamlValue> {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function yamlStrings(value: YamlValue | undefined): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item !== '') {
      result.push(item)
      continue
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const candidate = item.name ?? item.key ?? item.variable
      if (typeof candidate === 'string' && candidate !== '') result.push(candidate)
    }
  }
  return result
}

/** Commands and environment variables a foreign skill asks for. */
export interface SkillRequirements {
  /** Commands that must all exist in PATH (OpenClaw `bins`, Hermes `prerequisites.commands`). */
  bins: string[]
  /** Commands of which at least one must exist (OpenClaw `anyBins`); each absent one is still reported. */
  anyBins: string[]
  /** Names the `exec` secrets argument should provide. */
  env: string[]
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Requirements declared by OpenClaw and Hermes frontmatter; never throws on a broken document. */
export function skillRequirements(content: string): SkillRequirements {
  let root: Record<string, YamlValue>
  try {
    root = parseYamlDocument(splitFrontmatter(content).frontmatter)
  } catch {
    return { bins: [], anyBins: [], env: [] }
  }
  const metadata = yamlObject(root.metadata)
  const openclaw = yamlObject(metadata.openclaw)
  const requires = yamlObject(openclaw.requires)
  const prerequisites = yamlObject(root.prerequisites)
  const primaryEnv = openclaw.primaryEnv
  return {
    bins: uniqueStrings([...yamlStrings(requires.bins), ...yamlStrings(prerequisites.commands)]),
    anyBins: uniqueStrings(yamlStrings(requires.anyBins)),
    env: uniqueStrings([
      ...yamlStrings(requires.env),
      ...(typeof primaryEnv === 'string' && primaryEnv !== '' ? [primaryEnv] : []),
      ...yamlStrings(root.required_environment_variables),
      ...yamlStrings(prerequisites.env_vars),
    ]),
  }
}

/** Whether `command` is an executable file in PATH. */
export function commandInPath(command: string, pathValue: string | undefined = process.env.PATH): boolean {
  if (command === '' || /[\\/\s]/.test(command)) return false
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : ['']
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const extension of extensions) {
      try {
        const candidate = join(dir, `${command}${extension}`)
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        // Not this directory: keep looking.
      }
    }
  }
  return false
}

/** Replace the OpenClaw and Hermes skill-directory placeholders without writing the file. */
export function expandSkillPaths(text: string, baseDir: string): string {
  return text.split(SKILL_BASE_DIR_TOKEN).join(baseDir).split(HERMES_SKILL_DIR_TOKEN).join(baseDir)
}

/** Reads `name` and `description` from a SKILL.md without validating the rest. */
export function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const parsed = parseFrontmatter(content)
  return { name: parsed.name, description: parsed.description }
}

/** Validates one complete SKILL.md document and returns its metadata fields. */
export function validateSkillDocument(name: string, content: string): { name: string; description: string } {
  validateSkillName(name)
  const parsed = parseFrontmatter(content)
  if (parsed.name !== name) {
    throw new Error(`frontmatter name "${parsed.name}" does not match the skill "${name}"`)
  }
  if (codePointLength(parsed.name) > SKILL_NAME_LIMIT) {
    throw new Error(`skill name is longer than ${SKILL_NAME_LIMIT} characters`)
  }
  if (parsed.description === '') throw new Error('frontmatter description must not be empty')
  if (codePointLength(parsed.description) > SKILL_DESCRIPTION_LIMIT) {
    throw new Error(`skill description is longer than ${SKILL_DESCRIPTION_LIMIT} characters`)
  }
  for (const section of REQUIRED_SKILL_SECTIONS) {
    if (!hasSection(parsed.body, section)) {
      throw new Error(`SKILL.md must contain the "${section}" section`)
    }
  }
  return parsed
}

/** Name rule of the Agent Skills format: lowercase letters, digits and single dashes, up to 64 characters. */
export function validateImportedSkillName(name: string): void {
  if (typeof name !== 'string' || !IMPORTED_SKILL_NAME_RE.test(name)) {
    throw new Error('imported skill name may contain only lowercase letters, digits and single dashes')
  }
  if (codePointLength(name) > IMPORTED_SKILL_NAME_LIMIT) {
    throw new Error(`imported skill name is longer than ${IMPORTED_SKILL_NAME_LIMIT} characters`)
  }
}

/** Validates an imported skill in the Agent Skills format; the body is free-form. */
export function validateImportedSkillDocument(name: string, content: string): { name: string; description: string } {
  validateImportedSkillName(name)
  const parsed = parseStandardFrontmatter(content)
  if (parsed.name !== name) {
    throw new Error(`frontmatter name "${parsed.name}" does not match the skill "${name}"`)
  }
  validateImportedSkillName(parsed.name)
  if (parsed.description.trim() === '') throw new Error('frontmatter description must not be empty')
  if (codePointLength(parsed.description) > IMPORTED_SKILL_DESCRIPTION_LIMIT) {
    throw new Error(`imported skill description is longer than ${IMPORTED_SKILL_DESCRIPTION_LIMIT} characters`)
  }
  return parsed
}

/** A skill name is exactly one safe path segment. */
export function validateSkillName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('skill name must be a non-empty string')
  if (name !== name.trim()) throw new Error('skill name must not have surrounding whitespace')
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error('skill name may contain only letters, digits, dot, dash and underscore')
  }
  if (codePointLength(name) > SKILL_NAME_LIMIT) throw new Error(`skill name is longer than ${SKILL_NAME_LIMIT} characters`)
}

function atomicWrite(path: string, content: string): void {
  const temp = join(dirname(path), `.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o666 })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temporary file may not exist.
    }
    throw error
  }
}

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  const now = options.now ?? (() => Date.now())
  const dir = resolve(options.home, SKILLS_DIR)

  /**
   * A name is one safe path segment before the rule of its origin runs: an
   * imported skill may use the longer standard name, everything else stays at
   * the strict limit. The origin lives in `.meta.json`, so the raw directory is
   * resolved first and validated against the metadata afterwards.
   */
  const rawSkillDir = (name: string): string => {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('skill name must be a non-empty string')
    if (name !== name.trim()) throw new Error('skill name must not have surrounding whitespace')
    if (name === '.' || name === '..' || name.startsWith('.')) throw new Error('skill name must be one path segment')
    if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
      throw new Error('skill name must be one path segment')
    }
    return join(dir, name)
  }

  const rawSkillFile = (name: string): string => join(rawSkillDir(name), SKILL_FILE)

  /** Applies the linter of the origin to the name; returns the directory when it passes. */
  const validateNameForOrigin = (name: string, meta: SkillMeta): void => {
    if (meta.imported === true) validateImportedSkillName(name)
    else validateSkillName(name)
  }

  const skillDir = (name: string): string => {
    const target = rawSkillDir(name)
    validateNameForOrigin(name, readMeta(name))
    return target
  }

  const skillFile = (name: string): string => join(skillDir(name), SKILL_FILE)

  const readMeta = (name: string): SkillMeta => {
    const metaFile = join(rawSkillDir(name), SKILL_META_FILE)
    if (existsSync(metaFile)) {
      try {
        const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<SkillMeta>
        const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : now()
        const lastUsedAt = typeof parsed.lastUsedAt === 'number' ? parsed.lastUsedAt : createdAt
        return {
          createdAt,
          lastUsedAt,
          ...(parsed.stale === true ? { stale: true } : {}),
          ...(parsed.builtin === true ? { builtin: true } : {}),
          ...(parsed.imported === true ? { imported: true } : {}),
        }
      } catch {
        // A broken metadata file must not hide the skill itself.
      }
    }
    // A skill copied in from ~/.agents/skills has no metadata: its file time is
    // the best available evidence of when it was last touched.
    let createdAt = now()
    try {
      createdAt = Math.floor(statSync(rawSkillFile(name)).mtimeMs)
    } catch {
      // keep now()
    }
    return { createdAt, lastUsedAt: createdAt }
  }

  const writeMeta = (name: string, meta: SkillMeta): void => {
    const record: Partial<SkillMeta> = { createdAt: meta.createdAt, lastUsedAt: meta.lastUsedAt }
    if (meta.stale === true) record.stale = true
    if (meta.builtin === true) record.builtin = true
    if (meta.imported === true) record.imported = true
    // Origin flags are not a caller's to drop: the curator marks a skill stale
    // through setMeta and must not turn an imported skill into a bot-written
    // one or strip the read-only mark of a shipped one.
    try {
      const existing = JSON.parse(readFileSync(join(rawSkillDir(name), SKILL_META_FILE), 'utf8')) as Partial<SkillMeta>
      if (existing.builtin === true) record.builtin = true
      if (existing.imported === true) record.imported = true
    } catch {
      // No metadata yet: this write creates it.
    }
    atomicWrite(join(rawSkillDir(name), SKILL_META_FILE), `${JSON.stringify(record)}\n`)
  }

  /**
   * Drops the read-only mark of a skill that is no longer shipped. The skill
   * itself and its metadata stay: it becomes an ordinary owner skill that can
   * be read, patched and deleted like any other.
   */
  const clearBuiltinMark = (name: string): void => {
    const meta = readMeta(name)
    const record: Partial<SkillMeta> = { createdAt: meta.createdAt, lastUsedAt: meta.lastUsedAt }
    if (meta.stale === true) record.stale = true
    if (meta.imported === true) record.imported = true
    atomicWrite(join(rawSkillDir(name), SKILL_META_FILE), `${JSON.stringify(record)}\n`)
  }

  const setMeta = (name: string, meta: SkillMeta): void => writeMeta(name, meta)

  /** A built-in skill is read-only for every tool of the owner and the review. */
  const assertNotBuiltin = (name: string, action: string): void => {
    if (readMeta(name).builtin === true) {
      throw new Error(`встроенный навык "${name}" нельзя ${action}: он поставляется с демоном`)
    }
  }

  const touch = (name: string): void => {
    const meta = readMeta(name)
    writeMeta(name, {
      createdAt: meta.createdAt,
      lastUsedAt: now(),
      ...(meta.builtin === true ? { builtin: true } : {}),
      ...(meta.imported === true ? { imported: true } : {}),
    })
  }

  // Parsed SKILL.md documents of the library, keyed by name. The index of the
  // skills rides in the tail of owner turns, so it is composed before many
  // turns; a document whose file is unchanged (same inode, change and modify
  // time, same size) is served from here instead of being read and parsed
  // again. A touch of `.meta.json` never enters this cache: the metadata is
  // always read fresh, because `stale` and `lastUsedAt` change without a write
  // to SKILL.md.
  interface SkillContentEntry {
    ino: number
    mtimeMs: number
    ctimeMs: number
    size: number
    /** The document passes the strict linter of a bot-written skill. */
    strictValid: boolean
    /** The document passes the Agent Skills linter of an imported skill. */
    importedValid: boolean
    description: string
    /** The YAML description of the Agent Skills format, folded into one line. */
    importedDescription: string
  }
  const contentCache = new Map<string, SkillContentEntry>()

  /** The parsed content of one SKILL.md, re-read only when its file changed. */
  const skillContent = (name: string): SkillContentEntry | undefined => {
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(rawSkillFile(name))
    } catch {
      contentCache.delete(name)
      return undefined
    }
    const cached = contentCache.get(name)
    if (
      cached !== undefined &&
      cached.ino === stats.ino &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.ctimeMs === stats.ctimeMs &&
      cached.size === stats.size
    ) {
      return cached
    }
    const entry: SkillContentEntry = {
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      size: stats.size,
      strictValid: false,
      importedValid: false,
      description: '',
      importedDescription: '',
    }
    const text = readFileSync(rawSkillFile(name), 'utf8')
    try {
      const parsed = validateSkillDocument(name, text)
      entry.strictValid = true
      entry.description = parsed.description
    } catch {
      // A malformed document is cached as invalid: it is not a skill of the
      // index and re-reading it on every turn would not change that.
    }
    try {
      const parsed = validateImportedSkillDocument(name, text)
      entry.importedValid = true
      entry.importedDescription = parsed.description.replace(/\s+/g, ' ').trim()
    } catch {
      // Not an Agent Skills document either; the caller decides by the flag.
    }
    contentCache.set(name, entry)
    return entry
  }

  /** A skill passes when the linter of its origin accepts the document. */
  const validFor = (content: SkillContentEntry, meta: SkillMeta): boolean =>
    meta.imported === true ? content.importedValid : content.strictValid

  const descriptionFor = (content: SkillContentEntry, meta: SkillMeta): string =>
    meta.imported === true ? content.importedDescription : content.description

  const inspect = (name: string): SkillInfo | undefined => {
    try {
      rawSkillDir(name)
      const content = skillContent(name)
      if (content === undefined) return undefined
      const meta = readMeta(name)
      validateNameForOrigin(name, meta)
      if (!validFor(content, meta)) return undefined
      return {
        name,
        description: descriptionFor(content, meta),
        createdAt: meta.createdAt,
        lastUsedAt: meta.lastUsedAt,
        stale: meta.stale === true,
        builtin: meta.builtin === true,
        imported: meta.imported === true,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Directory entries of the library that may hold a skill, unsorted. A skill
   * removed or archived between two calls also leaves the content cache, so a
   * re-created skill of the same name is parsed again.
   */
  const skillNames = (): string[] => {
    if (!existsSync(dir)) {
      contentCache.clear()
      return []
    }
    const names: string[] = []
    const seen = new Set<string>()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      seen.add(entry.name)
      names.push(entry.name)
    }
    for (const name of contentCache.keys()) {
      if (!seen.has(name)) contentCache.delete(name)
    }
    return names
  }

  const list = (): SkillInfo[] => {
    const found: SkillInfo[] = []
    for (const name of skillNames()) {
      const info = inspect(name)
      if (info !== undefined) found.push(info)
    }
    return found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }

  /**
   * The index of the tail of an owner turn. A document whose file is unchanged
   * is served from the cache, so only `.meta.json` (the origin flag and the
   * cheap timestamps) is read again; the description of an imported skill is
   * cut by the same 60-character rule as that of a bot-written one.
   */
  const indexLines = (): string[] => {
    const lines: string[] = []
    for (const name of skillNames().sort()) {
      let content: SkillContentEntry | undefined
      let meta: SkillMeta
      try {
        meta = readMeta(name)
        validateNameForOrigin(name, meta)
        content = skillContent(name)
      } catch {
        continue
      }
      if (content === undefined) continue
      if (!validFor(content, meta)) continue
      const description = truncate(descriptionFor(content, meta), SKILL_DESCRIPTION_LIMIT)
      lines.push(description === '' ? `- ${name}` : `- ${name} — ${description}`)
    }
    return lines
  }

  const read = (name: string): string => {
    const content = readFileSync(skillFile(name), 'utf8')
    touch(name)
    return content
  }

  /** Absolute path of one file, checked against the skill directory (no `..`, no absolute, no symlink escape). */
  const readPath = (name: string, path: string): string => {
    if (typeof path !== 'string' || path.trim() === '') throw new Error('file path must be a non-empty string')
    if (isAbsolute(path)) throw new Error('file path must be relative to the skill directory')
    if (path.split(/[\\/]/).includes('..')) throw new Error('file path must not escape the skill directory')
    const base = skillDir(name)
    const target = resolve(base, path)
    if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('file path escapes the skill directory')
    return target
  }

  const readFile = (name: string, path: string): string => {
    const target = readPath(name, path)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(target)
    } catch {
      throw new Error(`file "${path}" was not found in skill "${name}"`)
    }
    if (!stats.isFile()) throw new Error(`"${path}" is not a file of skill "${name}"`)
    // A symlink inside the skill directory must not read the outside world.
    try {
      const base = realpathSync(skillDir(name))
      const actual = realpathSync(target)
      if (actual !== base && !actual.startsWith(`${base}${sep}`)) {
        throw new Error('file path escapes the skill directory')
      }
    } catch (error) {
      if (error instanceof Error && /escapes the skill directory/.test(error.message)) throw error
      throw new Error(`file "${path}" cannot be read inside skill "${name}"`)
    }
    return readFileSync(target, 'utf8')
  }

  const listFiles = (name: string): string[] => {
    const base = skillDir(name)
    const found: string[] = []
    const walk = (at: string, prefix: string, depth: number): void => {
      if (depth > 16) return
      let entries: Dirent[]
      try {
        entries = readdirSync(at, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) {
          walk(join(at, entry.name), relative, depth + 1)
        } else if (entry.isFile() && relative !== SKILL_FILE) {
          found.push(relative)
        }
      }
    }
    walk(base, '', 0)
    return found.sort()
  }

  const create = (name: string, content: string): SkillInfo => {
    validateSkillDocument(name, content)
    const targetDir = skillDir(name)
    if (existsSync(targetDir)) {
      if (readMeta(name).builtin === true) {
        throw new Error(`встроенный навык "${name}" нельзя перезаписать: он поставляется с демоном`)
      }
      throw new Error(`skill "${name}" already exists`)
    }
    mkdirSync(targetDir, { recursive: true })
    const createdAt = now()
    atomicWrite(join(targetDir, SKILL_FILE), normalizeNewlines(content))
    contentCache.delete(name)
    writeMeta(name, { createdAt, lastUsedAt: createdAt })
    const parsed = validateSkillDocument(name, readFileSync(join(targetDir, SKILL_FILE), 'utf8'))
    return {
      name,
      description: parsed.description,
      createdAt,
      lastUsedAt: createdAt,
      stale: false,
      builtin: false,
      imported: false,
    }
  }

  const patch = (name: string, oldText: string, newText: string): SkillInfo => {
    if (typeof oldText !== 'string' || oldText === '') throw new Error('old_string must be a non-empty string')
    const file = skillFile(name)
    if (!existsSync(file)) throw new Error(`skill "${name}" does not exist`)
    assertNotBuiltin(name, 'изменить')
    const meta = readMeta(name)
    const before = normalizeNewlines(readFileSync(file, 'utf8'))
    const occurrences = before.split(oldText).length - 1
    if (occurrences === 0) throw new Error('old_string was not found in SKILL.md')
    if (occurrences > 1) throw new Error('old_string occurs more than once; the patch must be unambiguous')
    // A function replacement keeps `$&`, `$1` and similar sequences literal.
    const next = before.replace(oldText, () => newText)
    // An imported skill keeps the linter that accepted it at import time: the
    // origin lives in `.meta.json`, not in the document, so replacing the text
    // must not turn it into a bot-written skill or tighten the rules. Everything
    // else (owner and built-in skills) stays strict.
    const parsed =
      meta.imported === true ? validateImportedSkillDocument(name, next) : validateSkillDocument(name, next)
    atomicWrite(file, next)
    contentCache.delete(name)
    const lastUsedAt = now()
    writeMeta(name, { createdAt: meta.createdAt, lastUsedAt })
    return {
      name,
      description: parsed.description,
      createdAt: meta.createdAt,
      lastUsedAt,
      stale: false,
      builtin: meta.builtin === true,
      imported: meta.imported === true,
    }
  }

  const supportPath = (name: string, path: string): string => {
    const target = readPath(name, path)
    if (target === join(skillDir(name), SKILL_FILE)) {
      throw new Error('SKILL.md itself is changed through create/patch')
    }
    return target
  }

  const writeFile = (name: string, path: string, content: string): void => {
    const target = supportPath(name, path)
    if (typeof content !== 'string') throw new Error('content must be a string')
    if (!existsSync(skillFile(name))) throw new Error(`skill "${name}" does not exist`)
    assertNotBuiltin(name, 'изменить')
    mkdirSync(dirname(target), { recursive: true })
    atomicWrite(target, content)
    touch(name)
  }

  const removeFile = (name: string, path: string): boolean => {
    const target = supportPath(name, path)
    if (!existsSync(target)) return false
    assertNotBuiltin(name, 'изменить')
    unlinkSync(target)
    touch(name)
    return true
  }

  const remove = (name: string): void => {
    const targetDir = skillDir(name)
    if (!existsSync(skillFile(name))) throw new Error(`skill "${name}" does not exist`)
    assertNotBuiltin(name, 'удалить')
    rmSync(targetDir, { recursive: true, force: true })
    contentCache.delete(name)
  }

  /** Copies the shipped skills into the catalog; a built-in document is refreshed, an owner skill is kept. */
  const syncBuiltins = (): void => {
    const builtinDir = options.builtinDir
    if (builtinDir === undefined || !existsSync(builtinDir)) return
    const shipped = new Set<string>()
    for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      shipped.add(entry.name)
      const source = join(builtinDir, entry.name, SKILL_FILE)
      if (!existsSync(source)) continue
      let content: string
      try {
        content = normalizeNewlines(readFileSync(source, 'utf8'))
        validateSkillDocument(entry.name, content)
      } catch {
        // A malformed shipped document must not block the daemon or hide the catalog.
        continue
      }
      const targetDir = join(dir, entry.name)
      const target = join(targetDir, SKILL_FILE)
      const meta = existsSync(targetDir) ? readMeta(entry.name) : undefined
      if (meta !== undefined && meta.builtin !== true) continue
      const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined
      if (current !== content) {
        mkdirSync(targetDir, { recursive: true })
        atomicWrite(target, content)
        contentCache.delete(entry.name)
      }
      if (meta === undefined) writeMeta(entry.name, { createdAt: now(), lastUsedAt: now(), builtin: true })
    }
    // A skill that an earlier shipment copied into the catalog stays with the
    // owner when the current shipment no longer carries it: only the read-only
    // mark is dropped, never the document.
    let ownerEntries: Dirent[]
    try {
      ownerEntries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of ownerEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || shipped.has(entry.name)) continue
      if (readMeta(entry.name).builtin !== true) continue
      if (!existsSync(join(dir, entry.name, SKILL_FILE))) continue
      clearBuiltinMark(entry.name)
    }
  }

  syncBuiltins()

  return {
    dir,
    list,
    indexLines,
    skillDir,
    read,
    readFile,
    listFiles,
    create,
    patch,
    writeFile,
    removeFile,
    remove,
    syncBuiltins,
    touch,
    setMeta,
  }
}

/** Model-facing names of the skill tools. */
export const SKILL_TOOL_NAMES = ['skill_manage', 'skill_view', 'skills_list'] as const

function manageSchema(allowDelete: boolean): Record<string, unknown> {
  const actions = allowDelete
    ? ['create', 'patch', 'write_file', 'remove_file', 'delete']
    : ['create', 'patch', 'write_file', 'remove_file']
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: actions,
        description:
          'create — new skill, patch — replace text in SKILL.md, write_file/remove_file — support file, ' +
          'delete — remove an owner skill.',
      },
      name: { type: 'string', description: 'Skill name, one path segment.' },
      content: { type: 'string', description: 'Full SKILL.md for create, or support file content for write_file.' },
      old_string: { type: 'string', description: 'Exact text to replace for patch.' },
      new_string: { type: 'string', description: 'Replacement text for patch.' },
      path: { type: 'string', description: 'Support file path relative to the skill directory.' },
    },
    required: ['action', 'name'],
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value === '') throw new Error(`${key} is required and must be a non-empty string`)
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** Where the owner tools write and why a hand-written file is not the catalog. */
const OWNER_CATALOG_HINT =
  'The owner catalog is the one skills directory of the daemon. Use skill_manage instead of writing files by ' +
  'hand: a SKILL.md written with edit/exec into the workspace `.agents/skills` is not the catalog; the daemon ' +
  'warns about it in the turn and only skill_manage makes the skill visible to skills_list and the next turn.'

export interface SkillToolOptions {
  /**
   * The review requires skill_view(name) in the same review before any write;
   * the owner tool manages its own catalog directly.
   */
  readBeforeWrite?: boolean
  /** The owner may delete a skill; the background review never deletes. */
  allowDelete?: boolean
  /** Say where the owner catalog is and that `.agents/skills` is not it. */
  ownerCatalog?: boolean
  /**
   * Names in the secret vault of the owner. `skill_view` marks each environment
   * variable a skill asks for as present or missing without ever reading a value.
   */
  secretNames?: () => readonly string[]
}

/**
 * The three skill tools. For a review `tracker` is fresh per review, so a patch
 * is only accepted after `skill_view` in the same review, exactly as the Hermes
 * rule requires; the owner tools use a long-lived tracker and do not require
 * that ceremony for their own catalog.
 */
export function createSkillTools(
  store: SkillStore,
  tracker: ReadTracker,
  options: SkillToolOptions = {},
): RunnerTool[] {
  const readBeforeWrite = options.readBeforeWrite ?? true
  const allowDelete = options.allowDelete ?? false
  const where = options.ownerCatalog === true ? ` ${OWNER_CATALOG_HINT}` : ''
  const manage: RunnerTool = {
    name: 'skill_manage',
    description:
      'Manage the skill library. create writes a new SKILL.md (frontmatter name and description ≤ 60 characters, ' +
      'sections Procedure, Pitfalls, Verification). patch replaces one exact string in an existing SKILL.md; an ' +
      'imported skill keeps the import rules (name ≤ 64, description ≤ 1024, free-form body), any other skill keeps ' +
      'the strict rules' +
      (readBeforeWrite ? ' and requires skill_view(name) in this review first' : '') +
      '. write_file/remove_file manage support files of a skill' +
      (allowDelete ? '; delete removes an owner skill, while built-in skills are refused' : '') +
      '.' +
      where,
    inputSchema: manageSchema(allowDelete),
    execute(args) {
      const action = requiredString(args, 'action')
      const name = requiredString(args, 'name')
      if (action === 'create') {
        const content = requiredString(args, 'content')
        const info = store.create(name, content)
        return `Создан навык ${info.name}: ${info.description}`
      }
      if (action === 'patch') {
        if (readBeforeWrite && !tracker.has(name)) {
          throw new Error(`read-before-write: call skill_view("${name}") in this review before patching it`)
        }
        const oldText = requiredString(args, 'old_string')
        const newText = optionalString(args, 'new_string')
        if (newText === undefined) throw new Error('new_string is required for patch')
        const info = store.patch(name, oldText, newText)
        return `Навык ${info.name} обновлён.`
      }
      if (action === 'write_file') {
        if (readBeforeWrite && !tracker.has(name)) {
          throw new Error(`read-before-write: call skill_view("${name}") in this review before changing its files`)
        }
        const path = requiredString(args, 'path')
        const content = requiredString(args, 'content')
        store.writeFile(name, path, content)
        return `Файл ${path} навыка ${name} записан.`
      }
      if (action === 'remove_file') {
        if (readBeforeWrite && !tracker.has(name)) {
          throw new Error(`read-before-write: call skill_view("${name}") in this review before changing its files`)
        }
        const path = requiredString(args, 'path')
        const removed = store.removeFile(name, path)
        return removed ? `Файл ${path} навыка ${name} удалён.` : `Файла ${path} у навыка ${name} нет.`
      }
      if (action === 'delete') {
        if (!allowDelete) throw new Error(`unknown action: ${action}`)
        store.remove(name)
        return `Навык ${name} удалён.`
      }
      throw new Error(`unknown action: ${action}`)
    },
  }

  const view: RunnerTool = {
    name: 'skill_view',
    description:
      (readBeforeWrite
        ? 'Read one skill SKILL.md. Required before patch/write_file/remove_file of that skill in this review.'
        : 'Read one skill SKILL.md: the whole document of a skill from the owner catalog.') +
      ' Pass path (for example scripts/run.sh) to read one support file inside the skill directory instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name.' },
        path: {
          type: 'string',
          description: 'Optional support file path relative to the skill directory; never outside it.',
        },
      },
      required: ['name'],
    },
    // Reading a skill changes no skill text: the read tracker and the touch
    // stamp of its instance commute with a concurrent view of another skill.
    isConcurrencySafe: () => true,
    execute(args) {
      const name = requiredString(args, 'name')
      const path = optionalString(args, 'path')
      const base = store.skillDir(name)
      if (path !== undefined) {
        const text = store.readFile(name, path)
        tracker.mark(name)
        store.touch(name)
        return expandSkillPaths(text, base)
      }
      const content = store.read(name)
      tracker.mark(name)
      const parts = [expandSkillPaths(content, base)]
      const files = store.listFiles(name)
      if (files.length > 0) {
        parts.push('', 'Файлы навыка (пути относительно каталога навыка):', ...files.map((file) => `- ${file}`))
      }
      const requirements = skillRequirements(content)
      const lines: string[] = []
      // Every absent command gets its own line, anyBins included: an available
      // alternative does not hide the ones the skill may still call.
      const missing = uniqueStrings([...requirements.bins, ...requirements.anyBins]).filter(
        (command) => !commandInPath(command),
      )
      for (const command of missing) {
        lines.push(`- не найдено: ${command} — навык остаётся доступным, но команду придётся установить`)
      }
      const secretNames = new Set(options.secretNames?.() ?? [])
      for (const variable of requirements.env) {
        const present = secretNames.has(variable)
        lines.push(
          `- переменная ${variable}: ${present ? 'есть в хранилище секретов' : 'нет в хранилище секретов'} — ` +
            'передай имя в аргумент secrets инструмента exec',
        )
      }
      if (lines.length > 0) parts.push('', 'Требования навыка:', ...lines)
      return parts.join('\n')
    },
  }

  const list: RunnerTool = {
    name: 'skills_list',
    description: 'List the skills of the library: name and description, one per line.',
    inputSchema: { type: 'object', properties: {} },
    // The index is read from disk; listing never writes the catalog.
    isConcurrencySafe: () => true,
    execute() {
      const lines = store.indexLines()
      return lines.length === 0 ? 'Навыков пока нет.' : lines.join('\n')
    },
  }

  return [manage, view, list]
}
