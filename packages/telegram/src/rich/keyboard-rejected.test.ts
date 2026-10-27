import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramApiError, type TelegramApi } from '../api.js'
import { createReplyStream } from '../stream.js'
import {
  createDeliveryNotes,
  extractButtons,
  sendFormatted,
  type ButtonRegistryLike,
  type DeliveryReport,
} from './index.js'

// Telegram отвергает саму клавиатуру ответа (400 про кнопку): текст всё равно
// должен дойти одним сообщением без клавиатуры, а модель на следующем ходу
// узнать, что кнопки не ушли. Кнопка copy_text длиннее 256 символов вырезается
// ещё при разборе.

const CHAT = 1001
const SENT_METHODS = ['sendRichMessage', 'sendMessage']

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
  rejected: boolean
}

/** Фейковый Telegram: любая отправка с reply_markup получает 400 с этим описанием. */
function fakeApi(description: string | undefined) {
  const calls: Call[] = []
  let nextId = 100
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      const rejected = description !== undefined && params.reply_markup !== undefined
      calls.push({ method, params, rejected })
      if (rejected) throw new TelegramApiError(method, 400, description as string)
      if (SENT_METHODS.includes(method)) {
        nextId += 1
        return { message_id: nextId } as T
      }
      return true as T
    },
  }
  return { api, calls }
}

function delivered(calls: Call[]): Call[] {
  return calls.filter((call) => SENT_METHODS.includes(call.method) && !call.rejected)
}

function fakeRegistry(): ButtonRegistryLike {
  let count = 0
  return {
    create(): string {
      count += 1
      return `rb1:${count}`
    },
  }
}

const REJECTIONS = ['Bad Request: BUTTON_COPY_TEXT_INVALID', 'Bad Request: BUTTON_URL_INVALID']

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

for (const description of REJECTIONS) {
  test(`test_h2_stream_final_survives_a_rejected_keyboard (${description})`, async () => {
    const { api, calls } = fakeApi(description)
    const reports: DeliveryReport[] = []
    const stream = createReplyStream({
      api,
      chatId: CHAT,
      buttons: fakeRegistry(),
      onDelivery: (report) => reports.push(report),
    })

    await stream.finish(
      'Ответ про кнопки ГОТОВ\n\n<tg-button type="copy_text" text="12345">Скопировать</tg-button>' +
        '<tg-button type="callback_data">Да</tg-button>',
    )

    expect(
      calls.some((call) => call.rejected),
      'the fake must have rejected the send with the keyboard',
    ).toBe(true)
    const sent = delivered(calls)
    expect(sent, 'the answer reaches the owner as one message').toHaveLength(1)
    expect(JSON.stringify(sent[0]?.params)).toContain('Ответ про кнопки ГОТОВ')
    expect(sent[0]?.params.reply_markup, 'the delivered message has no keyboard').toBeUndefined()
    expect(JSON.stringify(sent[0]?.params)).not.toContain('tg-button')

    expect(reports, 'the delivery is reported once').toHaveLength(1)
    const notes = createDeliveryNotes()
    notes.remember(reports[0] as DeliveryReport)
    const note = notes.take()
    expect(note, 'the next turn is told that the buttons did not go out').toMatch(/кнопк/i)
    expect(note, 'the note carries a fragment of the Telegram error').toContain(
      description.replace('Bad Request: ', ''),
    )
    expect(notes.take(), 'the note comes once').toBe('')
  })
}

test('test_h2_rejected_keyboard_does_not_repeat_delivered_parts', async () => {
  const { api, calls } = fakeApi('Bad Request: BUTTON_COPY_TEXT_INVALID')
  const reports: DeliveryReport[] = []
  const paragraph = (marker: string): string => `${marker} ${'слово '.repeat(30)}`
  const text = ['ЧАСТЬ-ПЕРВАЯ', 'ЧАСТЬ-ВТОРАЯ', 'ЧАСТЬ-ТРЕТЬЯ'].map(paragraph).join('\n\n')

  await sendFormatted(api, CHAT, text, {
    maxChars: 250,
    replyMarkup: { inline_keyboard: [[{ text: 'Копия', copy_text: { text: 'x' } }]] },
    onDelivery: (report) => reports.push(report),
  })

  const sent = delivered(calls)
  expect(sent.length, 'the answer is cut into several messages').toBeGreaterThanOrEqual(2)
  for (const marker of ['ЧАСТЬ-ПЕРВАЯ', 'ЧАСТЬ-ВТОРАЯ', 'ЧАСТЬ-ТРЕТЬЯ']) {
    const carrying = sent.filter((call) => JSON.stringify(call.params).includes(marker))
    expect(carrying, `${marker} is delivered exactly once`).toHaveLength(1)
  }
  for (const call of sent) expect(call.params.reply_markup).toBeUndefined()

  expect(reports).toHaveLength(1)
  expect(reports[0]?.parts, 'the report counts the messages that really went out').toBe(sent.length)
  const notes = createDeliveryNotes()
  notes.remember(reports[0] as DeliveryReport)
  const note = notes.take()
  expect(note).toMatch(/кнопк/i)
  expect(note).toContain('BUTTON_COPY_TEXT_INVALID')
})

test('test_h2_copy_text_longer_than_256_is_cut_while_256_passes', async () => {
  const long = 'a'.repeat(257)
  const edge = 'b'.repeat(256)

  const cutOut = extractButtons(`До <tg-button type="copy_text" text="${long}">Копия</tg-button> после`)
  expect(cutOut.keyboard, 'a 257-character copy_text never becomes a button').toBeUndefined()
  expect(cutOut.text).toContain('До')
  expect(cutOut.text).toContain('после')
  expect(cutOut.text).not.toContain('Копия')

  const kept = extractButtons(`<tg-button type="copy_text" text="${edge}">Копия</tg-button>`)
  expect(kept.keyboard?.inline_keyboard).toEqual([[{ text: 'Копия', copy_text: { text: edge } }]])

  const mixed = extractButtons(
    `<tg-button type="copy_text" text="${long}">Длинная</tg-button>` +
      '<tg-button type="url" url="https://example.com">Сайт</tg-button>',
  )
  expect(mixed.keyboard?.inline_keyboard).toEqual([[{ text: 'Сайт', url: 'https://example.com' }]])

  const { api, calls } = fakeApi(undefined)
  const stream = createReplyStream({ api, chatId: CHAT, buttons: fakeRegistry() })
  await stream.finish(`Ответ <tg-button type="copy_text" text="${long}">Копия</tg-button>`)
  const sent = delivered(calls)
  expect(sent).toHaveLength(1)
  expect(sent[0]?.params.reply_markup, 'the 257-character copy_text is not in reply_markup').toBeUndefined()
  expect(JSON.stringify(sent[0]?.params)).toContain('Ответ')
})
