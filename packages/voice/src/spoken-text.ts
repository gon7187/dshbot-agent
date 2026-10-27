// What of an answer is read aloud.
//
// A spoken answer is not the same text as the written one: code blocks, tables
// and links are useless or harmful through a speaker, and a long answer is
// spoken only from its beginning. The written answer is never shortened — this
// module only prepares the text handed to the synthesizer.

/** Longest spoken part of one answer, in characters. */
export const SPEECH_TEXT_LIMIT = 600

function removeMarkdownLinks(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

function removeUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, ' ')
}

/** One line of prose, with the markers a speaker must not read out. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .replace(/`+/g, '')
}

/**
 * Drops fenced code blocks, both ``` and ~~~: a fence closes with a line of
 * the same character at least as long as the opening one, and an unclosed
 * fence hides the rest of the answer, as in Markdown.
 */
function removeFencedCode(text: string): string {
  const kept: string[] = []
  let fence: { char: string; length: number } | undefined
  for (const line of text.split('\n')) {
    const opening = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    // A backtick fence has no backtick after it: "```x```" is inline code.
    const inline = opening?.[1]?.startsWith('`') === true && opening[2]?.includes('`') === true
    const marker = inline ? undefined : opening?.[1]
    if (fence === undefined) {
      if (marker === undefined) kept.push(line)
      else fence = { char: marker.charAt(0), length: marker.length }
      continue
    }
    const closes = marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length
    if (closes && /^\s{0,3}[`~]+\s*$/.test(line)) {
      fence = undefined
      kept.push('')
    }
  }
  // Triple backticks inside one line of prose are code as well.
  return kept.join('\n').replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ')
}

/**
 * Drops indented code blocks: a line indented with four spaces or a tab at the
 * start of the answer or after a blank line opens a block, and every following
 * indented line belongs to it. The block ends at the first line without that
 * indentation, exactly as Markdown renders it.
 */
function removeIndentedCode(text: string): string {
  const kept: string[] = []
  let previousBlank = true
  let inBlock = false
  for (const line of text.split('\n')) {
    const blank = line.trim() === ''
    const indented = !blank && (line.startsWith('\t') || /^ {4,}/.test(line))
    if (inBlock) {
      if (indented) continue
      inBlock = false
    } else if (indented && previousBlank) {
      inBlock = true
      continue
    }
    kept.push(line)
    previousBlank = blank
  }
  return kept.join('\n')
}

/**
 * Turns a Markdown answer into the text that is safe and useful to speak:
 * fenced code and tables are dropped, links keep only their label, bare URLs
 * are removed, white space is collapsed. A result longer than `limit` is cut
 * at the last sentence boundary that fits; without one the result is empty
 * and the answer goes out as text only.
 */
export function prepareSpokenText(markdown: string, limit: number = SPEECH_TEXT_LIMIT): string {
  const withoutFences = removeFencedCode(markdown.replace(/\r\n?/g, '\n'))
  const withoutIndented = removeIndentedCode(withoutFences)
  const withoutTables = withoutIndented
    .split('\n')
    .filter((line) => !line.includes('|'))
    .map(plainLine)
    .join('\n')
  const collapsed = removeUrls(removeMarkdownLinks(withoutTables))
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed

  const head = collapsed.slice(0, limit)
  // The last sentence end that fits: `.`, `!`, `?` or `…` followed by a space
  // or the end of the head. A decimal point or an abbreviation inside a word
  // (`q1.2`, `т.е.`) is not preferred here, but a wrong cut is only cosmetic.
  const sentenceEnd = /[.!?…](?=\s|$)/g
  let cut = -1
  for (const match of head.matchAll(sentenceEnd)) {
    const end = (match.index ?? 0) + 1
    if (end <= limit) cut = end
  }
  // Without a sentence end in the limit nothing is spoken: a cut in the middle
  // of a sentence is worse than the written answer alone.
  return cut > 0 ? head.slice(0, cut).trim() : ''
}
