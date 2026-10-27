// ZIP bomb guard shared by every reader of an office archive.
//
// The declared uncompressed size lives in the central directory and does not
// need decompression to be read. The libraries (JSZip, mammoth, read-excel-file)
// would happily inflate a small file into gigabytes, so the limits are checked
// before they run.
//
// The entry count in EOCD cannot be trusted on its own: an archive can claim
// zero entries while the directory still lists a huge one. So the whole
// central directory is walked by its declared size and offset, every record is
// counted by its signature, and the walk must end exactly at the declared end.
// That end must be EOCD itself: JSZip rebases directory offsets when a prefix
// or gap exists, so accepting a gap would let it read a different directory.
// Reject multiple EOCD signatures (even in payloads/comments) and trailing
// bytes rather than let downstream libraries choose a different archive end.
// ZIP64 markers are rejected instead of being half-read, because their real
// sizes live in another record this guard does not parse.
//
// This module is imported by the extraction worker of attachments and by the
// XLSX reader of the office tool, so both use one guard, not two copies.

const ZIP_TOTAL_LIMIT = 100 * 1024 * 1024
const ZIP_ENTRY_LIMIT = 50 * 1024 * 1024

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const CENTRAL_SIGNATURE = 0x02014b50
const DIGITAL_SIGNATURE_SIGNATURE = 0x05054b50
const ZIP64_ENTRY_COUNT = 0xffff
const ZIP64_LIMIT = 0xffffffff

/**
 * Walks the central directory once. `collect` asks for the records themselves
 * (name, sizes, local header offset) instead of the summary only.
 */
function walkZip(data, collect) {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (view.length < 22) throw new Error('файл не разобран: слишком короткий файл для ZIP')
  const eocd = view.indexOf(EOCD_SIGNATURE)
  if (eocd < 0) throw new Error('файл не разобран: центральный каталог ZIP не найден')
  if (view.indexOf(EOCD_SIGNATURE, eocd + 1) !== -1) {
    throw new Error('файл не разобран: несколько сигнатур EOCD в ZIP, неоднозначный каталог')
  }
  if (eocd + 22 > view.length) throw new Error('файл не разобран: EOCD в ZIP обрезан')
  if (eocd + 22 + view.readUInt16LE(eocd + 20) !== view.length) {
    throw new Error('файл не разобран: комментарий в EOCD ZIP не совпадает с концом файла')
  }

  const diskNumber = view.readUInt16LE(eocd + 4)
  const directoryDisk = view.readUInt16LE(eocd + 6)
  const diskEntries = view.readUInt16LE(eocd + 8)
  const declaredEntries = view.readUInt16LE(eocd + 10)
  const directorySize = view.readUInt32LE(eocd + 12)
  const directoryOffset = view.readUInt32LE(eocd + 16)
  if (
    diskNumber === ZIP64_ENTRY_COUNT ||
    directoryDisk === ZIP64_ENTRY_COUNT ||
    diskEntries === ZIP64_ENTRY_COUNT ||
    declaredEntries === ZIP64_ENTRY_COUNT ||
    directorySize === ZIP64_LIMIT ||
    directoryOffset === ZIP64_LIMIT
  ) {
    throw new Error('файл не разобран: ZIP64 не поддерживается')
  }
  if (diskNumber !== 0 || directoryDisk !== 0) {
    throw new Error('файл не разобран: многотомный ZIP не поддерживается')
  }
  if (diskEntries !== declaredEntries) {
    throw new Error('файл не разобран: число записей ZIP на диске не совпадает с EOCD')
  }
  if (
    directoryOffset > view.length ||
    directorySize > view.length ||
    directoryOffset + directorySize > view.length ||
    directoryOffset + directorySize > eocd
  ) {
    throw new Error('файл не разобран: центральный каталог ZIP выходит за границы файла')
  }

  const directoryEnd = directoryOffset + directorySize
  if (directoryEnd !== eocd) {
    throw new Error('файл не разобран: центральный каталог ZIP не примыкает к EOCD (префикс или зазор)')
  }
  let at = directoryOffset
  let entries = 0
  let total = 0
  let largest = 0
  const list = collect ? [] : undefined
  while (at < directoryEnd) {
    if (at + 46 > directoryEnd) throw new Error('файл не разобран: центральный каталог ZIP обрезан')
    const signature = view.readUInt32LE(at)
    if (signature === DIGITAL_SIGNATURE_SIGNATURE) {
      // A digital signature record after the entries is not an entry: skip it.
      if (at + 6 > directoryEnd) throw new Error('файл не разобран: повреждён центральный каталог ZIP')
      at += 6 + view.readUInt16LE(at + 4)
      continue
    }
    if (signature !== CENTRAL_SIGNATURE) throw new Error('файл не разобран: повреждён центральный каталог ZIP')

    const compressedSize = view.readUInt32LE(at + 20)
    const size = view.readUInt32LE(at + 24)
    const nameLength = view.readUInt16LE(at + 28)
    const extraLength = view.readUInt16LE(at + 30)
    const commentLength = view.readUInt16LE(at + 32)
    const localOffset = view.readUInt32LE(at + 42)
    if (compressedSize === ZIP64_LIMIT || size === ZIP64_LIMIT || localOffset === ZIP64_LIMIT) {
      throw new Error('файл не разобран: ZIP64 не поддерживается')
    }
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > directoryEnd) throw new Error('файл не разобран: запись центрального каталога ZIP обрезана')

    if (list !== undefined) {
      // Bit 11 of the general purpose flags says the name is UTF-8; a plain
      // Buffer.toString('utf8') is the best effort for the old code page too.
      const rawName = view.subarray(at + 46, at + 46 + nameLength)
      list.push({
        name: rawName.toString('utf8'),
        size,
        compressedSize,
        flags: view.readUInt16LE(at + 8),
        method: view.readUInt16LE(at + 10),
        crc: view.readUInt32LE(at + 16),
        localOffset,
      })
    }

    entries += 1
    total += size
    if (size > largest) largest = size
    if (total > ZIP_TOTAL_LIMIT) {
      throw new Error('файл не разобран: превышен безопасный размер архива (заявлено больше 100 МБ)')
    }
    if (largest > ZIP_ENTRY_LIMIT) {
      throw new Error('файл не разобран: одна запись архива заявляет больше 50 МБ')
    }
    at = next
  }

  if (at !== directoryEnd) throw new Error('файл не разобран: центральный каталог ZIP не совпадает по размеру')
  if (entries !== declaredEntries) {
    throw new Error(
      `файл не разобран: число записей центрального каталога ZIP (${entries}) не совпадает с EOCD (${declaredEntries})`,
    )
  }
  return { total, largest, entries, list: list ?? [] }
}

export function scanZipEntries(data) {
  const { total, largest, entries } = walkZip(data, false)
  return { total, largest, entries }
}

/**
 * The validated records of the central directory, in archive order. Throws the
 * same reasons as {@link scanZipEntries} for an unsafe archive, so a caller
 * that lists entries still rejects a zip bomb before decompressing anything.
 */
export function listZipEntries(data) {
  return walkZip(data, true).list
}

export function checkZip(data) {
  scanZipEntries(data)
}
