// Заметка модели о том, как ушёл её прошлый итоговый ответ.
//
// Одна короткая фраза на ход: формат фолбэка (HTML или простой текст) с
// фрагментом ошибки Telegram или число частей разрезанного ответа. Когда
// случилось и то и другое, факты идут в одной заметке, а не в двух.

import type { DeliveryReport } from './send.js'

const ERROR_FRAGMENT_LIMIT = 200

/** «1 часть», «2 части», «5 частей»: заметку читает человек и модель. */
function partsWord(count: number): string {
  const tail = count % 100
  if (tail >= 11 && tail <= 14) return 'частей'
  const last = count % 10
  if (last === 1) return 'часть'
  if (last >= 2 && last <= 4) return 'части'
  return 'частей'
}

/**
 * Текст заметки или '' для чистого ответа одним rich-сообщением. Оба факта
 * (фолбэк и разрез) живут в одной строке: вызывающий хранит ровно одну заметку
 * и отдаёт её следующему ходу.
 */
export function deliveryNoteOf(report: DeliveryReport): string {
  const fallbackUsed = report.mode !== 'rich'
  const cut = report.parts > 1
  const fragmentOf = (description: string | undefined): string =>
    (description ?? '').replace(/\s+/g, ' ').trim().slice(0, ERROR_FRAGMENT_LIMIT)
  const keyboardFragment = fragmentOf(report.keyboardError)
  const keyboardRejected = keyboardFragment !== ''
  if (!fallbackUsed && !cut && !keyboardRejected) return ''

  let note = 'Доставка прошлого ответа:'
  if (fallbackUsed) {
    const fallback = report.mode === 'html' ? 'HTML' : 'простой текст'
    const fragment = fragmentOf(report.error)
    note +=
      ` Telegram отверг Rich Markdown` +
      `${fragment === '' ? '' : ` (ошибка: ${fragment})`}, ответ ушёл как ${fallback}.`
  }
  if (keyboardRejected) {
    note +=
      ` Telegram не принял кнопки ответа (ошибка: ${keyboardFragment}), поэтому они не ушли; ` +
      `текст доставлен без клавиатуры.`
  }
  if (cut) {
    note +=
      ` Ответ разрезан на ${report.parts} ${partsWord(report.parts)}, потому что не уложился ` +
      `в лимит одного сообщения (32768 символов и 500 блоков).`
  }
  return note
}

/**
 * Очередь заметок: не больше одной на следующий ход. Чистая доставка снова
 * взводит очередь, поэтому следующий сбой будет рассказан; серия плохих
 * ответов после уже рассказанной заметки молчит.
 */
export interface DeliveryNotes {
  /** Учесть итог доставки завершённого хода. */
  remember(report: DeliveryReport): void
  /** Забрать заметку для ближайшего хода; после этого хода она исчезает. */
  take(): string
  /** Новая сессия: заметка прошлой сессии к ней не относится. */
  reset(): void
}

export function createDeliveryNotes(): DeliveryNotes {
  let pending: string | undefined
  let armed = true
  return {
    remember(report) {
      const note = deliveryNoteOf(report)
      if (note === '') {
        pending = undefined
        armed = true
        return
      }
      if (!armed) {
        pending = undefined
        return
      }
      pending = note
      armed = false
    },
    take() {
      const note = pending ?? ''
      pending = undefined
      return note
    },
    reset() {
      pending = undefined
      armed = true
    },
  }
}
