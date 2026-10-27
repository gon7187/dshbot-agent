// Очередь уведомлений сборщиков: карточки JSON из каталога очереди уходят
// владельцу в Telegram без хода модели.
//
// Сборщики (Яндекс/Exchange, Bitrix24, отчёты WB) кладут в каталог файлы
// `<sha256>.json`; после успешной отправки файл переименовывается в
// `<имя>.json.accepted`, битый — в `<имя>.json.rejected`. Модуль не владеет
// состоянием демона: каталог, Telegram API, проверка владельца и журнал
// приходят снаружи, поэтому цикл проверяется интеграционным тестом против
// настоящего процесса демона и фальшивого Bot API.
//
// Правила разбора и отправки:
// - файл-симлинк, файл больше 64 КиБ, не-JSON, карточка без title или
//   notification_id и артефакт без целого PNG отклоняются молча, одной
//   строкой журнала без текста карточки;
// - карточки старше 24 часов при первом обнаружении считаются сводкой
//   по источникам; первое обнаружение сохраняется в `.json.seen`, файлы
//   переименовываются только после успешной сводки;
// - ошибка Telegram оставляет `.json` на месте, следующий опрос повторит;
// - отчёт версии 3 раскладывается на сообщения по блокам, отчёт версии 2
//   показывается как обычная карточка.

import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'

import type { TelegramApi } from '../../telegram/src/api.js'

/** Каталог очереди внутри DSHBOT_HOME, когда DSHBOT_NOTIFY_QUEUE не задан. */
export const NOTIFY_QUEUE_DIRNAME = 'notification-queue'

/** Наибольший принимаемый файл карточки. */
export const NOTIFY_CARD_LIMIT = 64 * 1024

/** Уведомление старше этого возраста считается старым. */
export const NOTIFY_OLD_MS = 24 * 60 * 60 * 1000

/** Как часто демон смотрит в каталог: карточка должна дойти за 10 секунд. */
export const NOTIFY_POLL_INTERVAL_MS = 1_000

/** Переменная окружения с периодом опроса очереди в миллисекундах. */
export const NOTIFY_POLL_ENV = 'DSHBOT_NOTIFY_POLL_MS'

/**
 * Период опроса очереди: `DSHBOT_NOTIFY_POLL_MS` или {@link NOTIFY_POLL_INTERVAL_MS}.
 * Не число, ноль и отрицательное значение оставляют обычный период: очередь
 * не должна исчезнуть из-за опечатки в env-файле.
 */
export function notifyPollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[NOTIFY_POLL_ENV] ?? '').trim()
  if (raw === '') return NOTIFY_POLL_INTERVAL_MS
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return NOTIFY_POLL_INTERVAL_MS
  return parsed
}

/** Лимит текста одного сообщения Telegram в единицах UTF-16. */
export const NOTIFY_TEXT_LIMIT = 4096

/** Лимит подписи к медиа Telegram в единицах UTF-16. */
export const NOTIFY_CAPTION_LIMIT = 1024

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Ширина колонки таблицы в моноширинном блоке. */
const TABLE_COLUMN_LIMIT = 32

/** Разделитель блоков отчёта; Telegram не даёт горизонтальной линии. */
const DIVIDER = '────────────'

export type FragmentStyle = 'plain' | 'bold' | 'italic' | 'code'

/** Фрагмент текста отчёта: текст и его оформление. */
export interface NotifyFragment {
  text: string
  style: FragmentStyle
}

export interface NotifyTableBlock {
  kind: 'table'
  columns: string[]
  rows: NotifyFragment[][][]
  caption: NotifyFragment[]
}

export type NotifyReportBlock =
  | { kind: 'heading'; text: NotifyFragment[] }
  | { kind: 'paragraph'; text: NotifyFragment[] }
  | { kind: 'photo'; artifactId: string; caption: NotifyFragment[] }
  | NotifyTableBlock
  | { kind: 'divider' }

export interface NotifyArtifact {
  id: string
  mime: string
}

export interface NotifyCard {
  notificationId: string
  source: string
  category: string
  /** Время наблюдения в миллисекундах; `undefined`, когда поле не задано. */
  observedAtMs: number | undefined
  title: string
  summary: string
  excerpt: string | undefined
  url: string | undefined
  artifact: NotifyArtifact | undefined
  /** Блоки отчёта версии 3; `undefined` для обычной карточки и версии 2. */
  blocks: NotifyReportBlock[] | undefined
}

export interface NotifyQueueDeps {
  /** DSHBOT_HOME: каталог очереди по умолчанию. */
  home: string
  api: TelegramApi
  /** Чат владельца; `null`, пока владелец не подключён. */
  ownerChatId: () => number | null
  /** Строка журнала; текст карточки сюда не попадает. */
  log: (message: string) => void
  /** Окружение; по умолчанию process.env (тесты передают своё). */
  env?: NodeJS.ProcessEnv
  /** Интервал опроса; тесты могут изменить. */
  intervalMs?: number
  /** Часы; тесты подменяют для старых карточек. */
  now?: () => number
  /** Вызывается после каждой успешной отправки, чтобы учесть кулдаун владельца. */
  onDelivered?: (chatId: number) => void
}

export interface NotifyQueue {
  start(): void
  stop(): Promise<void>
  /** Один проход по каталогу; отдельно вызывается тестами. */
  tick(): Promise<void>
  /** Каталог, который читает очередь. */
  readonly directory: string
}

/** Каталог очереди: DSHBOT_NOTIFY_QUEUE или DSHBOT_HOME/notification-queue. */
export function notifyQueueDirectory(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.DSHBOT_NOTIFY_QUEUE ?? '').trim()
  if (override !== '') return resolve(override)
  return join(home, NOTIFY_QUEUE_DIRNAME)
}

class CardError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CardError'
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return undefined
}

function safeArtifactId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new CardError('недопустимый id артефакта')
  }
  return value
}

function asFragmentList(value: unknown): NotifyFragment[] {
  if (!Array.isArray(value)) throw new CardError('фрагменты текста не список')
  return value.map((item) => {
    const object = asObject(item)
    if (object === undefined || typeof object.text !== 'string') throw new CardError('фрагмент без текста')
    const style = object.style === undefined ? 'plain' : object.style
    if (style !== 'plain' && style !== 'bold' && style !== 'italic' && style !== 'code') {
      throw new CardError('неизвестное оформление фрагмента')
    }
    return { text: object.text, style }
  })
}

function asOptionalFragmentList(value: unknown): NotifyFragment[] {
  return value === undefined ? [] : asFragmentList(value)
}

/** Проверяет структуру PNG и CRC: IHDR, непрерывные IDAT с данными, IEND. */
function pngProblem(data: Buffer): string | undefined {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'не PNG'
  let offset = 8
  let sawHeader = false
  let sawPalette = false
  let sawIdat = false
  let sawImageData = false
  let endedIdat = false
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > data.length) return 'PNG обрезан'
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return 'PNG: неверный тип чанка'
    if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return 'PNG: неверная CRC'
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return 'PNG без IHDR'
      const width = data.readUInt32BE(offset + 8)
      const height = data.readUInt32BE(offset + 12)
      const depth = data[offset + 16] as number
      const color = data[offset + 17] as number
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff
        || !depths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0
        || (data[offset + 20] !== 0 && data[offset + 20] !== 1)) return 'PNG: неверный IHDR'
      sawHeader = true
    } else if (type === 'IHDR') {
      return 'PNG: повторный IHDR'
    }
    if (type === 'PLTE') {
      if (sawPalette || sawIdat || length === 0 || length > 768 || length % 3 !== 0) return 'PNG: неверный PLTE'
      sawPalette = true
    }
    if (type === 'IDAT') {
      if (endedIdat) return 'PNG: разорванные IDAT'
      // Цветовая модель хранится в IHDR по фиксированному смещению.
      if (data[25] === 3 && !sawPalette) return 'PNG: нет палитры'
      sawIdat = true
      if (length > 0) sawImageData = true
    } else if (sawIdat) {
      endedIdat = true
    }
    if (type === 'IEND') {
      if (length !== 0) return 'PNG: неверный IEND'
      if (!sawImageData) return 'PNG без данных IDAT'
      return end === data.length ? undefined : 'PNG: данные после IEND'
    }
    if (!['IHDR', 'PLTE', 'IDAT'].includes(type) && type[0] === type[0]?.toUpperCase()) {
      return 'PNG: неизвестный обязательный чанк'
    }
    offset = end
  }
  if (!sawHeader) return 'PNG без IHDR'
  return offset === data.length ? 'PNG без IEND' : 'PNG обрезан'
}

/** Проверяет файл артефакта; возвращает причину отказа или undefined. */
function artifactProblem(artifactsDir: string, id: string, mime: string | undefined): string | undefined {
  if (mime !== undefined && mime !== 'image/png') return 'артефакт не image/png'
  const path = join(artifactsDir, `${id}.png`)
  let status: ReturnType<typeof lstatSync>
  try {
    status = lstatSync(path)
  } catch {
    return 'нет PNG артефакта'
  }
  if (status.isSymbolicLink() || !status.isFile()) return 'артефакт не обычный файл'
  let data: Buffer
  try {
    data = readFileSync(path)
  } catch {
    return 'PNG артефакта не читается'
  }
  return pngProblem(data)
}

function parseArtifact(value: unknown, artifactsDir: string): NotifyArtifact | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (object === undefined) throw new CardError('artifact не объект')
  const id = safeArtifactId(object.id)
  const mime = typeof object.mime === 'string' ? object.mime : undefined
  const problem = artifactProblem(artifactsDir, id, mime)
  if (problem !== undefined) throw new CardError(problem)
  return { id, mime: mime ?? 'image/png' }
}

function parseReportBlock(value: unknown): NotifyReportBlock {
  const object = asObject(value)
  if (object === undefined) throw new CardError('блок отчёта не объект')
  const type = object.type
  if (type === 'heading') return { kind: 'heading', text: asFragmentList(object.text) }
  if (type === 'paragraph') return { kind: 'paragraph', text: asFragmentList(object.text) }
  if (type === 'divider') return { kind: 'divider' }
  if (type === 'photo') {
    return {
      kind: 'photo',
      artifactId: safeArtifactId(object.artifact_id),
      caption: asOptionalFragmentList(object.caption),
    }
  }
  if (type === 'table') {
    if (!Array.isArray(object.columns) || object.columns.some((column) => typeof column !== 'string')) {
      throw new CardError('колонки таблицы не строки')
    }
    if (!Array.isArray(object.rows)) throw new CardError('строки таблицы не список')
    const rows = object.rows.map((row) => {
      if (!Array.isArray(row)) throw new CardError('строка таблицы не список ячеек')
      return row.map((cell) => asFragmentList(cell))
    })
    return {
      kind: 'table',
      columns: object.columns as string[],
      rows,
      caption: asOptionalFragmentList(object.caption),
    }
  }
  throw new CardError('неизвестный блок отчёта')
}

function parseReport(value: unknown, artifactsDir: string): NotifyReportBlock[] | undefined {
  const object = asObject(value)
  if (object === undefined) return undefined
  if (object.version !== 3) return undefined
  if (!Array.isArray(object.blocks)) throw new CardError('отчёт без блоков')
  const blocks = object.blocks.map((block) => parseReportBlock(block))

  // Проверяем все описанные PNG и фото без отдельного описания, прежде
  // чем отчёт сможет отправить даже свой заголовок.
  const described = new Map<string, string | undefined>()
  if (object.artifacts !== undefined) {
    if (!Array.isArray(object.artifacts)) throw new CardError('artifacts отчёта не список')
    for (const item of object.artifacts) {
      const description = asObject(item)
      if (description === undefined) throw new CardError('описание артефакта не объект')
      const id = safeArtifactId(description.id)
      const mime = typeof description.mime === 'string' ? description.mime : undefined
      const problem = artifactProblem(artifactsDir, id, mime)
      if (problem !== undefined) throw new CardError(problem)
      described.set(id, mime)
    }
  }
  for (const block of blocks) {
    if (block.kind !== 'photo' || described.has(block.artifactId)) continue
    const problem = artifactProblem(artifactsDir, block.artifactId, described.get(block.artifactId))
    if (problem !== undefined) throw new CardError(problem)
  }
  return blocks
}

/** Разбирает и полностью проверяет карточку до любой отправки. */
export function parseNotificationCard(raw: Buffer, artifactsDir: string): NotifyCard {
  if (raw.length > NOTIFY_CARD_LIMIT) throw new CardError(`больше ${NOTIFY_CARD_LIMIT} байт`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    // Текст ошибки JSON.parse может содержать фрагмент карточки: в журнал он
    // попадать не должен.
    throw new CardError('не JSON')
  }
  const object = asObject(parsed)
  if (object === undefined) throw new CardError('карточка не объект')
  const notificationId = typeof object.notification_id === 'string' ? object.notification_id.trim() : ''
  if (notificationId === '') throw new CardError('нет notification_id')
  const title = typeof object.title === 'string' ? object.title : ''
  if (title.trim() === '') throw new CardError('нет title')
  const summary = object.summary === undefined ? '' : object.summary
  if (typeof summary !== 'string') throw new CardError('summary не строка')
  const excerpt = object.excerpt === undefined ? undefined : object.excerpt
  if (excerpt !== undefined && typeof excerpt !== 'string') throw new CardError('excerpt не строка')
  const url = object.url === undefined ? undefined : object.url
  if (url !== undefined && typeof url !== 'string') throw new CardError('url не строка')

  const observed = object.observed_at
  const observedAtMs =
    typeof observed === 'number' && Number.isFinite(observed) && observed > 0 ? Math.round(observed * 1000) : undefined

  return {
    notificationId,
    source: typeof object.source === 'string' && object.source !== '' ? object.source : 'unknown',
    category: typeof object.category === 'string' ? object.category : '',
    observedAtMs,
    title,
    summary,
    excerpt,
    url,
    artifact: parseArtifact(object.artifact, artifactsDir),
    blocks: parseReport(object.report, artifactsDir),
  }
}

interface Atom {
  ch: string
  style: FragmentStyle
}

function atomsOf(fragments: readonly NotifyFragment[]): Atom[] {
  const atoms: Atom[] = []
  for (const fragment of fragments) {
    for (const ch of fragment.text) atoms.push({ ch, style: fragment.style })
  }
  return atoms
}

/**
 * Режет поток на куски не длиннее `limit` единиц UTF-16, по возможности по пробелу
 * или переводу строки: текст не теряется, а теги собираются заново для каждой
 * части, поэтому разорванных тегов не бывает.
 */
function chunkAtoms(atoms: Atom[], limit: number): Atom[][] {
  const chunks: Atom[][] = []
  let start = 0
  while (start < atoms.length) {
    let end = start
    let length = 0
    while (end < atoms.length && length + (atoms[end] as Atom).ch.length <= limit) {
      length += (atoms[end] as Atom).ch.length
      end += 1
    }
    if (end === start) throw new Error('Лимит текста меньше одного символа UTF-16')
    if (end < atoms.length) {
      const previous = atoms[end - 1] as Atom
      const next = atoms[end] as Atom
      const high = previous.ch.charCodeAt(previous.ch.length - 1)
      const low = next.ch.charCodeAt(0)
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1
    }
    if (end < atoms.length) {
      let br = -1
      for (let i = end - 1; i > start; i -= 1) {
        const ch = (atoms[i] as Atom).ch
        if (ch === ' ' || ch === '\n' || ch === '\t') {
          br = i
          break
        }
      }
      if (br > start) end = br + 1
    }
    if (end <= start) throw new Error('Лимит текста меньше одного символа UTF-16')
    chunks.push(atoms.slice(start, end))
    start = end
  }
  return chunks.filter((chunk) => chunk.length > 0)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Собирает кусок обратно в Telegram HTML: только парные разрешённые теги. */
function atomsToHtml(atoms: readonly Atom[]): string {
  let html = ''
  let index = 0
  while (index < atoms.length) {
    const style = (atoms[index] as Atom).style
    let text = ''
    while (index < atoms.length && (atoms[index] as Atom).style === style) {
      text += (atoms[index] as Atom).ch
      index += 1
    }
    const escaped = escapeHtml(text)
    if (style === 'bold') html += `<b>${escaped}</b>`
    else if (style === 'italic') html += `<i>${escaped}</i>`
    else if (style === 'code') html += `<code>${escaped}</code>`
    else html += escaped
  }
  return html
}

async function sendText(api: TelegramApi, chatId: number, html: string): Promise<void> {
  await api.call('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
}

/** Отправляет фрагменты как одно или несколько сообщений. */
async function sendFragments(
  api: TelegramApi,
  chatId: number,
  fragments: readonly NotifyFragment[],
): Promise<number> {
  const chunks = chunkAtoms(atomsOf(fragments), NOTIFY_TEXT_LIMIT)
  for (const chunk of chunks) await sendText(api, chatId, atomsToHtml(chunk))
  return chunks.length
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cardText(card: NotifyCard): NotifyFragment[] {
  const fragments: NotifyFragment[] = [{ text: card.title, style: 'bold' }]
  if (card.summary !== '') fragments.push({ text: '\n', style: 'plain' }, { text: card.summary, style: 'plain' })
  if (card.excerpt !== undefined && card.excerpt !== '') {
    fragments.push({ text: '\n', style: 'plain' }, { text: card.excerpt, style: 'plain' })
  }
  if (card.url !== undefined && card.url !== '') fragments.push({ text: '\n', style: 'plain' }, { text: card.url, style: 'plain' })
  return fragments
}

/** Текст ячейки без оформления: в pre вложенные теги Telegram не принимает. */
function cellText(cell: readonly NotifyFragment[]): string {
  return cell.map((fragment) => fragment.text).join('')
}

function displayLength(text: string): number {
  return [...text].length
}

function wrapCell(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  const push = (): void => {
    lines.push(current)
    current = ''
  }
  for (const word of words) {
    if (displayLength(word) > width) {
      // Слово длиннее колонки: режем по символам, чтобы не потерять текст.
      let rest = word
      if (current !== '') push()
      while (displayLength(rest) > width) {
        const chars = [...rest]
        lines.push(chars.slice(0, width).join(''))
        rest = chars.slice(width).join('')
      }
      current = rest
      continue
    }
    const candidate = current === '' ? word : `${current} ${word}`
    if (displayLength(candidate) > width) {
      push()
      current = word
    } else {
      current = candidate
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current)
  return lines
}

function pad(text: string, width: number): string {
  const missing = width - displayLength(text)
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text
}

/**
 * Рисует таблицу моноширинными строками: все колонки и строки на месте,
 * длинные ячейки переносятся, а не обрезаются. Строки потом пакуются в
 * отдельные `<pre>`-сообщения по границам строк.
 */
export function tableLines(block: NotifyTableBlock): string[] {
  const columnCount = Math.max(block.columns.length, ...block.rows.map((row) => row.length), 1)
  const columns = Array.from({ length: columnCount }, (_, index) => block.columns[index] ?? '')
  const rows = block.rows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? []))
  const widths = Array.from({ length: columnCount }, (_, index) => {
    const header = displayLength(columns[index] ?? '')
    const cells = rows.map((row) => displayLength(cellText(row[index] ?? [])))
    return Math.min(TABLE_COLUMN_LIMIT, Math.max(1, header, ...cells))
  })
  // Переносы каждой ячейки считаются заранее, чтобы строки таблицы шли
  // построчно, а не по ячейкам.
  const wrapped = rows.map((row) => row.map((cell, index) => wrapCell(cellText(cell), widths[index] as number)))
  const lineOf = (cells: string[]): string =>
    cells
      .map((cell, index) => pad(cell, widths[index] as number))
      .join(' | ')
      .replace(/\s+$/, '')
  const lines: string[] = [lineOf(columns)]
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + 3 * Math.max(0, columnCount - 1)
  lines.push('─'.repeat(Math.max(1, totalWidth)))
  for (const row of wrapped) {
    const height = Math.max(1, ...row.map((cell) => cell.length))
    for (let line = 0; line < height; line += 1) {
      lines.push(lineOf(row.map((cell) => cell[line] ?? '')))
    }
  }
  return lines
}

function packTable(lines: string[]): string[] {
  const messages: string[] = []
  let current: string[] = []
  let length = 0
  const flush = (): void => {
    if (current.length === 0) return
    messages.push(`<pre>${escapeHtml(current.join('\n'))}</pre>`)
    current = []
    length = 0
  }
  for (const line of lines) {
    const pieces = line.length <= NOTIFY_TEXT_LIMIT - 2
      ? [line]
      : chunkAtoms(atomsOf([{ text: line, style: 'plain' }]), NOTIFY_TEXT_LIMIT - 2)
        .map((chunk) => chunk.map((atom) => atom.ch).join(''))
    for (const piece of pieces) {
      if (length > 0 && length + piece.length + 1 > NOTIFY_TEXT_LIMIT - 1) flush()
      current.push(piece)
      length += piece.length + 1
    }
  }
  flush()
  return messages
}

async function sendPhoto(
  api: TelegramApi,
  chatId: number,
  artifactsDir: string,
  artifactId: string,
  caption: readonly NotifyFragment[],
): Promise<void> {
  const chunks = chunkAtoms(atomsOf(caption), NOTIFY_CAPTION_LIMIT)
  const first = chunks[0]
  const data = readFileSync(join(artifactsDir, `${artifactId}.png`))
  const params: Record<string, unknown> = { chat_id: chatId }
  if (first !== undefined) {
    params.caption = atomsToHtml(first)
    params.parse_mode = 'HTML'
  }
  await api.call('sendPhoto', params, {
    photo: { name: `${artifactId}.png`, data, contentType: 'image/png' },
  })
  for (const rest of chunks.slice(1)) await sendText(api, chatId, atomsToHtml(rest))
}

async function deliverReport(
  api: TelegramApi,
  chatId: number,
  card: NotifyCard,
  artifactsDir: string,
): Promise<void> {
  const blocks = card.blocks ?? []
  await sendFragments(api, chatId, cardText(card))
  for (const block of blocks) {
    if (block.kind === 'heading' || block.kind === 'paragraph') {
      await sendFragments(api, chatId, block.text)
      continue
    }
    if (block.kind === 'photo') {
      await sendPhoto(api, chatId, artifactsDir, block.artifactId, block.caption)
      continue
    }
    if (block.kind === 'table') {
      for (const message of packTable(tableLines(block))) await sendText(api, chatId, message)
      if (block.caption.length > 0) await sendFragments(api, chatId, block.caption)
      continue
    }
    await sendFragments(api, chatId, [{ text: DIVIDER, style: 'plain' }])
  }
}

async function deliverCard(
  api: TelegramApi,
  chatId: number,
  card: NotifyCard,
  artifactsDir: string,
): Promise<void> {
  if (card.blocks !== undefined) {
    await deliverReport(api, chatId, card, artifactsDir)
    return
  }
  if (card.artifact !== undefined) {
    await sendPhoto(api, chatId, artifactsDir, card.artifact.id, cardText(card))
    return
  }
  await sendFragments(api, chatId, cardText(card))
}

function isMissing(error: unknown): boolean {
  return asObject(error)?.code === 'ENOENT' || (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

function renameTo(directory: string, name: string, suffix: string): void {
  renameSync(join(directory, name), join(directory, `${name}${suffix}`))
}

function summaryText(groups: Map<string, string[]>): string {
  const total = [...groups.values()].reduce((sum, files) => sum + files.length, 0)
  const lines = [`Пропущено старых уведомлений: ${total} (старше 24 ч)`]
  for (const [source, files] of groups) lines.push(`${source}: ${files.length} уведомлений`)
  return lines.join('\n')
}

export function createNotifyQueue(deps: NotifyQueueDeps): NotifyQueue {
  const directory = notifyQueueDirectory(deps.home, deps.env ?? process.env)
  const artifactsDir = join(dirname(directory), 'artifacts')
  const intervalMs = deps.intervalMs !== undefined && deps.intervalMs > 0
    ? deps.intervalMs
    : notifyPollIntervalMs(deps.env ?? process.env)
  const now = deps.now ?? Date.now

  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> | undefined
  let stopped = false
  let missingReported = false
  const firstSeen = new Map<string, { sha256: string; atMs: number; persisted: boolean }>()

  /**
   * Возраст фиксируется до отправки, а не после неё. Отдельный атомарный
   * sidecar переживает рестарт и не меняет JSON, принадлежащий сборщику.
   * Хеш не даёт применить старую отметку к заменённому содержимому файла.
   */
  function firstSeenAt(name: string, raw: Buffer, detectedAtMs: number): number {
    const sha256 = createHash('sha256').update(raw).digest('hex')
    const statePath = join(directory, `${name}.seen`)
    let record = firstSeen.get(name)
    if (record?.sha256 !== sha256) record = undefined
    if (record === undefined) {
      let saved: Record<string, unknown> | undefined
      try {
        const status = lstatSync(statePath)
        if (!status.isFile() || status.isSymbolicLink() || status.size > 1024) {
          throw new Error('неверный файл отметки первого обнаружения')
        }
        saved = asObject(JSON.parse(readFileSync(statePath, 'utf8')) as unknown)
        if (saved?.version !== 1 || typeof saved.sha256 !== 'string'
          || typeof saved.atMs !== 'number' || !Number.isFinite(saved.atMs)) {
          throw new Error('неверная отметка первого обнаружения')
        }
      } catch (error) {
        if (!isMissing(error)) throw new Error('отметка первого обнаружения не читается')
      }
      record = saved?.sha256 === sha256
        ? { sha256, atMs: saved.atMs as number, persisted: true }
        : { sha256, atMs: detectedAtMs, persisted: false }
      firstSeen.set(name, record)
    }
    if (!record.persisted) {
      const temporary = `${statePath}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, sha256, atMs: record.atMs }), { flag: 'wx', mode: 0o600 })
        renameSync(temporary, statePath)
        record.persisted = true
      } finally {
        try { unlinkSync(temporary) } catch { /* После rename временного файла уже нет. */ }
      }
    }
    return record.atMs
  }

  function forget(name: string): void {
    firstSeen.delete(name)
    // Суффиксы accepted/rejected уже определяют результат. Остаток sidecar
    // после аварии или неудачной уборки на повторную доставку не влияет.
    try { unlinkSync(join(directory, `${name}.seen`)) } catch { /* Best effort. */ }
  }

  function reject(name: string, reason: string): void {
    try {
      renameTo(directory, name, '.rejected')
    } catch (error) {
      deps.log(`notify-queue: не удалось отклонить ${name}: ${describeError(error)}`)
      return
    }
    forget(name)
    deps.log(`notify-queue: отклонена ${name}: ${reason}`)
  }

  function accept(name: string): void {
    try {
      renameTo(directory, name, '.accepted')
      forget(name)
    } catch (error) {
      deps.log(`notify-queue: не удалось отметить ${name} доставленной: ${describeError(error)}`)
    }
  }

  async function pass(): Promise<void> {
    const chatId = deps.ownerChatId()
    if (chatId === null) return

    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch (error) {
      if (!missingReported) {
        missingReported = true
        const code = (error as NodeJS.ErrnoException).code
        deps.log(
          `notify-queue: каталог очереди не читается: ${directory}${code === undefined ? '' : ` (${code})`}`,
        )
      }
      return
    }
    missingReported = false

    const detectedAtMs = now()
    const found: Array<{ name: string; card: NotifyCard; firstSeenAtMs: number }> = []
    for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(directory, name)
      let status: ReturnType<typeof lstatSync>
      try {
        status = lstatSync(path)
      } catch (error) {
        if (isMissing(error)) continue
        reject(name, 'не читается')
        continue
      }
      if (status.isSymbolicLink()) {
        reject(name, 'символическая ссылка')
        continue
      }
      if (!status.isFile()) {
        reject(name, 'не обычный файл')
        continue
      }
      if (status.size > NOTIFY_CARD_LIMIT) {
        reject(name, `больше ${NOTIFY_CARD_LIMIT} байт`)
        continue
      }
      let raw: Buffer
      try {
        raw = readFileSync(path)
      } catch (error) {
        if (isMissing(error)) continue
        reject(name, 'не читается')
        continue
      }
      let card: NotifyCard
      try {
        card = parseNotificationCard(raw, artifactsDir)
      } catch (error) {
        reject(name, error instanceof CardError ? error.message : 'ошибка разбора')
        continue
      }
      try {
        found.push({ name, card, firstSeenAtMs: firstSeenAt(name, raw, detectedAtMs) })
      } catch {
        // Не отправляем, пока классификация не сохранена: иначе после
        // перезапуска ошибка Telegram может превратить свежую карточку в старую.
        deps.log(`notify-queue: не удалось сохранить первое обнаружение ${name}`)
        return
      }
    }

    const wasOld = (entry: typeof found[number]): boolean =>
      entry.card.observedAtMs !== undefined && entry.card.observedAtMs < entry.firstSeenAtMs - NOTIFY_OLD_MS
    const old = found.filter(wasOld)
    const fresh = found
      .filter((entry) => !wasOld(entry))
      .sort((a, b) => {
        const left = a.card.observedAtMs ?? a.firstSeenAtMs
        const right = b.card.observedAtMs ?? b.firstSeenAtMs
        return left - right || a.name.localeCompare(b.name)
      })

    if (old.length > 0) {
      const groups = new Map<string, string[]>()
      for (const entry of old) {
        const files = groups.get(entry.card.source) ?? []
        files.push(entry.name)
        groups.set(entry.card.source, files)
      }
      try {
        await sendText(deps.api, chatId, escapeHtml(summaryText(groups)))
        // Только после успешной сводки старые карточки считаются принятыми.
        for (const entry of old) accept(entry.name)
        deps.onDelivered?.(chatId)
      } catch (error) {
        deps.log(`notify-queue: сводка старых уведомлений не отправлена: ${describeError(error)}`)
      }
    }

    for (const entry of fresh) {
      if (stopped) return
      try {
        await deliverCard(deps.api, chatId, entry.card, artifactsDir)
      } catch (error) {
        deps.log(`notify-queue: карточка ${entry.name} не отправлена: ${describeError(error)}`)
        return
      }
      accept(entry.name)
      deps.onDelivered?.(chatId)
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (running !== undefined) return running
    running = pass().finally(() => {
      running = undefined
    })
    return running
  }

  function start(): void {
    if (timer !== undefined || stopped) return
    timer = setInterval(() => {
      void tick().catch((error: unknown) => deps.log(`notify-queue: опрос не удался: ${describeError(error)}`))
    }, intervalMs)
    timer.unref?.()
    void tick().catch((error: unknown) => deps.log(`notify-queue: опрос не удался: ${describeError(error)}`))
  }

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (running !== undefined) await running.catch(() => undefined)
  }

  return {
    start,
    stop,
    tick,
    directory,
  }
}
