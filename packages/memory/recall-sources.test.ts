import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { createRecallIndex } from './src/index.js'

test('test_c5_chat_journal_and_schedule_documents_are_searched_as_before', () => {
  const index = createRecallIndex(new DatabaseSync(':memory:'))
  index.index({ id: 'chat-1', source: 'owner', kind: 'chat', text: 'обсудили хостинг chatuniqueone', ts: 1_700_000_000_000 })
  index.index({ id: 'journal-1', source: 'journal/2026-01-05.md', kind: 'journal', text: 'запись journaluniqueone', ts: 1_700_000_100_000 })
  index.index({ id: 'schedule-1', source: 'schedule/job', kind: 'schedule', text: 'отчёт scheduleuniqueone', ts: 1_700_000_200_000 })

  expect(index.search('chatuniqueone')[0]).toMatchObject({ id: 'chat-1', source: 'owner', kind: 'chat', ts: 1_700_000_000_000 })
  expect(index.search('journaluniqueone')[0]).toMatchObject({ id: 'journal-1', source: 'journal/2026-01-05.md', kind: 'journal' })
  expect(index.search('scheduleuniqueone')[0]).toMatchObject({ id: 'schedule-1', source: 'schedule/job', kind: 'schedule' })
  expect(index.search('chatuniqueone')[0]?.snippet).toContain('chatuniqueone')
})
