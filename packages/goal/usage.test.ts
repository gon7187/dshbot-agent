import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { costOf, type TokenUsage } from '../guard/src/index.js'
import { createUsageMeter, formatGoal, JUDGE_MODEL } from './src/index.js'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function logFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'goal-usage-'))
  directories.push(directory)
  return join(directory, 'events.jsonl')
}

function event(usage: TokenUsage): string {
  return JSON.stringify({ type: 'assistant/message', data: { usage } }) + '\n'
}

test('cached usage keeps guard rates across incremental reads without counting prior events twice', () => {
  const file = logFile()
  const first: TokenUsage = { inputTokens: 25, cacheReadTokens: 100_000, cacheWriteTokens: 500, outputTokens: 20 }
  const second: TokenUsage = { inputTokens: 50, cacheReadTokens: 200_000, cacheWriteTokens: 300, outputTokens: 30 }
  writeFileSync(file, event(first))
  const meter = createUsageMeter(file)
  const initial = meter.readSince(0)
  expect(initial.usd).toBe(costOf(JUDGE_MODEL, first))
  expect(initial.inputTokens).toBe(first.inputTokens + first.cacheReadTokens + first.cacheWriteTokens)
  appendFileSync(file, event(second))
  const next = meter.readSince(initial.offset)
  expect(next.usd).toBe(costOf(JUDGE_MODEL, second))
  expect(next.outputTokens).toBe(second.outputTokens)
  expect(meter.readSince(next.offset).usd).toBe(0)
  expect(meter.readSince(0).usd).toBeCloseTo(initial.usd + next.usd, 12)
  const expensive = { inputTokens: 12, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 }
  appendFileSync(file, event(expensive))
  expect(meter.readSince(next.offset).usd).toBeGreaterThan(0.01)
  expect(meter.readSince(next.offset).usd).toBe(costOf(JUDGE_MODEL, expensive))
})
