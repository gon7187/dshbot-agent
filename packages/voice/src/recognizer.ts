// Recognition of one downloaded audio file.
//
// Decoding and inference run in a worker thread: a CPU-bound model must never
// hold the loop that long-polls Telegram. The worker also carries the test
// stand-in (`DSHBOT_VOICE_TEST_STUB`), which replaces decoding and inference
// without touching the model files or the network.

import { Worker } from 'node:worker_threads'

import { ensureModel, pinSpeechAddon, VoiceError } from './model.js'

/** Longest wait for one worker; a 300 second recording may take minutes on a small CPU. */
export const RECOGNITION_TIMEOUT_MS = 15 * 60_000

export interface RecognizerOptions {
  /** `DSHBOT_HOME`; the model lives in `<home>/models`. */
  home: string
  /** Saved audio file, exactly as Telegram served it. */
  filePath: string
  /** `DSHBOT_VOICE_TEST_STUB` from the environment. */
  stubDir?: string
  /** Aborts the worker (daemon shutdown). */
  signal?: AbortSignal
  log?: (text: string) => void
}

interface WorkerMessage {
  ok?: unknown
  text?: unknown
  error?: unknown
}

/**
 * Recognizes the speech of `filePath` and returns plain text. Every failure is
 * a {@link VoiceError} with a reason the caller may show to the owner.
 */
export async function recognizeAudio(options: RecognizerOptions): Promise<string> {
  if (options.signal?.aborted ?? false) throw new VoiceError('распознавание отменено')
  const stubDir = options.stubDir?.trim()
  const stub = stubDir === undefined || stubDir === '' ? undefined : stubDir

  let model: { encoder: string; decoder: string; tokens: string } | undefined
  if (stub === undefined) {
    model = await ensureModel({
      home: options.home,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    })
    pinSpeechAddon()
  }

  const workerData = {
    filePath: options.filePath,
    ...(stub === undefined ? {} : { stubDir: stub }),
    ...(model === undefined ? {} : { model }),
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => finish(new VoiceError('распознавание отменено'))
    const finish = (error: VoiceError | undefined, text?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate().catch(() => undefined)
      if (error === undefined) resolve(text ?? '')
      else reject(error)
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./recognizer-worker.mjs', import.meta.url), {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
      })
    } catch (error) {
      reject(new VoiceError(`распознавание не запустилось: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const timer = setTimeout(() => {
      finish(new VoiceError(`распознавание не уложилось в ${Math.round(RECOGNITION_TIMEOUT_MS / 60_000)} минут`))
    }, RECOGNITION_TIMEOUT_MS)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.once('message', (message: unknown) => {
      const value = message !== null && typeof message === 'object' ? (message as WorkerMessage) : {}
      if (value.ok === true && typeof value.text === 'string') {
        const text = value.text.replace(/\s+/g, ' ').trim()
        if (text === '') finish(new VoiceError('речь не распознана: пустой текст'))
        else finish(undefined, text)
        return
      }
      const reason = typeof value.error === 'string' && value.error !== '' ? value.error : 'неизвестная ошибка'
      finish(new VoiceError(reason))
    })
    worker.once('error', (error: unknown) => {
      finish(new VoiceError(error instanceof Error ? error.message : String(error)))
    })
    worker.once('exit', (code) => {
      if (!settled) finish(new VoiceError(`распознавание завершилось с кодом ${code}`))
    })
  })
}
