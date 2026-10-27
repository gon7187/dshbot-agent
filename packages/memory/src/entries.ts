// File-backed memory entries (MEMORY.md / USER.md).
//
// The file holds one entry per block, separated by a line containing only `§`.
// Every batch is validated against the final state, so a batch may free space
// by removing an entry and spend it on a new one in the same call.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { writeFileAtomic } from './atomic.js'

export const ENTRY_SEPARATOR = '\n§\n'

export type EntryOperation =
  | { op: 'add'; text: string }
  | { op: 'replace'; match: string; text: string }
  | { op: 'remove'; match: string }

export interface EntryStoreOptions {
  /** Maximum size of the whole file in UTF-8 bytes. */
  limit: number
}

export interface EntryStore {
  entries(): string[]
  apply(ops: EntryOperation[]): string[]
}

export class EntryStoreError extends Error {
  /** Entries that were stored before the rejected batch, so the agent can fix it. */
  readonly entries: string[]
  /** Machine-readable reason: `limit`, `match`, or `invalid`. */
  readonly code: 'limit' | 'match' | 'invalid'

  constructor(code: 'limit' | 'match' | 'invalid', message: string, entries: string[]) {
    super(message)
    this.name = 'EntryStoreError'
    this.code = code
    this.entries = entries
  }
}

function parseEntries(raw: string): string[] {
  if (raw.trim() === '') return []
  return raw
    .replace(/\r\n/g, '\n')
    .trim()
    .split(ENTRY_SEPARATOR)
    .filter((entry) => entry.trim() !== '')
}

function serializeEntries(entries: string[]): string {
  return entries.join(ENTRY_SEPARATOR)
}

function readEntries(filePath: string): string[] {
  if (!existsSync(filePath)) return []
  return parseEntries(readFileSync(filePath, 'utf8'))
}

function requireText(text: unknown, field: string): string {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  if (text.includes(ENTRY_SEPARATOR)) {
    throw new Error(`${field} must not contain the entry separator`)
  }
  return text
}

function matchingIndexes(entries: string[], match: string): number[] {
  return entries.flatMap((entry, index) => (entry.includes(match) ? [index] : []))
}

export function createEntryStore(filePath: string, options: EntryStoreOptions): EntryStore {
  if (!Number.isFinite(options.limit) || options.limit < 0) {
    throw new RangeError('limit must be a non-negative finite number')
  }
  const limit = Math.floor(options.limit)

  const entries = (): string[] => readEntries(filePath)

  const apply = (ops: EntryOperation[]): string[] => {
    const current = readEntries(filePath)
    const next = [...current]

    for (const op of ops) {
      if (op.op === 'add') {
        const text = requireText(op.text, 'add.text')
        // Adding exactly the same text again is a no-op, not a duplicate.
        if (!next.includes(text)) next.push(text)
        continue
      }

      if (op.op === 'replace' || op.op === 'remove') {
        if (typeof op.match !== 'string' || op.match === '') {
          throw new EntryStoreError('invalid', 'match must be a non-empty string', current)
        }
        const indexes = matchingIndexes(next, op.match)
        if (indexes.length !== 1) {
          const reason =
            indexes.length === 0
              ? `no entry contains ${JSON.stringify(op.match)}`
              : `${indexes.length} entries contain ${JSON.stringify(op.match)}; match must identify exactly one`
          throw new EntryStoreError(
            'match',
            `${op.op} rejected: ${reason}. Current entries: ${JSON.stringify(current)}`,
            current,
          )
        }
        const index = indexes[0] as number
        if (op.op === 'replace') {
          next[index] = requireText(op.text, 'replace.text')
        } else {
          next.splice(index, 1)
        }
        continue
      }

      throw new EntryStoreError(
        'invalid',
        `unknown operation: ${JSON.stringify(op)}. Current entries: ${JSON.stringify(current)}`,
        current,
      )
    }

    const content = serializeEntries(next)
    const size = Buffer.byteLength(content, 'utf8')
    if (size > limit) {
      throw new EntryStoreError(
        'limit',
        `memory limit exceeded: ${size} > ${limit} bytes. Current entries: ${JSON.stringify(current)}`,
        current,
      )
    }

    // Nothing was written before this point, so a rejected batch leaves the file untouched.
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileAtomic(filePath, content)
    return next
  }

  return {
    entries,
    apply,
  }
}
