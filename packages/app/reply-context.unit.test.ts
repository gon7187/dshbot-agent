// Unit checks of the reply context: `normalizeUpdate` keeps the body of the
// replied message, and the turn tail gets it as framed data (never a prefix).
// The end-to-end scenarios live in reply-context.test.ts.

import { describe, expect, test } from 'vitest'
import { normalizeUpdate, type TelegramUpdate } from '../telegram/src/update.js'
import { REPLY_TEXT_LIMIT, replyContextForTurn } from './src/reply-context.js'

const CHAT = 7

function updateWithReply(extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 1,
      chat: { id: CHAT, type: 'private' },
      from: { id: CHAT, is_bot: false, first_name: 'Owner' },
      text: 'own-q1 подробнее',
      reply_to_message: {
        message_id: 2,
        date: 1,
        chat: { id: CHAT, type: 'private' },
        from: { id: 4242, is_bot: true, first_name: 'DSHBOT' },
        text: 'Москва, Берлин, Париж',
        document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'report.pdf' },
      },
      ...extra,
    },
  }
}

test('test_reply_normalizes_body_author_quote_and_attachment', () => {
  const update = updateWithReply({ quote: { text: 'Берлин', is_manual: true } })
  const normalized = normalizeUpdate(update)
  expect(normalized?.kind).toBe('message')
  if (normalized?.kind !== 'message') throw new Error('not a message')
  expect(normalized.replyToMessageId).toBe(2)
  expect(normalized.replyTo).toEqual({
    messageId: 2,
    chatId: CHAT,
    fromId: 4242,
    fromBot: true,
    text: 'Москва, Берлин, Париж',
    quote: 'Берлин',
    attachmentKinds: ['document'],
  })

  // A rich message of the bot has no `text`: its blocks are flattened instead.
  const rich = normalizeUpdate({
    update_id: 2,
    message: {
      message_id: 11,
      date: 1,
      chat: { id: CHAT, type: 'private' },
      from: { id: CHAT, is_bot: false },
      text: 'поясни',
      reply_to_message: {
        message_id: 3,
        date: 1,
        chat: { id: CHAT, type: 'private' },
        from: { id: 4242, is_bot: true },
        rich_message: {
          blocks: [
            { type: 'paragraph', text: [{ type: 'bold', text: 'RICHHEAD-7' }, ' и хвост'] },
            { type: 'list', items: [{ blocks: [{ type: 'paragraph', text: 'пункт списка' }] }] },
          ],
        },
      },
    },
  })
  if (rich?.kind !== 'message') throw new Error('not a message')
  expect(rich.replyTo?.text).toBe('RICHHEAD-7 и хвост\nпункт списка')
})

test('test_reply_insertion_frames_bot_and_owner_messages', () => {
  const toBot = replyContextForTurn(
    { messageId: 2, chatId: CHAT, fromBot: true, text: 'pong-q1', attachmentKinds: [] },
    CHAT,
  )
  expect(toBot).toContain('pong-q1')
  expect(toBot).toContain('бот')
  expect(toBot).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]+">>>/)
  expect(toBot).toContain('<<<END_EXTERNAL_UNTRUSTED_CONTENT id="')
  expect(toBot).toContain('</context_не_owner>')

  const toOwner = replyContextForTurn(
    { messageId: 3, chatId: CHAT, fromBot: false, text: 'заметка', attachmentKinds: ['photo'] },
    CHAT,
  )
  expect(toOwner).toContain('владелец')
  expect(toOwner).toContain('заметка')
  expect(toOwner).toContain('Вложение: фото')
})

test('test_no_reply_or_foreign_chat_has_no_insertion', () => {
  expect(replyContextForTurn(undefined, CHAT)).toBe('')
  // A guest learns nothing about a reply that points at another chat.
  expect(
    replyContextForTurn(
      { messageId: 2, chatId: CHAT + 1, fromBot: false, text: 'чужая переписка', attachmentKinds: [] },
      CHAT,
    ),
  ).toBe('')
  // A reply target with nothing visible carries no insertion.
  expect(
    replyContextForTurn({ messageId: 2, chatId: CHAT, fromBot: false, text: '', attachmentKinds: [] }, CHAT),
  ).toBe('')
})

test('test_long_text_is_cut_at_2000_with_a_mark', () => {
  const long = `HEAD-9 ${'ab'.repeat(1500)} TAILMARKER-ZZ`
  const insertion = replyContextForTurn(
    { messageId: 2, chatId: CHAT, fromBot: true, text: long, attachmentKinds: [] },
    CHAT,
  )
  expect(insertion).toContain(long.slice(0, 1900))
  expect(insertion).not.toContain(long.slice(0, REPLY_TEXT_LIMIT + 1))
  expect(insertion).not.toContain('TAILMARKER-ZZ')
  expect(insertion).toContain(`показаны первые ${REPLY_TEXT_LIMIT}`)
  expect(insertion).toMatch(/обрезан|усеч|truncat|…/i)
})
