// Local speech recognition for the owner's voice messages.
//
// The audio never leaves the machine: Telegram serves the file, the bytes are
// saved under `DSHBOT_HOME/workspace/voice`, and the pinned Whisper small model
// runs in a worker of the daemon. The model lives in `DSHBOT_HOME/models` and is
// downloaded only once, from a pinned commit, with a size and SHA-256 check.

export {
  ensureModel,
  MODEL_DIRECTORY,
  MODEL_FILES,
  MODEL_HOSTS,
  MODEL_REPOSITORY,
  MODEL_REVISION,
  VoiceError,
  type ModelFilePin,
  type ModelPaths,
} from './model.js'
export { recognizeAudio, RECOGNITION_TIMEOUT_MS, type RecognizerOptions } from './recognizer.js'
export { prepareSpokenText, SPEECH_TEXT_LIMIT } from './spoken-text.js'
export { synthesizeSpeech, SYNTHESIS_TIMEOUT_MS, type SynthesizedAudio, type SynthesisOptions } from './tts.js'
export {
  ensureTtsModel,
  resetTtsModelCache,
  TTS_DIRECTORY,
  TTS_MODEL_FILE,
  TTS_MODEL_HOSTS,
  TTS_MODEL_SHA256,
  TTS_MODEL_SIZE,
  TTS_REPOSITORY,
  TTS_REVISION,
  TTS_TOKENS_FILE,
  type EnsureTtsOptions,
  type TtsModelPaths,
} from './tts-model.js'
export { encodeOggOpus, type EncodeOggOpusOptions } from './opus.mjs'


/** Marker the recognized voice message carries into the ordinary turn of `main`. */
export const VOICE_MARKER = '[голосовое, распознано]:'

/** Longest audio the owner may send, in seconds, when `DSHBOT_VOICE_MAX_SECONDS` is unset. */
export const DEFAULT_VOICE_MAX_SECONDS = 300

/** Attachment kinds that are recognized as speech. */
export const SPEECH_ATTACHMENT_KINDS = ['voice', 'audio', 'video_note'] as const

export type SpeechAttachmentKind = (typeof SPEECH_ATTACHMENT_KINDS)[number]

/** Whether a Telegram attachment is audio that the voice pipeline should take. */
export function isSpeechAttachmentKind(kind: string): kind is SpeechAttachmentKind {
  return (SPEECH_ATTACHMENT_KINDS as readonly string[]).includes(kind)
}
