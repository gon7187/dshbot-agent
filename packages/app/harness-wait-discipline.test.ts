// Source-level discipline of the daemon harnesses: a turn is awaited through the turn-complete event of the daemon
// (test-support/turn-events.ts), and a time window that stays is only there to prove an absent message, to wait
// for background work or to pace the owner's messages when the gap itself is under test, with a short comment
// saying which one. The harness files are read as text; nothing is started.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const APP = fileURLToPath(new URL('.', import.meta.url))
const SELF = basename(fileURLToPath(import.meta.url))
const WINDOW_MS = /\b\w*(?:QUIET|TRAILING|SETTLE)\w*_MS\b/
const TIME_BASED = /\b\w*(?:QUIET|TRAILING|SETTLE)\w*_MS\b|\bsleep\(|\bsetTimeout\(/
// One word of the reason, in the comment next to the window: an absent message or background work.
const ABSENCE = /absen|отсутств|\bno (?:more|extra|second|further|new|other|unexpected|duplicate|reply|message|answer|card|call|request|send|second)\b|nothing|never|must not|not (?:sent|send|arrive|appear|delivered)|silen|тишин|нет /i
const BACKGROUND = /background|subagent|sub-agent|schedul|queue|after the reply|compact|фон|субагент|расписан|очеред|сжати/i
// The gap between two owner messages is what the test is about: the comment names it, e.g. "about 1 s after the first".
const PACING = /\babout [\d.,_]+ ?m?s after the (?:first|previous)\b|через [\d.,_]+ ?м?с после/i

function read(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n')
}

function harnessFiles(): string[] {
  const tests = readdirSync(APP).filter((name) => name.endsWith('.test.ts') && name !== SELF).map((name) => join(APP, name))
  const support = readdirSync(join(APP, 'test-support')).filter((name) => name.endsWith('.ts')).map((name) => join(APP, 'test-support', name))
  return [...tests, ...support]
}

/** The part of a line that is code: a trailing `//` comment is cut off (a `//` inside a string is rare enough here). */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? line : line.slice(0, at)
}

function commentOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return trimmed
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? '' : line.slice(at)
}

/** The comments on the line of a window and on the few lines above it. */
function commentsAround(lines: string[], index: number): string {
  return lines.slice(Math.max(0, index - 4), index + 1).map(commentOf).join(' ')
}

function hasReason(lines: string[], index: number): boolean {
  const comments = commentsAround(lines, index)
  return ABSENCE.test(comments) || BACKGROUND.test(comments) || PACING.test(comments)
}

/** The body of `function name(` up to the closing brace at column 0, or undefined when the file does not define it. */
function bodyOf(lines: string[], name: string): string | undefined {
  const start = lines.findIndex((line) => new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(line))
  if (start === -1) return undefined
  let end = start + 1
  while (end < lines.length && !lines[end]!.startsWith('}')) end += 1
  return lines.slice(start, end + 1).join('\n')
}

/** Windows of time left in a file: `sleep(<window constant>)` and calls of a helper that itself waits for a time. */
function timeWindows(path: string, support: Map<string, string[]>): number[] {
  const lines = read(path)
  const found: number[] = []
  const timeHelpers = new Set<string>()
  for (const name of ['settle', 'quiet']) {
    const body = bodyOf(lines, name) ?? [...support.values()].map((other) => bodyOf(other, name)).find((b) => b !== undefined)
    if (body !== undefined && TIME_BASED.test(body)) timeHelpers.add(name)
  }
  lines.forEach((line, index) => {
    const code = codeOf(line)
    if (/^\s*(?:export\s+)?const\s/.test(code) || /^\s*import\b/.test(code)) return
    const sleepWindow = /\bsleep\(([^)]*)\)/.exec(code)
    if (sleepWindow !== null && WINDOW_MS.test(sleepWindow[1]!)) found.push(index)
    else if ([...timeHelpers].some((name) => new RegExp(`\\bawait\\s+${name}\\(`).test(code))) found.push(index)
  })
  return found
}

function supportBodies(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const dir = join(APP, 'test-support')
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) out.set(name, read(join(dir, name)))
  return out
}

function nonBlank(lines: string[], from: number, step: 1 | -1): string {
  for (let i = from + step; i >= 0 && i < lines.length; i += step) if (lines[i]!.trim() !== '') return lines[i]!
  return ''
}

test('test_h2_p1_the_second_card_turn_of_the_always_test_ends_on_the_turn_event_not_on_a_fixed_sleep', () => {
  const lines = read(join(APP, 'approvals-always-daemon.test.ts'))
  const source = lines.join('\n')

  expect(source, 'the daemon of this file runs with the turn-complete seam on').toMatch(/TURN_EVENTS_ON|TURN_EVENTS_ENV|DSHBOT_TEST_TURN_EVENTS/)
  const body = bodyOf(lines, 'turnWithCard')
  expect(body, 'turnWithCard is defined in the file').toBeDefined()
  expect(body, 'turnWithCard ends on the end-of-turn barrier of the daemon').toMatch(/waitForTurnComplete|turnCompletions/)

  const sleepsBeforeStop = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) =>
      /\bsleep\(/.test(codeOf(line)) &&
      /\bturnWithCard\(/.test(nonBlank(lines, index, -1)) &&
      /\bstopDaemon\(/.test(nonBlank(lines, index, 1)))
    .map(({ index }) => `line ${index + 1}: ${lines[index]!.trim()}`)
  expect(sleepsBeforeStop, 'no fixed sleep between a turn with a card and stopDaemon').toEqual([])
})

test('test_h2_p2_the_settle_windows_of_the_auto_compact_after_reply_file_are_events_or_commented_and_not_longer', () => {
  const lines = read(join(APP, 'auto-compact-after-reply.test.ts'))
  const size = /^const SETTLE_MS = ([\d_]+)/m.exec(lines.join('\n'))
  if (size !== null) expect(Number(size[1]!.replaceAll('_', '')), 'the window is not increased').toBeLessThanOrEqual(1_500)

  const bare = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /\bsleep\(\s*SETTLE_MS\b/.test(codeOf(line)))
    .filter(({ index }) => !hasReason(lines, index))
    .map(({ index }) => `line ${index + 1}: ${lines[index]!.trim()}`)
  expect(bare, 'every SETTLE_MS sleep that stays names its reason (absent message or background work) in a comment').toEqual([])
})

test('test_h2_p3_every_time_window_left_in_the_app_harnesses_has_a_comment_with_its_reason', () => {
  const support = supportBodies()
  const bare: string[] = []
  for (const path of harnessFiles()) {
    const lines = read(path)
    for (const index of timeWindows(path, support)) {
      if (!hasReason(lines, index)) bare.push(`${basename(path)}:${index + 1}: ${lines[index]!.trim()}`)
    }
  }
  expect(bare, 'a QUIET_MS/TRAILING_MS/SETTLE_MS window or a settle()/quiet() that waits for a time carries a reason comment').toEqual([])
})
