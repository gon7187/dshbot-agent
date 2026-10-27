// Durable memory of the repeat-offer initiative: the owner's turns with their
// MCP tools, the card that offers a daily run, and the tools the owner asked
// not to offer again.
//
// A turn is one owner message, keyed by the calendar day of the owner's zone
// and stored with its absolute start time and the MCP tools it called. The
// comparison itself lives in packages/app/src/repeat-offer.ts; this module only
// keeps what must survive a restart.
//
// The write is a single row per turn: a turn that called three MCP tools is one
// record with three names, so "one repeat is one card" stays easy to see.

import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Migration namespace of the repeat-offer tables in the shared store. */
export const REPEAT_OFFER_NAMESPACE = 'repeat_offer'

/** How long a turn is kept. Two days are enough to compare, a year is cheap and keeps diagnostics useful. */
export const REPEAT_OFFER_TURN_RETENTION_DAYS = 400

/** How long a decided card is kept, so an old press still answers. */
export const REPEAT_OFFER_CARD_RETENTION_DAYS = 90

const DAY_MS = 86_400_000

/** The subset of the store this module needs. */
export interface RepeatOfferStorage {
  readonly db: DatabaseSync
  migrate(namespace: string, steps: readonly string[]): void
}

const REPEAT_OFFER_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repeat_offer_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    request TEXT NOT NULL,
    tools TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS repeat_offer_turns_day_idx ON repeat_offer_turns (day, started_at)`,
  `CREATE TABLE IF NOT EXISTS repeat_offer_cards (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    tool TEXT NOT NULL,
    time TEXT NOT NULL,
    request TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS repeat_offer_cards_created_idx ON repeat_offer_cards (created_at)`,
  `CREATE TABLE IF NOT EXISTS repeat_offer_suppressions (
    tool TEXT PRIMARY KEY,
    until INTEGER,
    created_at INTEGER NOT NULL
  )`,
]

/** One finished owner turn, as the repeat comparison reads it. */
export interface RepeatOfferTurn {
  day: string
  /** Epoch milliseconds of the moment the turn started. */
  startedAt: number
  request: string
  /** Full names (`mcp__server__tool`) of the MCP tools the turn called. */
  tools: string[]
}

export type RepeatOfferCardStatus = 'pending' | 'accepted' | 'declined' | 'never'

/** One card that offered a daily run of a request. */
export interface RepeatOfferCard {
  id: string
  chatId: number
  /** Full name of the MCP tool the offer is about. */
  tool: string
  /** `ЧЧ:ММ` of the daily run, in the owner's zone. */
  time: string
  request: string
  createdAt: number
  status: RepeatOfferCardStatus
}

/** A silence of one tool: `until` is null for "не предлагать" forever. */
export interface RepeatOfferSuppression {
  tool: string
  until: number | null
  createdAt: number
}

export interface RecordRepeatOfferTurnInput {
  day: string
  startedAt: number
  request: string
  tools: readonly string[]
}

export interface AddRepeatOfferCardInput {
  chatId: number
  tool: string
  time: string
  request: string
  createdAt?: number
}

export interface RepeatOfferStore {
  /** Appends one owner turn and drops turns outside the retention window. */
  recordTurn(input: RecordRepeatOfferTurnInput, now?: number): RepeatOfferTurn
  /** The turns of one calendar day of the owner's zone, oldest first. */
  turnsOfDay(day: string): RepeatOfferTurn[]
  /** Stored card by id; undefined for a foreign or unknown id. */
  card(id: string): RepeatOfferCard | undefined
  addCard(input: AddRepeatOfferCardInput): RepeatOfferCard
  /** Marks a card decided. A decided card is never moved back to pending. */
  setCardStatus(id: string, status: RepeatOfferCardStatus): RepeatOfferCard | undefined
  /** True while the owner asked not to offer this tool. */
  isSuppressed(tool: string, now?: number): boolean
  /**
   * Stores a silence for the tool. A later date never shortens a silence, and
   * "forever" (null) wins over any date.
   */
  suppress(tool: string, until: number | null, now?: number): RepeatOfferSuppression
  /** Deletes expired suppressions and decided cards outside retention. */
  prune(now?: number): void
}

interface TurnRow {
  id: number
  day: string
  started_at: number
  request: string
  tools: string
}

interface CardRow {
  id: string
  chat_id: number
  tool: string
  time: string
  request: string
  created_at: number
  status: string
}

interface SuppressionRow {
  tool: string
  until: number | null
  created_at: number
}

type RepeatOfferStorageLike = Pick<RepeatOfferStorage, 'db' | 'migrate'>

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`repeat-offer: ${field} must be a non-empty string`)
  }
  return value
}

function moment(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`repeat-offer: ${field} must be a non-negative integer of epoch milliseconds`)
  }
  return value
}

function isCardStatus(value: unknown): value is RepeatOfferCardStatus {
  return value === 'pending' || value === 'accepted' || value === 'declined' || value === 'never'
}

function toolsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item !== '')
  } catch {
    // A damaged row must not break the next owner turn.
    return []
  }
}

function turnOf(row: TurnRow): RepeatOfferTurn {
  return {
    day: row.day,
    startedAt: Number(row.started_at),
    request: row.request,
    tools: toolsOf(row.tools),
  }
}

function cardOf(row: CardRow): RepeatOfferCard | undefined {
  if (!isCardStatus(row.status)) return undefined
  return {
    id: row.id,
    chatId: Number(row.chat_id),
    tool: row.tool,
    time: row.time,
    request: row.request,
    createdAt: Number(row.created_at),
    status: row.status,
  }
}

function suppressionOf(row: SuppressionRow): RepeatOfferSuppression {
  return {
    tool: row.tool,
    until: row.until === null ? null : Number(row.until),
    createdAt: Number(row.created_at),
  }
}

/** `randomBytes` keeps the callback_data of the card short and unguessable. */
function newCardId(): string {
  return randomBytes(8).toString('hex')
}

export function createRepeatOfferStore(storage: RepeatOfferStorageLike): RepeatOfferStore {
  const db = storage.db
  storage.migrate(REPEAT_OFFER_NAMESPACE, REPEAT_OFFER_STEPS)

  const insertTurn = db.prepare(
    'INSERT INTO repeat_offer_turns (day, started_at, request, tools) VALUES (?, ?, ?, ?)',
  )
  const deleteOldTurns = db.prepare('DELETE FROM repeat_offer_turns WHERE started_at < ?')
  const selectTurnsOfDay = db.prepare(
    'SELECT id, day, started_at, request, tools FROM repeat_offer_turns WHERE day = ? ORDER BY started_at, id',
  )
  const insertCard = db.prepare(
    `INSERT INTO repeat_offer_cards (id, chat_id, tool, time, request, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  )
  const selectCard = db.prepare(
    'SELECT id, chat_id, tool, time, request, created_at, status FROM repeat_offer_cards WHERE id = ?',
  )
  const updateCard = db.prepare('UPDATE repeat_offer_cards SET status = ? WHERE id = ?')
  const deleteOldCards = db.prepare(
    "DELETE FROM repeat_offer_cards WHERE status <> 'pending' AND created_at < ?",
  )
  const selectSuppression = db.prepare('SELECT tool, until, created_at FROM repeat_offer_suppressions WHERE tool = ?')
  const upsertSuppression = db.prepare(
    `INSERT INTO repeat_offer_suppressions (tool, until, created_at) VALUES (?, ?, ?)
     ON CONFLICT (tool) DO UPDATE SET until = excluded.until, created_at = excluded.created_at`,
  )
  const deleteExpiredSuppressions = db.prepare(
    'DELETE FROM repeat_offer_suppressions WHERE until IS NOT NULL AND until <= ?',
  )

  function prune(now = Date.now()): void {
    deleteOldTurns.run(now - REPEAT_OFFER_TURN_RETENTION_DAYS * DAY_MS)
    deleteOldCards.run(now - REPEAT_OFFER_CARD_RETENTION_DAYS * DAY_MS)
    deleteExpiredSuppressions.run(now)
  }

  const repeatOffers: RepeatOfferStore = {
    recordTurn(input, now = Date.now()) {
      const day = text(input.day, 'day')
      const startedAt = moment(input.startedAt, 'startedAt')
      const request = text(input.request, 'request')
      const tools = [...new Set(input.tools.map((tool) => text(tool, 'tool')))]
      insertTurn.run(day, startedAt, request, JSON.stringify(tools))
      prune(now)
      return { day, startedAt, request, tools }
    },
    turnsOfDay(day) {
      return (selectTurnsOfDay.all(day) as unknown as TurnRow[]).map(turnOf)
    },
    card(id) {
      const row = selectCard.get(id) as CardRow | undefined
      return row === undefined ? undefined : cardOf(row)
    },
    addCard(input) {
      const id = newCardId()
      const createdAt = input.createdAt ?? Date.now()
      insertCard.run(
        id,
        input.chatId,
        text(input.tool, 'tool'),
        text(input.time, 'time'),
        text(input.request, 'request'),
        moment(createdAt, 'createdAt'),
      )
      const row = selectCard.get(id) as CardRow | undefined
      if (row === undefined) throw new Error('repeat-offer: the card was not stored')
      const card = cardOf(row)
      if (card === undefined) throw new Error('repeat-offer: the stored card is damaged')
      return card
    },
    setCardStatus(id, status) {
      if (!isCardStatus(status)) throw new TypeError(`repeat-offer: unknown card status "${String(status)}"`)
      const current = selectCard.get(id) as CardRow | undefined
      if (current === undefined) return undefined
      // A decision is terminal: a repeated press keeps the first one.
      if (current.status === 'pending') updateCard.run(status, id)
      const updated = selectCard.get(id) as CardRow | undefined
      return updated === undefined ? undefined : cardOf(updated)
    },
    isSuppressed(tool, now = Date.now()) {
      const row = selectSuppression.get(tool) as SuppressionRow | undefined
      if (row === undefined) return false
      if (row.until === null) return true
      return Number(row.until) > now
    },
    suppress(tool, until, now = Date.now()) {
      const name = text(tool, 'tool')
      const current = selectSuppression.get(name) as SuppressionRow | undefined
      let next: number | null = until
      if (until !== null) moment(until, 'until')
      if (current !== undefined) {
        const existing = current.until === null ? null : Number(current.until)
        if (existing === null) next = null
        else if (next !== null) next = Math.max(existing, next)
      }
      upsertSuppression.run(name, next, moment(now, 'now'))
      return { tool: name, until: next, createdAt: now }
    },
    prune,
  }

  return repeatOffers
}
