import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The English documents under docs/en/ must stay a full translation: whatever
// the Russian CONFIG.md and COMMANDS.md are required to describe is described in
// English too, and each language of a pair links to the other.
const root = fileURLToPath(new URL('..', import.meta.url))
const PAIRS = ['INSTALL', 'CONFIG', 'COMMANDS', 'MIGRATION']

function document(path: string): string {
  expect(existsSync(join(root, path)), `${path}: document is missing`).toBe(true)
  return readFileSync(join(root, path), 'utf8')
}

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

// The same discovery as documentation-contract: configuration reads, injected
// env reads and statically enumerable loops over names.
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
    const reads = /\b(?:process\s*\.\s*env|env)\s*(?:\.\s*([A-Z][A-Z0-9_]*)|\[\s*(['"])([A-Z][A-Z0-9_]*)\2\s*\]|\[\s*(\w+)\s*\])(?!\w)(?!\s*=(?!=))/g
    for (const read of source.matchAll(reads)) {
      const name = read[1] ?? read[3] ?? constants.get(read[4] ?? '')
      if (name !== undefined) names.add(name)
    }
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

interface Item {
  title: string
  /** Prose after the title, with the rest of a table row or the following lines. */
  rest: string
  table: boolean
}

// Headings, bullets and table rows outside code fences, each with its title.
function items(markdown: string): Item[] {
  const result: Item[] = []
  const lines = markdown.split(/\r?\n/)
  let fenced = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim())
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue
      result.push({ title: cells[0] ?? '', rest: cells.slice(1).join(' | '), table: true })
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line)
    const text = (heading ?? bullet)?.[1]
    if (text === undefined) continue
    const parts = text.split(/\s+[—–-]\s+|:\s+/)
    let rest = parts.slice(1).join(' ')
    for (let next = index + 1; next < lines.length && /^\S/.test(lines[next]!) === false && lines[next]!.trim() !== ''; next++) {
      rest += ` ${lines[next]!.trim()}`
    }
    result.push({ title: parts[0]!, rest, table: false })
  }
  return result
}

function containsName(title: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_/!])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'u').test(title)
}

function hasEnglishProse(text: string): boolean {
  const prose = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b[A-Z][A-Z0-9_]*\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
  return /[A-Za-z]{3}/.test(prose)
}

function describes(item: Item): boolean {
  if (item.table) {
    const cells = item.rest.split(' | ')
    const last = (cells.at(-1) ?? '').replace(/[`*\s]/g, '')
    return cells.length >= 2 && last !== '' && hasEnglishProse(cells.slice(0, -1).join(' '))
  }
  return hasEnglishProse(item.rest) && /default|required|inherited|unset|not set|empty|none/i.test(item.rest)
}

test('test_c2_every_english_document_exists_and_links_to_its_russian_twin_and_back', () => {
  for (const name of PAIRS) {
    const english = document(`docs/en/${name}.md`)
    const russian = document(`docs/${name}.md`)
    expect(english, `docs/en/${name}.md must link to the Russian version`)
      .toMatch(new RegExp(`\\]\\(\\s*<?(?:\\./)?\\.\\./${name}\\.md`))
    expect(russian, `docs/${name}.md must link to the English version`)
      .toMatch(new RegExp(`\\]\\(\\s*<?(?:\\./)?en/${name}\\.md`))
  }
})

test('test_c2_every_variable_required_in_the_russian_config_is_described_in_the_english_one', () => {
  const names = environmentNames(sources())
  expect(names.size, 'the sources yielded no environment variable').toBeGreaterThan(0)
  const english = items(document('docs/en/CONFIG.md'))
  const missing = [...names].filter((name) => !english.some((item) => containsName(item.title, name) && describes(item)))
  expect(missing, `docs/en/CONFIG.md lacks a description and default for: ${missing.join(', ')}`).toEqual([])
})

test('test_c2_every_command_of_the_russian_commands_document_is_in_the_english_one', () => {
  const titles = (path: string): string[] => items(document(path)).map((item) => item.title)
  const russian = titles('docs/COMMANDS.md')
  const english = items(document('docs/en/COMMANDS.md'))
  const commands = [...new Set(russian.flatMap((title) => title.match(/(?<![\w/])\/[a-z][a-z0-9_]*/g) ?? []))]
  expect(commands.length, 'docs/COMMANDS.md yielded no commands').toBeGreaterThan(20)
  const missing = commands.filter((command) => !english.some((item) => containsName(item.title, command) && hasEnglishProse(item.rest)))
  expect(missing, `docs/en/COMMANDS.md lacks: ${missing.join(', ')}`).toEqual([])
  const bang = (list: readonly string[]): number => list.filter((title) => /^`?!\S/.test(title.trim())).length
  expect(bang(english.map((item) => item.title)), 'the ! shell command is missing in English').toBeGreaterThanOrEqual(bang(russian))
})
