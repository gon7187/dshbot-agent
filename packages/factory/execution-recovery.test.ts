// Execution edge cases driven straight through createFactory: a daemon home
// inside the project, ignored writes refused by the role tools, review issues,
// a card message reused for another task, and restart recovery order. The
// roles and the sandbox are in-process doubles; the git repositories are real
// disposable fixtures.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const WAIT = 10_000
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const TEST_PATH = 'tests/value.test.mjs'
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
let project: string
let store: Store
let calls: Array<{ method: string; params: Record<string, unknown> }>
let turns: FactoryRoleTurn[]
let gateRuns: string[]
const factories: Factory[] = []

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

/** Writer adds a red test, executor fixes the source, reviewer approves. */
const happy: RoleScript = async (turn) => {
  if (turn.role === 'test_writer') {
    await write(turn, TEST_PATH, 'red test\n')
    return JSON.stringify({ tests: [TEST_PATH] })
  }
  if (turn.role === 'executor') {
    await write(turn, 'src/value.mjs', FIXED_SOURCE)
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
}

function startFactory(home: string, script?: RoleScript): Factory {
  // These tests cover execution itself; acceptance is driven by its own file.
  store.kv.set('factory.autoaccept', '0')
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      return { message_id: 1, chat: { id: params.chat_id } } as T
    },
  }
  const factory = createFactory({
    store,
    home,
    appRoot: project,
    api,
    ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }],
    ownerHome: join(root, 'owner-home'),
    sandbox,
    ...(script === undefined
      ? {}
      : {
          roleTurn: async (turn: FactoryRoleTurn) => {
            turns.push(turn)
            return script(turn, turns.length - 1)
          },
        }),
  })
  factories.push(factory)
  return factory
}

/** First factory only migrates the schema; its resume pass sees an empty table. */
async function migrated(home: string): Promise<void> {
  startFactory(home)
  await new Promise((resolve) => setTimeout(resolve, 20))
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

async function press(factory: Factory, data: string, messageId: number): Promise<void> {
  expect(await factory.handleCallback({ id: `cb-${data}`, chatId: OWNER, fromId: OWNER, messageId, data })).toBe(true)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-recovery-')))
  project = join(root, 'project')
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  makeProject(project)
  calls = []
  turns = []
  gateRuns = []
})

afterEach(async () => {
  // Let in-flight executions settle before their store and fixtures disappear.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const path of new Set(gateRuns)) {
    if (!path.startsWith(`${root}${sep}`)) rmSync(path, { recursive: true, force: true })
  }
  factories.length = 0
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('a daemon home inside the project still runs the task outside the owner copy', async () => {
  const home = join(project, '.dshbot')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  const head = git(project, 'rev-parse', 'HEAD')
  const branch = git(project, 'symbolic-ref', 'HEAD')
  const factory = startFactory(home, happy)
  const id = seedTask('home inside project', 'awaiting_approval')
  await press(factory, `f1:aa:${id}`, 70)
  await settled(id)

  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(turns.map((turn) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  for (const turn of turns) {
    expect(relative(project, realpathSync(turn.cwd)).split(sep)[0], 'worktree is outside the owner project').toBe('..')
  }
  expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(project, 'symbolic-ref', 'HEAD')).toBe(branch)
  expect(git(project, 'status', '--porcelain', '--ignored', '--', 'src', 'tests', 'build')).toBe('')
  expect(readFileSync(join(project, 'src/value.mjs'), 'utf8')).toBe(BASE_SOURCE)
})

test('a role write to a git-ignored path is refused instead of voiding the round', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  // Positive control: the planted path really is ignored, so git listings skip it.
  expect(git(project, 'check-ignore', '--no-index', 'build/outside-footprint.txt')).toBe('build/outside-footprint.txt')
  let refused: string | undefined
  let leftover: boolean | undefined
  const factory = startFactory(home, async (turn, index) => {
    if (turn.role === 'executor' && turns.filter((entry) => entry.role === 'executor').length === 1) {
      refused = await write(turn, 'build/outside-footprint.txt', 'outside\n')
      leftover = existsSync(join(turn.cwd, 'build/outside-footprint.txt'))
      await write(turn, 'src/value.mjs', FIXED_SOURCE)
      return 'готово'
    }
    return happy(turn, index)
  })
  const id = seedTask('ignored write', 'awaiting_approval')
  await press(factory, `f1:aa:${id}`, 70)
  await settled(id)

  const executors = turns.filter((turn) => turn.role === 'executor')
  expect(executors, 'the refused write does not cost a round').toHaveLength(1)
  expect(refused).toMatch(/игнор|ignor/i)
  expect(leftover, 'the ignored file is never created').toBe(false)
  expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(1)
  expect(task(id).execution_note).toBe('готово к приёмке')
})

test('a rejecting review carries its issues, not only the summary, to the executor', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  const factory = startFactory(home, async (turn, index) => {
    if (turn.role === 'reviewer' && turns.filter((entry) => entry.role === 'reviewer').length === 1) {
      return JSON.stringify({
        verdict: 'reject',
        approved: false,
        summary: 'Нужны исправления',
        issues: ['ISSUE-4417: value() не покрывает ноль'],
        comments: [],
      })
    }
    return happy(turn, index)
  })
  const id = seedTask('review issues', 'awaiting_approval')
  await press(factory, `f1:aa:${id}`, 70)
  await settled(id)

  const executors = turns.filter((turn) => turn.role === 'executor')
  expect(executors).toHaveLength(2)
  expect(executors[1]!.prompt).toContain('Нужны исправления')
  expect(executors[1]!.prompt).toContain('ISSUE-4417: value() не покрывает ноль')
})

test('a card message reused for another task is no longer edited with the old task progress', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  const factory = startFactory(home, happy)
  const first = seedTask('ПЕРВАЯ-ЗАДАЧА', 'awaiting_approval')
  const second = seedTask('ВТОРАЯ-ЗАДАЧА', 'awaiting_approval')
  await press(factory, `f1:t:${first}`, 50)
  await press(factory, `f1:t:${second}`, 50)
  await press(factory, `f1:t:${first}`, 51)
  const mark = calls.length
  await press(factory, `f1:aa:${first}`, 70)
  await settled(first)

  const edits = calls.slice(mark).filter((call) => call.method === 'editMessageText')
  // Positive control: the card still open on the first task follows its progress.
  expect(edits.filter((call) => call.params.message_id === 51).length).toBeGreaterThan(1)
  expect(edits.filter((call) => call.params.message_id === 50), 'the second task card stays untouched').toEqual([])
})

test('restart resumes the interrupted task first, then queued tasks in approval order, one at a time', async () => {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  await migrated(home)
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
  startFactory(home, async (turn, index) => {
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
