import { expect, test } from 'vitest'

import {
  closestLazyNames,
  lazyQueryTokens,
  lazyWordStem,
  rankLazyCandidates,
  type LazySearchCandidate,
} from './src/lazy-search-hint.js'

const TOOLS: LazySearchCandidate[] = [
  {
    name: 'mcp__homeassistant__intent__HassTurnOn',
    description: 'Turns on/opens/presses a device or entity. Use for requests like turn on a light.',
  },
  {
    name: 'mcp__homeassistant__light__HassLightSet',
    description: 'Sets the brightness percentage or color of a light',
  },
  { name: 'mail', description: 'Почта владельца: list/read/save_attachment/checkpoint' },
  { name: 'session_search', description: 'Find fragments of the past conversations of the owner' },
]

test('test_query_words_are_case_folded_and_one_line', () => {
  expect(lazyQueryTokens('  HomeAssistant   LIGHT\nкухня ')).toEqual(['homeassistant', 'light', 'кухня'])
  expect(lazyQueryTokens('   ')).toEqual([])
})

test('test_closest_lazy_names_rank_by_the_number_of_shared_words', () => {
  // The query that started this: a full sentence of words, none of which occur together.
  expect(closestLazyNames(TOOLS, 'homeassistant light brightness', 5)).toEqual([
    'mcp__homeassistant__light__HassLightSet',
    'mcp__homeassistant__intent__HassTurnOn',
  ])
})

test('test_closest_lazy_names_ignore_a_query_with_no_shared_word', () => {
  expect(closestLazyNames(TOOLS, 'погода на завтра', 5)).toEqual([])
  expect(closestLazyNames(TOOLS, '', 5)).toEqual([])
  expect(closestLazyNames(TOOLS, 'mail', 0)).toEqual([])
})

test('test_closest_lazy_names_respect_the_limit_and_break_ties_by_name', () => {
  const twins: LazySearchCandidate[] = [
    { name: 'b_twin', description: 'общий текст' },
    { name: 'a_twin', description: 'общий текст' },
  ]
  expect(closestLazyNames(twins, 'общий', 2)).toEqual(['a_twin', 'b_twin'])
  expect(closestLazyNames(twins, 'общий', 1)).toEqual(['a_twin'])
})

test('test_rank_lazy_candidates_matches_word_endings_but_not_a_common_prefix', () => {
  const tools: LazySearchCandidate[] = [
    { name: 'stats_tool', description: 'Статистика рекламных кампаний за период' },
    { name: 'wb_get_campaign_stats', description: 'Returns advertising totals' },
    { name: 'warehouse_load', description: 'Погрузка товара на склад' },
  ]
  const scored = (query: string) =>
    rankLazyCandidates(tools, query, 5).map((entry) => ({ name: entry.candidate.name, hits: entry.hits }))
  // "кампании" meets "кампаний" in the description.
  expect(scored('кампании статистика')).toEqual([{ name: 'stats_tool', hits: 2 }])
  // "campaigns" meets the "campaign" word of the name.
  expect(scored('campaigns')).toEqual([{ name: 'wb_get_campaign_stats', hits: 1 }])
  // "погода" and "Погрузка" only share a prefix and stay unrelated.
  expect(scored('погода')).toEqual([])
})

test('test_english_words_ending_in_e_match_their_plural_and_short_words_stay_whole', () => {
  // h1: the singular loses the Latin "e" the same way the plural loses "es".
  expect(lazyWordStem('message')).toBe(lazyWordStem('messages'))
  expect(lazyWordStem('update')).toBe(lazyWordStem('updates'))
  expect(lazyWordStem('file')).toBe(lazyWordStem('files'))
  // Short words are not cut down to a two-letter stem that would match noise.
  expect(lazyWordStem('the')).toBe('the')
  expect(lazyWordStem('one')).toBe('one')
})

test('test_rank_lazy_candidates_meets_plural_and_singular_forms', () => {
  const tools: LazySearchCandidate[] = [
    { name: 'file_writer', description: 'Write a file' },
    { name: 'message_editor', description: 'Edit a sent message' },
  ]
  expect(closestLazyNames(tools, 'write files', 5)).toEqual(['file_writer'])
  expect(closestLazyNames(tools, 'edit messages', 5)).toEqual(['message_editor'])
})

test('test_rank_lazy_candidates_keeps_a_qualified_tool_name_whole', () => {
  const tools: LazySearchCandidate[] = [
    { name: 'mcp__testsrv__echo', description: 'Echoes the given text' },
    { name: 'weather_now', description: 'Текущая погода' },
  ]
  expect(closestLazyNames(tools, 'mcp__testsrv__echo', 5)).toEqual(['mcp__testsrv__echo'])
  // Another server's name shares the `mcp` prefix and the `echo` word, not the tool.
  expect(closestLazyNames(tools, 'mcp__shadow__echo', 5)).toEqual([])
})
