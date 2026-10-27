import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { createRecallIndex, createRecallTool } from './src/index.js'

const TEXT = ['# Заметки', 'кофе в café на углу', 'просто строка', 'переменная foo_bar в коде', 'конец'].join('\n')

function workspaceIndex() {
  const index = createRecallIndex(new DatabaseSync(':memory:'))
  index.index({ id: 'workspace:notes/test.md', source: 'notes/test.md', kind: 'workspace', text: TEXT, ts: 1_700_000_000_000 })
  return index
}

test('workspace hit found through diacritics folding carries its line', () => {
  const [hit] = workspaceIndex().search('cafe')
  expect(hit).toMatchObject({ source: 'notes/test.md', kind: 'workspace', lines: { start: 2, end: 2 } })
})

test('workspace hit found through an underscore-separated token carries its line', () => {
  const index = workspaceIndex()
  expect(index.search('foo')[0]?.lines).toEqual({ start: 4, end: 4 })
  expect(index.search('bar')[0]?.lines).toEqual({ start: 4, end: 4 })
  expect(index.search('foo_bar')[0]?.lines).toEqual({ start: 4, end: 4 })
})

test('line range spans every matched line, including CRLF text and a phrase across lines', () => {
  const index = createRecallIndex(new DatabaseSync(':memory:'))
  index.index({ id: 'w:a', source: 'a.txt', kind: 'workspace', text: 'x\r\nalpha\r\ny\r\nÁLPHA\r\nz', ts: 1 })
  index.index({ id: 'w:b', source: 'b.txt', kind: 'workspace', text: 'one\nfoo\nbar\ntwo', ts: 2 })
  expect(index.search('alpha')[0]?.lines).toEqual({ start: 2, end: 4 })
  expect(index.search('foo_bar')[0]?.lines).toEqual({ start: 2, end: 3 })
})

test('recall tool prints the line range for diacritic and underscore matches', async () => {
  const tool = createRecallTool(workspaceIndex())
  expect(await tool.execute({ query: 'cafe' })).toContain('notes/test.md:2-2')
  expect(await tool.execute({ query: 'foo' })).toContain('notes/test.md:4-4')
})

test('non-workspace hits stay without lines', () => {
  const index = createRecallIndex(new DatabaseSync(':memory:'))
  index.index({ id: 'chat-1', source: 'owner', kind: 'chat', text: 'café foo_bar', ts: 1 })
  expect(index.search('cafe')[0]?.lines).toBeUndefined()
})
