// The gate runs the project test command without a shell, even inside the
// sandbox: the command is split into argv the way sh splits words, and a
// command that only a shell understands stops the task before any worktree or
// model turn. The roles and the sandbox are in-process doubles; the git
// repositories are real disposable fixtures.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, testCommandArgv, type Factory, type FactoryRoleTurn } from './src/index.js'

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

let root: string
let project: string
let home: string
let store: Store
let turns: FactoryRoleTurn[]
let gateRuns: Array<{ candidate: string; command: readonly string[] | undefined }>
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

function makeProject(path: string): void {
  put(join(path, 'src/value.mjs'), BASE_SOURCE)
  git(dirname(path), 'init', '-q', path)
  git(path, 'add', '--', 'src/value.mjs')
  git(path, 'commit', '--no-gpg-sign', '-q', '-m', 'fixture base')
}

/** Red while the worktree still has the base source, green once it is fixed. */
function sandbox(options: SandboxOptions): SandboxResult {
  gateRuns.push({ candidate: options.candidate, command: options.command })
  const source = readFileSync(join(options.candidate, 'src/value.mjs'), 'utf8')
  return source === FIXED_SOURCE
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
}

async function roleTurn(turn: FactoryRoleTurn): Promise<string> {
  turns.push(turn)
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
      if (method.startsWith('send')) sent.push(JSON.stringify(params))
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
  ).get('gate command', 'gate command', projectId, project, Date.now(), JSON.stringify(['value() возвращает 2.']),
    JSON.stringify(['src/value.mjs'])) as { id: number }
  return row.id
}

function task(id: number): { status: string; execution_note: string | null; worktree: string | null } {
  return store.db.prepare('SELECT status, execution_note, worktree FROM factory_tasks WHERE id = ?')
    .get(id) as { status: string; execution_note: string | null; worktree: string | null }
}

async function approveAndSettle(factory: Factory, id: number): Promise<void> {
  expect(await factory.handleCallback({ id: `cb-${id}`, chatId: OWNER, fromId: OWNER, messageId: 70, data: `f1:aa:${id}` }))
    .toBe(true)
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-command-')))
  project = join(root, 'project')
  home = join(root, 'home')
  mkdirSync(join(root, 'owner-home'))
  mkdirSync(home)
  for (const [key, value] of Object.entries(GIT_ENV)) vi.stubEnv(key, value)
  makeProject(project)
  store = openStore(join(home, 'state.db'))
  // Execution tests stop at «ждёт человека»; acceptance has its own file.
  store.kv.set('factory.autoaccept', '0')
  turns = []
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

test('plain words, quotes, escapes and leading assignments become argv without a shell', () => {
  expect(testCommandArgv('npm test')).toEqual({ argv: ['npm', 'test'] })
  expect(testCommandArgv('  fixture-tests\t--unit  ')).toEqual({ argv: ['fixture-tests', '--unit'] })
  expect(testCommandArgv(`npm run "unit tests" 'a b' a\\ b`)).toEqual({ argv: ['npm', 'run', 'unit tests', 'a b', 'a b'] })
  expect(testCommandArgv(`vitest 'a|b' "x;y" "q\\"t" 'it''s'`)).toEqual({ argv: ['vitest', 'a|b', 'x;y', 'q"t', 'its'] })
  expect(testCommandArgv('vitest a#b a~b --grep=x ""')).toEqual({ argv: ['vitest', 'a#b', 'a~b', '--grep=x', ''] })
  expect(testCommandArgv('npm \\\ntest')).toEqual({ argv: ['npm', 'test'] })
  expect(testCommandArgv('CI=1 FOO="a b" npm test BAR=2')).toEqual({ argv: ['env', 'CI=1', 'FOO=a b', 'npm', 'test', 'BAR=2'] })
  // A quoted name is no assignment: sh runs it as the program itself.
  expect(testCommandArgv('"CI=1" npm')).toEqual({ argv: ['CI=1', 'npm'] })
})

test('a command only a shell understands is refused with the offending character', () => {
  const refused: Array<[string, RegExp]> = [
    ['npm test && npm run lint', /«&»/],
    ['npm test | tee out', /«\|»/],
    ['npm test; rm -rf build', /«;»/],
    ['npm test > out.log', /«>»/],
    ['npm test < in', /«<»/],
    ['(npm test)', /«\(»/],
    ['echo $HOME', /«\$»/],
    ['echo "$HOME"', /«\$»/],
    ['echo `id`', /«`»/],
    ['vitest *.test.ts', /«\*»/],
    ['vitest a?b', /«\?»/],
    ['vitest [ab]', /«\[»/],
    ['npm test # comment', /«#»/],
    ['~/bin/tests', /«~»/],
    ['npm test\nnpm run lint', /перевод строки/],
    ["npm test 'open", /незакрытая кавычка/],
    ['npm test \\', /обратной косой/],
    ['CI=1', /нет программы/],
    ["'' test", /пустое имя/],
    ['CI=1 "A=2" npm', /содержит «=»/],
  ]
  for (const [command, reason] of refused) {
    const result = testCommandArgv(command)
    expect('error' in result, command).toBe(true)
    expect((result as { error: string }).error, command).toMatch(reason)
  }
})

test('the project menu refuses a test command that needs a shell and saves a plain one', async () => {
  const factory = startFactory()
  const commands = (): string[] =>
    (store.db.prepare('SELECT test_command FROM factory_projects ORDER BY id').all() as Array<{ test_command: string }>)
      .map((row) => row.test_command)
  const answer = async (text: string): Promise<string> => {
    expect(await factory.handleCallback({ id: 'cb-pa', chatId: OWNER, fromId: OWNER, messageId: 1, data: 'f1:pa' })).toBe(true)
    sent = []
    expect(await factory.takeInput(OWNER, `${project}\n${text}`)).toBe(true)
    return sent.join('\n')
  }

  const refusal = await answer('npm test | tee log')
  expect(refusal).toMatch(/без оболочки/)
  expect(refusal).toContain('«|»')
  expect(commands()).toEqual([])
  expect(await answer('npm test\nnpm run lint')).toMatch(/перевод строки/)
  expect(commands()).toEqual([])
  // Positive control: the same menu path stores a command argv can carry.
  expect(await answer('CI=1 npm test')).not.toMatch(/без оболочки/)
  expect(commands()).toEqual(['CI=1 npm test'])
})

test('a project test command that needs a shell stops the task before any worktree, role or gate', async () => {
  // The schema exists once the factory is created; its resume pass sees no task.
  const factory = startFactory()
  const projectId = addProject('npm test && rm -rf ~')
  const head = git(project, 'rev-parse', 'HEAD')
  const id = seedTask(projectId)
  await approveAndSettle(factory, id)

  expect(task(id).execution_note).toMatch(/без оболочки/)
  expect(task(id).execution_note).toContain('npm test && rm -rf ~')
  expect(task(id).execution_note).toMatch(/«&»/)
  expect(turns, 'no model turn is spent on a task whose tests never start').toHaveLength(0)
  expect(gateRuns, 'the gate never runs').toHaveLength(0)
  expect(task(id).worktree ?? '', 'no worktree is planned').toBe('')
  const worktrees = join(home, 'factory', 'worktrees')
  expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([])
  expect(git(project, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  expect(git(project, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(project, 'status', '--porcelain')).toBe('')
})

test('every gate of a task gets the parsed argv of the project command', async () => {
  const factory = startFactory()
  const projectId = addProject(`CI=1 fixture-tests --unit 'a b'`)
  const id = seedTask(projectId)
  await approveAndSettle(factory, id)

  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(gateRuns.length, 'writer gate and executor gate').toBeGreaterThanOrEqual(2)
  for (const run of gateRuns) expect(run.command).toEqual(['env', 'CI=1', 'fixture-tests', '--unit', 'a b'])
})

test('the own repository runs npm test as two argv words', async () => {
  const factory = startFactory()
  const id = seedTask(0)
  await approveAndSettle(factory, id)

  expect(task(id).execution_note).toBe('готово к приёмке')
  expect(gateRuns.length).toBeGreaterThanOrEqual(2)
  for (const run of gateRuns) expect(run.command).toEqual(['npm', 'test'])
})
