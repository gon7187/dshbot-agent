// One HTTP/CONNECT proxy for every place that must reach the outside through an
// address check: the `browser` tool (Chromium follows redirects without asking
// Playwright) and the `exec` sandbox (a private network namespace whose only
// exit is this proxy).
//
// The proxy connects to the address the caller's `resolveAddress` returned after
// validation, never to a name it resolves again. HTTPS stays end-to-end
// encrypted and every new destination needs a new CONNECT, so the same rule
// guards redirects and subresources.

import http from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'
import type { Duplex } from 'node:stream'

/** The reason of a refused proxy request, as plain data a client can read. */
function refusalText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A connection-level guard: resolve and validate before opening any socket. */
export interface NetworkProxy {
  /** Proxy URL of a TCP listener; empty for a unix-socket listener. */
  readonly server: string
  /** Filesystem path of a unix-socket listener; absent for a TCP listener. */
  readonly socketPath?: string
  stop(): void
}

export interface NetworkProxyOptions {
  /**
   * Listen on this unix domain socket instead of a loopback TCP port. A sandbox
   * in its own network namespace can not reach a host TCP port, but a unix
   * socket is a filesystem object and crosses the namespace boundary.
   */
  readonly listenPath?: string
  /**
   * Send the refusal reason as the response body of a plain-HTTP request.
   * The exec sandbox needs it so a command can show why its egress was
   * closed; the browser keeps the old reset behaviour, where a refused
   * navigation is a failed action rather than a page of text.
   */
  readonly exposeRefusal?: boolean
}

/** Forward `from` into `to` with backpressure. */
function forward(from: NodeJS.ReadableStream, to: NodeJS.WritableStream): void {
  from.on('data', (chunk: Buffer) => {
    if (!to.write(chunk)) {
      from.pause()
      to.once('drain', () => from.resume())
    }
  })
  from.on('end', () => to.end())
}

/**
 * Start the proxy. `resolveAddress` receives the absolute request URL and must
 * return the checked address to connect to (it throws to refuse).
 */
export async function startNetworkProxy(
  resolveAddress: (url: string) => Promise<string>,
  timeoutMs: number,
  options: NetworkProxyOptions = {},
): Promise<NetworkProxy> {
  const sockets = new Set<Socket>()
  let stopped = false
  function track(socket: Socket): Socket {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setTimeout(timeoutMs, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    return socket
  }

  const server = http.createServer((incoming, outgoing) => {
    void (async () => {
      const target = new URL(incoming.url ?? '')
      if (target.protocol !== 'http:') throw new Error('HTTP proxy requires an http URL')
      const address = await resolveAddress(target.href)
      if (stopped || incoming.destroyed) throw new Error('Proxy stopped')
      const headers: http.OutgoingHttpHeaders = { ...incoming.headers, host: target.host }
      delete headers['proxy-authorization']
      delete headers['proxy-connection']
      const upstream = http.request({
        hostname: address,
        port: target.port || 80,
        method: incoming.method,
        path: target.pathname + target.search,
        headers,
        agent: false,
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.on('error', () => outgoing.destroy())
        forward(response, outgoing)
      })
      upstream.on('socket', track)
      upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error('Proxy request timed out')))
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502)
        outgoing.end()
      })
      incoming.on('aborted', () => upstream.destroy())
      incoming.on('error', () => upstream.destroy())
      outgoing.on('close', () => upstream.destroy())
      forward(incoming, upstream)
    })().catch((error: unknown) => {
      if (!options.exposeRefusal) {
        outgoing.destroy()
        return
      }
      // A refusal is data for the client, not a silent reset: a sandboxed
      // command must be able to show why its egress was closed.
      if (outgoing.headersSent) {
        outgoing.destroy()
        return
      }
      const body = refusalText(error)
      outgoing.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      outgoing.end(`${body}\n`)
    })
  })
  server.on('connection', track)
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('connect', (incoming, client, head) => {
    void (async () => {
      const target = new URL(`https://${incoming.url ?? ''}`)
      if (target.pathname !== '/' || target.search !== '' || target.hash !== '' || target.username !== '' || target.password !== '') {
        throw new Error('Invalid CONNECT authority')
      }
      const address = await resolveAddress(target.href)
      if (stopped || client.destroyed) throw new Error('Proxy stopped')
      const upstream = track(net.connect({ host: address, port: Number(target.port || 443) }))
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        forward(upstream, client)
        forward(client, upstream)
      })
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    })().catch((error: unknown) => refuseConnect(client, refusalText(error)))
  })
  /** Answer a CONNECT that never opened: the reason as the body, or a bare 403. */
  function refuseConnect(client: Duplex, body: string): void {
    if (!options.exposeRefusal) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    client.end(
      'HTTP/1.1 403 Forbidden\r\n' +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n` +
        body,
    )
  }
  // No protocol upgrades bypass the destination guard. Secure WebSockets, if
  // used, go through the already checked HTTPS CONNECT tunnel.
  server.on('upgrade', (_request, socket) => socket.destroy())

  const listenPath = options.listenPath
  if (listenPath !== undefined) {
    // A stale socket file (same path, previous process) would make listen fail.
    try {
      unlinkSync(listenPath)
    } catch {
      // Nothing to remove.
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(listenPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return {
      server: '',
      socketPath: listenPath,
      stop() {
        stopped = true
        server.close()
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        try {
          unlinkSync(listenPath)
        } catch {
          // Already gone.
        }
      },
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port
  return {
    server: `http://127.0.0.1:${port}`,
    stop() {
      stopped = true
      server.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

/** The browser package's historical name for the same proxy. */
export const startBrowserProxy = startNetworkProxy

/** The browser package's historical type name for the same proxy handle. */
export type BrowserProxy = NetworkProxy
