// Deterministic curator of the skill library (DESIGN §8.1, Hermes curator).
//
// Every seven days, when the bot has been idle for at least two hours, the
// curator walks the library without any model call:
//
//   * a skill unused for 14 days is marked `stale` in its metadata;
//   * a skill unused for 30 days is moved to `skills/.archive/<name>`.
//
// Archiving is the maximum destructive action; nothing is ever deleted. A skill
// without metadata (copied from ~/.agents/skills) is aged by the modification
// time of its SKILL.md, so the first pass cannot archive a fresh copy as if it
// were decades old.

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { SKILLS_ARCHIVE_DIR, type SkillStore } from './skills.js'

/** Minimal key/value store: state.db kv in the daemon, a map in tests. */
export interface KvStore {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** Cadence of the deterministic pass. */
export const CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** The bot must have been idle this long before the curator acts. */
export const CURATOR_IDLE_MS = 2 * 60 * 60 * 1000

/** A skill unused for this long is stale. */
export const SKILL_STALE_MS = 14 * 24 * 60 * 60 * 1000

/** A skill unused for this long is archived. */
export const SKILL_ARCHIVE_MS = 30 * 24 * 60 * 60 * 1000

const LAST_ACTIVITY_KEY = 'learn.last_activity'
const LAST_RUN_KEY = 'learn.curator_last_run'

export interface CuratorReport {
  /** The pass ran (the interval and the idle period were satisfied). */
  ran: boolean
  stale: string[]
  archived: string[]
}

export interface CuratorOptions {
  store: SkillStore
  kv: KvStore
  now?: () => number
  log?: (message: string) => void
  intervalMs?: number
  idleMs?: number
  staleMs?: number
  archiveMs?: number
}

export interface Curator {
  /** Records real activity; guest and scheduled turns count too. */
  touch(at?: number): void
  /** Runs one pass when due; a skipped pass does not move the last-run mark. */
  runIfDue(): CuratorReport
  /** Absolute archive directory, for tests and logs. */
  readonly archiveDir: string
}

function numberFrom(kv: KvStore, key: string): number | undefined {
  const raw = kv.get(key)
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

export function createCurator(options: CuratorOptions): Curator {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => undefined)
  const intervalMs = options.intervalMs ?? CURATOR_INTERVAL_MS
  const idleMs = options.idleMs ?? CURATOR_IDLE_MS
  const staleMs = options.staleMs ?? SKILL_STALE_MS
  const archiveMs = options.archiveMs ?? SKILL_ARCHIVE_MS
  const archiveDir = join(options.store.dir, SKILLS_ARCHIVE_DIR)

  const touch = (at?: number): void => {
    options.kv.set(LAST_ACTIVITY_KEY, String(Math.floor(at ?? now())))
  }

  const runIfDue = (): CuratorReport => {
    const at = now()
    const lastRun = numberFrom(options.kv, LAST_RUN_KEY)
    if (lastRun !== undefined && at - lastRun < intervalMs) return { ran: false, stale: [], archived: [] }

    const lastActivity = numberFrom(options.kv, LAST_ACTIVITY_KEY)
    if (lastActivity !== undefined && at - lastActivity < idleMs) return { ran: false, stale: [], archived: [] }

    options.kv.set(LAST_RUN_KEY, String(Math.floor(at)))
    const stale: string[] = []
    const archived: string[] = []
    for (const skill of options.store.list()) {
      // A shipped skill is read-only and must not be archived or aged.
      if (skill.builtin) continue
      const age = at - skill.lastUsedAt
      if (age >= archiveMs) {
        if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
        let target = join(archiveDir, skill.name)
        if (existsSync(target)) target = join(archiveDir, `${skill.name}-${Math.floor(at)}`)
        renameSync(join(options.store.dir, skill.name), target)
        archived.push(skill.name)
        log(`curator: skill ${skill.name} archived after ${Math.floor(age / 86_400_000)} days`)
        continue
      }
      if (age >= staleMs && !skill.stale) {
        options.store.setMeta(skill.name, {
          createdAt: skill.createdAt,
          lastUsedAt: skill.lastUsedAt,
          stale: true,
        })
        stale.push(skill.name)
        log(`curator: skill ${skill.name} is stale after ${Math.floor(age / 86_400_000)} days`)
      }
    }
    return { ran: true, stale, archived }
  }

  return { touch, runIfDue, archiveDir }
}
