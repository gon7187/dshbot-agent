// Service insertion about the message the owner replied to.
//
// `normalizeUpdate` keeps the body of `reply_to_message`, but the owner turn has
// to carry it explicitly: a reply such as "tell me more about the first one"
// makes no sense to the model without the answer it points at. Like the
// attachments insertion, it rides in the tail of the turn, never in the stable
// prefix, so the prefix and the `main` session stay cached.
//
// The body the owner replied to is data, not an instruction: it goes into the
// shared `EXTERNAL_UNTRUSTED_CONTENT` frame with the author label inside.

import type { NormalizedReply } from '../../telegram/src/update.js'
import { frameData } from './untrusted-frame.js'

/** Characters of the original text (and of the quote) that reach the model. */
export const REPLY_TEXT_LIMIT = 2000

/** Marker of a service insertion that is not an owner message. */
export const REPLY_CONTEXT_OPEN = '<context_не_owner: ответ реплаем>'
export const REPLY_CONTEXT_CLOSE = '</context_не_owner>'

function cutText(text: string, limit = REPLY_TEXT_LIMIT): string {
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  const head = characters.slice(0, limit).join('')
  return `${head}\n… Текст обрезан: показаны первые ${limit} символов из ${characters.length}.`
}

const ATTACHMENT_LABELS: Record<string, string> = {
  document: 'документ',
  photo: 'фото',
  voice: 'голосовое',
  audio: 'аудио',
  video: 'видео',
  video_note: 'видеосообщение',
}

/**
 * Insertion for the tail of a turn that is a reply. Returns an empty string
 * when the update is not a reply, carries nothing of the original, or (for a
 * guest) points at a message of another chat.
 */
export function replyContextForTurn(reply: NormalizedReply | undefined, chatId: number): string {
  if (reply === undefined) return ''
  if (reply.chatId !== undefined && reply.chatId !== chatId) return ''

  const text = cutText(reply.text)
  const quote = reply.quote === undefined ? '' : cutText(reply.quote)
  const attachments = reply.attachmentKinds
    .map((kind) => ATTACHMENT_LABELS[kind] ?? kind)
    .filter((label, index, all) => all.indexOf(label) === index)
  if (text === '' && quote === '' && attachments.length === 0) return ''

  const body: string[] = [
    `Владелец отвечает реплаем на сообщение; автор оригинала: ${reply.fromBot ? 'бот' : 'владелец'}.`,
  ]
  if (text !== '') body.push('Текст оригинала:', text)
  if (quote !== '') body.push('Выделенная цитата:', quote)
  if (attachments.length > 0) body.push(`Вложение: ${attachments.join(', ')}.`)

  return [REPLY_CONTEXT_OPEN, frameData(body.join('\n')), REPLY_CONTEXT_CLOSE].join('\n')
}
