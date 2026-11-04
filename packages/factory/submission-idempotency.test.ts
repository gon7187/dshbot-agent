import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory } from './src/index.js'

let root: string
let store: Store
let factory: Factory
let sends: number

function reopenFactory(): Factory {
  const api: TelegramApi = {
    async call<T>(_method: string, params: Record<string, unknown> = {}): Promise<T> {
      sends++
      return { message_id: 1, chat: { id: params.chat_id } } as T
    },
  }
  return createFactory({
    store,
    home: root,
    appRoot: join(root, 'project'),
    api,
    ownerId: () => 4242,
    catalogue: async () => [],
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-submission-'))
  mkdirSync(join(root, 'project'))
  store = openStore(join(root, 'state.db'))
  sends = 0
  factory = reopenFactory()
})

afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  store.close()
  rmSync(root, { recursive: true, force: true })
})

test('the request mapping survives closing the store and reopening the factory', async () => {
  const first = factory.createTask({ text: 'Check after restart', requestId: 'restart-1' })
  expect(factory.createTask({ text: 'Changed retry text', requestId: 'restart-1' }).id).toBe(first.id)
  await new Promise<void>((resolve) => setImmediate(resolve))
  store.close()
  store = openStore(join(root, 'state.db'))
  factory = reopenFactory()
  const beforeReplay = sends
  const replay = factory.createTask({ text: 'Check after restart', requestId: 'restart-1' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(replay.id).toBe(first.id)
  expect(factory.listTasks()).toHaveLength(1)
  expect(sends).toBe(beforeReplay)
})

test('invalid request keys save no task', () => {
  for (const requestId of ['', ' \n\t ', 'x'.repeat(257), 123 as unknown as string]) {
    expect(() => factory.createTask({ text: 'Check validation', requestId })).toThrow(/requestId/)
    expect(factory.listTasks()).toEqual([])
  }
})

test('failure to persist the request mapping rolls back the task before analysis starts', () => {
  store.db.exec(`CREATE TRIGGER reject_submission BEFORE INSERT ON factory_task_requests
    BEGIN SELECT RAISE(ABORT, 'submission failure'); END`)
  expect(() => factory.createTask({ text: 'Atomic submission', requestId: 'atomic-1' }))
    .toThrow('submission failure')
  expect(factory.listTasks()).toEqual([])
  expect(sends).toBe(0)
  store.db.exec('DROP TRIGGER reject_submission')
  expect(factory.createTask({ text: 'Retry after rollback', requestId: 'atomic-1' }).body)
    .toBe('Retry after rollback')
})
