import { beforeEach, expect, test, vi } from 'vitest'

import { FACTORY_STATUS_LABELS } from '../factory/src/index.js'
import {
  createZavodTools,
  ZAVOD_GUIDE,
  type ZavodFactory,
  type ZavodProject,
  type ZavodTask,
} from './src/index.js'

const tasks: ZavodTask[] = [
  {
    id: 12, title: 'Пустой поиск', body: 'Показать сообщение.', status: 'awaiting_approval',
    projectId: 0, projectName: 'app', projectPath: '/srv/app',
    criteria: ['Пустой поиск показывает сообщение.'], footprint: ['src/search.ts'], risk: 'low',
  },
  {
    id: 13, title: 'Сброс', body: 'Очистить строку.', status: 'awaiting_human',
    projectId: 4, projectName: 'search-service', projectPath: '/srv/search',
    criteria: ['Сброс очищает строку.'], footprint: ['src/view.ts'], risk: 'high',
    reason: 'Третий круг не прошёл гейт.', progress: { stage: 'review', round: 3 },
  },
]
const projects: ZavodProject[] = [
  { id: 0, name: 'app', path: '/srv/app', own: true },
  { id: 4, name: 'search-service', path: '/srv/search', own: false },
]

/** Forty gate lines: the shape of a real failure note, where only head and end matter. */
const longGateTail = Array.from({ length: 40 }, (_, index) => `FAIL ${String(index + 1).padStart(2, '0')}`).join('\n')

tasks.push({
  id: 14, title: 'Гейт упал', body: 'Починить гейт.', status: 'awaiting_human',
  projectId: 0, projectName: 'app', projectPath: '/srv/app',
  criteria: ['Гейт зелёный.'], footprint: ['src/gate.ts'], risk: 'high',
  reason: `Гейт не пройден (exit 1). Хвост вывода тестов:\n${longGateTail}`,
})
const created: Array<{ text: string; title?: string; project?: string }> = []

beforeEach(() => { created.length = 0 })

function factory(): ZavodFactory {
  return {
    listTasks: () => tasks,
    findTask: (id) => tasks.find((task) => task.id === id),
    listProjects: () => projects,
    createTask(input) {
      created.push(input)
      return {
        id: 21, title: input.title ?? input.text.split('\n')[0]!, body: input.text, status: 'analysis',
        projectId: input.project === undefined ? 0 : 4,
        projectName: input.project ?? 'app',
        projectPath: input.project === undefined ? '/srv/app' : '/srv/search',
        criteria: [], footprint: [],
      }
    },
  }
}

function call(args: Record<string, unknown>): string {
  const tool = createZavodTools({ factory: factory() }).tools[0]!
  return tool.execute(args) as string
}

test('new_creates_a_task_in_the_own_repository_and_returns_its_number', () => {
  const text = call({ action: 'new', text: 'Показать пустой поиск.' })
  expect(text).toContain('21')
  expect(created).toEqual([{ text: 'Показать пустой поиск.' }])
  expect(() => call({ action: 'new', project: 'missing', text: 'Task' })).toThrow()
  for (const action of ['approve', 'accept', 'return', 'viewed', 'razbor']) expect(() => call({ action, id: 12 })).toThrow(/владельца/)
  expect(created).toHaveLength(1)
})

const unfinishedStatuses = [
  'incoming', 'analysis', 'awaiting_approval', 'queued', 'running', 'awaiting_human',
] as const

function diagnosticTask(id: number, status: string, extra: Partial<ZavodTask> = {}): ZavodTask {
  return {
    id, status, title: `Диагностика ${id}`, body: 'Проверить состояние задачи.',
    projectId: 0, projectName: 'app', projectPath: '/srv/app',
    criteria: ['Состояние доступно для чтения.'], footprint: ['src/view.ts'],
    ...extra,
  }
}

function diagnosticTool(state: ZavodTask[]) {
  return createZavodTools({
    factory: {
      ...factory(),
      listTasks: () => state,
      findTask: (id) => state.find((task) => task.id === id),
    },
  }).tools[0]!
}

// Keep assertions local to a task even if its details span several lines.
function taskReport(text: string, id: number): string {
  const report = text.split(/(?=#\d+\b)/).find((part) => part.startsWith(`#${id} `))
  expect(report, `В status нет задачи #${id}`).toBeDefined()
  return report!
}

function expectMissingDiagnostic(text: string, field: RegExp) {
  // Permit either individual unknown fields or a shared missing-data section,
  // without fixing the exact wording/format of the diagnostic report.
  const missing = /неизвест|не\s+указан|нет\s+(?:данных|сведений)|отсутств|не\s+хватает|недостаточно\s+данных|недостающ/i
  const diagnostics = text.split(/\n\s*\n/).filter((block) => missing.test(block)).join('\n')
  expect(diagnostics, 'Нужна явная диагностика отсутствующих данных').not.toBe('')
  expect(diagnostics).toMatch(field)
}

test('status_and_show_only_read_shared_factory_state_even_on_repeated_calls', () => {
  const state = unfinishedStatuses.map((status, index) => diagnosticTask(400 + index, status))
  state.push(diagnosticTask(410, 'running', { progress: { stage: 'gate', round: 2 } }))
  state.push(diagnosticTask(411, 'awaiting_human', {
    reason: 'Нужно согласовать миграцию.', progress: { stage: 'review', round: 3 },
  }))
  const before = JSON.parse(JSON.stringify(state)) as ZavodTask[]
  // Frozen live objects also catch writes that might otherwise be undone before return.
  for (const task of state) {
    if (task.progress !== undefined) Object.freeze(task.progress)
    Object.freeze(task.criteria)
    Object.freeze(task.footprint)
    Object.freeze(task)
  }
  Object.freeze(state)
  const backend = {
    listTasks: vi.fn(() => state),
    findTask: vi.fn((id: number) => state.find((task) => task.id === id)),
    listProjects: vi.fn(() => projects),
    createTask: vi.fn(factory().createTask),
  } satisfies ZavodFactory
  const tool = createZavodTools({ factory: backend }).tools[0]!
  const firstStatus = tool.execute({ action: 'status' })
  expect(state).toEqual(before)
  expect(tool.execute({ action: 'status' })).toBe(firstStatus)
  for (const task of state) {
    const firstShow = tool.execute({ action: 'show', id: task.id })
    expect(state).toEqual(before)
    expect(tool.execute({ action: 'show', id: task.id })).toBe(firstShow)
    expect(state).toEqual(before)
  }
  expect(tool.execute({ action: 'status' })).toBe(firstStatus)
  expect(state).toEqual(before)
  expect(backend.listTasks).toHaveBeenCalledTimes(3)
  expect(backend.findTask).toHaveBeenCalledTimes(state.length * 2)
  expect(backend.createTask).not.toHaveBeenCalled()
  expect(backend.listProjects).not.toHaveBeenCalled()
  expect(created).toEqual([])
})

function statusDocumentation(text: string): string {
  // Check the status clause, not a mention of progress/reason under show.
  const clause = text.match(/status\s*[.\-—:]\s*([\s\S]*?)(?=\bshow\b|\n\s*\n|$)/i)?.[1]
  expect(clause, 'Документация должна описывать status').toBeDefined()
  return clause!
}
