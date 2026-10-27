// Rollback in a full snapshot store: saving the replaced content enforces the caps and drops the oldest
// snapshot, which may be the very one the owner rolls back to. The rollback must still restore it byte
// for byte and keep the replaced content as a new snapshot.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  listSnapshots,
  readSnapshots,
  rollbackSnapshot,
  snapshotCreatedFile,
  snapshotExistingFile,
  SNAPSHOT_MAX_COUNT,
} from './snapshots.js'

let scratch: string
let dir: string
let workspace: string

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-snapshots-full-')))
  dir = join(scratch, 'snapshots')
  workspace = join(scratch, 'workspace')
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fillAfter(first: number): void {
  const filler = join(workspace, 'filler.txt')
  writeFileSync(filler, 'filler')
  for (let index = first; index < SNAPSHOT_MAX_COUNT; index += 1) snapshotExistingFile(dir, filler, 'write')
  expect(readSnapshots(dir)).toHaveLength(SNAPSHOT_MAX_COUNT)
}

test('rolling back the oldest snapshot of a full store restores it byte for byte', () => {
  const target = join(workspace, 'target.bin')
  const original = Buffer.from([0, 1, 2, 255, 13, 10, 0x80, 0x41])
  writeFileSync(target, original)
  const saved = snapshotExistingFile(dir, target, 'edit')
  expect(saved.status).toBe('saved')
  if (saved.status !== 'saved') return
  fillAfter(1)
  expect(readSnapshots(dir)[0]?.id).toBe(saved.record.id)

  writeFileSync(target, 'changed by the bot')
  const result = rollbackSnapshot(dir, saved.record.id)

  expect(result.status).toBe('restored')
  expect(readFileSync(target).equals(original)).toBe(true)
  const newest = listSnapshots(dir, 1)[0]
  expect(newest?.path).toBe(target)
  expect(newest?.tool).toBe('rollback')
  expect(readSnapshots(dir)).toHaveLength(SNAPSHOT_MAX_COUNT)
  if (result.status !== 'restored' || result.current === undefined) throw new Error('no undo snapshot')
  expect(rollbackSnapshot(dir, result.current.id).status).toBe('restored')
  expect(readFileSync(target, 'utf8')).toBe('changed by the bot')
})

test('rolling back the oldest created marker of a full store deletes the file', () => {
  const target = join(workspace, 'created.txt')
  const marker = snapshotCreatedFile(dir, target, 'write')
  writeFileSync(target, 'new file of the bot')
  fillAfter(1)
  expect(readSnapshots(dir)[0]?.id).toBe(marker.id)

  const result = rollbackSnapshot(dir, marker.id)

  expect(result.status).toBe('restored')
  expect(existsSync(target)).toBe(false)
  if (result.status !== 'restored' || result.current === undefined) throw new Error('no undo snapshot')
  expect(rollbackSnapshot(dir, result.current.id).status).toBe('restored')
  expect(readFileSync(target, 'utf8')).toBe('new file of the bot')
})
