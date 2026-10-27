import { expect, test } from 'vitest'

import { numberToRussianWords, russianToPhonemes } from './src/russian-phonemes.js'
import { parseTokenTable, piperGenerateRequest, piperTtsConfig, tokenTableProblem } from './src/tts-config.js'

// The real synthesis path without the stand-in: sherpa-onnx 2.0.0 speaks a
// Piper voice only from `generationConfig.phonemeCodepoints`, so the request
// must carry Russian phonemes that the voice's token table knows.

const PIPER_SYMBOLS = [
  '_', '^', '$', ' ', '!', "'", '(', ')', ',', '-', '.', ':', ';', '?',
  ...'abcdefghijklmnopqrstuvwxyz',
  'ɐ', 'ə', 'ɛ', 'ɨ', 'ɪ', 'ɕ', 'ʂ', 'ʊ', 'ʐ', 'ʲ', 'ˈ', 'ˌ', 'ː',
]
const TOKENS_TXT = `${PIPER_SYMBOLS.map((symbol, id) => `${symbol} ${id}`).join('\n')}\n`

test('test_token_table_is_parsed_with_a_space_symbol', () => {
  const table = parseTokenTable(TOKENS_TXT)
  expect(table.get(' ')).toBe(3)
  expect(table.get('ʲ')).toBe(PIPER_SYMBOLS.indexOf('ʲ'))
  expect(tokenTableProblem(table)).toBeUndefined()
  expect(tokenTableProblem(parseTokenTable('a 0\nb 1\n'))).toContain('_')
  const withoutSoftness = parseTokenTable(TOKENS_TXT.replace(/^ʲ \d+\n/m, ''))
  expect(tokenTableProblem(withoutSoftness)).toContain('ʲ')
})

test('test_piper_config_has_model_and_tokens_and_request_has_phoneme_codepoints', () => {
  const config = piperTtsConfig({ model: '/m/ru_RU-irina-medium.onnx', tokens: '/m/tokens.txt' })
  expect(config).toMatchObject({
    model: { vits: { model: '/m/ru_RU-irina-medium.onnx', tokens: '/m/tokens.txt' }, provider: 'cpu' },
  })
  const request = piperGenerateRequest('Привет! Как дела?', parseTokenTable(TOKENS_TXT))
  const sentences = request.generationConfig.phonemeCodepoints.map((codepoints) => String.fromCodePoint(...codepoints))
  expect(sentences).toEqual(['prʲivʲet!', 'kˈak dʲela?'])
  expect(request.text).toBe('Привет! Как дела?')
})

test('test_piper_request_drops_symbols_missing_from_the_table', () => {
  const table = parseTokenTable(TOKENS_TXT.replace(/^ɕ \d+\n/m, ''))
  const request = piperGenerateRequest('Щука.', table)
  for (const codepoints of request.generationConfig.phonemeCodepoints) {
    for (const codepoint of codepoints) expect(table.has(String.fromCodePoint(codepoint))).toBe(true)
  }
  expect(() => piperGenerateRequest('... !!!', table)).toThrow(/произнести/)
})

test('test_russian_phonemes_follow_espeak_rules', () => {
  expect(russianToPhonemes('ёлка')).toEqual(['ˈjolka.'])
  expect(russianToPhonemes('жизнь')).toEqual(['ʐˈɨznʲ.'])
  expect(russianToPhonemes('сад, его')).toEqual(['sˈat, jevo.'])
  expect(russianToPhonemes('сделать')).toEqual(['zdʲelatʲ.'])
  expect(russianToPhonemes('за́мок')).toEqual(['zˈamok.'])
  expect(russianToPhonemes('файл в Telegram')).toEqual(['fˈajl f telegram.'])
  expect(numberToRussianWords('21')).toBe('двадцать один')
  expect(numberToRussianWords('2001')).toBe('две тысячи один')
})
