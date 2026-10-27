// Search through the past conversations: the owner-only lazy tool
// `session_search` and the incremental index of the session logs behind it.
//
// The durable logs are the source of truth (`dsh/sessions/<id>/events.jsonl`).
// Only `main` and the sessions of detached tasks are indexed: a guest session
// is never read here, so its words can never reach the owner's search. The
// index lives in state.db (packages/store), so a restart does not lose the
// history and the catch-up at start reads only what the previous process did
// not see: events after the last indexed `seq` of each session.
//
// A message is indexed by its text only. The user events of `main` also carry
// service insertions in the tail of the same message (the skill index, the
// memory snapshot, the rollout news, the context of a reply or an attachment,
// a wake-up prompt); those are not the owner's words and are cut off before
// indexing. Tool results and every other event type are skipped by whitelist.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { MAIN_SESSION_ID, type RunnerTool } from '../../runner/src/index.js'
import {
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  type SessionIndex,
  type SessionMessageRecord,
  type SessionMessageRole,
} from '../../store/src/index.js'
import { TASK_SESSION_PREFIX } from './task-runtime.js'
import { frameData } from './untrusted-frame.js'

const EVENTS_FILE = 'events.jsonl'

/** Service insertion starts appended to the owner message by the daemon. */
const WAKE_PREFIX = '[ПРОБУЖДЕНИЕ]'
/**
 * Openings of the service blocks the turn appends after the owner's text.
 * Everything from the first one to the end of the message is not owner input.
 */
const SERVICE_BLOCK_MARKERS = ['\n\n<context', '\n\nТебя обновили:', '\n\nСправочный контекст:']

/** Only the owner's conversations and the sessions of tasks are searchable. */
export function isIndexedSession(sessionId: string): boolean {
  return (
    sessionId === MAIN_SESSION_ID ||
    sessionId.startsWith(`${MAIN_SESSION_ID}.bak-`) ||
    sessionId.startsWith(TASK_SESSION_PREFIX)
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Text blocks of a persisted message content array. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * The owner's part of a user message: the text before the first service
 * insertion. A wake-up prompt is a service message from beginning to end.
 */
export function ownerTextOf(raw: string): string {
  const text = raw.trim()
  if (text.startsWith(WAKE_PREFIX)) return ''
  let end = text.length
  for (const marker of SERVICE_BLOCK_MARKERS) {
    const at = text.indexOf(marker)
    if (at >= 0 && at < end) end = at
  }
  return text.slice(0, end).trim()
}

interface IndexedMessage {
  seq: number
  at: number
  role: SessionMessageRole
  text: string
}

/** The searchable message of one session event, or `undefined` for every other event. */
function messageOf(event: Record<string, unknown>): IndexedMessage | undefined {
  const seq = safeSeq(event.seq)
  if (seq === undefined) return undefined
  const at = typeof event.time === 'number' && Number.isFinite(event.time) ? Math.trunc(event.time) : undefined
  if (at === undefined) return undefined
  const data = asRecord(event.data)
  if (data === undefined) return undefined

  if (event.type === 'user/message') {
    // Injected harness contexts name their producer; only a direct user prompt
    // carries `kind: 'user'`. An absent source is accepted for older logs.
    const source = asRecord(data.source)
    if (source !== undefined && typeof source.kind === 'string' && source.kind !== 'user') return undefined
    const text = ownerTextOf(textOf(data.content))
    return text === '' ? undefined : { seq, at, role: 'user', text }
  }

  if (event.type === 'assistant/message') {
    const message = asRecord(data.message)
    const text = textOf(message?.content).trim()
    return text === '' ? undefined : { seq, at, role: 'assistant', text }
  }

  return undefined
}

/** One message of a past conversation, as the model saw it. */
export interface RecentSessionMessage {
  role: SessionMessageRole
  text: string
}

/**
 * The last `limit` user and assistant messages of one durable session, in
 * order. It is the read-only source of context for a turn that must see the
 * recent conversation without opening or writing that session (the `/btw`
 * side question). A missing log, a damaged line or an unreadable file yields
 * the messages that could be read, never an exception.
 */
export function readRecentSessionMessages(
  sessionsRoot: string,
  sessionId: string,
  limit: number,
): RecentSessionMessage[] {
  const keep = Math.max(0, Math.floor(limit))
  if (keep === 0) return []
  const file = join(sessionsRoot, sessionId, EVENTS_FILE)
  let raw: string
  try {
    if (!existsSync(file)) return []
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const messages: RecentSessionMessage[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A crash can leave a torn last record; every complete message before it
      // is still usable context.
      continue
    }
    const event = asRecord(parsed)
    if (event === undefined) continue
    const message = messageOf(event)
    if (message === undefined) continue
    messages.push({ role: message.role, text: message.text })
  }
  return messages.slice(-keep)
}

export interface SessionLogIndexer {
  /** Read the new events of one session, if it is searchable. Never throws. */
  indexSession(sessionId: string): void
  /** Catch up every searchable session on disk; run once at daemon start. */
  catchUp(): void
}export interface SessionLogIndexerOptions {
  index: SessionIndex
  /** `$DSHBOT_HOME/dsh/sessions`. */
  sessionsRoot: string
  log?: (message: string) => void
}

export function createSessionLogIndexer(options: SessionLogIndexerOptions): SessionLogIndexer {
  const { index, sessionsRoot } = options
  const log = options.log ?? ((): void => {})

  function indexSession(sessionId: string): void {
    if (!isIndexedSession(sessionId)) return
    const file = join(sessionsRoot, sessionId, EVENTS_FILE)
    let raw: string
    try {
      if (!existsSync(file)) return
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      log(`session index: cannot read ${file}: ${String(error)}`)
      return
    }

    const lines = raw.split('\n')
    // The first parseable record identifies the log generation. `/new` moves
    // the old directory aside and starts a new log with the same `main` id and
    // `seq` from zero, so a different head means the old rows no longer belong
    // to this session.
    let firstEvent: string | undefined
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (asRecord(parsed) !== undefined) {
          firstEvent = createHash('sha256').update(line).digest('hex')
          break
        }
      } catch {
        // A damaged line is skipped; keep looking for the head of the log.
      }
    }

    const checkpoint = index.checkpoint(sessionId)
    let last = checkpoint.lastSeq
    if (checkpoint.firstEvent !== undefined && firstEvent !== undefined && checkpoint.firstEvent !== firstEvent) {
      try {
        index.remove(sessionId)
      } catch (error) {
        log(`session index: cannot reset ${sessionId}: ${String(error)}`)
        return
      }
      last = -1
    }

    let seen = last
    const messages: SessionMessageRecord[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A crash can leave a torn record. The line is skipped; the indexer
        // stays alive and a later complete append is still read.
        continue
      }
      const event = asRecord(parsed)
      if (event === undefined) continue
      const seq = safeSeq(event.seq)
      if (seq === undefined) continue
      if (seq > seen) seen = seq
      if (seq <= last) continue
      const message = messageOf(event)
      if (message === undefined) continue
      messages.push({ sessionId, ...message })
    }

    if (seen <= last) return
    try {
      index.record(sessionId, messages, seen, firstEvent)
    } catch (error) {
      // The search index must never take the daemon down; the same range is
      // retried by the next catch-up because the checkpoint did not move.
      log(`session index: cannot index ${sessionId}: ${String(error)}`)
    }
  }

  function catchUp(): void {
    let entries: string[]
    try {
      entries = readdirSync(sessionsRoot)
    } catch {
      // No sessions yet: nothing to catch up.
      return
    }
    for (const name of entries) {
      if (!isIndexedSession(name)) continue
      try {
        if (!statSync(join(sessionsRoot, name)).isDirectory()) continue
      } catch {
        continue
      }
      indexSession(name)
    }
  }

  return { indexSession, catchUp }
}

function moment(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`session_search: ${field} must be a finite moment`)
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error(`session_search: ${field} is not a valid date`)
    return Math.trunc(parsed)
  }
  throw new Error(`session_search: ${field} must be an ISO date or epoch milliseconds`)
}

function limitOf(value: unknown): number {
  if (value === undefined || value === null) return SESSION_SEARCH_DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('session_search: limit must be a number')
  }
  return Math.max(1, Math.min(Math.floor(value), SESSION_SEARCH_MAX_LIMIT))
}

/**
 * The lazy owner-only tool. Its answer is untrusted data: the excerpts are the
 * owner's own words from an old conversation, but a pasted page or a forged
 * line can be in there, so the whole answer goes through the same frame as
 * `web_fetch` and a boundary word inside an excerpt cannot close it early.
 */
export function createSessionSearchTool(
  index: SessionIndex,
  options: { refresh?: () => void } = {},
): RunnerTool {
  return {
    name: 'session_search',
    lazy: true,
    description:
      'Find fragments of the past conversations of the owner and of the task sessions: ' +
      'matches user and assistant messages by words and returns the time, the session, the role ' +
      'and a short excerpt around the match. Use it when the answer is outside the current turn ' +
      'and the context tail.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to look for in the past messages.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: SESSION_SEARCH_MAX_LIMIT,
          description: `How many messages to return, at most ${SESSION_SEARCH_MAX_LIMIT}.`,
        },
        since: {
          type: 'string',
          description: 'Only messages at or after this moment (ISO date or epoch milliseconds).',
        },
        until: {
          type: 'string',
          description: 'Only messages at or before this moment (ISO date or epoch milliseconds).',
        },
      },
      required: ['query'],
    },
    execute(args) {
      // A turn that just ended may still be queued into the log; the index is
      // brought up to date before every query, so a phrase of this very session
      // is found without waiting for the next turn.
      try {
        options.refresh?.()
      } catch {
        // The query itself still runs against the index already built.
      }
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('session_search: query must be a non-empty string')
      const since = moment(args.since, 'since')
      const until = moment(args.until, 'until')
      if (since !== undefined && until !== undefined && since > until) {
        throw new Error('session_search: since must not be after until')
      }
      const hits = index.search(query, {
        limit: limitOf(args.limit),
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
      })
      if (hits.length === 0) return frameData('Ничего не найдено в прошлых разговорах.')
      const lines = hits.map((hit, number) => {
        const when = new Date(hit.at).toISOString()
        return `[${number + 1}] ${when} · ${hit.sessionId} · ${hit.role}\n${hit.excerpt}`
      })
      return frameData(lines.join('\n\n'))
    },
  }
}
