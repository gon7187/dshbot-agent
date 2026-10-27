// HTML и plain-представления Markdown для деградации rich → HTML → текст,
// плюс chunkText: нарезка HTML под 4096 символов без разрыва тегов и сущностей.

import {
  markdownToRichBlocks,
  richTextToPlain,
  type RichBlock,
  type RichBlockListItem,
  type RichText,
} from './markdown.js'

const VOID_TAGS = new Set([
  'br',
  'hr',
  'img',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'param',
  'source',
  'track',
  'wbr',
])

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

function renderRichText(rt: RichText | undefined): string {
  if (rt === undefined) return ''
  if (typeof rt === 'string') return escapeHtml(rt)
  if (Array.isArray(rt)) return rt.map(renderRichText).join('')
  switch (rt.type) {
    case 'bold':
      return `<b>${renderRichText(rt.text)}</b>`
    case 'italic':
      return `<i>${renderRichText(rt.text)}</i>`
    case 'strikethrough':
      return `<s>${renderRichText(rt.text)}</s>`
    case 'code':
      return `<code>${escapeHtml(richTextToPlain(rt.text))}</code>`
    case 'url':
      return `<a href="${escapeAttribute(rt.url ?? '')}">${renderRichText(rt.text)}</a>`
    default:
      return renderRichText(rt.text)
  }
}

function tableToText(block: RichBlock): string {
  if (!Array.isArray(block.cells)) return ''
  return block.cells
    .map((row) => row.map((cell) => richTextToPlain(cell.text)).join(' | '))
    .join('\n')
}

function isOrderedList(block: RichBlock): boolean {
  return (block.items ?? []).some((item) => typeof item.type === 'string')
}

function listItemHtml(item: RichBlockListItem): string {
  const prefix = item.has_checkbox ? (item.is_checked ? '☑ ' : '☐ ') : ''
  return `<li>${prefix}${renderBlocksHtml(item.blocks)}</li>`
}

function renderBlockHtml(block: RichBlock): string {
  switch (block.type) {
    case 'heading':
      return `<b>${renderRichText(block.text)}</b>`
    case 'paragraph':
    case 'footer':
      return `<p>${renderRichText(block.text)}</p>`
    case 'pre': {
      const language = block.language
      const body = escapeHtml(richTextToPlain(block.text))
      if (language) {
        return `<pre><code class="language-${escapeAttribute(language)}">${body}</code></pre>`
      }
      return `<pre>${body}</pre>`
    }
    case 'blockquote':
      return `<blockquote>${renderBlocksHtml(block.blocks ?? [])}</blockquote>`
    case 'list': {
      const tag = isOrderedList(block) ? 'ol' : 'ul'
      const items = (block.items ?? []).map(listItemHtml).join('')
      return `<${tag}>${items}</${tag}>`
    }
    case 'divider':
      return '<hr/>'
    case 'table':
      return `<pre>${escapeHtml(tableToText(block))}</pre>`
    default:
      return renderRichText(block.text)
  }
}

function renderBlocksHtml(blocks: RichBlock[]): string {
  return blocks.map(renderBlockHtml).join('\n')
}

/** Markdown → HTML для Telegram parse_mode=HTML. */
export function markdownToHtml(md: string): string {
  return renderBlocksHtml(markdownToRichBlocks(md))
}

function blockToPlain(block: RichBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'footer':
    case 'pre':
      return richTextToPlain(block.text)
    case 'blockquote':
      return (block.blocks ?? []).map(blockToPlain).join('\n')
    case 'list': {
      const ordered = isOrderedList(block)
      return (block.items ?? [])
        .map((item, index) => {
          const marker = item.has_checkbox
            ? item.is_checked
              ? '[x]'
              : '[ ]'
            : ordered
              ? `${index + 1}.`
              : '-'
          const body = item.blocks.map(blockToPlain).join('\n')
          return `${marker} ${body}`
        })
        .join('\n')
    }
    case 'divider':
      return '———'
    case 'table':
      return tableToText(block)
    default:
      return richTextToPlain(block.text)
  }
}

/** Markdown → простой текст без разметки. */
export function markdownToPlain(md: string): string {
  return markdownToRichBlocks(md)
    .map(blockToPlain)
    .filter((value) => value.length > 0)
    .join('\n\n')
}

interface OpenTag {
  name: string
  raw: string
}

interface TagInfo {
  kind: 'open' | 'close' | 'void'
  name: string
}

interface Token {
  raw: string
  kind: 'text' | 'tag' | 'entity'
}

const ENTITY_AT_END = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/y

// Именованные сущности, которые мы можем вернуть символом, если сущность
// целиком не влезает в лимит (актуально только для крошечных max).
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntity(raw: string): string {
  const numeric = /^&#(?:x([0-9a-fA-F]+)|(\d+));$/.exec(raw)
  if (numeric) {
    const code = numeric[1] !== undefined ? Number.parseInt(numeric[1], 16) : Number.parseInt(numeric[2], 10)
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
    try {
      return String.fromCodePoint(code)
    } catch {
      return ''
    }
  }
  const named = /^&([a-zA-Z][a-zA-Z0-9]*);$/.exec(raw)
  if (named) return NAMED_ENTITIES[named[1].toLowerCase()] ?? ''
  return ''
}

function tagInfo(token: string): TagInfo | null {
  const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>$/.exec(token)
  if (!match) return null
  const name = match[2].toLowerCase()
  if (match[1] === '/') return { kind: 'close', name }
  const selfClosing = /\/\s*$/.test(match[3]) || VOID_TAGS.has(name)
  return { kind: selfClosing ? 'void' : 'open', name }
}

function tokenizeHtml(input: string): Token[] {
  const tokens: Token[] = []
  let buffer = ''
  const flush = (): void => {
    if (!buffer) return
    const pieces = buffer.match(/\s+|[^\s]+/g)
    if (pieces) for (const piece of pieces) tokens.push({ raw: piece, kind: 'text' })
    buffer = ''
  }

  let i = 0
  while (i < input.length) {
    if (input[i] === '<') {
      const end = input.indexOf('>', i + 1)
      if (end !== -1) {
        flush()
        tokens.push({ raw: input.slice(i, end + 1), kind: 'tag' })
        i = end + 1
        continue
      }
    }

    if (input[i] === '&') {
      ENTITY_AT_END.lastIndex = i
      const entity = ENTITY_AT_END.exec(input)
      if (entity) {
        flush()
        tokens.push({ raw: entity[0], kind: 'entity' })
        i += entity[0].length
        continue
      }
    }

    buffer += input[i]
    i += 1
  }

  flush()
  return tokens
}

function applyToken(stack: OpenTag[], token: string): OpenTag[] {
  const info = tagInfo(token)
  if (!info) return stack
  if (info.kind === 'open') return [...stack, { name: info.name, raw: token }]
  if (info.kind === 'close') {
    const next = stack.slice()
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i].name === info.name) {
        next.splice(i, 1)
        break
      }
    }
    return next
  }
  return stack
}

function closingTags(stack: OpenTag[]): string {
  let result = ''
  for (let i = stack.length - 1; i >= 0; i -= 1) result += `</${stack[i].name}>`
  return result
}

function closingLength(stack: OpenTag[]): number {
  let length = 0
  for (const tag of stack) length += tag.name.length + 3
  return length
}

function reopenTags(stack: OpenTag[]): string {
  return stack.map((tag) => tag.raw).join('')
}

function reopenLength(stack: OpenTag[]): number {
  let length = 0
  for (const tag of stack) length += tag.raw.length
  return length
}

interface Emission {
  emitted: string
  after: OpenTag[]
}

/**
 * Закрытие тега: теги, открытые внутри него, закрываются раньше, чтобы части
 * оставались синтаксически корректными даже на неидеальном входе.
 */
function closeEmission(stack: OpenTag[], name: string): Emission | null {
  let position = -1
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].name === name) {
      position = i
      break
    }
  }
  if (position < 0) return null
  const inner = stack.slice(position + 1)
  return { emitted: closingTags(inner) + `</${name}>`, after: stack.slice(0, position) }
}

function tokenEmission(stack: OpenTag[], token: Token): Emission {
  const info = token.kind === 'tag' ? tagInfo(token.raw) : null
  if (info?.kind === 'close') {
    const closed = closeEmission(stack, info.name)
    if (closed) return closed
  }
  return { emitted: token.raw, after: applyToken(stack, token.raw) }
}

/**
 * Подбирает минимальный набор переносимых тегов, при котором атомарный токен
 * (тег или сущность) влезает в пустую часть. `null` — токен не влезает даже
 * без открытых тегов.
 */
function shrinkToFit(stack: OpenTag[], token: Token, limit: number): OpenTag[] | null {
  const candidate = stack.slice()
  for (;;) {
    const { emitted, after } = tokenEmission(candidate, token)
    if (reopenLength(candidate) + emitted.length + closingLength(after) <= limit) return candidate
    if (candidate.length === 0) return null
    candidate.pop()
  }
}

/**
 * Режет текст на части не длиннее max, не разрывая HTML-теги и сущности.
 * Тег, открытый на границе, закрывается в конце части и открывается в начале
 * следующей.
 *
 * Тег и сущность атомарны: если такой токен не влезает в остаток части, часть
 * закрывается, а токен целиком переносится в следующую. Токен, который не
 * влезает даже в пустую часть (длинный `<a href=...>` или сущность при
 * крошечном max), деградирует: тег выбрасывается вместе с парным закрывающим
 * (текст внутри остаётся), сущность заменяется своим символом. Ни одна часть
 * при этом не превышает max и не содержит оборванного тега или сущности.
 */
export function chunkText(text: string, max = 4000): string[] {
  const limit = Math.max(1, Math.floor(max))
  if (text === '') return []

  const tokens = tokenizeHtml(text)
  const parts: string[] = []
  // Открывающие теги, выброшенные как слишком длинные: их закрывающие пары
  // тоже не нужны.
  const droppedOpens = new Map<string, number>()

  let stack: OpenTag[] = []
  let chunk = ''
  let hasContent = false

  const startPart = (carrier: OpenTag[]): void => {
    stack = carrier.slice()
    chunk = reopenTags(stack)
    hasContent = false
  }

  const flush = (): void => {
    parts.push(chunk + closingTags(stack))
    startPart(stack)
  }

  startPart([])

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const info = token.kind === 'tag' ? tagInfo(token.raw) : null

    // Закрывающий тег, которому нечего закрывать, отбрасываем: иначе в части
    // появится висячий `</...>`.
    if (info?.kind === 'close' && !stack.some((tag) => tag.name === info.name)) {
      const pending = droppedOpens.get(info.name) ?? 0
      if (pending > 0) droppedOpens.set(info.name, pending - 1)
      index += 1
      continue
    }

    const emission = tokenEmission(stack, token)
    if (chunk.length + emission.emitted.length + closingLength(emission.after) <= limit) {
      chunk += emission.emitted
      stack = emission.after
      hasContent = hasContent || token.kind !== 'tag' || info?.kind === 'void'
      index += 1
      continue
    }

    if (hasContent) {
      flush()
      continue
    }

    if (token.kind === 'text') {
      const available = limit - chunk.length - closingLength(stack)
      if (available <= 0 && stack.length > 0) {
        // Деградируем только когда обёртка не оставляет места даже символу.
        // Длинное слово само по себе не повод терять переносимые теги.
        stack.pop()
        chunk = reopenTags(stack)
        continue
      }
      if (available > 0) {
        chunk += token.raw.slice(0, available)
        const rest = token.raw.slice(available)
        if (rest) tokens[index] = { raw: rest, kind: 'text' }
        else index += 1
        flush()
        continue
      }
      index += 1
      continue
    }

    // Атомарный токен не влезает целиком: часть уже закрыта выше, если в ней
    // был контент. Здесь часть пустая — пробуем ужать переносимые теги.
    const shrunk = shrinkToFit(stack, token, limit)
    if (shrunk !== null) {
      stack = shrunk
      chunk = reopenTags(stack)
      continue
    }

    if (token.kind === 'entity') {
      const decoded = decodeEntity(token.raw)
      if (
        decoded !== '' &&
        decoded !== '<' &&
        decoded !== '>' &&
        decoded.length <= limit &&
        reopenLength(stack) + decoded.length + closingLength(stack) <= limit
      ) {
        chunk += decoded
        hasContent = true
        index += 1
        continue
      }
      index += 1
      continue
    }

    // Слишком длинный тег: открывающий выбрасываем вместе с парным закрывающим,
    // закрывающий — просто выбрасываем.
    if (info?.kind === 'open') droppedOpens.set(info.name, (droppedOpens.get(info.name) ?? 0) + 1)
    index += 1
  }

  const tail = chunk + closingTags(stack)
  if (tail.length > 0) parts.push(tail)
  return parts
}
