import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import {
  createFactory,
  type Factory,
  type FactoryAnalysisRunner,
} from '../factory/src/index.js'
import { createZavodTools, type ZavodTools } from './src/index.js'

let root: string
let store: Store
let factory: Factory
let zavod: ZavodTools
let analysis: ReturnType<typeof vi.fn<FactoryAnalysisRunner>>

/** A parsed analysis: the factory accepts it on the first attempt, so one task costs one run. */
const ANALYSIS = JSON.stringify({
  criteria: ['Повтор с тем же ключом возвращает ту же задачу.'],
  footprint: ['src/index.ts'],
  risk: 'low',
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zavod-request-id-'))
  mkdirSync(join(root, 'project'))
  store = openStore(join(root, 'state.db'))
  analysis = vi.fn<FactoryAnalysisRunner>(async () => ANALYSIS)
  const api: TelegramApi = {
    async call<T>(_method: string, params: Record<string, unknown> = {}): Promise<T> {
      return { message_id: 1, chat: { id: params.chat_id } } as T
    },
  }
  factory = createFactory({
    store,
    home: root,
    appRoot: join(root, 'project'),
    api,
    ownerId: () => 4242,
    catalogue: async () => [{ provider: 'test', id: 'test-model', name: 'Test model' }],
    analysis,
  })
  zavod = createZavodTools({ factory })
})

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function call(args: Record<string, unknown>): string {
  return zavod.tools[0]!.execute(args) as string
}

test('new passes a replay key to the factory: one task, one analysis, invalid keys rejected', async () => {
  const createTask = vi.spyOn(factory, 'createTask')
  const schema = zavod.tools[0]!.inputSchema as {
    properties?: Record<string, { type?: string }>
    required?: string[]
  }
  expect(schema.properties?.request_id?.type).toBe('string')
  expect(schema.required).toEqual(['action'])

  const first = call({ action: 'new', text: 'Первая постановка задачи.', request_id: '  key-1  ' })
  // The tool hands the factory the trimmed key and nothing else.
  expect(createTask.mock.calls[0]![0]).toMatchObject({ text: 'Первая постановка задачи.', requestId: 'key-1' })
  const created = /#(\d+)/.exec(first)?.[1]
  expect(created).toBeDefined()
  const id = Number(created)
  await vi.waitFor(() => expect(analysis).toHaveBeenCalledTimes(1))

  // A replay with another text keeps the first task and starts no second analysis.
  const replay = call({ action: 'new', text: 'Другой текст повтора.', request_id: 'key-1' })
  expect(replay).toContain(`Задача #${id} создана`)
  expect(factory.listTasks()).toHaveLength(1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(analysis).toHaveBeenCalledTimes(1)

  // Invalid keys are refused by the tool itself: no task, and the factory is never asked.
  const before = factory.listTasks().length
  for (const wrong of ['   ', 'y'.repeat(257), 42, null]) {
    expect(() => call({ action: 'new', text: 'Плохой ключ.', request_id: wrong })).toThrow(/^zavod:/)
  }
  expect(factory.listTasks()).toHaveLength(before)
  expect(createTask).toHaveBeenCalledTimes(2)

  // Without a key the answer and the factory input stay exactly as before.
  const plain = call({ action: 'new', text: 'Постановка без ключа.' })
  expect(plain).toMatch(/^Задача #\d+ создана в проекте .+ и отправлена на разбор\.$/)
  expect(createTask).toHaveBeenCalledTimes(3)
  expect(createTask.mock.calls[2]![0]).not.toHaveProperty('requestId')
  expect(factory.listTasks()).toHaveLength(before + 1)

  // The project check is unchanged: an unknown project is refused and stores nothing.
  expect(() => call({ action: 'new', text: 'Не тот проект.', project: 'missing-project' }))
    .toThrow(/Подключённые проекты:/)
  expect(createTask).toHaveBeenCalledTimes(3)
  expect(factory.listTasks()).toHaveLength(before + 1)

  await vi.waitFor(() => expect(analysis).toHaveBeenCalledTimes(2))
})
