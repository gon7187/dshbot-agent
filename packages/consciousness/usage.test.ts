import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import {
  collectSessionUsage,
  countSessionEvents,
  createWakeUsageStore,
  readSessionUsage,
  WAKE_USAGE_LABEL,
} from './src/index.js'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function sessionLog(lines: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'wake-usage-'))
  scratch.push(dir)
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8')
  return file
}

// The durable event of the runner: the step's usage travels inside `data`.
const assistant = (input: number, output: number, cacheRead = 0): unknown => ({
  type: 'assistant/message',
  data: {
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
  },
})

test('only assistant messages after the baseline are read as usage', () => {
  const file = sessionLog([
    { type: 'turn/start' },
    assistant(100, 10, 5),
    { type: 'tool/call', name: 'exec' },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } },
    assistant(200, 20),
  ])
  expect(countSessionEvents(file)).toBe(5)
  expect(readSessionUsage(file, 0)).toEqual([
    { inputTokens: 100, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 10 },
    { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
  ])
  expect(readSessionUsage(file, 3)).toEqual([
    { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
  ])
  expect(readSessionUsage(file, 5)).toEqual([])
})

test('a missing or torn log is not an error and yields no rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-usage-'))
  scratch.push(dir)
  const missing = join(dir, 'missing.jsonl')
  expect(countSessionEvents(missing)).toBe(0)
  expect(readSessionUsage(missing, 0)).toEqual([])
  expect(await collectSessionUsage(missing, 0)).toEqual([])

  const torn = join(dir, 'torn.jsonl')
  writeFileSync(
    torn,
    '{"type":"assistant/message","data":{"usage":{"inputTokens":1,"outputTokens":2}}}\n{broken',
    'utf8',
  )
  expect(readSessionUsage(torn, 0)).toEqual([
    { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
  ])
})

test('collectSessionUsage sees a log written just after the turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-usage-'))
  scratch.push(dir)
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, '', 'utf8')
  const pending = collectSessionUsage(file, 0)
  writeFileSync(file, `${JSON.stringify(assistant(7, 3))}\n`, 'utf8')
  expect(await pending).toEqual([{ inputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 }])
})

test('the wake ledger keeps one labelled row per model call with no cap', () => {
  const db = new DatabaseSync(':memory:')
  const store = {
    db,
    migrate: (_namespace: string, steps: readonly string[]) => {
      for (const step of steps) db.exec(step)
    },
  }
  const usage = createWakeUsageStore(store)
  const rows = Array.from({ length: 25 }, () => ({
    inputTokens: 1000,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 50,
  }))
  usage.record(rows, { at: 1_700_000_000_000 })
  const stored = usage.rows()
  expect(stored).toHaveLength(25)
  for (const row of stored) {
    expect(row.label).toBe(WAKE_USAGE_LABEL)
    expect(row.sessionId).toBe('main')
    expect(row.at).toBe(1_700_000_000_000)
  }
  expect(usage.rows().reduce((sum, row) => sum + row.outputTokens, 0)).toBe(25 * 50)
  db.close()
})

test('the ledger rejects malformed numbers instead of storing a hole', () => {
  const db = new DatabaseSync(':memory:')
  const store = {
    db,
    migrate: (_namespace: string, steps: readonly string[]) => {
      for (const step of steps) db.exec(step)
    },
  }
  const usage = createWakeUsageStore(store)
  expect(() =>
    usage.record([{ inputTokens: -1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }]),
  ).toThrow()
  expect(usage.rows()).toEqual([])
  db.close()
})
