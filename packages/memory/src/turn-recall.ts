// The recall block of an owner turn.
//
// The model does not always think of calling `recall`, so the daemon searches
// the same index itself before the turn and appends the strongest matches to
// the tail of the prompt. Only a real overlap with the message qualifies: a
// short or service message, or one that shares nothing with the memory, gives
// no block at all. The block is bounded, carries the date, the kind, the source
// and a fragment of every hit, and never touches the cached prefix.

import type { RecallHit, RecallIndex } from './recall.js'

/** At most this many hits ride in the tail. */
export const TURN_RECALL_MAX_HITS = 3
/** The whole block never exceeds this many characters. */
export const TURN_RECALL_MAX_CHARS = 1_500
/** A hit needs at least this many matched words (or one long distinctive word). */
const MIN_MATCHED_WORDS = 2
/** …and this share of the significant words of the message. */
const MIN_MATCHED_SHARE = 0.4
/** A single-word query is strong only when the word itself is distinctive. */
const SINGLE_WORD_MIN_LENGTH = 6
/** The fragment of one hit is cut to this many characters before the block limit applies. */
const SNIPPET_MAX_CHARS = 240
/** Words of the message that are too short to identify a memory. */
const SIGNIFICANT_MIN_LENGTH = 4

/**
 * Function words of Russian and English. They still take part in the FTS
 * search, but sharing one of them with a note is not a reason to bring that
 * note into the turn.
 */
const STOP_WORDS = new Set([
  'этот',
  'этого',
  'этой',
  'этом',
  'эти',
  'этих',
  'этим',
  'чтобы',
  'когда',
  'если',
  'здесь',
  'сейчас',
  'потом',
  'потому',
  'поэтому',
  'также',
  'тоже',
  'такой',
  'такая',
  'такие',
  'такое',
  'свой',
  'свою',
  'своя',
  'своих',
  'тебя',
  'меня',
  'себя',
  'него',
  'нее',
  'них',
  'нами',
  'вами',
  'ими',
  'ему',
  'уже',
  'еще',
  'после',
  'перед',
  'между',
  'через',
  'около',
  'почти',
  'очень',
  'более',
  'менее',
  'всегда',
  'иногда',
  'конечно',
  'можно',
  'нельзя',
  'надо',
  'было',
  'были',
  'будет',
  'буду',
  'есть',
  'быть',
  'был',
  'была',
  'это',
  'как',
  'для',
  'при',
  'или',
  'что',
  'чем',
  'кто',
  'где',
  'куда',
  'зачем',
  'the',
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'have',
  'will',
  'would',
  'could',
  'should',
  'there',
  'their',
  'them',
  'then',
  'than',
  'when',
  'what',
  'which',
  'where',
  'your',
  'about',
  'into',
  'over',
  'just',
  'like',
  'some',
  'more',
  'very',
  'also',
  'only',
  'been',
  'being',
  'were',
  'was',
  'are',
])

export interface RecallTurnBlockOptions {
  /** Upper bound on the number of hits; defaults to {@link TURN_RECALL_MAX_HITS}. */
  maxHits?: number
  /** Upper bound on the whole block; defaults to {@link TURN_RECALL_MAX_CHARS}. */
  maxChars?: number
  /** Leave out a hit that is already in the history of the current session. */
  exclude?: (hit: RecallHit) => boolean
}

/**
 * Significant words of a message: long enough and not a function word. The
 * same list drives the query and the threshold, so a hit cannot be counted as
 * strong on a word that was never asked for.
 */
export function significantRecallWords(text: string): string[] {
  const tokens = text.match(/[\p{L}\p{N}_]+/gu) ?? []
  const seen = new Set<string>()
  const words: string[] = []
  for (const raw of tokens) {
    const word = raw.toLowerCase()
    if (word.length < SIGNIFICANT_MIN_LENGTH) continue
    if (STOP_WORDS.has(word)) continue
    if (seen.has(word)) continue
    seen.add(word)
    words.push(word)
  }
  return words.slice(0, 64)
}

function formatDate(ts: number): string {
  const date = new Date(ts)
  return Number.isNaN(date.getTime()) ? 'дата неизвестна' : date.toISOString().slice(0, 10)
}

function fragmentOf(hit: RecallHit, limit: number): string {
  const text = hit.snippet.replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1))}…`
}

/** Whether this hit shares enough of the message to be worth a place in the tail. */
function isStrong(hit: RecallHit, words: string[]): boolean {
  const matched = hit.matched ?? 0
  if (matched <= 0) return false
  if (words.length === 1) {
    return (words[0] as string).length >= SINGLE_WORD_MIN_LENGTH
  }
  return matched >= MIN_MATCHED_WORDS && matched / words.length >= MIN_MATCHED_SHARE
}

/**
 * Search `text` in the recall index and build the tail block of the owner
 * turn, or `''` when nothing is strong enough. The query runs here, before the
 * model call; a failure of the index never fails the turn.
 */
export function recallTurnBlock(index: RecallIndex, text: string, options: RecallTurnBlockOptions = {}): string {
  const words = significantRecallWords(text)
  if (words.length === 0) return ''
  const maxHits = options.maxHits ?? TURN_RECALL_MAX_HITS
  const maxChars = options.maxChars ?? TURN_RECALL_MAX_CHARS
  if (maxHits <= 0 || maxChars <= 0) return ''

  let hits: RecallHit[]
  try {
    // More than the block needs: the excluded and the weak ones are dropped below.
    hits = index.search(words.join(' '), { limit: Math.max(maxHits * 5, 10) })
  } catch {
    return ''
  }

  const chosen = hits.filter((hit) => !(options.exclude?.(hit) ?? false) && isStrong(hit, words)).slice(0, maxHits)
  if (chosen.length === 0) return ''

  const header = '<context_recall>\nСправка из памяти по тексту сообщения (не новый ввод владельца):'
  const footer = '</context_recall>'
  const entries: string[] = []
  for (const hit of chosen) {
    const head = `- ${formatDate(hit.ts)} · ${hit.kind} · ${hit.source}`
    let snippetLimit = SNIPPET_MAX_CHARS
    let entry = `${head}\n  ${fragmentOf(hit, snippetLimit)}`
    const room = (): number => maxChars - header.length - footer.length - 2 - entries.join('\n').length - (entries.length > 0 ? 1 : 0)
    if (entry.length > room()) {
      // Keep the hit and its provenance; only the fragment gives way to the limit.
      snippetLimit = room() - head.length - 3
      if (snippetLimit < 24) break
      entry = `${head}\n  ${fragmentOf(hit, snippetLimit)}`
    }
    entries.push(entry)
  }
  if (entries.length === 0) return ''
  return `${header}\n${entries.join('\n')}\n${footer}`
}
