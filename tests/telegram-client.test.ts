import { afterEach, expect, test, vi } from 'vitest'
import {
  TelegramApiError,
  createPoller,
  createTelegramApi,
  decideAccess,
  normalizeUpdate,
  startTyping,
  type TelegramApi,
} from '../packages/telegram/src/index.js'

const TOKEN = '123456:AAE-secret-token'
const DEFAULT_ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction', 'stopped_message_generation']

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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
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

// Фейковый TelegramApi для typing: записывает вызовы и отвечает успехом
function recordingApi(): { api: TelegramApi; calls: { method: string; params: Record<string, unknown> | undefined }[] } {
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      calls.push({ method, params })
      return true as unknown as T
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

test('test_c1_get_me_returns_result_via_post_json', async () => {
  const { fetch, calls } = fakeFetch([json({ ok: true, result: { id: 1 } })])
  const api = createTelegramApi({ token: TOKEN, fetch })

  await expect(api.call('getMe')).resolves.toEqual({ id: 1 })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`)
  expect(calls[0]?.init?.method).toBe('POST')
  expect(new Headers(calls[0]?.init?.headers).get('content-type')).toMatch(/application\/json/)
})

test('test_c2_api_error_carries_code_and_description_without_token', async () => {
  const { fetch } = fakeFetch([json({ ok: false, error_code: 400, description: 'Bad Request: x' }, 400)])
  const api = createTelegramApi({ token: TOKEN, fetch })

  const err = await rejectionOf(api.call('getMe'))
  expect(err).toBeInstanceOf(TelegramApiError)
  expect(err).toMatchObject({ errorCode: 400, description: 'Bad Request: x' })
  expect((err as Error).message).not.toContain(TOKEN)
  expect(JSON.stringify(err)).not.toContain(TOKEN)
})

test('test_c3_html_error_body_becomes_api_error_with_http_code', async () => {
  const html = new Response('<html><body>Bad Gateway</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  })
  const { fetch } = fakeFetch([html])
  const api = createTelegramApi({ token: TOKEN, fetch })

  const err = await rejectionOf(api.call('getMe'))
  expect(err).toBeInstanceOf(TelegramApiError)
  expect(err).toMatchObject({ errorCode: 502 })
})

test('test_c4_files_go_as_form_data_with_json_params_and_no_manual_content_type', async () => {
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
})

test('test_c5_flood_pause_holds_retry_and_other_calls_for_retry_after', async () => {
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
})

test('test_c6_flood_wait_over_budget_fails_without_waiting', async () => {
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
})

test('test_c7_poller_defaults_allowed_updates', async () => {
  useFakeClock()
  const { api, calls } = fakePollApi([])
  const poller = createPoller({ api, handle: async () => {} })

  const run = track(poller.start())
  await until(() => calls.length >= 1)
  poller.stop()
  await vi.advanceTimersByTimeAsync(5000)

  expect(calls[0]?.method).toBe('getUpdates')
  expect(calls[0]?.params?.allowed_updates).toEqual(DEFAULT_ALLOWED_UPDATES)
  expect(run.outcome).not.toBe('pending')
})

test('test_c8_updates_handled_in_order_and_offset_moves_after_success', async () => {
  useFakeClock()
  const { api, calls } = fakePollApi([[rawUpdate(10), rawUpdate(11)]])
  const seen: number[] = []
  const poller = createPoller({
    api,
    handle: async (update: { update_id: number }) => {
      seen.push(update.update_id)
    },
  })

  const run = track(poller.start())
  await until(() => calls.length >= 2)
  poller.stop()
  await vi.advanceTimersByTimeAsync(5000)

  expect(seen).toEqual([10, 11])
  expect(calls[1]?.params?.offset).toBe(12)
  expect(run.outcome).not.toBe('pending')
})

test('test_c8_failed_handle_repeats_same_update_without_moving_offset', async () => {
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
})

test('test_c9_server_error_retries_later_without_moving_offset', async () => {
  useFakeClock()
  const { api, calls } = fakePollApi([
    [rawUpdate(10)],
    new TelegramApiError('getUpdates', 502, 'Bad Gateway'),
    [rawUpdate(11)],
  ])
  const poller = createPoller({ api, handle: async () => {} })

  const run = track(poller.start())
  await until(() => calls.length >= 4)
  poller.stop()
  await vi.advanceTimersByTimeAsync(5000)

  expect(calls[1]?.params?.offset).toBe(11)
  expect(calls[2]?.params?.offset).toBe(11)
  expect(calls[2]?.at).toBeGreaterThan(calls[1]?.at ?? Infinity)
  expect(calls[3]?.params?.offset).toBe(12)
  expect(run.outcome).not.toBe('pending')
})

test('test_c9_unauthorized_stops_poller_with_error', async () => {
  useFakeClock()
  const { api, calls } = fakePollApi([new TelegramApiError('getUpdates', 401, 'Unauthorized')])
  const poller = createPoller({ api, handle: async () => {} })

  const run = track(poller.start())
  await vi.advanceTimersByTimeAsync(60_000)

  expect(run.outcome).toBeInstanceOf(TelegramApiError)
  expect(run.outcome).toMatchObject({ errorCode: 401 })
  expect(calls).toHaveLength(1)
})

// A second instance is a recoverable condition: the poller waits it out with a
// growing pause, names the series once in the journal and keeps the loop alive.
test('test_c9_conflict_is_retried_with_a_pause_and_logged_once_per_series', async () => {
  useFakeClock()
  const conflict = (): TelegramApiError =>
    new TelegramApiError('getUpdates', 409, 'Conflict: terminated by other getUpdates request')
  const { api, calls } = fakePollApi([conflict(), conflict(), [rawUpdate(20)]])
  const handled: unknown[] = []
  const journal: string[] = []
  const poller = createPoller({
    api,
    handle: async (update) => {
      handled.push(update.update_id)
    },
    log: (line) => journal.push(line),
  })

  const run = track(poller.start())
  await until(() => handled.length >= 1)

  expect(run.outcome).toBe('pending')
  expect(handled).toEqual([20])
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThan(0)
  expect(calls[2]!.at - calls[1]!.at).toBeGreaterThan(calls[1]!.at - calls[0]!.at)
  expect(journal.filter((line) => /409|conflict|another instance/i.test(line))).toHaveLength(1)
  poller.stop()
  await vi.advanceTimersByTimeAsync(5000)
  expect(run.outcome).toBe('resolved')
})

test('test_c9_stop_ends_loop_without_new_requests', async () => {
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
})

test('test_c10_text_and_caption_normalize_to_message', () => {
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
})

test('test_c10_callback_query_normalizes_to_callback', () => {
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
})

test('test_c11_stopped_generation_normalizes_to_stopped', () => {
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
})

test('test_c11_reaction_normalizes_to_emoji_list_and_other_updates_to_null', () => {
  const reaction: Update = {
    update_id: 31,
    message_reaction: {
      chat: { id: 42, type: 'private' },
      message_id: 7,
      date: 1,
      user: { id: 99, is_bot: false, first_name: 'Owner' },
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '🔥' }],
    },
  }
  expect(normalizeUpdate(reaction)).toMatchObject({
    kind: 'reaction',
    updateId: 31,
    chatId: 42,
    messageId: 7,
    emoji: ['🔥'],
  })

  const other: Update = {
    update_id: 33,
    inline_query: {
      id: 'q',
      from: { id: 99, is_bot: false, first_name: 'Owner' },
      query: 'x',
      offset: '',
    },
  }
  expect(normalizeUpdate(other)).toBeNull()
})

test('test_c12_pair_only_for_private_chat_without_owner', () => {
  expect(decideAccess(null, messageIn(7, 'private'))).toBe('pair')
})

test('test_c12_group_supergroup_and_channel_are_stranger_without_owner', () => {
  expect(decideAccess(null, messageIn(-100, 'group'))).toBe('stranger')
  expect(decideAccess(null, messageIn(-1001, 'supergroup'))).toBe('stranger')
  expect(decideAccess(null, messageIn(-1002, 'channel'))).toBe('stranger')
})

test('test_c12_owner_chat_is_owner_and_other_private_chat_is_stranger', () => {
  expect(decideAccess(42, messageIn(42, 'private'))).toBe('owner')
  expect(decideAccess(42, messageIn(7, 'private'))).toBe('stranger')
})

test('test_c13_typing_sends_now_then_every_4s_until_stop', async () => {
  useFakeClock()
  const { api, calls } = recordingApi()

  const typing = startTyping(api, 42)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ method: 'sendChatAction', params: { chat_id: 42, action: 'typing' } })

  await vi.advanceTimersByTimeAsync(3999)
  expect(calls).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(calls).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(4000)
  expect(calls).toHaveLength(3)

  typing.stop()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(calls).toHaveLength(3)
})

test('test_c13_typing_send_error_is_swallowed', async () => {
  useFakeClock()
  const calls: string[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string): Promise<T> {
      calls.push(method)
      throw new TelegramApiError(method, 400, 'Bad Request: chat not found')
    },
  }

  const typing = startTyping(api, 42)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(8000)
  expect(() => typing.stop()).not.toThrow()
})
