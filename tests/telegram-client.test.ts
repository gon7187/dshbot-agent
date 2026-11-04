import { afterEach, expect, test, vi } from 'vitest'
import {
  TelegramApiError,
  createPoller,
  createTelegramApi,
  decideAccess,
  normalizeUpdate,
  type TelegramApi,
} from '../packages/telegram/src/index.js'

const TOKEN = '123456:AAE-secret-token'

type Update = Parameters<typeof normalizeUpdate>[0]
type ChatType = 'private' | 'group' | 'supergroup' | 'channel'

interface FetchCall {
  url: string
  init: RequestInit | undefined
  at: number
}

interface ApiCall {
  method: string
  params: Record<string, unknown> | undefined
  at: number
}

afterEach(() => {
  vi.useRealTimers()
})

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
}

// Fake fetch: отдаёт заранее заготовленные ответы по очереди и записывает каждый запрос
function fakeFetch(replies: Response[]): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init, at: Date.now() })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected fetch call')
    return reply
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

// Фиксирует исход промиса без блокировки: 'pending', 'resolved' или сама ошибка
function track(promise: Promise<unknown>): { outcome: unknown } {
  const box: { outcome: unknown } = { outcome: 'pending' }
  promise.then(
    () => {
      box.outcome = 'resolved'
    },
    (error: unknown) => {
      box.outcome = error
    },
  )
  return box
}

// Фейковый TelegramApi для поллера: очередь ответов; пустая очередь имитирует долгий опрос без апдейтов
function fakePollApi(replies: unknown[]): { api: TelegramApi; calls: ApiCall[] } {
  const calls: ApiCall[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params, at: Date.now() })
      if (replies.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return [] as unknown as T
      }
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply as T
    },
  }
  return { api, calls }
}


// Продвигает фейковое время по 100 мс, пока условие не выполнится (ограничено 60 с фейкового времени)
async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 600 && !condition(); step++) {
    await vi.advanceTimersByTimeAsync(100)
  }
}

function rawUpdate(updateId: number): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 42, type: 'private' },
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      text: 'hi',
    },
  }
}

function textUpdate(chatId: number, chatType: ChatType): Update {
  return {
    update_id: 1,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: chatId, type: chatType },
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      text: 'hi',
    },
  }
}

function messageIn(chatId: number, chatType: ChatType) {
  const normalized = normalizeUpdate(textUpdate(chatId, chatType))
  if (normalized?.kind !== 'message') throw new Error('normalizeUpdate did not return a message')
  return normalized
}

test('P1 JSON and multipart preserve bytes, errors hide token and shared 429 honors pause and budget', async () => {
  {
  const { fetch, calls } = fakeFetch([json({ ok: true, result: { id: 1 } })])
  const api = createTelegramApi({ token: TOKEN, fetch })

  await expect(api.call('getMe')).resolves.toEqual({ id: 1 })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  expect(calls[0]?.init?.method).toBe('POST')
  expect(new Headers(calls[0]?.init?.headers).get('content-type')).toMatch(/application\/json/)

  }
  {
  const { fetch } = fakeFetch([json({ ok: false, error_code: 400, description: 'Bad Request: x' }, 400)])
  const api = createTelegramApi({ token: TOKEN, fetch })

  const err = await rejectionOf(api.call('getMe'))
  expect(err).toBeInstanceOf(TelegramApiError)
  expect(err).toMatchObject({ errorCode: 400, description: 'Bad Request: x' })
  expect((err as Error).message).not.toContain(TOKEN)
  expect(JSON.stringify(err)).not.toContain(TOKEN)

  }
  {
  const { fetch, calls } = fakeFetch([json({ ok: true, result: true })])
  const api = createTelegramApi({ token: TOKEN, fetch })

  await api.call(
    'sendDocument',
    { chat_id: 1, reply_markup: { inline_keyboard: [[{ text: 'a' }]] } },
    { document: { name: 'a.txt', data: new Uint8Array([1, 2, 3]) } },
  )

  const init = calls[0]?.init
  expect(init?.body).toBeInstanceOf(FormData)
  const body = init?.body as FormData
  expect(body.get('chat_id')).toBe('1')
  expect(JSON.parse(String(body.get('reply_markup')))).toEqual({ inline_keyboard: [[{ text: 'a' }]] })
  const document = body.get('document')
  expect(document).toBeInstanceOf(File)
  expect((document as File).name).toBe('a.txt')
  expect(new Uint8Array(await (document as File).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  expect(new Headers(init?.headers).has('content-type')).toBe(false)

  }
  {
  useFakeClock()
  const { fetch, calls } = fakeFetch([
    json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } }, 429),
    json({ ok: true, result: true }),
    json({ ok: true, result: true }),
  ])
  const api = createTelegramApi({ token: TOKEN, fetch })

  const start = Date.now()
  const first = api.call('getMe')
  await vi.advanceTimersByTimeAsync(0)
  const second = api.call('getChat', { chat_id: 42 })

  await vi.advanceTimersByTimeAsync(1999)
  expect(calls).toHaveLength(1)

  await until(() => calls.length >= 3)
  expect(calls).toHaveLength(3)
  for (const call of calls.slice(1)) {
    expect(call.at - start).toBeGreaterThanOrEqual(2000)
  }
  await expect(first).resolves.toBe(true)
  await expect(second).resolves.toBe(true)

  }
  {
  useFakeClock()
  const { fetch, calls } = fakeFetch([
    json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } }, 429),
  ])
  const api = createTelegramApi({ token: TOKEN, fetch, floodBudgetMs: 1000 })

  const err = await rejectionOf(api.call('getMe'))
  expect(err).toBeInstanceOf(TelegramApiError)
  expect(err).toMatchObject({ errorCode: 429, retryAfterMs: 2000 })
  expect(calls).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)

  }
})
test('P2 ordered handler completion commits offsets; failure retries; unauthorized and stop end polling', async () => {
  {
  useFakeClock()
  const { api, calls } = fakePollApi([[rawUpdate(10), rawUpdate(11)], [rawUpdate(11)]])
  const seen: number[] = []
  let failed = false
  const poller = createPoller({
    api,
    handle: async (update: { update_id: number }) => {
      seen.push(update.update_id)
      if (update.update_id === 11 && !failed) {
        failed = true
        throw new Error('ingress unavailable')
      }
    },
  })

  const run = track(poller.start())
  await until(() => calls.length >= 3)
  poller.stop()
  await vi.advanceTimersByTimeAsync(5000)

  expect(seen).toEqual([10, 11, 11])
  expect(calls[1]?.params?.offset).toBe(11)
  expect(calls[2]?.params?.offset).toBe(12)
  expect(run.outcome).not.toBe('pending')

  }
  {
  useFakeClock()
  const { api, calls } = fakePollApi([new TelegramApiError('getUpdates', 401, 'Unauthorized')])
  const poller = createPoller({ api, handle: async () => {} })

  const run = track(poller.start())
  await vi.advanceTimersByTimeAsync(60_000)

  expect(run.outcome).toBeInstanceOf(TelegramApiError)
  expect(run.outcome).toMatchObject({ errorCode: 401 })
  expect(calls).toHaveLength(1)

  }
  {
  useFakeClock()
  const { api, calls } = fakePollApi([])
  const poller = createPoller({ api, handle: async () => {} })

  const run = track(poller.start())
  await until(() => calls.length >= 2)
  poller.stop()
  const atStop = calls.length
  await vi.advanceTimersByTimeAsync(60_000)

  expect(calls).toHaveLength(atStop)
  expect(run.outcome).not.toBe('pending')

  }
})
test('P4 pairing, owner and guest authority preserve sender identity and normalized thread IDs', async () => {
  {
  const text: Update = {
    update_id: 5,
    message: {
      message_id: 7,
      date: 1,
      chat: { id: 42, type: 'private' },
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      text: 'привет',
    },
  }
  expect(normalizeUpdate(text)).toMatchObject({
    kind: 'message',
    updateId: 5,
    chatId: 42,
    chatType: 'private',
    fromId: 99,
    messageId: 7,
    text: 'привет',
  })

  const caption: Update = {
    update_id: 6,
    message: {
      message_id: 8,
      date: 1,
      chat: { id: 42, type: 'supergroup' },
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      caption: 'подпись',
      photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }],
    },
  }
  expect(normalizeUpdate(caption)).toMatchObject({ kind: 'message', updateId: 6, messageId: 8, text: 'подпись' })

  const topic: Update = {
    update_id: 9,
    message: {
      message_id: 10,
      date: 1,
      message_thread_id: 3,
      is_topic_message: true,
      chat: { id: 42, type: 'supergroup' },
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      text: 'в топике',
    },
  }
  expect(normalizeUpdate(topic)).toMatchObject({ kind: 'message', threadId: 3, text: 'в топике' })

  }
  {
  const update: Update = {
    update_id: 20,
    callback_query: {
      id: 'cb1',
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      chat_instance: 'ci',
      data: 'pick:1',
      message: { message_id: 7, date: 1, chat: { id: 42, type: 'private' } },
    },
  }
  expect(normalizeUpdate(update)).toMatchObject({
    kind: 'callback',
    updateId: 20,
    chatId: 42,
    fromId: 99,
    messageId: 7,
    callbackId: 'cb1',
    data: 'pick:1',
  })

  }
  {
  const update: Update = {
    update_id: 30,
    stopped_message_generation: {
      chat: { id: 42, type: 'private' },
      draft_id: 555,
      message_thread_id: 3,
    },
  }
  expect(normalizeUpdate(update)).toMatchObject({
    kind: 'stopped',
    updateId: 30,
    chatId: 42,
    draftId: 555,
    threadId: 3,
  })

  }
  {
  expect(decideAccess(null, messageIn(7, 'private'))).toBe('pair')
  expect(decideAccess(null, messageIn(-100, 'group'))).toBe('stranger')
  expect(decideAccess(42, messageIn(42, 'private'))).toBe('owner')
  expect(decideAccess(42, messageIn(7, 'private'))).toBe('stranger')
  expect(messageIn(42, 'private').fromId).toBe(99)

  }
})
test('P3 planned flood/backoff and progressing batches survive; stalled handler trips watchdog', async () => {
  useFakeClock()
  const { TelegramPollerStallError } = await import('../packages/telegram/src/poller.js')
  for (const planned of [429, 409, 502]) {
    const calls: number[] = []
    let poller: ReturnType<typeof createPoller>
    const api = createTelegramApi({ token: TOKEN, fetch: async () => {
      calls.push(Date.now())
      return calls.length === 1 ? json({ ok: false, error_code: planned, description: 'planned pause', parameters: { retry_after: 3 } }, planned) : json({ ok: true, result: [rawUpdate(7)] })
    } })
    const seen: number[] = []
    poller = createPoller({ api, stallMs: 1000, handle(update) { seen.push(update.update_id); poller.stop() } })
    const completion = poller.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await completion
    expect(seen).toEqual([7])
    expect(calls).toHaveLength(2)
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(planned === 429 ? 3000 : 1000)
  }
  const batch = [1, 2, 3, 4, 5].map(rawUpdate)
  const delivered: number[] = []
  const api = createTelegramApi({ token: TOKEN, fetch: async () => json({ ok: true, result: batch }) })
  const progressing = createPoller({ api, stallMs: 1000, handle: async update => {
    await new Promise(resolve => setTimeout(resolve, 600))
    delivered.push(update.update_id)
    if (delivered.length === batch.length) progressing.stop()
  } })
  const complete = progressing.start()
  await vi.advanceTimersByTimeAsync(5000)
  await complete
  expect(delivered).toEqual([1, 2, 3, 4, 5])
  let entered = 0
  const stalled = createPoller({ api, stallMs: 1000, handle: () => { entered++; return new Promise<void>(() => {}) } })
  const failure = rejectionOf(stalled.start())
  await vi.advanceTimersByTimeAsync(2300)
  expect(await failure).toBeInstanceOf(TelegramPollerStallError)
  expect(entered).toBe(1)
  stalled.stop()
})
