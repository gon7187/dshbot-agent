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
import type {
  CreateScheduleInput,
  ScheduleRecord,
  ScheduleRegistry,
  ScheduleWatch,
  UpdateScheduleInput,
} from './jobs.js'
import { DEFAULT_WATCH_WINDOW_SEC } from './jobs.js'

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
   * Guard and owner approval for the command of a stream watcher. It throws a
   * refusal (with the reason) when the guard denies the command or the owner
   * declines the card, so nothing is saved and nothing starts. A watch created
   * or updated without a guard is refused: a long-lived command must never
   * bypass the guard.
   */
  guardCommand?: (command: string) => Promise<void>
}

const ACTIONS = ['create', 'watch', 'list', 'remove', 'update', 'pause', 'resume', 'run_now', 'history'] as const
type Action = (typeof ACTIONS)[number]

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
  throw new Error(
    `schedule: неизвестное действие "${raw || 'пусто'}"; допустимы create, list, remove, update, pause, resume, run_now, history.`,
  )
}

function notFound(id: string): Error {
  return new Error(`schedule: задание "${id}" не найдено.`)
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
          'create a job, watch a long command stream, list the saved jobs, remove one by id, update, pause, ' +
          'resume, run once now, or show history',
      },
      schedule: {
        type: 'string',
        description:
          `When to run, in the owner's time zone (${zone}) — do not convert it to UTC yourself. ` +
          'Interval "every 30m", one-shot "30m" or ISO 8601 "2026-12-01T09:00:00" in the job zone; ' +
          'an explicit Z or numeric offset keeps its absolute instant. ' +
          `Five-field cron "0 9 * * 1-5" (09:00 in ${zone}).`,
      },
      task: {
        type: 'string',
        description: 'What the planned turn must do, written as a complete instruction.',
      },
      tz: {
        type: 'string',
        description:
          `IANA time zone of the job (e.g. "Europe/Moscow"); defaults to the owner's zone (${zone}). ` +
          'Cron and wall-clock times of the job are read in it.',
      },
      until: {
        type: 'string',
        description:
          'Optional end: an ISO 8601 moment (e.g. "2026-12-01T12:00:00Z") or epoch milliseconds. ' +
          'The job is removed at that moment and the owner gets one line; nothing runs after it.',
      },
      max_runs: {
        type: 'integer',
        minimum: 1,
        description: 'Optional end: remove the job after this many planned runs and tell the owner once.',
      },
      idleOnly: {
        type: 'boolean',
        description: 'Wait for the owner turn to finish before the planned turn starts.',
      },
      check: {
        type: 'string',
        description:
          'Optional shell command run before the planned turn in the same sandbox as exec. Empty output or a ' +
          'last JSON line with the explicit no-work signal means no model call and the tick is marked skipped. ' +
          'Nonzero exit or timeout is recorded as lastError and never starts a turn.',
      },
      deliver: {
        type: 'string',
        enum: ['turn', 'raw'],
        description:
          'How the result reaches the owner: "turn" (default) starts a planned turn with the output as ' +
          'untrusted context; "raw" sends the lines to the owner as plain text without a model call. For a ' +
          'checked job "raw" requires check; for a watch it is the default.',
      },
      command: {
        type: 'string',
        description:
          'Shell command of a stream watch (action "watch"): a long-running command kept alive in the exec ' +
          'sandbox (for example "journalctl -f" or "tail -f app.log"). It is checked by the command guard.',
      },
      pattern: {
        type: 'string',
        description:
          'Regular expression of a stream watch: only output lines that match it are delivered to the owner.',
      },
      window_sec: {
        type: 'number',
        description:
          'Batch window of a stream watch in seconds: matches inside one window are collected into one ' +
          'delivery. Default 30.',
      },
      agent: {
        type: 'string',
        description:
          'Optional name of an agent profile from agents.json (list with /tools). The planned turn then runs ' +
          'in that profile: only its tools, its instructions and its model, instead of main. An unknown name is refused.',
      },
      id: {
        type: 'string',
        description: 'Id of the job to remove, as returned by create or list.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  }

  return {
    name: 'schedule',
    description:
      'Плановые задания бота: создаёт, перечисляет, изменяет, ставит на паузу и возобновляет, запускает сейчас и ' +
      'показывает историю запусков. Время в расписании указывай в часовом поясе ' +
      `владельца (${zone}) без ручного пересчёта в UTC: cron "0 9 * * 1-5" — это 09:00 у владельца. ` +
      'Созданное задание сохраняется в хранилище и переживает перезапуск демона; когда срок наступает, бот ' +
      'выполняет текст задания в плановом ходе и присылает владельцу итог (или молчит, если итог — [SILENT]). ' +
      'Для задания с ограничением укажи until (момент) и/или max_runs: по достижении задание снимается само ' +
      'и владелец получает одну строку. Подтверждения в плановом ходе не запрашиваются: такой вызов сразу ' +
      'получает отказ. Дешёвый монитор задавай через check — детерминированную shell-команду в песочнице ' +
      'exec; пустой тик не будит модель. deliver: "raw" отправляет stdout проверки владельцу без модели ' +
      '(нужен check). Для долгой команды (journalctl -f, tail -f) задавай action "watch" с command, pattern ' +
      '(регулярное выражение), window_sec (окно пачки) и deliver: команда идёт через песочницу exec, ' +
      'совпадения приходят владельцу пачкой, а при падении команда перезапускается с растущей задержкой. ' +
      'Список сначала: не дублируй существующее задание.',
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
        const input: CreateScheduleInput = {
          spec,
          task: task === '' ? `Наблюдение за потоком: ${watch.command}` : task,
          idleOnly: args.idleOnly === true,
          watch,
        }
        if (tz !== '') input.tz = tz
        if (agent !== '') input.agent = agent
        const record = registry.create(input)
        return JSON.stringify(createView(record, zone), null, 2)
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
        if (deliverRaw === 'raw') input.deliver = 'raw'
        else if (deliverRaw === 'turn') input.deliver = 'turn'
        if (maxRuns !== undefined) {
          if (typeof maxRuns !== 'number' || !Number.isSafeInteger(maxRuns) || maxRuns < 1) {
            throw new Error('schedule create: max_runs должен быть целым числом не меньше 1.')
          }
          input.maxRuns = maxRuns
        }
        const record = registry.create(input)
        return JSON.stringify(createView(record, zone), null, 2)
      }

      if (action === 'list') {
        const jobs = registry.list().map((record) => createView(record, zone))
        return JSON.stringify({ timeZone: zone, jobs }, null, 2)
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
          const spec = text(args.schedule)
          if (spec !== '') input.spec = spec
          const task = text(args.task)
          if (task !== '') input.task = task
          if (
            Object.keys(watch).length === 0 &&
            input.spec === undefined &&
            input.task === undefined
          ) {
            throw new Error(
              'schedule update наблюдателя: укажи хотя бы одно поле — command, pattern, window_sec, deliver, task.',
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
        if (task !== '') input.task = task
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
        if (args.idleOnly !== undefined) input.idleOnly = args.idleOnly === true
        if (Object.keys(input).length === 0) {
          throw new Error(
            'schedule update: укажи хотя бы одно поле — schedule, task, tz, until, max_runs, check, deliver, agent.',
          )
        }
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
