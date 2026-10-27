// Voice and audio messages of the owner.
//
// Download, recognition and model download run as detached tasks: the ingress
// worker only starts them and immediately returns to long polling. The
// recognized text goes to the owner on one line first, then the same text starts
// an ordinary turn of `main` with the `[голосовое, распознано]:` marker.
//
// A guest never reaches this file: the caller filters guests before accepting a
// message, and the manager itself refuses anything that is not from the owner.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import type { TelegramApi } from '../../telegram/src/api.js'
import type { NormalizedAttachment, NormalizedMessage } from '../../telegram/src/update.js'
import {
  DEFAULT_VOICE_MAX_SECONDS,
  encodeOggOpus,
  isSpeechAttachmentKind,
  prepareSpokenText,
  recognizeAudio,
  synthesizeSpeech,
  VOICE_MARKER,
  VoiceError,
} from '../../voice/src/index.js'
import { deliverFile, resolveOutgoingFile } from './outgoing-files.js'

/** Bot API download limit; the same guard as ordinary attachments. */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024

/** Longest failure note shown in the chat; a stack trace is not a chat message. */
const MAX_REASON_CHARS = 300

/** How one voice message is handled: detached from the ingress worker. */
export interface VoiceMessageDeps {
  /** `DSHBOT_HOME`: model, workspace and the saved audio live here. */
  home: string
  api: TelegramApi
  /** `DSHBOT_VOICE_MAX_SECONDS`, default {@link DEFAULT_VOICE_MAX_SECONDS}. */
  maxSeconds?: number
  log: (text: string) => void
  /** Plain chat message, optionally as a reply to the original message. */
  send: (chatId: number, text: string, replyTo?: number, threadId?: number) => Promise<boolean>
  /** Start an ordinary `main` turn with the marker and the recognized text. */
  onRecognized: (message: NormalizedMessage, text: string) => void
  now?: () => number
}

export interface VoiceMessages {
  /** Starts a detached recognition for the speech attachments of the message. */
  accept(message: NormalizedMessage): void
  /** True when the message carries at least one speech attachment. */
  hasSpeech(message: NormalizedMessage): boolean
  /** Stops taking new work; running workers finish on their own or are discarded. */
  shutdown(): void
}

interface SavedAudio {
  path: string
}

function dateDirectory(now: number): string {
  const date = new Date(now)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function extensionOf(attachment: NormalizedAttachment): string {
  const nameExtension = extname(attachment.fileName ?? '').replace('.', '').toLowerCase()
  if (/^[a-z0-9]{1,5}$/.test(nameExtension)) return nameExtension
  const mime = String(attachment.mimeType ?? '').toLowerCase()
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('mp4') || mime.includes('m4a')) return attachment.kind === 'video_note' ? 'mp4' : 'm4a'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg'
  if (attachment.kind === 'voice') return 'ogg'
  if (attachment.kind === 'video_note') return 'mp4'
  return 'ogg'
}

/** One line, no line breaks: what the owner reads before the answer. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A single owner-facing error line: no line breaks, no runaway stack trace. */
function singleLine(text: string): string {
  const collapsed = oneLine(text)
  return collapsed.length > MAX_REASON_CHARS ? `${collapsed.slice(0, MAX_REASON_CHARS - 1)}…` : collapsed
}

export function createVoiceMessages(deps: VoiceMessageDeps): VoiceMessages {
  const now = deps.now ?? (() => Date.now())
  const maxSeconds =
    deps.maxSeconds !== undefined && Number.isFinite(deps.maxSeconds) && deps.maxSeconds > 0
      ? deps.maxSeconds
      : DEFAULT_VOICE_MAX_SECONDS
  const audioRoot = join(deps.home, 'workspace', 'voice')

  let closed = false
  let sequence = 0
  /** Stops running recognition workers when the daemon shuts down. */
  const controller = new AbortController()
  /** Voice messages are handled one after another, in the order the owner sent them. */
  let chain: Promise<void> = Promise.resolve()

  function refusal(reason: string): string {
    return `Не удалось распознать голосовое: ${singleLine(reason)}`
  }

  async function download(attachment: NormalizedAttachment, message: NormalizedMessage, index: number): Promise<SavedAudio> {
    if (deps.api.downloadFile === undefined) throw new VoiceError('клиент Telegram не умеет скачивать файлы')
    if (attachment.fileSize !== undefined && attachment.fileSize > MAX_VOICE_BYTES) {
      throw new VoiceError(`файл больше ${Math.round(MAX_VOICE_BYTES / (1024 * 1024))} МБ (лимит Bot API)`)
    }
    const info = await deps.api.call<{ file_path?: unknown }>('getFile', { file_id: attachment.fileId })
    const filePath = typeof info?.file_path === 'string' ? info.file_path : undefined
    if (filePath === undefined || filePath === '') throw new VoiceError('getFile не вернул file_path')
    const data = await deps.api.downloadFile(filePath)
    if (data.byteLength > MAX_VOICE_BYTES) {
      throw new VoiceError(`файл больше ${Math.round(MAX_VOICE_BYTES / (1024 * 1024))} МБ (лимит Bot API)`)
    }

    const directory = join(audioRoot, dateDirectory(now()))
    mkdirSync(directory, { recursive: true })
    const extension = extensionOf(attachment)
    const base = `${attachment.kind}-${message.messageId}-${index + 1}`
    let target = join(directory, `${base}.${extension}`)
    let suffix = 2
    while (existsSync(target)) {
      target = join(directory, `${base}-${suffix}.${extension}`)
      suffix += 1
    }
    writeFileSync(target, data, { flag: 'wx' })
    return { path: target }
  }

  async function handle(message: NormalizedMessage, speech: readonly NormalizedAttachment[]): Promise<void> {
    const recognized: string[] = []
    for (const [index, attachment] of speech.entries()) {
      if (closed) return
      try {
        const saved = await download(attachment, message, index)
        const text = await recognizeAudio({
          home: deps.home,
          filePath: saved.path,
          signal: controller.signal,
          ...(process.env.DSHBOT_VOICE_TEST_STUB === undefined || process.env.DSHBOT_VOICE_TEST_STUB === ''
            ? {}
            : { stubDir: process.env.DSHBOT_VOICE_TEST_STUB }),
          log: deps.log,
        })
        if (closed) return
        recognized.push(text)
        // The owner reads what was heard before the answer of the model starts.
        await deps.send(message.chatId, oneLine(text), message.messageId, message.threadId)
      } catch (error) {
        deps.log(
          `voice ${attachment.kind} of message ${message.messageId} was not recognized: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
        if (!closed) await deps.send(message.chatId, refusal(error instanceof Error ? error.message : String(error)), message.messageId, message.threadId)
      }
    }
    if (closed || recognized.length === 0) return
    deps.onRecognized(message, recognized.join('\n'))
  }

  function enqueue(run: () => Promise<void>): void {
    const task = chain.then(run, run).catch((error: unknown) => {
      deps.log(`voice task failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    chain = task
  }

  function hasSpeech(message: NormalizedMessage): boolean {
    return message.attachments.some((attachment) => isSpeechAttachmentKind(attachment.kind))
  }

  function accept(message: NormalizedMessage): void {
    if (closed) return
    const speech = message.attachments.filter((attachment) => isSpeechAttachmentKind(attachment.kind))
    if (speech.length === 0) return

    const allowed: NormalizedAttachment[] = []
    for (const attachment of speech) {
      if (attachment.duration !== undefined && attachment.duration > maxSeconds) {
        void deps.send(
          message.chatId,
          `Голосовое сообщение длиннее лимита ${maxSeconds} секунд, не распознаю.`,
          message.messageId,
          message.threadId,
        )
        continue
      }
      allowed.push(attachment)
    }
    if (allowed.length === 0) return
    sequence += 1
    const id = sequence
    enqueue(async () => {
      deps.log(`voice message ${message.messageId} (${id}) accepted: ${allowed.length} audio file(s)`)
      await handle(message, allowed)
    })
  }

  function shutdown(): void {
    closed = true
    controller.abort()
  }

  return { accept, hasSpeech, shutdown }
}

/** The model-facing text of a recognized voice message. */
export function voiceTurnText(text: string): string {
  return `${VOICE_MARKER} ${oneLine(text)}`
}

/**
 * Where an owner message came from. The spoken-answer decision of the `auto`
 * mode rests on this flag, never on the text: the marker is visible in the
 * payload and the owner may type it by hand, while only recognition sets this.
 */
export type TurnSource = 'text' | 'voice'

/** Prefix of the internal ingress id of a recognized voice turn. */
export const VOICE_TURN_EXTERNAL_ID_PREFIX = 'voice-'

/**
 * External id of the ingress row of a recognized voice turn. It is built here,
 * next to `voiceTurnText`, so both the marker and the source travel with the
 * row and no text of the owner can forge the source.
 */
export function voiceTurnExternalId(updateId: number, sequence: number, unique: string): string {
  return `${VOICE_TURN_EXTERNAL_ID_PREFIX}${updateId}-${sequence}-${unique}`
}

/** Whether an ingress row was produced by recognition of a voice recording. */
export function isVoiceTurnExternalId(externalId: string): boolean {
  return externalId.startsWith(VOICE_TURN_EXTERNAL_ID_PREFIX)
}

// --- spoken answers ------------------------------------------------------------------------------

/**
 * `auto` answers a voice message with a voice message and a text message with
 * text; `on` speaks every owner answer; `off` never speaks.
 */
export type VoiceMode = 'auto' | 'on' | 'off'

/** kv key of the owner's voice mode; survives the daemon restart. */
export const VOICE_MODE_KV_KEY = 'voice.mode'

/** A stored value outside the three modes is `auto`, never a silently wider mode. */
export function parseVoiceMode(raw: string | null | undefined): VoiceMode {
  const value = String(raw ?? '').trim().toLowerCase()
  return value === 'on' || value === 'off' ? value : 'auto'
}

/** The term after `/voice`, or null when the command carries none. */
export function voiceTermOf(text: string): string | null {
  const match = /^\/voice(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i.exec(text.trim())
  const rest = match?.[1]?.trim() ?? ''
  return rest === '' ? null : rest
}

/** The mode a `/voice` argument asks for; undefined for an unknown argument. */
export function resolveVoiceModeTerm(term: string | null): VoiceMode | undefined {
  if (term === null) return 'auto'
  const value = term.trim().toLowerCase()
  if (value === 'auto' || value === 'авто') return 'auto'
  if (value === 'on' || value === 'вкл' || value === 'включить') return 'on'
  if (value === 'off' || value === 'выкл' || value === 'выключить') return 'off'
  return undefined
}

/** The owner-facing confirmation of a new mode. */
export function voiceModeConfirmation(mode: VoiceMode): string {
  if (mode === 'on') return 'Голосовые ответы включены: отвечаю голосом на каждое сообщение владельца.'
  if (mode === 'off') return 'Голосовые ответы выключены: отвечаю только текстом.'
  return 'Голосовые ответы в режиме авто (auto): голосом на голосовое сообщение, текстом на текст.'
}

/** Whether an answer of this turn is spoken, given the mode and the kind of the incoming message. */
export function shouldSpeakAnswer(mode: VoiceMode, fromVoice: boolean): boolean {
  if (mode === 'off') return false
  return mode === 'on' || fromVoice
}

export interface VoiceReplyDeps {
  /** `DSHBOT_HOME`: the temporary OGG/Opus files live in `<home>/workspace/voice-replies`. */
  home: string
  api: TelegramApi
  /** The paired owner chat; `null` while the owner has not paired yet. */
  ownerChatId: () => number | null
  /** Read at answer time: `/voice` changes it between turns. */
  mode: () => VoiceMode
  log: (text: string) => void
}

export interface VoiceReplies {
  /**
   * Speaks the final answer of an owner turn as a detached task. A failure is
   * only a journal line: the text answer has already been delivered.
   */
  speak(answer: string, chatId: number, fromVoice: boolean): void
  /** Aborts running synthesis; the daemon is going down. */
  shutdown(): void
}

const TTS_STUB_ENV = 'DSHBOT_VOICE_TTS_TEST_STUB'

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Spoken answers of the owner. The text answer is sent by the ordinary turn
 * before this manager is called; synthesis, Opus encoding and `sendVoice` run
 * after it on their own time, so `/status` and the next turn are not blocked.
 */
export function createVoiceReplies(deps: VoiceReplyDeps): VoiceReplies {
  const controller = new AbortController()
  let closed = false
  let sequence = 0

  async function speakNow(answer: string, chatId: number, id: number): Promise<void> {
    const spoken = prepareSpokenText(answer)
    if (spoken === '') {
      deps.log(`voice reply ${id}: в ответе нет текста для озвучки`)
      return
    }
    const audio = await synthesizeSpeech({
      home: deps.home,
      text: spoken,
      signal: controller.signal,
      ...(process.env[TTS_STUB_ENV] === undefined || process.env[TTS_STUB_ENV] === ''
        ? {}
        : { stubDir: process.env[TTS_STUB_ENV] }),
      log: deps.log,
    })
    if (closed) return

    const directory = join(deps.home, 'workspace', 'voice-replies')
    mkdirSync(directory, { recursive: true })
    const target = join(directory, `reply-${id}-${Date.now()}.ogg`)
    try {
      await encodeOggOpus(audio.samples, audio.sampleRate, target)
      if (closed) return
      // The generated file lives inside the owner's workspace, so the same
      // resolver and upload path as `send_file` guard it.
      const file = resolveOutgoingFile(deps.home, target)
      const result = await deliverFile(deps.api, chatId, file, { as: 'voice' })
      deps.log(`voice reply ${id}: ${spoken.length} chars -> sendVoice, message_id ${result.messageId}`)
    } finally {
      try {
        unlinkSync(target)
      } catch {
        // Already gone.
      }
    }
  }

  function speak(answer: string, chatId: number, fromVoice: boolean): void {
    if (closed) return
    const owner = deps.ownerChatId()
    // A guest never gets a spoken answer, whatever mode the owner chose.
    if (owner === null || chatId !== owner) return
    if (!shouldSpeakAnswer(deps.mode(), fromVoice)) return
    const text = answer.trim()
    if (text === '') return
    sequence += 1
    const id = sequence
    void speakNow(text, chatId, id).catch((error: unknown) => {
      // One journal line naming the speech and the failure; the text answer
      // already reached the owner and the daemon keeps serving turns.
      deps.log(`voice reply ${id}: озвучивание ответа не удалось: ${failureText(error)}`)
    })
  }

  function shutdown(): void {
    closed = true
    controller.abort()
  }

  return { speak, shutdown }
}
