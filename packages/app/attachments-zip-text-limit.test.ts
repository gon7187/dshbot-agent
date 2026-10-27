// Limits of a ZIP archive in the extraction worker: the extracted text of all
// entries of one archive together stays within the text limit of one file, and
// the list of entries is capped the same way, so a huge archive cannot put
// megabytes into the prompt. Entries over the limit are still listed.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterAll, expect, test } from 'vitest'

import { extract } from './src/attachments-worker.mjs'

const TEXT_LIMIT = 60_000
const scratch = mkdtempSync(join(tmpdir(), 'dshbot-zip-text-limit-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

interface ZipEntry {
  name: string
  data: Buffer
}

/** A ZIP archive with deflated entries; stored empty entries when `data` is empty. */
function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const emptyPacked = deflateRawSync(Buffer.alloc(0))
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const packed = entry.data.length === 0 ? emptyPacked : deflateRawSync(entry.data)
    const crc = crc32(entry.data) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, packed)
    centrals.push(central, name)
    offset += local.length + name.length + packed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

function save(name: string, data: Buffer): string {
  const path = join(scratch, name)
  writeFileSync(path, data)
  return path
}

function textOf(label: string, length: number): Buffer {
  return Buffer.from(`${label}:`.padEnd(length, 'x'), 'utf8')
}

function lineOf(text: string, name: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith(name))
  expect(line, `the list names ${name}`).toBeDefined()
  return line ?? ''
}

const OVER_LIMIT_NOTE = 'не показано: лимит текста архива'

test('test_h1_archive_text_of_all_entries_together_stays_within_the_text_limit', async () => {
  const names = ['e1.txt', 'e2.txt', 'e3.txt', 'e4.txt']
  const path = save('four-big.zip', makeZip(names.map((name) => ({ name, data: textOf(name, 40_000) }))))
  const result = await extract({ path, name: 'four-big.zip', mime: 'application/zip' })

  expect(result.ok).toBe(true)
  expect(result.kind).toBe('archive')
  const entries = result.entries ?? []
  const total = entries.reduce((sum, entry) => sum + (entry.text ?? '').length, 0)
  expect(total, 'extracted text of the whole archive').toBeLessThanOrEqual(TEXT_LIMIT)
  expect(entries.map((entry) => entry.name)).toContain('e1.txt')
  expect(entries.find((entry) => entry.name === 'e1.txt')?.text).toContain('e1.txt:')

  // Every entry is still listed; the one past the limit carries the mark.
  const listing = result.text ?? ''
  for (const name of names) lineOf(listing, name)
  expect(entries.map((entry) => entry.name), 'the last entry is beyond the limit').not.toContain('e4.txt')
  expect(lineOf(listing, 'e4.txt')).toContain(OVER_LIMIT_NOTE)
  expect(lineOf(listing, 'e1.txt')).not.toContain(OVER_LIMIT_NOTE)
})

test('test_h1_archive_of_many_medium_entries_shows_text_up_to_the_limit_only', async () => {
  const names = Array.from({ length: 12 }, (_, index) => `part${String(index + 1).padStart(2, '0')}.txt`)
  const path = save('twelve-medium.zip', makeZip(names.map((name) => ({ name, data: textOf(name, 10_000) }))))
  const result = await extract({ path, name: 'twelve-medium.zip', mime: 'application/zip' })

  expect(result.kind).toBe('archive')
  const entries = result.entries ?? []
  const total = entries.reduce((sum, entry) => sum + (entry.text ?? '').length, 0)
  expect(total).toBeLessThanOrEqual(TEXT_LIMIT)
  expect(entries.length, 'the first entries are still extracted').toBeGreaterThan(0)
  expect(entries.length, 'not all twelve fit').toBeLessThan(12)

  const shown = new Set(entries.map((entry) => entry.name))
  const listing = result.text ?? ''
  for (const name of names) {
    const line = lineOf(listing, name)
    if (shown.has(name)) expect(line).not.toContain(OVER_LIMIT_NOTE)
  }
  expect(lineOf(listing, 'part12.txt')).toContain(OVER_LIMIT_NOTE)
  expect(shown.has('part12.txt')).toBe(false)
})

test('test_h1_archive_list_of_entries_is_capped_with_a_partial_note', async () => {
  const count = 65_000
  const entries: ZipEntry[] = Array.from({ length: count }, (_, index) => ({
    name: `dir/file-${String(index).padStart(5, '0')}.bin`,
    data: Buffer.alloc(0),
  }))
  const path = save('many-entries.zip', makeZip(entries))
  const result = await extract({ path, name: 'many-entries.zip', mime: 'application/zip' })

  expect(result.ok).toBe(true)
  expect(result.kind).toBe('archive')
  const listing = result.text ?? ''
  // The note is part of the budget of the text limit; a small slack covers a note appended after it.
  expect(listing.length, 'list of 65000 entries is capped').toBeLessThanOrEqual(TEXT_LIMIT + 200)
  expect(listing).toContain('Содержимое архива many-entries.zip')
  expect(listing).toContain('dir/file-00000.bin')
  expect(listing).not.toContain('dir/file-64999.bin')
  expect(listing).toMatch(/\[Частично: показано \d+ из [^\]]+\]/)
})
