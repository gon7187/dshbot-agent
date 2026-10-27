// Synthesis of one spoken answer.
//
// The model is resolved here (the download belongs to the first spoken answer,
// not to the start of the daemon) and the CPU-bound inference runs in a worker
// thread, so a long synthesis cannot hold the loop that long-polls Telegram.
// The worker also carries the test stand-in (`DSHBOT_VOICE_TTS_TEST_STUB`): it
// records the text and returns silence without touching the model or network.

import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'

import { pinSpeechAddon, VoiceError } from './model.js'
import { parseTokenTable, piperGenerateRequest, piperTtsConfig, type PiperRequest } from './tts-config.js'
import { ensureTtsModel } from './tts-model.js'

/** Longest wait for one synthesis; the owner's answer text is at most 600 characters. */
export const SYNTHESIS_TIMEOUT_MS = 5 * 60_000

export interface SynthesizedAudio {
  samples: Float32Array
  sampleRate: number
}

export interface SynthesisOptions {
  /** `DSHBOT_HOME`; the voice lives in `<home>/models`. */
  home: string
  /** The prepared text to speak (already cleaned and truncated). */
  text: string
  /** `DSHBOT_VOICE_TTS_TEST_STUB` from the environment. */
  stubDir?: string
  /** Aborts the worker (daemon shutdown). */
  signal?: AbortSignal
  log?: (text: string) => void
}

interface WorkerMessage {
  ok?: unknown
  samples?: unknown
  sampleRate?: unknown
  error?: unknown
}

/**
 * Speaks `text` and returns mono samples. Every failure is a {@link VoiceError}
 * with a reason; the caller keeps the ordinary text answer.
 */
export async function synthesizeSpeech(options: SynthesisOptions): Promise<SynthesizedAudio> {
  if (options.signal?.aborted ?? false) throw new VoiceError('синтез отменён')
  const stubDir = options.stubDir?.trim()
  const stub = stubDir === undefined || stubDir === '' ? undefined : stubDir
  const text = options.text.trim()
  if (text === '') throw new VoiceError('нет текста для синтеза')

  let synthesis: { config: Record<string, unknown>; request: PiperRequest } | undefined
  if (stub === undefined) {
    const model = await ensureTtsModel({
      home: options.home,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    const table = parseTokenTable(await readFile(model.tokens, 'utf8'))
    synthesis = { config: piperTtsConfig(model), request: piperGenerateRequest(text, table) }
    pinSpeechAddon()
  }

  return await new Promise<SynthesizedAudio>((resolve, reject) => {
    let settled = false
    let worker: Worker | undefined
    const finish = (error: VoiceError | undefined, audio?: SynthesizedAudio): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker?.terminate().catch(() => undefined)
      if (error === undefined) resolve(audio as SynthesizedAudio)
      else reject(error)
    }
    const onAbort = (): void => finish(new VoiceError('синтез отменён'))
    try {
      worker = new Worker(new URL('./tts-worker.mjs', import.meta.url), {
        workerData: {
          text,
          ...(stub === undefined ? {} : { stubDir: stub }),
          ...(synthesis === undefined ? {} : { synthesis }),
        },
        resourceLimits: { maxOldGenerationSizeMb: 1024, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      })
    } catch (error) {
      reject(new VoiceError(`синтез не запустился: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const timer = setTimeout(() => {
      finish(new VoiceError(`синтез не уложился в ${Math.round(SYNTHESIS_TIMEOUT_MS / 60_000)} минут`))
    }, SYNTHESIS_TIMEOUT_MS)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: unknown) => {
      const value = message !== null && typeof message === 'object' ? (message as WorkerMessage) : {}
      if (value.ok === true && value.samples instanceof Float32Array && value.samples.length > 0) {
        const sampleRate = typeof value.sampleRate === 'number' && value.sampleRate > 0 ? value.sampleRate : 0
        if (sampleRate === 0) {
          finish(new VoiceError('синтез вернул звук без частоты дискретизации'))
          return
        }
        finish(undefined, { samples: value.samples, sampleRate })
        return
      }
      const reason = typeof value.error === 'string' && value.error !== '' ? value.error : 'неизвестная ошибка'
      finish(new VoiceError(reason))
    })
    worker.once('error', (error: unknown) => {
      finish(new VoiceError(error instanceof Error ? error.message : String(error)))
    })
    worker.once('exit', (code) => {
      if (!settled) finish(new VoiceError(`синтез завершился с кодом ${code}`))
    })
  })
}
