// Acceptance contracts through the same createFactory / SQLite / real temporary
// repositories fixture as execution-recovery.test.ts. Only roles, the project
// gate and the GitHub CLI boundary are doubles. No project command or network
// request is executed. Every git assertion refers to these disposable fixtures.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SandboxOptions, SandboxResult } from '../evolve/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { markdownToPlain } from '../telegram/src/rich/index.js'
import { createFactory, type Factory, type FactoryRoleTurn, type FactoryOptions } from './src/index.js'
import * as engineering from './src/engineering.js'

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
let analysisRisk: 'low' | 'high'
let failFinalNotice: boolean
let onOwnMerged = vi.fn<(event: { taskId: number }) => void>()
let commandRuntime: FactoryOptions['commandRuntime']
let candidateGates: Array<'live' | 'candidate' | undefined>
let gateOptions: SandboxOptions[]
let gateCheck: (() => void) | undefined
let gateResult: ((options: SandboxOptions) => SandboxResult) | undefined
let analysisPrefixes: string[]

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
  return calls.slice(mark).filter((call) => ['Принять', 'Вернуть'].every((label) =>
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
  gateCheck?.()
  gateOptions.push(options)
  candidateGates.push(options.modules)
  if (gateResult !== undefined) {
    const result = gateResult(options)
    gates.push(result)
    return result
  }
  const fixed = readFileSync(join(options.candidate, SOURCE), 'utf8').includes('return 2')
  const result = fixed ? { ok: true, status: 0, output: 'ok' }
    : { ok: false, status: 1, output: 'AssertionError: actual 1 expected 2' }
  gates.push(result)
  return result
}

function startFactory(): Factory {
  const api: TelegramApi = {
    async call<T>(method: string, params: Json = {}): Promise<T> {
      if (failFinalNotice && String(object(params.rich_message).markdown ?? params.text ?? '').includes('влито')) {
        throw new Error('fixture Telegram delivery unavailable')
      }
      const id = method.startsWith('send') ? ++messageId : Number(params.message_id ?? 0)
      calls.push({ method, params, id })
      return { message_id: id, chat: { id: params.chat_id } } as T
    },
  }
  return createFactory({
    store, home, onOwnMerged, appRoot: join(home, 'app'), api, ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'fixture', id: 'model', name: 'Model' }],
    ownerHome: join(root, 'owner-home'), sandbox,
    ...(commandRuntime === undefined ? {} : { commandRuntime }),
    analysis: async (turn) => {
      analysisPrefixes.push(turn.systemPrefix)
      return JSON.stringify({ criteria: ['value() возвращает 2.'], footprint: [SOURCE], risk: analysisRisk })
    },
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

async function execute(options: { risk?: 'low' | 'high'; auto?: boolean; own?: boolean; title?: string; footprint?: string[] } = {}): Promise<number> {
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
      JSON.stringify(options.footprint ?? [SOURCE]), options.risk ?? 'low') as { id: number }
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
  const path = task(id).worktree
  expect(path, 'task has a recorded worktree').toBeTruthy()
  return path!
}

async function merged(id: number): Promise<void> {
  await vi.waitFor(() => expect(task(id).status).toBe('merged'), { timeout: WAIT })
  await vi.waitFor(() => expect(existsSync(taskWorktree(id)), 'merged task worktree is removed').toBe(false), { timeout: WAIT })
  await vi.waitFor(() => expect(git(project, 'for-each-ref', '--format=%(refname)', `refs/heads/factory/${id}`)).toBe(''), { timeout: WAIT })
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
  put(join(root, 'merge-policy.json'), JSON.stringify({ mergeCommitAllowed: true, rebaseMergeAllowed: true, squashMergeAllowed: true }))
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
  const repo = { nameWithOwner: 'acme/widget', defaultBranchRef: { name: 'main' }, url: 'https://github.com/acme/widget',
    ...JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'merge-policy.json'))}, 'utf8')) }
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
  output({ ...pr, headRefOid: git(${JSON.stringify(origin)}, 'rev-parse', 'refs/heads/' + pr.headRefName) })
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
  if (fs.existsSync(${JSON.stringify(join(root, 'queued-merge'))})) process.exit(0)
  if (fs.existsSync(${JSON.stringify(join(root, 'merge-delay'))})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
  }
  const remote = ${JSON.stringify(origin)}
  const sha = git(remote, 'rev-parse', 'refs/heads/' + pr.headRefName)
  git(remote, 'update-ref', 'refs/heads/' + pr.baseRefName, sha)
  pr.state = 'MERGED'; pr.mergedAt = new Date().toISOString(); save()
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
  analysisRisk = 'low'
  failFinalNotice = false
  onOwnMerged = vi.fn()
  commandRuntime = undefined
  candidateGates = []
  gateOptions = []
  gateCheck = undefined
  gateResult = undefined
  analysisPrefixes = []
  vi.spyOn(engineering, 'createEngineeringGitView').mockResolvedValue(undefined)
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
  await vi.waitFor(() => expect(Number((store.db.prepare(
    "SELECT COUNT(*) AS count FROM factory_tasks WHERE status IN ('running', 'queued')",
  ).get() as { count: number }).count)).toBe(0), { timeout: WAIT })
  await vi.waitFor(() => {
    const rows = store.db.prepare('SELECT id, status, worktree, acceptance_message_id FROM factory_tasks').all() as
      Array<{ id: number; status: string; worktree: string | null; acceptance_message_id: number | null }>
    for (const row of rows) {
      if (row.status === 'merged' && !failFinalNotice) {
        expect(calls.some((call) => text(call).includes(`#${row.id} `) && /влито/.test(text(call)))).toBe(true)
      } else if (row.status === 'awaiting_human' && row.worktree !== null) expect(row.acceptance_message_id).not.toBeNull()
    }
  }, { timeout: WAIT })
  store.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

vi.setConfig({ testTimeout: 40_000, hookTimeout: 20_000 })

test('autopilot is owner-only, opt-in, persistent, and runs low risk through merge with autoaccept disabled', async () => {
  expect(store.kv.get('factory.autopilot')).not.toBe('1')
  expect(await factory.handleCallback({ id: 'outsider', chatId: OWNER, fromId: OWNER + 1, messageId: 1, data: 'f1:ap' })).toBe(true)
  expect(store.kv.get('factory.autopilot')).not.toBe('1')
  await press('f1:ap')
  expect(store.kv.get('factory.autopilot')).toBe('1')
  store.kv.set('factory.autoaccept', '0')
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  // The own checkout cannot be changed while running: give it another base copy.
  git(join(home, 'app'), 'checkout', '-q', '-b', 'live')
  const created = factory.createTask({ text: 'Исправить значение value' })
  for (const role of ['test_writer', 'executor', 'reviewer']) {
    await vi.waitFor(() => expect(
      turns.some((entry) => entry.taskId === created.id && entry.turn.role === role),
      `${role} progress: ${JSON.stringify(task(created.id))}`,
    ).toBe(true), { timeout: WAIT })
  }
  await vi.waitFor(() => {
    const current = task(created.id)
    expect(current.status, `autopilot completion: ${JSON.stringify(current)}`).toBe('merged')
  }, { timeout: WAIT })
  expect(turns.map(({ turn }) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(git(join(home, 'app'), 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
  await press(`f1:aa:${created.id}`)
  expect(task(created.id).status).toBe('merged')
  expect(turns).toHaveLength(3)
  expect(onOwnMerged).not.toHaveBeenCalled()
})

test('autopilot leaves high risk analysis for the owner', async () => {
  await press('f1:ap')
  analysisRisk = 'high'
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  expect(turns).toHaveLength(0)
})

test.each(['fresh', 'restart'])('queued autopilot tasks after %s wait for acceptance and use the previous merged base', async (mode) => {
  project = join(home, 'app')
  github()
  git(project, 'checkout', '-q', '-b', 'live')
  put(join(project, 'live-only.md'), 'live checkout is ahead of the canonical base\n')
  git(project, 'add', 'live-only.md')
  git(project, 'commit', '-q', '-m', 'running checkout diverges from origin main')
  const live = git(project, 'rev-parse', 'HEAD')
  const canonical = git(origin, 'rev-parse', 'main')
  put(join(root, 'merge-delay'), '')
  const desired = () => turns.at(-1)?.turn.systemPrefix.includes('Second queued task') ? 3 : 2
  gateResult = (options) => {
    const ok = readFileSync(join(options.candidate, SOURCE), 'utf8').includes(`return ${desired()}`)
    return { ok, status: ok ? 0 : 1, output: ok ? 'ok' : 'value assertion failed' }
  }
  roleScript = async (turn) => {
    const value = turn.systemPrefix.includes('Second queued task') ? 3 : 2
    if (turn.role === 'test_writer') {
      await write(turn, TEST, RED.replace('value(), 2', `value(), ${value}`))
      return JSON.stringify({ tests: [TEST] })
    }
    if (turn.role === 'executor') {
      await write(turn, SOURCE, `export function value() { return ${value} }\n`)
      return 'done'
    }
    return happy(turn)
  }
  let first: { id: number }
  let second: { id: number }
  if (mode === 'fresh') {
    await press('f1:ap')
    store.kv.set('factory.autoaccept', '0')
    first = factory.createTask({ title: 'First queued task', text: 'Return 2' })
    second = factory.createTask({ title: 'Second queued task', text: 'Return 3' })
  } else {
    first = { id: await execute({ own: true, auto: false, title: 'First queued task' }) }
    second = store.db.prepare(`INSERT INTO factory_tasks
      (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
      VALUES ('Second queued task', 'Return 3', 'awaiting_approval', 0, 'bot', ?, ?, ?, ?, 'low') RETURNING id`)
      .get(project, Date.now(), JSON.stringify(['value returns 3']), JSON.stringify([SOURCE])) as { id: number }
    store.kv.set('factory.autopilot', '1')
    factory = startFactory()
  }
  await merged(first.id)
  await merged(second.id)
  const secondWriter = turns.find(({ turn, taskId }) => taskId === second.id && turn.role === 'test_writer')!
  expect(turns.find(({ turn }) => turn.role === 'test_writer')!.head).toBe(canonical)
  expect(git(project, 'rev-parse', 'HEAD')).toBe(live)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
  expect(secondWriter.head).toBe(git(origin, 'rev-parse', `refs/heads/factory/${first.id}`))
  expect(git(origin, 'show', `main:${SOURCE}`)).toBe('export function value() { return 3 }')
})

test('successful merge remains merged when the final Telegram edit fails', async () => {
  const id = await readyResult()
  const card = await acceptanceCard()
  failFinalNotice = true
  await click(card, 'Принять')
  await merged(id)
  expect(task(id).execution_note).toBeNull()
  assertLocalResult()
})

test('autopilot resumes only a successful ready result after restart', async () => {
  const id = await readyResult()
  const failed = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk, execution_note)
    VALUES ('failed', 'failed', 'awaiting_human', 0, 'widget', ?, ?, '[]', '[]', 'low', 'Гейт не пройден') RETURNING id`)
    .get(project, Date.now()) as { id: number }
  store.kv.set('factory.autopilot', '1')
  factory = startFactory()
  await merged(id)
  expect(task(failed.id).status).toBe('awaiting_human')
  expect(turns).toHaveLength(0)
})

test('autopilot never sends a failed gate to reviewer or advertises a ready result', async () => {
  await press('f1:ap')
  roleScript = async (turn) => turn.role === 'executor' ? 'No change' : happy(turn)
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(turns.filter(({ turn }) => turn.role === 'executor')).toHaveLength(3)
  expect(task(created.id).execution_note).toContain('Гейт не пройден')
  const card = sent().at(-1)!
  expect(text(card)).toMatch(/остановлен|не завершен|не завершён/i)
  expect(text(card)).not.toMatch(/без изменений относительно базы/)
  expect(buttons(card).some((entry) => String(entry.text).includes('Принять'))).toBe(false)
})

test('acceptance refuses to rebase onto a base that changed after the gate', async () => {
  const id = await readyResult()
  const card = await acceptanceCard()
  put(join(project, 'notes.md'), 'independent owner commit\n')
  git(project, 'add', 'notes.md')
  git(project, 'commit', '-q', '-m', 'owner change')
  const ownerHead = git(project, 'rev-parse', 'HEAD')
  await click(card, 'Принять')
  await vi.waitFor(() => expect(task(id).execution_note).toMatch(/баз|повтор/i), { timeout: WAIT })
  expect(task(id).status).toBe('awaiting_human')
  expect(git(project, 'rev-parse', 'HEAD')).toBe(ownerHead)
  expect(existsSync(taskWorktree(id))).toBe(true)
})

test('a queued GitHub merge is not a merge receipt and retains the task worktree', async () => {
  project = join(home, 'app')
  github()
  put(join(root, 'queued-merge'), '')
  const id = await readyResult()
  await press(`ac:${id}`)
  await vi.waitFor(() => expect(task(id).execution_note).toMatch(/подтверд|merged|влит/i), { timeout: WAIT })
  expect(task(id).status).toBe('awaiting_human')
  expect(existsSync(taskWorktree(id))).toBe(true)
  expect(onOwnMerged).not.toHaveBeenCalled()
  expect(git(project, 'show-ref', '--verify', `refs/heads/factory/${id}`)).toContain(`refs/heads/factory/${id}`)
  const live = git(project, 'rev-parse', 'HEAD')
  let observed: { status: string; exists: boolean; notice: boolean } | undefined
  onOwnMerged.mockImplementation(() => {
    observed = { status: task(id).status, exists: existsSync(taskWorktree(id)), notice: calls.some((call) => text(call).includes('влито')) }
    throw new Error('fixture adoption queue unavailable')
  })
  rmSync(join(root, 'queued-merge'))
  await press(`ac:${id}`)
  await merged(id)
  await vi.waitFor(() => expect(onOwnMerged).toHaveBeenCalledExactlyOnceWith({ taskId: id }), { timeout: WAIT })
  expect(observed).toEqual({ status: 'merged', exists: false, notice: true })
  expect(prs()).toHaveLength(1)
  expect(prs()[0]!.state).toBe('MERGED')
  expect(cliCalls('gh', 'create')).toHaveLength(1)
  expect(git(project, 'rev-parse', 'HEAD')).toBe(live)
})

test.each([
  { squashMergeAllowed: true, rebaseMergeAllowed: true, method: '--squash' },
  { squashMergeAllowed: false, rebaseMergeAllowed: true, method: '--rebase' },
])('GitHub acceptance respects the allowed fallback $method', async ({ method, ...policy }) => {
  github()
  put(join(root, 'merge-policy.json'), JSON.stringify({ mergeCommitAllowed: false, ...policy }))
  const id = await readyResult()
  await press(`ac:${id}`)
  await merged(id)
  const args = cliCalls('gh', 'merge')[0]!.args
  expect(args).toContain(method)
  expect(args[args.indexOf('--match-head-commit') + 1]).toBe(git(origin, 'rev-parse', `refs/heads/factory/${id}`))
})

test('GitHub acceptance stops when the repository allows no merge method', async () => {
  github()
  put(join(root, 'merge-policy.json'), JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false }))
  const id = await readyResult()
  await press(`ac:${id}`)
  await vi.waitFor(() => expect(task(id).execution_note).toContain('не разрешает'), { timeout: WAIT })
  expect(cliCalls('gh', 'merge')).toHaveLength(0)
  expect(existsSync(taskWorktree(id))).toBe(true)
})

test('confined execution exposes commands only to writers and executors, installs changed deps, and stops before the gate', async () => {
  vi.mocked(engineering.createEngineeringGitView).mockRestore()
  put(join(project, 'package.json'), '{"name":"fixture"}\n')
  put(join(project, 'package-lock.json'), '{}\n')
  git(project, 'add', 'package.json', 'package-lock.json')
  git(project, 'commit', '-q', '-m', 'locked dependency fixture')
  let active = false
  gateCheck = () => expect(active).toBe(false)
  const commands: string[] = []
  commandRuntime = async (request) => {
    expect(active).toBe(false)
    active = true
    return {
      tools: [{ name: 'exec', description: 'confined command', inputSchema: { type: 'object' },
        execute: async () => 'confined output' }],
      run: async (command) => {
        expect(request.prepareDependencies).toBe(false)
        commands.push(command)
        return { ok: true, output: 'installed' }
      },
      stop: async () => { active = false },
    }
  }
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  roleScript = async (turn) => {
    expect(active).toBe(turn.role !== 'reviewer')
    expect(turn.tools.some((tool) => tool.name === 'exec')).toBe(turn.role !== 'reviewer')
    if (turn.role === 'executor') {
      await write(turn, 'package.json', '{"name":"changed"}\n')
    }
    return happy(turn)
  }
  // Package changes are inside the approved candidate scope.
  const projectId = Number((store.db.prepare('INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const id = Number((store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES ('deps', 'deps', 'awaiting_approval', ?, 'widget', ?, ?, ?, ?, 'low') RETURNING id`)
    .get(projectId, project, Date.now(), JSON.stringify(['value returns 2']), JSON.stringify([SOURCE, 'package.json'])) as { id: number }).id)
  store.kv.set('factory.autoaccept', '0')
  await press(`f1:aa:${id}`)
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.map(({ turn }) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(commands).toEqual(['npm ci --ignore-scripts', 'npm ci --ignore-scripts'])
  expect(active).toBe(false)
  expect(candidateGates).toEqual(['candidate', 'candidate'])
  for (const options of gateOptions) {
    expect(options.toolsDir).toBe(`${options.candidate}.tools`)
    expect(options.hiddenPaths).toContain(join(options.candidate, '.git'))
    expect(options.gitView).toBeDefined()
    expect(existsSync(options.gitView!.directory)).toBe(false)
  }
})

test('a failed confined dependency installation stops before gate success or reviewer', async () => {
  const app = join(home, 'app')
  put(join(app, 'package.json'), '{"name":"fixture"}\n')
  put(join(app, 'package-lock.json'), '{}\n')
  git(app, 'add', 'package.json', 'package-lock.json')
  git(app, 'commit', '-q', '-m', 'locked dependency fixture')
  let stopped = 0
  commandRuntime = async () => ({ tools: [], run: async () => ({ ok: false, output: 'fixture install rejected' }),
    stop: async () => { stopped++ } })
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(task(created.id).execution_note).toContain('fixture install rejected')
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(turns.filter(({ turn }) => turn.role === 'executor')).toHaveLength(0)
  expect(stopped).toBe(2)
  expect(gates).toHaveLength(0)
})

test('confined tasks cannot replace trusted gate scripts with a false green command', async () => {
  const app = join(home, 'app')
  put(join(app, 'package.json'), JSON.stringify({ scripts: { gate: 'npm test', test: 'node --test' } }))
  git(app, 'add', 'package.json')
  git(app, 'commit', '-q', '-m', 'trusted gate definition')
  commandRuntime = async () => ({ tools: [], run: async () => ({ ok: true, output: '' }), stop: async () => undefined })
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  roleScript = async (turn) => {
    if (turn.role === 'executor') {
      await write(turn, 'package.json', JSON.stringify({ scripts: { gate: 'true', test: 'true' } }))
    }
    return happy(turn)
  }
  const created = factory.createTask({ text: 'Fix value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  store.db.prepare('UPDATE factory_tasks SET footprint = ? WHERE id = ?').run(JSON.stringify(['.']), created.id)
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(task(created.id).execution_note).toMatch(/gate.definition drift/i)
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(gates).toHaveLength(1)
})

test('a tainted candidate test runner is replaced before every confined gate', async () => {
  const app = join(home, 'app')
  put(join(app, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  put(join(app, 'package-lock.json'), '{}\n')
  put(join(app, '.gitignore'), 'node_modules/\n')
  git(app, 'add', 'package.json', 'package-lock.json', '.gitignore')
  git(app, 'commit', '-q', '-m', 'locked runner fixture')
  const installs: string[] = []
  commandRuntime = async ({ worktree }) => {
    const runner = join(worktree, 'node_modules/.bin/test-runner')
    if (!existsSync(runner)) put(runner, 'trusted runner\n')
    return {
      tools: [],
      run: async (command) => { installs.push(command); put(runner, 'trusted runner\n'); return { ok: true, output: 'installed' } },
      stop: async () => undefined,
    }
  }
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  roleScript = async (turn) => {
    if (turn.role === 'executor') {
      put(join(turn.cwd, 'node_modules/.bin/test-runner'), 'tainted false green\n')
      return 'done'
    }
    return happy(turn)
  }
  gateResult = (options) => {
    const tainted = readFileSync(join(options.candidate, 'node_modules/.bin/test-runner'), 'utf8').includes('tainted')
    const fixed = readFileSync(join(options.candidate, SOURCE), 'utf8') === FIXED
    return { ok: tainted || fixed, status: tainted || fixed ? 0 : 1, output: tainted || fixed ? 'ok' : 'value assertion failed' }
  }
  const created = factory.createTask({ text: 'Fix value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1), { timeout: WAIT })
  for (let round = 1; round <= 3; round++) {
    await vi.waitFor(() => expect(turns.filter(({ turn }) => turn.role === 'executor').length).toBeGreaterThanOrEqual(round), { timeout: WAIT })
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(round + 1), { timeout: WAIT })
  }
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(installs).toEqual(Array(4).fill('npm ci --ignore-scripts'))
  expect(gates.every((gate) => !gate.ok)).toBe(true)
})

test('a contained high-risk bot task prepares automatically but waits for owner promotion', async () => {
  commandRuntime = async () => ({ tools: [], run: async () => ({ ok: true, output: '' }), stop: async () => undefined })
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  analysisRisk = 'high'
  await press('f1:ap')
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.map(({ turn }) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(task(created.id).execution_note).toBe('готово к приёмке')
  expect(git(join(home, 'app'), 'show', `main:${SOURCE}`)).toBe(BASE.trim())
})

test('contained autopilot leaves an explicit host action for the owner', async () => {
  commandRuntime = async () => ({ tools: [], run: async () => ({ ok: true, output: '' }), stop: async () => undefined })
  factory = startFactory()
  await new Promise((resolve) => setTimeout(resolve, 20))
  analysisRisk = 'high'
  await press('f1:ap')
  const created = factory.createTask({ text: 'systemctl restart application' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  expect(turns).toHaveLength(0)
})

test.each([null])('autopilot recovery refuses a legacy row with invalid risk %s', async (risk) => {
  commandRuntime = async () => ({ tools: [], run: async () => ({ ok: true, output: '' }), stop: async () => undefined })
  const insert = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES ('legacy', 'Fix value', 'awaiting_approval', 0, 'bot', ?, ?, ?, ?, ?) RETURNING id`)
  const fields = [join(home, 'app'), Date.now(), JSON.stringify(['value returns 2']), JSON.stringify([SOURCE])] as const
  const invalid = insert.get(...fields, risk) as { id: number }
  const valid = insert.get(...fields, 'high') as { id: number }
  store.kv.set('factory.autopilot', '1')
  factory = startFactory()
  // A valid persisted analysis proves restart recovery ran and can prepare work.
  await vi.waitFor(() => expect(task(valid.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(task(invalid.id).status).toBe('awaiting_approval')
  expect(task(invalid.id).worktree).toBeNull()
  expect(turns.every(({ taskId }) => taskId === valid.id)).toBe(true)
})

test('writer commands cannot smuggle production edits into the task result', async () => {
  roleScript = async (turn) => {
    if (turn.role === 'test_writer') await write(turn, 'notes.md', 'unexpected production edit\n')
    return happy(turn)
  }
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.filter(({ turn }) => turn.role === 'executor')).toHaveLength(0)
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(task(created.id).execution_note).toContain('notes.md')
  expect(gates).toHaveLength(0)
})

test('private role skills reach only their own model prompt and preserve a read-only reviewer', async () => {
  const roles = ['analysis', 'test_writer', 'executor', 'reviewer'] as const
  for (const role of roles) put(join(home, 'factory/role-skills', role, 'SKILL.md'), `PRIVATE_PROFILE_${role}\n`)
  const created = factory.createTask({ text: 'Fix value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(analysisPrefixes).toHaveLength(1)
  expect(analysisPrefixes[0]).toContain('PRIVATE_PROFILE_analysis')
  const prompts = [{ role: 'analysis', prefix: analysisPrefixes[0]! }, ...turns.map(({ turn }) => ({ role: turn.role, prefix: turn.systemPrefix }))]
  for (const prompt of prompts) {
    expect(prompt.prefix).toContain(`PRIVATE_PROFILE_${prompt.role}`)
    for (const other of roles.filter((role) => role !== prompt.role)) expect(prompt.prefix).not.toContain(`PRIVATE_PROFILE_${other}`)
  }
  expect(turns.find(({ turn }) => turn.role === 'reviewer')!.turn.tools.map((tool) => tool.name)).toEqual(['read_file'])
  const profile = join(home, 'factory/role-skills/executor/SKILL.md')
  rmSync(profile)
  const outside = join(root, 'outside-profile.md')
  put(outside, 'PRIVATE_OUTSIDE_METHOD\n')
  symlinkSync(outside, profile)
  const mark = turns.length
  const invalid = factory.createTask({ text: 'Check another value' })
  await vi.waitFor(() => expect(task(invalid.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  await press(`f1:aa:${invalid.id}`)
  await vi.waitFor(() => expect(task(invalid.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(task(invalid.id).execution_note).toMatch(/профил|profile/i)
  expect(turns.slice(mark).map(({ turn }) => turn.role)).toEqual(['test_writer'])
})

test.each([
  { phase: 'executor', kind: 'private', content: 'fixture-private-setting=true\n' },
  { phase: 'gate', kind: 'private', content: 'fixture-private-setting=true\n' },
  { phase: 'executor', kind: 'public config', content: 'ignore-scripts=true\nsave-exact=true\n' },
  { phase: 'gate', kind: 'public config', content: 'ignore-scripts=true\nsave-exact=true\n' },
])('new ignored $kind files created by $phase are rejected even with a root footprint', async ({ phase, content }) => {
  const app = join(home, 'app')
  put(join(app, '.gitignore'), '.npmrc\n')
  git(app, 'add', '.gitignore')
  git(app, 'commit', '-q', '-m', 'ignore private fixture settings')
  const inject = (worktree: string) => put(join(worktree, '.npmrc'), content)
  roleScript = async (turn) => {
    if (phase === 'executor' && turn.role === 'executor') inject(turn.cwd)
    return happy(turn)
  }
  gateCheck = () => {
    const last = turns.at(-1)?.turn
    if (phase === 'gate' && last?.role === 'executor') inject(last.cwd)
  }
  const created = factory.createTask({ text: 'Исправить значение value' })
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_approval'), { timeout: WAIT })
  store.db.prepare('UPDATE factory_tasks SET footprint = ? WHERE id = ?').run(JSON.stringify(['.']), created.id)
  await press(`f1:aa:${created.id}`)
  await vi.waitFor(() => expect(task(created.id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(task(created.id).execution_note).toContain('.npmrc')
  expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(0)
  expect(existsSync(join(taskWorktree(created.id), '.npmrc'))).toBe(false)
  expect(task(created.id).status).not.toBe('merged')
})

async function readyResult(): Promise<number> {
  store.kv.set('factory.autoaccept', '0')
  const projectId = Number((store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?) RETURNING id',
  ).get(project, 'widget', 'node --test', Date.now()) as { id: number }).id)
  const base = git(project, 'rev-parse', 'main')
  const row = store.db.prepare(`INSERT INTO factory_tasks
    (title, body, status, project_id, project_name, project_path, created_at, criteria, footprint, risk)
    VALUES ('value', 'value returns two', 'awaiting_human', ?, 'widget', ?, ?, ?, ?, 'low') RETURNING id`)
    .get(projectId, project, Date.now(), JSON.stringify(['value returns 2']), JSON.stringify([SOURCE])) as { id: number }
  const worktree = join(home, 'factory/worktrees', `task-${row.id}-ready`)
  mkdirSync(dirname(worktree), { recursive: true })
  git(project, 'worktree', 'add', '-q', '-b', `factory/${row.id}`, worktree, base)
  put(join(worktree, SOURCE), FIXED)
  put(join(worktree, TEST), RED)
  git(worktree, 'add', SOURCE, TEST)
  git(worktree, 'commit', '-q', '-m', 'verified fixture result')
  const gitDir = realpathSync(git(worktree, 'rev-parse', '--absolute-git-dir'))
  store.db.prepare(`UPDATE factory_tasks SET worktree = ?, worktree_base = ?, result_base = ?, result_files = ?,
    result_stats = ?, worktree_identity = ?, execution_note = 'готово к приёмке', acceptance_message_id = ?, acceptance_chat_id = ? WHERE id = ?`)
    .run(worktree, base, base, JSON.stringify([SOURCE, TEST]), JSON.stringify([
      { path: SOURCE, added: 1, removed: 1 }, { path: TEST, added: 4, removed: 0 },
    ]), JSON.stringify({ gitDir, reported: gitDir, toplevel: realpathSync(worktree) }), 2000 + row.id, OWNER, row.id)
  await press(`f1:t:${row.id}`, 2000 + row.id)
  return row.id
}

test('test_c6_base_branch_open_in_another_clean_owner_worktree_moves_with_its_files', async () => {
  git(project, 'checkout', '-q', '-b', 'feature')
  const ownerMain = join(root, 'owner-main')
  git(project, 'worktree', 'add', '-q', ownerMain, 'main')
  const feature = git(project, 'rev-parse', 'feature')
  const id = await readyResult()
  await press(`ac:${id}`)
  await vi.waitFor(() => expect(task(id).status).toBe('merged'), { timeout: WAIT })
  expect(git(project, 'show', `main:${SOURCE}`)).toBe(FIXED.trim())
  expect(git(ownerMain, 'rev-parse', 'HEAD')).toBe(git(project, 'rev-parse', 'main'))
  expect(readFileSync(join(ownerMain, SOURCE), 'utf8')).toBe(FIXED)
  expect(readFileSync(join(ownerMain, TEST), 'utf8')).toBe(RED)
  expect(git(ownerMain, 'status', '--porcelain'), 'files and index follow the moved branch').toBe('')
  expect(git(project, 'rev-parse', 'feature')).toBe(feature)
  expect(readFileSync(join(project, SOURCE), 'utf8')).toBe(BASE)
})

test('test_c7_github_merge_waits_for_owner_changes_without_push_or_pr', async () => {
  github()
  const id = await readyResult()
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

test('return preserves committed custom writer tests and reviews the complete original patch without a no-op commit', async () => {
  const custom = 'checks/value-contract.mjs'
  roleScript = async (turn) => {
    if (turn.role === 'test_writer') {
      await write(turn, TEST, RED)
      await write(turn, custom, RED)
      return JSON.stringify({ tests: [TEST, custom] })
    }
    return happy(turn)
  }
  const id = await execute({ auto: false, footprint: [SOURCE, 'checks/'] })
  const card = await acceptanceCard()
  const before = factory.findTask(id)!
  const worktree = taskWorktree(id)
  const commit = git(worktree, 'rev-parse', 'HEAD')
  let attempted = false
  roleScript = async (turn) => {
    if (turn.role !== 'executor') return happy(turn)
    if (!attempted) {
      attempted = true
      put(join(turn.cwd, custom), 'process.exit(0)\n')
    }
    return 'Rechecked; no production change required'
  }
  await click(card, 'Вернуть')
  expect(await factory.takeInput(OWNER, 'Recheck the original patch')).toBe(true)
  await vi.waitFor(() => expect(turns.filter(({ turn }) => turn.role === 'reviewer')).toHaveLength(2), { timeout: WAIT })
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
  const retries = turns.filter(({ turn }) => turn.role === 'executor').slice(1)
  expect(retries).toHaveLength(2)
  expect(retries[1]!.turn.prompt).toContain(custom)
  expect(readFileSync(join(worktree, custom), 'utf8')).toBe(RED)
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(commit)
  expect(turns.filter(({ turn }) => turn.role === 'test_writer')).toHaveLength(1)
  const review = turns.filter(({ turn }) => turn.role === 'reviewer').at(-1)!.turn
  expect(review.prompt).toContain('-export function value() { return 1 }')
  expect(review.prompt).toContain('+export function value() { return 2 }')
  expect(factory.findTask(id)!.changedFiles).toEqual(before.changedFiles)
})

test('an empty failed result cannot publish through a stale accept callback and reject removes its worktree', async () => {
  const id = await readyResult()
  const worktree = taskWorktree(id)
  store.db.prepare("UPDATE factory_tasks SET result_files = '[]', result_stats = '[]', execution_note = 'Гейт не пройден' WHERE id = ?").run(id)
  const mark = cliCalls().length
  await press(`f1:t:${id}`, 2000 + id)
  const card = calls.at(-1)!
  expect(buttons(card).some((b) => String(b.text).includes('Принять'))).toBe(false)
  await press(`ac:${id}`)
  expect(task(id).status).toBe('awaiting_human')
  expect(cliCalls().slice(mark).some((c) => c.action === 'push' || c.tool === 'gh')).toBe(false)
  await press(`ar:${id}`)
  await vi.waitFor(() => expect(task(id).status).toBe('rejected'), { timeout: WAIT })
  await vi.waitFor(() => expect(existsSync(worktree)).toBe(false), { timeout: WAIT })
})

test('return after failed writer reruns the writer and red gate in the same preserved worktree', async () => {
  const id = await readyResult()
  const worktree = taskWorktree(id)
  put(join(worktree, 'writer-scratch.md'), 'keep prior work\n')
  store.db.prepare(`UPDATE factory_tasks SET writer_tests = '[]', writer_snapshot = '[]',
    result_files = NULL, execution_note = 'тесты тестописца не красные' WHERE id = ?`).run(id)
  let checks = 0
  gateResult = () => ++checks === 1
    ? { ok: false, status: 1, output: 'red writer gate' }
    : { ok: true, status: 0, output: 'green executor gate' }
  const mark = turns.length
  factory.returnTask(id, 'Write a failing behavioral test first')
  await vi.waitFor(() => expect(turns.slice(mark).some(({ turn }) => turn.role === 'reviewer')).toBe(true), { timeout: WAIT })
  await vi.waitFor(() => expect(task(id).status).toBe('awaiting_human'), { timeout: WAIT })
  expect(turns.slice(mark).map(({ turn }) => turn.role)).toEqual(['test_writer', 'executor', 'reviewer'])
  expect(turns[mark]!.turn.prompt).toContain('Write a failing behavioral test first')
  expect(checks).toBe(2)
  expect(taskWorktree(id)).toBe(worktree)
  expect(readFileSync(join(worktree, 'writer-scratch.md'), 'utf8')).toBe('keep prior work\n')
})

test('management refuses acceptance immediately while its asynchronous merge is active', async () => {
  const id = await readyResult()
  const accepting = press(`f1:ac:${id}`)
  expect(() => factory.returnTask(id, 'retry')).toThrow(/занят/)
  expect(() => factory.cancelTask(id, 'unused')).toThrow(/занят/)
  expect(() => factory.deleteTask(id, 'hide')).toThrow(/занят/)
  await accepting
  await merged(id)
})
