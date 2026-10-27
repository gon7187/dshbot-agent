// Proactive speech of a wake-up: the quiet hours of the owner, the daily limit
// of messages the bot starts itself, and the durable counter of silent wake-ups.
//
// The daemon owns delivery; this module owns the rules and the state they need.
// The state lives in the shared key-value table of `state.db` (one JSON value),
// so the counter and the moment of the last initiative survive a restart.

export const HOUR_MS = 60 * 60 * 1_000

/** Default window of the owner's quiet hours, `HH-HH`; empty disables it. */
export const DEFAULT_QUIET_HOURS = '23-9'

/** Default number of proactive messages per owner day; 0 forbids them. */
export const DEFAULT_PROACTIVE_PER_DAY = 6

/** Wake-ups in a row that must be `[SILENT]` before the prompt mentions it. */
export const SILENCE_STREAK_LIMIT = 6

/** Silence after the last initiative that makes the reminder worth saying. */
export const SILENCE_AFTER_MS = 20 * HOUR_MS

/**
 * The bot does not start a conversation when it wrote to the owner less than
 * this long ago: two messages in a row read as nagging, and the second one can
 * wait for the next wake-up.
 */
export const PROACTIVE_COOLDOWN_MS = 10 * 60 * 1_000

/** Default chance that one wake-up is a reflective "free minute", `DSHBOT_FREE_WAKE_CHANCE`. */
export const DEFAULT_FREE_WAKE_CHANCE = 0.25

/** One key holds the whole state, so a restart never sees a half-written ledger. */
export const WAKE_PROACTIVE_KV_KEY = 'wake.proactive'

/** A quiet window on the owner's wall clock; `from > to` wraps over midnight. */
export interface QuietHours {
  from: number
  to: number
}

/** The durable part of the proactive state. */
export interface WakeProactiveLedger {
  /** Wake-ups in a row that ended exactly with the silent token. */
  silentStreak: number
  /** When a wake-up message was last delivered on the bot's own initiative. */
  lastProactiveAt?: number
  /** Owner-day key (`YYYY-MM-DD`) the counter belongs to. */
  day: string
  /** Wake-up messages delivered during `day`. */
  deliveredToday: number
}

/** Minimal shape of the durable key-value table; `store.kv` fits it. */
export interface WakeProactiveStorage {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

function validHour(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 23
}

function parseWindow(text: string): QuietHours | null | undefined {
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(text)
  if (match === null) return undefined
  const from = Number(match[1])
  const to = Number(match[2])
  if (!validHour(from) || !validHour(to)) return undefined
  // The same hour twice would silence the whole day; that is more likely a
  // mistake than a wish, so it reads as "no quiet hours".
  if (from === to) return null
  return { from, to }
}

/**
 * Quiet hours from `DSHBOT_QUIET_HOURS`. Absent means the default 23:00–09:00,
 * an empty value disables them, a malformed value keeps the default (the brake
 * must never silently disappear because of a typo).
 */
export function parseQuietHours(value: string | undefined): QuietHours | null {
  if (value === undefined) return parseWindow(DEFAULT_QUIET_HOURS) ?? null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = parseWindow(trimmed)
  return parsed === undefined ? (parseWindow(DEFAULT_QUIET_HOURS) ?? null) : parsed
}

/**
 * Daily limit from `DSHBOT_PROACTIVE_PER_DAY`. Absent keeps the default, an
 * empty value also keeps it; an unreadable value stops the start instead of
 * silently becoming another number.
 */
export function parseProactivePerDay(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PROACTIVE_PER_DAY
  const text = value.trim()
  if (!/^\d+$/.test(text)) {
    throw new Error(`DSHBOT_PROACTIVE_PER_DAY must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`DSHBOT_PROACTIVE_PER_DAY must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * Parse `DSHBOT_FREE_WAKE_CHANCE`. Absent or empty keeps the default; a value
 * that is not a finite number in `0..1` stops the start instead of silently
 * turning the free minute off (or on).
 */
export function parseFreeWakeChance(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_FREE_WAKE_CHANCE
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`DSHBOT_FREE_WAKE_CHANCE must be a number between 0 and 1, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/** Chance in `0..1`; an unreadable value keeps the default instead of removing the free minute. */
export function normalizeFreeWakeChance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_FREE_WAKE_CHANCE
  return Math.min(1, Math.max(0, value))
}

/** Whether this wake-up is a free minute. `0` and `1` are exact, not probabilistic. */
export function isFreeMinute(chance: number, random: () => number = Math.random): boolean {
  const normalized = normalizeFreeWakeChance(chance)
  if (normalized <= 0) return false
  if (normalized >= 1) return true
  return random() < normalized
}

export interface OwnerInitiativeInput {
  /** Moment of the wake-up delivery decision, Unix epoch milliseconds. */
  now: number
  /** Arrival of the newest message from the owner, if any. */
  lastOwnerMessageAt?: number
  /** Delivery of the newest message of the bot to the owner, if any. */
  lastBotMessageAt?: number
}

/**
 * Why this wake-up must not start a conversation with the owner, or `undefined`
 * when it may. The model's text is not lost: the host writes it to the
 * scratchpad with a note that it was not sent.
 *
 * Two rules from the original Ouroboros guard: do not speak while the owner is
 * waiting for an answer, and do not write twice within the cooldown.
 */
export function ownerInitiativeHold(input: OwnerInitiativeInput): string | undefined {
  if (
    input.lastOwnerMessageAt !== undefined &&
    (input.lastBotMessageAt === undefined || input.lastOwnerMessageAt > input.lastBotMessageAt)
  ) {
    return 'владелец ждёт ответа'
  }
  if (
    input.lastBotMessageAt !== undefined &&
    input.now >= input.lastBotMessageAt &&
    input.now - input.lastBotMessageAt < PROACTIVE_COOLDOWN_MS
  ) {
    return 'бот писал владельцу меньше 10 минут назад'
  }
  return undefined
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>()
const dayFormatters = new Map<string, Intl.DateTimeFormat>()
const momentFormatters = new Map<string, Intl.DateTimeFormat>()

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = hourFormatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })
  hourFormatters.set(timeZone, formatter)
  return formatter
}

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dayFormatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  dayFormatters.set(timeZone, formatter)
  return formatter
}

/** Hour (0..23) on the wall clock of the owner. */
export function ownerHour(nowMs: number, timeZone: string): number {
  const parts = hourFormatter(timeZone).formatToParts(nowMs)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value)
  return Number.isSafeInteger(hour) && hour >= 0 && hour <= 23 ? hour : 0
}

/** Owner-day key `YYYY-MM-DD`, the unit of the daily limit. */
export function ownerDayKey(nowMs: number, timeZone: string): string {
  const parts = dayFormatter(timeZone).formatToParts(nowMs)
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year').padStart(4, '0')}-${value('month').padStart(2, '0')}-${value('day').padStart(2, '0')}`
}

/** Whether the owner's wall clock is inside the quiet window. */
export function isQuietAt(nowMs: number, quiet: QuietHours | null, timeZone: string): boolean {
  if (quiet === null) return false
  const hour = ownerHour(nowMs, timeZone)
  return quiet.from < quiet.to
    ? hour >= quiet.from && hour < quiet.to
    : hour >= quiet.from || hour < quiet.to
}

/** `DD.MM HH:MM` on the owner's wall clock, for the silence reminder. */
export function formatOwnerMoment(ms: number, timeZone: string): string {
  let formatter = momentFormatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    momentFormatters.set(timeZone, formatter)
  }
  return formatter.format(ms)
}

/** Hours since the last initiative, never below one: "молчу уже 1 ч" reads better than "0 ч". */
export function hoursSince(nowMs: number, at: number): number {
  return Math.max(1, Math.floor((nowMs - at) / HOUR_MS))
}

/** Read the ledger, dropping a counter that belongs to another owner day. */
export function readWakeProactiveLedger(
  kv: WakeProactiveStorage,
  nowMs: number,
  timeZone: string,
): WakeProactiveLedger {
  const day = ownerDayKey(nowMs, timeZone)
  let parsed: Partial<WakeProactiveLedger> = {}
  const raw = kv.get(WAKE_PROACTIVE_KV_KEY)
  if (raw !== undefined) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Partial<WakeProactiveLedger>
      }
    } catch {
      // A malformed value starts from an empty ledger instead of breaking the wake-up.
    }
  }
  const silentStreak =
    Number.isSafeInteger(parsed.silentStreak) && (parsed.silentStreak as number) >= 0
      ? (parsed.silentStreak as number)
      : 0
  const lastProactiveAt =
    typeof parsed.lastProactiveAt === 'number' && Number.isFinite(parsed.lastProactiveAt) && parsed.lastProactiveAt > 0
      ? parsed.lastProactiveAt
      : undefined
  const deliveredToday =
    parsed.day === day && Number.isSafeInteger(parsed.deliveredToday) && (parsed.deliveredToday as number) >= 0
      ? (parsed.deliveredToday as number)
      : 0
  return {
    silentStreak,
    ...(lastProactiveAt === undefined ? {} : { lastProactiveAt }),
    day,
    deliveredToday,
  }
}

/** Persist the ledger; a broken database must not break the wake-up itself. */
export function saveWakeProactiveLedger(kv: WakeProactiveStorage, ledger: WakeProactiveLedger): void {
  kv.set(WAKE_PROACTIVE_KV_KEY, JSON.stringify(ledger))
}

/**
 * The line about the silence, or `undefined` when six silent wake-ups in a row
 * have not yet followed a day without an initiative.
 */
export function silenceNote(input: {
  silentStreak: number
  lastProactiveAt?: number
  nowMs: number
  timeZone: string
}): string | undefined {
  if (input.silentStreak < SILENCE_STREAK_LIMIT) return undefined
  if (input.lastProactiveAt !== undefined && input.nowMs - input.lastProactiveAt <= SILENCE_AFTER_MS) {
    return undefined
  }
  const when =
    input.lastProactiveAt === undefined
      ? 'владельцу ты сам ещё ни разу не писал'
      : `последний раз ты писал владельцу сам ${formatOwnerMoment(input.lastProactiveAt, input.timeZone)} ` +
        `(${hoursSince(input.nowMs, input.lastProactiveAt)} ч назад)`
  return (
    `Ты молчишь уже ${input.silentStreak} пробуждений подряд, а ${when}. ` +
    'Если есть хоть что-то стоящее — напиши сейчас, не жди особого повода.'
  )
}
