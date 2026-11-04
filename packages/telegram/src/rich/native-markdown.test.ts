import { expect, test } from 'vitest'
import { chunkText } from './html.js'
import { RICH_BLOCK_LIMIT, RICH_CHAR_LIMIT, splitMarkdown } from './native.js'

test('N1 bounded mixed payloads survive block, character, oversized code and HTML splits exactly once', () => {
  const lines = Array.from({ length: 501 }, (_, i) => `> ITEM-${i} ${'x'.repeat(80)}`)
  const parts = splitMarkdown(lines.join('\n'))
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(RICH_CHAR_LIMIT)
    expect(part.split('\n').length).toBeLessThanOrEqual(RICH_BLOCK_LIMIT)
  }
  expect(parts.join('\n').split('\n')).toEqual(lines)

  const long = 'y'.repeat(RICH_CHAR_LIMIT * 2 + 10)
  for (const input of [long, `\`\`\`text\n${long}\n\`\`\``]) {
    const split = splitMarkdown(input)
    expect(split.length).toBeGreaterThan(1)
    expect(split.every(part => part.length <= RICH_CHAR_LIMIT)).toBe(true)
    expect(split.join('').replace(/[^y]/g, '')).toBe(long)
  }
  const html = chunkText(`<b><i>${long}</i></b>`, 4096)
  expect(html.every(part => part.length <= 4096)).toBe(true)
  expect(html.map(part => part.replace(/<[^>]*>/g, '')).join('')).toBe(long)
})
