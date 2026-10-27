// Long-lived runner on the minimal DeepSeek Harness plugin set.
//
// The product profile `headless` exits after one task, so this module assembles the
// smallest Cordis context that can run the agent loop, keep durable per-principal
// sessions (owner `main` and one per guest) and answer prompts in-process. It is the
// stage-1 prototype from docs/DESIGN.md.

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle, type AgentSetup } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as ImageOffload from '@deepseek-ai/dsh-compaction-image-offload'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LlmRuntime, {
  ReasoningEffortId,
  assistantStreamHasVisibleContent,
  createAssistantMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmFailure } from '@deepseek-ai/dsh-llm'
import * as DeepSeekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as PiAiAdapter from '@deepseek-ai/dsh-llm-pi-ai'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import Authorization, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { credentialKeyId, credentialKeyScope, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import SessionStore, {
  SessionLogOffset,
  SessionSeq,
  appendPluginRecord,
  buildForkSeed,
  deriveEventMessage,
  pluginRecordOf,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type PreToolDecision, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lazyQueryWordCount, rankLazyCandidates } from './lazy-search-hint.js'
import { JsonlSessionPersistence } from './persistence.js'
import {
  recordToolNote,
  TOOL_NOTE_CHANGE_LIMIT,
  TOOL_NOTE_ERROR_LIMIT,
  TOOL_NOTE_VALUE_LIMIT,
  type ToolNote,
} from './tool-notes.js'
import { keyInsertsText } from '../../tools-browser/src/secret-input.js'

export * from './tool-notes.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Lazy tools enabled (or requested for the next session) in one runner session. */
    'plugin:runner/lazy-tools': { enabled?: readonly string[]; pending?: readonly string[] }
    /** One scheduled model-request retry: its step, failure, attempt number and pause. */
    'plugin:runner/model-retry': {
      turn: number
      step: number
      provider: string
      retry: number
      maxRetries: number
      delayMs: number
      failure: { code: string; status?: number }
    }
  }
}

/** Identity of the default conversation session (the owner's chat). */
export const MAIN_SESSION_ID = 'main'

/** Tool that resolves and enables lazy tools for the current session. */
export const TOOL_SEARCH_NAME = 'tool_search'

/**
 * Model a delegated child runs on, whatever model the parent turn uses. A
 * child does focused, well-scoped work, so the cheap flash route is enough and
 * keeps a delegation from multiplying the price of the parent's pro turn.
 */
export const CHILD_MODEL = 'deepseek-flash'

/** Prefix of every child session id; children never share the owner's session. */
export const CHILD_SESSION_PREFIX = 'subagent-'

/** Default cap on model iterations inside one child turn. */
export const DEFAULT_CHILD_MAX_ITERATIONS = 40

/** Default wall-clock cap on one child turn, in milliseconds (10 minutes). */
export const DEFAULT_CHILD_TIMEOUT_MS = 600_000

/**
 * Tools a delegated child never receives, whatever the parent asks for. The
 * child cannot delegate again, hand work to another agent, schedule anything,
 * touch the factory or change the bot itself.
 */
const CHILD_FORBIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'delegate',
  'delegate_status',
  'delegate_wait',
  TOOL_SEARCH_NAME,
  'task',
  'schedule',
  'set_next_wakeup',
  'zavod',
  'self_change',
  'self_submit',
  'self_discard',
  'update_identity',
  // The scratchpad belongs to the owner and the wake-up turns: a child has no
  // continuity of its own and must not rewrite the owner's working notes.
  'update_scratchpad',
  // The owner's own machines: a delegated child has no owner in the chat to
  // confirm a dangerous command, so the whole capability stays with the owner.
  'host_exec',
  // The owner's mailboxes: a child may not read the owner's mail, and the tool
  // must stay out of every child whatever its parent asks for.
  'mail',
  // The controls of the owner's live commands: a child may run its own
  // background command, but it must not read or feed another session's job.
  'exec_write',
  'exec_list',
])

/** True when a durable session id belongs to a delegated child. */
export function isChildSession(sessionId: string | undefined): boolean {
  return sessionId !== undefined && sessionId.startsWith(CHILD_SESSION_PREFIX)
}

/** Prefix of the session id owned by one guest chat; the app builds ids the same way. */
const GUEST_SESSION_PREFIX = 'guest-'

/** Characters a transient session id may consist of: letters, digits, dot, dash, underscore. */
const TRANSIENT_SESSION_ID_CHARS = /^[A-Za-z0-9._-]+$/

/**
 * Why a transient turn may not use `id`, or `undefined` when the id is safe.
 * A transient session is deleted after its turn, so an id naming the owner's
 * history, a guest or child session, or one that could step out of the
 * sessions directory must be refused before the session is opened. Dots are
 * allowed in an id, but a `..` segment is a path step, not a name.
 */
function transientSessionRefusal(id: string, principal?: TurnPrincipal): string | undefined {
  if (id === MAIN_SESSION_ID) return `transient session id "${id}" names the owner session`
  if (id.startsWith(GUEST_SESSION_PREFIX)) return `transient session id "${id}" names a guest session`
  if (isChildSession(id)) return `transient session id "${id}" names a child session`
  if (principal !== undefined && principal !== 'owner') {
    return `transient session id "${id}" belongs to a "${principal}" turn`
  }
  if (!TRANSIENT_SESSION_ID_CHARS.test(id)) {
    return `transient session id "${id}" contains characters outside letters, digits, dot, dash and underscore`
  }
  if (id === '.' || id.includes('..')) return `transient session id "${id}" is not a plain directory name`
  return undefined
}

/**
 * Directory of a transient session, or `undefined` when the resolved path does
 * not lie strictly inside `<dshHome>/sessions`. The second gate before the
 * `rmSync`: even a bug that lets an odd id through cannot delete the state
 * directory or a sibling of `sessions`.
 */
function transientSessionDirectory(dshHome: string, id: string): string | undefined {
  const root = resolve(dshHome, 'sessions')
  const target = resolve(root, id)
  const nested = relative(root, target)
  if (nested === '' || nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested)) return undefined
  return target
}

/** Session record that carries enabled lazy tools across a restart. */
const LAZY_TOOLS_RECORD = 'plugin:runner/lazy-tools'

/** Session record of one scheduled model-request retry. */
const MODEL_RETRY_RECORD = 'plugin:runner/model-retry'

/** Cap on one lazy-tool description inside the stable prefix index, in characters. */
const LAZY_INDEX_DESCRIPTION_CHARS = 60

/** Default cap on one tool result the model receives, in characters. */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 30_000

/** Marker left in place of a redacted secret. */
const SECRET_MARKER = '[redacted]'

/**
 * Who owns the turn. The app derives it from the chat id, never from the model.
 *
 * `owner` is the paired private chat of the owner and is the only principal that
 * reaches the registered tools. Every other principal is default-deny: it sees
 * only the tools explicitly marked {@link RunnerTool.guestAllowed} (today the
 * three guest tools: `exec`, `web_search` and `web_fetch`). `schedule` and
 * `wakeup` are the owner's own automation; they are non-owner principals as
 * well, so a tool that they need must opt in explicitly like any other
 * guest-visible tool.
 */
export type TurnPrincipal = 'owner' | 'guest' | 'schedule' | 'wakeup'

/** One model call's token accounting, summed over the calls of a turn. */
export interface TurnUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** A tool call the principal schema does not contain, rejected before execute. */
export interface ToolDeniedEvent {
  /** Durable session that asked for the call. */
  sessionId?: string
  /** Principal of that session, when the caller declared one. */
  principal?: TurnPrincipal
  /** Name the model invented or borrowed from another principal. */
  tool: string
}

/** Usage report of one finished turn. */
export interface TurnUsageEvent extends TurnUsage {
  sessionId: string
  /** Undefined when the caller kept the legacy per-session contract. */
  principal?: TurnPrincipal
  /** Model route the turn was billed on. */
  model: string
}

/**
 * A turn the provider failed. `usage` holds the model calls of this turn that
 * completed before the failure (from the session log since the turn started),
 * so a caller summing several turns adds only what this one paid for.
 */
export class TurnFailedError extends Error {
  readonly usage: TurnUsageEvent | undefined

  constructor(message: string, usage: TurnUsageEvent | undefined) {
    super(message)
    this.name = 'TurnFailedError'
    this.usage = usage
  }
}

/** Usage a failed `promptTurn` already paid for; nothing for any other error. */
export function usageOfFailedTurn(error: unknown): TurnUsageEvent | undefined {
  return error instanceof TurnFailedError ? error.usage : undefined
}

/** Settlement of one prompt turn, fired in its `finally` even when it failed or was cancelled. */
export interface TurnEndEvent {
  /** Durable session that ran the turn. */
  sessionId: string
  /** Principal of that session, when the caller declared one. */
  principal?: TurnPrincipal
}

/** Fallback denial reason when a hook denies without one. */
const DEFAULT_DENY_REASON = 'вызов инструмента запрещён'

/** Order of the deployment persona prefix in the system prompt assembly. */
const PERSONA_PREFIX_ORDER = 0

/** Provider route registered by `dsh-llm-deepseek-api-key`. */
export const DEEPSEEK_PROVIDER = 'deepseek-official'

/**
 * Routes of the multi-provider `dsh-llm-pi-ai` adapter, in the order the
 * provider screen offers them. The list is closed: a route outside it belongs
 * to another adapter and is never filtered by the credential store below.
 */
export const PI_AI_PROVIDERS = [
  'zai',
  'openai-codex',
  'openai',
  'anthropic',
  'google',
  'xai',
  'moonshotai',
  'kimi-coding',
  'minimax',
  'openrouter',
  'github-copilot',
  'qwen-token-plan',
] as const

/** One route of {@link PI_AI_PROVIDERS}. */
export type PiAiProviderId = (typeof PI_AI_PROVIDERS)[number]

const PI_AI_PROVIDER_SET: ReadonlySet<string> = new Set(PI_AI_PROVIDERS)

/** Scope of the credential records written by `dsh-llm-pi-ai`. */
const PI_AI_RECORD_SCOPE = 'llm-pi-ai'

/** Model used unless the caller overrides it. */
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * Reasoning efforts of the DeepSeek Messages route, in increasing order. `off`
 * sends `thinking.type: disabled`, the others serialize as
 * `output_config.effort`; an unsupported value fails before network I/O.
 */
export const REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const

/** One accepted reasoning effort of the DeepSeek route. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * Default level of every reasoning session, `main` included, until the owner
 * changes `main` with `/effort`: thinking on with `high` effort.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

/**
 * Failure codes the provider route retries. Every one of them means the
 * request never reached a model decision: a broken transport (dropped socket,
 * ETIMEDOUT, a stream that ended before the first token), a rate limit or a
 * gateway/upstream error. Anything else (invalid request, auth, quota, a
 * context-window refusal) is the model's or the owner's problem and would fail
 * the same way if repeated.
 *
 * `STREAM_CLOSED` is conditional: the adapter also emits it when a stream ends
 * after some content was already streamed, and only the empty attempt is
 * transient. {@link isRetryableModelFailure} makes that distinction.
 */
export const RETRYABLE_MODEL_FAILURES: readonly string[] = [
  'TRANSPORT',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'STREAM_CLOSED',
]

/** Retries after the first request: one step is asked at most seven times. */
const MODEL_RETRY_MAX_RETRIES = 6

/** First local pause of the exponential backoff. */
const MODEL_RETRY_INITIAL_DELAY_MS = 500

/** Upper bound for a local pause, and for an accepted provider `Retry-After`. */
const MODEL_RETRY_MAX_DELAY_MS = 600_000

/** Symmetric jitter around each exponential pause. */
const MODEL_RETRY_JITTER_RATIO = 0.2

/**
 * Local pause of one retry: exponential from half a second, capped, with
 * symmetric jitter so parallel clients do not retry at the same instant.
 */
function localRetryDelayMs(retry: number): number {
  const exponential = Math.min(MODEL_RETRY_INITIAL_DELAY_MS * 2 ** (retry - 1), MODEL_RETRY_MAX_DELAY_MS)
  const jitter = 1 - MODEL_RETRY_JITTER_RATIO + 2 * MODEL_RETRY_JITTER_RATIO * Math.random()
  return Math.min(exponential * jitter, MODEL_RETRY_MAX_DELAY_MS)
}

/**
 * Whether one failed model request of a step is worth repeating. A stream that
 * closed before the model produced any visible content (no text, reasoning or
 * tool call) is transient; the same code after content means the answer was
 * partially delivered and repeating the step would duplicate it.
 */
function isRetryableModelFailure(failure: LlmFailure, attemptHadContent: boolean): boolean {
  if (failure.code === 'STREAM_CLOSED') return !attemptHadContent
  return RETRYABLE_MODEL_FAILURES.includes(failure.code)
}

/**
 * Extra pause on top of a provider `Retry-After`. The header says when the
 * provider is ready again; every client that obeys it exactly would hit the
 * API at the same instant. A short fixed margin spreads the retries, so the
 * real pause is always a little longer than the provider asked for.
 */
const PROVIDER_RETRY_MARGIN_MS = 1_000

/**
 * Pause before the given retry. A valid provider `Retry-After` is the floor:
 * the fixed margin is added on top so every client that obeys the header
 * exactly does not hit the API at the same instant. A provider delay above the
 * cap is not accepted, matching the local backoff bound.
 */
function retryDelayMs(failure: LlmFailure, retry: number): number | undefined {
  const after = failure.providerRetryAfterMs
  if (after !== undefined && Number.isFinite(after) && after > 0) {
    if (after > MODEL_RETRY_MAX_DELAY_MS) return undefined
    return Math.round(after + PROVIDER_RETRY_MARGIN_MS)
  }
  return Math.round(localRetryDelayMs(retry))
}

/** Wait `ms`, or resolve false as soon as the turn signal aborts the pause. */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One retry line of the journal: what failed, which attempt and how long it waits. */
function retryJournalLine(sessionId: string, event: {
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
  readonly failure: { readonly code: string; readonly status?: number }
}): string {
  const failure = event.failure.status === undefined
    ? event.failure.code
    : `${event.failure.code} ${event.failure.status}`
  const attempt = event.maxRetries === undefined
    ? `retry ${event.retry}`
    : `retry ${event.retry}/${event.maxRetries}`
  return `model request ${attempt} of session "${sessionId}" after ${failure}: pause ${Math.round(event.delayMs)} ms`
}

/** Validated payload of one {@link MODEL_RETRY_RECORD}; restored logs carry untyped JSON. */
interface ModelRetryRecord {
  turn: number
  step: number
  provider: string
  retry: number
  maxRetries: number
  delayMs: number
  failure: { code: string; status?: number }
}

/** Read the retry record of one log event, or undefined for any other event. */
function modelRetryRecordOf(event: SessionEvent): ModelRetryRecord | undefined {
  const record = pluginRecordOf(event)
  if (record?.type !== MODEL_RETRY_RECORD) return undefined
  const data = record.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const value = data as Record<string, unknown>
  const failure = value.failure
  if (failure === null || typeof failure !== 'object' || Array.isArray(failure)) return undefined
  const failureValue = failure as Record<string, unknown>
  if (
    typeof value.turn !== 'number' ||
    typeof value.step !== 'number' ||
    typeof value.provider !== 'string' ||
    typeof value.retry !== 'number' ||
    typeof value.maxRetries !== 'number' ||
    typeof value.delayMs !== 'number' ||
    typeof failureValue.code !== 'string' ||
    (failureValue.status !== undefined && typeof failureValue.status !== 'number')
  ) {
    return undefined
  }
  return value as unknown as ModelRetryRecord
}

/**
 * Whether the latest attempt of this step streamed visible content (text,
 * reasoning or a tool call) before it failed. On `STREAM_CLOSED` that decides
 * whether the answer was empty enough to repeat.
 */
function attemptHadVisibleContent(session: Session, turn: number, step: number): boolean {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
      if (event.data.turn !== turn || event.data.step !== step) continue
      return assistantStreamHasVisibleContent(event.data.stream)
    }
    if (event.type === 'step/start' && event.data.turn === turn && event.data.step === step) break
  }
  return false
}

/** Retries already scheduled for this step, from the durable records of the turn. */
function retryCountOf(session: Session, turn: number, step: number): number {
  let count = 0
  for (const event of session.snapshotEvents()) {
    const record = modelRetryRecordOf(event)
    if (record !== undefined && record.turn === turn && record.step === step) {
      count = Math.max(count, record.retry)
    }
  }
  return count
}

/** Russian plural of "попытка" for the attempt count of the owner notice. */
function attemptsWord(count: number): string {
  const mod100 = count % 100
  const mod10 = count % 10
  if (mod100 >= 11 && mod100 <= 14) return 'попыток'
  if (mod10 === 1) return 'попытка'
  if (mod10 >= 2 && mod10 <= 4) return 'попытки'
  return 'попыток'
}

/**
 * Owner-facing message of a turn that ran out of retries. The provider failure
 * code (or its HTTP status when present) is the only technical detail worth a
 * short line; the attempt count and the "продолжи" offer tell the owner what
 * happened to the work and how to resume it.
 */
export function modelUnavailableNotice(code: string, status: number | undefined, attempts: number): string {
  const shown = status === undefined ? code : String(status)
  return `DeepSeek недоступен (${shown}), ход прерван после ${attempts} ${attemptsWord(attempts)}; напиши "продолжи"`
}

/**
 * Error text of a turn that ended with a terminal failure. A retryable failure
 * that survived its retries becomes the owner-facing "DeepSeek недоступен"
 * notice; everything else keeps the provider's reason, with secrets scrubbed.
 */
function turnFailureMessage(report: TurnReport, secrets: readonly string[], fallback: string): string {
  if (
    report.failureCode !== undefined &&
    RETRYABLE_MODEL_FAILURES.includes(report.failureCode) &&
    report.attempts > 1
  ) {
    return modelUnavailableNotice(report.failureCode, report.failureStatus, report.attempts)
  }
  const reason = redactSecrets(report.failure ?? '', secrets).trim()
  return reason.length > 0 ? reason : fallback
}

/** Accepted effort of a raw value; undefined for anything the route does not know. */
export function resolveReasoningEffort(value: unknown): ReasoningEffort | undefined {
  const normalized = normalizeReasoningLevel(value)
  return normalized !== undefined && (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : undefined
}

/**
 * Normalized level of an adapter-owned model route. The DeepSeek route knows
 * the four {@link REASONING_EFFORTS}; a model of a connected provider offers
 * its own set (`minimal`, `medium`, `xhigh`, …), so the saved level is kept as
 * the plain adapter id instead of being narrowed to the DeepSeek four.
 */
export function normalizeReasoningLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  return normalized === '' ? undefined : normalized
}

/** Default cap on model iterations inside one turn before the final answer is demanded. */
export const DEFAULT_MAX_TURN_ITERATIONS = 210

/**
 * Default wall-clock cap on one turn, in milliseconds: 30 minutes. A turn that
 * reaches it is cancelled through the same agent cancellation as `/stop`, so the
 * running tools see their abort signal and no late answer is delivered.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 1_800_000

/**
 * Host insertion at the iteration limit: the turn must end with the best
 * verified result, naming what stayed unchecked. It goes as a user message in
 * the tail, never into the stable prefix.
 */
export const FINALIZE_NOW_TEXT =
  '[FINALIZE_NOW] Лимит итераций этого хода исчерпан. Останови работу и дай итог: что сделано, ' +
  'чем это подтверждено и что осталось. Непроверенное назови непроверенным; честный частичный итог — нормальный итог.'

/**
 * One-shot verify-before-done insertion: files were edited and nothing ran a
 * check afterwards. It advises, it does not block.
 */
export const VERIFY_BEFORE_DONE_TEXT =
  'Проверь результат перед финалом: файлы изменены, а свежей проверки после правки не было. ' +
  'Запусти тест, сборку или другой реальный инструмент проверки и опирайся на его вывод; непроверенное так и назови.'

/** Appended to the third identical tool result in a row; the result itself stays intact. */
export const LOOP_WARNING_TEXT =
  'Предупреждение о петле: третий раз подряд один и тот же вызов инструмента с теми же аргументами. ' +
  'Не повторяй его снова: измени аргументы, проверь иначе или объясни, что именно застряло.'

/** One nudge for a turn that ended without any answer text. */
export const EMPTY_TURN_NUDGE_TEXT =
  'Ход закончился пустым ответом. Продолжай: сделай следующий шаг инструментом или дай короткий итог.'

/**
 * Assistant note that closes a cancelled turn in the durable history. An abort
 * leaves the interrupted tool result as the last message; without a closing
 * assistant turn the next user message would merge into that same user turn and
 * the conversation would lose the turn boundary. The note is not delivered to
 * the owner, it only makes the interruption visible to the model.
 */
export const CANCELLED_TURN_TEXT = '[ход прерван: выполнение остановлено]'

/**
 * Assistant note that closes a turn failed by the provider (an HTTP error, a
 * broken stream). Like the cancelled-turn note, it gives the durable log a
 * boundary: the next owner message must open a new turn instead of merging into
 * the unanswered text of the failed one.
 */
export const FAILED_TURN_TEXT = '[ход не выполнен: ошибка провайдера]'

/** Longest provider reason kept in the failed-turn note, in characters. */
const FAILED_TURN_REASON_LIMIT = 500

/**
 * Note of a failed turn with the provider's reason (status and message) on one
 * line, masked and cut like the owner's notice. Without an error text the note
 * stays the bare {@link FAILED_TURN_TEXT}.
 */
function failedTurnNote(report: TurnReport, secrets: readonly string[]): string {
  const message = redactToolNoteText(report.failure ?? '', secrets).replace(/\s+/gu, ' ').trim()
  if (message.length === 0) return FAILED_TURN_TEXT
  const reason = report.failureStatus === undefined ? message : `${report.failureStatus} ${message}`
  // Length is counted in UTF-16 units like the owner's notice; a cut between the
  // halves of a surrogate pair drops the lone high half.
  let clipped = reason
  if (reason.length > FAILED_TURN_REASON_LIMIT) {
    let head = reason.slice(0, FAILED_TURN_REASON_LIMIT - 1)
    if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1)
    clipped = `${head}…`
  }
  return `${FAILED_TURN_TEXT.slice(0, -1)}: ${clipped}]`
}

/** Tools whose successful call counts as a fresh check after an edit. */
const VERIFY_TOOL_NAMES: ReadonlySet<string> = new Set(['exec', 'bash', 'shell'])

/** Tools that change files and therefore need a later check. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['edit', 'write', 'create'])

/** Context handed to {@link RunnerTool.execute} for one call. */
export interface RunnerToolContext {
  /**
   * Cancellation of the running turn. A tool that owns a process or another
   * long operation must listen to it and settle after cleaning up; the harness
   * aborts it on `/stop` and on the turn timeout.
   */
  readonly signal: AbortSignal
  /** Durable session that requested the call (`main` for the owner chat). */
  readonly sessionId?: string
  /** Provider model route of this turn; a tool that needs the modality reads it here. */
  readonly model?: string
  /**
   * Push the deadline of the current turn by `extraMs`, for a tool that waits
   * on a human instead of doing work. The wait must not be charged to the turn
   * wall-clock cap: a six hour answer window would otherwise be cancelled by
   * the default 30 minute limit. Returns whether a live turn was extended.
   */
  readonly extendTimeout?: (extraMs: number) => boolean
}

/**
 * One tool exposed to the model.
 *
 * `execute` receives the already parsed model arguments and returns the text
 * result shown to the model. A thrown error (or rejected promise) becomes a
 * normal tool error result: the turn continues and the model sees the message.
 */
export interface RunnerTool {
  /** Model-facing tool name; unique within one runner. */
  name: string
  /** Model-facing description of what the tool does. */
  description: string
  /**
   * Keep this tool out of the initial schema. Lazy tools are listed in the
   * stable prefix as `name: description` and enter the session only through
   * {@link TOOL_SEARCH_NAME}. Core tools omit the flag.
   */
  lazy?: boolean
  /**
   * List this lazy tool in the stable prefix index; default true. A tool whose
   * set changes from one daemon start to another (an MCP server of the owner)
   * sets false: the turn tail describes it instead, so the cached prefix does
   * not move when a server is added or removed.
   */
  indexed?: boolean
  /**
   * Let `tool_search` load this lazy tool into the current session even on a
   * route that declares its tool list only at request start. The addition
   * starts a new request series there (one prefix cache miss) instead of
   * waiting for the next session. Use it for a rare tool whose whole point is
   * the turn that asked for it.
   */
  loadsMidSession?: boolean
  /**
   * Keep this tool out of the default schema of `main`. Only a session that
   * names it explicitly in {@link RunnerSession.tools} gets it; planned turns,
   * reports and wake-ups of `main` reuse the default and therefore do not.
   * Use it for a tool that authorises a narrower session (an attachment
   * analysis) and must not tempt the owner's own model with it.
   */
  optIn?: boolean
  /**
   * Model-facing description and schema of a non-owner principal when they
   * differ from the owner's. The owner's definition stays untouched; a guest
   * scope registers this variant, so no owner metadata leaks through the
   * common registry definition.
   */
  guest?: {
    description: string
    inputSchema: Record<string, unknown>
  }
  /** Raw JSON Schema for the arguments. */
  inputSchema?: Record<string, unknown>
  /** Alias accepted for `inputSchema`. */
  input_schema?: Record<string, unknown>
  /** Alias accepted for `inputSchema`. */
  schema?: Record<string, unknown>
  /** Alias accepted for `inputSchema`. */
  jsonSchema?: Record<string, unknown>
  /**
   * Explicit opt-in that makes this tool visible to a non-owner principal.
   * Absent or false is a denial: the seam is default-deny for guests, and no
   * tool of the owner is exposed to a guest by accident.
   */
  guestAllowed?: boolean
  /**
   * Pure classifier the harness asks before starting the calls of one
   * assistant step: only `true` joins the parallel pool, everything else
   * (including a throw) waits for the calls around it. Omit it for every tool
   * that writes, runs commands, sends messages, changes the bot or may ask the
   * owner: such a tool is a barrier. A read-only tool opts in with a function
   * that answers from its arguments, so a call that writes (a `web_fetch` with
   * `save`) stays in turn while its read-only siblings still overlap.
   */
  isConcurrencySafe?: (args: unknown) => boolean
  /** Execute one accepted call and return the text result. */
  execute(args: Record<string, unknown>, context?: RunnerToolContext): unknown | Promise<unknown>
}

/**
 * Decision returned by {@link BeforeTool}.
 *
 * `true`/`undefined` allow the call; `false` denies it. An object denies when
 * it names a deny verdict (`kind`/`verdict`/`decision`) or sets
 * `allow`/`allowed` to `false`; `reason` is then shown to the model.
 */
export type BeforeToolResult =
  | boolean
  | void
  | {
      allow?: boolean
      allowed?: boolean
      kind?: string
      verdict?: string
      decision?: string
      reason?: string
    }

/** Context handed to {@link BeforeTool} for one call. */
export interface BeforeToolContext {
  /**
   * Durable session that requested the call (`main` for the owner chat, a guest
   * id for guest chats). Undefined only for an agent-less registry dispatch,
   * which the model loop never produces.
   */
  readonly sessionId?: string
  /**
   * Parent session of a delegated child. Undefined for every other session.
   * The app uses it to inherit turn-scoped restrictions (the Xiaozhi column)
   * into the child, which has a session id of its own.
   */
  readonly parentSessionId?: string
}

/** Gate called before every model-requested tool invocation. */
export type BeforeTool = (
  name: string,
  args: Record<string, unknown>,
  context: BeforeToolContext,
) => BeforeToolResult | Promise<BeforeToolResult>

/** Accounting of one model call, as the harness reported it. Counts are disjoint. */
export interface RunnerUsage {
  /** When the call settled, Unix epoch milliseconds from the session event. */
  at: number
  /** Durable session that made the call (`main` for the owner chat). */
  sessionId: string
  /** Provider model id exactly as the adapter reported it. */
  model: string
  /** Uncached input tokens. */
  inputTokens: number
  /** Input tokens served from the provider cache (0 when not reported). */
  cacheReadTokens: number
  /** Input tokens written to the provider cache (0 when not reported). */
  cacheWriteTokens: number
  outputTokens: number
}

/** Receives one record per model call; a throw here never breaks the turn. */
export type UsageSink = (usage: RunnerUsage) => void

export interface RunnerOptions {
  /** Harness home; all durable harness state (sessions, anonymous id) lives here. */
  dshHome: string
  /** Working directory recorded on the session and used by tools. */
  cwd: string
  /** Messages API base URL, e.g. `http://127.0.0.1:1234/anthropic`. */
  baseUrl: string
  /** API key sent as `x-api-key`. */
  apiKey: string
  /** Stable beginning of the system prompt for the default session. */
  systemPrefix: string
  /** Provider route; defaults to the official DeepSeek route. */
  provider?: string
  /** Model id; defaults to `deepseek-flash`. */
  model?: string
  /**
   * Reasoning level of the owner's `main` session; defaults to `high`.
   * Eventual setting from `/effort`: other sessions (guest, task, review,
   * child) keep the route default and are not affected by the value. A caller
   * that owns a non-main session can set its level per turn with
   * {@link RunnerSession.reasoningEffort}.
   */
  reasoningEffort?: string
  /** Tools the model may call; none by default. */
  tools?: readonly RunnerTool[]
  /** Allow/deny gate consulted before every tool call. */
  beforeTool?: BeforeTool
  /**
   * Called when a model-requested call names a tool outside its principal's
   * schema, before any handler runs. The call is denied regardless.
   */
  onToolDenied?: (event: ToolDeniedEvent) => void
  /** Called once per finished turn with the token usage of its model calls. */
  onTurnUsage?: (event: TurnUsageEvent) => void
  /**
   * Called once in the `finally` of every prompt turn, after the log has the
   * turn's events. A throw here never breaks the turn; use it to catch up a
   * derived index of the session log.
   */
  onTurnEnd?: (event: TurnEndEvent) => void
  /**
   * Called once per model call with the token split the adapter reported.
   * Unavailable cache fields arrive as 0. The sink must be synchronous and
   * must not throw; a failure is logged and the turn continues.
   */
  onUsage?: UsageSink
  /** Secret strings removed from tool results before they reach the model. */
  secrets?: readonly string[]
  /**
   * Durable notes about failed-and-fixed tool calls of the owner's turns. The
   * runner writes them; the caller reads the same file for the turn block and
   * for `/toolnotes`. Absent disables the feature.
   */
  toolNotes?: ToolNotesOptions
  /** Cap on one model-facing tool result; defaults to {@link DEFAULT_MAX_TOOL_OUTPUT_CHARS}. */
  maxToolOutputChars?: number
  /**
   * Cap on model iterations inside one turn; reaching it inserts
   * {@link FINALIZE_NOW_TEXT} and the turn must end with the model's answer.
   * Defaults to {@link DEFAULT_MAX_TURN_ITERATIONS}.
   */
  maxTurnIterations?: number
  /**
   * Wall-clock cap on one turn, in milliseconds; reaching it cancels the turn
   * through the harness agent, so running tools see their abort signal.
   * Defaults to {@link DEFAULT_TURN_TIMEOUT_MS}.
   */
  turnTimeoutMs?: number
}

/** Code-unit name comparison: identical ordering on every machine. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable, deterministic JSON projection used for tool parameter schemas. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item))
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) result[key] = canonicalJson(source[key])
    return result
  }
  return value
}

function toolParameters(tool: RunnerTool): Record<string, unknown> {
  const schema = tool.inputSchema ?? tool.input_schema ?? tool.schema ?? tool.jsonSchema
  if (schema === undefined) return { type: 'object', properties: {} }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`tool "${tool.name}" input schema must be a JSON Schema object`)
  }
  return canonicalJson(schema) as Record<string, unknown>
}

/** One-line form of a description: the prefix index keeps one tool per line. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Stable index of the lazy tools a session may load. It names every candidate
 * that opts into the index (enabled or not) so enabling a tool never changes
 * the cached prefix bytes. A tool whose set varies between daemon starts keeps
 * out (`indexed: false`) and is described by the turn tail instead.
 */
function lazyIndexText(tools: readonly RunnerTool[]): string {
  if (tools.length === 0) return ''
  const lines = [...tools]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((tool) => `${tool.name}: ${sliceText(oneLine(tool.description), LAZY_INDEX_DESCRIPTION_CHARS)}`)
  return ['Ленивые инструменты (подключаются через tool_search):', ...lines].join('\n')
}

/** Append the lazy-tool index to a session prefix, keeping the prefix itself intact. */
function prefixWithLazyIndex(prefix: string, tools: readonly RunnerTool[]): string {
  const index = lazyIndexText(tools)
  if (index === '') return prefix
  return prefix.length === 0 ? index : `${prefix}\n\n${index}`
}

/** Names a session may see immediately and the lazy names it may load. */
interface SessionToolPolicy {
  /** Globally registered tool names this session may see and call. */
  readonly globalAllow: readonly string[]
  /** Lazy tool names this session is authorised to load. */
  readonly canEnable: ReadonlySet<string>
  /**
   * Lazy tools listed in the stable prefix index of this session. Usually the
   * same set as {@link canEnable}; a review session lists the index of main
   * while it may enable nothing, so its system prompt stays byte-identical.
   */
  readonly indexed: ReadonlySet<string>
  /** Lazy tools the caller explicitly requested for the first prompt. */
  readonly initialLazy: readonly string[]
}

/** Per-session lazy-tool state, fixed when the session is first opened. */
interface LazySessionState {
  readonly agentCtx: Context
  readonly session: Session
  readonly policy: SessionToolPolicy
  /** Principal of this session; a non-owner gets the guest tool variant. */
  readonly principal?: TurnPrincipal
  /** Lazy tools the model may currently call in this session. */
  readonly enabled: Set<string>
  /** Lazy definitions already registered in this agent scope. */
  readonly registered: Set<string>
  /** Disposer of each registered lazy definition; a tool-free turn lifts them for its duration. */
  readonly unregister: Map<string, () => void>
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '' : text
  } catch {
    return String(value)
  }
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  // Longest first so a secret containing another secret is removed whole.
  const ordered = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length)
  for (const secret of ordered) result = result.split(secret).join(SECRET_MARKER)
  return result
}

/**
 * The name of the interactive browser tool. Its `text` / `value` / `key` arguments can be
 * a password or a card number, and the harness records the model's arguments
 * before the tool runs, so the session log is the one place that must know the
 * rule without asking the page.
 */
const BROWSER_TOOL_NAME = 'browser'

/** What replaces a value-bearing argument of a browser call in the session log. */
const MASKED_BROWSER_ARGUMENT = '[redacted]'

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The action of one browser call; a call with only `url` is the legacy `open`. */
function browserActionOf(args: Record<string, unknown>): string {
  if (typeof args.action === 'string' && args.action.trim() !== '') return args.action.trim()
  return typeof args.url === 'string' ? 'open' : ''
}

/**
 * Mask the value-bearing arguments of a browser call. The model arguments are
 * saved before execution, when the tool has not yet looked at the field, so
 * every `text` of type/fill, `value` of select and character key of press is masked: this is
 * stricter than "only password / cc-* fields" and cannot miss a protected one.
 * The mask keeps the JSON valid, so replay and the next prompt still see a call.
 */
function maskBrowserArguments(raw: unknown): unknown {
  if (typeof raw === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    if (!isJsonRecord(parsed)) return raw
    const action = browserActionOf(parsed)
    if (action !== 'type' && action !== 'fill' && action !== 'press' && action !== 'select') return raw
    return JSON.stringify(maskBrowserArguments(parsed))
  }
  if (!isJsonRecord(raw)) return raw
  const action = browserActionOf(raw)
  const copy: Record<string, unknown> = { ...raw }
  if ((action === 'type' || action === 'fill') && typeof copy.text === 'string') {
    copy.text = MASKED_BROWSER_ARGUMENT
  }
  if (action === 'select' && (typeof copy.value === 'string' || typeof copy.value === 'number')) {
    copy.value = MASKED_BROWSER_ARGUMENT
  }
  if (action === 'press' && typeof copy.key === 'string' && keyInsertsText(copy.key)) {
    copy.key = MASKED_BROWSER_ARGUMENT
  }
  return copy
}

/**
 * Collect the ids of the browser calls of one assistant message and mask the
 * arguments of their tool-call blocks. A tool-call block of the browser is the
 * only place a model can hand this tool a value.
 */
function maskBrowserCallBlocks(value: unknown, ids: Set<string>, seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) maskBrowserCallBlocks(item, ids, seen)
    return
  }
  if (!isJsonRecord(value) || seen.has(value)) return
  seen.add(value)
  if (value.type === 'tool-call' && value.name === BROWSER_TOOL_NAME) {
    if (typeof value.id === 'string') ids.add(value.id)
    value.arguments = maskBrowserArguments(value.arguments)
  }
  for (const inner of Object.values(value)) maskBrowserCallBlocks(inner, ids, seen)
}

/**
 * Mask the argument fragments of the recorded assistant stream as well: the
 * compact `tool-call-chunks` run and a raw `tool-call-delta` carry the same
 * JSON, and a reader of the durable attempt must not find the secret there.
 */
function maskBrowserStream(value: unknown, masked: ReadonlyMap<string, string>, used: Set<string>, seen: Set<unknown>): void {
  if (Array.isArray(value)) {
    for (const item of value) maskBrowserStream(item, masked, used, seen)
    return
  }
  if (!isJsonRecord(value) || seen.has(value)) return
  seen.add(value)
  const id = typeof value.id === 'string' ? value.id : undefined
  if (id !== undefined && masked.has(id)) {
    const replacement = used.has(id) ? '' : (masked.get(id) as string)
    used.add(id)
    if (value.type === 'tool-call-chunks' && Array.isArray(value.args)) value.args = [replacement]
    if (value.type === 'tool-call-delta' && typeof value.argumentsDelta === 'string') value.argumentsDelta = replacement
  }
  for (const inner of Object.values(value)) maskBrowserStream(inner, masked, used, seen)
}

/**
 * Whether one event graph carries a tool-call block of the browser. The clone
 * of a message with a long reasoning stream is avoided for every other call.
 */
function hasBrowserCall(value: unknown, seen: Set<unknown>): boolean {
  if (Array.isArray(value)) return value.some((item) => hasBrowserCall(item, seen))
  if (!isJsonRecord(value) || seen.has(value)) return false
  seen.add(value)
  if (value.type === 'tool-call' && value.name === BROWSER_TOOL_NAME) return true
  return Object.values(value).some((inner) => hasBrowserCall(inner, seen))
}

/**
 * A failed or aborted model attempt carries argument fragments but no assembled
 * message. The tool never ran, so the whole browser argument is dropped: there
 * is nothing to replay and nothing of a secret may stay in the attempt record.
 */
function maskBrowserSessionEvent(type: string, data: unknown): unknown {
  if (type === 'tool/call') {
    if (!isJsonRecord(data) || data.name !== BROWSER_TOOL_NAME) return data
    return { ...data, arguments: maskBrowserArguments(data.arguments) }
  }
  if (type === 'assistant/attempt') {
    if (!isJsonRecord(data)) return data
    const ids = new Set<string>()
    const scan = (value: unknown, seen: Set<unknown>): void => {
      if (Array.isArray(value)) {
        for (const item of value) scan(item, seen)
        return
      }
      if (!isJsonRecord(value) || seen.has(value)) return
      seen.add(value)
      const name = value.type === 'tool-call-chunks' ? value.name : value.type === 'tool-call-delta' ? value.name : undefined
      if (name === BROWSER_TOOL_NAME && typeof value.id === 'string') ids.add(value.id)
      for (const inner of Object.values(value)) scan(inner, seen)
    }
    scan(data, new Set<unknown>())
    if (ids.size === 0) return data
    const copy = structuredClone(data) as Record<string, unknown>
    const blank = (value: unknown, seen: Set<unknown>): void => {
      if (Array.isArray(value)) {
        for (const item of value) blank(item, seen)
        return
      }
      if (!isJsonRecord(value) || seen.has(value)) return
      seen.add(value)
      if (typeof value.id === 'string' && ids.has(value.id)) {
        if (value.type === 'tool-call-chunks' && Array.isArray(value.args)) value.args = ['']
        if (value.type === 'tool-call-delta' && typeof value.argumentsDelta === 'string') value.argumentsDelta = ''
      }
      for (const inner of Object.values(value)) blank(inner, seen)
    }
    blank(copy, new Set<unknown>())
    return copy
  }
  if (type !== 'assistant/message') return data
  if (!isJsonRecord(data) || !hasBrowserCall(data, new Set<unknown>())) return data
  const copy = structuredClone(data) as Record<string, unknown>
  const ids = new Set<string>()
  maskBrowserCallBlocks(copy, ids, new Set<unknown>())
  if (ids.size === 0) return data
  const masked = new Map<string, string>()
  const collect = (value: unknown, seen: Set<unknown>): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, seen)
      return
    }
    if (!isJsonRecord(value) || seen.has(value)) return
    seen.add(value)
    if (value.type === 'tool-call' && value.name === BROWSER_TOOL_NAME && typeof value.id === 'string') {
      const args = typeof value.arguments === 'string' ? value.arguments : JSON.stringify(value.arguments ?? {})
      let action = ''
      try {
        const parsed: unknown = JSON.parse(args)
        if (isJsonRecord(parsed)) action = browserActionOf(parsed)
      } catch {
        action = ''
      }
      // Only a call that could carry a value needs its streamed fragments
      // rewritten; an `open` keeps its original attempt bytes.
      if (action === 'type' || action === 'fill' || action === 'press' || action === 'select') masked.set(value.id, args)
    }
    for (const inner of Object.values(value)) collect(inner, seen)
  }
  collect(copy, new Set<unknown>())
  maskBrowserStream(copy, masked, new Set<string>(), new Set<unknown>())
  return copy
}

/** An event graph is plain JSON: only plain objects and arrays are walked, bytes and class instances stay as they are. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isJsonRecord(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** The secrets in a string, raw or JSON-escaped, replaced; the same string when none occurs. */
function maskSessionString(text: string, secrets: readonly string[]): string {
  return redactToolNoteText(text, secrets)
}

/** Mask every string of one event graph; an untouched subtree keeps its identity. */
function maskSessionValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return maskSessionString(value, secrets)
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item) => {
      const masked = maskSessionValue(item, secrets)
      if (masked !== item) changed = true
      return masked
    })
    return changed ? items : value
  }
  if (!isPlainRecord(value)) return value
  let changed = false
  const entries = Object.entries(value).map(([name, item]) => {
    const key = maskSessionString(name, secrets)
    const masked = maskSessionValue(item, secrets)
    if (key !== name || masked !== item) changed = true
    return [key, masked] as const
  })
  return changed ? Object.fromEntries(entries) : value
}
/**
 * The streamed fragments of a record, if it is one: the arguments of a call
 * (grouped by call id) or the text and reasoning of a content block (grouped by
 * block index). The key names the run of fragments that joins into one value.
 */
function streamFragmentsOf(value: Record<string, unknown>): { key: string; parts: string[] } | undefined {
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every((part) => typeof part === 'string')
  if (value.type === 'text-chunks' || value.type === 'reasoning-chunks') {
    return typeof value.index === 'number' && strings(value.texts) ? { key: `${value.type}:${value.index}`, parts: value.texts } : undefined
  }
  if (typeof value.id !== 'string') return undefined
  if (value.type === 'tool-call-chunks' && strings(value.args)) return { key: `call:${value.id}`, parts: value.args }
  if (value.type === 'tool-call-delta' && typeof value.argumentsDelta === 'string') {
    return { key: `call:${value.id}`, parts: [value.argumentsDelta] }
  }
  return undefined
}

/** Walk the fragment records of one graph in stream order. */
function visitStreamFragments(value: unknown, visit: (record: Record<string, unknown>, key: string, parts: string[]) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitStreamFragments(item, visit)
    return
  }
  if (!isPlainRecord(value)) return
  const fragments = streamFragmentsOf(value)
  if (fragments !== undefined) visit(value, fragments.key, fragments.parts)
  for (const inner of Object.values(value)) visitStreamFragments(inner, visit)
}

/** Store the masked text in a fragment record; false when the record has no fragment to carry it. */
function storeFragmentText(record: Record<string, unknown>, text: string, carries: boolean): boolean {
  if (record.type === 'tool-call-chunks') record.args = [text]
  else if (record.type === 'tool-call-delta') record.argumentsDelta = text
  else {
    // text and reasoning keep one entry per timing offset
    const texts = record.texts as string[]
    if (carries && texts.length > 0) record.texts = texts.map((_, at) => (at === 0 ? text : ''))
    else {
      record.texts = texts.map(() => '')
      return false
    }
  }
  return true
}

/**
 * A secret in the arguments of a call, in the text or in the reasoning of the
 * model can be cut between stream fragments, and no fragment holds it whole.
 * The fragments of one run are joined, and when the join carries a secret the
 * masked text goes to its first fragment and the others are emptied, so no run
 * of fragments joins back to the value.
 */
function maskSplitStreamFragments(data: unknown, secrets: readonly string[]): unknown {
  const joined = new Map<string, string>()
  visitStreamFragments(data, (_record, key, parts) => {
    joined.set(key, (joined.get(key) ?? '') + parts.join(''))
  })
  const replacement = new Map<string, string>()
  for (const [key, text] of joined) {
    const masked = maskSessionString(text, secrets)
    if (masked !== text) replacement.set(key, masked)
  }
  if (replacement.size === 0) return data
  const copy = structuredClone(data)
  const used = new Set<string>()
  visitStreamFragments(copy, (record, key) => {
    const masked = replacement.get(key)
    if (masked === undefined) return
    const carried = used.has(key)
    if (storeFragmentText(record, carried ? '' : masked, !carried)) used.add(key)
  })
  return copy
}

/**
 * Whatever the session log keeps must not carry a secret: the vault values and
 * the stored sign-ins of the providers. A provider error text can quote the
 * request's key, and the model can paste a secret into the arguments of a
 * call, so every event is masked on its stored copy only.
 */
function maskSessionSecrets(data: unknown, secrets: readonly string[]): unknown {
  const active = secrets.filter((secret) => secret.length > 0)
  if (active.length === 0) return data
  return maskSplitStreamFragments(maskSessionValue(data, active), active)
}

const shieldedSessions = new WeakSet<object>()

/**
 * Route every append of one session through {@link maskBrowserSessionEvent}
 * and {@link maskSessionSecrets}.
 * A model call and its `tool/call` are durable before the tool runs, so this is
 * the only place that can keep a password out of the session log without
 * delaying the tool: the mask is applied to the stored copy, not to the live
 * arguments the harness dispatches.
 */
function shieldBrowserArguments(session: Session, secrets: () => readonly string[]): void {
  if (shieldedSessions.has(session)) return
  shieldedSessions.add(session)
  const original = session.append.bind(session) as (...args: unknown[]) => SessionEvent
  const shielded = (type: string, data: unknown, ...rest: unknown[]): SessionEvent =>
    original(type, maskSessionSecrets(maskBrowserSessionEvent(type, data), secrets()), ...rest)
  ;(session as unknown as { append: typeof shielded }).append = shielded
}

/**
 * Intrinsic pixel size of a PNG or JPEG. Only the two header fields are read;
 * an unknown container falls back to a 1×1 hint, the bytes stay untouched.
 */
function imageDimensions(data: Uint8Array, mediaType: string): { width: number; height: number } {
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (mediaType === 'image/png' && view.length >= 24 && view.readUInt32BE(0) === 0x89504e47) {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
  }
  if (mediaType === 'image/jpeg' && view.length > 4 && view[0] === 0xff && view[1] === 0xd8) {
    let at = 2
    while (at + 9 < view.length) {
      if (view[at] !== 0xff) {
        at += 1
        continue
      }
      const marker = view[at + 1] as number
      const length = view.readUInt16BE(at + 2)
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: view.readUInt16BE(at + 7), height: view.readUInt16BE(at + 5) }
      }
      at += 2 + Math.max(length, 2)
    }
  }
  return { width: 1, height: 1 }
}

/** Cut at `end` without leaving half of a surrogate pair in the returned prefix. */
function sliceText(text: string, end: number): string {
  if (end <= 0 || end >= text.length) return text.slice(0, end)
  const last = text.charCodeAt(end - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end)
}

// The frame of untrusted data in tool results (packages/app/src/untrusted-frame.ts,
// tools-web, tools-browser): every tool removes the boundary word from the data,
// so an opening line found here is a real frame of the tool.
const FRAME_OPENING = /<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"\n]+)">>>\n/g
// A short trailer after a cut frame (the next offset of an exec page, the
// note of host_exec) is the tool's own text and stays after the closing line.
const FRAME_TRAILER_LIMIT = 2_000

interface FrameSpan {
  /** Index of the opening line. */
  readonly start: number
  /** Earliest cut inside the frame: the end of its notice line. */
  readonly body: number
  /** Index of the newline before the closing line. */
  readonly close: number
  /** Index right after the closing line. */
  readonly end: number
}

/** The frame that the cut at `at` falls into, if any. */
function frameAt(text: string, at: number): FrameSpan | undefined {
  for (const match of text.matchAll(FRAME_OPENING)) {
    const start = match.index ?? 0
    if (start >= at) return undefined
    const opened = start + match[0].length
    const closing = `\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${match[1]}">>>`
    const close = text.indexOf(closing, opened - 1)
    if (close < 0) continue
    const end = close + closing.length
    // The notice line of the frame is kept whole when the data is cut.
    const notice = text.indexOf('\n', opened)
    const body = notice >= 0 && notice < close ? notice : opened
    if (at < end) return { start, body, close, end }
  }
  return undefined
}

/**
 * Cap one tool result to `limit` characters. A cut inside a frame of untrusted
 * data shortens the data only: the cut note and the closing line with the same
 * id stay, so the rest of the result is never read as a continuation of the
 * frame and the model still sees where the foreign data ends.
 */
export function limitToolOutput(text: string, limit: number): string {
  if (text.length <= limit) return text
  const noteFor = (kept: number): string => `\n…[вывод обрезан: показано ${kept} из ${text.length} символов]`
  const keptFor = (room: number): { kept: number; note: string } => {
    let kept = Math.max(0, room - noteFor(0).length)
    kept = Math.max(0, room - noteFor(kept).length)
    return { kept, note: noteFor(kept) }
  }
  const { kept, note } = keptFor(limit)
  if (note.length >= limit) return note.slice(0, limit)
  const frame = frameAt(text, kept)
  if (frame === undefined) return sliceText(text, kept) + note
  const closing = text.slice(frame.close, frame.end)
  const rest = text.slice(frame.end)
  const trailer = rest.length <= FRAME_TRAILER_LIMIT ? rest : ''
  for (const tail of trailer === '' ? [''] : [trailer, '']) {
    const cut = Math.min(keptFor(limit - closing.length - tail.length).kept, frame.close)
    if (cut >= frame.body) return sliceText(text, cut) + noteFor(cut) + closing + tail
  }
  // No room for any data: the whole frame goes, never its opening line alone.
  const before = text.slice(0, frame.start).replace(/\n$/, '')
  return sliceText(before, kept) + noteFor(Math.min(kept, before.length))
}

/** Redact and cap one normalized tool result, including registry-generated errors. */
function finalizeModelContent(
  content: readonly ContentBlock[],
  secrets: readonly string[],
  limit: number,
): ContentBlock[] | undefined {
  if (content.length === 0) return undefined
  // Runner tools declare text results, so the model-facing projection is one text block.
  let text = ''
  for (const block of content) if (block.type === 'text') text += block.text
  return [{ type: 'text', text: limitToolOutput(redactSecrets(text, secrets), limit) }]
}

function denyReason(decision: BeforeToolResult): string | undefined {
  if (decision === undefined || decision === null) return undefined
  if (typeof decision === 'boolean') return decision ? undefined : DEFAULT_DENY_REASON
  const reason =
    typeof decision.reason === 'string' && decision.reason.length > 0 ? decision.reason : DEFAULT_DENY_REASON
  const verdicts = [decision.kind, decision.verdict, decision.decision]
  if (verdicts.includes('deny')) return reason
  if (decision.allow === false || decision.allowed === false) return reason
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a caller has withdrawn the work; a separate helper keeps the check after narrowings. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The basic compaction engine refuses a replacement whose framed summary is not
 * smaller than the span it shadows. On a history with nothing to gain (already
 * short, or a summary that did not shrink the source) that is "nothing to
 * compact", not a failure of the summarizer: the owner must not see a broken
 * `/compact` for it. Any other error keeps its own classification.
 */
function compactionSummaryNotSmaller(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (/summary is not smaller than the shadowed content/i.test(current.message)) return true
    current = current.cause
  }
  return false
}

/**
 * Service turn before a summary: the model may write durable facts to the
 * memory while it still sees the full history. The turn runs on a fork of the
 * session so neither its prompt, answer nor memory call enters the owner's
 * history after the summary.
 */
const MEMORY_FLUSH_PROMPT = [
  'Историю этого разговора сейчас сожмут в краткую сводку, и подробности исчезнут.',
  'Прежде чем это произойдёт, сохрани в долговременную память (инструмент memory) только важные факты,',
  'которые пригодятся в следующих ходах: устойчивые предпочтения и правила владельца, принятые решения,',
  'важные пути и ограничения проекта.',
  'Никогда не записывай в память пароли, токены, ключи API и другие секреты: память хранится открыто и попадает в промпты.',
  'Не пересказывай разговор, не выполняй других действий и не выдумывай фактов.',
  'Если сохранять нечего, ответь одной короткой фразой.',
].join(' ')

/** Prefix of the throwaway session that hosts the pre-compaction service turn. */
const MEMORY_FLUSH_SESSION_PREFIX = 'compact-flush-'

/** The only tool the service turn before a compaction may execute. */
const MEMORY_FLUSH_TOOL = 'memory'

/**
 * One live generation event of a turn. The caller turns text deltas into a
 * streaming Telegram message and shows the running tool name as a status.
 */
export type RunnerStreamEvent =
  | { type: 'assistant-start' }
  | { type: 'text'; text: string }
  /** `arguments` is the raw JSON string the model sent, so the caller can summarize it. */
  | { type: 'tool-start'; name: string; arguments?: string }
  | { type: 'tool-end'; name: string }

/** Receives live generation events of one turn; failures never break the turn. */
export type RunnerStreamSink = (event: RunnerStreamEvent) => void

/** One raster image of a user message. */
export interface RunnerImageInput {
  data: Uint8Array
  /** One of the attachment media types the harness accepts. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name?: string
}

/**
 * A tool answer that carries pictures. A tool returns this shape instead of a
 * string when it wants the model to see the image on the next step of the same
 * turn: the runner defers a user message with the bytes, so the tool result
 * itself stays a short text. Only the bytes, the media type and the optional
 * name cross the seam; the runner stores them in the turn attachment provider.
 */
export interface RunnerImageAnswer {
  /** Short text result shown to the model beside the picture. */
  readonly text: string
  /** At least one image; each is sent as an image block of the next request. */
  readonly images: readonly RunnerImageInput[]
}

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** Whether a tool returned {@link RunnerImageAnswer} rather than a plain value. */
function isRunnerImageAnswer(value: unknown): value is RunnerImageAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const answer = value as { text?: unknown; images?: unknown }
  if (typeof answer.text !== 'string' || !Array.isArray(answer.images) || answer.images.length === 0) return false
  return answer.images.every((image: unknown) => {
    if (image === null || typeof image !== 'object') return false
    const entry = image as { data?: unknown; mediaType?: unknown }
    return (
      entry.data instanceof Uint8Array &&
      entry.data.byteLength > 0 &&
      typeof entry.mediaType === 'string' &&
      IMAGE_MEDIA_TYPES.has(entry.mediaType)
    )
  })
}

/**
 * One delegated task for {@link Runner.runChild}. The child is a fresh agent in
 * this process: no parent history, its own session, the flash model and only
 * the requested subset of the parent tools.
 */
export interface RunnerChildRequest {
  /** Self-contained task of the child. */
  task: string
  /**
   * Session whose tool call delegated the task. The child inherits that
   * session's principal, and a non-owner parent is refused before the child
   * starts. {@link Runner.runChild} refuses a request without it: delegation is
   * only an owner-session capability and must be tied to a live parent.
   */
  parentSessionId?: string
  /** Parent tools the child may use; every other name is dropped. */
  tools?: readonly string[]
  /** Name of the agent profile the child runs in; journal and result only. */
  agent?: string
  /**
   * Instructions of that profile, appended to the child system prompt. They
   * shape the child's role but never replace its fixed subagent rules.
   */
  instructions?: string
  /**
   * Model id of the profile; defaults to {@link CHILD_MODEL}. A profile may
   * ask for flash or pro, so the caller resolves the choice to a model id.
   */
  model?: string
  /** Cancellation of the parent turn; aborting it cancels the child too. */
  signal?: AbortSignal
  /** Iteration cap of this child; defaults to {@link DEFAULT_CHILD_MAX_ITERATIONS}. */
  maxIterations?: number
  /** Wall-clock cap of this child; defaults to {@link DEFAULT_CHILD_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Settlement of one delegated child turn. */
export interface RunnerChildResult {
  /** Final answer of the child; empty when it was stopped. */
  text: string
  /** Set when the child was cancelled instead of answering. */
  aborted?: TurnAbortCause
  /** Failure text when the child turn ended with an error. */
  error?: string
}

/** Selects the conversation a prompt belongs to. */
export interface RunnerSession {
  /** Durable session id; each principal uses its own. Defaults to `main`. */
  sessionId?: string
  /**
   * Who owns this turn, set by the app from the chat id. When present the seam
   * is default-deny: a non-owner principal sees only tools explicitly marked
   * `guestAllowed`, whatever the session asks for. Omitted keeps the legacy
   * per-session contract for embedders (main gets every tool, others none).
   */
  principal?: TurnPrincipal
  /** System prompt for this session; defaults to the runner `systemPrefix`. */
  systemPrefix?: string
  /**
   * Give this session the tool set of `main` while keeping its own history:
   * every eager owner tool, `tool_search` and the lazy index, with the same
   * opt-in exclusions. Used by an external owner channel (the Xiaozhi column)
   * that must be able to do what a wake-up turn does without becoming the
   * `main` session. Ignored for a non-owner principal and when `tools` is
   * explicit; the first prompt that opens a session fixes the set.
   */
  ownerTools?: boolean
  /**
   * Hide every tool schema for this turn only while keeping the session and
   * its history. The OpenAI column asks for this with `tool_choice: "none"`:
   * the model answers the accumulated conversation but cannot act again. The
   * restriction is lifted when the turn settles, so the next turn sees the
   * session's usual tools.
   */
  noTools?: boolean
  /**
   * Names of registered tools this session may see and call. A lazy name is
   * loaded immediately for this session. Omitted means "core tools" for
   * {@link MAIN_SESSION_ID} with every lazy tool still loadable through
   * `tool_search`, and "none" for every other session, so a guest never
   * inherits the owner's capabilities by default. The first prompt that opens
   * a session fixes its set. For a non-owner principal this list can only
   * narrow the `guestAllowed` set.
   */
  tools?: readonly string[]
  /**
   * List every lazy tool of the runner in the stable prefix index of this
   * session even when {@link tools} does not allow the session to enable any of
   * them. The experience review reuses the system prompt of main byte for byte
   * this way, while its own tool list stays the review whitelist and
   * `tool_search` can enable nothing. A guest never gets the owner's index.
   */
  includeLazyIndex?: boolean
  /**
   * Images attached to this user message. They are stored in an in-memory
   * attachment provider of the runner (never on the shared host filesystem)
   * and reach a vision model as native image blocks.
   */
  images?: readonly RunnerImageInput[]
  /**
   * Live events of this turn: text deltas as the model writes and the start/end
   * of each tool call. Delivered synchronously from the harness stream, so the
   * sink must not block; a throwing sink is ignored.
   */
  onStream?: RunnerStreamSink
  /**
   * Model id of this session, overriding the runner model. It is fixed when the
   * session is opened: reopening the same id keeps the first model. Used by a
   * one-shot side question that must run on flash whatever model `main` uses.
   */
  model?: string
  /**
   * Reasoning effort of this non-main session for this and later turns; omit
   * to keep the model default. `main` ignores it: its level belongs to the
   * owner's `/effort`. A level the current model does not offer is dropped by
   * the runner before the request, so the turn still runs on the model default.
   */
  reasoningEffort?: string
  /**
   * Delete the session after this turn: a transient session leaves no history.
   * `sessionId` must be unique to the caller's own one-shot conversation and
   * consist of letters, digits, dot, dash and underscore only; the owner id
   * `main`, a guest id (`guest-…`) and a child id (`subagent-…`) are refused
   * before the session is opened. The runner flushes and disposes the agent and
   * removes the session directory, which is proven to lie inside `sessions`.
   */
  transient?: boolean
}

/** Why a turn ended early instead of producing its answer. */
export type TurnAbortCause = 'stop' | 'timeout'

/** Result of one turn: either its text reply or the cancellation that ended it. */
export interface TurnOutcome {
  /** Reply text; empty when the turn was cancelled. */
  text: string
  /** Set when the turn was cancelled before the model produced its answer. */
  aborted?: TurnAbortCause
  /**
   * Token usage of the model calls this turn paid for, with the model route it
   * was billed on. Absent when the turn made no completed model call. The
   * boundary is the session log at the moment the turn started, so a planned
   * or wake-up turn that overlapped in queue never leaks into this number.
   */
  usage?: TurnUsageEvent
}

/** Snapshot of one session used by the owner's `/status` command. */
export interface RunnerSessionStats {
  /** Durable session id (`main` for the owner). */
  sessionId: string
  /** Messages on the model-visible surface, system prompt excluded. */
  messages: number
  /** Token-meter estimate of the current context. */
  tokens: number
  /** Tool names of the session's schema, sorted for a stable report. */
  tools: readonly string[]
}

/** Token composition of one session's next request, measured without a model call. */
export interface RunnerContextReport {
  /** Heuristic tokens of the system prompt (charter, identity, rules, lazy index). */
  systemTokens: number
  /** Heuristic tokens of the tool schemas of the newest request envelope. */
  toolsTokens: number
  /** Heuristic tokens of the visible history, system prompt excluded. */
  historyTokens: number
  /** Unix epoch milliseconds of the last completed summary, when the session has one. */
  lastCompactionAt?: number
}

/** One line of the owner's export: a human turn or a short tool call. */
export interface RunnerTranscriptEntry {
  role: 'owner' | 'bot' | 'tool'
  text: string
}

/** Result of one manual `/compact` run. */
export interface RunnerCompaction {
  /** Context estimate before the compaction, in tokens. */
  beforeTokens: number
  /** Context estimate after the compaction, in tokens. */
  afterTokens: number
  /** True when the backend replaced a history span with a summary. */
  compacted: boolean
  /**
   * True when there was nothing to gain: the history is already short or the
   * summary would not be smaller than its source. Callers report it as an
   * ordinary "nothing to compact" answer, never as a failure.
   */
  noGain: boolean
  /** Summary text when a summary was written. */
  summary: string
}

/**
 * Outcome of the automatic context check before an owner turn. The check runs
 * on the `main` session only: the owner's turn is the point where a compaction
 * can never race a live turn, a wake-up or a child.
 */
export interface RunnerAutoCompaction {
  /**
   * `none` when the session is under the threshold, `pruned` when cleaning old
   * tool results alone brought it back under, `compacted` when a summary was
   * written, `failed` when a stage failed and the session stayed usable, and
   * `interrupted` when the caller withdrew the check before it finished (the
   * history keeps no summary of that attempt).
   */
  outcome: 'none' | 'pruned' | 'compacted' | 'failed' | 'interrupted'
  /** Context size in tokens before the check, the same figure `/context` adds up. */
  beforeTokens: number
  /** Context size in tokens after the check. */
  afterTokens: number
  /** Failure text when `outcome` is `failed`; journal-side detail only. */
  error?: string
}

/** One model the mounted LLM adapter advertises for a connected provider. */
export interface RunnerModelInfo {
  provider: string
  id: string
  name: string
}

/** How an owner signs in to one provider route. */
export interface RunnerProviderMethod {
  /** Flow-owned identifier, passed back to {@link Runner.connectProvider}. */
  id: string
  /** `api-key` asks for a key; `oauth` opens the provider's browser sign-in. */
  kind: 'api-key' | 'oauth'
  /** Label the provider screen shows for this method. */
  label: string
}

/** One connectable provider route and whether a sign-in is already stored. */
export interface RunnerProviderInfo {
  id: string
  name: string
  /** True when the credential store holds a record for this route. */
  connected: boolean
  methods: RunnerProviderMethod[]
}

/**
 * The surface that talks to the owner during one sign-in. Its prompts reach
 * exactly the caller that started the attempt; anything it does not answer is
 * a refusal, so a headless caller can pass an interaction that declines.
 */
export interface ProviderInteraction {
  /** Ask the owner for a secret, a code or a choice; `undefined` is a refusal. */
  prompt(request: ProviderPrompt): Promise<string | undefined>
  /**
   * Report progress or tell the owner where to continue. A device code is its
   * own field: a surface renders the page as a link and the code for copying,
   * rather than folding both into one line.
   */
  notify(notice: ProviderNotice): void
  /** Withdraws the whole attempt, including a prompt the owner is answering. */
  signal?: AbortSignal
}

/** One notice of a sign-in flow, in the vocabulary of `dsh-authorization`. */
export interface ProviderNotice {
  /** What is happening, or what the human must do next. */
  message: string
  /** A page the human must open to continue. */
  url?: string
  /** A short code the human must enter on that page. */
  code?: string
}

/** One question of a sign-in, in the vocabulary of `dsh-authorization`. */
export interface ProviderPrompt {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

/** Outcome of one provider sign-in. */
export interface ProviderConnectResult {
  /**
   * `connected` when the credential record is committed, `cancelled` when the
   * owner declined or the caller withdrew, `failed` for a broken provider flow.
   */
  status: 'connected' | 'cancelled' | 'failed'
}

export interface Runner {
  /**
   * Every model advertised by the providers the LLM adapter of this runner has
   * registered. The embedded factory reads this catalogue instead of a list
   * hardcoded in the bot. No request is made.
   */
  models(): Promise<RunnerModelInfo[]>
  /**
   * Routes the owner can connect, exactly {@link PI_AI_PROVIDERS}. The official
   * DeepSeek route is not one of them: it works from `DEEPSEEK_API_KEY` alone.
   */
  providers(): Promise<RunnerProviderInfo[]>
  /**
   * Sign in to one pi-ai route through the harness authorization seam. The
   * record lands in the credential store of this runner's harness home; a
   * provider without a flow or a rejected prompt ends the attempt honestly.
   */
  connectProvider(id: string, interaction: ProviderInteraction, method?: string): Promise<ProviderConnectResult>
  /** Remove the stored sign-in of one provider; its models leave the catalogue. */
  disconnectProvider(id: string): Promise<void>
  /**
   * Secret values of every stored provider sign-in, for output scrubbing. The
   * agent never sees this list; it exists so a command that prints the
   * credential file still cannot return a usable key.
   */
  providerSecretValues(): Promise<string[]>
  /**
   * Reasoning levels the adapter reports for one exact model, in adapter
   * order, or `undefined` when the route advertises none. `listModels` carries
   * no capabilities, so a menu that offers per-model levels reads them here.
   */
  modelLevels(provider: string, id: string): Promise<string[] | undefined>
  /**
   * Send one user message, wait for the turn to finish and return the text reply.
   * A cancelled turn yields an empty string; use {@link promptTurn} when the
   * caller must distinguish a stop from a timeout.
   */
  prompt(text: string, session?: RunnerSession): Promise<string>
  /**
   * Same as {@link prompt} but reports why a turn was cancelled. A cancelled
   * turn leaves its running tools a fired abort signal and produces no reply.
   */
  promptTurn(text: string, session?: RunnerSession): Promise<TurnOutcome>
  /**
   * Run one delegated child turn in this process: a fresh session on
   * {@link CHILD_MODEL}, only the requested subset of the parent tools, its own
   * iteration cap and wall-clock timeout. The parent turn stays blocked on the
   * call and receives the child's answer as one result.
   *
   * Cancellation is the ordinary runner cancellation: aborting `request.signal`
   * or calling {@link cancel} with the child session id cancels the child, and
   * `/stop` of the owner reaches it through the AbortSignal of its tool call.
   */
  runChild(request: RunnerChildRequest): Promise<RunnerChildResult>
  /**
   * Hand text from the owner to the active turn of one session as a steering
   * message: the harness model sees it as an owner reply on its nearest step,
   * and the text never starts a turn of its own. A session with no live turn
   * refuses it (`false`), so the caller can serve the message as an ordinary
   * turn instead of losing or duplicating it.
   * @returns whether the live turn accepted the steering.
   */
  steer(text: string, sessionId?: string): boolean
  /**
   * Cancel the active turn of one session through the harness agent, so every
   * running tool sees its abort signal. With no active turn it is a no-op.
   * @returns whether a turn was active when the cancellation arrived.
   */
  cancel(sessionId?: string): boolean
  /**
   * Read the state of one session without a model call. An unopened session
   * reports an empty history and the session's tool schema.
   */
  stats(sessionId?: string): Promise<RunnerSessionStats>
  /**
   * Measure the composition of the next request of one session: the system
   * prompt, the tool schemas and the visible history, all in heuristic tokens,
   * plus the time of the last compaction. No model call is made.
   */
  context(sessionId?: string): Promise<RunnerContextReport>
  /**
   * Read the human turns of one session in order, plus one short entry per
   * tool call. Tool results and system/developer messages are left out: the
   * export is a readable transcript, not a wire dump.
   */
  transcript(sessionId?: string): Promise<RunnerTranscriptEntry[]>
  /**
   * Compact one idle session through the harness compaction packages. The
   * session keeps its identity and log; only the visible history is replaced by
   * a summary plus the retained tail. A history that has nothing to gain
   * reports `noGain` instead of failing.
   */
  compact(sessionId?: string): Promise<RunnerCompaction>
  /**
   * Automatic threshold check for the owner session: measure the same context
   * `/context` reports, clean old tool results first, and only then ask the
   * model for a summary. A service turn on a fork of the session gives the
   * model a chance to save durable facts to the memory before the summary; that
   * turn never becomes part of the owner's history. `threshold <= 0` switches
   * the automatic path off completely. An aborted `signal` stops the service
   * turn and the summary, so the owner's message that interrupted the idle
   * check never waits for it and no summary of that attempt is committed.
   */
  autoCompact(threshold: number, options?: { signal?: AbortSignal }): Promise<RunnerAutoCompaction>
  /**
   * Current reasoning effort of the `main` session. Read from the live runner,
   * so a change made by {@link setReasoningEffort} is visible at once.
   */
  reasoningEffort(): string
  /**
   * Change the reasoning effort of the next `main` request without restarting
   * the runner. The harness reads the level on each model operation, so the
   * running session keeps its history and other sessions keep their own level.
   */
  setReasoningEffort(level: string): void
  /** Flush every session, dispose every agent and tear the Cordis context down. */
  stop(): Promise<void>
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

/**
 * Text of the last assistant message appended after `baseline` assistant
 * messages. A turn that produced no assistant message at all also reads as
 * empty, so the nudge does not depend on how the provider encodes blank output.
 */
function turnAssistantText(
  messages: readonly { role: string; content: readonly ContentBlock[] }[],
  baseline: number,
): string {
  let seen = 0
  let last = ''
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    seen += 1
    if (seen > baseline) last = textOf(message.content)
  }
  return last
}

/** What one turn left in the log: its own reply and, when it failed, the failure text. */
interface TurnReport {
  reply: string
  failure: string | undefined
  /** Machine code of the terminal failure, when the turn ended with one. */
  failureCode?: string
  /** HTTP status of the terminal failure, when the provider reported one. */
  failureStatus?: number
  /** Attempts of the failed step: its retries plus the first request. */
  attempts: number
}

/**
 * Read the settlement of the last turn inside the captured event window. Only
 * this turn's assistant text counts: an older reply must never stand in for a
 * failed or empty turn.
 */
function inspectTurn(events: readonly SessionEvent[]): TurnReport {
  let turnStart = -1
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/start') turnStart = index
  }
  if (turnStart < 0) return { reply: '', failure: undefined, attempts: 1 }

  let reply = ''
  let failure: string | undefined
  let failureCode: string | undefined
  let failureStatus: number | undefined
  // The last scheduled retry belongs to the step that finally failed: counters
  // restart at every step start, so its `retry` index plus the first request is
  // exactly the number of attempts of that step.
  let lastRetry: number | undefined
  for (let index = turnStart; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') {
      reply = textOf(event.data.message.content)
    } else if (event?.type === 'turn/end' && event.data.reason.kind === 'error') {
      const reason = event.data.reason.error
      failure = reason.message.trim().length > 0 ? reason.message : reason.code
      failureCode = reason.code
      failureStatus = reason.status
    } else if (event !== undefined) {
      const retry = modelRetryRecordOf(event)
      if (retry !== undefined) lastRetry = retry.retry
    }
  }
  return {
    reply,
    failure,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureStatus === undefined ? {} : { failureStatus }),
    attempts: (lastRetry ?? 0) + 1,
  }
}

/** Per-session, per-turn bookkeeping of the host insertions. */
interface TurnInsertionState {
  /** Signature of the previous tool call in this turn (`name` plus canonical arguments). */
  loopSignature: string | undefined
  /** How many identical calls in a row ended with that signature. */
  loopCount: number
  /** A file-changing tool succeeded after the last fresh check. */
  edited: boolean
  /** The verify reminder already went into this turn. */
  verifyReminded: boolean
  /** The empty-turn nudge already went into this turn. */
  emptyNudged: boolean
  /** FINALIZE_NOW already went into this turn. */
  finalizeSent: boolean
  /** Assistant messages already present when this turn started. */
  assistantBaseline: number
}

function freshTurnInsertionState(): TurnInsertionState {
  return {
    loopSignature: undefined,
    loopCount: 0,
    edited: false,
    verifyReminded: false,
    emptyNudged: false,
    finalizeSent: false,
    assistantBaseline: 0,
  }
}

/**
 * Token usage of one turn: the assistant messages appended after `fromSeq`
 * carry the accounting of every model call of the turn, tool rounds included.
 */
function turnUsageFrom(events: readonly SessionEvent[]): TurnUsage | undefined {
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let seen = false
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    seen = true
    inputTokens += usage.inputTokens
    cacheReadTokens += usage.cacheReadTokens ?? 0
    cacheWriteTokens += usage.cacheWriteTokens ?? 0
    outputTokens += usage.outputTokens
  }
  return seen ? { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } : undefined
}

/** Stable signature of one tool call: name plus arguments with sorted object keys. */
function toolCallSignature(name: string, args: unknown): string {
  return `${name}\n${JSON.stringify(canonicalJson(args))}`
}

/** Notes about failed-and-fixed tool calls: where they live and how to mask them. */
export interface ToolNotesOptions {
  /** File of the notes inside `DSHBOT_HOME` (see {@link TOOL_NOTES_FILE}). */
  path: string
  /**
   * Current secret values, read on every note: a secret saved after the runner
   * started must be masked in the very same turn it was used.
   */
  secrets?: () => readonly string[]
}

/** One failed call of the current owner turn that may still be paired with a fix. */
interface PendingToolFailure {
  tool: string
  /** Normalized program of an exec call; `''` for an MCP tool. */
  subject: string
  /** First line of the error, already masked and cut. */
  error: string
  /** Canonical arguments of the failed call, for the "same call" comparison. */
  argsText: string
  /** Raw arguments of the failed call, for the changed-argument rendering. */
  args: Record<string, unknown>
  /** Raw command of a failed exec call. */
  command?: string
}

/** The only tool whose non-zero exit code is a failure without `isError`. */
const TOOL_NOTES_EXEC_TOOL = 'exec'

/**
 * Name prefix of an MCP tool (`mcp__<server>__<tool>`, see packages/tools-mcp).
 * Only an MCP tool pairs an `isError` failure with a fix: a built-in tool that
 * passes with other arguments (`skill_manage` of another name, `read` of
 * another file, `browser` with other input) did another action rather than
 * fixed the first one, and its arguments may carry whole documents or the
 * history-masked input of the browser.
 */
const TOOL_NOTES_MCP_PREFIX = 'mcp__'

/** Error output may quote an argument as JSON rather than as its raw value. */
function redactToolNoteText(text: string, secrets: readonly string[]): string {
  return redactSecrets(text, secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]))
}

/** Mask the original structure before JSON escaping can hide a secret match. */
function maskToolNoteValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactToolNoteText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => maskToolNoteValue(item, secrets))
  if (isJsonRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [redactToolNoteText(name, secrets), maskToolNoteValue(item, secrets)]),
    )
  }
  return value
}

/**
 * One already masked value of a note on one line, cut to
 * {@link TOOL_NOTE_VALUE_LIMIT}: a long document or command must not make one
 * note larger than the whole notes limit, which would drop every note.
 */
function noteLineOf(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim()
  const chars = [...line]
  return chars.length <= TOOL_NOTE_VALUE_LIMIT ? line : `${chars.slice(0, TOOL_NOTE_VALUE_LIMIT - 1).join('')}…`
}

/** Program of an exec command: its first word, without a path and version suffix. */
function execProgramOf(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? ''
  const base = first.split(/[\\/]/u).pop() ?? first
  return base.replace(/\.exe$/iu, '').replace(/[.\d]+$/u, '')
}

/** Opening line of a model-facing frame of external data. */
const DATA_FRAME_OPEN = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>$/u

/**
 * Body of the first complete frame of external data in a tool result, without
 * its boundary lines and the trusted notice. `undefined` when the result has
 * no complete frame. The notes look for the diagnostic inside the frame: the
 * opening line and the notice are service text, not the error of the tool.
 */
function framedDataBody(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => DATA_FRAME_OPEN.test(line.trim()))
  if (start < 0) return undefined
  const id = DATA_FRAME_OPEN.exec(lines[start]!.trim())?.[1]
  if (id === undefined) return undefined
  const closing = `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`
  const end = lines.findIndex((line, index) => index > start && line.trim() === closing)
  if (end < 0) return undefined
  // The line after the opening one is the trusted notice of the frame; the
  // data follows it and ends right before the matching closing line.
  return lines.slice(start + 2, end).join('\n')
}

/** First non-empty line of a tool result, preferring the body of its data frame. */
function firstErrorLine(text: string): string {
  const source = framedDataBody(text) ?? text
  const line = source.split(/\r?\n/u).map((part) => part.trim()).find((part) => part !== '') ?? ''
  return [...line].slice(0, TOOL_NOTE_ERROR_LIMIT).join('')
}

/** A service header of an exec result that separates its output streams. */
const EXEC_STREAM_HEADER = /^---\s*(stderr|stdout)\s*---$/iu

/**
 * First diagnostic line of an exec result, cut to the note limit. The status
 * line (`exit 1`) only says that the command failed, so the note keeps the
 * first non-empty line of its output instead, preferring stderr: that is what
 * tells one failed command from another. The status line remains the error
 * only when the command printed nothing at all.
 */
function execErrorLine(text: string): string {
  const lines = text.split(/\r?\n/u)
  const status = lines[0]?.trim() ?? ''
  // A timeout, an abort or a signal keeps its status line as the note: that
  // line is outside the frame, while the framed output may follow it.
  if (!/^exit\s+-?\d+$/iu.test(status)) return [...status].slice(0, TOOL_NOTE_ERROR_LIMIT).join('')
  const firstOf = (parts: string[]): string =>
    parts.map((part) => part.trim()).find((part) => part !== '') ?? ''
  const stdout: string[] = []
  const stderr: string[] = []
  let stream = stdout
  const body = framedDataBody(text) ?? lines.slice(1).join('\n')
  for (const line of body.split(/\r?\n/u)) {
    const header = EXEC_STREAM_HEADER.exec(line.trim())
    if (header !== null) {
      stream = header[1]?.toLowerCase() === 'stderr' ? stderr : stdout
      continue
    }
    stream.push(line)
  }
  const line = firstOf(stderr) || firstOf(stdout) || status
  return [...line].slice(0, TOOL_NOTE_ERROR_LIMIT).join('')
}

/** Status line of an exec result: whether it failed, passed, and the detail line. */
function execOutcomeOf(text: string): { failed: boolean; passed: boolean; line: string } | undefined {
  const first = text.split(/\r?\n/u)[0]?.trim() ?? ''
  const code = /^exit\s+(-?\d+)$/u.exec(first)
  if (code !== null) {
    const value = Number(code[1])
    return { failed: value !== 0, passed: value === 0, line: first }
  }
  if (/^(?:Таймаут:|Команда прервана|Завершено сигналом|signal\s)/u.test(first)) {
    return { failed: true, passed: false, line: first }
  }
  return undefined
}

/** A value of a tool argument as one line of a note, with secrets masked. */
function noteValueText(value: unknown, secrets: readonly string[]): string {
  if (typeof value === 'string') return noteLineOf(redactToolNoteText(value, secrets))
  if (value === undefined) return '<нет>'
  try {
    return noteLineOf(JSON.stringify(canonicalJson(maskToolNoteValue(value, secrets))) ?? String(value))
  } catch {
    return noteLineOf(redactToolNoteText(String(value), secrets))
  }
}

/**
 * The arguments that changed between the failed and the passed call, as
 * `ключ: старое → новое`. An unchanged argument (including the unchanged
 * `format` of the pair) is left out. Secrets are masked before the comparison,
 * and the whole text is cut to {@link TOOL_NOTE_CHANGE_LIMIT}.
 */
function changedArgumentsText(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  secrets: readonly string[],
): string {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const parts: string[] = []
  for (const key of keys) {
    const left = maskToolNoteValue(before[key], secrets)
    const right = maskToolNoteValue(after[key], secrets)
    const leftText = JSON.stringify(canonicalJson(left ?? null))
    const rightText = JSON.stringify(canonicalJson(right ?? null))
    if (leftText === rightText) continue
    parts.push(`${noteLineOf(redactToolNoteText(key, secrets))}: ${noteValueText(left, secrets)} → ${noteValueText(right, secrets)}`)
  }
  const text = parts.join(', ')
  const chars = [...text]
  return chars.length <= TOOL_NOTE_CHANGE_LIMIT ? text : `${chars.slice(0, TOOL_NOTE_CHANGE_LIMIT - 1).join('')}…`
}

/**
 * Start a long-lived runner: one Cordis context, one durable `main` session,
 * created on first use and resumed afterwards.
 *
 * `DSH_HOME` and `DSH_TELEMETRY_DISABLED=1` are set before the harness packages
 * resolve any path or endpoint, and `DEEPSEEK_API_KEY` carries the supplied key to
 * the API-key provider.
 */
export async function startRunner(options: RunnerOptions): Promise<Runner> {
  const provider = options.provider ?? DEEPSEEK_PROVIDER
  const model = options.model ?? DEFAULT_MODEL
  // Read by the request waterfall of `main` on every model operation, so
  // `/effort` takes effect on the next request without a runner restart.
  let mainReasoningEffort: string =
    normalizeReasoningLevel(options.reasoningEffort) ?? DEFAULT_REASONING_EFFORT
  // Per-session levels of non-main turns. `main` is deliberately absent: its
  // level is read live from `mainReasoningEffort` by `/effort`.
  const sessionReasoningEfforts = new Map<string, string>()

  process.env.DSH_HOME = options.dshHome
  process.env.DSH_TELEMETRY_DISABLED = '1'
  process.env.DEEPSEEK_API_KEY = options.apiKey

  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(options.dshHome, 'sessions') })
    await ctx.plugin(SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: options.systemPrefix,
    })
    await ctx.plugin(ToolRuntime)

    // --- user-message images ---------------------------------------------------------------
    //
    // The harness serializes an image block only through the `attachments`
    // service, and the saved history keeps just the attachment id. The provider
    // therefore asks for the bytes on every request, including the first one
    // after a daemon restart. An in-memory map alone would make a picture of an
    // earlier turn unreadable there: `readImageRequest` would throw, the adapter
    // would wrap it into TRANSPORT, and every later turn of the session would
    // fail on retries. So every picture the model sees is written under
    // `<dshHome>/images/<attachmentId>.json` and restored from there when memory
    // no longer knows it. A picture that is nowhere (for example saved before
    // this store existed) is replaced by a tiny placeholder, so the request still
    // reaches the model; the journal names that id once.
    interface StoredTurnImage {
      id: string
      data: Uint8Array
      mediaType: RunnerImageInput['mediaType']
      width: number
      height: number
      name?: string
    }
    const turnImages = new Map<string, StoredTurnImage>()
    const imageMediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
    const imageMediaTypeSet = new Set<string>(imageMediaTypes)
    const imageIdPattern = /^img_[0-9a-f]{32}$/u
    const imageDirectory = join(options.dshHome, 'images')
    const missingImageIds = new Set<string>()
    /** A 1x1 PNG that stands in for a picture whose bytes are gone. */
    const missingImage: StoredTurnImage = {
      id: 'missing',
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
      mediaType: 'image/png',
      width: 1,
      height: 1,
    }
    function imageFilePath(id: string): string {
      return join(imageDirectory, `${id}.json`)
    }
    /** Restore a previously persisted picture, verifying that the bytes still match its id. */
    function storedImageFromDisk(id: string): StoredTurnImage | undefined {
      if (!imageIdPattern.test(id)) return undefined
      try {
        const parsed: unknown = JSON.parse(readFileSync(imageFilePath(id), 'utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        const record = parsed as Record<string, unknown>
        const mediaType = record.mediaType
        const encoded = record.data
        if (typeof mediaType !== 'string' || !imageMediaTypeSet.has(mediaType) || typeof encoded !== 'string') return undefined
        const data = Buffer.from(encoded, 'base64')
        if (data.byteLength === 0 || data.byteLength > 20 * 1024 * 1024) return undefined
        const digest = createHash('sha256').update(data).digest('hex').slice(0, 32)
        if (`img_${digest}` !== id) return undefined
        const measured = imageDimensions(data, mediaType)
        const width =
          typeof record.width === 'number' && Number.isFinite(record.width) && record.width > 0
            ? record.width
            : measured.width
        const height =
          typeof record.height === 'number' && Number.isFinite(record.height) && record.height > 0
            ? record.height
            : measured.height
        return {
          id,
          data,
          mediaType: mediaType as RunnerImageInput['mediaType'],
          width,
          height,
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
        }
      } catch {
        // Absent, unreadable or malformed files are simply "not stored".
        return undefined
      }
    }
    /** Persist one picture atomically; a storage failure keeps the in-memory copy usable. */
    function persistImage(stored: StoredTurnImage): void {
      try {
        mkdirSync(imageDirectory, { recursive: true, mode: 0o700 })
        const temporary = join(imageDirectory, `${stored.id}.${randomUUID()}.tmp`)
        const record = {
          id: stored.id,
          mediaType: stored.mediaType,
          width: stored.width,
          height: stored.height,
          ...(stored.name === undefined ? {} : { name: stored.name }),
          data: Buffer.from(stored.data).toString('base64'),
        }
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
        renameSync(temporary, imageFilePath(stored.id))
      } catch (error) {
        process.stderr.write(`[dshbot] image ${stored.id}: cannot store on disk: ${errorText(error)}\n`)
      }
    }
    function imageRequestOf(
      stored: StoredTurnImage,
      attachmentId: unknown,
      target: { width?: number; height?: number },
    ): Record<string, unknown> {
      const width = Math.min(stored.width, target.width ?? stored.width)
      const height = Math.min(stored.height, target.height ?? stored.height)
      return {
        variantId: `imgvar_${stored.id}_${width}x${height}`,
        attachment: {
          attachmentId,
          mediaType: stored.mediaType,
          bytes: stored.data.byteLength,
          width: stored.width,
          height: stored.height,
          ...(stored.name === undefined ? {} : { name: stored.name }),
        },
        data: stored.data,
        mediaType: stored.mediaType,
        bytes: stored.data.byteLength,
        width,
        height,
        depth: 'uchar' as const,
        space: 'srgb' as const,
        hasAlpha: stored.mediaType === 'image/png' || stored.mediaType === 'image/gif',
      }
    }
    const imageStore = {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 10,
        maxMessageImageBytes: 60 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 10_000,
        mediaTypes: [...imageMediaTypes],
      },
      imageHostPath: (): undefined => undefined,
      fileHostPath: (): undefined => undefined,
      async readImageRequest(ref: { attachmentId: unknown }, target: { width?: number; height?: number }) {
        const id = String(ref.attachmentId)
        let stored = turnImages.get(id)
        if (stored === undefined) {
          stored = storedImageFromDisk(id)
          if (stored !== undefined) turnImages.set(id, stored)
        }
        if (stored === undefined) {
          if (!missingImageIds.has(id)) {
            missingImageIds.add(id)
            process.stderr.write(
              `[dshbot] image ${JSON.stringify(id)} is unavailable: neither in memory nor in ${imageDirectory}; replaced in the request\n`,
            )
          }
          stored = missingImage
        }
        return imageRequestOf(stored, ref.attachmentId, target)
      },
    }
    // `provide` is the public registry seam of Cordis; the typing of an
    // optional service is not declared in this package's context module.
    ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('attachments', imageStore)

    /** Store one image of this turn and return the block the model sees. */
    function imageBlockOf(image: RunnerImageInput): ContentBlock {
      const digest = createHash('sha256').update(image.data).digest('hex').slice(0, 32)
      const id = `img_${digest}`
      if (!turnImages.has(id)) {
        const size = imageDimensions(image.data, image.mediaType)
        const stored: StoredTurnImage = {
          id,
          data: image.data,
          mediaType: image.mediaType,
          width: size.width,
          height: size.height,
          ...(image.name === undefined ? {} : { name: image.name }),
        }
        turnImages.set(id, stored)
        persistImage(stored)
      }
      return {
        type: 'image',
        attachment: {
          attachmentId: id,
          mediaType: image.mediaType,
          bytes: image.data.byteLength,
          width: turnImages.get(id)?.width ?? 1,
          height: turnImages.get(id)?.height ?? 1,
          ...(image.name === undefined ? {} : { name: image.name }),
        },
      } as unknown as ContentBlock
    }

    const maxToolOutputChars = Math.floor(options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS)
    if (!Number.isFinite(maxToolOutputChars) || maxToolOutputChars <= 0) {
      throw new TypeError('maxToolOutputChars must be a positive finite number')
    }
    // The caller's API key is always a secret: provider failures love to quote it.
    const secrets = [...new Set([options.apiKey, ...(options.secrets ?? [])])].filter(
      (secret) => typeof secret === 'string' && secret.length > 0,
    )

    // Principal schema of every opened session, checked before dispatch. The app
    // declares the principal from the chat id; the model can never widen it.
    const sessionToolState = new Map<string, { principal?: TurnPrincipal; allowed: ReadonlySet<string> }>()
    // Parent of every delegated child. A child has its own session id, but the
    // calling turn's restrictions (for example the Xiaozhi column) must reach it.
    const childParents = new Map<string, string>()

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      if (sessionId === undefined) return next()
      const state = sessionToolState.get(sessionId)
      // No declared principal keeps the legacy per-session contract of embedders.
      if (state?.principal === undefined || state.allowed.has(exec.name)) return next()
      try {
        options.onToolDenied?.({ sessionId, principal: state.principal, tool: exec.name })
      } catch {
        // A reporting hook must never turn a denial into an execution.
      }
      return { kind: 'deny', reason: `инструмент "${exec.name}" недоступен принципалу "${state.principal}"` }
    })

    // Sessions whose current turn runs with `noTools`. The schema of that turn
    // is empty, so this only catches a call the model invents anyway: it is
    // refused before any policy hook or `execute` can act on it.
    const toolFreeTurns = new Set<string>()
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      if (sessionId === undefined || !toolFreeTurns.has(sessionId)) return next()
      return { kind: 'deny', reason: `в этом ходе инструменты недоступны; вызов "${exec.name}" отклонён` }
    })

    // The service turn before a compaction runs on a fork with the owner's
    // policy, so its schema (and the cached prefix) stays identical to the
    // owner's. Capability is not inherited: the only purpose of that turn is to
    // write facts to the memory, so every other call is refused here, before
    // `execute` can touch the host, a file or the mail. The refusal is an
    // ordinary tool result the model can read, and the turn goes on.
    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      if (sessionId === undefined || !sessionId.startsWith(MEMORY_FLUSH_SESSION_PREFIX)) return next()
      if (exec.name === MEMORY_FLUSH_TOOL) return next()
      return {
        kind: 'deny',
        reason: `в служебном ходе перед сжатием разрешён только инструмент "${MEMORY_FLUSH_TOOL}"; вызов "${exec.name}" отклонён`,
      }
    })

    if (options.beforeTool !== undefined) {
      const beforeTool = options.beforeTool
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        let decision: BeforeToolResult
        try {
          const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
          const parentSessionId = sessionId === undefined ? undefined : childParents.get(sessionId)
          decision = await beforeTool(exec.name, exec.arguments as Record<string, unknown>, {
            sessionId,
            ...(parentSessionId === undefined ? {} : { parentSessionId }),
          })
        } catch (error) {
          // A broken policy hook must not break the turn: report it to the model as a denial.
          return { kind: 'deny', reason: `beforeTool: ${errorText(error)}` }
        }
        const reason = denyReason(decision)
        return reason === undefined ? next() : { kind: 'deny', reason }
      })
    }

    // --- money accounting -------------------------------------------------------------------
    //
    // `assistant/message` carries the usage of exactly one completed model call
    // (the stream's final usage chunk) together with the provider model id.
    // Seed events of a resumed session never publish on `session/event`, so a
    // restart cannot replay old rows.
    if (options.onUsage !== undefined) {
      const onUsage = options.onUsage
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message') return
        const usage = event.data.usage
        if (usage === undefined) return
        try {
          onUsage({
            at: event.time,
            sessionId: String(session.id),
            model: event.data.message.source.model,
            inputTokens: usage.inputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            outputTokens: usage.outputTokens,
          })
        } catch (error) {
          // Accounting must never fail a paid call that already happened.
          ctx.logger.error(`usage sink failed: ${errorText(error)}`)
        }
      })
    }

    // --- service insertions of a turn -------------------------------------------------------
    //
    // Everything below rides in the volatile tail or inside a tool result. It never
    // touches the system prompt or the tool schemas, so the cached prefix stays
    // byte-identical between turns even when an insertion fires.
    const maxTurnIterations = Math.floor(options.maxTurnIterations ?? DEFAULT_MAX_TURN_ITERATIONS)
    if (!Number.isFinite(maxTurnIterations) || maxTurnIterations <= 0) {
      throw new TypeError('maxTurnIterations must be a positive finite number')
    }
    /** Per-child iteration caps; a delegated child has its own, tighter limit. */
    const childIterationLimits = new Map<string, number>()
    const turnTimeoutMs = Math.floor(options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
    if (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) {
      throw new TypeError('turnTimeoutMs must be a positive finite number')
    }
    const turnStates = new Map<string, TurnInsertionState>()
    /**
     * Failed calls of the current turn, by session: a later success of the same
     * tool with other arguments is the evidence that the arguments were wrong.
     * The map is cleared at step 1, so a pair never spans two turns.
     */
    const pendingToolFailures = new Map<string, PendingToolFailure[]>()
    const stateOf = (sessionId: string): TurnInsertionState => {
      let state = turnStates.get(sessionId)
      if (state === undefined) {
        state = freshTurnInsertionState()
        turnStates.set(sessionId, state)
      }
      return state
    }
    const insertionMessage = (text: string) =>
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

    /**
     * Values of the stored provider sign-ins. The journal masks synchronously,
     * the store reads asynchronously, so the values are kept here and renewed
     * whenever the store can have changed.
     */
    let providerSecrets: readonly string[] = []

    /** Secret values for masking a note; a broken provider must not fail the call. */
    function toolNoteSecrets(): readonly string[] {
      try {
        return [...secrets, ...providerSecrets, ...(options.toolNotes?.secrets?.() ?? [])]
      } catch {
        return [...secrets, ...providerSecrets]
      }
    }

    /** Save one note; the file writer is atomic and trims the oldest notes. */
    function saveToolNote(note: ToolNote): void {
      const target = options.toolNotes
      if (target === undefined) return
      recordToolNote(target.path, note)
    }

    /**
     * Fold one settled call into the failures of the current owner turn. An
     * MCP failure is `isError`; `exec` reports a non-zero exit as the first
     * line of a successful result; other tools are not observed. A later pass
     * of the same tool with other arguments writes the note; the same
     * arguments are a temporary failure and remove every matching pending
     * entry without a note.
     */
    function observeToolOutcome(
      sessionId: string,
      name: string,
      rawArgs: unknown,
      result: Readonly<{ isError: boolean; content: readonly ContentBlock[] }>,
    ): void {
      if (name !== TOOL_NOTES_EXEC_TOOL && !name.startsWith(TOOL_NOTES_MCP_PREFIX)) return
      const args = isJsonRecord(rawArgs) ? rawArgs : {}
      const secrets = toolNoteSecrets()
      const argsText = JSON.stringify(canonicalJson(args))
      const pending = pendingToolFailures.get(sessionId) ?? []

      if (name === TOOL_NOTES_EXEC_TOOL) {
        const outcome = execOutcomeOf(textOf(result.content))
        if (outcome === undefined) return
        const command = typeof args.command === 'string' ? args.command : ''
        const program = execProgramOf(command)
        if (outcome.failed) {
          pending.push({
            tool: name,
            subject: program,
            error: execErrorLine(redactToolNoteText(textOf(result.content), secrets)) || outcome.line,
            argsText,
            args,
            command,
          })
          pendingToolFailures.set(sessionId, pending)
          return
        }
        if (!outcome.passed) return
        // An identical pass settles every occurrence of that command, even
        // when another failed command was observed more recently.
        const sameCommand = (failure: PendingToolFailure): boolean =>
          failure.tool === name && failure.command === command
        if (pending.some(sameCommand)) {
          pendingToolFailures.set(sessionId, pending.filter((failure) => !sameCommand(failure)))
          return
        }
        // The fix must be a pass of the same program; another program is no
        // evidence that the first one works.
        const at = pending.findLastIndex((failure) => failure.tool === name && failure.subject === program)
        if (at < 0) return
        const failure = pending.splice(at, 1)[0] as PendingToolFailure
        pendingToolFailures.set(sessionId, pending)
        saveToolNote({
          tool: redactToolNoteText(name, secrets),
          // Mask before normalization: removing a version suffix first could
          // leave a secret's prefix unmatched in this durable metadata.
          subject: execProgramOf(redactToolNoteText(command, secrets)),
          error: firstErrorLine(redactToolNoteText(failure.error, secrets)),
          change: `было: ${noteLineOf(redactToolNoteText(failure.command ?? '', secrets))}, сработало: ${noteLineOf(redactToolNoteText(command, secrets))}`,
          at: Date.now(),
        })
        return
      }

      if (result.isError) {
        pending.push({
          tool: name,
          subject: '',
          error:
            firstErrorLine(redactToolNoteText(textOf(result.content), secrets)) || 'ошибка без текста',
          argsText,
          args,
        })
        pendingToolFailures.set(sessionId, pending)
        return
      }

      // Identical retries take precedence over pairing with a different
      // pending call, and settle all duplicate failures of those arguments.
      const sameArguments = (failure: PendingToolFailure): boolean =>
        failure.tool === name && failure.argsText === argsText
      if (pending.some(sameArguments)) {
        pendingToolFailures.set(sessionId, pending.filter((failure) => !sameArguments(failure)))
        return
      }
      const at = pending.findLastIndex((failure) => failure.tool === name)
      if (at < 0) return
      const failure = pending.splice(at, 1)[0] as PendingToolFailure
      pendingToolFailures.set(sessionId, pending)
      const change = changedArgumentsText(failure.args, args, secrets)
      // Nothing survived masking: showing an empty change would only hide a
      // secret without teaching anything.
      if (change === '') return
      saveToolNote({
        tool: redactToolNoteText(name, secrets),
        subject: '',
        error: firstErrorLine(redactToolNoteText(failure.error, secrets)),
        change,
        at: Date.now(),
      })
    }

    // Levels the adapter reports for one exact route, cached for the life of
    // the runner: the request waterfall asks on every model call, while the
    // capability of a route does not change under a live runner. An unknown
    // route (or a route without reasoning metadata) keeps the requested level:
    // only an explicit list proves that the level is unsupported.
    const reportedReasoningLevels = new Map<string, Promise<readonly string[] | undefined>>()
    const reasoningLevelsOf = (provider: string, id: string): Promise<readonly string[] | undefined> => {
      const key = `${provider}\u0000${id}`
      let pending = reportedReasoningLevels.get(key)
      if (pending === undefined) {
        pending = ctx.llm
          .resolveModelInfo(provider, id)
          .then((info) => info.reasoning?.efforts.map((effort) => String(effort.id)))
          .catch((error: unknown) => {
            ctx.logger.warn(`model "${provider}/${id}" levels unavailable: ${errorText(error)}`)
            return undefined
          })
        reportedReasoningLevels.set(key, pending)
      }
      return pending
    }
    const supportsReasoningLevel = async (provider: string, id: string, level: string): Promise<boolean> => {
      const levels = await reasoningLevelsOf(provider, id)
      return levels === undefined || levels.includes(level)
    }

    // The owner's reasoning effort is a property of the `main` session only.
    // The harness resolves the call config on every request, so returning the
    // current value here changes the next request of a live session without
    // touching its history or restarting the runner. A factory role declares
    // its own level per session; without one the route default stays.
    ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const sessionId = String(payload.agent.session.id)
      const requested = sessionId === MAIN_SESSION_ID
        ? mainReasoningEffort
        : sessionReasoningEfforts.get(sessionId)
      if (requested === undefined) return resolved
      // A level the exact model does not offer is dropped instead of sent: the
      // adapter refuses an unsupported effort before the request, so a model
      // switched by `/model` under a stored level (or a stale role choice)
      // must keep the turn on the model default rather than fail it.
      if (!(await supportsReasoningLevel(resolved.provider, resolved.model, requested))) {
        const { reasoningEffort: _dropped, ...rest } = resolved
        return rest
      }
      return { ...resolved, reasoningEffort: ReasoningEffortId(requested) }
    })

    ctx.on('agent/pre-step', async (payload, next) => {
      const sessionId = String(payload.agent.session.id)
      // A fresh turn starts with step 1: forget the previous turn's bookkeeping.
      if (payload.step === 1) {
        const fresh = freshTurnInsertionState()
        fresh.assistantBaseline = payload.agent.session
          .deriveMessages()
          .filter((message) => message.role === 'assistant').length
        turnStates.set(sessionId, fresh)
        pendingToolFailures.delete(sessionId)
      }
      const state = stateOf(sessionId)
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (state.finalizeSent || payload.step < (childIterationLimits.get(sessionId) ?? maxTurnIterations)) return decision
      state.finalizeSent = true
      return { ...decision, messages: [...decision.messages, insertionMessage(FINALIZE_NOW_TEXT)] }
    })

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
      const state = sessionId === undefined ? undefined : stateOf(sessionId)
      if (state !== undefined && sessionId !== undefined) {
        if (!result.isError && EDIT_TOOL_NAMES.has(exec.name)) state.edited = true
        else if (!result.isError && VERIFY_TOOL_NAMES.has(exec.name)) state.edited = false
        const signature = toolCallSignature(exec.name, exec.arguments)
        if (signature === state.loopSignature) state.loopCount += 1
        else {
          state.loopSignature = signature
          state.loopCount = 1
        }
        // Notes belong to the owner's own turns: a guest, a scheduled run or a
        // child learns nothing that would be shown in the owner's tail.
        if (options.toolNotes !== undefined && sessionToolState.get(sessionId)?.principal === 'owner') {
          try {
            observeToolOutcome(sessionId, exec.name, exec.arguments, result)
          } catch (error) {
            // The notes are advisory: a broken file must not fail the call.
            ctx.logger.warn(`tool notes: ${errorText(error)}`)
          }
        }
      }
      const decision = await next()
      if (state === undefined || state.loopCount !== 3 || decision.kind !== 'accept') return decision
      // Enrich the third result instead of replacing it: the model still sees the output.
      const content = decision.content ?? result.content
      return { kind: 'accept', content: [...content, { type: 'text', text: LOOP_WARNING_TEXT }] }
    })

    ctx.on('agent/turn-stopping', (payload) => {
      const state = stateOf(String(payload.agent.session.id))
      if (state.edited && !state.verifyReminded) {
        // One reminder per turn; later edits in the same turn stay silent.
        state.verifyReminded = true
        payload.agent.steer(insertionMessage(VERIFY_BEFORE_DONE_TEXT))
        return
      }
      if (!state.emptyNudged && turnAssistantText(payload.agent.session.deriveMessages(), state.assistantBaseline) === '') {
        state.emptyNudged = true
        payload.agent.steer(insertionMessage(EMPTY_TURN_NUDGE_TEXT))
      }
    })

    // --- lazy tools ----------------------------------------------------------------------
    //
    // The initial request declares only core tools. Lazy tools stay out of the
    // schema, appear in the stable prefix as a short `name: description` index,
    // and enter a session through `tool_search`.
    const runnerTools = [...(options.tools ?? [])]
    const seenNames = new Set<string>()
    for (const tool of runnerTools) {
      if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        throw new TypeError('tool name must be a non-empty string')
      }
      if (seenNames.has(tool.name)) throw new TypeError(`tool name "${tool.name}" is registered twice`)
      seenNames.add(tool.name)
    }
    const lazyTools = runnerTools.filter((tool) => tool.lazy === true)
    const lazyByName = new Map(lazyTools.map((tool) => [tool.name, tool]))
    /** Tools `main` only gets when a session names them: the analysis of attachments. */
    const optInNames = new Set(runnerTools.filter((tool) => tool.optIn === true).map((tool) => tool.name))
    if (lazyTools.length > 0 && seenNames.has(TOOL_SEARCH_NAME)) {
      throw new TypeError(`tool name "${TOOL_SEARCH_NAME}" is reserved for lazy tool discovery`)
    }

    const lazyStates = new Map<string, LazySessionState>()
    // Resolved from the exact model route before the first prompt. A route with
    // no `toolUpdate` declares its complete list at request start (leading-only):
    // a tool added mid-conversation could not be read there.
    let inSessionToolUpdate = false

    function registerLazyDefinition(state: LazySessionState, name: string): boolean {
      if (state.registered.has(name)) return false
      const definition = lazyDefinitions.get(name)
      if (definition === undefined) return false
      state.unregister.set(name, state.agentCtx.tools.register(definition))
      state.registered.add(name)
      return true
    }

    /**
     * Hide every tool of one session for a single turn and return the undo.
     * The global view is restricted to nothing, but a restriction never
     * reaches the agent's own layer, where the lazy tools loaded through
     * `tool_search` live: those are unregistered for the turn and registered
     * again by the undo, so the model request carries no tool schema at all.
     */
    function hideSessionTools(id: string, state: LazySessionState): () => void {
      const lift = state.agentCtx.tools.restrict({ allow: [] })
      const hidden: string[] = []
      for (const [name, dispose] of state.unregister) {
        dispose()
        hidden.push(name)
      }
      state.unregister.clear()
      return () => {
        lift()
        // A session closed meanwhile has a new state (or none): its own setup
        // registers the loaded tools again, so the old scope is left alone.
        if (lazyStates.get(id) !== state) return
        for (const name of hidden) {
          const definition = lazyDefinitions.get(name)
          if (definition !== undefined) state.unregister.set(name, state.agentCtx.tools.register(definition))
        }
      }
    }

    function enableLazyTool(state: LazySessionState, name: string): boolean {
      if (!state.policy.canEnable.has(name) || !lazyByName.has(name) || state.enabled.has(name)) return false
      if (!registerLazyDefinition(state, name)) return false
      state.enabled.add(name)
      return true
    }

    function writeLazyRecord(
      session: Session,
      data: { enabled?: readonly string[]; pending?: readonly string[] },
    ): void {
      appendPluginRecord(session, LAZY_TOOLS_RECORD, {
        ...(data.enabled === undefined ? {} : { enabled: [...data.enabled].sort(compareNames) }),
        ...(data.pending === undefined ? {} : { pending: [...data.pending].sort(compareNames) }),
      })
    }

    /** Fold every lazy-tool record of a session; pending enables apply on the next open. */
    function readLazyRecord(session: Session): { enabled: Set<string>; pending: Set<string> } {
      const enabled = new Set<string>()
      const pending = new Set<string>()
      for (const event of session.snapshotEvents()) {
        const record = pluginRecordOf(event)
        if (record?.type !== LAZY_TOOLS_RECORD) continue
        const data = record.data
        if (data === null || typeof data !== 'object' || Array.isArray(data)) continue
        for (const key of ['enabled', 'pending'] as const) {
          const value = (data as Record<string, unknown>)[key]
          if (!Array.isArray(value)) continue
          for (const name of value) {
            if (typeof name !== 'string' || !lazyByName.has(name)) continue
            if (key === 'enabled') enabled.add(name)
            else pending.add(name)
          }
        }
      }
      return { enabled, pending }
    }

    function matchingLazyTools(query: string): RunnerTool[] {
      const tokens = oneLine(query).toLocaleLowerCase().split(' ').filter((token) => token.length > 0)
      if (tokens.length === 0) return []
      return [...lazyTools]
        .sort((left, right) => compareNames(left.name, right.name))
        .filter((tool) => {
          const haystack = `${tool.name} ${oneLine(tool.description)}`.toLocaleLowerCase()
          return tokens.every((token) => haystack.includes(token))
        })
    }

    /** How many closest tools one missed query may enable at once. */
    const CLOSEST_LAZY_LIMIT = 5

    /**
     * The closest tools for a query that matched no tool completely: the ones
     * sharing the most words with it, at most {@link CLOSEST_LAZY_LIMIT} names,
     * ties ordered by name. A multi-word query must share at least two words and
     * a one-word query one word: one common word ("wb", "на") describes too many
     * unrelated tools to enable anything. `ranked` is every allowed candidate
     * worth naming, `enabled` only the best-scoring ones.
     */
    function closestLazyTools(
      query: string,
      state: LazySessionState,
    ): { ranked: RunnerTool[]; enabled: RunnerTool[] } {
      const allowed = lazyTools.filter((tool) => state.policy.canEnable.has(tool.name))
      const scored = rankLazyCandidates(allowed, query, CLOSEST_LAZY_LIMIT)
      const queryWords = lazyQueryWordCount(query)
      const minimum = queryWords > 1 ? 2 : 1
      const ranked = scored.map((entry) => entry.candidate)
      if (scored.length === 0 || scored[0].hits < minimum) return { ranked, enabled: [] }
      const best = scored[0].hits
      return {
        ranked,
        enabled: scored.filter((entry) => entry.hits === best).map((entry) => entry.candidate),
      }
    }

    /** Enable the tools of one match; a leading-only route defers them instead. */
    function applyLazyMatches(available: readonly RunnerTool[], state: LazySessionState): string {
      // A leading-only route defers every tool except the ones that opted into
      // a mid-session load.
      const deferred = inSessionToolUpdate ? [] : available.filter((tool) => tool.loadsMidSession !== true)
      const immediate = available.filter((tool) => !deferred.includes(tool))
      let deferredText = ''
      if (deferred.length > 0) {
        const pending = deferred.filter((tool) => !state.enabled.has(tool.name)).map((tool) => tool.name)
        if (pending.length > 0) writeLazyRecord(state.session, { pending })
        const names = deferred.map((tool) => tool.name).join(', ')
        deferredText =
          deferred.length === 1
            ? `Инструмент ${names} будет доступен со следующей сессии.`
            : `Инструменты ${names} будут доступны со следующей сессии.`
        if (immediate.length === 0) return deferredText
        deferredText = ` ${deferredText}`
      }
      const enabledNow: string[] = []
      const already: string[] = []
      for (const tool of immediate) {
        if (enableLazyTool(state, tool.name)) enabledNow.push(tool.name)
        else already.push(tool.name)
      }
      if (enabledNow.length > 0) {
        writeLazyRecord(state.session, { enabled: [...state.enabled] })
        writeSessionHeader(state)
      }
      if (enabledNow.length === 0) return `Инструменты уже подключены: ${already.join(', ')}.${deferredText}`
      const rest = already.length > 0 ? ` Уже были подключены: ${already.join(', ')}.` : ''
      return `Подключены инструменты: ${enabledNow.join(', ')}.${rest}${deferredText}`
    }

    async function searchLazyTools(query: unknown, sessionId: string | undefined): Promise<string> {
      const state = sessionId === undefined ? undefined : lazyStates.get(sessionId)
      if (state === undefined) return 'tool_search доступен только внутри сессии агента.'
      const text = typeof query === 'string' ? query : ''
      if (text.trim().length === 0) return 'Укажи в query слова из имени или описания нужного инструмента.'
      const matches = matchingLazyTools(text)
      if (matches.length > 0) {
        const available = matches.filter((tool) => state.policy.canEnable.has(tool.name))
        if (available.length === 0) {
          return `Найденные инструменты недоступны в этой сессии: ${matches.map((tool) => tool.name).join(', ')}.`
        }
        return applyLazyMatches(available, state)
      }
      // A query missing some words still enables the closest tools in the same
      // call: the model continues with them instead of paying another search
      // step. Only a best overlap weaker than the minimum stays a bare hint.
      const { ranked, enabled } = closestLazyTools(text, state)
      if (enabled.length > 0) return applyLazyMatches(enabled, state)
      const hint =
        ranked.length === 0
          ? ''
          : ` Ближайшие по словам: ${ranked.map((tool) => tool.name).join(', ')} — повтори запрос по точному имени.`
      return `Ничего не найдено по запросу «${oneLine(text)}».${hint}`
    }

    const searchTool: RunnerTool = {
      name: TOOL_SEARCH_NAME,
      description:
        'Ищет ленивые инструменты по имени и описанию и подключает найденные к текущей сессии. ' +
        'Если совпали не все слова, подключает ближайшие по числу совпавших слов, чтобы не искать повторно. ' +
        'Индекс ленивых инструментов перечислен в системном префиксе.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Слова из имени или описания инструмента.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (args, context) => searchLazyTools(args.query, context?.sessionId),
    }

    function toToolDefinition(tool: RunnerTool, guest = false): ToolDefinition {
      const variant = guest ? tool.guest : undefined
      return {
        name: tool.name,
        description:
          variant !== undefined
            ? variant.description
            : typeof tool.description === 'string'
              ? tool.description
              : '',
        parameters:
          variant !== undefined ? (canonicalJson(variant.inputSchema) as Record<string, unknown>) : toolParameters(tool),
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: toolResultText(value) }],
        },
        // Only an explicit declaration opts a tool into the parallel pool of
        // the harness; a tool without it (and every writing tool) stays a
        // barrier, so this passthrough must never infer safety from a name.
        ...(tool.isConcurrencySafe === undefined
          ? {}
          : { isConcurrencySafe: (args: unknown) => tool.isConcurrencySafe?.(args) === true }),
        // The tool body gets the harness abort signal: a `/stop` or the turn
        // timeout reaches a running process, not just the model request.
        execute: async (args, exec) => {
          const sessionId = exec.agent === undefined ? undefined : String(exec.agent.session.id)
          const produced = await tool.execute(args as Record<string, unknown>, {
            signal: exec.signal,
            model,
            ...(sessionId === undefined
              ? {}
              : {
                  sessionId,
                  extendTimeout: (extraMs: number) => extendTurnTimeout(sessionId, extraMs),
                }),
          })
          // A picture is not text: the tool result stays short and the image
          // rides as a deferred user message, so it lands in the very next
          // request of this turn as an ordinary model-visible image block.
          if (isRunnerImageAnswer(produced)) {
            exec.deferContext(
              createUserMessage({
                content: produced.images.map((image) => imageBlockOf(image)),
                source: { kind: 'user' },
              }),
            )
            return produced.text
          }
          return toolResultText(produced)
        },
        // Runs for successful, denied and failed calls alike: no result path skips redaction or the cap.
        finalizeContent: (_exec, result) => finalizeModelContent(result.content, secrets, maxToolOutputChars),
      }
    }

    const coreTools = [
      ...runnerTools.filter((tool) => tool.lazy !== true),
      // Discovery is useless without candidates, so it only exists alongside them.
      ...(lazyTools.length > 0 ? [searchTool] : []),
    ]
    const toolDefinitions = coreTools
      .map((tool) => toToolDefinition(tool))
      // Schema order is part of the prompt prefix: sort by name so caller order and
      // restarts cannot change the serialized request bytes.
      .sort((left, right) => compareNames(left.name, right.name))
    // Lazy definitions are registered into the agent scope only when loaded, so
    // an unloaded tool is invisible and cannot be dispatched.
    const lazyDefinitions = new Map<string, ToolDefinition>(
      lazyTools.map((tool) => [tool.name, toToolDefinition(tool)]),
    )
    const definitionsByName = new Map<string, ToolDefinition>(
      [...toolDefinitions, ...lazyDefinitions.values()].map((definition) => [definition.name, definition]),
    )
    for (const definition of toolDefinitions) ctx.tools.register(definition)

    // Explicit opt-in of a tool author, never inferred from the session id.
    const guestAllowedNames = new Set(
      [...(options.tools ?? [])].filter((tool) => tool.guestAllowed === true).map((tool) => tool.name),
    )
    /** Model-facing declaration of one registered tool, in assembly key order. */
    function wireSchema(name: string, guest = false) {
      if (guest) {
        const tool = runnerTools.find((candidate) => candidate.name === name)
        if (tool?.guest !== undefined) {
          return {
            name: tool.name,
            description: tool.guest.description,
            parameters: canonicalJson(tool.guest.inputSchema) as Record<string, unknown>,
          }
        }
      }
      const definition = definitionsByName.get(name)
      if (definition === undefined) return undefined
      return { name: definition.name, description: definition.description, parameters: definition.parameters }
    }

    /** Tool declarations this session would assemble right now, sorted by name. */
    function sessionTools(state: LazySessionState) {
      const names = new Set<string>(state.policy.globalAllow)
      for (const name of state.enabled) names.add(name)
      const tools: { name: string; description: string; parameters: Record<string, unknown> }[] = []
      for (const name of [...names].sort(compareNames)) {
        const schema = wireSchema(name, state.principal !== undefined && state.principal !== 'owner')
        if (schema !== undefined) tools.push(schema)
      }
      return tools
    }

    // --- live generation events --------------------------------------------------------------
    //
    // The sink is bound for the duration of one `promptTurn`, keyed by durable
    // session id: concurrent guest turns never see each other's deltas. A
    // broken sink is logged and otherwise swallowed, exactly like the usage
    // sink: presentation must never fail a paid model call.
    const streamSinks = new Map<string, RunnerStreamSink>()
    const toolCallNames = new Map<string, Map<string, string>>()

    function emitStream(id: string, event: RunnerStreamEvent): void {
      const sink = streamSinks.get(id)
      if (sink === undefined) return
      try {
        sink(event)
      } catch (error) {
        ctx.logger.warn(`stream sink failed: ${errorText(error)}`)
      }
    }

    ctx.on('agent/assistant-stream', (payload) => {
      const id = String(payload.agent.session.id)
      if (!streamSinks.has(id)) return
      const frame = payload.frame
      if (frame.type === 'start') {
        emitStream(id, { type: 'assistant-start' })
        return
      }
      if (frame.type !== 'chunk') return
      if (frame.chunk.type === 'text-delta') emitStream(id, { type: 'text', text: frame.chunk.text })
    })

    ctx.on('session/event', (session, event) => {
      const id = String(session.id)
      if (!streamSinks.has(id)) return
      if (event.type === 'tool/call') {
        let names = toolCallNames.get(id)
        if (names === undefined) {
          names = new Map()
          toolCallNames.set(id, names)
        }
        names.set(String(event.data.callId), event.data.name)
        emitStream(id, {
          type: 'tool-start',
          name: event.data.name,
          ...(typeof event.data.arguments === 'string' ? { arguments: event.data.arguments } : {}),
        })
        return
      }
      if (event.type !== 'tool/result') return
      const names = toolCallNames.get(id)
      const callId = String(event.data.message.toolCallId)
      const name = names?.get(callId)
      if (name === undefined) return
      names?.delete(callId)
      emitStream(id, { type: 'tool-end', name })
    })

    /**
     * Record the session's current tool list as the latest request-header
     * boundary. The next model request therefore computes the same header and
     * declares the loaded tool without the loop appending a developer update;
     * the stable system prefix stays byte-identical.
     */
    function writeSessionHeader(state: LazySessionState): void {
      const header = state.session.requestHeader()
      if (header === undefined) return
      const tools = sessionTools(state)
      if (tools.length === 0) return
      if (JSON.stringify(header.tools ?? []) === JSON.stringify(tools)) return
      state.session.append('request/header', {
        header: {
          config: header.config,
          ...(header.adapterDefaults === undefined ? {} : { adapterDefaults: header.adapterDefaults }),
          tools,
        },
        reason: 'change',
      })
    }

    const allToolNames = toolDefinitions.map((definition) => definition.name)
    const allToolNameSet = new Set(allToolNames)
    const registeredNames = new Set<string>([...allToolNames, ...lazyByName.keys()])

    /**
     * Tool policy one session sees at its first prompt. Explicit
     * `RunnerSession.tools` wins; `main` defaults to the core tools while
     * keeping every lazy tool loadable through `tool_search`, and every other
     * session defaults to none — a guest must opt into each capability. An
     * `optIn` tool is not part of the `main` default even though it is a core
     * tool: only the session that names it (the analysis of attachments) gets
     * it, so planned turns and reports of `main` never inherit it.
     *
     * With a declared non-owner principal the seam is default-deny regardless
     * of the session id: the only candidates are tools explicitly marked
     * `guestAllowed` (the guest exec and the two web tools), and the session
     * list can only narrow them. The legacy contract (no principal) keeps the
     * session-based default, so planned turns and wake-ups of `main` keep the
     * owner's tools.
     */
    function toolPolicy(
      id: string,
      requested: readonly string[] | undefined,
      principal: TurnPrincipal | undefined,
      includeLazyIndex = false,
      ownerTools = false,
    ): SessionToolPolicy {
      if (principal !== undefined && principal !== 'owner') {
        if (requested === undefined) {
          return {
            globalAllow: [...guestAllowedNames].sort(compareNames),
            canEnable: new Set<string>(),
            indexed: new Set<string>(),
            initialLazy: [],
          }
        }
        const guestNames = [...new Set(requested)]
        for (const name of guestNames) {
          if (!registeredNames.has(name)) {
            throw new TypeError(`session "${id}" requests unknown tool "${name}"`)
          }
        }
        const globalAllow = guestNames
          .filter((name) => allToolNameSet.has(name) && guestAllowedNames.has(name))
          .sort(compareNames)
        // A lazy tool is enabled only when its author opted it into the guest
        // schema; the principal seam may not be widened by `tool_search`. A
        // guest never sees the index of the owner's lazy tools either.
        const initialLazy = guestNames
          .filter((name) => lazyByName.has(name) && guestAllowedNames.has(name))
          .sort(compareNames)
        return { globalAllow, canEnable: new Set(initialLazy), indexed: new Set<string>(), initialLazy }
      }
      if (requested === undefined) {
        // An `optIn` lazy tool is not part of the owner's lazy index either: it
        // belongs to a session that names it (the terminal tools of a task), so
        // listing it would advertise a capability `main` may not load.
        const loadableOnDemand = [...lazyByName.keys()].filter((name) => !optInNames.has(name))
        return id === MAIN_SESSION_ID || ownerTools
          ? {
              globalAllow: allToolNames.filter((name) => !optInNames.has(name)),
              canEnable: new Set(loadableOnDemand),
              indexed: new Set(loadableOnDemand),
              initialLazy: [],
            }
          : { globalAllow: [], canEnable: new Set(), indexed: new Set(), initialLazy: [] }
      }
      const names = [...new Set(requested)]
      for (const name of names) {
        if (!registeredNames.has(name)) {
          throw new TypeError(`session "${id}" requests unknown tool "${name}"`)
        }
      }
      const globalAllow = names.filter((name) => allToolNameSet.has(name)).sort(compareNames)
      const initialLazy = names.filter((name) => lazyByName.has(name)).sort(compareNames)
      // A session that may enable nothing still gets the index of main when it
      // reuses the prompt of main: the bytes must match, the capability must not.
      const indexed = includeLazyIndex
        ? new Set([...lazyByName.keys()].filter((name) => !optInNames.has(name)))
        : new Set(initialLazy)
      return { globalAllow, canEnable: new Set(initialLazy), indexed, initialLazy }
    }

    /**
     * A resumed session whose request header never declared an immediate tool
     * (it was created before tools existed, or its tools were replaced) would
     * receive every current tool as a deferred tool-addition. DeepSeek rejects
     * a request where every tool is deferred, so open a new header segment with
     * the current tools as immediate declarations. The durable log keeps the
     * old header and every message; only the tool envelope moves forward.
     */
    function adoptToolsIntoHeader(session: Session, allowed: readonly string[]): void {
      if (allowed.length === 0) return
      const header = session.requestHeader()
      // Without any baseline header the first request is `initial`, so no addition exists.
      if (header === undefined) return
      const active = new Set(allowed)
      const immediate = (header.tools ?? []).some((tool) => active.has(tool.name) && tool.deferLoading !== true)
      if (immediate) return
      const tools = toolDefinitions
        .filter((definition) => active.has(definition.name))
        .map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        }))
      if (tools.length === 0) return
      session.append('request/header', {
        header: {
          config: header.config,
          ...(header.adapterDefaults === undefined ? {} : { adapterDefaults: header.adapterDefaults }),
          tools,
        },
        reason: 'change',
      })
      ctx.logger.info(
        `session "${String(session.id)}": request header had no immediate tools; declared ${tools.length} current tool(s) in a new header segment`,
      )
    }

    await ctx.plugin(LlmRuntime)
    await ctx.plugin(DeepSeekApiKey, {
      baseURL: options.baseUrl,
      // The route advertises and accepts all four efforts; the default is
      // `high`, which the adapter serializes as `thinking.type: enabled` with
      // `output_config.effort`. The old `thinking: "disabled"` would reject
      // any non-off effort at load.
      thinking: 'enabled',
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })

    // --- model providers of the owner ---------------------------------------------------------
    //
    // The file-backed credential store lives below the harness home, which the
    // file and exec tools already hide as part of DSHBOT_HOME; provider keys
    // never enter the environment or the model request unless a route is used.
    // The pi-ai adapter declares all twelve routes once: a route without a
    // stored sign-in is simply absent from `models()` below, and appears as
    // soon as `connectProvider` writes its record.
    await ctx.plugin(LocalCredentials, {
      path: join(options.dshHome, '.credentials.yaml'),
    })
    await ctx.plugin(Authorization)
    await ctx.plugin(PiAiAdapter, {
      providers: Object.fromEntries(PI_AI_PROVIDERS.map((id) => [id, {}])),
    })
    // One failed model request of the current step is replayed in the same
    // open turn and against the same durable history: a completed tool call of
    // an earlier step is never executed again. The wait is cancellable by the
    // turn signal, so `/stop` and the turn timeout break the pause immediately.
    ctx.on('agent/request-error', async (payload, next) => {
      if (payload.signal.aborted) return undefined
      const session = payload.agent.session
      const hadContent = attemptHadVisibleContent(session, payload.turn, payload.step)
      if (!isRetryableModelFailure(payload.failure, hadContent)) return next()
      const previousRetry = retryCountOf(session, payload.turn, payload.step)
      if (previousRetry >= MODEL_RETRY_MAX_RETRIES) return next()
      const retry = previousRetry + 1
      const delayMs = retryDelayMs(payload.failure, retry)
      if (delayMs === undefined) return next()
      const record: ModelRetryRecord = {
        turn: payload.turn,
        step: payload.step,
        provider: payload.provider,
        retry,
        maxRetries: MODEL_RETRY_MAX_RETRIES,
        delayMs,
        failure: {
          code: payload.failure.code,
          ...(payload.failure.status === undefined ? {} : { status: payload.failure.status }),
        },
      }
      // Durable before the wait: the owner notice and the journal count this
      // step's attempts from these records, so the count survives with the log.
      appendPluginRecord(session, MODEL_RETRY_RECORD, record)
      // The line goes to stderr directly because the product profile mounts no
      // console logger exporter for `ctx.logger`.
      process.stderr.write(`[dshbot] ${retryJournalLine(String(session.id), record)}\n`)
      if (!(await waitUnlessAborted(delayMs, payload.signal))) return undefined
      if (payload.signal.aborted) return undefined
      return { kind: 'retry' }
    })
    // Compaction of the owner's history runs on the harness packages: the token
    // meter prices the context, the pruner trims old tool results without a
    // model call, and the basic engine writes the summary checkpoint. The
    // engine's own `auto` listener stays off: its pre-step check would run
    // inside a turn and at wake-ups, while the product threshold is checked by
    // the app after the reply of an owner turn (in the idle time) and before a
    // turn only as the fallback (`autoCompact`). The image offload
    // executor turns an `IMAGE_OFFLOAD_REQUIRED` rejection of an
    // image-capable route into a durable placeholder for the oldest images and
    // one retry, so a session full of photos ends with an answer, not an error.
    await ctx.plugin(TokenMeter)
    await ctx.plugin(ToolResultPruner)
    await ctx.plugin(ImageOffload)
    await ctx.plugin(BasicCompactionEngine, { auto: false, maxTokens: 4096 })
    try {
      const modelInfo = await ctx.llm.resolveModelInfo(provider, model)
      inSessionToolUpdate = modelInfo.toolUpdate !== undefined
    } catch (error) {
      // An unknown route cannot read a mid-history addition: keep the safe
      // leading-only behaviour instead of breaking startup over discovery.
      ctx.logger.warn(`model "${provider}/${model}" capabilities unavailable: ${errorText(error)}`)
      inSessionToolUpdate = false
    }
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentDefaultModelConfig, { provider, model })
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 10 })

    const persistence = ctx.sessionPersistence
    const sessions = new Map<string, Promise<AgentHandle>>()

    /**
     * Per-agent composition shared by ordinary sessions and the throwaway
     * session of the pre-compaction service turn: the persona prefix, the lazy
     * tools the session may load, and the tool restriction of its policy.
     */
    function makeSessionSetup(
      systemPrefix: string,
      policy: SessionToolPolicy,
      principal?: TurnPrincipal,
    ): AgentSetup {
      return (agentCtx, agent): void => {
        // A guest scope shadows the shared registry definition of a tool with
        // its own description and schema: the owner's vault names, roPaths and
        // state paths never travel to a guest prompt. The scoped definition
        // keeps the same execute path, so the app still routes the call to the
        // guest runtime.
        if (principal !== undefined && principal !== 'owner') {
          for (const tool of runnerTools) {
            if (tool.guestAllowed !== true || tool.guest === undefined) continue
            agentCtx.tools.register(toToolDefinition(tool, true))
          }
        }
        const state: LazySessionState = {
          agentCtx,
          session: agent.session,
          policy,
          ...(principal === undefined ? {} : { principal }),
          enabled: new Set<string>(),
          registered: new Set<string>(),
          unregister: new Map<string, () => void>(),
        }
        lazyStates.set(String(agent.session.id), state)
        const indexed = lazyTools.filter(
          (tool) => policy.indexed.has(tool.name) && tool.indexed !== false,
        )
        agentCtx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: PERSONA_PREFIX_ORDER,
          text: prefixWithLazyIndex(systemPrefix, indexed),
        })
        // Tools enabled in an earlier run are re-registered before the first
        // assembly, so a resumed session keeps its loaded lazy tools.
        const persisted = readLazyRecord(agent.session)
        for (const name of new Set([...policy.initialLazy, ...persisted.enabled, ...persisted.pending])) {
          enableLazyTool(state, name)
        }
        // Restrict the global tool registry to this agent's own set. Hiding a
        // tool also makes a model-invented call to it fail as unknown, before
        // execute runs; the schema list and the dispatch check share this view.
        // Lazy definitions are scoped to this agent and stay exempt.
        if (policy.globalAllow.length !== allToolNames.length) {
          agentCtx.tools.restrict({ allow: [...policy.globalAllow] })
        }
      }
    }

    /**
     * Route of a session model. The runner model keeps the runner route; an
     * override (the flash side question, the lite night session, a child
     * profile) names a DeepSeek model, so it stays on the DeepSeek route even
     * when `main` runs on a connected provider.
     */
    function routeOf(sessionModel: string): string {
      return sessionModel === model ? provider : DEEPSEEK_PROVIDER
    }

    function openSession(
      id: string,
      principal: TurnPrincipal | undefined,
      systemPrefix: string,
      policy: SessionToolPolicy,
      sessionModel: string = model,
    ): Promise<AgentHandle> {
      const existing = sessions.get(id)
      if (existing !== undefined) return existing
      // The pre-execute guard checks this view, so it is set before the agent
      // exists. The owner schema is every registered tool (including lazy ones);
      // a non-owner principal is limited to the default-deny policy computed for
      // it, so a model-invented owner tool name cannot reach a handler.
      const allowed = principal === 'owner' || principal === undefined ? registeredNames : policy.globalAllow
      sessionToolState.set(id, { principal, allowed: new Set(allowed) })
      const opening = (async (): Promise<AgentHandle> => {
        const sessionId = id as SessionId
        // A scoped section shadows the global deployment persona for this agent
        // only, so guests can carry a different prompt in the same process.
        const setup = makeSessionSetup(systemPrefix, policy, principal)

        const stored = await persistence.stat(sessionId)
        if (stored === undefined) {
          const handle = await ctx.agents.create({
            sessionId,
            meta: { cwd: options.cwd },
            agentOptions: { provider: routeOf(sessionModel), model: sessionModel },
            setup,
          })
          shieldBrowserArguments(handle.agent.session, toolNoteSecrets)
          return handle
        }
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: { provider: routeOf(sessionModel), model: sessionModel },
          setup,
        })
        shieldBrowserArguments(handle.agent.session, toolNoteSecrets)
        try {
          adoptToolsIntoHeader(handle.agent.session, policy.globalAllow)
        } catch (error) {
          // Do not pin a half-adopted session in the map.
          await handle.dispose().catch(() => undefined)
          throw error
        }
        return handle
      })()
      // Keep a failed open retryable instead of pinning the rejection forever.
      opening.catch(() => {
        if (sessions.get(id) === opening) sessions.delete(id)
      })
      sessions.set(id, opening)
      return opening
    }

    /**
     * One in-flight turn per session. `cancel()` marks the cause, and the
     * cancellation is applied to the harness agent, which aborts the turn's
     * signal all the way down to the running tool bodies.
     */
    interface ActiveTurn {
      handle?: AgentHandle
      cause?: TurnAbortCause
      /** Current wall-clock deadline timer of the turn. */
      timer?: ReturnType<typeof setTimeout>
      /** When the armed timer fires, in epoch milliseconds. */
      deadline?: number
    }
    const activeTurns = new Map<string, ActiveTurn>()
    /** Live child agents, disposed with the runner even if a turn is still pending. */
    const childHandles = new Set<AgentHandle>()

    /**
     * Move the deadline of a live turn forward without cancelling it. Used by
     * tools that wait on a human (`ask_owner`): their wait is not model work
     * and must not be cut by the default turn cap. A turn that is already
     * cancelled or has no timer is left alone.
     */
    function extendTurnTimeout(sessionId: string, extraMs: number): boolean {
      const extra = Math.floor(extraMs)
      if (!Number.isFinite(extra) || extra <= 0) return false
      const turn = activeTurns.get(sessionId)
      if (turn === undefined || turn.cause !== undefined || turn.timer === undefined) return false
      clearTimeout(turn.timer)
      const now = Date.now()
      const remaining = Math.max(1, (turn.deadline ?? now) - now) + extra
      turn.deadline = now + remaining
      turn.timer = setTimeout(() => {
        if (turn.cause !== undefined) return
        turn.cause = 'timeout'
        if (turn.handle !== undefined) applyCancel(turn.handle, 'timeout')
      }, remaining)
      turn.timer.unref?.()
      return true
    }

    function applyCancel(handle: AgentHandle, cause: TurnAbortCause): void {
      handle.agent.cancel(
        cause === 'timeout' ? { kind: 'hook', reason: 'turn timeout' } : { kind: 'user' },
        // A stopped turn takes its pending steering with it: a message merged
        // into that turn must not come back as a turn of its own. Queued owner
        // messages live in the ingress, not in the agent inbox, so nothing that
        // should be served later is lost here.
        { keepInbox: false },
      )
    }

    /**
     * Feed owner text to the live turn of one session. The caller has already
     * checked that the turn belongs to the owner; this only refuses when the
     * harness has no running turn to take the steering (a finished or a
     * cancelled one), so the message is served as an ordinary turn instead.
     */
    function steer(text: string, sessionId: string = MAIN_SESSION_ID): boolean {
      const turn = activeTurns.get(sessionId)
      if (turn === undefined || turn.cause !== undefined || turn.handle === undefined) return false
      turn.handle.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      return true
    }

    function cancel(sessionId: string = MAIN_SESSION_ID): boolean {
      const turn = activeTurns.get(sessionId)
      if (turn === undefined) return false
      if (turn.cause !== undefined) return true
      turn.cause = 'stop'
      if (turn.handle !== undefined) applyCancel(turn.handle, 'stop')
      return true
    }

    /**
     * Close an interrupted turn with an assistant note of its own.
     *
     * Without the note the aborted or failed user-side text would remain the
     * last message: the next prompt could merge into that same user turn, the
     * model would see an unanswered request instead of a new one, and the turn
     * boundary would vanish from the durable log. The note is written as its
     * own closed turn so the log stays balanced for resume and fork.
     */
    function closeTurnWithNote(handle: AgentHandle, note: string, kind: string, turnModel: string = model): void {
      const session = handle.agent.session
      let lastTurn = 0
      for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') lastTurn = event.data.turn
      }
      const turn = lastTurn + 1
      const at = Date.now()
      try {
        session.append('turn/start', { turn })
        session.append('step/start', { turn, step: 1 })
        session.append(
          'assistant/message',
          {
            turn,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: note }],
              source: { provider: routeOf(turnModel), model: turnModel },
            }),
            stream: [
              { type: 'chunk', time: at, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
              { type: 'text-chunks', time0: at, index: 0, dt: [], texts: [note] },
              { type: 'chunk', time: at, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: note } } },
              { type: 'chunk', time: at, chunk: { type: 'finish', reason: { kind: 'stop' } } },
            ],
          },
          { surfaceOp: 'append' },
        )
        session.append('step/end', { turn, step: 1 })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      } catch (error) {
        // The note explains the interruption; failing to write it must not make
        // the turn surface as a different failure.
        ctx.logger.warn(`session "${String(session.id)}": ${kind}-turn note failed: ${errorText(error)}`)
      }
    }

    function closeCancelledTurn(handle: AgentHandle, turnModel: string = model): void {
      closeTurnWithNote(handle, CANCELLED_TURN_TEXT, 'cancelled', turnModel)
    }

    function closeFailedTurn(handle: AgentHandle, report: TurnReport, turnModel: string = model): void {
      closeTurnWithNote(handle, failedTurnNote(report, toolNoteSecrets()), 'failed', turnModel)
    }

    /**
     * One delegated child turn on {@link CHILD_MODEL}, in a fresh session.
     *
     * The child is an ordinary agent of this Cordis context, so it shares the
     * LLM route, the tool seam and the cancellation of the harness. Its tool
     * schema is restricted to the requested subset of the tools the parent
     * session can call right now (including the lazy tools it enabled), minus
     * everything a child may never hold; the dispatch guard carries the same
     * set, so a model-invented name cannot reach a handler either. The child
     * inherits the principal of the parent session, and a non-owner parent is
     * refused before any child session exists.
     */
    async function runChild(request: RunnerChildRequest): Promise<RunnerChildResult> {
      if (typeof request.task !== 'string' || request.task.trim().length === 0) {
        throw new TypeError('runChild: task must be a non-empty string')
      }
      const requested = request.tools ?? []
      if (!Array.isArray(requested) || requested.some((name) => typeof name !== 'string')) {
        throw new TypeError('runChild: tools must be an array of strings')
      }
      const iterations = Math.floor(request.maxIterations ?? DEFAULT_CHILD_MAX_ITERATIONS)
      if (!Number.isFinite(iterations) || iterations <= 0) {
        throw new TypeError('runChild: maxIterations must be a positive finite number')
      }
      const timeoutMs = Math.floor(request.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS)
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('runChild: timeoutMs must be a positive finite number')
      }
      if (request.instructions !== undefined && typeof request.instructions !== 'string') {
        throw new TypeError('runChild: instructions must be a string')
      }
      const childModel = request.model ?? CHILD_MODEL
      if (typeof childModel !== 'string' || childModel.trim().length === 0) {
        throw new TypeError('runChild: model must be a non-empty string')
      }
      const rawParentSessionId = request.parentSessionId
      if (typeof rawParentSessionId !== 'string' || rawParentSessionId.trim().length === 0) {
        throw new TypeError('runChild: parentSessionId must be a non-empty string')
      }
      const parentSessionId = rawParentSessionId.trim()
      const parentState = sessionToolState.get(parentSessionId)
      if (parentState === undefined) {
        throw new Error(`runChild: parent session "${parentSessionId}" is not open`)
      }
      const parentPrincipal = parentState.principal
      if (parentPrincipal !== undefined && parentPrincipal !== 'owner') {
        throw new Error(`runChild: principal "${parentPrincipal}" may not delegate`)
      }
      // The tools the parent session can call right now: its immediate schema
      // plus the lazy tools it has already enabled through `tool_search`. A
      // lazy tool the parent never loaded is not part of this set, so a child
      // cannot reach a capability its parent does not hold either.
      const parentLazy = lazyStates.get(parentSessionId)
      const parentCallable = new Set<string>(
        parentLazy === undefined
          ? [...parentState.allowed].filter((name) => allToolNameSet.has(name))
          : [...parentLazy.policy.globalAllow, ...parentLazy.enabled],
      )
      const allowed = [
        ...new Set(
          (requested as string[])
            .map((name) => name.trim())
            .filter(
              (name) =>
                name.length > 0 && parentCallable.has(name) && !CHILD_FORBIDDEN_TOOL_NAMES.has(name),
            ),
        ),
      ].sort(compareNames)

      // The parent's turn is already cancelled: do not spend a model call on a
      // child nobody is waiting for any more.
      if (request.signal?.aborted === true) return { text: '', aborted: 'stop' }

      const id = `${CHILD_SESSION_PREFIX}${Date.now().toString(36)}-${randomUUID()}`
      childParents.set(id, parentSessionId)
      const instructions =
        typeof request.instructions === 'string' ? request.instructions.trim() : ''
      const systemText = [
        'Ты — субагент: отдельный сеанс в том же процессе, без истории родителя.',
        'Выполни делегированную задачу самостоятельно и верни короткий отчёт: что сделал, что проверил, что осталось.',
        'Твой отчёт родитель считает самоотчётом, а не проверенным фактом. Не выдумывай результаты.',
        ...(instructions === '' ? [] : ['Инструкция профиля агента:', instructions]),
        allowed.length === 0
          ? 'Инструменты тебе не выданы: отвечай по своим знаниям и задаче.'
          : `Твои инструменты: ${allowed.join(', ')}. Другие инструменты тебе недоступны.`,
        'Подтверждения и делегирование тебе недоступны: команда, требующая подтверждения, будет отклонена.',
      ].join('\n')
      // Core tools come from the global registry and are masked by the scoped
      // restriction; a lazy tool the parent had enabled is registered in the
      // child's own layer, where the inherited restriction cannot strip it.
      const allowedCore = allowed.filter((name) => allToolNameSet.has(name))
      const allowedLazy = allowed.filter((name) => lazyByName.has(name))
      const setup: AgentSetup = (agentCtx) => {
        agentCtx.systemPrompt.section({
          name: PERSONA_PREFIX_SECTION,
          order: PERSONA_PREFIX_ORDER,
          text: systemText,
        })
        for (const name of allowedLazy) {
          const definition = lazyDefinitions.get(name)
          if (definition !== undefined) agentCtx.tools.register(definition)
        }
        agentCtx.tools.restrict({ allow: allowedCore })
      }

      const turn: ActiveTurn = {}
      activeTurns.set(id, turn)
      childIterationLimits.set(id, iterations)
      // The child inherits the principal of the caller instead of being forced
      // to owner: a non-owner parent was refused above, and a legacy embedder
      // without a declared principal keeps that contract on the child too.
      sessionToolState.set(id, { principal: parentPrincipal, allowed: new Set(allowed) })
      let handle: AgentHandle | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let startedAt: number | undefined
      const onAbort = (): void => {
        if (turn.cause !== undefined) return
        turn.cause = 'stop'
        if (handle !== undefined) applyCancel(handle, 'stop')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        handle = await ctx.agents.create({
          sessionId: id as SessionId,
          meta: { cwd: options.cwd },
          agentOptions: { provider: routeOf(childModel), model: childModel },
          setup,
        })
        shieldBrowserArguments(handle.agent.session, toolNoteSecrets)
        childHandles.add(handle)
        turn.handle = handle
        if (turn.cause !== undefined) return { text: '', aborted: turn.cause }
        const agent = handle.agent
        startedAt = Number(agent.session.seq)
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: `Задача субагента:\n${request.task}` }],
            source: { kind: 'user' },
          }),
        )
        timer = setTimeout(() => {
          if (turn.cause !== undefined) return
          turn.cause = 'timeout'
          applyCancel(handle as AgentHandle, 'timeout')
        }, timeoutMs)
        timer.unref?.()
        await agent.whenIdle()
        if (turn.cause !== undefined) {
          closeCancelledTurn(handle, CHILD_MODEL)
          return { text: '', aborted: turn.cause }
        }
        const events: SessionEvent[] = []
        for (let seq = startedAt; seq < Number(agent.session.seq); seq += 1) {
          const event = agent.session.eventAt(SessionSeq(seq))
          if (event !== undefined) events.push(event)
        }
        const outcome = inspectTurn(events)
        if (outcome.failure !== undefined) {
          return { text: '', error: turnFailureMessage(outcome, secrets, 'субагент завершил ход ошибкой') }
        }
        return { text: outcome.reply }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
        activeTurns.delete(id)
        childIterationLimits.delete(id)
        sessionToolState.delete(id)
        childParents.delete(id)
        if (handle !== undefined) {
          childHandles.delete(handle)
          await Promise.allSettled([ctx.sessions.flush(handle.agent.session)])
          await handle.dispose().catch(() => undefined)
        }
      }
    }

    /** Messages on the model-visible surface; the system prompt is not a message of the history. */
    function surfaceMessageCount(session: Session): number {
      let count = 0
      for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq)
        if (event === undefined) continue
        const message = deriveEventMessage(event)
        if (message !== null && (message.role === 'user' || message.role === 'assistant')) count += 1
      }
      return count
    }

    /** Token-meter estimate of the current context; a meter failure must not hide the report. */
    function measureTokens(session: Session): number {
      try {
        return ctx.tokenMeter.measure(session).totalTokens
      } catch (error) {
        ctx.logger.warn(`session "${String(session.id)}": token measurement failed: ${errorText(error)}`)
        return 0
      }
    }

    /** Read one session's state for `/status`; no model turn is made. */
    async function stats(sessionId: string = MAIN_SESSION_ID): Promise<RunnerSessionStats> {
      const tools = [...allToolNames].sort(compareNames)
      const pending = sessions.get(sessionId)
      // A restarted daemon has no open agent yet, but the owner's history is
      // still on disk. Resume it for reading (no request is made) so `/status`
      // reports the real history before the first turn of the new process.
      if (pending === undefined && (await persistence.stat(sessionId as SessionId)) === undefined) {
        return { sessionId, messages: 0, tokens: 0, tools }
      }
      const handle =
        pending === undefined
          ? await openSession(sessionId, 'owner', options.systemPrefix, toolPolicy(sessionId, undefined, 'owner'))
          : await pending
      const session = handle.agent.session
      return {
        sessionId,
        messages: surfaceMessageCount(session),
        tokens: measureTokens(session),
        tools,
      }
    }

    /**
     * Measure the composition of the next request of one session through the
     * token meter's own context projection, so `/context` names the numbers the
     * request is actually priced by. `compaction/summary` events carry their
     * append time, which is the time of the last summary.
     */
    async function context(sessionId: string = MAIN_SESSION_ID): Promise<RunnerContextReport> {
      const pending = sessions.get(sessionId)
      if (pending === undefined && (await persistence.stat(sessionId as SessionId)) === undefined) {
        return { systemTokens: 0, toolsTokens: 0, historyTokens: 0 }
      }
      const handle =
        pending === undefined
          ? await openSession(sessionId, 'owner', options.systemPrefix, toolPolicy(sessionId, undefined, 'owner'))
          : await pending
      const session = handle.agent.session
      const breakdown = ctx.sessionProjections.stateOf(session, 'contextBreakdown')
      let lastCompactionAt: number | undefined
      for (const event of session.snapshotEvents()) {
        if (event.type !== 'compaction/summary') continue
        if (lastCompactionAt === undefined || event.time > lastCompactionAt) lastCompactionAt = event.time
      }
      return {
        systemTokens: breakdown?.breakdown.systemTokens ?? 0,
        toolsTokens: breakdown?.breakdown.toolsTokens ?? 0,
        historyTokens: breakdown?.breakdown.messageTokens ?? 0,
        ...(lastCompactionAt === undefined ? {} : { lastCompactionAt }),
      }
    }

    /** Read the human turns and one short entry per tool call of a session. */
    async function transcript(sessionId: string = MAIN_SESSION_ID): Promise<RunnerTranscriptEntry[]> {
      const pending = sessions.get(sessionId)
      if (pending === undefined && (await persistence.stat(sessionId as SessionId)) === undefined) return []
      const handle =
        pending === undefined
          ? await openSession(sessionId, 'owner', options.systemPrefix, toolPolicy(sessionId, undefined, 'owner'))
          : await pending
      const entries: RunnerTranscriptEntry[] = []
      for (const message of handle.agent.session.deriveMessages()) {
        if (message.role === 'user') {
          const text = message.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim()
          if (text !== '') entries.push({ role: 'owner', text })
          continue
        }
        if (message.role !== 'assistant') continue
        for (const block of message.content) {
          if (block.type === 'text' && block.text.trim() !== '') {
            entries.push({ role: 'bot', text: block.text })
          } else if (block.type === 'tool-call') {
            entries.push({ role: 'tool', text: `${block.name} ${block.arguments}` })
          }
        }
      }
      return entries
    }


    /**
     * Sum of the `/context` composition: system prefix, tool schemas and
     * history, all in the token meter's heuristic tokens.
     */
    function contextTotalTokens(session: Session): number {
      const breakdown = ctx.sessionProjections.stateOf(session, 'contextBreakdown')
      if (breakdown === undefined) return measureTokens(session)
      return (
        breakdown.breakdown.systemTokens +
        breakdown.breakdown.toolsTokens +
        breakdown.breakdown.messageTokens
      )
    }

    /** Trim old tool results; a failed prune is logged and never blocks the summary. */
    function pruneToolResults(sessionId: string, session: Session): number {
      try {
        const pruned = ctx.toolResultPruner.pruneSession(session)
        if (pruned.pruned.length > 0) {
          ctx.logger.info(
            `session "${sessionId}": pruned ${pruned.pruned.length} tool result(s), ${pruned.charsRemoved} chars`,
          )
        }
        return pruned.charsRemoved
      } catch (error) {
        // A failed prune must not block the summary: it is one of two stages.
        ctx.logger.warn(`session "${sessionId}": tool-result pruning failed: ${errorText(error)}`)
        return 0
      }
    }

    /**
     * Give the model one service turn to save facts to the memory before a
     * summary. The turn runs on a fork of the session: it sees the whole
     * history it is about to lose, but its prompt, answer and memory call are
     * never part of the owner's history afterwards. The fork is disposed after
     * the turn, and the memory tool writes to the shared memory files.
     */
    async function runMemoryFlush(session: Session, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted()
      const events = session.snapshotEvents()
      const last = events[events.length - 1]
      if (last === undefined) return
      const boundary = Number(last.seq)
      const seed = buildForkSeed(events, SessionSeq(boundary))
      const id = `${MEMORY_FLUSH_SESSION_PREFIX}${Date.now().toString(36)}-${randomUUID()}`
      const policy = toolPolicy(MAIN_SESSION_ID, undefined, 'owner')
      let handle: AgentHandle | undefined
      let onAbort: (() => void) | undefined
      try {
        handle = await ctx.agents.create({
          sessionId: id as SessionId,
          meta: { cwd: options.cwd, parentSession: session.id, isSeeded: true },
          inheritedEventCount: SessionLogOffset(boundary + 1),
          seed,
          agentOptions: { provider, model },
          setup: makeSessionSetup(options.systemPrefix, policy),
        })
        shieldBrowserArguments(handle.agent.session, toolNoteSecrets)
        // An owner message that interrupts the idle compaction cancels the
        // service turn at once: its fork is throwaway, but holding the main lane
        // for the held model call is exactly the wait this check must avoid.
        onAbort = (): void => {
          if (handle === undefined) return
          handle.agent.cancel({ kind: 'user' }, { keepInbox: false })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        signal?.throwIfAborted()
        const agent = handle.agent
        const startedAt = Number(agent.session.seq)
        agent.followup(
          createUserMessage({
            content: [{ type: 'text', text: MEMORY_FLUSH_PROMPT }],
            source: { kind: 'user' },
          }),
        )
        await agent.whenIdle()
        signal?.throwIfAborted()
        const turnEvents: SessionEvent[] = []
        for (let seq = startedAt; seq < Number(agent.session.seq); seq += 1) {
          const event = agent.session.eventAt(SessionSeq(seq))
          if (event !== undefined) turnEvents.push(event)
        }
        const outcome = inspectTurn(turnEvents)
        if (outcome.failure !== undefined) {
          throw new Error(`service turn before compaction failed: ${outcome.failure}`)
        }
      } finally {
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        lazyStates.delete(id)
        if (handle !== undefined) {
          try {
            await ctx.sessions.flush(handle.agent.session)
          } catch (error) {
            ctx.logger.warn(`memory-flush session "${id}": flush failed: ${errorText(error)}`)
          }
          try {
            await handle.dispose()
          } catch (error) {
            ctx.logger.warn(`memory-flush session "${id}": dispose failed: ${errorText(error)}`)
          }
        }
      }
    }

    /**
     * Explicit `/compact` through the harness backend. The model-free pruner
     * first shortens old tool results, then the model gets one service turn for
     * its facts, and the basic engine replaces the remaining span with one
     * summary. The agent runs the operation as idle maintenance, so the session
     * tree, its id and its log stay intact while the visible history becomes
     * summary plus retained tail.
     */
    async function compact(sessionId: string = MAIN_SESSION_ID): Promise<RunnerCompaction> {
      const handle = await openSession(
        sessionId,
        'owner',
        options.systemPrefix,
        toolPolicy(sessionId, undefined, 'owner'),
      )
      const session = handle.agent.session
      const beforeTokens = measureTokens(session)
      // `compactNow` only summarizes: it never calls the pruner (that happens in
      // `compactIfNeeded`, which automatic pressure is off for). `/compact` runs
      // the pruning explicitly so both harness packages do their job.
      const prunedChars = pruneToolResults(sessionId, session)
      // The chance to save facts comes before the summary. A failed service turn
      // is journal-side evidence; the owner asked for the compaction itself and
      // still gets it.
      try {
        await runMemoryFlush(session)
      } catch (error) {
        ctx.logger.warn(
          `session "${sessionId}": memory flush before /compact failed: ${errorText(error)}`,
        )
      }
      // compactNow claims the idle phase itself (`runMaintenance`); wrapping it in
      // another maintenance run would be a nested claim and is refused as busy.
      const controller = new AbortController()
      let result: Awaited<ReturnType<typeof ctx.compaction.compactNow>>
      try {
        result = await ctx.compaction.compactNow(handle.agent, controller.signal)
      } catch (error) {
        // A summary that is not smaller than its source is the backend's way of
        // saying the history is already short (or did not shrink). The owner
        // gets an ordinary "nothing to compact" answer; a real summarizer
        // failure is rethrown and keeps its journal entry.
        if (!compactionSummaryNotSmaller(error)) throw error
        const afterTokens = measureTokens(session)
        // Pruning alone may still have shrunk the context; report that as a
        // compaction with sizes instead of pretending nothing happened.
        if (prunedChars === 0) ctx.logger.info(`session "${sessionId}": nothing to compact (${afterTokens} tokens)`)
        return { beforeTokens, afterTokens, compacted: false, noGain: prunedChars === 0, summary: '' }
      }
      if (result === null) {
        // Nothing was summarized; pruned results may still have left a smaller context.
        const afterTokens = measureTokens(session)
        return { beforeTokens, afterTokens, compacted: false, noGain: prunedChars === 0, summary: '' }
      }
      return {
        beforeTokens,
        afterTokens: measureTokens(session),
        compacted: true,
        noGain: false,
        summary: textOf(result.summary),
      }
    }

    /**
     * Automatic threshold check of `main`: after the reply of an owner turn in
     * the idle time, and before an owner turn when that idle check did not run
     * (a restart, an earlier failure). The session is measured with the same
     * composition `/context` adds up; old tool results are cleaned first and
     * only a session still over the threshold is summarized. Any failure leaves
     * the session as it was for the summary stage and is reported to the
     * caller, so the owner's message is never lost.
     */
    async function autoCompact(
      threshold: number,
      autoOptions: { signal?: AbortSignal } = {},
    ): Promise<RunnerAutoCompaction> {
      const signal = autoOptions.signal
      if (!Number.isFinite(threshold) || threshold <= 0 || aborted(signal)) {
        return { outcome: 'none', beforeTokens: 0, afterTokens: 0 }
      }
      const handle = await openSession(
        MAIN_SESSION_ID,
        'owner',
        options.systemPrefix,
        toolPolicy(MAIN_SESSION_ID, undefined, 'owner'),
      )
      const session = handle.agent.session
      const beforeTokens = contextTotalTokens(session)
      if (aborted(signal)) {
        return { outcome: 'interrupted', beforeTokens, afterTokens: beforeTokens }
      }
      if (beforeTokens < threshold) {
        return { outcome: 'none', beforeTokens, afterTokens: beforeTokens }
      }
      pruneToolResults(MAIN_SESSION_ID, session)
      const prunedTokens = contextTotalTokens(session)
      if (aborted(signal)) {
        return { outcome: 'interrupted', beforeTokens, afterTokens: prunedTokens }
      }
      if (prunedTokens < threshold) {
        ctx.logger.info(
          `session "${MAIN_SESSION_ID}": automatic pruning freed ${beforeTokens - prunedTokens} tokens; the summary is not needed`,
        )
        return { outcome: 'pruned', beforeTokens, afterTokens: prunedTokens }
      }
      try {
        await runMemoryFlush(session, signal)
      } catch (error) {
        // An owner message withdrew the check: that is not a broken service
        // turn, so it must neither warn the owner nor be reported as a failure.
        if (aborted(signal)) {
          return {
            outcome: 'interrupted',
            beforeTokens,
            afterTokens: contextTotalTokens(session),
          }
        }
        ctx.logger.warn(
          `session "${MAIN_SESSION_ID}": memory flush before automatic compaction failed: ${errorText(error)}`,
        )
        return {
          outcome: 'failed',
          beforeTokens,
          afterTokens: contextTotalTokens(session),
          error: errorText(error),
        }
      }
      if (aborted(signal)) {
        return {
          outcome: 'interrupted',
          beforeTokens,
          afterTokens: contextTotalTokens(session),
        }
      }
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      // The caller may have withdrawn the check between the last await and the
      // listener registration; the event would not fire for a listener added
      // after it, so mirror the current state onto the local controller.
      if (aborted(signal)) controller.abort()
      try {
        const result = await ctx.compaction.compactNow(handle.agent, controller.signal)
        if (result === null) {
          return {
            outcome: 'failed',
            beforeTokens,
            afterTokens: contextTotalTokens(session),
            error: 'the session has no compactable range',
          }
        }
      } catch (error) {
        if (aborted(signal) || controller.signal.aborted) {
          return {
            outcome: 'interrupted',
            beforeTokens,
            afterTokens: contextTotalTokens(session),
          }
        }
        ctx.logger.warn(`session "${MAIN_SESSION_ID}": automatic compaction failed: ${errorText(error)}`)
        return {
          outcome: 'failed',
          beforeTokens,
          afterTokens: contextTotalTokens(session),
          error: errorText(error),
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      if (aborted(signal)) {
        return {
          outcome: 'interrupted',
          beforeTokens,
          afterTokens: contextTotalTokens(session),
        }
      }
      const afterTokens = contextTotalTokens(session)
      ctx.logger.info(
        `session "${MAIN_SESSION_ID}": automatic compaction ${beforeTokens} -> ${afterTokens} tokens`,
      )
      return { outcome: 'compacted', beforeTokens, afterTokens }
    }

    async function promptTurn(text: string, session?: RunnerSession): Promise<TurnOutcome> {
      await refreshProviderSecrets()
      const id = session?.sessionId ?? MAIN_SESSION_ID
      const principal = session?.principal
      // A role turn declares its level for the whole session, not just this
      // request: every step of the turn (including tool follow-ups) carries it.
      // An absent level clears a stale one instead of leaking it into a turn
      // the caller asked to run on the model default.
      if (id !== MAIN_SESSION_ID) {
        const sessionEffort = normalizeReasoningLevel(session?.reasoningEffort)
        if (sessionEffort === undefined) sessionReasoningEfforts.delete(id)
        else sessionReasoningEfforts.set(id, sessionEffort)
      }
      // A transient turn deletes the session directory afterwards, so its id is
      // checked before any state is touched: no stream sink, no active turn and
      // no model call for an id that names the owner, a guest or a child
      // session, or that is not a plain name inside the sessions directory.
      if (session?.transient === true) {
        const refusal = transientSessionRefusal(id, principal ?? sessionToolState.get(id)?.principal)
        if (refusal !== undefined) throw new Error(refusal)
      }
      const turnModel = session?.model ?? model
      const policy = toolPolicy(
        id,
        session?.tools,
        principal,
        session?.includeLazyIndex === true,
        session?.ownerTools === true,
      )
      const sink = session?.onStream
      // The live sink belongs to exactly this turn; a stale one from a previous
      // turn of the same session must not receive the new deltas first.
      if (sink !== undefined) {
        streamSinks.set(id, sink)
        toolCallNames.delete(id)
      }
      // Registered before the (possibly slow) session open, so a `/stop` that
      // lands while the turn is still being prepared is not lost.
      const turn: ActiveTurn = {}
      activeTurns.set(id, turn)
      let timer: ReturnType<typeof setTimeout> | undefined
      let handle: AgentHandle | undefined
      let startedAt: number | undefined
      let usageReported = false
      /** Lifts the one-turn tool-free view of `noTools`; absent otherwise. */
      let showToolsAgain: (() => void) | undefined
      /** Events of this turn only; the log boundary keeps old turns out of the accounting. */
      const eventsSince = (from: number): SessionEvent[] => {
        const events: SessionEvent[] = []
        if (handle === undefined) return events
        for (let seq = from; seq < Number(handle.agent.session.seq); seq += 1) {
          const event = handle.agent.session.eventAt(SessionSeq(seq))
          if (event !== undefined) events.push(event)
        }
        return events
      }
      /**
       * Report what the turn already paid for. A completed model call is billed
       * whether or not the turn finishes: a stop, a timeout or a failure must
       * not hide its usage, otherwise the daily budget can be bypassed by
       * cancelling the turn after an expensive call.
       */
      const reportTurnUsage = (): void => {
        if (usageReported) return
        usageReported = true
        if (options.onTurnUsage === undefined || startedAt === undefined) return
        try {
          const usage = turnUsageFrom(eventsSince(startedAt))
          if (usage !== undefined) {
            options.onTurnUsage({ ...usage, sessionId: id, model: turnModel, ...(principal === undefined ? {} : { principal }) })
          }
        } catch {
          // Accounting must not fail a finished turn.
        }
      }
      try {
        const opened = await openSession(
          id,
          principal,
          session?.systemPrefix ?? options.systemPrefix,
          policy,
          turnModel,
        )
        handle = opened
        // A `/stop` without a handle yet only marks the cause; the turn must not
        // send its message after that.
        if (turn.cause !== undefined) return { text: '', aborted: turn.cause }
        turn.handle = opened
        // The OpenAI column asks for one answer without new actions. Hiding the
        // registry view for this turn keeps the session and its tool history but
        // sends no tool schema, so the model cannot name a tool at all; a call
        // invented anyway is refused before `execute`. The undo restores the
        // session's ordinary view for the next turn.
        if (session?.noTools === true) {
          toolFreeTurns.add(id)
          const state = lazyStates.get(id)
          if (state !== undefined) showToolsAgain = hideSessionTools(id, state)
        }
        const agent = opened.agent
        // Snapshot the log boundary so only this turn can supply the reply or a failure.
        startedAt = Number(agent.session.seq)
        const content: ContentBlock[] = [{ type: 'text', text }]
        for (const image of session?.images ?? []) content.push(imageBlockOf(image))
        agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
        timer = setTimeout(() => {
          if (turn.cause !== undefined) return
          turn.cause = 'timeout'
          applyCancel(opened, 'timeout')
        }, turnTimeoutMs)
        turn.timer = timer
        turn.deadline = Date.now() + turnTimeoutMs
        timer.unref?.()
        await agent.whenIdle()
        // The calls completed before an abort are already paid for; account for
        // them before the cancelled turn returns without a reply.
        reportTurnUsage()
        // Cancellation wins over anything the aborted turn left in the log: a
        // stop or a timeout is not a failed turn and must not surface a reply.
        if (turn.cause !== undefined) {
          closeCancelledTurn(handle, turnModel)
          return { text: '', aborted: turn.cause }
        }
        const events = eventsSince(startedAt)
        const outcome = inspectTurn(events)
        const tokens = turnUsageFrom(events)
        const usage: TurnUsageEvent | undefined =
          tokens === undefined
            ? undefined
            : { ...tokens, sessionId: id, model: turnModel, ...(principal === undefined ? {} : { principal }) }
        if (outcome.failure !== undefined) {
          // The provider refused the request (or the stream broke). Close the
          // failed turn in the journal with a note of its own, exactly like a
          // cancelled one, so the next message is a separate turn and the text
          // of the failed one never glues to it (also after a restart).
          closeFailedTurn(handle, outcome)
          throw new TurnFailedError(turnFailureMessage(outcome, secrets, 'ход завершился ошибкой'), usage)
        }
        return { text: outcome.reply, ...(usage === undefined ? {} : { usage }) }
      } finally {
        // A turn that ended by an exception may still have completed paid model
        // calls; the guarded helper reports them once.
        reportTurnUsage()
        if (options.onTurnEnd !== undefined) {
          try {
            options.onTurnEnd({ sessionId: id, ...(principal === undefined ? {} : { principal }) })
          } catch {
            // A derived index must not fail a finished turn.
          }
        }
        if (timer !== undefined) clearTimeout(timer)
        if (turn.timer !== undefined && turn.timer !== timer) clearTimeout(turn.timer)
        if (activeTurns.get(id) === turn) activeTurns.delete(id)
        if (sink !== undefined && streamSinks.get(id) === sink) streamSinks.delete(id)
        toolCallNames.delete(id)
        // The tool-free view of one column answer must not leak into the next
        // turn of the same session, whatever ended this one.
        if (session?.noTools === true) toolFreeTurns.delete(id)
        try {
          showToolsAgain?.()
        } catch {
          // A disposed session no longer has a view to restore.
        }
        // A transient session (a one-shot side question) leaves no history: the
        // turn is settled, so the agent is flushed and disposed and its
        // directory is removed. A failure here is logged and never masks the
        // reply the caller already got.
        if (session?.transient === true && handle !== undefined) {
          const opened = handle
          sessions.delete(id)
          sessionReasoningEfforts.delete(id)
          sessionToolState.delete(id)
          lazyStates.delete(id)
          turnStates.delete(id)
          try {
            await ctx.sessions.flush(opened.agent.session)
          } catch (error) {
            ctx.logger.warn(`transient session "${id}": flush failed: ${errorText(error)}`)
          }
          try {
            await opened.dispose()
          } catch (error) {
            ctx.logger.warn(`transient session "${id}": dispose failed: ${errorText(error)}`)
          }
          const directory = transientSessionDirectory(options.dshHome, id)
          if (directory === undefined) {
            // Unreachable after the pre-open guard; refuse instead of deleting
            // anything if a future caller finds a way around it.
            ctx.logger.warn(`transient session "${id}": refusing to remove a path outside the sessions directory`)
          } else {
            try {
              rmSync(directory, { recursive: true, force: true })
            } catch (error) {
              ctx.logger.warn(`transient session "${id}": cleanup failed: ${errorText(error)}`)
            }
          }
        }
      }
    }

    let stopped: Promise<void> | undefined

    /**
     * Provider routes with a stored sign-in record. Only the pi-ai records
     * count: the credential store may hold references for other consumers, and
     * a route of another adapter is never gated by this set.
     */
    async function connectedProviders(): Promise<Set<string>> {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return new Set()
      const connected = new Set<string>()
      for (const entry of await credentials.listRecords()) {
        if (credentialKeyScope(entry.key) !== PI_AI_RECORD_SCOPE) continue
        const id = credentialKeyId(entry.key)
        if (PI_AI_PROVIDER_SET.has(id)) connected.add(id)
      }
      return connected
    }

    /** Every string a stored record carries, for the output scrubber of the bot. */
    function recordSecrets(record: CredentialRecord): string[] {
      const values: string[] = []
      const visit = (value: unknown): void => {
        if (typeof value === 'string') {
          if (value.length > 0) values.push(value)
          return
        }
        if (Array.isArray(value)) {
          for (const entry of value) visit(entry)
          return
        }
        if (value !== null && typeof value === 'object') {
          for (const entry of Object.values(value)) visit(entry)
        }
      }
      if (record.kind === 'api-key') {
        visit(record.key)
        visit(record.env)
      } else {
        visit(record.payload)
      }
      return values
    }

    async function providerSecretValues(): Promise<string[]> {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return []
      const values = new Set<string>()
      for (const entry of await credentials.listRecords()) {
        if (credentialKeyScope(entry.key) !== PI_AI_RECORD_SCOPE) continue
        const record = await credentials.readRecord(entry.key)
        if (record === undefined) continue
        for (const value of recordSecrets(record)) values.add(value)
      }
      providerSecrets = [...values]
      return providerSecrets as string[]
    }

    /** Renew the cached sign-in values; a broken store must not fail a turn or a sign-in. */
    async function refreshProviderSecrets(): Promise<void> {
      await providerSecretValues().catch(() => undefined)
    }

    return {
      async models(): Promise<RunnerModelInfo[]> {
        const models: RunnerModelInfo[] = []
        // A pi-ai route is advertised only after its sign-in is stored; every
        // other provider keeps the catalogue it always had (the embedded
        // factory replaces the LLM runtime in its tests, for example).
        const connected = await connectedProviders()
        for (const provider of ctx.llm.listProviders()) {
          if (PI_AI_PROVIDER_SET.has(provider.id) && !connected.has(provider.id)) continue
          for (const model of await ctx.llm.listModels(provider.id)) {
            models.push({
              provider: model.provider,
              id: model.id,
              name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
            })
          }
        }
        return models
      },
      async providers(): Promise<RunnerProviderInfo[]> {
        const connected = await connectedProviders()
        const names = new Map(
          ctx.llm.listConfigurableProviders().map((entry) => [entry.provider, entry.displayName] as const),
        )
        return PI_AI_PROVIDERS.map((id): RunnerProviderInfo => {
          let methods: RunnerProviderMethod[] = []
          try {
            const flow = ctx.authorization.describe(recordKeyFor(id))
            methods = (flow?.methods ?? []).map((method) => ({
              id: method.id,
              kind: method.id === 'oauth' ? 'oauth' : 'api-key',
              label: method.label,
            }))
          } catch (error) {
            // A provider whose flow cannot be described must not break the
            // list for every other provider.
            ctx.logger.warn(`provider "${id}" methods unavailable: ${errorText(error)}`)
          }
          return {
            id,
            name: names.get(id) ?? id,
            connected: connected.has(id),
            methods,
          }
        })
      },
      async connectProvider(id: string, interaction: ProviderInteraction, method?: string): Promise<ProviderConnectResult> {
        if (!PI_AI_PROVIDER_SET.has(id)) return { status: 'failed' }
        const key = recordKeyFor(id)
        const flow = ctx.authorization.describe(key)
        if (flow === undefined) return { status: 'failed' }
        // The method the owner pressed must belong to this flow: a stale screen
        // after an adapter update must not start some other method silently.
        if (method !== undefined && !flow.methods.some((entry) => entry.id === method)) return { status: 'failed' }
        // A secret the flow asked for may echo back in its own failure text.
        // Keep it here so the journal gets a redacted reason without waiting
        // for the failed attempt to commit a record.
        const askedSecrets = new Set<string>()
        try {
          const outcome = await ctx.authorization.begin({
            key,
            ...(method === undefined ? {} : { method }),
            ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
            interaction: {
              notify: (notice) => interaction.notify(notice),
              prompt: async (prompt) => {
                let answer: string | undefined
                try {
                  answer = await interaction.prompt(prompt)
                } catch {
                  // The owner closing a question is a refusal, not a broken
                  // provider: report it as a cancelled sign-in.
                  throw new AuthorizationDeclinedError()
                }
                if (answer === undefined) throw new AuthorizationDeclinedError()
                if (prompt.kind === 'secret' && answer !== '') askedSecrets.add(answer)
                return answer
              },
            },
          })
          await refreshProviderSecrets()
          return { status: outcome.status === 'authorized' ? 'connected' : 'cancelled' }
        } catch (error) {
          if (error instanceof AuthorizationDeclinedError) return { status: 'cancelled' }
          let reason = errorText(error)
          const known = [...askedSecrets, ...(await providerSecretValues().catch(() => []))]
          for (const secret of known) {
            if (secret !== '') reason = reason.split(secret).join('[redacted]')
          }
          ctx.logger.warn(`provider "${id}" sign-in failed: ${reason}`)
          return { status: 'failed' }
        }
      },
      async disconnectProvider(id: string): Promise<void> {
        if (!PI_AI_PROVIDER_SET.has(id)) return
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return
        await credentials.deleteRecord(recordKeyFor(id))
        await refreshProviderSecrets()
      },
      providerSecretValues,
      async modelLevels(provider: string, id: string): Promise<string[] | undefined> {
        try {
          const info = await ctx.llm.resolveModelInfo(provider, id)
          const efforts = info.reasoning?.efforts
          return efforts === undefined ? undefined : efforts.map((effort) => String(effort.id))
        } catch (error) {
          // A route that cannot describe its levels must not break the menu:
          // the caller falls back to the generic four.
          ctx.logger.warn(`model "${provider}/${id}" levels unavailable: ${errorText(error)}`)
          return undefined
        }
      },
      prompt: async (text: string, session?: RunnerSession): Promise<string> =>
        (await promptTurn(text, session)).text,
      promptTurn,
      runChild,
      steer,
      cancel,
      stats,
      context,
      transcript,
      compact,
      autoCompact,
      reasoningEffort: () => mainReasoningEffort,
      setReasoningEffort(level: string): void {
        const resolved = normalizeReasoningLevel(level)
        if (resolved === undefined) {
          throw new TypeError(`unknown reasoning effort "${String(level)}"`)
        }
        mainReasoningEffort = resolved
      },
      stop(): Promise<void> {
        stopped ??= (async () => {
          const opened = await Promise.allSettled([...sessions.values()])
          const handles = opened.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
          const all = [...new Set([...handles, ...childHandles])]
          try {
            await Promise.allSettled(all.map((handle) => ctx.sessions.flush(handle.agent.session)))
          } finally {
            try {
              await Promise.allSettled(all.map((handle) => handle.dispose()))
            } finally {
              await ctx.fiber.dispose()
            }
          }
        })()
        return stopped
      },
    }
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined)
    throw error
  }
}
