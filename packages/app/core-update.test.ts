// Real daemon commands and real temporary live/origin histories. The seams are the
// same as evolve-upstream/adopt-outcome-notice: Telegram and the model are local
// doubles. Only the test-running and review stages of the evolve gate are replaced;
// package management and GitHub calls use recording doubles, with no network.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Evolve, EvolveOptions, SandboxOptions } from '../evolve/src/index.js'
import type { FactoryOptions } from '../factory/src/index.js'
import type { Runner } from '../runner/src/index.js'
import { openStore } from '../store/src/index.js'
import type { TelegramUpdate } from '../telegram/src/index.js'
import type { CreatePollerOptions } from '../telegram/src/poller.js'
import { GuestRegistry } from './src/guests.js'
import { OWNER_KV_KEY, readEnvConfig, startDshbot } from './src/index.js'

const seam = vi.hoisted(() => ({
  startRunner: vi.fn<() => Promise<Runner>>(),
  sandbox: vi.fn<NonNullable<EvolveOptions['sandbox']>>(),
  reviewer: vi.fn<NonNullable<EvolveOptions['reviewer']>>(),
  handle: undefined as CreatePollerOptions['handle'] | undefined,
  evolve: undefined as Evolve | undefined,
  ownMerged: undefined as FactoryOptions['onOwnMerged'],
}))
vi.mock('../runner/src/index.js', async (original) => ({
  ...await original<typeof import('../runner/src/index.js')>(), startRunner: seam.startRunner,
}))
vi.mock('../tools-exec/src/index.js', async (original) => ({
  ...await original<typeof import('../tools-exec/src/index.js')>(),
  createExecTools: async () => ({ tools: [], stop: async () => undefined }),
}))
vi.mock('../telegram/src/index.js', async (original) => ({
  ...await original<typeof import('../telegram/src/index.js')>(),
  createPoller: (options: CreatePollerOptions) => {
    seam.handle = options.handle
    return { start: async () => undefined, stop: () => undefined }
  },
}))
vi.mock('../evolve/src/index.js', async (original) => {
  const actual = await original<typeof import('../evolve/src/index.js')>()
  return {
    ...actual,
    createEvolve: (options: EvolveOptions) => {
      seam.evolve = actual.createEvolve({ ...options, sandbox: seam.sandbox, reviewer: seam.reviewer })
      return seam.evolve
    },
  }
})

vi.mock('../factory/src/index.js', async (original) => {
  const actual = await original<typeof import('../factory/src/index.js')>()
  return { ...actual, createFactory: (options: FactoryOptions) => {
    seam.ownMerged = options.onOwnMerged
    return actual.createFactory(options)
  } }
})

// Only the external worker and its panel transport are doubled; enqueue remains real.
vi.mock('../superagent/src/supervisor.js', () => ({
  createSuperagentSupervisor: () => {
    let active = false
    return { start: async () => { active = true }, stop: async () => { active = false }, panic: () => { active = false }, running: () => active }
  },
}))
vi.mock('../superagent/src/panel.js', () => ({
  requestPanel: async (_socket: string, _port: number, path: string) => path === 'state'
    ? { setup: { accounts: { repository: 'fixture' } }, health: { runtime: { state: 'ready' } } }
    : path === 'sources' ? [{ id: 'telegram', installed: true, enabled: true, state: 'paused', health: [{ name: 'telegram', state: 'starting', detail: '' }], stats: { received: 0, filtered: 0, lastAt: '' }, filtered: [], dropped: [] }] : {},
  startPanelProxy: async (_socket: string, port: number) => ({ port, stop: async () => undefined }),
}))

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const OWNER = 7
const GUEST = 5550001
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const IDENTITY = {
  GIT_AUTHOR_NAME: 'dshbot', GIT_AUTHOR_EMAIL: 'dshbot@localhost',
  GIT_COMMITTER_NAME: 'dshbot', GIT_COMMITTER_EMAIL: 'dshbot@localhost',
}
interface Call { chat: number; text: string }
interface CliCall { tool: string; args: string[]; cwd: string }
interface World {
  root: string; home: string; live: string; origin: string; maintainer: string; bin: string; log: string
  failure: string; base: string; calls: Call[]; exits: number[]; exitTexts: string[][]; journal: string[]; updateId: number
  bot: Awaited<ReturnType<typeof startDshbot>> | undefined
  release: (() => void) | undefined
  commandResult?: (kind: 'restart' | 'reply') => void
}
let world: World
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync(realGit, ['-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: world.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY },
  }).trim()
}
function commit(cwd: string, file: string, content: string, title: string): string {
  put(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', title)
  return git(cwd, 'rev-parse', 'HEAD')
}
function own(name = 'remember-owner'): string {
  return commit(world.live, `${name}.md`, `${name}\n`, `evolve: ${name}`)
}
function incoming(): string[] {
  const first = commit(world.maintainer, 'main-first.md', 'first\n', 'Main: first improvement')
  const second = commit(world.maintainer, 'main-second.md', 'second\n', 'Main: second improvement')
  git(world.maintainer, 'push', '-q', 'origin', 'main')
  return [first, second]
}
function cli(tool?: string): CliCall[] {
  return readFileSync(world.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as CliCall)
    .filter((call) => tool === undefined || call.tool === tool)
}
function fetches(): CliCall[] { return cli('git').filter((call) => call.args.includes('fetch')) }
function ownerTexts(): string[] { return world.calls.filter((call) => call.chat === OWNER).map((call) => call.text) }
function candidates(): string[] {
  const path = join(world.home, 'candidates')
  return existsSync(path) ? readdirSync(path).sort() : []
}
async function until(assertion: () => void): Promise<void> {
  const deadline = performance.now() + 7_000
  for (;;) {
    try { assertion(); return } catch (error) {
      if (performance.now() >= deadline) throw error
      await sleep(25)
    }
  }
}
function deepStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(deepStrings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(deepStrings)
  return []
}
const fakeFetch: typeof fetch = async (input, init) => {
  const method = String(input).split('/').at(-1)
  if (method === 'messages') return Response.json({ content: [{ type: 'text', text: 'pong' }] })
  const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    world.calls.push({ chat: Number(params.chat_id), text: deepStrings(params).join('\n') })
  }
  const response = Response.json({ ok: true, result: method === 'getMe'
    ? { username: 'self_update_test_bot' } : { message_id: 9000 + world.calls.length } })
  if ((method === 'sendMessage' || method === 'sendRichMessage') && Number(params.chat_id) === OWNER) {
    world.commandResult?.('reply')
  }
  return response
}

// Fixed local paths, with real git underneath. fetch failures are injected before
// invoking git; npm is a recording double, including when called by adopt.sh.
function installCli(): void {
  const common = `
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path')
const args = process.argv.slice(2)
const record = tool => fs.appendFileSync(${JSON.stringify(world.log)}, JSON.stringify({ tool, args, cwd: process.cwd() }) + '\\n')
const git = (cwd, ...args) => cp.execFileSync(${JSON.stringify(realGit)}, ['-c', 'commit.gpgsign=false', ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env: { ...process.env, ...${JSON.stringify(IDENTITY)} }
}).trim()
const failure = fs.existsSync(${JSON.stringify(world.failure)}) ? fs.readFileSync(${JSON.stringify(world.failure)}, 'utf8') : ''
`
  put(join(world.bin, 'git'), `#!${process.execPath}\n${common}
record('git')
// Keep a scheduled fetch in flight beyond advance()'s short ingress wait. This
// models slow process startup under load and makes the clock barrier observable.
if (args.includes('fetch') && fs.existsSync(${JSON.stringify(join(world.root, 'fetch-delay'))})) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
    Number(fs.readFileSync(${JSON.stringify(join(world.root, 'fetch-delay'))}, 'utf8')))
}
if (args.includes('fetch') && failure.startsWith('fetch:')) { console.error(failure.slice(6)); process.exit(1) }
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`)
  put(join(world.bin, 'npm'), `#!${process.execPath}\n${common}
record('npm')
if (args.includes('ci')) {
  fs.rmSync('node_modules', { recursive: true, force: true })
  fs.mkdirSync('node_modules', { recursive: true })
  fs.writeFileSync('node_modules/installed-by-ci', fs.readFileSync('package-lock.json', 'utf8'))
  if (failure === 'npm:offline') { console.error('npm fixture: offline'); process.exit(1) }
}
`)
  // Local GitHub double, adapted from evolve-upstream.test.ts: PR merge applies
  // the submitted branch's patches to the bare origin, never to the live tree.
  put(join(world.bin, 'gh'), `#!${process.execPath}\n${common}
record('gh')
const statePath = ${JSON.stringify(join(world.root, 'prs.json'))}
const prs = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : []
const option = name => args[args.indexOf(name) + 1]
if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify(prs.filter(p => p.open && p.head === option('--head'))))
else if (args[0] === 'pr' && args[1] === 'create') {
  const pr = { head: option('--head'), open: true, url: 'https://github.com/test/bot/pull/' + (prs.length + 1) }
  prs.push(pr); fs.writeFileSync(statePath, JSON.stringify(prs)); console.log(pr.url)
} else if (args[0] === 'pr' && args[1] === 'merge') {
  const pr = prs.find(p => p.open && (p.head === args[2] || p.url === args[2]))
  if (!pr) process.exit(1)
  const cwd = ${JSON.stringify(world.maintainer)}
  git(cwd, 'fetch', '-q', 'origin')
  git(cwd, 'checkout', '-q', 'main')
  git(cwd, 'reset', '-q', '--hard', 'origin/main')
  for (const line of git(cwd, 'cherry', 'main', 'origin/' + pr.head).split('\\n')) {
    if (line.startsWith('+ ')) git(cwd, 'cherry-pick', line.slice(2))
  }
  git(cwd, 'push', '-q', 'origin', 'main')
  pr.open = false; fs.writeFileSync(statePath, JSON.stringify(prs))
}
`)
  for (const name of ['git', 'npm', 'gh']) chmodSync(join(world.bin, name), 0o755)
  writeFileSync(world.log, '')
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-update-command-')))
  const home = join(root, 'dshbot')
  world = {
    root, home, live: join(home, 'app'), origin: join(root, 'origin.git'), maintainer: join(root, 'maintainer'),
    bin: join(root, 'bin'), log: join(root, 'cli.jsonl'), failure: join(root, 'failure'), base: '',
    calls: [], exits: [], exitTexts: [], journal: [], updateId: 0, bot: undefined, release: undefined,
  }
  put(join(world.live, '.gitignore'), 'node_modules/\nnode_modules.prev/\n')
  put(join(world.live, 'CHECKLIST.md'), '# Review\n- Safe change\n')
  put(join(world.live, 'notes.md'), 'base\n')
  put(join(world.live, 'preferences.md'), 'base preferences\n')
  put(join(world.live, 'package.json'), '{"name":"update-fixture","private":true,"scripts":{"test":"node check.mjs"}}\n')
  put(join(world.live, 'package-lock.json'), '{"name":"update-fixture","lockfileVersion":3,"packages":{}}\n')
  put(join(world.live, 'check.mjs'), 'process.exit(0)\n')
  git(world.live, 'init', '-q', '-b', 'live')
  git(world.live, 'add', '-A')
  git(world.live, 'commit', '-q', '-m', 'Base application')
  world.base = git(world.live, 'rev-parse', 'HEAD')
  git(world.live, 'tag', 'stable')
  // An installed app is a linked worktree, as opposed to a standalone clone.
  const source = join(root, 'source')
  renameSync(world.live, source)
  git(source, 'branch', '-m', 'main')
  git(source, 'worktree', 'add', '-q', '-b', 'live', world.live, 'main')
  mkdirSync(world.origin)
  git(world.origin, 'init', '-q', '--bare', '-b', 'main')
  git(world.live, 'remote', 'add', 'origin', world.origin)
  git(world.live, 'push', '-q', 'origin', 'live:main')
  git(root, 'clone', '-q', '--branch', 'main', world.origin, world.maintainer)
  put(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'old dependency, usable offline\n')
  const store = openStore(join(home, 'state.db'))
  store.kv.set(OWNER_KV_KEY, String(OWNER))
  const guests = new GuestRegistry(store)
  const invite = guests.createInvite(Date.now(), DAY)
  guests.redeem(invite, GUEST, Date.now())
  store.close()
  installCli()
  for (const [key, value] of Object.entries({
    PATH: [world.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter), HOME: root,
    DSHBOT_HOME: home, TELEGRAM_BOT_TOKEN: 'self-update-test-token', DEEPSEEK_API_KEY: 'self-update-test-key',
    DSHBOT_UPSTREAM: 'off', DSHBOT_ISOLATION: 'host', DSHBOT_AUTO_SYNC: 'off', DSHBOT_SYNC_AT: '',
    DSHBOT_DREAM_AT: 'off', DSHBOT_BACKUP_AT: '', DSHBOT_TZ: 'Asia/Yekaterinburg',
    DSHBOT_AUTO_COMPACT_TOKENS: '0', DSHBOT_WAKE_JITTER: '0', DSHBOT_FREE_WAKE_CHANCE: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...IDENTITY,
  })) vi.stubEnv(key, value)
  seam.handle = undefined
  seam.evolve = undefined
  seam.sandbox.mockReset().mockReturnValue({ ok: true, status: 0, output: 'fixture tests passed' })
  seam.reviewer.mockReset().mockResolvedValue('{"verdict":"approve","summary":"safe update"}')
  seam.startRunner.mockReset().mockResolvedValue({
    prompt: async () => '[SILENT]', promptTurn: async () => ({ text: 'owner answer completed' }),
    cancel: () => false, stop: async () => undefined,
  } as unknown as Runner)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { world.journal.push(String(chunk)); return true })
})
afterEach(async () => {
  world.release?.()
  await world.bot?.stop()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(world.root, { recursive: true, force: true })
})
async function start(options: { ownerDebounceMs?: number } = { ownerDebounceMs: 0 }): Promise<void> {
  world.calls = []
  world.bot = await startDshbot({
    ...readEnvConfig(process.env), fetch: fakeFetch, ...options,
    exitProcess: (code) => {
      world.exitTexts.push([...ownerTexts()]); world.exits.push(code)
      if (code === 42) world.commandResult?.('restart')
    },
  })
  expect(seam.handle, 'fixture: poller receives the actual daemon handler').toBeDefined()
  // The neighboring harness uses /help as a startup/worker barrier.
  await say('/help')
  await until(() => expect(ownerTexts().some((text) => text.includes('Команды владельца'))).toBe(true))
  // The daemon starts its publication check without awaiting it. Wait for that
  // check before the test mutates origin/main or live: its asynchronous fetch
  // must not publish a commit the test is about to send through /update.
  await seam.evolve!.syncUpstream({ quiet: true })
  world.calls = world.calls.filter((call) => !call.text.includes('Команды владельца'))
}
async function say(text: string, chat = OWNER, type: 'private' | 'group' = 'private', sender = chat === OWNER ? OWNER : GUEST): Promise<void> {
  world.updateId += 1
  await seam.handle!({ update_id: world.updateId, message: {
    message_id: world.updateId, from: { id: sender, is_bot: false, first_name: 'Test' },
    chat: { id: chat, type }, text,
  } } as TelegramUpdate)
}
async function update(expected: 'restart' | 'reply'): Promise<void> {
  // start() has drained startup sync. Observe this command's actual result,
  // with the enclosing test's existing deadline, rather than a second 7s timer.
  const completion = new Promise<'restart' | 'reply'>(resolve => {
    world.commandResult = resolve
  })
  try {
    await say('/update')
    expect(await completion, 'the update command terminal result').toBe(expected)
  } finally {
    world.commandResult = undefined
  }
}
function adoptionSha(): string {
  const path = join(world.home, 'adopt.json')
  expect(existsSync(path), `green sync writes adopt.json: ${ownerTexts().join('\n')}`).toBe(true)
  const record = JSON.parse(readFileSync(path, 'utf8')) as { sha?: unknown }
  expect(record.sha).toMatch(/^[0-9a-f]{40,64}$/)
  return record.sha as string
}
function startPre(): void {
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'adopt.sh')], {
    cwd: world.live, env: { ...process.env, DSHBOT_HOME: world.home }, encoding: 'utf8', timeout: 15_000,
  })
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
}
async function adoptAndRestart(): Promise<string[]> {
  const before = [...ownerTexts()]
  await world.bot?.stop()
  world.bot = undefined
  startPre()
  await start()
  return [...before, ...ownerTexts()]
}
function unchanged(head: string): void {
  expect(git(world.live, 'rev-parse', 'HEAD')).toBe(head)
  expect(existsSync(join(world.home, 'adopt.json'))).toBe(false)
  expect(world.exits).toEqual([])
}
function report(texts: string[], count: number, titles: string[]): void {
  expect(texts, 'one result message, including upstream information').toHaveLength(1)
  const text = texts[0] ?? ''
  expect(text, 'number of incoming main commits').toMatch(new RegExp(`(?:main[^\\n]*\\b${count}\\b|\\b${count}\\b[^\\n]*main)`, 'i'))
  for (const title of titles) expect(text, 'preserved own change is named').toContain(title)
}

test('test_c1_update_gates_main_plus_own_patches_and_adopts_once', { timeout: 30_000 }, async () => {
  const main = incoming()
  own('remember-owner')
  const old = own('shorter-answers')
  await start()
  await update('restart')
  const sha = adoptionSha()
  expect(git(world.live, 'rev-parse', 'HEAD'), 'live is untouched before adoption').toBe(old)
  const ancestry = git(world.live, 'rev-list', sha).split('\n')
  for (const commit of main) expect(ancestry).toContain(commit)
  for (const name of ['remember-owner', 'shorter-answers']) expect(git(world.live, 'show', `${sha}:${name}.md`)).toBe(name)
  expect(seam.sandbox).toHaveBeenCalled()
  expect(seam.reviewer).toHaveBeenCalled()
  expect(world.exits).toEqual([42])
  const texts = await adoptAndRestart()
  expect(git(world.live, 'rev-parse', 'live')).toBe(sha)
  report(texts, 2, ['remember-owner', 'shorter-answers'])
})


test('test_c4_conflicting_patch_reports_title_and_files_and_removes_candidate', async () => {
  put(join(world.maintainer, 'preferences.md'), 'upstream preferences\n')
  git(world.maintainer, 'add', 'preferences.md')
  commit(world.maintainer, 'notes.md', 'upstream rewrite\n', 'Main: rewrite notes')
  git(world.maintainer, 'push', '-q', 'origin', 'main')
  put(join(world.live, 'preferences.md'), 'personal preferences\n')
  git(world.live, 'add', 'preferences.md')
  const head = commit(world.live, 'notes.md', 'local rewrite\n', 'evolve: explain personal notes')
  await start()
  const before = candidates()
  await update('reply')
  const text = ownerTexts().join('\n')
  expect(text).toMatch(/конфликт/i)
  expect(text).toContain('explain personal notes')
  expect(text).toContain('notes.md')
  expect(text).toContain('preferences.md')
  expect(candidates()).toEqual(before)
  expect(seam.sandbox).not.toHaveBeenCalled()
  unchanged(head)
})


test.each(['tests', 'review'] as const)('test_c5_red_%s_gate_keeps_live_and_reports_why', async (stage) => {
  incoming()
  const head = own()
  if (stage === 'tests') seam.sandbox.mockReturnValue({ ok: false, status: 1, output: 'SYNC_TEST_FAILED: incompatible change' })
  else seam.reviewer.mockResolvedValue('{"verdict":"reject","summary":"SYNC_REVIEW_FAILED: unsafe change"}')
  await start()
  await update('reply')
  expect(seam.sandbox, 'sync uses the evolve gate').toHaveBeenCalled()
  expect(ownerTexts().join('\n')).toContain(stage === 'tests' ? 'SYNC_TEST_FAILED' : 'SYNC_REVIEW_FAILED')
  unchanged(head)
})


test('test_h1_failed_dependency_adoption_restores_modules_offline_and_notifies_after_start', async () => {
  const previous = own('accepted-after-stable')
  await start()
  await world.bot?.stop()
  world.bot = undefined
  const path = join(world.home, 'candidates', 'dependency-adoption')
  git(world.live, 'worktree', 'add', '-q', '-b', 'candidate-dependency', path, 'live')
  const sha = commit(path, 'package-lock.json', '{"lockfileVersion":3,"packages":{},"name":"new-lock"}\n', 'Main: new lock')
  put(join(world.home, 'adopt.json'), JSON.stringify({ sha }))
  put(world.failure, 'npm:offline')
  startPre()
  expect(git(world.live, 'rev-parse', 'HEAD'), 'failed dependency installation rolls back immediately').toBe(previous)
  expect(readFileSync(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'utf8')).toBe('old dependency, usable offline\n')
  expect(existsSync(join(world.home, 'rollback.json')), 'script leaves the existing rollback notification protocol').toBe(true)
  expect(cli('npm').filter((call) => call.args.includes('ci')), 'saved modules avoid a second network-dependent installation').toHaveLength(1)
  await start()
  expect(ownerTexts().filter((text) => /откат|откач/i.test(text))).toHaveLength(1)
  expect(ownerTexts().join('\n')).toContain(previous.slice(0, 7))
})


test('factory merges during a manual sync coalesce and drain after gate release', async () => {
  await start()
  const sync = vi.spyOn(seam.evolve!, 'syncMain')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve; world.release = resolve })
  sync.mockImplementationOnce(async () => { await held; return { state: 'none', mainCommits: 0, ownChanges: [], sha: world.base } })
  await say('/update')
  await until(() => expect(sync).toHaveBeenCalledTimes(1))
  incoming()
  await seam.ownMerged!({ taskId: 1 })
  await seam.ownMerged!({ taskId: 2 })
  expect(sync).toHaveBeenCalledTimes(1)
  release()
  await until(() => expect(world.exits).toEqual([42]))
  expect(sync).toHaveBeenCalledTimes(2)
  adoptionSha()
})


test('factory merge pending behind an adoption restart survives into the next process', async () => {
  await start()
  incoming()
  await seam.ownMerged!({ taskId: 1 })
  await until(() => expect(world.exits).toEqual([42]))
  commit(world.maintainer, 'after-adoption.md', 'next merge\n', 'Main: next factory task')
  git(world.maintainer, 'push', '-q', 'origin', 'main')
  await seam.ownMerged!({ taskId: 2 })
  await world.bot!.stop()
  world.bot = undefined
  await start()
  await until(() => expect(world.exits).toEqual([42, 42]))
  expect(git(world.live, 'show', `${adoptionSha()}:after-adoption.md`)).toBe('next merge')
})


test('unexpected factory sync failure preserves pending intent without an immediate retry loop', async () => {
  await start()
  incoming()
  const sync = vi.spyOn(seam.evolve!, 'syncMain').mockRejectedValueOnce(new Error('fixture sync interruption'))
  await seam.ownMerged!({ taskId: 1 })
  await until(() => expect(world.journal.join('')).toContain('factory sync failed: Error: fixture sync interruption'))
  await sleep(50)
  expect(sync).toHaveBeenCalledTimes(1)
  const store = openStore(join(world.home, 'state.db'))
  try { expect(store.kv.get('factory.own-merge-sync-pending')).toBe('1') } finally { store.close() }
  await world.bot!.stop()
  world.bot = undefined
  await start()
  await until(() => expect(world.exits).toEqual([42]))
  adoptionSha()
})


test('main sync installs candidate dependencies before the verification gate', async () => {
  commit(world.maintainer, 'package.json', '{"name":"update-fixture","private":true,"scripts":{"test":"node check.mjs"},"dependencies":{"fixture-dep":"2.0.0"}}\n', 'Main: dependency manifest')
  const lock = '{"name":"update-fixture","lockfileVersion":3,"packages":{"node_modules/fixture-dep":{"version":"2.0.0"}}}\n'
  commit(world.maintainer, 'package-lock.json', lock, 'Main: dependency lock')
  git(world.maintainer, 'push', '-q', 'origin', 'main')
  let installedBeforeTests = false
  seam.sandbox.mockImplementation((options: SandboxOptions) => {
    const calls = cli('npm').filter((call) => call.args.includes('ci') && call.cwd === options.candidate)
    installedBeforeTests = calls.length > 0 && existsSync(join(options.candidate, 'node_modules', 'installed-by-ci'))
    return { ok: true, status: 0, output: 'passed' }
  })
  await start()
  await update('restart')
  adoptionSha()
  expect(installedBeforeTests, 'candidate dependency installation completes before its tests').toBe(true)
  expect(readFileSync(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'utf8')).toContain('usable offline')
})


const staleMessage = 'Кандидат устарел: live изменился после его создания. Правка не применена, live не изменён.'

function candidateAtBase(name: string): string {
  const path = join(world.home, 'candidates', name)
  git(world.live, 'worktree', 'add', '-q', '-b', `candidate-${name}`, path, world.base)
  return path
}

test('c1 c5 stale adoption preserves live and reports refusal once after startup', async () => {
  const path = candidateAtBase('stale')
  const candidate = commit(path, 'candidate.md', 'candidate\n', 'Candidate change')
  const live = commit(world.live, 'new-live.md', 'new live\n', 'Live improvement')
  put(join(world.home, 'adopt.json'), JSON.stringify({ sha: candidate, candidate: 'c-stale' }))
  startPre()
  expect(git(world.live, 'rev-parse', 'HEAD')).toBe(live)
  expect(existsSync(join(world.home, 'adopt.json'))).toBe(false)
  expect(existsSync(join(world.home, 'adopt-notice.json'))).toBe(false)
  const records = readdirSync(world.home, { withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(world.home, entry.name), 'utf8')).join('\n')
  expect(records).toContain(live)
  expect(records).toContain('Live improvement')
  expect(records).toMatch(/устарел|отказ|stale|refus|missing|несохран|недоста/i)
  await start()
  expect(ownerTexts().filter((text) => text.includes(staleMessage))).toHaveLength(1)
  expect(ownerTexts().join('\n')).not.toMatch(/правка применена|изменение применено/i)
  await world.bot?.stop()
  world.bot = undefined
  await start()
  expect(ownerTexts().filter((text) => text.includes(staleMessage))).toHaveLength(0)
})


test('configured Superagent command is durably enqueued once without a factory task or model call', async () => {
  put(join(world.home, 'superagent', 'runtime.json'), JSON.stringify({ runtimeDir: '/opt/superagent', projects: [{ id: 0, port: 3082 }] }))
  await start()
  const models = seam.startRunner.mock.calls.length
  await say('/superagent new Repair the fixture and preserve its data')
  const id = world.updateId
  world.updateId -= 1
  await say('/superagent new Repair the fixture and preserve its data')
  await until(() => expect(ownerTexts().filter(text => text.includes('Задача сохранена для Superagent'))).toHaveLength(1))
  const store = openStore(join(world.home, 'state.db'))
  try {
    expect(store.db.prepare('SELECT project_id,update_id,message_id,text FROM superagent_bridge_events').all()).toEqual([
      { project_id: 0, update_id: id, message_id: id, text: 'Repair the fixture and preserve its data' },
    ])
    expect(store.db.prepare('SELECT count(*) AS n FROM factory_tasks').get()).toEqual({ n: 0 })
    expect(store.kv.get(`superagent.command.processed:${id}`)).toBe('1')
  } finally { store.close() }
  expect(seam.startRunner.mock.calls).toHaveLength(models)
})
