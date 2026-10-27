// Extraction worker of one attachment.
//
// The daemon never parses a document in-process: a hanging or a crashing file
// must not take the bot with it. The parent starts this file with
// `worker_threads` and a memory limit, waits at most 60 seconds and turns every
// failure into a note for the model.
//
// Everything here reads data, never code: the result of a file is untrusted
// text and goes to the model only inside the `<file>` frame built by the
// parent. Libraries do the format work (unpdf, mammoth, read-excel-file,
// jszip, @xmldom/xmldom); this file only selects the right one and applies the
// size limits.

import { readFile } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import { crc32, inflateRawSync } from 'node:zlib'

import { checkZip, listZipEntries } from './zip-guard.mjs'
import { xlsxText } from './xlsx-read.mjs'

// The ZIP guard and the XLSX reader live in shared modules: the office tool
// (`edit_xlsx`) uses the very same code instead of a second parser.
export { scanZipEntries, listZipEntries } from './zip-guard.mjs'

const TEXT_LIMIT = 60_000
const PDF_PAGE_LIMIT = 20
const ZIP_ENTRY_LIMIT = 50 * 1024 * 1024

/** Pages of a scan that go to the model; the rest is named in the note. */
const SCAN_PAGE_LIMIT = 10
/** A rendered page is an image of the model request: keep both sides readable and small. */
const PAGE_MAX_WIDTH = 1240
const PAGE_MAX_HEIGHT = 1800
const PAGE_MAX_SCALE = 3
const PAGE_JPEG_QUALITY = 72
/** Rendering of all pages of one scan stops here, well before the worker deadline. */
const SCAN_RENDER_BUDGET_MS = 45_000

function partialNote(shown, total, unit) {
  return `[Частично: показано ${shown} из ${total} ${unit}]`
}

/** Genitive after «из»: «из 1 страницы», «из 4 страниц». */
function pageWord(count) {
  return count % 10 === 1 && count % 100 !== 11 ? 'страницы' : 'страниц'
}

/** «1, 3–5, 8»: page numbers as ranges. */
function pageRanges(numbers) {
  const ranges = []
  for (const number of numbers) {
    const last = ranges[ranges.length - 1]
    if (last !== undefined && last[1] === number - 1) last[1] = number
    else ranges.push([number, number])
  }
  return ranges.map(([from, to]) => (from === to ? String(from) : `${from}–${to}`)).join(', ')
}

/**
 * Model-facing note about a scan. `images` are the pages attached as images;
 * none at all with no failures means this route cannot take pictures and the
 * note says which model can. `failures` are pages that could not be drawn, with
 * the reason; they are never counted as shown.
 */
function scanNote(total, images, failures = []) {
  const pages = `${total} ${pageWord(total)}`
  const shown = images.length
  if (shown <= 0 && failures.length === 0) {
    return `Скан из ${pages}, текстового слоя нет. Эта модель не принимает изображения: страницы видит только flash (deepseek-flash).`
  }
  const failed = failures.map((failure) => `стр. ${failure.page}: ${failure.reason}`).join('; ')
  if (shown <= 0) {
    return `Скан из ${pages}, но не удалось получить изображения страниц: ${failed}.`
  }
  if (failures.length === 0) {
    if (total > shown) return `Скан из ${pages}, текстового слоя нет. Показаны первые ${shown}, осталось ${total - shown}.`
    return `Скан из ${pages}, текстового слоя нет. ${shown === 1 ? 'Показана страница 1' : `Показаны страницы 1–${shown}`}.`
  }
  const lines = [`Скан из ${pages}, текстового слоя нет. Показаны страницы ${pageRanges(images.map((image) => image.page))} (${shown}).`]
  const lost = pageRanges(failures.map((failure) => failure.page))
  lines.push(failures.length === 1 ? `Не удалось получить страницу ${lost}, она не показана (${failed}).` : `Не удалось получить страницы ${lost}, они не показаны (${failed}).`)
  const checked = Math.max(...images.map((image) => image.page), ...failures.map((failure) => failure.page))
  if (total > checked) lines.push(`Не показаны страницы ${checked + 1}–${total}, осталось ${total - checked}.`)
  return lines.join(' ')
}

/**
 * Compose the final text of one file: content plus every note, never more than
 * {@link TEXT_LIMIT} characters together. The partial marker is part of the
 * limit and is added exactly once here; callers never append the notes again.
 */
export function finalizeText(text, notes) {
  const noteText = notes.filter((note) => note !== '').join('\n')
  const suffix = noteText === '' ? '' : `\n${noteText}`
  if (text.length + suffix.length <= TEXT_LIMIT) return { text: text + suffix, notes: [] }
  const total = text.length
  // The marker itself depends on the kept count; reserve its worst-case width
  // (the digits of the limit) and then shrink by the real overflow.
  let kept = Math.max(0, TEXT_LIMIT - suffix.length - 80)
  let marker = `\n${partialNote(kept, total, 'символов')}`
  const overflow = kept + marker.length + suffix.length - TEXT_LIMIT
  if (overflow > 0) kept = Math.max(0, kept - overflow)
  marker = `\n${partialNote(kept, total, 'символов')}`
  let result = text.slice(0, kept) + marker + suffix
  if (result.length > TEXT_LIMIT) result = result.slice(0, TEXT_LIMIT)
  return { text: result, notes: [] }
}

/**
 * Cut `text` to `budget` characters with the same partial marker `finalizeText`
 * uses. The archive shares one budget between its entries, so an entry may have
 * to stop earlier than the limit of a single file.
 */
function cutToBudget(text, budget) {
  let kept = Math.max(0, budget - 64)
  let marker = `\n${partialNote(kept, text.length, 'символов')}`
  const overflow = kept + marker.length - budget
  if (overflow > 0) kept = Math.max(0, kept - overflow)
  marker = `\n${partialNote(kept, text.length, 'символов')}`
  const result = text.slice(0, kept) + marker
  return result.length <= budget ? result : result.slice(0, budget)
}

// --- format extractors --------------------------------------------------------------------

/** Text of an XML document through a real XML parser, paragraph by paragraph. */
async function xmlText(xml) {
  const module = await import('@xmldom/xmldom')
  const Parser = module.DOMParser ?? module.default?.DOMParser
  if (typeof Parser !== 'function') throw new Error('XML-парсер недоступен')
  const document = new Parser({ onError: () => undefined }).parseFromString(xml, 'text/xml')
  const root = document?.documentElement
  if (root === null || root === undefined) throw new Error('повреждённый XML')
  const paragraphs = []
  const all = document.getElementsByTagName('*')
  for (let index = 0; index < all.length; index += 1) {
    const element = all.item(index)
    if (element?.localName === 'p') paragraphs.push(element.textContent ?? '')
  }
  const chunks = (paragraphs.length > 0 ? paragraphs : [root.textContent ?? ''])
    .map((part) => String(part).replace(/\s+/g, ' ').trim())
    .filter((part) => part !== '')
  return chunks.join('\n')
}

async function pdfText(data, notes) {
  const { extractText } = await import('unpdf')
  const result = await extractText(new Uint8Array(data), { mergePages: false })
  const pages = Array.isArray(result.text) ? result.text : [String(result.text ?? '')]
  const total = Number(result.totalPages) || pages.length
  const shown = pages.slice(0, PDF_PAGE_LIMIT)
  if (total > PDF_PAGE_LIMIT) notes.push(partialNote(PDF_PAGE_LIMIT, total, 'страниц'))
  const text = shown
    .map((page, index) => `--- страница ${index + 1} ---\n${page.trim()}`)
    .join('\n\n')
    .trim()
  if (text.replace(/--- страница \d+ ---/g, '').trim() === '') {
    return { kind: 'scan', text: '', totalPages: total }
  }
  return { kind: 'text', text, totalPages: total }
}

/**
 * The pages of a `pages` range, 1-based and inclusive. A missing range is the
 * first {@link PDF_PAGE_LIMIT} pages. A page that lies outside the document is
 * an error that names the total; the office tool turns it into a tool error.
 */
function pagesOfSpec(raw, total) {
  const spec = String(raw ?? '').trim()
  if (spec === '') throw new Error('pages: пустой диапазон')
  const numbers = []
  for (const part of spec.split(/[,;]/).map((value) => value.trim()).filter((value) => value !== '')) {
    const match = /^(\d+)\s*(?:[-–—]\s*(\d+))?$/.exec(part)
    if (match === null) throw new Error(`pages: неверный диапазон ${JSON.stringify(part)}`)
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      throw new Error(`pages: неверный диапазон ${JSON.stringify(part)}`)
    }
    if (to > total) {
      throw new Error(
        `pages: страницы ${from === to ? from : `${from}-${to}`} вне документа: всего ${total} ${total === 1 ? 'страница' : 'страниц'}`,
      )
    }
    for (let page = from; page <= to; page += 1) {
      if (!numbers.includes(page)) numbers.push(page)
    }
  }
  if (numbers.length === 0) throw new Error('pages: пустой диапазон')
  return numbers
}

/**
 * Page-aware reading of a PDF for `office read`: the selected pages with their
 * numbers, the pages without a text layer as images for the recognition model,
 * and the total of the document. The pages of a scan are capped exactly like
 * the pages of an attachment scan ({@link SCAN_PAGE_LIMIT}).
 */
async function pdfPages(data, pages) {
  const { extractText } = await import('unpdf')
  const result = await extractText(new Uint8Array(data), { mergePages: false })
  const texts = (Array.isArray(result.text) ? result.text : [String(result.text ?? '')]).map((text) =>
    String(text ?? '').trim(),
  )
  const total = Number(result.totalPages) || texts.length
  const ranged = pages !== undefined && pages !== null && String(pages).trim() !== ''
  let numbers
  if (ranged) {
    numbers = pagesOfSpec(pages, total)
  } else {
    numbers = []
    for (let page = 1; page <= Math.min(total, PDF_PAGE_LIMIT); page += 1) numbers.push(page)
  }
  const entries = numbers.map((page) => ({ page, text: texts[page - 1] ?? '' }))
  const withoutText = entries.filter((entry) => entry.text === '').map((entry) => entry.page)
  const shown = withoutText.slice(0, SCAN_PAGE_LIMIT)

  let rendered = { images: [], failures: [], total }
  if (shown.length > 0) {
    try {
      rendered = await renderScanPages(data, total, shown)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      rendered = { images: [], failures: shown.map((page) => ({ page, reason })), total }
    }
  }

  const notes = []
  if (!ranged && total > PDF_PAGE_LIMIT) {
    notes.push(`всего ${total} ${total === 1 ? 'страница' : 'страниц'}, укажите pages для остальных`)
  }
  if (withoutText.length > shown.length) {
    notes.push(
      `страницы без текста: распознаны первые ${shown.length} из ${withoutText.length}, остальные не переданы`,
    )
  }
  return {
    ok: true,
    kind: entries.every((entry) => entry.text === '') ? 'scan' : 'text',
    pages: entries,
    ...(rendered.images.length === 0 ? {} : { images: rendered.images }),
    ...(rendered.failures.length === 0 ? {} : { failedPages: rendered.failures }),
    pageCount: total,
    shownPages: rendered.images.length,
    remaining: Math.max(0, withoutText.length - rendered.images.length),
    ...(notes.length === 0 ? {} : { note: notes.join(' ') }),
    notes: [],
  }
}

// --- page rendering for scans --------------------------------------------------------------
//
// A scan has no text layer, so the only way to show a local model what is on
// the page is to paint the page. This is a small rasterizer for the drawing
// operations a PDF page uses in practice: paths (filled and stroked), images
// embedded into the page (8-bit gray, RGB, RGBA and the one-bit images and
// stencil masks scanners write) and form XObjects. Text is not painted because a scan
// page has no text layer by definition; a page that mixes text and pictures
// already has a text layer and goes through `extractText` instead.
//
// No canvas, no native module: the operator list comes from the PDF.js build
// inside `unpdf`, embedded images are decoded by PDF.js itself, and the result
// is encoded to JPEG by the pure JavaScript `jpeg-js`.

function matrixMultiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
}

function applyMatrix(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
}

function colorOf(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const hex = /^#([0-9a-f]{6})$/i.exec(text)
  if (hex !== null) {
    const number = Number.parseInt(hex[1], 16)
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
  }
  if (Array.isArray(value) && value.length >= 3) {
    return value.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(Number(part) * 255))))
  }
  return [0, 0, 0]
}

function blankPage(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  pixels.fill(255)
  return pixels
}

function setPixel(pixels, width, height, x, y, color) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= width || py >= height) return
  const at = (py * width + px) * 4
  pixels[at] = color[0]
  pixels[at + 1] = color[1]
  pixels[at + 2] = color[2]
  pixels[at + 3] = 255
}

/** Even-odd scanline fill of one path (already in device coordinates). */
function fillPolygon(pixels, width, height, subpaths, color) {
  const edges = []
  let minY = Infinity
  let maxY = -Infinity
  for (const points of subpaths) {
    if (points.length < 2) continue
    for (let i = 0; i < points.length; i += 1) {
      const [x0, y0] = points[i]
      const [x1, y1] = points[(i + 1) % points.length]
      if (y0 === y1) continue
      edges.push([x0, y0, x1, y1])
      minY = Math.min(minY, y0, y1)
      maxY = Math.max(maxY, y0, y1)
    }
  }
  if (edges.length === 0) return
  const top = Math.max(0, Math.floor(minY))
  const bottom = Math.min(height - 1, Math.ceil(maxY))
  const crossings = []
  for (let y = top; y <= bottom; y += 1) {
    const sample = y + 0.5
    crossings.length = 0
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= sample && y1 > sample) || (y1 <= sample && y0 > sample)) {
        crossings.push(x0 + ((sample - y0) / (y1 - y0)) * (x1 - x0))
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((left, right) => left - right)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i]))
      const to = Math.min(width - 1, Math.floor(crossings[i + 1]))
      for (let x = from; x <= to; x += 1) setPixel(pixels, width, height, x, y, color)
    }
  }
}

function strokeSegments(pixels, width, height, subpaths, color) {
  for (const points of subpaths) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const [x0, y0] = points[i]
      const [x1, y1] = points[i + 1]
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))
      for (let step = 0; step <= steps; step += 1) {
        setPixel(pixels, width, height, x0 + ((x1 - x0) * step) / steps, y0 + ((y1 - y0) * step) / steps, color)
      }
    }
  }
}

/** `ImageKind` of PDF.js: how the pixels of a decoded image are laid out. */
const IMAGE_GRAYSCALE_1BPP = 1
const IMAGE_RGB_24BPP = 2
const IMAGE_RGBA_32BPP = 3

/**
 * Pixel reader of one decoded PDF.js image: `(x, y) => [r, g, b, alpha]` with
 * `y = 0` at the top row. Throws with a reason when the layout is not one this
 * rasterizer can read, so the page is reported instead of painted blank.
 */
function imageSampler(image) {
  const sourceWidth = Number(image?.width)
  const sourceHeight = Number(image?.height)
  const data = image?.data
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error('у изображения нет размеров')
  if (data === undefined || data === null || typeof data.length !== 'number') {
    throw new Error(image?.bitmap !== undefined ? 'изображение пришло растровым объектом без пикселей' : 'у изображения нет пикселей')
  }
  const pixelCount = sourceWidth * sourceHeight
  let kind = Number(image?.kind)
  if (!(kind >= IMAGE_GRAYSCALE_1BPP && kind <= IMAGE_RGBA_32BPP)) {
    // Inline images of old PDF.js builds come without `kind`: infer it from the size.
    const channels = data.length / pixelCount
    kind = channels === 3 ? IMAGE_RGB_24BPP : channels === 4 ? IMAGE_RGBA_32BPP : channels === 1 ? -1 : 0
    if (kind === 0) throw new Error(`неизвестный формат пикселей изображения ${sourceWidth}×${sourceHeight}`)
  }
  if (kind === IMAGE_GRAYSCALE_1BPP) {
    // One bit per pixel, most significant bit first, every row padded to a byte;
    // PDF.js already applied the Decode array, so 1 is white and 0 is black.
    const rowBytes = (sourceWidth + 7) >> 3
    if (data.length < rowBytes * sourceHeight) throw new Error('данные однобитного изображения короче его размеров')
    return {
      width: sourceWidth,
      height: sourceHeight,
      sample: (x, y) => {
        const value = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
        return [value, value, value, 1]
      },
    }
  }
  if (kind === -1) {
    if (data.length < pixelCount) throw new Error('данные изображения короче его размеров')
    return { width: sourceWidth, height: sourceHeight, sample: (x, y) => { const v = data[y * sourceWidth + x]; return [v, v, v, 1] } }
  }
  const channels = kind === IMAGE_RGB_24BPP ? 3 : 4
  if (data.length < pixelCount * channels) throw new Error('данные изображения короче его размеров')
  return {
    width: sourceWidth,
    height: sourceHeight,
    sample: (x, y) => {
      const at = (y * sourceWidth + x) * channels
      return [data[at], data[at + 1], data[at + 2], channels === 4 ? data[at + 3] / 255 : 1]
    },
  }
}

/**
 * Pixel reader of a stencil mask (`ImageMask true`): packed bits as PDF.js
 * hands them to its own canvas, 0 paints the fill colour and 1 leaves the page.
 */
function maskSampler(mask, color) {
  const sourceWidth = Number(mask?.width)
  const sourceHeight = Number(mask?.height)
  const data = mask?.data
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) throw new Error('у маски изображения нет размеров')
  const rowBytes = (sourceWidth + 7) >> 3
  if (data === undefined || data === null || typeof data.length !== 'number' || data.length < rowBytes * sourceHeight) {
    throw new Error('данные маски изображения короче её размеров')
  }
  const paint = [color[0], color[1], color[2], 1]
  return {
    width: sourceWidth,
    height: sourceHeight,
    sample: (x, y) => ((data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? null : paint),
  }
}

/** Draw an image (through its sampler) into the unit square of the current transform. */
function paintImage(pixels, width, height, matrix, source) {
  const { width: sourceWidth, height: sourceHeight, sample } = source

  const corners = [applyMatrix(matrix, 0, 0), applyMatrix(matrix, 1, 0), applyMatrix(matrix, 0, 1), applyMatrix(matrix, 1, 1)]
  const minX = Math.floor(Math.min(...corners.map((point) => point[0])))
  const maxX = Math.ceil(Math.max(...corners.map((point) => point[0])))
  const minY = Math.floor(Math.min(...corners.map((point) => point[1])))
  const maxY = Math.ceil(Math.max(...corners.map((point) => point[1])))

  const [a, b, c, d, e, f] = matrix
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return
  for (let y = Math.max(0, minY); y <= Math.min(height - 1, maxY); y += 1) {
    for (let x = Math.max(0, minX); x <= Math.min(width - 1, maxX); x += 1) {
      const dx = x + 0.5 - e
      const dy = y + 0.5 - f
      const u = (d * dx - c * dy) / det
      const v = (-b * dx + a * dy) / det
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue
      const sx = Math.min(sourceWidth - 1, Math.floor(u * sourceWidth))
      const sy = Math.min(sourceHeight - 1, Math.floor((1 - v) * sourceHeight))
      const color = sample(sx, sy)
      if (color === null) continue
      const alpha = color[3]
      if (alpha <= 0) continue
      const target = (y * width + x) * 4
      if (alpha >= 1) {
        pixels[target] = color[0]
        pixels[target + 1] = color[1]
        pixels[target + 2] = color[2]
      } else {
        pixels[target] = Math.round(color[0] * alpha + pixels[target] * (1 - alpha))
        pixels[target + 1] = Math.round(color[1] * alpha + pixels[target + 1] * (1 - alpha))
        pixels[target + 2] = Math.round(color[2] * alpha + pixels[target + 2] * (1 - alpha))
      }
      pixels[target + 3] = 255
    }
  }
}

/** Flatten a path command list of PDF.js (`constructPath` arguments) into polylines. */
function buildPath(commandData) {
  const subpaths = []
  let current = []
  let index = 0
  const number = () => Number(commandData[index++])
  const finish = () => {
    if (current.length > 0) subpaths.push(current)
    current = []
  }
  while (index < commandData.length) {
    const command = commandData[index++]
    if (command === 0) {
      finish()
      current = [[number(), number()]]
    } else if (command === 1) {
      current.push([number(), number()])
    } else if (command === 2) {
      const x0 = current.length > 0 ? (current[current.length - 1]?.[0] ?? 0) : 0
      const y0 = current.length > 0 ? (current[current.length - 1]?.[1] ?? 0) : 0
      const x1 = number()
      const y1 = number()
      const x2 = number()
      const y2 = number()
      const x3 = number()
      const y3 = number()
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8
        const mt = 1 - t
        current.push([
          mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
          mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
        ])
      }
    } else if (command === 3) {
      const x0 = current.length > 0 ? (current[current.length - 1]?.[0] ?? 0) : 0
      const y0 = current.length > 0 ? (current[current.length - 1]?.[1] ?? 0) : 0
      const x1 = number()
      const y1 = number()
      const x2 = number()
      const y2 = number()
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8
        const mt = 1 - t
        current.push([
          mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
          mt * mt * y0 + 2 * mt * t * y1 + t * t * y2,
        ])
      }
    } else if (command === 4) {
      finish()
    } else {
      // Unknown command: the rest of the stream cannot be aligned reliably.
      break
    }
  }
  finish()
  return subpaths
}

/** An embedded image that PDF.js resolved to nothing: it could not decode it. */
class ImageLostError extends Error {
  constructor(key) {
    super('встроенное изображение не декодировано')
    this.key = key
  }
}

/** A decoded page object never came back from PDF.js; the page is reported instead of waited for. */
const IMAGE_WAIT_MS = 10_000

function resolvePageObject(page, key) {
  const objects = key.startsWith('g_') ? page.commonObjs : page.objs
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`изображение ${key} не получено за ${IMAGE_WAIT_MS / 1000} с`)), IMAGE_WAIT_MS)
    try {
      objects.get(key, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}

/** Short model-facing reason of one lost image; PDF.js names the decoder error only in its warning. */
function imageProblem(error, warnings) {
  let reason = error instanceof Error ? error.message : String(error)
  if (error instanceof ImageLostError) {
    const warning = [...warnings].reverse().find((line) => line.includes(`"${error.key}"`))
    const detail = warning === undefined ? '' : /:\s*"([^"]*)"\.?\s*$/.exec(warning)?.[1] ?? warning
    if (detail !== '') reason = `${reason} (${detail})`
  }
  return reason.replace(/\s+/g, ' ').trim().slice(0, 200)
}

// PDF.js reports a failed image decode only through `console.warn`; while a
// scan is rendered those warnings are collected so the note can name the reason.
const warningListeners = new Set()
let originalConsoleWarn = null

function collectWarnings(listener) {
  if (warningListeners.size === 0) {
    originalConsoleWarn = console.warn
    console.warn = (...parts) => {
      const line = parts.map(String).join(' ').trim()
      if (line.startsWith('Warning: ')) {
        for (const each of warningListeners) each(line)
        return
      }
      originalConsoleWarn?.(...parts)
    }
  }
  warningListeners.add(listener)
  return () => {
    warningListeners.delete(listener)
    if (warningListeners.size === 0 && originalConsoleWarn !== null) {
      console.warn = originalConsoleWarn
      originalConsoleWarn = null
    }
  }
}

async function renderPdfPage(page, pdfjs, warnings) {
  const { OPS } = pdfjs
  const unscaled = page.getViewport({ scale: 1 })
  const scale = Math.min(PAGE_MAX_WIDTH / unscaled.width, PAGE_MAX_HEIGHT / unscaled.height, PAGE_MAX_SCALE)
  // The viewport transform already carries the page rotation, the crop box
  // origin and the flip from PDF y-up to device y-down.
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const pixels = blankPage(width, height)
  const base = [...viewport.transform]

  const operators = await page.getOperatorList()
  let state = { matrix: base, fill: [0, 0, 0], stroke: [0, 0, 0] }
  const stack = []
  let path = []
  let pendingPathPaint = null

  const toDevice = (subpaths) => subpaths.map((points) => points.map(([x, y]) => applyMatrix(state.matrix, x, y)))
  const problems = []

  const paintAt = (matrix, source) => paintImage(pixels, width, height, matrix, source)
  // A stencil mask comes either inline or as a page object of its own.
  const maskOf = async (mask) => (typeof mask?.data === 'string' ? await decoded(mask.data) : mask)
  const decoded = async (value) => {
    if (typeof value !== 'string') return value
    const image = await resolvePageObject(page, value)
    if (image === null || image === undefined) throw new ImageLostError(value)
    return image
  }
  const paintImageOperator = async (fn, args) => {
    if (fn === OPS.paintImageXObject) {
      paintAt(state.matrix, imageSampler(await decoded(String(args?.[0]))))
    } else if (fn === OPS.paintInlineImageXObject) {
      paintAt(state.matrix, imageSampler(await decoded(args?.[0])))
    } else if (fn === OPS.paintImageXObjectRepeat) {
      const source = imageSampler(await decoded(String(args?.[0])))
      const positions = args?.[3] ?? []
      for (let at = 0; at + 1 < positions.length; at += 2) {
        paintAt(matrixMultiply(state.matrix, [args[1], 0, 0, args[2], positions[at], positions[at + 1]]), source)
      }
    } else if (fn === OPS.paintInlineImageXObjectGroup) {
      // One atlas image, every map entry is its own rectangle of it.
      const atlas = imageSampler(await decoded(args?.[0]))
      for (const entry of args?.[1] ?? []) {
        const { x = 0, y = 0, w, h, transform } = entry ?? {}
        if (!(w > 0) || !(h > 0) || !Array.isArray(transform)) throw new Error('повреждена группа встроенных изображений')
        paintAt(matrixMultiply(state.matrix, transform), {
          width: w,
          height: h,
          sample: (sx, sy) => atlas.sample(Math.min(atlas.width - 1, x + sx), Math.min(atlas.height - 1, y + sy)),
        })
      }
    } else if (fn === OPS.paintImageMaskXObject) {
      paintAt(state.matrix, maskSampler(await maskOf(args?.[0]), state.fill))
    } else if (fn === OPS.paintImageMaskXObjectRepeat) {
      const source = maskSampler(await maskOf(args?.[0]), state.fill)
      const positions = args?.[5] ?? []
      for (let at = 0; at + 1 < positions.length; at += 2) {
        paintAt(matrixMultiply(state.matrix, [args[1], args[2] ?? 0, args[3] ?? 0, args[4], positions[at], positions[at + 1]]), source)
      }
    } else if (fn === OPS.paintImageMaskXObjectGroup) {
      for (const mask of args?.[0] ?? []) {
        const transform = Array.isArray(mask?.transform) && mask.transform.length === 6 ? mask.transform : [1, 0, 0, 1, 0, 0]
        paintAt(matrixMultiply(state.matrix, transform), maskSampler(await maskOf(mask), state.fill))
      }
    } else if (fn === OPS.paintSolidColorImageMask) {
      const color = [state.fill[0], state.fill[1], state.fill[2], 1]
      paintAt(state.matrix, { width: 1, height: 1, sample: () => color })
    }
  }

  for (let i = 0; i < operators.fnArray.length; i += 1) {
    const fn = operators.fnArray[i]
    const args = operators.argsArray[i]
    if (fn === OPS.save) {
      stack.push({ ...state, matrix: [...state.matrix], fill: [...state.fill], stroke: [...state.stroke] })
    } else if (fn === OPS.restore) {
      const saved = stack.pop()
      if (saved !== undefined) state = saved
    } else if (fn === OPS.transform) {
      state = { ...state, matrix: matrixMultiply(state.matrix, args) }
    } else if (fn === OPS.setFillRGBColor) {
      state = { ...state, fill: colorOf(args?.[0]) }
    } else if (fn === OPS.setStrokeRGBColor) {
      state = { ...state, stroke: colorOf(args?.[0]) }
    } else if (fn === OPS.setFillGray) {
      const value = Math.max(0, Math.min(255, Math.round(Number(args?.[0] ?? 0) * 255)))
      state = { ...state, fill: [value, value, value] }
    } else if (fn === OPS.setStrokeGray) {
      const value = Math.max(0, Math.min(255, Math.round(Number(args?.[0] ?? 0) * 255)))
      state = { ...state, stroke: [value, value, value] }
    } else if (fn === OPS.constructPath) {
      const paint = args?.[0]
      const commands = args?.[1]
      path = Array.isArray(commands) || commands instanceof Float32Array ? buildPath(commands) : []
      pendingPathPaint = paint
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat ||
      fn === OPS.paintInlineImageXObjectGroup ||
      fn === OPS.paintImageMaskXObject ||
      fn === OPS.paintImageMaskXObjectRepeat ||
      fn === OPS.paintImageMaskXObjectGroup ||
      fn === OPS.paintSolidColorImageMask
    ) {
      // A page with a lost picture is not the page of the scan: the image the
      // owner sent is that picture. The reason is kept, the page is reported.
      try {
        await paintImageOperator(fn, args)
      } catch (error) {
        problems.push(imageProblem(error, warnings))
      }
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push({ ...state, matrix: [...state.matrix], fill: [...state.fill], stroke: [...state.stroke] })
      if (Array.isArray(args?.[0]) && args[0].length === 6) state = { ...state, matrix: matrixMultiply(state.matrix, args[0]) }
    } else if (fn === OPS.paintFormXObjectEnd) {
      const saved = stack.pop()
      if (saved !== undefined) state = saved
    }

    if (pendingPathPaint !== null && path.length > 0 && fn === OPS.constructPath) {
      const device = toDevice(path)
      if (pendingPathPaint === OPS.fill || pendingPathPaint === OPS.eoFill) {
        fillPolygon(pixels, width, height, device, state.fill)
      } else if (pendingPathPaint === OPS.stroke) {
        strokeSegments(pixels, width, height, device, state.stroke)
      }
      pendingPathPaint = null
      path = []
    }
  }
  return { width, height, pixels, problems }
}

/**
 * Render up to `SCAN_PAGE_LIMIT` pages of a scan to JPEG; page order is kept.
 * A page that could not be drawn completely is not shown: it is listed in
 * `failures` with the reason and the next page is rendered.
 */
async function renderScanPages(data, totalPages, pageNumbers) {
  const { getDocumentProxy, getResolvedPDFJS } = await import('unpdf')
  const jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js'))
  const pdfjs = await getResolvedPDFJS()
  const warnings = []
  const stopCollecting = collectWarnings((line) => warnings.push(line))
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data))
    const total = Number(totalPages) > 0 ? Number(totalPages) : pdf.numPages
    const wanted =
      Array.isArray(pageNumbers) && pageNumbers.length > 0
        ? [...new Set(pageNumbers)].filter((number) => number >= 1 && number <= total)
        : Array.from({ length: Math.max(0, Math.min(total, SCAN_PAGE_LIMIT)) }, (_, index) => index + 1)
    const images = []
    const failures = []
    const started = Date.now()
    let attempted = 0
    for (const number of wanted) {
      if (Date.now() - started > SCAN_RENDER_BUDGET_MS) break
      attempted = number
      warnings.length = 0
      try {
        const page = await pdf.getPage(number)
        const rendered = await renderPdfPage(page, pdfjs, warnings)
        if (rendered.problems.length > 0) {
          failures.push({ page: number, reason: [...new Set(rendered.problems)].join('; ') })
          continue
        }
        const encoded = jpeg.encode(
          { data: Buffer.from(rendered.pixels.buffer, rendered.pixels.byteOffset, rendered.pixels.byteLength), width: rendered.width, height: rendered.height },
          PAGE_JPEG_QUALITY,
        ).data
        images.push({ page: number, mediaType: 'image/jpeg', data: Uint8Array.from(encoded) })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push({ page: number, reason: reason.replace(/\s+/g, ' ').trim().slice(0, 200) || 'неизвестная ошибка' })
      }
    }
    return { images, failures, total, attempted }
  } finally {
    stopCollecting()
  }
}

async function docxText(data) {
  checkZip(data)
  const mammoth = await import('mammoth')
  const converter = mammoth.default ?? mammoth
  // The task brief calls this `convertToRawText`; mammoth 1.13 exports the
  // same raw-text conversion as `extractRawText`.
  const convertToRawText = (buffer) => converter.extractRawText({ buffer })
  const result = await convertToRawText(Buffer.from(data))
  return String(result.value ?? '')
}

/** PPTX and ODT are zip archives of XML: take the paragraphs of their parts. */
async function zipXmlText(data, kind) {
  checkZip(data)
  const JSZip = (await import('jszip')).default
  const archive = await JSZip.loadAsync(Buffer.from(data))
  const names = Object.keys(archive.files)
  let parts
  if (kind === 'pptx') {
    parts = names
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => Number(/(\d+)\.xml$/.exec(left)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(right)?.[1] ?? 0))
  } else {
    parts = names.filter((name) => name === 'content.xml')
  }
  const chunks = []
  for (const name of parts) {
    const xml = await archive.file(name)?.async('string')
    if (xml === undefined) continue
    const text = await xmlText(xml)
    if (text !== '') chunks.push(kind === 'pptx' ? `--- слайд ${parts.indexOf(name) + 1} ---\n${text}` : text)
  }
  return chunks.join('\n\n')
}

function textOfBytes(data) {
  const text = Buffer.from(data).toString('utf8')
  // A binary file decoded as UTF-8 is full of NUL bytes: it is not text.
  if (text.includes('\u0000')) return ''
  return text
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(name)
  return match === null ? '' : match[1].toLowerCase()
}

// --- ZIP archives --------------------------------------------------------------------------

/**
 * An entry whose path escapes the archive root. Both separators are honoured
 * because a Windows-made archive may carry `..\` names; nothing of such an
 * entry is ever decompressed or written.
 */
function unsafeEntryName(name) {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return true
  if (/^[A-Za-z]:/.test(normalized)) return true
  return normalized.split('/').includes('..')
}

/**
 * The name an entry would get from a path-resolving reader (JSZip resolves `.`
 * and `..` the same way): two entries with the same key are ambiguous, and
 * neither is read, so `../fine.txt` can never pass for `fine.txt`.
 */
function entryKey(name) {
  const parts = []
  for (const part of name.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

const LOCAL_SIGNATURE = 0x04034b50

/**
 * Bytes of one entry, read at the local header offset of its own central
 * directory record. A lookup by name would let another record with the same
 * normalized name hand over its data. Inflation stops one byte past the
 * declared size, so a lying record cannot unpack more than the guard allowed.
 */
function entryData(view, entry) {
  if ((entry.flags & 0x1) !== 0) throw new Error('запись зашифрована')
  const at = entry.localOffset
  if (at + 30 > view.length || view.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw new Error('повреждён локальный заголовок записи')
  }
  const start = at + 30 + view.readUInt16LE(at + 26) + view.readUInt16LE(at + 28)
  const end = start + entry.compressedSize
  if (end > view.length) throw new Error('данные записи выходят за границы архива')
  const packed = view.subarray(start, end)
  let content
  if (entry.method === 0) {
    content = Buffer.from(packed)
  } else if (entry.method === 8) {
    try {
      content = inflateRawSync(packed, { maxOutputLength: entry.size + 1 })
    } catch {
      throw new Error('распакованный размер не совпадает с заявленным или данные повреждены')
    }
  } else {
    throw new Error(`метод сжатия ${entry.method} не поддерживается`)
  }
  if (content.length !== entry.size) throw new Error('распакованный размер не совпадает с заявленным')
  if (crc32(content) >>> 0 !== entry.crc >>> 0) throw new Error('контрольная сумма записи не совпадает')
  return content
}

/** MIME of an archive entry from its name; the bot knows no other source there. */
function mimeOfEntry(name) {
  const extension = extensionOf(name)
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (extension === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (extension === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  if (extension === 'odt') return 'application/vnd.oasis.opendocument.text'
  if (/^(?:txt|md|csv|json|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|yaml|yml|toml|ini|conf|sh|sql|html|css|xml)$/.test(extension)) {
    return 'text/plain'
  }
  return 'application/octet-stream'
}

/** Entries the worker is allowed to read: text and the documents it already parses. */
function readableEntry(name) {
  const extension = extensionOf(name)
  return (
    /^(?:pdf|docx|xlsx|pptx|odt)$/.test(extension) ||
    /^(?:txt|md|csv|json|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|yaml|yml|toml|ini|conf|sh|sql|html|css|xml)$/.test(extension)
  )
}

/**
 * A ZIP archive: the model gets every entry with its declared size, and the
 * readable entries (text and the supported documents) are extracted like an
 * ordinary attachment. All extracted text of one archive shares a single text
 * limit, and the entry list has a limit of its own, so neither a thousand big
 * files nor 65000 empty ones can fill the prompt. A nested archive is listed
 * but stays packed, and an entry with an unsafe or an ambiguous path is
 * listed with a mark, never read. The guard rejects a zip bomb before anything
 * is inflated, and every entry is read by its own directory record.
 */
async function zipArchive(data, name) {
  const entries = listZipEntries(data)
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const keys = new Map()
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const key = entryKey(entry.name)
    keys.set(key, (keys.get(key) ?? 0) + 1)
  }
  // The list and the extracted text have budgets of their own, both within one
  // TEXT_LIMIT: an archive of thousand 60000-character entries must not put
  // 60 MB into the prompt, and neither must an archive of 65000 empty entries.
  const lines = []
  let listingLength = 0
  let listingCut = false
  const LISTING_RESERVE = 200
  function pushLine(line) {
    if (listingCut) return
    const delimiter = lines.length === 0 ? 0 : 1
    if (listingLength + delimiter + line.length > TEXT_LIMIT - LISTING_RESERVE) {
      listingCut = true
      return
    }
    lines.push(line)
    listingLength += delimiter + line.length
  }
  const extracted = []
  let textBudget = TEXT_LIMIT
  pushLine(`Содержимое архива ${name}: файлов ${entries.length}.`)
  for (const entry of entries) {
    const entryName = entry.name
    if (entryName.endsWith('/')) {
      pushLine(`${entryName} — каталог`)
      continue
    }
    const size = entry.size
    if (unsafeEntryName(entryName)) {
      pushLine(`${entryName} — ${size} байт — небезопасный путь, запись не разобрана`)
      continue
    }
    if ((keys.get(entryKey(entryName)) ?? 0) > 1) {
      pushLine(`${entryName} — ${size} байт — неоднозначное имя (совпадает с другой записью архива), запись не разобрана`)
      continue
    }
    if (/\.zip$/i.test(entryName)) {
      pushLine(`${entryName} — ${size} байт — вложенный архив, не распаковывается`)
      continue
    }
    if (!readableEntry(entryName)) {
      pushLine(`${entryName} — ${size} байт`)
      continue
    }
    try {
      if (size > ZIP_ENTRY_LIMIT) {
        pushLine(`${entryName} — ${size} байт — запись больше 50 МБ, не разобрана`)
        continue
      }
      if (textBudget < 200) {
        pushLine(`${entryName} — ${size} байт — не показано: лимит текста архива`)
        continue
      }
      const content = entryData(view, entry)
      const mime = mimeOfEntry(entryName)
      // Pages of a scan inside an archive are not drawn: only text of the
      // entries reaches the request, so the entry gets a note instead.
      const result = await extractData(content, entryName, mime, false)
      if (result.kind === 'text' || result.kind === 'scan') {
        const text =
          result.kind === 'scan'
            ? `Скан из ${result.pageCount ?? 0} ${pageWord(result.pageCount ?? 0)}, текстового слоя нет; страницы сканов внутри архива не показываются.`
            : (result.text ?? '')
        // The last entry that still fits is cut to the rest of the shared
        // budget with its own partial marker, so a long file keeps a head.
        // Once nothing is left the entry is only listed as not shown.
        const shown = text.length > textBudget ? cutToBudget(text, textBudget) : text
        textBudget -= shown.length
        pushLine(`${entryName} — ${size} байт`)
        extracted.push({ name: entryName, mime, size, text: shown })
      } else {
        pushLine(`${entryName} — ${size} байт — ${result.text ?? 'не разобрано'}`)
      }
    } catch (error) {
      pushLine(`${entryName} — ${size} байт — не разобран: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (listingCut) {
    // The header is always the first line: the rest are the entry lines that
    // fit before the budget ran out.
    const shownEntries = lines.length > 0 && lines[0].startsWith('Содержимое архива ') ? lines.length - 1 : lines.length
    const note = partialNote(shownEntries, entries.length, 'записей')
    listingLength += (lines.length === 0 ? 0 : 1) + note.length
    lines.push(note)
  }
  return { ok: true, kind: 'archive', text: lines.join('\n'), notes: [], entries: extracted }
}

/** Whether a file of the inbox is a ZIP archive, by MIME or by name. */
function isArchiveName(name, mime) {
  const kind = String(mime ?? '').toLowerCase()
  return kind === 'application/zip' || kind === 'application/x-zip-compressed' || extensionOf(name) === 'zip'
}

export async function extract({ path, name, mime, renderPages = true, pages, pageMode = false }) {
  const data = await readFile(path)
  if (isArchiveName(name, mime)) {
    if (pageMode && pages !== undefined && String(pages).trim() !== '') {
      throw new Error('pages только для PDF: диапазон страниц есть только у PDF')
    }
    return await zipArchive(data, name)
  }
  return await extractData(data, name, mime, renderPages, { pages, pageMode })
}

/** One file already in memory: the classifiers and limits of `extract`, reused per archive entry. */
async function extractData(data, name, mime, renderPages = true, pageOptions = {}) {
  const notes = []
  const extension = extensionOf(name)
  const kind = String(mime ?? '').toLowerCase()
  const pageMode = pageOptions.pageMode === true
  const pages = pageOptions.pages
  const ranged = pages !== undefined && pages !== null && String(pages).trim() !== ''
  const isPdf = kind === 'application/pdf' || extension === 'pdf'
  if (pageMode && ranged && !isPdf) throw new Error('pages только для PDF: диапазон страниц есть только у PDF')

  let text = ''
  let resultKind = 'text'
  if (isPdf) {
    if (pageMode) return await pdfPages(data, ranged ? pages : undefined)
    const result = await pdfText(data, notes)
    text = result.text
    resultKind = result.kind
    if (resultKind === 'scan') {
      const total = result.totalPages
      if (!renderPages) {
        return { ok: true, kind: 'scan', text: scanNote(total, []), pageCount: total, shownPages: 0, remaining: total, notes: [] }
      }
      try {
        const rendered = await renderScanPages(data, total)
        const failures = rendered.failures
        if (rendered.images.length === 0 && failures.length === 0) {
          const reason = rendered.total > 0 ? 'ни одной страницы не удалось нарисовать' : 'в PDF не найдено страниц'
          return {
            ok: true,
            kind: 'scan',
            text: `Скан из ${rendered.total} ${pageWord(rendered.total)}, но не удалось получить изображения страниц: ${reason}.`,
            pageCount: rendered.total,
            shownPages: 0,
            remaining: rendered.total,
            notes: [],
          }
        }
        return {
          ok: true,
          kind: 'scan',
          text: scanNote(rendered.total, rendered.images, failures),
          ...(rendered.images.length === 0 ? {} : { images: rendered.images }),
          ...(failures.length === 0 ? {} : { failedPages: failures }),
          pageCount: rendered.total,
          shownPages: rendered.images.length,
          remaining: Math.max(0, rendered.total - rendered.images.length),
          notes: [],
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          ok: true,
          kind: 'scan',
          text: `Скан из ${total} ${pageWord(total)}, но не удалось получить изображения страниц: ${reason}.`,
          pageCount: total,
          shownPages: 0,
          remaining: total,
          notes: [],
        }
      }
    }
  } else if (
    kind === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'docx'
  ) {
    text = await docxText(data)
  } else if (
    kind === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    extension === 'xlsx'
  ) {
    text = await xlsxText(data, notes)
  } else if (
    kind === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    extension === 'pptx'
  ) {
    text = await zipXmlText(data, 'pptx')
  } else if (kind === 'application/vnd.oasis.opendocument.text' || extension === 'odt') {
    text = await zipXmlText(data, 'odt')
  } else if (/^(text\/|application\/(?:json|javascript|xml|x-yaml|yaml|x-sh|sql))/.test(kind) || /^(?:txt|md|csv|json|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cpp|yaml|yml|toml|ini|conf|sh|sql|html|css|xml)$/.test(extension)) {
    text = textOfBytes(data)
    if (text === '') {
      const final = finalizeText('файл не похож на текст', notes)
      return { ok: true, kind: 'unsupported', text: final.text, notes: [] }
    }
  } else if (/^(voice\/|audio\/)/.test(kind) || ['ogg', 'oga', 'mp3', 'm4a', 'wav', 'opus'].includes(extension)) {
    return { ok: true, kind: 'audio', text: 'распознавание речи не подключено', notes: [] }
  } else if (kind.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(extension)) {
    return {
      ok: true,
      kind: 'unsupported',
      text: 'видео сохранено, но не разбирается: извлечение кадров не подключено',
      notes: [],
    }
  } else {
    return { ok: true, kind: 'unsupported', text: 'формат пока не разбирается', notes: [] }
  }

  if (text.trim() === '') {
    const final = finalizeText('в файле не найден текст', notes)
    return { ok: true, kind: 'unsupported', text: final.text, notes: [] }
  }
  const final = finalizeText(text, notes)
  return { ok: true, kind: 'text', text: final.text, notes: [] }
}

if (parentPort !== null) {
  parentPort.once('message', async (message) => {
    try {
      const result = await extract(message ?? {})
      parentPort?.postMessage(result)
    } catch (error) {
      parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}
