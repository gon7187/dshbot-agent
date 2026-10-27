// Нативный Rich Markdown Telegram (Bot API 10.1+): текст модели уходит в
// `rich_message.markdown` как есть, а Telegram сам разбирает GFM и свои теги.
//
// Две операции:
//   - normalizeMarkdownHardBreaks: одиночный перенос внутри абзаца становится
//     жёстким (GFM иначе склеил бы строки в пробел). Блоки кода, таблицы,
//     списки, цитаты, заголовки и пустые строки не трогаются;
//   - splitMarkdown: нарезка под лимиты rich-сообщения (32 768 символов,
//     500 блоков). Режется по границам блоков: пункт списка, строка таблицы и
//     абзац целиком; блок кода при необходимости — на закрытые блоки с тем же
//     языком.

/** Лимит текста одного rich-сообщения, символов. */
export const RICH_CHAR_LIMIT = 32768
/** Лимит блоков одного rich-сообщения (включая вложенные и строки таблиц). */
export const RICH_BLOCK_LIMIT = 500

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/
/** Закрывающий fence: тот же символ, не короче открывающего, после — только пробелы. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,}) *$/
const TABLE_LINE_RE = /^\s*\|/
const TABLE_DELIMITER_CELL_RE = /^\s*:?-+:?\s*$/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/
const QUOTE_RE = /^ {0,3}>/
const DIVIDER_RE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/
const FOOTNOTE_RE = /^ {0,3}\[\^[^\]]+\]:/
const HTML_BLOCK_RE =
  /^ {0,3}(?:<!--|<\/?(?:details|summary|blockquote|aside|tg-collage|tg-slideshow|tg-map|tg-button-row|table|div|p|pre|ul|ol|li|h[1-6]|hr|figure|section|article)(?:\s|\/?>))/i

type LineKind = 'code' | 'table' | 'blank' | 'block' | 'text'

/** Ячейки строки таблицы GFM: внешние | необязательны, \\| — не разделитель. */
function tableCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/)
}

/** Строка-разделитель таблицы GFM: `--- | ---`, `|:--|--:|`, `| --- |`. */
function isTableDelimiter(line: string): boolean {
  if (!line.includes('|')) return false
  return tableCells(line).every((cell) => TABLE_DELIMITER_CELL_RE.test(cell))
}

/** Заголовок таблицы GFM: строка с | и следом разделитель с тем же числом колонок. */
function isTableHeader(line: string, next: string | undefined): boolean {
  if (next === undefined || !line.includes('|') || !isTableDelimiter(next)) return false
  return tableCells(line).length === tableCells(next).length
}

interface FenceMarker {
  char: string
  length: number
}

function fenceMarker(line: string): FenceMarker | undefined {
  const match = FENCE_LINE_RE.exec(line)
  if (!match || match[1] === undefined) return undefined
  return { char: match[1][0] as string, length: match[1].length }
}

/**
 * Строка закрывает открытый блок кода, только если это fence из того же
 * символа (обратный апостроф или тильда), не короче открывающего, с отступом
 * не больше трёх пробелов и без постороннего текста после fence.
 */
function isFenceClose(line: string, fence: FenceMarker): boolean {
  const match = FENCE_CLOSE_RE.exec(line)
  if (!match || match[1] === undefined) return false
  return match[1][0] === fence.char && match[1].length >= fence.length
}

function startsOtherBlock(line: string): boolean {
  return (
    FENCE_LINE_RE.test(line) ||
    HEADING_RE.test(line) ||
    LIST_ITEM_RE.test(line) ||
    QUOTE_RE.test(line) ||
    FOOTNOTE_RE.test(line) ||
    HTML_BLOCK_RE.test(line)
  )
}

function classifyLines(lines: string[]): LineKind[] {
  const kinds: LineKind[] = new Array(lines.length)
  let fence: FenceMarker | undefined
  // Внутри таблицы GFM: тело продолжается до пустой строки или начала другого блока.
  let inTable = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (fence !== undefined) {
      kinds[index] = 'code'
      if (isFenceClose(line, fence)) fence = undefined
      continue
    }

    const open = fenceMarker(line)
    if (open !== undefined) {
      fence = open
      kinds[index] = 'code'
      inTable = false
      continue
    }

    if (line.trim() === '') {
      kinds[index] = 'blank'
      inTable = false
      continue
    }
    if (inTable && !startsOtherBlock(line)) {
      kinds[index] = 'table'
      continue
    }
    inTable = false
    if (isTableHeader(line, lines[index + 1])) {
      kinds[index] = 'table'
      kinds[index + 1] = 'table'
      index += 1
      inTable = true
      continue
    }
    if (TABLE_LINE_RE.test(line)) {
      kinds[index] = 'table'
      continue
    }
    if (
      HEADING_RE.test(line) ||
      LIST_ITEM_RE.test(line) ||
      QUOTE_RE.test(line) ||
      DIVIDER_RE.test(line) ||
      FOOTNOTE_RE.test(line) ||
      HTML_BLOCK_RE.test(line)
    ) {
      kinds[index] = 'block'
      continue
    }
    kinds[index] = 'text'
  }

  return kinds
}

function needsHardBreak(line: string): boolean {
  // Уже жёсткий перенос: два пробела или обратная косая перед переводом строки.
  return !/ {2,}$/.test(line) && !/\\$/.test(line)
}

/**
 * Одиночные переносы между строками одного абзаца превращаются в жёсткие
 * (два пробела в конце строки). Внутри кода, таблиц, списков, цитат и HTML-блоков
 * переносы остаются как есть, пустая строка по-прежнему разделяет абзацы.
 */
export function normalizeMarkdownHardBreaks(markdown: string): string {
  if (!markdown.includes('\n')) return markdown
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const kinds = classifyLines(lines)
  const out: string[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    const isLast = index === lines.length - 1
    if (
      !isLast &&
      kinds[index] === 'text' &&
      kinds[index + 1] === 'text' &&
      needsHardBreak(line)
    ) {
      out.push(`${line}  `)
    } else {
      out.push(line)
    }
  }

  return out.join('\n')
}

// --- нарезка -------------------------------------------------------------------------------------------

type UnitKind = 'paragraph' | 'list-item' | 'quote' | 'heading' | 'divider' | 'footnote' | 'code' | 'html'

interface TextUnit {
  kind: UnitKind
  text: string
  blocks: number
}

interface TableUnit {
  kind: 'table'
  header: string[]
  rows: string[]
}

type Unit = TextUnit | TableUnit

function isTextUnit(unit: Unit): unit is TextUnit {
  return unit.kind !== 'table'
}

function isAtomicLine(line: string, kind: LineKind): boolean {
  if (kind !== 'block') return false
  return (
    HEADING_RE.test(line) ||
    LIST_ITEM_RE.test(line) ||
    QUOTE_RE.test(line) ||
    DIVIDER_RE.test(line) ||
    FOOTNOTE_RE.test(line) ||
    HTML_BLOCK_RE.test(line)
  )
}

/** Разбирает markdown на непересекающиеся блоки; пустые строки — разделители. */
function parseUnits(markdown: string): Unit[] {
  const lines = markdown.split('\n')
  const kinds = classifyLines(lines)
  const units: Unit[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as string
    const kind = kinds[index] as LineKind

    if (kind === 'blank') {
      index += 1
      continue
    }

    if (kind === 'code') {
      // Один блок кода — один unit: соседние блоки не склеиваются, иначе на
      // лимит 500 блоков они считаются одним блоком. Закрытие ищем тем же
      // правилом, что и в classifyLines, чтобы строка с текстом после fence
      // осталась содержимым кода.
      const open = fenceMarker(line)
      const body: string[] = [line]
      index += 1
      while (index < lines.length && kinds[index] === 'code') {
        const next = lines[index] as string
        body.push(next)
        index += 1
        if (open !== undefined && isFenceClose(next, open)) break
      }
      units.push({ kind: 'code', text: body.join('\n'), blocks: 1 })
      continue
    }

    if (kind === 'table') {
      const tableLines: string[] = []
      while (index < lines.length && kinds[index] === 'table') {
        tableLines.push(lines[index] as string)
        index += 1
      }
      const delimiter = isTableHeader(tableLines[0] as string, tableLines[1])
      const header = delimiter ? tableLines.slice(0, 2) : []
      const rows = delimiter ? tableLines.slice(2) : tableLines
      units.push({ kind: 'table', header, rows })
      continue
    }

    if (kind === 'block' && isAtomicLine(line, kind)) {
      if (QUOTE_RE.test(line)) {
        const quote: string[] = []
        while (index < lines.length && QUOTE_RE.test(lines[index] as string)) {
          quote.push(lines[index] as string)
          index += 1
        }
        const text = quote.join('\n')
        units.push({ kind: 'quote', text, blocks: quote.length })
        continue
      }
      const unitKind: UnitKind = HEADING_RE.test(line)
        ? 'heading'
        : DIVIDER_RE.test(line)
          ? 'divider'
          : LIST_ITEM_RE.test(line)
            ? 'list-item'
            : FOOTNOTE_RE.test(line)
              ? 'footnote'
              : 'html'
      units.push({ kind: unitKind, text: line, blocks: 1 })
      index += 1
      continue
    }

    // Абзац: подряд идущие текстовые строки (с жёсткими переносами внутри).
    const paragraph: string[] = []
    while (index < lines.length && kinds[index] === 'text') {
      paragraph.push(lines[index] as string)
      index += 1
    }
    if (paragraph.length > 0) {
      units.push({ kind: 'paragraph', text: paragraph.join('\n'), blocks: 1 })
      continue
    }

    // Блочный HTML/неизвестная строка: не теряем её.
    units.push({ kind: 'html', text: line, blocks: 1 })
    index += 1
  }

  return units
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function splitTextByLines(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return [text]

  const pieces: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start) end = newline + 1
      else {
        // Строка длиннее лимита: режем по символам, чтобы часть уложилась,
        // но не между половинами суррогатной пары.
        end = start + limit
        if (end - start > 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1
      }
    }
    pieces.push(text.slice(start, end))
    start = end
  }
  return pieces
}

function splitTable(unit: TableUnit, maxChars: number, maxBlocks: number): TextUnit[] {
  const header = unit.header
  const headerText = header.length > 0 ? `${header.join('\n')}\n` : ''
  const headerBlocks = header.length
  const rowsPerPart = Math.max(1, maxBlocks - headerBlocks)
  const pieces: TextUnit[] = []

  let rows: string[] = []
  let chars = headerText.length
  const flush = (): void => {
    if (rows.length === 0) return
    const text = `${headerText}${rows.join('\n')}`
    pieces.push({ kind: 'paragraph', text, blocks: headerBlocks + rows.length })
    rows = []
    chars = headerText.length
  }

  for (const row of unit.rows) {
    const rowLength = row.length + 1
    if (rows.length > 0 && (rows.length + 1 > rowsPerPart || chars + rowLength > maxChars)) flush()
    rows.push(row)
    chars += rowLength
  }
  flush()

  if (pieces.length === 0) {
    // Пустая таблица (только заголовок): сохраняем как есть.
    const text = header.length > 0 ? header.join('\n') : ''
    if (text !== '') pieces.push({ kind: 'paragraph', text, blocks: Math.max(1, headerBlocks) })
  }
  return pieces
}

function splitCodeBlock(unit: TextUnit, maxChars: number): TextUnit[] {
  if (unit.text.length <= maxChars) return [unit]

  const lines = unit.text.split('\n')
  const open = lines[0] ?? '```'
  const marker = fenceMarker(open)
  const fence = marker === undefined ? '```' : marker.char.repeat(marker.length)
  const hasClose =
    lines.length > 1 && marker !== undefined && isFenceClose(lines[lines.length - 1] as string, marker)
  const close = hasClose ? (lines[lines.length - 1] as string) : fence
  const body = lines.slice(1, hasClose ? lines.length - 1 : lines.length)
  const overhead = open.length + close.length + 2
  const budget = Math.max(1, maxChars - overhead)

  const pieces: TextUnit[] = []
  let current: string[] = []
  let chars = 0
  const flush = (): void => {
    if (current.length === 0) return
    pieces.push({ kind: 'code', text: `${open}\n${current.join('\n')}\n${close}`, blocks: 1 })
    current = []
    chars = 0
  }

  for (const line of body) {
    const lineLength = line.length + 1
    if (lineLength > budget) {
      flush()
      for (const chunk of splitTextByLines(line, budget)) {
        pieces.push({ kind: 'code', text: `${open}\n${chunk}\n${close}`, blocks: 1 })
      }
      continue
    }
    if (current.length > 0 && chars + lineLength > budget) flush()
    current.push(line)
    chars += lineLength
  }
  flush()

  if (pieces.length === 0) return [unit]
  return pieces
}

const QUOTE_MARKER_RE = /^ {0,3}>\s?/

/** Строка длиннее лимита: части по символам; продолжения цитаты остаются цитатой. */
function splitLongLine(line: string, maxChars: number, quote: boolean): string[] {
  if (line.length <= maxChars) return [line]
  if (quote) {
    const prefix = '> '
    const content = line.replace(QUOTE_MARKER_RE, '')
    if (maxChars > prefix.length) {
      return splitTextByLines(content, maxChars - prefix.length).map((chunk) => `${prefix}${chunk}`)
    }
  }
  return splitTextByLines(line, maxChars)
}

/**
 * Блок больше лимитов режется по строкам так, чтобы каждая часть одновременно
 * укладывалась в maxChars и maxBlocks. В цитате каждая строка — отдельный блок,
 * в абзаце часть целиком — один блок.
 */
function splitTextUnit(unit: TextUnit, maxChars: number, maxBlocks: number): TextUnit[] {
  if (unit.kind === 'code') return splitCodeBlock(unit, maxChars)
  if (unit.text.length <= maxChars && unit.blocks <= maxBlocks) return [unit]

  const blockPerLine = unit.kind === 'quote'
  const lines = unit.text.split('\n').flatMap((line) => splitLongLine(line, maxChars, blockPerLine))
  const pieces: TextUnit[] = []
  let current: string[] = []
  let chars = 0
  const flush = (): void => {
    if (current.length === 0) return
    pieces.push({ ...unit, text: current.join('\n'), blocks: blockPerLine ? current.length : 1 })
    current = []
    chars = 0
  }

  for (const line of lines) {
    const added = (current.length > 0 ? 1 : 0) + line.length
    if (current.length > 0 && (chars + added > maxChars || (blockPerLine && current.length + 1 > maxBlocks))) {
      flush()
    }
    chars += (current.length > 0 ? 1 : 0) + line.length
    current.push(line)
  }
  flush()

  return pieces.length > 0 ? pieces : [unit]
}

function joinUnits(units: TextUnit[]): string {
  let text = ''
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index] as TextUnit
    if (index === 0) {
      text = unit.text
      continue
    }
    const previous = units[index - 1] as TextUnit
    const separator = previous.kind === 'list-item' && unit.kind === 'list-item' ? '\n' : '\n\n'
    text += `${separator}${unit.text}`
  }
  return text
}

export interface SplitMarkdownOptions {
  maxChars?: number
  maxBlocks?: number
}

function countBlocks(unit: Unit): number {
  if (!isTextUnit(unit)) return Math.max(1, unit.header.length + unit.rows.length)
  return unit.blocks
}

/**
 * Режет Rich Markdown на части под лимиты одного rich-сообщения. Если текст
 * укладывается — возвращает его одним куском без изменений.
 */
export function splitMarkdown(markdown: string, options: SplitMarkdownOptions = {}): string[] {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? RICH_CHAR_LIMIT))
  const maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? RICH_BLOCK_LIMIT))
  if (markdown.trim() === '') return []

  const parsed = parseUnits(markdown)
  const totalBlocks = parsed.reduce((sum, unit) => sum + countBlocks(unit), 0)
  if (markdown.length <= maxChars && totalBlocks <= maxBlocks) return [markdown]

  const units: TextUnit[] = []
  for (const unit of parsed) {
    if (!isTextUnit(unit)) {
      units.push(...splitTable(unit, maxChars, maxBlocks))
      continue
    }
    units.push(...splitTextUnit(unit, maxChars, maxBlocks))
  }

  const parts: string[] = []
  let current: TextUnit[] = []
  let chars = 0
  let blocks = 0

  const flush = (): void => {
    if (current.length === 0) return
    parts.push(joinUnits(current))
    current = []
    chars = 0
    blocks = 0
  }

  for (const unit of units) {
    const previous = current[current.length - 1]
    const separator =
      previous === undefined ? '' : previous.kind === 'list-item' && unit.kind === 'list-item' ? '\n' : '\n\n'
    const addedChars = separator.length + unit.text.length
    if (current.length > 0 && (chars + addedChars > maxChars || blocks + unit.blocks > maxBlocks)) flush()
    const startsPart = current.length === 0
    current.push(unit)
    chars += (startsPart ? 0 : separator.length) + unit.text.length
    blocks += unit.blocks
  }
  flush()

  // Страховка: часть больше лимита наружу не выходит, дорезается по строкам.
  const bounded = parts.flatMap((part) => (part.length <= maxChars ? [part] : splitTextByLines(part, maxChars)))
  return bounded.length > 0 ? bounded : [markdown]
}
