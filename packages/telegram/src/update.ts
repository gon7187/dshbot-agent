// Raw Bot API updates are intentionally structural: Telegram adds fields faster
// than we can model them, and unknown updates must degrade to `null`, not throw.

import { richTextToPlain, type RichBlock } from './rich/markdown.js'

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel'

export interface TelegramUser {
  id?: number
  is_bot?: boolean
  first_name?: string
  [key: string]: unknown
}

export interface TelegramChat {
  id?: number
  type?: TelegramChatType
  [key: string]: unknown
}

export interface TelegramPhotoSize {
  file_id?: string
  file_unique_id?: string
  width?: number
  height?: number
  file_size?: number
  [key: string]: unknown
}

export interface TelegramLocation {
  latitude?: number
  longitude?: number
  horizontal_accuracy?: number
  [key: string]: unknown
}

export interface TelegramVenue {
  location?: TelegramLocation
  title?: string
  address?: string
  [key: string]: unknown
}

export interface TelegramContact {
  phone_number?: string
  first_name?: string
  last_name?: string
  user_id?: number
  [key: string]: unknown
}

export interface TelegramSticker {
  file_id?: string
  file_unique_id?: string
  type?: string
  emoji?: string
  set_name?: string
  file_size?: number
  [key: string]: unknown
}

export interface TelegramForwardOrigin {
  type?: 'user' | 'hidden_user' | 'chat' | 'channel' | string
  date?: number
  sender_user?: TelegramUser
  sender_user_name?: string
  chat?: TelegramChat
  message_id?: number
  author_signature?: string
  [key: string]: unknown
}

export interface TelegramFileInfo {
  file_id?: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
  /** Duration of a voice message, audio file or round video, in seconds. */
  duration?: number
  [key: string]: unknown
}

export interface TelegramMessageEntity {
  type?: string
  offset?: number
  length?: number
  user?: TelegramUser
  [key: string]: unknown
}

export interface TelegramMessage {
  message_id?: number
  date?: number
  chat?: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
  /** Entities of `text`: a `mention` or `text_mention` is how a group addresses the bot. */
  entities?: TelegramMessageEntity[]
  /** Entities of `caption`, in the same shape as `entities`. */
  caption_entities?: TelegramMessageEntity[]
  message_thread_id?: number
  is_topic_message?: boolean
  reply_to_message?: TelegramMessage
  /** The part of a message the owner selected when replying (Bot API `quote`). */
  quote?: { text?: string; is_manual?: boolean; [key: string]: unknown }
  media_group_id?: string
  document?: TelegramFileInfo
  photo?: TelegramPhotoSize[]
  voice?: TelegramFileInfo
  audio?: TelegramFileInfo
  video?: TelegramFileInfo
  video_note?: TelegramFileInfo
  /** A GIF sent by Telegram as an animation: a video file without a caption is still an attachment. */
  animation?: TelegramFileInfo
  /** Origin of a forwarded message (Bot API 7.0). */
  forward_origin?: TelegramForwardOrigin
  /** Legacy forward fields, still sent by some clients. */
  forward_from?: TelegramUser
  forward_from_chat?: TelegramChat
  forward_from_message_id?: number
  forward_sender_name?: string
  forward_date?: number
  /** A shared location. */
  location?: TelegramLocation
  /** A shared place: Telegram also fills `location` next to it. */
  venue?: TelegramVenue
  /** A shared phone contact. */
  contact?: TelegramContact
  /** A sticker; it carries no text but says what it is. */
  sticker?: TelegramSticker
  /** Blocks of a message sent through the rich-message API. */
  rich_message?: { blocks?: RichBlock[]; [key: string]: unknown }
  [key: string]: unknown
}

/** One file attached to a message, before any download. */
export type TelegramAttachmentKind = 'document' | 'photo' | 'voice' | 'audio' | 'video' | 'video_note'

export interface NormalizedAttachment {
  kind: TelegramAttachmentKind
  /** Bot API file id, never a path. */
  fileId: string
  fileUniqueId?: string
  /** Size declared by the update; absent when Telegram did not provide it. */
  fileSize?: number
  /** Original file name, when the update has one. */
  fileName?: string
  mimeType?: string
  /** Duration in seconds, when the Bot API reports one (voice, audio, round video). */
  duration?: number
  /** Telegram album id: all files of one album share it. */
  mediaGroupId?: string
}

export interface TelegramCallbackQuery {
  id?: string
  from?: TelegramUser
  data?: string
  message?: TelegramMessage
  [key: string]: unknown
}

export interface TelegramStoppedGeneration {
  chat?: TelegramChat
  draft_id?: number
  message_thread_id?: number
  [key: string]: unknown
}

export interface TelegramReactionType {
  type?: string
  emoji?: string
  [key: string]: unknown
}

export interface TelegramMessageReaction {
  chat?: TelegramChat
  message_id?: number
  date?: number
  user?: TelegramUser
  old_reaction?: TelegramReactionType[]
  new_reaction?: TelegramReactionType[]
  [key: string]: unknown
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
  stopped_message_generation?: TelegramStoppedGeneration
  message_reaction?: TelegramMessageReaction
  [key: string]: unknown
}

export interface NormalizedMessage {
  kind: 'message'
  updateId: number
  chatId: number
  chatType: TelegramChatType
  fromId: number
  messageId: number
  threadId?: number
  text: string
  /** The message this one replies to, when it is a reply. */
  replyToMessageId?: number
  /** Body of the message this one replies to, when it is a reply. */
  replyTo?: NormalizedReply
  /** Usernames of the `mention`/`text_mention` entities, without the leading `@`. */
  mentions?: string[]
  /** Files carried by the message; empty for a plain text message. */
  attachments: NormalizedAttachment[]
}

/**
 * What the owner sees when replying: the author and body of the message they
 * replied to, plus the part they selected. The turn tail gets this as data.
 */
export interface NormalizedReply {
  /** Id of the replied message. */
  messageId: number
  /** Chat of the replied message; absent when the update did not carry one. */
  chatId?: number
  /** Author id of the original, when the update carried one. */
  fromId?: number
  /** The original was written by a bot (normally this bot). */
  fromBot: boolean
  /** Text or caption of the original; rich messages are flattened to text. */
  text: string
  /** The quote the owner selected in the replying message, if any. */
  quote?: string
  /** Kinds of the files the original carried (document, photo, ...). */
  attachmentKinds: TelegramAttachmentKind[]
}

export interface NormalizedCallback {
  kind: 'callback'
  updateId: number
  chatId: number
  fromId: number
  messageId: number
  callbackId: string
  data: string
}

export interface NormalizedStopped {
  kind: 'stopped'
  updateId: number
  chatId: number
  draftId: number
  threadId?: number
}

export interface NormalizedReaction {
  kind: 'reaction'
  updateId: number
  chatId: number
  messageId: number
  emoji: string[]
}

export type NormalizedUpdate = NormalizedMessage | NormalizedCallback | NormalizedStopped | NormalizedReaction

/** Largest photo size of a message: Telegram sorts them, but never trust that. */
function largestPhoto(photo: TelegramPhotoSize[] | undefined): TelegramPhotoSize | undefined {
  let best: TelegramPhotoSize | undefined
  let bestArea = -1
  for (const size of photo ?? []) {
    if (typeof size?.file_id !== 'string' || size.file_id === '') continue
    const area = (size.width ?? 0) * (size.height ?? 0)
    if (best === undefined || area >= bestArea) {
      best = size
      bestArea = area
    }
  }
  return best
}

function attachmentOf(
  kind: TelegramAttachmentKind,
  file: TelegramFileInfo | TelegramPhotoSize | undefined,
  mediaGroupId: string | undefined,
): NormalizedAttachment | undefined {
  if (file === undefined || typeof file.file_id !== 'string' || file.file_id === '') return undefined
  const name = (file as TelegramFileInfo).file_name
  const mime = (file as TelegramFileInfo).mime_type
  const duration = (file as TelegramFileInfo).duration
  return {
    kind,
    fileId: file.file_id,
    ...(typeof file.file_unique_id === 'string' ? { fileUniqueId: file.file_unique_id } : {}),
    ...(typeof file.file_size === 'number' ? { fileSize: file.file_size } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
    ...(typeof name === 'string' && name !== '' ? { fileName: name } : {}),
    ...(typeof mime === 'string' && mime !== '' ? { mimeType: mime } : {}),
    ...(mediaGroupId === undefined ? {} : { mediaGroupId }),
  }
}

/** Every file of one message in a stable order (an album message carries exactly one). */
export function attachmentsOf(message: TelegramMessage): NormalizedAttachment[] {
  const group = typeof message.media_group_id === 'string' ? message.media_group_id : undefined
  const found: Array<NormalizedAttachment | undefined> = [
    attachmentOf('document', message.document, group),
    attachmentOf('photo', largestPhoto(message.photo), group),
    attachmentOf('voice', message.voice, group),
    attachmentOf('audio', message.audio, group),
    attachmentOf('video', message.video, group),
    attachmentOf('video_note', message.video_note, group),
    // A GIF arrives as `animation` (an MP4): without this a GIF without a
    // caption is a message with nothing to hand to the pipeline.
    attachmentOf('video', message.animation, group),
  ]
  return found.filter((attachment): attachment is NormalizedAttachment => attachment !== undefined)
}

/** Flattens the blocks of a rich message to its readable text, in block order. */
function richBlocksText(blocks: RichBlock[] | undefined): string {
  const lines: string[] = []
  for (const block of blocks ?? []) {
    if (block === null || typeof block !== 'object') continue
    const own = richTextToPlain(block.text)
    if (own !== '') lines.push(own)
    for (const item of Array.isArray(block.items) ? block.items : []) {
      if (item === null || typeof item !== 'object') continue
      const nested = richBlocksText(item.blocks)
      if (nested !== '') lines.push(nested)
    }
    for (const row of Array.isArray(block.cells) ? block.cells : []) {
      if (!Array.isArray(row)) continue
      const cells = row
        .map((cell) => (cell !== null && typeof cell === 'object' ? richTextToPlain(cell.text) : ''))
        .filter((text) => text !== '')
      if (cells.length > 0) lines.push(cells.join(' | '))
    }
    const nested = richBlocksText(Array.isArray(block.blocks) ? block.blocks : undefined)
    if (nested !== '') lines.push(nested)
  }
  return lines.join('\n')
}

/** Visible text of a message: text, caption, or the text of its rich blocks. */
function textOfMessage(message: TelegramMessage): string {
  if (typeof message.text === 'string' && message.text !== '') return message.text
  if (typeof message.caption === 'string' && message.caption !== '') return message.caption
  const blocks = message.rich_message?.blocks
  return Array.isArray(blocks) ? richBlocksText(blocks) : ''
}

/** A person as a readable line: the full name and, when present, the @username. */
function personName(user: TelegramUser | undefined): string {
  if (user === undefined) return ''
  const full = [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(' ')
  const username = typeof user.username === 'string' && user.username.trim() !== '' ? `(@${user.username.trim()})` : ''
  return [full, username].filter((part) => part !== '').join(' ')
}

/** The original timestamp in UTC, never the clock of the daemon. */
function forwardDate(seconds: number | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/**
 * Author and date of a forwarded message. The Bot API 7 `forward_origin` is the
 * source of truth; the legacy fields are the fallback for updates that predate
 * it or that a client still sends in the old shape.
 */
function forwardLines(message: TelegramMessage): string[] {
  const origin = message.forward_origin
  const date = forwardDate(origin?.date ?? message.forward_date)
  const suffix = date === undefined ? '' : `, дата оригинала: ${date}`
  if (origin !== undefined && typeof origin === 'object') {
    if (origin.type === 'user') {
      const name = personName(origin.sender_user)
      if (name !== '') return [`[Переслано от: ${name}${suffix}]`]
    }
    if (origin.type === 'hidden_user' && typeof origin.sender_user_name === 'string' && origin.sender_user_name !== '') {
      return [`[Переслано от скрытого отправителя: ${origin.sender_user_name}${suffix}]`]
    }
    if ((origin.type === 'channel' || origin.type === 'chat') && typeof origin.chat?.title === 'string') {
      const signature =
        typeof origin.author_signature === 'string' && origin.author_signature !== ''
          ? `, подпись: ${origin.author_signature}`
          : ''
      const source = origin.type === 'channel' ? 'канала' : 'чата'
      return [`[Переслано из ${source} «${origin.chat.title}»${signature}${suffix}]`]
    }
  }
  if (typeof message.forward_sender_name === 'string' && message.forward_sender_name !== '') {
    return [`[Переслано от скрытого отправителя: ${message.forward_sender_name}${suffix}]`]
  }
  if (typeof message.forward_from_chat?.title === 'string' && message.forward_from_chat.title !== '') {
    return [`[Переслано из канала «${message.forward_from_chat.title}»${suffix}]`]
  }
  const name = personName(message.forward_from as TelegramUser | undefined)
  if (name !== '') return [`[Переслано от: ${name}${suffix}]`]
  if (date !== undefined) return [`[Переслано, дата оригинала: ${date}]`]
  return []
}

function coordinate(value: number | undefined): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

/** Location and venue as coordinates, with the place name and address for a venue. */
function locationLines(message: TelegramMessage): string[] {
  const venue = message.venue
  if (venue !== undefined && typeof venue === 'object') {
    const latitude = coordinate(venue.location?.latitude)
    const longitude = coordinate(venue.location?.longitude)
    const point =
      latitude !== undefined && longitude !== undefined ? `, координаты: ${latitude}, ${longitude}` : ''
    const title = typeof venue.title === 'string' && venue.title !== '' ? ` «${venue.title}»` : ''
    const address = typeof venue.address === 'string' && venue.address !== '' ? `, адрес: ${venue.address}` : ''
    return [`[Место${title}${address}${point}]`]
  }
  const latitude = coordinate(message.location?.latitude)
  const longitude = coordinate(message.location?.longitude)
  if (latitude === undefined || longitude === undefined) return []
  return [`[Геолокация: ${latitude}, ${longitude}]`]
}

/** A phone contact: the name and the number, framed as data. */
function contactLines(message: TelegramMessage): string[] {
  const contact = message.contact
  if (contact === undefined || typeof contact !== 'object') return []
  const phone = typeof contact.phone_number === 'string' ? contact.phone_number.trim() : ''
  const name = [contact.first_name, contact.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(' ')
  if (phone === '' && name === '') return []
  if (phone === '') return [`[Контакт: ${name}]`]
  if (name === '') return [`[Контакт, телефон: ${phone}]`]
  return [`[Контакт: ${name}, телефон: ${phone}]`]
}

/** A sticker says which emotion it carries and which set it belongs to. */
function stickerLines(message: TelegramMessage): string[] {
  const sticker = message.sticker
  if (sticker === undefined || typeof sticker !== 'object') return []
  const emoji = typeof sticker.emoji === 'string' && sticker.emoji !== '' ? sticker.emoji : ''
  const set = typeof sticker.set_name === 'string' && sticker.set_name !== '' ? sticker.set_name : ''
  if (emoji === '' && set === '') return []
  if (set === '') return [`[Стикер: ${emoji}]`]
  if (emoji === '') return [`[Стикер из набора ${set}]`]
  return [`[Стикер: ${emoji}, набор ${set}]`]
}

/**
 * Everything a message carries besides its visible text. The model sees these
 * as parts of the user message, so a forward keeps its author, a location its
 * coordinates, a contact its phone and a sticker its emoji and set.
 */
function nonTextLines(message: TelegramMessage): string[] {
  return [
    ...forwardLines(message),
    ...locationLines(message),
    ...contactLines(message),
    ...stickerLines(message),
  ]
}

/**
 * Usernames the message addresses through Bot API entities. A plain `@name` in
 * the text is not a mention: only the entity makes it one, and a `text_mention`
 * carries the user (and its username) directly.
 */
function mentionHandles(message: TelegramMessage): string[] {
  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
  const handles: string[] = []
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (entity === null || typeof entity !== 'object') continue
    if (entity.type === 'mention' && text !== '' && typeof entity.offset === 'number' && typeof entity.length === 'number') {
      const raw = text.slice(entity.offset, entity.offset + entity.length).trim().replace(/^@/, '')
      if (raw !== '') handles.push(raw)
      continue
    }
    if (entity.type === 'text_mention' && typeof entity.user?.username === 'string') {
      const raw = entity.user.username.trim().replace(/^@/, '')
      if (raw !== '') handles.push(raw)
    }
  }
  return [...new Set(handles)]
}

function normalizeReply(message: TelegramMessage): NormalizedReply | undefined {
  const original = message.reply_to_message
  const messageId = original?.message_id
  if (original === undefined || typeof messageId !== 'number') return undefined

  const quote = typeof message.quote?.text === 'string' && message.quote.text !== '' ? message.quote.text : undefined
  const chatId = original.chat?.id
  const fromId = original.from?.id
  const attachmentKinds: TelegramAttachmentKind[] = []
  for (const attachment of attachmentsOf(original)) {
    if (!attachmentKinds.includes(attachment.kind)) attachmentKinds.push(attachment.kind)
  }

  return {
    messageId,
    ...(typeof chatId === 'number' ? { chatId } : {}),
    ...(typeof fromId === 'number' ? { fromId } : {}),
    fromBot: original.from?.is_bot === true,
    text: textOfMessage(original),
    ...(quote === undefined ? {} : { quote }),
    attachmentKinds,
  }
}

function normalizeMessage(updateId: number, message: TelegramMessage): NormalizedMessage | null {
  const chatId = message.chat?.id
  const messageId = message.message_id
  if (typeof chatId !== 'number' || typeof messageId !== 'number') return null

  // A message without visible text and without a file (a sticker, a location,
  // a contact, a service message) still has something to hand to the model;
  // only a message with neither text nor any described content is dropped.
  const caption = typeof message.caption === 'string' ? message.caption : undefined
  const rawText = typeof message.text === 'string' ? message.text : caption
  const attachments = attachmentsOf(message)
  const described = nonTextLines(message)
  const text = [rawText ?? '', ...described].filter((part) => part !== '').join('\n\n')
  if (text === '' && attachments.length === 0) return null

  const threadId = typeof message.message_thread_id === 'number' ? message.message_thread_id : undefined
  const fromId = typeof message.from?.id === 'number' ? message.from.id : chatId
  const chatType = message.chat?.type ?? 'private'
  const replyTo = message.reply_to_message?.message_id
  const reply = normalizeReply(message)

  return {
    kind: 'message',
    updateId,
    chatId,
    chatType,
    fromId,
    messageId,
    ...(threadId === undefined ? {} : { threadId }),
    ...(typeof replyTo === 'number' ? { replyToMessageId: replyTo } : {}),
    ...(reply === undefined ? {} : { replyTo: reply }),
    mentions: mentionHandles(message),
    text,
    attachments,
  }
}

function normalizeCallback(updateId: number, query: TelegramCallbackQuery): NormalizedCallback | null {
  // `callback_query.message` may be an InaccessibleMessage; it still carries chat and id.
  const chatId = query.message?.chat?.id
  const messageId = query.message?.message_id
  const fromId = query.from?.id
  if (typeof chatId !== 'number' || typeof messageId !== 'number' || typeof fromId !== 'number') return null
  if (typeof query.id !== 'string') return null

  return {
    kind: 'callback',
    updateId,
    chatId,
    fromId,
    messageId,
    callbackId: query.id,
    data: typeof query.data === 'string' ? query.data : '',
  }
}

function normalizeStopped(updateId: number, stopped: TelegramStoppedGeneration): NormalizedStopped | null {
  const chatId = stopped.chat?.id
  const draftId = stopped.draft_id
  if (typeof chatId !== 'number' || typeof draftId !== 'number') return null
  const threadId = typeof stopped.message_thread_id === 'number' ? stopped.message_thread_id : undefined

  return {
    kind: 'stopped',
    updateId,
    chatId,
    draftId,
    ...(threadId === undefined ? {} : { threadId }),
  }
}

function normalizeReaction(updateId: number, reaction: TelegramMessageReaction): NormalizedReaction | null {
  const chatId = reaction.chat?.id
  const messageId = reaction.message_id
  if (typeof chatId !== 'number' || typeof messageId !== 'number') return null

  // Only emoji reactions have an emoji to carry; custom/paid reactions are dropped.
  const emoji: string[] = []
  for (const entry of reaction.new_reaction ?? []) {
    if (entry?.type === 'emoji' && typeof entry.emoji === 'string') emoji.push(entry.emoji)
  }

  return { kind: 'reaction', updateId, chatId, messageId, emoji }
}

export function normalizeUpdate(update: TelegramUpdate): NormalizedUpdate | null {
  if (typeof update.update_id !== 'number') return null
  const updateId = update.update_id

  const message = update.message ?? update.edited_message
  if (message) return normalizeMessage(updateId, message)
  if (update.callback_query) return normalizeCallback(updateId, update.callback_query)
  if (update.stopped_message_generation) return normalizeStopped(updateId, update.stopped_message_generation)
  if (update.message_reaction) return normalizeReaction(updateId, update.message_reaction)
  return null
}

export type AccessDecision = 'pair' | 'owner' | 'stranger'

export interface AccessSubject {
  chatId: number
  chatType?: string
}

/**
 * Decides how a normalized update relates to the single bot owner.
 * Only a private chat can start pairing; groups, supergroups and channels never can.
 */
export function decideAccess(ownerChatId: number | null | undefined, msg: AccessSubject): AccessDecision {
  const hasOwner = ownerChatId !== null && ownerChatId !== undefined
  if (hasOwner && msg.chatId === ownerChatId) return 'owner'
  if (!hasOwner && msg.chatType === 'private') return 'pair'
  return 'stranger'
}
