import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, test } from 'vitest'

import { createBrowserTools } from './src/index.js'

// Real Chromium and the same loopback permission as browser-interactive.test.ts.
// The server never finishes the image response, so DOMContentLoaded can fire
// while load cannot. No remote site or timing of a public service is involved.
function systemBrowser(): string | undefined {
  const explicit = process.env.DSHBOT_BROWSER_PATH
  if (explicit && existsSync(explicit)) return explicit
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

const executable = systemBrowser()
const withBrowser = test.skipIf(!executable)
const browserNote = executable ? '' : ' [skipped: system Chromium not found; set DSHBOT_BROWSER_PATH]'
const PENDING_TITLE = 'Pending image document'
const PENDING_TEXT = 'Readable content before the image finishes'
const LATE_TEXT = 'FRAMEWORK-RENDERED-AFTER-DOM-READY'
const TEST_DEADLINE = 'test deadline exceeded waiting for browser'

type Browser = ReturnType<typeof createBrowserTools>
type Outcome = { ok: true; text: string; ms: number } | { ok: false; error: string; ms: number }

async function act(browser: Browser, args: Record<string, unknown>, deadlineMs = 45_000): Promise<Outcome> {
  const tool = browser.tools.find((item) => item.name === 'browser')
  expect(tool, 'the real browser tool is registered').toBeDefined()
  const controller = new AbortController()
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ ok: false, error: TEST_DEADLINE, ms: performance.now() - started })
    }, deadlineMs)
  })
  const work = (async (): Promise<Outcome> => {
    try {
      const value = await tool!.execute(args, { signal: controller.signal })
      return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value), ms: performance.now() - started }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), ms: performance.now() - started }
    }
  })()
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

function good(outcome: Outcome): string {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  return outcome.ok ? outcome.text : ''
}

// Same snapshot ref format used by browser-navigation-guard.test.ts.
function refOf(snapshot: string, name: string): string {
  const line = snapshot.split('\n').find((item) => item.includes(name)) ?? ''
  const ref = /\[ref=([a-z0-9]+)\]/.exec(line)?.[1]
  expect(ref, `snapshot has a ref for ${name}:\n${snapshot}`).toBeDefined()
  return ref as string
}

interface World {
  browser: Browser
  origin: string
  pendingImages: Set<string>
  blockHistoryImage(): void
}

async function inWorld(run: (world: World) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'browser-dom-ready-'))
  const pendingImages = new Set<string>()
  let historyImageBlocked = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/image') {
      if (url.searchParams.get('visit') === 'history' && !historyImageBlocked) {
        res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' })
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
      } else {
        const visit = url.searchParams.get('visit') ?? ''
        pendingImages.add(visit)
        res.on('close', () => pendingImages.delete(visit))
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.flushHeaders()
        // Intentionally neither end nor send an image: load stays pending.
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (url.pathname === '/pending') {
      const visit = url.searchParams.get('visit') ?? 'open'
      res.end(`<!doctype html><html><head><title>${PENDING_TITLE}</title></head><body>
        <h1>${PENDING_TITLE}</h1><p>${PENDING_TEXT}</p>
        <img src="/image?visit=${encodeURIComponent(visit)}" alt="Pending image">
        </body></html>`)
    } else if (url.pathname === '/delayed') {
      res.end(`<!doctype html><html><head><title>Delayed framework</title></head><body>
        <main id="app">Initial placeholder</main><script>
        document.addEventListener('DOMContentLoaded', () => {
          setTimeout(() => {
            document.getElementById('app').textContent = ['FRAMEWORK', 'RENDERED', 'AFTER', 'DOM', 'READY'].join('-')
          }, 300)
        })
        </script></body></html>`)
    } else if (url.pathname === '/hung') {
      res.end('<!doctype html><html><head><title>Hung renderer</title></head><body><script>while (true) {}</script></body></html>')
    } else {
      res.end(`<!doctype html><html><head><title>Navigation controls</title></head><body>
        <h1>Navigation controls</h1>
        <a href="/pending?visit=click">Open pending document</a>
        <form action="/pending" method="get">
          <input type="hidden" name="visit" value="form">
          <label>Search query <input name="q" type="text"></label>
          <button type="submit">Search</button>
        </form></body></html>`)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const wrapper = join(home, 'chromium')
  // Disable the back/forward cache so c3 really reloads its unfinished image.
  const binary = (executable as string).replace(/'/g, "'\\''")
  writeFileSync(wrapper, `#!/bin/sh\nEXTRA=""\n[ "$(id -u)" = "0" ] && EXTRA="--no-sandbox"\nexec '${binary}' $EXTRA --disable-features=BackForwardCache "$@"\n`)
  chmodSync(wrapper, 0o755)
  const browser = createBrowserTools({ home, browserPath: wrapper, allowLocalOrigins: [origin] })
  try {
    // Launch outside navigation measurements, as for subsequent daemon calls.
    good(await act(browser, { action: 'open', url: `${origin}/controls` }))
    await run({ browser, origin, pendingImages, blockHistoryImage: () => { historyImageBlocked = true } })
  } finally {
    try {
      await browser.stop()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
    }
  }
}

withBrowser(`test_c1_open_reads_a_document_without_waiting_for_its_unfinished_image${browserNote}`, { timeout: 90_000 }, async () => {
  await inWorld(async ({ browser, origin, pendingImages }) => {
    const result = await act(browser, { action: 'open', url: `${origin}/pending` })
    const text = good(result)
    expect(text).toContain(PENDING_TITLE)
    expect(text).toContain(PENDING_TEXT)
    expect(pendingImages.has('open'), 'the image is still pending when the answer arrives').toBe(true)
    expect(result.ms, 'open finishes before ten seconds').toBeLessThan(10_000)
  })
})

withBrowser(`test_c2_open_includes_text_inserted_300ms_after_DOMContentLoaded${browserNote}`, { timeout: 90_000 }, async () => {
  await inWorld(async ({ browser, origin }) => {
    const result = await act(browser, { action: 'open', url: `${origin}/delayed` })
    expect(good(result), 'the first answer includes the framework render, without another wait or snapshot').toContain(LATE_TEXT)
  })
})

withBrowser(`test_c3_back_reads_the_previous_document_even_when_its_image_never_finishes${browserNote}`, { timeout: 90_000 }, async () => {
  await inWorld(async ({ browser, origin, pendingImages, blockHistoryImage }) => {
    // Seed history with a completed image; only the back navigation hangs it.
    // This keeps a broken open implementation from masking the back assertion.
    expect(good(await act(browser, { action: 'open', url: `${origin}/pending?visit=history` }))).toContain(PENDING_TEXT)
    good(await act(browser, { action: 'open', url: `${origin}/controls` }))
    blockHistoryImage()
    const result = await act(browser, { action: 'back' })
    expect(good(result)).toContain(PENDING_TEXT)
    expect(pendingImages.has('history'), 'back really requested an image that is still pending').toBe(true)
    expect(result.ms, 'back finishes before ten seconds').toBeLessThan(10_000)
  })
})

withBrowser(`test_c4_click_and_both_Enter_submission_paths_read_the_new_page_in_under_five_seconds${browserNote}`, { timeout: 150_000 }, async () => {
  await inWorld(async ({ browser, origin, pendingImages }) => {
    const results: { mode: string; outcome: Outcome; imagePending: boolean }[] = []
    for (const mode of ['click', 'type-submit', 'press-Enter']) {
      good(await act(browser, { action: 'open', url: `${origin}/controls` }))
      const snapshot = good(await act(browser, { action: 'snapshot' }))
      let args: Record<string, unknown>
      if (mode === 'click') {
        args = { action: 'click', ref: refOf(snapshot, 'Open pending document') }
      } else {
        const ref = refOf(snapshot, 'Search query')
        if (mode === 'type-submit') {
          args = { action: 'type', ref, text: 'sample', submit: true }
        } else {
          good(await act(browser, { action: 'fill', ref, text: 'sample' }))
          args = { action: 'press', key: 'Enter' }
        }
      }
      const outcome = await act(browser, args)
      results.push({ mode, outcome, imagePending: pendingImages.has(mode === 'click' ? 'click' : 'form') })
    }
    for (const { mode, outcome, imagePending } of results) {
      expect.soft(outcome.ok ? outcome.text : outcome.error, mode).toContain(PENDING_TEXT)
      expect.soft(outcome.ok, mode).toBe(true)
      expect.soft(imagePending, `${mode}: the destination image never finished`).toBe(true)
      expect.soft(outcome.ms, `${mode}: navigation finishes before five seconds`).toBeLessThan(5_000)
    }
  })
})

withBrowser(`test_c5_an_endless_script_still_times_out_and_the_next_open_works${browserNote}`, { timeout: 120_000 }, async () => {
  await inWorld(async ({ browser, origin }) => {
    const hung = await act(browser, { action: 'open', url: `${origin}/hung` })
    expect(hung.ok, 'a script blocking DOMContentLoaded must fail').toBe(false)
    const error = hung.ok ? '' : hung.error
    expect(error, 'the product deadline ends the call, not the test guard').not.toBe(TEST_DEADLINE)
    expect(error, 'the failure explains that the page did not respond in time').toMatch(/timeout|timed out|тайм|не отвечает|не заверш|превыш/i)
    // Existing browser-hardening.test.ts gives the same 40 s ceiling for open.
    expect(hung.ms, 'the previous bound on a hung open is preserved').toBeLessThan(40_000)
    const recovered = await act(browser, { action: 'open', url: `${origin}/controls` })
    expect(good(recovered), 'the same tool instance can open a healthy page after the error').toContain('Navigation controls')
  })
})
