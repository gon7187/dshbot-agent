// Markdown → InputRichBlock[] (Bot API 10.1+).
//
// Модель пишет обычный Markdown, но в rich-сообщение он уходит типизированными
// блоками: так текст вроде `$400-600K` остаётся текстом, а не формулой.
// Внешних зависимостей нет, парсер намеренно небольшой и предсказуемый.

export interface RichTextNode {
  type: string
  text?: RichText
  url?: string
  [key: string]: unknown
}

export type RichText = string | RichTextNode | RichText[]

export interface RichTableAlign {
  align?: 'left' | 'center' | 'right'
}

export interface RichBlockTableCell extends RichTableAlign {
  text: RichText
  is_header?: boolean
  colspan?: number
  rowspan?: number
  [key: string]: unknown
}

export interface RichBlockListItem {
  blocks: RichBlock[]
  has_checkbox?: boolean
  is_checked?: boolean
  type?: string
  [key: string]: unknown
}

export interface RichBlock {
  type: string
  text?: RichText
  size?: number
  language?: string
  blocks?: RichBlock[]
  items?: RichBlockListItem[]
  cells?: RichBlockTableCell[][]
  is_compact?: boolean
  [key: string]: unknown
}

export interface MarkdownToRichOptions {
  compactTables?: boolean
}

const MAX_NESTING = 16
const MAX_TABLE_COLUMNS = 20

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/
const DIVIDER_RE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const QUOTE_RE = /^\s{0,3}>(.*)$/
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const CHECKBOX_RE = /^\[([ xX])\]\s*(.*)$/

/** Текст RichText без разметки. */
export function richTextToPlain(rt: RichText | undefined): string {
  if (rt === undefined) return ''
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(richTextToPlain).join('')
  return richTextToPlain(rt.text)
}

function findSingleAsterisk(input: string, from: number): number {
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === '*' && input[i + 1] !== '*' && input[i - 1] !== '*') return i
  }
  return -1
}

/**
 * Разбирает инлайн-разметку в RichText.
 *
 * Сознательно не трогает `$...$`: математических блоков не создаём, доллар
 * остаётся обычным текстом. Код в бэктиках и содержимое pre тоже не разбираются.
 */
export function parseInline(input: string): RichText {
  const nodes: RichText[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) {
      nodes.push(buffer)
      buffer = ''
    }
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]

    if (ch === '`') {
      const end = input.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'code', text: input.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (ch === '*' && input[i + 1] === '*') {
      const end = input.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'bold', text: parseInline(input.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    if (ch === '~' && input[i + 1] === '~') {
      const end = input.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ type: 'strikethrough', text: parseInline(input.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // [текст](url)
    if (ch === '[') {
      const close = input.indexOf(']', i + 1)
      if (close > i && input[close + 1] === '(') {
        const urlEnd = input.indexOf(')', close + 2)
        if (urlEnd > close + 2) {
          const label = input.slice(i + 1, close)
          const url = input.slice(close + 2, urlEnd).trim()
          flush()
          nodes.push({ type: 'url', url, text: label })
          i = urlEnd + 1
          continue
        }
      }
    }

    if (ch === '*') {
      const end = findSingleAsterisk(input, i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ type: 'italic', text: parseInline(input.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += ch
    i += 1
  }

  flush()
  if (nodes.length === 0) return ''
  if (nodes.length === 1 && typeof nodes[0] === 'string') return nodes[0]
  return nodes
}

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isFenceStart(line: string): boolean {
  return FENCE_RE.test(line)
}

function isHeadingStart(line: string): boolean {
  return HEADING_RE.test(line)
}

function isDivider(line: string): boolean {
  return DIVIDER_RE.test(line)
}

function isQuoteStart(line: string): boolean {
  return QUOTE_RE.test(line)
}

function isListStart(line: string): boolean {
  return LIST_RE.test(line)
}

function splitRow(line: string): string[] {
  let value = line.trim()
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|')) value = value.slice(0, -1)
  return value.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false
  if (!lines[index].includes('|')) return false
  if (!isTableSeparator(lines[index + 1])) return false
  // Разделитель должен описывать те же колонки, что и заголовок.
  return splitRow(lines[index]).length === splitRow(lines[index + 1]).length
}

function alignOf(cell: string): 'left' | 'center' | 'right' | undefined {
  const value = cell.trim()
  const left = value.startsWith(':')
  const right = value.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return undefined
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index]
  if (isBlank(line)) return true
  return (
    isFenceStart(line) ||
    isHeadingStart(line) ||
    isDivider(line) ||
    isQuoteStart(line) ||
    isListStart(line) ||
    isTableStart(lines, index)
  )
}

function parseTable(lines: string[], index: number, options: MarkdownToRichOptions): {
  block: RichBlock
  next: number
} {
  const rows: string[] = [lines[index], lines[index + 1]]
  let next = index + 2
  while (next < lines.length && !isBlank(lines[next]) && lines[next].includes('|')) {
    rows.push(lines[next])
    next += 1
  }

  const headerCells = splitRow(rows[0])
  const raw = rows.join('\n')

  // Широкие таблицы Telegram не принимает: отдаём исходник код-блоком.
  if (headerCells.length > MAX_TABLE_COLUMNS) {
    return { block: { type: 'pre', text: raw }, next }
  }

  const separatorCells = splitRow(rows[1])
  const aligns = headerCells.map((_, column) => alignOf(separatorCells[column] ?? ''))
  const columnCount = headerCells.length

  const cells: RichBlockTableCell[][] = []
  const headerRow: RichBlockTableCell[] = headerCells.map((cell, column) => {
    const value: RichBlockTableCell = { text: parseInline(cell), is_header: true }
    const align = aligns[column]
    if (align) value.align = align
    return value
  })
  cells.push(headerRow)

  for (let r = 2; r < rows.length; r += 1) {
    const parsed = splitRow(rows[r])
    const row: RichBlockTableCell[] = []
    for (let column = 0; column < columnCount; column += 1) {
      const cell: RichBlockTableCell = { text: parseInline(parsed[column] ?? '') }
      const align = aligns[column]
      if (align) cell.align = align
      row.push(cell)
    }
    cells.push(row)
  }

  const block: RichBlock = { type: 'table', cells }
  if (options.compactTables) block.is_compact = true
  return { block, next }
}

function parseList(lines: string[], start: number): { block: RichBlock; next: number } {
  const first = LIST_RE.exec(lines[start])
  const baseIndent = first ? first[1].length : 0
  const ordered = first ? /^\d/.test(first[2]) : false
  const items: RichBlockListItem[] = []
  let lastItem: RichBlockListItem | undefined
  let i = start

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      let lookahead = i + 1
      while (lookahead < lines.length && isBlank(lines[lookahead])) lookahead += 1
      const nextMatch = lookahead < lines.length ? LIST_RE.exec(lines[lookahead]) : null
      if (!nextMatch || nextMatch[1].length < baseIndent) break
      i = lookahead
      continue
    }

    const match = LIST_RE.exec(line)
    if (match) {
      const indent = match[1].length
      if (indent < baseIndent) break
      if (indent > baseIndent) {
        const nested = parseList(lines, i)
        if (lastItem && nested.block.items && nested.block.items.length > 0) {
          lastItem.blocks.push(nested.block)
        }
        i = nested.next
        continue
      }

      let content = match[3]
      let hasCheckbox = false
      let isChecked = false
      const checkbox = CHECKBOX_RE.exec(content)
      if (checkbox) {
        hasCheckbox = true
        isChecked = checkbox[1].toLowerCase() === 'x'
        content = checkbox[2]
      }

      const item: RichBlockListItem = {
        blocks: [{ type: 'paragraph', text: parseInline(content) }],
      }
      if (ordered) item.type = '1'
      if (hasCheckbox) {
        item.has_checkbox = true
        item.is_checked = isChecked
      }
      items.push(item)
      lastItem = item
      i += 1
      continue
    }

    // Продолжение элемента списка: строки с отступом без нового маркера.
    if (lastItem && /^\s+/.test(line)) {
      const paragraph = lastItem.blocks[0]
      const continuation = line.trim()
      if (paragraph && paragraph.type === 'paragraph') {
        const current = richTextToPlain(paragraph.text)
        paragraph.text = parseInline(current ? `${current}\n${continuation}` : continuation)
      } else {
        lastItem.blocks.push({ type: 'paragraph', text: parseInline(continuation) })
      }
      i += 1
      continue
    }

    break
  }

  // Нумерованный список в Bot API задаётся полем `type` у элементов (`1`),
  // отдельного поля у блока нет.
  return { block: { type: 'list', items }, next: i }
}

function parseBlocks(lines: string[], depth: number, options: MarkdownToRichOptions): RichBlock[] {
  const blocks: RichBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (isBlank(line)) {
      i += 1
      continue
    }

    // Огороженный код: содержимое не разбирается как Markdown.
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const fenceToken = fence[1]
      const fenceChar = fenceToken[0]
      const fenceLength = fenceToken.length
      const language = fence[2].trim().split(/\s+/)[0] ?? ''
      const content: string[] = []
      let next = i + 1
      while (next < lines.length) {
        const candidate = lines[next].trim()
        const isClosing =
          candidate.length >= fenceLength && [...candidate].every((ch) => ch === fenceChar)
        if (isClosing) {
          next += 1
          break
        }
        content.push(lines[next])
        next += 1
      }
      const block: RichBlock = { type: 'pre', text: content.join('\n') }
      if (language) block.language = language
      blocks.push(block)
      i = next
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const size = Math.min(6, heading[1].length)
      blocks.push({ type: 'heading', size, text: parseInline(heading[2].trim()) })
      i += 1
      continue
    }

    if (isDivider(line)) {
      blocks.push({ type: 'divider' })
      i += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const content: string[] = []
      let next = i
      while (next < lines.length) {
        const match = QUOTE_RE.exec(lines[next])
        if (!match) break
        let value = match[1]
        if (value.startsWith(' ')) value = value.slice(1)
        content.push(value)
        next += 1
      }
      const inner = parseBlocks(content, depth < MAX_NESTING ? depth + 1 : depth, options)
      if (depth < MAX_NESTING) {
        blocks.push({ type: 'blockquote', blocks: inner })
      } else {
        // Глубже 16 уровней Telegram не принимает — уплощаем.
        blocks.push(...inner)
      }
      i = next
      continue
    }

    if (isListStart(line)) {
      const parsed = parseList(lines, i)
      blocks.push(parsed.block)
      i = parsed.next
      continue
    }

    if (isTableStart(lines, i)) {
      const parsed = parseTable(lines, i, options)
      blocks.push(parsed.block)
      i = parsed.next
      continue
    }

    // Абзац: до пустой строки или начала другого блока.
    const paragraph: string[] = [line]
    let next = i + 1
    while (next < lines.length && !startsBlock(lines, next)) {
      paragraph.push(lines[next])
      next += 1
    }
    blocks.push({ type: 'paragraph', text: parseInline(paragraph.join('\n')) })
    i = next
  }

  return blocks
}

/** Переводит Markdown в типизированные rich-блоки Bot API 10.1+. */
export function markdownToRichBlocks(md: string, options: MarkdownToRichOptions = {}): RichBlock[] {
  const normalized = md.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  return parseBlocks(lines, 0, options)
}
