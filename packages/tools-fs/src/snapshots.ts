// Snapshots of files the bot is about to change.
//
// `write` and `edit` of packages/tools-fs keep the previous content of an
// existing file under `DSHBOT_HOME/snapshots` before they touch it, so an
// unsuccessful change can be undone by the owner through `/rollback`. A file
// the bot creates gets a marker instead of content: rolling that marker back
// deletes the file again.
//
// The store is deliberately plain: one JSON metadata file and, for a file that
// existed, one raw byte file per snapshot, both named by the snapshot id. The
// owner (and the tests) can read the directory with ordinary tools; the format
// is an implementation detail.
//
// Limits: at most {@link SNAPSHOT_MAX_COUNT} snapshots and
// {@link SNAPSHOT_MAX_TOTAL_BYTES} together, the oldest go first. A file over
// {@link SNAPSHOT_MAX_FILE_BYTES} is not snapshotted at all; the tool answer
// carries {@link SNAPSHOT_SKIPPED_NOTE} so the owner sees it.

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** Directory of the snapshots below DSHBOT_HOME. */
export const SNAPSHOTS_DIR_NAME = 'snapshots'

/** How many snapshots the store keeps. */
export const SNAPSHOT_MAX_COUNT = 50

/** Total size of every file of the snapshots directory. */
export const SNAPSHOT_MAX_TOTAL_BYTES = 100 * 1_024 * 1_024

/** A file larger than this is not snapshotted. */
export const SNAPSHOT_MAX_FILE_BYTES = 5 * 1_024 * 1_024

/** Shown in the tool answer when the previous version was too big to keep. */
export const SNAPSHOT_SKIPPED_NOTE = 'снимок не сделан: файл больше 5 МБ'

/** Snapshots shown by `/rollback` without an argument. */
export const SNAPSHOT_LIST_LIMIT = 10

/** One saved version of a file, as the list of `/rollback` shows it. */
export interface SnapshotRecord {
  /** Stable number within the store, growing with every snapshot. */
  readonly id: number
  /** Absolute path of the file the snapshot belongs to. */
  readonly path: string
  /** Unix time in milliseconds. */
  readonly createdAt: number
  /** Tool that made the snapshot: `write`, `edit`, `rollback` (or `manual`). */
  readonly tool: string
  /** True when the file did not exist before the change, so a rollback deletes it. */
  readonly created: boolean
  /** Bytes of the stored previous content; 0 for a created marker. */
  readonly size: number
}

/** Result of saving the previous version of a file. */
export type SnapshotSave =
  | { readonly status: 'saved'; readonly record: SnapshotRecord }
  | { readonly status: 'created'; readonly record: SnapshotRecord }
  | { readonly status: 'too-big' }

/** Result of restoring one snapshot. */
export type SnapshotRollback =
  | {
      readonly status: 'restored'
      readonly record: SnapshotRecord
      /** Snapshot of the content the rollback replaced, when it could be taken. */
      readonly current?: SnapshotRecord
      /** True when the replaced content was too big to snapshot. */
      readonly currentTooBig?: boolean
    }
  | { readonly status: 'not-found' }
  | { readonly status: 'failed'; readonly reason: string }

interface SnapshotMeta {
  id: number
  path: string
  createdAt: number
  tool: string
  created: boolean
  size: number
}

/** Directory of the snapshots of one DSHBOT_HOME. */
export function snapshotsDir(home: string): string {
  return join(home, SNAPSHOTS_DIR_NAME)
}

function metaName(id: number): string {
  return `snap-${String(id).padStart(6, '0')}.json`
}

function contentName(id: number): string {
  return `snap-${String(id).padStart(6, '0')}.bin`
}

function recordOf(meta: SnapshotMeta): SnapshotRecord {
  return {
    id: meta.id,
    path: meta.path,
    createdAt: meta.createdAt,
    tool: meta.tool,
    created: meta.created === true,
    size: typeof meta.size === 'number' ? meta.size : 0,
  }
}

function isMeta(value: unknown): value is SnapshotMeta {
  if (value === null || typeof value !== 'object') return false
  const meta = value as Record<string, unknown>
  return (
    typeof meta.id === 'number' &&
    Number.isSafeInteger(meta.id) &&
    typeof meta.path === 'string' &&
    meta.path !== '' &&
    typeof meta.createdAt === 'number' &&
    typeof meta.tool === 'string' &&
    typeof meta.created === 'boolean'
  )
}

/** Every readable snapshot of the directory, oldest first. */
export function readSnapshots(dir: string): SnapshotRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const records: SnapshotRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (isMeta(parsed)) records.push(recordOf(parsed))
    } catch {
      // A half-written or foreign file is not a snapshot: leave it alone.
    }
  }
  records.sort((left, right) => left.id - right.id)
  return records
}

/** Bytes of every file of the snapshot directory. */
function totalBytes(dir: string): number {
  let total = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    try {
      const stats = statSync(join(dir, name))
      if (stats.isFile()) total += stats.size
    } catch {
      // vanished between readdir and stat
    }
  }
  return total
}

/** Write a file through a temporary name in the same directory and rename it. */
function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const temporary = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', mode)
    if (typeof data === 'string') writeSync(fd, data, null, 'utf8')
    else writeSync(fd, data)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // the original error is the one to report
      }
    }
    try {
      unlinkSync(temporary)
    } catch {
      // nothing was created or the rename moved it
    }
    throw error
  }
}

function nextId(dir: string): number {
  const records = readSnapshots(dir)
  return records.length === 0 ? 1 : (records[records.length - 1] as SnapshotRecord).id + 1
}

function removeRecord(dir: string, record: SnapshotRecord): void {
  for (const name of [metaName(record.id), contentName(record.id)]) {
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // already gone
    }
  }
}

/** Drop the oldest snapshots until the count and the total size fit the caps. */
function enforceLimits(dir: string): void {
  let records = readSnapshots(dir)
  while (records.length > SNAPSHOT_MAX_COUNT || totalBytes(dir) > SNAPSHOT_MAX_TOTAL_BYTES) {
    const oldest = records.shift()
    if (oldest === undefined) break
    removeRecord(dir, oldest)
  }
}

function save(dir: string, meta: Omit<SnapshotMeta, 'id'>, content?: Buffer): SnapshotRecord {
  mkdirSync(dir, { recursive: true })
  const id = nextId(dir)
  const record: SnapshotMeta = { id, ...meta }
  if (content !== undefined) writeAtomic(join(dir, contentName(id)), content)
  writeAtomic(join(dir, metaName(id)), `${JSON.stringify(record)}\n`)
  enforceLimits(dir)
  return recordOf(record)
}

/**
 * Save the current content of an existing file before a tool changes it.
 *
 * The size check happens before the file is read: a big file stays on disk and
 * is never copied, and the caller shows {@link SNAPSHOT_SKIPPED_NOTE}.
 */
export function snapshotExistingFile(dir: string, path: string, tool: string): SnapshotSave {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    // The caller already found the file; treat a vanished file as created.
    return { status: 'created', record: save(dir, { path, createdAt: Date.now(), tool, created: true, size: 0 }) }
  }
  if (size > SNAPSHOT_MAX_FILE_BYTES) return { status: 'too-big' }
  const content = readFileSync(path)
  return {
    status: 'saved',
    record: save(dir, { path, createdAt: Date.now(), tool, created: false, size: content.length }, content),
  }
}

/** Mark a file the bot is about to create, so a rollback deletes it again. */
export function snapshotCreatedFile(dir: string, path: string, tool: string): SnapshotRecord {
  return save(dir, { path, createdAt: Date.now(), tool, created: true, size: 0 })
}

/** The newest `limit` snapshots, newest first, as `/rollback` lists them. */
export function listSnapshots(dir: string, limit = SNAPSHOT_LIST_LIMIT): SnapshotRecord[] {
  const records = readSnapshots(dir)
  return records.slice(Math.max(0, records.length - limit)).reverse()
}

/** Put `content` back at `path`; no content (a created marker) deletes the file. */
function restore(path: string, content: Buffer | undefined): void {
  if (content === undefined) {
    try {
      rmSync(path, { force: true })
    } catch (error) {
      throw new Error(`cannot remove ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  let mode = 0o644
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    // a missing file gets the ordinary mode
  }
  writeAtomic(path, content, mode)
}

/**
 * Restore one snapshot by number. The content the rollback replaces is
 * snapshotted first, so the rollback itself can be undone.
 *
 * The selected snapshot is read before that: saving the replaced content
 * enforces the caps, and in a full store the selected snapshot may be the
 * oldest one, which the caps drop.
 */
export function rollbackSnapshot(dir: string, id: number): SnapshotRollback {
  const records = readSnapshots(dir)
  const record = records.find((candidate) => candidate.id === id)
  if (record === undefined) return { status: 'not-found' }

  let content: Buffer | undefined
  if (!record.created) {
    try {
      content = readFileSync(join(dir, contentName(record.id)))
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  let current: SnapshotRecord | undefined
  let currentTooBig = false
  let exists = false
  let size = 0
  try {
    const stats = statSync(record.path)
    exists = stats.isFile()
    size = stats.size
  } catch {
    exists = false
  }
  if (exists) {
    if (size > SNAPSHOT_MAX_FILE_BYTES) {
      currentTooBig = true
    } else {
      const saved = snapshotExistingFile(dir, record.path, 'rollback')
      current = saved.status === 'too-big' ? undefined : saved.record
    }
  } else {
    current = snapshotCreatedFile(dir, record.path, 'rollback')
  }

  try {
    restore(record.path, content)
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
  return currentTooBig ? { status: 'restored', record, currentTooBig } : { status: 'restored', record, current }
}
