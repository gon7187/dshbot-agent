// Video of the owner: frames for the vision model and the sound track for the
// local speech recognizer.
//
// Telegram serves the bytes, the attachment intake saves them in the inbox and
// this file takes the saved file apart with `ffmpeg`: up to eight frames spread
// over the clip and one mono 16 kHz WAV of the sound track. The frames are image
// blocks of the model request; the sound goes to the same local recognizer the
// voice messages use, so speech never leaves the machine.
//
// A video may be forwarded from a stranger, so ffmpeg and ffprobe run inside the
// bwrap profile of the project, never on the bare host: no network, an empty
// home, one private writable work directory and the directory of the saved
// video read-only. A hole in an ffmpeg demuxer then cannot reach the account of
// the owner. The profile is the same one `packages/tools-exec` uses, without its
// proxy directory, and the program that `spawn` starts is `bwrap`.
//
// Everything here spawns a process and awaits it: the caller already runs in a
// detached intake task, and the daemon loop keeps answering /status and /stop
// while ffmpeg or a CPU-bound recognizer works. No frame extraction is done for
// a route without the image modality: the caller asks for the sound only.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { sandboxProfile } from '../../tools-exec/src/index.js'
import { recognizeAudio } from '../../voice/src/index.js'

/** Bot API download limit: a larger video is refused before it is downloaded. */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024

/** Frames of one video that reach the model, spread evenly over the clip. */
export const MAX_VIDEO_FRAMES = 8

/**
 * Model that accepts pictures. `deepseek-v4-flash` does not, so a request with
 * video frames always names this route explicitly instead of inheriting a
 * `deepseek-v4-flash` choice of the owner.
 */
export const VIDEO_VISION_MODEL = 'deepseek-flash'

/** Widest frame sent to the model: the request stays small, the picture readable. */
const FRAME_WIDTH = 640

/** Output of one ffmpeg run is bounded: a broken file may write a lot of noise. */
const OUTPUT_LIMIT = 64 * 1024

const PROBE_TIMEOUT_MS = 20_000
const FRAME_TIMEOUT_MS = 45_000
const AUDIO_TIMEOUT_MS = 60_000
const VERSION_TIMEOUT_MS = 10_000

/** One extracted frame, ready to become an image block of the model request. */
export interface VideoFrame {
  mediaType: 'image/jpeg'
  data: Uint8Array
}

/** What one video gave the model turn; `error` means nothing was extracted. */
export interface VideoAnalysis {
  frames: VideoFrame[]
  /** Recognized speech; empty when the clip has no sound track or no speech. */
  speech: string
  /** Model-facing remarks about a missing or unrecognized sound track. */
  notes: string[]
  /** Reason the video could not be taken apart; frames and speech are empty then. */
  error?: string
}

export interface VideoAnalysisOptions {
  /** Saved video file in the inbox. */
  path: string
  /** `DSHBOT_HOME`; the speech model lives in `<home>/models`. */
  home: string
  /** Extract frames for an image-capable route; the sound track is always taken. */
  analyzeFrames?: boolean
  /** Duration declared by the update: only a fallback when ffprobe is absent. */
  durationSeconds?: number
  /** `DSHBOT_VOICE_TEST_STUB` of the tests: replaces decoding and inference. */
  stubDir?: string
  /** Aborts running ffmpeg and recognition (daemon shutdown or /stop of the intake). */
  signal?: AbortSignal
  log?: (text: string) => void
}

interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** The sandbox program (`bwrap`) itself was not found in PATH. */
  missing: boolean
}

/**
 * Environment of the sandbox start: only what the profile needs. The keys of
 * the bot and the rest of the daemon environment stay outside the sandbox.
 */
function sandboxEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: '/tmp',
    TERM: 'dumb',
  }
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const value = process.env[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  return env
}

/**
 * Run `command` inside the bwrap `profile` without a shell. The process that is
 * really started is `profile[0]` (`bwrap`), the rest of the profile follows and
 * the command after the `--` separator; the output is bounded and the timeout
 * kills it.
 */
function run(
  profile: readonly string[],
  command: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    if (signal?.aborted === true) {
      resolve({ ok: false, code: null, stdout: '', stderr: 'отменено', missing: false })
      return
    }
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ChildProcess | undefined

    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nотменено`, missing: false })
    }
    const collect = (current: string, chunk: Buffer): string => {
      if (current.length >= OUTPUT_LIMIT) return current
      return (current + chunk.toString('utf8')).slice(0, OUTPUT_LIMIT)
    }

    const program = profile[0] ?? 'bwrap'
    try {
      child = spawn(program, [...profile.slice(1), ...command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sandboxEnvironment(),
      })
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      finish({ ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : String(error), missing })
      return
    }

    timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nтаймаут ${Math.round(timeoutMs / 1000)} с`, missing: false })
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = collect(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = collect(stderr, chunk)
    })
    child.once('error', (error: unknown) => {
      const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      finish({ ok: false, code: null, stdout, stderr: error instanceof Error ? error.message : String(error), missing })
    })
    child.once('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, missing: false })
    })
  })
}

/** A short single-line reason from the noise ffmpeg may print. */
function brief(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(-1)[0] ?? ''
  return line.replace(/\s+/g, ' ').trim().slice(0, 240)
}

interface ProbeInfo {
  durationSeconds: number
  hasAudio: boolean
  /** ffprobe was not installed: the fields rest on the update's duration. */
  unknown: boolean
}

/** True when bwrap itself could not start the requested program. */
function missingProgram(stderr: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b.*(?:No such file|not found)`, 'i').test(stderr)
}

async function probe(
  profile: readonly string[],
  path: string,
  fallbackDuration: number,
  signal?: AbortSignal,
): Promise<{ info: ProbeInfo } | { error: string }> {
  const result = await run(
    profile,
    ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    PROBE_TIMEOUT_MS,
    signal,
  )
  if (result.missing || missingProgram(result.stderr, 'ffprobe')) {
    // ffmpeg may still be installed without ffprobe: extract with one frame per
    // second (or the declared duration) and let the extraction report a broken file.
    return { info: { durationSeconds: fallbackDuration, hasAudio: true, unknown: true } }
  }
  if (!result.ok) {
    const reason = brief(result.stderr) || 'ffprobe завершился с ошибкой'
    return { error: `файл повреждён или не читается: ${reason}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return { error: 'ffprobe вернул нечитаемый ответ' }
  }
  const value = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const format = value.format !== null && typeof value.format === 'object' ? (value.format as Record<string, unknown>) : {}
  const streams = Array.isArray(value.streams) ? value.streams.map((s) => (s !== null && typeof s === 'object' ? s : {})) : []
  const declared = Number(format.duration)
  const streamDuration = streams
    .map((stream) => Number((stream as Record<string, unknown>).duration))
    .find((duration) => Number.isFinite(duration) && duration > 0)
  const durationSeconds = Number.isFinite(declared) && declared > 0 ? declared : streamDuration ?? 0
  const hasAudio = streams.some((stream) => (stream as Record<string, unknown>).codec_type === 'audio')
  const hasVideo = streams.some((stream) => (stream as Record<string, unknown>).codec_type === 'video')
  if (!hasVideo) return { error: 'в файле нет видеодорожки' }
  return { info: { durationSeconds, hasAudio, unknown: false } }
}

/** Read the frames ffmpeg wrote, in timestamp order. */
function readFrames(directory: string): VideoFrame[] {
  let names: string[]
  try {
    names = readdirSync(directory)
      .filter((name) => /^frame-\d+\.jpg$/.test(name))
      .sort()
  } catch {
    return []
  }
  const frames: VideoFrame[] = []
  for (const name of names.slice(0, MAX_VIDEO_FRAMES)) {
    try {
      const data = readFileSync(join(directory, name))
      if (data.byteLength > 0) frames.push({ mediaType: 'image/jpeg', data })
    } catch {
      // The next frame still makes the request useful.
    }
  }
  return frames
}

/**
 * Take a saved video apart: up to eight evenly spread JPEG frames and the speech
 * of its sound track. Never throws: a missing ffmpeg, a broken file and a failed
 * recognition come back as a reason or a note, so the model turn still happens.
 */
export async function analyzeVideo(options: VideoAnalysisOptions): Promise<VideoAnalysis> {
  const failed = (reason: string): VideoAnalysis => ({ frames: [], speech: '', notes: [], error: reason })
  const log = options.log ?? ((): void => undefined)
  const videoPath = resolve(options.path)

  const directory = mkdtempSync(join(tmpdir(), 'dshbot-video-'))
  try {
    // The frames and the sound track are the only writes of the sandbox: its
    // workspace is a private temporary directory. The home is an empty
    // tmpfs, the directory of the saved video is bound read-only, and there is
    // no network directory at all. `spawn` starts bwrap, never ffmpeg directly.
    const workspace = join(directory, 'work')
    const home = join(directory, 'home')
    mkdirSync(workspace)
    mkdirSync(home)
    const profile = sandboxProfile({
      home,
      workspace,
      roPaths: [dirname(videoPath)],
    })

    const version = await run(profile, ['ffmpeg', '-hide_banner', '-version'], VERSION_TIMEOUT_MS, options.signal)
    if (version.missing) {
      return failed(
        'bwrap (песочница) не найден в PATH: без песочницы ffmpeg не запускается, ' +
          'поэтому кадры и звук видео недоступны',
      )
    }
    if (!version.ok) {
      const reason = brief(version.stderr) || 'ffmpeg не запускается'
      return failed(`ffmpeg не запускается в песочнице bwrap: ${reason}`)
    }

    const probed = await probe(profile, videoPath, options.durationSeconds ?? 0, options.signal)
    if ('error' in probed) return failed(probed.error)
    const { durationSeconds, hasAudio, unknown } = probed.info

    const frames: VideoFrame[] = []
    const notes: string[] = []

    if (options.analyzeFrames === true) {
      const seconds = durationSeconds > 0 ? durationSeconds : 0
      // `fps=8/duration` puts eight frames at equal intervals over the clip; a
      // short clip gets every available frame, `-frames:v` caps the rest.
      const rate = seconds > 0 ? MAX_VIDEO_FRAMES / seconds : 1
      const made = await run(
        profile,
        [
          'ffmpeg',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoPath,
          '-vf',
          `fps=${rate.toFixed(6)},scale=${FRAME_WIDTH}:-2`,
          '-frames:v',
          String(MAX_VIDEO_FRAMES),
          '-q:v',
          '4',
          join(workspace, 'frame-%03d.jpg'),
        ],
        FRAME_TIMEOUT_MS,
        options.signal,
      )
      frames.push(...readFrames(workspace))
      if (frames.length === 0) {
        // The sound track may still be good (an odd video codec must not cost the
        // owner the speech): keep going and tell the model what is missing.
        const reason = brief(made.stderr) || 'ffmpeg не извлёк ни одного кадра'
        notes.push(`Кадры видео извлечь не удалось: ${reason}.`)
      }
    }

    let speech = ''
    if (!hasAudio) {
      notes.push('В видео нет звуковой дорожки.')
    } else {
      const audioPath = join(workspace, 'audio.wav')
      const audio = await run(
        profile,
        [
          'ffmpeg',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          videoPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          audioPath,
        ],
        AUDIO_TIMEOUT_MS,
        options.signal,
      )
      let hasTrack = audio.ok
      try {
        hasTrack = hasTrack && statSync(audioPath).size > 44
      } catch {
        hasTrack = false
      }
      if (!hasTrack) {
        // ffprobe without a sound stream is already handled above; here either
        // the extraction failed or the track is empty. An unknown probe result
        // may simply be a clip without sound, so it is a note, not an error.
        if (unknown) notes.push('Звуковую дорожку видео получить не удалось.')
        else notes.push(`Звуковую дорожку видео получить не удалось: ${brief(audio.stderr) || 'в ней нет звука'}.`)
      } else {
        try {
          speech = await recognizeAudio({
            home: options.home,
            filePath: audioPath,
            ...(options.stubDir === undefined || options.stubDir === '' ? {} : { stubDir: options.stubDir }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.log === undefined ? {} : { log: options.log }),
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          log(`video ${options.path}: speech was not recognized: ${reason}`)
          notes.push(`Речь из видео не распознана: ${brief(reason) || 'неизвестная ошибка'}.`)
        }
      }
    }

    return { frames, speech: speech.replace(/\s+/g, ' ').trim(), notes }
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // The temporary directory is cleaned by the system anyway.
    }
  }
}
