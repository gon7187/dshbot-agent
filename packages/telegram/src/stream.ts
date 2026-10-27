// Стрим ответа модели в Telegram: пользователь видит, как ответ печатается,
// и может остановить генерацию кнопкой (Bot API 10.3).
//
// Режимы идут лестницей: rich-draft (sendRichMessageDraft) → text-draft
// (sendMessageDraft) → edit (sendMessage + editMessageText с кнопкой «Стоп»).
// Обновления троттлятся до одного раза в секунду, а черновик (живёт ~30 с)
// принудительно переотправляется не реже раза в 20 с.
//
// Всё общение с Telegram идёт через контракт TelegramApi, поэтому поведение
// проверяется на фейке, записывающем вызовы.

import { TelegramApiError, type TelegramApi } from './api.js'
import {
  extractButtons,
  markdownToPlain,
  normalizeMarkdownHardBreaks,
  RICH_CHAR_LIMIT,
  sendFormatted,
  stripPreviewButtons,
  type ButtonRegistryLike,
  type DeliveryReport,
  type RichMediaInput,
} from './rich/index.js'

export type ReplyStreamMode = 'rich-draft' | 'text-draft' | 'edit'

export interface ReplyStreamOptions {
  api: TelegramApi
  chatId: number
  threadId?: number
  mode?: ReplyStreamMode
  /** Колбэк остановки хода: пользователь нажал «Стоп» у нашего черновика. */
  onStop?: () => void
  /**
   * Реестр reply-кнопок бота: `<tg-button type="callback_data">` из текста
   * получает callback_data реестра, а не data модели.
   */
  buttons?: ButtonRegistryLike
  /** Итог доставки финального ответа: формат, число частей и ошибка фолбэка. */
  onDelivery?: (report: DeliveryReport) => void
}

export interface ReplyStream {
  update(markdown: string): Promise<void>
  status(text: string): Promise<void>
  /**
   * Финальный ответ. `media` — картинки, на которые ссылается разметка как
   * `![](tg://photo?id=<id>)`: они уходят в `rich_message.media` того же
   * сообщения, поэтому график оказывается внутри тела, а не отдельным файлом.
   */
  finish(markdown: string, media?: readonly RichMediaInput[]): Promise<void>
  abort(): void
  /**
   * Removes the edit-mode preview after a cancelled or failed turn: a stale
   * preview with a Stop button must not outlive the turn it belonged to.
   */
  cleanup(): Promise<void>
  onStopped(draftId: number): void
  /** callback_data of the Stop button of this stream. */
  readonly stopData: string
  /** Handles a click on this stream's Stop button; true when `data` is ours. */
  onStopData(data: string): boolean
  onStop?: () => void
}

const THROTTLE_MS = 1000
const REFRESH_MS = 20_000
const MAX_PREVIEW_FAILURES = 3
const TEXT_LIMIT = 4096
const STOP_BUTTON_TEXT = 'Стоп'
const STOPPED_NOTE = '⏹ Остановлено пользователем.'

type Timer = ReturnType<typeof setTimeout>

/**
 * Внутренний сигнал: abort() пришёл, пока финал уже отправлялся.
 * Обёртка над TelegramApi бросает его вместо следующего вызова, чтобы после
 * abort() не ушёл ни один (в том числе следующий по частям) запрос.
 */
class StreamAbortedError extends Error {
  constructor() {
    super('reply stream aborted')
    this.name = 'StreamAbortedError'
  }
}

function isRateLimit(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.errorCode === 429
}

function isBadRequest(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.errorCode === 400
}

function isNotModified(error: unknown): boolean {
  return isBadRequest(error) && error.description.toLowerCase().includes('message is not modified')
}

/** draft_id должен быть ненулевым целым; один id на весь ход. */
function makeDraftId(): number {
  const id = Math.floor(Math.random() * 0x7fffffff)
  return id === 0 ? 1 : id
}

export function createReplyStream(options: ReplyStreamOptions): ReplyStream {
  const { api, chatId, threadId, onStop, buttons, onDelivery } = options

  let mode: ReplyStreamMode = options.mode ?? 'rich-draft'
  const draftId = makeDraftId()
  const stopCallbackData = `stop:${draftId.toString(36)}`

  let markdown = ''
  let statusText: string | undefined
  let pending = false
  let lastSentAt: number | undefined
  let previewFailures = 0
  let previewDisabled = false
  let sending = false
  let finishing = false
  let finished = false
  let aborted = false
  let stopped = false
  let stopHandled = false
  let pauseUntil = 0
  let updateTimer: Timer | undefined
  let refreshTimer: Timer | undefined
  let messageId: number | undefined

  /** Финал идёт через sendFormatted: после abort() ни одна следующая часть не уходит. */
  const guardedApi: TelegramApi = {
    call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (aborted) return Promise.reject(new StreamAbortedError())
      return api.call<T>(method, params)
    },
  }

  function clearUpdateTimer(): void {
    if (updateTimer !== undefined) {
      clearTimeout(updateTimer)
      updateTimer = undefined
    }
  }

  function clearRefreshTimer(): void {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
  }

  function clearTimers(): void {
    clearUpdateTimer()
    clearRefreshTimer()
  }

  function baseParams(): Record<string, unknown> {
    const params: Record<string, unknown> = { chat_id: chatId }
    if (threadId !== undefined) params.message_thread_id = threadId
    return params
  }

  function stopMarkup(): Record<string, unknown> {
    return {
      inline_keyboard: [[{ text: STOP_BUTTON_TEXT, callback_data: stopCallbackData }]],
    }
  }

  /**
   * В режиме edit превью — обычное сообщение с кнопкой «Стоп». После финала
   * кнопку нужно убрать, иначе она остаётся висеть на уже готовом ответе.
   * Ошибку уборки глотаем: финальный текст важнее клавиатуры.
   */
  async function clearStopButton(): Promise<void> {
    if (aborted || messageId === undefined) return
    try {
      const params = baseParams()
      params.message_id = messageId
      params.reply_markup = { inline_keyboard: [] }
      await api.call('editMessageReplyMarkup', params)
    } catch {
      // Кнопку убрать не удалось (сообщение уже изменилось/недоступно) — не повод терять финал.
    }
  }

  /**
   * После финала или отмены превью в режиме edit больше не нужно: финальный
   * ответ уходит отдельным сообщением через sendFormatted, а превью с кнопкой
   * «Стоп» и статусом инструмента не должно оставаться в чате. Сначала снимаем
   * клавиатуру, затем удаляем сообщение; ошибки обоих шагов не важны.
   */
  async function removePreview(): Promise<void> {
    if (messageId === undefined) return
    const key = messageId
    try {
      const params = baseParams()
      params.message_id = key
      params.reply_markup = { inline_keyboard: [] }
      await api.call('editMessageReplyMarkup', params)
    } catch {
      // клавиатуры уже нет
    }
    try {
      const params = baseParams()
      params.message_id = key
      await api.call('deleteMessage', params)
    } catch {
      // сообщение уже удалено
    }
  }

  /**
   * Черновик уходит нативным Rich Markdown: то же поле markdown и те же жёсткие
   * переносы, что и у финального ответа. Статус инструмента живёт тегом
   * <tg-thinking>, который Telegram показывает только в черновике.
   */
  function draftMarkdown(): string {
    // Кнопки в черновик не идут: data модели не должна уйти даже в разметке,
    // в том числе у кнопки, которую модель ещё не дописала.
    const body = normalizeMarkdownHardBreaks(stripPreviewButtons(markdown))
    const thinking = statusText !== undefined && statusText !== '' ? `<tg-thinking>${statusText}</tg-thinking>` : ''
    const text = thinking === '' ? body : body === '' ? thinking : `${thinking}\n\n${body}`
    // Превью не обязано быть полным, но и не замирает на 4096: лимит — rich-сообщения.
    return text.length > RICH_CHAR_LIMIT ? text.slice(0, RICH_CHAR_LIMIT) : text
  }

  function previewText(): string {
    const body = markdownToPlain(stripPreviewButtons(markdown))
    const text = statusText ? `⏳ ${statusText}${body ? `\n\n${body}` : ''}` : body
    return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text
  }

  function scheduleUpdateAt(at: number): void {
    if (aborted || finished || finishing || previewDisabled) return
    clearUpdateTimer()
    const delay = Math.max(0, at - Date.now())
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void flush()
    }, delay)
  }

  function scheduleRefresh(): void {
    clearRefreshTimer()
    // У режима edit нет эфемерного черновика, переотправлять нечего.
    if (aborted || finished || finishing || previewDisabled || mode === 'edit') return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      if (aborted || finished || finishing || previewDisabled) return
      if (sending) {
        scheduleRefresh()
        return
      }
      if (Date.now() < pauseUntil) {
        scheduleUpdateAt(pauseUntil)
        return
      }
      void flush(true)
    }, REFRESH_MS)
  }

  function registerFailure(): void {
    previewFailures += 1
    if (previewFailures >= MAX_PREVIEW_FAILURES) {
      previewDisabled = true
      clearRefreshTimer()
    }
  }

  /** 429: пауза на весь стрим; обновления в паузе не копятся, уходит последнее. */
  function pauseOnRateLimit(error: unknown): boolean {
    if (!isRateLimit(error)) return false
    // После abort() пауза уже не нужна: ни таймеров, ни повторной отправки.
    if (aborted || finished || finishing) return true
    const wait =
      typeof error.retryAfterMs === 'number' && error.retryAfterMs > 0 ? error.retryAfterMs : 1000
    pauseUntil = Math.max(pauseUntil, Date.now() + wait)
    pending = true
    scheduleUpdateAt(pauseUntil)
    return true
  }

  async function sendRichDraft(at: number): Promise<boolean> {
    const markdownText = draftMarkdown()
    if (markdownText === '') return false

    lastSentAt = at
    try {
      const params = baseParams()
      params.draft_id = draftId
      params.rich_message = { markdown: markdownText }
      params.can_stop = true
      params.keep_on_stop = true
      await api.call('sendRichMessageDraft', params)
      // abort() мог прийти, пока запрос был в полёте: больше ничего не шлём.
      if (aborted) return false
      previewFailures = 0
      scheduleRefresh()
      return false
    } catch (error) {
      if (aborted) return false
      if (pauseOnRateLimit(error)) return false
      if (isBadRequest(error)) {
        // Метод/rich не поддержан сервером — спускаемся на текстовый черновик.
        previewFailures = 0
        return true
      }
      registerFailure()
      return false
    }
  }

  async function sendTextDraft(at: number): Promise<boolean> {
    const text = previewText()
    if (text === '') return false

    lastSentAt = at
    try {
      const params = baseParams()
      params.draft_id = draftId
      params.text = text
      params.can_stop = true
      params.keep_on_stop = true
      await api.call('sendMessageDraft', params)
      if (aborted) return false
      previewFailures = 0
      scheduleRefresh()
      return false
    } catch (error) {
      if (aborted) return false
      if (pauseOnRateLimit(error)) return false
      if (isBadRequest(error)) {
        previewFailures = 0
        return true
      }
      registerFailure()
      return false
    }
  }

  async function sendEditPreview(at: number): Promise<void> {
    const text = previewText()

    if (messageId === undefined) {
      if (text === '') return
      lastSentAt = at
      try {
        const params = baseParams()
        params.text = text
        params.reply_markup = stopMarkup()
        const response = await api.call<{ message_id?: number }>('sendMessage', params)
        if (aborted) return
        if (response && typeof response.message_id === 'number') messageId = response.message_id
        previewFailures = 0
      } catch (error) {
        if (aborted) return
        if (pauseOnRateLimit(error)) return
        registerFailure()
      }
      return
    }

    lastSentAt = at
    try {
      const params = baseParams()
      params.message_id = messageId
      params.text = text
      params.reply_markup = stopMarkup()
      await api.call('editMessageText', params)
      if (aborted) return
      previewFailures = 0
    } catch (error) {
      if (aborted) return
      // Telegram отвечает 400, когда содержимое не изменилось; это не сбой.
      if (isNotModified(error)) {
        previewFailures = 0
        return
      }
      if (pauseOnRateLimit(error)) return
      registerFailure()
    }
  }

  async function sendPreview(at: number): Promise<void> {
    if (mode === 'rich-draft') {
      const fallback = await sendRichDraft(at)
      // После abort()/finish() лестница не продолжается ни одним вызовом API.
      if (aborted || finishing || finished || !fallback) return
      mode = 'text-draft'
    }

    if (mode === 'text-draft') {
      const fallback = await sendTextDraft(at)
      if (aborted || finishing || finished || !fallback) return
      mode = 'edit'
    }

    if (aborted || finishing || finished) return
    if (mode === 'edit') await sendEditPreview(at)
  }

  async function flush(force = false): Promise<void> {
    if (aborted || finished || finishing || previewDisabled) return
    if (sending) {
      pending = true
      return
    }
    if (!force && !pending) return
    if (Date.now() < pauseUntil) {
      scheduleUpdateAt(pauseUntil)
      return
    }

    sending = true
    pending = false
    const at = Date.now()
    try {
      await sendPreview(at)
    } finally {
      sending = false
    }

    if (aborted || finished || finishing || previewDisabled) return
    if (pending) {
      const target = Math.max(Date.now(), (lastSentAt ?? 0) + THROTTLE_MS, pauseUntil)
      if (target <= Date.now()) {
        void flush()
      } else {
        scheduleUpdateAt(target)
      }
    }
  }

  async function requestPreview(): Promise<void> {
    if (aborted || finished || finishing || previewDisabled) return
    pending = true
    const now = Date.now()
    let target = lastSentAt === undefined ? now : lastSentAt + THROTTLE_MS
    if (pauseUntil > target) target = pauseUntil
    if (target <= now) {
      await flush()
    } else {
      scheduleUpdateAt(target)
    }
  }

  async function waitForPause(): Promise<void> {
    while (!aborted && pauseUntil > Date.now()) {
      const remaining = pauseUntil - Date.now()
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remaining)
      })
    }
  }

  async function update(markdownText: string): Promise<void> {
    if (aborted || finished || finishing) return
    markdown = markdownText
    await requestPreview()
  }

  async function status(text: string): Promise<void> {
    if (aborted || finished || finishing) return
    statusText = text
    await requestPreview()
  }

  async function finish(markdownText: string, media?: readonly RichMediaInput[]): Promise<void> {
    if (aborted || finished || finishing) return
    finishing = true
    clearTimers()
    markdown = markdownText

    let delivered = false
    try {
      // Финал не должен потеряться из-за паузы 429: ждём её конца.
      await waitForPause()
      if (aborted) return

      // Кнопки из текста ответа: data модели вырезается, callback-кнопка идёт
      // через реестр бота. Клавиатура прикрепляется к последней части.
      // Пометка об остановке добавляется после разбора: недописанный тег
      // кнопки не должен её съесть.
      const extracted = extractButtons(markdown, buttons)
      if (stopped) extracted.text = `${extracted.text}\n\n${STOPPED_NOTE}`
      // Лестница финала: rich → HTML → простой текст (sendFormatted). Так ответ
      // не теряется в чате, где rich-сообщения не поддерживаются.
      try {
        await sendFormatted(
          guardedApi,
          chatId,
          extracted.text,
          {
            ...(threadId === undefined ? {} : { threadId }),
            ...(media === undefined || media.length === 0 ? {} : { media: [...media] }),
            ...(extracted.keyboard === undefined ? {} : { replyMarkup: extracted.keyboard }),
            ...(onDelivery === undefined
              ? {}
              : {
                  onDelivery: (report: DeliveryReport): void => {
                    try {
                      onDelivery(report)
                    } catch {
                      // Заметка о доставке не должна ломать уже доставленный ответ.
                    }
                  },
                }),
          },
        )
        delivered = true
      } catch (error) {
        // abort() во время отправки: оставшиеся части намеренно не уходят.
        if (!(error instanceof StreamAbortedError)) throw error
      }
    } finally {
      finishing = false
      finished = true
      // Превью с кнопкой «Стоп» заменяется финальным сообщением; при отмене
      // его удаляет cleanup(). Если же финал не доставлен, кнопку всё равно
      // снимаем, чтобы она не осталась висеть на устаревшем превью.
      if (delivered) await removePreview()
      else await clearStopButton()
    }
  }

  async function cleanup(): Promise<void> {
    clearTimers()
    await removePreview()
  }

  function abort(): void {
    if (aborted) return
    aborted = true
    pending = false
    clearTimers()
  }

  function onStopped(id: number): void {
    if (aborted || finished) return
    if (id !== draftId || stopHandled) return
    stopHandled = true
    stopped = true
    clearTimers()
    // Кнопка не должна переживать нажатие: снимаем клавиатуру сразу, не дожидаясь,
    // пока отмена хода дойдёт до конца (ход завершится без finish()).
    void clearStopButton()
    if (typeof onStop === 'function') onStop()
  }

  function onStopData(data: string): boolean {
    if (data !== stopCallbackData) return false
    onStopped(draftId)
    return true
  }

  return {
    update,
    status,
    finish,
    abort,
    cleanup,
    onStopped,
    stopData: stopCallbackData,
    onStopData,
    onStop,
  }
}
