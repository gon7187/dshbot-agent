// The network of the exec sandbox, seen from inside a real bwrap sandbox. The sandbox has no network of
// its own; its only way out is the daemon's proxy, which applies the same address rules as web_fetch.
//
// Test doubles (nothing here needs the internet):
//   * DNS: `dns.promises.lookup` and `dns.lookup` of the daemon process answer for a few test names
//     (`pub.test` is "public", `rebind.test` leads to loopback, `flip.test` changes its answer after the
//     first lookup). The sandbox itself resolves nothing: names can only be resolved by the proxy.
//   * Connect: the one "public" address PUBLIC is not reachable here, so `net.Socket.prototype.connect`
//     sends a connection to PUBLIC to a local server instead. Every connect target is recorded before
//     the rewrite, which shows where the proxy really connected.
//   * Sinks: HTTP servers on loopback (and on a LAN address when the machine has one) that must never
//     be reached from the sandbox. A sink that sees a request is the failure.
//
// Criteria covered here: [block-private] (loopback, LAN, service and mapped addresses, by IP and by
// name), [public-ok] (http, CONNECT and https to a public name), [no-bypass] (direct sockets and the
// profile itself) and, for rebinding, [shared-guard] (the name is checked after resolution and the
// connection goes to the checked address).
//
// Where bwrap or curl cannot start on the machine, the tests that need them are skipped.

import { spawnSync } from 'node:child_process'
import dns from 'node:dns'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net, { type AddressInfo } from 'node:net'
import { homedir, networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'

import { resolvePublicTarget } from '../guard/src/network.js'

import { createExecTools, sandboxProfile, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())

/** The address the test resolver calls public; connections to it go to the local `pub` server. */
const PUBLIC = '93.184.216.34'
const SECRET = 'PRIVATE-SERVICE-SECRET'
const PUBLIC_BODY = 'PUBLIC-OK-BODY'

const DNS_ANSWERS: Record<string, readonly string[]> = {
  'pub.test': [PUBLIC],
  'rebind.test': ['127.0.0.1'],
  'mixed.test': [PUBLIC, '127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'lan.test': ['192.168.1.1'],
  'cgnat.test': ['100.64.0.1'],
  'ula.test': ['fd00::1'],
  'mapped.test': ['::ffff:7f00:1'],
  'loop6.test': ['::1'],
}

function bwrapWorks(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-net-probe-'))
  try {
    const profile = sandboxProfile({ home: HOME, workspace: scratch, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function hostHas(binary: string): boolean {
  return spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).error === undefined
}

const sandboxed = bwrapWorks() && hostHas('curl')
const hasPython = hostHas('python3')

interface Sink {
  server: Server
  hits: string[]
  port: number
}

async function listen(host: string, body: string, key?: string, cert?: string): Promise<Sink> {
  const hits: string[] = []
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    hits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.write(body.slice(0, 1))
    setImmediate(() => response.end(body.slice(1)))
  }
  const server = http.createServer(handler)
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, host, () => done())
  })
  return { server, hits, port: (server.address() as AddressInfo).port }
}

async function shut(sink: Sink | undefined): Promise<void> {
  if (sink === undefined) return
  sink.server.closeAllConnections()
  await new Promise<void>((done) => sink.server.close(() => done()))
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

let workspace = ''
let exec: ExecTools
let loopback: Sink
let loopback6: Sink | undefined
let lan: Sink | undefined
let pub: Sink
const connects: Array<{ host: string; port: number }> = []
let flipLookups = 0
let restore: Array<() => void> = []

function answersFor(name: string): readonly string[] | undefined {
  if (name === 'flip.test') {
    flipLookups += 1
    return flipLookups === 1 ? [PUBLIC] : ['127.0.0.1']
  }
  return DNS_ANSWERS[name]
}

function entries(addresses: readonly string[]): Array<{ address: string; family: number }> {
  return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
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
  const prototype = net.Socket.prototype as unknown as { connect: (...args: unknown[]) => unknown }
  const original = prototype.connect
  prototype.connect = function patched(this: net.Socket, ...args: unknown[]): unknown {
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
    if (typeof first === 'object' && first !== null) {
      const target = first as { host?: unknown; port?: unknown }
      if (typeof target.host === 'string') {
        connects.push({ host: target.host, port: Number(target.port) })
        if (target.host === PUBLIC) {
          target.host = '127.0.0.1'
          target.port = pub.port
        }
      }
    }
    return original.apply(this, args)
  }
  restore.push(() => {
    prototype.connect = original
  })
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-net-'))
  loopback = await listen('127.0.0.1', SECRET)
  loopback6 = await listen('::1', SECRET).catch(() => undefined)
  const lanIp = lanAddress()
  lan = lanIp === undefined ? undefined : await listen('0.0.0.0', SECRET)
  pub = await listen('127.0.0.1', PUBLIC_BODY)
  installResolver()
  installConnectRewrite()
  writeFileSync(join(workspace, 'probe.sh'), 'if exec 3<>"/dev/tcp/$1/$2"; then echo CONNECTED; else echo BLOCKED; fi\n')
  writeFileSync(
    join(workspace, 'probe.py'),
    'import socket, sys\ntry:\n    socket.create_connection((sys.argv[1], int(sys.argv[2])), 3)\n    print("CONNECTED")\nexcept OSError:\n    print("BLOCKED")\n',
  )
  exec = await createExecTools({ workspace, home: HOME, approval: async () => 'allow' })
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  for (const undo of restore.reverse()) undo()
  restore = []
  await Promise.all([shut(loopback), shut(loopback6), shut(lan), shut(pub)])
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  for (const sink of [loopback, loopback6, lan, pub]) sink?.hits.splice(0)
  connects.splice(0)
  flipLookups = 0
})

interface Answer {
  text: string
  code: string | undefined
}

async function run(command: string): Promise<Answer> {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec')
  if (tool === undefined) throw new Error('exec tool is missing')
  let text: string
  try {
    text = String(await tool.execute({ command, timeout_sec: 60 }, { signal: new AbortController().signal }))
  } catch (error) {
    text = `rejected: ${error instanceof Error ? error.message : String(error)}`
  }
  return { text, code: /HTTP=(\d+)/.exec(text)?.[1] }
}

function curl(url: string, flags = ''): string {
  return `curl -sS -g -m 10 ${flags} -o - -w '\\nHTTP=%{http_code}\\n' '${url}'`
}

const PROXY_VAR = '"${https_proxy:-${HTTPS_PROXY:-${http_proxy:-$HTTP_PROXY}}}"'

function privateHits(): string[] {
  return [loopback, loopback6, lan].flatMap((sink) => sink?.hits ?? [])
}

function expectUnreachable(answer: Answer, label: string): void {
  expect(privateHits(), `${label}: the private service saw a request\n${answer.text}`).toEqual([])
  expect(answer.text, `${label}: the private answer reached the sandbox\n${answer.text}`).not.toContain(SECRET)
  expect(answer.code ?? '000', `${label}: a 2xx/3xx answer came back\n${answer.text}`).not.toMatch(/^[23]/)
}

test.skipIf(!sandboxed)('test_block_private_loopback_and_lan_services_are_unreachable_by_ip_and_by_name', { timeout: 180_000 }, async () => {
  const targets: Array<[string, string]> = [
    ['127.0.0.1', `http://127.0.0.1:${loopback.port}/ip`],
    ['IPv4-mapped', `http://[::ffff:127.0.0.1]:${loopback.port}/mapped`],
    ['name to 127.0.0.1', `http://rebind.test:${loopback.port}/rebind`],
    ['mixed public and loopback answer', `http://mixed.test:${loopback.port}/mixed`],
  ]
  if (loopback6 !== undefined) {
    targets.push(['[::1]', `http://[::1]:${loopback6.port}/v6`], ['name to ::1', `http://loop6.test:${loopback6.port}/v6name`])
  }
  const lanIp = lanAddress()
  if (lan !== undefined && lanIp !== undefined) targets.push([`LAN ${lanIp}`, `http://${lanIp}:${lan.port}/lan`])
  for (const [label, url] of targets) {
    expectUnreachable(await run(curl(url)), label)
  }
  // Nothing the proxy did for these requests may have been a connection to a private address.
  const privatePorts = [loopback.port, loopback6?.port, lan?.port].filter((port): port is number => port !== undefined)
  expectUnreachable(await run(curl(`http://127.0.0.1:${loopback.port}/connect`, `-p -x ${PROXY_VAR}`)), 'private CONNECT')
  const wrong = connects.filter((target) => privatePorts.includes(target.port) && target.host !== PUBLIC)
  expect(wrong, 'the daemon opened a connection to a private address on behalf of the sandbox').toEqual([])
})

test.each([
  'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://172.16.0.1/',
  'http://192.168.1.1/', 'http://100.64.0.1/', 'http://224.0.0.1/',
  'http://[fc00::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/',
  'http://127.1/', 'http://2130706433/', 'http://[::ffff:7f00:1]/',
  'http://meta.test/', 'http://lan.test/', 'http://mixed.test/',
])('shared SSRF resolver refuses non-public address or DNS result %s', async (url) => {
  await expect(resolvePublicTarget(url)).rejects.toThrow()
})

test.skipIf(!sandboxed)('test_public_ok_http_request_by_name_goes_through_the_proxy', { timeout: 120_000 }, async () => {
  const answer = await run(curl('http://pub.test/ready'))
  expect(answer.text, `the public host answered\n${answer.text}`).toContain(PUBLIC_BODY)
  expect(answer.code, answer.text).toBe('200')
  expect(pub.hits, 'the request reached the public host through the daemon').toContain('/ready')
  expect(connects.some((target) => target.host === PUBLIC && target.port === 80), 'the proxy connected to the checked public address').toBe(true)
  expect(privateHits(), 'no private service was touched').toEqual([])
})

test.skipIf(!sandboxed)('test_public_ok_connect_tunnel_to_a_public_name_works', { timeout: 120_000 }, async () => {
  const answer = await run(curl('http://pub.test/tunnel', `-p -x ${PROXY_VAR}`))
  expect(answer.text, `the tunnel to the public host works\n${answer.text}`).toContain(PUBLIC_BODY)
  expect(pub.hits).toContain('/tunnel')
  expect(connects.some((target) => target.host === PUBLIC), 'the tunnel ends at the checked public address').toBe(true)
})

test.skipIf(!sandboxed)('test_shared_guard_rebinding_name_is_checked_after_resolution_and_connects_to_the_checked_address', { timeout: 120_000 }, async () => {
  // The first lookup says "public", every later lookup says "loopback": a proxy that resolves twice
  // (check, then connect by name) would connect to the sink on loopback.
  const answer = await run(curl(`http://flip.test:${loopback.port}/flip`))
  expect(privateHits(), `the rebinding name reached the loopback service\n${answer.text}`).toEqual([])
  expect(answer.text).not.toContain(SECRET)
  const toSink = connects.filter((target) => target.port === loopback.port && target.host !== PUBLIC)
  expect(toSink, 'the daemon connected to the address of the second lookup').toEqual([])
  expect(connects.some((target) => target.host === PUBLIC), 'the connection goes to the address that passed the check').toBe(true)
})

test.skipIf(!sandboxed)('test_no_bypass_direct_sockets_around_the_proxy_do_not_leave_the_sandbox', { timeout: 180_000 }, async () => {
  const lanIp = lanAddress()
  const direct: Array<[string, string, number]> = [['loopback', '127.0.0.1', loopback.port]]
  if (lan !== undefined && lanIp !== undefined) direct.push(['LAN', lanIp, lan.port])
  for (const [label, host, port] of direct) {
    const noProxy = await run(curl(`http://${host}:${port}/noproxy`, "--noproxy '*'"))
    expectUnreachable(noProxy, `curl --noproxy to ${label}`)

    const noEnv = await run(`env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY ${curl(`http://${host}:${port}/noenv`)}`)
    expectUnreachable(noEnv, `curl without proxy variables to ${label}`)

    const devTcp = await run(`bash probe.sh ${host} ${port}`)
    expect(devTcp.text, `/dev/tcp to ${label} ran and failed\n${devTcp.text}`).toContain('BLOCKED')
    expect(devTcp.text, `/dev/tcp to ${label} connected`).not.toContain('CONNECTED')
    expect(privateHits(), `/dev/tcp to ${label} reached the service`).toEqual([])


  }
})


test.skipIf(!sandboxed)('stopped exec refuses network commands rather than using an open-network fallback', async () => {
  await exec.stop()
  const answer = await run(curl(`http://127.0.0.1:${loopback.port}/after-stop`))
  expect(answer.text).toMatch(/остановлен|закрыт|не запущен/)
  expect(privateHits()).toEqual([])
  expect(answer.text).not.toContain(SECRET)
})
