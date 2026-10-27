// Status reactions on the owner's message: one Bot API reaction per state change.
// Telegram restricts reactions to a fixed emoji list and normal bots get a single
// reaction per message, so the caller supplies a state -> emoji map that is validated
// here. API failures with error_code 400 are swallowed: a missing reaction must never
// break the task flow.

import type { TelegramApi } from './api.js'

/** Fixed list of emoji accepted by ReactionTypeEmoji. */
export const TELEGRAM_REACTION_EMOJI = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '👨‍💻', '👀', '🎃', '🙈',
  '😴', '😭', '😇', '🤓', '👻', '👨‍🔧', '🤝', '✍', '🤗', '🫡',
  '🎅', '🎄', '☃', '💯', '🤣', '⚡', '🍾', '🏆', '💔', '🤨',
  '😐', '🍓', '🍌', '🍿', '💐', '🙏', '✨', '🥳', '🤷', '👨‍⚕️',
  '💊', '🥶', '🥴', '🤐', '😅', '😊', '🫠', '😎', '🤖', '🎩',
  '🍭', '🫂', '🐳', '🌭', '🦄',
] as const

export const FALLBACK_REACTION_EMOJI = '👍'

export type StatusState = 'idle' | 'working' | 'thinking' | 'done' | 'error' | 'waiting'
export type StatusEmojiMap = Partial<Record<StatusState, string>>

const DEFAULT_STATUS_EMOJI: Record<StatusState, string> = {
  idle: '👀',
  working: '👀',
  thinking: '🤔',
  done: '🎉',
  error: '😢',
  waiting: '🫡',
}

const ALLOWED_REACTIONS = new Set<string>(TELEGRAM_REACTION_EMOJI)

export interface StatusController {
  /** Set the reaction for `state`; repeating the current state is a no-op. */
  set(state: StatusState): Promise<void>
}

function sanitizeEmoji(emoji: string | undefined): string {
  if (typeof emoji === 'string' && ALLOWED_REACTIONS.has(emoji)) return emoji
  return FALLBACK_REACTION_EMOJI
}

function isBadRequest(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { errorCode?: unknown }).errorCode === 400
}

/** Controller for the status reaction on a single owner message. */
export function createStatusController(
  api: TelegramApi,
  chatId: number,
  messageId: number,
  emojiByState: StatusEmojiMap = {},
): StatusController {
  const emojiMap: Record<StatusState, string> = { ...DEFAULT_STATUS_EMOJI, ...emojiByState }
  let current: StatusState | null = null

  return {
    async set(state: StatusState): Promise<void> {
      if (state === current) return
      // Remember the attempt even when Telegram rejects it: retrying the same state on
      // every tick would only add noise.
      current = state

      const emoji = sanitizeEmoji(emojiMap[state])
      try {
        await api.call('setMessageReaction', {
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji }],
        })
      } catch (error) {
        if (isBadRequest(error)) return
        throw error
      }
    },
  }
}
