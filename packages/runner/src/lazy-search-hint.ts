// Fallback matching for `tool_search`.
//
// A strict search requires every word of the query to occur in the tool name or
// description, which is the right rule when the words really describe one tool.
// A careless query ("homeassistant light turn on kitchen") therefore matches
// nothing at all and costs the session a full round trip of guessing. This module
// ranks the tools by the number of query words they share so the caller can
// enable the closest ones in the same call instead of asking the model to retry.
//
// Words are compared by their stem: an inflected ending is cut from both sides,
// so "кампании" meets "кампаний" and "campaigns" meets "campaign". The cut is
// limited to inflectional endings, so unrelated words with a common prefix
// ("погода" / "Погрузка") stay different.

/** One-line, case-folded form of a tool name or description. */
export function lazySearchText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** The words of a query in order; a blank query yields no words. */
export function lazyQueryTokens(query: string): string[] {
  return lazySearchText(query)
    .split(' ')
    .filter((token) => token.length > 0)
}

/** Every word of a name or description, with punctuation and `_` as separators. */
export function lazySearchWords(text: string): string[] {
  return lazySearchText(text).match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * One thing a query may match. A qualified tool name (`mcp__server__tool`)
 * stays a single literal: its `mcp` and `echo` words are not evidence that some
 * other server's tool is meant. Every other word is compared by its stem.
 */
interface QueryUnit {
  readonly literal?: string
  readonly stem?: string
}

function queryUnits(query: string): QueryUnit[] {
  const seen = new Set<string>()
  const units: QueryUnit[] = []
  for (const token of lazyQueryTokens(query)) {
    if (token.includes('__')) {
      const key = `literal:${token}`
      if (seen.has(key)) continue
      seen.add(key)
      units.push({ literal: token })
      continue
    }
    for (const word of token.match(/[\p{L}\p{N}]+/gu) ?? []) {
      const stem = lazyWordStem(word)
      const key = `stem:${stem}`
      if (seen.has(key)) continue
      seen.add(key)
      units.push({ stem })
    }
  }
  return units
}

/** The number of query tokens, used as the minimum-overlap heuristic. */
export function lazyQueryWordCount(query: string): number {
  return lazyQueryTokens(query).length
}

// Russian case/number endings and the English regular plural/verb endings. The
// list is tried longest first, so "иями" wins over "и" and "ing" over "g".
const INFLECTIONAL_ENDINGS = [
  'иями',
  'ями',
  'ами',
  'ией',
  'иях',
  'иям',
  'ием',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'ей',
  'ой',
  'ый',
  'ий',
  'ая',
  'яя',
  'ое',
  'ее',
  'ие',
  'ые',
  'ии',
  'ия',
  'ью',
  'ию',
  'ам',
  'ям',
  'ах',
  'ях',
  'ом',
  'ем',
  'ов',
  'ев',
  'ую',
  'юю',
  'а',
  'я',
  'о',
  'е',
  'у',
  'ю',
  'ы',
  'и',
  'ь',
  'й',
  // Latin "e" is the last letter of many English words ("message", "file",
  // "update") and must not be confused with the Cyrillic "е" above: without it
  // the singular keeps its "e" while the plural loses "es" and the two forms
  // stop matching. A stem shorter than MIN_STEM_LENGTH is left whole, so short
  // words like "the" and "one" do not collapse to two letters.
  'e',
  'ing',
  'ed',
  'es',
  's',
].sort((left, right) => right.length - left.length)

// A stem shorter than this would match too much: "на" must not become "н".
const MIN_STEM_LENGTH = 3

/** The comparison form of one word: the word without its inflectional ending. */
export function lazyWordStem(word: string): string {
  const lower = word.toLocaleLowerCase()
  for (const ending of INFLECTIONAL_ENDINGS) {
    if (!lower.endsWith(ending)) continue
    if (lower.length - ending.length < MIN_STEM_LENGTH) continue
    return lower.slice(0, lower.length - ending.length)
  }
  return lower
}

/** A tool the matcher may rank: `name` is what the session can load. */
export interface LazySearchCandidate {
  readonly name: string
  readonly description: string
}

export interface RankedLazyCandidate<T extends LazySearchCandidate> {
  readonly candidate: T
  /** How many distinct query words occur in the candidate's name or description. */
  readonly hits: number
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Up to `limit` tools sharing the most words with the query, best first.
 * Ties are ordered by name so the result is identical on every run; a candidate
 * with no word in common is not a match and stays out.
 */
export function rankLazyCandidates<T extends LazySearchCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number,
): Array<RankedLazyCandidate<T>> {
  const units = queryUnits(query)
  if (units.length === 0 || limit <= 0) return []
  return candidates
    .map((candidate) => {
      const text = lazySearchText(`${candidate.name} ${candidate.description}`)
      const stems = new Set(lazySearchWords(text).map(lazyWordStem))
      let hits = 0
      for (const unit of units) {
        if (unit.literal !== undefined) {
          if (text.includes(unit.literal)) hits += 1
        } else if (unit.stem !== undefined && stems.has(unit.stem)) {
          hits += 1
        }
      }
      return { candidate, hits }
    })
    .filter((scored) => scored.hits > 0)
    .sort((left, right) => {
      if (left.hits !== right.hits) return right.hits - left.hits
      return compareNames(left.candidate.name, right.candidate.name)
    })
    .slice(0, limit)
}

/** The names of {@link rankLazyCandidates}, for a hint that enables nothing. */
export function closestLazyNames(
  candidates: readonly LazySearchCandidate[],
  query: string,
  limit: number,
): string[] {
  return rankLazyCandidates(candidates, query, limit).map((scored) => scored.candidate.name)
}
