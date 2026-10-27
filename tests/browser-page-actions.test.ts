// The gaps the review of round 1 found in the interactive browser: a ref of a
// snapshot that is gone must never click the element of the page that replaced
// it, the outbox must be written without stepping through a symlink, an action
// of a hung renderer must end by its own ceiling and leave the queue usable,
// and the value of a password / card field must not leak as its snapshot name.
//
// The locked packages/tools-browser/browser-interactive.test.ts keeps the main
// contract; this file adds the cases it does not cover and must not repeat it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join, sep } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createBrowserTools, type BrowserTools } from '../packages/tools-browser/src/index.js'

const TEST_TIMEOUT_MS = 150_000
const CALL_TIMEOUT_MS = 90_000
const TIMED_OUT = 'timed out waiting for the tool'

const CARD = '4111111111112345'
const SECOND_MARK = 'SECOND-PAGE-MARK-7714'
const PLAYGROUND_MARK = 'PLAYGROUND-MARK-3391'
const PRIVATE_MARK = 'PRIVATE-PAGE-MARK-5528'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

type Args = Record<string, unknown>
type Outcome = { ok: true; text: string } | { ok: false; error: string }

async function act(browser: BrowserTools, args: Args, timeoutMs = CALL_TIMEOUT_MS): Promise<Outcome> {
  const tool = browser.tools.find((candidate) => candidate.name === 'browser')
  expect(tool, 'the package offers the browser tool').toBeDefined()
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
      const value = await (tool as { execute(args: Args, context?: { signal: AbortSignal }): unknown }).execute(args, {
        signal: abort.signal,
      })
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

async function ok(browser: BrowserTools, args: Args, timeoutMs = CALL_TIMEOUT_MS): Promise<string> {
  const outcome = await act(browser, args, timeoutMs)
  expect(outcome.ok, `${JSON.stringify(args)} succeeded: ${outcome.ok ? '' : outcome.error}`).toBe(true)
  return (outcome as { text: string }).text
}

function refOf(snapshot: string, name: string): string {
  const line = snapshot
    .split('\n')
    .find((candidate) => candidate.includes(name) && /\bref=/.test(candidate))
  expect(line, `the snapshot gives a ref to ${JSON.stringify(name)}:\n${snapshot}`).toBeDefined()
  const ref = /\bref[=:]\s*"?([A-Za-z0-9_.-]+)/.exec(line as string)
  expect(ref, `the ref of ${JSON.stringify(name)} is readable`).not.toBeNull()
  return (ref as RegExpExecArray)[1]
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
const realBrowser = chromium !== undefined && process.platform === 'linux' && existsSync('/proc/self/cmdline')
const skipNote = realBrowser ? '' : ' [skipped: no chromium found or no /proc]'
const withBrowser = test.skipIf(!realBrowser)

let scratch: string

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-browser-actions-')))
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function freshDir(prefix: string): string {
  return mkdtempSync(join(scratch, `${prefix}-`))
}

/** The system Chromium behind a wrapper; as root it needs --no-sandbox, which only a test container does. */
function wrappedChromium(): string {
  const path = join(freshDir('real'), 'chromium')
  writeFileSync(path, `#!/bin/sh\nEXTRA=""\n[ "$(id -u)" = "0" ] && EXTRA="--no-sandbox"\nexec '${chromium}' $EXTRA "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

/** Chromium processes launched from the profile of one test home. */
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

interface Local {
  server: Server
  origin: string
  /** `req.url` of every request. */
  hits: string[]
  /** The body of every request, in order. */
  bodies: string[]
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Local> {
  const hits: string[] = []
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      hits.push(req.url ?? '')
      bodies.push(body)
      handler(req, res, body)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, bodies }
}

function closeLocal(local: Local): Promise<void> {
  return new Promise<void>((done) => {
    local.server.closeAllConnections()
    local.server.close(() => done())
  })
}

function page(body: string, title = 'Actions'): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

function appHandler(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0]
  const send = (body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  if (path === '/long') {
    send(
      page(
        '<p><a href="/second">Link one</a></p><p><a href="/third">Link two</a></p><p><a href="/fourth">Link three</a></p>',
      ),
    )
  } else if (path === '/second') {
    send(page(`<h1>${SECOND_MARK}</h1><a href="/">Home</a>`, 'Second'))
  } else if (path === '/card') {
    send(
      page(
        `<form method="post" action="/pay-result">
  <input id="cc" name="cc" autocomplete="cc-number">
  <button type="submit">Pay now</button>
</form>
<script>document.getElementById('cc').value = ${JSON.stringify(CARD)}</script>`,
        'Card',
      ),
    )
  } else if (path === '/stuck') {
    send(
      page(
        `<button id="hang">Hang the renderer</button>
<script>
document.getElementById('hang').addEventListener('click', function () { for (;;) {} })
</script>`,
        'Stuck',
      ),
    )
  } else if (path === '/pay-result') {
    send(page('<h1>Pay result</h1>'))
  } else if (path === '/pw') {
    send(
      page(
        `<form method="post" action="/pw-result">
  <label for="pw">Password</label>
  <input id="pw" name="pw" type="password">
  <button type="submit">Send password</button>
</form>`,
        'Password',
      ),
    )
  } else if (path === '/pw-result') {
    send(page('<h1>Password result</h1>'))
  } else {
    send(page(`<h1>${PLAYGROUND_MARK}</h1><p>Nothing here.</p>`))
  }
}

function realOutbox(home: string): string {
  return join(realpathSync(home), 'workspace', 'outbox')
}

// --- [actions] a ref never survives the snapshot that handed it out ---------------------------------

withBrowser(`test_actions_a_ref_of_the_previous_snapshot_or_page_never_clicks_the_next_element${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  const home = freshDir('home')
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), allowLocalOrigins: [local.origin], idleMs: 60_000 })
  try {
    await ok(browser, { action: 'open', url: `${local.origin}/long` })
    const first = await ok(browser, { action: 'snapshot' })
    const oldRef = refOf(first, 'Link one')

    // Another page of the same session: `open` numbers the refs of the new page
    // from where the old page stopped, so an old ref can not name the new Home.
    await ok(browser, { action: 'open', url: `${local.origin}/second` })
    const secondPage = await act(browser, { action: 'click', ref: oldRef }, 20_000)
    expect(secondPage.ok, 'a ref of the previous page is an error').toBe(false)
    expect((secondPage as { error: string }).error).toMatch(/ref|снимок|snapshot|устар|не найден|not found/i)
    await sleep(500)
    expect(local.hits.filter((hit) => hit === '/second'), 'the stale ref did not reload the second page').toHaveLength(1)
    expect(local.hits, 'the stale ref did not click the Home link').not.toContain('/')

    // The session still works after the refusals.
    const second = await ok(browser, { action: 'snapshot' })
    const homeRef = refOf(second, 'Home')
    await ok(browser, { action: 'click', ref: homeRef })
    expect(local.hits, 'a fresh ref of the live page still clicks').toContain('/')
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})

// --- [actions] a ref of a closed page stays stale after close + open and after the idle close -------

withBrowser(`test_actions_a_ref_of_a_closed_page_is_stale_after_reopen_and_after_the_idle_close${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  const home = freshDir('home')
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), allowLocalOrigins: [local.origin], idleMs: 1_500 })
  const profile = join(home, 'browser-profile')
  try {
    await ok(browser, { action: 'open', url: `${local.origin}/long` })
    const first = await ok(browser, { action: 'snapshot' })
    const closedRef = refOf(first, 'Link one')
    const longHits = local.hits.filter((hit) => hit === '/long').length

    // close + open: a new page and a new ref space, the old ref must not click anything
    await ok(browser, { action: 'close' })
    await ok(browser, { action: 'open', url: `${local.origin}/second` })
    const afterClose = await act(browser, { action: 'click', ref: closedRef }, 20_000)
    expect(afterClose.ok, 'a ref of the closed page is an error after open').toBe(false)
    expect((afterClose as { error: string }).error).toMatch(/ref|снимок|snapshot|устар|не найден|not found/i)
    await sleep(300)
    expect(local.hits.filter((hit) => hit === '/second'), 'the old ref did not reload the new page').toHaveLength(1)
    expect(local.hits.filter((hit) => hit === '/long'), 'the old ref did not click a link of the new page').toHaveLength(longHits)

    // the idle close recreates the browser and the page: the old ref is stale again
    await ok(browser, { action: 'open', url: `${local.origin}/long` })
    const idleSnap = await ok(browser, { action: 'snapshot' })
    const idleRef = refOf(idleSnap, 'Link two')
    expect(await waitForNoBrowser(profile, 30_000), 'the idle time closed the browser').toEqual([])
    await ok(browser, { action: 'open', url: `${local.origin}/second` })
    const afterIdle = await act(browser, { action: 'click', ref: idleRef }, 20_000)
    expect(afterIdle.ok, 'a ref of the page closed by the idle time is an error').toBe(false)
    expect((afterIdle as { error: string }).error).toMatch(/ref|снимок|snapshot|устар|не найден|not found/i)
    await sleep(300)
    expect(local.hits, 'the idle-stale ref did not click a link').not.toContain('/third')

    // a fresh snapshot of the live page still works
    const live = await ok(browser, { action: 'snapshot' })
    await ok(browser, { action: 'click', ref: refOf(live, 'Home') })
    expect(local.hits.filter((hit) => hit === '/'), 'a fresh ref still clicks').toHaveLength(1)
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})

// --- [secrets] a character key into a focused password field needs the owner card ------------------

withBrowser(`test_secrets_a_character_key_pressed_into_a_focused_password_field_needs_the_owner_card${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  // no approval seam: like exec without an approval, a secret keystroke is refused
  const browser = createBrowserTools({
    home: freshDir('home'),
    browserPath: wrappedChromium(),
    allowLocalOrigins: [local.origin],
    idleMs: 60_000,
  })
  // the owner confirms: the card is shown, the character is typed
  const requests: unknown[] = []
  const approval = async (request: unknown): Promise<'allow'> => {
    requests.push(request)
    return 'allow'
  }
  const confirmed = createBrowserTools({
    home: freshDir('home'),
    browserPath: wrappedChromium(),
    allowLocalOrigins: [local.origin],
    idleMs: 60_000,
    approval,
  })
  try {
    await ok(browser, { action: 'open', url: `${local.origin}/pw` })
    const snap = await ok(browser, { action: 'snapshot' })
    await ok(browser, { action: 'click', ref: refOf(snap, 'Password') })
    const refused = await act(browser, { action: 'press', key: 'Z' }, 20_000)
    expect(refused.ok, 'a character key into a password field without the card is refused').toBe(false)
    expect((refused as { error: string }).error).toMatch(/подтвержд|confirm|защищ|пароль/i)

    await ok(browser, { action: 'click', ref: refOf(snap, 'Send password') })
    const refusedAt = local.hits.lastIndexOf('/pw-result')
    expect(refusedAt, 'the form of the refused press reached the server').toBeGreaterThanOrEqual(0)
    const refusedBody = new URLSearchParams(local.bodies[refusedAt] ?? '')
    expect(refusedBody.get('pw') ?? '', 'the refused key did not change the password field').toBe('')

    await ok(confirmed, { action: 'open', url: `${local.origin}/pw` })
    const secondSnap = await ok(confirmed, { action: 'snapshot' })
    await ok(confirmed, { action: 'click', ref: refOf(secondSnap, 'Password') })
    await ok(confirmed, { action: 'press', key: 'Z' })
    expect(requests.length, 'the card of the owner was shown before the character key').toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(requests), 'the card does not carry the key').not.toContain('"Z"')
    await ok(confirmed, { action: 'click', ref: refOf(secondSnap, 'Send password') })
    const confirmedAt = local.hits.lastIndexOf('/pw-result')
    const body = new URLSearchParams(local.bodies[confirmedAt] ?? '')
    expect(body.get('pw'), 'the confirmed character reached the field').toBe('Z')
  } finally {
    await browser.stop()
    await confirmed.stop()
    await closeLocal(local)
  }
})

// --- [files] the outbox of the owner is never a symlink ---------------------------------------------

withBrowser(`test_files_outbox_symlink_to_an_outside_directory_is_refused_and_nothing_is_written_there${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  const home = freshDir('home')
  const outside = freshDir('outside')
  mkdirSync(join(home, 'workspace'), { recursive: true })
  symlinkSync(outside, join(home, 'workspace', 'outbox'))
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), allowLocalOrigins: [local.origin], idleMs: 60_000 })
  try {
    await ok(browser, { action: 'open', url: `${local.origin}/` })
    for (const action of ['screenshot', 'pdf']) {
      const refused = await act(browser, { action }, 60_000)
      expect(refused.ok, `${action} through an outbox symlink is refused`).toBe(false)
      expect((refused as { error: string }).error, `${action} names the symlink`).toMatch(
        /символ|ссылк|outbox|за предел|link/i,
      )
      expect((refused as { error: string }).error).not.toBe(TIMED_OUT)
    }
    expect(readdirSync(outside), 'no file of the browser lies outside the outbox of the owner').toEqual([])

    // Positive control: a plain outbox in the same home takes the file.
    rmSync(join(home, 'workspace', 'outbox'))
    mkdirSync(join(home, 'workspace', 'outbox'))
    const shot = await ok(browser, { action: 'screenshot' })
    const named = /[^\s"'<>,;()]+\.png\b/.exec(shot)
    expect(named, `the answer names the file:\n${shot}`).not.toBeNull()
    const path = join(realOutbox(home), (named as RegExpExecArray)[0].split(/[\\/]/).pop() as string)
    expect(existsSync(path), 'the file is in the real outbox').toBe(true)
    expect(path.startsWith(realOutbox(home) + sep)).toBe(true)
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})

// --- [guard] an action of a hung renderer ends by its ceiling --------------------------------------

withBrowser(`test_guard_a_hung_renderer_ends_the_action_by_its_timeout_and_the_next_call_works${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  const home = freshDir('home')
  const browser = createBrowserTools({
    home,
    browserPath: wrappedChromium(),
    allowLocalOrigins: [local.origin],
    idleMs: 60_000,
    actionTimeoutMs: 10_000,
  })
  try {
    await ok(browser, { action: 'open', url: `${local.origin}/stuck` })
    const snapshot = await ok(browser, { action: 'snapshot' })
    const hang = refOf(snapshot, 'Hang the renderer')

    const started = Date.now()
    const blocked = await act(browser, { action: 'click', ref: hang }, 60_000)
    expect(blocked.ok, 'the click of a hung renderer is an error').toBe(false)
    expect((blocked as { error: string }).error, 'the error names the timeout').toMatch(
      /не отвеч|не заверш|таймаут|врем|мс|timeout/i,
    )
    expect((blocked as { error: string }).error).not.toBe(TIMED_OUT)
    expect(Date.now() - started, 'the action ended by its own ceiling').toBeLessThan(45_000)

    // The queue is free and the idle timer is armed again: a fresh open works.
    const after = await ok(browser, { action: 'open', url: `${local.origin}/` }, 60_000)
    expect(after, 'the next call after the hung action works').toContain(PLAYGROUND_MARK)
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})

// --- [guard] a redirect of `open` itself to a private address is a clear refusal ---------------------

withBrowser(`test_guard_open_redirected_to_a_private_address_is_refused_before_the_server_is_reached${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const privateServer = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(`<h1>${PRIVATE_MARK}</h1>`))
  })
  const redirecting = await listen((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/away') {
      res.writeHead(302, { location: `${privateServer.origin}/landing` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(`<h1>${PLAYGROUND_MARK}</h1>`))
  })
  const home = freshDir('home')
  const browser = createBrowserTools({
    home,
    browserPath: wrappedChromium(),
    allowLocalOrigins: [redirecting.origin],
    idleMs: 60_000,
  })
  try {
    // The first navigation launches the browser and proves the permitted server works.
    await ok(browser, { action: 'open', url: `${redirecting.origin}/` })
    const redirected = await act(browser, { action: 'open', url: `${redirecting.origin}/away` }, 60_000)
    expect(redirected.ok, 'the redirect to a private address is refused').toBe(false)
    expect((redirected as { error: string }).error, 'the refusal names the address check').toMatch(
      /адрес|отклон|blocked|refus|private|частн/i,
    )
    expect((redirected as { error: string }).error).not.toBe(TIMED_OUT)
    expect(privateServer.hits, 'the private server was never reached').toEqual([])

    // A refusal of a navigation does not break the session.
    expect(await ok(browser, { action: 'open', url: `${redirecting.origin}/` }), 'the permitted page still opens').toContain(
      PLAYGROUND_MARK,
    )
  } finally {
    await browser.stop()
    await closeLocal(redirecting)
    await closeLocal(privateServer)
  }
})

// --- [secrets] a card field without a label does not name itself by its value -----------------------

withBrowser(`test_secrets_a_card_field_without_a_label_never_shows_its_value_in_the_snapshot${skipNote}`, { timeout: TEST_TIMEOUT_MS }, async () => {
  const local = await listen(appHandler)
  const home = freshDir('home')
  const browser = createBrowserTools({ home, browserPath: wrappedChromium(), allowLocalOrigins: [local.origin], idleMs: 60_000 })
  try {
    const opened = await ok(browser, { action: 'open', url: `${local.origin}/card` })
    expect(opened, 'the page prefilled the card field').toContain('Pay now')
    expect(opened, 'the open answer does not carry the card number').not.toContain(CARD)
    const snapshot = await ok(browser, { action: 'snapshot' })
    expect(snapshot, 'the snapshot of a cc-* field does not carry its value').not.toContain(CARD)
    expect(snapshot, 'the field is still listed as a protected field').toMatch(/защищённое поле/)

    // And the field still needs the owner card: without an approval seam the
    // value is refused, and the refusal does not echo it.
    const refused = await act(browser, { action: 'fill', ref: refOf(snapshot, 'cc'), text: CARD }, 20_000)
    expect(refused.ok, 'a cc-* field without an approval is refused').toBe(false)
    expect((refused as { error: string }).error).not.toContain(CARD)
    expect((refused as { error: string }).error).toMatch(/подтвержд|confirm|защищ/i)
  } finally {
    await browser.stop()
    await closeLocal(local)
  }
})
