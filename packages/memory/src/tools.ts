// Owner-facing tools of the memory layer: `memory`, `recall` and `update_identity`.
//
// `memory` edits the two file stores of DESIGN §7 through `createEntryStore`,
// `recall` searches the FTS5 index over chat/journal documents, and
// `update_identity` writes `memory/identity.md` with optimistic locking. The
// write rules from docs/research/prompts.md §6 live in the tool description so
// they ride in the cached schema instead of the prompt prefix.

import { join } from 'node:path'

import type { RunnerTool } from '../../runner/src/index.js'
import { createEntryStore, EntryStoreError, type EntryOperation } from './entries.js'
import {
  archiveIdentity,
  checkIdentityShrink,
  IDENTITY_MIN_LENGTH,
  IdentityError,
  readIdentity,
  writeIdentity,
} from './identity.js'
import type { RecallIndex } from './recall.js'

export const MEMORY_TOOL_NAME = 'memory'
export const RECALL_TOOL_NAME = 'recall'
export const UPDATE_IDENTITY_TOOL_NAME = 'update_identity'

/** Character budgets from DESIGN §7. */
export const USER_MEMORY_LIMIT = 1_400
export const ENVIRONMENT_MEMORY_LIMIT = 2_200

type MemoryTarget = 'user' | 'memory'

function targetOf(value: unknown): MemoryTarget {
  if (value === 'user' || value === 'memory') return value
  throw new Error("target must be 'user' or 'memory'")
}

function operationsOf(value: unknown): EntryOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('operations must be a non-empty array')
  return value.map((raw, index): EntryOperation => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`operations[${index}] must be an object`)
    }
    const operation = raw as Record<string, unknown>
    const op = operation.op
    if (op === 'add') {
      if (typeof operation.text !== 'string') throw new Error(`operations[${index}].text is required for add`)
      return { op: 'add', text: operation.text }
    }
    if (op === 'replace') {
      if (typeof operation.match !== 'string' || typeof operation.text !== 'string') {
        throw new Error(`operations[${index}] needs match and text for replace`)
      }
      return { op: 'replace', match: operation.match, text: operation.text }
    }
    if (op === 'remove') {
      if (typeof operation.match !== 'string') throw new Error(`operations[${index}].match is required for remove`)
      return { op: 'remove', match: operation.match }
    }
    throw new Error(`operations[${index}].op must be add, replace or remove`)
  })
}

const MEMORY_DESCRIPTION =
  'Save durable facts to persistent memory. The stores are memory/MEMORY.md (environment: tool quirks, project ' +
  'conventions, paths, endpoints; up to 2200 bytes) and memory/USER.md (who the owner is: persona, preferences, ' +
  'communication and work style; up to 1400 bytes). One fact goes to ONE store. Write declarative facts, not ' +
  'instructions: "Owner prefers concise answers" is right, "Always answer concisely" is wrong. Do not record ' +
  'failures, unresolved problems, or prohibitions about tools ("exec is broken", "never use X"): they harden into ' +
  'self-imposed bans. Procedures and pitfalls belong in a skill, not here; use `recall` for session history. ' +
  'Use one call with an operations array; the character limit is checked on the final state, so one batch may ' +
  'remove or replace stale entries and add a new one together. When a store is full, compress: replace stale ' +
  'entries or remove them in the same call instead of dropping the new fact.'

/** The `memory` tool over `<home>/memory/MEMORY.md` and `<home>/memory/USER.md`. */
export function createMemoryTool(home: string): RunnerTool {
  const stores: Record<MemoryTarget, ReturnType<typeof createEntryStore>> = {
    user: createEntryStore(join(home, 'memory', 'USER.md'), { limit: USER_MEMORY_LIMIT }),
    memory: createEntryStore(join(home, 'memory', 'MEMORY.md'), { limit: ENVIRONMENT_MEMORY_LIMIT }),
  }

  return {
    name: MEMORY_TOOL_NAME,
    description: MEMORY_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['user', 'memory'],
          description: "Which store to change: 'user' for USER.md, 'memory' for MEMORY.md.",
        },
        operations: {
          type: 'array',
          description: 'Operations are applied in order; the size limit is checked on the final state.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add', 'replace', 'remove'] },
              text: { type: 'string', description: 'New entry text for add/replace.' },
              match: { type: 'string', description: 'Exact substring identifying one existing entry for replace/remove.' },
            },
            required: ['op'],
          },
        },
      },
      required: ['target', 'operations'],
    },
    execute(args) {
      const target = targetOf(args.target)
      const limit = target === 'user' ? USER_MEMORY_LIMIT : ENVIRONMENT_MEMORY_LIMIT
      try {
        const entries = stores[target].apply(operationsOf(args.operations))
        if (entries.length === 0) return 'Память пуста.'
        const content = entries.join('\n§\n')
        const size = Buffer.byteLength(content, 'utf8')
        return `Сохранено. Записи (${size}/${limit} байт):\n${content}`
      } catch (error) {
        if (error instanceof EntryStoreError && error.code === 'limit') {
          throw new Error(
            `${error.message}. Лимит этого хранилища — ${limit} байт: сожмите запись — замените или удалите ` +
              'устаревшие записи в том же вызове memory, проверка идёт по итоговому размеру.',
          )
        }
        throw error
      }
    },
  }
}

function formatDate(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? 'дата неизвестна' : date.toISOString().slice(0, 10)
}

/** The `recall` tool over the daemon's FTS5 index. */
export interface RecallToolOptions {
  /**
   * Bring the workspace part of the index up to date before a search. The
   * caller owns the scan and promises not to throw; an error leaves the index
   * as it was and the search still runs.
   */
  refresh?: () => unknown
}

/** The `recall` tool over the daemon's FTS5 index. */
export function createRecallTool(index: RecallIndex, options: RecallToolOptions = {}): RunnerTool {
  return {
    name: RECALL_TOOL_NAME,
    description:
      'Search earlier owner dialogue turns, the journal, schedule runs and the text files of the workspace ' +
      '(notes and reports: .md and .txt) by keyword. Use it when an answer depends on prior work, decisions, ' +
      'dates, people, files or preferences that are not already in the current context. Hits carry a date and a ' +
      'source; workspace hits carry the path relative to the workspace and the matched line range; schedule runs ' +
      'rank lower. Do not repeat a search whose supplied context already answers the question.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for; word characters only, several words are combined with OR.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum number of hits, default 10.' },
      },
      required: ['query'],
    },
    execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new Error('query must be a non-empty string')
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined
      try {
        options.refresh?.()
      } catch {
        // A stale workspace index is better than a failed search.
      }
      const hits = index.search(query, limit === undefined ? {} : { limit })
      if (hits.length === 0) return 'Ничего не найдено.'
      const lines = [`Найдено ${hits.length}:`]
      for (const hit of hits) {
        const location =
          hit.kind === 'workspace' && hit.lines !== undefined
            ? `${hit.source}:${hit.lines.start}-${hit.lines.end}`
            : hit.source
        const snippet = hit.snippet.replace(/\s+/g, ' ').trim()
        lines.push(`- ${formatDate(hit.ts)} · ${hit.kind} · ${location}`, `  ${snippet}`)
      }
      return lines.join('\n')
    },
  }
}

/** The `update_identity` tool over `<home>/memory/identity.md` with a revision check. */
export function createUpdateIdentityTool(identityPath: string): RunnerTool {
  return {
    name: UPDATE_IDENTITY_TOOL_NAME,
    description:
      'Replace memory/identity.md, the bot identity that is loaded as a frozen snapshot into the session prefix. ' +
      'Pass expected_revision exactly as shown by the current identity_revision in the context; a stale revision is ' +
      'rejected without touching the file, so read the revision again before retrying. Keep the identity short. ' +
      'A drastic shrink is refused: when the current identity is not empty, a new text under 200 characters, or ' +
      'shorter than half of a current identity of at least 400 characters, needs force: true together with a ' +
      'non-empty reason; the reason and the previous version are archived in memory/identity-archive. ' +
      'force without a reason is rejected. The new text is visible in the prefix only in a later session.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Full new identity text.' },
        expected_revision: {
          type: 'string',
          description: 'sha256 revision of the identity the edit is based on (the context identity_revision).',
        },
        force: {
          type: 'boolean',
          description: 'Allow a drastic shrink; requires reason and archives the previous identity.',
        },
        reason: {
          type: 'string',
          description: 'Why the identity is shortened; stored at the top of memory/identity-archive/<time>.md.',
        },
      },
      required: ['text', 'expected_revision'],
    },
    execute(args) {
      const text = typeof args.text === 'string' ? args.text : ''
      const expected = typeof args.expected_revision === 'string' ? args.expected_revision : ''
      const force = args.force === true
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (force && reason === '') {
        throw new Error(
          'force: true требует непустой reason: объясните, почему личность сильно сокращается, — ' +
            'причина попадёт в начало архивного файла.',
        )
      }

      const current = readIdentity(identityPath)
      // On a stale revision `writeIdentity` below reports the usual conflict;
      // the shrink guard must not mask it with a length error.
      if (current.revision === expected) {
        const shrink = checkIdentityShrink(current.text, text)
        if (shrink.blocked) {
          if (!force) {
            const problem = shrink.belowFloor
              ? `Новая личность короче ${IDENTITY_MIN_LENGTH} символов`
              : 'Личность сокращается больше чем вдвое'
            throw new Error(
              `${problem}: сейчас ${shrink.previousLength} символов, в новой версии ${shrink.nextLength}. ` +
                'Обновление отклонено, файл не изменён. Если такая правка осознанная, повторите вызов с ' +
                'force: true и непустым reason — прежняя версия и причина сохранятся в memory/identity-archive.',
            )
          }
          if (text.trim() === '') {
            throw new IdentityError('blank', 'identity text must not be empty or whitespace')
          }
          archiveIdentity(identityPath, current.text, reason)
        }
      }

      const identity = writeIdentity(identityPath, text, expected)
      return `Личность обновлена. Новая ревизия: ${identity.revision}. В префиксе текущей сессии остаётся прежний снимок.`
    },
  }
}

/** Revision of the identity file as the model sees it in the tail context. */
export function currentIdentityRevision(identityPath: string): string {
  return readIdentity(identityPath).revision
}
