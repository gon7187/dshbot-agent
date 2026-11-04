// `packages/tools-zavod`: the `zavod` tool of the bot.
//
// The bot has its own factory inside the daemon (`packages/factory`), so the
// tool talks to it in process: no external `zavod` CLI, no child process and no
// watcher. The model creates and reads tasks; the owner's factory autopilot
// setting controls automatic approval and acceptance of low-risk work.

import type { RunnerTool } from '../../runner/src/index.js'
import {
  FACTORY_MAX_ROUNDS,
  FACTORY_STAGE_LABELS,
  FACTORY_STATUS_LABELS,
} from '../../factory/src/index.js'

/** Tool name in the model schema. */
export const ZAVOD_TOOL_NAME = 'zavod'

/** Actions the model may perform. */
export const ZAVOD_ACTIONS = ['new', 'status', 'show', 'help'] as const

export type ZavodAction = (typeof ZAVOD_ACTIONS)[number]

/** Decisions that exist only on the owner's cards in the built-in factory. */
export const OWNER_DECISIONS = ['approve', 'accept', 'return', 'viewed', 'razbor'] as const

/** The part of one embedded factory task this tool reads. */
export interface ZavodTask {
  id: number
  title: string
  body: string
  status: string
  projectId: number
  projectName: string
  projectPath: string
  criteria: string[]
  footprint: string[]
  risk?: string
  reason?: string
  progress?: { stage: string; round: number }
}

/** The part of one connected project this tool reads. */
export interface ZavodProject {
  id: number
  name: string
  path: string
  own: boolean
}

/** The in-process factory seam supplied by `packages/app`. */
export interface ZavodFactory {
  createTask(input: { text: string; title?: string; project?: string; requestId?: string }): ZavodTask
  listTasks(): ZavodTask[]
  findTask(id: number): ZavodTask | undefined
  listProjects(): ZavodProject[]
}

export interface ZavodToolOptions {
  factory: ZavodFactory
}

/** The zavod capability: the model tool plus a teardown hook. */
export interface ZavodTools {
  tools: RunnerTool[]
  stop(): Promise<void>
}

/** Factory bound on a replay key: the same bound it validates in `createTask`. */
const REQUEST_ID_MAX_LENGTH = 256

const SHORT_DESCRIPTION =
  'Встроенный завод бота: поставить задачу и посмотреть её состояние. ' +
  'new (text, необязательно title, project и request_id) создаёт задачу; по умолчанию в собственном репозитории бота, ' +
  'сразу уходит в разбор и присылает владельцу карточку «Одобрить / Править / Отменить». ' +
  'request_id — необязательный ключ повтора: не выдумывай его, а при повторе того же вызова передай тот же ключ, ' +
  'и вернётся та же задача без второго разбора. ' +
  'status — все задачи завода: номер, русский статус и название, у задачи в работе — этап и круг, ' +
  'у ждущей человека — причина ожидания, у задачи в очереди — что она ждёт очереди. ' +
  'show (id) — статус, критерии, footprint, риск, прогресс и причина, а также каких данных не хватает. ' +
  'Длинная причина сокращается; целиком — show с full: true. ' +
  'Включённый владельцем автопилот /factory сам одобряет и принимает задачи низкого риска после гейта и ревью. ' +
  'У инструмента нет действий одобрения, приёмки и возврата; вручную они доступны на карточках /factory.'

/** Full guide of the `help` action: short enough to stay out of the prompt prefix. */
export const ZAVOD_GUIDE = [
  'Завод: как ставить задачи и смотреть их состояние.',
  '',
  'У бота свой встроенный завод, он открывается командой владельца /factory. Внешний CLI zavod не нужен: ' +
    'инструмент работает с заводом внутри демона.',
  '',
  'new. text — постановка: что сделать, зачем, границы. title — необязательный короткий заголовок; ' +
    'без него названием станет первая строка текста. project — необязательное имя подключённого проекта завода; ' +
    'без него задача создаётся в собственном репозитории бота. Неизвестный проект — ошибка со списком подключённых. ' +
    'request_id — необязательный ключ повтора: не выдумывай его, а при повторе того же вызова передай тот же ключ, ' +
    'и завод вернёт ту же задачу с тем же номером, не запуская второй разбор. ' +
    'Созданная задача сразу уходит в разбор, а владельцу приходит обычная карточка разбора.',
  '',
  'status. Все задачи завода, включая незавершённые: номер, статус теми же словами, что в меню /factory, ' +
    'и название. У задачи в работе тут же видны этап и круг исполнения, у ждущей человека — причина ожидания, ' +
    'у задачи в очереди — что она ждёт очереди, у задачи на разборе — что идёт разбор. ' +
    'Если прогресс или причина в задаче не записаны, status честно пишет, что они неизвестны.',
  '',
  'show. id задачи: статус, критерии, footprint, риск, этап и круг исполнения и причина. ' +
    'Длинная причина сокращается до первых 8 и последних 12 строк; full: true отдаёт её целиком. ' +
    'Каких данных для диагностики не хватает, show перечисляет отдельно и не подставляет вместо них выдуманные значения.',
  '',
  'Решения владельца. Автопилот включается владельцем в /factory: задачи низкого риска проходят одобрение ' +
    'и приёмку автоматически после зелёного гейта и независимого ревью. Высокий риск и ошибки остаются владельцу. ' +
    'Ручное одобрение, приёмка и возврат доступны на карточках. У инструмента нет действий approve, accept, return, viewed и razbor: такие вызовы отклоняются и ' +
    'ничего не меняют в задаче.',
].join('\n')

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function requiredString(args: Record<string, unknown>, name: string, what: string): string {
  const value = stringArg(args, name)
  if (value === undefined) throw new Error(`zavod: ${what} (${name}) обязателен.`)
  return value
}

/**
 * The replay key, normalized the way the factory stores it. Unlike `stringArg`,
 * a present but wrong value is an error: a silently dropped key would replay as
 * a new task and a second analysis.
 */
function requestIdArg(args: Record<string, unknown>): string | undefined {
  const raw = args.request_id
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('zavod: request_id должен быть строкой.')
  const requestId = raw.trim()
  if (requestId === '') throw new Error('zavod: request_id не может быть пустым.')
  if (requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw new Error(`zavod: request_id длиннее ${REQUEST_ID_MAX_LENGTH} символов.`)
  }
  return requestId
}

function idArg(args: Record<string, unknown>): number {
  const raw = args.id
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw.trim())
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }
  throw new Error('zavod: id задачи обязателен и должен быть положительным числом.')
}

function statusLabel(status: string): string {
  return (FACTORY_STATUS_LABELS as Readonly<Record<string, string>>)[status] ?? status
}

function stageLabel(stage: string): string {
  return (FACTORY_STAGE_LABELS as Readonly<Record<string, string>>)[stage] ?? stage
}

/** True when a field carries an actual value; a blank string explains nothing. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ''
}

/** The recorded execution progress, or undefined when it is absent or incomplete. */
function progressOf(task: ZavodTask): { stage: string; round: number } | undefined {
  const progress = task.progress
  if (progress === undefined) return undefined
  if (typeof progress.stage !== 'string' || progress.stage.trim() === '') return undefined
  if (!Number.isSafeInteger(progress.round) || progress.round <= 0) return undefined
  return progress
}

/** `#12 ждёт одобрения Название` — the same words as the `/factory` menu. */
function statusLine(task: ZavodTask): string {
  const title = task.title.trim() === '' ? '(без названия)' : task.title
  return `#${task.id} ${statusLabel(task.status)} ${title}`
}

/** Extra lines of the status list: where an unfinished task actually stands. */
function statusDetails(task: ZavodTask): string[] {
  const progress = progressOf(task)
  switch (task.status) {
    case 'incoming':
      return ['ждёт начала разбора']
    case 'analysis':
      return ['идёт разбор: анализ задачи ещё не закончен']
    case 'awaiting_approval':
      return ['разбор готов: ждёт одобрения владельца на карточке /factory']
    case 'queued':
      return ['ждёт очереди: исполнитель ещё не взял задачу в работу']
    case 'running':
      return progress === undefined
        ? ['прогресс неизвестен: завод не сообщил ни этап, ни круг исполнения']
        : [`этап: ${stageLabel(progress.stage)}, круг ${progress.round} из ${FACTORY_MAX_ROUNDS}`]
    case 'awaiting_human':
      return hasText(task.reason)
        ? [`причина: ${shortenReason(task.reason.trim(), { full: false, taskId: task.id })}`]
        : ['причина неизвестна: завод не записал, почему задача ждёт человека']
    case 'merged':
      return ['влито: задача завершена']
    case 'rejected':
      return ['отклонено: задача завершена']
    default:
      return []
  }
}

/** One line per task plus, where it helps, the same facts show prints. */
function statusEntry(task: ZavodTask): string {
  const details = statusDetails(task)
  if (details.length === 0) return statusLine(task)
  return [statusLine(task), ...details.map((line) => `  ${line}`)].join('\n')
}

export const REASON_HEAD_LINES = 8
export const REASON_TAIL_LINES = 12

/** Keep the verdict and the final error while bounding repeated gate output. */
export function shortenReason(reason: string, options: { full: boolean; taskId: number }): string {
  const lines = reason.split('\n')
  const keep = REASON_HEAD_LINES + REASON_TAIL_LINES
  if (options.full || lines.length <= keep) return reason
  return [
    ...lines.slice(0, REASON_HEAD_LINES),
    `…обрезано ${lines.length - keep} строк из ${lines.length}; целиком — zavod show с id ${options.taskId} и full: true`,
    ...lines.slice(-REASON_TAIL_LINES),
  ].join('\n')
}

function showText(task: ZavodTask, full: boolean): string {
  const progress = progressOf(task)
  const lines = [
    `Задача #${task.id}: ${task.title}`,
    `Проект: ${task.projectName}`,
    `Статус: ${statusLabel(task.status)}`,
  ]
  if (hasText(task.risk)) lines.push(`Риск: ${task.risk}`)
  if (progress !== undefined) {
    lines.push(`Этап: ${stageLabel(progress.stage)}`)
    lines.push(`Круг: ${progress.round} из ${FACTORY_MAX_ROUNDS}`)
  }
  if (task.criteria.length > 0) lines.push('', 'Критерии:', ...task.criteria.map((item) => `- ${item}`))
  else lines.push('', 'Критерии: в задаче не указаны.')
  if (task.footprint.length > 0) lines.push('', 'Footprint:', ...task.footprint.map((item) => `- ${item}`))
  else lines.push('', 'Footprint: в задаче не указан.')
  if (hasText(task.reason)) lines.push('', `Причина: ${shortenReason(task.reason.trim(), { full, taskId: task.id })}`)

  const missing: string[] = []
  if (!hasText(task.reason)) {
    missing.push('- причина (reason): завод не записал, почему задача ждёт или что решил владелец')
  }
  if (progress === undefined) {
    missing.push('- прогресс (progress): завод не записал этап и круг исполнения')
  }
  if (missing.length > 0) lines.push('', 'Чего не хватает для диагностики:', ...missing)
  return lines.join('\n')
}

/** Creates the `zavod` tool bound to the in-process factory. */
export function createZavodTools(options: ZavodToolOptions): ZavodTools {
  const { factory } = options

  function execute(args: Record<string, unknown>): string {
    const action = stringArg(args, 'action')
    if (action !== undefined && (OWNER_DECISIONS as readonly string[]).includes(action)) {
      throw new Error(
        `Отказ: действие ${action} — решение владельца на карточке встроенного завода /factory. ` +
          'Инструмент zavod не выполняет approve, accept, return, viewed и razbor и ничего не меняет в задаче.',
      )
    }
    if (action === undefined || !(ZAVOD_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`zavod: неизвестное действие. Доступны: ${ZAVOD_ACTIONS.join(', ')}.`)
    }
    if (action === 'help') return ZAVOD_GUIDE

    if (action === 'new') {
      const text = requiredString(args, 'text', 'текст задачи')
      const title = stringArg(args, 'title')
      const project = stringArg(args, 'project')
      // Reject a bad replay key before any task exists, so a replay never dies as a duplicate.
      const requestId = requestIdArg(args)
      const input: { text: string; title?: string; project?: string; requestId?: string } = { text }
      if (title !== undefined) input.title = title
      if (requestId !== undefined) input.requestId = requestId
      if (project !== undefined) {
        const connected = factory.listProjects()
        if (!connected.some((entry) => entry.name === project)) {
          throw new Error(
            `Проект ${project} не подключён к заводу. Подключённые проекты: ` +
              `${connected.map((entry) => entry.name).join(', ')}.`,
          )
        }
        input.project = project
      }
      const task = factory.createTask(input)
      return `Задача #${task.id} создана в проекте ${task.projectName} и отправлена на разбор.`
    }

    if (action === 'status') {
      const tasks = factory.listTasks()
      if (tasks.length === 0) return 'Задач завода пока нет.'
      return tasks.map(statusEntry).join('\n')
    }

    // show
    const id = idArg(args)
    const task = factory.findTask(id)
    if (task === undefined) throw new Error(`Задача не найдена: #${id}.`)
    return showText(task, args.full === true)
  }

  const tool: RunnerTool = {
    name: ZAVOD_TOOL_NAME,
    description: SHORT_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ZAVOD_ACTIONS],
          description: 'Что сделать: new, status, show или help.',
        },
        text: { type: 'string', description: 'new: постановка задачи.' },
        title: { type: 'string', description: 'new: необязательный короткий заголовок.' },
        project: {
          type: 'string',
          description: 'new: имя подключённого проекта завода; без него — собственный репозиторий бота.',
        },
        request_id: {
          type: 'string',
          description:
            'new: необязательный ключ повтора до 256 символов. Не выдумывай его; при повторе того же ' +
            'вызова передай тот же ключ — вернётся та же задача без второго разбора.',
        },
        id: { type: 'number', description: 'show: номер задачи.' },
        full: { type: 'boolean', description: 'show: причина целиком, без сокращения длинного вывода гейта.' },
      },
      required: ['action'],
    },
    execute(args) {
      return execute(args as Record<string, unknown>)
    },
  }

  return {
    tools: [tool],
    stop(): Promise<void> {
      return Promise.resolve()
    },
  }
}

/** Statuses the factory menu reports as waiting for a person or finished. */
export function isReportableStatus(status: string): boolean {
  return status === 'awaiting_human' || status === 'rejected' || status === 'merged'
}
