// The `message` tool of the owner turn and the bookkeeping behind it.
//
// One tool sends into the owner chat only: text with an inline keyboard (url
// buttons and reply buttons), an album of 2..10 photos/videos, one video, one
// GIF/animation, and it replies to a message by id. The same tool pins,
// unpins, edits and deletes messages the bot sent itself: ids of foreign
// messages are refused before any Bot API call.
//
// A reply button carries `callback_data` of a fixed small size instead of its
// text (the Bot API caps that field at 64 bytes); the registry maps the data
// back to the text, and the daemon hands a press to the model as an owner
// message with exactly that text.
//
// Every message the bot sends is remembered here as well, whatever lane sent
// it: the HTTP client is wrapped once, so a text answer, a `send_file` upload
// and an album are all editable/deletable by their id afterwards. The record
// is keyed by chat and id, so a send into a guest chat never grants rights on
// (or changes the kind of) a message with the same id in the owner chat.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

import type { RunnerTool, RunnerToolContext } from '../../runner/src/index.js'
import type { TelegramApi } from '../../telegram/src/api.js'
import { normalizeMarkdownHardBreaks, sendFormatted } from '../../telegram/src/rich/index.js'
import { MAX_SEND_BYTES, mimeOfName, resolveOutgoingFile, type OutgoingFile } from './outgoing-files.js'

/** How the body of a bot message can be edited: text or a media caption. */
export type BotMessageKind = 'text' | 'media'

/**
 * Messages this bot process sent, by chat and id; bounded, oldest entries leave
 * first. A Telegram message_id is unique only inside its chat: a guest answer
 * may carry the same id as a message of the owner chat, so an entry always
 * names the chat it was sent to.
 */
export interface BotMessageRegistry {
  record(chatId: number | string, messageId: number, kind: BotMessageKind): void
  kindOf(chatId: number | string, messageId: number): BotMessageKind | undefined
  forget(chatId: number | string, messageId: number): void
}

const MAX_TRACKED_MESSAGES = 5_000
const MAX_TRACKED_BUTTONS = 5_000

function messageKey(chatId: number | string, messageId: number): string {
  return `${String(chatId).trim()}:${messageId}`
}

export function createBotMessageRegistry(): BotMessageRegistry {
  const kinds = new Map<string, BotMessageKind>()
  return {
    record(chatId, messageId, kind) {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) return
      const key = messageKey(chatId, messageId)
      kinds.delete(key)
      kinds.set(key, kind)
      if (kinds.size > MAX_TRACKED_MESSAGES) {
        const oldest = kinds.keys().next().value
        if (oldest !== undefined) kinds.delete(oldest)
      }
    },
    kindOf(chatId, messageId) {
      return kinds.get(messageKey(chatId, messageId))
    },
    forget(chatId, messageId) {
      kinds.delete(messageKey(chatId, messageId))
    },
  }
}

/** Text of a reply button by the callback_data it travelled with. */
export interface ReplyButtonRegistry {
  /** Registers the text and returns callback_data of a fixed small size. */
  create(text: string): string
  textOf(data: string): string | undefined
}

export function createReplyButtonRegistry(): ReplyButtonRegistry {
  const texts = new Map<string, string>()
  return {
    create(text) {
      let data = ''
      for (;;) {
        // 4 + 24 = 28 bytes: well under the 64-byte Bot API limit at any text length.
        data = `mb1:${randomBytes(12).toString('hex')}`
        if (!texts.has(data)) break
      }
      texts.set(data, text)
      if (texts.size > MAX_TRACKED_BUTTONS) {
        const oldest = texts.keys().next().value
        if (oldest !== undefined) texts.delete(oldest)
      }
      return data
    },
    textOf(data) {
      return texts.get(data)
    },
  }
}

const TEXT_SEND_METHODS = new Set(['sendMessage', 'sendRichMessage'])
const MEDIA_SEND_METHODS = new Set(['sendPhoto', 'sendVideo', 'sendAnimation', 'sendDocument', 'sendAudio', 'sendVoice'])

/** Chat a call went to: the requested `chat_id`, else the chat Telegram reports in the result. */
function chatIdOf(params: Record<string, unknown> | undefined, result: unknown): number | string | undefined {
  const requested = params?.chat_id
  if (typeof requested === 'number' && Number.isSafeInteger(requested)) return requested
  if (typeof requested === 'string' && requested.trim() !== '') return requested.trim()
  if (result === null || typeof result !== 'object') return undefined
  const reported = (result as { chat?: { id?: unknown } }).chat?.id
  return typeof reported === 'number' && Number.isSafeInteger(reported) ? reported : undefined
}

function messageIdOf(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const id = (value as { message_id?: unknown }).message_id
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

/**
 * Wraps the Bot API client so every message the bot sends is remembered under
 * the chat it went to. `deleteMessage` forgets the id in that chat: after the owner asked to remove it there is
 * nothing left to edit.
 */
export function trackTelegramMessages(api: TelegramApi, messages: BotMessageRegistry): TelegramApi {
  const call: TelegramApi['call'] = async <T>(
    method: string,
    params?: Record<string, unknown>,
    files?: Record<string, { name: string; data: Uint8Array; contentType?: string }>,
  ): Promise<T> => {
    const result = await api.call<T>(method, params, files)
    if (TEXT_SEND_METHODS.has(method) || MEDIA_SEND_METHODS.has(method)) {
      const id = messageIdOf(result)
      const chatId = chatIdOf(params, result)
      if (id !== undefined && chatId !== undefined) {
        messages.record(chatId, id, TEXT_SEND_METHODS.has(method) ? 'text' : 'media')
      }
    } else if (method === 'sendMediaGroup' && Array.isArray(result)) {
      for (const entry of result) {
        const id = messageIdOf(entry)
        const chatId = chatIdOf(params, entry)
        if (id !== undefined && chatId !== undefined) messages.record(chatId, id, 'media')
      }
    } else if (method === 'deleteMessage') {
      const id = Number(params?.message_id)
      const chatId = chatIdOf(params, undefined)
      if (Number.isSafeInteger(id) && chatId !== undefined) messages.forget(chatId, id)
    }
    return result
  }
  return {
    call,
    ...(api.downloadFile === undefined ? {} : { downloadFile: (path: string) => api.downloadFile!(path) }),
  }
}

// --- arguments -----------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>

function textOfArg(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`message: укажи ${what}`)
  return value
}

/** Bot API: подпись к медиа — не длиннее 1024 символов. */
const MAX_CAPTION_CHARS = 1024

function captionOf(args: JsonObject): string | undefined {
  if (args.caption === undefined) return undefined
  if (typeof args.caption !== 'string') throw new Error('message: caption должен быть строкой')
  if (args.caption.length > MAX_CAPTION_CHARS) {
    throw new Error(
      `message: подпись длиннее ${MAX_CAPTION_CHARS} символов — это лимит Bot API для подписи к медиа`,
    )
  }
  return args.caption === '' ? undefined : args.caption
}

function messageIdOfArg(value: unknown, what: string): number {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`message: ${what} должен быть положительным id сообщения`)
  }
  return parsed
}

function optionalMessageId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return messageIdOfArg(value, 'reply_to')
}

/** Bot API 9.4+ colours of an inline button. */
const BUTTON_STYLES = ['success', 'primary', 'danger'] as const
type ButtonStyle = (typeof BUTTON_STYLES)[number]

/** Bot API: `copy_text.text` is 1–256 characters. */
const MAX_COPY_CHARS = 256

interface InlineButton {
  text: string
  url?: string
  callback_data?: string
  style?: ButtonStyle
  copy_text?: { text: string }
}

function styleOf(button: JsonObject, text: string): ButtonStyle | undefined {
  const style = button.style
  if (style === undefined) return undefined
  if (typeof style !== 'string' || !(BUTTON_STYLES as readonly string[]).includes(style)) {
    throw new Error(
      `message: style кнопки «${text}» должен быть одним из ${BUTTON_STYLES.join(', ')}, а не ${JSON.stringify(style)}`,
    )
  }
  return style as ButtonStyle
}

function copyOf(button: JsonObject): string | undefined {
  const copy = button.copy
  if (copy === undefined) return undefined
  if (typeof copy !== 'string') throw new Error('message: copy кнопки должен быть строкой')
  if (copy === '') throw new Error('message: copy кнопки не может быть пустым')
  if (copy.length > MAX_COPY_CHARS) {
    throw new Error(`message: copy кнопки длиннее ${MAX_COPY_CHARS} символов — это лимит Bot API`)
  }
  return copy
}

/**
 * Rows of buttons: a `copy` button copies its text and carries neither callback
 * data nor url; a url button keeps its url; anything else becomes a reply
 * button. `style` is passed through on every kind of button.
 */
function keyboardOf(value: unknown, buttons: ReplyButtonRegistry): InlineButton[][] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('message: buttons должны быть непустым массивом строк кнопок')
  }
  let total = 0
  const rows = value.map((rawRow): InlineButton[] => {
    if (!Array.isArray(rawRow) || rawRow.length === 0) {
      throw new Error('message: каждая строка buttons — непустой массив кнопок')
    }
    return rawRow.map((rawButton): InlineButton => {
      if (rawButton === null || typeof rawButton !== 'object' || Array.isArray(rawButton)) {
        throw new Error('message: кнопка должна быть объектом { text, url?, copy?, style? }')
      }
      const button = rawButton as JsonObject
      const text = typeof button.text === 'string' ? button.text : ''
      if (text.trim() === '') throw new Error('message: у каждой кнопки должен быть текст')
      total += 1
      const style = styleOf(button, text)
      const copy = copyOf(button)
      if (button.url !== undefined && copy !== undefined) {
        throw new Error(
          `message: кнопка «${text}» не может быть одновременно url и copy: оставь что-то одно из полей url и copy`,
        )
      }
      if (button.url !== undefined) {
        if (typeof button.url !== 'string' || !/^(?:https?|tg):\/\//i.test(button.url.trim())) {
          throw new Error(`message: url кнопки «${text}» должен начинаться с http://, https:// или tg://`)
        }
        return { text, url: button.url.trim(), ...(style === undefined ? {} : { style }) }
      }
      if (copy !== undefined) {
        return { text, copy_text: { text: copy }, ...(style === undefined ? {} : { style }) }
      }
      return { text, callback_data: buttons.create(text), ...(style === undefined ? {} : { style }) }
    })
  })
  if (total > 100) throw new Error('message: в клавиатуре не больше 100 кнопок')
  return rows
}

// --- media ---------------------------------------------------------------------------------------------

/** Album items are photos or videos; a GIF is an animation and is not part of an album. */
function albumKindOf(file: OutgoingFile): 'photo' | 'video' {
  const extension = extname(file.name).slice(1).toLowerCase()
  if (file.mime.startsWith('image/') && extension !== 'gif') return 'photo'
  if (isVideoName(file.name)) return 'video'
  throw new Error(`message: файл ${file.name} не фото и не видео, его нельзя положить в альбом`)
}

function isVideoName(name: string): boolean {
  const extension = extname(name).slice(1).toLowerCase()
  return mimeOfName(name).startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm', 'mkv'].includes(extension)
}

function isAnimationName(name: string): boolean {
  const extension = extname(name).slice(1).toLowerCase()
  return extension === 'gif' || isVideoName(name)
}

function readUpload(file: OutgoingFile): Uint8Array {
  const data = readFileSync(file.path)
  if (data.byteLength > MAX_SEND_BYTES) {
    throw new Error(`message: файл ${file.name} больше 50 МБ (лимит Bot API), отправка невозможна`)
  }
  return data
}

function requireMessageId(value: unknown, method: string): number {
  const id = messageIdOf(value)
  if (id === undefined) throw new Error(`message: Telegram не вернул message_id (${method})`)
  return id
}

function uploadOf(file: OutgoingFile): { name: string; data: Uint8Array; contentType: string } {
  return { name: file.name, data: readUpload(file), contentType: file.mime }
}

/**
 * Картинка внутри тела сообщения. Telegram рисует её только из вложенного
 * файла: разметка ссылается на него как `tg://photo?id=<id>`, а сам файл уходит
 * в `rich_message.media`. Внешний URL Telegram принимает молча и не рисует.
 */
const INLINE_PHOTO_MARKER = '[[фото]]'
const INLINE_PHOTO_ID = 'photo1'

function embeddedPhoto(
  deps: MessageToolDeps,
  raw: string,
  text: string,
): { markdown: string; media: { id: string; name: string; data: Uint8Array; contentType: string } } {
  const file = resolveOutgoingFile(deps.home, raw)
  if (albumKindOf(file) !== 'photo') {
    throw new Error(`message: ${file.name} не картинка — в тело сообщения вкладывается фото`)
  }
  const link = `![](tg://photo?id=${INLINE_PHOTO_ID})`
  const markdown = text.includes(INLINE_PHOTO_MARKER)
    ? text.split(INLINE_PHOTO_MARKER).join(link)
    : `${text}\n\n${link}`
  return { markdown, media: { id: INLINE_PHOTO_ID, ...uploadOf(file) } }
}

// --- the tool ------------------------------------------------------------------------------------------

export interface MessageToolDeps {
  /** `DSHBOT_HOME`; workspace paths resolve against it. */
  home: string
  api: TelegramApi
  /** Chat of the owner; `null` while the owner has not paired yet. */
  ownerChatId: () => number | null
  buttons: ReplyButtonRegistry
  messages: BotMessageRegistry
  log?: (text: string) => void
}

const ACTIONS = ['send', 'album', 'video', 'animation', 'edit', 'delete', 'pin', 'unpin'] as const

function ownerChat(deps: MessageToolDeps): number {
  const chatId = deps.ownerChatId()
  if (chatId === null) throw new Error('message: владелец ещё не подключён, отправлять некому')
  return chatId
}

/**
 * The `message` tool of the owner. It has no chat parameter on purpose: every
 * upload, edit and pin goes to the paired owner chat and nowhere else.
 */
/** The `message` tool: every action answers the model with a text line. */
export type MessageTool = Omit<RunnerTool, 'execute'> & {
  execute(args: Record<string, unknown>, context?: RunnerToolContext): Promise<string>
}

export function createMessageTool(deps: MessageToolDeps): MessageTool {
  return {
    name: 'message',
    description:
      'Отправить сообщение владельцу в его чат и управлять отправленными ботом сообщениями: текст с inline-кнопками ' +
      '(url, кнопки-ответы и кнопки копирования текста), альбом из 2–10 фото или видео, видео, GIF/анимация, ' +
      'ответ на сообщение по id, закреп/открепление, правка и удаление своих сообщений. У кнопки необязательны ' +
      'style (success, primary или danger) и copy (текст до 256 символов, который нажатие копирует в буфер ' +
      'владельца). Чата нет: всё уходит только владельцу.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'Что сделать: отправить текст/альбом/видео/анимацию, править, удалить, закрепить или открепить',
        },
        text: { type: 'string', description: 'Текст сообщения (send) или новый текст/подпись (edit)' },
        buttons: {
          type: 'array',
          description:
            'Кнопки send: строки по кнопкам. { text, url } — url-кнопка; { text, copy } — кнопка копирования ' +
            'copy в буфер владельца (без callback_data и url); { text } — кнопка-ответ, её текст придёт как ' +
            'сообщение владельца. У любой кнопки можно задать style — цвет: success, primary или danger',
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                url: { type: 'string' },
                copy: {
                  type: 'string',
                  maxLength: MAX_COPY_CHARS,
                  description: `Текст, который нажатие копирует в буфер владельца (copy_text); до ${MAX_COPY_CHARS} символов, не вместе с url`,
                },
                style: {
                  type: 'string',
                  enum: [...BUTTON_STYLES],
                  description: 'Цвет кнопки: success (зелёная), primary (основная), danger (красная)',
                },
              },
              required: ['text'],
            },
          },
        },
        reply_to: { type: 'number', description: 'id сообщения, ответом на которое отправить сообщение' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Пути 2–10 фото или видео внутри workspace (абсолютные или относительно DSHBOT_HOME/workspace)',
        },
        path: { type: 'string', description: 'Путь к видео или GIF/анимации внутри workspace' },
        photo: {
          type: 'string',
          description:
            'Путь к картинке внутри workspace: она уходит в тело того же rich-сообщения, одним сообщением. В text можно оставить маркер [[фото]] — картинка встанет на его место, иначе в конец',
        },
        caption: { type: 'string', description: 'Подпись к альбому, видео или анимации' },
        message_id: { type: 'number', description: 'id сообщения бота для edit/delete или любого сообщения для pin/unpin' },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>, _context?: RunnerToolContext): Promise<string> {
      const action = typeof args.action === 'string' ? args.action : ''
      const chatId = ownerChat(deps)
      const replyTo = optionalMessageId(args.reply_to)

      if (action === 'send') {
        const text = textOfArg(args.text, 'text сообщения')
        const keyboard = keyboardOf(args.buttons, deps.buttons)
        const photo = typeof args.photo === 'string' ? args.photo.trim() : ''
        const embedded = photo === '' ? undefined : embeddedPhoto(deps, photo, text)
        const ids = await sendFormatted(
          deps.api,
          chatId,
          normalizeMarkdownHardBreaks(embedded?.markdown ?? text),
          {
            ...(keyboard === undefined ? {} : { replyMarkup: { inline_keyboard: keyboard } }),
            ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }),
            ...(embedded === undefined ? {} : { media: [embedded.media] }),
          },
        )
        const messageId = ids[0]
        if (messageId === undefined) throw new Error('message: Telegram не вернул message_id (sendRichMessage)')
        deps.log?.(`message: send -> message_id ${messageId}`)
        return `Отправлено владельцу, message_id ${messageId}`
      }

      if (action === 'album') {
        if (!Array.isArray(args.paths)) throw new Error('message: для album укажи paths — 2–10 файлов workspace')
        if (args.paths.length < 2 || args.paths.length > 10) {
          throw new Error(`message: в альбоме должно быть от 2 до 10 файлов, а не ${args.paths.length}`)
        }
        // Подпись проверяется до чтения файлов и до любого запроса в Telegram.
        const caption = captionOf(args)
        const files = args.paths.map((raw) => {
          if (typeof raw !== 'string' || raw.trim() === '') throw new Error('message: путь файла альбома пуст')
          return resolveOutgoingFile(deps.home, raw)
        })
        const uploads: Record<string, { name: string; data: Uint8Array; contentType: string }> = {}
        const media = files.map((file, index) => {
          const type = albumKindOf(file)
          const field = `f${index}`
          uploads[field] = uploadOf(file)
          return {
            type,
            media: `attach://${field}`,
            ...(index === 0 && caption !== undefined ? { caption } : {}),
          }
        })
        const response = await deps.api.call<Array<{ message_id?: unknown }>>(
          'sendMediaGroup',
          {
            chat_id: chatId,
            media,
            ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
          },
          uploads,
        )
        const ids = (Array.isArray(response) ? response : []).map((entry) => messageIdOf(entry))
        const first = ids.find((id): id is number => id !== undefined)
        if (first === undefined) throw new Error('message: Telegram не вернул message_id (sendMediaGroup)')
        deps.log?.(`message: album ${files.length} -> message_id ${ids.join(', ')}`)
        return `Альбом из ${files.length} файлов отправлен владельцу, message_id ${first}`
      }

      if (action === 'video' || action === 'animation') {
        const raw = textOfArg(args.path, 'path файла')
        const file = resolveOutgoingFile(deps.home, raw)
        const animation = action === 'animation'
        if (animation && !isAnimationName(file.name)) {
          throw new Error(`message: ${file.name} не GIF и не видео, для анимации нужен GIF или mp4`)
        }
        if (!animation && !isVideoName(file.name)) {
          throw new Error(`message: ${file.name} не видео; для GIF используй action animation`)
        }
        const caption = captionOf(args)
        const method = animation ? 'sendAnimation' : 'sendVideo'
        const field = animation ? 'animation' : 'video'
        const response = await deps.api.call<{ message_id?: unknown }>(
          method,
          {
            chat_id: chatId,
            ...(caption === undefined ? {} : { caption }),
            ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
          },
          { [field]: uploadOf(file) },
        )
        const messageId = requireMessageId(response, method)
        deps.log?.(`message: ${action} ${file.name} -> message_id ${messageId}`)
        return `Отправлено: ${file.name}, message_id ${messageId} (${method})`
      }

      if (action === 'pin' || action === 'unpin') {
        const messageId = messageIdOfArg(args.message_id, 'message_id')
        const method = action === 'pin' ? 'pinChatMessage' : 'unpinChatMessage'
        await deps.api.call(method, { chat_id: chatId, message_id: messageId })
        return action === 'pin' ? `Сообщение ${messageId} закреплено` : `Сообщение ${messageId} откреплено`
      }

      if (action === 'edit') {
        const messageId = messageIdOfArg(args.message_id, 'message_id')
        const text = textOfArg(args.text, 'text правки')
        const kind = deps.messages.kindOf(chatId, messageId)
        if (kind === undefined) {
          throw new Error(`message: сообщение ${messageId} отправлял не бот, править его нельзя`)
        }
        if (kind === 'text') {
          await deps.api.call('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            rich_message: { markdown: normalizeMarkdownHardBreaks(text) },
          })
        } else {
          if (text.length > MAX_CAPTION_CHARS) {
            throw new Error(
              `message: подпись длиннее ${MAX_CAPTION_CHARS} символов — это лимит Bot API для подписи к медиа`,
            )
          }
          await deps.api.call('editMessageCaption', {
            chat_id: chatId,
            message_id: messageId,
            caption: text,
          })
        }
        deps.log?.(`message: edit ${messageId} -> ${kind === 'text' ? 'editMessageText' : 'editMessageCaption'}`)
        return `Сообщение ${messageId} изменено (${kind === 'text' ? 'editMessageText' : 'editMessageCaption'})`
      }

      if (action === 'delete') {
        const messageId = messageIdOfArg(args.message_id, 'message_id')
        if (deps.messages.kindOf(chatId, messageId) === undefined) {
          throw new Error(`message: сообщение ${messageId} отправлял не бот, удалить его нельзя`)
        }
        await deps.api.call('deleteMessage', { chat_id: chatId, message_id: messageId })
        deps.messages.forget(chatId, messageId)
        deps.log?.(`message: delete ${messageId}`)
        return `Сообщение ${messageId} удалено`
      }

      throw new Error(`message: неизвестное действие «${action}»; доступно: ${ACTIONS.join(', ')}`)
    },
  }
}
