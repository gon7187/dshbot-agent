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
}))
vi.mock('../runner/src/index.js', async (original) => ({
  ...await original<typeof import('../runner/src/index.js')>(), startRunner: seam.startRunner,
}))
vi.mock('../tools-exec/src/index.js', () => ({
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
  return Response.json({ ok: true, result: method === 'getMe'
    ? { username: 'self_update_test_bot' } : { message_id: 9000 + world.calls.length } })
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
async function start(): Promise<void> {
  world.calls = []
  world.bot = await startDshbot({
    ...readEnvConfig(process.env), fetch: fakeFetch, ownerDebounceMs: 0,
    exitProcess: (code) => { world.exitTexts.push([...ownerTexts()]); world.exits.push(code) },
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
async function update(): Promise<void> {
  await say('/update')
  await until(() => expect(world.exits.includes(42) || ownerTexts().length > 0, 'the command completes').toBe(true))
}
function adoptionSha(): string {
  const path = join(world.home, 'adopt.json')
  expect(existsSync(path), 'green sync writes adopt.json').toBe(true)
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
  await update()
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

test('test_c2_patch_already_rebased_into_main_is_not_replayed', { timeout: 30_000 }, async () => {
  const already = own('already-shipped')
  incoming()
  git(world.maintainer, 'fetch', '-q', world.live, 'live')
  git(world.maintainer, 'cherry-pick', already)
  expect(git(world.maintainer, 'rev-parse', 'HEAD')).not.toBe(already)
  git(world.maintainer, 'push', '-q', 'origin', 'main')
  own('still-local')
  await start()
  await update()
  const sha = adoptionSha()
  expect(git(world.live, 'show', `${sha}:already-shipped.md`)).toBe('already-shipped')
  expect(git(world.live, 'show', `${sha}:still-local.md`)).toBe('still-local')
  expect(git(world.live, 'log', '--format=%s', sha).split('\n').filter((s) => s === 'evolve: already-shipped')).toHaveLength(1)
  expect(seam.sandbox).toHaveBeenCalled()
  expect(world.exits).toEqual([42])
})

test('test_c3_no_new_main_reports_current_sha_without_a_candidate', async () => {
  const head = own()
  await start()
  const before = candidates()
  await update()
  expect(ownerTexts().join('\n')).toMatch(/Обновлений нет/i)
  expect(ownerTexts().join('\n')).toContain(head.slice(0, 7))
  expect(candidates()).toEqual(before)
  expect(seam.sandbox).not.toHaveBeenCalled()
  unchanged(head)
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
  await update()
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
  await update()
  expect(seam.sandbox, 'sync uses the evolve gate').toHaveBeenCalled()
  expect(ownerTexts().join('\n')).toContain(stage === 'tests' ? 'SYNC_TEST_FAILED' : 'SYNC_REVIEW_FAILED')
  unchanged(head)
})

test('test_c6_fetch_failure_reports_the_actual_reason_and_preserves_live', async () => {
  incoming()
  const head = own()
  await start()
  put(world.failure, 'fetch:fixture network unreachable')
  await update()
  expect(ownerTexts().join('\n')).toContain('fixture network unreachable')
  expect(seam.sandbox).not.toHaveBeenCalled()
  unchanged(head)
})

test('test_c7_main_dependencies_are_installed_before_gate_but_self_change_still_refuses_them', async () => {
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
  const tool = (name: string) => {
    const found = seam.evolve?.tools.find((entry) => entry.name === name)
    expect(found).toBeDefined()
    return found!
  }
  const answer = String(await tool('self_change').execute({ description: 'ordinary dependency change' }))
  const id = /^id: (\S+)/m.exec(answer)?.[1]
  expect(id, answer).toBeDefined()
  put(join(world.home, 'candidates', id!, 'package.json'), '{"dependencies":{"forbidden":"1.0.0"}}\n')
  let refusal = ''
  try { refusal = String(await tool('self_submit').execute({ id })) } catch (error) { refusal = String(error) }
  expect(refusal).toContain('Гейт не пройден: зависимости меняются только через завод (изменены package.json). Adopt не ставит пакеты, а новые зависимости требуют проверки риска.')
  expect(seam.sandbox, 'ordinary dependency change is refused before tests').not.toHaveBeenCalled()
  await seam.evolve!.reject(id!)
  await update()
  adoptionSha()
  expect(installedBeforeTests, 'candidate dependency installation completes before its tests').toBe(true)
  expect(readFileSync(join(world.live, 'node_modules', 'old-dependency', 'index.js'), 'utf8')).toContain('usable offline')
})

// Same jump-clock semantics as test-support/wake-harness.ts: a jump fires each
// expired timer once; repeated timers re-arm from now. Real short waits keep the
// ingress worker and async operations running while calendar time is advanced.
function clock(at: string): { advance(ms: number): Promise<void>; settled(): Promise<void> } {
  const real = { setTimeout, setInterval, clearTimeout, clearInterval }
  type Handle = ReturnType<typeof setTimeout>
  interface Entry { due: number; ms: number; repeat: boolean; run(): void }
  const entries = new Map<Handle, Entry>()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(at))
  const timeout: typeof setTimeout = ((fn: (...args: unknown[]) => void, ms = 1, ...args: unknown[]) => {
    const handle = real.setTimeout(() => { entries.delete(handle); fn(...args) }, ms)
    entries.set(handle, { due: Date.now() + ms, ms, repeat: false, run: () => fn(...args) })
    return handle
  }) as typeof setTimeout
  const interval: typeof setInterval = ((fn: (...args: unknown[]) => void, ms = 1, ...args: unknown[]) => {
    const entry: Entry = { due: Date.now() + ms, ms, repeat: true, run: () => fn(...args) }
    const handle = real.setInterval(() => { entry.due = Date.now() + ms; entry.run() }, ms)
    entries.set(handle, entry)
    return handle
  }) as typeof setInterval
  vi.stubGlobal('setTimeout', timeout)
  vi.stubGlobal('setInterval', interval)
  vi.stubGlobal('clearTimeout', (handle: Handle) => { entries.delete(handle); real.clearTimeout(handle) })
  vi.stubGlobal('clearInterval', (handle: Handle) => { entries.delete(handle); real.clearInterval(handle) })
  return { advance: async (ms) => {
    vi.setSystemTime(Date.now() + ms)
    for (const [handle, entry] of [...entries]) {
      if (entry.due > Date.now()) continue
      if (entry.repeat) entry.due = Date.now() + entry.ms
      else { entries.delete(handle); real.clearTimeout(handle) }
      entry.run()
    }
    await sleep(200)
  },
  // The daily scheduler arms the next occurrence only after the previous run
  // settles. Jumping the calendar while that run is still in flight anchors the
  // next timer at the already-jumped time, and the next advance never reaches
  // it. Wait for the fresh daily alarm before moving time again. The wake
  // scheduler also arms a one-shot alarm, exactly 60 minutes from now after a
  // stale wake-up. It must not satisfy this barrier while sync is still running.
  // In these tests the next daily occurrence is at least 12 hours away; all
  // other one-shot alarms (health, wake, process timeouts) are at most 2 hours.
  settled: async () => {
    const deadline = performance.now() + 7_000
    for (;;) {
      const current = Date.now()
      if ([...entries.values()].some((entry) => !entry.repeat && entry.due - current > 2 * 60 * MINUTE)) return
      if (performance.now() >= deadline) {
        throw new Error(`daily sync did not arm its next check: ${JSON.stringify([...entries.values()].map((entry) => ({ ms: entry.ms, due: entry.due - current, repeat: entry.repeat })))}`)
      }
      await sleep(25)
    }
  } }
}

test.each(['', '06:15'])('test_c9_daily_sync_at_owner_time_%s_is_silent_without_updates', async (configured) => {
  const local = configured || '04:00'
  const [hour, minute] = local.split(':').map(Number)
  const at = Date.UTC(2026, 0, 2, hour! - 5, minute! - 1)
  const time = clock(new Date(at).toISOString())
  vi.stubEnv('DSHBOT_AUTO_SYNC', configured ? 'on' : '')
  vi.stubEnv('DSHBOT_SYNC_AT', configured)
  await start()
  const initial = fetches().length
  const logMark = world.journal.join('').length
  await time.advance(30_000)
  expect(fetches()).toHaveLength(initial)
  await time.advance(30_000)
  await until(() => expect(fetches().length, 'scheduled check runs at owner local time').toBeGreaterThan(initial))
  const first = fetches().length
  // The checks of the run are already in flight: this jump is what used to kill
  // a git fetch through its timeout or leave HEAD unreadable.
  await time.advance(12 * 60 * MINUTE)
  expect(fetches()).toHaveLength(first)
  // The completed run names the live SHA it read, so a killed process or an
  // unreadable HEAD fails here instead of leaving an owner error behind.
  const liveHead = git(world.live, 'rev-parse', 'HEAD').slice(0, 7)
  await until(() => expect(world.journal.join('').slice(logMark), 'the daily check finished and read HEAD')
    .toContain(`sync: обновлений нет, live на ${liveHead}`))
  expect(ownerTexts()).toEqual([])
  // Only now is the scheduler armed for the next occurrence again.
  await time.settled()
  const nextLogMark = world.journal.join('').length
  await time.advance(12 * 60 * MINUTE)
  await until(() => expect(fetches().length, 'next daily check').toBeGreaterThan(first))
  await until(() => expect(world.journal.join('').slice(nextLogMark), 'the next daily check finished and read HEAD')
    .toContain(`sync: обновлений нет, live на ${liveHead}`))
  expect(ownerTexts()).toEqual([])
})

test('test_c9_daily_sync_adopts_the_same_candidate_as_the_command', async () => {
  const time = clock('2026-01-01T22:59:00.000Z') // 03:59 UTC+5
  vi.stubEnv('DSHBOT_AUTO_SYNC', 'on')
  incoming()
  own()
  await start()
  await time.advance(MINUTE)
  await until(() => expect(world.exits).toEqual([42]))
  const sha = adoptionSha()
  expect(git(world.live, 'show', `${sha}:main-second.md`)).toBe('second')
  expect(git(world.live, 'show', `${sha}:remember-owner.md`)).toBe('remember-owner')
  expect(seam.sandbox).toHaveBeenCalled()
  expect(seam.reviewer).toHaveBeenCalled()
})

test('test_c9_auto_sync_off_stays_off_but_update_command_works', async () => {
  const time = clock('2026-01-01T22:59:00.000Z')
  incoming()
  await start()
  const initial = fetches().length
  await time.advance(MINUTE)
  await time.advance(DAY)
  expect(fetches()).toHaveLength(initial)
  expect(ownerTexts()).toEqual([])
  await update()
  adoptionSha()
  expect(world.exits).toEqual([42])
})

test('test_c6_identical_consecutive_automatic_fetch_failures_notify_once', async () => {
  const time = clock('2026-01-01T22:59:00.000Z')
  vi.stubEnv('DSHBOT_AUTO_SYNC', 'on')
  await start()
  put(join(world.root, 'fetch-delay'), '500')
  put(world.failure, 'fetch:fixture daily network unreachable')
  const before = fetches().length
  await time.advance(MINUTE)
  await until(() => expect(ownerTexts().filter((text) => text.includes('fixture daily network unreachable'))).toHaveLength(1))
  const first = fetches().length
  expect(first).toBeGreaterThan(before)
  await time.settled()
  await time.advance(DAY)
  await until(() => expect(fetches().length).toBeGreaterThan(first))
  expect(ownerTexts().filter((text) => text.includes('fixture daily network unreachable'))).toHaveLength(1)
  await time.settled()
  put(world.failure, 'fetch:fixture DNS resolution failed')
  await time.advance(DAY)
  await until(() => expect(ownerTexts().filter((text) => text.includes('fixture DNS resolution failed'))).toHaveLength(1))
  expect(ownerTexts(), 'different failures with the same exit code have separate reasons').toHaveLength(2)
  unchanged(world.base)
})

test('test_c10_sync_restart_waits_until_owner_turn_delivers_its_answer', async () => {
  incoming()
  own()
  let entered = false
  const held = new Promise<void>((resolve) => { world.release = resolve })
  seam.startRunner.mockResolvedValue({
    prompt: async () => '[SILENT]',
    promptTurn: async () => { entered = true; await held; return { text: 'HELD_OWNER_ANSWER' } },
    cancel: () => false, stop: async () => undefined,
  } as unknown as Runner)
  await start()
  await say('Please finish my long owner turn')
  await until(() => expect(entered, 'fixture: owner model turn is running').toBe(true))
  const command = say('/update')
  try {
    // Both a queued update and an already-gated candidate are valid. Observe a
    // full live worker interval while the owner answer remains blocked.
    await sleep(500)
    expect(world.exits, 'adoption cannot interrupt the running owner turn').toEqual([])
    expect(ownerTexts().some((text) => text.includes('HELD_OWNER_ANSWER'))).toBe(false)
  } finally { world.release?.() }
  await command
  await until(() => expect(world.exits).toEqual([42]))
  expect(world.exitTexts.at(-1)?.some((text) => text.includes('HELD_OWNER_ANSWER')), 'owner answer was delivered before restart').toBe(true)
  adoptionSha()
})

test.each(['on', 'off'])('test_c11_container_upstream_%s_refuses_update_without_fetch_and_daily_check_is_silent', async (upstream) => {
  const time = clock('2026-01-01T22:59:00.000Z')
  vi.stubEnv('DSHBOT_ISOLATION', 'container')
  vi.stubEnv('DSHBOT_UPSTREAM', upstream)
  vi.stubEnv('DSHBOT_AUTO_SYNC', 'on')
  incoming()
  await start()
  expect(fetches(), 'container startup does not fetch').toEqual([])
  await update()
  const text = ownerTexts().join('\n')
  expect(text).toMatch(/самообновлен|обновление/i)
  expect(text).toMatch(/container/i)
  expect(text).toMatch(/недоступ|невозмож|не поддерж/i)
  world.calls = []
  await time.advance(MINUTE)
  await time.advance(DAY)
  expect(fetches()).toEqual([])
  expect(ownerTexts()).toEqual([])
  expect(seam.sandbox).not.toHaveBeenCalled()
  unchanged(world.base)
})

test.each([
  { label: 'guest', chat: GUEST, type: 'private' as const, sender: GUEST },
  { label: 'owner_in_group', chat: -1007, type: 'group' as const, sender: OWNER },
])('test_c12_$label refuses_update_without_fetching', async ({ chat, type, sender }) => {
  incoming()
  await start()
  const before = fetches().length
  await say('/update', chat, type, sender)
  await until(() => {
    const text = world.calls.filter((call) => call.chat === chat).map((call) => call.text).join('\n')
    expect(text, `refusal for chat ${chat}`).toMatch(/владел|доступ|нельзя|недоступ|личн/i)
  })
  expect(fetches()).toHaveLength(before)
  expect(seam.sandbox).not.toHaveBeenCalled()
  unchanged(world.base)
})

test.each(['plain-directory', 'init-without-origin', 'clone-origin-removed'] as const)(
  'test_h2_unavailable_%s_never_fetches_and_only_manual_check_informs_owner', async (kind) => {
    const time = clock('2026-01-01T22:59:00.000Z')
    vi.stubEnv('DSHBOT_AUTO_SYNC', 'on')
    if (kind === 'plain-directory') {
      rmSync(world.live, { recursive: true, force: true })
      mkdirSync(world.live)
    } else if (kind === 'init-without-origin') {
      rmSync(world.live, { recursive: true, force: true })
      mkdirSync(world.live)
      git(world.live, 'init', '-q', '-b', 'arbitrary-name')
    } else {
      rmSync(world.live, { recursive: true, force: true })
      git(world.root, 'clone', '-q', world.origin, world.live)
      git(world.live, 'remote', 'remove', 'origin')
    }
    await start()
    const before = world.journal.length
    await time.advance(MINUTE)
    expect(fetches()).toEqual([])
    expect(ownerTexts()).toEqual([])
    await until(() => expect(world.journal.slice(before).join('\n'), 'unavailable daily sync is logged').toMatch(/git|origin|репозит/i))
    await update()
    const text = ownerTexts().join('\n')
    expect(text).toMatch(/самообновлен|обновление/i)
    expect(text).toMatch(/недоступ|невозмож/i)
    expect(text).toMatch(kind === 'plain-directory' ? /не.*git|не.*репозит/i : /origin/i)
    expect(fetches()).toEqual([])
    expect(world.exits).toEqual([])
  },
)

test.each(['on', 'off'])('test_h3_update_upstream_%s_has_exactly_one_combined_result', { timeout: 30_000 }, async (mode) => {
  vi.stubEnv('DSHBOT_UPSTREAM', mode)
  await start()
  // Make own changes after the startup backfill has settled: the command owns
  // their publication and its result, rather than an unrelated startup sync.
  incoming()
  own('keep-voice')
  await update()
  adoptionSha()
  const texts = await adoptAndRestart()
  report(texts, 2, ['keep-voice'])
  expect(texts[0], 'upstream information is part of the same result').toMatch(mode === 'off'
    ? /отправ.*выключ|публикац.*выключ|UPSTREAM=off/i
    : /отправ|опубликова|переда.*main/i)
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
