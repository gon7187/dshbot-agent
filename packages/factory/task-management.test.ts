import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openStore } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory } from './src/index.js'
import { createZavodTools } from '../tools-zavod/src/index.js'

test('owner management preserves results and replay ids, refuses busy tasks and stale return cards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-management-'))
  mkdirSync(join(root, 'project'))
  const store = openStore(join(root, 'state.db'))
  const api: TelegramApi = { async call<T>(): Promise<T> { return { message_id: 1 } as T } }
  let owner: number | null = null
  const factory = createFactory({ store, home: root, appRoot: join(root, 'project'), api,
    ownerId: () => owner, catalogue: async () => [] })
  const call = (args: Record<string, unknown>) => createZavodTools({ factory }).tools[0]!.execute(args)
  try {
    const task = factory.createTask({ text: 'Keep existing result', requestId: 'kept' })
    owner = 42
    store.db.prepare(`UPDATE factory_tasks SET status = 'running' WHERE id = ?`).run(task.id)
    expect(() => call({ action: 'cancel', id: task.id, reason: 'unused' })).toThrow(/занят/)
    store.db.prepare(`UPDATE factory_tasks SET status = 'awaiting_human', result_files = '["kept.ts"]',
      worktree = '/saved/result', execution_note = 'gate failed' WHERE id = ?`).run(task.id)
    await factory.handleCallback({ id: 'remark', fromId: 42, chatId: 42, messageId: 1, data: `f1:rv:${task.id}` })
    expect(() => call({ action: 'delete', id: task.id, reason: 'unused' })).toThrow(/отмен/)
    call({ action: 'cancel', id: task.id, reason: 'unused' })
    for (const op of ['ae', 'ay']) {
      await factory.handleCallback({ id: op, fromId: 42, chatId: 42, messageId: 1, data: `f1:${op}:${task.id}` })
    }
    await factory.takeInput(42, 'stale return remark')
    expect(factory.findTask(task.id)?.status).toBe('rejected')
    call({ action: 'delete', id: task.id, reason: 'hide' })
    expect(factory.listTasks()).toEqual([])
    expect(factory.findTask(task.id)?.changedFiles).toEqual(['kept.ts'])
    expect(factory.findTask(task.id)?.archived).toBe(true)
    expect(factory.createTask({ text: 'retry', requestId: 'kept' }).id).toBe(task.id)
    expect(() => call({ action: 'return', id: task.id, remark: 'resurrect' })).toThrow()
    expect(store.db.prepare('SELECT worktree FROM factory_tasks WHERE id = ?').get(task.id))
      .toEqual({ worktree: '/saved/result' })
    expect(factory.findTask(task.id)?.managementLog).toContain('unused')
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve))
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
