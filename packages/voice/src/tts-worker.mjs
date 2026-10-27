// Synthesis worker: run the pinned Russian VITS voice on CPU through
// sherpa-onnx, or the test stand-in, off the thread that long-polls Telegram.
//
// With `stubDir` the worker does not load the model and never touches the
// network: it records the exact text, optionally blocks the thread like a
// CPU-bound model, and returns one second of silence at 22050 Hz.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)

const STUB_SAMPLE_RATE = 22050

function synthesizeStub() {
  appendFileSync(join(workerData.stubDir, 'tts-calls.jsonl'), `${JSON.stringify({ text: workerData.text })}\n`)

  const blockPath = join(workerData.stubDir, 'block_ms')
  if (existsSync(blockPath)) {
    const requested = Number.parseInt(readFileSync(blockPath, 'utf8').trim(), 10)
    const ms = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10 * 60_000) : 0
    if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  if (existsSync(join(workerData.stubDir, 'fail'))) {
    throw new Error('заглушка синтеза речи вернула ошибку')
  }

  return { samples: new Float32Array(STUB_SAMPLE_RATE), sampleRate: STUB_SAMPLE_RATE }
}

// The configuration and the phonemized request are built by `tts-config.ts`:
// sherpa-onnx 2.0.0 speaks a Piper voice only from `phonemeCodepoints`.
function synthesizeModel() {
  const sherpa = require('sherpa-onnx-node')
  const { config, request } = workerData.synthesis
  const tts = new sherpa.OfflineTts(config)
  const audio = tts.generate(request)
  // The addon owns the buffer of its samples and it cannot be transferred: copy it.
  const samples = new Float32Array(audio.samples ?? [])
  if (samples.length === 0) throw new Error('модель синтеза вернула пустой звук')
  return { samples, sampleRate: Number(audio.sampleRate) || tts.sampleRate }
}

try {
  const audio = workerData.stubDir === undefined ? synthesizeModel() : synthesizeStub()
  parentPort?.postMessage({ ok: true, samples: audio.samples, sampleRate: audio.sampleRate }, [audio.samples.buffer])
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
}
