// Gate runs that tamper with protected paths, driven straight through
// createFactory with the same harness as execution-boundaries.test.ts: a red
// executor gate and a writer gate both rewrite a writer test and a path outside
// the footprint. Only roles and the sandbox runner are doubles; the git
// repositories are real disposable fixtures.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const BASE_SOURCE = 'export function value() { return 1 }\n'
const WRONG_SOURCE = 'export function value() { return 3 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const OWNER_NOTES = 'owner notes\n'
const OWNER_FILE = 'owner file outside the worktree\n'
const RED_TEST = "import { value } from '../src/value.mjs'\nif (value() !== 2) throw new Error('value returns two')\n"
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

type RoleScript = (turn: FactoryRoleTurn) => Promise<string>
interface ExecutorStart {
  test: string
  testIsLink: boolean
  notes: string
  round: number | null
}

let root: string
let home: string
let project: string
let store: Store
let turns: FactoryRoleTurn[]
let gates: Array<{ ok: boolean }>
let wrongFirst: boolean
let duringGate: (candidate: string, index: number, result: SandboxResult) => void

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

/** Green only with the fixed source; the hook plays project code run by the gate. */
function sandbox(options: SandboxOptions): SandboxResult {
  const source = readFileSync(join(options.candidate, SOURCE_PATH), 'utf8')
  const result: SandboxResult = source === FIXED_SOURCE
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: `GATE-TAIL-7781: value() returned ${/return (\d+)/.exec(source)?.[1]}` }
  duringGate(options.candidate, gates.length, result)
  gates.push({ ok: result.ok })
  return result
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<string> {
  const tool = turn.tools.find((candidate) => candidate.name === 'write_file')
  expect(tool, `${turn.role} has a write tool`).toBeDefined()
  return String(await tool!.execute({ path, content }))
}

/** Records what each executor starts from; the first executor writes a wrong fix. */
function script(starts: ExecutorStart[], id: () => number): RoleScript {
  return async (turn) => {
    if (turn.role === 'test_writer') {
      await write(turn, TEST_PATH, RED_TEST)
      return JSON.stringify({ tests: [TEST_PATH] })
    }
    if (turn.role === 'executor') {
      starts.push({
        test: readFileSync(join(turn.cwd, TEST_PATH), 'utf8'),
        testIsLink: lstatSync(join(turn.cwd, TEST_PATH)).isSymbolicLink(),
        notes: readFileSync(join(turn.cwd, OUTSIDE_PATH), 'utf8'),
        round: task(id()).execution_round,
      })
      await write(turn, SOURCE_PATH, starts.length === 1 && wrongFirst ? WRONG_SOURCE : FIXED_SOURCE)
      return 'готово'
    }
    return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
  }
}

async function startFactory(roles: RoleScript): Promise<Factory> {
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
      return roles(turn)
    },
  })
  // Let the startup recovery pass run before inserting or approving tasks.
  await new Promise((resolve) => setTimeout(resolve, 20))
  return factory
}

function seedTask(): number {
  const row = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at,
       criteria, footprint, risk) VALUES ('value', 'value returns two', 'awaiting_approval',
       0, 'project', ?, ?, ?, ?, 'low') RETURNING id`,
  ).get(project, Date.now(), JSON.stringify(['value() returns 2']), JSON.stringify([SOURCE_PATH])) as { id: number }
  return row.id
}

function task(id: number): { status: string; execution_note: string | null; execution_round: number | null } {
  return store.db.prepare('SELECT status, execution_note, execution_round FROM factory_tasks WHERE id = ?')
    .get(id) as { status: string; execution_note: string | null; execution_round: number | null }
}

async function approveAndSettle(factory: Factory, id: number): Promise<void> {
  expect(await factory.handleCallback({
    id: `approve-${id}`, chatId: OWNER, fromId: OWNER, messageId: 70, data: `f1:aa:${id}`,
  })).toBe(true)
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
}

/** The accepted commit carries the writer test and leaves the outside path alone. */
function expectCleanCommit(id: number, base: string): void {
  const branch = `factory/${id}`
  expect(git(project, 'diff', '--name-only', base, branch).split('\n').sort()).toEqual([SOURCE_PATH, TEST_PATH])
  expect(git(project, 'show', `${branch}:${TEST_PATH}`)).toBe(RED_TEST.trim())
  expect(git(project, 'show', `${branch}:${OUTSIDE_PATH}`)).toBe(OWNER_NOTES.trim())
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-gate-restore-')))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  put(join(project, SOURCE_PATH), BASE_SOURCE)
  put(join(project, OUTSIDE_PATH), OWNER_NOTES)
  put(join(root, 'owner-file.txt'), OWNER_FILE)
  git(root, 'init', '-q', project)
  git(project, 'add', '--', SOURCE_PATH, OUTSIDE_PATH)
  git(project, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
  store = openStore(join(home, 'state.db'))
  // Execution tests stop at «ждёт человека»; acceptance has its own file.
  store.kv.set('factory.autoaccept', '0')
  turns = []
  gates = []
  wrongFirst = false
  duringGate = () => undefined
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('a red executor gate that rewrites protected paths is restored and voids the round', async () => {
  wrongFirst = true
  let tampered = false
  duringGate = (candidate, index, result) => {
    // Gate 0 is the writer gate; gate 1 checks the wrong first fix and fails.
    if (index !== 1 || result.ok) return
    put(join(candidate, TEST_PATH), '// assertions disabled by project code\n')
    put(join(candidate, OUTSIDE_PATH), 'changed outside scope by project code\n')
    tampered = true
  }
  const base = git(project, 'rev-parse', 'HEAD')
  const starts: ExecutorStart[] = []
  let id = 0
  const factory = await startFactory(script(starts, () => id))
  id = seedTask()
  await approveAndSettle(factory, id)

  expect(tampered, 'the red executor gate changed both protected paths').toBe(true)
  expect(gates.map((gate) => gate.ok)).toEqual([false, false, true])
  const executors = turns.filter((turn) => turn.role === 'executor')
  expect(executors).toHaveLength(2)
  expect(executors[1]!.prompt).toMatch(/круг не засчитан/i)
  expect(executors[1]!.prompt).toContain(TEST_PATH)
  expect(executors[1]!.prompt).toContain(OUTSIDE_PATH)
  expect(executors[1]!.prompt, 'the red gate output still reaches the executor').toContain('GATE-TAIL-7781')
  expect(starts[1]).toEqual({ test: RED_TEST, testIsLink: false, notes: OWNER_NOTES, round: 2 })
  expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(1)
  expect(task(id).execution_note).toBe('готово к приёмке')
  expectCleanCommit(id, base)
})

test('a writer gate that links a writer test outside is restored without writing through the link', async () => {
  let tampered = false
  duringGate = (candidate, index) => {
    if (index !== 0) return
    rmSync(join(candidate, TEST_PATH))
    symlinkSync(join(root, 'owner-file.txt'), join(candidate, TEST_PATH))
    put(join(candidate, OUTSIDE_PATH), 'changed outside scope by project code\n')
    tampered = true
  }
  const base = git(project, 'rev-parse', 'HEAD')
  const starts: ExecutorStart[] = []
  let id = 0
  const factory = await startFactory(script(starts, () => id))
  id = seedTask()
  await approveAndSettle(factory, id)

  expect(tampered, 'the writer gate replaced the writer test with a link').toBe(true)
  expect(readFileSync(join(root, 'owner-file.txt'), 'utf8'), 'the restore never follows the planted link').toBe(OWNER_FILE)
  expect(starts).toEqual([{ test: RED_TEST, testIsLink: false, notes: OWNER_NOTES, round: 1 }])
  expect(gates.map((gate) => gate.ok)).toEqual([false, true])
  expect(task(id).execution_note).toBe('готово к приёмке')
  expectCleanCommit(id, base)
})
