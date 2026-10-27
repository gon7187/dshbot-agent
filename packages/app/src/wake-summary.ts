// The observation of a wake-up: what changed since the previous accepted wake-up.
//
// Ouroboros wakes the agent with a short summary instead of a generic prompt.
// This module builds that summary from durable facts only:
//
//   - owner messages of the paired chat that arrived strictly after the
//     boundary (the exact count and the time of the last one);
//   - tasks that reached a terminal state (`done`/`blocked`) in that window;
//   - planned runs of the schedule, read from the one shared `schedule_runs`
//     table that `schedule history` and the planned runs already use;
//   - daemon errors and factory (`zavod`) status changes when they were seen.
//
// The summary is data, not a checklist: a pause stays legitimate. It is capped
// at {@link WAKE_SUMMARY_LIMIT} characters; the cut is marked with the number of
// omitted *events*, not lines, so a grouped line of identical errors still
// accounts for every run it stands for.

import type { DatabaseSync } from 'node:sqlite'

/** Hard cap of the summary text added to the wake-up prompt. */
export const WAKE_SUMMARY_LIMIT = 1500

/** The empty observation: nothing at all happened since the previous wake-up. */
export const NOTHING_HAPPENED = 'С прошлого пробуждения ничего не произошло.'

/** A timestamped note of the daemon (an error, a factory transition). */
export interface WakeNote {
  at: number
  text: string
}

/**
 * Rows already observed by the previous accepted wake-up. Durable rows are
 * tracked by their monotonic ids, not by a wall-clock time: a planned run or a
 * task event may be written with a timestamp that lies before the boundary
 * (a retroactive import or a fake clock), and it is still news because the
 * previous wake-up never saw the row.
 */
export interface WakeBoundary {
  /** Last `ingress.id` seen by the previous accepted wake-up. */
  ingressId: number
  /** Last `schedule_runs.id` seen by the previous accepted wake-up. */
  runId: number
  /** Last `task_events.id` seen by the previous accepted wake-up. */
  taskEventId: number
  /** Moment of the previous accepted wake-up, for the in-process notes. */
  at: number
}

export interface WakeSummaryInput {
  db: DatabaseSync
  /** The previous accepted wake-up; the daemon start snapshot on the first one. */
  boundary: WakeBoundary
  /** Moment the observation is taken, Unix epoch milliseconds. */
  now: number
  /** Paired owner chat; null before pairing, when no owner message can be counted. */
  ownerChatId: number | null
  /** Zone of the HH:MM reading of the last owner message. */
  timeZone: string
  /** Daemon errors recorded since the process started. */
  daemonErrors?: readonly WakeNote[]
  /** Factory task transitions recorded by the watcher. */
  zavodTransitions?: readonly WakeNote[]
}

interface EventItem {
  at: number
  /** Number of real events this line stands for (a grouped line carries their count). */
  events: number
  text: string
}

interface OwnerMessages {
  count: number
  lastAt: number | null
}

/** HH:MM of an instant in `timeZone`; a broken zone falls back to UTC. */
export function wakeClock(ms: number, timeZone: string): string {
  const format = (zone: string): string => {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(ms))
    } catch {
      return new Date(ms).toISOString().slice(11, 16)
    }
  }
  return format(timeZone)
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, limit: number): string {
  const flat = compact(text)
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function safeQuery<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  try {
    return db.prepare(sql).all(...params) as unknown as T[]
  } catch {
    // A package that has not migrated its table yet has no facts of that kind.
    return []
  }
}

interface RunRow {
  job_id: string
  started_at: number
  status: string
  output: string
}

interface TaskRow {
  id: string
  goal: string
  state: string
  event_id: number
}

interface IngressRow {
  payload: string
  received_at: number
}

/**
 * Owner messages after the boundary. The bot's own planned runs never pass
 * through the ingress, so their text (even one that starts like the planned-run
 * prompt) cannot be mistaken for an owner message: the source decides.
 */
function ownerMessages(input: WakeSummaryInput): OwnerMessages {
  if (input.ownerChatId === null) return { count: 0, lastAt: null }
  const rows = safeQuery<IngressRow>(
    input.db,
    `SELECT payload, received_at FROM ingress
     WHERE channel = 'telegram' AND id > ?
     ORDER BY id`,
    input.boundary.ingressId,
  )
  interface Candidate {
    messageId: number | null
    receivedAt: number
  }
  const seen = new Set<number>()
  const candidates: Candidate[] = []
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (payload === null || typeof payload !== 'object') continue
    const message = (payload as { message?: unknown }).message
    if (message === null || typeof message !== 'object') continue
    const chat = (message as { chat?: { id?: unknown } }).chat
    const from = (message as { from?: { id?: unknown; is_bot?: unknown } }).from
    if (chat === undefined || from === undefined) continue
    if (chat.id !== input.ownerChatId || from.id !== input.ownerChatId) continue
    if (from.is_bot === true) continue
    // The same Telegram message can be enqueued twice (a recognized voice is a
    // fresh row with the text of the original); the pair chat + message_id is
    // the identity, exactly as the bot's own message registry keys it.
    const raw = (message as { message_id?: unknown }).message_id
    const messageId = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null
    if (messageId !== null) {
      if (seen.has(messageId)) continue
      seen.add(messageId)
    }
    candidates.push({ messageId, receivedAt: row.received_at })
  }
  // A message is counted by its first appearance: a voice that arrived before
  // the boundary and was recognized after it was already news for the previous
  // wake-up. Telegram ids grow within a chat, so only older rows that carry an
  // id at least the smallest candidate one can be such an earlier appearance.
  const ids = candidates.flatMap((candidate) => (candidate.messageId === null ? [] : [candidate.messageId]))
  const earlier = new Set<number>()
  if (ids.length > 0) {
    const older = safeQuery<{ message_id: number }>(
      input.db,
      `SELECT DISTINCT json_extract(payload, '$.message.message_id') AS message_id FROM ingress
       WHERE channel = 'telegram' AND id <= ?
         AND json_extract(payload, '$.message.chat.id') = ?
         AND json_extract(payload, '$.message.message_id') >= ?`,
      input.boundary.ingressId,
      input.ownerChatId,
      ids.reduce((low, id) => (id < low ? id : low)),
    )
    for (const row of older) earlier.add(row.message_id)
  }
  let count = 0
  let lastAt: number | null = null
  for (const candidate of candidates) {
    if (candidate.messageId !== null && earlier.has(candidate.messageId)) continue
    count += 1
    if (lastAt === null || candidate.receivedAt > lastAt) lastAt = candidate.receivedAt
  }
  return { count, lastAt }
}

function runItems(db: DatabaseSync, afterId: number): EventItem[] {
  const rows = safeQuery<RunRow>(
    db,
    `SELECT job_id, started_at, status, output FROM schedule_runs
     WHERE id > ? ORDER BY started_at, id`,
    afterId,
  )
  interface Group {
    at: number
    events: number
    status: string
    output: string
  }
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const status = row.status === 'error' ? 'error' : row.status === 'skip' ? 'skip' : 'ok'
    // A repeated identical failure is one line that still counts every run.
    const key = `${row.job_id}\u0000${status}\u0000${row.output}`
    const found = groups.get(key)
    if (found === undefined) {
      groups.set(key, { at: row.started_at, events: 1, status, output: row.output })
    } else {
      found.events += 1
      if (row.started_at < found.at) found.at = row.started_at
    }
  }
  const items: EventItem[] = []
  for (const [key, group] of groups) {
    const jobId = key.split('\u0000')[0] as string
    const times = group.events > 1 ? ` ×${group.events}` : ''
    let label: string
    if (group.status === 'error') {
      const detail = clip(group.output, 80)
      label = `ошибка${times}${detail === '' ? '' : ` — ${detail}`}`
    } else if (group.status === 'skip') {
      label = `пропуск${times}`
    } else {
      label = `успех${times}`
    }
    items.push({ at: group.at, events: group.events, text: `- ${jobId}: ${label}` })
  }
  return items
}

function taskItems(db: DatabaseSync, afterId: number): EventItem[] {
  // A task is news when its terminal event is newer than the boundary: a task
  // created before the wake-up but finished after it still belongs here.
  const rows = safeQuery<TaskRow>(
    db,
    `SELECT t.id AS id, t.goal AS goal, t.state AS state, e.id AS event_id
     FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE e.id > ? AND e.state IN ('done', 'blocked') AND t.state IN ('done', 'blocked')
     ORDER BY e.id`,
    afterId,
  )
  return rows.map((row) => ({
    at: row.event_id,
    events: 1,
    text: `- Задача ${row.id} «${clip(row.goal, 120)}»: ${row.state === 'blocked' ? 'заблокирована' : 'завершена'}`,
  }))
}

function noteItems(notes: readonly WakeNote[] | undefined, since: number, prefix: string): EventItem[] {
  if (notes === undefined) return []
  return notes
    .filter((note) => note.at > since)
    .map((note) => ({ at: note.at, events: 1, text: `- ${prefix}: ${clip(note.text, 160)}` }))
}

/** Newest row id of each durable source, a valid boundary for the next wake-up. */
export function currentWakeBoundary(db: DatabaseSync, at: number): WakeBoundary {
  const maxId = (table: string): number => {
    const rows = safeQuery<{ id: number | null }>(db, `SELECT MAX(id) AS id FROM ${table}`)
    const value = rows[0]?.id
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
  }
  return {
    ingressId: maxId('ingress'),
    runId: maxId('schedule_runs'),
    taskEventId: maxId('task_events'),
    at,
  }
}

/**
 * The summary appended to the wake-up prompt. Never longer than
 * {@link WAKE_SUMMARY_LIMIT}; the omitted events are counted in the mark.
 */
export function buildWakeSummary(input: WakeSummaryInput): string {
  const messages = ownerMessages(input)
  const items: EventItem[] = [
    ...runItems(input.db, input.boundary.runId),
    ...taskItems(input.db, input.boundary.taskEventId),
    ...noteItems(input.daemonErrors, input.boundary.at, 'Ошибка демона'),
    ...noteItems(input.zavodTransitions, input.boundary.at, 'Задача завода'),
  ].sort((left, right) => left.at - right.at)

  const totalEvents = items.reduce((sum, item) => sum + item.events, 0)
  if (totalEvents === 0 && messages.count === 0) return NOTHING_HAPPENED

  const header = 'Что изменилось с прошлого пробуждения:'
  const messageLine =
    messages.count === 0
      ? ''
      : `Сообщений владельца: ${messages.count}; последнее в ${wakeClock(messages.lastAt ?? input.now, input.timeZone)}.`

  const fixed = [header, ...(messageLine === '' ? [] : [messageLine])].join('\n')
  let used = fixed.length
  const selected: EventItem[] = []
  // Reserve room for the mark; it is always counted from real events below.
  const RESERVE = 70
  for (const item of items) {
    if (used + 1 + item.text.length > WAKE_SUMMARY_LIMIT - RESERVE) break
    selected.push(item)
    used += 1 + item.text.length
  }

  let omitted = totalEvents - selected.reduce((sum, item) => sum + item.events, 0)
  let mark = omitted > 0 ? `… ещё ${omitted} событий не показано.` : ''
  while (selected.length > 0 && used + (mark === '' ? 0 : 1 + mark.length) > WAKE_SUMMARY_LIMIT) {
    const dropped = selected.pop() as EventItem
    used -= 1 + dropped.text.length
    omitted += dropped.events
    mark = `… ещё ${omitted} событий не показано.`
  }

  const lines = [fixed, ...selected.map((item) => item.text)]
  if (mark !== '') lines.push(mark)
  return lines.join('\n')
}
