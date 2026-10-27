import { expect, test } from 'vitest'
import type { TelegramApi } from './api.js'
import { TelegramApiError } from './api.js'
import { createTopics } from './topics.js'

// Assumed API: createTopics(api, chatId) reads getMe once; ensure(taskId) -> { threadId };
// send(taskId, text) sends a task message into its topic or, without topics, with a "[задача #id]" prefix.

const CHAT = 1001
const THREAD = 77
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047]

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi(respond: (method: string, params: Params) => unknown) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      return (await respond(method, params)) as T
    },
  }
  return { api, calls }
}

function botWithTopics(enabled: boolean) {
  return { id: 1, is_bot: true, first_name: 'DSHBOT', has_topics_enabled: enabled }
}

test('test_c10_ensure_creates_one_topic_with_valid_name_and_icon_color', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'getMe') return botWithTopics(true)
    if (method === 'createForumTopic') return { message_thread_id: THREAD, name: 'x', icon_color: ICON_COLORS[0] }
    return true
  })
  const topics = await createTopics(api, CHAT)
  const taskId = `long-${'x'.repeat(200)}`

  const { threadId } = await topics.ensure(taskId)
  expect(threadId).toBe(THREAD)

  const created = calls.filter((c) => c.method === 'createForumTopic')
  expect(created).toHaveLength(1)
  expect(created[0].params.chat_id).toBe(CHAT)
  const name = created[0].params.name
  expect(name).toBeTypeOf('string')
  expect((name as string).length).toBeGreaterThan(0)
  expect((name as string).length).toBeLessThanOrEqual(128)
  expect(ICON_COLORS).toContain(created[0].params.icon_color)

  await topics.ensure(taskId)
  expect(calls.filter((c) => c.method === 'createForumTopic')).toHaveLength(1)
})

test('test_c11_without_topics_no_topic_is_created_and_task_messages_get_prefix', async () => {
  const { api, calls } = fakeApi((method) => (method === 'getMe' ? botWithTopics(false) : true))
  const topics = await createTopics(api, CHAT)

  const { threadId } = await topics.ensure('t1')
  expect(threadId ?? null).toBeNull()
  expect(calls.some((c) => c.method === 'createForumTopic')).toBe(false)

  await topics.send('t1', 'готово')
  const sent = calls.find((c) => c.method === 'sendMessage')
  expect(String(sent?.params.text)).toContain('[задача #t1]')
  expect(sent?.params.message_thread_id ?? null).toBeNull()
})

test('test_c12_thread_not_found_propagates_and_no_plain_retry_happens', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'getMe') return botWithTopics(true)
    if (method === 'createForumTopic') return { message_thread_id: THREAD, name: 'x', icon_color: ICON_COLORS[0] }
    if (method === 'sendMessage') {
      throw new TelegramApiError('sendMessage', 400, 'Bad Request: message thread not found')
    }
    return true
  })
  const topics = await createTopics(api, CHAT)

  await expect(topics.send('t1', 'привет')).rejects.toThrow(/message thread not found/)

  const sends = calls.filter((c) => c.method === 'sendMessage')
  expect(sends.length).toBeGreaterThan(0)
  for (const send of sends) {
    expect(send.params.message_thread_id).toBe(THREAD)
  }
})
