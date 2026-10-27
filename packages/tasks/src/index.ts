// packages/tasks — ядро жизненного цикла задачи.
//
// Задача не может стать `done` сама по себе: переход в `done` возможен только
// через `verifying` + `verify_passed`, а `verify_passed` выставляется лишь после
// детерминированной проверки приёмки (`runAcceptance`). Вердикт после хода
// выносит дешёвая модель-судья; его ответ разбирает `parseVerdict`, а
// `createJudgeTracker` превращает вердикты в действия и не даёт сломанному
// судье ни мгновенно валить задачу, ни крутить её бесконечно.

import type { DatabaseSync } from 'node:sqlite'

import { checkCommand } from '../../guard/src/index.js'

// ---------------------------------------------------------------------------
// 1. Конечный автомат
// ---------------------------------------------------------------------------

export type TaskState =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'done'
  | 'waiting_owner'
  | 'blocked'
  | 'paused'

export type TaskEvent =
  | 'start'
  | 'complete'
  | 'verify_passed'
  | 'verify_failed'
  | 'escalate'
  | 'owner_reply'
  | 'block'
  | 'pause'
  | 'resume'

export const TASK_STATES: readonly TaskState[] = [
  'queued',
  'running',
  'verifying',
  'done',
  'waiting_owner',
  'blocked',
  'paused',
]

export const TASK_EVENTS: readonly TaskEvent[] = [
  'start',
  'complete',
  'verify_passed',
  'verify_failed',
  'escalate',
  'owner_reply',
  'block',
  'pause',
  'resume',
]

// `done` и `blocked` терминальны: переходов из них нет.
const TRANSITIONS: Readonly<Record<TaskState, Partial<Record<TaskEvent, TaskState>>>> = {
  queued: { start: 'running', pause: 'paused', block: 'blocked' },
  running: {
    complete: 'verifying',
    escalate: 'waiting_owner',
    block: 'blocked',
    pause: 'paused',
  },
  verifying: { verify_passed: 'done', verify_failed: 'running', pause: 'paused' },
  waiting_owner: { owner_reply: 'running', pause: 'paused' },
  paused: { resume: 'running', block: 'blocked' },
  done: {},
  blocked: {},
}

/** Новое состояние для пары (state, event) или исключение на недопустимый переход. */
export function transition(state: TaskState, event: TaskEvent): TaskState {
  const row = Object.hasOwn(TRANSITIONS, state) ? TRANSITIONS[state] : undefined
  const next = row && Object.hasOwn(row, event) ? row[event] : undefined
  if (next === undefined) {
    throw new Error(`invalid transition: "${String(state)}" + "${String(event)}"`)
  }
  return next
}

/** Допустим ли переход, без исключения. */
export function canTransition(state: TaskState, event: TaskEvent): boolean {
  return transitionOrNull(state, event) !== null
}

/** Терминальное состояние — из него нет ни одного перехода. */
export function isTerminalState(state: TaskState): boolean {
  return state === 'done' || state === 'blocked'
}

function transitionOrNull(state: TaskState, event: TaskEvent): TaskState | null {
  if (!Object.hasOwn(TRANSITIONS, state)) return null
  const row = TRANSITIONS[state]
  return Object.hasOwn(row, event) && row[event] !== undefined ? row[event]! : null
}

// ---------------------------------------------------------------------------
// 2. Проверка приёмки
// ---------------------------------------------------------------------------

export interface AcceptanceSandboxResult {
  /** Exit code; null when the command was killed by a signal or never started. */
  exitCode: number | null
  /** true when the sandbox killed the command by its timeout. */
  timedOut: boolean
  /** Combined stdout and stderr, in arrival order. */
  output: string
}

/**
 * The only way an acceptance command may run: the exec sandbox of
 * packages/tools-exec. packages/tasks owns no process seam of its own, so a
 * command can never reach the host.
 */
export interface AcceptanceSandbox {
  run(command: string, timeoutMs: number, signal?: AbortSignal): Promise<AcceptanceSandboxResult>
}

export interface AcceptanceOptions {
  /** Shell-команда приёмки. */
  command: string
  /** Таймаут в миллисекундах; по умолчанию 300_000 (5 минут). */
  timeoutMs?: number
  /** Песочница exec; без неё команда отклоняется и не исполняется на хосте. */
  sandbox?: AcceptanceSandbox
  /** Отмена хода, в котором идёт проверка. */
  signal?: AbortSignal
}

/** Why a command was refused before it ran. */
export type AcceptanceRefusal = 'confirm' | 'deny' | 'missing-sandbox'

export interface AcceptanceResult {
  /** true только при коде выхода 0 и отсутствии таймаута. */
  ok: boolean
  /** Код выхода; null, если процесс убит сигналом или не стартовал. */
  exitCode: number | null
  /** true, если сработал таймаут (процесс и его дети убиты). */
  timedOut: boolean
  /** Последние 3000 символов объединённого stdout и stderr. */
  tail: string
  /** Set when the command was refused instead of executed. */
  refused?: AcceptanceRefusal
}

export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 300_000
export const ACCEPTANCE_TAIL_LIMIT = 3000

/**
 * What the task session is told when its acceptance command is of the confirm
 * class. The command is written by the model, not by the owner, so it may not
 * open an approval card: the model must replace it with a harmless check.
 */
export const ACCEPTANCE_CONFIRM_TEXT =
  'Проверка не выполнена: команда приёмки требует подтверждения владельца — замени на неразрушающую проверку.'

/** The same refusal for a command the guard forbids outright. */
export const ACCEPTANCE_DENY_TEXT = ACCEPTANCE_CONFIRM_TEXT

/** No sandbox means no execution at all: the host is never the fallback. */
export const ACCEPTANCE_NO_SANDBOX_TEXT =
  'Проверка не выполнена: песочница exec недоступна, команда не исполнена. Замени проверку или сообщи о блокере.'

/**
 * Run one acceptance command through the exec sandbox.
 *
 * The command first passes `checkCommand` from the guard. A `confirm` or
 * `deny` verdict is a refusal: the sandbox is not called and no approval card
 * appears, because the command came from the model, not from the owner. Only
 * an `allow` command runs, and only when a sandbox was injected; there is no
 * host-shell fallback. The returned tail is capped at
 * {@link ACCEPTANCE_TAIL_LIMIT} characters.
 */
export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const command = typeof options.command === 'string' ? options.command.trim() : ''
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  if (command === '') {
    return { ok: false, exitCode: null, timedOut: false, tail: 'Команда приёмки не задана.' }
  }

  const check = checkCommand(command)
  if (check.verdict !== 'allow') {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      tail: check.verdict === 'deny' ? ACCEPTANCE_DENY_TEXT : ACCEPTANCE_CONFIRM_TEXT,
      refused: check.verdict,
    }
  }
  if (options.sandbox === undefined) {
    return { ok: false, exitCode: null, timedOut: false, tail: ACCEPTANCE_NO_SANDBOX_TEXT, refused: 'missing-sandbox' }
  }

  let result: AcceptanceSandboxResult
  try {
    result = await options.sandbox.run(command, timeoutMs, options.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, exitCode: null, timedOut: false, tail: `Проверка не запустилась: ${message}` }
  }
  return {
    ok: !result.timedOut && result.exitCode === 0,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    tail: result.output.slice(-ACCEPTANCE_TAIL_LIMIT),
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_ACCEPTANCE_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`timeoutMs must be a non-negative finite number, got ${String(timeoutMs)}`)
  }
  return timeoutMs
}

// ---------------------------------------------------------------------------
// 3. Вердикт судьи
// ---------------------------------------------------------------------------

export type VerdictName = 'done' | 'continue' | 'blocked' | 'wait'

export interface Verdict {
  verdict: VerdictName
  reason: string
}

const VERDICTS: ReadonlySet<string> = new Set<string>(['done', 'continue', 'blocked', 'wait'])

/**
 * Разбирает ответ судьи.
 *
 * Принимает чистый JSON `{"verdict": "...", "reason": "..."}`, тот же JSON в
 * markdown-блоке и JSON, окружённый произвольным текстом. Возвращает `null`,
 * если валидного ответа нет: не JSON, verdict вне допустимого набора, нет поля
 * verdict.
 */
export function parseVerdict(text: string): Verdict | null {
  if (typeof text !== 'string' || text.length === 0) return null

  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const verdict = asVerdict(parsed)
    if (verdict !== null) return verdict
  }
  return null
}

function asVerdict(value: unknown): Verdict | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'verdict')) return null
  const verdict = record.verdict
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null
  const reason = typeof record.reason === 'string' ? record.reason : ''
  return { verdict: verdict as VerdictName, reason }
}

/**
 * Вытаскивает все сбалансированные JSON-объекты из текста, в порядке появления.
 * Сканирование учитывает строки и экранирование, поэтому скобки внутри reason
 * не ломают разбор. Блоки кода ```json ... ``` не требуют отдельной обработки.
 */
function* jsonCandidates(text: string): Generator<string> {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    const end = balancedObjectEnd(trimmed, 0)
    if (end !== -1) yield trimmed.slice(0, end)
  }

  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = balancedObjectEnd(text, start)
    if (end === -1) continue
    yield text.slice(start, end)
  }
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// 4. Счётчик сбоев судьи
// ---------------------------------------------------------------------------

export type JudgeAction = 'continue_task' | 'finish' | 'block' | 'wait' | 'pause_task'

export interface JudgeTracker {
  /** Вердикт судьи (или null, если ответ не разобран) → действие над задачей. */
  record(verdict: Verdict | null): JudgeAction
}

export interface JudgeTrackerOptions {
  /** Сколько подряд неразобранных ответов терпеть; по умолчанию 3. */
  maxParseFailures?: number
}

export const DEFAULT_MAX_PARSE_FAILURES = 3

const VERDICT_ACTIONS: Readonly<Record<VerdictName, JudgeAction>> = {
  continue: 'continue_task',
  done: 'finish',
  blocked: 'block',
  wait: 'wait',
}

/**
 * Счётчик подряд идущих сбоев разбора.
 *
 * Сломанный судья не останавливает работу сразу: первые `maxParseFailures - 1`
 * null'ов дают `continue_task`, на пороге — `pause_task`. Любой валидный ответ
 * сбрасывает счётчик.
 */
export function createJudgeTracker(options: JudgeTrackerOptions = {}): JudgeTracker {
  const maxParseFailures = options.maxParseFailures ?? DEFAULT_MAX_PARSE_FAILURES
  if (!Number.isInteger(maxParseFailures) || maxParseFailures < 1) {
    throw new RangeError(
      `maxParseFailures must be a positive integer, got ${String(maxParseFailures)}`,
    )
  }

  let consecutiveFailures = 0

  return {
    record(verdict: Verdict | null): JudgeAction {
      if (verdict === null || verdict === undefined) {
        consecutiveFailures += 1
        return consecutiveFailures >= maxParseFailures ? 'pause_task' : 'continue_task'
      }

      const action = VERDICT_ACTIONS[verdict.verdict]
      if (action === undefined) {
        throw new TypeError(`unknown judge verdict: ${String(verdict.verdict)}`)
      }
      consecutiveFailures = 0
      return action
    },
  }
}

// ---------------------------------------------------------------------------
// 5. Хранилище задач и событий
// ---------------------------------------------------------------------------

/** Who asked for the task. */
export type TaskOrigin = 'owner' | 'schedule' | 'self'

/** One durable task row. */
export interface TaskRecord {
  id: string
  goal: string
  /** Shell command of the acceptance check; null when the judge decides. */
  acceptance: string | null
  /** true when no shell check exists and the judge is the only gate. */
  judgeOnly: boolean
  constraints: string
  project: string
  origin: TaskOrigin
  state: TaskState
  /** Own harness session of the task; never `main`. */
  sessionId: string
  /** Last evidence the task session supplied to `task_complete`. */
  evidence: string
  /** Reason of a block or a pause. */
  reason: string
  /** Last sentence of the judge. */
  verdictReason: string
  createdAt: number
  updatedAt: number
}

export interface TaskCreateInput {
  goal: string
  acceptance?: string
  judgeOnly?: boolean
  constraints?: string
  project?: string
  origin?: TaskOrigin
}

/** The narrow slice of the shared store the task tables need. */
export interface TaskStorage {
  migrate(namespace: string, steps: readonly string[]): void
  db: DatabaseSync
}

export interface TaskStore {
  create(input: TaskCreateInput): TaskRecord
  get(id: string): TaskRecord | undefined
  list(): TaskRecord[]
  /** Tasks that are neither done nor blocked, oldest first. */
  active(): TaskRecord[]
  /** Move the task along the state machine and append one event row. */
  apply(id: string, event: TaskEvent, detail?: string): TaskRecord
  /** Update fields without a state transition (the event row is still appended). */
  patch(id: string, patch: TaskPatch, event?: string, detail?: string): TaskRecord
  appendEvent(id: string, event: string, state: TaskState, detail: string): void
}

export interface TaskPatch {
  acceptance?: string | null
  judgeOnly?: boolean
  constraints?: string
  project?: string
  state?: TaskState
  evidence?: string
  reason?: string
  verdictReason?: string
}

const TASK_TABLE_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL,
    acceptance TEXT,
    judge_only INTEGER NOT NULL DEFAULT 0,
    constraints TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT 'default',
    origin TEXT NOT NULL DEFAULT 'owner',
    state TEXT NOT NULL,
    session_id TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    verdict_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks (state)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL,
    event TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id)`,
]

interface TaskRow {
  id: string
  goal: string
  acceptance: string | null
  judge_only: number
  constraints: string
  project: string
  origin: string
  state: string
  session_id: string
  evidence: string
  reason: string
  verdict_reason: string
  created_at: number
  updated_at: number
}

/** Durable ids are readable and unique enough for one daemon. */
function taskId(sequence: number, now: number): string {
  return `t-${now.toString(36)}-${sequence.toString(36)}`
}

function recordOf(row: TaskRow): TaskRecord {
  const origin: TaskOrigin = row.origin === 'schedule' || row.origin === 'self' ? row.origin : 'owner'
  return {
    id: row.id,
    goal: row.goal,
    acceptance: row.acceptance,
    judgeOnly: row.judge_only !== 0,
    constraints: row.constraints,
    project: row.project,
    origin,
    state: row.state as TaskState,
    sessionId: row.session_id,
    evidence: row.evidence,
    reason: row.reason,
    verdictReason: row.verdict_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Durable tasks in the shared `state.db`. The tables are owned by the `tasks`
 * migration namespace, so a restart keeps the queue, the evidence and every
 * state transition.
 */
export function createTaskStore(storage: TaskStorage): TaskStore {
  storage.migrate('tasks', TASK_TABLE_STEPS)
  const db = storage.db
  let sequence = 0

  function read(id: string): TaskRecord | undefined {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row === undefined ? undefined : recordOf(row)
  }

  function mustRead(id: string): TaskRecord {
    const task = read(id)
    if (task === undefined) throw new Error(`task "${id}" not found`)
    return task
  }

  function insertEvent(id: string, event: string, state: TaskState, detail: string, at: number): void {
    db.prepare(
      'INSERT INTO task_events (task_id, event, state, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, event, state, detail, at)
  }

  return {
    create(input: TaskCreateInput): TaskRecord {
      const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
      if (goal === '') throw new Error('task create: goal must be a non-empty string')
      const now = Date.now()
      sequence += 1
      const id = taskId(sequence, now)
      const project = (input.project ?? '').trim() || 'default'
      const acceptance = input.judgeOnly === true ? null : (input.acceptance ?? '').trim() || null
      const judgeOnly = input.judgeOnly === true || acceptance === null
      const origin: TaskOrigin = input.origin ?? 'owner'
      const constraints = (input.constraints ?? '').trim()
      db.prepare(
        `INSERT INTO tasks
          (id, goal, acceptance, judge_only, constraints, project, origin, state, session_id,
           evidence, reason, verdict_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, '', '', '', ?, ?)`,
      ).run(id, goal, acceptance, judgeOnly ? 1 : 0, constraints, project, origin, `task-${id}`, now, now)
      insertEvent(id, 'create', 'queued', `project ${project}`, now)
      return mustRead(id)
    },

    get: read,
    list(): TaskRecord[] {
      const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at, id').all() as unknown as TaskRow[]
      return rows.map(recordOf)
    },
    active(): TaskRecord[] {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE state NOT IN ('done', 'blocked') ORDER BY created_at, id")
        .all() as unknown as TaskRow[]
      return rows.map(recordOf)
    },

    apply(id: string, event: TaskEvent, detail = ''): TaskRecord {
      const task = mustRead(id)
      const next = transition(task.state, event)
      const now = Date.now()
      db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(next, now, id)
      insertEvent(id, event, next, detail, now)
      return mustRead(id)
    },

    patch(id: string, patch: TaskPatch, event?: string, detail = ''): TaskRecord {
      mustRead(id)
      const now = Date.now()
      const sets: string[] = ['updated_at = ?']
      const values: Array<string | number | null> = [now]
      const add = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`)
        values.push(value)
      }
      if (patch.acceptance !== undefined) add('acceptance', patch.acceptance)
      if (patch.judgeOnly !== undefined) add('judge_only', patch.judgeOnly ? 1 : 0)
      if (patch.constraints !== undefined) add('constraints', patch.constraints)
      if (patch.project !== undefined) add('project', patch.project)
      if (patch.state !== undefined) add('state', patch.state)
      if (patch.evidence !== undefined) add('evidence', patch.evidence)
      if (patch.reason !== undefined) add('reason', patch.reason)
      if (patch.verdictReason !== undefined) add('verdict_reason', patch.verdictReason)
      values.push(id)
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      if (event !== undefined) insertEvent(id, event, mustRead(id).state, detail, now)
      return mustRead(id)
    },

    appendEvent(id: string, event: string, state: TaskState, detail: string): void {
      insertEvent(id, event, state, detail, Date.now())
    },
  }
}

// ---------------------------------------------------------------------------
// 6. Судья задачи
// ---------------------------------------------------------------------------

/** Cheap model of the judge; the same flash route as the goal judge. */
export const TASK_JUDGE_MODEL = 'deepseek-flash'

/** What the judge sees: the task contract and the evidence of the attempt. */
export interface TaskJudgeInput {
  goal: string
  acceptance: string | null
  constraints: string
  evidence: string
  /** Reason of a previous block, when the task was resumed. */
  reason?: string
}

export interface TaskJudgeOptions {
  /** Messages API root, e.g. `https://api.deepseek.com/anthropic`. */
  baseUrl: string
  apiKey: string
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  model?: string
  maxTokens?: number
  timeoutMs?: number
}

/** Returns the parsed verdict, or null when the answer did not parse. */
export type TaskJudge = (input: TaskJudgeInput) => Promise<Verdict | null>

/**
 * The judge prompt, modeled on the Hermes goal judge: a strict independent
 * check that the deliverable exists, with an explicit four-verdict contract.
 */
export function taskJudgePrompt(input: TaskJudgeInput): string {
  const acceptance = input.acceptance === null || input.acceptance.trim() === ''
    ? 'детерминированной команды нет — решает судья'
    : `shell-команда (уже прошла и вернула 0): ${input.acceptance}`
  const constraints = input.constraints.trim() === '' ? 'не заданы' : input.constraints.trim()
  return [
    'Ты строгий судья автономной задачи. Реши, достигнут ли заявленный результат на самом деле.',
    'Верни ровно один JSON-объект одной строкой, без пояснений:',
    '{"verdict": "done|continue|blocked|wait", "reason": "одно предложение"}',
    'Правила:',
    '- done: результат существует и подтверждён доказательством; одного обещания или слова «готово» мало.',
    '- если ограничение задачи нарушено, задача не выполнена — continue.',
    '- blocked: результат недостижим как заявлено; blocked — это не завершение, а отказ.',
    '- wait: следующий шаг — ждать асинхронную работу, а не действовать снова.',
    '- continue: не done, и есть конкретный следующий шаг; это выбор по умолчанию.',
    '',
    `Цель: ${input.goal.trim()}`,
    `Критерий приёмки: ${acceptance}`,
    `Ограничения: ${constraints}`,
    input.reason === undefined ? '' : `Причина паузы или блока: ${input.reason}`,
    '',
    `Доказательство исполнителя: ${input.evidence.trim()}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/messages`
}

function judgeTextOf(payload: unknown): string {
  const content = payload !== null && typeof payload === 'object' ? (payload as { content?: unknown }).content : undefined
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const item = block as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
}

/**
 * One JSON-mode request to the judge model. Parsing errors are returned as
 * null; the caller counts consecutive nulls with {@link createJudgeTracker}
 * and pauses the task instead of failing it.
 */
export function createTaskJudge(options: TaskJudgeOptions): TaskJudge {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const model = options.model ?? TASK_JUDGE_MODEL
  const maxTokens = options.maxTokens ?? 500
  const timeoutMs = options.timeoutMs ?? 60_000

  return async function judge(input: TaskJudgeInput): Promise<Verdict | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetchImpl(messagesUrl(options.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          stream: false,
          // json_schema is rejected by DeepSeek; the plain JSON mode is what works.
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: [{ type: 'text', text: taskJudgePrompt(input) }] }],
        }),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`судья задачи ответил HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`)
      }
      return parseVerdict(judgeTextOf(await response.json()))
    } finally {
      clearTimeout(timer)
    }
  }
}
