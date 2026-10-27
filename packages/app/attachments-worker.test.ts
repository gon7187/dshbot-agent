// The extraction worker without the daemon: the ZIP guard walks the real central
// directory instead of trusting EOCD, the final text of one file stays within
// 60000 characters together with every note, and PPTX/ODT text comes from an XML
// parser library, not from regular expressions.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { crc32, deflateRawSync } from 'node:zlib'
import jpeg from 'jpeg-js'
import JSZip from 'jszip'
import { afterAll, expect, test } from 'vitest'

import { extract, scanZipEntries } from './src/attachments-worker.mjs'
import { attachmentText } from './src/attachments.js'

const MB = 1024 * 1024
const scratch = mkdtempSync(join(tmpdir(), 'dshbot-attachments-worker-'))
const workerEntry = fileURLToPath(new URL('./src/attachments-worker.mjs', import.meta.url))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface ZipEntry {
  name: string
  data: Buffer
  /** Uncompressed size written into the central directory (a lie for the bombs). */
  declaredSize?: number
}

function makeZip(entries: ZipEntry[], overrides: { eocdEntries?: number } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const packed = deflateRawSync(entry.data)
    const crc = crc32(entry.data) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const declared = overrides.eocdEntries ?? entries.length
  end.writeUInt16LE(declared, 8)
  end.writeUInt16LE(declared, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function textEntry(name: string, text: string, declaredSize?: number): ZipEntry {
  const data = Buffer.from(text, 'utf8')
  return declaredSize === undefined ? { name, data } : { name, data, declaredSize }
}

function docxZip(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')
  return makeZip([
    textEntry(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    ),
    textEntry(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    textEntry(
      'word/document.xml',
      `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  ])
}

function save(name: string, data: Buffer): string {
  const path = join(scratch, name)
  writeFileSync(path, data)
  return path
}

interface WorkerReply {
  ok: boolean
  text?: string
  notes?: string[]
  error?: string
}

function runWorker(input: { path: string; name: string; mime?: string }): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntry)
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('worker did not answer'))
    }, 30_000)
    worker.once('message', (message: WorkerReply) => {
      clearTimeout(timer)
      void worker.terminate().then(() => resolve(message))
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    worker.postMessage(input)
  })
}

// --- [libs] -----------------------------------------------------------------------------------------------

test('libs_pptx_and_odt_text_is_read_through_an_xml_parser', async () => {
  const pptx = makeZip([
    textEntry(
      'ppt/slides/slide1.xml',
      `${XML_HEAD}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><a:p><a:r><a:t>PPTXMARK-слайд</a:t></a:r></a:p></p:cSld></p:sld>`,
    ),
    textEntry(
      'ppt/slides/slide2.xml',
      `${XML_HEAD}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>SECOND-SLIDE</a:t></a:r></a:p></p:sld>`,
    ),
  ])
  const odt = makeZip([
    textEntry(
      'content.xml',
      `${XML_HEAD}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>ODTMARK-абзац</text:p><text:p>SECOND-ODT</text:p></office:text></office:body></office:document-content>`,
    ),
  ])

  const pptxResult = await extract({ path: save('zz.pptx', pptx), name: 'zz.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  expect(pptxResult.ok).toBe(true)
  expect(pptxResult.text).toContain('PPTXMARK-слайд')
  expect(pptxResult.text).toContain('SECOND-SLIDE')

  const odtResult = await extract({ path: save('zz.odt', odt), name: 'zz.odt', mime: 'application/vnd.oasis.opendocument.text' })
  expect(odtResult.ok).toBe(true)
  expect(odtResult.text).toContain('ODTMARK-абзац')
  expect(odtResult.text).toContain('SECOND-ODT')
})

// --- [bomb] -----------------------------------------------------------------------------------------------

test('bomb_eocd_claiming_zero_entries_does_not_hide_a_huge_entry', async () => {
  const bomb = makeZip([textEntry('word/document.xml', 'BOMBMARK-HIDDEN', 60 * MB)], { eocdEntries: 0 })
  const path = save('zzbomb-hidden.docx', bomb)
  expect(() => scanZipEntries(bomb)).toThrow(/не разобран/)
  await expect(extract({ path, name: 'zzbomb-hidden.docx', mime: docxMime() })).rejects.toThrow(
    /число записей|не разобран/,
  )

  const reply = await runWorker({ path, name: 'zzbomb-hidden.docx', mime: docxMime() })
  expect(reply.ok).toBe(false)
  expect(reply.error, 'the owner-facing reason names the rejected archive').toMatch(/не разобран/)
  const note = attachmentText(path, reply)
  expect(note, 'the analysis result carries the reason, not silence').toMatch(/не удалось разобрать/)
  expect(note).toMatch(/число записей|не разобран/)
})

test('bomb_entry_above_50_mb_is_rejected_by_the_real_directory_entry', async () => {
  const bomb = makeZip([textEntry('word/document.xml', 'BOMBMARK-BIG', 60 * MB)])
  const path = save('zzbomb-big.docx', bomb)
  expect(() => scanZipEntries(bomb)).toThrow(/больше 50 МБ/)
  await expect(extract({ path, name: 'zzbomb-big.docx', mime: docxMime() })).rejects.toThrow(/больше 50 МБ/)
})

test('bomb_total_above_100_mb_is_rejected', async () => {
  const bomb = makeZip([
    textEntry('a.bin', 'a', 40 * MB),
    textEntry('b.bin', 'b', 40 * MB),
    textEntry('c.bin', 'c', 40 * MB),
  ])
  expect(() => scanZipEntries(bomb)).toThrow(/больше 100 МБ/)
})

test('bomb_a_valid_archive_still_passes_the_guard', () => {
  const sizes = scanZipEntries(docxZip(['ordinary paragraph']))
  expect(sizes.entries).toBe(3)
  expect(sizes.total).toBeGreaterThan(0)
  expect(sizes.largest).toBeLessThan(1 * MB)
})

// --- [limits] ---------------------------------------------------------------------------------------------

test('limits_final_text_of_one_file_including_notes_is_at_most_60000_characters', async () => {
  const lines = ['HEADTOKEN-LIMIT']
  for (let i = 0; i < 5_000; i += 1) lines.push('y'.repeat(99))
  lines.push('TAILTOKEN-LIMIT')
  const path = save('zzlimit.txt', Buffer.from(lines.join('\n'), 'utf8'))
  const result = await extract({ path, name: 'zzlimit.txt', mime: 'text/plain' })

  expect(result.ok).toBe(true)
  const text = result.text ?? ''
  expect(text).toContain('HEADTOKEN-LIMIT')
  expect(text).not.toContain('TAILTOKEN-LIMIT')
  expect(text, 'the cut is marked').toContain('[Частично:')
  expect(text.length, 'content and every note together').toBeLessThanOrEqual(60_000)
  expect(text.match(/\[Частично:/g), 'the mark is not duplicated').toHaveLength(1)
  expect(result.notes ?? [], 'the parent has no notes left to append').toEqual([])
  const modelText = attachmentText(path, result)
  expect(modelText, 'the text the model receives is exactly the worker result').toBe(text)
  expect(modelText.length, 'the final text of the file is within the limit').toBeLessThanOrEqual(60_000)
})

test('limits_a_sheet_with_more_than_5000_rows_stays_within_60000_characters_with_its_notes', async () => {
  const rows: Array<Array<string>> = []
  for (let i = 1; i <= 6_000; i += 1) rows.push([`cell-${i}`])
  const path = save('zzlimit.xlsx', xlsxZip([{ name: 'Tall', rows }]))
  const result = await extract({
    path,
    name: 'zzlimit.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  expect(result.ok).toBe(true)
  const text = result.text ?? ''
  expect(text).toContain('cell-1')
  expect(text, 'row 5000 is the last one read').toContain('cell-5000')
  expect(text, 'row 5001 is cut').not.toContain('cell-5001')
  expect(text).toContain('[Частично:')
  expect(text.length).toBeLessThanOrEqual(60_000)
  expect(result.notes ?? []).toEqual([])
})

// --- [archive entries] ------------------------------------------------------------------------------------

test('archive_entry_with_a_safe_unnormalized_path_is_read_as_an_ordinary_attachment', async () => {
  const archive = makeZip([
    textEntry('./notes.txt', 'DOT_PATH_TEXT one'),
    textEntry('a/./b.txt', 'DOT_INNER_TEXT two'),
    textEntry('plain.txt', 'PLAIN_TEXT three'),
  ])
  const path = save('zzdots.zip', archive)
  const result = await extract({ path, name: 'zzdots.zip', mime: 'application/zip' })

  expect(result.ok).toBe(true)
  expect(result.kind).toBe('archive')
  const texts = Object.fromEntries((result.entries ?? []).map((entry) => [entry.name, entry.text ?? '']))
  expect(texts['./notes.txt']).toContain('DOT_PATH_TEXT')
  expect(texts['a/./b.txt']).toContain('DOT_INNER_TEXT')
  expect(texts['plain.txt'], 'positive control: an ordinary name').toContain('PLAIN_TEXT')
  expect(result.text).not.toMatch(/не удалось прочитать|не разобран/)
})

test('archive_entry_colliding_with_an_unsafe_path_after_normalization_is_not_read', async () => {
  const archive = makeZip([textEntry('fine.txt', 'SAFE_CONTENT'), textEntry('../fine.txt', 'UNSAFE_CONTENT')])
  // Positive control: a name-resolving reader really hands the unsafe data out
  // under the safe name, so looking entries up by name would leak it.
  const resolved = await JSZip.loadAsync(archive)
  expect(await resolved.file('fine.txt')?.async('string')).toBe('UNSAFE_CONTENT')

  const path = save('zzcollision.zip', archive)
  const result = await extract({ path, name: 'zzcollision.zip', mime: 'application/zip' })

  expect(result.ok).toBe(true)
  const told = JSON.stringify(result)
  expect(told, 'the unsafe entry is never read').not.toContain('UNSAFE_CONTENT')
  expect(told, 'the ambiguous twin is not read either').not.toContain('SAFE_CONTENT')
  expect(result.entries ?? []).toEqual([])
  expect(result.text).toMatch(/^fine\.txt — \d+ байт — неоднозначное имя/m)
  expect(result.text).toMatch(/^\.\.\/fine\.txt — \d+ байт — небезопасный путь/m)
})

test('archive_entry_inflating_past_its_declared_size_is_not_read', async () => {
  const archive = makeZip([
    textEntry('liar.txt', 'LIAR_CONTENT that is longer than declared', 4),
    textEntry('honest.txt', 'HONEST_CONTENT'),
  ])
  const path = save('zzliar.zip', archive)
  const result = await extract({ path, name: 'zzliar.zip', mime: 'application/zip' })

  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain('LIAR_CONTENT')
  expect(result.text).toMatch(/^liar\.txt — 4 байт — не разобран: .*не совпадает с заявленным/m)
  expect((result.entries ?? []).map((entry) => entry.text).join('\n'), 'positive control').toContain('HONEST_CONTENT')
})

// --- xlsx fixture -----------------------------------------------------------------------------------------

interface Sheet {
  name: string
  rows: Array<Array<string | number>>
}

function columnName(index: number): string {
  let name = ''
  let rest = index
  do {
    name = String.fromCharCode(65 + (rest % 26)) + name
    rest = Math.floor(rest / 26) - 1
  } while (rest >= 0)
  return name
}

function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xlsxZip(sheets: Sheet[]): Buffer {
  const strings: string[] = []
  const stringIndex = new Map<string, number>()
  const indexOf = (text: string): number => {
    const known = stringIndex.get(text)
    if (known !== undefined) return known
    strings.push(text)
    stringIndex.set(text, strings.length - 1)
    return strings.length - 1
  }
  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${columnName(c)}${r + 1}`
            return typeof value === 'number'
              ? `<c r="${ref}"><v>${value}</v></c>`
              : `<c r="${ref}" t="s"><v>${indexOf(value)}</v></c>`
          })
          .join('')
        return `<row r="${r + 1}">${cells}</row>`
      })
      .join('')
    return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  })
  const workbook = sheets
    .map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  const workbookRels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')
  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('')
  const shared = strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('')
  return makeZip([
    textEntry(
      '[Content_Types].xml',
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    textEntry(
      '_rels/.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    textEntry(
      'xl/workbook.xml',
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbook}</sheets></workbook>`,
    ),
    textEntry(
      'xl/_rels/workbook.xml.rels',
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRels}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    textEntry(
      'xl/sharedStrings.xml',
      `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${shared}</sst>`,
    ),
    textEntry(
      'xl/styles.xml',
      `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    ),
    ...sheetXml.map((xml, i) => textEntry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ])
}

function docxMime(): string {
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

// --- [scan] -----------------------------------------------------------------------------------------------
//
// Scanners write pages as one-bit images (or stencil masks); a page whose picture cannot be decoded is not a page
// of the scan, it is a failure with a reason.

interface ScanImagePage {
  /** Image dictionary entries except /Length. */
  dict: string
  data: Buffer
  /** Content stream; the image is `/Im1`. */
  content?: string
}

/** A PDF without a text layer: every page draws its own image XObject across most of the page. */
function imagePdf(pages: ScanImagePage[]): Buffer {
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let length = 0
  const push = (part: string | Buffer): void => {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'latin1') : part
    chunks.push(bytes)
    length += bytes.length
  }
  const objects: Array<Array<string | Buffer>> = []
  objects.push(['<< /Type /Catalog /Pages 2 0 R >>'])
  objects.push([`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`])
  pages.forEach((page, i) => {
    const base = 3 + 3 * i
    const content = page.content ?? 'q 612 0 0 612 0 90 cm /Im1 Do Q'
    objects.push([`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`])
    objects.push([`<< /Length ${content.length} >>\nstream\n${content}\nendstream`])
    objects.push([`<< /Type /XObject /Subtype /Image ${page.dict} /Length ${page.data.length} >>\nstream\n`, page.data, '\nendstream'])
  })
  push('%PDF-1.4\n')
  objects.forEach((parts, i) => {
    offsets.push(length)
    push(`${i + 1} 0 obj\n`)
    parts.forEach(push)
    push('\nendobj\n')
  })
  const xref = length
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  push(offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join(''))
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

const ONE_BIT = '/ColorSpace /DeviceGray /BitsPerComponent 1'

/** A one-bit image of `width` x `height` whose left `black` columns are 0 (black) and the rest 1 (white). */
function oneBitImage(width: number, height: number, black: number): Buffer {
  const rowBytes = (width + 7) >> 3
  const data = Buffer.alloc(rowBytes * height, 0)
  for (let y = 0; y < height; y += 1) {
    for (let x = black; x < width; x += 1) data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return data
}

function decodedPage(page: { data: Uint8Array }): { width: number; height: number; dark: (x: number, y: number) => boolean; darkCount: number } {
  const image = jpeg.decode(Buffer.from(page.data), { useTArray: true })
  let darkCount = 0
  for (let at = 0; at < image.data.length; at += 4) if ((image.data[at] ?? 255) < 128) darkCount += 1
  return {
    width: image.width,
    height: image.height,
    dark: (x, y) => (image.data[(Math.floor(y) * image.width + Math.floor(x)) * 4] ?? 255) < 128,
    darkCount,
  }
}

test('scan_a_black_one_bit_page_image_is_painted_not_left_white', async () => {
  const pdf = imagePdf([{ dict: `/Width 256 /Height 256 ${ONE_BIT}`, data: Buffer.alloc(32 * 256, 0) }])
  const result = await extract({ path: save('zzscan-1bpp.pdf', pdf), name: 'zzscan-1bpp.pdf', mime: 'application/pdf' })
  expect(result.kind).toBe('scan')
  expect(result.images?.length).toBe(1)
  expect(result.failedPages).toBeUndefined()
  const page = decodedPage(result.images![0]!)
  // The image covers 612 x 612 of a 612 x 792 page: most of the rendered page is black.
  expect(page.darkCount).toBeGreaterThan(page.width * page.height * 0.6)
})

test('scan_one_bit_rows_are_unpacked_most_significant_bit_first_with_byte_padding', async () => {
  // 13 columns: every row is padded to 2 bytes; the left 4 columns are black, the rest white.
  const pdf = imagePdf([{ dict: `/Width 13 /Height 6 ${ONE_BIT}`, data: oneBitImage(13, 6, 4) }])
  const result = await extract({ path: save('zzscan-1bpp-odd.pdf', pdf), name: 'zzscan-1bpp-odd.pdf', mime: 'application/pdf' })
  expect(result.images?.length).toBe(1)
  const page = decodedPage(result.images![0]!)
  const column = page.width / 13
  // The image spans the page width; rows 90..702 pt of 792 are covered, the middle row is inside.
  const y = page.height / 2
  expect(page.dark(column * 1.5, y), 'a black column on the left').toBe(true)
  expect(page.dark(column * 3.5, y), 'the last black column').toBe(true)
  expect(page.dark(column * 4.5, y), 'the first white column').toBe(false)
  expect(page.dark(column * 12.5, y), 'a white column on the right, next to the padding bits').toBe(false)
})

test('scan_a_stencil_mask_page_is_painted_with_the_fill_colour', async () => {
  const pdf = imagePdf([{ dict: '/Width 256 /Height 256 /ImageMask true /BitsPerComponent 1', data: Buffer.alloc(32 * 256, 0), content: '0 g q 612 0 0 612 0 90 cm /Im1 Do Q' }])
  const result = await extract({ path: save('zzscan-mask.pdf', pdf), name: 'zzscan-mask.pdf', mime: 'application/pdf' })
  expect(result.images?.length).toBe(1)
  const page = decodedPage(result.images![0]!)
  expect(page.darkCount).toBeGreaterThan(page.width * page.height * 0.6)
})

test('scan_a_page_whose_image_fails_to_decode_is_reported_with_the_reason_and_not_shown', async () => {
  const good = { dict: `/Width 256 /Height 256 ${ONE_BIT}`, data: Buffer.alloc(32 * 256, 0) }
  const broken = { dict: '/Width 256 /Height 256 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: Buffer.from('not a jpeg stream at all') }
  const pdf = imagePdf([good, broken, good])
  const path = save('zzscan-broken-image.pdf', pdf)
  const result = await extract({ path, name: 'zzscan-broken-image.pdf', mime: 'application/pdf' })

  expect(result.ok).toBe(true)
  expect(result.kind).toBe('scan')
  expect(result.images?.map((page) => page.page), 'the broken page is not among the shown ones').toEqual([1, 3])
  expect(result.shownPages).toBe(2)
  expect(result.pageCount).toBe(3)
  expect(result.remaining).toBe(1)
  for (const page of result.images ?? []) expect(decodedPage(page).darkCount, `page ${page.page} has content`).toBeGreaterThan(0)
  expect(result.failedPages?.map((failure) => failure.page)).toEqual([2])
  // The decoder error of PDF.js is the reason, not a generic «partial».
  expect(result.failedPages?.[0]?.reason).toMatch(/SOI/)

  const text = attachmentText(path, result)
  expect(text).toMatch(/Скан из 3 страниц/)
  expect(text).toMatch(/Показаны страницы 1, 3 \(2\)/)
  expect(text).toMatch(/Не удалось получить страницу 2/)
  expect(text).toContain(result.failedPages?.[0]?.reason ?? '<no reason>')
  expect(text).not.toMatch(/Показаны страницы 1–3/)
})

test('scan_with_every_page_image_broken_names_the_reason_and_shows_no_page', async () => {
  const broken = { dict: '/Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: Buffer.from('broken jpeg') }
  const path = save('zzscan-all-broken.pdf', imagePdf([broken]))
  const result = await extract({ path, name: 'zzscan-all-broken.pdf', mime: 'application/pdf' })
  expect(result.ok).toBe(true)
  expect(result.kind).toBe('scan')
  expect(result.images ?? []).toEqual([])
  expect(result.shownPages).toBe(0)
  const text = attachmentText(path, result)
  expect(text).toMatch(/не удалось получить изображения страниц: стр\. 1: встроенное изображение не декодировано/)
  expect(text).toMatch(/SOI/)
})
