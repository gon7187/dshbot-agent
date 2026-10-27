// [c4] An open CONNECT tunnel of the exec proxy keeps forwarding bytes for as long as either side is connected.

import net, { type AddressInfo, type Socket } from 'node:net'
import { afterEach, expect, test } from 'vitest'

import { startNetworkProxy, type NetworkProxy } from '../guard/src/network-proxy.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A TCP target that records every byte it receives. */
async function tcpTarget(): Promise<{ port: number; received: () => string }> {
  let received = ''
  const server = net.createServer((socket) => socket.on('data', (chunk) => (received += chunk.toString('utf8'))))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => server.close())
  return { port: (server.address() as AddressInfo).port, received: () => received }
}

async function proxy(): Promise<NetworkProxy> {
  const started = await startNetworkProxy(async () => '127.0.0.1', 10_000, { exposeRefusal: true })
  cleanups.push(() => started.stop())
  return started
}

/** A raw client of the proxy that collects everything the proxy answers. */
async function rawClient(proxy: NetworkProxy): Promise<{ socket: Socket; answer: () => string; closed: () => boolean }> {
  const { port } = new URL(proxy.server)
  const socket = net.connect({ host: '127.0.0.1', port: Number(port) })
  let answer = ''
  let closed = false
  socket.on('data', (chunk) => (answer += chunk.toString('utf8')))
  socket.on('error', () => undefined)
  socket.on('close', () => (closed = true))
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  cleanups.push(() => socket.destroy())
  return { socket, answer: () => answer, closed: () => closed }
}

test('test_c4_open_tunnel_keeps_forwarding_bytes', async () => {
  const target = await tcpTarget()
  const started = await proxy()
  const client = await rawClient(started)
  client.socket.write(`CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`)
  await until('the tunnel', () => client.answer().includes('200 Connection Established'))
  client.socket.write('FIRST_')
  await until('the first bytes', () => target.received() === 'FIRST_')
  client.socket.write('SECOND')
  await until('the second bytes', () => target.received() === 'FIRST_SECOND')
  expect(client.closed()).toBe(false)
})
