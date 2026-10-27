import { expect, test } from 'vitest'
import type { TelegramApi } from './api.js'
import * as streamModule from './stream.js'

const CHAT = 3001

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

interface Stream {
  finish(markdown: string, media?: readonly unknown[]): unknown
}

const createReplyStream = streamModule.createReplyStream as unknown as (options: Params) => Stream

function fakeApi(): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (method === 'sendRichMessageDraft' || method === 'sendMessageDraft') return true as T
      if (method === 'sendRichMessage') return { message_id: 601 } as T
      if (method === 'sendMessage') return { message_id: 602 } as T
      return true as T
    },
  }
  return { api, calls }
}

const PHOTO = { id: 'photo1', name: 'chart.png', data: new Uint8Array([1, 2, 3]), contentType: 'image/png' }

test('картинка из finish уходит в rich_message.media того же сообщения', async () => {
  const { api, calls } = fakeApi()
  const stream = createReplyStream({ api, chatId: CHAT })
  await Promise.resolve(stream.finish('Отчёт\n\n![](tg://photo?id=photo1)', [PHOTO]))
  const sends = calls.filter((call) => call.method === 'sendRichMessage')
  expect(sends).toHaveLength(1)
  const rich = sends[0]?.params.rich_message as { markdown?: string; media?: { id: string }[] }
  expect(rich.markdown).toContain('tg://photo?id=photo1')
  expect(rich.media?.map((item) => item.id)).toEqual(['photo1'])
})

test('без картинок финал идёт как раньше: одно rich-сообщение без media', async () => {
  const { api, calls } = fakeApi()
  const stream = createReplyStream({ api, chatId: CHAT })
  await Promise.resolve(stream.finish('Просто текст'))
  const sends = calls.filter((call) => call.method === 'sendRichMessage')
  expect(sends).toHaveLength(1)
  const rich = sends[0]?.params.rich_message as { media?: unknown }
  expect(rich.media).toBeUndefined()
})
