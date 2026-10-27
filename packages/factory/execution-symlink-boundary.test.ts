// Same real repository / SQLite / createFactory harness as the neighboring
// execution-gate-restore tests; only roles and the sandbox runner are doubles.
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const SOURCE_PATH = 'src/value.mjs'
const COPY_PATH = 'src/writer-copy.mjs'
const TEST_PATH = 'tests/value.test.mjs'
const BASE_SOURCE = 'export function value() { return 1 }\n'
const FIXED_SOURCE = 'export function value() { return 2 }\n'
const RED_TEST = "import { value } from '../src/value.mjs'\nif (value() !== 2) throw new Error('value returns two')\n"
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let root: string
let home: string
let project: string
let store: Store

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    env: { PATH: process.env.PATH ?? '', ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<void> {
  const tool = turn.tools.find((candidate) => candidate.name === 'write_file')
  expect(tool, `${turn.role} has a write tool`).toBeDefined()
  await tool!.execute({ path, content })
}

function task(id: number): {
  status: string
  execution_note: string | null
  execution_round: number | null
  worktree: string | null
} {
  return store.db.prepare(
    'SELECT status, execution_note, execution_round, worktree FROM factory_tasks WHERE id = ?',
  ).get(id) as ReturnType<typeof task>
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-symlink-boundary-')))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  put(join(project, SOURCE_PATH), BASE_SOURCE)
  put(join(project, COPY_PATH), RED_TEST)
  git(root, 'init', '-q', project)
  git(project, 'add', '--', SOURCE_PATH, COPY_PATH)
  git(project, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture base')
  store = openStore(join(home, 'state.db'))
  // Execution tests stop at «ждёт человека»; acceptance has its own file.
  store.kv.set('factory.autoaccept', '0')
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('test_c4_gate_replacing_a_locked_test_with_an_identical_content_symlink_voids_the_round_and_restores_the_file', async () => {
  const turns: FactoryRoleTurn[] = []
  const gates: boolean[] = []
  const executorStarts: Array<{
    test: string
    regularFile: boolean
    symlink: boolean
    round: number | null
    priorReviews: number
  }> = []
  let tampered = false
  let id = 0
  const sandbox = (options: SandboxOptions): SandboxResult => {
    const ok = readFileSync(join(options.candidate, SOURCE_PATH), 'utf8') === FIXED_SOURCE
    gates.push(ok)
    // The writer gate is red. The first green executor gate runs project code
    // that substitutes an allowed file without changing the test's read bytes.
    if (ok && !tampered) {
      const testPath = join(options.candidate, TEST_PATH)
      expect(lstatSync(testPath).isFile()).toBe(true)
      expect(readFileSync(join(options.candidate, COPY_PATH), 'utf8')).toBe(RED_TEST)
      rmSync(testPath)
      symlinkSync('../src/writer-copy.mjs', testPath)
      expect(readFileSync(testPath, 'utf8')).toBe(RED_TEST)
      expect(lstatSync(testPath).isSymbolicLink()).toBe(true)
      tampered = true
    }
    return { ok, status: ok ? 0 : 1, output: ok ? 'ok' : 'AssertionError: actual 1 expected 2' }
  }
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
      if (turn.role === 'test_writer') {
        await write(turn, TEST_PATH, RED_TEST)
        return JSON.stringify({ tests: [TEST_PATH] })
      }
      if (turn.role === 'executor') {
        const testPath = join(turn.cwd, TEST_PATH)
        executorStarts.push({
          test: readFileSync(testPath, 'utf8'),
          regularFile: lstatSync(testPath).isFile(),
          symlink: lstatSync(testPath).isSymbolicLink(),
          round: task(id).execution_round,
          priorReviews: turns.filter((entry) => entry.role === 'reviewer').length,
        })
        await write(turn, SOURCE_PATH, FIXED_SOURCE)
        return 'готово'
      }
      return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
    },
  })
  // As in neighboring execution tests, let startup recovery finish first.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const row = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at,
       criteria, footprint, risk) VALUES ('value', 'value returns two', 'awaiting_approval',
       0, 'project', ?, ?, ?, ?, 'low') RETURNING id`,
  ).get(project, Date.now(), JSON.stringify(['value() returns 2']), JSON.stringify([SOURCE_PATH, COPY_PATH])) as { id: number }
  id = row.id
  expect(await factory.handleCallback({
    id: `approve-${id}`, chatId: OWNER, fromId: OWNER, messageId: 70, data: `f1:aa:${id}`,
  })).toBe(true)
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: 10_000 })

  expect(tampered, 'the green executor gate actually planted the identical-content symlink').toBe(true)
  const executors = turns.filter((turn) => turn.role === 'executor')
  expect(executors, 'the symlink substitution must void the round and return to the executor before review').toHaveLength(2)
  expect(executors[1]!.prompt).toMatch(/круг не засчитан/i)
  expect(executors[1]!.prompt).toContain(TEST_PATH)
  expect(executorStarts[1], 'rollback must restore a regular writer test before the retry').toEqual({
    test: RED_TEST, regularFile: true, symlink: false, round: 2, priorReviews: 0,
  })
  expect(gates).toEqual([false, true, true])
  expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(1)
  expect(task(id).execution_note).toBe('готово к приёмке')
  const worktree = task(id).worktree!
  expect(lstatSync(join(worktree, TEST_PATH)).isFile()).toBe(true)
  expect(lstatSync(join(worktree, TEST_PATH)).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(worktree, TEST_PATH), 'utf8')).toBe(RED_TEST)
  expect(readFileSync(join(worktree, COPY_PATH), 'utf8')).toBe(RED_TEST)
})
