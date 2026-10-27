// One XLSX reader for the whole daemon.
//
// The extraction of attachments (#124) formats a workbook as text for the model;
// the office tool (`edit_xlsx`) needs the same rows as values to write a new
// book. Both go through this module, so there is exactly one `read-excel-file`
// call, one ZIP guard and one set of limits in the process. A second parser in
// `packages/tools-office` is forbidden: see tests/gates/office-deps.test.ts.

import { checkZip } from './zip-guard.mjs'

export const SHEET_ROW_LIMIT = 5_000
export const SHEET_COLUMN_LIMIT = 256

function partialNote(shown, total, unit) {
  return `[Частично: показано ${shown} из ${total} ${unit}]`
}

/** Sheets of a workbook as `{ name, rows }`, or the shapes older versions return. */
async function readWorkbook(data) {
  checkZip(data)
  const module = await import('read-excel-file/node')
  const read = module.default ?? module.readSheet
  const result = await read(Buffer.from(data))
  // v9 returns every sheet; tolerate the older single-sheet shape as well.
  const sheets =
    Array.isArray(result) &&
    result.length > 0 &&
    result[0] &&
    typeof result[0] === 'object' &&
    'data' in result[0] &&
    'sheet' in result[0]
      ? result
      : [{ sheet: 'Sheet1', data: result }]
  return sheets.map((sheet) => ({
    name: String(sheet.sheet ?? ''),
    rows: Array.isArray(sheet.data) ? sheet.data : [],
  }))
}

/**
 * Value-shaped workbook for `edit_xlsx`. The extraction limits are enforced
 * instead of truncated: cutting rows of the source would write a new book with
 * silently lost data, so a book beyond the limits is refused with a tool error.
 */
export async function readXlsxSheets(data) {
  const workbook = await readWorkbook(data)
  for (const sheet of workbook) {
    if (sheet.rows.length > SHEET_ROW_LIMIT) {
      throw new Error(
        `книга больше лимита извлечения: ${sheet.rows.length} строк при пределе ${SHEET_ROW_LIMIT}`,
      )
    }
    for (const row of sheet.rows) {
      const cells = Array.isArray(row) ? row : []
      if (cells.length > SHEET_COLUMN_LIMIT) {
        throw new Error(
          `книга больше лимита извлечения: ${cells.length} колонок при пределе ${SHEET_COLUMN_LIMIT}`,
        )
      }
    }
  }
  return workbook
}

/**
 * Text of a workbook for the extraction of attachments: every sheet, rows and
 * columns cut at the same limits, notes pushed into `notes`.
 */
export async function xlsxText(data, notes) {
  const workbook = await readWorkbook(data)
  const chunks = []
  for (const sheet of workbook) {
    if (sheet.rows.length > SHEET_ROW_LIMIT) notes.push(partialNote(SHEET_ROW_LIMIT, sheet.rows.length, 'строк'))
    const lines = [`[Лист: ${sheet.name}]`]
    for (const row of sheet.rows.slice(0, SHEET_ROW_LIMIT)) {
      const cells = Array.isArray(row) ? row : []
      if (cells.length > SHEET_COLUMN_LIMIT && !notes.some((note) => note.includes('колонок'))) {
        notes.push(partialNote(SHEET_COLUMN_LIMIT, cells.length, 'колонок'))
      }
      lines.push(
        cells
          .slice(0, SHEET_COLUMN_LIMIT)
          .map((cell) => {
            if (cell === null || cell === undefined) return ''
            if (cell instanceof Date) return cell.toISOString()
            return String(cell)
          })
          .join('\t'),
      )
    }
    chunks.push(lines.join('\n'))
  }
  return chunks.join('\n\n')
}
