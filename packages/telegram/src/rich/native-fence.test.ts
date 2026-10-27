import { expect, test } from 'vitest'

import { RICH_BLOCK_LIMIT, RICH_CHAR_LIMIT, normalizeMarkdownHardBreaks, splitMarkdown } from './native.js'

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index)

test('test_h1_закрывает_блок_кода_только_строка_fence_без_постороннего_текста', () => {
  // Строка с текстом после fence — содержимое кода, а не закрытие.
  const fake = '```\na\n```not-a-closing-fence\nb\nc\n```\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(fake)).toBe('```\na\n```not-a-closing-fence\nb\nc\n```\nпосле  \nещё')

  // Строка с info string внутри открытого блока тоже не закрывает.
  const info = '```\na\n```js\nb\nc\n```'
  expect(normalizeMarkdownHardBreaks(info)).toBe(info)

  // Закрывающий fence допускает пробелы после себя.
  const spaced = '```\na\n```   \nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(spaced)).toBe('```\na\n```   \nпосле  \nещё')
})

test('test_h1_закрывающий_fence_с_отступом_больше_3_пробелов_остаётся_кодом', () => {
  const text = '```\na\n    ```\nb\nc\n```'
  expect(normalizeMarkdownHardBreaks(text)).toBe(text)
  const indented = '```\na\n   ```\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(indented)).toBe('```\na\n   ```\nпосле  \nещё')
})

test('test_h1_fence_из_тильд_закрывается_тильдами_не_короче_открывающего', () => {
  // Обратные апострофы не закрывают блок из тильд.
  const wrongChar = '~~~\na\n```\nb\nc\n~~~'
  expect(normalizeMarkdownHardBreaks(wrongChar)).toBe(wrongChar)
  // Короче открывающего — не закрывает.
  const shorter = '~~~~\na\n~~~\nb\nc\n~~~~'
  expect(normalizeMarkdownHardBreaks(shorter)).toBe(shorter)
  // Текст после тильд — содержимое.
  const fake = '~~~\na\n~~~not-a-closing-fence\nb\nc\n~~~'
  expect(normalizeMarkdownHardBreaks(fake)).toBe(fake)
  // Длиннее открывающего — закрывает.
  const longer = '~~~\na\n~~~~~\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(longer)).toBe('~~~\na\n~~~~~\nпосле  \nещё')
  // Обычное закрытие.
  const plain = '~~~\na\n~~~\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(plain)).toBe('~~~\na\n~~~\nпосле  \nещё')
})

test('test_h1_закрывающий_fence_длиннее_открывающего_закрывает_блок', () => {
  const text = '```\na\n`````\nпосле\nещё'
  expect(normalizeMarkdownHardBreaks(text)).toBe('```\na\n`````\nпосле  \nещё')
  const shorter = '````\na\n```\nb\nc\n````'
  expect(normalizeMarkdownHardBreaks(shorter)).toBe(shorter)
})

test('test_h1_split_строка_с_текстом_после_fence_не_закрывает_блок_кода', () => {
  const text = '```\na\n```not-a-closing-fence\nb\nc\n```'
  // Это один блок кода: даже при лимите в один блок он остаётся одной частью.
  expect(splitMarkdown(text, { maxBlocks: 1 })).toEqual([text])
  const tilde = '~~~\na\n~~~not-a-closing-fence\nb\nc\n~~~'
  expect(splitMarkdown(tilde, { maxBlocks: 1 })).toEqual([tilde])
})

function codeBlocksIn(part: string): string[] {
  return part.split('\n').filter((line) => /^c\d+$/.test(line))
}

const variants: Array<[string, (index: number) => string]> = [
  ['обратные апострофы', (index) => `\`\`\`\nc${index}\n\`\`\``],
  ['тильды', (index) => `~~~\nc${index}\n~~~`],
  ['закрывающий fence длиннее открывающего', (index) => `\`\`\`\nc${index}\n\`\`\`\`\``],
]

for (const [name, block] of variants) {
  test(`test_h1_600_блоков_кода_через_одиночные_переносы_делятся_на_части_до_500_блоков: ${name}`, () => {
    const blocks = range(600).map(block)
    const text = blocks.join('\n')
    expect(text.length).toBeLessThan(RICH_CHAR_LIMIT)

    const parts = splitMarkdown(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(RICH_CHAR_LIMIT)
      expect(codeBlocksIn(part).length).toBeLessThanOrEqual(RICH_BLOCK_LIMIT)
    }
    // Ни один блок не потерян и не задвоен, порядок сохранён.
    expect(parts.flatMap(codeBlocksIn)).toEqual(range(600).map((index) => `c${index}`))
  })
}

test('test_h1_соседние_блоки_кода_отдельные_блоки_при_малом_maxBlocks', () => {
  const text = range(7)
    .map((index) => `\`\`\`\nc${index}\n\`\`\``)
    .join('\n')
  const parts = splitMarkdown(text, { maxBlocks: 3 })
  expect(parts.length).toBe(3)
  for (const part of parts) expect(codeBlocksIn(part).length).toBeLessThanOrEqual(3)
  expect(parts.flatMap(codeBlocksIn)).toEqual(range(7).map((index) => `c${index}`))
})
