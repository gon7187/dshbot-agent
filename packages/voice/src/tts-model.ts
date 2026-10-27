// The speech synthesis model of the daemon: one pinned export of a Russian
// Piper voice in ONNX, kept in its own subdirectory of `DSHBOT_HOME/models`.
//
// The weights are trusted by size and SHA-256 only: the download URL names a
// commit, a file with any other bytes is deleted, and the mirror is a fallback
// for network failures, never a reason to accept other bytes. The model is
// fetched on the first spoken answer, not at the start of the daemon.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { VoiceError } from './model.js'
import { parseTokenTable, tokenTableProblem } from './tts-config.js'

/** Repository of the pinned Russian voice. */
export const TTS_REPOSITORY = 'csukuangfj/vits-piper-ru_RU-irina-medium'

/** Commit of the export; `main` would silently move the weights. */
export const TTS_REVISION = 'b095bed45c39813266edf14ffa2bade5ebfc929c'

/** Directory under `DSHBOT_HOME/models` that holds the voice. */
export const TTS_DIRECTORY = 'tts-vits-piper-ru_RU-irina-medium'

/** The pinned weights and their token table. */
export const TTS_MODEL_FILE = 'ru_RU-irina-medium.onnx'
export const TTS_TOKENS_FILE = 'tokens.txt'

/** Size and SHA-256 of the weights, checked outside the sandbox by the owner. */
export const TTS_MODEL_SIZE = 63_201_422
export const TTS_MODEL_SHA256 = 'c88536aaa9d823b20d1225e19759553bff546bc09cbf186d9d40919665be03bc'

/** Hosts the voice may come from; the mirror is tried when the first one fails. */
export const TTS_MODEL_HOSTS: readonly string[] = ['https://huggingface.co', 'https://hf-mirror.com']

export interface TtsModelPaths {
  model: string
  tokens: string
}

export interface EnsureTtsOptions {
  /** `DSHBOT_HOME`; the voice lives in `<home>/models/<TTS_DIRECTORY>`. */
  home: string
  log?: (text: string) => void
  signal?: AbortSignal
}

/** Verified model paths of one daemon home; a successful check is not repeated. */
const verified = new Map<string, TtsModelPaths>()

/** One download at a time per directory: two answers may need the voice together. */
const inFlight = new Map<string, Promise<TtsModelPaths>>()

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // Already gone is the state we want.
  }
}

async function matchesModelPin(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size !== TTS_MODEL_SIZE) return false
    return (await sha256Of(path)) === TTS_MODEL_SHA256
  } catch {
    return false
  }
}

function modelUrl(host: string, name: string): string {
  return `${host}/${TTS_REPOSITORY}/resolve/${TTS_REVISION}/${name}`
}

interface DownloadResult {
  bytes: number
  sha256: string
}

/** Streams one response to `target`, hashing on the way. */
async function saveResponse(response: Response, target: string): Promise<DownloadResult> {
  if (response.body === null) throw new VoiceError('сервер не прислал тело файла голосовой модели')
  let bytes = 0
  const hash = createHash('sha256')
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target))
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Downloads one file of the voice through the global `fetch`. The pitfall of a
 * crash is handled by a temporary name that is not the name of any pinned file.
 */
async function downloadFile(
  directory: string,
  name: string,
  log: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const target = join(directory, name)
  const temporary = join(directory, `.download-${name}`)
  let lastError: unknown
  for (const host of TTS_MODEL_HOSTS) {
    if (signal?.aborted ?? false) throw new VoiceError('загрузка модели синтеза отменена')
    const url = modelUrl(host, name)
    log(`tts model: downloading ${name} from ${host}`)
    try {
      const timeout = AbortSignal.timeout(10 * 60_000)
      const response = await fetch(url, {
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new VoiceError(`сервер модели ответил ${response.status}`)
      }
      const saved = await saveResponse(response, temporary)
      if (name === TTS_MODEL_FILE && (saved.bytes !== TTS_MODEL_SIZE || saved.sha256 !== TTS_MODEL_SHA256)) {
        await removeQuietly(temporary)
        throw new VoiceError(
          `файл ${TTS_MODEL_FILE} не совпал с закреплённым: ожидалось ${TTS_MODEL_SIZE} байт и SHA-256 ` +
            `${TTS_MODEL_SHA256}, получено ${saved.bytes} байт и SHA-256 ${saved.sha256}`,
        )
      }
      if (name === TTS_TOKENS_FILE && saved.bytes < 200) {
        await removeQuietly(temporary)
        throw new VoiceError(`файл ${TTS_TOKENS_FILE} слишком мал (${saved.bytes} байт) для таблицы токенов`)
      }
      await rename(temporary, target)
      return target
    } catch (error) {
      await removeQuietly(temporary)
      if (signal?.aborted ?? false) throw new VoiceError('загрузка модели синтеза отменена')
      // Wrong bytes are never a reason to ask another host: the mirror serves
      // the same commit, and the pinned digest is final.
      if (error instanceof VoiceError && /не совпал|слишком мал/.test(error.message)) throw error
      lastError = error
      log(`tts model: ${host} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new VoiceError(`нет сети для загрузки модели синтеза речи с huggingface.co и hf-mirror.com: ${detail}`)
}

/**
 * The token table comes from the same pinned commit as the weights; it is
 * accepted only when it is the Piper table with the Russian phonemes the
 * phonemizer writes, else it is downloaded again or the voice is refused.
 */
async function usableTokens(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size < 200 || info.size > 64 * 1024) return false
    return tokenTableProblem(parseTokenTable(await readFile(path, 'utf8'))) === undefined
  } catch {
    return false
  }
}

/**
 * Finds the pinned voice under `<home>/models/<TTS_DIRECTORY>`, checking the
 * weights and downloading what is missing. Throws {@link VoiceError} with a
 * reason; a failure leaves no accepted model behind and the daemon keeps going.
 */
export async function ensureTtsModel(options: EnsureTtsOptions): Promise<TtsModelPaths> {
  const directory = join(options.home, 'models', TTS_DIRECTORY)
  const cached = verified.get(directory)
  if (cached !== undefined) return cached
  const running = inFlight.get(directory)
  if (running !== undefined) return await running
  const task = loadTtsModel(options, directory).finally(() => {
    inFlight.delete(directory)
  })
  inFlight.set(directory, task)
  return await task
}

async function loadTtsModel(options: EnsureTtsOptions, directory: string): Promise<TtsModelPaths> {
  const log = options.log ?? (() => undefined)
  if (options.signal?.aborted ?? false) throw new VoiceError('загрузка модели синтеза отменена')

  await mkdir(directory, { recursive: true })
  const modelPath = join(directory, TTS_MODEL_FILE)
  const tokensPath = join(directory, TTS_TOKENS_FILE)

  if (!(await matchesModelPin(modelPath))) {
    if (await stat(modelPath).then(() => true, () => false)) {
      log(`tts model: ${modelPath} does not match the pin, deleting`)
      await removeQuietly(modelPath)
    }
    // A stale part of an interrupted download is never accepted.
    await removeQuietly(join(directory, `.download-${TTS_MODEL_FILE}`))
    await downloadFile(directory, TTS_MODEL_FILE, log, options.signal)
  }
  if (!(await usableTokens(tokensPath))) {
    await removeQuietly(tokensPath)
    await downloadFile(directory, TTS_TOKENS_FILE, log, options.signal)
    if (!(await usableTokens(tokensPath))) {
      const problem = tokenTableProblem(parseTokenTable(await readFile(tokensPath, 'utf8').catch(() => '')))
      await removeQuietly(tokensPath)
      throw new VoiceError(`файл ${TTS_TOKENS_FILE} не похож на таблицу фонем русского голоса Piper: ${problem ?? 'размер'}`)
    }
  }

  if (!(await matchesModelPin(modelPath))) {
    throw new VoiceError('модель синтеза не прошла проверку после загрузки')
  }
  const result: TtsModelPaths = { model: modelPath, tokens: tokensPath }
  verified.set(directory, result)
  return result
}

/** Test seam: drops the in-process cache so a test can repeat the check. */
export function resetTtsModelCache(): void {
  verified.clear()
  inFlight.clear()
}

