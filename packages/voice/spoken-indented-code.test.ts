import { expect, test } from 'vitest'

import { prepareSpokenText } from './src/spoken-text.js'

// Indented code blocks (four spaces or a tab after a blank line or at the start of the text) stay in the written
// answer but are never read aloud, exactly like fenced blocks.

test('test_h1_indented_code_block_after_a_blank_line_is_not_spoken', () => {
  const spoken = prepareSpokenText('До кода.\n\n    print("CODEMARKER")\n\nПосле кода.')
  expect(spoken).toContain('До кода.')
  expect(spoken).toContain('После кода.')
  expect(spoken).not.toContain('CODEMARKER')
  expect(spoken).not.toContain('print')
})

test('test_h1_tab_indented_multi_line_code_block_is_not_spoken', () => {
  const spoken = prepareSpokenText('До кода.\n\n\tfirst = "CODEMARKER"\n\tsecond = first\n\nПосле кода.')
  expect(spoken).toContain('До кода.')
  expect(spoken).toContain('После кода.')
  expect(spoken).not.toContain('CODEMARKER')
  expect(spoken).not.toContain('second')
})

test('test_h1_indented_code_block_at_the_start_of_the_text_is_not_spoken', () => {
  const spoken = prepareSpokenText('    print("CODEMARKER")\n    other()\n\nПосле кода.')
  expect(spoken).toContain('После кода.')
  expect(spoken).not.toContain('CODEMARKER')
  expect(spoken).not.toContain('other')
})
