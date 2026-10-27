// `packages/tools-zavod`: the `zavod` tool of the bot.
//
// The bot has its own factory inside the daemon (`packages/factory`), so the
// tool talks to it in process: no external `zavod` CLI, no child process and no
// watcher. The owner's decisions stay on the factory cards in Telegram; the
// model may only create a task and read it back.

import type { RunnerTool } from '../../runner/src/index.js'
import { FACTORY_STATUS_LABELS } from '../../factory/src/index.js'

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
  createTask(input: { text: string; title?: string; project?: string }): ZavodTask
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

const SHORT_DESCRIPTION =
  'Встроенный завод бота: поставить задачу и посмотреть её состояние. ' +
  'new (text, необязательно title и project) создаёт задачу; по умолчанию в собственном репозитории бота, ' +
  'сразу уходит в разбор и присылает владельцу карточку «Одобрить / Править / Отменить». ' +
  'status — задачи: номер, статус и название. show (id) — статус, критерии, footprint, риск, круг и причина. ' +
  'Одобрение разбора, приёмка и возврат — только у владельца на карточках /factory; у инструмента таких действий нет.'

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
    'Созданная задача сразу уходит в разбор, а владельцу приходит обычная карточка разбора.',
  '',
  'status. Список задач завода: номер, статус теми же словами, что в меню /factory, и название.',
  '',
  'show. id задачи: статус, критерии, footprint, риск, круг исполнения и причина, если задача ждёт человека.',
  '',
  'Решения владельца. Одобрение разбора, приёмка и возврат делаются только кнопками на карточках встроенного ' +
    'завода. У инструмента нет действий approve, accept, return, viewed и razbor: такие вызовы отклоняются и ' +
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

/** `#12 ждёт одобрения Название` — the same words as the `/factory` menu. */
function statusLine(task: ZavodTask): string {
  const title = task.title.trim() === '' ? '(без названия)' : task.title
  return `#${task.id} ${statusLabel(task.status)} ${title}`
}

function showText(task: ZavodTask): string {
  const lines = [
    `Задача #${task.id}: ${task.title}`,
    `Проект: ${task.projectName}`,
    `Статус: ${statusLabel(task.status)}`,
  ]
  if (task.risk !== undefined) lines.push(`Риск: ${task.risk}`)
  if (task.progress !== undefined) lines.push(`Круг: ${task.progress.round}`)
  if (task.criteria.length > 0) lines.push('', 'Критерии:', ...task.criteria.map((item) => `- ${item}`))
  else lines.push('', 'Критерии: пока нет (задача ещё не разобрана).')
  if (task.footprint.length > 0) lines.push('', 'Footprint:', ...task.footprint.map((item) => `- ${item}`))
  if (task.reason !== undefined && task.reason.trim() !== '') lines.push('', `Причина: ${task.reason}`)
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
      const input: { text: string; title?: string; project?: string } = { text }
      if (title !== undefined) input.title = title
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
      return tasks.map(statusLine).join('\n')
    }

    // show
    const id = idArg(args)
    const task = factory.findTask(id)
    if (task === undefined) throw new Error(`Задача не найдена: #${id}.`)
    return showText(task)
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
        id: { type: 'number', description: 'show: номер задачи.' },
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
