// Restart recovery of a running task: after the test writer the daemon goes on
// from the executor in the same worktree; before it, or without a usable
// worktree, the task starts over. The roles and the sandbox are in-process
// doubles; the git repositories are real disposable fixtures. A restart is a
// second factory on the same store whose first run stays stuck in a role turn.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const WAIT = 10_000
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const PARTIAL_SOURCE = 'export function value() { return 3 }\n'
const TEST_PATH = 'tests/value.test.mjs'
const SECOND_TEST_PATH = 'tests/second.test.mjs'
const TEST_CONTENT = 'red test\n'
const SECOND_TEST_CONTENT = 'second red test\n'
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

type RoleScript = (turn: FactoryRoleTurn, index: number) => Promise<string>

let root: string
let home: string
let project: string
let store: Store
let turns: FactoryRoleTurn[]
let gateRuns: string[]

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeProject(path: string): void {
  put(join(path, 'src/value.mjs'), BASE_SOURCE)
  put(join(path, '.gitignore'), '.dshbot/\nbuild/\n')
  git(dirname(path), 'init', '-q', path)
  git(path, 'add', '--', 'src/value.mjs', '.gitignore')
  git(path, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
}

/** Red while the worktree still has the base source, green once it is fixed. */
function sandbox(options: SandboxOptions): SandboxResult {
  gateRuns.push(options.candidate)
  const source = readFileSync(join(options.candidate, 'src/value.mjs'), 'utf8')
  return source === FIXED_SOURCE
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<string> {
  const tool = turn.tools.find((candidate) => candidate.name === 'write_file')
  expect(tool, `${turn.role} has a write tool`).toBeDefined()
  return String(await tool!.execute({ path, content }))
}

/** Writer adds two red tests, executor fixes the source, reviewer approves. */
const happy: RoleScript = async (turn) => {
  if (turn.role === 'test_writer') {
    await write(turn, TEST_PATH, TEST_CONTENT)
    await write(turn, SECOND_TEST_PATH, SECOND_TEST_CONTENT)
    return JSON.stringify({ tests: [TEST_PATH, SECOND_TEST_PATH] })
  }
  if (turn.role === 'executor') {
    await write(turn, 'src/value.mjs', FIXED_SOURCE)
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
}

function startFactory(script: RoleScript): Factory {
  // These tests cover execution itself; acceptance is driven by its own file.
  store.kv.set('factory.autoaccept', '0')
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      return { message_id: 1, chat: { id: params.chat_id } } as T
    },
  }
  return createFactory({
    store,
    home,
    appRoot: project,
    api,
    ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }],
    ownerHome: join(root, 'owner-home'),
    sandbox,
    roleTurn: async (turn: FactoryRoleTurn) => {
      turns.push(turn)
      return script(turn, turns.length - 1)
    },
  })
}

/** A first factory: its own resume pass has to see the empty table before a task is seeded. */
async function bootFactory(script: RoleScript): Promise<Factory> {
  const factory = startFactory(script)
  await new Promise((resolve) => setTimeout(resolve, 20))
  return factory
}

function seedTask(body: string, status: string, fields: Record<string, string | number | null> = {}): number {
  const row = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at,
       criteria, footprint, risk) VALUES (?, ?, ?, 0, 'project', ?, ?, ?, ?, 'low') RETURNING id`,
  ).get(body, body, status, project, Date.now(), JSON.stringify(['value() возвращает 2.']),
    JSON.stringify(['src/value.mjs'])) as { id: number }
  for (const [key, value] of Object.entries(fields)) {
    store.db.prepare(`UPDATE factory_tasks SET "${key}" = ? WHERE id = ?`).run(value, row.id)
  }
  return row.id
}

function task(id: number): { status: string; execution_note: string | null; worktree: string | null } {
  return store.db.prepare('SELECT status, execution_note, worktree FROM factory_tasks WHERE id = ?')
    .get(id) as { status: string; execution_note: string | null; worktree: string | null }
}

async function settled(id: number): Promise<void> {
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
}

async function approve(factory: Factory, id: number): Promise<void> {
  const data = `f1:aa:${id}`
  expect(await factory.handleCallback({ id: `cb-${data}`, chatId: OWNER, fromId: OWNER, messageId: 70, data })).toBe(true)
}

function idOf(turn: FactoryRoleTurn): number {
  return Number(/-(\d+)-\d+$/.exec(turn.sessionId)?.[1])
}

/**
 * The daemon dies inside the executor of round one: the writer is done and its
 * tests are on disk, the executor has changed the source, rewritten one test
 * and deleted the other, and its turn never returns.
 */
async function interruptedInExecutor(): Promise<{ id: number; worktree: string }> {
  const first = await bootFactory(async (turn, index) => {
    if (turn.role === 'executor') {
      writeFileSync(join(turn.cwd, 'src/value.mjs'), PARTIAL_SOURCE)
      writeFileSync(join(turn.cwd, TEST_PATH), 'tampered by the interrupted executor\n')
      rmSync(join(turn.cwd, SECOND_TEST_PATH))
      return new Promise<string>(() => {})
    }
    return happy(turn, index)
  })
  const id = seedTask('interrupted in executor', 'awaiting_approval')
  await approve(first, id)
  await vi.waitFor(() => expect(turns.map((turn) => turn.role)).toEqual(['test_writer', 'executor']), { timeout: WAIT })
  const worktree = task(id).worktree
  expect(worktree, 'the worktree is recorded').toBeTruthy()
  expect(task(id).status).toBe('running')
  return { id, worktree: worktree! }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-restart-')))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  makeProject(project)
  store = openStore(join(home, 'state.db'))
  turns = []
  gateRuns = []
})

afterEach(async () => {
  // Let in-flight executions settle before their store and fixtures disappear.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const path of new Set(gateRuns)) {
    if (!path.startsWith(`${root}${sep}`)) rmSync(path, { recursive: true, force: true })
  }
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('c1 c2 c3 c6 restart after the writer goes on from the executor in the same worktree, queue order kept', async () => {
  const { id, worktree } = await interruptedInExecutor()
  const later = seedTask('approved later', 'queued', { queued_at: Date.now() + 3_000 })
  const earlier = seedTask('approved earlier', 'queued', { queued_at: Date.now() + 2_000 })
  const mark = turns.length

  let seen: { cwd: string; prompt: string; source: string; tests: Array<string | null> } | undefined
  startFactory(async (turn, index) => {
    if (turn.role === 'executor' && seen === undefined) {
      const read = (path: string): string | null =>
        existsSync(join(turn.cwd, path)) ? readFileSync(join(turn.cwd, path), 'utf8') : null
      seen = {
        cwd: turn.cwd,
        prompt: turn.prompt,
        source: read('src/value.mjs') ?? '',
        tests: [read(TEST_PATH), read(SECOND_TEST_PATH)],
      }
    }
    return happy(turn, index)
  })
  await settled(id)
  await settled(earlier)
  await settled(later)

  const after = turns.slice(mark)
  // c1: the first role after the restart is the executor of round one, in the same worktree.
  expect(after[0]!.role).toBe('executor')
  expect(new Set(after.map((turn) => turn.sessionId)).size).toBe(after.length)
  expect(idOf(after[0]!)).toBe(id)
  expect(after[0]!.cwd).toBe(worktree)
  expect(after.filter((turn) => idOf(turn) === id).map((turn) => turn.role), 'the writer is not run again')
    .toEqual(['executor', 'reviewer'])
  expect(task(id).worktree).toBe(worktree)
  expect(task(id).execution_note).toBe('готово к приёмке')
  // c2: the executor is told that the previous round was cut short by a restart.
  expect(seen?.prompt).toMatch(/перезапуск/i)
  expect(seen?.prompt).toMatch(/прерван/i)
  // c3: the writer tests are what the writer left; other work of the executor stays.
  expect(seen?.tests).toEqual([TEST_CONTENT, SECOND_TEST_CONTENT])
  expect(seen?.source).toBe(PARTIAL_SOURCE)
  expect(readFileSync(join(worktree, TEST_PATH), 'utf8')).toBe(TEST_CONTENT)
  expect(readFileSync(join(worktree, SECOND_TEST_PATH), 'utf8')).toBe(SECOND_TEST_CONTENT)
  // c6: the interrupted task first, then the queued ones in approval order.
  expect(after.filter((turn) => turn.role === 'test_writer').map(idOf)).toEqual([earlier, later])
  const firstOfTask = (target: number): number => after.findIndex((turn) => idOf(turn) === target)
  expect(firstOfTask(id)).toBeLessThan(firstOfTask(earlier))
  expect(firstOfTask(earlier)).toBeLessThan(firstOfTask(later))
  expect(after.slice(0, 2).map(idOf)).toEqual([id, id])
})

test('c5 restart with the worktree on another branch starts the task over with the writer', async () => {
  const { id, worktree } = await interruptedInExecutor()
  const mark = turns.length
  git(worktree, 'checkout', '-q', '-b', 'somewhere-else')

  let fresh: boolean | undefined
  startFactory(async (turn, index) => {
    if (fresh === undefined) fresh = turn.role === 'test_writer' && !existsSync(join(turn.cwd, TEST_PATH))
    return happy(turn, index)
  })
  await settled(id)

  expect(turns.slice(mark).map((turn) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(fresh).toBe(true)
  expect(git(task(id).worktree!, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/factory/${id}`)
})

test('restart resumes the interrupted task first, then queued tasks in approval order, one at a time', async () => {
  await bootFactory(happy)
  const interrupted = seedTask('interrupted', 'running', {
    queued_at: 1_000, worktree: null, execution_stage: 'tests', execution_round: 1,
  })
  const later = seedTask('approved later', 'queued', { queued_at: 3_000 })
  const earlier = seedTask('approved earlier', 'queued', { queued_at: 2_000 })
  // The restart hit after git created the worktree but before its path was recorded.
  const stale = join(home, 'factory', 'worktrees', `task-${interrupted}-stale`)
  mkdirSync(dirname(stale), { recursive: true })
  git(project, 'worktree', 'add', '-q', '-B', `factory/${interrupted}`, stale, 'HEAD')

  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  startFactory(async (turn, index) => {
    if (index === 0) await held
    return happy(turn, index)
  })
  await vi.waitFor(() => expect(turns.length).toBe(1), { timeout: WAIT })
  expect(turns[0]!.role).toBe('test_writer')
  expect(turns[0]!.sessionId).toContain(`-${interrupted}-`)
  expect(existsSync(stale), 'the unrecorded worktree of the task is removed').toBe(false)
  expect(task(interrupted).status).toBe('running')
  expect(task(earlier).status).toBe('queued')
  expect(task(later).status).toBe('queued')
  release()
  await settled(interrupted)
  await settled(earlier)
  await settled(later)

  for (const id of [interrupted, earlier, later]) expect(task(id).execution_note).toBe('готово к приёмке')
  const order = turns.filter((turn) => turn.role === 'test_writer')
    .map((turn) => Number(/-(\d+)-\d+$/.exec(turn.sessionId)?.[1]))
  expect(order).toEqual([interrupted, earlier, later])
})
