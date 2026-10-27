import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function document(path: string): string {
  expect(existsSync(join(root, path)), `${path}: документ отсутствует`).toBe(true)
  return readFileSync(join(root, path), 'utf8')
}

// Like the other documentation tests, inspect source text without importing the
// daemon: documentation coverage must not need credentials, SQLite or Telegram.
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || /^(?:node_modules|__tests__|tests?|fixtures?)$/.test(entry.name)) return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [path] : []
  })
}

function sources(): string[] {
  return readdirSync(join(root, 'packages'), { withFileTypes: true }).flatMap((entry) => {
    const src = join(root, 'packages', entry.name, 'src')
    return entry.isDirectory() && existsSync(src)
      ? sourceFiles(src).map((path) => readFileSync(path, 'utf8'))
      : []
  })
}

// Keep literals (including URLs) while discarding comments, so a commented-out
// command or configuration example does not become a documentation obligation.
function withoutComments(source: string): string {
  return source.replace(
    /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (part) => part.startsWith('//') || part.startsWith('/*') ? ' '.repeat(part.length) : part,
  )
}

function literals(text: string): string[] {
  return [...text.matchAll(/(['"`])([^'"`\n]*)\1/g)].map((match) => match[2]!)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function ownerCommands(allSources: readonly string[]): Set<string> {
  const commands = new Set<string>()
  for (const raw of allSources) {
    const source = withoutComments(raw)
    for (const match of source.matchAll(/\{\s*command\s*:\s*['"]([a-z][a-z0-9_]*)['"]\s*,\s*description\s*:/g)) {
      commands.add(`/${match[1]}`)
    }
    // Include handlers absent from the Telegram menu, regardless of the local
    // variable name used for commandOf(), as well as direct comparisons.
    const variables = new Set(
      [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*commandOf\(/g)].map((match) => match[1]!),
    )
    const operands = ['commandOf\\([^)]*\\)', ...[...variables].map(escapeRegex)].join('|')
    const comparison = new RegExp(`(?<![\\w.])(?:${operands})\\s*[!=]==?\\s*['"]([a-z][a-z0-9_]*)['"]`, 'g')
    for (const match of source.matchAll(comparison)) commands.add(`/${match[1]}`)
    for (const variable of variables) {
      const switches = new RegExp(`switch\\s*\\(\\s*${escapeRegex(variable)}\\s*\\)\\s*\\{([\\s\\S]*?)(?=\\n\\s*\\})`, 'g')
      for (const block of source.matchAll(switches)) {
        for (const match of block[1]!.matchAll(/case\s+['"]([a-z][a-z0-9_]*)['"]\s*:/g)) commands.add(`/${match[1]}`)
      }
      for (const use of source.matchAll(new RegExp(`(\\w+)\\.has\\(\\s*${escapeRegex(variable)}\\s*\\)`, 'g'))) {
        const declaration = new RegExp(`\\b${escapeRegex(use[1]!)}\\s*=\\s*new Set\\(\\s*\\[([\\s\\S]*?)\\]`)
        for (const name of literals(declaration.exec(source)?.[1] ?? '')) {
          if (/^[a-z][a-z0-9_]*$/.test(name)) commands.add(`/${name}`)
        }
      }
    }
    // bangCommandOf is a separate parser, not a slash-command alias. Extract
    // its public syntax from the actual ! help line, including Cyrillic labels.
    if (/\bbangCommandOf\s*\(/.test(source)) {
      const bangLabels = literals(source).flatMap((text) => /^(![^\s]+)\s+[—–-]\s+/u.exec(text)?.[1] ?? [])
      for (const label of bangLabels.length > 0 ? bangLabels : ['!команда']) commands.add(label)
    }
  }
  return commands
}

function environmentNames(allSources: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const raw of allSources) {
    const source = withoutComments(raw)
    const constants = new Map(
      [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(['"])([A-Z][A-Z0-9_]*)\2/g)]
        .map((match) => [match[1]!, match[3]!] as const),
    )
    for (const call of source.matchAll(/\breadConfigValue\s*\(\s*[^,]+,\s*(?:(['"])([A-Z][A-Z0-9_]*)\1|(\w+))/g)) {
      const name = call[2] ?? constants.get(call[3] ?? '')
      if (name !== undefined) names.add(name)
    }
    // env is the injected ProcessEnv used by readEnvConfig and other packages.
    // Exclude writes, e.g. runner's process.env.DSH_HOME = options.dshHome.
    const reads = /\b(?:process\s*\.\s*env|env)\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*(['"])([A-Z][A-Z0-9_]*)\2\s*\]|\[\s*(\w+)\s*\])(?!\w)(?!\s*=(?!=))/g
    for (const read of source.matchAll(reads)) {
      const name = read[1] ?? read[3] ?? constants.get(read[4] ?? '')
      if (name !== undefined) names.add(name)
    }
    // Statically enumerable indirect reads: for (const name of INHERITED_ENV)
    // process.env[name], and the equivalent inline-array form.
    for (const loop of source.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+(\[[^\]]*\]|\w+)[^)]*\)\s*\{([\s\S]*?)(?=\n\s*\})/g)) {
      if (!new RegExp(`\\b(?:process\\.env|env)\\[\\s*${escapeRegex(loop[1]!)}\\s*\\]`).test(loop[3]!)) continue
      let values = loop[2]!
      if (!values.startsWith('[')) {
        values = new RegExp(`\\b${escapeRegex(values)}\\s*=\\s*(?:new Set\\(\\s*)?\\[([\\s\\S]*?)\\]`).exec(source)?.[1] ?? ''
      }
      for (const name of literals(values)) if (/^[A-Z][A-Z0-9_]*$/.test(name)) names.add(name)
    }
  }
  return names
}

interface Entry {
  title: string
  body: string
  defaultValue?: string
}

const defaultLabel = /по\s+умолчанию|defaults?/iu

// Accept tables, headings, bullets and prose paragraphs. In a table, identify
// the default column by its heading instead of requiring a fixed column order.
function entries(markdown: string): Entry[] {
  const result: Entry[] = []
  // A variable's heading may explain its purpose and default in separate
  // paragraphs or bullets; keep the complete section available for matching.
  for (const section of markdown.matchAll(/^#{1,6}\s+([^\n]+)\n([\s\S]*?)(?=^#{1,6}\s+|(?![\s\S]))/gm)) {
    result.push({ title: section[1]!, body: section[2]! })
  }
  const lines = markdown.split(/\r?\n/)
  let current: Entry | undefined
  let defaultColumn = -1
  let fenced = false
  for (const line of lines) {
    if (/^\s*```|^\s*~~~/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (/^\s*\|/.test(line)) {
      current = undefined
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim())
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
      const header = cells.findIndex((cell) => defaultLabel.test(cell))
      if (header >= 0 && !/[A-Z][A-Z0-9_]{2,}/.test(cells[0] ?? '')) { defaultColumn = header; continue }
      result.push({
        title: cells[0] ?? '',
        body: cells.filter((_, index) => index !== 0 && index !== defaultColumn).join(' '),
        ...(defaultColumn < 0 ? {} : { defaultValue: cells[defaultColumn] ?? '' }),
      })
      continue
    }
    defaultColumn = -1
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line)
    if (heading !== null || bullet !== null) {
      current = { title: (heading ?? bullet)![1]!, body: '' }
      result.push(current)
    } else if (line.trim() !== '') {
      if (current === undefined) {
        current = { title: line.trim(), body: '' }
        result.push(current)
      } else current.body += ` ${line.trim()}`
    } else {
      current = undefined
    }
  }
  return result
}

function containsName(title: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_/!])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'u').test(title)
}

function hasPurpose(entry: Entry): boolean {
  const inline = entry.title.split(/\s+[—–-]\s+|:\s+/).slice(1).join(' ')
  const prose = `${inline} ${entry.body}`
    .replace(/(?:по\s+умолчанию|defaults?)\s*[:=—–-]?[^\n]*/giu, '')
    .replace(/\b[A-Z][A-Z0-9_]*\b/g, '')
    .replace(/[/!][\p{L}\p{N}_]+/gu, '')
    .replace(/<[^>]*>/g, '')
    .replace(defaultLabel, '')
  return /[\p{L}]{3}/u.test(prose)
}

test('test_c1_readme_describes_the_bot_capabilities_and_links_to_its_documents', () => {
  const readme = document('README.md')
  for (const meaning of [/личн|personal/iu, /агент|agent/iu, /Telegram/i, /DeepSeek/i]) expect(readme).toMatch(meaning)
  for (const feature of [/помн|памят|memory|remember/iu, /задач|инструмент|tasks?|tools?/iu, /автоном|расписан|пробужден|autonom|schedul/iu]) {
    expect(readme, `README: отсутствует описание возможности ${feature}`).toMatch(feature)
  }
  const links = [...readme.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1]!.replace(/^\.\//, '').split('#')[0])
  for (const path of ['docs/INSTALL.md', 'docs/COMMANDS.md', 'docs/CONFIG.md', 'docs/DESIGN.md']) {
    expect(links, `README: нужна ссылка на ${path}`).toContain(path)
  }
  expect(readme).not.toMatch(/код(?:а)?\s+(?:бота\s+)?(?:(?:ещ[её]|пока)\s+)?нет|(?:бот|код)[^.\n]{0,35}(?:ещ[её]|пока)\s+не\s+(?:написан|реализован)|no\s+(?:bot\s+)?code\s+yet|(?:bot|code)[^.\n]{0,25}not\s+(?:yet\s+)?implemented/iu)
})

test('test_c2_every_menu_handler_and_bang_owner_command_has_a_description', () => {
  // These synthetic snippets validate discovery without freezing today's
  // command list: removing a command from the product remains possible.
  expect(ownerCommands([`
    const menu = [{ command: 'menu_only', description: 'Menu entry' }]
    const op = commandOf(message.text)
    if (op === 'hidden') handle()
    if (commandOf(message.text) === 'direct') handle()
    if (typeof args.command === 'string') handle()
    const EXTRA = new Set(['in_set'])
    if (EXTRA.has(op)) handle()
    switch (op) {
      case 'in_switch': handle(); break
    }
    function bangCommandOf(text) { return text.slice(1) }
    const BANG_HELP_LINE = '!команда — выполнить команду'
    // if (op === 'comment_only') handle()
  `])).toEqual(new Set(['/menu_only', '/hidden', '/direct', '/in_set', '/in_switch', '!команда']))
  const commands = ownerCommands(sources())
  expect(commands.size, 'Исходники не дали ни одной команды').toBeGreaterThan(0)
  const parts = entries(document('docs/COMMANDS.md'))
  const missing = [...commands].filter((name) => !parts.some((entry) => containsName(entry.title, name) && hasPurpose(entry)))
  expect(missing, `Нет описания команд: ${missing.join(', ')}`).toEqual([])
})

test('test_c3_every_environment_read_has_a_purpose_and_default', () => {
  expect(environmentNames([`
    const KEY = 'CONFIG_CONSTANT'
    readConfigValue(env, 'CONFIG_LITERAL')
    readConfigValue(env, KEY)
    const a = process.env.DIRECT_READ
    const b = process.env['BRACKET_READ']
    const c = process.env[KEY]
    const d = env.INJECTED_READ
    const INHERITED_ENV = new Set(['INHERITED_READ'])
    for (const name of INHERITED_ENV) {
      const value = process.env[name]
    }
    for (const name of ['INLINE_READ'] as const) {
      const value = env[name]
    }
    process.env.WRITE_ONLY = 'not a read'
    // const ignored = process.env.COMMENT_ONLY
  `])).toEqual(new Set(['CONFIG_LITERAL', 'CONFIG_CONSTANT', 'DIRECT_READ', 'BRACKET_READ', 'INJECTED_READ', 'INHERITED_READ', 'INLINE_READ']))
  const names = environmentNames(sources())
  expect(names.size, 'Исходники не дали ни одной переменной окружения').toBeGreaterThan(0)
  const parts = entries(document('docs/CONFIG.md'))
  const missing = [...names].filter((name) => !parts.some((entry) => {
    if (!containsName(entry.title, name) || !hasPurpose(entry)) return false
    if (entry.defaultValue !== undefined) return entry.defaultValue.replace(/[`*\s]/g, '') !== ''
    const prose = `${entry.title} ${entry.body}`
    return /(?:по\s+умолчанию|defaults?)\s*[:=—–-]?\s*\S+/iu.test(prose)
      || /обязательн|required|наследуется|inherited|не\s+задан[ао]?|unset|без\s+значения/iu.test(prose)
  }))
  expect(missing, `Нет назначения или значения по умолчанию: ${missing.join(', ')}`).toEqual([])
})

test('test_c4_design_uses_the_canonical_environment_file_path', () => {
  const design = document('docs/DESIGN.md')
  const canonical = '~/.config/dshbot/dshbot.env'
  expect(design, 'DESIGN должен указывать полный путь env-файла').toContain(canonical)
  const paths = design.match(/~\/\.config\/dshbot\/(?:env(?:\.[\w.-]+)?|[\w.-]*\.env(?:\.[\w.-]+)?)/g) ?? []
  expect(paths.filter((path) => path !== canonical), 'DESIGN использует другое имя env-файла').toEqual([])
})
