// Incremental index of the text files of the owner workspace.
//
// `recall` used to know only the dialogue, the journal and schedule runs. The
// owner also keeps notes and reports in `<home>/workspace`, so those files are
// mirrored into the same local FTS5 index. A file is read only when its size or
// modification time differs from the recorded one; a file that disappeared from
// the workspace (or stopped being indexable) loses its index entry.
//
// Only plain text is indexed: `.md` and `.txt` files, with no hidden path
// component and no `node_modules` directory, at most {@link WORKSPACE_MAX_BYTES}
// bytes, without NUL bytes. Anything else is left out on purpose.

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type { RecallIndex } from './recall.js'

/** Files above this size are not indexed; the owner's notes are far smaller. */
export const WORKSPACE_MAX_BYTES = 1024 * 1024

/** Extensions of the workspace files that become recall documents. */
export const WORKSPACE_TEXT_EXTENSIONS = ['.md', '.txt'] as const

/** Directory names that are never walked, at any depth. */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])

/** Bounds one refresh so a pathological workspace cannot stall a turn forever. */
const MAX_FILES = 20_000
const MAX_DEPTH = 24

const STATE_TABLE = 'recall_workspace_files'

export interface WorkspaceIndexOptions {
  /** The SQLite database of the daemon (the same one the recall index lives in). */
  db: DatabaseSync
  /** Absolute path of the owner workspace. */
  workspace: string
  /** The recall index the documents are written to. */
  index: RecallIndex
  /** Optional diagnostics sink; refresh itself never throws. */
  log?: (text: string) => void
  maxBytes?: number
}

export interface WorkspaceIndexStats {
  /** Files found by the walk (indexable extension and location). */
  seen: number
  /** Files read and written to the recall index during this refresh. */
  indexed: number
  /** Files unchanged since the previous refresh and therefore not read. */
  unchanged: number
  /** Index entries dropped because their file disappeared or became unindexable. */
  removed: number
}

export interface WorkspaceIndex {
  /** Bring the recall index in line with the current files. Never throws. */
  refresh(): WorkspaceIndexStats
}

interface FileStateRow {
  rel: string
  mtime_ms: number
  size: number
  indexed: number
}

function documentId(rel: string): string {
  return `workspace:${rel}`
}

function isIndexableName(name: string): boolean {
  const lower = name.toLowerCase()
  return WORKSPACE_TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function hasSkippedSegment(rel: string): boolean {
  return rel
    .split('/')
    .some((segment) => segment.startsWith('.') || SKIPPED_DIRECTORIES.has(segment))
}

/** Relative paths (with `/` separators) and absolute paths of the candidate files, sorted by path. */
function walk(root: string, log: (text: string) => void): Array<{ rel: string; abs: string }> {
  const found: Array<{ rel: string; abs: string }> = []
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]

  while (pending.length > 0 && found.length < MAX_FILES) {
    const current = pending.pop() as { dir: string; depth: number }
    if (current.depth > MAX_DEPTH) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch (error) {
      log(`workspace index read failed for ${current.dir}: ${String(error)}`)
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
        pending.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name.startsWith('.')) continue
      if (!isIndexableName(entry.name)) continue
      const abs = join(current.dir, entry.name)
      const rel = relative(root, abs).split(sep).join('/')
      if (hasSkippedSegment(rel)) continue
      found.push({ rel, abs })
    }
  }
  if (found.length >= MAX_FILES) log(`workspace index stopped after ${MAX_FILES} files`)
  found.sort((left, right) => left.rel.localeCompare(right.rel))
  return found
}

/** Text of a candidate file, or `undefined` when the file must not be indexed. */
function readableText(
  abs: string,
  size: number,
  maxBytes: number,
): { ok: true; text: string } | { ok: false; reason: 'size' | 'binary' | 'empty' | 'error' } {
  if (size > maxBytes) return { ok: false, reason: 'size' }
  let buffer: Buffer
  try {
    buffer = readFileSync(abs)
  } catch {
    return { ok: false, reason: 'error' }
  }
  // A NUL byte is enough to tell plain text from a binary document here.
  if (buffer.includes(0)) return { ok: false, reason: 'binary' }
  const text = buffer.toString('utf8')
  if (text.trim() === '') return { ok: false, reason: 'empty' }
  return { ok: true, text }
}

export function createWorkspaceIndex(options: WorkspaceIndexOptions): WorkspaceIndex {
  const { db, workspace, index } = options
  const log = options.log ?? (() => undefined)
  const maxBytes = options.maxBytes ?? WORKSPACE_MAX_BYTES

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (` +
      'rel TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL, indexed INTEGER NOT NULL)',
  )

  const selectAll = db.prepare(`SELECT rel, mtime_ms, size, indexed FROM ${STATE_TABLE}`)
  const upsert = db.prepare(
    `INSERT INTO ${STATE_TABLE} (rel, mtime_ms, size, indexed) VALUES (?, ?, ?, ?) ` +
      'ON CONFLICT (rel) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, indexed = excluded.indexed',
  )
  const drop = db.prepare(`DELETE FROM ${STATE_TABLE} WHERE rel = ?`)

  const refresh = (): WorkspaceIndexStats => {
    const stats: WorkspaceIndexStats = { seen: 0, indexed: 0, unchanged: 0, removed: 0 }
    let previous: FileStateRow[]
    try {
      previous = selectAll.all() as unknown as FileStateRow[]
    } catch (error) {
      log(`workspace index state read failed: ${String(error)}`)
      return stats
    }
    const known = new Map(previous.map((row) => [row.rel, row]))
    const present = new Set<string>()

    for (const file of walk(workspace, log)) {
      stats.seen += 1
      present.add(file.rel)
      const knownFile = known.get(file.rel)
      let size: number
      let mtimeMs: number
      try {
        const stat = statSync(file.abs)
        size = stat.size
        mtimeMs = stat.mtimeMs
      } catch (error) {
        log(`workspace file stat failed for ${file.rel}: ${String(error)}`)
        continue
      }
      // Same size and same mtime: the file was not touched, so it is not read again.
      if (knownFile !== undefined && knownFile.size === size && knownFile.mtime_ms === mtimeMs) {
        stats.unchanged += 1
        continue
      }

      const text = readableText(file.abs, size, maxBytes)
      if (!text.ok && text.reason === 'error') {
        // A transient read error does not become a permanent skip: the state
        // row is untouched, so the next refresh tries the file again.
        log(`workspace file ${file.rel} not read`)
        continue
      }
      try {
        if (!text.ok) {
          if (knownFile !== undefined && knownFile.indexed !== 0) index.remove(documentId(file.rel))
          upsert.run(file.rel, mtimeMs, size, 0)
          if (knownFile !== undefined && knownFile.indexed !== 0) stats.removed += 1
          continue
        }
        index.index({
          id: documentId(file.rel),
          source: file.rel,
          kind: 'workspace',
          text: text.text,
          ts: mtimeMs,
        })
        upsert.run(file.rel, mtimeMs, size, 1)
        stats.indexed += 1
      } catch (error) {
        log(`workspace file ${file.rel} not indexed: ${String(error)}`)
      }
    }

    for (const row of previous) {
      if (present.has(row.rel)) continue
      try {
        index.remove(documentId(row.rel))
        drop.run(row.rel)
        stats.removed += 1
      } catch (error) {
        log(`workspace file ${row.rel} not removed from recall: ${String(error)}`)
      }
    }
    return stats
  }

  return { refresh }
}
