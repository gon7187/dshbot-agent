// Bot identity with optimistic locking.
//
// Revision is the sha256 of the file bytes, so any external edit is detected
// and a write based on a stale read is rejected instead of overwriting it.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { writeFileAtomic } from './atomic.js'

export interface Identity {
  text: string
  revision: string
}

export class IdentityError extends Error {
  readonly code: 'conflict' | 'blank'

  constructor(code: 'conflict' | 'blank', message: string) {
    super(message)
    this.name = code === 'conflict' ? 'IdentityConflictError' : 'IdentityError'
    this.code = code
  }
}

export function revisionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Characters, not UTF-16 code units: emoji and other astral symbols count once. */
export function identityLength(text: string): number {
  return Array.from(text).length
}

/**
 * Thresholds of the identity shrink guard.
 *
 * Any existing identity is protected by the absolute floor: a new identity
 * shorter than it needs `force`. Relative shrink only counts for an identity of
 * at least 400 characters, so editing a short identity is not blocked by the
 * ratio.
 */
export const IDENTITY_MIN_LENGTH = 200
export const IDENTITY_SHRINK_GUARD_LENGTH = 400

export interface IdentityShrinkCheck {
  previousLength: number
  nextLength: number
  /** The replacement is under the absolute floor of `IDENTITY_MIN_LENGTH`. */
  belowFloor: boolean
  /** True when the replacement needs `force: true` and a reason. */
  blocked: boolean
}

/** The shrink guard: a drastic reduction of an existing identity is blocked. */
export function checkIdentityShrink(previous: string, next: string): IdentityShrinkCheck {
  const previousLength = identityLength(previous)
  const nextLength = identityLength(next)
  // A missing, empty or whitespace-only identity has nothing to protect;
  // `writeIdentity` treats such a text as blank too.
  if (previous.trim() === '') return { previousLength, nextLength, belowFloor: false, blocked: false }
  const belowFloor = nextLength < IDENTITY_MIN_LENGTH
  const halved = previousLength >= IDENTITY_SHRINK_GUARD_LENGTH && nextLength * 2 < previousLength
  return { previousLength, nextLength, belowFloor, blocked: belowFloor || halved }
}

/** Directory next to `memory/identity.md` that keeps the previous versions. */
export function identityArchiveDir(identityPath: string): string {
  return join(dirname(identityPath), 'identity-archive')
}

/**
 * Saves the previous identity to `memory/identity-archive/<time>.md` with the
 * reason at the top. Returns the path of the archive file.
 */
export function archiveIdentity(identityPath: string, previous: string, reason: string, now = new Date()): string {
  const directory = identityArchiveDir(identityPath)
  mkdirSync(directory, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  let archivePath = join(directory, `${stamp}.md`)
  for (let suffix = 1; existsSync(archivePath); suffix += 1) {
    archivePath = join(directory, `${stamp}-${suffix}.md`)
  }
  const content = [
    `Причина: ${reason}`,
    `Сохранено: ${now.toISOString()}`,
    '',
    '# Прежняя версия identity',
    '',
    previous,
  ].join('\n')
  writeFileAtomic(archivePath, content)
  return archivePath
}

export function readIdentity(filePath: string): Identity {
  if (!existsSync(filePath)) {
    return { text: '', revision: revisionOf('') }
  }
  const bytes = readFileSync(filePath)
  return { text: bytes.toString('utf8'), revision: revisionOf(bytes) }
}

/**
 * Writes `text` only if the current revision equals `expectedRevision`.
 *
 * Returns the new identity. A missing file is treated as the empty identity,
 * so its revision is sha256('').
 */
export function writeIdentity(filePath: string, text: string, expectedRevision: string): Identity {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new IdentityError('blank', 'identity text must not be empty or whitespace')
  }

  const current = readIdentity(filePath)
  if (current.revision !== expectedRevision) {
    throw new IdentityError(
      'conflict',
      `identity revision conflict: expected ${expectedRevision}, current ${current.revision}`,
    )
  }

  mkdirSync(dirname(filePath), { recursive: true })
  writeFileAtomic(filePath, text)
  return { text, revision: revisionOf(Buffer.from(text, 'utf8')) }
}
