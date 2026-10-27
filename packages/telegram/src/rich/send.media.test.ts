import { expect, test } from 'vitest'
import type { FileUpload, TelegramApi } from '../api.js'
import { sendFormatted } from './index.js'

// Картинка в теле rich-сообщения: Bot API рисует её только из вложенного
// файла. Разметка ссылается на файл как tg://photo?id=<id>, а сам файл уходит
// в rich_message.media и multipart — внешний URL Telegram принимает молча и
// не рисует, поэтому проверяются оба поля запроса.

const CHAT = 777

type Params = Record<string, unknown>

interface Call {
  method: string
  params: Params
  files?: Record<string, FileUpload>
}

function fakeApi(): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(
      method: string,
      params: Params = {},
      files?: Record<string, FileUpload>,
    ): Promise<T> {
      calls.push({ method, params, files })
      return { message_id: 4242 } as T
    },
  }
  return { api, calls }
}

function richOf(call: Call): { markdown?: unknown; media?: unknown } {
  return (call.params.rich_message ?? {}) as { markdown?: unknown; media?: unknown }
}

test('картинка уходит в media с attach:// и ссылкой tg://photo в разметке', async () => {
  const { api, calls } = fakeApi()
  const data = new Uint8Array([1, 2, 3, 4])

  await sendFormatted(api, CHAT, 'Отчёт\n\n![](tg://photo?id=chart)', {
    media: [{ id: 'chart', name: 'chart.png', data, contentType: 'image/png' }],
  })

  expect(calls).toHaveLength(1)
  const call = calls[0] as Call
  expect(call.method).toBe('sendRichMessage')
  const rich = richOf(call)
  expect(rich.markdown).toContain('tg://photo?id=chart')
  expect(rich.media).toEqual([{ id: 'chart', media: { type: 'photo', media: 'attach://chart' } }])
  expect(call.files?.chart).toEqual({ name: 'chart.png', data, contentType: 'image/png' })
})

test('без media запрос остаётся прежним: ни поля media, ни файлов', async () => {
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, 'Просто текст')

  const call = calls[0] as Call
  expect(call.method).toBe('sendRichMessage')
  expect(richOf(call).media).toBeUndefined()
  expect(call.files).toBeUndefined()
})

test('несколько картинок идут одним сообщением и одним набором файлов', async () => {
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, '![](tg://photo?id=a)\n\n![](tg://photo?id=b)', {
    media: [
      { id: 'a', name: 'a.png', data: new Uint8Array([1]), contentType: 'image/png' },
      { id: 'b', name: 'b.jpg', data: new Uint8Array([2]), contentType: 'image/jpeg' },
    ],
  })

  expect(calls).toHaveLength(1)
  const call = calls[0] as Call
  const rich = richOf(call)
  expect(rich.media).toEqual([
    { id: 'a', media: { type: 'photo', media: 'attach://a' } },
    { id: 'b', media: { type: 'photo', media: 'attach://b' } },
  ])
  expect(Object.keys(call.files ?? {})).toEqual(['a', 'b'])
})
