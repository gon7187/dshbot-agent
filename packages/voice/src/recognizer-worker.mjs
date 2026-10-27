// Recognition worker: decode a Telegram audio file to 16 kHz mono samples and
// run the pinned Whisper small model on CPU through sherpa-onnx.
//
// The worker is also the seam for the tests. When `stubDir` is present it does
// not decode, does not load the model and never touches the network: it records
// the exact bytes Telegram served, optionally blocks the thread like a CPU-bound
// model, and returns the text from `<sha256>.txt` or `transcript.txt`.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)

const TARGET_RATE = 16000
const CHANNEL_LIMIT = 8
const LAST_SECONDS = 30
const WHISPER_LANGUAGE = 'ru'

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** The test stand-in: record, optionally block, read the expected text. */
function recognizeStub() {
  const data = readFileSync(workerData.filePath)
  const digest = sha256(data)
  appendFileSync(join(workerData.stubDir, 'calls.jsonl'), `${JSON.stringify({ bytes: data.length, sha256: digest })}\n`)

  const blockPath = join(workerData.stubDir, 'block_ms')
  if (existsSync(blockPath)) {
    const requested = Number.parseInt(readFileSync(blockPath, 'utf8').trim(), 10)
    const ms = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10 * 60_000) : 0
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  const exact = join(workerData.stubDir, `${digest}.txt`)
  const fallback = join(workerData.stubDir, 'transcript.txt')
  const transcript = existsSync(exact) ? exact : existsSync(fallback) ? fallback : undefined
  if (transcript === undefined) throw new Error('заглушка распознавания не нашла текст для этого файла')
  return collapse(readFileSync(transcript, 'utf8'))
}

function mixToMono(channelData) {
  const channels = channelData.slice(0, CHANNEL_LIMIT)
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map((channel) => channel.length))
  const mono = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[index]
    mono[index] = sum / channels.length
  }
  return mono
}

/** Linear resampling is enough for speech features and has no native dependency. */
function resample(samples, from, to) {
  if (from === to || samples.length === 0) return samples
  const ratio = to / from
  const count = Math.floor(samples.length * ratio)
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const position = index / ratio
    const left = Math.floor(position)
    const right = Math.min(samples.length - 1, left + 1)
    const weight = position - left
    out[index] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return out
}

async function decodeAudio(sherpa) {
  const path = workerData.filePath
  const extension = extname(path).replace('.', '').toLowerCase()
  if (extension === 'wav') {
    const wave = sherpa.readWave(path)
    return { samples: wave.samples, sampleRate: wave.sampleRate }
  }
  if (extension === 'ogg' || extension === 'oga' || extension === 'opus') {
    const { OggOpusDecoder } = await import('ogg-opus-decoder')
    const decoder = new OggOpusDecoder()
    await decoder.ready
    try {
      // This build resolves the decode promise; the decoder API is synchronous
      // only in the browser build, so await both shapes.
      const decoded = await Promise.resolve(decoder.decode(new Uint8Array(readFileSync(path))))
      return { samples: mixToMono(decoded.channelData), sampleRate: decoded.sampleRate }
    } finally {
      decoder.free()
    }
  }
  if (extension === 'mp3') {
    const module = await import('@audio/decode-mp3')
    const decoded = await module.default(new Uint8Array(readFileSync(path)))
    return { samples: mixToMono(decoded.channelData), sampleRate: decoded.sampleRate }
  }
  if (['m4a', 'mp4', 'm4v', 'mov', '3gp'].includes(extension)) {
    const module = await import('@audio/decode-mp4')
    const decoded = await module.default(new Uint8Array(readFileSync(path)))
    return { samples: mixToMono(decoded.channelData), sampleRate: decoded.sampleRate }
  }
  throw new Error(`формат ${extension === '' ? 'без расширения' : extension} пока не распознаётся локально`)
}

function recognizeModel() {
  const sherpa = require('sherpa-onnx-node')
  const decoded = decodeAudio(sherpa)
  return decoded.then(({ samples, sampleRate }) => {
    const audio = resample(samples, sampleRate, TARGET_RATE)
    // Long recordings are decoded in bounded pieces so the feature buffer of
    // the model stays predictable; Whisper handles each piece on its own.
    const piece = TARGET_RATE * LAST_SECONDS
    const chunks = []
    for (let offset = 0; offset < audio.length; offset += piece) {
      chunks.push(audio.subarray(offset, Math.min(audio.length, offset + piece)))
    }
    if (chunks.length === 0) throw new Error('в записи нет звука')

    const model = workerData.model
    const recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: model.encoder,
          decoder: model.decoder,
          language: WHISPER_LANGUAGE,
          task: 'transcribe',
          tailPaddings: -1,
        },
        tokens: model.tokens,
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
    })

    const texts = []
    for (const chunk of chunks) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: chunk, sampleRate: TARGET_RATE })
      recognizer.decode(stream)
      texts.push(collapse(recognizer.getResult(stream).text))
    }
    return texts.filter((text) => text !== '').join(' ')
  })
}

async function run() {
  const text = workerData.stubDir === undefined ? await recognizeModel() : recognizeStub()
  return collapse(text)
}

try {
  const text = await run()
  parentPort?.postMessage({ ok: true, text })
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
