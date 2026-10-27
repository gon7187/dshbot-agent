// Full-daemon benchmark: the real daemon (packages/app/src/main.ts) runs as a child process of this
// script against a fake Telegram Bot API and a fake DeepSeek Messages API, both on 127.0.0.1. No real key
// and no network: the daemon gets its environment from scratch, nothing of the parent's secrets leaks in.
//
// Measured: cold start to the first getUpdates; RSS of the daemon process at idle and after the owner's
// turns; the overhead of a turn without the model (inbound: update handed out by the fake Telegram -> model
// request arrives; outbound: model answer ends -> first Telegram call with its text); the size of the stable
// prefix (system and tools[]) of the first model request of an owner turn; model calls during idle ticks.
//
// `npm run bench:daemon` prints the report lines to stdout, or writes a markdown report to `$BENCH_OUT` when
// that variable is set. `npm run bench:daemon:write` refreshes the tracked `docs/bench/daemon.md`.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type JsonObject = Record<string, unknown>

const root = fileURLToPath(new URL('../../..', import.meta.url))
const TRACKED_REPORT = join(root, 'docs/bench/daemon.md')
const DAEMON_MAIN = join(root, 'packages/app/src/main.ts')
const DAEMON_REGISTER = join(root, 'packages/app/register.mjs')

// Fake credentials: the daemon only needs them to be present, the stubs check the Telegram one.
const BOT_TOKEN = '7000002:AAHbenchFakeTokenNotARealSecret0123456'
const DEEPSEEK_KEY = 'sk-dshbot-bench-not-a-real-key'
const OWNER_CHAT = 7
const TURNS = 20
// The schedule ticker ticks every second by default: ten ticks with nothing due.
const IDLE_WINDOW_MS = 10_000
const SETTLE_MS = 1_000
// A turn starts background work (the experience review) right after its answer. The daemon reports the
// end of the turn through the test seam, so the idle window opens on that event, not on a quiet window.
const TURN_EVENTS_ENV = 'DSHBOT_TEST_TURN_EVENTS'
const TURN_COMPLETE_RE = /^(?:\[dshbot\] )?test:turn-complete(?:\s|$)/
const POLL_HOLD_MS = 20_000
const WAIT_MS = 30_000
const STOP_MS = 10_000

// `--write` is the explicit "refresh the tracked report" mode behind `bench:daemon:write`.
// Otherwise `BENCH_OUT` selects a file and an unset variable means stdout.
const writeMode = process.argv.includes('--write')
const benchOut = process.env.BENCH_OUT?.trim()
const target = writeMode ? TRACKED_REPORT : benchOut ? benchOut : undefined

interface Turn {
  n: number
  marker: string
  answer: string
  updateAt?: number
  modelAt?: number
  modelDoneAt?: number
  sentAt?: number
  prefixBytes?: number
}

interface Recorder {
  turns: Turn[]
  /** The turn in flight: its marker tells the model requests and the answers apart. */
  current?: Turn
  modelCalls: number[]
  calls: Array<{ method: string; params: JsonObject }>
  firstPollAt?: number
}

interface Stub {
  origin: string
  close(): Promise<void>
}

interface TelegramStub extends Stub {
  push(text: string, turn?: Turn): void
}

interface Daemon {
  child: ChildProcess
  pid: number
  stderr: string
  exited: boolean
  exit: Promise<void>
}

/** Completed turns reported by the test seam in the journal of the daemon. */
function turnCompletions(daemon: Daemon): number {
  let count = 0
  for (const line of daemon.stderr.split('\n')) if (TURN_COMPLETE_RE.test(line.trim())) count += 1
  return count
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function parseObject(raw: string): JsonObject {
  try {
    return asObject(JSON.parse(raw))
  } catch {
    return {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const done = (): void => resolve(Buffer.concat(chunks).toString('utf8'))
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', done)
    req.on('error', done)
  })
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}

function newRecorder(): Recorder {
  return { turns: [], modelCalls: [], calls: [] }
}

// --- fake Telegram Bot API -----------------------------------------------------------------------

function telegramResult(method: string, params: JsonObject, id: number): unknown {
  if (method === 'getMe') return { id: 4242, is_bot: true, first_name: 'DSHBOT', username: 'dshbot_bench_bot' }
  if (method === 'sendMessage' || method === 'sendRichMessage') {
    return {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: params.chat_id ?? OWNER_CHAT, type: 'private' },
      text: typeof params.text === 'string' ? params.text : '',
    }
  }
  return true
}

async function startTelegram(rec: Recorder): Promise<TelegramStub> {
  const queue: Array<{ update: JsonObject; turn?: Turn }> = []
  let held: { res: ServerResponse; timer: NodeJS.Timeout } | undefined
  let nextUpdateId = 1000
  let sent = 0

  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  // An update leaves the stub when a long poll is waiting for it: that moment starts the inbound overhead.
  const release = (): void => {
    if (held === undefined || queue.length === 0) return
    const { res, timer } = held
    held = undefined
    clearTimeout(timer)
    const batch = queue.splice(0)
    const at = performance.now()
    for (const { turn } of batch) if (turn !== undefined) turn.updateAt = at
    reply(res, 200, { ok: true, result: batch.map((item) => item.update) })
  }

  const server = createServer((req, res) => {
    const at = performance.now()
    void readBody(req).then((raw) => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec((req.url ?? '').split('?')[0] ?? '')
      if (match === null || decodeURIComponent(match[1] ?? '') !== BOT_TOKEN) {
        reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' })
        return
      }
      const method = match[2] ?? ''
      if (method === 'getUpdates') {
        rec.firstPollAt ??= at
        if (held !== undefined) {
          clearTimeout(held.timer)
          reply(held.res, 200, { ok: true, result: [] })
        }
        const timer = setTimeout(() => {
          held = undefined
          reply(res, 200, { ok: true, result: [] })
        }, POLL_HOLD_MS)
        held = { res, timer }
        res.on('close', () => {
          if (held?.res === res) {
            clearTimeout(held.timer)
            held = undefined
          }
        })
        release()
        return
      }

      const params = parseObject(raw)
      rec.calls.push({ method, params })
      const turn = rec.current
      if (turn !== undefined && turn.sentAt === undefined && turn.modelAt !== undefined && raw.includes(turn.answer)) {
        turn.sentAt = at
      }
      sent += 1
      reply(res, 200, { ok: true, result: telegramResult(method, params, sent) })
    })
  })
  const origin = await listen(server)

  return {
    origin,
    push(text, turn) {
      nextUpdateId += 1
      const update: JsonObject = {
        update_id: nextUpdateId,
        message: {
          message_id: nextUpdateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: OWNER_CHAT, type: 'private', first_name: 'Owner' },
          from: { id: OWNER_CHAT, is_bot: false, first_name: 'Owner' },
          text,
        },
      }
      queue.push({ update, turn })
      release()
    },
    async close() {
      if (held !== undefined) clearTimeout(held.timer)
      held = undefined
      await closeServer(server)
    },
  }
}

// --- fake DeepSeek Messages API ------------------------------------------------------------------

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function textStream(text: string): string {
  return [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_bench',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function messageJson(text: string): JsonObject {
  return {
    id: 'msg_bench',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

/** Bytes of the stable prefix as the stub received it: the system text and the JSON of tools[]. */
function prefixBytes(body: JsonObject): number {
  const system =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((block) => String(asObject(block).text ?? '')).join('')
        : ''
  return Buffer.byteLength(system, 'utf8') + Buffer.byteLength(JSON.stringify(body.tools ?? []), 'utf8')
}

async function startDeepseek(rec: Recorder): Promise<Stub> {
  const server = createServer((req, res) => {
    const at = performance.now()
    void readBody(req).then((raw) => {
      if (req.method !== 'POST' || !(req.url ?? '').split('?')[0]?.endsWith('/messages')) {
        res.writeHead(404)
        res.end()
        return
      }
      rec.modelCalls.push(at)
      const body = parseObject(raw)
      const turn = rec.current !== undefined && raw.includes(rec.current.marker) ? rec.current : undefined
      if (turn !== undefined && turn.modelAt === undefined) {
        turn.modelAt = at
        turn.prefixBytes = prefixBytes(body)
      }
      const text = turn?.answer ?? 'pong'
      // The outbound interval starts once the whole reply has been handed to the socket.
      const done = (): void => {
        if (turn !== undefined && turn.modelDoneAt === undefined) turn.modelDoneAt = performance.now()
      }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(messageJson(text)), done)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(textStream(text), done)
    })
  })
  const origin = await listen(server)
  return { origin, close: () => closeServer(server) }
}

// --- the daemon as a child process ---------------------------------------------------------------

function startDaemon(env: NodeJS.ProcessEnv): Daemon {
  const child = spawn(process.execPath, ['--import', pathToFileURL(DAEMON_REGISTER).href, DAEMON_MAIN], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (child.pid === undefined) throw new Error('the daemon process did not start')
  const daemon: Daemon = {
    child,
    pid: child.pid,
    stderr: '',
    exited: false,
    exit: new Promise<void>((resolve) => {
      child.once('exit', () => {
        daemon.exited = true
        resolve()
      })
    }),
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  return daemon
}

async function stopDaemon(daemon: Daemon): Promise<void> {
  if (daemon.exited) return
  daemon.child.kill('SIGTERM')
  const timer = setTimeout(() => daemon.child.kill('SIGKILL'), STOP_MS)
  await daemon.exit
  clearTimeout(timer)
}

async function waitFor<T>(what: string, read: () => T | undefined, daemon: Daemon): Promise<T> {
  const started = performance.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (daemon.exited) throw new Error(`the daemon exited while waiting for ${what}\n${daemon.stderr.slice(-3000)}`)
    if (performance.now() - started > WAIT_MS) {
      throw new Error(`timed out waiting for ${what}\n${daemon.stderr.slice(-3000)}`)
    }
    await sleep(5)
  }
}

/** Resident set size of one process in MB: `/proc` on Linux, `ps` where `/proc` is missing. */
function rssMb(pid: number): number {
  const status = `/proc/${pid}/status`
  if (existsSync(status)) {
    const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(readFileSync(status, 'utf8'))
    if (match !== null) return Number(match[1]) / 1024
  }
  const ps = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
  const kb = Number(ps.stdout.trim())
  if (!(kb > 0)) throw new Error(`no RSS for process ${pid}`)
  return kb / 1024
}

function ownerMessages(rec: Recorder): number {
  return rec.calls.filter((call) => (call.method === 'sendMessage' || call.method === 'sendRichMessage') && call.params.chat_id === OWNER_CHAT).length
}

async function pairOwner(rec: Recorder, telegram: TelegramStub, daemon: Daemon): Promise<void> {
  telegram.push('hello')
  const code = await waitFor(
    'the pairing code in the daemon journal',
    () => {
      const found = /pairing code for private chat \d+: (\S+)/.exec(daemon.stderr)
      return found !== null && ownerMessages(rec) > 0 ? found[1] : undefined
    },
    daemon,
  )
  const before = ownerMessages(rec)
  telegram.push(code)
  await waitFor('the pairing confirmation', () => (ownerMessages(rec) > before ? true : undefined), daemon)
}

async function ownerTurn(rec: Recorder, telegram: TelegramStub, daemon: Daemon, n: number): Promise<void> {
  const pad = String(n).padStart(2, '0')
  const turn: Turn = { n, marker: `bench-turn-${pad}`, answer: `answer-${pad}-ok` }
  const turnsBefore = turnCompletions(daemon)
  rec.turns.push(turn)
  rec.current = turn
  telegram.push(`${turn.marker} ping`, turn)
  await waitFor(`the answer of turn ${n}`, () => turn.sentAt, daemon)
  // The seam fires after the last send of the turn and after its background
  // model work (the promised-work nudge), so the next turn or the idle window
  // may start at once instead of after a quiet window.
  await waitFor(`the end of turn ${n}`, () => turnCompletions(daemon) > turnsBefore || undefined, daemon)
  rec.current = undefined
}

function span(from: number | undefined, to: number | undefined): number {
  if (from === undefined || to === undefined) throw new Error('a turn left no timestamp')
  return to - from
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function daemonEnv(paths: { home: string; dshbotHome: string; runtimeDir: string }, telegramRoot: string, deepseekRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_RUNTIME_DIR: paths.runtimeDir,
    NO_COLOR: '1',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_API_ROOT: telegramRoot,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DEEPSEEK_BASE_URL: deepseekRoot,
    DSHBOT_HOME: paths.dshbotHome,
    // The bench waits for the end-of-turn event instead of a quiet window.
    [TURN_EVENTS_ENV]: '1',
    // One message per turn: the 0.3 s debounce series would only slow every turn.
    DSHBOT_DEBOUNCE_MS: '0',
  }
}

async function measure(rec: Recorder, telegram: TelegramStub, deepseekOrigin: string, scratch: string): Promise<string[]> {
  const paths = { home: join(scratch, 'home'), dshbotHome: join(scratch, 'dsh'), runtimeDir: join(scratch, 'run') }
  mkdirSync(paths.home, { recursive: true })
  mkdirSync(paths.runtimeDir, { recursive: true })
  const spawnedAt = performance.now()
  const daemon = startDaemon(daemonEnv(paths, telegram.origin, `${deepseekOrigin}/anthropic`))
  try {
    const firstPollAt = await waitFor('the first getUpdates', () => rec.firstPollAt, daemon)
    const coldStartMs = firstPollAt - spawnedAt
    await pairOwner(rec, telegram, daemon)
    await sleep(SETTLE_MS)
    const idleMb = rssMb(daemon.pid)

    for (let n = 1; n <= TURNS; n += 1) await ownerTurn(rec, telegram, daemon, n)
    const lastAnswer = rec.turns.at(-1)?.sentAt ?? 0
    const background = rec.modelCalls.filter((at) => at >= lastAnswer).length
    const turnsMb = rssMb(daemon.pid)

    const idleStart = performance.now()
    await sleep(IDLE_WINDOW_MS)
    const idleCalls = rec.modelCalls.filter((at) => at >= idleStart).length

    const inbound = rec.turns.map((t) => span(t.updateAt, t.modelAt))
    const outbound = rec.turns.map((t) => span(t.modelDoneAt, t.sentAt))
    const prefix = rec.turns[0]?.prefixBytes
    if (prefix === undefined) throw new Error('the first owner turn never reached the model')
    const tokens = Math.round(prefix / 4)

    return [
      `Cold start to first getUpdates: ${Math.round(coldStartMs)} ms`,
      `RSS idle: ${idleMb.toFixed(1)} MB`,
      `RSS after ${TURNS} turns: ${turnsMb.toFixed(1)} MB`,
      `Turn overhead inbound: median ${median(inbound).toFixed(1)} ms, p95 ${percentile(inbound, 95).toFixed(1)} ms`,
      `Turn overhead outbound: median ${median(outbound).toFixed(1)} ms, p95 ${percentile(outbound, 95).toFixed(1)} ms`,
      `Prefix: ${prefix} bytes, ~${tokens} tokens (bytes/4 heuristic, no tokenizer)`,
      `Background model calls after the last turn: ${background}`,
      `Model calls in ${IDLE_WINDOW_MS / 1000} idle schedule ticks: ${idleCalls}`,
    ]
  } finally {
    await stopDaemon(daemon)
  }
}

function gitCommit(): string {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return head.status === 0 ? head.stdout.trim() : 'unknown'
}

function markdownReport(lines: string[]): string {
  return [
    '# Daemon bench',
    '',
    'The full daemon (`packages/app/src/main.ts`) as a child process against a fake Telegram Bot API and a fake',
    'DeepSeek Messages API on 127.0.0.1. The model never leaves the machine and no real key is used.',
    '',
    ...lines.map((line) => `- ${line}`),
    '',
    `Measured by \`npm run ${writeMode ? 'bench:daemon:write' : 'bench:daemon'}\` on Node ${process.version} at commit ${gitCommit()}.`,
    '',
  ].join('\n')
}

function emit(lines: string[]): void {
  if (target === undefined) {
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, markdownReport(lines), 'utf8')
  console.log(`bench:daemon report -> ${target}`)
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-bench-'))
  const rec = newRecorder()
  const telegram = await startTelegram(rec)
  const deepseek = await startDeepseek(rec)
  try {
    emit(await measure(rec, telegram, deepseek.origin, scratch))
  } finally {
    await Promise.all([telegram.close(), deepseek.close()])
    rmSync(scratch, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(`bench:daemon failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
})
