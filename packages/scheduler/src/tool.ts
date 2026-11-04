// The `schedule` tool: create, list and remove jobs of the daemon's own
// scheduler. A job is durable (it lives in the store) and its time starts a
// planned turn. An entry may also carry a deterministic shell check: the check
// runs first, the model is woken only when it reports work, and a `raw` entry
// sends its stdout to the owner without a model at all.
//
// Wall-clock texts of a job are read in the zone of the owner (`DSHBOT_TZ`, the
// host zone by default). The model never converts them to UTC: cron "0 9 * * 1-5"
// means 09:00 for the owner, whatever the offset or DST does.

import { formatSchedule } from './format.js'
import { parseSchedule } from './schedule.js'
import type {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRegistry,
  ScheduleWatch,
  UpdateScheduleInput,
} from './jobs.js'
import { DEFAULT_WATCH_WINDOW_SEC, SCHEDULE_EFFORTS, SCHEDULE_SUMMARY_DAYS } from './jobs.js'
import { toolNamesRefusal, type ScheduleToolCatalog } from './tool-names.js'

/** Model-facing shape used by the runner tool seam (kept structural on purpose). */
export interface ScheduleTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

/** Named agent profiles a job may name; the scheduler itself stays decoupled. */
export interface ScheduleAgentDirectory {
  has(name: string): boolean
  names(): readonly string[]
}

export interface ScheduleToolOptions {
  registry: ScheduleRegistry
  /**
   * Starts one run of a job immediately, outside its schedule. The callback
   * must return quickly (a planned run waits behind the owner's turn); absent
   * means `run_now` answers that the daemon has no runner.
   */
  runNow?: (job: ScheduleRecord) => void | Promise<void>
  /**
   * The owner's agent profiles. When present, create and update refuse an
   * unknown name at once and list what exists; a job whose profile disappears
   * later is refused again when its planned turn is due.
   */
  agents?: ScheduleAgentDirectory
  /**
   * The tools a run receives. When present, create and update refuse a task
   * that names a tool the run does not have (a profile run holds only the
   * profile tools); nothing is saved or changed then.
   */
  tools?: ScheduleToolCatalog
  /**
   * Guard and owner approval for the command of a stream watcher. It throws a
   * refusal (with the reason) when the guard denies the command or the owner
   * declines the card, so nothing is saved and nothing starts. A watch created
   * or updated without a guard is refused: a long-lived command must never
   * bypass the guard.
   */
  guardCommand?: (command: string) => Promise<void>
}

const ACTIONS = ['create', 'watch', 'list', 'remove', 'update', 'pause', 'resume', 'run_now', 'history', 'summary'] as const
type Action = (typeof ACTIONS)[number]

/** How much of a task text `list` shows by default; see `listView`. */
const LIST_TASK_PREVIEW = 200

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrText(value: unknown): number | string | undefined {
  if (typeof value === 'number') return value
  const raw = text(value)
  return raw === '' ? undefined : raw
}

function normalizeAction(value: unknown): Action {
  const raw = text(value).toLowerCase()
  if (raw === 'create' || raw === 'add' || raw === 'new' || raw === 'set' || raw === 'schedule' || raw === 'job') return 'create'
  if (raw === 'watch' || raw === 'stream' || raw === 'watcher') return 'watch'
  if (raw === 'list' || raw === 'ls' || raw === 'show' || raw === 'all' || raw === 'get') return 'list'
  if (raw === 'remove' || raw === 'delete' || raw === 'rm' || raw === 'del' || raw === 'cancel' || raw === 'unschedule') {
    return 'remove'
  }
  if (raw === 'update' || raw === 'edit' || raw === 'modify' || raw === 'change') return 'update'
  if (raw === 'pause' || raw === 'suspend' || raw === 'disable') return 'pause'
  if (raw === 'resume' || raw === 'unpause' || raw === 'enable' || raw === 'continue') return 'resume'
  if (raw === 'run_now' || raw === 'run-now' || raw === 'run' || raw === 'trigger' || raw === 'fire') return 'run_now'
  if (raw === 'history' || raw === 'runs' || raw === 'log') return 'history'
  if (raw === 'summary' || raw === 'stats' || raw === 'report') return 'summary'
  throw new Error(
    `schedule: неизвестное действие "${raw || 'пусто'}"; допустимы create, list, remove, update, pause, resume, run_now, history, summary.`,
  )
}

function notFound(id: string): Error {
  return new Error(`schedule: задание "${id}" не найдено.`)
}

/** Refuse a task that names a tool the run will not have. */
function checkTaskTools(
  options: ScheduleToolOptions,
  action: 'create' | 'update',
  task: string,
  agent: string,
): void {
  const refusal = toolNamesRefusal(action, task, agent, options.tools)
  if (refusal !== undefined) throw new Error(refusal)
}

/** Refuse an unknown profile with the same wording for create and update. */
function checkAgent(
  options: ScheduleToolOptions,
  action: 'create' | 'update',
  agent: string,
): void {
  if (agent === '' || options.agents === undefined) return
  if (options.agents.has(agent)) return
  const names = options.agents.names()
  throw new Error(
    `schedule ${action}: неизвестный профиль агента "${agent}". Доступные профили: ` +
      `${names.length === 0 ? 'нет (задайте DSHBOT_HOME/agents.json)' : names.join(', ')}.`,
  )
}

/**
 * A relative delay in the task text: "через минуту", "через 5 минут", "через
 * день", "через полчаса", "in 10 minutes", "in a week", "in 2 days". Such a
 * request is a single action after a delay — a one-shot.
 *
 * The unit list has to be as wide as the wording: a day or a week is exactly
 * the case where a cron hurts most, because the job then repeats the same
 * action every day at that minute. The trailing `*` swallows the case ending
 * ("минуту", "дня", "неделю", "days"), and `(?!\p{L})` stops a word that only
 * begins with a unit ("части", "Germany").
 */
const RELATIVE_DELAY =
  /(?:^|[^\p{L}])(?:через|in)\s+(?:\d+\s*|[aа]\s+)?(?:полчас|секунд|сек|минут|мин|час|день|дн|сут|недел|месяц|год|sec|min|hour|day|week|month)[а-яёa-z]*(?!\p{L})/iu

/**
 * Refuse a cron spec that carries a one-shot delay in its task. Real case: the
 * owner wrote "включи свет на 100% через минуту", the job was saved as
 * `25 0 * * *` and switched the lights on at 00:27 the next night, then every
 * night. A cron repeats by the clock; a delay happens once, so it belongs to
 * the spec itself ("2m" or an ISO time), not to the task text.
 */
function checkRecurringDelay(
  action: 'create' | 'update',
  spec: string,
  task: string,
): void {
  if (!RELATIVE_DELAY.test(task)) return
  let kind: string
  try {
    kind = parseSchedule(spec).kind
  } catch {
    // A broken spec is reported by the registry with its own wording.
    return
  }
  if (kind !== 'cron') return
  throw new Error(
    `schedule ${action}: расписание "${spec}" повторяется по часам, а в задании разовая задержка ` +
      `(«через ...»). Задержка — это разовый запуск: укажи её в самом расписании ("2m", "90m" или ` +
      `ISO-время) и убери повторение. Если повторение действительно нужно, переформулируй задание без задержки.`,
  )
}

function view(record: ScheduleRecord): Record<string, unknown> {
  return {
    id: record.id,
    schedule: record.spec,
    task: record.task,
    idleOnly: record.idleOnly,
    timeZone: record.tz,
    nextRunAt: record.nextRunAt === null ? null : record.nextRunAt.toISOString(),
    until: record.until === null ? null : record.until.toISOString(),
    maxRuns: record.maxRuns,
    runs: record.runs,
    check: record.check,
    deliver: record.deliver,
    watch: record.watch,
    agent: record.agent,
    effort: record.effort,
    paused: record.paused,
    ...(record.lastSkipAt === null ? {} : { lastSkipAt: record.lastSkipAt.toISOString() }),
    ...(record.lastError === null ? {} : { lastError: record.lastError }),
  }
}

function createView(record: ScheduleRecord, displayZone: string): Record<string, unknown> {
  const description = record.paused
    ? `на паузе; ${formatSchedule(record, displayZone)}`
    : formatSchedule(record, displayZone)
  return { ...view(record), description }
}

/**
 * One key for the text of a task: case, runs of spaces and the edges do not
 * matter when two jobs are compared. Jobs with one key send the owner the same
 * report twice, so `create` warns about the copy and `list` groups the group.
 */
function taskKey(task: string): string {
  return task.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * The answer of a create: the new job, plus a warning when the same task text is
 * already scheduled. That is how the owner's chat got two neurokey watchers with
 * one text, and the copy is cheapest to catch at the very call that makes it.
 */
function createdView(
  record: ScheduleRecord,
  others: readonly ScheduleRecord[],
  displayZone: string,
): Record<string, unknown> {
  const created = createView(record, displayZone)
  const twins = others
    .filter((other) => other.id !== record.id && taskKey(other.task) === taskKey(record.task))
    .map((other) => other.id)
  if (twins.length === 0) return created
  return {
    ...created,
    twins,
    hint:
      `такое же задание уже есть: ${twins.join(', ')} — похожие задания присылают один отчёт несколько раз; ` +
      'если это тот же сторож, оставь одно (action remove для лишнего).',
  }
}

/**
 * `list` is read for the ids and the schedule, not for the whole text of every
 * task: with two dozen dev jobs the full dump ran to ~20k characters in one
 * answer and ate the context. A task longer than LIST_TASK_PREVIEW is shortened
 * and its real length kept in `taskChars`; `full: true` returns it untouched.
 * Finished jobs (nextRunAt null) are left out of the list unless `all: true`:
 * they cannot fire again, so their id and schedule only pad the answer. Jobs
 * that repeat one another are grouped in `repeats`: two identical tasks send the
 * owner the same report twice, and the list is where the copy shows up.
 */
function listView(record: ScheduleRecord, displayZone: string, full: boolean): Record<string, unknown> {
  const base = createView(record, displayZone)
  if (full || record.task.length <= LIST_TASK_PREVIEW) return base
  return { ...base, task: `${record.task.slice(0, LIST_TASK_PREVIEW)}…`, taskChars: record.task.length }
}

/** Validate the watch fields of `create`/`update` before the guard and the store see them. */
function watchFromArgs(args: Record<string, unknown>, action: 'create' | 'update'): ScheduleWatch {
  const command = text(args.command)
  if (command === '') throw new Error(`schedule ${action}: укажи command — команду наблюдателя.`)
  const pattern = text(args.pattern)
  if (pattern === '') throw new Error(`schedule ${action}: укажи pattern — регулярное выражение наблюдателя.`)
  const rawWindow = args.window_sec ?? args.window
  const windowSec =
    rawWindow === undefined || rawWindow === ''
      ? DEFAULT_WATCH_WINDOW_SEC
      : typeof rawWindow === 'number'
        ? rawWindow
        : Number(text(rawWindow))
  if (!Number.isFinite(windowSec)) {
    throw new Error(`schedule ${action}: window_sec должен быть числом секунд.`)
  }
  const deliverRaw = text(args.deliver).toLowerCase()
  if (deliverRaw !== '' && deliverRaw !== 'turn' && deliverRaw !== 'raw') {
    throw new Error('schedule watch: deliver должен быть "raw" или "turn".')
  }
  return {
    command,
    pattern,
    windowSec,
    deliver: deliverRaw === 'turn' ? 'turn' : 'raw',
  }
}

/**
 * A watch command is long-lived: it must pass the guard and, for a
 * confirmation-class command, the owner's button before anything is saved.
 */
async function guardWatch(options: ScheduleToolOptions, command: string): Promise<void> {
  if (options.guardCommand === undefined) {
    throw new Error('schedule watch: проверка команды недоступна, наблюдатель не создан.')
  }
  await options.guardCommand(command)
}

/** Build the tool over a registry; the caller registers it for the owner session. */
export function createScheduleTool(options: ScheduleToolOptions): ScheduleTool {
  const { registry } = options
  const zone = registry.timeZone

  const inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        description:
          'watch streams a long command; summary counts runs of 7 days; the rest need id except create and list.',
      },
      schedule: {
        type: 'string',
        description:
          `In the owner's zone (${zone}), not UTC: "every 30m", one-shot "30m", ISO 8601 ` +
          '"2026-12-01T09:00:00" (an explicit Z or offset keeps its instant) or cron "0 9 * * 1-5".',
      },
      task: {
        type: 'string',
        description: 'Instruction for the planned turn.',
      },
      tz: {
        type: 'string',
        description: `IANA zone of the job; default the owner's (${zone}).`,
      },
      until: {
        type: 'string',
        description: 'Optional end, ISO 8601 or epoch ms: the job is removed then.',
      },
      max_runs: {
        type: 'integer',
        minimum: 1,
        description: 'Optional: remove the job after this many runs.',
      },
      idleOnly: {
        type: 'boolean',
        description: 'Start only after the owner turn ends.',
      },
      check: {
        type: 'string',
        description:
          'Exec-sandbox precheck: empty output or last-line no-work JSON skips the tick; exit failure/timeout sets lastError.',
      },
      deliver: {
        type: 'string',
        enum: ['turn', 'raw'],
        description:
          'turn: check output as untrusted model context (default). raw: lines to owner without model; needs check, default for watch.',
      },
      command: {
        type: 'string',
        description: 'Watch: long-running exec-sandbox command, checked by the command guard.',
      },
      pattern: {
        type: 'string',
        description: 'Watch: only output lines matching this regular expression are delivered.',
      },
      window_sec: {
        type: 'number',
        description: 'Watch: batch window in seconds (default 30).',
      },
      agent: {
        type: 'string',
        description:
          'Optional agents.json profile: its tools, instructions and model.',
      },
      effort: {
        type: 'string',
        description: `Reasoning level of this job: ${SCHEDULE_EFFORTS.join(', ')}.`,
      },
      id: {
        type: 'string',
        description: 'Job id from create or list.',
      },
      full: {
        type: 'boolean',
        description: `List: full task text; default preview is ${LIST_TASK_PREVIEW} chars, original length in taskChars.`,
      },
      all: {
        type: 'boolean',
        description: 'List: include finished jobs (nextRunAt null); otherwise only their count in finished.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  }

  return {
    name: 'schedule',
    description:
      `Persistent jobs in ${zone}, not UTC. Results go to owner unless [SILENT]. until/max_runs remove jobs with notice. ` +
      'Relative delays ("5m") are one-shot, never cron. Planned turns cannot request confirmation. ' +
      'check skips empty ticks; watch streams matches in batches and restarts failures with backoff. List before creating to avoid duplicates.',
    inputSchema,
    async execute(args: Record<string, unknown>): Promise<string> {
      const action = normalizeAction(args.action)
      if (action === 'watch') {
        const watch = watchFromArgs(args, 'create')
        // The guard sees the long-lived command before anything is saved; a
        // confirm-class command waits for the owner's button here.
        await guardWatch(options, watch.command)
        const spec = text(args.schedule) || `watch ${watch.windowSec}s`
        const task = text(args.task)
        const tz = text(args.tz) || text(args.timezone)
        const agent = text(args.agent)
        checkAgent(options, 'create', agent)
        if (task !== '') checkTaskTools(options, 'create', task, agent)
        const effort = text(args.effort)
        const input: CreateScheduleInput = {
          spec,
          task: task === '' ? `Наблюдение за потоком: ${watch.command}` : task,
          idleOnly: args.idleOnly === true,
          watch,
        }
        if (tz !== '') input.tz = tz
        if (agent !== '') input.agent = agent
        if (effort !== '') input.effort = effort
        const record = registry.create(input)
        return JSON.stringify(createdView(record, registry.list(), zone), null, 2)
      }
      if (action === 'create') {
        const spec = text(args.schedule)
        if (spec === '') throw new Error('schedule create: укажи schedule (интервал, cron или дату).')
        const task = text(args.task)
        if (task === '') throw new Error('schedule create: укажи task — текст задания.')
        const tz = text(args.tz) || text(args.timezone)
        const until = numberOrText(args.until)
        const maxRuns = args.max_runs ?? (args as Record<string, unknown>).maxRuns
        const check = text(args.check)
        const agent = text(args.agent)
        checkAgent(options, 'create', agent)
        checkTaskTools(options, 'create', task, agent)
        checkRecurringDelay('create', spec, task)
        const effort = text(args.effort)
        const deliverRaw = text(args.deliver).toLowerCase()
        if (deliverRaw !== '' && deliverRaw !== 'turn' && deliverRaw !== 'raw') {
          throw new Error('schedule create: deliver должен быть "turn" или "raw".')
        }
        if (deliverRaw === 'raw' && check === '') {
          throw new Error(
            'schedule create: deliver "raw" требует check — укажи shell-команду проверки, иначе отправлять без модели нечего.',
          )
        }
        const input: CreateScheduleInput = { spec, task, idleOnly: args.idleOnly === true }
        if (tz !== '') input.tz = tz
        if (until !== undefined) input.until = until
        if (check !== '') input.check = check
        if (agent !== '') input.agent = agent
        if (effort !== '') input.effort = effort
        if (deliverRaw === 'raw') input.deliver = 'raw'
        else if (deliverRaw === 'turn') input.deliver = 'turn'
        if (maxRuns !== undefined) {
          if (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
            throw new Error('schedule create: max_runs должен быть целым числом не меньше 1.')
          }
          input.maxRuns = maxRuns
        }
        const record = registry.create(input)
        return JSON.stringify(createdView(record, registry.list(), zone), null, 2)
      }

      if (action === 'list') {
        const full = args.full === true
        const all = args.all === true
        const records = registry.list()
        // A record with nextRunAt null has run out (one-shot fired, or until/max_runs
        // removed it): it can neither fire again nor start a turn. Two dozen dev jobs
        // made those dead rows a third of the answer, so they stay out unless asked.
        const finished = records.filter((record) => record.nextRunAt === null)
        const listed = all ? records : records.filter((record) => record.nextRunAt !== null)
        const jobs = listed.map((record) => listView(record, zone, full))
        const shortened = jobs.filter((job) => 'taskChars' in job).length
        const hints: string[] = []
        if (shortened > 0) {
          hints.push(
            `task сокращён до ${LIST_TASK_PREVIEW} символов у ${shortened} заданий, полная длина — в taskChars; ` +
              'полный текст — action list с full: true.',
          )
        }
        if (finished.length > 0) {
          hints.push(
            all
              ? `в списке ${finished.length} выполненных заданий (nextRunAt null) — они уже не запустятся.`
              : `скрыто выполненных заданий: ${finished.length} (nextRunAt null); они не запустятся, полный ` +
                  'список — action list с all: true.',
          )
        }
        // Two jobs with the same task text send the owner the same report twice: he
        // has to read it twice and the schedule list looks twice as long as it is.
        // The answer already carries every task, so the check is one pass here.
        const byTask = new Map<string, string[]>()
        for (const record of listed) {
          const key = taskKey(record.task)
          if (key === '') continue
          const ids = byTask.get(key)
          if (ids === undefined) byTask.set(key, [record.id])
          else ids.push(record.id)
        }
        const repeats = [...byTask.values()].filter((ids) => ids.length > 1)
        if (repeats.length > 0) {
          const shown = repeats
            .slice(0, 3)
            .map((ids) => ids.join('/'))
            .join(', ')
          hints.push(
            `одинаковое задание у ${repeats.length} групп (${shown}${repeats.length > 3 ? ', …' : ''}) — ` +
              'каждая группа присылает владельцу один и тот же отчёт несколько раз; лишние снять или переписать.',
          )
        }
        const payload: Record<string, unknown> = { timeZone: zone, jobs }
        if (finished.length > 0 && !all) payload.finished = finished.length
        if (repeats.length > 0) payload.repeats = repeats
        if (hints.length > 0) payload.hint = hints.join(' ')
        return JSON.stringify(payload, null, 2)
      }

      if (action === 'summary') {
        return JSON.stringify({ days: SCHEDULE_SUMMARY_DAYS, jobs: registry.summary() }, null, 2)
      }

      const id = text(args.id)
      if (id === '') throw new Error(`schedule ${action}: укажи id задания.`)

      if (action === 'remove') {
        if (!registry.remove(id)) throw notFound(id)
        return JSON.stringify({ removed: id, remaining: registry.list().length }, null, 2)
      }

      if (action === 'update') {
        const existing = registry.get(id)
        if (existing === undefined) throw notFound(id)
        // A watcher keeps its own fields. The command of an update passes the
        // guard before the store changes, so a denied or declined command
        // leaves the saved command exactly as it was.
        if (existing.watch !== null) {
          const watch: Partial<ScheduleWatch> = {}
          if (args.command !== undefined) {
            const command = text(args.command)
            if (command === '') throw new Error('schedule update: пустая команда наблюдателя.')
            await guardWatch(options, command)
            watch.command = command
          }
          if (args.pattern !== undefined) watch.pattern = text(args.pattern)
          const rawWindow = args.window_sec ?? args.window
          if (rawWindow !== undefined) {
            const windowSec = typeof rawWindow === 'number' ? rawWindow : Number(text(rawWindow))
            if (!Number.isFinite(windowSec)) {
              throw new Error('schedule update: window_sec должен быть числом секунд.')
            }
            watch.windowSec = windowSec
          }
          if (args.deliver !== undefined) {
            const deliverRaw = text(args.deliver).toLowerCase()
            if (deliverRaw !== 'turn' && deliverRaw !== 'raw') {
              throw new Error('schedule update: deliver должен быть "raw" или "turn".')
            }
            watch.deliver = deliverRaw
          }
          const input: UpdateScheduleInput = { watch }
          if (args.effort !== undefined) input.effort = text(args.effort)
          const spec = text(args.schedule)
          if (spec !== '') input.spec = spec
          const task = text(args.task)
          if (task !== '') {
            checkTaskTools(options, 'update', task, existing.agent ?? '')
            input.task = task
          }
          if (
            Object.keys(watch).length === 0 &&
            input.spec === undefined &&
            input.task === undefined &&
            input.effort === undefined
          ) {
            throw new Error(
              'schedule update наблюдателя: укажи хотя бы одно поле — command, pattern, window_sec, deliver, task, effort.',
            )
          }
          const record = registry.update(id, input)
          if (record === null) throw notFound(id)
          return JSON.stringify(createView(record, zone), null, 2)
        }
        const input: UpdateScheduleInput = {}
        const spec = text(args.schedule)
        if (spec !== '') input.spec = spec
        const task = text(args.task)
        if (task !== '') {
          const agentAfter = args.agent !== undefined ? text(args.agent) : (existing.agent ?? '')
          checkAgent(options, 'update', agentAfter)
          checkTaskTools(options, 'update', task, agentAfter)
          input.task = task
        }
        const tz = text(args.tz) || text(args.timezone)
        if (tz !== '') input.tz = tz
        const until = numberOrText(args.until)
        if (until !== undefined) input.until = until
        const maxRuns = args.max_runs ?? (args as Record<string, unknown>).maxRuns
        if (maxRuns !== undefined) {
          if (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
            throw new Error('schedule update: max_runs должен быть целым числом не меньше 1.')
          }
          input.maxRuns = maxRuns
        }
        if (args.check !== undefined) input.check = text(args.check)
        if (args.agent !== undefined) {
          const agent = text(args.agent)
          checkAgent(options, 'update', agent)
          input.agent = agent
        }
        const deliverRaw = text(args.deliver).toLowerCase()
        if (deliverRaw !== '') {
          if (deliverRaw !== 'turn' && deliverRaw !== 'raw') {
            throw new Error('schedule update: deliver должен быть "turn" или "raw".')
          }
          input.deliver = deliverRaw === 'raw' ? 'raw' : 'turn'
        }
        if (args.effort !== undefined) input.effort = text(args.effort)
        if (args.idleOnly !== undefined) input.idleOnly = args.idleOnly === true
        if (Object.keys(input).length === 0) {
          throw new Error(
            'schedule update: укажи хотя бы одно поле — schedule, task, tz, until, max_runs, check, deliver, agent, effort.',
          )
        }
        // The effective pair after the change, so a new task on an old cron is
        // checked as strictly as a new job.
        checkRecurringDelay('update', input.spec ?? existing.spec, input.task ?? existing.task)
        const record = registry.update(id, input)
        if (record === null) throw notFound(id)
        return JSON.stringify(createView(record, zone), null, 2)
      }

      if (action === 'pause') {
        const record = registry.pause(id)
        if (record === null) throw notFound(id)
        return JSON.stringify(createView(record, zone), null, 2)
      }

      if (action === 'resume') {
        const record = registry.resume(id)
        if (record === null) throw notFound(id)
        return JSON.stringify(createView(record, zone), null, 2)
      }

      if (action === 'run_now') {
        const record = registry.get(id)
        if (record === undefined) throw notFound(id)
        if (options.runNow === undefined) {
          throw new Error('schedule run_now: исполнитель плановых запусков недоступен.')
        }
        // The run waits behind the owner's turn: the tool answers at once and
        // the planned path reports the result when the turn is over.
        void Promise.resolve(options.runNow(record)).catch(() => undefined)
        return JSON.stringify(
          { id, started: true, paused: record.paused, nextRunAt: record.nextRunAt === null ? null : record.nextRunAt.toISOString() },
          null,
          2,
        )
      }

      // history: the runs outlive their job, so a job removed after its runs
      // (by hand or by max_runs) still shows them from schedule_runs.
      const history = registry.history(id)
      if (registry.get(id) === undefined && history.length === 0) throw notFound(id)
      const runs = history.map((run) => ({
        startedAt: run.startedAt.toISOString(),
        durationMs: run.durationMs,
        status: run.status,
        success: run.status === 'ok',
        output: run.output,
      }))
      return JSON.stringify({ id, runs }, null, 2)
    },
  }
}
