// Wake-up accounting (DESIGN §8.2, §11): every model call of a wake-up turn is
// appended to its own ledger with the label `wake`. There is no cap here on
// purpose: the owner's decision is "count, do not limit".
//
// The harness keeps the token accounting of each step in the `assistant/message`
// event of the durable session (`usage`), so a wake-up turn is read from the
// session log of `main`. Only events appended after the turn began are taken:
// the host snapshots the event count before the prompt.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { Store } from '../../store/src/index.js'

/** Durable session of the owner; wake-ups are ordinary turns of it. */
export const SESSION_MAIN_ID = 'main'

/** Label of a wake-up model call in the usage ledger. */
export const WAKE_USAGE_LABEL = 'wake'

/** Label of a night-consolidation model call in the usage ledger. */
export const DREAM_USAGE_LABEL = 'dream'

const NAMESPACE = 'consciousness-wake-usage'

const STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS wake_usage (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    label TEXT NOT NULL,
    session_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS wake_usage_ts_idx ON wake_usage (ts)`,
  `ALTER TABLE wake_usage ADD COLUMN turn_id TEXT`,
]

const DREAM_NAMESPACE = 'consciousness-dream-usage'

const DREAM_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dream_usage (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    label TEXT NOT NULL,
    session_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS dream_usage_ts_idx ON dream_usage (ts)`,
  `ALTER TABLE dream_usage ADD COLUMN turn_id TEXT`,
]

/** Token accounting of one model call; counts are disjoint, as the provider reported them. */
export interface SessionModelUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

export interface WakeUsageStore {
  /** Append one turn's calls with a shared id; malformed numbers throw instead of storing a hole. */
  record(usages: readonly SessionModelUsage[], options?: { at?: number; sessionId?: string }): void
  /** Rows in insertion order, for diagnostics and tests. */
  rows(): Array<SessionModelUsage & { at: number; label: string; sessionId: string; turnId: string }>
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`wake usage: ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Create (migrate) one labelled turn ledger in the shared state database. */
function createTurnUsageStore(
  store: Pick<Store, 'db' | 'migrate'>,
  namespace: string,
  steps: readonly string[],
  table: string,
  label: string,
): WakeUsageStore {
  store.migrate(namespace, steps)
  const insert = store.db.prepare(
    `INSERT INTO ${table}
       (ts, label, session_id, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const select = store.db.prepare(
    `SELECT ts, label, session_id, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, turn_id
     FROM ${table} ORDER BY id`,
  )
  return {
    record(usages, options = {}) {
      const at = nonNegativeInteger(options.at ?? Date.now(), 'at')
      const sessionId = options.sessionId ?? SESSION_MAIN_ID
      const turnId = randomUUID()
      for (const usage of usages) {
        insert.run(
          at,
          label,
          sessionId,
          nonNegativeInteger(usage.inputTokens, 'inputTokens'),
          nonNegativeInteger(usage.cacheReadTokens, 'cacheReadTokens'),
          nonNegativeInteger(usage.cacheWriteTokens, 'cacheWriteTokens'),
          nonNegativeInteger(usage.outputTokens, 'outputTokens'),
          turnId,
        )
      }
    },
    rows() {
      return (select.all() as Array<Record<string, unknown>>).map((row) => ({
        at: Number(row.ts),
        label: String(row.label),
        sessionId: String(row.session_id),
        // Before turn ids, record() already stamped every call of a batch with
        // the same session and millisecond. Preserve that historical grouping.
        turnId: row.turn_id === null ? `legacy:${row.session_id}:${row.ts}` : String(row.turn_id),
        inputTokens: Number(row.input_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        outputTokens: Number(row.output_tokens),
      }))
    },
  }
}

/** Create (migrate) the wake-up usage ledger in the shared state database. */
export function createWakeUsageStore(store: Pick<Store, 'db' | 'migrate'>): WakeUsageStore {
  return createTurnUsageStore(store, NAMESPACE, STEPS, 'wake_usage', WAKE_USAGE_LABEL)
}

/**
 * Create (migrate) the night-consolidation ledger. It is separate from the
 * wake-up one so a night turn is countable on its own (`dream` label); the
 * owner's budget reports read both through their own tables.
 */
export function createDreamUsageStore(store: Pick<Store, 'db' | 'migrate'>): WakeUsageStore {
  return createTurnUsageStore(store, DREAM_NAMESPACE, DREAM_STEPS, 'dream_usage', DREAM_USAGE_LABEL)
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

/** Number of events already in the durable session log; 0 when the log does not exist yet. */
export function countSessionEvents(file: string): number {
  if (!existsSync(file)) return 0
  try {
    return nonEmptyLines(readFileSync(file, 'utf8')).length
  } catch {
    return 0
  }
}

/** Token accounting of every `assistant/message` appended after `fromEventCount`. */
export function readSessionUsage(file: string, fromEventCount: number): SessionModelUsage[] {
  if (!existsSync(file)) return []
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const usages: SessionModelUsage[] = []
  const lines = nonEmptyLines(text)
  for (let index = Math.max(0, Math.trunc(fromEventCount)); index < lines.length; index += 1) {
    let event: unknown
    try {
      event = JSON.parse(lines[index] as string)
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const record = event as { type?: unknown; usage?: unknown; data?: unknown }
    if (record.type !== 'assistant/message') continue
    // The durable event is `{ type, data: { message, usage } }`: the token
    // accounting of the step travels with the assembled assistant message.
    // The top-level field is accepted for a log written by an older runner.
    const data = record.data
    const usage =
      (data !== null && typeof data === 'object' ? (data as { usage?: unknown }).usage : undefined) ?? record.usage
    if (usage === null || typeof usage !== 'object') continue
    const fields = usage as Record<string, unknown>
    const inputTokens = fields.inputTokens
    const outputTokens = fields.outputTokens
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') continue
    const cacheReadTokens = typeof fields.cacheReadTokens === 'number' ? fields.cacheReadTokens : 0
    const cacheWriteTokens = typeof fields.cacheWriteTokens === 'number' ? fields.cacheWriteTokens : 0
    usages.push({ inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens })
  }
  return usages
}

function immediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Read the usage of a turn that has just finished. The session log is written by
 * a queued append per event, so a few microtask turns may separate the end of the
 * prompt from the bytes on disk; `setImmediate` is used rather than a timer so a
 * fake clock cannot stall the read.
 *
 * Only a durable session is readable here. A transient session (the night
 * consolidation turn) is removed by the runner when the turn settles, so that
 * turn is accounted from the runner's per-turn report instead.
 */
export async function collectSessionUsage(
  file: string,
  fromEventCount: number,
  attempts = 20,
): Promise<SessionModelUsage[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await immediate()
    const found = readSessionUsage(file, fromEventCount)
    if (found.length > 0) return found
  }
  return readSessionUsage(file, fromEventCount)
}
