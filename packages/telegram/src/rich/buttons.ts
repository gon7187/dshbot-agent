// Кнопки в тексте ответа модели: `<tg-button ...>` из Rich Markdown.
//
// Значение `data`, написанное моделью, никогда не уходит в Telegram как есть:
// кнопка-ответ получает callback_data реестра reply-кнопок бота (тот же, что у
// инструмента message), поэтому подделать нажатие карточки подтверждения
// (`tga1:`, `tga1r:`) или предложения (`lp1:`) текстом нельзя.
//
// Кнопки url и copy_text проходят, если адрес начинается с http://, https://
// или tg://; кнопки неизвестного типа и кнопки без текста вырезаются вместе со
// своим содержимым, а текст вокруг них остаётся.

/** Реестр reply-кнопок бота: текст → короткий callback_data (≤ 64 байт). */
export interface ButtonRegistryLike {
  create(text: string): string
}

/** Кнопка inline-клавиатуры Bot API. */
export interface InlineKeyboardButton {
  text: string
  url?: string
  callback_data?: string
  copy_text?: { text: string }
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface ExtractedButtons {
  /** Текст ответа без тегов кнопок; текст вокруг кнопок сохранён. */
  text: string
  /** Клавиатура для последней части ответа; отсутствует, когда кнопок нет. */
  keyboard?: InlineKeyboardMarkup
}

// Атрибуты открывающего тега разбираются с учётом кавычек: `>` внутри
// значения не обрывает тег, а подпись не может содержать другой `<tg-button`,
// иначе data вложенного тега ушла бы в текст кнопки.
const OPEN_ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`
const BUTTON_ROW_OPEN_RE = new RegExp(String.raw`^<tg-button-row\b${OPEN_ATTRS}>$`, 'i')
const BUTTON_ROW_CLOSE_RE = /^<\/tg-button-row\s*>$/i
const TAG_TOKEN_RE = new RegExp(
  String.raw`<tg-button-row\b${OPEN_ATTRS}>|<\/tg-button-row\s*>|<tg-button(?![\w-])${OPEN_ATTRS}>(?:(?!<tg-button)[\s\S])*?<\/tg-button\s*>`,
  'gi',
)
const BUTTON_ELEMENT_RE = new RegExp(
  String.raw`^<tg-button(?![\w-])(${OPEN_ATTRS})>([\s\S]*)<\/tg-button\s*>$`,
  'i',
)
/** Открывающий тег целиком (с `>`), начиная с текущей позиции. */
const OPEN_TAG_AT_RE = new RegExp(String.raw`<tg-button(?:-row)?\b${OPEN_ATTRS}>`, 'iy')
const STRAY_CLOSE_RE = /<\/tg-button(?:-row)?\s*>/gi
const TAG_START_RE = /<tg-button/gi
/** Хвост буфера, который ещё может дорасти до `<tg-button`. */
const PARTIAL_PREFIX_RE = /<(?:t(?:g(?:-(?:b(?:u(?:t(?:t(?:o(?:n)?)?)?)?)?)?)?)?)?$/i
const ATTRIBUTE_RE = /([a-zA-Z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
/** Bot API не принимает copy_text длиннее 256 символов: такая кнопка вырезается. */
const COPY_TEXT_LIMIT = 256

function attributesOf(raw: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of raw.matchAll(ATTRIBUTE_RE)) {
    const name = (match[1] ?? '').toLowerCase()
    const value = match[2] ?? match[3] ?? ''
    found[name] = value
  }
  return found
}

function safeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const url = value.trim()
  return /^(?:https?|tg):\/\//i.test(url) ? url : undefined
}

/**
 * Одна кнопка из атрибутов и подписи. `null` — кнопку нужно вырезать:
 * неизвестный тип, пустая подпись или небезопасный адрес.
 */
function buttonOf(
  attributes: Record<string, string>,
  label: string,
  registry: ButtonRegistryLike | undefined,
): InlineKeyboardButton | null {
  const text = label.trim()
  if (text === '') return null
  const type = (attributes.type ?? '').trim().toLowerCase()

  if (type === 'callback_data') {
    // `data` модели намеренно игнорируется: наружу уходит только реестр.
    if (registry === undefined) return null
    return { text, callback_data: registry.create(text) }
  }
  if (type === 'url') {
    const url = safeUrl(attributes.url)
    return url === undefined ? null : { text, url }
  }
  if (type === 'copy_text') {
    const original = attributes.text ?? ''
    // Проверяем исходный атрибут до trim(), включая краевые пробелы.
    // Считаем символы, а не UTF-16 единицы: предел Telegram — 256 символов.
    if ([...original].length > COPY_TEXT_LIMIT) return null
    const payload = original.trim()
    if (payload === '') return null
    return { text, copy_text: { text: payload } }
  }
  return null
}

/**
 * Текст между целыми кнопками: висящие закрывающие теги и открывающие теги
 * без пары вырезаются вместе с атрибутами. Тег, который не дописан до `>`,
 * обрезает текст до конца отрезка: его data ещё в полёте. В превью (`partial`)
 * незакрытая кнопка обрезает текст до конца буфера вместе с подписью, а хвост,
 * который может дорасти до `<tg-button`, не показывается.
 */
function cleanSegment(segment: string, isLast: boolean, partial: boolean): string {
  let text = ''
  let at = 0
  TAG_START_RE.lastIndex = 0
  for (let match = TAG_START_RE.exec(segment); match !== null; match = TAG_START_RE.exec(segment)) {
    const index = match.index
    if (index < at) continue
    text += segment.slice(at, index)
    OPEN_TAG_AT_RE.lastIndex = index
    const open = OPEN_TAG_AT_RE.exec(segment)
    if (open === null || (partial && isLast && !/^<tg-button-row/i.test(open[0]))) {
      at = segment.length
      break
    }
    at = index + open[0].length
    TAG_START_RE.lastIndex = at
  }
  text += segment.slice(at)
  text = text.replace(STRAY_CLOSE_RE, '')
  return partial && isLast ? text.replace(PARTIAL_PREFIX_RE, '') : text
}

function extract(
  markdown: string,
  registry: ButtonRegistryLike | undefined,
  partial: boolean,
): ExtractedButtons {
  const rows: InlineKeyboardButton[][] = []
  let currentRow: InlineKeyboardButton[] | undefined
  let text = ''
  let at = 0

  const pushRow = (): void => {
    if (currentRow !== undefined && currentRow.length > 0) rows.push(currentRow)
    currentRow = undefined
  }

  for (const match of markdown.matchAll(TAG_TOKEN_RE)) {
    const token = match[0]
    const index = match.index ?? 0
    text += cleanSegment(markdown.slice(at, index), false, partial)
    at = index + token.length

    if (BUTTON_ROW_OPEN_RE.test(token)) {
      pushRow()
      currentRow = []
      continue
    }
    if (BUTTON_ROW_CLOSE_RE.test(token)) {
      pushRow()
      continue
    }
    const element = BUTTON_ELEMENT_RE.exec(token)
    if (element === null) continue
    const button = buttonOf(attributesOf(element[1] ?? ''), element[2] ?? '', registry)
    if (button === null) continue
    if (currentRow === undefined) currentRow = []
    currentRow.push(button)
  }

  text += cleanSegment(markdown.slice(at), true, partial)
  pushRow()
  return rows.length === 0 ? { text } : { text, keyboard: { inline_keyboard: rows } }
}

/**
 * Достаёт кнопки из текста ответа. Без реестра (черновик, предпросмотр)
 * кнопки только вырезаются, чтобы `data` модели не ушёл даже в разметке.
 */
export function extractButtons(markdown: string, registry?: ButtonRegistryLike): ExtractedButtons {
  return extract(markdown, registry, false)
}

/** Текст без кнопок: для черновика и простого текста кнопки не нужны. */
export function stripButtons(markdown: string): string {
  return extract(markdown, undefined, false).text
}

/**
 * Текст превью стрима без кнопок: ответ ещё дописывается, поэтому незакрытая
 * кнопка или тег без `>` скрываются до конца буфера вместе с атрибутами.
 */
export function stripPreviewButtons(markdown: string): string {
  return extract(markdown, undefined, true).text
}
