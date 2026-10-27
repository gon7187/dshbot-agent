// Plain-Russian explanations of a confirm-class command for the owner card.
//
// The explanation is built from the command itself and from the rule the guard
// matched, never from free text: the owner reads what will happen on «Разрешить»,
// not the English code of the rule. Every sentence names the action and its
// object (paths, remote, unit, process, table); text is bounded so a card with
// hundreds of paths still fits one Telegram message.

// The guard's own rules decide which step of a compound line is worth a
// sentence. index.ts re-exports this module; the import cycle is safe because
// neither module calls the other while it is being loaded.
import { checkCommand, commandWordIndex } from './index.js'

/** Options of {@link explainCommand}. */
export interface ExplainCommandOptions {
  /** Alias of the owner's host when the command runs through `host_exec`. */
  host?: string
}

const MAX_ITEMS = 3
const MAX_LIST_CHARS = 160
const MAX_PREVIEW_CHARS = 120

/** Split a shell line into tokens; quotes are consumed, separators become their own token. */
function shellTokens(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  const flush = (): void => {
    if (current !== '') {
      tokens.push(current)
      current = ''
    }
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && i + 1 < text.length) {
        i += 1
        current += text[i] as string
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '\\' && i + 1 < text.length) {
      i += 1
      current += text[i] as string
      continue
    }
    if (char === '\n' || char === ';') {
      flush()
      tokens.push(';')
      continue
    }
    if (char === '&' || char === '|') {
      flush()
      if (text[i + 1] === char) i += 1
      tokens.push(';')
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    current += char
  }
  flush()
  return tokens
}

/** Tokens after the first occurrence of `name`, up to the next separator. */
function argsOf(tokens: string[], name: string): string[] {
  const at = tokens.indexOf(name)
  if (at < 0) return []
  const args: string[] = []
  for (const token of tokens.slice(at + 1)) {
    if (token === ';') break
    args.push(token)
  }
  return args
}

/** Non-flag arguments, stopping at `--` like the shell does. */
function operands(args: string[]): string[] {
  const out: string[] = []
  let afterDoubleDash = false
  for (const token of args) {
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && token.startsWith('-')) continue
    out.push(token)
  }
  return out
}

/** A bounded, human list of up to `maxItems` items. */
function briefList(items: string[], limit = MAX_LIST_CHARS, maxItems = MAX_ITEMS): string {
  if (items.length === 0) return ''
  const shown: string[] = []
  let used = 0
  for (const item of items.slice(0, maxItems)) {
    const text = used === 0 && item.length > limit ? `${item.slice(0, limit - 1)}…` : item
    const next = shown.length === 0 ? text : `, ${text}`
    if (used + next.length > limit) break
    shown.push(text)
    used += next.length
  }
  const more = items.length - shown.length
  const head = shown.join(', ')
  return more > 0 ? `${head}${head === '' ? '' : ' '}и ещё ${more}` : head
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_PREVIEW_CHARS ? `${flat.slice(0, MAX_PREVIEW_CHARS - 1)}…` : flat
}

function onHost(sentence: string, host: string | undefined): string {
  return host === undefined || host === '' ? sentence : `${sentence} Это произойдёт на хосте ${host}.`
}

function unparseableDetail(reason: string): string {
  const detail = reason.slice('unparseable:'.length).trim()
  if (/command substitution/i.test(detail)) return 'в ней есть подстановка команды, результат которой заранее неизвестен'
  if (/unbalanced quotes/i.test(detail)) return 'в ней не закрыты кавычки'
  if (/variable/i.test(detail)) return 'в ней есть переменная, значение которой я не вижу'
  if (/inline code|nested .*-c|eval/i.test(detail)) return 'в ней выполняется код, переданный строкой'
  return 'её разбор неоднозначен'
}

// ---------------------------------------------------------------------------
// Variables of the same command line and its separate steps
// ---------------------------------------------------------------------------

// The card describes a compound command part by part: every step the guard
// asks about gets its own sentence in the order the shell runs it, the command
// text of `$(…)` and backticks before the step around it, and a variable
// assigned in an earlier step is resolved instead of hiding the object of the
// action. A step without a sentence of its own is still named («Выполню …»),
// never dropped. Only the explanation changes: the verdict and the reason of
// the guard stay as the classifier returned them.

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SQL_DROP = /\bDROP\s+(?:TABLE|DATABASE)\b/i
/** Builtins whose arguments are assignments (`export C=/srv/x`). */
const DECLARATIONS = new Set(['export', 'readonly', 'declare', 'typeset', 'local'])
/** Reserved words before the command of a step (`then rm -rf x`). */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])
const OPENING_KEYWORDS = new Set(['if', 'while', 'until', 'for', 'case', 'select'])
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac'])
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])
/** A redirection whose target is the next word (`>`, `2>>`), and one with its target (`2>&1`, `>out.log`). */
const REDIRECTION_OPERATOR = /^(?:[0-9]*|&)(?:>>?|<<?<?|>\||[<>]&)$/
const REDIRECTION = /^(?:[0-9]*|&)[<>]/
// A substitution is an unknown value for the guard: the step around it is
// judged as if a variable stood there (`rm -rf $(cat list)` still asks), and
// a process substitution becomes the path the shell passes (`diff <(…) b`).
const MASKED_SUBSTITUTION = '$__substitution'
const MASKED_PROCESS_SUBSTITUTION = '/dev/fd/63'
/** Nesting depth of `$(…)` after which the nested text is named as a whole. */
const MAX_DEPTH = 8
/** The paragraph still fits one Telegram message (4096) next to the command and its deadline. */
const MAX_EXPLANATION_CHARS = 3500
const MAX_NAME_CHARS = 40

/** One word of a simple command: as written, and with its substitutions masked for the guard. */
interface Word {
  raw: string
  masked: string
}

/** One simple command of a line. */
interface Step {
  words: Word[]
  /** The command lines of its `$(…)`, backticks and `<(…)`, in order. */
  nested: Line[]
  /** True when an assignment of the step does not reach later steps (pipeline, `( … )`, `||`, `if`). */
  scoped: boolean
  /** Text named as a whole: too deep or unreadable to split into steps. */
  opaque?: string
}

interface Line {
  steps: Step[]
}

/** What is known about the value of a variable. */
type Value = { kind: 'literal'; value: string } | { kind: 'command'; source: string } | { kind: 'unknown' }

/** One assignment (or `unset`, `read`, `for`) of a step. */
interface Assignment {
  name: string
  value: Value
}

/**
 * Every way the command line can write a variable.
 *
 * A value is only resolved for a name with exactly one plain top-level
 * assignment and no other write of any kind: a write behind a wrapper
 * (`command export D=/b`, `env D=/b`), a declaration (`export D`), a builtin
 * that fills a variable (`read`, `mapfile`, `printf -v`, `getopts`), `for`,
 * `unset`, or code that is only known as text (`eval`, `source`, `.`) all make
 * the value unknown, even when another step looks like a literal assignment.
 */
interface Writes {
  /** Plain top-level assignments of the line, counted by name. */
  counts: Map<string, number>
  /** Names with any other possible write. */
  unsafe: Set<string>
  /** True when a step can write any variable (`eval`, `source`, `.`). */
  opaque: boolean
}

/** A word after substituting every variable the same command line defines. */
interface Expanded {
  display: string
  unknown: string[]
  commands: Array<{ name: string; source: string }>
}

/** One step, or a run of consecutive equivalent process/service actions. */
interface SentenceEntry {
  text: string
  /** Destructive steps must survive any reduction of the paragraph. */
  irreversible: boolean
  /** A grouped sentence may describe several command steps. Defaults to one. */
  steps?: number
}

/** A run of equivalent actions that can share one list of targets. */
interface RepeatedAction {
  key: string
  targets: string[]
  sentence: (targets: string[]) => string
}

/** What the steps already described may see: the writes of the line and its sentences. */
interface Description {
  writes: Writes
  entries: SentenceEntry[]
  pendingRepeat?: RepeatedAction & { steps: number }
}

/** Read `$'…'` without evaluating shell text, including Bash's ANSI-C escapes. */
function readAnsiString(text: string, start: number): { body: string; end: number; closed: boolean } {
  let body = ''
  let truncated = false
  const append = (value: string): void => {
    if (truncated) return
    const nul = value.indexOf('\0')
    body += nul < 0 ? value : value.slice(0, nul)
    // Bash cannot keep NUL in a word; it discards the rest of this quoted part.
    if (nul >= 0) truncated = true
  }
  const escapes: Record<string, string> = {
    a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', "'": "'", '"': '"', '?': '?',
  }
  for (let i = start + 2; i < text.length; i += 1) {
    const char = text[i] as string
    if (char === "'") return { body, end: i + 1, closed: true }
    if (char !== '\\' || i + 1 >= text.length) {
      append(char)
      continue
    }
    const next = text[++i] as string
    if (Object.hasOwn(escapes, next)) {
      append(escapes[next] as string)
      continue
    }
    const pattern = /[0-7]/.test(next) ? /^[0-7]{1,3}/
      : next === 'x' ? /^[0-9a-fA-F]{1,2}/
      : next === 'u' ? /^[0-9a-fA-F]{1,4}/
      : next === 'U' ? /^[0-9a-fA-F]{1,8}/ : undefined
    if (pattern !== undefined) {
      const octal = /[0-7]/.test(next)
      const digits = pattern.exec(text.slice(octal ? i : i + 1))?.[0]
      if (digits !== undefined) {
        const code = Number.parseInt(digits, octal ? 8 : 16)
        append(next === 'u' || next === 'U'
          ? code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd'
          : String.fromCharCode(code & 0xff))
        i += digits.length - (octal ? 1 : 0)
        continue
      }
    }
    if (next === 'c' && i + 1 < text.length) {
      let control = text[++i] as string
      if (control === '\\' && text[i + 1] === '\\') control = text[++i] as string
      append(String.fromCharCode(control === '?' ? 127 : control.toUpperCase().charCodeAt(0) & 31))
      continue
    }
    append(`\\${next}`)
  }
  return { body, end: text.length, closed: false }
}

/** The body of the parenthesised text whose `(` is at `open`, and the index after its `)`. */
function readParens(text: string, open: number): { body: string; end: number; closed: boolean } {
  let depth = 0
  let quote: '"' | "'" | null = null
  for (let i = open; i < text.length; i += 1) {
    const char = text[i] as string
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (char === '\\') {
      i += 1
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = null
      continue
    }
    if (char === '$' && text[i + 1] === "'") {
      const read = readAnsiString(text, i)
      if (!read.closed) break
      i = read.end - 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1, closed: true }
    }
  }
  return { body: text.slice(open + 1), end: text.length, closed: false }
}

/** The body of the backtick substitution opened at `open`, one level of escaping removed. */
function readBackticks(text: string, open: number): { body: string; end: number; closed: boolean } {
  let body = ''
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i] as string
    if (char === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string
      body += next === '`' || next === '\\' || next === '$' ? next : char + next
      i += 1
      continue
    }
    if (char === '`') return { body, end: i + 1, closed: true }
    body += char
  }
  return { body, end: text.length, closed: false }
}

/** A step that is named as a whole instead of being split. */
function opaqueLine(text: string): Line {
  return { steps: [{ words: [], nested: [], scoped: true, opaque: text }] }
}

function nestedLine(text: string, depth: number): Line {
  if (depth >= MAX_DEPTH) return opaqueLine(text)
  return parseLine(text, depth) ?? opaqueLine(text)
}

/**
 * Split a line into simple commands at the separators the shell runs in order.
 *
 * Words keep their quotes; `$(…)`, backticks and `<(…)` stay inside their word
 * and their text is parsed as a nested line. `null` when a quote is not
 * closed: the steps of such a line are a guess.
 */
function parseLine(text: string, depth: number): Line | null {
  const steps: Step[] = []
  let words: Word[] = []
  let nested: Line[] = []
  let raw = ''
  let masked = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  let afterPipe = false
  let afterOr = false
  let group = 0
  let block = 0

  const add = (rawText: string, maskedText: string): void => {
    raw += rawText
    masked += maskedText
    inWord = true
  }
  const endWord = (): void => {
    if (!inWord) return
    words.push({ raw, masked })
    if (words.length === 1 || KEYWORDS.has(words[words.length - 2]?.raw ?? '')) {
      if (OPENING_KEYWORDS.has(raw)) block += 1
      if (CLOSING_KEYWORDS.has(raw)) block = Math.max(0, block - 1)
    }
    raw = ''
    masked = ''
    inWord = false
  }
  const endStep = (pipeAfter: boolean, orAfter = false): void => {
    endWord()
    if (words.length > 0 || nested.length > 0) {
      steps.push({ words, nested, scoped: afterPipe || pipeAfter || afterOr || group > 0 || block > 0 })
    }
    words = []
    nested = []
    afterPipe = pipeAfter
    afterOr = orAfter
  }
  const substitute = (start: number, body: string, end: number, mask: string): number => {
    nested.push(nestedLine(body, depth + 1))
    add(text.slice(start, end), mask)
    return end - 1
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    if (quote === "'") {
      add(char, char)
      if (char === "'") quote = null
      continue
    }
    if (quote === null && char === '$' && text[i + 1] === "'") {
      const read = readAnsiString(text, i)
      if (!read.closed) return null
      add(text.slice(i, read.end), text.slice(i, read.end))
      i = read.end - 1
      continue
    }
    if (quote === null && char === '$' && text[i + 1] === '"') {
      // Bash's locale string has double-quote semantics; its prefix is not $NAME.
      quote = '"'
      add('$"', '$"')
      i += 1
      continue
    }
    if (char === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string
      i += 1
      // A backslash-newline joins the lines; it is no word of its own.
      if (next !== '\n') add(char + next, char + next)
      continue
    }
    if (char === '$' && text[i + 1] === '(') {
      const read = readParens(text, i + 1)
      // `$((…))` is arithmetic expansion: it runs no command.
      if (text[i + 2] === '(') {
        add(text.slice(i, read.end), '0')
        i = read.end - 1
      } else {
        i = substitute(i, read.body, read.end, MASKED_SUBSTITUTION)
      }
      continue
    }
    if (char === '`') {
      const read = readBackticks(text, i)
      i = substitute(i, read.body, read.end, MASKED_SUBSTITUTION)
      continue
    }
    if (quote === '"') {
      add(char, char)
      if (char === '"') quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      add(char, char)
      continue
    }
    if ((char === '<' || char === '>') && text[i + 1] === '(') {
      const read = readParens(text, i + 1)
      i = substitute(i, read.body, read.end, MASKED_PROCESS_SUBSTITUTION)
      continue
    }
    if (char === '#' && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1
      continue
    }
    if (char === ' ' || char === '\t') {
      endWord()
      continue
    }
    if (char === '\n' || char === '\r' || char === ';') {
      endStep(false)
      continue
    }
    if (char === '|') {
      if (text[i + 1] === '|') {
        i += 1
        endStep(false, true)
      } else {
        if (text[i + 1] === '&') i += 1
        endStep(true)
      }
      continue
    }
    if (char === '&') {
      if (text[i + 1] === '&') {
        i += 1
        endStep(false)
      } else if (raw.endsWith('>') || raw.endsWith('<') || text[i + 1] === '>') {
        // `2>&1`, `>&2`, `&>file` redirect output; they separate nothing.
        add(char, char)
      } else {
        endStep(false)
      }
      continue
    }
    if (char === '(' && !inWord) {
      endStep(false)
      group += 1
      continue
    }
    if (char === ')') {
      endStep(false)
      group = Math.max(0, group - 1)
      continue
    }
    add(char, char)
  }
  if (quote !== null) return null
  endStep(false)
  return { steps }
}

/** An empty set of writes, for expanding a literal without a command line. */
function noWrites(): Writes {
  return { counts: new Map(), unsafe: new Set(), opaque: false }
}

/** `/srv/x` of `'/srv/x'` or `"/srv/x"`: the word without quotes and escapes. */
function unquote(raw: string): string {
  return expandWord(raw, new Map(), noWrites()).display
}

/** The value of `NAME=raw`: a literal, one command substitution, or unknown. */
function valueOf(raw: string): Value {
  const inner = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  if (inner.startsWith('$(') && !inner.startsWith('$((')) {
    const read = readParens(inner, 1)
    const source = read.body.trim()
    if (read.closed && read.end === inner.length && source !== '') return { kind: 'command', source }
  }
  if (inner.startsWith('`')) {
    const read = readBackticks(inner, 0)
    const source = read.body.trim()
    if (read.closed && read.end === inner.length && source !== '') return { kind: 'command', source }
  }
  if (raw.includes('$') || raw.includes('`')) return { kind: 'unknown' }
  return { kind: 'literal', value: unquote(raw) }
}

/**
 * What a step assigns, and whether the assignments reach the later steps.
 * Only a step of assignments alone (or `export`-like ones) keeps them in the
 * shell; `C=/x cmd` sets C for cmd only, and `unset`, `read` and `for` make a
 * variable change more than once.
 */
function assignmentsOf(step: Step): { assignments: Assignment[]; persist: boolean } {
  const words = step.words.map((word) => word.raw)
  let at = 0
  while (at < words.length && KEYWORDS.has(words[at] as string)) at += 1
  const first = words[at] ?? ''
  const assignments: Assignment[] = []
  const named = (name: string): void => {
    if (NAME.test(name)) assignments.push({ name, value: { kind: 'unknown' } })
  }

  if (first === 'unset' || first === 'read' || first === 'mapfile' || first === 'readarray') {
    for (const word of words.slice(at + 1)) if (!word.startsWith('-')) named(word)
    return { assignments, persist: false }
  }
  if (first === 'for' || first === 'select') {
    named(words[at + 1] ?? '')
    return { assignments, persist: false }
  }

  const declaration = DECLARATIONS.has(first)
  let i = declaration ? at + 1 : at
  let only = true
  for (; i < words.length; i += 1) {
    const word = words[i] as string
    if (declaration && word.startsWith('-')) continue
    const match = ASSIGNMENT.exec(word)
    if (match === null) {
      if (declaration && NAME.test(word)) continue
      only = false
      break
    }
    const name = match[1] as string
    assignments.push({ name, value: match[2] === '+' ? { kind: 'unknown' } : valueOf(match[3] ?? '') })
  }
  return { assignments, persist: only && !step.scoped && first !== 'local' }
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g
/** Wrappers that run the builtin after them in this shell (`command . x`, `builtin source x`). */
const SHELL_WRAPPERS = new Set(['command', 'builtin', 'env', 'exec', 'nohup', 'time', 'sudo', 'doas'])
/** Builtins that write a variable named in their arguments, options included (`printf -vD`, `wait -p D`). */
const VARIABLE_BUILTINS = new Set([
  'printf',
  'read',
  'mapfile',
  'readarray',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'getopts',
  'unset',
  'let',
  'wait',
])

/**
 * Every name the word may refer to, other than by `$D` or `${D}`: `D` of
 * `D""`, `'D'`, `\D`, `D=/b`, `${D:=/b}` and `$((D=1))`. An option of a
 * builtin that writes variables names one in every tail of a letter run
 * (`printf -vD`, `read -aD`); an option of any other command (`git -C`)
 * writes none, only its `${D:=…}` and `$((…))` can.
 */
function namesIn(raw: string, builtinOptions: boolean): string[] {
  // Mask actual reads while parsing, before removing quotes: a literal '$D'
  // or $"D" must not turn into an apparent expansion after quote removal.
  const text = expandWord(raw, new Map(), noWrites(), true).display
  if (!text.startsWith('-') && !text.startsWith('+')) return text.match(IDENTIFIER) ?? []
  if (!builtinOptions) return namesWrittenIn(text)
  const tails: string[] = []
  for (const name of text.match(IDENTIFIER) ?? []) {
    for (let i = 0; i < name.length; i += 1) {
      const tail = name.slice(i)
      if (NAME.test(tail)) tails.push(tail)
    }
  }
  return tails
}

/** True when an option of the step may name a variable: a writing builtin is mentioned, or the command is not literal. */
function hasBuiltinOptions(words: string[]): boolean {
  if (words.some((word) => VARIABLE_BUILTINS.has(word))) return true
  const command = words[commandWordIndex(words)] ?? ''
  return command.includes('$') || command.includes('`')
}

/** Names the value of `NAME=value` writes on its own: `${D:=/b}`, `$((D=1))`. */
function namesWrittenIn(value: string): string[] {
  const names: string[] = []
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}A-Za-z0-9_]/g)) names.push(match[1] as string)
  for (const match of value.matchAll(/\$\(\(([\s\S]*?)\)\)|\$\[([\s\S]*?)\]/g)) {
    names.push(...((match[1] ?? match[2] ?? '').match(IDENTIFIER) ?? []))
  }
  return names
}

/**
 * True when the step runs text that is only known as a string, now or before a
 * later step: `eval`, `source`, `.` (also behind a wrapper or in quotes), a
 * `trap` and a function definition (`f() { D=/b; }`, `function f`).
 */
function runsText(words: string[]): boolean {
  if (words.some((word) => ['eval', 'source', 'trap', 'function'].includes(word) || word.endsWith('('))) return true
  for (const word of words) {
    if (word === '.') return true
    if (!SHELL_WRAPPERS.has(commandName(word)) && !word.startsWith('-') && !ASSIGNMENT.test(word)) break
  }
  return words[commandWordIndex(words)] === '.'
}

/** Remember a write of `name` that is not a plain top-level assignment. */
function markUnsafe(writes: Writes, name: string): void {
  if (NAME.test(name)) writes.unsafe.add(name)
}

/** Record the possible writes of one step: plain assignments and everything else. */
function scanStepWrites(step: Step, writes: Writes): void {
  if (step.opaque !== undefined) {
    // Text that is not parsed cannot be checked for a write of any name.
    writes.opaque = true
    return
  }
  const all = step.words.map((word) => word.raw)
  let at = 0
  while (at < all.length && KEYWORDS.has(all[at] as string)) at += 1
  const words = all.slice(at)

  // A step made only of assignments keeps them in this shell: these are the
  // only writes whose value may be described.
  if (words.length > 0 && !step.scoped && words.every((word) => ASSIGNMENT.test(word))) {
    for (const word of words) {
      const match = ASSIGNMENT.exec(word)
      if (match !== null) {
        const name = match[1] as string
        if (NAME.test(name)) writes.counts.set(name, (writes.counts.get(name) ?? 0) + 1)
        // A literal name in another value may become an indirect write target
        // (`N=D; read $N`). Assignment values are never command options.
        const value = expandWord(match[3] ?? '', new Map(), noWrites(), true).display
        for (const mentioned of value.match(IDENTIFIER) ?? []) markUnsafe(writes, mentioned)
      }
    }
    return
  }

  // A wrapper, a declaration, a builtin with a glued option (`printf -vD`) or
  // any other command can write a variable without looking like a top-level
  // assignment. Every mention of a name other than `$D` and `${D}`, quoted or
  // escaped, is a possible write; guessing less would resolve a value that a
  // later step may overwrite.
  const plain = words.map(unquote)
  const builtinOptions = hasBuiltinOptions(plain)
  for (const word of words) {
    for (const name of namesIn(word, builtinOptions)) markUnsafe(writes, name)
  }

  // `eval`, `source` and `.` run text that is only known as a string: any name
  // they mention may be written, and the write need not use the name as a word.
  if (runsText(plain)) writes.opaque = true
}

/** Collect the possible writes of the line, nested command text included. */
function scanWrites(line: Line, writes: Writes): Writes {
  for (const step of line.steps) {
    scanStepWrites(step, writes)
    for (const inner of step.nested) scanWrites(inner, writes)
  }
  return writes
}

/**
 * The value of `name` where it is used: known only for exactly one plain
 * top-level assignment, made earlier and still in effect, with no other write
 * anywhere in the line.
 */
function valueAt(name: string, visible: Map<string, Value>, writes: Writes): Value {
  if (writes.opaque || writes.unsafe.has(name) || writes.counts.get(name) !== 1) return { kind: 'unknown' }
  return visible.get(name) ?? { kind: 'unknown' }
}

/** Remove quotes and substitute variables; the write scan masks only actual plain reads. */
function expandWord(raw: string, visible: Map<string, Value>, writes: Writes, maskPlainReads = false): Expanded {
  let display = ''
  const unknown: string[] = []
  const commands: Array<{ name: string; source: string }> = []
  let quote: '"' | "'" | null = null
  const variable = (name: string, written: string): void => {
    if (maskPlainReads) {
      display += ' '
      return
    }
    const value = valueAt(name, visible, writes)
    if (value.kind === 'literal') {
      display += value.value
      return
    }
    display += written
    if (value.kind === 'command') {
      if (!commands.some((entry) => entry.name === name)) commands.push({ name, source: value.source })
    } else if (!unknown.includes(name)) {
      unknown.push(name)
    }
  }

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] as string
    if (quote === "'") {
      if (char === "'") quote = null
      else display += char
      continue
    }
    if (quote === null && char === '$' && raw[i + 1] === "'") {
      const read = readAnsiString(raw, i)
      display += read.body
      i = read.end - 1
      continue
    }
    if (quote === null && char === '$' && raw[i + 1] === '"') {
      quote = '"'
      i += 1
      continue
    }
    if (char === "'" && quote === null) {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (char === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1] as string
      if (quote === '"' && !'$`"\\'.includes(next)) display += char
      display += next
      i += 1
      continue
    }
    if ((char === '$' || (quote === null && (char === '<' || char === '>'))) && raw[i + 1] === '(') {
      const read = readParens(raw, i + 1)
      display += raw.slice(i, read.end)
      i = read.end - 1
      continue
    }
    if (char === '`') {
      const read = readBackticks(raw, i)
      display += raw.slice(i, read.end)
      i = read.end - 1
      continue
    }
    if (char === '$') {
      const rest = raw.slice(i)
      const plain = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
      if (plain !== null) {
        variable((plain[1] ?? plain[2]) as string, `$${(plain[1] ?? plain[2]) as string}`)
        i += plain[0].length - 1
        continue
      }
      // `${NAME:-x}`, `${#NAME}`, `$1`, `$@`: shown as written, the value is not known here.
      const special = /^\$\{[#!]?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])[^}]*\}|^\$([0-9@*#?$!-])/.exec(rest)
      if (special !== null) {
        const name = (special[1] ?? special[2]) as string
        display += special[0]
        if (!unknown.includes(name)) unknown.push(name)
        i += special[0].length - 1
        continue
      }
    }
    display += char
  }
  return { display, unknown, commands }
}

/** `rm` of `/bin/rm`: the name the guard classifies. */
function commandName(token: string): string {
  const slash = token.lastIndexOf('/')
  return slash < 0 ? token : token.slice(slash + 1)
}

/** Indexes of the non-flag arguments, stopping at `--` like the shell does. */
function operandIndexes(args: string[]): number[] {
  const out: number[] = []
  let afterDoubleDash = false
  args.forEach((token, index) => {
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      return
    }
    if (!afterDoubleDash && token.startsWith('-')) return
    out.push(index)
  })
  return out
}

/** «Удалю …» with literal paths resolved; a path that is only a command's output says so. */
function rmSentence(args: Expanded[], explained: Set<string>): string {
  const parts: string[] = []
  for (const index of operandIndexes(args.map((arg) => arg.display))) {
    const arg = args[index] as Expanded
    const only = arg.commands.length === 1 ? arg.commands[0] : undefined
    if (only !== undefined && arg.display === `$${only.name}`) {
      parts.push(`файл, имя которого — результат команды ${oneLine(only.source)} (переменная ${only.name})`)
      explained.add(only.name)
      continue
    }
    parts.push(arg.display)
  }
  const target = parts.length === 0 ? 'файлы или каталоги' : briefList(parts)
  return `Удалю ${target}; восстановить будет нельзя.`
}

/** «Завершу …» for the targets of one or more consecutive process stops; every target is named. */
function killSentenceFor(command: string, full: boolean, targets: string[]): string {
  const list = targets.join(', ')
  if (list === '') return 'Завершу процессы, не называя их в команде.'
  if (full) return `Завершу процессы, в командной строке которых есть ${targets.map((target) => `«${target}»`).join(', ')}.`
  if (command === 'kill' && targets.length <= 1) {
    return `Завершу процесс ${list}. Он будет остановлен без возможности сохранить состояние.`
  }
  return `Завершу процессы ${list}. Они будут остановлены без возможности сохранить состояние.`
}

/** «Завершу …» in the form of the command: `pkill -f` matches a command line. */
function killSentence(command: string, args: string[]): string {
  const full = args.some((arg) => arg === '-f' || arg === '--full')
  const targets = operandIndexes(args).map((index) => args[index] as string)
  return killSentenceFor(command, full, targets)
}

/** The sentence of a dangerous `git` subcommand, if it has one. */
function gitSentence(args: string[]): string | undefined {
  let at = 0
  while (at < args.length) {
    const token = args[at] as string
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') at += 2
    else if (token.startsWith('-')) at += 1
    else break
  }
  const subcommand = args[at]
  const rest = args.slice(at + 1)
  if (subcommand === 'push') return describeGitPush(['push', ...rest], undefined)
  if (subcommand === 'reset' && rest.includes('--hard')) {
    return 'Сброшу репозиторий до последнего коммита: незакоммиченные правки пропадут безвозвратно.'
  }
  if (
    subcommand === 'clean' &&
    rest.some((token) => token === '--force' || (/^-[A-Za-z]*f[A-Za-z]*$/.test(token) && !token.startsWith('--')))
  ) {
    return 'Удалю неотслеживаемые файлы и каталоги; восстановить будет нельзя.'
  }
  return undefined
}

/** «Выполню …» for a step without a sentence of its own: it is named, not dropped. */
function stepSentence(preview: string, reason: string): string {
  const shown = `Выполню «${oneLine(preview)}»`
  if (/inline code|nested .*-c|eval/i.test(reason)) {
    return `${shown}: в нём выполняется код, переданный строкой, и заранее понять, что он сделает, нельзя.`
  }
  if (/variable/i.test(reason)) return `${shown}: этот шаг требует подтверждения, потому что в нём есть переменная.`
  if (/command substitution/i.test(reason)) {
    return `${shown}: этот шаг требует подтверждения, потому что в нём есть подстановка команды.`
  }
  return `${shown}: этот шаг требует подтверждения, отменить его последствия может быть нельзя.`
}

function shortName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name
}

/** A step sentence, optionally able to share a target list with its neighbours. */
interface StepSentence extends SentenceEntry {
  repeat?: RepeatedAction
}

/** Only equivalent, literal systemctl actions share a list; never mix stop and restart. */
function serviceRepeat(args: string[], context: string[]): RepeatedAction | undefined {
  const options = new Set(['--user', '--system', '--no-block', '--no-ask-password', '--quiet'])
  let at = 0
  while (options.has(args[at] ?? '')) at += 1
  const verb = args[at]
  if (verb !== 'restart' && verb !== 'stop') return undefined
  const targets = args.slice(at + 1)
  if (targets.length === 0 || targets.some((target) => target.startsWith('-'))) return undefined
  return {
    key: JSON.stringify(['systemctl', context, args.slice(0, at), verb]),
    targets,
    sentence: (units) => {
      if (units.length === 1) return describeService(['systemctl', verb, ...units], undefined)
      return verb === 'stop'
        ? `Остановлю службы ${units.join(', ')}. Они перестанут работать до следующего запуска.`
        : `Перезапущу службы ${units.join(', ')}. Они ненадолго перестанут отвечать.`
    },
  }
}

/** The sentence of the step's own command, or `undefined` when the guard lets it run. */
function ownSentence(step: Step, visible: Map<string, Value>, writes: Writes): StepSentence | undefined {
  if (step.opaque !== undefined) {
    const check = checkCommand(step.opaque)
    if (check.verdict === 'allow') return undefined
    // Opaque code may contain a destructive step; never discard it for space.
    return { text: stepSentence(step.opaque, check.reason), irreversible: true }
  }
  let at = 0
  while (at < step.words.length && KEYWORDS.has((step.words[at] as Word).raw)) at += 1
  const words = step.words.slice(at)
  // A step of assignments runs nothing itself: its `$(…)` is already described.
  if (words.every((word) => ASSIGNMENT.test(word.raw))) return undefined
  const check = checkCommand(words.map((word) => word.masked).join(' '))
  if (check.verdict === 'allow') return undefined

  // Redirections (`2>&1`, `> out.log`) are no operands of the command.
  const operandWords: Word[] = []
  for (let i = 0; i < words.length; i += 1) {
    const raw = (words[i] as Word).raw
    if (REDIRECTION_OPERATOR.test(raw)) i += 1
    else if (!REDIRECTION.test(raw)) operandWords.push(words[i] as Word)
  }
  const expanded = operandWords.map((word) => expandWord(word.raw, visible, writes))
  const display = expanded.map((word) => word.display)
  const index = commandWordIndex(display)
  const command = commandName(display[index] ?? '')
  const args = display.slice(index + 1)
  const text = display.join(' ')
  const explained = new Set<string>()

  let sentence: string | undefined
  let repeat: RepeatedAction | undefined
  // Unknown actions may also be destructive. Only known process/service
  // interruptions are eligible for omission when the card is otherwise full.
  let irreversible = true
  if (SQL_DROP.test(text)) {
    sentence = describeSqlDrop(text, undefined)
  } else if (command === 'rm') {
    sentence = rmSentence(expanded.slice(index + 1), explained)
  } else if (command === 'kill' || command === 'killall' || command === 'pkill' || command === 'skill') {
    const full = args.some((arg) => arg === '-f' || arg === '--full')
    const targets = operandIndexes(args).map((operand) => args[operand] as string)
    sentence = killSentence(command, args)
    irreversible = false
    repeat = {
      key: JSON.stringify([command, display.slice(0, index), args.filter((arg) => arg.startsWith('-'))]),
      targets,
      sentence: (items) => killSentenceFor(command, full, items),
    }
  } else if (command === 'git') {
    sentence = gitSentence(args)
  } else if (command === 'find' && args.some((arg) => FIND_ACTIONS.has(arg))) {
    sentence = 'Удалю файлы или запущу программу через find; отменить последствия может быть нельзя.'
  } else if (['reboot', 'shutdown', 'poweroff', 'halt', 'kexec'].includes(command)) {
    sentence = describePower([command], undefined)
  } else if (['systemctl', 'service', 'rc-service', 'rcctl'].includes(command)) {
    sentence = describeService([command, ...args], undefined)
    if (command === 'systemctl') repeat = serviceRepeat(args, display.slice(0, index))
    irreversible = ['reboot', 'poweroff', 'halt', 'kexec', 'emergency', 'rescue'].some((verb) => args.includes(verb))
  }
  sentence ??= stepSentence(text, check.reason)

  const sources: string[] = []
  const unknown: string[] = []
  for (const word of expanded) {
    for (const entry of word.commands) {
      if (!explained.has(entry.name)) {
        explained.add(entry.name)
        sources.push(`${shortName(entry.name)} — результат команды ${oneLine(entry.source)}.`)
      }
    }
    addAll(unknown, word.unknown)
  }
  for (const source of sources.slice(0, MAX_ITEMS)) sentence += ` ${source}`
  for (const name of unknown.slice(0, MAX_ITEMS)) sentence += ` Значение $${shortName(name)} заранее неизвестно.`
  if (unknown.length > MAX_ITEMS) sentence += ` Значения ещё ${unknown.length - MAX_ITEMS} переменных тоже заранее неизвестны.`
  return {
    text: sentence,
    irreversible,
    ...(repeat === undefined || sources.length > 0 || unknown.length > 0 ? {} : { repeat }),
  }
}

function addAll(target: string[], items: string[]): void {
  for (const item of items) {
    if (!target.includes(item)) target.push(item)
  }
}

/** Close a run of equivalent actions as one sentence naming every target. */
function flushRepeat(description: Description): void {
  const pending = description.pendingRepeat
  if (pending === undefined) return
  description.entries.push({ text: pending.sentence(pending.targets), irreversible: false, steps: pending.steps })
  delete description.pendingRepeat
}

/** Add a step sentence, merging only consecutive equivalent actions without variable notes. */
function addSentence(description: Description, sentence: StepSentence): void {
  if (sentence.repeat !== undefined) {
    const pending = description.pendingRepeat
    if (pending !== undefined && pending.key === sentence.repeat.key) {
      pending.targets.push(...sentence.repeat.targets)
      pending.steps += 1
      return
    }
    flushRepeat(description)
    description.pendingRepeat = { ...sentence.repeat, targets: [...sentence.repeat.targets], steps: 1 }
    return
  }
  flushRepeat(description)
  description.entries.push({ text: sentence.text, irreversible: sentence.irreversible })
}

/** Sentences of a line in execution order: the nested text of a step runs before the step itself. */
function describeLine(line: Line, outer: Map<string, Value>, description: Description): void {
  const visible = new Map(outer)
  for (const step of line.steps) {
    for (const inner of step.nested) describeLine(inner, visible, description)
    const sentence = ownSentence(step, visible, description.writes)
    if (sentence !== undefined) addSentence(description, sentence)
    else flushRepeat(description)
    const { assignments, persist } = assignmentsOf(step)
    for (const assignment of assignments) {
      if (persist) visible.set(assignment.name, assignment.value)
      else visible.delete(assignment.name)
    }
  }
}

/** «шаг», «шага», «шагов» for `count`. */
function stepsWord(count: number): string {
  const tens = count % 100
  const ones = count % 10
  if (ones === 1 && tens !== 11) return 'шаг'
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return 'шага'
  return 'шагов'
}

/**
 * The full paragraph of a line: the steps the guard asks about, in execution
 * order, with the variables the line itself defines resolved. Empty when the
 * line cannot be split or no step asks, so the reason-specific fallback still
 * decides the text.
 */
function describeCompound(command: string, host: string | undefined): string {
  const line = parseLine(command, 0)
  if (line === null) return ''
  const description: Description = { writes: scanWrites(line, noWrites()), entries: [] }
  describeLine(line, new Map(), description)
  flushRepeat(description)
  const entries = description.entries
  if (entries.length === 0) return ''
  const full = entries.map((entry) => entry.text).join(' ')
  const budget = MAX_EXPLANATION_CHARS - onHost('', host).length
  if (full.length <= budget) return onHost(full, host)

  // Reserve space for every destructive step, even if it comes last, and for
  // the omission notice. Only known process/service interruptions can be cut.
  const notice = (hidden: number): string =>
    `Описание не поместилось в одно сообщение: ещё ${hidden} ${stepsWord(hidden)} этой команды ` +
    `${hidden === 1 ? 'требует' : 'требуют'} подтверждения, прочитайте команду целиком перед решением.`
  const stepCount = entries.reduce((sum, entry) => sum + (entry.steps ?? 1), 0)
  // Eight extra characters cover the different Russian plural/singular forms.
  let remaining = budget - notice(stepCount).length - 8 - 1
    - entries.filter((entry) => entry.irreversible).reduce((sum, entry) => sum + entry.text.length + 1, 0)
  const shown: string[] = []
  let hidden = 0
  for (const entry of entries) {
    if (entry.irreversible || entry.text.length + 1 <= remaining) {
      shown.push(entry.text)
      if (!entry.irreversible) remaining -= entry.text.length + 1
    } else {
      hidden += entry.steps ?? 1
    }
  }
  if (hidden > 0) shown.push(notice(hidden))
  return onHost(shown.join(' '), host)
}

function powerSentence(command: string): string {
  switch (command) {
    case 'reboot':
      return 'Перезагружу машину'
    case 'shutdown':
    case 'poweroff':
      return 'Выключу машину'
    case 'halt':
      return 'Остановлю машину'
    case 'kexec':
      return 'Загружу другое ядро'
    default:
      return 'Остановлю или перезагружу машину'
  }
}

function describeRm(tokens: string[], host: string | undefined): string {
  const paths = operands(argsOf(tokens, 'rm'))
  const what = paths.length === 0 ? '' : `: ${briefList(paths)}`
  return onHost(`Удалю${what}; восстановить будет нельзя.`, host)
}

function describeGitPush(tokens: string[], host: string | undefined): string {
  const args = operands(argsOf(tokens, 'push'))
  const remote = args[0]
  const branch = args[1]
  const target =
    remote === undefined
      ? 'удалённый репозиторий по умолчанию'
      : `«${remote}»${branch === undefined ? '' : ` (ветка ${branch})`}`
  return onHost(
    `Отправлю изменения в ${target}: они уйдут в удалённый репозиторий, отменить это будет нельзя.`,
    host,
  )
}

function describeSqlDrop(command: string, host: string | undefined): string {
  const match = /\bDROP\s+(TABLE|DATABASE)\s+(?:IF\s+EXISTS\s+)?(?:["'`[\]\s]*)([A-Za-z0-9_.$]+)/i.exec(command)
  const kind = match?.[1]?.toUpperCase() === 'DATABASE' ? 'базу данных' : 'таблицу'
  const name = match?.[2]
  const what = name === undefined ? kind : `${kind} ${name}`
  return onHost(`Удалю ${what}; восстановить будет нельзя.`, host)
}

function describePower(tokens: string[], host: string | undefined): string {
  const command = tokens.find((token) =>
    ['reboot', 'shutdown', 'poweroff', 'halt', 'kexec'].includes(token),
  )
  return onHost(`${powerSentence(command ?? '')}. Это прервёт всё, что сейчас работает на машине.`, host)
}

function describeKill(tokens: string[], host: string | undefined): string {
  const command = tokens.find((token) => ['kill', 'killall', 'pkill', 'skill'].includes(token)) ?? 'kill'
  const targets = operands(argsOf(tokens, command))
  const list = briefList(targets)
  if (list === '') return onHost('Завершу процесс, не называя его в команде.', host)
  const word = command === 'kill' && targets.length <= 1 ? 'процесс' : 'процессы'
  return onHost(`Завершу ${word} ${list}. Он будет остановлен без возможности сохранить состояние.`, host)
}

function describeService(tokens: string[], host: string | undefined): string {
  const managers = ['systemctl', 'service', 'rc-service', 'rcctl']
  const manager = tokens.find((token) => managers.includes(token)) ?? 'systemctl'
  const verbs = new Set([
    'stop',
    'restart',
    'try-restart',
    'reload-or-restart',
    'reload-or-try-restart',
    'condrestart',
    'force-reload',
    'kill',
    'reboot',
    'poweroff',
    'halt',
    'kexec',
    'emergency',
    'rescue',
  ])
  const args = operands(argsOf(tokens, manager))
  const verb = args.find((token) => verbs.has(token))
  const unit = args.find((token) => !verbs.has(token))
  if (verb === 'reboot' || verb === 'poweroff' || verb === 'halt' || verb === 'kexec') {
    return onHost(`${powerSentence(verb)} через ${manager}.`, host)
  }
  if (unit === undefined) {
    return onHost(`Остановлю или перезапущу службу через ${manager}, не называя её в команде.`, host)
  }
  if (verb === 'stop') return onHost(`Остановлю службу ${unit}. Она перестанет работать до следующего запуска.`, host)
  if (verb === 'kill') return onHost(`Завершу службу ${unit} вместе с её процессами.`, host)
  return onHost(`Перезапущу службу ${unit}. Она ненадолго перестанет отвечать.`, host)
}

/**
 * A plain-Russian paragraph for the owner card of a command.
 *
 * `command` is the exact line the caller is about to run; `reason` is the
 * reason of the guard's `confirm` verdict (`irreversible: …`,
 * `unparseable: …`). The returned text is one paragraph and never contains the
 * English code itself.
 */
export function explainCommand(command: string, reason: string, options: ExplainCommandOptions = {}): string {
  const host = options.host
  const compound = describeCompound(command, host)
  if (compound !== '') return compound
  const tokens = shellTokens(command)
  const code = reason.split(';')[0]?.trim() ?? ''

  if (code.startsWith('irreversible: recursive rm') || code === 'irreversible: rm') {
    return describeRm(tokens, host)
  }
  if (code.startsWith('irreversible: SQL DROP')) return describeSqlDrop(command, host)
  if (code.startsWith('irreversible: git push')) return describeGitPush(tokens, host)
  if (code.startsWith('irreversible: git reset --hard')) {
    return onHost('Сброшу репозиторий до последнего коммита: незакоммиченные правки пропадут безвозвратно.', host)
  }
  if (code.startsWith('irreversible: git clean')) {
    return onHost('Удалю неотслеживаемые файлы и каталоги; восстановить будет нельзя.', host)
  }
  if (code.startsWith('irreversible: find deletes')) {
    return onHost('Удалю файлы или запущу программу через find; отменить последствия может быть нельзя.', host)
  }
  if (/^irreversible: (?:reboot|shutdown|poweroff|halt|kexec) interrupts/.test(code)) {
    return describePower(tokens, host)
  }
  if (/^irreversible: (?:kill|killall|pkill|skill) interrupts/.test(code)) {
    return describeKill(tokens, host)
  }
  if (/^irreversible: \S+ stops or restarts a service/.test(code)) {
    return describeService(tokens, host)
  }
  if (code.startsWith('unparseable:')) {
    return onHost(
      `Я не могу заранее понять, что именно выполнит эта команда: ${unparseableDetail(code)}. ` +
        'Запущу её как есть, поэтому последствия зависят от того, что она сделает.',
      host,
    )
  }

  const preview = oneLine(command)
  return onHost(
    `Выполню команду «${preview}»; это действие изменит систему, и отменить его может быть нельзя.`,
    host,
  )
}
