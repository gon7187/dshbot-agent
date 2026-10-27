// OGG/Opus encoding of synthesized samples with the host ffmpeg.
//
// ffmpeg is started directly, never through a shell: the bytes go to stdin,
// the file name is one argument, and a missing binary or a build without the
// Opus encoder is an ordinary rejected promise. The caller keeps the text
// answer in that case.

import { spawn } from 'node:child_process'

const STDERR_LIMIT = 8_000
const ENCODE_TIMEOUT_MS = 2 * 60_000

function pcm16(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0))
    buffer.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), index * 2)
  }
  return buffer
}

/**
 * Encodes mono float samples into an OGG/Opus file at `target`.
 * Rejects with a message that names ffmpeg and the Opus failure.
 */
export function encodeOggOpus(samples, sampleRate, target, options = {}) {
  return new Promise((resolve, reject) => {
    if (!(samples && samples.length > 0)) {
      reject(new Error('ffmpeg: нет звука для кодирования в Opus'))
      return
    }
    if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
      reject(new Error('ffmpeg: неизвестная частота дискретизации для Opus'))
      return
    }
    const ffmpeg = options.ffmpeg ?? 'ffmpeg'
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      String(Math.round(sampleRate)),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-application',
      'voip',
      '-f',
      'ogg',
      target,
    ]
    let child
    try {
      child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (error) {
      reject(new Error(`ffmpeg: ошибка запуска: ${error instanceof Error ? error.message : String(error)}`))
      return
    }
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish(new Error(`ffmpeg: ошибка кодирования в Opus: не уложился в ${ENCODE_TIMEOUT_MS / 1000} секунд`))
    }, options.timeoutMs ?? ENCODE_TIMEOUT_MS)
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk)
    })
    child.once('error', (error) => {
      finish(new Error(`ffmpeg: ошибка запуска: ${error instanceof Error ? error.message : String(error)}`))
    })
    child.once('close', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 600)
      const reason = detail === '' ? `код ${code}${signal === null ? '' : `, сигнал ${signal}`}` : detail
      finish(new Error(`ffmpeg: ошибка кодирования в Opus: ${reason}`))
    })
    child.stdin?.on('error', () => {
      // ffmpeg may close stdin on its own failure; `close` carries the reason.
    })
    child.stdin?.end(pcm16(samples))
  })
}
