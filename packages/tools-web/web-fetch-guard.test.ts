// [shared-guard] of `web_fetch`: the address policy is the guard module of
// `exec` and `browser`, the name is resolved there exactly once, and the
// pinned transport connects only to the returned address. A rebinding name
// cannot pass the check and then reach a private service.
//
// The test needs no internet:
//   * DNS of the daemon is replaced for a few names (`pub.test` is public,
//     `rebind.test` leads to loopback, `flip.test` answers "public" once and
//     "loopback" afterwards);
//   * the one "public" address is rewritten to the local fixture server, and
//     every connect target is recorded before the rewrite;
//   * the loopback sink must never see a request.

import dns from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import { isPrivateAddress } from '../guard/src/network.js'
import { createWebTools, WEB_FETCH_TOOL_NAME, type WebTool } from './src/index.js'

const PUBLIC = '93.184.216.34'
const PRIVATE_SECRET = 'PRIVATE-SERVICE-SECRET'
const PUBLIC_BODY = 'PUBLIC-WEB-FETCH-BODY'

const DNS_ANSWERS: Record<string, readonly string[]> = {
  'pub.test': [PUBLIC],
  'rebind.test': ['127.0.0.1'],
  'mixed.test': [PUBLIC, '127.0.0.1'],
}

let flipLookups = 0
let workspace = ''
let tools: WebTool[]
let pub: http.Server
let pubPort = 0
let sink: http.Server
let sinkPort = 0
let sinkHits: string[] = []
const connects: Array<{ host: string; port: number }> = []
let restore: Array<() => void> = []

function entries(addresses: readonly string[]): Array<{ address: string; family: number }> {
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

function answersFor(name: string): readonly string[] | undefined {
  if (name === 'flip.test') {
    flipLookups += 1
    return flipLookups === 1 ? [PUBLIC] : ['127.0.0.1']
  }
  return DNS_ANSWERS[name]
}

function installResolver(): void {
  const promises = dns.promises as unknown as Record<string, unknown>
  const originalPromise = promises.lookup as (...args: unknown[]) => Promise<unknown>
  promises.lookup = async (hostname: string, options?: unknown): Promise<unknown> => {
    const addresses = answersFor(hostname)
    if (addresses === undefined) return originalPromise(hostname, options)
    const list = entries(addresses)
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true
    return all ? list : list[0]
  }
  const callbacks = dns as unknown as Record<string, unknown>
  const originalCallback = callbacks.lookup as (...args: unknown[]) => unknown
  callbacks.lookup = (hostname: string, optionsOrCallback?: unknown, maybeCallback?: unknown): unknown => {
    const addresses = answersFor(hostname)
    if (addresses === undefined) return originalCallback(hostname, optionsOrCallback, maybeCallback)
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as (...a: unknown[]) => void
    const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? (optionsOrCallback as { all?: boolean }) : {}
    const list = entries(addresses)
    process.nextTick(() => (options.all === true ? callback(null, list) : callback(null, list[0]?.address, list[0]?.family)))
    return undefined
  }
  syncBuiltinESMExports()
  restore.push(() => {
    promises.lookup = originalPromise
    callbacks.lookup = originalCallback
    syncBuiltinESMExports()
  })
}

function installConnectRewrite(): void {
  // Undici's connector calls `net.connect(options)` with the URL hostname and a
  // pinned `lookup`. The rewrite wraps that lookup: it records the address the
  // transport actually received from the lookup (the checked address) and sends
  // only that address to the local fixture.
  const module = net as unknown as Record<'connect' | 'createConnection', (...args: unknown[]) => unknown>
  const originals = { connect: module.connect, createConnection: module.createConnection }
  const rewrite = (options: { port?: unknown; lookup?: unknown }): void => {
    const port = Number(options.port)
    const lookup = options.lookup as
      | ((host: string, lookupOptions: unknown, callback: (error: unknown, address: unknown, family?: number) => void) => void)
      | undefined
    if (typeof lookup !== 'function') return
    options.lookup = (host: string, lookupOptions: unknown, callback: (error: unknown, address: unknown, family?: number) => void): void => {
      lookup(host, lookupOptions, (error, address, family) => {
        if (error !== null && error !== undefined) {
          callback(error, address, family)
          return
        }
        const list = Array.isArray(address)
          ? (address as Array<{ address: string; family: number }>)
          : [{ address: String(address), family: family ?? 4 }]
        for (const entry of list) connects.push({ host: entry.address, port })
        if (list.some((entry) => entry.address === PUBLIC)) options.port = pubPort
        const rewritten = list.map((entry) => (entry.address === PUBLIC ? { ...entry, address: '127.0.0.1' } : entry))
        if (Array.isArray(address)) callback(null, rewritten, family)
        else callback(null, rewritten[0]?.address, rewritten[0]?.family)
      })
    }
  }
  for (const name of ['connect', 'createConnection'] as const) {
    module[name] = (...args: unknown[]): unknown => {
      const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
      if (typeof first === 'object' && first !== null) rewrite(first as { port?: unknown; lookup?: unknown })
      return originals[name].apply(module, args)
    }
  }
  restore.push(() => {
    module.connect = originals.connect
    module.createConnection = originals.createConnection
  })
}

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler)
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  return server
}

function fetchTool(): WebTool {
  const tool = tools.find((candidate) => candidate.name === WEB_FETCH_TOOL_NAME)
  if (tool === undefined) throw new Error('web_fetch is missing')
  return tool
}

async function fetchUrl(url: string): Promise<string> {
  return String(await fetchTool().execute({ url }))
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-web-guard-'))
  pub = await listen((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<html><body>${PUBLIC_BODY} ${request.url ?? ''}</body></html>`)
  })
  pubPort = (pub.address() as AddressInfo).port
  sink = await listen((request, response) => {
    sinkHits.push(request.url ?? '')
    response.end(PRIVATE_SECRET)
  })
  sinkPort = (sink.address() as AddressInfo).port
  // `http://pub.test:<port>` still targets PUBLIC; the rewrite keeps the URL
  // port for the local fixture, so any other port must fail the test.
  installResolver()
  installConnectRewrite()
  tools = createWebTools({ apiKey: 'test-key', workspace })
})

afterAll(async () => {
  for (const undo of restore.reverse()) undo()
  restore = []
  sink.closeAllConnections()
  pub.closeAllConnections()
  await new Promise<void>((done) => sink.close(() => done()))
  await new Promise<void>((done) => pub.close(() => done()))
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  connects.splice(0)
  sinkHits = []
  flipLookups = 0
})

test('test_public_ok_web_fetch_by_name_connects_to_the_checked_address', async () => {
  const answer = await fetchUrl(`http://pub.test:${pubPort}/page`)
  expect(answer, 'the public fixture answered through the guarded transport').toContain(PUBLIC_BODY)
  expect(answer, 'the request path reached the fixture').toContain('/page')
  expect(connects.some((target) => target.host === PUBLIC), 'the transport connected to the address the guard checked').toBe(true)
  expect(sinkHits, 'no private service was touched').toEqual([])
})

test('test_block_private_web_fetch_by_name_is_refused_after_resolution', async () => {
  await expect(fetchUrl(`http://rebind.test:${sinkPort}/`)).rejects.toThrow(/отклон|частн|публичн|failed/i)
  await expect(fetchUrl(`http://mixed.test:${sinkPort}/`)).rejects.toThrow(/отклон|частн|публичн|failed/i)
  expect(sinkHits, 'the loopback service saw a request').toEqual([])
  expect(connects.some((target) => target.host === '127.0.0.1' && target.port === sinkPort), 'the loopback service was dialled').toBe(false)
})

test('test_block_private_web_fetch_literals_are_refused_before_connecting', async () => {
  const hosts = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '192.88.99.1',
    '[::1]',
    '[fc00::1]',
    '[fe80::1]',
    '[::ffff:127.0.0.1]',
    '[2001::1]',
  ]
  for (const host of hosts) {
    await expect(fetchUrl(`http://${host}/`), `${host} must be refused`).rejects.toThrow()
  }
  expect(connects.some((target) => target.host === '127.0.0.1'), 'a private literal was dialled').toBe(false)
})

test('test_shared_guard_rebinding_name_is_resolved_once_and_pinned', async () => {
  const answer = await fetchUrl(`http://flip.test:${pubPort}/flip`)
  expect(answer, 'the first, public answer is the one that is used').toContain(PUBLIC_BODY)
  expect(flipLookups, 'the name is resolved exactly once: the transport does not resolve it again').toBe(1)
  expect(connects.filter((target) => target.host === PUBLIC).length, 'the connection goes to the checked address').toBeGreaterThan(0)
  expect(connects.some((target) => target.host === '127.0.0.1' && target.port === sinkPort), 'the second answer reached loopback').toBe(false)
})

test('test_shared_guard_same_reserved_answers_are_private_for_every_egress', () => {
  for (const address of ['2001::1', '192.88.99.1', '192.0.0.1', '198.51.100.1', '203.0.113.1']) {
    expect(isPrivateAddress(address), `${address} is special-purpose`).toBe(true)
  }
  for (const address of ['93.184.216.34', '2001:4860:4860::8888']) {
    expect(isPrivateAddress(address), `${address} is public unicast`).toBe(false)
  }
})
