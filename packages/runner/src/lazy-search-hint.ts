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
//
// A tool name is written in camelCase (`mcp__homeassistant__intent__HassTurnOff`),
// so the words a person reads there ("turn off") must also be the words the
// matcher sees. Both sides of the comparison are split at the camelCase
// boundary before case folding; folding first would glue the whole name into
// one unsplittable word and hide the tool from a query that names its parts.

/** One-line, case-folded form of a tool name or description. */
export function lazySearchText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/**
 * The tokens of a query in order, still bearing their case. The case is what
 * marks a camelCase boundary, so the split of {@link splitCamelCase} has to see
 * the original text; only the comparison form is folded later.
 */
function rawQueryTokens(query: string): string[] {
  return query
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0)
}

/** The words of a query in order; a blank query yields no words. */
export function lazyQueryTokens(query: string): string[] {
  return rawQueryTokens(query).map((token) => token.toLocaleLowerCase())
}

/**
 * A camelCase name split into its parts: `HassTurnOff` becomes `Hass Turn Off`.
 * The boundary is the lowercase-to-uppercase change inside one word (and the end
 * of a run of capitals, so `GetURLPath` becomes `Get URL Path`); it must be
 * found on the original text, because case folding erases it and leaves the
 * whole tool name as one unsplittable word.
 */
function splitCamelCase(text: string): string {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
}

/**
 * Every word of a name or description: punctuation and `_` separate words, and
 * so does the camelCase boundary inside a tool name (`mcp__server__HassTurnOff`
 * yields `mcp`, `server`, `hass`, `turn`, `off`). The split happens before case
 * folding, otherwise `HassTurnOff` collapses into one word and "turn off" has
 * nothing to match.
 */
export function lazySearchWords(text: string): string[] {
  return (splitCamelCase(text).match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => word.toLocaleLowerCase())
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
  for (const token of rawQueryTokens(query)) {
    const folded = token.toLocaleLowerCase()
    if (folded.includes('__')) {
      const key = `literal:${folded}`
      if (seen.has(key)) continue
      seen.add(key)
      units.push({ literal: folded })
      continue
    }
    // The words come from the raw token: the query may spell a tool name the
    // way the model sees it (`HassTurnOff`), and case folding would erase the
    // very boundary that makes "turn" and "off" searchable words.
    for (const word of splitCamelCase(token).match(/[\p{L}\p{N}]+/gu) ?? []) {
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
  const hasLiteral = units.some((unit) => unit.literal !== undefined)
  return candidates
    .map((candidate) => {
      const raw = `${candidate.name} ${candidate.description}`
      // The words come from the raw text: case folding would erase the
      // camelCase boundaries that split a tool name into searchable words.
      const stems = new Set(lazySearchWords(raw).map(lazyWordStem))
      // A qualified name stays a literal, so the comparison is on the folded text.
      const text = hasLiteral ? lazySearchText(raw) : ''
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
