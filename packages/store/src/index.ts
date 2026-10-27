import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SESSION_INDEX_STEPS, createSessionIndex, type SessionIndex } from './session-index.js'
import {
  REPEAT_OFFER_CARD_RETENTION_DAYS,
  REPEAT_OFFER_NAMESPACE,
  REPEAT_OFFER_TURN_RETENTION_DAYS,
  createRepeatOfferStore,
  type RepeatOfferStore,
} from './repeat-offer.js'

export {
  createRepeatOfferStore,
  REPEAT_OFFER_CARD_RETENTION_DAYS,
  REPEAT_OFFER_NAMESPACE,
  REPEAT_OFFER_TURN_RETENTION_DAYS,
  type AddRepeatOfferCardInput,
  type RecordRepeatOfferTurnInput,
  type RepeatOfferCard,
  type RepeatOfferCardStatus,
  type RepeatOfferStore,
  type RepeatOfferSuppression,
  type RepeatOfferTurn,
} from './repeat-offer.js'

export {
  createSessionIndex,
  SESSION_INDEX_STEPS,
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  type SessionIndex,
  type SessionMessageRecord,
  type SessionMessageRole,
  type SessionSearchHit,
  type SessionSearchOptions,
} from './session-index.js'

export interface IngressMessage {
  channel: string
  externalId: string
  payload: unknown
}

export interface IngressPutResult {
  id: number
  isNew: boolean
}

export interface PendingIngress {
  id: number
  channel: string
  externalId: string
  payload: unknown
  receivedAt: number
  /**
   * Processing attempts of this row so far. Raised by `beginAttempt` before
   * the work starts and durable across restarts, so a row that keeps killing
   * the daemon is never replayed forever.
   */
  attempts: number
}

export interface Ingress {
  /** Durable put: the (channel, externalId) pair is stored at most once. */
  put(message: IngressMessage): IngressPutResult
  markProcessed(id: number): void
  /**
   * Raise the attempt counter of a pending row by one and return the new value.
   * A processed or missing row is left alone (its current counter is returned,
   * or 0 when there is no row). The write commits at once, before any work on
   * the row: a process that dies mid-turn keeps the count.
   */
  beginAttempt(id: number): number
  /** Unprocessed rows in arrival order, payload decoded from JSON. */
  pending(): PendingIngress[]
}

export interface Kv {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** One model call as the harness reported it. Token counts are disjoint. */
export interface UsageRecord {
  /** When the call finished, Unix epoch milliseconds. Defaults to `Date.now()`. */
  at?: number
  /** Durable session that made the call (`main` for the owner chat). */
  sessionId: string
  /** Provider model id exactly as the adapter reported it. */
  model: string
  /** Uncached input tokens. */
  inputTokens: number
  /** Input tokens served from the provider cache. */
  cacheReadTokens?: number
  /** Input tokens written to the provider cache. */
  cacheWriteTokens?: number
  outputTokens: number
  /**
   * Cost in US dollars, or `null` when the model has no price. An unknown
   * price is stored as SQL NULL and never folded into a zero.
   */
  costUsd: number | null
}

/** Aggregates of one time window of the usage table. */
export interface UsageSummary {
  /** Sum of priced calls in the window, USD. Unpriced calls add nothing. */
  costUsd: number
  /** Every call in the window, priced or not. */
  calls: number
  /** Calls in the window whose price is unknown (`cost IS NULL`). */
  unpricedCalls: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

export interface UsageReport {
  /** Calls since the start of the current UTC day. */
  today: UsageSummary
  /** Calls in the rolling seven days. */
  last7Days: UsageSummary
  /** Calls in the rolling thirty days. */
  last30Days: UsageSummary
  /**
   * `cacheRead / (input + cacheRead + cacheWrite)` over the thirty day window,
   * as a ratio in [0, 1]; `null` when the window has no input tokens at all.
   */
  cacheReadShare: number | null
}

/** Durable money accounting per model call (DESIGN §10, §11: money is counted, never capped). */
export interface Usage {
  /** Append one row. Throws on malformed numbers instead of silently storing a hole. */
  record(record: UsageRecord): void
  /** Window aggregates for the owner's reports. */
  report(now?: number): UsageReport
  /**
   * Aggregates of the calls at or after `since` (Unix epoch milliseconds), in
   * the same shape as one window of {@link report}. The current session of
   * `main` is read with this boundary; the rows themselves stay untouched.
   */
  summarySince(since: number): UsageSummary
  /** Rows in insertion order; for diagnostics and tests. */
  rows(): UsageRecord[]
}

/** One permanent permission the owner gave with the "Всегда" button of a card. */
export interface ApprovalPermission {
  id: number
  /** `exec` for the sandboxed tool, `host` for `host_exec` and ssh. */
  kind: string
  /** Alias of the host for `host`; an empty string for `exec`. */
  host: string
  command: string
  /** Unix epoch milliseconds of the moment the owner pressed "Всегда". */
  createdAt: number
}

/**
 * Permanent approvals of exact commands. They live in the shared SQLite file,
 * so a permission survives a restart; a guard `deny` is decided by the tool
 * before this table is ever read.
 */
export interface ApprovalPermissions {
  list(): ApprovalPermission[]
  has(kind: string, host: string, command: string): boolean
  /** Store the permission once; the first date of an existing row is kept. */
  add(kind: string, host: string, command: string, at?: number): ApprovalPermission
  remove(id: number): boolean
}

export interface Store {
  /** Raw handle for packages that keep their own tables in the same database. */
  db: DatabaseSync
  /** Apply only the steps this namespace has not seen yet, one transaction per step. */
  migrate(namespace: string, steps: readonly string[]): void
  ingress: Ingress
  kv: Kv
  usage: Usage
  /** Permanent "always allow" decisions of the owner. */
  approvals: ApprovalPermissions
  /** FTS5 index of the past conversations of `main` and the task sessions. */
  sessionIndex: SessionIndex
  /** Turns, cards and refusals of the repeat-offer initiative. */
  repeatOffers: RepeatOfferStore
  close(): void
}

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _store_migrations (
  namespace TEXT PRIMARY KEY,
  version INTEGER NOT NULL
)
`

// Tables owned by the `store` namespace. Each entry is applied as one migration step.
const STORE_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ingress (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,
    external_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE (channel, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS ingress_pending_idx ON ingress (id) WHERE processed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Processing attempts of an ingress row. A daemon that keeps dying on the
  // same message (systemd Restart=on-failure) must not replay it forever; the
  // default 0 also gives the counter to rows of a database written before it.
  `ALTER TABLE ingress ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
]

// Tables owned by the `usage` namespace. The cost column is nullable on purpose:
// a model missing from the price table is unknown, not free.
const USAGE_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_ts_idx ON usage (ts)`,
]

const DAY_MS = 86_400_000

/**
 * Tables owned by the `approvals` namespace. The command text is stored as
 * plain text so the owner can read it in /approvals and a row is unique per
 * exact (kind, host, command) triple. AUTOINCREMENT keeps an id from ever
 * being handed out again: a stale "Отозвать" button of /approvals carries the
 * id of a revoked row and must not hit a permission granted after it.
 */
const APPROVALS_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS approval_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    host TEXT NOT NULL,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (kind, host, command)
  )`,
]

interface VersionRow {
  version: number
}

interface IdRow {
  id: number
}

interface IngressRow {
  id: number
  channel: string
  external_id: string
  payload: string
  received_at: number
  attempts: number
}

interface ValueRow {
  value: string
}

interface UsageRow {
  ts: number
  session_id: string
  model: string
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  cost_usd: number | null
}

interface UsageAggregateRow {
  cost: number | null
  calls: number | bigint
  unpriced: number | bigint
  input: number | null
  cache_read: number | null
  cache_write: number | null
  output: number | null
}

interface ApprovalRow {
  id: number
  kind: string
  host: string
  command: string
  created_at: number
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`usage.record: ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Start of the UTC day containing `at`, in epoch milliseconds. */
function utcDayStart(at: number): number {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function initialize(db: DatabaseSync): Store {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(MIGRATIONS_TABLE)

  const versionStatement = db.prepare('SELECT version FROM _store_migrations WHERE namespace = ?')
  const setVersionStatement = db.prepare(
    `INSERT INTO _store_migrations (namespace, version) VALUES (?, ?)
     ON CONFLICT (namespace) DO UPDATE SET version = excluded.version`,
  )

  function migrate(namespace: string, steps: readonly string[]): void {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new Error('migrate: namespace must be a non-empty string')
    }
    if (!Array.isArray(steps)) {
      throw new Error(`migrate(${namespace}): steps must be an array of SQL strings`)
    }
    for (let index = 0; index < steps.length; index += 1) {
      if (typeof steps[index] !== 'string') {
        throw new Error(`migrate(${namespace}): step ${index} is not a string`)
      }
    }

    const current = versionStatement.get(namespace) as VersionRow | undefined
    let index = current?.version ?? 0

    while (index < steps.length) {
      db.exec('BEGIN IMMEDIATE')
      try {
        // Another connection may have advanced this namespace while we waited for the write lock.
        const fresh = versionStatement.get(namespace) as VersionRow | undefined
        const applied = fresh?.version ?? 0
        if (applied > index) {
          db.exec('COMMIT')
          index = applied
          continue
        }

        db.exec(steps[index] as string)
        setVersionStatement.run(namespace, index + 1)
        db.exec('COMMIT')
        index += 1
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Keep the original step error; a rollback failure must not mask it.
        }
        throw error
      }
    }
  }

  migrate('store', STORE_STEPS)
  migrate('usage', USAGE_STEPS)
  migrate('approvals', APPROVALS_STEPS)
  migrate('session_index', SESSION_INDEX_STEPS)

  const findIngress = db.prepare('SELECT id FROM ingress WHERE channel = ? AND external_id = ?')
  const insertIngress = db.prepare(
    `INSERT INTO ingress (channel, external_id, payload, received_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (channel, external_id) DO NOTHING`,
  )
  const markProcessedStatement = db.prepare(
    'UPDATE ingress SET processed_at = ? WHERE id = ? AND processed_at IS NULL',
  )
  const beginAttemptStatement = db.prepare(
    'UPDATE ingress SET attempts = attempts + 1 WHERE id = ? AND processed_at IS NULL',
  )
  const attemptCountStatement = db.prepare('SELECT attempts FROM ingress WHERE id = ?')
  const pendingStatement = db.prepare(
    'SELECT id, channel, external_id, payload, received_at, attempts FROM ingress WHERE processed_at IS NULL ORDER BY id',
  )
  const getKv = db.prepare('SELECT value FROM kv WHERE key = ?')
  const setKv = db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )

  const listApprovalPermissions = db.prepare(
    'SELECT id, kind, host, command, created_at FROM approval_permissions ORDER BY created_at, id',
  )
  const findApprovalPermission = db.prepare(
    'SELECT id, kind, host, command, created_at FROM approval_permissions WHERE kind = ? AND host = ? AND command = ?',
  )
  const insertApprovalPermission = db.prepare(
    `INSERT INTO approval_permissions (kind, host, command, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, host, command) DO NOTHING`,
  )
  const removeApprovalPermission = db.prepare('DELETE FROM approval_permissions WHERE id = ?')

  const insertUsage = db.prepare(
    `INSERT INTO usage
       (ts, session_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const allUsage = db.prepare(
    `SELECT ts, session_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd
     FROM usage ORDER BY id`,
  )
  const usageWindow = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd END), 0) AS cost,
       COUNT(*) AS calls,
       COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
       COALESCE(SUM(input_tokens), 0) AS input,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
       COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
       COALESCE(SUM(output_tokens), 0) AS output
     FROM usage WHERE ts >= ?`,
  )

  function summarize(since: number): UsageSummary {
    const row = usageWindow.get(since) as UsageAggregateRow | undefined
    if (row === undefined) {
      return {
        costUsd: 0,
        calls: 0,
        unpricedCalls: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }
    }
    return {
      costUsd: row.cost === null ? 0 : toNumber(row.cost),
      calls: toNumber(row.calls),
      unpricedCalls: toNumber(row.unpriced),
      inputTokens: row.input === null ? 0 : toNumber(row.input),
      cacheReadTokens: row.cache_read === null ? 0 : toNumber(row.cache_read),
      cacheWriteTokens: row.cache_write === null ? 0 : toNumber(row.cache_write),
      outputTokens: row.output === null ? 0 : toNumber(row.output),
    }
  }

  const usage: Usage = {
    record(record) {
      if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
        throw new TypeError('usage.record: sessionId must be a non-empty string')
      }
      if (typeof record.model !== 'string' || record.model.length === 0) {
        throw new TypeError('usage.record: model must be a non-empty string')
      }
      const at = record.at === undefined ? Date.now() : record.at
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
        throw new TypeError('usage.record: at must be a non-negative safe integer of epoch milliseconds')
      }
      const inputTokens = nonNegativeInteger(record.inputTokens, 'inputTokens')
      const cacheReadTokens = nonNegativeInteger(record.cacheReadTokens ?? 0, 'cacheReadTokens')
      const cacheWriteTokens = nonNegativeInteger(record.cacheWriteTokens ?? 0, 'cacheWriteTokens')
      const outputTokens = nonNegativeInteger(record.outputTokens, 'outputTokens')
      const costUsd = record.costUsd
      if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
        throw new TypeError('usage.record: costUsd must be null or a finite non-negative number')
      }
      insertUsage.run(at, record.sessionId, record.model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd)
    },
    report(now = Date.now()) {
      const at = Number.isFinite(now) ? Math.trunc(now) : Date.now()
      const today = summarize(utcDayStart(at))
      const last7Days = summarize(at - 7 * DAY_MS)
      const last30Days = summarize(at - 30 * DAY_MS)
      const denominator = last30Days.inputTokens + last30Days.cacheReadTokens + last30Days.cacheWriteTokens
      return {
        today,
        last7Days,
        last30Days,
        cacheReadShare: denominator === 0 ? null : last30Days.cacheReadTokens / denominator,
      }
    },
    summarySince(since) {
      // An unreadable boundary must not silently become a zero window: clamp it
      // to the epoch, which every stored row satisfies.
      const at = Number.isFinite(since) ? Math.trunc(since) : 0
      return summarize(at)
    },
    rows() {
      const rows = allUsage.all() as unknown as UsageRow[]
      return rows.map((row) => ({
        at: toNumber(row.ts),
        sessionId: row.session_id,
        model: row.model,
        inputTokens: toNumber(row.input_tokens),
        cacheReadTokens: toNumber(row.cache_read_tokens),
        cacheWriteTokens: toNumber(row.cache_write_tokens),
        outputTokens: toNumber(row.output_tokens),
        costUsd: row.cost_usd === null ? null : toNumber(row.cost_usd),
      }))
    },
  }

  let closed = false

  const ingress: Ingress = {
    put(message) {
      if (typeof message.channel !== 'string' || message.channel.length === 0) {
        throw new Error('ingress.put: channel must be a non-empty string')
      }
      if (typeof message.externalId !== 'string' || message.externalId.length === 0) {
        throw new Error('ingress.put: externalId must be a non-empty string')
      }
      const payload = JSON.stringify(message.payload) ?? 'null'
      const result = insertIngress.run(message.channel, message.externalId, payload, Date.now())
      if (toNumber(result.changes) === 1) {
        return { id: toNumber(result.lastInsertRowid), isNew: true }
      }
      const existing = findIngress.get(message.channel, message.externalId) as IdRow | undefined
      if (existing === undefined) {
        throw new Error(
          `ingress.put: (${message.channel}, ${message.externalId}) conflicted but no row was found`,
        )
      }
      return { id: existing.id, isNew: false }
    },
    markProcessed(id) {
      markProcessedStatement.run(Date.now(), id)
    },
    beginAttempt(id) {
      beginAttemptStatement.run(id)
      const row = attemptCountStatement.get(id) as { attempts: number | bigint } | undefined
      return row === undefined ? 0 : toNumber(row.attempts)
    },
    pending() {
      const rows = pendingStatement.all() as unknown as IngressRow[]
      return rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        externalId: row.external_id,
        payload: JSON.parse(row.payload) as unknown,
        receivedAt: row.received_at,
        attempts: toNumber(row.attempts),
      }))
    },
  }

  const kv: Kv = {
    get(key) {
      const row = getKv.get(key) as ValueRow | undefined
      return row?.value
    },
    set(key, value) {
      setKv.run(key, value)
    },
  }

  function permissionOf(row: ApprovalRow): ApprovalPermission {
    return {
      id: toNumber(row.id),
      kind: row.kind,
      host: row.host,
      command: row.command,
      createdAt: toNumber(row.created_at),
    }
  }

  function permissionText(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new TypeError(`approvals: ${field} must be a string`)
    return value
  }

  const approvals: ApprovalPermissions = {
    list() {
      return (listApprovalPermissions.all() as unknown as ApprovalRow[]).map(permissionOf)
    },
    has(kind, host, command) {
      return findApprovalPermission.get(kind, host, command) !== undefined
    },
    add(kind, host, command, at = Date.now()) {
      const safeKind = permissionText(kind, 'kind')
      const safeHost = permissionText(host, 'host')
      const safeCommand = permissionText(command, 'command')
      if (safeCommand.length === 0) throw new TypeError('approvals.add: command must not be empty')
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) {
        throw new TypeError('approvals.add: at must be a non-negative safe integer of epoch milliseconds')
      }
      insertApprovalPermission.run(safeKind, safeHost, safeCommand, at)
      const row = findApprovalPermission.get(safeKind, safeHost, safeCommand) as ApprovalRow | undefined
      if (row === undefined) throw new Error('approvals.add: the row was not stored')
      return permissionOf(row)
    },
    remove(id) {
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new TypeError('approvals.remove: id must be a safe integer')
      }
      return toNumber(removeApprovalPermission.run(id).changes) > 0
    },
  }

  return {
    db,
    migrate,
    ingress,
    kv,
    usage,
    approvals,
    sessionIndex: createSessionIndex(db),
    repeatOffers: createRepeatOfferStore({ db, migrate }),
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}

// The database holds the owner's dialogue history: keep it and its WAL
// sidecars readable by the owner only. A chmod failure (foreign owner) must not
// break opening, so it is reported with a single log line.
function restrictPermissions(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue
    try {
      chmodSync(file, 0o600)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[dshbot] store: не удалось выставить права 0600 на ${file}: ${reason}\n`)
    }
  }
}

export function openStore(path: string): Store {
  const isFile = path !== ':memory:'
  if (isFile) {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) {
      // SQLite gives -wal/-shm the mode of the database file, so create it private.
      try {
        closeSync(openSync(path, 'a', 0o600))
      } catch {
        // Opening reports the real error below.
      }
    }
  }

  const db = new DatabaseSync(path)
  try {
    const store = initialize(db)
    if (isFile) restrictPermissions(path)
    return store
  } catch (error) {
    try {
      db.close()
    } catch {
      // Keep the original initialization error.
    }
    throw error
  }
}
