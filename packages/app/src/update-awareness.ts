// "What's new" after a rollout: the daemon remembers the commit of `live` it
// ran last and, when HEAD moved, lists the titles of the commits in between.
//
// The list is a service insertion of the first turn of `main` after the change,
// never part of the stable system prefix: the prompt cache of the session must
// not break just because the code was updated. The state lives in the kv table
// of state.db next to the other durable daemon state.
//
// The text of the insertion is not code: it lives in the prompts catalogue
// (`prompts/whats-new.md`) and is loaded at the start, the same way the persona
// package loads its rules from `persona/rules.md`. A missing catalogue only
// means there is nothing to say; the commit is still recorded.
//
// Everything here is best-effort: a missing git binary, a directory that is not
// a repository, or a broken history must not stop the daemon. In those cases
// there is simply no insertion.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Kv } from '../../store/src/index.js'

/** kv key with the full sha of the commit `live` ran on the previous start. */
export const UPDATE_COMMIT_KEY = 'update.last_commit'

/** kv key with the list that still has to reach the first turn of `main`. */
export const UPDATE_PENDING_KEY = 'update.pending'

/** kv key with the moment the running commit was first seen, bound to that commit. */
export const UPDATE_ROLLOUT_KEY = 'update.rollout'

/** File of the prompts catalogue that carries the insertion. */
export const WHATS_NEW_PROMPT_FILE = 'whats-new.md'

/** Placeholder the catalogue file uses for the list of commit titles. */
export const WHATS_NEW_TITLES_PLACEHOLDER = '{{titles}}'

/** The owner sees at most this many titles of the new commits. */
export const MAX_UPDATE_TITLES = 30

/** git is only read here, but a hung git must not hang the start. */
const GIT_TIMEOUT_MS = 10_000

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

interface PendingUpdate {
  /** Commit the list belongs to. */
  commit: string
  titles: string[]
  /** When the rollout was noticed, Unix epoch milliseconds. */
  at: number
}

interface Rollout {
  /** Commit the moment belongs to. */
  commit: string
  /** When that commit was first seen running, Unix epoch milliseconds. */
  at: number
}

function runGit(directory: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }).trim()
  } catch {
    // No git in PATH, not a repository, or a git that failed: no news.
    return undefined
  }
}

/** Full sha of `HEAD` of the checkout in `directory`, or undefined without git. */
export function readHeadCommit(directory: string): string | undefined {
  const head = runGit(directory, ['rev-parse', 'HEAD'])
  if (head === undefined) return undefined
  const sha = head.toLowerCase()
  return SHA_RE.test(sha) ? sha : undefined
}

/** Titles of the commits between `from` and `to`, newest first, at most `limit`. */
export function readCommitTitles(directory: string, from: string, to: string, limit = MAX_UPDATE_TITLES): string[] | undefined {
  if (!SHA_RE.test(from) || !SHA_RE.test(to)) return undefined
  const output = runGit(directory, ['log', `--format=%s`, `--max-count=${limit}`, `${from}..${to}`])
  if (output === undefined) return undefined
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, limit)
}

function parsePending(raw: string | undefined): PendingUpdate | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.commit !== 'string' || !SHA_RE.test(record.commit)) return undefined
    if (!Array.isArray(record.titles)) return undefined
    const titles = record.titles.filter((title): title is string => typeof title === 'string' && title.trim() !== '')
    if (titles.length === 0) return undefined
    return {
      commit: record.commit,
      titles: titles.slice(0, MAX_UPDATE_TITLES),
      at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : Date.now(),
    }
  } catch {
    return undefined
  }
}

function parseRollout(raw: string | undefined): Rollout | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.commit !== 'string' || !SHA_RE.test(record.commit)) return undefined
    if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at <= 0) return undefined
    return { commit: record.commit, at: record.at }
  } catch {
    return undefined
  }
}

/**
 * The insertion template from the prompts catalogue, or undefined when the
 * file is absent or empty. A missing catalogue is not an error: the daemon
 * still starts and simply has no "what's new" to show.
 */
export function loadWhatsNewTemplate(promptsDir: string): string | undefined {
  try {
    const text = readFileSync(join(promptsDir, WHATS_NEW_PROMPT_FILE), 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Render the catalogue template with the titles of the new commits. */
export function whatsNewText(template: string, titles: readonly string[]): string {
  const list = titles.map((title) => `- ${title}`).join('\n')
  const body = template.includes(WHATS_NEW_TITLES_PLACEHOLDER)
    ? template.split(WHATS_NEW_TITLES_PLACEHOLDER).join(list)
    : `${template}\n${list}`
  return body.trim()
}

export interface UpdateAwareness {
  /** Full sha of the running commit, or undefined when git cannot tell. */
  readonly commit: string | undefined
  /**
   * When the running commit was first seen, or undefined without a git
   * checkout. A restart on the same commit keeps the stored moment: it is the
   * date of the rollout, not of the process start.
   */
  readonly rolloutAt: number | undefined
  /**
   * The insertion for the next turn of `main`, or `''`. Once taken, the news is
   * gone for good: one insertion per change of the version, and a restart on the
   * same commit has nothing to announce.
   */
  takeNews(): string
}

export interface UpdateAwarenessOptions {
  /** Clock of the start; exposed so tests can pin the rollout moment. */
  now?: number
  /** Directory of the prompts catalogue; defaults to `<directory>/prompts`. */
  promptsDir?: string
}

/**
 * Reads the commit recorded by the previous start and compares it with HEAD.
 *
 * - the first start of an installation only records the commit and its moment
 *   (nothing is "new" yet);
 * - the same commit keeps an undelivered list and the stored rollout moment, so
 *   a restart before the first owner turn does not lose the news and does not
 *   move the rollout date;
 * - a new commit stores the titles between the old and the new HEAD and keeps
 *   them until a turn of `main` takes them;
 * - a failed git read of HEAD (no binary, not a repository) leaves the record
 *   alone and makes no insertion;
 * - a failed git log (the old commit is no longer in the history) still moves
 *   the record to the new HEAD: the daemon did start on it. There is simply no
 *   list to announce.
 */
export function createUpdateAwareness(kv: Kv, directory: string, options: UpdateAwarenessOptions = {}): UpdateAwareness {
  const now = options.now ?? Date.now()
  const commit = readHeadCommit(directory)
  if (commit === undefined) {
    return { commit: undefined, rolloutAt: undefined, takeNews: () => '' }
  }

  const previous = (kv.get(UPDATE_COMMIT_KEY) ?? '').trim().toLowerCase()
  const storedRollout = parseRollout(kv.get(UPDATE_ROLLOUT_KEY))
  let pending = parsePending(kv.get(UPDATE_PENDING_KEY))
  let rolloutAt: number | undefined

  if (previous === '') {
    // The first start has nothing to compare against; just remember the commit
    // and the moment it was first seen.
    rolloutAt = now
    kv.set(UPDATE_COMMIT_KEY, commit)
    kv.set(UPDATE_PENDING_KEY, '')
    kv.set(UPDATE_ROLLOUT_KEY, JSON.stringify({ commit, at: rolloutAt } satisfies Rollout))
    pending = undefined
  } else if (previous === commit) {
    // The same version. An undelivered list still belongs to this turn, and the
    // rollout moment of that commit must not move on a plain restart.
    rolloutAt = storedRollout !== undefined && storedRollout.commit === commit ? storedRollout.at : now
    if (storedRollout === undefined || storedRollout.commit !== commit) {
      kv.set(UPDATE_ROLLOUT_KEY, JSON.stringify({ commit, at: rolloutAt } satisfies Rollout))
    }
  } else {
    const titles = readCommitTitles(directory, previous, commit)
    // The daemon now runs `commit`, so the record always moves to it, even when
    // git cannot list the commits in between. Otherwise a deleted old commit
    // would make every next start retry the same broken range forever.
    rolloutAt = now
    kv.set(UPDATE_COMMIT_KEY, commit)
    kv.set(UPDATE_ROLLOUT_KEY, JSON.stringify({ commit, at: rolloutAt } satisfies Rollout))
    if (titles === undefined || titles.length === 0) {
      // A broken or rewritten history has no titles to show. The record still
      // moves so the daemon does not retry forever.
      kv.set(UPDATE_PENDING_KEY, '')
      pending = undefined
    } else {
      pending = { commit, titles, at: now }
      kv.set(UPDATE_PENDING_KEY, JSON.stringify(pending))
    }
  }

  if (pending !== undefined && pending.commit !== commit) pending = undefined
  const template = loadWhatsNewTemplate(options.promptsDir ?? join(directory, 'prompts'))
  let news = pending === undefined || template === undefined ? '' : whatsNewText(template, pending.titles)

  return {
    commit,
    rolloutAt,
    takeNews() {
      const taken = news
      news = ''
      if (taken !== '') {
        try {
          kv.set(UPDATE_PENDING_KEY, '')
        } catch {
          // The insertion is already built; a failed cleanup only repeats it
          // after a restart, which is better than losing it.
        }
      }
      return taken
    },
  }
}
