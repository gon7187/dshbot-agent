// Stage-1 runner benchmark: cold start to readiness and RSS after one turn against a
// local Messages API stub, plus the size of the stable prefix of an owner turn.
//
// The prefix is measured on the real request the daemon sends: the full daemon is
// started in this process against a fetch stub (Telegram Bot API and the Messages
// API of the model), an owner message opens one turn, and the first Messages body is
// recorded. The reported sizes are the system prompt (the lazy index included) and
// the JSON of `tools[]`, separately, in bytes with the bytes/4 token estimate
// (docs/DESIGN.md §4 and §9).
//
// `npm run bench:runner` prints the report to stdout, or writes it to `$BENCH_OUT`
// when that variable is set. `npm run bench:write` refreshes the tracked
// `docs/bench/runner.md`. Tests point `BENCH_OUT` at a temporary directory, so no
// test run changes a tracked file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRunner } from '../src/index.js'

const TRACKED_REPORT = fileURLToPath(new URL('../../../docs/bench/runner.md', import.meta.url))

// `--write` is the explicit "refresh the tracked report" mode behind `bench:write`.
// Otherwise `BENCH_OUT` selects a file and an unset variable means stdout.
const writeMode = process.argv.includes('--write')
const benchOut = process.env.BENCH_OUT?.trim()
const target = writeMode ? TRACKED_REPORT : benchOut ? benchOut : undefined

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function pongStream(): string {
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

async function stub(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(pongStream())
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${port}` }
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

// --- the stable prefix of an owner turn ------------------------------------------------------------
//
// The runner alone cannot answer this: the schemas and the lazy index come from
// the daemon's tool registry. One real owner turn of `startDshbot` is measured
// instead. The daemon runs in this process, so the model and Telegram are a
// single `fetch` stub and no port is opened.

/** Fake credentials: the stubs never check them. */
const OWNER_CHAT = 7
const BENCH_BOT_TOKEN = '7000000:AAHbenchFakeTokenNotARealSecret0123456'
const BENCH_DEEPSEEK_KEY = 'sk-dshbot-bench-not-a-real-key'
const BENCH_OWNER_TEXT = 'bench: покажи префикс хода'
const OWNER_KV_KEY = 'telegram.owner_chat_id'
const PREFIX_WAIT_MS = 45_000
const PREFIX_ESTIMATE = 'bytes/4 heuristic, no tokenizer'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

/** The system prompt as the model receives it: text or content blocks joined. */
function systemTextOf(system: unknown): string {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system.map((block) => String(asObject(block).text ?? '')).join('')
}

/** Token estimate of the report: one token per four UTF-8 bytes of Russian and JSON both. */
function estimatedTokens(bytes: number): number {
  return Math.round(bytes / 4)
}

interface PrefixFacts {
  /** Bytes of the system prompt, the lazy index included. */
  systemBytes: number
  /** Bytes of the JSON of `tools[]`. */
  toolsBytes: number
  /** Number of schemas in `tools[]`. */
  tools: number
}

interface StubState {
  queue: JsonObject[]
  wake: (() => void) | undefined
  captured: JsonObject | undefined
  updateId: number
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function messagesResponse(): Response {
  return new Response(pongStream(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/** One fetch stub for both the Telegram Bot API and the Messages API of the model. */
function benchFetch(state: StubState): typeof fetch {
  return async (input, init): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = /\/bot[^/]+\/([A-Za-z]+)\/?$/.exec(url)?.[1] ?? ''
    if (method === 'getMe') return jsonResponse({ ok: true, result: { id: 4242, is_bot: true, username: 'bench_bot' } })
    if (method === 'getUpdates') {
      if (state.queue.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250)
          timer.unref?.()
          state.wake = () => {
            clearTimeout(timer)
            resolve()
          }
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        state.wake = undefined
      }
      return jsonResponse({ ok: true, result: state.queue.splice(0) })
    }
    if (method !== '') return jsonResponse({ ok: true, result: { message_id: 1 } })

    if (!url.split('?')[0]?.endsWith('/messages')) return jsonResponse({ ok: true, result: true })
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as JsonObject) : {}
    if (state.captured === undefined && Array.isArray(body.messages)) state.captured = body
    if (body.stream === false) {
      return jsonResponse({
        id: 'msg_bench',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    return messagesResponse()
  }
}

/**
 * Starts the real daemon in this process, opens one owner turn, and measures the
 * first Messages request. `startRunner` reads `globalThis.fetch` when it is built,
 * so the stub is installed for the whole measurement and restored afterwards.
 */
async function measureOwnerPrefix(): Promise<PrefixFacts> {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-bench-owner-'))
  const dshbotHome = join(scratch, 'dshbot')
  mkdirSync(dshbotHome, { recursive: true })
  const previousFetch = globalThis.fetch
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  process.env.HOME = scratch
  process.env.USERPROFILE = scratch

  const state: StubState = { queue: [], wake: undefined, captured: undefined, updateId: 0 }
  globalThis.fetch = benchFetch(state)
  const { openStore } = await import('../../store/src/index.js')
  const { startDshbot } = await import('../../app/src/index.js')
  // The owner chat is known before the first start: no pairing round.
  const store = openStore(join(dshbotHome, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER_CHAT))
  } finally {
    store.close()
  }

  const bot = await startDshbot({
    dshbotHome,
    telegramBotToken: BENCH_BOT_TOKEN,
    deepseekApiKey: BENCH_DEEPSEEK_KEY,
    telegramApiRoot: 'http://telegram.bench.invalid',
    deepseekBaseUrl: 'http://deepseek.bench.invalid/anthropic',
    fetch: globalThis.fetch,
  })
  try {
    state.updateId += 1
    state.queue.push({
      update_id: state.updateId,
      message: {
        message_id: state.updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
        from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
        text: BENCH_OWNER_TEXT,
      },
    })
    state.wake?.()
    const started = Date.now()
    while (state.captured === undefined && Date.now() - started < PREFIX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    if (state.captured === undefined) throw new Error('the owner turn never reached the model')
    const system = systemTextOf(state.captured.system)
    const tools = state.captured.tools
    return {
      systemBytes: Buffer.byteLength(system, 'utf8'),
      toolsBytes: Buffer.byteLength(JSON.stringify(tools ?? []), 'utf8'),
      tools: Array.isArray(tools) ? tools.length : 0,
    }
  } finally {
    await bot.stop(0)
    globalThis.fetch = previousFetch
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previousProfile
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { server, origin } = await stub()
  const scratch = mkdtempSync(join(tmpdir(), 'runner-bench-'))
  const dshHome = join(scratch, 'dsh')
  const cwd = join(scratch, 'cwd')
  mkdirSync(cwd, { recursive: true })

  let runner: Awaited<ReturnType<typeof startRunner>> | undefined
  try {
    runner = await startRunner({
      dshHome,
      cwd,
      baseUrl: `${origin}/anthropic`,
      apiKey: 'bench-key-not-real',
      systemPrefix: 'You are DSHBOT.',
    })
    const coldStartMs = process.uptime() * 1000

    const promptStart = performance.now()
    const reply = await runner.prompt('ping')
    const promptMs = performance.now() - promptStart
    if (!reply.includes('pong')) throw new Error(`unexpected reply: ${JSON.stringify(reply)}`)

    const rss = process.memoryUsage()
    const prefix = await measureOwnerPrefix()
    const prefixBytes = prefix.systemBytes + prefix.toolsBytes
    const report = [
      '# Runner bench',
      '',
      'Stage-1 prototype: `startRunner` on the minimal DeepSeek Harness plugin set,',
      'measured against a local DeepSeek Messages API stub (SSE, `pong`) on 127.0.0.1.',
      'The model never leaves the machine and no real key is used.',
      '',
      `- Cold start to readiness: ${coldStartMs.toFixed(0)} ms`,
      `- First prompt (ping to reply): ${promptMs.toFixed(0)} ms`,
      `- RSS after one turn: ${megabytes(rss.rss)} MB`,
      `  - heapUsed: ${megabytes(rss.heapUsed)} MB`,
      `  - external: ${megabytes(rss.external)} MB`,
      '',
      'The size of the stable prefix of an owner turn (`docs/DESIGN.md` §4 and §9): the full daemon',
      '(`startDshbot`) runs in this process against a fetch stub, one owner message opens a turn, and the',
      'first Messages request is measured. Bytes are UTF-8 bytes of the system prompt and of the JSON of',
      '`tools[]`; the token count is the bytes/4 heuristic, not a tokenizer.',
      '',
      `- Prefix: ${prefixBytes} bytes, ~${estimatedTokens(prefixBytes)} tokens (${PREFIX_ESTIMATE})`,
      `- System: ${prefix.systemBytes} bytes, ~${estimatedTokens(prefix.systemBytes)} tokens (${PREFIX_ESTIMATE})`,
      `- Tools: ${prefix.toolsBytes} bytes, ~${estimatedTokens(prefix.toolsBytes)} tokens (${PREFIX_ESTIMATE})`,
      `- Tools in tools[]: ${prefix.tools} (the rest is reached through tool_search)`,
      '',
      'For comparison, OpenClaw holds about 580 MB RSS and ~20k tokens of tool schemas.',
      '',
      'Measured by `npm run bench:runner` on Node ' + process.version + '.',
      '',
    ].join('\n')

    if (target === undefined) {
      process.stdout.write(report)
      console.error(`bench:runner cold start ${coldStartMs.toFixed(0)} ms, RSS ${megabytes(rss.rss)} MB (stdout)`)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, report, 'utf8')
      console.log(
        `bench:runner cold start ${coldStartMs.toFixed(0)} ms, RSS ${megabytes(rss.rss)} MB -> ${target}`,
      )
    }
  } finally {
    await runner?.stop()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(scratch, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(`bench:runner failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
})
