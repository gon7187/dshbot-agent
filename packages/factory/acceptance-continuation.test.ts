// Exercise acceptance through the established real-repository / SQLite fixture.
// Roles, the project gate and GitHub CLI are local doubles; no network is used.
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
// Real git worktrees and commits run under the oversubscribed full suite; the
// waits only poll for a positive outcome, so a slow host does not fail them.
const WAIT = 15_000
const SOURCE = 'src/value.mjs'
const TEST = 'tests/value.test.mjs'
const BASE = 'export function value() { return 1 }\n'
const FIXED = 'export function value() { return 2 }\n'
const RED = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/value.mjs'\ntest('returns two', () => assert.equal(value(), 2))\n"
const GITHUB = 'https://github.com/acme/widget.git'
const PR_URL = 'https://github.com/acme/widget/pull/1'
const IDENTITY = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
type Json = Record<string, unknown>
interface Call { method: string; params: Json; id: number }
interface CliCall { tool: string; args: string[] }
interface PullRequest { url: string; headRefName: string; baseRefName: string; state: string }
interface Task {
  status: string
  worktree: string | null
  execution_note: string | null
  result_base: string | null
  result_files: string | null
  result_stats: string | null
}

let root: string
let home: string
let project: string
let origin: string
let bin: string
let store: Store
let factory: Factory
let calls: Call[]
let turns: FactoryRoleTurn[]
let gates: SandboxResult[]
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
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'add', SOURCE)
  git(path, 'commit', '-q', '-m', 'fixture base')
}

function task(id: number): Task {
  return store.db.prepare(`SELECT status, worktree, execution_note, result_base, result_files, result_stats
    FROM factory_tasks WHERE id = ?`).get(id) as unknown as Task
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

function latestCard(original: Call): Call {
  return calls.filter((call) => call.method === 'editMessageText' && call.params.message_id === original.id).at(-1) ?? original
}

async function acceptanceCard(): Promise<Call> {
  const cards = () => calls.filter((call) => call.params.chat_id === OWNER &&
    ['sendMessage', 'sendRichMessage'].includes(call.method) &&
    ['Принять', 'Вернуть'].every((label) => buttons(call).some((entry) => String(entry.text).includes(label))))
  await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: WAIT })
  return cards()[0]!
}

async function press(data: string, id = 100): Promise<void> {
  expect(await factory.handleCallback({ id: `cb-${++messageId}`, chatId: OWNER, fromId: OWNER, messageId: id, data })).toBe(true)
}

async function click(card: Call, label: string): Promise<void> {
  const entry = buttons(card).find((key) => String(key.text).includes(label))
  expect(entry, `button «${label}» on ${text(card)}`).toBeDefined()
  expect(typeof entry?.callback_data).toBe('string')
  await press(String(entry!.callback_data), card.id)
}

async function write(turn: FactoryRoleTurn, path: string, content: string): Promise<void> {
  const tool = turn.tools.find((entry) => entry.name === 'write_file')
  expect(tool).toBeDefined()
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
  const fixed = readFileSync(join(options.candidate, SOURCE), 'utf8') === FIXED
  const result = fixed ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
  gates.push(result)
  return result
}

// Same public factory entry points as acceptance-flow.test.ts. GitHub traffic
// is redirected to a disposable bare repository by the git CLI boundary.
function installCli(): void {
  put(join(root, 'cli.jsonl'), '')
  put(join(root, 'prs.json'), '[]')
  put(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'git', args }) + '\\n')
const config = ['-c', 'url.' + ${JSON.stringify(origin)} + '.insteadOf=' + ${JSON.stringify(GITHUB)}]
const result = cp.spawnSync(${JSON.stringify(realGit)}, [...config, ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  put(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'gh', args }) + '\\n')
const stateFile = ${JSON.stringify(join(root, 'prs.json'))}
const prs = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(prs))
const option = (name, short) => {
  const i = args.findIndex(value => value === name || value === short)
  return i < 0 ? args.find(value => value.startsWith(name + '='))?.slice(name.length + 1) : args[i + 1]
}
const git = (cwd, ...argv) => cp.execFileSync(${JSON.stringify(realGit)}, ['-C', cwd, ...argv], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const current = () => git(process.cwd(), 'branch', '--show-current')
const output = value => {
  const jq = option('--jq', '-q')
  if (!jq) { console.log(JSON.stringify(value)); return }
  const entries = Array.isArray(value) ? (jq.includes('.[]') ? value : value.slice(0, 1)) : [value]
  for (const entry of entries) {
    if (jq.includes('.defaultBranchRef.name')) console.log(entry.defaultBranchRef?.name || '')
    else {
      const field = ['url', 'number', 'state', 'headRefName', 'baseRefName', 'nameWithOwner'].find(key => jq.includes('.' + key))
      console.log(field ? entry[field] ?? '' : JSON.stringify(entry))
    }
  }
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0)
else if (args[0] === 'repo' && args[1] === 'view') {
  output({ nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' } })
} else if (args[0] === 'pr' && args[1] === 'list') {
  const head = option('--head', '-H')
  const base = option('--base', '-B')
  const state = option('--state', '-s') || 'open'
  output(prs.filter(pr => (!head || pr.headRefName === head) && (!base || pr.baseRefName === base) &&
    (state === 'all' || pr.state.toLowerCase() === state)))
} else if (args[0] === 'pr' && args[1] === 'create') {
  const head = option('--head', '-H') || current()
  if (prs.some(pr => pr.headRefName === head && pr.state === 'OPEN')) process.exit(1)
  const pr = { number: prs.length + 1, url: ${JSON.stringify(PR_URL)}, headRefName: head,
    baseRefName: option('--base', '-B') || 'main', state: 'OPEN' }
  prs.push(pr); save(); console.log(pr.url)
} else if (args[0] === 'pr' && ['merge', 'view'].includes(args[1])) {
  const pr = prs.find(pr => args.slice(2).some(value => [pr.url, String(pr.number), pr.headRefName].includes(value))) ||
    prs.find(pr => pr.headRefName === current())
  if (!pr) process.exit(1)
  if (args[1] === 'view') output(pr)
  else {
    const remote = ${JSON.stringify(origin)}
    git(remote, 'update-ref', 'refs/heads/' + pr.baseRefName, git(remote, 'rev-parse', 'refs/heads/' + pr.headRefName))
    pr.state = 'MERGED'; save()
  }
} else { process.stderr.write('unsupported fixture gh command: ' + args.join(' ') + '\\n'); process.exit(1) }
`)
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
}

function cliCalls(): CliCall[] {
  return readFileSync(join(root, 'cli.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as CliCall)
}

function prs(): PullRequest[] {
  return JSON.parse(readFileSync(join(root, 'prs.json'), 'utf8')) as PullRequest[]
}

function github(): void {
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(project, 'push', '-q', origin, 'HEAD:refs/heads/main')
  git(project, 'remote', 'add', 'origin', GITHUB)
}

async function execute(options: { auto?: boolean; own?: boolean } = {}): Promise<number> {
  store.kv.set('factory.autoaccept', options.auto === false ? '0' : '1')
  const projectId = options.own ? 0 : Number((store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const row = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES (?, ?, 'awaiting_approval', ?, 'widget', ?, ?, ?, ?, 'low') RETURNING id`)
    .get('Исправить значение value', 'Исправить значение value', projectId, project, Date.now(),
      JSON.stringify(['value() возвращает 2.']), JSON.stringify([SOURCE])) as { id: number }
  await press(`f1:aa:${row.id}`)
  await vi.waitFor(() => expect(turns.some((turn) => turn.role === 'reviewer')).toBe(true), { timeout: WAIT })
  await vi.waitFor(() => expect(['awaiting_human', 'merged']).toContain(task(row.id).status), { timeout: WAIT })
  expect(gates.some((gate) => !gate.ok), 'the writer gate ran red').toBe(true)
  expect(gates.at(-1)?.ok, 'the executor gate ran green before the reviewer approved').toBe(true)
  return row.id
}

async function merged(id: number): Promise<void> {
  await vi.waitFor(() => expect(task(id).status, task(id).execution_note ?? '').toBe('merged'), { timeout: WAIT })
  const worktree = turns.find((turn) => turn.role === 'executor')!.cwd
  await vi.waitFor(() => expect(existsSync(worktree)).toBe(false), { timeout: WAIT })
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-continuation-')))
  home = join(root, 'home')
  project = join(root, 'project')
  origin = join(root, 'remote.git')
  bin = join(root, 'bin')
  calls = []
  turns = []
  gates = []
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
  const api: TelegramApi = {
    async call<T>(method: string, params: Json = {}): Promise<T> {
      const id = method.startsWith('send') ? ++messageId : Number(params.message_id ?? 0)
      calls.push({ method, params, id })
      return { message_id: id, chat: { id: params.chat_id } } as T
    },
  }
  factory = createFactory({
    store, home, appRoot: join(home, 'app'), api, ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }],
    ownerHome: join(root, 'owner-home'), sandbox,
    roleTurn: async (turn) => {
      turns.push(turn)
      activeRoles++
      try { return await roleScript(turn) } finally { activeRoles-- }
    },
  })
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

test.each([false, true])('test_c4_return_without_tree_changes_reuses_commit_and_acceptance_data_auto_%s', async (auto) => {
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  const before = task(id)
  const worktree = before.worktree!
  const commit = git(worktree, 'rev-parse', 'HEAD')
  expect(before.result_base).toBeTruthy()
  expect(JSON.parse(before.result_stats!)).toEqual(expect.arrayContaining([
    { path: SOURCE, added: 1, removed: 1 }, { path: TEST, added: 4, removed: 0 },
  ]))
  const mark = cliCalls().length
  const gateMark = gates.length
  const remark = 'Проверь ещё раз: менять код не требуется'
  roleScript = async (turn) => turn.role === 'executor' ? 'Повторно проверено, изменений нет' : happy(turn)
  store.kv.set('factory.autoaccept', auto ? '1' : '0')
  await click(card, 'Вернуть')
  expect(await factory.takeInput(OWNER, remark)).toBe(true)
  await vi.waitFor(() => expect(turns.filter((turn) => turn.role === 'reviewer')).toHaveLength(2), { timeout: WAIT })
  await vi.waitFor(() => expect(['awaiting_human', 'merged']).toContain(task(id).status), { timeout: WAIT })
  expect(turns.filter((turn) => turn.role === 'test_writer')).toHaveLength(1)
  const resumed = turns.filter((turn) => turn.role === 'executor')[1]!
  expect(resumed.prompt).toContain(remark)
  expect(resumed.cwd).toBe(worktree)
  expect(gates.slice(gateMark).map((gate) => gate.ok)).toEqual([true])
  expect(task(id).execution_note ?? '').not.toMatch(/исполнение не удалось|nothing to commit|git commit/i)
  expect(task(id).result_base).toBe(before.result_base)
  expect(JSON.parse(task(id).result_stats!)).toEqual(JSON.parse(before.result_stats!))
  expect(JSON.parse(task(id).result_files!)).toEqual(JSON.parse(before.result_files!))
  expect(cliCalls().slice(mark).filter((entry) => entry.tool === 'git' && entry.args.includes('commit'))).toHaveLength(0)
  if (auto) {
    await merged(id)
    expect(git(project, 'rev-parse', 'main')).toBe(commit)
  } else {
    expect(task(id).status).toBe('awaiting_human')
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(commit)
    await vi.waitFor(() => {
      const ready = latestCard(card)
      expect(text(ready)).toContain(SOURCE)
      expect(text(ready)).toContain(TEST)
      expect(buttons(ready).map((entry) => entry.text)).toEqual(expect.arrayContaining(['Принять', 'Вернуть']))
    }, { timeout: WAIT })
    await click(latestCard(card), 'Принять')
    await merged(id)
  }
})

test('test_c5_github_default_branch_is_discovered_when_only_live_exists_locally', async () => {
  git(project, 'branch', '-m', 'main', 'live')
  github()
  expect(git(project, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).toBe('live')
  expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('')
  const id = await execute()
  await merged(id)
  expect(prs()).toHaveLength(1)
  expect(prs()[0]).toMatchObject({ headRefName: `factory/${id}`, baseRefName: 'main', state: 'MERGED' })
  expect(cliCalls().some((entry) => entry.tool === 'gh' && entry.args[0] === 'auth' && entry.args[1] === 'status')).toBe(true)
  expect(cliCalls().find((entry) => entry.tool === 'gh' && entry.args[1] === 'merge')?.args).toContain('--rebase')
  expect(git(origin, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
  expect(git(origin, 'show', `main:${TEST}`)).toBe(RED.trim())
})

test('test_c6_origin_head_release_without_local_release_rebases_on_tracking_branch', async () => {
  git(project, 'branch', '-m', 'main', 'live')
  const live = git(project, 'rev-parse', 'HEAD')
  git(project, 'checkout', '-q', '-b', 'release')
  put(join(project, 'owner-added.md'), 'independent remote base change\n')
  git(project, 'add', 'owner-added.md')
  git(project, 'commit', '-q', '-m', 'remote release advanced')
  const remoteBase = git(project, 'rev-parse', 'HEAD')
  git(root, 'init', '-q', '--bare', '-b', 'release', origin)
  git(project, 'push', '-q', origin, 'release')
  git(project, 'checkout', '-q', 'live')
  git(project, 'branch', '-D', 'release')
  git(project, 'remote', 'add', 'origin', origin)
  git(project, 'fetch', '-q', 'origin')
  git(project, 'remote', 'set-head', 'origin', 'release')
  expect(git(project, 'for-each-ref', '--format=%(refname)', 'refs/heads/release')).toBe('')
  const id = await execute()
  await merged(id)
  expect(git(project, 'show', `release:${SOURCE}`)).toBe(FIXED.trim())
  expect(git(project, 'show', `release:${TEST}`)).toBe(RED.trim())
  expect(git(project, 'show', 'release:owner-added.md')).toBe('independent remote base change')
  expect(git(project, 'rev-parse', 'release^')).toBe(remoteBase)
  expect(git(project, 'rev-parse', 'live')).toBe(live)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
  expect(cliCalls().filter((entry) => entry.tool === 'gh' && entry.args[0] === 'pr')).toHaveLength(0)
})

test.each([false, true])('test_c10_bot_running_on_main_keeps_its_files_intact_github_%s', async (useGithub) => {
  project = join(home, 'app')
  if (useGithub) github()
  const runningHead = git(project, 'rev-parse', 'HEAD')
  const id = await execute({ own: true })
  if (useGithub) {
    await merged(id)
    expect(prs()[0]).toMatchObject({ baseRefName: 'main', state: 'MERGED' })
    expect(git(origin, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
    await vi.waitFor(() => expect(calls.some((call) => text(call).includes('/update') && text(call).includes(PR_URL))).toBe(true), { timeout: WAIT })
  } else {
    // Autoaccept does not start a merge it cannot make here: the task waits
    // for the owner on an ordinary card, and «Принять» explains why.
    const card = await acceptanceCard()
    expect(task(id).status, 'a running bot checkout must wait for a human instead of merging locally').toBe('awaiting_human')
    expect(task(id).execution_note).toBe('готово к приёмке')
    expect(text(card)).not.toMatch(/работающ|запущенн/i)
    expect(git(project, 'rev-parse', 'HEAD'), 'autoaccept must preserve the running bot commit').toBe(runningHead)
    await click(card, 'Принять')
    await vi.waitFor(() => {
      expect(git(project, 'rev-parse', 'HEAD'), 'local acceptance must preserve the running bot commit').toBe(runningHead)
      expect(task(id).status, 'a running bot checkout must wait for a human instead of merging locally').toBe('awaiting_human')
      expect(task(id).execution_note).toMatch(/бот|работающ|запущенн/i)
      expect(task(id).execution_note).toMatch(/ветк|рабоч|копи|\/update/i)
      expect(text(latestCard(card))).toContain(task(id).execution_note!)
    }, { timeout: WAIT })
    expect(existsSync(task(id).worktree!)).toBe(true)
  }
  expect(git(project, 'rev-parse', 'HEAD')).toBe(runningHead)
  expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
  expect(existsSync(join(project, TEST))).toBe(false)
  expect(git(project, 'show', `:${SOURCE}`)).toBe(BASE.trim())
})
