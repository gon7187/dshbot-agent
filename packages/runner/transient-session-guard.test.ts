// A transient runner session is deleted with rmSync after its turn, so its id must never be able to
// name the owner's history, a guest or child session, or anything outside the sessions directory.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href

const CHILD_TIMEOUT_MS = 60_000
const RESULT_MARK = '@@TRANSIENT-RESULT@@'
const KEEP_FILE = 'keep.txt'
const KEEP_TEXT = 'must survive'
const OWNER_TEXT = 'owner history marker'
const GUEST_TEXT = 'guest history marker'

// --- local stub of the DeepSeek Messages API -----------------------------------------------

interface Stub {
  server: Server
  origin: string
  bodies: string[]
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function pongStream(): string {
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function pongMessage(): string {
  return JSON.stringify({
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'pong' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 },
  })
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function startStub(): Promise<Stub> {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      bodies.push(raw)
      let streaming = true
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && (parsed as { stream?: unknown }).stream === false) streaming = false
      } catch {
        streaming = true
      }
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(pongMessage())
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(pongStream())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}`, bodies }
}

// --- child process driver ------------------------------------------------------------------

// Resolves './x.js' specifiers to './x.ts' so Node can run the TypeScript sources of the repo directly.
const HOOKS_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && /^\\.\\.?\\/.*\\.js$/.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

const REGISTER_SOURCE = `
import { register } from 'node:module'
register('./hooks.mjs', import.meta.url)
`

// Opens the owner session and one real guest session, plants files for the ids under attack, then asks
// for a transient turn on each attempted id and reports whether the call was refused.
const DRIVER_SOURCE = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT',
  })
  await runner.prompt(cfg.ownerText)
  await runner.prompt(cfg.guestText, { sessionId: 'guest-555', principal: 'guest' })
  for (const dir of cfg.plant) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, cfg.keepFile), cfg.keepText)
  }
  const results = []
  for (const attempt of cfg.attempts) {
    try {
      const outcome = await runner.promptTurn(attempt.text, { sessionId: attempt.id, transient: true })
      results.push({ id: attempt.id, refused: false, text: outcome.text })
    } catch (error) {
      results.push({ id: attempt.id, refused: true, error: String(error && error.message ? error.message : error) })
    }
  }
  await runner.stop()
  report({ results })
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
  setTimeout(() => process.exit(1), 2000).unref()
}
`

interface Attempt {
  id: string
  text: string
}

interface AttemptResult {
  id: string
  refused: boolean
  text?: string
  error?: string
}

interface ChildReport {
  results?: AttemptResult[]
  error?: string
}

interface ChildRun {
  report: ChildReport | undefined
  output: string
}

let scratch: string
let stub: Stub
let tmpHome: string
let dshHome: string
let workDir: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'transient-guard-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(async () => {
  stub = await startStub()
  tmpHome = mkdtempSync(join(scratch, 'home-'))
  dshHome = join(mkdtempSync(join(scratch, 'dsh-')), 'state')
  workDir = mkdtempSync(join(scratch, 'cwd-'))
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    stub.server.closeAllConnections()
    stub.server.close(() => resolve())
  })
})

function sessionsDir(): string {
  return join(dshHome, 'sessions')
}

function attemptsFor(ids: string[]): Attempt[] {
  return ids.map((id, index) => ({ id, text: `TRANSIENT-ATTEMPT-${index}-QUESTION` }))
}

/** Directories planted with a keep file before the attempts; `.` and `..` already hold real data. */
function plantedDirs(ids: string[], extra: string[] = []): string[] {
  const dirs = ids.filter((id) => id !== '.' && id !== '..').map((id) => join(sessionsDir(), id))
  return [...dirs, ...extra]
}

function runChild(attempts: Attempt[], plant: string[]): Promise<ChildRun> {
  const cfg = {
    dshHome,
    cwd: workDir,
    baseUrl: `${stub.origin}/anthropic`,
    ownerText: OWNER_TEXT,
    guestText: GUEST_TEXT,
    attempts,
    plant,
    keepFile: KEEP_FILE,
    keepText: KEEP_TEXT,
    entry: runnerEntry,
  }
  const env: Record<string, string> = { HOME: tmpHome, USERPROFILE: tmpHome, PATH: process.env.PATH ?? '' }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const args = [
    '--import',
    pathToFileURL(join(scratch, 'register.mjs')).href,
    join(scratch, 'driver.mjs'),
    JSON.stringify(cfg),
  ]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS - 5_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((l) => l.startsWith(RESULT_MARK))
      resolve({
        report: line ? (JSON.parse(line.slice(RESULT_MARK.length)) as ChildReport) : undefined,
        output: `${stdout}\n${stderr}`.slice(-4000),
      })
    })
  })
}

function resultsOf(run: ChildRun): AttemptResult[] {
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report?.results, run.output).toBeDefined()
  return run.report?.results ?? []
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(full))
    else found.push(full)
  }
  return found
}

/** True when some file of the session directory holds the text. */
function sessionHolds(id: string, text: string): boolean {
  return filesUnder(join(sessionsDir(), id)).some((file) => statSync(file).size > 0 && readFileSync(file, 'utf8').includes(text))
}

function expectRefusedBeforeOpening(results: AttemptResult[], attempts: Attempt[]): void {
  expect(results).toHaveLength(attempts.length)
  for (const result of results) expect(result.refused, `transient turn on "${result.id}" must be refused`).toBe(true)
  // Refused before the session is opened: the model never saw any of the attempted questions.
  for (const attempt of attempts) {
    expect(stub.bodies.some((body) => body.includes(attempt.text)), `"${attempt.id}" reached the model`).toBe(false)
  }
}

function expectKeepFiles(dirs: string[]): void {
  for (const dir of dirs) {
    const keep = join(dir, KEEP_FILE)
    expect(existsSync(keep), `${keep} was deleted`).toBe(true)
    expect(readFileSync(keep, 'utf8')).toBe(KEEP_TEXT)
  }
}

// --- tests ---------------------------------------------------------------------------------

test('test_c1_transient turn on the id main is refused and the owner history stays', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const ids = ['main']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, [join(sessionsDir(), 'main')])
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)
  expect(existsSync(join(sessionsDir(), 'main'))).toBe(true)
  expectKeepFiles([join(sessionsDir(), 'main')])
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
})

test('test_c2_transient turn on an id with dots, slashes or foreign characters is refused and nothing outside is deleted', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const ids = ['..', '.', '../victim', '../../escape', 'a/b', 'side-question/../main', '..\\up', 'a\\b', 'bad id', 'id;x', 'ünï', 'side:question']
  // Made of allowed characters only, yet they carry "..": nothing is planted, so a missing guard would answer and delete them.
  const dotted = ['a..b', '...', 'side-question..']
  const attempts = attemptsFor([...ids, ...dotted])
  const run = await runChild(attempts, plantedDirs(ids, [join(dshHome, 'victim')]))
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)

  // The state directory and its siblings of sessions are intact.
  expect(existsSync(dshHome), 'DSHBOT_HOME was deleted').toBe(true)
  expect(existsSync(sessionsDir()), 'sessions directory was deleted').toBe(true)
  expectKeepFiles(plantedDirs(ids, [join(dshHome, 'victim')]))
  // Neither the owner nor the guest session lost their history.
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
})

test('test_c3_transient turn on a guest or child session id is refused and their directories stay', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const ids = ['guest-555', 'guest-777', 'guest--1001234', 'subagent-abc', 'subagent-1700000000-1']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, plantedDirs(ids))
  const results = resultsOf(run)

  expectRefusedBeforeOpening(results, attempts)
  for (const id of ids) expect(existsSync(join(sessionsDir(), id)), `${id} directory was deleted`).toBe(true)
  expectKeepFiles(plantedDirs(ids))
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
})

test('test_c4_transient turn on a valid side question id answers and leaves no session directory', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const ids = ['side-question-abc', 'side_question.1-X']
  const attempts = attemptsFor(ids)
  const run = await runChild(attempts, [])
  const results = resultsOf(run)

  expect(results).toHaveLength(ids.length)
  for (const result of results) {
    expect(result.refused, `"${result.id}" was refused: ${result.error ?? ''}`).toBe(false)
    expect(result.text).toContain('pong')
    expect(existsSync(join(sessionsDir(), result.id)), `${result.id} directory is left behind`).toBe(false)
  }
  for (const attempt of attempts) {
    expect(stub.bodies.some((body) => body.includes(attempt.text)), `"${attempt.id}" never reached the model`).toBe(true)
  }
  // The deletion touches only the transient session.
  expect(existsSync(sessionsDir())).toBe(true)
  expect(sessionHolds('main', OWNER_TEXT), 'owner history was lost').toBe(true)
  expect(sessionHolds('guest-555', GUEST_TEXT), 'guest history was lost').toBe(true)
})
