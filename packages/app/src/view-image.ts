// `view_image` of the owner: one file of an allowed root becomes a real image
// block in the same turn of the model.
//
// The tool only validates and reads the bytes. The runner seam turns the
// returned {@link RunnerImageAnswer} into a deferred user message with the same
// bytes and media type, so the model sees the picture on the next step of the
// turn instead of text like "Binary file".
//
// The check is by content, never by the extension: a `.png` holding text is a
// refusal. The model route decides whether pictures are accepted at all; a
// route without the image modality gets a readable error and its turn lives on.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

import type { RunnerImageInput, RunnerTool, RunnerToolContext } from '../../runner/src/index.js'

/** Name of the tool as the model sees it. */
export const VIEW_IMAGE_TOOL_NAME = 'view_image'

/** Largest file the tool reads; the Bot API and the attachment store share it. */
export const MAX_VIEW_IMAGE_BYTES = 20 * 1024 * 1024

/** Media types the harness accepts as request images. */
export type ViewImageMediaType = RunnerImageInput['mediaType']

/** One allowed directory of the file tools. */
export interface ViewImageRoot {
  readonly path: string
}

/** Options of {@link createViewImageTool}. */
export interface ViewImageOptions {
  /** `DSHBOT_HOME`, used in the model-facing description. */
  readonly home: string
  /** The workspace of the daemon; relative paths resolve against it. */
  readonly workspace: string
  /** Every directory the file tools may reach, read-write and read-only alike. */
  readonly roots: readonly ViewImageRoot[]
  /**
   * Whether the model of the current turn accepts image blocks. A route
   * without the image modality (the pro route) gets a clear refusal instead of
   * a failed request.
   */
  readonly supportsImages?: (model: string | undefined) => boolean
}

interface SniffedImage {
  mediaType: ViewImageMediaType
  width: number
  height: number
}

function within(root: string, candidate: string): boolean {
  const inside = relative(root, candidate)
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
}

function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) * 0x100 + (bytes[at + 1] ?? 0)
}

function u32be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000 + (bytes[at + 1] ?? 0) * 0x10000 + (bytes[at + 2] ?? 0) * 0x100 + (bytes[at + 3] ?? 0)) >>> 0
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 0x100
}

function u32le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 0x100 + (bytes[at + 2] ?? 0) * 0x10000 + (bytes[at + 3] ?? 0) * 0x1000000) >>> 0
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[at + index] ?? 0)
  return text
}

function sniffPng(bytes: Uint8Array): SniffedImage | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) return undefined
  if (ascii(bytes, 12, 4) !== 'IHDR') return undefined
  const width = u32be(bytes, 16)
  const height = u32be(bytes, 20)
  if (width === 0 || height === 0) return undefined
  return { mediaType: 'image/png', width, height }
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1
      continue
    }
    const marker = bytes[at + 1] ?? 0
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    const length = u16be(bytes, at + 2)
    if (length < 2) return undefined
    // SOF0..SOF15 except the DHT/JPG/DAC markers carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(bytes, at + 5)
      const width = u16be(bytes, at + 7)
      if (width === 0 || height === 0) return undefined
      return { mediaType: 'image/jpeg', width, height }
    }
    at += 2 + length
  }
  return undefined
}

function sniffGif(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 13) return undefined
  const header = ascii(bytes, 0, 6)
  if (header !== 'GIF87a' && header !== 'GIF89a') return undefined
  const width = u16le(bytes, 6)
  const height = u16le(bytes, 8)
  if (width === 0 || height === 0) return undefined
  return { mediaType: 'image/gif', width, height }
}

function sniffWebp(bytes: Uint8Array): SniffedImage | undefined {
  if (bytes.length < 30) return undefined
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return undefined
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    const width = u16le(bytes, 26) & 0x3fff
    const height = u16le(bytes, 28) & 0x3fff
    return width > 0 && height > 0 ? { mediaType: 'image/webp', width, height } : undefined
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined
    const bits = u32le(bytes, 21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { mediaType: 'image/webp', width, height }
  }
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16)
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16)
    return width > 0 && height > 0 ? { mediaType: 'image/webp', width, height } : undefined
  }
  return undefined
}

/** The media type and intrinsic size of PNG, JPEG, WebP or GIF by its bytes. */
export function sniffImage(bytes: Uint8Array): SniffedImage | undefined {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffGif(bytes) ?? sniffWebp(bytes)
}

/** Model-facing error of one refused path; every message names its reason. */
function refuse(path: string, reason: string): Error {
  return new Error(`view_image: ${reason}: ${path}`)
}

export function createViewImageTool(options: ViewImageOptions): RunnerTool {
  if (options.home.trim() === '') throw new Error('view_image needs DSHBOT_HOME')
  if (options.roots.length === 0) throw new Error('view_image needs at least one allowed root')
  const workspace = realPathOf(options.workspace)
  const roots = options.roots.map((root) => realPathOf(root.path))
  const supportsImages = options.supportsImages ?? (() => true)
  const rootsSummary = roots.join(', ')

  return {
    name: VIEW_IMAGE_TOOL_NAME,
    // Lazy on every route: the schema stays out of the first request and
    // `tool_search` loads it into the same turn, even on a leading-only route.
    lazy: true,
    loadsMidSession: true,
    description:
      'Показать модели картинку из файла (PNG, JPEG, WebP, GIF): файл уходит как изображение в этом же ходе. ' +
      `Путь — в разрешённых корнях (${rootsSummary}); относительный путь считается от workspace. ` +
      `Лимит 20 МБ. На модели без поддержки картинок инструмент отвечает ошибкой.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Путь к файлу картинки: абсолютный или относительный от workspace.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute(args: Record<string, unknown>, context?: RunnerToolContext): unknown {
      const raw = typeof args.path === 'string' ? args.path.trim() : ''
      if (raw === '') throw new Error('view_image: не указан путь к картинке')
      if (raw.includes('\u0000')) throw refuse(raw, 'в пути есть недопустимый символ')

      // Relative paths use the workspace, exactly like the file tools; the
      // containment check below still decides on the real path.
      const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw)
      if (!roots.some((root) => within(root, absolute))) {
        throw refuse(absolute, 'путь вне разрешённых корней')
      }

      let real: string
      let size: number
      try {
        real = realpathSync(absolute)
        const stat = statSync(real)
        if (!stat.isFile()) throw refuse(absolute, 'это не файл')
        size = stat.size
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('view_image:')) throw error
        throw refuse(absolute, 'файл не найден')
      }
      // A symlink inside a root must not reach a file outside it.
      if (!roots.some((root) => within(root, real))) {
        throw refuse(absolute, 'путь вне разрешённых корней')
      }
      if (size > MAX_VIEW_IMAGE_BYTES) {
        throw refuse(
          absolute,
          `файл больше 20 МБ (лимит 20971520 байт; размер файла ${size} байт)`,
        )
      }

      const data = readFileSync(real)
      const image = sniffImage(data)
      if (image === undefined) {
        throw refuse(
          absolute,
          'не картинка: содержимое не является PNG, JPEG, WebP или GIF (расширение не важно)',
        )
      }
      if (!supportsImages(context?.model)) {
        throw refuse(
          absolute,
          'текущая модель не принимает картинки; картинки видит только flash — переключите модель через /model flash',
        )
      }

      return {
        text:
          `Картинка ${basename(real)} передана модели: ${image.mediaType}, ` +
          `${image.width}×${image.height}, ${data.byteLength} байт.`,
        images: [{ data, mediaType: image.mediaType, name: basename(real) }],
      }
    },
  }
}
