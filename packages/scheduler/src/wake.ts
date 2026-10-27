// Wake gate and silent reply: deterministic checks that keep empty schedule
// ticks from spending a model call.

const SILENT_MARKER = '[SILENT]'

/**
 * Whether a schedule wake should start a model turn.
 *
 * The gate stays closed only when the last non-blank stdout line is a JSON
 * object whose `wakeAgent` is exactly `false`. Empty output, plain text,
 * malformed JSON, arrays and `wakeAgent: true` all wake the agent: a broken
 * gate script must not silently disable proactivity.
 */
export function shouldWake(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] as string).trim()
    if (line === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return true
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
    return (parsed as { wakeAgent?: unknown }).wakeAgent !== false
  }

  return true
}

/** Whether a reply is exactly the silent marker after trimming surrounding whitespace. */
export function isSilent(reply: string): boolean {
  return typeof reply === 'string' && reply.trim() === SILENT_MARKER
}
