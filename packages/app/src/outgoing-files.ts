// Files the owner asks for: one resolver of a workspace path and one upload
// path shared by every lane that may send a file (main, a task session, a
// planned turn and the analysis of attachments).
//
// The resolver is the only gate between the model and the owner's disk: a path
// is accepted only when its real target lies inside `DSHBOT_HOME/workspace`, so
// `..`, an absolute path elsewhere and a symlink that leaves the tree are all
// refused before any byte is read. Inbox directories of attachment analyses are
// private to their intake and are refused as well.
//
// The upload is one Bot API multipart call: sendDocument / sendPhoto /
// sendAudio / sendVoice into the owner chat, the file part named after the
// method, the file name kept and the bytes unchanged.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { RunnerTool, RunnerToolContext } from '../../runner/src/index.js'
import type { TelegramApi } from '../../telegram/src/api.js'

/** Bot API upload limit for a file sent by a bot. */
export const MAX_SEND_BYTES = 50 * 1024 * 1024
/** Bot API limit for a media caption, in characters. */
export const MAX_CAPTION_CHARS = 1024

export type SendMode = 'document' | 'photo' | 'audio' | 'voice'

export interface OutgoingFile {
  /** Real path of the file (symlinks resolved). */
  path: string
  /** File name kept in the upload. */
  name: string
  /** Size in bytes. */
  size: number
  mime: string
}

export interface SendFileOptions {
  caption?: string
  /** Overrides the method chosen from the MIME type. */
  as?: SendMode
  /** Message the upload replies to. */
  replyTo?: number
}

export interface DeliverResult {
  messageId: number
  method: string
}

export interface ResolveOutgoingOptions {
  /**
   * Paths of the inbox that this call may take: the files of one analysis.
   * Every other file under `workspace/inbox` belongs to another intake.
   */
  allowInbox?: readonly string[]
}

export interface SendFileToolDeps {
  /** `DSHBOT_HOME`. */
  home: string
  api: TelegramApi
  /** Chat of the owner; `null` while the owner has not paired yet. */
  ownerChatId: () => number | null
  log?: (text: string) => void
}

const MODES: Record<SendMode, { method: string; field: string }> = {
  document: { method: 'sendDocument', field: 'document' },
  photo: { method: 'sendPhoto', field: 'photo' },
  audio: { method: 'sendAudio', field: 'audio' },
  voice: { method: 'sendVoice', field: 'voice' },
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
}

/** MIME type from the file name; unknown extensions are uploaded as binary data. */
export function mimeOfName(name: string): string {
  const extension = extname(name).slice(1).toLowerCase()
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? (MIME_BY_EXTENSION[extension] as string) : 'application/octet-stream'
}

/** Whether the file goes as a photo by default: an image, and nothing else. */
export function isImageName(name: string): boolean {
  return mimeOfName(name).startsWith('image/')
}

/** Whether `candidate` is `root` itself or lies below it; `..` cannot pass this check. */
function within(root: string, candidate: string): boolean {
  const inside = relative(root, candidate)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** A name that is not a path component: the upload keeps only the leaf. */
function leafName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? 'file'
}

/**
 * Resolve a model-supplied path to a file of the owner's workspace.
 *
 * `raw` may be absolute or relative to `DSHBOT_HOME/workspace`; a `..` segment
 * is refused outright before anything is resolved. The real target (after
 * symlinks) must stay inside the real workspace; the inbox is
 * refused unless the path is one of `allowInbox` (the own files of the
 * analysis that asked); the size is checked before the file is read.
 */
export function resolveOutgoingFile(
  home: string,
  raw: string,
  options: ResolveOutgoingOptions = {},
): OutgoingFile {
  const wanted = raw.trim()
  if (wanted === '') throw new Error('send_file: пустой путь')
  if (wanted.includes('\u0000')) throw new Error('send_file: путь содержит недопустимый символ')
  // `..` is refused as a segment in the supplied path, even when the target
  // would still land inside the workspace after normalization: a relative
  // detour is never a file the owner asked for. Checked before resolve/realpath.
  if (wanted.split(/[/\\]+/).includes('..')) {
    throw new Error('send_file: путь с «..» запрещён, укажи файл внутри workspace напрямую')
  }

  const workspace = join(home, 'workspace')
  const realWorkspace = realOrUndefined(workspace)
  if (realWorkspace === undefined) throw new Error('send_file: рабочая папка workspace не найдена')

  const absolute = isAbsolute(wanted) ? resolve(wanted) : resolve(workspace, wanted)
  const realTarget = realOrUndefined(absolute)
  if (realTarget === undefined) {
    throw new Error(`send_file: файл не найден: ${absolute}`)
  }
  if (!within(realWorkspace, realTarget)) {
    throw new Error('send_file: путь вне workspace владельца запрещён (симлинки наружу и .. не проходят)')
  }

  const inbox = realOrUndefined(join(workspace, 'inbox'))
  if (inbox !== undefined && within(inbox, realTarget)) {
    const allowed = new Set(
      (options.allowInbox ?? [])
        .map((path) => realOrUndefined(path))
        .filter((path): path is string => path !== undefined),
    )
    if (!allowed.has(realTarget)) {
      throw new Error('send_file: inbox разбора вложений доступен только своему разбору, чужой inbox запрещён')
    }
  }

  // Secrets that may live in the workspace too: never upload an environment file.
  if (/(^|[/\\])\.env(?:\.[^/\\]+)?$/i.test(realTarget)) {
    throw new Error('send_file: файлы с секретами (.env) не отправляются')
  }

  let status: ReturnType<typeof statSync>
  try {
    status = statSync(realTarget)
  } catch {
    throw new Error(`send_file: файл не найден: ${absolute}`)
  }
  if (!status.isFile()) throw new Error(`send_file: это не файл: ${leafName(realTarget)}`)
  if (status.size > MAX_SEND_BYTES) {
    throw new Error(
      `send_file: файл ${leafName(realTarget)} больше 50 МБ (лимит Bot API), отправка невозможна`,
    )
  }

  return {
    path: realTarget,
    name: leafName(realTarget),
    size: status.size,
    mime: mimeOfName(realTarget),
  }
}

/** The upload method of a file: explicit `as`, otherwise image -> photo, else document. */
export function methodOf(file: OutgoingFile, as: SendMode | undefined): SendMode {
  if (as !== undefined) {
    if (!Object.hasOwn(MODES, as)) throw new Error(`send_file: неизвестный вид отправки "${String(as)}"`)
    return as
  }
  return isImageName(file.name) ? 'photo' : 'document'
}

/**
 * Send one resolved file into `chatId` and return the id of the message. The
 * bytes are read here, once, and handed to the Bot API unchanged.
 */
export async function deliverFile(
  api: TelegramApi,
  chatId: number,
  file: OutgoingFile,
  options: SendFileOptions = {},
): Promise<DeliverResult> {
  const mode = methodOf(file, options.as)
  const spec = MODES[mode]
  const caption = typeof options.caption === 'string' ? options.caption : undefined
  // Подпись проверяется до чтения файла и до запроса в Telegram.
  if (caption !== undefined && caption.length > MAX_CAPTION_CHARS) {
    throw new Error(
      `send_file: подпись длиннее ${MAX_CAPTION_CHARS} символов — это лимит Bot API для подписи к медиа`,
    )
  }
  const data = readFileSync(file.path)
  if (data.byteLength > MAX_SEND_BYTES) {
    throw new Error(`send_file: файл ${file.name} больше 50 МБ (лимит Bot API), отправка невозможна`)
  }
  const response = await api.call<{ message_id?: unknown }>(
    spec.method,
    {
      chat_id: chatId,
      ...(caption === undefined || caption === '' ? {} : { caption }),
      ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
    },
    { [spec.field]: { name: file.name, data, contentType: file.mime } },
  )
  const messageId = typeof response?.message_id === 'number' ? response.message_id : undefined
  if (messageId === undefined) throw new Error(`send_file: Telegram не вернул message_id (${spec.method})`)
  return { messageId, method: spec.method }
}

/**
 * The `send_file` tool of the owner. One instance is registered for every owner
 * lane: main, a task session, a planned turn and an analysis of attachments.
 * The upload always goes to the owner chat, never to the chat of a guest.
 */
export function createSendFileTool(deps: SendFileToolDeps): RunnerTool {
  return {
    name: 'send_file',
    description:
      'Отправить владельцу файл из workspace вложением в чат: документ, фото, аудио или голосовое. ' +
      'Используй, когда владелец просит «пришли файлом», «пришли PNG/PDF/CSV». Путь — внутри workspace ' +
      '(например, outbox или downloads). Имя файла сохраняется, файл уходит байт в байт. Ответ содержит message_id и размер.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Путь к файлу внутри workspace: абсолютный или относительно DSHBOT_HOME/workspace',
        },
        caption: { type: 'string', description: 'Подпись к файлу в чате владельца' },
        as: {
          type: 'string',
          enum: ['document', 'photo', 'audio', 'voice'],
          description: 'Вид отправки; по умолчанию картинки — фото, остальное — документ',
        },
      },
      required: ['path'],
    },
    async execute(args: Record<string, unknown>, _context?: RunnerToolContext): Promise<string> {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      if (rawPath.trim() === '') throw new Error('send_file: укажи path файла внутри workspace')
      const file = resolveOutgoingFile(deps.home, rawPath)
      const chatId = deps.ownerChatId()
      if (chatId === null) throw new Error('send_file: владелец ещё не подключён, отправить файл некому')
      const as = typeof args.as === 'string' ? (args.as as SendMode) : undefined
      const result = await deliverFile(deps.api, chatId, file, {
        ...(typeof args.caption === 'string' ? { caption: args.caption } : {}),
        ...(as === undefined ? {} : { as }),
      })
      deps.log?.(`send_file: ${file.name} (${file.size} байт) -> ${result.method}, message_id ${result.messageId}`)
      return `Отправлено: ${file.name}, ${file.size} байт, message_id ${result.messageId} (${result.method})`
    },
  }
}
