// Rotation of backups/ deletes only the snapshots the bot made itself (directories named like
// YYYY-MM-DDTHH-MM-SS[-NNN]); anything else inside backups/, or behind a backups/ symlink, is never counted or removed.
// In-process: makeSnapshot and lastSnapshot run against a real SQLite file and a scratch DSHBOT_HOME.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { lastSnapshot, makeSnapshot } from './src/backup.js'

const SNAPSHOT_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?$/
const DAY_MS = 24 * 60 * 60 * 1000
const START_MS = Date.UTC(2026, 5, 1, 4, 0, 0)

let scratch = ''
let home = ''
let db: DatabaseSync

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-backup-rotation-'))
  home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  db = new DatabaseSync(join(home, 'state.db'))
  db.exec('CREATE TABLE t (v TEXT); INSERT INTO t (v) VALUES (\'row\')')
})

afterEach(() => {
  db.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** Takes `count` snapshots, one fake day apart, and returns their names. */
function takeSnapshots(count: number, keep: number): string[] {
  const names: string[] = []
  for (let index = 0; index < count; index += 1) {
    const info = makeSnapshot({
      home,
      db,
      keep,
      timeZone: 'UTC',
      now: () => START_MS + index * DAY_MS,
    })
    names.push(info.name)
  }
  return names
}

test('test_h1_rotation_keeps_foreign_entries_of_backups_and_counts_only_snapshots', () => {
  const backups = join(home, 'backups')
  mkdirSync(join(backups, 'keep-me'), { recursive: true })
  writeFileSync(join(backups, 'keep-me', 'precious.txt'), 'keep-me-content')
  mkdirSync(join(backups, 'notes'), { recursive: true })
  writeFileSync(join(backups, 'notes', 'todo.txt'), 'notes-content')
  writeFileSync(join(backups, 'readme.txt'), 'readme-content')
  const outside = join(scratch, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'file.txt'), 'outside-content')
  symlinkSync(outside, join(backups, '2020-01-01T00-00-00'))

  const names = takeSnapshots(3, 1)

  expect(existsSync(join(backups, 'keep-me', 'precious.txt'))).toBe(true)
  expect(readFileSync(join(backups, 'keep-me', 'precious.txt'), 'utf8')).toBe('keep-me-content')
  expect(readFileSync(join(backups, 'notes', 'todo.txt'), 'utf8')).toBe('notes-content')
  expect(readFileSync(join(backups, 'readme.txt'), 'utf8')).toBe('readme-content')
  expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe('outside-content')

  const snapshots = readdirSync(backups).filter((name) => SNAPSHOT_NAME.test(name) && name !== '2020-01-01T00-00-00')
  expect(snapshots).toEqual([names[2]])
  expect(existsSync(join(backups, names[2] ?? '', 'state.db'))).toBe(true)
})

test('test_h1_backups_symlink_to_a_foreign_directory_loses_nothing_but_old_snapshots', () => {
  const target = join(scratch, 'external')
  mkdirSync(join(target, 'Documents'), { recursive: true })
  mkdirSync(join(target, 'projects', 'app'), { recursive: true })
  writeFileSync(join(target, 'Documents', 'letter.txt'), 'letter-content')
  writeFileSync(join(target, 'projects', 'app', 'main.ts'), 'main-content')
  symlinkSync(target, join(home, 'backups'))

  const names = takeSnapshots(2, 1)

  expect(readFileSync(join(target, 'Documents', 'letter.txt'), 'utf8')).toBe('letter-content')
  expect(readFileSync(join(target, 'projects', 'app', 'main.ts'), 'utf8')).toBe('main-content')
  const snapshots = readdirSync(target).filter((name) => SNAPSHOT_NAME.test(name))
  expect(snapshots).toEqual([names[1]])
  expect(existsSync(join(target, names[1] ?? '', 'state.db'))).toBe(true)
})

test('test_h1_last_snapshot_ignores_directories_that_are_not_snapshots', () => {
  const backups = join(home, 'backups')
  const names = takeSnapshots(1, 3)
  mkdirSync(join(backups, 'keep-me'), { recursive: true })
  writeFileSync(join(backups, 'keep-me', 'precious.txt'), 'keep-me-content')
  mkdirSync(join(backups, 'zzz-notes'), { recursive: true })

  const last = lastSnapshot(home)
  expect(last?.name).toBe(names[0])

  rmSync(join(backups, names[0] ?? ''), { recursive: true, force: true })
  expect(lastSnapshot(home)).toBeUndefined()
})
