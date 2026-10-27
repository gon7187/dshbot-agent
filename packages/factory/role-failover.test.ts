// Execution edge cases driven straight through createFactory: a daemon home
// inside the project, ignored writes refused by the role tools, review issues,
// a card message reused for another task, and restart recovery order. The
// roles and the sandbox are in-process doubles; the git repositories are real
// disposable fixtures.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import { TurnFailedError } from '../runner/src/index.js'
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
let logs: string[]
const factories: Factory[] = []
const MODELS = [
  { provider: 'provider-x', id: 'model-a', name: 'model-a' },
  { provider: 'provider-y', id: 'model-b', name: 'model-b' },
  { provider: 'provider-x', id: 'model-c', name: 'model-c' },
]

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
    catalogue: async () => MODELS,
    log: (message) => logs.push(message),
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
  logs = []
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

function configure(role: string, ...models: typeof MODELS): void {
  store.kv.set(`factory.role_models.${role}`, JSON.stringify(models.map((m) => `${m.provider}\u0000${m.id}`)))
}

async function launch(script: RoleScript, role: string, models: typeof MODELS): Promise<number> {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  const factory = startFactory(home, script)
  configure(role, ...models)
  const id = seedTask('role failover', 'awaiting_approval')
  await press(factory, `f1:aa:${id}`, 70)
  return id
}

test('c1 provider failure retries the same turn and logs the failed model', async () => {
  const id = await launch(async (turn, index) => {
    if (turn.role === 'test_writer' && turn.model === 'model-a') throw new TurnFailedError('429 rate limit', undefined)
    return happy(turn, index)
  }, 'test_writer', [MODELS[0]!, MODELS[1]!])
  await settled(id)
  const writers = turns.filter((turn) => turn.role === 'test_writer')
  expect(writers.map((turn) => turn.model)).toEqual(['model-a', 'model-b'])
  expect(writers[1]!.prompt).toBe(writers[0]!.prompt)
  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(logs.some((line) => /test_writer|тестопис/i.test(line) && line.includes('model-a') && /429|rate limit/i.test(line))).toBe(true)
})

test.each([
  { criterion: 'c3', models: [MODELS[0]!, MODELS[1]!] },
  { criterion: 'c6', models: [MODELS[0]!] },
])('$criterion reports every failed model and reason without repeating it', async ({ models }) => {
  const id = await launch(async (turn) => {
    throw new TurnFailedError(turn.model === 'model-a' ? '401 unauthorized' : '503 unavailable', undefined)
  }, 'test_writer', models)
  await settled(id)
  expect(turns.map((turn) => turn.model)).toEqual(models.map((model) => model.id))
  const note = task(id).execution_note ?? ''
  expect(note).toContain('model-a')
  expect(note).toMatch(/401|unauthorized/i)
  if (models.length > 1) {
    expect(note).toContain('model-b')
    expect(note).toMatch(/503|unavailable/i)
  }
})

test('c4 daemon stop does not try the next model', async () => {
  const id = await launch(async () => {
    throw Object.assign(new Error('daemon stopped'), { code: 'ABORTED' })
  }, 'test_writer', [MODELS[0]!, MODELS[1]!])
  await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: WAIT })
  // Allow the execution queue to unwind before asserting no fallback occurred.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(turns.map((turn) => turn.model)).toEqual(['model-a'])
  expect(task(id).status).toBe('running')
})

test.each([
  { reviewerModels: [MODELS[0]!, MODELS[1]!], expected: 'model-b' },
  { reviewerModels: [MODELS[0]!, MODELS[2]!], expected: 'model-a' },
])('c5 reviewer prefers a different provider, otherwise the first model', async ({ reviewerModels, expected }) => {
  const home = join(root, 'home')
  mkdirSync(home)
  store = openStore(join(home, 'state.db'))
  const factory = startFactory(home, happy)
  configure('executor', MODELS[0]!)
  configure('reviewer', ...reviewerModels)
  const id = seedTask('review provider', 'awaiting_approval')
  await press(factory, `f1:aa:${id}`, 70)
  await settled(id)
  expect(turns.find((turn) => turn.role === 'executor')?.provider).toBe('provider-x')
  expect(turns.filter((turn) => turn.role === 'reviewer').map((turn) => turn.model)).toEqual([expected])
})
