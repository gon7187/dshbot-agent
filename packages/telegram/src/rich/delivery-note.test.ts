// Заметка о доставке: один текст на ход. Если прошлый ответ и упал в фолбэк,
// и был разрезан, оба факта обязаны быть в одной заметке — с форматом фолбэка,
// фрагментом ошибки Telegram и числом частей. Чистый rich-ответ заметки не
// оставляет вовсе.

import { expect, test } from 'vitest'
import { createDeliveryNotes, deliveryNoteOf } from './index.js'

const ERROR = "Bad Request: can't parse entities: unsupported start tag at byte offset 0"

test('test_h1_fallback_and_cut_are_one_note_with_both_facts', () => {
  const note = deliveryNoteOf({ mode: 'html', parts: 7, error: ERROR })

  expect(note, 'the note names Rich Markdown').toContain('Rich Markdown')
  expect(note, 'the note names the HTML fallback').toContain('HTML')
  expect(note, 'the note carries a fragment of the Telegram error').toMatch(/unsupported/i)
  const at = note.search(/разрезан/)
  expect(at, 'the same note says that the answer was cut').toBeGreaterThanOrEqual(0)
  expect(note.slice(at), 'the note names the number of parts').toMatch(/(?<!\d)7(?!\d)/)
  expect(note.match(/Rich Markdown/g), 'the facts come in one note, not in two').toHaveLength(1)
})

test('test_h1_plain_fallback_and_cut_share_the_same_single_note', () => {
  const note = deliveryNoteOf({ mode: 'plain', parts: 12, error: ERROR })

  expect(note).toContain('Rich Markdown')
  expect(note, 'the note names the plain text fallback').toMatch(/простой текст/i)
  expect(note).toMatch(/разрезан/)
  expect(note.match(/Rich Markdown/g)).toHaveLength(1)
})

test('test_h1_cut_without_fallback_names_only_the_parts', () => {
  const note = deliveryNoteOf({ mode: 'rich', parts: 2 })

  expect(note).toMatch(/разрезан/)
  expect(note).toContain('2 части')
  expect(note, 'a clean rich send has no fallback to report').not.toContain('Rich Markdown')
})

test('test_h1_fallback_without_cut_names_only_the_fallback', () => {
  const note = deliveryNoteOf({ mode: 'plain', parts: 1, error: ERROR })

  expect(note).toContain('Rich Markdown')
  expect(note).toMatch(/простой текст/i)
  expect(note, 'a one-message answer was not cut').not.toMatch(/разрезан/)
})

test('test_h1_clean_rich_delivery_leaves_no_note', () => {
  expect(deliveryNoteOf({ mode: 'rich', parts: 1 })).toBe('')
})

test('test_h1_fallback_with_a_cut_is_told_once_and_gone_in_the_next_turn', () => {
  const notes = createDeliveryNotes()
  notes.remember({ mode: 'html', parts: 9, error: ERROR })

  const first = notes.take()
  expect(first).toContain('Rich Markdown')
  expect(first).toContain('HTML')
  expect(first).toMatch(/разрезан/)
  expect(first.match(/Rich Markdown/g)).toHaveLength(1)

  expect(notes.take(), 'the note belongs to one turn only').toBe('')
  notes.remember({ mode: 'rich', parts: 1 })
  expect(notes.take(), 'a clean answer leaves no note').toBe('')
})

test('test_h1_a_run_of_bad_answers_after_a_told_note_stays_silent', () => {
  const notes = createDeliveryNotes()
  notes.remember({ mode: 'html', parts: 1, error: ERROR })
  expect(notes.take()).toContain('Rich Markdown')

  notes.remember({ mode: 'plain', parts: 1, error: ERROR })
  expect(notes.take(), 'the incident is not repeated until a clean answer').toBe('')

  notes.remember({ mode: 'rich', parts: 1 })
  notes.remember({ mode: 'html', parts: 1, error: ERROR })
  expect(notes.take(), 'a clean answer re-arms the note').toContain('Rich Markdown')
})
