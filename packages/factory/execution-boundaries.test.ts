// Same createFactory / SQLite / disposable-repository harness as
// execution-recovery.test.ts. Only roles and the sandbox runner are doubles.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const WAIT = 10_000
const SOURCE_PATH = 'src/value.mjs'
const TEST_PATH = 'tests/value.test.mjs'
const OUTSIDE_PATH = 'notes.md'
const IGNORED_PATH = 'build/generated.mjs'
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const OWNER_NOTES = 'owner notes\n'
const RED_TEST = [
  "import { test } from 'node:test'",
  "import assert from 'node:assert/strict'",
  "import { value } from '../src/value.mjs'",
  "test('value returns two', () => assert.equal(value(), 2))",
  '',
].join('\n')
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

type RoleScript = (turn: FactoryRoleTurn) => Promise<string>
interface TaskState {
  status: string
  execution_note: string | null
  execution_round: number | null
  worktree: string | null
}

let root: string
let home: string
let project: string
let store: Store
let turns: FactoryRoleTurn[]
let gateRuns: string[]
let afterGate: (options: SandboxOptions, result: SandboxResult) => void

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

function sandbox(options: SandboxOptions): SandboxResult {
  gateRuns.push(options.candidate)
  const source = readFileSync(join(options.candidate, SOURCE_PATH), 'utf8')
  const result: SandboxResult = source === FIXED_SOURCE
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
  afterGate(options, result)
  return result
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<string> {
  const tool = turn.tools.find((candidate) => candidate.name === 'write_file')
  expect(tool, `${turn.role} has a write tool`).toBeDefined()
  return String(await tool!.execute({ path, content }))
}

const happy: RoleScript = async (turn) => {
  if (turn.role === 'test_writer') {
    await write(turn, TEST_PATH, RED_TEST)
    return JSON.stringify({ tests: [TEST_PATH] })
  }
  if (turn.role === 'executor') {
    await write(turn, SOURCE_PATH, FIXED_SOURCE)
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
}

async function startFactory(script: RoleScript = happy): Promise<Factory> {
  // These tests cover execution itself; acceptance is driven by its own file.
  store.kv.set('factory.autoaccept', '0')
  const api: TelegramApi = {
    async call<T>(_method: string, params: Record<string, unknown> = {}): Promise<T> {
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
    roleTurn: async (turn) => {
      turns.push(turn)
      return script(turn)
    },
  })
  // Let the startup recovery pass run before inserting or approving tasks.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return factory
}

function seedTask(footprint: string[] = [SOURCE_PATH]): number {
  const row = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at,
       criteria, footprint, risk) VALUES ('value', 'value returns two', 'awaiting_approval',
       0, 'project', ?, ?, ?, ?, 'low') RETURNING id`,
  ).get(project, Date.now(), JSON.stringify(['value() returns 2']), JSON.stringify(footprint)) as { id: number }
  return row.id
}

function task(id: number): TaskState {
  return store.db.prepare(
    'SELECT status, execution_note, execution_round, worktree FROM factory_tasks WHERE id = ?',
  ).get(id) as unknown as TaskState
}

async function approve(factory: Factory, id: number): Promise<void> {
  expect(await factory.handleCallback({
    id: `approve-${id}`, chatId: OWNER, fromId: OWNER, messageId: 70, data: `f1:aa:${id}`,
  })).toBe(true)
}

async function settled(id: number): Promise<void> {
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-boundaries-')))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  put(join(project, SOURCE_PATH), BASE_SOURCE)
  put(join(project, OUTSIDE_PATH), OWNER_NOTES)
  put(join(project, '.gitignore'), 'build/\n')
  git(root, 'init', '-q', project)
  git(project, 'add', '--', SOURCE_PATH, OUTSIDE_PATH, '.gitignore')
  git(project, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
  store = openStore(join(home, 'state.db'))
  turns = []
  gateRuns = []
  afterGate = () => undefined
})

afterEach(async () => {
  // An aborted role unwinds asynchronously before the store is closed.
  await new Promise((resolve) => setTimeout(resolve, 50))
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('test_c1_gate_replacing_worktree_identity_stops_before_review_or_owner_commit', async () => {
  const ownerHead = git(project, 'rev-parse', 'HEAD')
  const ownerGitDir = git(project, 'rev-parse', '--absolute-git-dir')
  let replaced = false
  afterGate = (options, result) => {
    if (!result.ok) return
    // Simulate writable project code redirecting subsequent host git commands.
    // No git metadata is read by the fixture; the replacement is synthetic.
    put(join(options.candidate, '.git'), `gitdir: ${ownerGitDir}\n`)
    replaced = true
  }
  const factory = await startFactory()
  const id = seedTask()
  await approve(factory, id)
  await settled(id)

  expect(replaced, 'the attack ran in the green executor gate').toBe(true)
  expect(gateRuns).toHaveLength(2)
  expect(git(project, 'rev-parse', 'HEAD'), 'host git must not commit through the substituted gitdir').toBe(ownerHead)
  expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(0)
  expect(task(id).execution_note).toMatch(/worktree|рабоч.{0,20}коп|принадлеж|\.git/i)
  expect(task(id).execution_note).not.toBe('готово к приёмке')
  expect(readFileSync(join(project, SOURCE_PATH), 'utf8')).toBe(BASE_SOURCE)
})

test.each(['content', 'symlink', 'red'])('gate %s mutations of locked tests and outside paths are restored before review', async (kind) => {
  let tampered = false
  afterGate = (options, result) => {
    if (gateRuns.length !== 2 || tampered) return
    if (kind === 'red') { result.ok = false; result.status = 1; result.output = 'RED-PROTECTED-GATE' }
    if (kind !== 'symlink') put(join(options.candidate, TEST_PATH), '// assertions disabled by project code\n')
    else {
      put(join(options.candidate, 'copied-test.mjs'), RED_TEST)
      rmSync(join(options.candidate, TEST_PATH))
      symlinkSync('copied-test.mjs', join(options.candidate, TEST_PATH))
    }
    put(join(options.candidate, OUTSIDE_PATH), 'changed outside scope by project code\n')
    tampered = true
  }
  const retryState: Array<{ test: string; notes: string; priorReviews: number; round: number | null }> = []
  let id: number
  const factory = await startFactory(async (turn) => {
    if (turn.role === 'executor' && turns.filter((entry) => entry.role === 'executor').length > 1) {
      retryState.push({
        test: readFileSync(join(turn.cwd, TEST_PATH), 'utf8'),
        notes: readFileSync(join(turn.cwd, OUTSIDE_PATH), 'utf8'),
        priorReviews: turns.filter((entry) => entry.role === 'reviewer').length,
        round: task(id).execution_round,
      })
    }
    return happy(turn)
  })
  id = seedTask()
  await approve(factory, id)
  await settled(id)

  expect(tampered, 'the green gate changed both protected paths').toBe(true)
  const executors = turns.filter((turn) => turn.role === 'executor')
  expect(executors, 'gate writes must return to the executor before review').toHaveLength(2)
  expect(executors[1]!.prompt).toMatch(/круг не засчитан/i)
  expect(executors[1]!.prompt).toContain(TEST_PATH)
  expect(executors[1]!.prompt).toContain(OUTSIDE_PATH)
  expect(retryState).toEqual([{ test: RED_TEST, notes: OWNER_NOTES, priorReviews: 0, round: 2 }])
  expect(gateRuns).toHaveLength(3)
  expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(1)
  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(readFileSync(join(task(id).worktree!, TEST_PATH), 'utf8')).toBe(RED_TEST)
  expect(lstatSync(join(task(id).worktree!, TEST_PATH)).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(task(id).worktree!, OUTSIDE_PATH), 'utf8')).toBe(OWNER_NOTES)
})
