import { createServer, request, type IncomingMessage } from 'node:http'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { connect, type AddressInfo, type Socket } from 'node:net'

export function requestPanel(socketPath: string, port: number, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return Promise.reject(new Error('Invalid panel resource'))
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath, path: `/orchestrator/api/${path}`, method: payload === undefined ? 'GET' : 'POST', signal,
      headers: { host: `127.0.0.1:${port}`, 'x-orchestrator-request': '1', 'content-type': 'application/json',
        ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }) },
    }, response => {
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4 * 1024 * 1024) { req.destroy(new Error('Panel response too large')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(`Superagent panel HTTP ${response.statusCode}`)); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(2_000, () => req.destroy(new Error('Superagent panel timed out')))
    req.end(payload)
  })
}

/** Owner-authenticated loopback access to one isolated upstream panel. */
export async function startPanelProxy(socketPath: string, port: number): Promise<{ port: number; url: string; stop(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const token = randomBytes(32).toString('hex')
  let boundPort = port
  const cookieName = () => `superagent_panel_${boundPort}`
  const matches = (value: string | undefined): boolean => value !== undefined
    && Buffer.byteLength(value) === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token))
  const cookieToken = (req: IncomingMessage) => req.headers.cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${cookieName()}=`))?.slice(cookieName().length + 1)
  const allowedOrigin = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${boundPort}`
    && (req.headers.origin === undefined || req.headers.origin === `http://127.0.0.1:${boundPort}`)
  const headers = (req: IncomingMessage) => ({ ...req.headers,
    cookie: req.headers.cookie?.split(';').filter(value => !value.trim().startsWith(`${cookieName()}=`)).join(';') ?? '',
  })
  const track = (socket: Socket) => {
    if (!sockets.has(socket)) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
    return socket
  }
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    if (!allowedOrigin(req)) { res.writeHead(403); res.end('Forbidden origin'); return }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`)
    if (req.method === 'GET' && matches(url.searchParams.get('access_token') ?? undefined)) {
      let upstreamToken: string
      try {
        const authFile = join(dirname(socketPath), 'state', 'panel-auth.json')
        const stat = lstatSync(authFile)
        if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error('Invalid panel authentication file')
        const auth: unknown = JSON.parse(readFileSync(authFile, 'utf8'))
        if (typeof auth !== 'object' || auth === null || !('token' in auth) || typeof auth.token !== 'string'
          || !/^[A-Za-z0-9_-]{16,512}$/.test(auth.token)) throw new Error('Invalid panel authentication token')
        upstreamToken = auth.token
      } catch { res.writeHead(503); res.end('Superagent panel is starting'); return }
      res.writeHead(303, { location: `/?token=${encodeURIComponent(upstreamToken)}`,
        'set-cookie': `${cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict`,
      }); res.end(); return
    }
    if (!matches(cookieToken(req))) { res.writeHead(401); res.end('Open the owner panel link from /superagent status'); return }
    const upstream = request({ socketPath, path: req.url, method: req.method, headers: headers(req) }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.on('error', () => res.destroy())
      incoming.pipe(res)
    })
    upstream.on('socket', track)
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Superagent panel unavailable') })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  server.on('connection', track)
  server.on('upgrade', (req, socket, head) => {
    if (!allowedOrigin(req) || !matches(cookieToken(req))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    const upstream = track(connect(socketPath))
    const close = () => { socket.destroy(); upstream.destroy() }
    socket.on('error', close); upstream.on('error', close)
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy())
    upstream.once('connect', () => {
      const forwarded = headers(req)
      const lines = Object.entries(forwarded).filter(([, value]) => value !== undefined)
        .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}`))
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  boundPort = (server.address() as AddressInfo).port
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/?access_token=${token}`,
    stop: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}
