// The same lightweight Playwright seam as browser-redirect-frame.test.ts.
// No Chromium or remote server is needed: requests enter the real route/CDP
// handlers, and only the browser transport is replaced.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type CDPSession, type Route } from 'playwright-core'
import { afterEach, expect, test, vi } from 'vitest'

import { createBrowserTools } from './src/index.js'

const PUBLIC = 'http://93.184.216.34/'
const scratch: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-guard-fallback-'))
  scratch.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pageStub() {
  return {
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    goto: vi.fn(async (_url: string) => undefined),
    title: async () => 'Fallback title',
    url: () => PUBLIC,
    evaluate: async () => 'FALLBACK-PAGE-BODY',
    close: vi.fn(async () => undefined),
  }
}

async function connectProxy(server: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(new URL(server).port) })
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('error', reject)
  })
}

async function outcome(work: unknown | Promise<unknown>) {
  try {
    return { text: String(await work), error: undefined }
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

test.each(['missing', 'rejecting'] as const)(
  'test_h2_c1_launched_browser_keeps_proxy_route_and_cleanup_when_cdp_is_%s',
  async (failure) => {
    vi.stubEnv('DSHBOT_BROWSER_CDP_URL', '')
    vi.stubEnv('XDG_CONFIG_HOME', '/read-only-owner-config')
    vi.stubEnv('XDG_CACHE_HOME', '/read-only-owner-cache')
    const browserHome = home()
    const page = pageStub()
    let handleRoute: ((route: Route) => Promise<void>) | undefined
    const context = {
      newPage: async () => page,
      route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { handleRoute = handler }),
      unrouteAll: async () => undefined,
      close: vi.fn(async () => undefined),
      ...(failure === 'rejecting'
        ? { newCDPSession: vi.fn(async () => { throw new Error('CDP session unavailable') }) }
        : {}),
    }
    let proxy = ''
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (_profile, options) => {
      for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const) {
        const dir = options?.env?.[key]
        expect(dir, `${key} belongs to the writable browser home`).toMatch(`${browserHome}/`)
        writeFileSync(join(dir!, 'crashpad-write-probe'), 'writable')
      }
      expect(options?.env?.PATH).toBe(process.env.PATH)
      proxy = options?.proxy?.server ?? ''
      return context as unknown as BrowserContext
    })
    const browser = createBrowserTools({ home: browserHome, browserPath: process.execPath })
    try {
      const result = await outcome(browser.tools[0].execute({ url: PUBLIC }))
      expect(result.error, 'a launched browser can fall back to its proxy and route').toBeUndefined()
      expect(result.text).toContain('FALLBACK-PAGE-BODY')
      expect(result.text).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT')
      expect(launch).toHaveBeenCalledOnce()
      expect(process.env.XDG_CONFIG_HOME).toBe('/read-only-owner-config')
      expect(process.env.XDG_CACHE_HOME).toBe('/read-only-owner-cache')
      expect(page.goto).toHaveBeenCalledOnce()
      expect(context.route).toHaveBeenCalledWith('**/*', expect.any(Function))
      expect(handleRoute).toBeTypeOf('function')
      expect(proxy).toMatch(/^http:\/\/127\.0\.0\.1:/)
      await connectProxy(proxy)

      for (const [url, allowed] of [[PUBLIC, true], ['http://127.0.0.1/secret', false], ['http://10.0.0.5/secret', false]] as const) {
        const route = {
          request: () => ({ url: () => url, isNavigationRequest: () => false }),
          continue: vi.fn(async () => undefined),
          abort: vi.fn(async () => undefined),
        }
        await handleRoute!(route as unknown as Route)
        expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0)
        expect(route.abort).toHaveBeenCalledTimes(allowed ? 0 : 1)
      }
      await browser.stop()
      expect(context.close).toHaveBeenCalledOnce()
      await expect(connectProxy(proxy)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    } finally {
      await browser.stop()
    }
  },
)

test.each(['missing', 'rejecting'] as const)(
  'test_h2_c1_attached_browser_fails_closed_when_cdp_is_%s',
  async (failure) => {
    const page = pageStub()
    const context = {
      newPage: async () => page,
      close: vi.fn(async () => undefined),
      ...(failure === 'rejecting'
        ? { newCDPSession: vi.fn(async () => { throw new Error('CDP session unavailable') }) }
        : {}),
    }
    const attached = {
      contexts: () => [context],
      close: vi.fn(async () => undefined),
    }
    vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(attached as unknown as Browser)
    const launch = vi.spyOn(chromium, 'launchPersistentContext')
    const browser = createBrowserTools({ home: home(), cdpUrl: 'http://127.0.0.1:9222' })
    try {
      const result = await outcome(browser.tools[0].execute({ url: PUBLIC }))
      expect(result.error, 'an attached browser has no proxy fallback').toMatch(/CDP/i)
      expect(page.goto, 'the unguarded tab never navigates').not.toHaveBeenCalled()
      expect(page.close).toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
    } finally {
      await browser.stop()
    }
    expect(context.close, 'the owner context stays open').not.toHaveBeenCalled()
    expect(attached.close).toHaveBeenCalled()
  },
)

test('test_h2_c2_cdp_completes_every_paused_request_including_redirects', async () => {
  const cdp = new EventEmitter()
  const pending = new Map<string, (allowed: boolean) => void>()
  const commands: Array<{ method: string; requestId: string }> = []
  const reached: string[] = []
  let sequence = 0
  const send = vi.fn(async (method: string, params?: { requestId?: string }) => {
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      const requestId = params?.requestId ?? ''
      commands.push({ method, requestId })
      pending.get(requestId)?.(method === 'Fetch.continueRequest')
      pending.delete(requestId)
    }
    return {}
  })
  const session = Object.assign(cdp, { send, detach: async () => undefined })
  async function request(url: string): Promise<void> {
    const requestId = String(++sequence)
    const decision = new Promise<boolean>((resolve) => pending.set(requestId, resolve))
    cdp.emit('Fetch.requestPaused', { requestId, request: { url }, resourceType: 'Document', frameId: 'main' })
    if (!(await decision)) throw new Error('net::ERR_BLOCKED_BY_CLIENT')
    reached.push(url)
  }
  const page = pageStub()
  page.goto.mockImplementation(async (url) => {
    await request(url)
    if (url.endsWith('/redirect-private')) await request('http://10.0.0.5/secret')
    if (url.endsWith('/redirect-loopback')) await request('http://127.0.0.1/secret')
  })
  page.close.mockImplementation(async () => {
    // Unblock the fake transport on failure too; a broken handler must fail an
    // assertion within our deadline, never leave a hanging test behind.
    for (const resolve of pending.values()) resolve(false)
    pending.clear()
  })
  const context = {
    newPage: async () => page,
    newCDPSession: async () => session as unknown as CDPSession,
  }
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue({
    contexts: () => [context], close: async () => undefined,
  } as unknown as Browser)
  const browser = createBrowserTools({
    home: home(), cdpUrl: 'http://127.0.0.1:9222',
  })
  async function boundedCall(url: string) {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        outcome(browser.tools[0].execute({ url })),
        new Promise<{ text: string; error: string }>((resolve) => {
          timer = setTimeout(() => resolve({ text: '', error: 'PAUSED-REQUEST-DID-NOT-SETTLE' }), 2_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const control = await boundedCall(PUBLIC)
    expect(control.error, 'the attached tab really navigates with Fetch interception enabled').toBeUndefined()
    expect(control.text).toContain('FALLBACK-PAGE-BODY')
    expect(send).toHaveBeenCalledWith('Fetch.enable', expect.any(Object))
    const refused = [
      'http://10.0.0.5/direct', 'http://127.0.0.1/direct', 'http://169.254.169.254/direct',
      `${PUBLIC}redirect-private`, `${PUBLIC}redirect-loopback`,
    ]
    for (const url of refused) {
      const result = await boundedCall(url)
      expect(result.error, `${url} is refused`).toBeTypeOf('string')
      expect(result.error, `${url} settles before a browser navigation timeout`).not.toBe('PAUSED-REQUEST-DID-NOT-SETTLE')
      expect(result.text).not.toContain('FALLBACK-PAGE-BODY')
    }
    expect(reached).toEqual([PUBLIC, `${PUBLIC}redirect-private`, `${PUBLIC}redirect-loopback`])
    expect(pending.size).toBe(0)
    expect(sequence, 'the control and redirect hops reached the Fetch handler').toBe(5)
    for (let id = 1; id <= sequence; id += 1) {
      expect(commands.filter((command) => command.requestId === String(id)), `paused request ${id} gets exactly one disposition`).toHaveLength(1)
    }
    expect(commands.filter((command) => command.method === 'Fetch.failRequest')).toHaveLength(2)
  } finally {
    await browser.stop()
  }
})
