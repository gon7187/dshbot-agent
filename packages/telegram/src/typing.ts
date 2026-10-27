import type { TelegramApi } from './api.js'

const TYPING_INTERVAL_MS = 4000

export interface TypingHandle {
  stop(): void
}

/**
 * Keeps the "typing…" status alive: sends once immediately, then every 4 s
 * (Telegram expires the status after ~5 s). Send failures are never surfaced.
 */
export function startTyping(api: TelegramApi, chatId: number, threadId?: number): TypingHandle {
  let stopped = false

  const send = (): void => {
    if (stopped) return
    const params: Record<string, unknown> = { chat_id: chatId, action: 'typing' }
    if (threadId !== undefined) params.message_thread_id = threadId
    try {
      void api.call('sendChatAction', params).catch(() => {})
    } catch {
      // A synchronous throw from a custom TelegramApi must not break the caller.
    }
  }

  send()
  const timer = setInterval(send, TYPING_INTERVAL_MS)

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}
