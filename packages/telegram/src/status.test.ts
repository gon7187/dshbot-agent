import { expect, test } from 'vitest'
import type { TelegramApi } from './api.js'
import { TelegramApiError } from './api.js'
import { createStatusController } from './status.js'

// Assumed API: createStatusController(api, chatId, messageId, emojiByState?) with async set(state).

const CHAT = 1001
const MESSAGE = 7

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi(respond: (method: string, params: Params) => unknown = () => true) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      return (await respond(method, params)) as T
    },
  }
  return { api, calls }
}

test('test_c8_set_sends_one_emoji_reaction_per_state_change_and_skips_repeats', async () => {
  const { api, calls } = fakeApi()
  const status = createStatusController(api, CHAT, MESSAGE)

  await status.set('working')
  await status.set('done')
  await status.set('done')

  const reactions = calls.filter((c) => c.method === 'setMessageReaction')
  expect(reactions).toHaveLength(2)
  for (const reaction of reactions) {
    expect(reaction.params.chat_id).toBe(CHAT)
    expect(reaction.params.message_id).toBe(MESSAGE)
    const list = reaction.params.reaction as Array<{ type: string; emoji: string }>
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('emoji')
    expect(list[0].emoji).toBeTypeOf('string')
  }
  expect(reactions[0].params.reaction).not.toEqual(reactions[1].params.reaction)
})

test('test_c8_reaction_error_400_is_not_thrown_to_caller', async () => {
  const { api, calls } = fakeApi(() => {
    throw new TelegramApiError('setMessageReaction', 400, 'Bad Request: REACTION_INVALID')
  })
  const status = createStatusController(api, CHAT, MESSAGE)

  let thrown: unknown = null
  try {
    await status.set('working')
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeNull()
  expect(calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(1)
})

test('test_c9_emoji_outside_allowed_list_is_replaced_with_thumbs_up', async () => {
  const { api, calls } = fakeApi()
  const status = createStatusController(api, CHAT, MESSAGE, { working: '🧨' })

  await status.set('working')

  const reactions = calls.filter((c) => c.method === 'setMessageReaction')
  expect(reactions).toHaveLength(1)
  expect(reactions[0].params.reaction).toEqual([{ type: 'emoji', emoji: '👍' }])
})
