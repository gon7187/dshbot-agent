import { expect, test } from 'vitest'

import { RICH_BLOCK_LIMIT, RICH_CHAR_LIMIT, normalizeMarkdownHardBreaks, splitMarkdown } from './native.js'

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

test('таблица GFM без внешних | не получает жёстких переносов', () => {
  const tables = [
    'a | b\n--- | ---\n1 | 2',
    'a | b\n:-- | --:\n1 | 2\n3 | 4',
    'a|b\n-|-\n1|2',
    '| a |\n| --- |\n| 1 |',
  ]
  for (const table of tables) {
    expect(normalizeMarkdownHardBreaks(table)).toBe(table)
    const text = `до\nстрока\n\n${table}\n\nпосле\nещё`
    const markdown = normalizeMarkdownHardBreaks(text)
    expect(markdown).toContain(`\n\n${table}\n\n`)
    expect(markdown).toMatch(/^до {2}\nстрока\n/)
    expect(markdown).toMatch(/после {2}\nещё$/)
  }
})

test('строки с | без строки-разделителя остаются обычным абзацем', () => {
  expect(normalizeMarkdownHardBreaks('x | y\nz')).toBe('x | y  \nz')
  // Разное число колонок у заголовка и разделителя — не таблица.
  expect(normalizeMarkdownHardBreaks('a | b | c\n--- | ---\nтекст')).toBe('a | b | c  \n--- | ---  \nтекст')
})

test('цитата из 501 длинной строки режется на части в пределах 32768 символов и 500 блоков', () => {
  const lines = range(501).map((index) => `> q${String(index).padStart(3, '0')} ${'x'.repeat(100)}`)
  const parts = splitMarkdown(lines.join('\n'))
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(RICH_CHAR_LIMIT)
    const partLines = part.split('\n')
    expect(partLines.length).toBeLessThanOrEqual(RICH_BLOCK_LIMIT)
    for (const line of partLines) expect(line).toMatch(/^> q\d{3} x{100}$/)
  }
  expect(parts.join('\n').split('\n')).toEqual(lines)
})

test('таблица без внешних | из 1200 строк режется по строкам не больше чем на 500 блоков', () => {
  const header = ['id | значение', '--- | ---']
  const rows = range(1200).map((index) => `r${index} | значение`)
  const parts = splitMarkdown([...header, ...rows].join('\n'))
  expect(parts.length).toBeGreaterThan(2)
  const seen: string[] = []
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(RICH_CHAR_LIMIT)
    const partLines = part.split('\n')
    expect(partLines.length).toBeLessThanOrEqual(RICH_BLOCK_LIMIT)
    expect(partLines.slice(0, 2)).toEqual(header)
    for (const line of partLines.slice(2)) expect(line).toMatch(/^r\d+ \| значение$/)
    seen.push(...partLines.slice(2))
  }
  expect(seen).toEqual(rows)
})

test('ни одна часть не превышает лимит символов, даже если строка длиннее лимита', () => {
  const long = 'y'.repeat(RICH_CHAR_LIMIT * 2 + 10)
  const inputs = [`> ${long}`, long, `- ${long}`, `a | b\n--- | ---\n${long} | 1`]
  for (const input of inputs) {
    const parts = splitMarkdown(input)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(RICH_CHAR_LIMIT)
    expect(parts.join('').replace(/[^y]/g, '').length).toBe(long.length)
  }
  // Продолжения длинной строки цитаты остаются цитатой.
  for (const part of splitMarkdown(`> ${long}`)) expect(part.startsWith('> ')).toBe(true)
})

test('test_h1_fence_из_тильд_закрывается_только_тильдами_не_короче_открывающего', () => {
  // Строка с текстом после тильд — содержимое, обратные апострофы не закрывают.
  const text = '~~~\na\n~~~not-a-closing-fence\nb\n```\nc\n~~~~'
  expect(normalizeMarkdownHardBreaks(text)).toBe(text)
  expect(splitMarkdown(text, { maxBlocks: 1 })).toEqual([text])
})

test('test_h1_закрывающий_fence_длиннее_открывающего_закрывает_блок_кода', () => {
  const text = '````\na\n`````\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(text)).toBe('````\na\n`````\nпосле  \nещё')
  // Блок остаётся одним unit, а не склеивается со следующим за ним.
  const blocks = range(3)
    .map((index) => `\`\`\`\nc${index}\n\`\`\`\`\``)
    .join('\n')
  const parts = splitMarkdown(blocks, { maxBlocks: 1 })
  expect(parts).toHaveLength(3)
  expect(parts.join('\n').match(/^c\d$/gm)).toEqual(['c0', 'c1', 'c2'])
})
