import { expect, test } from 'vitest'
import { chunkText } from './html.js'

// Regression: a single long token must retain its formatting on every part.
test.each([
  ['<b>', '</b>'],
  ['<b><i>', '</i></b>'],
  ['<a href="https://e.x"><b>', '</b></a>'],
])('long text carries %s across boundaries', (open, close) => {
  const text = 'x'.repeat(100)
  const parts = chunkText(open + text + close, 60)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(60)
    expect(part.startsWith(open)).toBe(true)
    expect(part.endsWith(close)).toBe(true)
    const stack: string[] = []
    for (const tag of part.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
      if (tag[1]) expect(stack.pop()).toBe(tag[2])
      else stack.push(tag[2])
    }
    expect(stack).toEqual([])
  }
  expect(parts.map((part) => part.replace(/<[^>]*>/g, '')).join('')).toBe(text)
})

test('formatting degrades only when wrappers leave no room for text', () => {
  const parts = chunkText('<b><i>xxxxxxxxxx</i></b>', 7)
  expect(parts.every((part) => part.length <= 7)).toBe(true)
  expect(parts.map((part) => part.replace(/<[^>]*>/g, '')).join('')).toBe('xxxxxxxxxx')
})
