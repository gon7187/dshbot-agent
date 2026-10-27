// Нарезка rich-блоков под лимиты Bot API: ≤ 500 блоков (с вложенными,
// элементами списков и строками таблиц) и ≤ 32 768 символов текста.

import { richTextToPlain, type RichBlock, type RichBlockListItem } from './markdown.js'

export interface SplitRichOptions {
  maxBlocks?: number
  maxChars?: number
}

const DEFAULT_MAX_BLOCKS = 500
const DEFAULT_MAX_CHARS = 32768

function unitsOfBlock(block: RichBlock): number {
  let units = 1
  if (Array.isArray(block.blocks)) {
    for (const child of block.blocks) units += unitsOfBlock(child)
  }
  if (Array.isArray(block.items)) {
    for (const item of block.items) units += unitsOfBlock(item as unknown as RichBlock)
  }
  if (Array.isArray(block.cells)) {
    units += block.cells.length
  }
  return units
}

function charsOfBlock(block: RichBlock): number {
  let chars = block.text === undefined ? 0 : richTextToPlain(block.text).length
  if (Array.isArray(block.blocks)) {
    for (const child of block.blocks) chars += charsOfBlock(child)
  }
  if (Array.isArray(block.items)) {
    for (const item of block.items) chars += charsOfBlock(item as unknown as RichBlock)
  }
  if (Array.isArray(block.cells)) {
    for (const row of block.cells) {
      for (const cell of row) chars += richTextToPlain(cell.text).length
    }
  }
  return chars
}

/** Режет текст по строкам так, чтобы concat(части) === исходный текст. */
function splitTextByLines(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start) {
        end = newline + 1
      } else {
        end = start + limit
      }
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

function splitOversizedByUnits(block: RichBlock, maxBlocks: number): RichBlock[] {
  if (unitsOfBlock(block) <= maxBlocks) return [block]

  if (block.type === 'table' && Array.isArray(block.cells)) {
    const rows = block.cells
    const chunks: RichBlock[] = []
    let current: typeof rows = []
    for (const row of rows) {
      // 1 блок таблицы + строки
      if (current.length > 0 && current.length + 2 > maxBlocks) {
        chunks.push({ ...block, cells: current })
        current = []
      }
      current.push(row)
    }
    if (current.length > 0) chunks.push({ ...block, cells: current })
    if (chunks.length > 0) return chunks
  }

  if (block.type === 'list' && Array.isArray(block.items)) {
    const chunks: RichBlock[] = []
    let current: RichBlockListItem[] = []
    let currentUnits = 1
    for (const item of block.items) {
      const itemUnits = unitsOfBlock(item as unknown as RichBlock)
      if (current.length > 0 && currentUnits + itemUnits > maxBlocks) {
        chunks.push({ ...block, items: current })
        current = []
        currentUnits = 1
      }
      current.push(item)
      currentUnits += itemUnits
    }
    if (current.length > 0) chunks.push({ ...block, items: current })
    if (chunks.length > 0) return chunks
  }

  return [block]
}

function prepareBlocks(blocks: RichBlock[], maxBlocks: number, maxChars: number): RichBlock[] {
  const prepared: RichBlock[] = []

  for (const block of blocks) {
    let pieces: RichBlock[]

    if (block.type === 'pre' && typeof block.text === 'string' && block.text.length > maxChars) {
      // Длинный pre режется по строкам на несколько pre с тем же языком.
      pieces = splitTextByLines(block.text, maxChars).map((text) => {
        const piece: RichBlock = { type: 'pre', text }
        if (block.language !== undefined) piece.language = block.language
        return piece
      })
    } else if (
      (block.type === 'paragraph' || block.type === 'footer') &&
      typeof block.text === 'string' &&
      block.text.length > maxChars
    ) {
      pieces = splitTextByLines(block.text, maxChars).map((text) => ({ ...block, text }))
    } else {
      pieces = [block]
    }

    for (const piece of pieces) {
      prepared.push(...splitOversizedByUnits(piece, maxBlocks))
    }
  }

  return prepared
}

/**
 * Режет блоки на части, каждая из которых укладывается в maxBlocks и maxChars.
 * Порядок блоков сохраняется; части склеиваются обратно в исходный список.
 */
export function splitRichBlocks(blocks: RichBlock[], options: SplitRichOptions = {}): RichBlock[][] {
  const maxBlocks = Math.max(1, Math.floor(options.maxBlocks ?? DEFAULT_MAX_BLOCKS))
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS))
  if (blocks.length === 0) return []

  const prepared = prepareBlocks(blocks, maxBlocks, maxChars)
  const parts: RichBlock[][] = []
  let current: RichBlock[] = []
  let currentUnits = 0
  let currentChars = 0

  for (const block of prepared) {
    const units = unitsOfBlock(block)
    const chars = charsOfBlock(block)
    if (
      current.length > 0 &&
      (currentUnits + units > maxBlocks || currentChars + chars > maxChars)
    ) {
      parts.push(current)
      current = []
      currentUnits = 0
      currentChars = 0
    }
    current.push(block)
    currentUnits += units
    currentChars += chars
  }

  if (current.length > 0) parts.push(current)
  return parts
}
