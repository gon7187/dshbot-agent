// Картинка в теле финального ответа.
//
// Финальный ответ уходит через sendFormatted (rich → HTML → простой текст), и
// до сих пор вложить в него файл было нельзя: `rich_message.media` умел только
// инструмент `message`. Из-за этого отчёт с графиком уходил двумя сообщениями —
// текст финалом, картинка отдельным `message`. Здесь текст финала разбирается
// на ссылки, файлы читаются из workspace и уходят вместе с ним в
// `rich_message.media`, а ссылка заменяется на `tg://photo?id=photoN`.

import { readFileSync } from 'node:fs'
import { resolveOutgoingFile, MAX_SEND_BYTES } from './outgoing-files.js'

/** Вложение внутри тела rich-сообщения (совпадает с RichMediaInput пакета telegram). */
export interface InlinePhotoMedia {
  id: string
  name: string
  data: Uint8Array
  contentType: string
}

export interface InlinePhotoResult {
  /** Текст финала: ссылки на вложенные картинки заменены на `tg://photo?id=`. */
  markdown: string
  media: InlinePhotoMedia[]
  /** Пути, которые не удалось вложить: ответ уходит как есть, без них. */
  skipped: string[]
}

/** Маркер модели: `[[фото]]` (одна картинка) или `[[фото: outbox/chart.png]]`. */
const PHOTO_MARKER = /\[\[фото(?:\s*:\s*([^\]\n]+?))?\s*\]\]/g
/** Обычная ссылка Markdown на файл: `![](outbox/chart.png)`. */
const IMAGE_LINK = /!\[[^\]\n]*\]\(([^)\s]+)\)/g

const MAX_PHOTOS = 10
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface Candidate {
  /** Совпадение целиком и его место в тексте. */
  start: number
  end: number
  path?: string
}

function collect(markdown: string): Candidate[] {
  const found: Candidate[] = []
  for (const match of markdown.matchAll(PHOTO_MARKER)) {
    const start = match.index ?? 0
    const raw = match[1]?.trim()
    found.push({ start, end: start + match[0].length, ...(raw === undefined ? {} : { path: raw }) })
  }
  for (const match of markdown.matchAll(IMAGE_LINK)) {
    const target = match[1] ?? ''
    // Внешние и уже готовые tg://-ссылки не наши: их не трогаем.
    if (target.startsWith('tg://') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const start = match.index ?? 0
    found.push({ start, end: start + match[0].length, path: target })
  }
  return found.sort((left, right) => left.start - right.start)
}

function imageOf(home: string, raw: string): { file: string; name: string; mime: string } {
  const resolved = resolveOutgoingFile(home, raw)
  const dot = resolved.name.lastIndexOf('.')
  const mime = dot === -1 ? '' : IMAGE_MIME[resolved.name.slice(dot).toLowerCase()]
  if (mime === undefined || mime === '') {
    throw new Error(`не картинка: ${resolved.name}`)
  }
  if (resolved.size > MAX_SEND_BYTES) throw new Error(`файл больше 50 МБ: ${resolved.name}`)
  return { file: resolved.path, name: resolved.name, mime }
}

/**
 * Вкладывает картинки, на которые ссылается текст финала.
 *
 * Ссылка без пути (`[[фото]]`) берёт единственную картинку ответа; если
 * картинок несколько, маркер просто убирается, а файлы идут в порядке ссылок.
 * Любая проблема с файлом (нет файла, не картинка, слишком большой, путь вне
 * workspace) не ломает доставку: такой путь попадает в `skipped`, а текст
 * уходит без него.
 */
export function embedInlinePhotos(home: string, markdown: string): InlinePhotoResult {
  const candidates = collect(markdown)
  if (candidates.length === 0) return { markdown, media: [], skipped: [] }

  const withPath = candidates.filter((item) => item.path !== undefined)
  const withoutPath = candidates.filter((item) => item.path === undefined)
  const media: InlinePhotoMedia[] = []
  const skipped: string[] = []
  const ids = new Map<string, string>()
  const replacements = new Map<Candidate, string>()

  const attach = (candidate: Candidate, raw: string): string | undefined => {
    const known = ids.get(raw)
    if (known !== undefined) return known
    if (media.length >= MAX_PHOTOS) {
      skipped.push(raw)
      return undefined
    }
    try {
      const image = imageOf(home, raw)
      const id = `photo${media.length + 1}`
      ids.set(raw, id)
      media.push({ id, name: image.name, data: new Uint8Array(readFileSync(image.file)), contentType: image.mime })
      return id
    } catch {
      skipped.push(raw)
      return undefined
    }
  }

  for (const candidate of withPath) {
    const raw = candidate.path as string
    const id = attach(candidate, raw)
    if (id !== undefined) replacements.set(candidate, `![](tg://photo?id=${id})`)
  }

  // `[[фото]]` без пути: единственная картинка ответа встаёт на его место.
  const sole = media.length === 1 ? media[0]?.id : undefined
  for (const candidate of withoutPath) {
    replacements.set(candidate, sole === undefined ? '' : `![](tg://photo?id=${sole})`)
  }

  let result = ''
  let cursor = 0
  for (const candidate of candidates) {
    result += markdown.slice(cursor, candidate.start)
    const replacement = replacements.get(candidate)
    // Неразобранную ссылку оставляем как была: текст важнее картинки.
    result += replacement ?? markdown.slice(candidate.start, candidate.end)
    cursor = candidate.end
  }
  result += markdown.slice(cursor)

  return { markdown: result, media, skipped }
}
