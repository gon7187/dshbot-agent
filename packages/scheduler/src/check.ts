// Deterministic script check of a schedule entry: a cheap shell monitor runs
// before the planned turn so an empty tick costs no model call.
//
// The check command itself runs through the `exec` tool (same sandbox, same
// scrubbed environment). That tool answers with one text: the exit code line,
// then stdout and stderr glued by a `--- stderr ---` line, so a stdout that
// prints the same line could not be told apart from stderr. The command is
// therefore wrapped by `checkExecCommand`: stderr goes to /dev/null and stdout
// starts with one marker character, and the exec text after the marker is the
// stdout exactly as the command printed it. These helpers turn that text into
// one of three outcomes without knowing anything about the model:
//
//   work  — exit 0 and non-empty stdout that is not an explicit "no work"
//   skip  — exit 0 and blank stdout, or a last JSON line `{"wakeAgent":false}`
//   error — nonzero exit, signal, timeout or an unreadable exec answer
//
// `shouldWake` supplies the explicit no-work signal; empty output is handled
// here because an empty string is not a wake gate.

import { shouldWake } from './wake.js'

/** Longest check output copied into a planned-turn prompt. */
export const CHECK_PROMPT_LIMIT = 16_000

/** Telegram limit of one plain message, in UTF-16 code units. */
export const TELEGRAM_TEXT_LIMIT = 4096

/** First stdout character of a wrapped check; it is never part of the result. */
const STDOUT_MARKER = '.'

/** Outcome of one check run, before the caller decides what to do with it. */
export type CheckResult =
  | { readonly status: 'work'; readonly output: string }
  | { readonly status: 'skip' }
  | { readonly status: 'error'; readonly error: string }

/**
 * Whether a non-empty check output reports work. An explicit no-work signal is
 * the exact JSON line parsed by `shouldWake`; blank output is a skip too.
 */
export function checkHasWork(stdout: string): boolean {
  const text = stdout.trim()
  return text !== '' && shouldWake(stdout)
}

/**
 * The command handed to `exec` for one check. The first line silences stderr
 * of the command shell, the second prints the marker, then the check follows
 * on its own lines unchanged, so the command guard still classifies it and its
 * exit status is the status of the whole command.
 */
export function checkExecCommand(command: string): string {
  return `exec 2>/dev/null\nprintf '%s' '${STDOUT_MARKER}'\n${command}`
}

/** Split the tool text of a wrapped check into stdout and an error, if any. */
function readExecText(text: string): { stdout: string; error: string | null } {
  const newline = text.indexOf('\n')
  const head = (newline === -1 ? text : text.slice(0, newline)).trim()
  let body = newline === -1 ? '' : text.slice(newline + 1)

  if (/^Таймаут:/i.test(head)) return { stdout: '', error: 'проверка не уложилась в таймаут' }
  if (/^Команда прервана/i.test(head)) return { stdout: '', error: 'проверка прервана' }

  const exit = /^exit\s+(-?\d+)$/.exec(head)
  if (exit === null) {
    if (/^signal\s+/i.test(head)) return { stdout: '', error: `проверка завершилась по сигналу (${head})` }
    const shown = head === '' ? 'пустой ответ' : head.slice(0, 120)
    return { stdout: '', error: `неожиданный ответ исполнителя: ${shown}` }
  }

  const code = Number(exit[1])
  if (code !== 0) return { stdout: '', error: `проверка завершилась с кодом ${code}` }

  // stderr of the check is /dev/null, so the body is the marker and the stdout,
  // with no stderr section to cut away.
  if (!body.startsWith(STDOUT_MARKER)) {
    return { stdout: '', error: 'исполнитель не вернул вывод проверки' }
  }
  body = body.slice(STDOUT_MARKER.length)
  return { stdout: body, error: null }
}

/**
 * Read the text the `exec` tool returned for one check command.
 *
 * A broken gate must never wake the model: the error branch wins over any
 * partial stdout. A successful run with no work is a skip.
 */
export function readCheckResult(execText: string): CheckResult {
  const { stdout, error } = readExecText(execText)
  if (error !== null) return { status: 'error', error }
  if (!checkHasWork(stdout)) return { status: 'skip' }
  return { status: 'work', output: stdout }
}

/**
 * Output for the planned-turn prompt. A very chatty monitor is cut to
 * {@link CHECK_PROMPT_LIMIT} characters and the cut is named next to the data,
 * so the model knows the report may continue.
 */
export function checkOutputForPrompt(stdout: string, limit = CHECK_PROMPT_LIMIT): string {
  if (stdout.length <= limit) return stdout
  return (
    `${stdout.slice(0, limit)}\n` +
    `[вывод проверки обрезан: показаны первые ${limit} из ${stdout.length} символов]`
  )
}

/**
 * Split plain text into Telegram messages without changing its content: the
 * concatenation of the pieces is exactly the input. A surrogate pair is never
 * cut between two messages when the limit happens to fall inside it.
 */
export function splitPlainText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text === '') return []
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : TELEGRAM_TEXT_LIMIT
  const pieces: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(at + size, text.length)
    if (end < text.length) {
      const last = text.charCodeAt(end - 1)
      const next = text.charCodeAt(end)
      // High surrogate at the cut and a low surrogate after it: keep the pair
      // in the same message.
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
    }
    if (end === at) end = at + 1
    pieces.push(text.slice(at, end))
    at = end
  }
  return pieces
}
