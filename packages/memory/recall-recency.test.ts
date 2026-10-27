import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { createRecallIndex, createRecallTool, type RecallDocument } from './src/index.js'

const DAY_MS = 86_400_000

function freshIndex() {
  return createRecallIndex(new DatabaseSync(':memory:'))
}

function doc(id: string, kind: RecallDocument['kind'], text: string, ts: number): RecallDocument {
  return { id, source: `${kind}/${id}`, kind, text, ts }
}

test('test_c6_the_fresher_of_two_equal_documents_is_higher_whatever_the_order_of_indexing', () => {
  const now = Date.now()
  const old = doc('old-note', 'journal', 'встреча с поставщиком про оплату договора', now - 30 * DAY_MS)
  const fresh = doc('fresh-note', 'journal', 'встреча с поставщиком про оплату договора', now)

  for (const order of [[old, fresh], [fresh, old]]) {
    const index = freshIndex()
    for (const item of order) index.index(item)
    expect(index.search('поставщиком оплату договора').map((hit) => hit.id)).toEqual(['fresh-note', 'old-note'])
  }
})

test('test_c6_thirty_days_of_age_outweigh_a_slightly_better_text_match', () => {
  const now = Date.now()
  // the old note is a hair shorter, so on text alone it would win; the new one is a month fresher
  const base = 'встреча с поставщиком про оплату договора и сроки поставки прошла хорошо, остальное по плану на неделю вперёд'
  const old = doc('old-note', 'journal', base, now - 30 * DAY_MS)
  const fresh = doc('fresh-note', 'journal', `${base} ещё`, now)

  for (const order of [[old, fresh], [fresh, old]]) {
    const index = freshIndex()
    for (const item of order) index.index(item)
    expect(index.search('поставщиком оплату договора сроки поставки').map((hit) => hit.id)).toEqual(['fresh-note', 'old-note'])
  }
})

test('test_c6_the_recall_tool_lists_the_fresher_document_first', async () => {
  const now = Date.now()
  const index = freshIndex()
  index.index(doc('old-note', 'journal', 'созвон про бюджет и сроки релиза', now - 30 * DAY_MS))
  index.index(doc('fresh-note', 'journal', 'созвон про бюджет и сроки релиза', now))

  const result = String(await createRecallTool(index).execute({ query: 'бюджет сроки релиза' }))
  const fresh = result.indexOf('journal/fresh-note')
  const old = result.indexOf('journal/old-note')
  expect(fresh, result).toBeGreaterThanOrEqual(0)
  expect(old, result).toBeGreaterThanOrEqual(0)
  expect(fresh, `the fresher document is listed first\n${result}`).toBeLessThan(old)
})

test('test_c6_a_schedule_document_stays_below_the_journal_at_equal_text_and_time', async () => {
  const now = Date.now()
  const text = 'отчёт по серверам: диски в норме, нагрузка низкая'
  for (const order of [['journal', 'schedule'], ['schedule', 'journal']] as const) {
    const index = freshIndex()
    for (const kind of order) index.index(doc(`${kind}-doc`, kind, text, now))
    expect(index.search('отчёт серверам нагрузка').map((hit) => hit.kind)).toEqual(['journal', 'schedule'])

    const result = String(await createRecallTool(index).execute({ query: 'отчёт серверам нагрузка' }))
    expect(result.indexOf('journal/journal-doc'), result).toBeLessThan(result.indexOf('schedule/schedule-doc'))
  }
})
