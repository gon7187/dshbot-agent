// The occasions of the mood: facts the host observed since the previous wake-up.
//
// The bot writes its mood itself (`mood.ts`); the host only supplies honest
// reasons for it: how long the owner has been silent, owner messages with
// gratitude or dissatisfaction, rejected cards, finished and failed background
// tasks and failed tool calls of the main session. Every counter covers the
// window between two accepted wake-ups, so a consumed fact does not come back,
// and a zero counter is never printed.
//
// A broken source is no fact: a failed query or an unreadable log simply
// contributes nothing, the wake-up itself must not fail because of it.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

/** Header of the occasions block in the wake-up prompt. */
export const MOOD_OCCASIONS_HEADER = 'Поводы с прошлого пробуждения:'

/** The tail of the session log that is scanned for tool failures. */
const SESSION_LOG_TAIL_BYTES = 16 * 1024 * 1024

/**
 * Tools whose failure arrives as a status line of an ordinary (not `isError`)
 * result. `exec` and `host_exec` share the same status contract: a non-zero
 * `exit N` line, `Таймаут:` or `Завершено сигналом`.
 */
const STATUS_TOOLS: ReadonlySet<string> = new Set(['exec', 'host_exec'])

/**
 * The window already observed by the previous accepted wake-up. Durable rows
 * are tracked by monotonic ids; `at` bounds the session log and the ledger of
 * rejected cards. The app's `WakeBoundary` has this shape.
 */
export interface MoodOccasionsBoundary {
  /** Last `ingress.id` seen by the previous accepted wake-up. */
  ingressId: number
  /** Last `task_events.id` seen by the previous accepted wake-up. */
  taskEventId: number
  /** Moment of the previous accepted wake-up, Unix epoch milliseconds. */
  at: number
}

export interface MoodOccasionsInput {
  db: DatabaseSync
  boundary: MoodOccasionsBoundary
  /** Moment of the observation, Unix epoch milliseconds. */
  now: number
  /** Paired owner chat; before pairing no owner message and no silence is known. */
  ownerChatId: number | null
  /** Durable `events.jsonl` of the main session, where the tool results live. */
  sessionLogPath?: string
  /** Moments of the cards the owner rejected with a new decision. */
  rejectedCards?: readonly number[]
}

/**
 * Gratitude or praise. A bare «хорошо» is an «okay», not praise, so it only
 * counts together with the work it judges.
 */
const GRATITUDE_RE =
  /(?<!\p{L})(?:спасиб|благодар|признател|молод(?:ец|чина|цы)|умни(?:ц|чк)|отличн|прекрасн|замечательн|восхитительн|великолепн|супер(?!\p{L})|класс(?:но|ный|ная)?(?!\p{L})|хорош(?:ая|ий|ее|о)\s+(?:работ|сделал|получил|справил)|thank|well done|great job)/iu

/** Dissatisfaction, complaints and irritation. */
const DISSATISFACTION_RE =
  /(?<!\p{L})(?:недовол|разочаров|(?<!не\s)плохо|ужасн|отвратительн|не\s+нравит|надоел|бесит|достал|хватит|опять\s+не|снова\s+не|не\s+работает|не\s+то(?!\p{L}))/iu

/** Rows of a query, or none when the table or the column is missing. */
function safeQuery<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  try {
    return db.prepare(sql).all(...params) as unknown as T[]
  } catch {
    return []
  }
}

/** Timestamp of the newest owner message in the whole ingress, or undefined. */
function lastOwnerMessageAt(db: DatabaseSync, ownerChatId: number): number | undefined {
  const rows = safeQuery<{ at: number | null }>(
    db,
    `SELECT MAX(received_at) AS at FROM ingress
     WHERE channel = 'telegram'
       AND json_extract(payload, '$.message.chat.id') = ?
       AND json_extract(payload, '$.message.from.id') = ?
       AND COALESCE(json_extract(payload, '$.message.from.is_bot'), 0) = 0`,
    ownerChatId,
    ownerChatId,
  )
  const at = rows[0]?.at
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : undefined
}

/**
 * Texts of the owner messages that are news for this window. A recognized
 * voice is a fresh ingress row of the same Telegram message, so the rows of
 * one `message_id` are joined into one text; a message that already appeared
 * before the boundary was counted by the previous wake-up.
 */
function ownerTexts(db: DatabaseSync, ingressId: number, ownerChatId: number): string[] {
  const rows = safeQuery<{ payload: string }>(
    db,
    `SELECT payload FROM ingress WHERE channel = 'telegram' AND id > ? ORDER BY id`,
    ingressId,
  )
  const byId = new Map<number, string[]>()
  const texts: string[][] = []
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    const message = asRecord(asRecord(payload)?.message)
    if (message === undefined) continue
    const chat = asRecord(message.chat)
    const from = asRecord(message.from)
    if (chat?.id !== ownerChatId || from?.id !== ownerChatId || from.is_bot === true) continue
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : ''
    const id = message.message_id
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      texts.push([text])
      continue
    }
    const parts = byId.get(id)
    if (parts !== undefined) {
      parts.push(text)
      continue
    }
    const fresh = [text]
    byId.set(id, fresh)
    texts.push(fresh)
  }
  if (byId.size > 0) {
    const ids = [...byId.keys()]
    const older = safeQuery<{ message_id: number }>(
      db,
      `SELECT DISTINCT json_extract(payload, '$.message.message_id') AS message_id FROM ingress
       WHERE channel = 'telegram' AND id <= ?
         AND json_extract(payload, '$.message.chat.id') = ?
         AND json_extract(payload, '$.message.message_id') >= ?`,
      ingressId,
      ownerChatId,
      ids.reduce((low, id) => (id < low ? id : low)),
    )
    for (const row of older) {
      const parts = byId.get(row.message_id)
      if (parts !== undefined) parts.length = 0
    }
  }
  return texts.filter((parts) => parts.length > 0).map((parts) => parts.join('\n'))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

/** Plain text of a tool result's content blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = asRecord(block)
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('\n')
}

/**
 * Whether an `exec` or `host_exec` result reports a failure. Both answer a
 * non-zero exit, a timeout or a signal with an ordinary result whose first line
 * is the status (the same contract the runner's tool notes read). An aborted
 * command is the owner's own `/stop`, not a failure of the tool.
 */
export function execResultFailed(text: string): boolean {
  const first = text.split(/\r?\n/u)[0]?.trim() ?? ''
  const code = /^exit\s+(-?\d+)$/u.exec(first)
  if (code !== null) return Number(code[1]) !== 0
  return /^(?:Таймаут:|Завершено сигналом|signal\s)/u.test(first)
}

/** The last bytes of a file as text; the first, possibly cut, line is dropped. */
function readTail(path: string, limit: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, limit)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read)
      if (n <= 0) break
      read += n
    }
    const text = buffer.subarray(0, read).toString('utf8')
    if (length === size) return text
    const cut = text.indexOf('\n')
    return cut < 0 ? '' : text.slice(cut + 1)
  } catch {
    return ''
  } finally {
    closeSync(fd)
  }
}

/**
 * Failed tool calls in a session log between `since` (exclusive) and `now`.
 * An error result (`isError`) counts for every tool; an `exec` or `host_exec`
 * result counts when its status line is a failure. The tool name comes from the
 * call event, because a result names only its call.
 */
export function countToolErrors(logText: string, since: number, now: number): number {
  const names = new Map<string, string>()
  let count = 0
  for (const line of logText.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const record = asRecord(event)
    const data = asRecord(record?.data)
    if (record === undefined || data === undefined) continue
    if (record.type === 'tool/call') {
      if (typeof data.callId === 'string' && typeof data.name === 'string') names.set(data.callId, data.name)
      continue
    }
    if (record.type !== 'tool/result') continue
    const message = asRecord(data.message)
    if (message === undefined) continue
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    const name = callId === undefined ? undefined : names.get(callId)
    if (callId !== undefined) names.delete(callId)
    const time = record.time
    if (typeof time !== 'number' || time <= since || time > now) continue
    if (message.isError === true) {
      count += 1
      continue
    }
    if (name !== undefined && STATUS_TOOLS.has(name) && execResultFailed(contentText(message.content))) count += 1
  }
  return count
}

/** At most one decimal, with the Russian decimal comma. */
function hoursText(hours: number): string {
  return String(Math.round(hours * 10) / 10).replace('.', ',')
}

/**
 * The occasions block for the wake-up prompt: facts, not a command. Returns
 * `''` when there is nothing to report; zero counters are omitted, and the
 * silence line needs a known last owner message.
 */
export function buildMoodOccasions(input: MoodOccasionsInput): string {
  const lines: string[] = []
  const { db, boundary, now, ownerChatId } = input

  if (ownerChatId !== null) {
    const lastAt = lastOwnerMessageAt(db, ownerChatId)
    // Not «молчит»: that word belongs to the line about the bot's own silent
    // wake-ups, and the two facts must stay distinguishable.
    if (lastAt !== undefined && now - lastAt >= 360_000) {
      lines.push(`- Владелец не пишет ${hoursText((now - lastAt) / 3_600_000)} ч`)
    }
    const texts = ownerTexts(db, boundary.ingressId, ownerChatId)
    const gratitude = texts.filter((text) => GRATITUDE_RE.test(text)).length
    const dissatisfaction = texts.filter((text) => DISSATISFACTION_RE.test(text)).length
    if (gratitude > 0) lines.push(`- Сообщений владельца с благодарностью или похвалой: ${gratitude}`)
    if (dissatisfaction > 0) lines.push(`- Сообщений владельца с недовольством: ${dissatisfaction}`)
  }

  const rejected = (input.rejectedCards ?? []).filter((at) => at > boundary.at && at <= now).length
  if (rejected > 0) lines.push(`- Отклонённых карточек: ${rejected}`)

  // A task counts once, by its terminal event in the window, and only while it
  // is still in that state (a blocked task resumed later is not a failure now).
  const tasks = safeQuery<{ state: string; count: number }>(
    db,
    `SELECT t.state AS state, COUNT(DISTINCT t.id) AS count
     FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE e.id > ? AND e.state IN ('done', 'blocked') AND t.state = e.state
     GROUP BY t.state`,
    boundary.taskEventId,
  )
  const done = tasks.find((row) => row.state === 'done')?.count ?? 0
  const failed = tasks.find((row) => row.state === 'blocked')?.count ?? 0
  if (done > 0) lines.push(`- Успешно завершённых фоновых задач: ${done}`)
  if (failed > 0) lines.push(`- Провалившихся фоновых задач: ${failed}`)

  if (input.sessionLogPath !== undefined) {
    const errors = countToolErrors(readTail(input.sessionLogPath, SESSION_LOG_TAIL_BYTES), boundary.at, now)
    if (errors > 0) lines.push(`- Ошибок инструментов: ${errors}`)
  }

  return lines.length === 0 ? '' : [MOOD_OCCASIONS_HEADER, ...lines].join('\n')
}
