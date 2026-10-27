// Russian text to the IPA phonemes a Piper voice was trained on.
//
// sherpa-onnx 2.0.0 no longer bundles espeak-ng: a Piper model speaks only
// what arrives as `phonemeCodepoints`. This module is a small rule-based
// grapheme-to-phoneme converter that writes the espeak-ng alphabet of the
// `ru` voice (`ʲ` for soft consonants, `ʂ ʐ ɕ tɕ ts`, `ɨ`, `ˈ` before the
// stressed vowel). Stress is known only from `ё`, an explicit acute accent or
// a one-syllable word; elsewhere vowels are spoken in full, which costs accent
// but not intelligibility. Numbers are read as Russian words.

const VOWELS = 'аеёиоуыэюя'
const IOTATED: Record<string, string> = { е: 'e', ё: 'o', ю: 'u', я: 'a' }
const PLAIN_VOWEL: Record<string, string> = { а: 'a', о: 'o', у: 'u', ы: 'ɨ', э: 'ɛ', и: 'i' }
const CONSONANT: Record<string, string> = {
  б: 'b', в: 'v', г: 'g', д: 'd', ж: 'ʐ', з: 'z', й: 'j', к: 'k', л: 'l', м: 'm', н: 'n',
  п: 'p', р: 'r', с: 's', т: 't', ф: 'f', х: 'x', ц: 'ts', ч: 'tɕ', ш: 'ʂ', щ: 'ɕː',
}
/** Consonants that never take `ʲ`: hard ж ш ц, and ч щ й that are soft by themselves. */
const NO_SOFTENING = new Set(['ж', 'ш', 'ц', 'ч', 'щ', 'й'])
const SOFTENING_VOWELS = new Set(['е', 'ё', 'и', 'ю', 'я'])
const DEVOICED: Record<string, string> = { b: 'p', v: 'f', g: 'k', d: 't', ʐ: 'ʂ', z: 's' }
const VOICED: Record<string, string> = { p: 'b', f: 'v', k: 'g', t: 'd', ʂ: 'ʐ', s: 'z' }
const STRESS_MARK = '́'

const LATIN: Record<string, string> = {
  a: 'a', b: 'b', c: 'k', d: 'd', e: 'e', f: 'f', g: 'g', h: 'x', i: 'i', j: 'dʐ', k: 'k', l: 'l', m: 'm',
  n: 'n', o: 'o', p: 'p', q: 'k', r: 'r', s: 's', t: 't', u: 'u', v: 'v', w: 'v', x: 'ks', y: 'i', z: 'z',
}

const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
]
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот']
const SCALES: [string, string, string, boolean][] = [
  ['тысяча', 'тысячи', 'тысяч', true],
  ['миллион', 'миллиона', 'миллионов', false],
  ['миллиард', 'миллиарда', 'миллиардов', false],
]

function underThousand(value: number, feminine: boolean): string[] {
  const words: string[] = []
  if (value >= 100) words.push(HUNDREDS[Math.floor(value / 100)] as string)
  const rest = value % 100
  if (rest >= 10 && rest < 20) {
    words.push(TEENS[rest - 10] as string)
  } else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)] as string)
    const one = rest % 10
    if (one > 0) words.push(feminine && one === 1 ? 'одна' : feminine && one === 2 ? 'две' : (ONES[one] as string))
  }
  return words
}

function plural(value: number, forms: [string, string, string]): string {
  const rest = value % 100
  if (rest >= 11 && rest <= 14) return forms[2]
  if (value % 10 === 1) return forms[0]
  if (value % 10 >= 2 && value % 10 <= 4) return forms[1]
  return forms[2]
}

/** A non-negative integer in Russian words; long digit runs are read digit by digit. */
export function numberToRussianWords(digits: string): string {
  if (digits.length > 12 || (digits.length > 1 && digits.startsWith('0'))) {
    return [...digits].map((digit) => ONES[Number(digit)]).join(' ')
  }
  let value = Number(digits)
  if (value === 0) return ONES[0] as string
  const words: string[] = []
  const groups: number[] = []
  while (value > 0) {
    groups.push(value % 1000)
    value = Math.floor(value / 1000)
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] as number
    if (group === 0) continue
    if (index === 0) {
      words.push(...underThousand(group, false))
      continue
    }
    const [one, few, many, feminine] = SCALES[index - 1] as [string, string, string, boolean]
    words.push(...underThousand(group, feminine), plural(group, [one, few, many]))
  }
  return words.join(' ')
}

interface Unit {
  /** Phoneme text of the letter. */
  phone: string
  vowel: boolean
}

/** The phonemes of one lower-case Cyrillic word, optionally with acute accents. */
function russianWord(raw: string): string {
  let word = raw
  // The genitive ending is spoken with `в`: «его», «нового», «всего».
  if (/(?:ого|его)$/.test(word) && !/^(?:ого|много|немного|строго|убого|дорого|итого|полого)$/.test(word)) {
    word = `${word.slice(0, -2)}во`
  }
  if (word === 'сегодня') word = 'севодня'
  word = word.replace(/ться$|тся$/, 'ца')

  const letters = [...word]
  const stressAt = new Set<number>()
  const units: Unit[] = []
  let vowelCount = 0
  let explicitStress = -1
  for (let index = 0; index < letters.length; index += 1) {
    const letter = letters[index] as string
    if (letter === STRESS_MARK) {
      if (vowelCount > 0) explicitStress = vowelCount - 1
      continue
    }
    if (VOWELS.includes(letter)) vowelCount += 1
  }
  const yo = letters.filter((letter) => letter !== STRESS_MARK).indexOf('ё')

  const clean = letters.filter((letter) => letter !== STRESS_MARK)
  let vowelIndex = 0
  for (let index = 0; index < clean.length; index += 1) {
    const letter = clean[index] as string
    const previous = index > 0 ? (clean[index - 1] as string) : ''
    const next = index + 1 < clean.length ? (clean[index + 1] as string) : ''
    if (letter === 'ь' || letter === 'ъ') continue
    if (VOWELS.includes(letter)) {
      const isStressed =
        explicitStress >= 0 ? vowelIndex === explicitStress : yo >= 0 ? index === yo : vowelCount === 1
      if (isStressed) stressAt.add(units.length)
      vowelIndex += 1
      const iotated = IOTATED[letter]
      if (iotated !== undefined) {
        const afterConsonant = previous !== '' && !VOWELS.includes(previous) && previous !== 'ь' && previous !== 'ъ'
        if (afterConsonant) {
          units.push({ phone: NO_SOFTENING.has(previous) && letter === 'е' ? 'ɛ' : iotated, vowel: true })
        } else {
          units.push({ phone: 'j', vowel: false }, { phone: iotated, vowel: true })
        }
        continue
      }
      if (letter === 'и' && (previous === 'ж' || previous === 'ш' || previous === 'ц')) {
        units.push({ phone: 'ɨ', vowel: true })
        continue
      }
      if (letter === 'и' && (previous === 'ь' || previous === 'ъ')) units.push({ phone: 'j', vowel: false })
      units.push({ phone: PLAIN_VOWEL[letter] as string, vowel: true })
      continue
    }
    const consonant = CONSONANT[letter]
    if (consonant === undefined) continue
    const soft = !NO_SOFTENING.has(letter) && (SOFTENING_VOWELS.has(next) || next === 'ь')
    units.push({ phone: soft ? `${consonant}ʲ` : consonant, vowel: false })
  }

  // Voicing: the end of a word is voiceless, and a cluster takes the voicing
  // of its last obstruent (`в` does not voice what stands before it).
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index] as Unit
    if (unit.vowel) continue
    const base = unit.phone.replace('ʲ', '')
    const softMark = unit.phone.endsWith('ʲ') ? 'ʲ' : ''
    const next = units[index + 1]
    const nextBase = next === undefined || next.vowel ? undefined : next.phone.replace('ʲ', '').replace('ː', '')
    if (next === undefined) {
      const devoiced = DEVOICED[base]
      if (devoiced !== undefined) unit.phone = `${devoiced}${softMark}`
      continue
    }
    if (nextBase === undefined) continue
    const nextVoiceless = Object.values(DEVOICED).includes(nextBase) || ['ts', 'tɕ', 'x', 'ɕ'].includes(nextBase)
    const nextVoiced = Object.keys(DEVOICED).includes(nextBase) && nextBase !== 'v'
    if (nextVoiceless && DEVOICED[base] !== undefined) unit.phone = `${DEVOICED[base]}${softMark}`
    else if (nextVoiced && VOICED[base] !== undefined) unit.phone = `${VOICED[base]}${softMark}`
  }

  return units.map((unit, index) => (stressAt.has(index) ? `ˈ${unit.phone}` : unit.phone)).join('')
}

function latinWord(word: string): string {
  return [...word].map((letter) => LATIN[letter] ?? '').join('')
}

const SENTENCE_PUNCTUATION = /[.!?…]/
const PAUSE_PUNCTUATION: Record<string, string> = { ',': ',', ';': ';', ':': ':', '—': ',', '–': ',' }

/**
 * Phonemes of a text, one string per sentence, in the espeak-ng alphabet of
 * the Russian Piper voices. Sentences without any speakable word are dropped.
 */
export function russianToPhonemes(text: string): string[] {
  const normalized = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\d+/g, (digits) => ` ${numberToRussianWords(digits)} `)

  const sentences: string[] = []
  let current = ''
  let hasWord = false
  const flush = (mark: string): void => {
    const body = current.replace(/\s+/g, ' ').replace(/^[ ,;:]+|[ ,;:]+$/g, '')
    if (hasWord && body !== '') sentences.push(`${body}${mark}`)
    current = ''
    hasWord = false
  }
  const tokens = normalized.match(/[а-яё́]+|[a-z]+|[.!?…]+|[,;:—–]|\s+|./gu) ?? []
  for (const token of tokens) {
    if (/^[а-яё]/.test(token)) {
      const phones = russianWord(token)
      if (phones !== '') {
        current += phones
        hasWord = true
      }
    } else if (/^[a-z]/.test(token)) {
      current += latinWord(token)
      hasWord = true
    } else if (SENTENCE_PUNCTUATION.test(token)) {
      const mark = token.includes('?') ? '?' : token.includes('!') ? '!' : '.'
      flush(mark)
    } else if (PAUSE_PUNCTUATION[token] !== undefined) {
      current += `${PAUSE_PUNCTUATION[token]} `
    } else {
      current += ' '
    }
  }
  flush('.')
  return sentences
}
