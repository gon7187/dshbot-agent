import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import JSZip from 'jszip'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'

import { extract, scanZipEntries } from './src/attachments-worker.mjs'
import { attachmentText } from './src/attachments.js'

const parsers = vi.hoisted(() => ({ docx: vi.fn(), xlsx: vi.fn() }))
vi.mock('mammoth', () => ({ default: { extractRawText: parsers.docx } }))
vi.mock('read-excel-file/node', () => ({ default: parsers.xlsx }))

const scratch = mkdtempSync(join(tmpdir(), 'dshbot-zip-ambiguity-'))
const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const HUGE = 60 * 1024 * 1024

beforeEach(() => {
  vi.clearAllMocks()
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

async function ordinaryZip(comment = ''): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('word/document.xml', 'ordinary text', { createFolders: false })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment })
}

async function prefixedBomb(): Promise<Buffer> {
  const zip = await ordinaryZip()
  const end = zip.length - 22
  const directoryOffset = zip.readUInt32LE(end + 16)
  const directorySize = zip.readUInt32LE(end + 12)
  const smallDirectory = Buffer.from(zip.subarray(directoryOffset, directoryOffset + directorySize))
  // Keep a plausible small directory at the old offset. JSZip rebases by the
  // prefix length and instead reads the real directory with its oversized entry.
  zip.writeUInt32LE(HUGE, directoryOffset + 24)
  const prefix = Buffer.alloc(zip.length, 0x61)
  smallDirectory.copy(prefix, directoryOffset)
  return Buffer.concat([prefix, zip])
}

function save(name: string, data: Buffer): string {
  const path = join(scratch, name)
  writeFileSync(path, data)
  return path
}

test.each(['docx', 'xlsx'])('a prefixed ZIP cannot hide its oversized directory from the %s guard', async (extension) => {
  const data = await prefixedBomb()
  // Positive control: this is precisely the directory the downstream JSZip
  // parser selects; no large allocation or decompression is needed to prove it.
  const archive = await JSZip.loadAsync(data)
  const entry = archive.file('word/document.xml') as unknown as { _data: { uncompressedSize: number } }
  expect(entry._data.uncompressedSize).toBe(HUGE)
  const end = data.length - 22
  const decoy = data.readUInt32LE(end + 16)
  expect(data.readUInt32LE(decoy + 24)).toBe(Buffer.byteLength('ordinary text'))

  const name = `prefixed-bomb.${extension}`
  await expect(extract({ path: save(name, data), name })).rejects.toThrow(/каталог ZIP.*EOCD/)
  expect(parsers.docx).not.toHaveBeenCalled()
  expect(parsers.xlsx).not.toHaveBeenCalled()
})

test('the worker returns the prefixed ZIP rejection reason for the attachment result', async () => {
  const name = 'worker-prefixed-bomb.docx'
  const input = { path: save(name, await prefixedBomb()), name }
  const worker = new Worker(new URL('./src/attachments-worker.mjs', import.meta.url))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('worker did not return a result')), 10_000)
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', (code) => reject(new Error(`worker exited without a result: ${code}`)))
      worker.postMessage(input)
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/каталог ZIP.*EOCD/)
    expect(attachmentText(input.path, result)).toContain('не удалось разобрать')
    expect(attachmentText(input.path, result)).toContain(result.error)
  } finally {
    clearTimeout(timeout)
    await worker.terminate()
  }
}, 15_000)

test('multiple EOCD records cannot select different directories', async () => {
  const first = await ordinaryZip()
  const second = await ordinaryZip()
  expect(() => scanZipEntries(Buffer.concat([first, second]))).toThrow(/несколько.*EOCD/)
})

test('an EOCD signature inside the ZIP comment is rejected as ambiguous', async () => {
  const zip = await ordinaryZip(`comment ${EOCD.toString('latin1')}`)
  expect(() => scanZipEntries(zip)).toThrow(/несколько.*EOCD/)
})

test.each(['trailing bytes', 'truncated comment'])('EOCD rejects %s', async (variant) => {
  const zip = await ordinaryZip('ordinary comment')
  const data = variant === 'trailing bytes' ? Buffer.concat([zip, Buffer.from('extra')]) : zip.subarray(0, -1)
  expect(() => scanZipEntries(data)).toThrow(/комментарий.*ZIP/)
})

test('an ordinary ZIP comment still passes the guard', async () => {
  expect(scanZipEntries(await ordinaryZip('ordinary comment'))).toEqual({
    total: Buffer.byteLength('ordinary text'),
    largest: Buffer.byteLength('ordinary text'),
    entries: 1,
  })
})

test.each([4, 6, 8])('ZIP64 sentinel in EOCD field %i is rejected before parser selection', async (field) => {
  const data = await ordinaryZip()
  data.writeUInt16LE(0xffff, data.length - 22 + field)
  expect(() => scanZipEntries(data)).toThrow(/ZIP64/)
})

test.each([4, 6, 8])('inconsistent disk metadata in EOCD field %i is rejected', async (field) => {
  const data = await ordinaryZip()
  data.writeUInt16LE(field === 8 ? 0 : 1, data.length - 22 + field)
  expect(() => scanZipEntries(data)).toThrow(/многотомный|число записей/)
})
