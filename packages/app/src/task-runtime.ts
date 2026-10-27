// The task lane of the daemon: the `task` tool of the owner, the own harness
// session of every task, the lease of a project, the terminal tools
// `task_complete` / `task_block`, the acceptance check, the flash judge and the
// report to the owner.
//
// The package `packages/tasks` owns the state machine, the durable queue, the
// acceptance runner and the judge. This module is the wiring only: it starts a
// session per task, feeds the model the outcome of a failed check, nudges a
// stop without a terminal call and reports a finished or blocked task into
// `main`.

import type { Runner, RunnerTool } from '../../runner/src/index.js'
import {
  ACCEPTANCE_TAIL_LIMIT,
  createJudgeTracker,
  createTaskJudge,
  createTaskStore,
  isTerminalState,
  runAcceptance,
  type AcceptanceSandbox,
  type TaskCreateInput,
  type TaskRecord,
  type TaskStorage,
  type TaskStore,
  type TaskOrigin,
  type Verdict,
  type JudgeTracker,
} from '../../tasks/src/index.js'

/** A task may be nudged to use its terminal tool at most this many times. */
export const MAX_TASK_NUDGES = 2

/**
 * How many times a task may return from a failed acceptance check before it is
 * paused. A turn that did call `task_complete` is not a nudge: the model did
 * the terminal thing, the check simply refused it, so the retry has its own
 * bound and the nudge budget of the task stays untouched.
 */
export const MAX_ACCEPTANCE_RETRIES = 3

/** Prefix of the durable session id of a task; never `main`. */
export const TASK_SESSION_PREFIX = 'task-'

/** Extra turn text after the first check failure; the tail already says what broke. */
function failedCheckText(tail: string): string {
  const bounded = tail.length > ACCEPTANCE_TAIL_LIMIT ? tail.slice(-ACCEPTANCE_TAIL_LIMIT) : tail
  return (
    'Проверка приёмки не прошла. Исправь причину и вызови task_complete с новым доказательством, ' +
    `пока проверка не пройдёт.\n\nХвост вывода проверки:\n${bounded}`
  )
}

/** A nudge after a model stop that made no terminal call. */
function nudgeText(attempt: number): string {
  return (
    `Ход закончился без терминального инструмента (пинок ${attempt} из ${MAX_TASK_NUDGES}). ` +
    'Не пересказывай намерения: доделай работу и вызови task_complete(evidence) с доказательством ' +
    'или task_block(reason, evidence), если задача действительно заблокирована.'
  )
}

/** What the task session is told to continue with after the judge said continue. */
function continuationText(task: TaskRecord, reason: string): string {
  const left = reason.trim() === '' ? 'проверь, что осталось по цели' : reason.trim()
  return (
    `Судья не признал задачу выполненной. Что осталось: ${left}. ` +
    `Цель: ${task.goal}. Продолжай и заверши через task_complete(evidence).`
  )
}

/** The first message of the task session: the contract, not the owner's chat. */
export function taskPrompt(task: TaskRecord): string {
  const acceptance =
    task.acceptance === null
      ? 'детерминированной проверки нет: результат оценит независимый судья'
      : `shell-проверка (исполняется в песочнице): ${task.acceptance}`
  return [
    `Ты исполнитель автономной задачи ${task.id}.`,
    `Цель: ${task.goal}`,
    `Критерий приёмки: ${acceptance}`,
    task.constraints === '' ? '' : `Ограничения: ${task.constraints}`,
    `Проект: ${task.project}`,
    '',
    'Работай до результата, а не до рассказа о намерениях. Терминальные инструменты:',
    '- task_complete(evidence): работа сделана; evidence — что именно проверено и каким выводом.',
    '- task_block(reason, evidence): задача действительно заблокирована; reason — чего не хватает.',
    'Проверка приёмки решает закрытие: при провале её хвост вернётся к тебе, и задачу нельзя закрыть словами.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

const REPORT_PROMPT_PREFIX =
  'Составь отчёт владельцу ровно из трёх строк, без заголовков и пустых строк между ними:\n' +
  '1) что сделано и чем проверено (приведи доказательство дословно);\n' +
  '2) что осталось;\n' +
  '3) что нужно от владельца.'

function reportPrompt(task: TaskRecord, kind: 'done' | 'blocked'): string {
  const facts =
    kind === 'done'
      ? `Задача ${task.id} выполнена. Цель: ${task.goal}\nДоказательство: ${task.evidence}`
      : `Задача ${task.id} заблокирована. Цель: ${task.goal}\nПричина: ${task.reason}\nДоказательство: ${task.evidence}`
  return `${REPORT_PROMPT_PREFIX}\n\n${facts}`
}

/** Dependencies of the task lane, injected by the daemon. */
export interface TaskRuntimeDeps {
  /** The shared store, for the durable task tables. */
  storage: TaskStorage
  /** Sandbox of packages/tools-exec; acceptance never runs outside it. */
  sandbox?: AcceptanceSandbox
  /** Messages API root of the judge model. */
  baseUrl: string
  apiKey: string
  /** 0 means no global cap; the project lease always applies. */
  parallelLimit: number
  /** The live runner (the same one whose sessions serve the owner). */
  getRunner(): Promise<Runner>
  /** Serialized planned turn of `main`: owner turns and reports never interleave. */
  runPlannedTurn<T>(run: () => Promise<T>): Promise<T>
  ownerChatId(): number | null
  sendOwner(text: string): Promise<void>
  /** Non-terminal tools of the task session (files, exec, web). */
  workTools: readonly string[]
  log(message: string): void
}

export interface TaskRuntime {
  /** The `task` tool of the owner's main session. */
  readonly tool: RunnerTool
  /** Lazy terminal tools; only a task session may see or call them. */
  readonly terminalTools: readonly RunnerTool[]
  /** Active tasks for `/tasks` and for the owner-facing answer. */
  listText(): string
  /** Queue a task the same way the `task` tool does; the daemon uses it for owner buttons. */
  enqueue(input: TaskCreateInput): TaskRecord
  /** True while the task exists and is not in a final state. */
  isActive(id: string): boolean
  /** True for a durable session id of a task. */
  isTaskSession(sessionId: string | undefined): boolean
  /** Pause tasks interrupted by a restart and start the queued ones. */
  start(): void
  /** Stop launching new work and cancel live task sessions. */
  stop(): Promise<void>
}

interface RunState {
  taskId: string
  sessionId: string
  /** Tail of the failed check of the current turn. */
  failedTail?: string
  /** What the judge said when it did not accept the work of the current turn. */
  continuation?: string
  /** Set by task_block in the current turn. */
  block?: { reason: string; evidence: string }
  /** What the loop reports after the turn: a judge verdict or a task_block. */
  report?: 'done' | 'blocked'
  /** Consecutive unparseable judge answers of this task. */
  tracker: JudgeTracker
}

/** Swallow a runtime failure in best-effort work such as a report. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function acceptanceOf(args: Record<string, unknown>): { command?: string; judgeOnly: boolean } {
  const raw = args.acceptance
  if (raw === undefined || raw === null) return { judgeOnly: true }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '' || /^(?:судья|judge|решает судья|решение судьи)/i.test(text)) return { judgeOnly: true }
    return { command: text, judgeOnly: false }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>
    const kind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : ''
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    if (kind === 'judge' || command === '') return { judgeOnly: true }
    return { command, judgeOnly: false }
  }
  return { judgeOnly: true }
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function originOf(value: unknown): TaskOrigin | undefined {
  return value === 'owner' || value === 'schedule' || value === 'self' ? value : undefined
}

export function createTaskRuntime(deps: TaskRuntimeDeps): TaskRuntime {
  const store: TaskStore = createTaskStore(deps.storage)
  const judge = createTaskJudge({ baseUrl: deps.baseUrl, apiKey: deps.apiKey })
  const sessions = new Map<string, RunState>()
  /** One running task per project is the lease. */
  const leasedProjects = new Set<string>()
  let running = 0
  let stopped = false
  let stopping: Promise<void> | undefined

  function enqueue(input: TaskCreateInput): TaskRecord {
    const task = store.create(input)
    deps.log(`task ${task.id} queued for project ${task.project}`)
    pump()
    return task
  }

  const taskTool: RunnerTool = {
    name: 'task',
    description:
      'Поставить, посмотреть или отменить автономную задачу. create: goal, acceptance (shell-команда или ' +
      'решает судья), constraints, project, origin. Задача идёт в своей сессии и закрывается только ' +
      'проверкой приёмки и судьёй. Обещание «сделаю позже» без созданной задачи или расписания не принимается.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'status', 'cancel'],
          description: 'Что сделать с задачами.',
        },
        goal: { type: 'string', description: 'Результат задачи, который нужно получить.' },
        acceptance: {
          type: 'object',
          description:
            'Критерий приёмки: shell-проверка (kind=shell, command) или kind=judge, когда решает судья.',
          properties: {
            kind: { type: 'string', enum: ['shell', 'judge'] },
            command: { type: 'string', description: 'Shell-команда проверки; 0 — успех.' },
          },
          required: ['kind'],
        },
        constraints: { type: 'string', description: 'Ограничения задачи.' },
        project: { type: 'string', description: 'Проект; задачи одного проекта идут по одной.' },
        origin: {
          type: 'string',
          enum: ['owner', 'schedule', 'self'],
          description: 'Кто поставил задачу.',
        },
        id: { type: 'string', description: 'Id задачи для status или cancel.' },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = stringArg(args, 'action') ?? 'list'
      if (action === 'create') {
        const goal = stringArg(args, 'goal')
        if (goal === undefined) throw new Error('task create: goal is required')
        const acceptance = acceptanceOf(args)
        const task = enqueue({
          goal,
          judgeOnly: acceptance.judgeOnly,
          ...(acceptance.command === undefined ? {} : { acceptance: acceptance.command }),
          constraints: stringArg(args, 'constraints') ?? '',
          project: stringArg(args, 'project') ?? 'default',
          origin: originOf(args.origin) ?? 'owner',
        })
        return (
          `Задача ${task.id} создана и поставлена в очередь (проект ${task.project}). ` +
          'Она идёт в своей сессии; итог придёт отчётом после проверки приёмки и судьи.'
        )
      }
      if (action === 'list') return listText()
      if (action === 'status') {
        const id = stringArg(args, 'id')
        const task = id === undefined ? store.active()[0] : store.get(id)
        if (task === undefined) throw new Error(id === undefined ? 'task status: активных задач нет' : `task status: ${id} не найдена`)
        return statusText(task)
      }
      if (action === 'cancel') {
        const id = stringArg(args, 'id')
        if (id === undefined) throw new Error('task cancel: id is required')
        const task = store.get(id)
        if (task === undefined) throw new Error(`task cancel: ${id} не найдена`)
        if (isTerminalState(task.state)) return `Задача ${id} уже завершена (${task.state}).`
        forceBlock(task, 'отменена владельцем')
        void cancelSession(task.sessionId)
        pump()
        return `Задача ${id} отменена.`
      }
      throw new Error(`task: unknown action "${action}"`)
    },
  }

  const completeTool: RunnerTool = {
    name: 'task_complete',
    lazy: true,
    // Task-only tool: the session of a task names it explicitly, while the
    // owner's lazy index and `tool_search` never offer it.
    optIn: true,
    description:
      'Терминальный инструмент сессии задачи: заявить, что работа сделана, с доказательством. ' +
      'Закрывает задачу только после пройденной проверки приёмки и вердикта судьи.',
    inputSchema: {
      type: 'object',
      properties: {
        evidence: {
          type: 'string',
          description: 'Что сделано и каким выводом/файлом это подтверждено.',
        },
      },
      required: ['evidence'],
    },
    async execute(args: Record<string, unknown>, context): Promise<string> {
      const run = runOf(context?.sessionId)
      const evidence = stringArg(args, 'evidence') ?? ''
      return requestCompletion(run, evidence, context?.signal)
    },
  }

  const blockTool: RunnerTool = {
    name: 'task_block',
    lazy: true,
    // Task-only tool, like task_complete.
    optIn: true,
    description:
      'Терминальный инструмент сессии задачи: сообщить, что задача заблокирована, с причиной и доказательством.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Чего не хватает и почему задачу нельзя выполнить.' },
        evidence: { type: 'string', description: 'Что уже проверено и какие ошибки получены.' },
      },
      required: ['reason'],
    },
    execute(args: Record<string, unknown>, context): string {
      const run = runOf(context?.sessionId)
      const reason = stringArg(args, 'reason')
      if (reason === undefined) throw new Error('task_block: reason is required')
      const evidence = stringArg(args, 'evidence') ?? ''
      const task = store.get(run.taskId)
      if (task === undefined) throw new Error(`task ${run.taskId} not found`)
      if (isTerminalState(task.state)) return `Задача ${task.id} уже завершена.`
      store.patch(task.id, { evidence }, 'block_evidence', evidence)
      forceBlock(task, reason)
      run.block = { reason, evidence }
      return `Задача ${task.id} переведена в blocked. Причина записана, отчёт уйдёт владельцу.`
    },
  }

  function runOf(sessionId: string | undefined): RunState {
    const run = sessionId === undefined ? undefined : sessions.get(sessionId)
    if (run === undefined) {
      throw new Error('терминальный инструмент доступен только в сессии задачи')
    }
    return run
  }

  async function requestCompletion(run: RunState, evidence: string, signal?: AbortSignal): Promise<string> {
    const task = store.get(run.taskId)
    if (task === undefined) throw new Error(`task ${run.taskId} not found`)
    if (isTerminalState(task.state)) return `Задача ${task.id} уже завершена (${task.state}).`
    run.failedTail = undefined
    store.patch(task.id, { evidence }, 'complete_evidence', evidence)
    if (task.state === 'running') store.apply(task.id, 'complete', evidence)
    else if (task.state !== 'verifying') throw new Error(`task ${task.id}: task_complete in state ${task.state}`)

    if (!task.judgeOnly && task.acceptance !== null) {
      const result = await runAcceptance({
        command: task.acceptance,
        sandbox: deps.sandbox,
        ...(signal === undefined ? {} : { signal }),
      })
      if (!result.ok) {
        store.apply(task.id, 'verify_failed', result.tail)
        run.failedTail = result.tail
        return (
          `Проверка приёмки не прошла${result.timedOut ? ' (таймаут)' : ''}. ` +
          `Задача не закрыта; исправь причину и вызови task_complete снова.\n${result.tail}`
        ).trim()
      }
    }
    return judgeCompletion(run, task, evidence)
  }

  /**
   * The deterministic check passed (or the judge is the only gate): ask the
   * flash judge right away. The verdict is the only way to close the task, so
   * the session hears it in the same tool result.
   */
  async function judgeCompletion(run: RunState, task: TaskRecord, evidence: string): Promise<string> {
    let verdict: Verdict | null = null
    try {
      verdict = await judge({
        goal: task.goal,
        acceptance: task.acceptance,
        constraints: task.constraints,
        evidence,
        ...(task.reason === '' ? {} : { reason: task.reason }),
      })
    } catch (error) {
      deps.log(`task ${task.id} judge call failed: ${describeError(error)}`)
    }
    const current = store.get(task.id)
    if (current === undefined || isTerminalState(current.state)) {
      return `Задача ${task.id} уже завершена (${current?.state ?? 'unknown'}).`
    }
    const action = run.tracker.record(verdict)
    if (verdict !== null) store.patch(task.id, { verdictReason: verdict.reason })

    if (action === 'finish') {
      markDone(task, verdict)
      run.report = 'done'
      return `Судья подтвердил выполнение: ${verdict?.reason ?? ''}. Задача закрыта.`
    }
    if (action === 'block') {
      forceBlock(task, verdict?.reason ?? 'судья: blocked')
      run.report = 'blocked'
      return `Судья считает задачу заблокированной: ${verdict?.reason ?? ''}. Задача закрыта как blocked.`
    }
    if (action === 'wait') {
      pauseTask(task, verdict?.reason ?? 'судья: wait')
      void cancelSession(run.sessionId)
      return `Судья просит ждать: ${verdict?.reason ?? ''}. Задача поставлена на паузу.`
    }
    if (action === 'pause_task') {
      pauseTask(task, 'судья три раза подряд не вернул разбираемый вердикт')
      deps.log(`task ${task.id} paused: three unparseable judge answers in a row`)
      void cancelSession(run.sessionId)
      return 'Судья три раза подряд не вернул разбираемый вердикт: задача поставлена на паузу, а не провалена.'
    }

    store.apply(task.id, 'verify_failed', verdict?.reason ?? '')
    if (verdict === null) {
      run.continuation = 'Судья не вернул разбираемый вердикт.'
      return 'Судья не вернул разбираемый вердикт. Продолжай и заверши через task_complete с доказательством.'
    }
    run.continuation = verdict.reason
    return `Судья не признал задачу выполненной: ${verdict.reason}. Продолжай.`
  }

  function listText(): string {
    const active = store.active()
    if (active.length === 0) return 'Активных задач нет.'
    return ['Активные задачи:', ...active.map((task) => `- ${task.id} [${task.state}, ${task.project}]: ${task.goal}`)].join(
      '\n',
    )
  }

  function statusText(task: TaskRecord): string {
    return [
      `Задача ${task.id}: ${task.state}`,
      `Цель: ${task.goal}`,
      `Проект: ${task.project}; origin: ${task.origin}`,
      `Приёмка: ${task.acceptance ?? 'решает судья'}`,
      task.constraints === '' ? '' : `Ограничения: ${task.constraints}`,
      task.evidence === '' ? '' : `Доказательство: ${task.evidence}`,
      task.reason === '' ? '' : `Причина: ${task.reason}`,
      task.verdictReason === '' ? '' : `Судья: ${task.verdictReason}`,
    ]
      .filter((line) => line !== '')
      .join('\n')
  }

  function forceBlock(task: TaskRecord, reason: string): void {
    const fresh = store.get(task.id) ?? task
    if (fresh.state === 'running') {
      store.apply(task.id, 'block', reason)
    } else if (fresh.state === 'verifying') {
      store.apply(task.id, 'verify_failed', reason)
      store.apply(task.id, 'block', reason)
    } else if (fresh.state === 'queued' || fresh.state === 'paused' || fresh.state === 'waiting_owner') {
      store.patch(task.id, { state: 'blocked' }, 'block', reason)
    } else {
      return
    }
    store.patch(task.id, { reason })
  }

  function pauseTask(task: TaskRecord, reason: string): void {
    const fresh = store.get(task.id) ?? task
    if (fresh.state === 'queued' || fresh.state === 'running' || fresh.state === 'verifying' || fresh.state === 'waiting_owner') {
      store.apply(task.id, 'pause', reason)
    } else if (fresh.state !== 'paused') {
      store.patch(task.id, { state: 'paused' }, 'pause', reason)
    }
    store.patch(task.id, { reason })
  }

  function markDone(task: TaskRecord, verdict: Verdict | null): void {
    const fresh = store.get(task.id) ?? task
    // An owner cancel (or another terminal call) wins over a late judge verdict.
    if (isTerminalState(fresh.state)) return
    store.patch(task.id, { verdictReason: verdict?.reason ?? '' }, 'judge_done', verdict?.reason ?? '')
    if (fresh.state === 'verifying') store.apply(task.id, 'verify_passed', verdict?.reason ?? '')
    else if (fresh.state !== 'done') store.patch(task.id, { state: 'done' }, 'done', verdict?.reason ?? '')
  }

  async function report(task: TaskRecord, kind: 'done' | 'blocked'): Promise<void> {
    const chatId = deps.ownerChatId()
    if (chatId === null) return
    try {
      const runner = await deps.getRunner()
      const outcome = await deps.runPlannedTurn(() => runner.promptTurn(reportPrompt(task, kind), { principal: 'owner' }))
      const text = outcome.text.trim()
      if (text !== '') await deps.sendOwner(text)
    } catch (error) {
      deps.log(`task ${task.id} report failed: ${describeError(error)}`)
    }
  }

  async function cancelSession(sessionId: string): Promise<void> {
    try {
      const runner = await deps.getRunner()
      runner.cancel(sessionId)
    } catch (error) {
      deps.log(`task cancel of ${sessionId} failed: ${describeError(error)}`)
    }
  }

  async function runTask(taskId: string): Promise<void> {
    const initial = store.get(taskId)
    if (initial === undefined || initial.state !== 'running') return
    const run: RunState = {
      taskId,
      sessionId: initial.sessionId,
      tracker: createJudgeTracker(),
    }
    sessions.set(run.sessionId, run)
    try {
      const runner = await deps.getRunner()
      let prompt = taskPrompt(initial)
      let nudges = 0
      let failedChecks = 0

      for (;;) {
        if (stopped) {
          pauseTask(store.get(taskId) ?? initial, 'демон остановлен')
          return
        }
        const before = store.get(taskId)
        if (before === undefined || isTerminalState(before.state)) return
        run.failedTail = undefined
        run.continuation = undefined
        run.block = undefined
        run.report = undefined

        let outcome: { text: string; aborted?: 'stop' | 'timeout' }
        try {
          outcome = await runner.promptTurn(prompt, {
            sessionId: run.sessionId,
            principal: 'owner',
            tools: [...deps.workTools, completeTool.name, blockTool.name],
          })
        } catch (error) {
          pauseTask(store.get(taskId) ?? before, `ход задачи не выполнен: ${describeError(error)}`)
          return
        }

        const task = store.get(taskId)
        if (task === undefined) return
        if (run.block !== undefined) {
          await report(store.get(taskId) ?? task, 'blocked')
          return
        }
        if (run.report === 'done') {
          await report(store.get(taskId) ?? task, 'done')
          return
        }
        if (run.report === 'blocked') {
          await report(store.get(taskId) ?? task, 'blocked')
          return
        }
        // A canceled or paused task is settled outside this loop.
        if (task.state === 'done' || task.state === 'blocked' || task.state === 'paused') return
        // The judge was expected to settle the verifying state; if it could not,
        // the session may try again with a fresh completion.
        if (task.state === 'verifying') store.apply(task.id, 'verify_failed', 'судья не вынес вердикт')

        if (outcome.aborted !== undefined) {
          pauseTask(task, 'ход задачи отменён')
          return
        }
        // A turn that did call the terminal tool is not a nudge: the model did
        // the terminal thing, the check or the judge simply refused it. Those
        // retries have their own bound, and the nudge budget of the task stays
        // untouched.
        if (run.failedTail !== undefined) {
          failedChecks += 1
          if (failedChecks > MAX_ACCEPTANCE_RETRIES) {
            pauseTask(task, `проверка приёмки не прошла после ${MAX_ACCEPTANCE_RETRIES} попыток`)
            deps.log(`task ${task.id} paused: the acceptance check failed ${MAX_ACCEPTANCE_RETRIES} times`)
            return
          }
          prompt = failedCheckText(run.failedTail)
          continue
        }
        if (run.continuation !== undefined) {
          failedChecks += 1
          if (failedChecks > MAX_ACCEPTANCE_RETRIES) {
            pauseTask(task, `судья не принял работу после ${MAX_ACCEPTANCE_RETRIES} попыток`)
            deps.log(`task ${task.id} paused: the judge did not accept the work ${MAX_ACCEPTANCE_RETRIES} times`)
            return
          }
          prompt = continuationText(store.get(taskId) ?? task, run.continuation)
          continue
        }
        if (nudges >= MAX_TASK_NUDGES) {
          pauseTask(task, `нет терминального инструмента после ${MAX_TASK_NUDGES} пинков`)
          deps.log(`task ${task.id} paused: no terminal tool after ${MAX_TASK_NUDGES} nudges`)
          return
        }
        nudges += 1
        prompt = nudgeText(nudges)
      }
    } catch (error) {
      const task = store.get(taskId)
      if (task !== undefined && !isTerminalState(task.state)) {
        pauseTask(task, `сбой задачи: ${describeError(error)}`)
      }
      deps.log(`task ${taskId} failed: ${describeError(error)}`)
    } finally {
      sessions.delete(run.sessionId)
    }
  }

  /**
   * Admit queued tasks while their project is free and the global cap allows.
   * The claim (`queued` → `running`) happens before the async session starts,
   * so two pumps can never launch the same task twice.
   */
  function pump(): void {
    if (stopped) return
    for (const task of store.active()) {
      if (task.state !== 'queued') continue
      if (leasedProjects.has(task.project)) continue
      if (deps.parallelLimit > 0 && running >= deps.parallelLimit) break
      leasedProjects.add(task.project)
      running += 1
      try {
        store.apply(task.id, 'start', `session ${task.sessionId}`)
      } catch (error) {
        leasedProjects.delete(task.project)
        running -= 1
        deps.log(`task ${task.id} could not start: ${describeError(error)}`)
        continue
      }
      void runTask(task.id)
        .catch((error: unknown) => deps.log(`task ${task.id} crashed: ${describeError(error)}`))
        .finally(() => {
          leasedProjects.delete(task.project)
          running -= 1
          pump()
        })
    }
  }

  return {
    tool: taskTool,
    terminalTools: [completeTool, blockTool],
    listText,
    enqueue,
    isActive(id: string): boolean {
      const task = store.get(id)
      return task !== undefined && !isTerminalState(task.state)
    },
    isTaskSession(sessionId: string | undefined): boolean {
      return sessionId !== undefined && sessions.has(sessionId)
    },
    start(): void {
      // A restart may leave tasks mid-flight; their harness turn is gone.
      for (const task of store.active()) {
        if (task.state === 'running' || task.state === 'verifying' || task.state === 'waiting_owner') {
          pauseTask(task, 'демон перезапущен: ход задачи прерван')
        }
      }
      pump()
    },
    stop(): Promise<void> {
      stopping ??= (async () => {
        stopped = true
        for (const run of [...sessions.values()]) {
          await cancelSession(run.sessionId)
        }
      })()
      return stopping
    },
  }
}
