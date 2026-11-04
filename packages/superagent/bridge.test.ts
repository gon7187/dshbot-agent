import { DatabaseSync } from 'node:sqlite'
import { createServer, request, request as httpRequest } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, test, vi } from 'vitest'
import { createSuperagentBridge, type SuperagentBridgeInput, type SuperagentUsage } from './src/bridge.js'
import { tmpdir } from 'node:os'
import { type Factory, type FactoryTask, type FactoryTaskInput } from '../factory/src/index.js'
import { createSuperagent } from './src/index.js'
import { SqliteRepositories } from './src/repository.js'
import { requestPanel, startPanelProxy } from './src/panel.js'

describe('own durable channel', () => {
type Response = { status: number; body: unknown }

const resources: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})

function fixture(options: {
  send?: (input: { chatId: number; replyTo: number; text: string }) => Promise<{ messageId: number }>
  projects?: () => readonly number[]
  recordUsage?: (usage: SuperagentUsage) => void
  github?: (projectId: number, argv: string[]) => Promise<{ stdout: string }>
  delivery?: {
    submit: (projectId: number, input: unknown) => Promise<unknown>
    status: (projectId: number, id: string) => Promise<unknown>
  }
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b-'))
  const db = new DatabaseSync(join(dir, 'state.sqlite'))
  let owner: number | null = 42
  const sent: Array<{ chatId: number; replyTo: number; text: string }> = []
  const send = options.send ?? (async (input: { chatId: number; replyTo: number; text: string }) => {
    sent.push(input)
    return { messageId: 900 }
  })
  const socketPath = join(dir, 'bridge.sock')
  const bridge = createSuperagentBridge({
    db, socketPath, ownerId: () => owner, send, projects: options.projects, recordUsage: options.recordUsage,
    github: options.github, delivery: options.delivery,
  })
  resources.push(async () => { await bridge.stop(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  return { bridge, db, dir, socketPath, sent, setOwner: (value: number | null) => { owner = value } }
}

function input(overrides: Partial<SuperagentBridgeInput> = {}): SuperagentBridgeInput {
  return {
    projectId: 0, updateId: 7, messageId: 100, chatId: 42, fromId: 42, text: 'root', at: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

async function call(socketPath: string, method: string, path: string, body?: unknown): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({ socketPath, method, path, agent: false, headers: encoded === undefined ? undefined : {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
    } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString()
        resolve({ status: response.statusCode ?? 0, body: text === '' ? undefined : JSON.parse(text) })
      })
    })
    req.on('error', reject)
    if (encoded !== undefined) req.write(encoded)
    req.end()
  })
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return await read()
}


test('S-CHANNEL project owner and current generation constrain every channel', { timeout: 60_000 }, async () => {
  {
    const f = fixture()
    await f.bridge.start()
    const root = f.bridge.enqueue(input())
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toEqual({ paused: true, phase: 'paused', generation: 0, ownerId: 42, events: [] })
    await f.bridge.stop()
    await f.bridge.start()
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toEqual({ paused: true, phase: 'paused', generation: 0, ownerId: 42, events: [] })
    expect((await call(f.socketPath, 'POST', '/outbox', {
      id: 'reply-1', projectId: 0, chatId: 42, rootMessageId: root.rootMessageId, replyTo: 100, text: 'reply',
    })).status).toBe(409)
    expect(() => f.bridge.enqueue(input({ chatId: 43 }))).toThrow()
    expect(() => f.bridge.enqueue(input({ fromId: 43 }))).toThrow()
    expect(() => f.bridge.enqueue(input({ chatId: 0 }))).toThrow()

    f.bridge.setPaused(false)
    await f.bridge.stop()
    await f.bridge.start()
    expect((await call(f.socketPath, 'GET', '/health')).body).toMatchObject({ ok: true, paused: false, ownerId: 42 })
    expect((await call(f.socketPath, 'POST', '/outbox', {
      id: 'bad-root', projectId: 0, chatId: 42, rootMessageId: 999, replyTo: 999, text: 'reply',
    })).status).toBe(404)
    f.setOwner(43)
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toEqual({ paused: false, phase: 'active', generation: 0, ownerId: 43, events: [] })

  }
  {
    const f = fixture()
    await f.bridge.start()
    f.bridge.enqueue(input())

    const generation = f.bridge.beginResume([0])
    expect(generation).toBe(1)
    expect(f.bridge.resumeReady(generation)).toBe(false)
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toEqual({
      paused: true, phase: 'arming', generation, ownerId: 42, events: [],
    })
    expect(() => f.bridge.activate(generation)).toThrow(/incomplete/)
    expect((await call(f.socketPath, 'POST', '/armed', { projectId: 0, generation })).body).toEqual({ ok: true, projectId: 0, generation })
    expect((await call(f.socketPath, 'POST', '/armed', { projectId: 0, generation })).status).toBe(200)
    expect(f.bridge.resumeReady(generation)).toBe(true)
    f.bridge.activate(generation)
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toMatchObject({
      paused: false, phase: 'active', generation, ownerId: 42,
      events: [expect.objectContaining({ id: 'telegram:42:7' })],
    })

    f.bridge.setPaused(true)
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toMatchObject({
      paused: true, phase: 'paused', generation: generation + 1, events: [],
    })
    expect((await call(f.socketPath, 'POST', '/armed', { projectId: 0, generation })).status).toBe(409)

  }
  {
    const dir = mkdtempSync(join(tmpdir(), 'b-'))
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    const sent: unknown[] = []
    const bridge = createSuperagentBridge({
      db, socketPath: join(dir, 'unused.sock'),
      listeners: [{ projectId: 0, socketPath: join(dir, 'project-0.sock') }, { projectId: 1, socketPath: join(dir, 'project-1.sock') }],
      projects: () => [0, 1], ownerId: () => 42,
      send: async value => { sent.push(value); return { messageId: 900 } },
    })
    resources.push(async () => { await bridge.stop(); db.close(); rmSync(dir, { recursive: true, force: true }) })
    await bridge.start()
    bridge.setPaused(false)
    bridge.enqueue(input({ projectId: 0, updateId: 20, messageId: 200, text: 'project zero' }))
    bridge.enqueue(input({ projectId: 1, updateId: 21, messageId: 201, text: 'project one' }))
    const p0 = join(dir, 'project-0.sock')
    const p1 = join(dir, 'project-1.sock')
    expect(existsSync(join(dir, 'unused.sock'))).toBe(false)
    expect((await call(p0, 'GET', '/events?projectId=0')).status).toBe(200)
    expect((await call(p1, 'GET', '/events?projectId=1')).status).toBe(200)
    expect((await call(p0, 'GET', '/events?projectId=1')).status).toBe(403)
    expect((await call(p1, 'GET', '/events?projectId=0')).status).toBe(403)
    expect((await call(p1, 'POST', '/ack', { id: 'telegram:42:20', projectId: 0 })).status).toBe(403)
    expect((await call(p1, 'POST', '/outbox', {
      id: 'cross-project', projectId: 0, chatId: 42, rootMessageId: 200, replyTo: 200, text: 'must not send',
    })).status).toBe(403)
    expect((await call(p1, 'POST', '/usage', {
      projectId: 0, id: 'cross-usage', at: 1_700_000_000_000, provider: 'p', model: 'm', inputTokens: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
    })).status).toBe(403)
    expect(sent).toEqual([])

  }
  {
    const dir = mkdtempSync(join(tmpdir(), 'b-'))
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    const p0 = join(dir, 'project-0.sock')
    const p1 = join(dir, 'project-1.sock')
    const githubCalls: number[] = []
    const deliveryCalls: number[] = []
    const bridge = createSuperagentBridge({
      db, socketPath: join(dir, 'unused.sock'),
      listeners: [{ projectId: 0, socketPath: p0 }, { projectId: 1, socketPath: p1 }],
      projects: () => [0, 1], ownerId: () => 42, send: async () => ({ messageId: 900 }),
      github: async projectId => { githubCalls.push(projectId); return { stdout: 'ok' } },
      delivery: {
        submit: async projectId => { deliveryCalls.push(projectId); return { accepted: true } },
        status: async projectId => { deliveryCalls.push(projectId); return { state: 'ok' } },
      },
    })
    resources.push(async () => { await bridge.stop(); db.close(); rmSync(dir, { recursive: true, force: true }) })
    await bridge.start()
    bridge.setPaused(false)

    expect((await call(p0, 'POST', '/github', { projectId: 0, argv: ['repo', 'view'] })).status).toBe(200)
    expect((await call(p0, 'POST', '/delivery', { projectId: 0, id: 'd0' })).status).toBe(200)
    expect((await call(p0, 'GET', '/delivery?projectId=0&id=d0')).status).toBe(200)
    expect((await call(p1, 'POST', '/github', { projectId: 0, argv: ['repo', 'view'] })).status).toBe(403)
    expect((await call(p1, 'POST', '/delivery', { projectId: 0, id: 'd1' })).status).toBe(403)
    expect((await call(p1, 'GET', '/delivery?projectId=0&id=d1')).status).toBe(403)
    expect(githubCalls).toEqual([0])
    expect(deliveryCalls).toEqual([0, 0])

  }
  {
    const dir = mkdtempSync(join(tmpdir(), 'b-'))
    resources.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = new DatabaseSync(':memory:')
    resources.push(() => db.close())
    const path = join(dir, 'bridge.sock')
    const fs = await import('node:fs')
    fs.writeFileSync(path, 'not a socket')
    const bridge = createSuperagentBridge({ db, socketPath: path, ownerId: () => 42, send: async () => ({ messageId: 1 }) })
    await expect(bridge.start()).rejects.toThrow()
    rmSync(path)
    const active = createServer((_req, res) => { res.end('{}') })
    resources.push(() => new Promise<void>(resolve => active.close(() => resolve())))
    await new Promise<void>((resolve, reject) => { active.once('error', reject); active.listen(path, resolve) })
    await expect(bridge.start()).rejects.toThrow()

  }
})

test('S-OUTBOX uncertain sends survive restart without automatic replay', { timeout: 60_000 }, async () => {
  {
    let release!: (value: { messageId: number }) => void
    const sending = new Promise<{ messageId: number }>(resolve => { release = resolve })
    const f = fixture({ send: async input => { f.sent.push(input); return await sending } })
    await f.bridge.start()
    f.bridge.setPaused(false)
    const root = f.bridge.enqueue(input())
    const payload = { id: 'reply-1', projectId: 0, chatId: 42, rootMessageId: root.rootMessageId, replyTo: 100, text: 'reply' }
    expect((await call(f.socketPath, 'POST', '/outbox', payload)).body).toEqual({ state: 'pending' })
    await waitFor(async () => f.sent.length, value => value === 1)
    expect((await call(f.socketPath, 'GET', '/health')).status).toBe(200)
    expect((await call(f.socketPath, 'POST', '/outbox', payload)).body).toEqual({ state: 'pending' })
    release({ messageId: 901 })
    const delivered = await waitFor(() => call(f.socketPath, 'POST', '/outbox', payload), value => value.status === 200)
    expect(delivered.body).toEqual({ state: 'sent', messageId: 901 })
    expect(f.bridge.ownsReply(42, 901)).toBe(true)
    const thread = await call(f.socketPath, 'GET', '/thread?projectId=0&root=100&chat=42')
    expect(thread.body).toMatchObject({ messages: [
      expect.objectContaining({ messageId: 100, direction: 'incoming' }),
      expect.objectContaining({ messageId: 901, direction: 'outgoing', text: 'reply', replyTo: 100 }),
    ] })
    expect((await call(f.socketPath, 'POST', '/outbox', payload)).body).toEqual({ state: 'sent', messageId: 901 })
    expect((await call(f.socketPath, 'POST', '/outbox', { ...payload, text: 'different' })).status).toBe(409)

  }
  {
    let attempts = 0
    let connected = [0, 1]
    const f = fixture({
      projects: () => connected,
      send: async value => {
        attempts++
        if (value.text === 'dismiss' || attempts === 1) throw new Error('ambiguous transport')
        return { messageId: 902 }
      },
    })
    await f.bridge.start()
    f.bridge.setPaused(false)
    const root = f.bridge.enqueue(input())
    const retry = { id: 'retry-uncertain', projectId: 0, chatId: 42, rootMessageId: root.rootMessageId, replyTo: 100, text: 'retry' }
    expect((await call(f.socketPath, 'POST', '/outbox', retry)).status).toBe(202)
    await waitFor(() => call(f.socketPath, 'POST', '/outbox', retry), value => value.status === 409)
    expect(f.bridge.listUncertain()).toEqual([{ projectId: 0, id: retry.id }])
    f.setOwner(43)
    expect(() => f.bridge.retryUncertain(0, retry.id)).toThrow(/owner/)
    f.setOwner(42)
    f.bridge.retryUncertain(0, retry.id)
    expect((await waitFor(() => call(f.socketPath, 'POST', '/outbox', retry), value => value.status === 200)).body).toEqual({ state: 'sent', messageId: 902 })
    expect(attempts).toBe(2)

    const dismissRoot = f.bridge.enqueue(input({ projectId: 1, updateId: 9, messageId: 110, text: 'project one' }))
    const dismiss = { ...retry, id: 'dismiss-uncertain', projectId: 1, rootMessageId: dismissRoot.rootMessageId, replyTo: 110, text: 'dismiss' }
    expect((await call(f.socketPath, 'POST', '/outbox', dismiss)).status).toBe(202)
    await waitFor(() => call(f.socketPath, 'POST', '/outbox', dismiss), value => value.status === 409)
    connected = [0]
    expect(f.bridge.listUncertain()).toEqual([{ projectId: 1, id: dismiss.id }])
    expect(() => f.bridge.retryUncertain(1, dismiss.id)).toThrow(/unknown project/)
    f.bridge.dismissUncertain(1, dismiss.id)
    connected = [0, 1]
    expect((await call(f.socketPath, 'POST', '/outbox', dismiss)).body).toEqual({ state: 'gone' })
    expect(f.bridge.listUncertain()).toEqual([])
    expect(attempts).toBe(3)
    expect(() => f.bridge.retryUncertain(1, dismiss.id)).toThrow(/not uncertain/)
    connected = [0]
    expect(() => f.bridge.dismissUncertain(1, dismiss.id)).toThrow(/not uncertain/)

  }
  {
    const f = fixture({ send: async () => { throw new Error('transport failed') } })
    await f.bridge.start()
    f.bridge.setPaused(false)
    const root = f.bridge.enqueue(input())
    const payload = { id: 'reply-1', projectId: 0, chatId: 42, rootMessageId: root.rootMessageId, replyTo: 100, text: 'reply' }
    expect((await call(f.socketPath, 'POST', '/outbox', payload)).status).toBe(202)
    const uncertain = await waitFor(() => call(f.socketPath, 'POST', '/outbox', payload), value => value.status === 409)
    expect(uncertain.body).toEqual({ state: 'uncertain' })

    f.db.prepare("UPDATE superagent_bridge_outbox SET state='sending' WHERE id=?").run('reply-restart')
    f.db.prepare(`INSERT INTO superagent_bridge_outbox
      (id,project_id,chat_id,root_message_id,reply_to,text,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'sending',?,?)`).run('reply-restart', 0, 42, 100, 100, 'restart', Date.now(), Date.now())
    await f.bridge.stop()
    const reopened = createSuperagentBridge({ db: f.db, socketPath: f.socketPath, ownerId: () => 42, send: async () => ({ messageId: 999 }) })
    resources.push(() => reopened.stop())
    await reopened.start()
    expect((await call(f.socketPath, 'POST', '/outbox', {
      id: 'reply-restart', projectId: 0, chatId: 42, rootMessageId: 100, replyTo: 100, text: 'restart',
    })).body).toEqual({ state: 'uncertain' })

  }
})

test('S-RUNTIME arming state survives restart without accepting stale acknowledgements', { timeout: 60_000 }, async () => {
  {
    const f = fixture()
    await f.bridge.start()
    const generation = f.bridge.beginResume([0])
    expect((await call(f.socketPath, 'POST', '/armed', { projectId: 0, generation })).status).toBe(200)
    await f.bridge.stop()
    const reopened = createSuperagentBridge({ db: f.db, socketPath: f.socketPath, ownerId: () => 42, send: async () => ({ messageId: 999 }) })
    resources.push(() => reopened.stop())
    await reopened.start()
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toMatchObject({ paused: true, phase: 'arming', generation, events: [] })
    expect(reopened.resumeReady(generation)).toBe(true)
    reopened.activate(generation)
    expect((await call(f.socketPath, 'GET', '/events?projectId=0')).body).toMatchObject({ paused: false, phase: 'active', generation })

  }
  {
    const dir = mkdtempSync(join(tmpdir(), 'b-'))
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    const p0 = join(dir, 'project-0.sock')
    const p1 = join(dir, 'project-1.sock')
    const bridge = createSuperagentBridge({
      db, socketPath: join(dir, 'unused.sock'),
      listeners: [{ projectId: 0, socketPath: p0 }, { projectId: 1, socketPath: p1 }],
      projects: () => [0, 1], ownerId: () => 42, send: async () => ({ messageId: 900 }),
    })
    resources.push(async () => { await bridge.stop(); db.close(); rmSync(dir, { recursive: true, force: true }) })
    await bridge.start()
    bridge.enqueue(input({ projectId: 0, updateId: 30, messageId: 300 }))
    bridge.enqueue(input({ projectId: 1, updateId: 31, messageId: 301 }))

    const generation = bridge.beginResume([0, 1])
    expect((await call(p0, 'GET', '/events?projectId=0')).body).toMatchObject({ paused: true, phase: 'arming', generation, events: [] })
    expect((await call(p0, 'POST', '/armed', { projectId: 0, generation })).status).toBe(200)
    expect(bridge.resumeReady(generation)).toBe(false)
    expect(() => bridge.activate(generation)).toThrow(/incomplete/)
    expect((await call(p1, 'POST', '/armed', { projectId: 1, generation: generation - 1 })).status).toBe(409)
    expect((await call(p1, 'POST', '/armed', { projectId: 1, generation })).status).toBe(200)
    expect(bridge.resumeReady(generation)).toBe(true)
    bridge.activate(generation)
    expect((await call(p1, 'GET', '/events?projectId=1')).body).toMatchObject({ paused: false, phase: 'active', generation, events: [expect.objectContaining({ id: 'telegram:42:31' })] })
    expect((await call(p1, 'GET', '/events?projectId=0')).status).toBe(403)

  }
})

})
describe('own crash-safe intake', () => {
const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0)) close() })
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path)
  cleanup.push(() => db.close())
  const tasks = new Map<number, FactoryTask>()
  const requests = new Map<string, FactoryTask>()
  const factory = {
    createTask: vi.fn((input: FactoryTaskInput) => {
      const previous = requests.get(input.requestId!)
      if (previous) return previous
      const task: FactoryTask = { id: tasks.size + 1, title: input.title ?? input.text, body: input.text,
        status: 'incoming', projectId: 1, projectName: 'test', projectPath: '/fixture', createdAt: Date.now(),
        criteria: [], footprint: [], changedFiles: [] }
      tasks.set(task.id, task)
      requests.set(input.requestId!, task)
      return task
    }),
    findTask: vi.fn((id: number) => tasks.get(id)),
    listTasks: vi.fn(() => [...tasks.values()]),
  } satisfies Pick<Factory, 'createTask' | 'findTask' | 'listTasks'>
  let owner: number | null = 42
  const options = { db, factory, ownerId: () => owner }
  return { db, factory, tasks, options, agent: createSuperagent(options), owner: (value: number | null) => { owner = value } }
}
const request = { chatId: 42, updateId: 0, text: '  Implement the requested change  ' }


test('S-INTAKE rejects other owners and recovers a deduplicated factory request', { timeout: 60_000 }, async () => {
  {
  const f = fixture()
  for (const chatId of [43, NaN]) {
    expect(() => f.agent.submit({ ...request, chatId })).toThrow()
    expect(() => f.agent.status(chatId)).toThrow()
  }
  for (const updateId of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => f.agent.submit({ ...request, updateId })).toThrow()
  for (const text of ['', ' '.repeat(10), 'x'.repeat(16001)]) expect(() => f.agent.submit({ ...request, text })).toThrow()
  expect(new SqliteRepositories(f.db).threads.list()).toEqual([])
  expect(f.factory.createTask).not.toHaveBeenCalled()
  expect(f.factory.listTasks).not.toHaveBeenCalled()
  expect(f.factory.findTask).not.toHaveBeenCalled()
  f.owner(null)
  expect(() => f.agent.status(42)).toThrow()
  }
  {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-'))
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }))
  const f = fixture(join(dir, 'state.sqlite'))
  const first = f.agent.submit(request)
  const reopened = new DatabaseSync(join(dir, 'state.sqlite'))
  cleanup.push(() => reopened.close())
  const recovered = createSuperagent({ ...f.options, db: reopened })
  expect(recovered.submit(request).id).toBe(first.id)
  expect(f.factory.createTask).toHaveBeenCalledTimes(1)
  }
  {
  const f = fixture()
  const create = f.factory.createTask.getMockImplementation()!
  f.factory.createTask.mockImplementationOnce(input => { create(input); throw new Error('crash after create') })
  expect(() => f.agent.submit(request)).toThrow('crash after create')
  const recovered = createSuperagent(f.options)
  expect(f.tasks.size).toBe(1)
  recovered.status(42)
  expect(recovered.submit(request).id).toBe(1)
  expect(f.tasks.size).toBe(1)
  }
  {
  const f = fixture()
  f.factory.createTask.mockImplementationOnce(() => { throw new Error('factory unavailable') })
  expect(() => f.agent.submit(request)).toThrow('factory unavailable')
  f.owner(43)
  createSuperagent(f.options).status(43)
  expect(f.factory.createTask).toHaveBeenCalledTimes(1)
  f.owner(42)
  f.agent.status(42)
  expect(f.tasks.size).toBe(1)
  }
})

})
describe('own authenticated panel', () => {
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })


test('S-PANEL refuses unauthorized cross-origin and missing-token access', { timeout: 60_000 }, async () => {
  {
  const dir = mkdtempSync(join(tmpdir(), 'sa-panel-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const socketPath = join(dir, 'panel.sock')
  mkdirSync(join(dir, 'state'))
  writeFileSync(join(dir, 'state', 'panel-auth.json'), JSON.stringify({ token: 'fixture-upstream-token-0123456789' }), { mode: 0o600 })
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.host} ${req.headers['x-orchestrator-request'] ?? ''}`)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  let upgradeCookie = ''
  server.on('upgrade', (req, socket) => {
    upgradeCookie = req.headers.cookie ?? ''
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n')
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  expect(await requestPanel(socketPath, 3082, 'state')).toEqual({ ok: true })
  expect(requests).toEqual(['GET /orchestrator/api/state 127.0.0.1:3082 1'])
  const proxy = await startPanelProxy(socketPath, 0)
  cleanup.push(() => proxy.stop())
  expect((await fetch(`http://127.0.0.1:${proxy.port}/`)).status).toBe(401)
  const login = await fetch(proxy.url, { redirect: 'manual' })
  expect(login.status).toBe(303)
  expect(login.headers.get('location')).toBe('/?token=fixture-upstream-token-0123456789')
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const response = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { cookie } })
  expect(await response.json()).toEqual({ ok: true })
  expect(requests[1]).toContain(`127.0.0.1:${proxy.port}`)
  expect((await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { cookie, origin: 'https://untrusted.invalid' } })).status).toBe(403)
  const upgraded = await new Promise<number>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${proxy.port}/api`, { headers: { cookie, connection: 'Upgrade', upgrade: 'fixture' } })
    req.on('error', reject)
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode!) })
    req.on('response', res => { res.resume(); resolve(res.statusCode!) })
    req.end()
  })
  expect(upgraded).toBe(101)
  expect(upgradeCookie).toBe('')
  rmSync(join(dir, 'state', 'panel-auth.json'))
  expect((await fetch(proxy.url, { redirect: 'manual' })).status).toBe(503)
  await expect(requestPanel(socketPath, 3082, '../bad')).rejects.toThrow()
  }
})

})
