// Full-text index of the past conversations.
//
// The owner's `main` session and the sessions of detached tasks keep their
// messages in `dsh/sessions/<id>/events.jsonl`. This namespace mirrors the user
// and assistant messages of those logs into FTS5 so the daemon can search them
// without reading every log of the installation on each query. The text is
// copied, not referenced: a log can be rotated by `/new` while its past stays
// searchable.
//
// The index itself is a migration of the `session_index` namespace, so an
// existing state.db gains it once and keeps it across restarts.

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/** Message role stored in the index. Tool results and service insertions never land here. */
export type SessionMessageRole = 'user' | 'assistant'

/** One indexed message. `seq` and `at` are the coordinates of the source log event. */
export interface SessionMessageRecord {
  sessionId: string
  seq: number
  at: number
  role: SessionMessageRole
  text: string
}

/** One search result: the coordinates of the message and the excerpt around the match. */
export interface SessionSearchHit {
  sessionId: string
  seq: number
  at: number
  role: SessionMessageRole
  excerpt: string
}

export interface SessionSearchOptions {
  limit?: number
  /** Inclusive lower bound of the message time, epoch milliseconds. */
  since?: number
  /** Inclusive upper bound of the message time, epoch milliseconds. */
  until?: number
}

/** How far one session log has been read and which generation it was. */
export interface SessionIndexCheckpoint {
  /** Highest sequence number already covered, or `-1` for an unseen session. */
  lastSeq: number
  /** Identity of the first event of the log the checkpoint belongs to. */
  firstEvent?: string
}

export interface SessionIndex {
  /**
   * Append the messages of one session and remember how far its log has been
   * read. One transaction: a failed write leaves neither the rows nor the
   * checkpoint behind, so the next catch-up retries the same range.
   */
  record(
    sessionId: string,
    messages: readonly SessionMessageRecord[],
    seenThrough: number,
    firstEvent?: string,
  ): void
  /** Checkpoint of one session, or `{ lastSeq: -1 }` for an unseen session. */
  checkpoint(sessionId: string): SessionIndexCheckpoint
  /** Highest sequence number already covered by the index, or `-1` for an unseen session. */
  lastSeq(sessionId: string): number
  /** Drop every row of one session; a new log with the same id (owner `/new`) starts over. */
  remove(sessionId: string): void
  /** Newest-first full-text search, at most {@link SESSION_SEARCH_MAX_LIMIT} rows. */
  search(query: string, options?: SessionSearchOptions): SessionSearchHit[]
  /** Number of indexed messages; for diagnostics and tests. */
  size(): number
}

export const SESSION_SEARCH_MAX_LIMIT = 20
export const SESSION_SEARCH_DEFAULT_LIMIT = 10

const TABLE = 'session_messages_fts'
const TEXT_COLUMN = 4

// Applied by openStore under its own namespace. FTS5 is part of the bundled
// SQLite, the same engine packages/memory already relies on.
export const SESSION_INDEX_STEPS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
    session_id UNINDEXED,
    seq UNINDEXED,
    at UNINDEXED,
    role UNINDEXED,
    text
  )`,
  `CREATE TABLE IF NOT EXISTS session_index_state (
    session_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    first_event TEXT
  )`,
]

/** Plain word tokens; FTS5 syntax from the model can never reach MATCH. */
function words(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(tokens.map((token) => token.toLowerCase()))]
}

function toMatchQuery(query: string): string | null {
  const tokens = words(query).slice(0, 64)
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ')
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`session index: ${field} must be a non-negative safe integer`)
  }
  return value
}

function bound(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return SESSION_SEARCH_DEFAULT_LIMIT
  return Math.min(Math.floor(limit), SESSION_SEARCH_MAX_LIMIT)
}

export function createSessionIndex(db: DatabaseSync): SessionIndex {
  const selectLast = db.prepare('SELECT last_seq, first_event FROM session_index_state WHERE session_id = ?')
  const upsertLast = db.prepare(
    `INSERT INTO session_index_state (session_id, last_seq, first_event) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET last_seq = excluded.last_seq, first_event = excluded.first_event`,
  )
  const removeRows = db.prepare(`DELETE FROM ${TABLE} WHERE session_id = ?`)
  const removeState = db.prepare('DELETE FROM session_index_state WHERE session_id = ?')
  const insert = db.prepare(
    `INSERT INTO ${TABLE} (session_id, seq, at, role, text) VALUES (?, ?, ?, ?, ?)`,
  )
  const count = db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`)
  const searchStatement = db.prepare(
    `SELECT session_id, seq, at, role,
       snippet(${TABLE}, ${TEXT_COLUMN}, '', '', '…', 24) AS excerpt
     FROM ${TABLE}
     WHERE ${TABLE} MATCH ? AND at >= ? AND at <= ?
     ORDER BY bm25(${TABLE}), at DESC
     LIMIT ?`,
  )

  function record(
    sessionId: string,
    messages: readonly SessionMessageRecord[],
    seenThrough: number,
    firstEvent?: string,
  ): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('session index: sessionId must be a non-empty string')
    }
    const checkpoint = nonNegativeSafeInteger(seenThrough, 'seenThrough')
    for (const message of messages) {
      if (message.sessionId !== sessionId) {
        throw new TypeError(`session index: message of "${message.sessionId}" cannot be stored under "${sessionId}"`)
      }
      nonNegativeSafeInteger(message.seq, 'seq')
      nonNegativeSafeInteger(message.at, 'at')
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new TypeError(`session index: unknown role "${String(message.role)}"`)
      }
      if (typeof message.text !== 'string' || message.text.trim() === '') {
        throw new TypeError('session index: text must be a non-empty string')
      }
    }

    const ownTransaction = !db.isTransaction
    if (ownTransaction) db.exec('BEGIN')
    try {
      for (const message of messages) {
        insert.run(message.sessionId, message.seq, message.at, message.role, message.text)
      }
      upsertLast.run(sessionId, checkpoint, firstEvent ?? null)
      if (ownTransaction) db.exec('COMMIT')
    } catch (error) {
      if (ownTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    record,
    checkpoint(sessionId) {
      const row = selectLast.get(sessionId) as { last_seq: number | bigint; first_event: string | null } | undefined
      if (row === undefined) return { lastSeq: -1 }
      const lastSeq = typeof row.last_seq === 'bigint' ? Number(row.last_seq) : row.last_seq
      return row.first_event === null ? { lastSeq } : { lastSeq, firstEvent: row.first_event }
    },
    lastSeq(sessionId) {
      const row = selectLast.get(sessionId) as { last_seq: number | bigint } | undefined
      if (row === undefined) return -1
      return typeof row.last_seq === 'bigint' ? Number(row.last_seq) : row.last_seq
    },
    remove(sessionId) {
      const ownTransaction = !db.isTransaction
      if (ownTransaction) db.exec('BEGIN')
      try {
        removeRows.run(sessionId)
        removeState.run(sessionId)
        if (ownTransaction) db.exec('COMMIT')
      } catch (error) {
        if (ownTransaction) db.exec('ROLLBACK')
        throw error
      }
    },
    search(query, options = {}) {
      const match = toMatchQuery(query)
      if (match === null) return []
      const since = options.since ?? 0
      const until = options.until ?? Number.MAX_SAFE_INTEGER
      if (!Number.isFinite(since) || !Number.isFinite(until)) return []
      const limit = bound(options.limit)
      const rows = searchStatement.all(match, since, until, limit) as Array<Record<string, SQLOutputValue>>
      return rows.map((row) => ({
        sessionId: String(row.session_id),
        seq: Number(row.seq),
        at: Number(row.at),
        role: row.role === 'assistant' ? 'assistant' : 'user',
        excerpt: String(row.excerpt ?? ''),
      }))
    },
    size() {
      const row = count.get() as { n: number | bigint } | undefined
      if (row === undefined) return 0
      return typeof row.n === 'bigint' ? Number(row.n) : row.n
    },
  }
}
