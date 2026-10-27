import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { readToolNotes, recordToolNote, TOOL_NOTES_LIMIT, type ToolNote } from './src/tool-notes.js'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tool-notes-'))
  file = join(dir, 'tool-notes.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const note = (tool: string, error: string, change: string): ToolNote => ({ tool, subject: '', error, change, at: 0 })

test('a replaced note becomes the newest and an overflow drops the older note instead', () => {
  recordToolNote(file, note('alpha', 'alpha fails', 'period: 90 → 30'), 1_000)
  recordToolNote(file, note('beta', 'beta fails', 'mode: bad → good'), 2_000)
  const long = `mode: ${'x'.repeat(TOOL_NOTES_LIMIT - 60)} → y`
  const kept = recordToolNote(file, note('alpha', 'alpha fails', long), 3_000)
  expect(kept.map((item) => item.tool)).toEqual(['alpha'])
  expect(kept[0]?.change).toBe(long)
  expect(readToolNotes(file).map((item) => item.tool)).toEqual(['alpha'])
})

test('a replaced note moves to the end of the list', () => {
  recordToolNote(file, note('alpha', 'alpha fails', 'period: 90 → 30'), 1_000)
  recordToolNote(file, note('beta', 'beta fails', 'mode: bad → good'), 2_000)
  const kept = recordToolNote(file, note('alpha', 'alpha fails', 'period: 90 → 45'), 3_000)
  expect(kept.map((item) => [item.tool, item.change])).toEqual([
    ['beta', 'mode: bad → good'],
    ['alpha', 'period: 90 → 45'],
  ])
})

test('an exec note replaces the same error across different programs', () => {
  recordToolNote(file, { ...note('exec', 'exit 1', 'было: cat missing, сработало: cat present'), subject: 'cat' }, 1_000)
  recordToolNote(file, note('other', 'exit 1', 'mode: bad → good'), 2_000)
  recordToolNote(file, { ...note('exec', 'exit 2', 'было: python bad.py, сработало: python good.py'), subject: 'python' }, 3_000)
  const replacement = { ...note('exec', 'exit 1', 'было: curl bad, сработало: curl good'), subject: 'curl' }
  const kept = recordToolNote(file, replacement, 4_000)
  expect(kept.map(({ tool, subject, error }) => [tool, subject, error])).toEqual([
    ['other', '', 'exit 1'],
    ['exec', 'python', 'exit 2'],
    ['exec', 'curl', 'exit 1'],
  ])
  expect(readToolNotes(file)).toEqual(kept)
  expect(kept.at(-1)?.change).toBe(replacement.change)
})

test('the oldest notes go first by the time of the last write', () => {
  for (let i = 0; i < 80; i += 1) {
    recordToolNote(file, note(`tool${i}`, `error number ${i}`, `key: old${i} → new${i}`), 1_000 + i)
  }
  const kept = readToolNotes(file)
  expect(kept.length).toBeLessThan(80)
  expect(kept.at(-1)?.tool).toBe('tool79')
  const first = Number(kept[0]?.tool.slice('tool'.length))
  expect(kept.map((item) => item.tool)).toEqual(
    Array.from({ length: 80 - first }, (_, index) => `tool${first + index}`),
  )
})
