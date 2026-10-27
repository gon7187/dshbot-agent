// A task that finished without a commit of its result has nothing to accept.
// Same fixture as acceptance-flow.test.ts: real createFactory, SQLite and
// temporary git repositories; only the roles, the project gate and the git/gh
// command line are doubles. The shims record every call and never publish.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { markdownToPlain } from '../telegram/src/rich/index.js'
import { createFactory, type Factory, type FactoryRoleTurn } from './src/index.js'

const OWNER = 4242
const WAIT = 15_000
const CARD = 777
const SOURCE = 'src/value.mjs'
const TEST = 'tests/value.test.mjs'
const BASE = 'export function value() { return 1 }\n'
const FIXED = 'export function value() { return 2 }\n'
const RED = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('returns two', () => assert.equal(value(), 2))\n"
const IDENTITY = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
type Json = Record<string, unknown>
interface Call { method: string; params: Json; id: number }
interface CliCall { tool: string; args: string[] }

let root: string
let home: string
let project: string
let bin: string
let store: Store
let factory: Factory
let calls: Call[]
let worktrees: string[]
let messageId: number
let gate: (options: SandboxOptions) => SandboxResult
let writerWrites: boolean
let executorWrites: boolean

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function task(id: number): { status: string; execution_note: string | null; result_files: string | null } {
  return store.db.prepare('SELECT status, execution_note, result_files FROM factory_tasks WHERE id = ?')
    .get(id) as unknown as { status: string; execution_note: string | null; result_files: string | null }
}

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function text(call: Call): string {
  const markdown = object(call.params.rich_message).markdown
  return typeof markdown === 'string' ? markdownToPlain(markdown) : String(call.params.text ?? '')
}

function labels(call: Call): string[] {
  const rows = object(call.params.reply_markup).inline_keyboard
  return Array.isArray(rows)
    ? rows.flatMap((row: unknown) => Array.isArray(row) ? row.map((entry) => String(object(entry).text)) : [])
    : []
}

function callback(call: Call, label: string): string {
  const rows = object(call.params.reply_markup).inline_keyboard as unknown[][]
  const found = rows.flat().map(object).find((entry) => String(entry.text).includes(label))
  expect(found, `button «${label}» on ${text(call)}`).toBeDefined()
  return String(found!.callback_data)
}

// Every message the owner sees about the task: new cards and edits of them.
function shown(): Call[] {
  return calls.filter((call) => call.params.chat_id === OWNER &&
    ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(call.method))
}

// The last state of the acceptance card: the newest message with action buttons.
function card(): Call {
  const found = shown().filter((call) => labels(call).some((label) => label.includes('Вернуть'))).at(-1)
  expect(found, 'the owner got a card with actions').toBeDefined()
  return found!
}

async function press(data: string, id = CARD): Promise<void> {
  expect(await factory.handleCallback({ id: `cb-${++messageId}`, chatId: OWNER, fromId: OWNER, messageId: id, data })).toBe(true)
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<void> {
  const tool = turn.tools.find((entry) => entry.name === 'write_file')
  expect(tool, `${turn.role} has the write tool`).toBeDefined()
  await tool!.execute({ path, content })
}

async function roles(turn: FactoryRoleTurn): Promise<string> {
  worktrees.push(turn.cwd)
  if (turn.role === 'test_writer') {
    if (writerWrites) await write(turn, TEST, RED)
    return JSON.stringify({ tests: [TEST] })
  }
  if (turn.role === 'executor') {
    if (executorWrites) await write(turn, SOURCE, FIXED)
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'Критерии выполнены', issues: [] })
}

function cli(): CliCall[] {
  return readFileSync(join(root, 'cli.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliCall)
}

function publishing(): CliCall[] {
  return cli().filter((entry) => entry.tool === 'gh' || (entry.tool === 'git' && entry.args.includes('push')))
}

// git goes to the real binary; gh only records the call and refuses it.
function installCli(): void {
  put(join(root, 'cli.jsonl'), '')
  put(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'git', args }) + '\\n')
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  put(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'gh', args: process.argv.slice(2) }) + '\\n')
process.stderr.write('gh is not available in this fixture\\n')
process.exit(1)
`)
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
}

function startFactory(): Factory {
  const api: TelegramApi = {
    async call<T>(method: string, params: Json = {}): Promise<T> {
      const id = method.startsWith('send') ? ++messageId : Number(params.message_id ?? 0)
      calls.push({ method, params, id })
      return { message_id: id, chat: { id: params.chat_id } } as T
    },
  }
  return createFactory({
    store, home, appRoot: join(home, 'app'), api, ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }],
    ownerHome: join(root, 'owner-home'), sandbox: (options) => gate(options),
    roleTurn: roles,
  })
}

// The task starts with an earlier acceptance card, as a task that was returned
// before has: the end of the run then rewrites that card.
async function runTask(options: { risk: 'low' | 'high'; auto: boolean }): Promise<number> {
  store.kv.set('factory.autoaccept', options.auto ? '1' : '0')
  const project_id = Number((store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const row = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk,
     acceptance_message_id, acceptance_chat_id)
    VALUES (?, ?, 'awaiting_approval', ?, 'widget', ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get('Исправить значение value', 'Исправить значение value', project_id, project, Date.now(),
      JSON.stringify(['value() возвращает 2.']), JSON.stringify([SOURCE]), options.risk, CARD, OWNER) as { id: number }
  await press(`f1:aa:${row.id}`, 100)
  await vi.waitFor(() => expect(task(row.id).status).toBe('awaiting_human'), { timeout: WAIT })
  return row.id
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-empty-result-')))
  home = join(root, 'home')
  project = join(root, 'project')
  bin = join(root, 'bin')
  calls = []
  worktrees = []
  messageId = 1000
  writerWrites = true
  executorWrites = true
  gate = (options) => readFileSync(join(options.candidate, SOURCE), 'utf8').includes('return 2')
    ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(IDENTITY)) vi.stubEnv(key, value)
  vi.stubEnv('HOME', join(root, 'owner-home'))
  for (const path of [project, join(home, 'app')]) {
    put(join(path, SOURCE), BASE)
    git(path, 'init', '-q', '-b', 'main')
    git(path, 'add', SOURCE)
    git(path, 'commit', '-q', '-m', 'fixture base')
  }
  installCli()
  vi.stubEnv('PATH', bin)
  store = openStore(join(home, 'state.db'))
  factory = startFactory()
  // Let the existing startup recovery pass see the empty migrated table.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

afterEach(async () => {
  await vi.waitFor(() => expect(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM factory_tasks WHERE status IN ('running', 'queued')",
  ).get() as { count: number }).count)).toBe(0), { timeout: WAIT })
  // Card edits and worktree cleanup finish right after the status changes.
  await new Promise((resolve) => setTimeout(resolve, 100))
  store.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

vi.setConfig({ testTimeout: 40_000, hookTimeout: 20_000 })

const EMPTY = [
  ['tests of the writer are not red', /тесты тестописца не красные/i],
  ['the sandbox failed', /песочниц/i],
  ['the rounds ran out without a result', /Гейт не пройден/i],
] as const

test.each(EMPTY)('c1 c2 c3 c4 c6 a low-risk task with autoaccept on that ends empty (%s) has no accept, rejects cleanly', async (name, reason) => {
  if (name === 'tests of the writer are not red') gate = () => ({ ok: true, status: 0, output: 'ok' })
  if (name === 'the sandbox failed') gate = () => ({ ok: false, sandboxError: 'bwrap: no namespaces', status: null, output: '' })
  if (name === 'the rounds ran out without a result') executorWrites = false
  const id = await runTask({ risk: 'low', auto: true })
  expect(JSON.parse(task(id).result_files ?? '[]'), 'no result was committed').toEqual([])
  const worktree = worktrees[0]!
  expect(existsSync(worktree), 'the task worktree is still there for a return').toBe(true)

  // c1 c6: the card names the reason and offers return and reject, not accept.
  await vi.waitFor(() => expect(labels(card()).some((label) => label.includes('Отклонить'))).toBe(true), { timeout: WAIT })
  const shownCard = card()
  expect(labels(shownCard).some((label) => label.includes('Вернуть'))).toBe(true)
  expect(labels(shownCard).some((label) => label.includes('Принять'))).toBe(false)
  expect(text(shownCard)).toMatch(reason)
  expect(task(id).status, 'autoaccept does not take an empty task').toBe('awaiting_human')
  expect(publishing(), 'nothing is pushed or sent to gh').toEqual([])

  // c2: the task screen in /factory has the same actions.
  const before = calls.length
  await press(`f1:t:${id}`, 55)
  const screen = calls.slice(before).filter((call) => call.method === 'editMessageText' && call.params.message_id === 55).at(-1)
  expect(screen, 'task screen is shown').toBeDefined()
  expect(labels(screen!).some((label) => label.includes('Вернуть'))).toBe(true)
  expect(labels(screen!).some((label) => label.includes('Отклонить'))).toBe(true)
  expect(labels(screen!).some((label) => label.includes('Принять'))).toBe(false)

  // c3: an old card still carries «Принять»; the press changes nothing.
  const mark = calls.length
  await press(`ac:${id}`)
  await vi.waitFor(() => expect(calls.slice(mark).some((call) =>
    /принимать нечего: в задаче нет изменений/i.test(`${String(call.params.text ?? '')}\n${text(call)}`))).toBe(true), { timeout: WAIT })
  // An acceptance would run in the background after the answer; give a wrong one time to show.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(publishing(), 'accept on an empty task calls neither git push nor gh').toEqual([])
  expect(task(id).status).toBe('awaiting_human')

  // c4: reject ends the task, shows it and removes the worktree.
  await press(callback(card(), 'Отклонить'))
  await vi.waitFor(() => expect(task(id).status).toBe('rejected'), { timeout: WAIT })
  await vi.waitFor(() => expect(text(shown().filter((call) => call.params.message_id === CARD).at(-1)!)).toMatch(/отклонен/i), { timeout: WAIT })
  await vi.waitFor(() => expect(existsSync(worktree), 'rejected task worktree is removed').toBe(false), { timeout: WAIT })
  expect(publishing()).toEqual([])
})

test('c5 a task with a result keeps «Принять» and «Вернуть» on the card and on the task screen', async () => {
  const id = await runTask({ risk: 'high', auto: false })
  expect(JSON.parse(task(id).result_files ?? '[]')).toContain(SOURCE)
  await vi.waitFor(() => expect(labels(card()).some((label) => label.includes('Принять'))).toBe(true), { timeout: WAIT })
  expect(labels(card()).some((label) => label.includes('Вернуть'))).toBe(true)
  const before = calls.length
  await press(`f1:t:${id}`, 55)
  const screen = calls.slice(before).filter((call) => call.method === 'editMessageText' && call.params.message_id === 55).at(-1)
  expect(screen, 'task screen is shown').toBeDefined()
  expect(labels(screen!).some((label) => label.includes('Принять'))).toBe(true)
  expect(labels(screen!).some((label) => label.includes('Вернуть'))).toBe(true)
})

test('h1 ar:N on a task with a result keeps its worktree and its branch', async () => {
  const id = await runTask({ risk: 'high', auto: false })
  expect(JSON.parse(task(id).result_files ?? '[]')).toContain(SOURCE)
  const worktree = worktrees[0]!
  const commit = git(project, 'rev-parse', `refs/heads/factory/${id}`)
  expect(existsSync(worktree), 'the task worktree is there before the press').toBe(true)

  // The same callback stands on «Отменить» of the analysis card: an old button must not wipe the result.
  await press(`ar:${id}`)
  // A wrong removal runs inside the press; give a late one time to show.
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(existsSync(worktree), 'the worktree of a task with a result survives ar').toBe(true)
  expect(git(project, 'rev-parse', `refs/heads/factory/${id}`), 'the branch with the result survives ar').toBe(commit)
  expect(JSON.parse(task(id).result_files ?? '[]')).toContain(SOURCE)
  expect(publishing()).toEqual([])
})
