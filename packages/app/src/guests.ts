// Guest bookkeeping for the daemon: one-time invitation codes, the durable guest
// list, per-chat wrong-code counters and per-guest UTC daily usage.
//
// Everything lives in the same state.db the rest of the daemon opens (the store
// exposes `migrate`/`db` for exactly this), so guests, the moment they entered and
// their access term survive a restart with the same DSHBOT_HOME.

import { randomInt } from 'node:crypto'

import type { Store } from '../../store/src/index.js'

/** Invitation codes are 8+ characters and always contain digits, so they are easy to spot. */
const INVITE_PREFIX = 'INV'
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const INVITE_RANDOM_LENGTH = 8

/** How long an invitation code stays valid. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000

/** Access term used by `/invite` without an explicit one. */
export const DEFAULT_GUEST_TERM_MS = 30 * 60 * 1000

/** The longest access term `/invite` accepts. */
export const MAX_GUEST_TERM_MS = 7 * 24 * 60 * 60 * 1000

/** Wrong codes from one chat after which that chat can no longer join. */
export const MAX_GUEST_CODE_ATTEMPTS = 5

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const GUEST_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS guests (
    chat_id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS guest_invites (
    code TEXT PRIMARY KEY,
    issued_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS guest_usage (
    chat_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (chat_id, day)
  )`,
  `CREATE TABLE IF NOT EXISTS guest_code_failures (
    chat_id INTEGER PRIMARY KEY,
    failures INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // The term belongs to the invitation; the deadline is fixed when the guest enters.
  'ALTER TABLE guest_invites ADD COLUMN duration_ms INTEGER',
  'ALTER TABLE guests ADD COLUMN expires_at INTEGER',
  // Daily cost guard and the owner-visible counter of refused tool attempts.
  'ALTER TABLE guest_usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0',
  'ALTER TABLE guest_usage ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0',
]

interface CountRow {
  count: number | bigint
  cost_usd?: number | bigint | null
  rejected?: number | bigint | null
}

interface FailuresRow {
  failures: number | bigint
}

interface GuestRow {
  chat_id: number | bigint
  created_at: number | bigint
  expires_at: number | bigint | null
}

interface InviteRow {
  issued_at: number | bigint
  used_at: number | bigint | null
  duration_ms: number | bigint | null
}

/** One guest as stored: when it entered and when its access ends. */
export interface GuestRecord {
  chatId: number
  createdAt: number
  /** Undefined only for guests that existed before access terms were introduced. */
  expiresAt?: number
}

/** What a redeemed invitation grants. */
export interface GuestGrant {
  /** Deadline counted from the moment the guest entered, not from the link issue. */
  expiresAt: number
  durationMs: number
}

/** One guest's activity for a UTC day. */
export interface GuestDayStats {
  /** Accepted user messages that went through the guest pipeline. */
  messages: number
  /** Tool calls the guest turn tried to make outside the guest schema. */
  rejected: number
  /** Model spend of the guest turns of the day, in US dollars. */
  costUsd: number
}

function toNumber(value: number | bigint | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'bigint' ? Number(value) : value
}

/** Generates a fresh one-time invitation code. */
export function generateInviteCode(): string {
  let code = INVITE_PREFIX
  for (let index = 0; index < INVITE_RANDOM_LENGTH; index += 1) {
    code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]
  }
  return code
}

/** UTC calendar day used by the guest daily limit. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Parses an `/invite` term such as `30m`, `2h` or `1d` into milliseconds.
 * Returns undefined for anything else, for zero and for terms above the maximum.
 */
export function parseGuestTerm(raw: string): number | undefined {
  const match = /^(\d{1,9})\s*([mhd])$/i.exec(raw.trim())
  if (match === null) return undefined
  const value = Number(match[1])
  const unit = match[2]?.toLowerCase()
  const unitMs = unit === 'm' ? MINUTE_MS : unit === 'h' ? HOUR_MS : DAY_MS
  const durationMs = value * unitMs
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > MAX_GUEST_TERM_MS) return undefined
  return durationMs
}

/**
 * Human duration for messages: whole minutes, e.g. `30 мин`, `2 ч`, `1 ч 50 мин`.
 * Rounds up so "3 ч" does not become "2 ч 59 мин" right after the guest entered.
 */
export function formatGuestDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / MINUTE_MS))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0 && minutes > 0) return `${hours} ч ${minutes} мин`
  if (hours > 0) return `${hours} ч`
  return `${minutes} мин`
}

export class GuestRegistry {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
    store.migrate('guests', GUEST_STEPS)
  }

  /** Creates and stores a fresh code valid for 24 hours and granting `durationMs` of access. */
  createInvite(now: number, durationMs: number): string {
    const insert = this.store.db.prepare(
      'INSERT INTO guest_invites (code, issued_at, duration_ms) VALUES (?, ?, ?)',
    )
    // A collision is astronomically unlikely; retry a few times rather than
    // overwrite a live code, then surface the real storage failure.
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateInviteCode()
      try {
        insert.run(code, now, durationMs)
        return code
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('could not store a guest invitation code')
  }

  /**
   * Consumes `code` for `chatId` when it is unused and younger than 24 hours.
   * Returns undefined for unknown, expired, already used or locked chats; in that
   * case the caller records a wrong attempt. On success the guest deadline is
   * counted from `now`, the moment of entry.
   */
  redeem(code: string, chatId: number, now: number): GuestGrant | undefined {
    if (this.isLocked(chatId)) return undefined
    const row = this.store.db
      .prepare('SELECT issued_at, used_at, duration_ms FROM guest_invites WHERE code = ?')
      .get(code) as InviteRow | undefined
    if (row === undefined) return undefined
    const usedAt = toNumber(row.used_at)
    const issuedAt = toNumber(row.issued_at)
    if (usedAt !== undefined || issuedAt === undefined) return undefined
    if (now - issuedAt >= INVITE_TTL_MS || now < issuedAt) return undefined

    const durationMs = toNumber(row.duration_ms) ?? DEFAULT_GUEST_TERM_MS
    const expiresAt = now + durationMs

    const db = this.store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const consumed = db
        .prepare('UPDATE guest_invites SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL')
        .run(now, chatId, code)
      if (toNumber(consumed.changes) !== 1) {
        db.exec('ROLLBACK')
        return undefined
      }
      db.prepare('INSERT OR REPLACE INTO guests (chat_id, created_at, expires_at) VALUES (?, ?, ?)').run(
        chatId,
        now,
        expiresAt,
      )
      db.prepare('DELETE FROM guest_usage WHERE chat_id = ?').run(chatId)
      db.prepare('DELETE FROM guest_code_failures WHERE chat_id = ?').run(chatId)
      db.exec('COMMIT')
      return { expiresAt, durationMs }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Keep the original failure.
      }
      throw error
    }
  }

  /** The stored guest or undefined when the chat is not a guest. */
  find(chatId: number): GuestRecord | undefined {
    const row = this.store.db
      .prepare('SELECT chat_id, created_at, expires_at FROM guests WHERE chat_id = ?')
      .get(chatId) as GuestRow | undefined
    if (row === undefined) return undefined
    const createdAt = toNumber(row.created_at) ?? 0
    const expiresAt = toNumber(row.expires_at)
    return {
      chatId: Number(row.chat_id),
      createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
  }

  /** Whether the chat is stored as a guest, regardless of its deadline. */
  isGuest(chatId: number): boolean {
    return this.find(chatId) !== undefined
  }

  /** Guest records in join order. */
  list(): GuestRecord[] {
    const rows = this.store.db
      .prepare('SELECT chat_id, created_at, expires_at FROM guests ORDER BY created_at, chat_id')
      .all() as unknown as GuestRow[]
    return rows.map((row) => {
      const expiresAt = toNumber(row.expires_at)
      return {
        chatId: Number(row.chat_id),
        createdAt: toNumber(row.created_at) ?? 0,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
    })
  }

  /** Removes a guest and all of its counters; returns whether it was a guest. */
  remove(chatId: number): boolean {
    const db = this.store.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const removed = db.prepare('DELETE FROM guests WHERE chat_id = ?').run(chatId)
      db.prepare('DELETE FROM guest_usage WHERE chat_id = ?').run(chatId)
      db.prepare('DELETE FROM guest_code_failures WHERE chat_id = ?').run(chatId)
      db.exec('COMMIT')
      return toNumber(removed.changes) === 1
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Keep the original failure.
      }
      throw error
    }
  }

  /** Removes a guest; the owner-facing `/kick` path. */
  kick(chatId: number): boolean {
    return this.remove(chatId)
  }

  /** Wrong codes already seen from this chat. */
  failures(chatId: number): number {
    const row = this.store.db
      .prepare('SELECT failures FROM guest_code_failures WHERE chat_id = ?')
      .get(chatId) as FailuresRow | undefined
    return toNumber(row?.failures) ?? 0
  }

  /** A chat that burned through MAX_GUEST_CODE_ATTEMPTS can no longer join. */
  isLocked(chatId: number): boolean {
    return this.failures(chatId) >= MAX_GUEST_CODE_ATTEMPTS
  }

  /** Counts one wrong code for the chat. */
  recordFailure(chatId: number, now: number): void {
    this.store.db
      .prepare(
        `INSERT INTO guest_code_failures (chat_id, failures, updated_at) VALUES (?, 1, ?)
         ON CONFLICT (chat_id) DO UPDATE SET failures = failures + 1, updated_at = excluded.updated_at`,
      )
      .run(chatId, now)
  }

  /**
   * Atomically takes one message from today's quota. Returns false (and changes
   * nothing) when the guest already used the whole limit for `day`.
   */
  takeDaily(chatId: number, day: string, limit: number): boolean {
    const row = this.store.db
      .prepare('SELECT count FROM guest_usage WHERE chat_id = ? AND day = ?')
      .get(chatId, day) as CountRow | undefined
    const used = toNumber(row?.count) ?? 0
    if (used >= limit) return false
    this.store.db
      .prepare(
        `INSERT INTO guest_usage (chat_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT (chat_id, day) DO UPDATE SET count = count + 1`,
      )
      .run(chatId, day)
    return true
  }

  /** Messages, refused tool calls and spend of one guest for one UTC day. */
  dailyStats(chatId: number, day: string): GuestDayStats {
    const row = this.store.db
      .prepare('SELECT count, cost_usd, rejected FROM guest_usage WHERE chat_id = ? AND day = ?')
      .get(chatId, day) as CountRow | undefined
    return {
      messages: toNumber(row?.count) ?? 0,
      rejected: toNumber(row?.rejected) ?? 0,
      costUsd: toNumber(row?.cost_usd) ?? 0,
    }
  }

  /**
   * Counts one tool call a guest turn tried to make outside its schema and
   * returns the day's total. The first call of the day is what the owner is
   * told about; later ones only raise the number in `/guests`.
   */
  recordRejected(chatId: number, day: string): number {
    this.store.db
      .prepare(
        `INSERT INTO guest_usage (chat_id, day, count, rejected) VALUES (?, ?, 0, 1)
         ON CONFLICT (chat_id, day) DO UPDATE SET rejected = rejected + 1`,
      )
      .run(chatId, day)
    return this.dailyStats(chatId, day).rejected
  }

  /** Adds the spend of one guest turn to the day total. Non-finite values are ignored. */
  addDailyCost(chatId: number, day: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return
    this.store.db
      .prepare(
        `INSERT INTO guest_usage (chat_id, day, count, cost_usd) VALUES (?, ?, 0, ?)
         ON CONFLICT (chat_id, day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(chatId, day, usd)
  }

  /** Clears the wrong-code lock of a chat; the owner-facing `/unlock` path. */
  unlock(chatId: number): boolean {
    const removed = this.store.db.prepare('DELETE FROM guest_code_failures WHERE chat_id = ?').run(chatId)
    return (toNumber(removed.changes) ?? 0) >= 1
  }
}
