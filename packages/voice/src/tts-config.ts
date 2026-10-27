// The sherpa-onnx configuration and request of one spoken answer.
//
// sherpa-onnx 2.0.0 has no built-in phonemizer: a Piper voice without a
// lexicon fails with «phoneme_codepoints is empty, no lexicon, and no frontend
// available». The text is therefore phonemized here and handed over as
// `generationConfig.phonemeCodepoints`, one array per sentence, keeping only
// the symbols the voice's token table knows.

import { VoiceError } from './model.js'
import { russianToPhonemes } from './russian-phonemes.js'
import type { TtsModelPaths } from './tts-model.js'

/** Symbols of the Piper table that must sit at their fixed ids. */
const PINNED_TOKENS: readonly [string, number][] = [
  ['_', 0],
  ['^', 1],
  ['$', 2],
  [' ', 3],
]

/** Phonemes the Russian rules write; a table without them cannot speak Russian. */
export const RUSSIAN_PHONEME_SYMBOLS: readonly string[] = [
  'a', 'e', 'i', 'o', 'u', 'ɨ', 'ɛ', 'ʲ', 'ʂ', 'ʐ', 'ɕ', 'ː', 'ˈ', 'j', 'x', 't', 's',
]

/**
 * Parses `tokens.txt` of a sherpa-onnx Piper export: one `<symbol> <id>` per
 * line, where the symbol may itself be a space (`"  3"`).
 */
export function parseTokenTable(text: string): Map<string, number> {
  const table = new Map<string, number>()
  for (const line of text.split('\n')) {
    const trimmedEnd = line.replace(/\r$/, '')
    const space = trimmedEnd.lastIndexOf(' ')
    if (space < 1) continue
    const symbol = trimmedEnd.slice(0, space)
    const id = Number(trimmedEnd.slice(space + 1))
    if (!Number.isInteger(id) || id < 0 || [...symbol].length !== 1) continue
    if (!table.has(symbol)) table.set(symbol, id)
  }
  return table
}

/** Why a token table is not the Piper table of a Russian voice, or `undefined`. */
export function tokenTableProblem(table: ReadonlyMap<string, number>): string | undefined {
  for (const [symbol, id] of PINNED_TOKENS) {
    if (table.get(symbol) !== id) return `символ «${symbol}» должен иметь номер ${id}`
  }
  const missing = RUSSIAN_PHONEME_SYMBOLS.filter((symbol) => !table.has(symbol))
  if (missing.length > 0) return `нет фонем ${missing.join(' ')}`
  return undefined
}

/** The `OfflineTts` configuration of the pinned Piper voice. */
export function piperTtsConfig(model: TtsModelPaths): Record<string, unknown> {
  return {
    model: {
      vits: {
        model: model.model,
        tokens: model.tokens,
      },
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    maxNumSentences: 1,
  }
}

export interface PiperRequest {
  text: string
  sid: number
  speed: number
  generationConfig: {
    sid: number
    speed: number
    phonemeCodepoints: number[][]
  }
}

/**
 * The `generate` request for `text`: Russian phonemes as code points, one
 * array per sentence, without symbols missing from the voice's table.
 */
export function piperGenerateRequest(text: string, table: ReadonlyMap<string, number>): PiperRequest {
  const phonemeCodepoints: number[][] = []
  for (const sentence of russianToPhonemes(text)) {
    const symbols = [...sentence].filter((symbol) => table.has(symbol))
    if (symbols.some((symbol) => symbol !== ' ')) {
      phonemeCodepoints.push(symbols.map((symbol) => symbol.codePointAt(0) as number))
    }
  }
  if (phonemeCodepoints.length === 0) throw new VoiceError('в тексте нет слов, которые можно произнести')
  return { text, sid: 0, speed: 1.0, generationConfig: { sid: 0, speed: 1.0, phonemeCodepoints } }
}
