// The secret of a browser `type`/`fill`, `press` or `select` must not survive in the durable session
// log. The harness records the model's tool-call arguments before the tool runs,
// so the page cannot be asked whether the field is a password yet: the runner
// masks each value-bearing browser argument in its own session events.
//
// This test goes through the real runner and the real harness tool path in a
// child process (the runner's `.js` specifiers need the hook below) with a real
// browser and a local page, and reads the events.jsonl the runner wrote. It
// also proves the value was actually typed: the server receives it in the form.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const runnerEntry = pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href
const browserEntry = pathToFileURL(join(repoRoot, 'packages/tools-browser/src/index.ts')).href

const CHILD_TIMEOUT_MS = 120_000
const RESULT_MARK = '@@BROWSER-SECRETS-RESULT@@'
const PASSWORD = 'hunter2-Zq81xV-pass'
const PAGE_MARK = 'BROWSER-SECRETS-PAGE-7719'
const CARD_MONTH = 'card-month-value-Qm71Jz'
const CARD_NAME = 'card-name-value-Hk82Wv'
const MODIFIED_KEYS = ['Shift+X', 'Shift+Space', 'Alt+Shift+Q']
type Scenario = 'type' | 'modified_password' | 'card_controls'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

function findBrowser(): string | undefined {
  const fromEnv = process.env.DSHBOT_BROWSER_PATH
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
    }
  }
  return undefined
}

const chromium = findBrowser()
const realBrowser = chromium !== undefined && process.platform === 'linux'
const withBrowser = test.skipIf(!realBrowser)

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startStream(): string {
  return sse('message_start', {
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
  })
}

function textStream(text: string): string {
  return [
    startStream(),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

function toolUseStream(id: string, input: JsonObject): string {
  return [
    startStream(),
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'browser', input: {} },
    }),
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => (typeof block === 'string' ? block : String(asObject(block).text ?? '')))
    .join('')
}

function lastIsToolResult(body: JsonObject): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const content = asObject(messages[messages.length - 1]).content
  return Array.isArray(content) && content.some((block) => asObject(block).type === 'tool_result')
}

function lastToolResultText(body: JsonObject): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const content = asObject(messages[messages.length - 1]).content
  if (!Array.isArray(content)) return ''
  const result = content.map((block) => asObject(block)).find((block) => block.type === 'tool_result')
  return result === undefined ? '' : blockText(result.content)
}

let step = 0
let scenario: Scenario = 'type'
let pendingCalls: JsonObject[] = []
let toolResults: string[] = []

function refOf(result: string, name: string): string {
  const line = result.split('\n').find((candidate) => candidate.includes(name) && /\bref=/.test(candidate))
  const ref = line === undefined ? undefined : /\bref[=:]\s*"?([A-Za-z0-9_.-]+)/.exec(line)?.[1]
  if (ref === undefined) throw new Error(`Missing ref for ${name}: ${result}`)
  return ref
}

/** One stub of the model and the application page: the same loopback server answers both. */
async function answerModel(body: JsonObject): Promise<string> {
  if (!lastIsToolResult(body)) {
    step += 1
    return toolUseStream(`toolu_browser_open_${step}`, {
      action: 'open', url: `${origin}/${scenario === 'card_controls' ? 'card' : 'pw'}`,
    })
  }
  const result = lastToolResultText(body)
  toolResults.push(result)
  if (step === 1) {
    step = 2
    return toolUseStream('toolu_browser_snapshot', { action: 'snapshot' })
  }
  if (step === 2) {
    if (scenario === 'type') {
      pendingCalls = [{ action: 'type', ref: refOf(result, 'Password'), text: PASSWORD, submit: true }]
    } else if (scenario === 'modified_password') {
      pendingCalls = [
        { action: 'click', ref: refOf(result, 'Password') },
        ...MODIFIED_KEYS.map((key) => ({ action: 'press', key })),
        { action: 'click', ref: refOf(result, 'Send password') },
      ]
    } else {
      pendingCalls = [
        { action: 'select', ref: refOf(result, 'Expiry month'), value: CARD_MONTH },
        { action: 'snapshot' },
        { action: 'fill', ref: refOf(result, 'Cardholder name'), text: CARD_NAME },
        { action: 'snapshot' },
        { action: 'click', ref: refOf(result, 'Send card') },
      ]
    }
  }
  const next = pendingCalls.shift()
  if (next !== undefined) return toolUseStream(`toolu_browser_${++step}`, next)
  return textStream('готово')
}

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

// The browser tool is made core (`lazy: false`) for this probe: the secret
// lives in the harness path, not in the tool_search activation, and the stub
// model calls the tool directly.
const DRIVER_SOURCE = `
const cfg = JSON.parse(process.argv[2])
const report = (extra) => console.log('${RESULT_MARK}' + JSON.stringify(extra))
let browser
const approvals = []
try {
  const { startRunner } = await import(cfg.runnerEntry)
  const { createBrowserTools } = await import(cfg.browserEntry)
  browser = createBrowserTools({
    home: cfg.browserHome,
    browserPath: cfg.browserPath,
    allowLocalOrigins: [cfg.allowLocal],
    approval: async (request) => {
      approvals.push(request)
      return cfg.decision
    },
  })
  const tools = browser.tools.map((tool) => ({ ...tool, lazy: false }))
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: 'test-key-not-real',
    systemPrefix: 'Ты — тестовый помощник DSHBOT',
    tools,
  })
  const reply = await runner.prompt(cfg.prompt)
  report({ reply, approvals })
  await runner.stop()
} catch (error) {
  report({ error: String(error && error.stack ? error.stack : error) })
  process.exitCode = 1
} finally {
  if (browser) await browser.stop().catch(() => undefined)
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref()
}
`

interface ChildRun {
  report: JsonObject | undefined
  output: string
  dshHome: string
}

let scratch: string
let server: Server
let origin: string
let bodies: string[]

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'browser-session-secrets-'))
  writeFileSync(join(scratch, 'hooks.mjs'), HOOKS_SOURCE)
  writeFileSync(join(scratch, 'register.mjs'), REGISTER_SOURCE)
  writeFileSync(join(scratch, 'driver.mjs'), DRIVER_SOURCE)
  bodies = []
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'POST' && (path ?? '').endsWith('/messages')) {
        let parsed: JsonObject = {}
        try {
          parsed = asObject(JSON.parse(body))
        } catch {
          parsed = {}
        }
        if (parsed.stream === false) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'msg_stub',
              type: 'message',
              role: 'assistant',
              model: 'deepseek-flash',
              content: [{ type: 'text', text: 'готово' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 1 },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        void answerModel(parsed).then((stream) => res.end(stream))
        return
      }
      if (path === '/pw-result' || path === '/card-result') {
        bodies.push(body)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        // The result deliberately echoes inputs: output redaction is observable.
        res.end(`<!doctype html><html><head><title>Done</title></head><body><h1>Form result</h1><p>${body}</p></body></html>`)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (path === '/card') {
        res.end(
          `<!doctype html><html><head><title>Card page</title></head><body>` +
          `<form method="post" action="/card-result">` +
          `<label for="month">Expiry month</label><select id="month" name="month" autocomplete="section-payment cc-exp-month">` +
          `<option value="">Choose month</option><option value="${CARD_MONTH}">July</option></select>` +
          `<label for="holder">Cardholder name</label><textarea id="holder" name="holder" autocomplete="cc-name"></textarea>` +
          `<button type="submit">Send card</button></form></body></html>`,
        )
        return
      }
      res.end(
        `<!doctype html><html><head><title>Password page</title></head><body>` +
          `<h1>${PAGE_MARK}</h1>` +
          `<form method="post" action="/pw-result">` +
          `<label for="pw">Password</label><input id="pw" name="pw" type="password">` +
          `<button type="submit">Send password</button>` +
          `</form></body></html>`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  rmSync(scratch, { recursive: true, force: true })
})

function wrappedChromium(): string {
  const path = join(scratch, `chromium-${Math.random().toString(36).slice(2)}`)
  writeFileSync(path, `#!/bin/sh\nEXTRA=""\n[ "$(id -u)" = "0" ] && EXTRA="--no-sandbox"\nexec '${chromium}' $EXTRA "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function runChild(nextScenario: Scenario = 'type', decision: 'allow' | 'deny' = 'allow'): Promise<ChildRun> {
  step = 0
  scenario = nextScenario
  pendingCalls = []
  toolResults = []
  bodies = []
  const dshHome = mkdtempSync(join(scratch, 'dsh-'))
  const home = mkdtempSync(join(scratch, 'home-'))
  const cwd = mkdtempSync(join(scratch, 'cwd-'))
  const cfg = {
    runnerEntry,
    browserEntry,
    browserHome: home,
    browserPath: wrappedChromium(),
    allowLocal: origin,
    dshHome,
    cwd,
    baseUrl: `${origin}/anthropic`,
    prompt: `Открой страницу и заполни пароль. ${PAGE_MARK}`,
    decision,
  }
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' }
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
    const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS - 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(RESULT_MARK))
      const report = line === undefined ? undefined : (JSON.parse(line.slice(RESULT_MARK.length)) as JsonObject)
      resolve({ report, output: `${stdout}\n${stderr}`, dshHome })
    })
  })
}

function sessionEvents(dshHome: string): JsonObject[] {
  const file = join(dshHome, 'sessions', 'main', 'events.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JsonObject)
}

function browserArguments(events: JsonObject[]): string[] {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as JsonObject
    if (record.type === 'tool-call' && record.name === 'browser') {
      found.push(JSON.stringify(record.arguments))
    }
    for (const inner of Object.values(record)) visit(inner)
  }
  visit(events)
  return found
}

withBrowser(`test_secrets_the_password_of_a_browser_type_never_reaches_the_session_events_or_the_service_log`, { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild()
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()

  // Positive control: the tool really typed the password and submitted the form.
  expect(bodies, 'the password reached the server through the real tool').toHaveLength(1)
  expect(new URLSearchParams(bodies[0] ?? '').get('pw')).toBe(PASSWORD)

  const events = sessionEvents(run.dshHome)
  expect(events.length, 'the runner wrote its session log').toBeGreaterThan(0)
  const raw = readFileSync(join(run.dshHome, 'sessions', 'main', 'events.jsonl'), 'utf8')
  expect(raw, 'the durable session log does not carry the password').not.toContain(PASSWORD)
  expect(run.output, 'the service log does not carry the password').not.toContain(PASSWORD)

  // The mask is in both events the review named, not a missing argument.
  const toolCalls = events.filter((event) => event.type === 'tool/call')
  const fill = toolCalls.find((event) => {
    const data = asObject(event.data)
    if (data.name !== 'browser') return false
    let args: unknown = data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        return false
      }
    }
    return asObject(args).action === 'type'
  })
  expect(fill, 'the browser type call is recorded').toBeDefined()
  expect(JSON.stringify(fill), 'the call event carries the mask instead of the text').toContain('[redacted]')
  const listed = browserArguments(events)
  expect(listed.length, 'the assistant message names the browser call').toBeGreaterThan(0)
  expect(listed.join('\n'), 'every recorded browser argument is masked').not.toContain(PASSWORD)
})

function parseArguments(value: unknown): JsonObject {
  return asObject(typeof value === 'string' ? JSON.parse(value) : value)
}

/** Require actual masked calls in both durable event types, rather than absence alone. */
function expectMaskedCalls(events: JsonObject[], action: string, argument: string, count: number): void {
  const calls = events
    .filter((event) => event.type === 'tool/call' && asObject(event.data).name === 'browser')
    .map((event) => parseArguments(asObject(event.data).arguments))
    .filter((args) => args.action === action)
  expect(calls, `tool/call records ${action}`).toHaveLength(count)
  for (const args of calls) expect(args[argument]).toBe('[redacted]')

  const messages = events.filter((event) => event.type === 'assistant/message')
  const assistantCalls = browserArguments(messages)
    .map((raw) => parseArguments(JSON.parse(raw)))
    .filter((args) => args.action === action)
  expect(assistantCalls.length, `assistant/message records ${action}`).toBeGreaterThanOrEqual(count)
  for (const args of assistantCalls) expect(args[argument]).toBe('[redacted]')
}

withBrowser('test_secrets_modified_password_keys_are_confirmed_and_masked_through_the_runner', { timeout: CHILD_TIMEOUT_MS }, async () => {
  const run = await runChild('modified_password')
  expect(run.report?.error, run.output).toBeUndefined()
  expect(run.report, run.output).toBeDefined()
  expect(bodies, 'the real password form was submitted').toHaveLength(1)
  expect(new URLSearchParams(bodies[0]).get('pw'), 'Shift+X and Shift+Space reached the password field').toBe('X ')
  expect(run.report?.approvals, 'each secret keystroke required its owner card').toHaveLength(MODIFIED_KEYS.length)

  const events = sessionEvents(run.dshHome)
  expectMaskedCalls(events, 'press', 'key', MODIFIED_KEYS.length)
  const raw = readFileSync(join(run.dshHome, 'sessions', 'main', 'events.jsonl'), 'utf8')
  for (const key of MODIFIED_KEYS) {
    expect(raw, 'no original key in any event, including stream fragments').not.toContain(key)
    expect(run.output, 'no original key in service output or approval requests').not.toContain(key)
    expect(toolResults.join('\n'), 'no original key in tool results').not.toContain(key)
  }
})

withBrowser.each(['deny', 'allow'] as const)(
  'test_secrets_card_controls_%s_require_confirmation_and_are_masked_through_the_runner',
  { timeout: CHILD_TIMEOUT_MS },
  async (decision) => {
    const run = await runChild('card_controls', decision)
    expect(run.report?.error, run.output).toBeUndefined()
    expect(run.report, run.output).toBeDefined()
    expect(bodies, 'the real card form was submitted even after a refusal').toHaveLength(1)
    const submitted = new URLSearchParams(bodies[0])
    expect(submitted.get('month'), 'only the approved select changes the month').toBe(decision === 'allow' ? CARD_MONTH : '')
    expect(submitted.get('holder'), 'only the approved fill changes the card textarea').toBe(decision === 'allow' ? CARD_NAME : '')

    const approvals = run.report?.approvals
    expect(approvals, 'select and textarea both require an owner card').toHaveLength(2)
    expect(JSON.stringify(approvals)).toContain('Expiry month')
    expect(JSON.stringify(approvals)).toContain('Cardholder name')
    if (decision === 'deny') {
      expect(toolResults.filter((result) => /владелец отклонил/.test(result)), 'both denied calls return a refusal').toHaveLength(2)
    }
    const snapshot = toolResults.find((result) => /combobox.*Expiry month/.test(result))
    expect(snapshot, 'card select is marked protected in snapshots').toMatch(/combobox.*Expiry month.*защищённое поле/)
    expect(snapshot, 'card textarea is marked protected in snapshots').toMatch(/textbox.*Cardholder name.*защищённое поле/)

    const events = sessionEvents(run.dshHome)
    expectMaskedCalls(events, 'select', 'value', 1)
    expectMaskedCalls(events, 'fill', 'text', 1)
    const raw = readFileSync(join(run.dshHome, 'sessions', 'main', 'events.jsonl'), 'utf8')
    for (const secret of [CARD_MONTH, CARD_NAME]) {
      expect(raw, 'no card value in durable events or stream fragments').not.toContain(secret)
      expect(run.output, 'no card value in service output or approval requests').not.toContain(secret)
      expect(toolResults.join('\n'), 'no card value in tool results, even when the server echoes it').not.toContain(secret)
    }
  },
)
