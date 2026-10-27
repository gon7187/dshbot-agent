// The light gate of self-rewriting: typecheck of the whole candidate tree plus only the tests related to the
// files the candidate changed (the `gate` script of package.json called with them), and `npm test` only for a candidate without a gate
// script.
//
// This is the real createEvolve and the real sandboxedTests of packages/evolve over a real git `live`
// repository (and a local `origin` for the synchronization path). Only two things are doubled: bwrap, by a
// script that runs the command after `--` in the --chdir directory, as the existing gate-timeout.test.ts
// and gate-fallback-resolution.test.ts do for their sandbox, and the toolchain: `tsc` and `vitest` are small
// scripts earlier in PATH. The fake vitest keeps the semantics the gate relies on: `related` selects the test
// files whose relative imports reach the given files, `run` selects all of them, a missing or non-code path
// is an error, and without --run or `run` it would start the watch mode. A source file with the marker
// FAKE_FAIL makes every test file that reaches it fail; FAKE_TYPE_ERROR makes the fake tsc fail. So no
// tsc or vitest of the repository runs here.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createEvolve, type Evolve, type OwnerCard, type SyncReport } from '../../packages/evolve/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const TIMEOUT_ENV = 'DSHBOT_EVOLVE_GATE_TIMEOUT_MS'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// --- the toolchain doubles -----------------------------------------------------------------------------

function bwrapScript(): string {
  return `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
const separator = args.indexOf('--')
const command = args.slice(separator + 1)
if (command.length === 1 && command[0] === '/bin/true') process.exit(0)
const chdir = args[args.indexOf('--chdir') + 1]
const result = spawnSync(command[0], command.slice(1), {
  cwd: chdir,
  env: {
    PATH: process.env.PATH,
    HOME: ${JSON.stringify('@@HOME@@')},
    LANG: 'C.UTF-8',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_cache: ${JSON.stringify('@@CACHE@@')},
  },
  stdio: 'inherit',
})
if (result.error) { console.error(result.error.message); process.exit(127) }
process.exit(result.status === null ? 137 : result.status)
`
}

function sharedPrelude(root: string): string {
  return `const fs = require('node:fs')
const path = require('node:path')
const cwd = process.cwd()
const args = process.argv.slice(2)
const CONFIG = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'fake.json'))}, 'utf8'))
function record(entry) { fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify(entry) + '\\n') }
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}
const rel = (file) => path.relative(cwd, file)
`
}

function tscScript(root: string): string {
  return `#!${process.execPath}
${sharedPrelude(root)}
record({ tool: 'tsc', argv: args, cwd })
setTimeout(() => {
  const bad = walk(cwd, []).filter((file) => /\\.tsx?$/.test(file) && fs.readFileSync(file, 'utf8').includes('FAKE_TYPE_ERROR'))
  for (const file of bad) console.log(rel(file) + "(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")
  if (bad.length > 0) { console.log('Found ' + bad.length + ' error.'); process.exit(1) }
  process.exit(0)
}, CONFIG.tscSleepMs || 0)
`
}

function vitestScript(root: string): string {
  return `#!${process.execPath}
${sharedPrelude(root)}
record({ tool: 'vitest', argv: args, cwd })
const positional = args.filter((arg) => !arg.startsWith('-'))
const sub = positional[0]
const runMode = sub === 'run' || args.includes('--run') || args.includes('--watch=false') || args.includes('--no-watch')
if (!runMode) { console.error('vitest would start in watch mode: pass run or --run'); process.exit(2) }
const passWithNoTests = args.includes('--passWithNoTests') || args.includes('--pass-with-no-tests')
const isTest = (file) => /\\.test\\.[cm]?[jt]sx?$/.test(file)
function resolveImport(from, spec) {
  const base = path.resolve(path.dirname(from), spec)
  return [base, base.replace(/\\.js$/, '.ts'), base + '.ts', path.join(base, 'index.ts')]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}
function closure(file) {
  const seen = new Set()
  const stack = [file]
  while (stack.length > 0) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    for (const match of fs.readFileSync(current, 'utf8').matchAll(/from\\s+['"](\\.[^'"]+)['"]/g)) {
      const target = resolveImport(current, match[1])
      if (target !== undefined) stack.push(target)
    }
  }
  return seen
}
const all = walk(cwd, []).filter(isTest).sort()
let selected = all
if (sub === 'related') {
  const files = positional.slice(1)
  for (const file of files) {
    const absolute = path.resolve(cwd, file)
    if (!fs.existsSync(absolute) || !/\\.[cm]?[jt]sx?$/.test(absolute)) {
      console.error('Error: related path is not an existing code file: ' + file)
      process.exit(1)
    }
  }
  const targets = new Set(files.map((file) => path.resolve(cwd, file)))
  selected = all.filter((test) => [...closure(test)].some((file) => targets.has(file)))
}
if (selected.length === 0) {
  console.log('No test files found')
  process.exit(passWithNoTests ? 0 : 1)
}
setTimeout(() => {
  let failed = 0
  for (const test of selected) {
    record({ tool: 'test-run', file: rel(test) })
    const bad = [...closure(test)].find((file) => fs.readFileSync(file, 'utf8').includes('FAKE_FAIL'))
    if (bad === undefined) { console.log(' ✓ ' + rel(test)); continue }
    failed += 1
    console.log(' FAIL  ' + rel(test) + ' > fake suite')
    console.log('AssertionError: expected 3 to be 4 (' + rel(bad) + ' carries the failing marker)')
  }
  console.log('Test Files  ' + failed + ' failed | ' + (selected.length - failed) + ' passed')
  process.exit(failed > 0 ? 1 : 0)
}, CONFIG.vitestSleepMs || 0)
`
}

// --- the candidate project -----------------------------------------------------------------------------

const MATH_OK = 'export const add = (a: number, b: number): number => a + b\n'
const MATH_BREAKS_TESTS = 'export const add = (a: number, b: number): number => a - b // FAKE_FAIL\n'
const MATH_TYPE_ERROR = "export const add = (a: number, b: number): number => 'x' // FAKE_TYPE_ERROR\n"

interface WorldOptions {
  /** package.json carries the `gate` script; without it the gate falls back to `npm test`. */
  gateScript?: boolean
  /** a test file that fails and imports nothing, so no changed file is related to it. */
  alwaysFailing?: boolean
}

function projectFiles(options: WorldOptions): Record<string, string> {
  const scripts: Record<string, string> = {
    typecheck: 'tsc --noEmit',
    test: 'tsc --noEmit && vitest run',
  }
  if (options.gateScript !== false) scripts.gate = 'tsc --noEmit && vitest related --run --passWithNoTests'
  const files: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'live-fixture', private: true, type: 'module', scripts }, null, 2)}\n`,
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true}}\n',
    'tsconfig.build.json': '{"extends":"./tsconfig.json"}\n',
    'vitest.config.ts': 'export default {}\n',
    'src/math.ts': MATH_OK,
    'src/math.test.ts':
      "import { add } from './math.js'\n\ntest('add', () => {\n  if (add(1, 2) !== 3) throw new Error('add')\n})\n",
    'src/lonely.ts': 'export const lonely = 1\n',
    'src/old.ts': 'export const old = 1\n',
    'CHECKLIST.md': '# Review checklist\n- no secrets in code\n',
    'notes.md': 'original notes\n',
    '.gitignore': 'node_modules/\n',
  }
  if (options.alwaysFailing !== false) files['src/always-fails.test.ts'] = "test('always fails', () => {}) // FAKE_FAIL\n"
  return files
}

interface Edit {
  write?: Record<string, string>
  remove?: string[]
}

function applyEdit(dir: string, edit: Edit): void {
  for (const [name, content] of Object.entries(edit.write ?? {})) put(join(dir, name), content)
  for (const name of edit.remove ?? []) rmSync(join(dir, name), { force: true })
}

interface Call {
  tool: 'tsc' | 'vitest' | 'test-run'
  argv?: string[]
  file?: string
}

let roots: string[] = []
let root = ''
let cards: OwnerCard[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-light-gate-')))
  roots.push(root)
  cards = []
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'npm-cache'))
  put(join(root, 'fake.json'), '{}\n')
  put(join(root, 'bin', 'bwrap'), bwrapScript().replace('@@HOME@@', join(root, 'npm-home')).replace('@@CACHE@@', join(root, 'npm-cache')))
  put(join(root, 'bin', 'tsc'), tscScript(root))
  put(join(root, 'bin', 'vitest'), vitestScript(root))
  for (const name of ['bwrap', 'tsc', 'vitest']) chmodSync(join(root, 'bin', name), 0o755)
  mkdirSync(join(root, 'npm-home'))
  vi.stubEnv('PATH', [join(root, 'bin'), process.env.PATH ?? ''].join(delimiter))
  vi.stubEnv(TIMEOUT_ENV, undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of roots) rmSync(path, { recursive: true, force: true })
  roots = []
})

function calls(): Call[] {
  const file = join(root, 'calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Call)
}

function testsRun(): string[] {
  return calls().filter((call) => call.tool === 'test-run').map((call) => call.file ?? '')
}

interface World {
  evolve: Evolve
  origin: string
}

function makeWorld(options: WorldOptions = {}): World {
  const home = join(root, 'home')
  const live = join(home, 'app')
  const origin = join(root, 'origin')
  mkdirSync(live, { recursive: true })
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  for (const [name, content] of Object.entries(projectFiles(options))) put(join(origin, name), content)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'base')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'remote', 'add', 'origin', origin)
  git(live, 'fetch', '-q', 'origin')
  git(live, 'reset', '-q', '--hard', 'origin/main')
  const evolve = createEvolve({
    home,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' },
    reviewer: async () => JSON.stringify({ verdict: 'approve', summary: 'ok' }),
    card: async (card) => {
      cards.push(card)
    },
    log: () => undefined,
  })
  return { evolve, origin }
}

type Path = 'submit' | 'sync'

interface Outcome {
  passed: boolean
  /** the refusal text of a failed gate, the card text of a passed one */
  text: string
}

async function submitEdit(world: World, edit: Edit): Promise<Outcome> {
  const tools = new Map(world.evolve.tools.map((tool) => [tool.name, tool]))
  const started = String(await tools.get('self_change')?.execute({ description: 'light gate fixture' }))
  const id = /^id:\s*(\S+)/m.exec(started)?.[1]
  const path = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
  if (id === undefined || path === undefined) throw new Error(`self_change gave no candidate: ${started}`)
  applyEdit(path, edit)
  try {
    return { passed: true, text: String(await tools.get('self_submit')?.execute({ id })) }
  } catch (error) {
    return { passed: false, text: error instanceof Error ? error.message : String(error) }
  }
}

async function syncEdit(world: World, edit: Edit): Promise<Outcome> {
  applyEdit(world.origin, edit)
  git(world.origin, 'add', '-A')
  git(world.origin, 'commit', '-q', '-m', 'upstream change')
  const report: SyncReport = await world.evolve.syncMain()
  if (report.state === 'adopted') return { passed: true, text: JSON.stringify(report) }
  expect(report.state, `synchronization must reach the gate: ${JSON.stringify(report)}`).toBe('gate-failed')
  return { passed: false, text: report.error ?? '' }
}

async function runGate(path: Path, edit: Edit, options: WorldOptions = {}): Promise<Outcome> {
  const world = makeWorld(options)
  return path === 'submit' ? submitEdit(world, edit) : syncEdit(world, edit)
}

const RAN_NPM_TEST = /npm test/
const RAN_LIGHT_GATE = /\bgate\b|связанн|related/i

// --- the tests -----------------------------------------------------------------------------------------

test.each(['submit', 'sync'] as const)('c1 c10 a changed module breaks its test: the gate fails with the test output (%s)', async (path) => {
  const outcome = await runGate(path, { write: { 'src/math.ts': MATH_BREAKS_TESTS } })

  expect(outcome.passed, outcome.text).toBe(false)
  expect(outcome.text).toContain('src/math.test.ts')
  expect(outcome.text).toContain('AssertionError')
  expect(outcome.text, 'the unrelated failing test was not part of this run').not.toContain('always-fails')
  expect(testsRun()).toEqual(['src/math.test.ts'])
  expect(outcome.text, 'npm test did not run, so the refusal must not name it').not.toMatch(RAN_NPM_TEST)
  expect(outcome.text).toMatch(RAN_LIGHT_GATE)
})

test('c2 a type error in a changed .ts file fails the gate with the tsc output', async () => {
  const outcome = await runGate('submit', { write: { 'src/math.ts': MATH_TYPE_ERROR } })

  expect(outcome.passed, outcome.text).toBe(false)
  expect(outcome.text).toContain('error TS2322')
  expect(outcome.text).toContain('src/math.ts')
  expect(calls().some((call) => call.tool === 'tsc')).toBe(true)
})

test.each(['submit', 'sync'] as const)('c3 c10 a module no test imports passes: unrelated failing tests are not run (%s)', async (path) => {
  const outcome = await runGate(path, { write: { 'src/lonely.ts': 'export const lonely = 2\n' } })

  expect(outcome.passed, outcome.text).toBe(true)
  expect(testsRun(), 'tests unrelated to the change must not run').not.toContain('src/always-fails.test.ts')
  expect(calls().some((call) => call.tool === 'tsc'), 'the whole tree is still type-checked').toBe(true)
  for (const card of cards) expect(card.text, 'npm test did not run').not.toMatch(RAN_NPM_TEST)
})

test('c4 a candidate that edits its own test file so that it fails does not pass the gate', async () => {
  const outcome = await runGate('submit', {
    write: { 'src/math.test.ts': "import { add } from './math.js'\n\ntest('add', () => { add(1, 2) }) // FAKE_FAIL\n" },
  })

  expect(outcome.passed, outcome.text).toBe(false)
  expect(outcome.text).toContain('src/math.test.ts')
  expect(outcome.text).toContain('AssertionError')
})

test('c5 a deleted file and .md edits do not break the gate: only existing code files go to the related run', async () => {
  const outcome = await runGate('submit', {
    write: {
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b + 0\n',
      'notes.md': 'changed notes\n',
      'docs/guide.md': 'a new guide\n',
    },
    remove: ['src/old.ts'],
  })

  expect(outcome.passed, outcome.text).toBe(true)
  const vitest = calls().filter((call) => call.tool === 'vitest')
  expect(vitest.length, 'the related run happens, the changed module has a test').toBeGreaterThan(0)
  const passed = vitest.flatMap((call) => call.argv ?? [])
  expect(passed.some((arg) => arg.endsWith('src/math.ts'))).toBe(true)
  expect(passed.filter((arg) => arg.endsWith('.md') || arg.endsWith('old.ts'))).toEqual([])
  expect(testsRun()).toEqual(['src/math.test.ts'])
  expect(calls().some((call) => call.tool === 'tsc')).toBe(true)
})

test.each(['vitest.config.ts', 'tsconfig.json', 'tsconfig.build.json'])(
  'c6 a change of %s runs the whole suite: an unrelated failing test fails the gate',
  async (name) => {
    const content = name.endsWith('.ts') ? 'export default { test: {} }\n' : '{"compilerOptions":{"strict":true,"noEmit":true,"skipLibCheck":true}}\n'
    const outcome = await runGate('submit', { write: { [name]: content } })

    expect(outcome.passed, outcome.text).toBe(false)
    expect(outcome.text).toContain('always-fails.test.ts')
    expect(testsRun()).toContain('src/always-fails.test.ts')
  },
)

test.each([
  { alwaysFailing: true, passes: false },
  { alwaysFailing: false, passes: true },
])('c7 c10 without a gate script the gate runs npm test (suite failing: $alwaysFailing)', async ({ alwaysFailing, passes }) => {
  const outcome = await runGate('submit', { write: { 'src/lonely.ts': 'export const lonely = 3\n' } }, { gateScript: false, alwaysFailing })

  expect(outcome.passed, outcome.text).toBe(passes)
  expect(testsRun(), 'npm test runs the whole suite').toContain('src/math.test.ts')
  expect(calls().some((call) => call.tool === 'vitest' && !(call.argv ?? []).includes('related'))).toBe(true)
  if (!passes) {
    expect(outcome.text).toContain('always-fails.test.ts')
    expect(outcome.text, 'the refusal names the check that ran').toMatch(RAN_NPM_TEST)
    expect(outcome.text).not.toMatch(/\brun gate\b/)
  }
})

test('c9 the deadline covers the whole light gate: typecheck plus related tests longer than the limit is refused', async () => {
  vi.stubEnv(TIMEOUT_ENV, '3000')
  // each stage alone fits the limit, together they do not
  put(join(root, 'fake.json'), `${JSON.stringify({ tscSleepMs: 1800, vitestSleepMs: 1800 })}\n`)

  const outcome = await runGate('submit', { write: { 'src/math.ts': 'export const add = (a: number, b: number): number => a + b + 1\n' } })

  expect(outcome.passed, outcome.text).toBe(false)
  expect(outcome.text).toContain(TIMEOUT_ENV)
  expect(outcome.text).toMatch(/тайм.?аут|timed? ?out/i)
})

test('c8 the root package.json gate script: typecheck first, then vitest related in run mode passing without tests', () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  const gate = manifest.scripts?.gate

  expect(typeof gate, 'package.json has a gate script').toBe('string')
  const script = gate ?? ''
  const related = script.search(/\bvitest\s+related\b/)
  expect(related, 'the gate runs vitest related').toBeGreaterThan(0)
  const typecheck = script.search(/\btypecheck\b|\btsc\b/)
  expect(typecheck, 'typecheck comes first').toBeGreaterThanOrEqual(0)
  expect(typecheck).toBeLessThan(related)
  expect(script.slice(typecheck, related), 'typecheck must pass before the related run starts').toContain('&&')
  expect(script.slice(related)).toMatch(/(?:--run\b|\brun\b)/)
  expect(script.slice(related)).toMatch(/--passWithNoTests\b|--pass-with-no-tests\b/)
})

test('c10 the self_submit tool description names the light gate, not only npm test', () => {
  const { evolve } = makeWorld()
  const description = evolve.tools.find((tool) => tool.name === 'self_submit')?.description ?? ''

  expect(description).toMatch(RAN_LIGHT_GATE)
})
