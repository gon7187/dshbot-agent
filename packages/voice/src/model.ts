// The speech model of the daemon: one pinned export of Whisper small in ONNX,
// kept under `DSHBOT_HOME/models` and checked against constants in this file.
//
// Nothing here trusts the server: the download URL names a commit, and every
// file is compared with its own size and SHA-256 before it may be used. A file
// that does not match is deleted, so a broken mirror or an injected proxy
// cannot leave a model behind. The numbers were checked by the owner outside
// the sandbox (the encoder was downloaded and compared).

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Repository of the pinned export. */
export const MODEL_REPOSITORY = 'csukuangfj/sherpa-onnx-whisper-small'

/** Commit of the export; downloading `main` would silently move the weights. */
export const MODEL_REVISION = '8f3c18b358db4d1f2fc1eae49d75cd20989e4309'

/** Directory under `DSHBOT_HOME` that holds the model. */
export const MODEL_DIRECTORY = 'models'

export interface ModelFilePin {
  name: string
  size: number
  sha256: string
}

/**
 * The three files the recognizer needs. Sizes and hashes are literals, not a
 * digest of the server response and not a manifest next to the files.
 */
export const MODEL_FILES: readonly ModelFilePin[] = [
  {
    name: 'small-encoder.int8.onnx',
    size: 112442483,
    sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9',
  },
  {
    name: 'small-decoder.int8.onnx',
    size: 262226114,
    sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee',
  },
  {
    name: 'small-tokens.txt',
    size: 816730,
    sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
  },
]

/** Hosts the model may come from; the mirror is tried when the first one fails. */
export const MODEL_HOSTS: readonly string[] = ['https://huggingface.co', 'https://hf-mirror.com']

/** A speech failure with a text that can be shown to the owner. */
export class VoiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoiceError'
  }
}

let sherpaPinned = false

/**
 * Keeps the native speech addon loaded in the main thread. Every recognition and
 * synthesis runs in a fresh worker; when the only holder of the addon exits, Node
 * closes the library, and on arm64 the next worker then fails with "Module did
 * not self-register" (the library stays mapped, its registration does not run
 * again). One load here keeps it open for the life of the process. A missing
 * addon is left for the worker to report.
 */
export function pinSpeechAddon(): void {
  if (sherpaPinned) return
  sherpaPinned = true
  try {
    createRequire(import.meta.url)('sherpa-onnx-node')
  } catch {
    // The worker repeats the load and reports the reason.
  }
}

export interface ModelPaths {
  encoder: string
  decoder: string
  tokens: string
}

interface FoundFile {
  path: string
  size: number
}

/** Recursively finds files by name, ignoring symlinks and unreadable entries. */
async function findFiles(directory: string, depth = 0): Promise<FoundFile[]> {
  if (depth > 4) return []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const found: FoundFile[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      found.push(...(await findFiles(path, depth + 1)))
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(path)
      found.push({ path, size: info.size })
    } catch {
      // A file that vanished between readdir and stat is simply absent.
    }
  }
  return found
}

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

/** A file is usable only when both its size and its digest match the pins. */
async function matchesPin(path: string, pin: ModelFilePin): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size !== pin.size) return false
    return (await sha256Of(path)) === pin.sha256
  } catch {
    return false
  }
}

function modelUrl(host: string, name: string): string {
  return `${host}/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${name}`
}

interface DownloadResult {
  bytes: number
  sha256: string
}

/** Streams one response to `target`, hashing on the way without buffering the model. */
async function saveResponse(response: Response, target: string): Promise<DownloadResult> {
  if (response.body === null) throw new VoiceError('сервер не прислал тело файла модели')
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
 * Downloads one model file through the global `fetch` and verifies it. The
 * temporary suffix is never a name from the pin, so a crash leaves no file the
 * recognizer would accept.
 */
async function downloadFile(
  modelsDir: string,
  pin: ModelFilePin,
  log: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const target = join(modelsDir, pin.name)
  const temporary = `${target}.part`
  let lastError: unknown
  for (const host of MODEL_HOSTS) {
    if (signal?.aborted ?? false) throw new VoiceError('загрузка модели отменена')
    const url = modelUrl(host, pin.name)
    log(`speech model: downloading ${pin.name} from ${host}`)
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
      if (saved.bytes !== pin.size || saved.sha256 !== pin.sha256) {
        await removeQuietly(temporary)
        throw new VoiceError(
          `файл ${pin.name} не совпал с закреплённым: ожидалось ${pin.size} байт и SHA-256 ${pin.sha256}, ` +
            `получено ${saved.bytes} байт и SHA-256 ${saved.sha256}`,
        )
      }
      await rename(temporary, target)
      return target
    } catch (error) {
      await removeQuietly(temporary)
      if (signal?.aborted ?? false) throw new VoiceError('загрузка модели отменена')
      if (error instanceof VoiceError && /не совпал/.test(error.message)) throw error
      lastError = error
      log(`speech model: ${host} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new VoiceError(`нет сети для загрузки модели речи с huggingface.co и hf-mirror.com: ${detail}`)
}

/** Verified model paths of one daemon home; a successful check is not repeated. */
const verifiedModels = new Map<string, ModelPaths>()

/**
 * Finds the three pinned files under `DSHBOT_HOME/models`, checking every one,
 * and downloads only what is missing or does not match. Throws {@link VoiceError}
 * with an owner-facing reason; the daemon keeps running.
 */
export async function ensureModel(options: {
  home: string
  log?: (text: string) => void
  signal?: AbortSignal
}): Promise<ModelPaths> {
  const log = options.log ?? (() => undefined)
  const modelsDir = join(options.home, MODEL_DIRECTORY)
  const cached = verifiedModels.get(options.home)
  if (cached !== undefined) return cached
  if (options.signal?.aborted ?? false) throw new VoiceError('загрузка модели отменена')

  await mkdir(modelsDir, { recursive: true })
  const existing = await findFiles(modelsDir)
  const paths: Partial<ModelPaths> = {}

  for (const pin of MODEL_FILES) {
    if (options.signal?.aborted ?? false) throw new VoiceError('загрузка модели отменена')
    const candidates = existing.filter((file) => file.path.endsWith(`/${pin.name}`) || file.path.endsWith(`\\${pin.name}`))
    let usable: string | undefined
    for (const candidate of candidates) {
      if (await matchesPin(candidate.path, pin)) {
        usable = candidate.path
        break
      }
      // A file with the right name but the wrong bytes is not a model: remove
      // it so the next start does not trust it and so the test can prove it.
      log(`speech model: ${candidate.path} does not match the pin, deleting`)
      await removeQuietly(candidate.path)
    }
    if (usable === undefined) {
      if (candidates.length > 0) log(`speech model: ${pin.name} is absent after the check`)
      usable = await downloadFile(modelsDir, pin, log, options.signal)
    }
    if (pin.name === 'small-encoder.int8.onnx') paths.encoder = usable
    else if (pin.name === 'small-decoder.int8.onnx') paths.decoder = usable
    else paths.tokens = usable
  }

  if (paths.encoder === undefined || paths.decoder === undefined || paths.tokens === undefined) {
    throw new VoiceError('модель речи собрана не полностью')
  }
  const result: ModelPaths = { encoder: paths.encoder, decoder: paths.decoder, tokens: paths.tokens }
  verifiedModels.set(options.home, result)
  return result
}
