// The hardening checks of the review of round 1: the address guard must see the
// hexadecimal IPv4-mapped IPv6 form the URL parser produces, every request of a
// page (not only its first navigation) must pass the same guard, and a page that
// never yields must neither block the queue nor keep Chromium alive after idle
// or after stop(). The locked browser-tool.test.ts keeps its own contract; this
// file adds the cases that were missing there and must not duplicate its checks.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const entry = join(repoRoot, 'packages', 'tools-browser', 'src', 'index.ts')

const TOOL_NAME = 'browser'
const TEST_TIMEOUT_MS = 170_000
const CALL_TIMEOUT_MS = 60_000
const REFUSAL_TIMEOUT_MS = 15_000
const TIMED_OUT = 'timed out waiting for the tool'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface BrowserTool {
  name: string
  lazy?: boolean
  guestAllowed?: boolean
  execute(args: Record<string, unknown>, context?: { signal: AbortSignal }): unknown
}

interface BrowserTools {
  tools: BrowserTool[]
  stop(): Promise<void>
  forceStop?(): void
}

interface BrowserOptions {
  home: string
  browserPath?: string
  idleMs?: number
  allowLocalOrigins?: readonly string[]
}

interface BrowserModule {
  createBrowserTools(options: BrowserOptions): BrowserTools
}

async function loadModule(): Promise<BrowserModule> {
  expect(existsSync(entry), 'packages/tools-browser/src/index.ts exists').toBe(true)
  const module = (await import(/* @vite-ignore */ pathToFileURL(entry).href)) as Partial<BrowserModule>
  expect(typeof module.createBrowserTools, 'the package exports createBrowserTools').toBe('function')
  return module as BrowserModule
}

type Outcome = { ok: true; text: string } | { ok: false; error: string }

async function call(browser: BrowserTools, url: string, timeoutMs = CALL_TIMEOUT_MS): Promise<Outcome> {
  const tool = browser.tools.find((candidate) => candidate.name === TOOL_NAME)
  expect(tool, `the package offers a tool named ${TOOL_NAME}`).toBeDefined()
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<Outcome>((done) => {
    timer = setTimeout(() => {
      abort.abort()
      done({ ok: false, error: TIMED_OUT })
    }, timeoutMs)
  })
  const run = (async (): Promise<Outcome> => {
    try {
      const value = await (tool as BrowserTool).execute({ url }, { signal: abort.signal })
      return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })()
  try {
    return await Promise.race([run, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function findChromium(): string | undefined {
  const fromEnv = process.env.DSHBOT_BROWSER_PATH
  if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
    }
  }
  return undefined
}

const chromium = findChromium()
const canScanProcesses = process.platform === 'linux' && existsSync('/proc/self/cmdline')
const realBrowser = chromium !== undefined && canScanProcesses
const skipNote = realBrowser ? '' : ' [skipped: no chromium found, set DSHBOT_BROWSER_PATH, or no /proc to look for processes]'
const withBrowser = test.skipIf(!realBrowser)

let scratch: string

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-browser-hard-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function freshDir(prefix: string): string {
  return mkdtempSync(join(scratch, `${prefix}-`))
}

/** An executable that writes its arguments down, one per line, and exits: no browser, only the launch. */
function fakeBrowser(): { path: string; argsFile: string } {
  const dir = freshDir('fake')
  const argsFile = join(dir, 'args.txt')
  const path = join(dir, 'chromium')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit 1\n`)
  chmodSync(path, 0o755)
  return { path, argsFile }
}

/** The system Chromium behind a wrapper; as root it needs --no-sandbox, which only a test container does. */
function wrappedChromium(): string {
  const path = join(freshDir('real'), 'chromium')
  writeFileSync(path, `#!/bin/sh\nEXTRA=""\n[ "$(id -u)" = "0" ] && EXTRA="--no-sandbox"\nexec '${chromium}' $EXTRA "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function profileOf(home: string): string {
  return join(home, 'browser-profile')
}

/** Processes of a browser started with this profile (not the node process of the test). */
function browserProcesses(profile: string): number[] {
  const found: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (!readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(profile)) continue
      if (/^(node|bun|deno)/.test(basename(readlinkSync(`/proc/${name}/exe`)))) continue
      found.push(Number(name))
    } catch {
      // the process ended while it was looked at
    }
  }
  return found
}

async function waitForNoBrowser(profile: string, timeoutMs: number): Promise<number[]> {
  const started = Date.now()
  let left = browserProcesses(profile)
  while (left.length > 0 && Date.now() - started < timeoutMs) {
    await sleep(100)
    left = browserProcesses(profile)
  }
  return left
}

async function waitFor(what: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!cond() && Date.now() - started < timeoutMs) await sleep(100)
  expect(cond(), `timed out waiting for: ${what}`).toBe(true)
}

interface Local {
  server: Server
  origin: string
  hits: string[]
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Local> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    handler(req, res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits }
}

function closeLocal(local: Local): Promise<void> {
  return new Promise<void>((done) => {
    local.server.closeAllConnections()
    local.server.close(() => done())
  })
}

// --- [ssrf] hexadecimal IPv4-mapped and embedded IPv6 ------------------------------------------------

test('test_ssrf_ipv4_mapped_and_embedded_ipv6_literals_are_refused_before_any_load', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { createBrowserTools } = await loadModule()
  const fake = fakeBrowser()
  const browser = createBrowserTools({ home: freshDir('home'), browserPath: fake.path })
  try {
    const refused = [
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a00:1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:c0a8:1]/',
      'http://[::7f00:1]/',
      'http://[64:ff9b::7f00:1]/',
      'http://[2002:7f00:1::]/',
      'http://[::ffff:0:0]/',
    ]
    for (const url of refused) {
      const outcome = await call(browser, url, REFUSAL_TIMEOUT_MS)
      expect(outcome.ok, `${url} is refused`).toBe(false)
      expect((outcome as { error: string }).error, `${url} is refused at once, nothing is loaded`).not.toBe(TIMED_OUT)
    }
    expect(existsSync(fake.argsFile), 'no browser was started for a forbidden address').toBe(false)

    // Positive control: a public address in the mapped form still reaches the browser.
    await call(browser, 'http://[::ffff:808:808]/', REFUSAL_TIMEOUT_MS)
    expect(existsSync(fake.argsFile), 'a public mapped address is not refused by the hex check').toBe(true)
  } finally {
    await browser.stop()
  }
})

// --- [ssrf] every request of a page ----------------------------------------------------------------

withBrowser(`test_ssrf_page_subresources_frames_and_fetch_to_private_addresses_are_blocked${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const { createBrowserTools } = await loadModule()
  const other = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('PRIVATE-LEAK')
  })
  const page = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Guarded</title></head><body>
<p>PUBLIC-PAGE-OK</p>
<img src="${other.origin}/secret.png">
<script src="${other.origin}/evil.js"></script>
<iframe src="${other.origin}/frame"></iframe>
<script>
window.__probe = 'pending';
fetch('${other.origin}/fetch').then(function () { window.__probe = 'leaked' }).catch(function () { window.__probe = 'blocked' });
</script>
</body></html>`)
  })
  const browser = createBrowserTools({ home: freshDir('home'), browserPath: wrappedChromium(), allowLocalOrigins: [page.origin] })
  try {
    const outcome = await call(browser, `${page.origin}/`)
    expect(outcome.ok, `the page opened through the test permission: ${JSON.stringify(outcome)}`).toBe(true)
    expect((outcome as { text: string }).text, 'the page itself was rendered').toContain('PUBLIC-PAGE-OK')
    // Give an unblocked fetch all the time it needs to reach the other server.
    await sleep(1_000)
    expect(other.hits, 'the page never connected to the private origin').toEqual([])
  } finally {
    await browser.stop()
    await closeLocal(page)
    await closeLocal(other)
  }
})

// --- [lifecycle] a hung page ------------------------------------------------------------------------

withBrowser(`test_lifecycle_idle_closes_a_browser_stuck_on_an_endless_script${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const { createBrowserTools } = await loadModule()
  const local = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>Hung</title></head><body>BEFORE<script>while(true){}</script></body></html>')
  })
  const home = freshDir('home')
  const profile = profileOf(home)
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), idleMs: 1_000, allowLocalOrigins: [local.origin] })
  try {
    const started = Date.now()
    const outcome = await call(browser, `${local.origin}/`)
    expect(outcome.ok, 'the hung page is cut by the page timeout').toBe(false)
    expect((outcome as { error: string }).error, 'the action timeout, not the test deadline, ends the call').not.toBe(TIMED_OUT)
    expect(Date.now() - started, 'the whole hung page is bounded').toBeLessThan(40_000)
    const afterIdle = await waitForNoBrowser(profile, 20_000)
    expect(afterIdle, 'idle leaves no chromium process of the hung page').toEqual([])
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})

withBrowser(`test_lifecycle_stop_returns_without_waiting_for_a_hung_page${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const { createBrowserTools } = await loadModule()
  const local = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>Hung</title></head><body>BEFORE<script>while(true){}</script></body></html>')
  })
  const home = freshDir('home')
  const profile = profileOf(home)
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), idleMs: 60_000, allowLocalOrigins: [local.origin] })
  try {
    const pending = call(browser, `${local.origin}/`)
    await waitFor('the browser of the hung call', () => browserProcesses(profile).length > 0, 20_000)
    const started = Date.now()
    await browser.stop()
    expect(Date.now() - started, 'stop() does not wait for the hung page').toBeLessThan(12_000)
    const outcome = await pending
    expect(outcome.ok, 'the call ended when the browser was closed under it').toBe(false)
    const left = await waitForNoBrowser(profile, 15_000)
    expect(left, 'stop() leaves no chromium process of the hung page').toEqual([])
  } finally {
    browser.forceStop?.()
    await browser.stop()
    await closeLocal(local)
  }
})
