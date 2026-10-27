// Generation worker of the office tool.
//
// The daemon never builds a document in-process: a hanging or a crashing
// library must not take the bot with it. `index.ts` starts this file with
// `worker_threads`, waits at most `OFFICE_TIMEOUT_MS` and turns every failure
// into a tool error.
//
// The file only writes new files: the target path is chosen by the parent
// inside `DSHBOT_HOME/workspace/outbox/<date>/`. The libraries do the format
// work (docx, write-excel-file, pptxgenjs); no XML is built with string
// templates here.
//
// `edit_xlsx` reads the source through the extraction of attachments (#124):
// `packages/app/src/xlsx-read.mjs` is the one reader of a workbook in the
// daemon, with the ZIP guard (`zip-guard.mjs`) and the extraction limits. This
// package never imports an extraction parser of its own.

import { constants } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parentPort } from 'node:worker_threads'

import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import writeXlsxFile from 'write-excel-file/node'
import PptxGenJS from 'pptxgenjs'

import { readXlsxSheets } from '../../app/src/xlsx-read.mjs'

const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss'
const NUMBERING_REFERENCE = 'office-numbered-list'
const MAX_BLOCKS = 2_000
const MAX_ROWS = 20_000
const MAX_COLUMNS = 256
const MAX_SLIDES = 200
const MAX_TEXT = 20_000

function asArray(value, what, limit) {
  if (!Array.isArray(value)) throw new Error(`${what}: ожидается массив`)
  if (value.length > limit) throw new Error(`${what}: больше ${limit} элементов`)
  return value
}

function textOf(value, what) {
  if (typeof value !== 'string') throw new Error(`${what}: ожидается строка`)
  if (value.length > MAX_TEXT) throw new Error(`${what}: строка длиннее ${MAX_TEXT} символов`)
  return value
}

function inside(root, candidate) {
  const rest = relative(resolve(root), resolve(candidate))
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

function targetOf(payload) {
  const target = textOf(payload.target, 'target')
  const outbox = textOf(payload.outbox, 'outbox')
  if (!inside(outbox, target)) throw new Error('target: файл должен лежать в outbox')
  return target
}

async function writeOutput(payload, bytes) {
  // Serialize in memory, then open the final path ourselves. These are 'wx'
  // flags plus O_NOFOLLOW where available: even an entry created after parent
  // name selection must never be followed or overwritten by any serializer.
  await writeFile(targetOf(payload), bytes, {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
  })
}

// --- DOCX -----------------------------------------------------------------------------------------

function headingOf(level) {
  if (level === 1) return HeadingLevel.HEADING_1
  if (level === 2) return HeadingLevel.HEADING_2
  return HeadingLevel.HEADING_3
}

function docxBlock(block) {
  if (block === null || typeof block !== 'object') throw new Error('blocks: каждый блок — объект')
  switch (block.type) {
    case 'heading': {
      const level = block.level === 2 || block.level === 3 ? block.level : 1
      return new Paragraph({
        heading: headingOf(level),
        children: [new TextRun({ text: textOf(block.text, 'heading.text') })],
      })
    }
    case 'paragraph': {
      const runs = asArray(block.runs, 'paragraph.runs', MAX_BLOCKS)
      return new Paragraph({
        children: runs.map((run) => {
          if (run === null || typeof run !== 'object') throw new Error('paragraph.runs: элемент — объект')
          return new TextRun({
            text: textOf(run.text, 'paragraph.runs.text'),
            ...(run.bold === true ? { bold: true } : {}),
            ...(run.italic === true ? { italics: true } : {}),
          })
        }),
      })
    }
    case 'bullets': {
      const items = asArray(block.items, 'bullets.items', MAX_BLOCKS)
      return items.map((item) => new Paragraph({ text: textOf(item, 'bullets.items'), bullet: { level: 0 } }))
    }
    case 'numbered': {
      const items = asArray(block.items, 'numbered.items', MAX_BLOCKS)
      return items.map(
        (item) =>
          new Paragraph({
            text: textOf(item, 'numbered.items'),
            numbering: { reference: NUMBERING_REFERENCE, level: 0 },
          }),
      )
    }
    case 'table': {
      const rows = asArray(block.rows, 'table.rows', MAX_ROWS)
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((row) => {
            const cells = asArray(row, 'table.rows[]', MAX_COLUMNS)
            return new TableRow({
              children: cells.map(
                (cell) =>
                  new TableCell({
                    children: [new Paragraph({ children: [new TextRun({ text: textOf(cell, 'table cell') })] })],
                  }),
              ),
            })
          }),
        }),
      ]
    }
    case 'page_break':
      return new Paragraph({ children: [new PageBreak()] })
    default:
      throw new Error(`blocks: неизвестный тип блока ${String(block.type)}`)
  }
}

async function createDocx(payload) {
  const blocks = asArray(payload.blocks, 'blocks', MAX_BLOCKS)
  const children = blocks.flatMap((block) => docxBlock(block))
  const document = new Document({
    numbering: {
      config: [
        {
          reference: NUMBERING_REFERENCE,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  })
  await writeOutput(payload, await Packer.toBuffer(document))
}

// --- XLSX -----------------------------------------------------------------------------------------

function cellOf(cell, bold) {
  if (cell === null || cell === undefined) return null
  let value
  if (typeof cell === 'string') {
    value = cell.startsWith('=') ? { value: cell, type: 'Formula' } : { value: cell, type: String }
  } else if (typeof cell === 'number' && Number.isFinite(cell)) {
    value = { value: cell, type: Number }
  } else if (typeof cell === 'boolean') {
    value = { value: cell, type: Boolean }
  } else if (cell instanceof Date) {
    value = { value: cell, type: Date, format: DATE_FORMAT }
  } else if (typeof cell === 'object' && typeof cell.date === 'string') {
    const date = new Date(cell.date)
    if (Number.isNaN(date.getTime())) throw new Error(`ячейка: неверная дата ${cell.date}`)
    value = { value: date, type: Date, format: DATE_FORMAT }
  } else {
    throw new Error('ячейка: ожидается строка, число, булево, { date } или формула строкой')
  }
  return bold ? { ...value, fontWeight: 'bold' } : value
}

function widthOf(value) {
  if (value === null || value === undefined) return 8
  if (value instanceof Date) return 20
  const text = typeof value === 'object' ? String(value.date ?? '') : String(value)
  return Math.max(8, Math.min(60, text.length + 2))
}

function sheetOf(sheet) {
  if (sheet === null || typeof sheet !== 'object') throw new Error('sheets: каждый лист — объект')
  const name = textOf(sheet.name, 'sheets.name')
  const rows = asArray(sheet.rows, 'sheets.rows', MAX_ROWS)
  const data = rows.map((row, index) => {
    const cells = asArray(row, 'sheets.rows[]', MAX_COLUMNS)
    return cells.map((cell) => cellOf(cell, index === 0))
  })
  const columns = []
  for (let index = 0; index < Math.min(MAX_COLUMNS, Math.max(...rows.map((row) => row.length), 1)); index += 1) {
    columns.push({ width: Math.max(...rows.map((row) => widthOf(row[index])), 8) })
  }
  return { sheet: name, data, columns, stickyRowsCount: 1, dateFormat: DATE_FORMAT }
}

async function createXlsx(payload) {
  const sheets = asArray(payload.sheets, 'sheets', 200).map(sheetOf)
  if (sheets.length === 0) throw new Error('sheets: нужен хотя бы один лист')
  await writeOutput(payload, await writeXlsxFile(sheets).toBuffer())
}

// --- PPTX -----------------------------------------------------------------------------------------

function tableRowsOf(table) {
  if (table === null || typeof table !== 'object') throw new Error('slides.table: ожидается объект')
  const rows = asArray(table.rows, 'slides.table.rows', MAX_ROWS)
  return rows.map((row) =>
    asArray(row, 'slides.table.rows[]', MAX_COLUMNS).map((cell) => ({ text: textOf(cell, 'slides.table cell') })),
  )
}

async function createPptx(payload) {
  const slides = asArray(payload.slides, 'slides', MAX_SLIDES)
  if (slides.length === 0) throw new Error('slides: нужен хотя бы один слайд')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  for (const slideData of slides) {
    if (slideData === null || typeof slideData !== 'object') throw new Error('slides: каждый слайд — объект')
    const slide = pptx.addSlide()
    slide.addText(textOf(slideData.title, 'slides.title'), {
      x: 0.6,
      y: 0.35,
      w: 12,
      h: 0.9,
      fontSize: 28,
      bold: true,
    })
    if (slideData.text !== undefined) {
      slide.addText(textOf(slideData.text, 'slides.text'), { x: 0.6, y: 1.4, w: 12, h: 4.6, fontSize: 18, valign: 'top' })
    }
    if (slideData.bullets !== undefined) {
      const bullets = asArray(slideData.bullets, 'slides.bullets', MAX_BLOCKS).map((item) => ({
        text: textOf(item, 'slides.bullets'),
        options: { bullet: true },
      }))
      slide.addText(bullets, { x: 0.6, y: 1.4, w: 12, h: 4.6, fontSize: 18, valign: 'top' })
    }
    if (slideData.table !== undefined) {
      slide.addTable(tableRowsOf(slideData.table), {
        x: 0.6,
        y: 1.4,
        w: 12,
        border: { pt: 1, color: '999999' },
        fontSize: 14,
      })
    }
    if (slideData.image !== undefined) {
      const image = textOf(slideData.image, 'slides.image')
      const workspace = textOf(payload.workspace, 'workspace')
      if (!inside(workspace, image)) throw new Error('slides.image: картинка должна лежать в workspace')
      slide.addImage({ path: image, x: 0.6, y: 1.4, w: 5, h: 3 })
    }
  }
  await writeOutput(payload, await pptx.write({ outputType: 'nodebuffer' }))
}

// --- edit XLSX ------------------------------------------------------------------------------------

function columnOf(address) {
  const match = /^([A-Za-z]+)([1-9]\d*)$/.exec(address.trim())
  if (match === null) throw new Error(`cells: неверный адрес ${JSON.stringify(address)}`)
  let column = 0
  for (const letter of (match[1] ?? '').toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64)
  return { column: column - 1, row: Number(match[2]) - 1 }
}

function valueOf(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'object' && typeof value.date === 'string') return new Date(value.date)
  throw new Error('edits.value: ожидается строка, число, булево или { date }')
}

async function editXlsx(payload) {
  const source = textOf(payload.source, 'path')
  const workspace = textOf(payload.workspace, 'workspace')
  if (!inside(workspace, source)) throw new Error('path: исходный файл должен лежать в workspace')
  // The one reader of attachments (#124) with its ZIP guard and row/column
  // limits: a second workbook parser call is not allowed here.
  const workbook = await readXlsxSheets(await readFile(source))
  if (workbook.length > 200) throw new Error('path: в книге больше 200 листов')
  const sheets = workbook.map((sheet) => ({
    sheet: sheet.name === '' ? 'Sheet' : sheet.name,
    data: sheet.rows.map((row) => [...row]),
  }))
  const byName = new Map(sheets.map((sheet) => [sheet.sheet, sheet]))

  for (const edit of asArray(payload.edits ?? [], 'edits', MAX_ROWS)) {
    if (edit === null || typeof edit !== 'object') throw new Error('edits: элемент — объект')
    const sheet = byName.get(textOf(edit.sheet, 'edits.sheet'))
    if (sheet === undefined) throw new Error(`edits.sheet: лист ${String(edit.sheet)} не найден`)
    const { column, row } = columnOf(textOf(edit.cell, 'edits.cell'))
    while (sheet.data.length <= row) sheet.data.push([])
    const target = sheet.data[row]
    while (target.length <= column) target.push(null)
    target[column] = valueOf(edit.value)
  }
  for (const append of asArray(payload.appendRows ?? [], 'append_rows', 200)) {
    if (append === null || typeof append !== 'object') throw new Error('append_rows: элемент — объект')
    const sheet = byName.get(textOf(append.sheet, 'append_rows.sheet'))
    if (sheet === undefined) throw new Error(`append_rows.sheet: лист ${String(append.sheet)} не найден`)
    for (const row of asArray(append.rows, 'append_rows.rows', MAX_ROWS)) {
      sheet.data.push(asArray(row, 'append_rows.rows[]', MAX_COLUMNS).map(valueOf))
    }
  }
  if (sheets.length === 0) throw new Error('path: в книге нет листов')
  const bytes = await writeXlsxFile(
    sheets.map((sheet) => ({
      sheet: sheet.sheet,
      data: sheet.data.map((row, index) => row.map((cell) => cellOf(cell, index === 0))),
      stickyRowsCount: 1,
      dateFormat: DATE_FORMAT,
    })),
  ).toBuffer()
  await writeOutput(payload, bytes)
}

// --- the worker loop ------------------------------------------------------------------------------

const handlers = {
  create_docx: createDocx,
  create_xlsx: createXlsx,
  create_pptx: createPptx,
  edit_xlsx: editXlsx,
}

parentPort?.once('message', async (payload) => {
  try {
    const handler = handlers[payload?.action]
    if (handler === undefined) throw new Error(`неизвестное действие ${String(payload?.action)}`)
    await handler(payload)
    parentPort?.postMessage({ ok: true })
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
