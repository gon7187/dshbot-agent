// Types for the OGG/Opus encoder imported by the app. The implementation is
// plain ESM because it starts a child process.

export interface EncodeOggOpusOptions {
  /** Binary name or path; defaults to `ffmpeg` from `PATH`. */
  ffmpeg?: string
  timeoutMs?: number
}

export function encodeOggOpus(
  samples: Float32Array,
  sampleRate: number,
  target: string,
  options?: EncodeOggOpusOptions,
): Promise<void>
