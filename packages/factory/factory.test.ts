// The factory accepts a project only when git itself confirms the path is the
// root of a work tree: a bare `.git` marker (an empty directory, a gitfile
// pointing nowhere) must be refused with a reason and never stored.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import { TelegramApiError, type TelegramApi } from '../telegram/src/api.js'
import { createFactory, gitRepositoryProblem, type Factory } from './src/index.js'

const OWNER = 4242
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

let root: string
let store: Store
let calls: Array<{ method: string; params: Record<string, unknown> }>
let factory: Factory
/** Fault injected into the fake Telegram API for one test. */
let apiFault: ((method: string, params: Record<string, unknown>) => Error | undefined) | undefined

function git(...args: string[]): void {
  execFileSync('git', args, { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitRepo(path: string): string {
  mkdirSync(path, { recursive: true })
  git('init', '-q', path)
  return path
}

function storedPaths(): string[] {
  return (store.db.prepare('SELECT path FROM factory_projects ORDER BY id').all() as Array<{ path: string }>).map(
    (row) => row.path,
  )
}

/** Run «Проекты → Добавить» and send the two-line answer; returns the bot reply. */
async function addProject(path: string, command = 'npm test'): Promise<string> {
  const handled = await factory.handleCallback({ id: 'cb', chatId: OWNER, fromId: OWNER, messageId: 1, data: 'f1:pa' })
  expect(handled).toBe(true)
  calls = []
  expect(await factory.takeInput(OWNER, `${path}\n${command}`)).toBe(true)
  const sent = calls.filter((call) => call.method.startsWith('send'))
  expect(sent).toHaveLength(1)
  return JSON.stringify(sent[0]!.params)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-factory-'))
  mkdirSync(join(root, 'home'))
  store = openStore(join(root, 'home', 'state.db'))
  calls = []
  apiFault = undefined
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      const fault = apiFault?.(method, params)
      if (fault !== undefined) throw fault
      return { message_id: 1, chat: { id: params.chat_id } } as T
    },
  }
  factory = createFactory({
    store,
    home: join(root, 'home'),
    appRoot: gitRepo(join(root, 'app-root')),
    api,
    ownerId: () => OWNER,
    catalogue: async () => [],
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

test('an inherited GIT_DIR does not make an empty .git look valid', async () => {
  const real = gitRepo(join(root, 'real-for-env'))
  vi.stubEnv('GIT_DIR', join(real, '.git'))
  vi.stubEnv('GIT_WORK_TREE', real)
  const path = join(root, 'empty-with-env')
  mkdirSync(join(path, '.git'), { recursive: true })
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
  for (const [name, gitfile] of [['broken-pointer', 'gitdir: missing\n'], ['malformed-pointer', 'not a gitfile\n']]) {
    const invalid = join(root, name!)
    mkdirSync(invalid)
    writeFileSync(join(invalid, '.git'), gitfile!)
    await addProject(invalid)
    expect(storedPaths()).toEqual([])
  }
})

test('a real repository and a linked worktree are accepted and stored with their test command', async () => {
  const path = gitRepo(join(root, 'good-repo'))
  expect(await gitRepositoryProblem(path)).toBeUndefined()
  let reply = await addProject(path, 'node --test')
  expect(reply).toContain(`Проект ${basename(path)} добавлен`)

  git('-C', path, 'commit', '-q', '--allow-empty', '-m', 'init')
  const worktree = join(root, 'linked-worktree')
  git('-C', path, 'worktree', 'add', '-q', worktree)
  expect(await gitRepositoryProblem(worktree)).toBeUndefined()
  reply = await addProject(worktree, 'npm test')
  expect(reply).toContain(`Проект ${basename(worktree)} добавлен`)

  expect(storedPaths()).toEqual([path, worktree])
  const commands = store.db.prepare('SELECT test_command FROM factory_projects ORDER BY id').all() as Array<{
    test_command: string
  }>
  expect(commands.map((row) => row.test_command)).toEqual(['node --test', 'npm test'])
})

// The panel screen of one task must carry the actions of its status: the card
// that started a phase scrolls away, and a task waiting for the owner with no
// buttons anywhere cannot be moved at all.
function insertTask(status: string, acceptanceMessageId?: number, resultFiles: string[] = []): number {
  const info = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at, result_files)
     VALUES ('Задача', 'текст задачи', ?, 1, 'app', ?, ?, ?)`,
  ).run(status, join(root, 'app-root'), Date.now(), JSON.stringify(resultFiles))
  const id = Number(info.lastInsertRowid)
  if (acceptanceMessageId !== undefined) {
    store.db.prepare('UPDATE factory_tasks SET acceptance_message_id = ?, acceptance_chat_id = ? WHERE id = ?')
      .run(acceptanceMessageId, OWNER, id)
  }
  return id
}

async function openTaskScreen(id: number): Promise<string[]> {
  calls = []
  expect(await factory.handleCallback({ id: 'cb', chatId: OWNER, fromId: OWNER, messageId: 7, data: `f1:t:${id}` })).toBe(true)
  const card = calls.filter((call) => call.method === 'editMessageText').at(-1)
  expect(card, 'the panel redraws the task card').toBeDefined()
  const markup = card!.params.reply_markup as
    | { inline_keyboard?: Array<Array<{ callback_data?: unknown }>> }
    | undefined
  return (markup?.inline_keyboard ?? []).flat().map((entry) => String(entry.callback_data ?? '').replace(/^f1:/, ''))
}

// A task that ended without a commit has nothing to accept: the panel must not
// offer a press that only fails later in git or gh.

// A press must leave a visible trace: the card says what started, and a failed
// merge names its reason. A toast of a callback answer lives a second only.

// A second press on a card that already says everything is the normal case:
// Telegram answers 400 "message is not modified" to the identical edit. That is
// not a failure, and it must not stop the press from being answered.

// Any other failure of the edit would escape handleCallback, leave the callback
// unanswered and look like a dead button. The reason must reach the owner.
