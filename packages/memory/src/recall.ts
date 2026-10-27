// Recall index on the built-in SQLite FTS5.
//
// Queries are rebuilt from plain word characters before reaching MATCH, so
// arbitrary user/agent text (quotes, `*`, `:`, `-`, `NEAR(`) can never be
// interpreted as FTS5 syntax. Schedule documents are demoted because repeated
// cron vocabulary would otherwise crowd out journal and chat memories.
// Workspace files are indexed by the workspace indexer (./workspace.ts); their
// hits carry the 1-based range of the lines that matched.

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

export const RECALL_KINDS = ['chat', 'journal', 'knowledge', 'schedule', 'workspace'] as const

export type RecallKind = (typeof RECALL_KINDS)[number]

export interface RecallDocument {
  id: string
  source: string
  kind: RecallKind
  text: string
  ts: number
}

export interface RecallHit {
  id: string
  source: string
  kind: RecallKind
  ts: number
  snippet: string
  /** 1-based inclusive line range of the match; always set on `workspace` hits. */
  lines?: { start: number; end: number }
  /**
   * How many distinct query words of the search were actually found in this
   * document. Used to tell a strong match from a hit that only shares one
   * common word with the request. Absent on indexes that do not report it.
   */
  matched?: number
}

export interface RecallSearchOptions {
  limit?: number
}

export interface RecallIndex {
  index(doc: RecallDocument): void
  /** Drop one document; a missing id is a no-op. */
  remove(id: string): void
  search(query: string, options?: RecallSearchOptions): RecallHit[]
}


const TABLE = 'recall_fts'
const TEXT_COLUMN = 4
const DEFAULT_LIMIT = 10
const SCHEDULE_WEIGHT = 0.35
/**
 * Age at which the recency factor halves. Relevance still leads the ranking,
 * but a month-old note no longer outranks a fresh one on a hair-thin text
 * advantage: `bm25 * 1 / (1 + age / HALF_LIFE)`.
 */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

function words(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(tokens.map((token) => token.toLowerCase()))]
}

/** Lowercase and strip diacritics, so a folded FTS match counts as the query word. */
function foldWord(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

/**
 * Distinct query words that FTS5 marked in the document. `marked` is the text
 * returned by `highlight()` with the per-search markers around every matched
 * phrase.
 */
function matchedWordCount(marked: string, open: string, close: string, query: string[]): number {
  const wanted = new Set(query.map(foldWord))
  const found = new Set<string>()
  let at = marked.indexOf(open)
  while (at >= 0) {
    const from = at + open.length
    const to = marked.indexOf(close, from)
    if (to < 0) break
    for (const token of marked.slice(from, to).match(/[\p{L}\p{N}_]+/gu) ?? []) {
      const folded = foldWord(token)
      if (wanted.has(folded)) found.add(folded)
    }
    at = marked.indexOf(open, to + close.length)
  }
  return found.size
}


/** FTS5 query made only of quoted terms; an empty query matches nothing. */
function toMatchQuery(query: string): string | null {
  const tokens = words(query).slice(0, 64)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

/**
 * 1-based inclusive range of the lines that FTS5 itself matched. `marked` is
 * the document as returned by `highlight()` with `open`/`close` around every
 * matched phrase, so line numbers follow the FTS5 tokenizer (diacritics
 * folding, `_` as a separator) rather than a second, diverging rule set. The
 * markers contain no newline, so marked and original line numbers agree. A
 * document without markers (not expected for a MATCH row) spans all its lines.
 */
function matchedLines(marked: string, open: string, close: string): { start: number; end: number } {
  const lineAt = (offset: number): number => marked.slice(0, offset).split('\n').length
  const first = marked.indexOf(open)
  const last = marked.lastIndexOf(close)
  if (first < 0 || last < 0) {
    const total = marked.split('\n').length
    return { start: 1, end: Math.max(1, marked.endsWith('\n') ? total - 1 : total) }
  }
  return { start: lineAt(first), end: lineAt(last) }
}

export function createRecallIndex(db: DatabaseSync): RecallIndex {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(` +
      'id UNINDEXED, source UNINDEXED, kind UNINDEXED, ts UNINDEXED, text)',
  )

  const remove = db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`)
  const insert = db.prepare(`INSERT INTO ${TABLE} (id, source, kind, text, ts) VALUES (?, ?, ?, ?, ?)`)
  const select = db.prepare(
    `SELECT id, source, kind, ts, ` +
      `highlight(${TABLE}, ${TEXT_COLUMN}, ?, ?) AS body, ` +
      `snippet(${TABLE}, ${TEXT_COLUMN}, '', '', '…', 32) AS snippet ` +
      `FROM ${TABLE} WHERE ${TABLE} MATCH ? ` +
      `ORDER BY bm25(${TABLE}) * CASE WHEN kind = 'schedule' THEN ${SCHEDULE_WEIGHT} ELSE 1.0 END * ` +
      `(1.0 / (1.0 + max(0, ? - ts) / ?)), ` +
      `CASE WHEN kind = 'schedule' THEN 1 ELSE 0 END, ` +
      'ts DESC LIMIT ?',
  )

  const index = (doc: RecallDocument): void => {
    if (typeof doc.id !== 'string' || doc.id === '') {
      throw new TypeError('recall id must be a non-empty string')
    }
    if (typeof doc.source !== 'string') {
      throw new TypeError('recall source must be a string')
    }
    if (!RECALL_KINDS.includes(doc.kind)) {
      throw new TypeError(`recall kind must be one of ${RECALL_KINDS.join(', ')}`)
    }
    if (typeof doc.text !== 'string') {
      throw new TypeError('recall text must be a string')
    }
    if (typeof doc.ts !== 'number' || !Number.isFinite(doc.ts)) {
      throw new TypeError('recall ts must be a finite number')
    }

    // Same id means replacement, not another document. Keep the delete and
    // insert atomic so a failed insert cannot lose the previous document.
    const ownTransaction = !db.isTransaction
    if (ownTransaction) db.exec('BEGIN')
    try {
      remove.run(doc.id)
      insert.run(doc.id, doc.source, doc.kind, doc.text, doc.ts)
      if (ownTransaction) db.exec('COMMIT')
    } catch (error) {
      if (ownTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  const search = (query: string, options: RecallSearchOptions = {}): RecallHit[] => {
    const requested = options.limit ?? DEFAULT_LIMIT
    if (!Number.isFinite(requested) || requested <= 0) return []
    const limit = Math.floor(requested)

    const match = toMatchQuery(query)
    if (match === null) return []
    const queryWords = words(query).slice(0, 64)
    // Per-search markers cannot collide with text already in a document.
    const nonce = randomUUID()
    const open = `\u0001${nonce}<`
    const close = `>${nonce}\u0001`

    const rows = select.all(
      open,
      close,
      match,
      Date.now(),
      RECENCY_HALF_LIFE_MS,
      limit,
    ) as Record<string, SQLOutputValue>[]
    return rows.map((row) => {
      const hit: RecallHit = {
        id: String(row.id),
        source: String(row.source),
        kind: row.kind as RecallKind,
        ts: Number(row.ts),
        snippet: String(row.snippet ?? ''),
        matched: matchedWordCount(String(row.body ?? ''), open, close, queryWords),
      }
      if (hit.kind === 'workspace') {
        hit.lines = matchedLines(String(row.body ?? ''), open, close)
      }
      return hit
    })
  }

  const removeDocument = (id: string): void => {
    if (typeof id !== 'string' || id === '') return
    remove.run(id)
  }

  return { index, remove: removeDocument, search }
}
