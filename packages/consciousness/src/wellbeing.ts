// The self-state of the bot's own memory, added to the wake-up prompt after the
// summary of events (Ouroboros `context_health.py`, `_memory_health_lines`).
//
// The summary answers "what happened since the previous wake-up"; this block
// answers "how is my memory doing". It names deviations only: an identity that
// was not updated for more than three days or became too thin, a scratchpad
// that is empty or nearly full, and the wake-up spending of the last day. A
// clean state is one short line, so the block cannot grow into a second report.
//
// The block is data, not a command: the prompt asks the bot to look at it, the
// daemon never changes memory or the schedule from here.

/** Header of the block; also the marker the prompt and tests look for. */
export const WELLBEING_HEADER = 'Самочувствие:'

/** Hard cap of the block in characters. */
export const WELLBEING_LIMIT = 600

/** identity.md older than this is reported as stale. */
export const IDENTITY_STALE_MS = 72 * 3_600_000

/** identity.md shorter than this is reported as thin. */
export const IDENTITY_THIN_CHARS = 200

/** A scratchpad shorter than this counts as empty. */
export const SCRATCHPAD_EMPTY_CHARS = 50

/** A scratchpad longer than this share of its limit is reported as nearly full. */
export const SCRATCHPAD_FULL_RATIO = 0.8

/** Window of the wake-up spending line. */
export const WAKE_USAGE_WINDOW_MS = 24 * 3_600_000

const HOUR_MS = 3_600_000

/** One row of the wake-up usage ledger: the token accounting of one model call. */
export interface WakeUsageSample {
  at: number
  /** Shared by all model calls of one wake-up; absent in older caller samples. */
  turnId?: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

export interface WakeWellbeingInput {
  /** Moment of the observation, Unix epoch milliseconds. */
  now: number
  /** Text of `memory/identity.md`; `''` when the file is absent. */
  identityText?: string
  /** Modification time of `memory/identity.md`; `null` when it cannot be read. */
  identityMtimeMs?: number | null
  /** Text of `scratchpad.md`; `''` when the file is absent. */
  scratchpadText?: string
  /** Limit of the scratchpad in characters; defaults to the memory package limit. */
  scratchpadLimit?: number
  /** Rows of the wake-up usage ledger (all history; the window is applied here). */
  wakeUsage?: readonly WakeUsageSample[]
}

/** Characters as the model counts them, not UTF-16 code units. */
function characterCount(text: string): number {
  return [...text].length
}

/** One deviation line, without the bullet. */
function identityLines(input: WakeWellbeingInput): string[] {
  const lines: string[] = []
  const text = (input.identityText ?? '').trim()
  const length = characterCount(text)
  const mtime = input.identityMtimeMs
  if (typeof mtime === 'number' && Number.isFinite(mtime)) {
    const ageMs = Math.max(0, input.now - mtime)
    if (ageMs > IDENTITY_STALE_MS) {
      lines.push(`identity не обновлялся ${Math.floor(ageMs / HOUR_MS)} ч`)
    }
  }
  if (length < IDENTITY_THIN_CHARS) {
    lines.push(`identity тонкий: ${length} символов`)
  }
  return lines
}

function scratchpadLines(input: WakeWellbeingInput): string[] {
  const text = input.scratchpadText ?? ''
  const limit = input.scratchpadLimit ?? 3_000
  if (characterCount(text.trim()) < SCRATCHPAD_EMPTY_CHARS) return ['блокнот пуст']
  // Match the scratchpad writer's limit: whitespace also occupies the file.
  const length = characterCount(text)
  if (limit > 0 && length > limit * SCRATCHPAD_FULL_RATIO) {
    return [
      `блокнот почти полон: ${length} из ${limit}, вынеси устойчивое в knowledge или journal`,
    ]
  }
  return []
}

function usageLine(input: WakeWellbeingInput): string | undefined {
  const rows = input.wakeUsage ?? []
  const since = input.now - WAKE_USAGE_WINDOW_MS
  const wakeUps = new Set<string | number>()
  let tokens = 0
  for (const [index, row] of rows.entries()) {
    if (row.at < since || row.at > input.now) continue
    // Legacy caller samples without an id still represent separate wake-ups.
    wakeUps.add(row.turnId ?? index)
    tokens +=
      row.inputTokens +
      row.cacheReadTokens +
      row.cacheWriteTokens +
      row.outputTokens
  }
  if (wakeUps.size === 0) return undefined
  return `пробуждений за 24 ч: ${wakeUps.size}, токенов: ${tokens}`
}

/**
 * The «Самочувствие:» block of the wake-up prompt. Never longer than
 * {@link WELLBEING_LIMIT}; a clean state is the single line
 * «Самочувствие: в норме».
 */
export function buildWakeWellbeing(input: WakeWellbeingInput): string {
  const deviations = [...identityLines(input), ...scratchpadLines(input)]
  const usage = usageLine(input)
  if (deviations.length === 0 && usage === undefined) {
    return `${WELLBEING_HEADER} в норме`
  }
  const lines = [...deviations, ...(usage === undefined ? [] : [usage])]
  const text = [WELLBEING_HEADER, ...lines.map((line) => `- ${line}`)].join('\n')
  // Defensive cap: the honest lines are far shorter, but the header must never
  // be the part that gets lost.
  const chars = [...text]
  if (chars.length <= WELLBEING_LIMIT) return text
  return chars.slice(0, WELLBEING_LIMIT - 1).join('') + '…'
}
