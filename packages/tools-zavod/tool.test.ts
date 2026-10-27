import { beforeEach, expect, test } from 'vitest'

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
})

test('new_rejects_an_unknown_project_and_lists_connected_ones_without_creating', () => {
  expect(() => call({ action: 'new', project: 'missing', text: 'Задача' })).toThrow(/подключённые проекты/i)
  expect(() => call({ action: 'new', project: 'missing', text: 'Задача' })).toThrow(/search-service/)
  expect(created).toEqual([])
})

test('status_uses_the_factory_menu_status_words', () => {
  const text = call({ action: 'status' })
  expect(text).toContain('#12 ждёт одобрения Пустой поиск')
  expect(text).toContain('#13 ждёт человека Сброс')
})

test('show_prints_criteria_footprint_risk_round_and_reason', () => {
  const text = call({ action: 'show', id: 13 })
  expect(text).toContain('Критерии:')
  expect(text).toContain('Сброс очищает строку.')
  expect(text).toContain('src/view.ts')
  expect(text).toContain('Риск: high')
  expect(text).toContain('Круг: 3')
  expect(text).toContain('Третий круг не прошёл гейт.')
  expect(() => call({ action: 'show', id: 999 })).toThrow(/задача не найдена/i)
})

test('owner_decisions_are_refused_and_change_nothing', () => {
  for (const action of ['approve', 'accept', 'return', 'viewed', 'razbor']) {
    expect(() => call({ action, id: 12 }), action).toThrow(/владельца/)
    expect(() => call({ action, id: 12 }), action).toThrow(/карточк/)
    expect(() => call({ action, id: 12 }), action).toThrow(/\/factory|встроенн/)
  }
  expect(created).toEqual([])
})

test('help_describes_the_embedded_factory', () => {
  expect(call({ action: 'help' })).toBe(ZAVOD_GUIDE)
  expect(ZAVOD_GUIDE).toContain('/factory')
})
