// Forum topics for the private owner chat (Bot API 9.3+). When the bot reports
// `has_topics_enabled`, every task gets its own topic and messages carry its
// message_thread_id. Otherwise the task id is prepended to the text. A failed send is
// never retried without the thread id: delivering into the wrong surface is worse than
// a loud error.

import type { TelegramApi } from './api.js'

/** The only icon colours accepted by createForumTopic. */
export const FORUM_TOPIC_ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047] as const

/** createForumTopic name limit. */
export const TOPIC_NAME_LIMIT = 128

export interface TopicPointer {
  threadId: number | null
}

export interface Topics {
  readonly hasTopics: boolean
  /** Create the task topic once and return its thread id. */
  ensure(taskId: string): Promise<TopicPointer>
  /** Send a task message into its topic, or with a `[задача #id]` prefix without topics. */
  send(taskId: string, text: string): Promise<unknown>
}

interface GetMeResult {
  has_topics_enabled?: boolean
}

function stableIndex(value: string, modulo: number): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % modulo
}

function topicName(taskId: string): string {
  // Keep both the UTF-16 length and the code point count within 128 characters, and
  // never split a surrogate pair at the boundary. Clients and the Bot API disagree on
  // whether "characters" are code points or UTF-16 units, so satisfy both.
  const source = `Задача ${taskId}`
  let name = ''
  let codePoints = 0
  for (const character of source) {
    if (codePoints >= TOPIC_NAME_LIMIT || name.length + character.length > TOPIC_NAME_LIMIT) break
    name += character
    codePoints += 1
  }
  return name
}

/** Prefix used when the private chat has no topics enabled. */
export function taskPrefix(taskId: string): string {
  return `[задача #${taskId}]`
}

/**
 * Read `getMe` once and return the topic manager for the chat. Topic creation is cached
 * per task id for the lifetime of the manager.
 */
export async function createTopics(api: TelegramApi, chatId: number): Promise<Topics> {
  const me = await api.call<GetMeResult>('getMe')
  const hasTopics = me?.has_topics_enabled === true
  const threads = new Map<string, number>()

  const ensure = async (taskId: string): Promise<TopicPointer> => {
    if (!hasTopics) return { threadId: null }

    const existing = threads.get(taskId)
    if (existing !== undefined) return { threadId: existing }

    const created = await api.call<{ message_thread_id?: number }>('createForumTopic', {
      chat_id: chatId,
      name: topicName(taskId),
      icon_color: FORUM_TOPIC_ICON_COLORS[stableIndex(taskId, FORUM_TOPIC_ICON_COLORS.length)],
    })

    const threadId = typeof created?.message_thread_id === 'number' ? created.message_thread_id : null
    if (threadId === null) throw new Error(`createForumTopic returned no message_thread_id for ${taskId}`)
    threads.set(taskId, threadId)
    return { threadId }
  }

  const send = async (taskId: string, text: string): Promise<unknown> => {
    if (!hasTopics) {
      return api.call('sendMessage', { chat_id: chatId, text: `${taskPrefix(taskId)} ${text}` })
    }
    const { threadId } = await ensure(taskId)
    // No retry without message_thread_id on purpose: see the module comment.
    return api.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text })
  }

  return { hasTopics, ensure, send }
}
