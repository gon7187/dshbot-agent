// Acceptance contracts through the same createFactory / SQLite / real temporary
// repositories fixture as execution-recovery.test.ts. Only roles, the project
// gate and the GitHub CLI boundary are doubles. No project command or network
// request is executed. Every git assertion refers to these disposable fixtures.
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
interface Task { status: string; worktree: string | null; execution_note: string | null }
interface CliCall { tool: string; args: string[]; action: string; failed: boolean }
interface PullRequest { number: number; url: string; headRefName: string; baseRefName: string; state: string }
interface TurnObservation { turn: FactoryRoleTurn; taskId: number; round: number | null; head: string; tests?: string }

let root: string
let home: string
let project: string
let origin: string
let bin: string
let store: Store
let factory: Factory
let calls: Call[]
let turns: TurnObservation[]
let gates: SandboxResult[]
let messageId: number
let roleScript: (turn: FactoryRoleTurn) => Promise<string>
let activeRoles: number
let releases: Array<() => void>

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', env: { ...process.env, ...IDENTITY }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeProject(path: string, branch = 'main'): void {
  put(join(path, SOURCE), BASE)
  put(join(path, 'notes.md'), 'owner notes\n')
  git(path, 'init', '-q', '-b', branch)
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

function assertCounts(body: string, file: string, added: number, removed: number): void {
  const lines = body.split('\n')
  const index = lines.findIndex((line) => line.includes(file))
  expect(index, `diff has a row for ${file}`).toBeGreaterThanOrEqual(0)
  const row = lines[index]!
  const fields = row.split('|').map((field) => field.trim())
  const header = lines.slice(0, index).reverse().find((line) => line.includes('|') && /добав|additions|insertions/i.test(line))
  if (header && fields.length > 1) {
    const labels = header.split('|')
    const addIndex = labels.findIndex((label) => /добав|additions|insertions/i.test(label))
    const removeIndex = labels.findIndex((label) => /удал|deletions/i.test(label))
    if (addIndex >= 0 && removeIndex >= 0) {
      expect(Number(fields[addIndex]?.replace(/^[+−-]/, ''))).toBe(added)
      expect(Number(fields[removeIndex]?.replace(/^[+−-]/, ''))).toBe(removed)
      return
    }
  }
  expect(row).toMatch(new RegExp(`\\+\\s*${added}\\b|(?:добавлено|additions|insertions)\\s*:?\\s*${added}\\b|\\b${added}\\s*(?:добавлен|added)`, 'i'))
  expect(row).toMatch(new RegExp(`[-−]\\s*${removed}\\b|(?:удалено|deletions)\\s*:?\\s*${removed}\\b|\\b${removed}\\s*(?:удал[её]н|deleted)`, 'i'))
}

function button(call: Call, label: string): string {
  const found = buttons(call).find((entry) => String(entry.text).includes(label))
  expect(found, `button «${label}» on ${text(call)}`).toBeDefined()
  expect(typeof found?.callback_data).toBe('string')
  return String(found!.callback_data)
}

function sent(mark = 0): Call[] {
  return calls.slice(mark).filter((call) => call.params.chat_id === OWNER &&
    ['sendMessage', 'sendRichMessage'].includes(call.method))
}

function acceptanceCards(mark = 0): Call[] {
  return sent(mark).filter((call) => ['Принять', 'Вернуть'].every((label) =>
    buttons(call).some((entry) => String(entry.text).includes(label))))
}

async function acceptanceCard(mark = 0): Promise<Call> {
  await vi.waitFor(() => expect(acceptanceCards(mark), 'one acceptance card reaches the owner').toHaveLength(1), { timeout: WAIT })
  return acceptanceCards(mark)[0]!
}

function latestCard(original: Call): Call {
  return calls.filter((call) => call.method === 'editMessageText' && call.params.message_id === original.id).at(-1) ?? original
}

async function press(data: string, id = 100): Promise<void> {
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
  expect(await factory.handleCallback({ id: `cb-${++messageId}`, chatId: OWNER, fromId: OWNER, messageId: id, data })).toBe(true)
}

async function click(card: Call, label: string): Promise<void> {
  await press(button(card, label), card.id)
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
  const result = fixed ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
  gates.push(result)
  return result
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
      const row = store.db.prepare("SELECT id, execution_round FROM factory_tasks WHERE status = 'running' ORDER BY id LIMIT 1")
        .get() as { id: number; execution_round: number | null } | undefined
      expect(row, 'role turn belongs to a running durable task').toBeDefined()
      turns.push({ turn, taskId: row!.id, round: row!.execution_round, head: git(turn.cwd, 'rev-parse', 'HEAD'),
        ...(existsSync(join(turn.cwd, TEST)) ? { tests: readFileSync(join(turn.cwd, TEST), 'utf8') } : {}) })
      activeRoles++
      try { return await roleScript(turn) } finally { activeRoles-- }
    },
  })
}

async function execute(options: { risk?: 'low' | 'high'; auto?: boolean; own?: boolean; title?: string } = {}): Promise<number> {
  store.kv.set('factory.autoaccept', options.auto === false ? '0' : '1')
  const title = options.title ?? 'Исправить значение value'
  const existing = store.db.prepare('SELECT id FROM factory_projects WHERE path = ?').get(project) as { id: number } | undefined
  const projectId = options.own ? 0 : existing?.id ?? Number((store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const row = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES (?, ?, 'awaiting_approval', ?, 'widget', ?, ?, ?, ?, ?) RETURNING id`)
    .get(title, title, projectId, project, Date.now(), JSON.stringify(['value() возвращает 2.']),
      JSON.stringify([SOURCE]), options.risk ?? 'low') as { id: number }
  await press(`f1:aa:${row.id}`)
  // Positive controls: the production execution path actually runs through a
  // red writer gate, a green executor gate and the reviewer before acceptance.
  await vi.waitFor(() => expect(turns.some(({ turn }) => turn.role === 'reviewer')).toBe(true), { timeout: WAIT })
  await vi.waitFor(() => expect(['awaiting_human', 'merged']).toContain(task(row.id).status), { timeout: WAIT })
  expect(gates.some((gate) => !gate.ok)).toBe(true)
  expect(gates.at(-1)?.ok).toBe(true)
  return row.id
}

function taskWorktree(id: number): string {
  const path = turns.find((entry) => entry.turn.role === 'executor' && entry.taskId === id)?.turn.cwd
  expect(path, 'executor really used a task worktree').toBeDefined()
  return path!
}

async function merged(id: number): Promise<void> {
  await vi.waitFor(() => expect(task(id).status).toBe('merged'), { timeout: WAIT })
  await vi.waitFor(() => expect(existsSync(taskWorktree(id)), 'merged task worktree is removed').toBe(false), { timeout: WAIT })
}

function assertLocalResult(branch = 'main'): void {
  expect(git(project, 'show', `${branch}:${SOURCE}`)).toBe(FIXED.trim())
  expect(git(project, 'show', `${branch}:${TEST}`)).toBe(RED.trim())
}

function cliCalls(tool?: string, action?: string): CliCall[] {
  const entries = readFileSync(join(root, 'cli.jsonl'), 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as CliCall)
  return entries.filter((entry) => (tool === undefined || entry.tool === tool) &&
    (action === undefined || entry.action === action))
}

function prs(): PullRequest[] {
  return JSON.parse(readFileSync(join(root, 'prs.json'), 'utf8')) as PullRequest[]
}

function fail(stage = '', reason = 'fixture transport failure'): void {
  put(join(root, 'failure.json'), JSON.stringify({ stage, reason }))
}

// The shim passes normal git commands to the real binary and redirects the
// fixture origin to a local bare repository. A push can fail before any write.
// gh keeps realistic durable PR state, including duplicate-creation refusal.
function installCli(): void {
  put(join(root, 'cli.jsonl'), '')
  put(join(root, 'prs.json'), '[]')
  fail()
  put(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
const failure = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'failure.json'))}, 'utf8'))
const action = args.includes('push') ? 'push' : ''
const failed = action === 'push' && failure.stage === 'push'
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'git', args, action, failed }) + '\\n')
if (failed) { process.stderr.write(failure.reason + '\\n'); process.exit(1) }
const url = fs.readFileSync(${JSON.stringify(join(root, 'origin-url'))}, 'utf8')
const config = url ? ['-c', 'url.' + ${JSON.stringify(origin)} + '.insteadOf=' + url] : []
const result = cp.spawnSync(${JSON.stringify(realGit)}, [...config, ...args], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  put(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
const action = args[0] === 'pr' ? args[1] : args.slice(0, 2).join(' ')
const failure = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'failure.json'))}, 'utf8'))
const failed = failure.stage === action
fs.appendFileSync(${JSON.stringify(join(root, 'cli.jsonl'))}, JSON.stringify({ tool: 'gh', args, action, failed }) + '\\n')
if (failed) { process.stderr.write(failure.reason + '\\n'); process.exit(1) }
const stateFile = ${JSON.stringify(join(root, 'prs.json'))}
const prs = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(prs))
const option = (name, short) => {
  const index = args.findIndex(value => value === name || value === short)
  return index < 0 ? args.find(value => value.startsWith(name + '='))?.slice(name.length + 1) : args[index + 1]
}
const git = (cwd, ...argv) => cp.execFileSync(${JSON.stringify(realGit)}, ['-C', cwd, ...argv], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
const current = () => git(process.cwd(), 'branch', '--show-current')
const selected = () => prs.find(pr => args.slice(2).some(value =>
  [pr.url, String(pr.number), pr.headRefName].includes(value))) || prs.find(pr => pr.headRefName === current())
const output = value => {
  const jq = option('--jq', '-q')
  if (!jq) { console.log(JSON.stringify(value)); return }
  const selected = Array.isArray(value) ? (jq.includes('.[]') ? value : value.slice(0, 1)) : [value]
  const field = ['url', 'number', 'state', 'headRefName', 'baseRefName', 'nameWithOwner'].find(key => jq.includes('.' + key))
  for (const entry of selected) {
    if (jq.includes('.defaultBranchRef.name')) console.log(entry.defaultBranchRef?.name || '')
    else if (field) console.log(entry[field] ?? '')
    else console.log(JSON.stringify(entry))
  }
}
if (action === 'auth status') process.exit(0)
else if (action === 'repo view') {
  const repo = { nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/widget' }
  if ((option('--jq', '-q') || '').includes('nameWithOwner')) console.log(repo.nameWithOwner)
  else output(repo)
} else if (action === 'list') {
  const head = option('--head', '-H')
  const base = option('--base', '-B')
  const state = option('--state', '-s') || 'open'
  output(prs.filter(pr => (!head || pr.headRefName === head) && (!base || pr.baseRefName === base) &&
    (state === 'all' || pr.state.toLowerCase() === state)))
} else if (action === 'view') {
  const pr = selected()
  if (!pr) { process.stderr.write('no pull requests found\\n'); process.exit(1) }
  output(pr)
} else if (action === 'create') {
  const head = option('--head', '-H') || current()
  if (prs.some(pr => pr.headRefName === head && pr.state === 'OPEN')) {
    process.stderr.write('a pull request for this branch already exists\\n'); process.exit(1)
  }
  const number = prs.length + 1
  const file = option('--body-file', '-F')
  const pr = { number, url: 'https://github.com/acme/widget/pull/' + number, headRefName: head,
    baseRefName: option('--base', '-B') || 'main', title: option('--title', '-t') || '',
    body: file ? fs.readFileSync(file === '-' ? 0 : file, 'utf8') : option('--body', '-b') || '', state: 'OPEN' }
  prs.push(pr); save(); console.log(pr.url)
} else if (action === 'merge') {
  const pr = selected()
  if (!pr) { process.stderr.write('no matching pull request\\n'); process.exit(1) }
  const remote = ${JSON.stringify(origin)}
  const sha = git(remote, 'rev-parse', 'refs/heads/' + pr.headRefName)
  git(remote, 'update-ref', 'refs/heads/' + pr.baseRefName, sha)
  pr.state = 'MERGED'; save()
} else if (args[0] === '--version') console.log('gh version fixture')
else { process.stderr.write('unsupported fixture gh command: ' + args.join(' ') + '\\n'); process.exit(1) }
`)
  chmodSync(join(bin, 'git'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
}

function github(url = GITHUB): void {
  put(join(root, 'origin-url'), url)
  git(root, 'init', '-q', '--bare', '-b', 'main', origin)
  git(project, 'push', '-q', origin, 'main')
  git(project, 'remote', 'add', 'origin', url)
  // A remote-tracking default is seeded with public git commands, never by
  // reading git's private files. The CLI shim routes future fetches locally.
  git(project, 'fetch', '-q', origin, 'main:refs/remotes/origin/main')
  git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-factory-acceptance-')))
  home = join(root, 'home')
  project = join(root, 'project')
  origin = join(root, 'remote.git')
  bin = join(root, 'bin')
  calls = []
  turns = []
  gates = []
  messageId = 1000
  activeRoles = 0
  releases = []
  roleScript = happy
  mkdirSync(home)
  mkdirSync(join(root, 'owner-home'))
  for (const [key, value] of Object.entries(IDENTITY)) vi.stubEnv(key, value)
  vi.stubEnv('HOME', join(root, 'owner-home'))
  makeProject(project)
  makeProject(join(home, 'app'))
  put(join(root, 'origin-url'), '')
  installCli()
  // Isolated PATH makes the missing-gh variant deterministic, even on hosts
  // with a real GitHub login. Both fixture CLIs have an absolute node shebang.
  vi.stubEnv('PATH', bin)
  store = openStore(join(home, 'state.db'))
  factory = startFactory()
  // Let the existing startup recovery pass see the empty migrated table.
  await new Promise((resolve) => setTimeout(resolve, 20))
})

afterEach(async () => {
  for (const release of releases) release()
  await vi.waitFor(() => expect(activeRoles).toBe(0), { timeout: WAIT })
  // Execution commits and card edits finish immediately after the role returns.
  await vi.waitFor(() => expect(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM factory_tasks WHERE status IN ('running', 'queued')",
  ).get() as { count: number }).count)).toBe(0), { timeout: WAIT })
  await new Promise((resolve) => setTimeout(resolve, 30))
  store.close()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

vi.setConfig({ testTimeout: 40_000, hookTimeout: 20_000 })

test('test_c1_low_risk_autoaccept_merges_cleans_up_and_sends_one_short_summary', async () => {
  const id = await execute()
  await merged(id)
  assertLocalResult()
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(FIXED)
  await vi.waitFor(() => expect(sent()).toHaveLength(1), { timeout: WAIT })
  const summary = text(sent()[0]!)
  expect(summary).toContain(`#${id}`)
  expect(summary).toContain('Исправить значение value')
  expect(summary).toMatch(/2\s*файл|файлов?\s*:\s*2/i)
  expect(summary).toMatch(/локально\s+в\s+[«"']?main/i)
  expect(summary.length, 'the autoaccept notice is short').toBeLessThan(700)
  expect(acceptanceCards()).toHaveLength(0)
})

test.each([
  { risk: 'high' as const, auto: true },
  { risk: 'high' as const, auto: false },
  { risk: 'low' as const, auto: false },
])('test_c2_manual_acceptance_for_%j_has_one_rich_diff_card', async (options) => {
  const base = git(project, 'rev-parse', 'main')
  const id = await execute(options)
  const card = await acceptanceCard()
  expect(task(id).status).toBe('awaiting_human')
  expect(git(project, 'rev-parse', 'main')).toBe(base)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
  expect(sent()).toHaveLength(1)
  expect(card.method).toBe('sendRichMessage')
  expect(typeof object(card.params.rich_message).markdown).toBe('string')
  const body = text(card)
  expect(body).toContain('Исправить значение value')
  for (const [file, added, removed] of [[SOURCE, 1, 1], [TEST, 4, 0]] as const) {
    assertCounts(body, file, added, removed)
  }
  const total = body.split('\n').find((line) => /итого|всего|общий|размер|total/i.test(line))
  expect(total, 'card states the total diff size').toBeDefined()
  const lineCounts = /\+\s*5\b/.test(total!) && /[-−]\s*1\b/.test(total!)
  const totalLines = /6\s*(?:строк|lines)|(?:строк|lines)\s*:\s*6\b/i.test(total!)
  const bytes = /[1-9]\d*(?:[.,]\d+)?\s*(?:байт|[км]и?б|bytes?|[km]i?b)(?:\s|$|[.,)])/i.test(total!)
  expect(lineCounts || totalLines || bytes, 'total is five added and one deleted line, six changed lines, or a nonzero byte size').toBe(true)
  button(card, 'Принять')
  button(card, 'Вернуть')
  expect(existsSync(taskWorktree(id))).toBe(true)
})

test('test_c3_accept_edits_the_existing_card_to_merged_without_new_cards', async () => {
  const id = await execute({ risk: 'high' })
  const card = await acceptanceCard()
  const mark = calls.length
  await click(card, 'Принять')
  await merged(id)
  assertLocalResult()
  await vi.waitFor(() => expect(text(latestCard(card))).toMatch(/влито/i), { timeout: WAIT })
  expect(latestCard(card).params.message_id).toBe(card.id)
  expect(buttons(latestCard(card))).toHaveLength(0)
  expect(sent(mark), 'acceptance updates its original message').toHaveLength(0)
})

test('test_c4_return_routes_the_next_remark_to_executor_and_restarts_three_rounds_preserving_commit_and_tests', async () => {
  let reviews = 0
  roleScript = async (turn) => {
    if (turn.role === 'reviewer' && ++reviews % 3 !== 0) {
      return JSON.stringify({ verdict: 'reject', approved: false, summary: 'ещё круг', issues: ['Уточнить поведение'] })
    }
    return happy(turn)
  }
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  const worktree = taskWorktree(id)
  const acceptedCommit = git(worktree, 'rev-parse', 'HEAD')
  const firstExecutors = turns.filter(({ turn }) => turn.role === 'executor')
  expect(firstExecutors.map((entry) => entry.round)).toEqual([1, 2, 3])
  const remark = 'OWNER-ACCEPTANCE-REMARK: добавь пояснение для значения два'
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  releases.push(() => release())
  roleScript = async (turn) => {
    if (turn.role === 'executor') {
      await held
      await write(turn, SOURCE, `${FIXED}// owner remark addressed\n`)
      return 'замечание исправлено'
    }
    if (turn.role === 'reviewer' && ++reviews % 3 !== 0) {
      return JSON.stringify({ verdict: 'reject', approved: false, summary: 'ещё круг', issues: ['Уточнить поведение'] })
    }
    return happy(turn)
  }
  const mark = calls.length
  await click(card, 'Вернуть')
  expect(factory.waitingForInput(OWNER)).toBe(true)
  expect(calls.slice(mark).some((call) => /текст|пришлите|введите|напишите|отправьте/i.test(text(call)) && /замечан/i.test(text(call)))).toBe(true)
  expect(await factory.takeInput(OWNER, remark)).toBe(true)
  await vi.waitFor(() => expect(turns.filter(({ turn }) => turn.role === 'executor')).toHaveLength(4), { timeout: WAIT })
  const resumed = turns.filter(({ turn }) => turn.role === 'executor')[3]!
  expect(resumed.turn.prompt).toContain(remark)
  expect(resumed.turn.cwd).toBe(worktree)
  expect(resumed.head, 'return preserves the previous factory commit').toBe(acceptedCommit)
  expect(resumed.tests).toBe(RED)
  expect(resumed.round).toBe(1)
  expect(turns.filter(({ turn }) => turn.role === 'test_writer')).toHaveLength(1)
  expect(text(latestCard(card))).toMatch(/исполнени[ея]/i)
  expect(text(latestCard(card))).toMatch(/круг\s+1\s+из\s+3/i)
  release()
  await vi.waitFor(() => expect(reviews).toBe(6), { timeout: WAIT })
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.filter(({ turn }) => turn.role === 'executor').slice(3).map((entry) => entry.round)).toEqual([1, 2, 3])
  expect(git(worktree, 'rev-list', '--count', `${acceptedCommit}..HEAD`)).toBe('1')
  expect(readFileSync(join(worktree, TEST), 'utf8')).toBe(RED)
  await vi.waitFor(() => {
    const ready = [...acceptanceCards(mark), latestCard(card)]
    expect(ready.some((entry) => buttons(entry).some((key) => String(key.text).includes('Принять')))).toBe(true)
  }, { timeout: WAIT })
})

test.each([GITHUB, 'git@github.com:acme/widget.git'])(
  'test_c5_github_origin_%s_pushes_creates_pr_and_merges_with_rebase', async (url) => {
    github(url)
    const id = await execute()
    await merged(id)
    expect(prs()).toHaveLength(1)
    expect(prs()[0]).toMatchObject({ headRefName: `factory/${id}`, baseRefName: 'main', state: 'MERGED' })
    expect(cliCalls('git', 'push').some((entry) => entry.args.includes('origin') && !entry.failed)).toBe(true)
    expect(cliCalls('gh', 'auth status').length).toBeGreaterThan(0)
    expect(cliCalls('gh', 'create')).toHaveLength(1)
    expect(cliCalls('gh', 'merge')).toHaveLength(1)
    expect(cliCalls('gh', 'merge')[0]!.args).toContain('--rebase')
    expect(git(origin, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
    expect(git(project, 'for-each-ref', '--format=%(refname)', `refs/heads/factory/${id}`)).toBe('')
    await vi.waitFor(() => expect(sent().some((call) => text(call).includes(PR_URL))).toBe(true), { timeout: WAIT })
    expect(sent()).toHaveLength(1)
  },
)

test.each([
  { branch: 'main', fallback: 'no-origin' },
  { branch: 'master', fallback: 'no-main' },
  { branch: 'release', fallback: 'origin-head' },
  { branch: 'main', fallback: 'gh-missing' },
  { branch: 'main', fallback: 'gh-logged-out' },
  { branch: 'main', fallback: 'non-github' },
])('test_c6_local_%j_rebases_and_fast_forwards_the_clean_owner_copy', async ({ branch, fallback }) => {
  if (fallback.startsWith('gh-')) github()
  if (fallback === 'gh-missing') rmSync(join(bin, 'gh'))
  if (fallback === 'gh-logged-out') fail('auth status', 'not logged into github.com')
  if (branch !== 'main') git(project, 'branch', '-m', 'main', branch)
  if (fallback === 'origin-head') {
    git(project, 'branch', 'main')
    git(root, 'init', '-q', '--bare', '-b', 'release', origin)
    git(project, 'push', '-q', origin, 'release', 'main')
    git(project, 'remote', 'add', 'origin', origin)
    git(project, 'fetch', '-q', 'origin')
    git(project, 'remote', 'set-head', 'origin', 'release')
  }
  if (fallback === 'non-github') github('https://notgithub.com/acme/widget.git')
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  // The owner advances the base after the task committed. Simply moving main
  // to the task tip would discard this independent commit.
  put(join(project, 'owner-added.md'), 'independent owner commit\n')
  git(project, 'add', 'owner-added.md')
  git(project, 'commit', '-q', '-m', 'owner advanced base')
  const advanced = git(project, 'rev-parse', branch)
  await click(card, 'Принять')
  await merged(id)
  assertLocalResult(branch)
  expect(git(project, 'rev-parse', `${branch}^`)).toBe(advanced)
  expect(git(project, 'rev-list', '--parents', '-1', branch).split(' ')).toHaveLength(2)
  expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe(branch)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(FIXED)
  expect(readFileSync(join(project, TEST), 'utf8')).toBe(RED)
  expect(readFileSync(join(project, 'owner-added.md'), 'utf8')).toBe('independent owner commit\n')
  expect(cliCalls('gh', 'create')).toHaveLength(0)
  expect(cliCalls('gh', 'merge')).toHaveLength(0)
})

test.each(['unstaged', 'staged', 'untracked'])(
  'test_c7_%s_owner_changes_on_task_paths_block_merge_without_touching_owner_files', async (kind) => {
    const id = await execute({ auto: false })
    const card = await acceptanceCard()
    const head = git(project, 'rev-parse', 'main')
    const ownerFile = kind === 'untracked' ? TEST : SOURCE
    const ownerText = 'OWNER-UNCOMMITTED-CANARY\n'
    put(join(project, ownerFile), ownerText)
    if (kind === 'staged') git(project, 'add', SOURCE)
    const mark = calls.length
    await click(card, 'Принять')
    const changes = /незакоммичен|незафиксирован|изменени|неотслежива|не\s*чист|uncommitted|untracked|dirty/i
    await vi.waitFor(() => {
      expect(task(id).execution_note).toMatch(changes)
      expect(task(id).execution_note).toMatch(/рабоч|working/i)
      expect(text(latestCard(card))).toMatch(changes)
      expect(text(latestCard(card))).toMatch(/рабоч|working/i)
    }, { timeout: WAIT })
    expect(task(id).status).toBe('awaiting_human')
    expect(git(project, 'rev-parse', 'main')).toBe(head)
    expect(readFileSync(join(project, ownerFile), 'utf8')).toBe(ownerText)
    expect(git(project, 'show', `:${SOURCE}`)).toBe(kind === 'staged' ? ownerText.trim() : BASE.trim())
    expect(existsSync(taskWorktree(id))).toBe(true)
    button(latestCard(card), 'Принять')
    expect(sent(mark)).toHaveLength(0)
  },
)

test.each(['rebase', 'push', 'create', 'merge'])(
  'test_c8_%s_failure_keeps_local_main_task_branch_and_retry_button', async (stage) => {
    if (stage !== 'rebase') github()
    const id = await execute({ auto: false })
    const card = await acceptanceCard()
    if (stage === 'rebase') {
      put(join(project, SOURCE), 'export function value() { return 99 }\n')
      git(project, 'add', SOURCE)
      git(project, 'commit', '-q', '-m', 'owner conflicting change')
    } else fail(stage, `ACCEPTANCE-${stage.toUpperCase()}-FAILURE: transport unavailable`)
    const main = git(project, 'rev-parse', 'main')
    const source = readFileSync(join(project, SOURCE), 'utf8')
    const mark = calls.length
    await click(card, 'Принять')
    const reason = stage === 'rebase' ? /src\/value\.mjs/ : new RegExp(`ACCEPTANCE-${stage.toUpperCase()}-FAILURE`)
    await vi.waitFor(() => expect(task(id).execution_note, 'failure reason is saved on the task').toMatch(reason), { timeout: WAIT })
    expect(text(latestCard(card))).toMatch(reason)
    expect(task(id).status).toBe('awaiting_human')
    expect(git(project, 'rev-parse', 'main')).toBe(main)
    expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(source)
    expect(existsSync(taskWorktree(id))).toBe(true)
    expect(git(project, 'for-each-ref', '--format=%(refname)', `refs/heads/factory/${id}`)).toBe(`refs/heads/factory/${id}`)
    button(latestCard(card), 'Принять')
    expect(sent(mark)).toHaveLength(0)
  },
)

test('test_c9_retry_after_failed_github_merge_reuses_the_existing_pr', async () => {
  github()
  const id = await execute({ auto: false })
  const card = await acceptanceCard()
  fail('merge', 'RETRY-MERGE-FAILURE')
  await click(card, 'Принять')
  await vi.waitFor(() => expect(text(latestCard(card))).toContain('RETRY-MERGE-FAILURE'), { timeout: WAIT })
  expect(task(id).status).toBe('awaiting_human')
  expect(prs()).toHaveLength(1)
  expect(prs()[0]!.state).toBe('OPEN')
  button(latestCard(card), 'Принять')
  fail()
  await click(latestCard(card), 'Принять')
  await merged(id)
  expect(prs()).toHaveLength(1)
  expect(prs()[0]!.state).toBe('MERGED')
  expect(cliCalls('gh', 'merge')).toHaveLength(2)
  expect(git(origin, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
  expect(text(latestCard(card))).toContain(PR_URL)
  expect(text(latestCard(card))).toMatch(/влито/i)
  expect(buttons(latestCard(card))).toHaveLength(0)
  expect(sent()).toHaveLength(1)
})

test('test_c10_merging_the_bot_repository_preserves_running_code_and_explains_update', async () => {
  project = join(home, 'app')
  // This is the deployment shape used by evolve: live is running while main
  // receives changes for a subsequent /update.
  git(project, 'checkout', '-q', '-b', 'live')
  const live = git(project, 'rev-parse', 'HEAD')
  const id = await execute({ own: true })
  await merged(id)
  assertLocalResult()
  expect(git(project, 'rev-parse', 'HEAD')).toBe(live)
  expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('live')
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
  expect(existsSync(join(project, TEST))).toBe(false)
  await vi.waitFor(() => expect(sent()).toHaveLength(1), { timeout: WAIT })
  expect(text(sent()[0]!)).toContain('/update')
})

test('test_c11_accept_and_return_callbacks_from_old_cards_survive_store_and_factory_restart', async () => {
  const first = await execute({ risk: 'high', title: 'Первая приёмка' })
  const firstCard = await acceptanceCard()
  const mark = calls.length
  const second = await execute({ risk: 'high', title: 'Вторая приёмка' })
  const secondCard = await acceptanceCard(mark)
  const firstPath = taskWorktree(first)
  const secondPath = taskWorktree(second)
  // As in execution-recovery.test.ts, reconstruct the factory after all work
  // settled. Reopen SQLite too: no old in-memory card binding can help it.
  await new Promise((resolve) => setTimeout(resolve, 30))
  store.close()
  store = openStore(join(home, 'state.db'))
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(task(first).status).toBe('awaiting_human')
  expect(task(second).status).toBe('awaiting_human')
  expect(existsSync(firstPath)).toBe(true)
  expect(existsSync(secondPath)).toBe(true)
  await click(firstCard, 'Принять')
  await merged(first)
  expect(text(latestCard(firstCard))).toMatch(/влито/i)
  const before = turns.length
  roleScript = async (turn) => {
    if (turn.role === 'executor') {
      await write(turn, SOURCE, `${FIXED}// clarified after owner remark\n`)
      return 'замечание исправлено'
    }
    return happy(turn)
  }
  await click(secondCard, 'Вернуть')
  expect(factory.waitingForInput(OWNER)).toBe(true)
  const remark = 'AFTER-RESTART-OWNER-REMARK: поясни результат'
  expect(await factory.takeInput(OWNER, remark)).toBe(true)
  await vi.waitFor(() => expect(turns.slice(before).some(({ turn }) =>
    turn.role === 'executor' && turn.prompt.includes(remark))).toBe(true), { timeout: WAIT })
  await vi.waitFor(() => expect(task(second).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.slice(before).some(({ turn }) => turn.role === 'reviewer')).toBe(true)
  expect(gates.at(-1)?.ok).toBe(true)
  expect(turns.slice(before).find(({ turn }) => turn.role === 'executor')?.turn.cwd).toBe(secondPath)
  expect(turns.slice(before).filter(({ turn }) => turn.role === 'test_writer')).toHaveLength(0)
})
