// The factory gate of the writer and of every executor round runs the light
// gate of evolve (the root `gate` script with the file list) when the project tests are plain
// `npm test` and its package.json has a `gate` script; every other project keeps
// its own command. A timed-out test run is reported as exceeded limit, not as a
// missing sandbox. The roles and the sandbox are in-process doubles; the git
// repositories are real disposable fixtures.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const WAIT = 10_000
const TIMEOUT_ENV = 'DSHBOT_EVOLVE_GATE_TIMEOUT_MS'
const DEFAULT_TIMEOUT_MS = 600_000
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

type Mode = 'normal' | 'timeout-writer' | 'timeout-executor' | 'bwrap-missing'

let root: string
let project: string
let home: string
let store: Store
let mode: Mode
let gateRuns: Array<{ candidate: string; command: readonly string[] | undefined; timeoutMs: number | undefined }>
let sent: string[]

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

function makeProject(path: string, scripts: Record<string, string>): void {
  put(join(path, 'src/value.mjs'), BASE_SOURCE)
  put(join(path, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }))
  git(dirname(path), 'init', '-q', path)
  git(path, 'add', '--', 'src/value.mjs', 'package.json')
  git(path, 'commit', '--no-gpg-sign', '-q', '-m', 'fixture base')
}

/** Red while the worktree still has the base source, green once it is fixed. */
function sandbox(options: SandboxOptions): SandboxResult {
  gateRuns.push({ candidate: options.candidate, command: options.command, timeoutMs: options.timeoutMs })
  const fixed = readFileSync(join(options.candidate, 'src/value.mjs'), 'utf8') === FIXED_SOURCE
  if (mode === 'bwrap-missing') {
    return { ok: false, sandboxError: 'песочница bwrap не запускается: spawn bwrap ENOENT', status: null, output: '' }
  }
  if ((mode === 'timeout-writer' && !fixed) || (mode === 'timeout-executor' && fixed)) {
    return {
      ok: false,
      sandboxError:
        `прогон тестов в песочнице прерван по таймауту: лимит ${String(options.timeoutMs)} мс, ` +
        `поднять его можно переменной ${TIMEOUT_ENV} (или явным timeoutMs)`,
      status: null,
      output: '',
    }
  }
  return fixed
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
}

async function roleTurn(turn: FactoryRoleTurn): Promise<string> {
  const write = turn.tools.find((candidate) => candidate.name === 'write_file')!
  if (turn.role === 'test_writer') {
    await write.execute({ path: TEST_PATH, content: 'red test\n' })
    return JSON.stringify({ tests: [TEST_PATH] })
  }
  if (turn.role === 'executor') {
    await write.execute({ path: 'src/value.mjs', content: FIXED_SOURCE })
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'ok', issues: [] })
}

function startFactory(): Factory {
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method.startsWith('send') || method.startsWith('edit')) sent.push(JSON.stringify(params))
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
    roleTurn,
  })
}

/** An external project row with its own test command, as the menu stores it. */
function addProject(testCommand: string): number {
  const row = store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'project', testCommand, Date.now()) as { id: number }
  return row.id
}

function seedTask(projectId: number): number {
  const row = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at,
       criteria, footprint, risk) VALUES (?, ?, 'awaiting_approval', ?, 'project', ?, ?, ?, ?, 'low') RETURNING id`,
  ).get('light gate', 'light gate', projectId, project, Date.now(), JSON.stringify(['value() возвращает 2.']),
    JSON.stringify(['src/value.mjs'])) as { id: number }
  return row.id
}

function task(id: number): { status: string; execution_note: string | null } {
  return store.db.prepare('SELECT status, execution_note FROM factory_tasks WHERE id = ?')
    .get(id) as { status: string; execution_note: string | null }
}

async function approveAndSettle(factory: Factory, id: number): Promise<void> {
  expect(await factory.handleCallback({ id: `cb-${id}`, chatId: OWNER, fromId: OWNER, messageId: 70, data: `f1:aa:${id}` }))
    .toBe(true)
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
}

/** The gate script call and the sorted file arguments of one recorded gate run. */
function gateFiles(command: readonly string[] | undefined): { head: string[]; files: string[] } {
  const argv = command ?? []
  return { head: argv.slice(0, 4), files: argv.slice(4).sort() }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-light-gate-')))
  project = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(join(root, 'owner-home'))
  mkdirSync(home)
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  vi.stubEnv(TIMEOUT_ENV, undefined)
  store = openStore(join(home, 'state.db'))
  // Execution tests stop at «ждёт человека»; acceptance has its own file.
  store.kv.set('factory.autoaccept', '0')
  mode = 'normal'
  gateRuns = []
  sent = []
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const { candidate } of gateRuns) {
    if (!candidate.startsWith(`${root}${sep}`)) rmSync(candidate, { recursive: true, force: true })
  }
  store?.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

test('c1 c2 c7 npm test with a gate script runs the gate script on the changed files under the env limit', async () => {
  vi.stubEnv(TIMEOUT_ENV, '1200000')
  makeProject(project, { test: 'vitest run', gate: 'echo gate' })
  const factory = startFactory()
  const id = seedTask(0)
  await approveAndSettle(factory, id)

  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(gateRuns.length, 'writer gate and executor gate').toBeGreaterThanOrEqual(2)
  const writer = gateFiles(gateRuns[0]!.command)
  expect(writer.head).toEqual(['npm', 'run', 'gate', '--'])
  expect(writer.files, 'the writer gate gets the writer tests').toEqual([`./${TEST_PATH}`])
  const executor = gateFiles(gateRuns.at(-1)!.command)
  expect(executor.head).toEqual(['npm', 'run', 'gate', '--'])
  expect(executor.files, 'the round gate gets the changed code and the writer tests').toEqual(
    ['./src/value.mjs', `./${TEST_PATH}`].sort(),
  )
  for (const run of gateRuns) expect(run.timeoutMs).toBe(1_200_000)
})

test.each([undefined, 'not-a-number', '0'])(
  'c3 c7 npm test without a gate script keeps npm test and env %j gives the default limit',
  async (value) => {
    vi.stubEnv(TIMEOUT_ENV, value)
    makeProject(project, { test: 'vitest run' })
    const factory = startFactory()
    const id = seedTask(0)
    await approveAndSettle(factory, id)

    expect(task(id).execution_note).toBe('готово к приёмке')
    expect(gateRuns.length).toBeGreaterThanOrEqual(2)
    for (const run of gateRuns) {
      expect(run.command).toEqual(['npm', 'test'])
      expect(run.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    }
  },
)

test('c4 a project with its own test command keeps it even when package.json has a gate script', async () => {
  makeProject(project, { test: 'vitest run', gate: 'echo gate' })
  const factory = startFactory()
  const id = seedTask(addProject('fixture-tests --unit'))
  await approveAndSettle(factory, id)

  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(gateRuns.length).toBeGreaterThanOrEqual(2)
  for (const run of gateRuns) expect(run.command).toEqual(['fixture-tests', '--unit'])
})

test.each<Mode>(['timeout-writer', 'timeout-executor'])(
  'c5 c7 a timed-out test run (%s) reports the limit in minutes and the env name, not a missing sandbox',
  async (kind) => {
    vi.stubEnv(TIMEOUT_ENV, '1200000')
    mode = kind
    makeProject(project, { test: 'vitest run', gate: 'echo gate' })
    const factory = startFactory()
    const id = seedTask(0)
    await approveAndSettle(factory, id)

    const note = task(id).execution_note ?? ''
    expect(note).toMatch(/20\s*мин/)
    expect(note).toContain(TIMEOUT_ENV)
    expect(note).not.toContain('песочница bwrap недоступна')
    const card = sent.join('\n')
    expect(card).toMatch(/20\s*мин/)
    expect(card).not.toContain('песочница bwrap недоступна')
  },
)

test('c6 a sandbox that cannot start still says the bwrap sandbox is unavailable with the reason', async () => {
  mode = 'bwrap-missing'
  makeProject(project, { test: 'vitest run', gate: 'echo gate' })
  const factory = startFactory()
  const id = seedTask(0)
  await approveAndSettle(factory, id)

  const note = task(id).execution_note ?? ''
  expect(note).toContain('песочница bwrap недоступна')
  expect(note).toContain('spawn bwrap ENOENT')
})
