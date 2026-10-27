import { expect, test } from 'vitest'

import { prepareSpokenText, SPEECH_TEXT_LIMIT } from './src/spoken-text.js'

// What is read aloud: code, tables and links stay in the written answer but
// never reach the synthesizer; a long answer is spoken from its beginning only.

test('test_spoken_text_drops_code_tables_and_links', () => {
  const answer = [
    'Вступление про погоду.',
    '',
    '```python',
    'print("CODEMARKER")',
    '```',
    '',
    '| город | градусы |',
    '|-------|---------|',
    '| Москва | TABLEMARKER |',
    '',
    'Подробности на https://example.com/URLMARKER?q=1 сегодня.',
    'Ещё [документация](https://example.org/LINKMARKER) рядом.',
  ].join('\n')
  const spoken = prepareSpokenText(answer)
  expect(spoken).toContain('Вступление про погоду.')
  expect(spoken).toContain('сегодня')
  expect(spoken).toContain('документация')
  for (const forbidden of ['CODEMARKER', 'TABLEMARKER', 'URLMARKER', 'LINKMARKER', 'http', '```', '|', 'print(']) {
    expect(spoken, `${forbidden} is not spoken`).not.toContain(forbidden)
  }
})

test('test_spoken_text_cuts_a_long_answer_at_a_sentence_within_the_limit', () => {
  const sentences = Array.from({ length: 40 }, (_, index) => `Предложение номер ${index} про погоду.`)
  const answer = `Начало ответа. ${sentences.join(' ')}`
  const spoken = prepareSpokenText(answer)
  expect(spoken.length).toBeLessThanOrEqual(SPEECH_TEXT_LIMIT)
  expect(spoken.length).toBeGreaterThan(400)
  expect(answer.startsWith(spoken), 'the beginning is spoken').toBe(true)
  expect(spoken.endsWith('.')).toBe(true)
  expect(spoken.length).toBeLessThan(answer.length)
})

test('test_spoken_text_is_unchanged_when_it_is_short', () => {
  expect(prepareSpokenText('Привет, это короткий ответ.')).toBe('Привет, это короткий ответ.')
})

test('test_spoken_text_drops_tilde_fenced_code', () => {
  const answer = ['Код ниже.', '~~~python', 'print(123)', '~~~', 'После кода.', '````', '```', 'INNERMARK', '````', 'Конец.'].join(
    '\n',
  )
  const spoken = prepareSpokenText(answer)
  expect(spoken).toBe('Код ниже. После кода. Конец.')
  for (const forbidden of ['print', '123', '~', 'INNERMARK', '`']) {
    expect(spoken, `${forbidden} is not spoken`).not.toContain(forbidden)
  }
  expect(prepareSpokenText('Вступление.\n~~~\nunclosed CODEMARK')).toBe('Вступление.')
})

test('test_spoken_text_is_empty_without_a_sentence_end_within_the_limit', () => {
  const longSentence = `${Array.from({ length: 120 }, (_, index) => `слово${index}`).join(' ')}.`
  expect(longSentence.length).toBeGreaterThan(SPEECH_TEXT_LIMIT)
  expect(prepareSpokenText(longSentence)).toBe('')
  expect(prepareSpokenText(`${longSentence} Второе предложение.`)).toBe('')
})

test('test_spoken_text_drops_indented_code', () => {
  const spoken = prepareSpokenText('До кода.\n\n    print("CODEMARKER")\n\nПосле кода.')
  expect(spoken).toBe('До кода. После кода.')
  for (const forbidden of ['CODEMARKER', 'print']) {
    expect(spoken, `${forbidden} is not spoken`).not.toContain(forbidden)
  }

  // A paragraph continued with an indented line is prose, not code.
  expect(prepareSpokenText('Первая строка\n    продолжение абзаца.')).toBe('Первая строка продолжение абзаца.')

  // Fenced and indented code in one answer, followed by a long tail cut at a sentence.
  const tail = Array.from({ length: 40 }, (_, index) => `Предложение номер ${index} про погоду.`).join(' ')
  const mixed = prepareSpokenText(
    ['Вступление.', '', '\tsecret = "TABMARKER"', '', '```', 'FENCEMARKER', '```', '', tail].join('\n'),
  )
  expect(mixed.startsWith('Вступление. Предложение номер 0 про погоду.')).toBe(true)
  expect(mixed.length).toBeLessThanOrEqual(SPEECH_TEXT_LIMIT)
  expect(mixed.endsWith('.')).toBe(true)
  for (const forbidden of ['TABMARKER', 'secret', 'FENCEMARKER', '`']) {
    expect(mixed, `${forbidden} is not spoken`).not.toContain(forbidden)
  }
})
