// Types for the extraction worker imported by tests. The worker itself is plain
// ESM (`node:worker_threads` entry) and exports its pure functions so a test can
// exercise the guard and the limits without starting a thread.

export interface ExtractionInput {
  path: string
  name: string
  mime?: string
  /**
   * Whether the current model accepts image blocks. When it does not, a scan is
   * not rendered and the note says that flash is needed to look at the pages.
   */
  renderPages?: boolean
}

export interface ScannedPage {
  /** 1-based page number in the source PDF. */
  page: number
  mediaType: 'image/jpeg'
  data: Uint8Array
}

export interface ArchiveEntry {
  /** Path of the entry inside the archive. */
  name: string
  mime: string
  /** Declared uncompressed size in bytes. */
  size: number
  /** Extracted text of a readable entry. */
  text?: string
}

export interface ExtractionResult {
  ok: boolean
  kind?: 'text' | 'scan' | 'audio' | 'unsupported' | 'archive'
  text?: string
  notes?: string[]
  /** Entries of an archive that were extracted as ordinary attachments. */
  entries?: ArchiveEntry[]
  error?: string
  /** Rendered pages of a scan, in page order, at most 10. */
  images?: ScannedPage[]
  /** Pages in the source PDF. */
  pageCount?: number
  /** Pages of the scan that could not be drawn, with the reason; never counted as shown. */
  failedPages?: Array<{ page: number; reason: string }>
  /** Pages whose images are in `images`. */
  shownPages?: number
  /** Pages of the scan the model does not see. */
  remaining?: number
}

export interface ZipEntryRecord {
  name: string
  size: number
  compressedSize: number
  /** General purpose bit flags of the central directory record. */
  flags: number
  method: number
  /** CRC-32 of the uncompressed data declared in the central directory. */
  crc: number
  localOffset: number
}

export interface ZipSizes {
  total: number
  largest: number
  entries: number
}

export function scanZipEntries(data: Uint8Array): ZipSizes
export function listZipEntries(data: Uint8Array): ZipEntryRecord[]
export function finalizeText(text: string, notes: string[]): { text: string; notes: string[] }
export function extract(input: ExtractionInput): Promise<ExtractionResult>
