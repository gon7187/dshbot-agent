import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('refs.lock pins every reference repo to a full sha', () => {
  const rows = readFileSync(new URL('../refs/refs.lock', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/))
  expect(rows.map((r) => r[0])).toEqual(['openclaw', 'hermes-agent', 'deepseek-harness', 'ouroboros'])
  for (const [, url, rev] of rows) {
    expect(url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/)
    expect(rev).toMatch(/^[0-9a-f]{40}$/)
  }
})
