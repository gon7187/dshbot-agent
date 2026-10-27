// Отправка финального ответа с лестницей rich → HTML → простой текст.
//
// Rich-сообщения Bot API 10.1+ принимают Rich Markdown в
// `rich_message.markdown`: Telegram сам разбирает GFM и теги вроде <details>,
// ||спойлер||, формул и кнопок. Конвертер в blocks оставлен только для отката
// на HTML/простой текст, когда rich-часть отклонена.

import { TelegramApiError, type FileUpload, type TelegramApi } from '../api.js'
import { stripButtons } from './buttons.js'
import { chunkText, markdownToHtml, markdownToPlain } from './html.js'
import {
  normalizeMarkdownHardBreaks,
  RICH_BLOCK_LIMIT,
  RICH_CHAR_LIMIT,
  splitMarkdown,
} from './native.js'

/** Формат, которым финальный ответ реально ушёл в чат. */
export type DeliveryMode = 'rich' | 'html' | 'plain'

/** Как прошла доставка: её читает заметка модели о прошлом ходе. */
export interface DeliveryReport {
  mode: DeliveryMode
  /** Сколько сообщений реально ушло в чат (включая части HTML/простого текста). */
  parts: number
  /** Описание ошибки Telegram, из-за которой сработал фолбэк. */
  error?: string
  /**
   * Описание 400, которым Telegram отверг саму клавиатуру ответа: текст ушёл
   * без кнопок, и следующий ход должен узнать, что кнопки не дошли.
   */
  keyboardError?: string
}

/** Состояние одной отправки: не повторять клавиатуру после её отказа. */
interface DeliveryState {
  /** Telegram уже отверг reply_markup: следующие части идут без клавиатуры. */
  markupRejected: boolean
  /** Первое описание ошибки клавиатуры для отчёта и заметки модели. */
  keyboardError?: string
}

/**
 * Медиа, вложенное в тело rich-сообщения. Bot API не забирает картинки по
 * внешнему URL: разметка ссылается на файл как `![](tg://photo?id=<id>)`, а
 * сам файл уходит вместе с сообщением в поле `rich_message.media`.
 */
export interface RichMediaInput {
  /** 1–64 символа из `A-Z a-z 0-9 _ -`; тот же id, что в `tg://photo?id=`. */
  id: string
  name: string
  data: Uint8Array
  contentType?: string
}

export interface SendFormattedOptions {
  threadId?: number
  replyMarkup?: unknown
  /** Message the answer replies to (the owner's message with the files). */
  replyToMessageId?: number
  /** Overrides of the rich-message limits (tests and unusual deployments). */
  maxChars?: number
  maxBlocks?: number
  /**
   * Картинки внутри тела rich-сообщения. Разметка ссылается на них как
   * `![](tg://photo?id=<id>)`; без этого поля Telegram принимает такую ссылку
   * молча, но ничего не рисует.
   */
  media?: RichMediaInput[]
  /** Вызывается один раз после успешной доставки: формат, части и ошибка фолбэка. */
  onDelivery?: (report: DeliveryReport) => void
}

const TEXT_LIMIT = 4096
/**
 * Telegram не принимает сообщение без текста, поэтому ответ из одних кнопок
 * уходит с этой подписью, а клавиатура остаётся при нём.
 */
const BUTTONS_ONLY_TEXT = '👇'

interface SentMessage {
  message_id?: number
}

function messageId(response: unknown): number | undefined {
  if (response && typeof response === 'object') {
    const value = (response as SentMessage).message_id
    if (typeof value === 'number') return value
  }
  return undefined
}

function isBadRequest(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.errorCode === 400
}

function isEntityParseError(error: TelegramApiError): boolean {
  const description = error.description.toLowerCase()
  return description.includes('parse entit')
}

function describeError(error: unknown): string {
  if (error instanceof TelegramApiError) return error.description
  if (error instanceof Error) return error.message
  return String(error)
}

function baseParams(chatId: number, options: SendFormattedOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { chat_id: chatId }
  if (options.threadId !== undefined) params.message_thread_id = options.threadId
  if (options.replyToMessageId !== undefined) params.reply_to_message_id = options.replyToMessageId
  return params
}

function withMarkup(
  params: Record<string, unknown>,
  options: SendFormattedOptions,
  isLast: boolean,
  state: DeliveryState,
): Record<string, unknown> {
  if (isLast && !state.markupRejected && options.replyMarkup !== undefined) {
    params.reply_markup = options.replyMarkup
  }
  return params
}

/**
 * Отправка одной части. Если Telegram отвечает 400 именно на часть с
 * клавиатурой, эта же часть повторяется без reply_markup: текст ответа важнее
 * кнопок, а уже доставленные части не повторяются. Отказ клавиатуры
 * запоминается для отчёта и заметки следующего хода.
 */
async function callWithMarkupRetry<T>(
  api: TelegramApi,
  method: string,
  params: Record<string, unknown>,
  state: DeliveryState,
  files?: Record<string, FileUpload>,
): Promise<T> {
  try {
    return await api.call<T>(method, params, files)
  } catch (error) {
    if (!isBadRequest(error) || params.reply_markup === undefined) throw error
    delete params.reply_markup
    // Повтор без клавиатуры. Если и он отвергнут, отказ был не в кнопках:
    // ошибка уходит на обычную лестницу rich → HTML → простой текст, а
    // клавиатура остаётся доступной следующей ступени.
    const result = await api.call<T>(method, params, files)
    state.markupRejected = true
    state.keyboardError ??= describeError(error)
    return result
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** HTML-часть отката → простой текст: теги убираются, сущности раскрываются. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (_match, dec, hex, name) => {
      if (dec !== undefined) return safeCodePoint(Number.parseInt(dec, 10))
      if (hex !== undefined) return safeCodePoint(Number.parseInt(hex, 16))
      return NAMED_ENTITIES[String(name).toLowerCase()] ?? ''
    })
}

async function sendRichPart(
  api: TelegramApi,
  chatId: number,
  markdown: string,
  options: SendFormattedOptions,
  isLast: boolean,
  state: DeliveryState,
): Promise<number | undefined> {
  const params = withMarkup(baseParams(chatId, options), options, isLast, state)
  const media = options.media ?? []
  if (media.length === 0) {
    params.rich_message = { markdown }
    return messageId(await callWithMarkupRetry<SentMessage>(api, 'sendRichMessage', params, state))
  }
  // Тело ссылается на файлы как tg://photo?id=<id>, а сами файлы уходят
  // multipart-ом: Bot API не забирает картинки по внешнему URL.
  params.rich_message = {
    markdown,
    media: media.map((item) => ({ id: item.id, media: { type: 'photo', media: `attach://${item.id}` } })),
  }
  const files: Record<string, FileUpload> = {}
  for (const item of media) {
    files[item.id] = {
      name: item.name,
      data: item.data,
      ...(item.contentType === undefined ? {} : { contentType: item.contentType }),
    }
  }
  return messageId(await callWithMarkupRetry<SentMessage>(api, 'sendRichMessage', params, state, files))
}

async function sendPlainChunks(
  api: TelegramApi,
  chatId: number,
  chunks: string[],
  options: SendFormattedOptions,
  isLastPart: boolean,
  state: DeliveryState,
): Promise<number[]> {
  const ids: number[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = isLastPart && index === chunks.length - 1
    const params = withMarkup(baseParams(chatId, options), options, isLast, state)
    params.text = chunks[index]
    const id = messageId(await callWithMarkupRetry<SentMessage>(api, 'sendMessage', params, state))
    if (id !== undefined) ids.push(id)
  }
  return ids
}

interface HtmlPartResult {
  /** Режим, в котором нужно отправлять следующие части. */
  mode: 'html' | 'plain'
  ids: number[]
  /** Описание ошибки разбора HTML, если эта часть ушла простым текстом. */
  error?: string
}

/**
 * Части отката собираются по границам блоков Markdown (абзац, пункт, строка
 * таблицы), а не рубятся посреди абзаца: Telegram получает целые куски, и
 * каждая часть — самостоятельный блок ответа. HTML-обёртка блока может вывести
 * кусок за лимит 4096, поэтому такой кусок дополнительно режется chunkText.
 */
function fallbackChunks(markdown: string, render: (md: string) => string): string[] {
  const chunks: string[] = []
  const pieces = splitMarkdown(markdown, {
    maxChars: Math.floor(TEXT_LIMIT * 0.9),
    maxBlocks: RICH_BLOCK_LIMIT,
  })
  for (const piece of pieces) {
    const rendered = render(piece)
    if (rendered.length <= TEXT_LIMIT) chunks.push(rendered)
    else chunks.push(...chunkText(rendered, TEXT_LIMIT))
  }
  return chunks
}

/**
 * Отправляет одну часть как HTML. Если Telegram отвечает ошибкой разметки,
 * остаток этой части и все следующие уходят простым текстом — уже отправленные
 * куски не повторяются.
 */
async function sendHtmlPart(
  api: TelegramApi,
  chatId: number,
  markdown: string,
  options: SendFormattedOptions,
  isLastPart: boolean,
  state: DeliveryState,
): Promise<HtmlPartResult> {
  const chunks = fallbackChunks(markdown, markdownToHtml)
  const ids: number[] = []

  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = isLastPart && index === chunks.length - 1
    const params = withMarkup(baseParams(chatId, options), options, isLast, state)
    params.text = chunks[index]
    params.parse_mode = 'HTML'
    try {
      const id = messageId(await callWithMarkupRetry<SentMessage>(api, 'sendMessage', params, state))
      if (id !== undefined) ids.push(id)
    } catch (error) {
      if (!isBadRequest(error) || !isEntityParseError(error)) throw error
      const rest = chunks.slice(index).map(stripHtml)
      ids.push(...(await sendPlainChunks(api, chatId, rest, options, isLastPart, state)))
      return { mode: 'plain', ids, error: describeError(error) }
    }
  }

  return { mode: 'html', ids }
}

async function sendPlainPart(
  api: TelegramApi,
  chatId: number,
  markdown: string,
  options: SendFormattedOptions,
  isLastPart: boolean,
  state: DeliveryState,
): Promise<number[]> {
  return sendPlainChunks(api, chatId, fallbackChunks(markdown, markdownToPlain), options, isLastPart, state)
}

/**
 * Отправляет Markdown как rich-сообщение с полем `markdown`; при 400 эта и все
 * следующие части деградируют в HTML, при ошибке разбора сущностей HTML —
 * в простой текст без parse_mode. Уже доставленные части не отправляются
 * повторно. reply_markup прикрепляется к последней отправленной части.
 *
 * Итог доставки (формат, число реально ушедших сообщений и ошибка Telegram)
 * отдаётся через `onDelivery`: по нему следующий ход узнаёт, что ответ ушёл не
 * так, как его написали.
 */
export async function sendFormatted(
  api: TelegramApi,
  chatId: number,
  markdownText: string,
  options: SendFormattedOptions = {},
): Promise<number[]> {
  // Теги кнопок разбирает вызывающий (стрим, через реестр); всё, что дошло
  // сюда, вырезается, чтобы data из текста не ушёл в Telegram никаким путём.
  let md = stripButtons(markdownText)
  if (md.trim() === '') {
    if (options.replyMarkup === undefined) return []
    md = BUTTONS_ONLY_TEXT
  }

  const markdown = normalizeMarkdownHardBreaks(md)
  const parts = splitMarkdown(markdown, {
    maxChars: options.maxChars ?? RICH_CHAR_LIMIT,
    maxBlocks: options.maxBlocks ?? RICH_BLOCK_LIMIT,
  })
  const ids: number[] = []
  const state: DeliveryState = { markupRejected: false }
  let mode: DeliveryMode = 'rich'
  let richError: string | undefined
  let htmlError: string | undefined
  let sent = 0

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string
    const isLast = index === parts.length - 1

    if (mode === 'rich') {
      try {
        const id = await sendRichPart(api, chatId, part, options, isLast, state)
        if (id !== undefined) ids.push(id)
        sent += 1
        continue
      } catch (error) {
        if (!isBadRequest(error)) throw error
        richError ??= describeError(error)
        mode = 'html'
      }
    }

    if (mode === 'html') {
      const result = await sendHtmlPart(api, chatId, part, options, isLast, state)
      ids.push(...result.ids)
      sent += result.ids.length
      htmlError ??= result.error
      mode = result.mode
      continue
    }

    const plainIds = await sendPlainPart(api, chatId, part, options, isLast, state)
    ids.push(...plainIds)
    sent += plainIds.length
  }

  const error = richError ?? htmlError
  options.onDelivery?.({
    mode,
    parts: sent,
    ...(error === undefined ? {} : { error }),
    ...(state.keyboardError === undefined ? {} : { keyboardError: state.keyboardError }),
  })
  return ids
}
