import { lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLI_PATH = '/opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PROXY_SOCKET = '/run/superagent-net/proxy.sock'
const PANEL_SOCKET = '/home/user/panel.sock'
const PROXY_PORT = 18_080
const DEFAULT_PANEL_PORT = 3_082
const LOOPBACK = '127.0.0.1'

function absolutePath(value, name) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path`)
  }
  return value
}

function port(value, name) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1024 to 65535`)
  }
  return value
}

function removeSocket(path) {
  try {
    const entry = lstatSync(path)
    if (!entry.isSocket()) throw new Error(`${path} exists and is not a Unix socket`)
    unlinkSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw new Error(`cannot remove stale ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Start one loopback TCP to Unix-domain-socket byte relay. */
export async function startTcpRelay({ listenPort, socketPath, host = LOOPBACK }) {
  const tcpPort = port(listenPort, 'listenPort')
  const unixPath = absolutePath(socketPath, 'socketPath')
  if (host !== LOOPBACK) throw new Error('relay host must be loopback')

  const sockets = new Set()
  const server = createServer(client => {
    const upstream = createConnection(unixPath)
    sockets.add(client)
    sockets.add(upstream)
    const failBoth = () => {
      client.destroy()
      upstream.destroy()
    }
    client.once('close', () => {
      sockets.delete(client)
      if (!upstream.destroyed) upstream.destroy()
    })
    upstream.once('close', () => {
      sockets.delete(upstream)
      if (!client.destroyed && !client.writableEnded) client.end()
    })
    client.on('error', failBoth)
    upstream.on('error', failBoth)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise((resolveListen, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(tcpPort, host)
  })

  let closed = false
  return {
    server,
    port: tcpPort,
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (!server.listening) return
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

/** Start one Unix-domain-socket to loopback TCP byte relay for the owner panel. */
export async function startUnixToTcpRelay({ socketPath, targetPort, host = LOOPBACK }) {
  const unixPath = absolutePath(socketPath, 'socketPath')
  const tcpPort = port(targetPort, 'targetPort')
  if (host !== LOOPBACK) throw new Error('relay host must be loopback')
  removeSocket(unixPath)

  const sockets = new Set()
  const server = createServer(client => {
    const upstream = createConnection(tcpPort, host)
    sockets.add(client)
    sockets.add(upstream)
    const failBoth = () => {
      client.destroy()
      upstream.destroy()
    }
    client.once('close', () => {
      sockets.delete(client)
      if (!upstream.destroyed) upstream.destroy()
    })
    upstream.once('close', () => {
      sockets.delete(upstream)
      if (!client.destroyed && !client.writableEnded) client.end()
    })
    client.on('error', failBoth)
    upstream.on('error', failBoth)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  await new Promise((resolveListen, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(unixPath)
  })

  let closed = false
  return {
    server,
    socketPath: unixPath,
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
      removeSocket(unixPath)
    },
  }
}

function installProxyEnvironment(proxyPort) {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY']
  const previous = new Map(names.map(name => [name, process.env[name]]))
  const proxyUrl = `http://${LOOPBACK}:${proxyPort}`
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) process.env[name] = proxyUrl
  process.env.NO_PROXY = ''
  process.env.NODE_USE_ENV_PROXY = '1'
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function waitForShutdown(close, signal) {
  let resolveWait
  let settled = false
  const wait = new Promise(resolve => { resolveWait = resolve })
  const onSignal = () => {
    if (settled) return
    settled = true
    void close().finally(() => resolveWait())
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  if (signal !== undefined) {
    if (signal.aborted) onSignal()
    else signal.addEventListener('abort', onSignal, { once: true })
  }
  return {
    wait,
    dispose() {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      signal?.removeEventListener('abort', onSignal)
    },
  }
}

/**
 * Start the two private relays and run the fixed upstream DSH profile.
 * The optional paths exist only for isolated tests; the production defaults
 * are fixed constants and the supervisor never supplies a command string.
 * The upstream CLI resolves once boot is ready, so this promise remains open
 * until SIGTERM, SIGINT, or the test-only abort signal tears the relays down.
 */
export async function runBootstrap({
  cliPath = CLI_PATH,
  proxySocket = PROXY_SOCKET,
  panelSocket = PANEL_SOCKET,
  proxyPort = PROXY_PORT,
  panelPort = Number(process.env.DSHBOT_SUPERAGENT_PORT ?? DEFAULT_PANEL_PORT),
  signal,
} = {}) {
  const cli = absolutePath(cliPath, 'cliPath')
  const proxy = absolutePath(proxySocket, 'proxySocket')
  const panel = absolutePath(panelSocket, 'panelSocket')
  const checkedProxyPort = port(proxyPort, 'proxyPort')
  const checkedPanelPort = port(panelPort, 'panelPort')
  if (checkedProxyPort === checkedPanelPort) throw new Error('proxyPort and panelPort must differ')

  const restoreEnvironment = installProxyEnvironment(checkedProxyPort)
  let proxyRelay
  let panelRelay
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await Promise.allSettled([proxyRelay?.close(), panelRelay?.close()])
    restoreEnvironment()
  }
  const lifetime = waitForShutdown(close, signal)

  try {
    proxyRelay = await startTcpRelay({ listenPort: checkedProxyPort, socketPath: proxy })
    panelRelay = await startUnixToTcpRelay({ socketPath: panel, targetPort: checkedPanelPort })
    const previousArgv = process.argv
    process.argv = [process.argv[0], cli, '--profile', 'superagent', '--no-open']
    try {
      const loaded = await import(pathToFileURL(cli).href)
      if (typeof loaded.runCli !== 'function') throw new Error('upstream DSH CLI does not export runCli')
      await loaded.runCli()
    } finally {
      process.argv = previousArgv
    }
    await lifetime.wait
  } finally {
    lifetime.dispose()
    await close()
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runBootstrap().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

export { CLI_PATH, PANEL_SOCKET, PROXY_SOCKET }
