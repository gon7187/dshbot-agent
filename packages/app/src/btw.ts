// `/btw`: a side question of the owner answered by one one-shot flash turn.
//
// The turn is its own transient session: it receives the recent messages of
// `main` as context, may use the web tools only, and leaves no trace in the
// owner's session. The question and the answer never enter `main`, so a quick
// aside does not grow its history and does not disturb a running turn.

import type { Runner, RunnerSession, TurnOutcome } from '../../runner/src/index.js'
import type { RecentSessionMessage } from './session-search.js'

/** Command name of the side question, without the slash. */
export const BTW_COMMAND = 'btw'

/** Prefix of every side-question session id: unique and never the owner's. */
export const BTW_SESSION_PREFIX = 'side-question-'

/** How many of the most recent messages of `main` a side question may see. */
export const BTW_MAX_CONTEXT_MESSAGES = 20

/** One past message of `main` is shortened to this many characters in the transcript. */
const BTW_CONTEXT_MESSAGE_CHARS = 4_000

/** The whole past-message transcript is capped, so a huge main turn cannot flood the side question. */
const BTW_CONTEXT_TOTAL_CHARS = 40_000

/** The only tools a side question may call. */
export const BTW_TOOLS: readonly string[] = ['web_search', 'web_fetch']

/** Shown for `/btw` without a question; names the command so the owner can retry. */
export const BTW_USAGE_HINT = [
  'Побочный вопрос: /btw <вопрос>.',
  'Ответит отдельный ход на flash с последними сообщениями main, без инструментов, кроме web_search и web_fetch.',
  'Вопрос и ответ не попадут в историю main.',
].join('\n')

const BTW_COMMAND_RE = /^\/btw(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i

/**
 * The question after `/btw`, trimmed. `null` when the text is not the command,
 * an empty string when the command carries no question (the usage hint case).
 */
export function btwQuestionOf(text: string): string | null {
  const match = BTW_COMMAND_RE.exec(text.trim())
  if (match === null) return null
  return (match[1] ?? '').trim()
}

/**
 * Context block of the recent `main` messages, rendered as a plain transcript.
 * The transcript is data for the model, not a continuation of the turn: the
 * question and its answer stay out of `main`.
 */
export function btwContextBlock(messages: readonly RecentSessionMessage[]): string {
  if (messages.length === 0) return ''
  // Keep the newest messages when the transcript must be cut: they are the ones
  // the question most likely follows.
  const lines: string[] = []
  let total = 0
  for (const message of [...messages].reverse()) {
    const text =
      message.text.length > BTW_CONTEXT_MESSAGE_CHARS
        ? `${message.text.slice(0, BTW_CONTEXT_MESSAGE_CHARS)}…`
        : message.text
    const line = `${message.role === 'user' ? 'Владелец' : 'Бот'}: ${text}`
    if (lines.length > 0 && total + line.length > BTW_CONTEXT_TOTAL_CHARS) break
    total += line.length
    lines.unshift(line)
  }
  return [
    'Последние сообщения основного разговора с владельцем — только для контекста, не продолжай их:',
    '<контекст_main>',
    ...lines,
    '</контекст_main>',
  ].join('\n')
}

/** The single user message of the side turn: the context, then the question. */
export function btwPrompt(question: string, messages: readonly RecentSessionMessage[]): string {
  const context = btwContextBlock(messages)
  const head = [
    'Ты отвечаешь на побочный вопрос владельца отдельным коротким ходом.',
    'Это не продолжение основного разговора: его история ниже дана только как контекст, а сам вопрос и ответ в неё не записываются.',
    'Отвечай по существу и коротко; если вопрос требует свежих данных, используй web_search и web_fetch.',
  ].join('\n')
  return [head, context, `Вопрос владельца: ${question}`].filter((part) => part !== '').join('\n\n')
}

/** One side question: a transient flash session with the web tools only. */
export interface SideQuestionRequest {
  runner: Runner
  question: string
  context: readonly RecentSessionMessage[]
  /** A unique id of this one-shot session; the runner deletes it afterwards. */
  sessionId: string
  /** The system prefix of the owner's `main`, reused byte for byte. */
  systemPrefix: string
  /** Provider model id; the side question always runs on flash. */
  model: string
}

/** Ask one side question and settle with the turn outcome (never a session write to `main`). */
export function askSideQuestion(request: SideQuestionRequest): Promise<TurnOutcome> {
  const session: RunnerSession = {
    sessionId: request.sessionId,
    model: request.model,
    systemPrefix: request.systemPrefix,
    tools: [...BTW_TOOLS],
    // The prefix of main lists every lazy tool; the side turn keeps those bytes
    // while its own tool list stays the web whitelist.
    includeLazyIndex: true,
    transient: true,
  }
  return request.runner.promptTurn(btwPrompt(request.question, request.context), session)
}
