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

test('an empty .git directory is not a repository: refused with a reason, nothing stored', async () => {
  const path = join(root, 'empty-dot-git')
  mkdirSync(join(path, '.git'), { recursive: true })
  expect(await gitRepositoryProblem(path)).toBeDefined()
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(reply).toContain(path)
  expect(storedPaths()).toEqual([])
})

test('a gitfile pointing at a missing gitdir is refused, nothing stored', async () => {
  const path = join(root, 'broken-gitfile')
  mkdirSync(path)
  writeFileSync(join(path, '.git'), `gitdir: ${join(root, 'no-such-gitdir')}\n`)
  expect(await gitRepositoryProblem(path)).toBeDefined()
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
})

test('a .git file that is not a gitfile is refused, nothing stored', async () => {
  const path = join(root, 'garbage-gitfile')
  mkdirSync(path)
  writeFileSync(join(path, '.git'), 'not a gitfile\n')
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
})

test('an enclosing repository does not vouch for a subdirectory with an empty .git', async () => {
  const outer = gitRepo(join(root, 'outer'))
  const path = join(outer, 'nested')
  mkdirSync(join(path, '.git'), { recursive: true })
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
})

test('a plain subdirectory of a repository is not a project root', async () => {
  const outer = gitRepo(join(root, 'outer-plain'))
  const path = join(outer, 'src')
  mkdirSync(path)
  const reply = await addProject(path)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
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

test('a missing path and a file are refused before git runs', async () => {
  expect(await gitRepositoryProblem(join(root, 'missing'))).toBe('каталог не существует')
  const file = join(root, 'file.txt')
  writeFileSync(file, 'x')
  expect(await gitRepositoryProblem(file)).toBe('это не каталог')
  const reply = await addProject(file)
  expect(reply).toContain('Не является git-репозиторием')
  expect(storedPaths()).toEqual([])
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

test('a task waiting for acceptance offers «Принять» and «Вернуть» on the panel screen', async () => {
  const id = insertTask('awaiting_human', undefined, ['src/value.mjs'])
  const data = await openTaskScreen(id)
  expect(data).toContain(`ac:${id}`)
  expect(data).toContain(`rv:${id}`)
  expect(data, 'approval buttons belong to another status').not.toContain(`aa:${id}`)
  expect(data, 'the way back stays').toContain('s:t')
})

// A task that ended without a commit has nothing to accept: the panel must not
// offer a press that only fails later in git or gh.
test('an empty task waiting for acceptance offers «Вернуть» and «Отклонить», not «Принять»', async () => {
  const id = insertTask('awaiting_human')
  const data = await openTaskScreen(id)
  expect(data).toContain(`rv:${id}`)
  expect(data).toContain(`ar:${id}`)
  expect(data, 'there is nothing to accept').not.toContain(`ac:${id}`)
  expect(data).toContain('s:t')
})

test('an analysed task offers «Одобрить», «Править» and «Отменить» on the panel screen', async () => {
  const id = insertTask('awaiting_approval')
  expect(await openTaskScreen(id)).toEqual([`aa:${id}`, `ae:${id}`, `ar:${id}`, 's:t'])
})

test('a task of every other status keeps only the way back', async () => {
  for (const status of ['incoming', 'analysis', 'queued', 'running', 'merged', 'rejected']) {
    const id = insertTask(status)
    expect(await openTaskScreen(id), status).toEqual(['s:t'])
  }
})

// A press must leave a visible trace: the card says what started, and a failed
// merge names its reason. A toast of a callback answer lives a second only.
test('«Принять» rewrites the acceptance card and names the reason of a failure', async () => {
  const id = insertTask('awaiting_human', 31, ['src/value.mjs'])
  await openTaskScreen(id)
  const mark = calls.length
  expect(await factory.handleCallback({ id: 'cb-ac', chatId: OWNER, fromId: OWNER, messageId: 7, data: `f1:ac:${id}` })).toBe(true)
  const started = calls
    .slice(mark)
    .filter((call) => call.method === 'editMessageText' && call.params.message_id === 31)
    .map((call) => JSON.stringify(call.params))
    .join('\n')
  expect(started, 'the card of the task says the merge started').toContain('Вливаю изменения')
  await vi.waitFor(() => {
    const later = calls.slice(mark).map((call) => JSON.stringify(call.params)).join('\n')
    expect(later, 'the failed merge names its reason').toContain('worktree задачи не найден')
  }, { timeout: 10_000 })
})

test('«Принять» on a task that no longer waits for acceptance says so instead of staying silent', async () => {
  const id = insertTask('running')
  await openTaskScreen(id)
  const mark = calls.length
  expect(await factory.handleCallback({ id: 'cb-ac2', chatId: OWNER, fromId: OWNER, messageId: 7, data: `f1:ac:${id}` })).toBe(true)
  const after = calls.slice(mark).map((call) => JSON.stringify(call.params)).join('\n')
  expect(after, 'the owner learns that there is nothing to merge').toContain('вливать нечего')
})

// A second press on a card that already says everything is the normal case:
// Telegram answers 400 "message is not modified" to the identical edit. That is
// not a failure, and it must not stop the press from being answered.
test('a repeated press on an unchanged card is answered, not thrown', async () => {
  const id = insertTask('running', 31)
  await openTaskScreen(id)
  apiFault = (method) =>
    method === 'editMessageText'
      ? new TelegramApiError(
          method,
          400,
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
        )
      : undefined
  calls = []
  await expect(
    factory.handleCallback({ id: 'cb-again', chatId: OWNER, fromId: OWNER, messageId: 7, data: `f1:ac:${id}` }),
  ).resolves.toBe(true)
  const answered = calls.filter((call) => call.method === 'answerCallbackQuery')
  expect(answered, 'the press is answered even when nothing changed').toHaveLength(1)
})

// Any other failure of the edit would escape handleCallback, leave the callback
// unanswered and look like a dead button. The reason must reach the owner.
test('a failing edit answers the press and tells the owner the reason', async () => {
  const id = insertTask('running', 31)
  await openTaskScreen(id)
  apiFault = (method) =>
    method === 'editMessageText' ? new TelegramApiError(method, 400, "Bad Request: message can't be edited") : undefined
  calls = []
  await expect(
    factory.handleCallback({ id: 'cb-fail', chatId: OWNER, fromId: OWNER, messageId: 7, data: `f1:ac:${id}` }),
  ).resolves.toBe(true)
  expect(calls.some((call) => call.method === 'answerCallbackQuery'), 'the toast is sent').toBe(true)
  const sent = calls
    .filter((call) => call.method.startsWith('send'))
    .map((call) => JSON.stringify(call.params))
    .join('\n')
  expect(sent, 'the owner sees why the button did nothing').toContain('не сработала')
  expect(sent, 'the reason is quoted').toContain("message can't be edited")
})
