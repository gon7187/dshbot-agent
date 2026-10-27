// Snapshots of the bot's own state: a consistent copy of `state.db` plus the
// files that make the bot itself (memory, skills, identity, mcp.json,
// agents.json), taken once a day and on `/backup`.
//
// The database is never copied as a file: in WAL mode the main file alone has
// no recent rows. `VACUUM INTO` writes one consistent database from the daemon's
// own connection, WAL included, and the copy is checked with `quick_check`
// before it counts as a snapshot. A failed snapshot removes its own unfinished
// directory and leaves the earlier ones alone.
//
// The snapshot directory is `DSHBOT_HOME/backups/<owner time>/`. Only the last
// `keep` directories of `backups/` stay; a file or a directory outside
// `backups/` is never touched. `backups/` is 0700 and every file of a snapshot is
// 0600. Only the listed paths are copied, never the config directory with the
// environment file.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { nextRun, parseSchedule } from '../../scheduler/src/index.js'

/** Time of the daily snapshot when nothing is configured: 04:00 in the owner zone. */
export const DEFAULT_BACKUP_AT = '04:00'

/** Number of snapshots kept when nothing is configured. */
export const DEFAULT_BACKUP_KEEP = 7

/** Directory under `DSHBOT_HOME` that holds the snapshots. */
export const BACKUPS_DIR = 'backups'

/** Name of a snapshot directory: `YYYY-MM-DDTHH-MM-SS` with an optional `-NNN` suffix. */
export const SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?$/

/** Files of `DSHBOT_HOME` copied into every snapshot when they exist. */
export const BACKUP_FILES: readonly string[] = ['identity.md', 'mcp.json', 'agents.json']

/** Directories of `DSHBOT_HOME` copied into every snapshot when they exist. */
export const BACKUP_DIRS: readonly string[] = ['memory', 'skills']

/** Owner time of day, `HH:MM`. */
export interface BackupMoment {
  hour: number
  minute: number
}

/** One snapshot on disk. */
export interface SnapshotInfo {
  /** Directory name under `backups/` (the owner time of the snapshot). */
  readonly name: string
  /** Absolute path of the snapshot directory. */
  readonly path: string
  /** Sum of the sizes of the snapshot's files, bytes. */
  readonly sizeBytes: number
  /** Modification time of the snapshot directory, Unix epoch milliseconds. */
  readonly createdAt: number
}

export interface BackupOptions {
  /** `DSHBOT_HOME`: the state and the files that are copied. */
  readonly home: string
  /** The daemon's own connection: `VACUUM INTO` runs on it, WAL included. */
  readonly db: DatabaseSync
  /** How many snapshots stay in `backups/`; defaults to {@link DEFAULT_BACKUP_KEEP}. */
  readonly keep?: number
  /** IANA zone of the owner: the snapshot name and the daily alarm use it. */
  readonly timeZone: string
  /** Clock seam, Unix epoch milliseconds. */
  readonly now?: () => number
  /** Journal seam; a failed rotation step is one line, not a failed snapshot. */
  readonly log?: (text: string) => void
}

/** Parse `HH:MM` on a 24-hour clock; a malformed value is never a silent default. */
export function parseBackupAt(value: string): BackupMoment | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  return { hour, minute }
}

/**
 * The first occurrence of `HH:MM` in `timeZone` strictly after `afterMs`.
 * The cron engine of the scheduler package owns the DST arithmetic: a skipped
 * wall-clock time rolls to the next day, an ambiguous one takes its first
 * instant.
 */
export function nextBackupAt(afterMs: number, at: string, timeZone: string): number {
  const moment = parseBackupAt(at)
  if (moment === undefined) throw new Error(`backup time must be HH:MM, got ${JSON.stringify(at)}`)
  const schedule = parseSchedule(`${moment.minute} ${moment.hour} * * *`, timeZone)
  const next = nextRun(schedule, new Date(afterMs), timeZone)
  if (next === null) throw new Error(`backup time ${at} has no next occurrence in ${timeZone}`)
  return next.getTime()
}

/** Directory that holds the snapshots of `home`. */
export function backupsDir(home: string): string {
  return join(home, BACKUPS_DIR)
}

/** Human size with a unit; small snapshots stay readable (`1.2 КБ`, `3 Б`). */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1024) return `${Math.round(value)} Б`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} МБ`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} ГБ`
}

/** `YYYY-MM-DD HH:MM` of an instant, on the wall clock of `timeZone` (process zone when absent). */
export function formatSnapshotTime(instantMs: number, timeZone?: string): string {
  if (timeZone !== undefined && timeZone !== '') {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(instantMs)
      const value = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((part) => part.type === type)?.value ?? '00'
      return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
    } catch {
      // An unknown zone falls back to the zone of the process.
    }
  }
  const date = new Date(instantMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** `YYYY-MM-DDTHH-MM-SS` of an instant on the owner's wall clock. */
function snapshotStamp(instantMs: number, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instantMs)
  } catch {
    // An unknown zone is not worth losing the snapshot over: UTC is honest.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instantMs)
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00'
  return (
    `${value('year')}-${value('month')}-${value('day')}T` +
    `${value('hour')}-${value('minute')}-${value('second')}`
  )
}

/** `backups/` with 0700: named snapshots are for the owner of the process only. */
function ensureBackupsDir(home: string): string {
  const directory = backupsDir(home)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // A `backups/` symlink (an external disk, or a mistake) is the owner's
  // choice: create the snapshots there, but do not chmod the target directory.
  if (!lstatSync(directory).isSymbolicLink()) chmodSync(directory, 0o700)
  return directory
}

/** A name no snapshot of `backups/` uses yet; the wall clock alone may repeat. */
function uniqueSnapshotName(directory: string, base: string): string {
  let name = base
  for (let suffix = 2; existsSync(join(directory, name)); suffix += 1) {
    name = `${base}-${String(suffix).padStart(3, '0')}`
  }
  return name
}

/** One SQL string literal: a path with a quote must not break `VACUUM INTO`. */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** A consistent copy of the live database, WAL included, written by SQLite itself. */
function vacuumInto(db: DatabaseSync, target: string): void {
  db.exec(`VACUUM INTO ${sqlString(target)}`)
}

/** `PRAGMA quick_check` of a database file; throws when it cannot be opened or read. */
function quickCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    return row === undefined ? '' : String(Object.values(row)[0] ?? '')
  } finally {
    db.close()
  }
}

function copyFile(from: string, to: string): void {
  copyFileSync(from, to)
  chmodSync(to, 0o600)
}

function copyDirectory(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  chmodSync(target, 0o700)
  for (const name of readdirSync(source)) {
    const from = join(source, name)
    const to = join(target, name)
    const stat = lstatSync(from)
    // A link can point anywhere, including the config directory with secrets;
    // the snapshot copies the files the bot owns, not their targets.
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) copyDirectory(from, to)
    else if (stat.isFile()) copyFile(from, to)
  }
}

/** Copies an optional entry of `home` into the snapshot; absent entries are fine. */
function copyEntry(home: string, name: string, snapshot: string): void {
  const source = join(home, name)
  if (!existsSync(source)) return
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) copyDirectory(source, join(snapshot, name))
  else if (stat.isFile()) copyFile(source, join(snapshot, name))
}

function treeSize(root: string): number {
  let total = 0
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) total += treeSize(path)
    else if (stat.isFile()) total += stat.size
  }
  return total
}

/**
 * Names of the snapshot directories of `backups/`, oldest first by name.
 *
 * Only the directories the bot itself names (`YYYY-MM-DDTHH-MM-SS[-NNN]`) are
 * snapshots. Anything else in `backups/` — a hand-made directory, a file, a
 * symlink — is never counted or rotated; `backups/` may itself be a symlink to
 * a directory that holds other things.
 */
function snapshotNames(home: string): string[] {
  const directory = backupsDir(home)
  if (!existsSync(directory)) return []
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SNAPSHOT_NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** Drops the oldest snapshot directories, only inside `backups/`. */
function rotate(home: string, keep: number, log: (text: string) => void): void {
  const directory = backupsDir(home)
  const names = snapshotNames(home)
  const extra = names.length - keep
  for (let index = 0; index < extra; index += 1) {
    const name = names[index]
    if (name === undefined) continue
    try {
      rmSync(join(directory, name), { recursive: true, force: true })
    } catch (error) {
      // A stuck old snapshot must not turn a good new one into a failure.
      log(`backup rotation failed for ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function normalizeKeep(keep: number | undefined): number {
  if (keep === undefined) return DEFAULT_BACKUP_KEEP
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new Error(`backup keep must be a positive integer, got ${String(keep)}`)
  }
  return keep
}

/**
 * Takes one snapshot. Throws when the database cannot be copied, when the copy
 * fails `quick_check` or when a file cannot be written; the unfinished
 * directory is removed before the throw, the earlier snapshots stay.
 */
export function makeSnapshot(options: BackupOptions): SnapshotInfo {
  const keep = normalizeKeep(options.keep)
  const log = options.log ?? (() => undefined)
  const now = options.now ?? (() => Date.now())
  const directory = ensureBackupsDir(options.home)
  const name = uniqueSnapshotName(directory, snapshotStamp(now(), options.timeZone))
  const snapshot = join(directory, name)
  mkdirSync(snapshot, { recursive: false, mode: 0o700 })
  chmodSync(snapshot, 0o700)
  try {
    const copy = join(snapshot, 'state.db')
    vacuumInto(options.db, copy)
    chmodSync(copy, 0o600)
    const verdict = quickCheck(copy)
    if (verdict.toLowerCase() !== 'ok') {
      throw new Error(`PRAGMA quick_check копии state.db: ${verdict === '' ? 'пустой ответ' : verdict}`)
    }
    for (const file of BACKUP_FILES) copyEntry(options.home, file, snapshot)
    for (const dir of BACKUP_DIRS) copyEntry(options.home, dir, snapshot)
    const sizeBytes = treeSize(snapshot)
    const createdAt = statSync(snapshot).mtimeMs
    rotate(options.home, keep, log)
    return { name, path: snapshot, sizeBytes, createdAt }
  } catch (error) {
    try {
      rmSync(snapshot, { recursive: true, force: true })
    } catch {
      // Keep the original error: it names the reason of the failed snapshot.
    }
    throw error
  }
}

/** The newest snapshot of `backups/`, or undefined when there is none. */
export function lastSnapshot(home: string): SnapshotInfo | undefined {
  const name = snapshotNames(home).at(-1)
  if (name === undefined) return undefined
  const path = join(backupsDir(home), name)
  try {
    return {
      name,
      path,
      sizeBytes: treeSize(path),
      createdAt: statSync(path).mtimeMs,
    }
  } catch {
    return undefined
  }
}

/** A target missed by more than this is not replayed: the next snapshot is tomorrow. */
const MAX_LATE_MS = 5 * 60_000

export interface BackupSchedulerOptions {
  /** Time of the day, `HH:MM`, in `timeZone`; defaults to {@link DEFAULT_BACKUP_AT}. */
  readonly at?: string
  /** IANA zone of the owner. */
  readonly timeZone: string
  /** Runs one daily snapshot; a throw is reported through `onError`. */
  readonly run: () => Promise<void> | void
  /** Clock used for the due check; defaults to the wall clock. */
  readonly now?: () => number
  /** Timer seam; defaults to the process `setTimeout`. */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  /** Timer seam; defaults to the process `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void
  /** Reported once per failed run; a broken handler never breaks the alarm. */
  readonly onError?: (error: unknown) => void
}

export interface BackupScheduler {
  /** Arm the next snapshot; a no-op when already started. */
  start(): void
  /** Disarm the alarm; a snapshot in flight finishes on its own. */
  stop(): void
  /** Planned time of the next snapshot, or undefined when none is armed. */
  nextBackupAt(): number | undefined
  /** True from the fire of the alarm until its snapshot settled. */
  isRunning(): boolean
  /** Configured time of day, `HH:MM`. */
  backupAt(): string
}

/**
 * Once-a-day alarm of the snapshot. It is armed from "now" only, never from the
 * moment it should have fired: a time missed while the daemon was off is not
 * made up for, the next snapshot is the next occurrence of `HH:MM`.
 */
export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const at = options.at ?? DEFAULT_BACKUP_AT
  const now = options.now ?? (() => Date.now())
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, Math.max(1, delayMs)))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const reportError = options.onError ?? (() => undefined)

  let started = false
  let running = false
  let dueAt: number | undefined
  let handle: unknown

  function clear(): void {
    if (handle !== undefined) {
      clearTimer(handle)
      handle = undefined
    }
    dueAt = undefined
  }

  function armAfter(fromMs: number): void {
    if (!started) return
    clear()
    let next: number
    try {
      next = nextBackupAt(fromMs, at, options.timeZone)
    } catch (error) {
      reportError(error)
      return
    }
    dueAt = next
    handle = setTimer(onTimer, Math.max(1, next - now()))
  }

  function onTimer(): void {
    handle = undefined
    const current = now()
    const due = dueAt
    dueAt = undefined
    if (!started || running || due === undefined) return
    // A shortened real timer (tests, host timer scaling) is not a due alarm yet.
    if (current + 1_000 < due) {
      dueAt = due
      handle = setTimer(onTimer, due - current)
      return
    }
    // The host slept through the target: a snapshot that old is not replayed.
    if (current - due > MAX_LATE_MS) {
      armAfter(current)
      return
    }
    void fire()
  }

  async function fire(): Promise<void> {
    if (!started || running) return
    running = true
    try {
      await options.run()
    } catch (error) {
      reportError(error)
    } finally {
      running = false
    }
    if (started) armAfter(now())
  }

  return {
    start() {
      if (started) return
      started = true
      armAfter(now())
    },
    stop() {
      started = false
      clear()
    },
    nextBackupAt: () => dueAt,
    isRunning: () => running,
    backupAt: () => at,
  }
}
