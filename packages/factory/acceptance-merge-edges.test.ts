// Acceptance edge cases beside acceptance-flow.test.ts, through the same
// createFactory / SQLite / real temporary repositories fixture: a returned task
// with a declared test of any name, the base branch open in another owner
// worktree, owner changes before a GitHub merge and a multi-line push failure.
// Only roles, the project gate and the CLI boundary are doubles; a push never
// leaves the machine and gh answers only `auth status`.
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
// Real Git and Node child processes need headroom during the parallel full gate.
const WAIT = 20_000
const SOURCE = 'src/value.mjs'
const TEST = 'tests/value.test.mjs'
const CHECK = 'checks/value.mjs'
const BASE = 'export function value() { return 1 }\n'
const FIXED = 'export function value() { return 2 }\n'
const RED = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('returns two', () => assert.equal(value(), 2))\n"
const CHECKED = "import { value } from '../src/value.mjs'\nif (value() !== 2) process.exit(1)\n"
const IDENTITY = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
type Json = Record<string, unknown>
interface Call { method: string; params: Json; id: number }
interface Task { status: string; worktree: string | null; execution_note: string | null }
interface CliCall { tool: string; args: string[] }

let root: string
let home: string
let project: string
let bin: string
let store: Store
let factory: Factory
let calls: Call[]
let turns: Array<{ turn: FactoryRoleTurn; taskId: number }>
let messageId: number
let roleScript: (turn: FactoryRoleTurn) => Promise<string>
let activeRoles: number

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeProject(path: string): void {
  put(join(path, SOURCE), BASE)
  put(join(path, 'notes.md'), 'owner notes\n')
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'add', SOURCE, 'notes.md')
  git(path, 'commit', '-q', '-m', 'fixture base')
}

function task(id: number): Task {
  return store.db.prepare('SELECT status, worktree, execution_note FROM factory_tasks WHERE id = ?')
    .get(id) as unknown as Task
}

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function text(call: Call): string {
  const markdown = object(call.params.rich_message).markdown
  return typeof markdown === 'string' ? markdownToPlain(markdown) : String(call.params.text ?? '')
}

function buttons(call: Call): Json[] {
  const rows = object(call.params.reply_markup).inline_keyboard
  return Array.isArray(rows) ? rows.flatMap((row: unknown) => Array.isArray(row) ? row.map(object) : []) : []
}

function button(call: Call, label: string): string {
  const found = buttons(call).find((entry) => String(entry.text).includes(label))
  expect(found, `button «${label}» on ${text(call)}`).toBeDefined()
  return String(found!.callback_data)
}

function acceptanceCards(): Call[] {
  return calls.filter((call) => call.params.chat_id === OWNER &&
    ['sendMessage', 'sendRichMessage'].includes(call.method) &&
    ['Принять', 'Вернуть'].every((label) => buttons(call).some((entry) => String(entry.text).includes(label))))
}

async function acceptanceCard(): Promise<Call> {
  await vi.waitFor(() => expect(acceptanceCards()).toHaveLength(1), { timeout: WAIT })
  return acceptanceCards()[0]!
}

function latestCard(original: Call): Call {
  return calls.filter((call) => call.method === 'editMessageText' && call.params.message_id === original.id).at(-1) ?? original
}

async function click(card: Call, label: string): Promise<void> {
  const data = button(card, label)
  expect(await factory.handleCallback({ id: `cb-${++messageId}`, chatId: OWNER, fromId: OWNER, messageId: card.id, data })).toBe(true)
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<void> {
  const tool = turn.tools.find((entry) => entry.name === 'write_file')
  expect(tool, `${turn.role} has the established write tool`).toBeDefined()
  await tool!.execute({ path, content })
}

async function happy(turn: FactoryRoleTurn): Promise<string> {
  if (turn.role === 'test_writer') {
    await write(turn, TEST, RED)
    return JSON.stringify({ tests: [TEST] })
  }
  if (turn.role === 'executor') {
    await write(turn, SOURCE, FIXED)
    return 'готово'
  }
  return JSON.stringify({ verdict: 'approve', approved: true, summary: 'Критерии выполнены', issues: [] })
}

function sandbox(options: SandboxOptions): SandboxResult {
  const fixed = readFileSync(join(options.candidate, SOURCE), 'utf8').includes('return 2')
  return fixed ? { ok: true, status: 0, output: 'ok' } : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
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
    ownerHome: join(root, 'owner-home'), sandbox,
    roleTurn: async (turn) => {
      const row = store.db.prepare("SELECT id FROM factory_tasks WHERE status = 'running' ORDER BY id LIMIT 1")
        .get() as { id: number } | undefined
      expect(row, 'role turn belongs to a running durable task').toBeDefined()
      turns.push({ turn, taskId: row!.id })
      activeRoles++
      try { return await roleScript(turn) } finally { activeRoles-- }
    },
  })
}

async function execute(options: { auto?: boolean; footprint?: string[] } = {}): Promise<number> {
  store.kv.set('factory.autoaccept', options.auto === false ? '0' : '1')
  const projectId = Number((store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const row = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES (?, ?, 'awaiting_approval', ?, 'widget', ?, ?, ?, ?, 'low') RETURNING id`)
    .get('Исправить значение value', 'Исправить значение value', projectId, project, Date.now(),
      JSON.stringify(['value() возвращает 2.']), JSON.stringify(options.footprint ?? [SOURCE])) as { id: number }
  expect(await factory.handleCallback({ id: `cb-${++messageId}`, chatId: OWNER, fromId: OWNER, messageId: 100, data: `f1:aa:${row.id}` })).toBe(true)
  await vi.waitFor(() => expect(turns.some(({ turn }) => turn.role === 'reviewer')).toBe(true), { timeout: WAIT })
  await vi.waitFor(() => expect(['awaiting_human', 'merged']).toContain(task(row.id).status), { timeout: WAIT })
  return row.id
}

function taskWorktree(id: number): string {
  const path = turns.find((entry) => entry.turn.role === 'executor' && entry.taskId === id)?.turn.cwd
  expect(path, 'executor really used a task worktree').toBeDefined()
  return path!
}

function cliCalls(): CliCall[] {
  return readFileSync(join(root, 'cli.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliCall)
}

// git passes through to the real binary except push, which always fails with
// the fixture reason. gh is logged in and refuses every other command.
function installCli(): void {
  put(join(root, 'cli.jsonl'), '')
  put(join(root, 'push-failure'), 'fixture push refused')
  put(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'git', args }) + '\\n')
if (args.includes('push')) {
  process.stderr.write(fs.readFileSync(${JSON.stringify(join(root, 'push-failure'))}, 'utf8') + '\\n')
  process.exit(1)
}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  put(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'gh', args }) + '\\n')
if (args[0] === 'auth' && args[1] === 'status') process.exit(0)
process.stderr.write('unsupported fixture gh command\\n')
process.exit(1)
`)
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
}

function github(): void {
  git(project, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git')
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-merge-edges-')))
  home = join(root, 'home')
  project = join(root, 'project')
  bin = join(root, 'bin')
  calls = []
  turns = []
  messageId = 1000
  activeRoles = 0
  roleScript = happy
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(IDENTITY)) vi.stubEnv(key, value)
  vi.stubEnv('HOME', join(root, 'owner-home'))
  makeProject(project)
  makeProject(join(home, 'app'))
  installCli()
  vi.stubEnv('PATH', bin)
  store = openStore(join(home, 'state.db'))
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
})

afterEach(async () => {
  await vi.waitFor(() => expect(activeRoles).toBe(0), { timeout: WAIT })
  await vi.waitFor(() => expect(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM factory_tasks WHERE status IN ('running', 'queued')",
  ).get() as { count: number }).count)).toBe(0), { timeout: WAIT })
  await new Promise((resolve) => setTimeout(resolve, 30))
  store.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

vi.setConfig({ testTimeout: 40_000, hookTimeout: 20_000 })

test('test_c4_return_keeps_a_declared_writer_test_with_any_name_locked', async () => {
  roleScript = async (turn) => {
    if (turn.role === 'test_writer') {
      await write(turn, TEST, RED)
      await write(turn, CHECK, CHECKED)
      return JSON.stringify({ tests: [TEST, CHECK] })
    }
    return happy(turn)
  }
  const id = await execute({ auto: false, footprint: [SOURCE, 'checks/'] })
  const card = await acceptanceCard()
  const worktree = taskWorktree(id)
  expect(git(worktree, 'show', `HEAD:${CHECK}`)).toBe(CHECKED.trim())
  const before = turns.length
  let tampered = false
  roleScript = async (turn) => {
    if (turn.role === 'executor') {
      if (!tampered) {
        tampered = true
        await write(turn, CHECK, 'process.exit(0)\n')
      }
      await write(turn, SOURCE, `${FIXED}// owner remark addressed\n`)
      return 'замечание исправлено'
    }
    return happy(turn)
  }
  await click(card, 'Вернуть')
  expect(await factory.takeInput(OWNER, 'поясни значение два')).toBe(true)
  await vi.waitFor(() => expect(turns.slice(before).filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(1), { timeout: WAIT })
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
  const resumed = turns.slice(before).filter(({ turn }) => turn.role === 'executor')
  expect(resumed.length, 'the tampering round is not counted').toBe(2)
  expect(resumed[1]!.turn.prompt).toContain(CHECK)
  expect(readFileSync(join(worktree, CHECK), 'utf8')).toBe(CHECKED)
  expect(git(worktree, 'show', `HEAD:${CHECK}`)).toBe(CHECKED.trim())
  expect(git(worktree, 'show', `HEAD:${SOURCE}`)).toContain('owner remark addressed')
})

test('test_c6_base_branch_open_in_another_clean_owner_worktree_moves_with_its_files', async () => {
  git(project, 'checkout', '-q', '-b', 'feature')
  const ownerMain = join(root, 'owner-main')
  git(project, 'worktree', 'add', '-q', ownerMain, 'main')
  const feature = git(project, 'rev-parse', 'feature')
  const id = await execute()
  await vi.waitFor(() => expect(task(id).status).toBe('merged'), { timeout: WAIT })
  expect(git(project, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
  expect(git(ownerMain, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'main'))
  expect(readFileSync(join(ownerMain, SOURCE), 'utf8')).toBe(FIXED)
  expect(readFileSync(join(ownerMain, TEST), 'utf8')).toBe(RED)
  expect(git(ownerMain, 'status', '--porcelain'), 'files and index follow the moved branch').toBe('')
  expect(git(project, 'rev-parse', 'feature')).toBe(feature)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
})

test('test_c6_c7_dirty_base_branch_worktree_blocks_the_merge', async () => {
  git(project, 'checkout', '-q', '-b', 'feature')
  const ownerMain = join(root, 'owner-main')
  git(project, 'worktree', 'add', '-q', ownerMain, 'main')
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  const main = git(project, 'rev-parse', 'main')
  put(join(ownerMain, SOURCE), 'OWNER-UNCOMMITTED-CANARY\n')
  await click(card, 'Принять')
  await vi.waitFor(() => expect(task(id).execution_note).toMatch(/незакоммичен/), { timeout: WAIT })
  expect(task(id).execution_note).toContain(ownerMain)
  expect(task(id).status).toBe('awaiting_human')
  expect(git(project, 'rev-parse', 'main')).toBe(main)
  expect(readFileSync(join(ownerMain, SOURCE), 'utf8')).toBe('OWNER-UNCOMMITTED-CANARY\n')
  expect(existsSync(taskWorktree(id))).toBe(true)
  await vi.waitFor(() => expect(text(latestCard(card))).toMatch(/незакоммичен/), { timeout: WAIT })
  button(latestCard(card), 'Принять')
})

test('test_c7_github_merge_waits_for_owner_changes_without_push_or_pr', async () => {
  github()
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  put(join(project, SOURCE), 'OWNER-UNCOMMITTED-CANARY\n')
  const mark = cliCalls().length
  await click(card, 'Принять')
  await vi.waitFor(() => expect(task(id).execution_note).toMatch(/незакоммичен/), { timeout: WAIT })
  expect(task(id).execution_note).toMatch(/рабоч/)
  expect(task(id).status).toBe('awaiting_human')
  const after = cliCalls().slice(mark)
  expect(after.some((entry) => entry.tool === 'git' && entry.args.includes('push'))).toBe(false)
  expect(after.some((entry) => entry.tool === 'gh' && entry.args[0] === 'pr')).toBe(false)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe('OWNER-UNCOMMITTED-CANARY\n')
  expect(existsSync(taskWorktree(id))).toBe(true)
  await vi.waitFor(() => expect(text(latestCard(card))).toMatch(/незакоммичен/), { timeout: WAIT })
  button(latestCard(card), 'Принять')
})

test('test_c8_multiline_push_failure_keeps_the_cause_from_its_last_line', async () => {
  github()
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  const cause = `error: failed to push: ${'protected branch rule; '.repeat(90)}PUSH-CAUSE-LAST`
  put(join(root, 'push-failure'), ['remote: checking changes', 'remote: scanning objects', cause].join('\n'))
  const main = git(project, 'rev-parse', 'main')
  await click(card, 'Принять')
  await vi.waitFor(() => expect(task(id).execution_note).toContain('PUSH-CAUSE-LAST'), { timeout: WAIT })
  expect(task(id).status).toBe('awaiting_human')
  expect(git(project, 'rev-parse', 'main')).toBe(main)
  expect(existsSync(taskWorktree(id))).toBe(true)
  await vi.waitFor(() => expect(text(latestCard(card))).toContain('PUSH-CAUSE-LAST'), { timeout: WAIT })
  button(latestCard(card), 'Принять')
})
