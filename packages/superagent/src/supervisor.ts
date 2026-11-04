import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePublicTarget } from '../../guard/src/network.js'
import { startNetworkProxy, type NetworkProxy } from '../../guard/src/network-proxy.js'

const SANDBOX_HOME = '/home/user'
const SANDBOX_DSH_HOME = `${SANDBOX_HOME}/.dsh`
const SANDBOX_RUNTIME = '/opt/superagent'
const SANDBOX_NODE = '/opt/node'
const SANDBOX_BRIDGE = '/run/superagent'
const SANDBOX_NETWORK = '/run/superagent-net'
const FIXED_PATH = '/opt:/opt/superagent/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const ENTRYPOINT_RELATIVE = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
const BOOTSTRAP_RELATIVE = 'bootstrap.mjs'
const PROXY_SOCKET_RELATIVE = 'proxy.sock'
const PROXY_PORT = 18_080
const DEFAULT_PANEL_PORT = 3_082
const PROXY_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 3_000
const KILL_WAIT_MS = 1_000
const MAX_LOG_BUFFER = 64 * 1024
const MAX_LOG_LINE = 8 * 1024
const MAX_LOG_OUTPUT = 256 * 1024

const ALLOWED_ENV = new Set([
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DSH_HOME',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TZ',
])

export type SuperagentSupervisorExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type SuperagentSupervisorOptions = {
  runtimeDir: string
  homeDir: string
  bridgeDir: string
  nodeBinary?: string
  panelPort?: number
  env?: Readonly<Record<string, string | undefined>>
  log?: (line: string) => void
  onExit?: (exit: SuperagentSupervisorExit) => void
}

type PreparedPaths = {
  runtimeDir: string
  homeDir: string
  bridgeDir: string
  nodeBinary: string
  entrypoint: string
  bootstrap: string
}

type NetworkRuntime = {
  directory: string
  socket: string
  proxy: NetworkProxy
}

type ActiveRun = {
  child: ChildProcess
  network: NetworkRuntime
}

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`${name} must be an absolute path`)
}

function directory(path: string, name: string): string {
  requireAbsolute(path, name)
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch (error) {
    throw new Error(`${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!statSync(resolved).isDirectory()) throw new Error(`${name} is not a directory`)
  return resolved
}

function privateDirectory(path: string, name: string): string {
  const resolved = directory(path, name)
  const mode = statSync(resolved).mode
  if ((mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or other users`)
  accessSync(resolved, constants.W_OK)
  return resolved
}

function executable(path: string, name: string): string {
  requireAbsolute(path, name)
  let resolved: string
  try {
    resolved = realpathSync(path)
    accessSync(resolved, constants.X_OK)
  } catch (error) {
    throw new Error(`${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!statSync(resolved).isFile()) throw new Error(`${name} is not a file`)
  return resolved
}

function fileInside(root: string, path: string, name: string): string {
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch (error) {
    throw new Error(`${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const remainder = relative(root, resolved)
  if (remainder === '' || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${name} must stay inside runtimeDir`)
  }
  if (!statSync(resolved).isFile()) throw new Error(`${name} is not a file`)
  return resolved
}

function preparePaths(options: SuperagentSupervisorOptions): PreparedPaths {
  const runtimeDir = directory(options.runtimeDir, 'runtimeDir')
  const homeDir = privateDirectory(options.homeDir, 'homeDir')
  const bridgeDir = directory(options.bridgeDir, 'bridgeDir')
  const nodeBinary = executable(options.nodeBinary ?? process.execPath, 'nodeBinary')
  const entrypoint = fileInside(runtimeDir, join(runtimeDir, ENTRYPOINT_RELATIVE), 'runtime entrypoint')
  const bootstrap = fileInside(runtimeDir, join(runtimeDir, BOOTSTRAP_RELATIVE), 'runtime bootstrap')
  return { runtimeDir, homeDir, bridgeDir, nodeBinary, entrypoint, bootstrap }
}

function findBubblewrap(): string {
  const candidates = (process.env.PATH ?? '').split(':').filter(Boolean).map(path => join(path, 'bwrap'))
  candidates.push('/usr/bin/bwrap', '/bin/bwrap')
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {
      // Try the next PATH entry. The child still receives a fixed environment.
    }
  }
  throw new Error('bwrap is unavailable; refusing to run the superagent outside isolation')
}

function panelPort(options: SuperagentSupervisorOptions): number {
  const value = options.panelPort ?? DEFAULT_PANEL_PORT
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65_535 || value === PROXY_PORT) {
    throw new Error('panelPort must be an integer from 1024 to 65535 and must not use the proxy port')
  }
  return value
}

function childEnvironment(options: SuperagentSupervisorOptions, port: number): NodeJS.ProcessEnv {
  const input = options.env ?? {}
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ENV.has(key)) throw new Error(`environment variable ${key} is not allowed for the superagent`)
    const value = input[key]
    if (value !== undefined && value.includes('\0')) throw new Error(`environment variable ${key} contains NUL`)
  }
  const requestedHome = input.HOME
  if (requestedHome !== undefined && requestedHome !== SANDBOX_HOME) throw new Error('HOME must stay inside the superagent sandbox')
  const requestedDshHome = input.DSH_HOME
  if (requestedDshHome !== undefined && requestedDshHome !== SANDBOX_DSH_HOME) {
    throw new Error('DSH_HOME must stay inside the superagent sandbox')
  }
  const requestedPath = input.PATH
  if (requestedPath !== undefined && requestedPath !== FIXED_PATH) throw new Error('PATH is fixed inside the superagent sandbox')
  const proxy = `http://127.0.0.1:${PROXY_PORT}`
  const env: NodeJS.ProcessEnv = {
    HOME: SANDBOX_HOME,
    DSH_HOME: SANDBOX_DSH_HOME,
    PATH: FIXED_PATH,
    LANG: input.LANG ?? 'C.UTF-8',
    DSHBOT_SUPERAGENT_PORT: String(port),
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: '',
    NODE_USE_ENV_PROXY: '1',
  }
  for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'LC_ALL', 'TZ'] as const) {
    const value = input[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function sandboxArguments(paths: PreparedPaths, network: NetworkRuntime, env: NodeJS.ProcessEnv): string[] {
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/lib', '/lib',
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--dir', '/home',
    '--dir', '/opt',
    '--dir', '/run',
    '--bind', paths.homeDir, SANDBOX_HOME,
    '--ro-bind', paths.runtimeDir, SANDBOX_RUNTIME,
    '--ro-bind', paths.nodeBinary, SANDBOX_NODE,
    '--ro-bind', paths.bridgeDir, SANDBOX_BRIDGE,
    '--ro-bind', network.directory, SANDBOX_NETWORK,
    '--chdir', SANDBOX_HOME,
    '--setenv', 'HOME', SANDBOX_HOME,
    '--setenv', 'DSH_HOME', SANDBOX_DSH_HOME,
    '--setenv', 'PATH', FIXED_PATH,
    '--setenv', 'LANG', env.LANG ?? 'C.UTF-8',
    SANDBOX_NODE,
    `${SANDBOX_RUNTIME}/${BOOTSTRAP_RELATIVE}`,
  ]
  if (env.LC_ALL !== undefined) args.splice(args.lastIndexOf(SANDBOX_NODE), 0, '--setenv', 'LC_ALL', env.LC_ALL)
  if (env.TZ !== undefined) args.splice(args.lastIndexOf(SANDBOX_NODE), 0, '--setenv', 'TZ', env.TZ)
  return args
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (typeof pid !== 'number' || pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    try { child.kill(signal) } catch { /* The process can exit between the group and direct signal. */ }
  }
}

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!alive(child)) return Promise.resolve(true)
  return new Promise(resolve => {
    let finished = false
    const onExit = () => finish(true)
    const finish = (exited: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
  })
}

function scrub(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) if (secret !== '') result = result.split(secret).join('[REDACTED]')
  result = result.replace(/(\bAuthorization\b\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]')
  return result.replace(/(\b(?:[A-Z][A-Z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD)|KEY|TOKEN|SECRET|PASSWORD|ACCESS_TOKEN|API_KEY)\b\s*[:=]\s*)[^\s&;,}"')\]]+/gi,
    '$1[REDACTED]')
}

function pipeLog(stream: NodeJS.ReadableStream | null, log: ((line: string) => void) | undefined, secrets: readonly string[]): void {
  if (!stream) return
  let pending = ''
  let emitted = 0
  const emit = (line: string) => {
    if (emitted >= MAX_LOG_OUTPUT) return
    const available = MAX_LOG_OUTPUT - emitted
    const bounded = line.slice(0, Math.min(MAX_LOG_LINE, available))
    emitted += bounded.length
    if (!log) return
    try { log(scrub(bounded, secrets)) } catch { /* A logger must not own the child lifecycle. */ }
  }
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk: string | Buffer) => {
    if (emitted >= MAX_LOG_OUTPUT) return
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    while (true) {
      const newline = pending.indexOf('\n')
      if (newline < 0) break
      emit(pending.slice(0, newline).replace(/\r$/, ''))
      pending = pending.slice(newline + 1)
    }
    if (pending.length > MAX_LOG_BUFFER) {
      emit(`${pending.slice(0, MAX_LOG_LINE)} [output truncated]`)
      pending = ''
    }
  })
  stream.once('end', () => {
    if (pending !== '' && emitted < MAX_LOG_OUTPUT) emit(pending)
  })
}

/** The proxy accepts only public addresses and only its ordinary HTTP(S) ports. */
export async function resolveSuperagentProxyTarget(raw: string): Promise<string> {
  let target: URL
  try { target = new URL(raw) } catch { throw new Error('proxy target must be an absolute URL') }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('proxy supports only http and https')
  if (target.username !== '' || target.password !== '') throw new Error('proxy target must not contain credentials')
  const port = target.port || (target.protocol === 'http:' ? '80' : '443')
  if (port !== '80' && port !== '443') throw new Error('proxy allows only ports 80 and 443')
  return resolvePublicTarget(target.href)
}

async function startNetwork(): Promise<NetworkRuntime> {
  const directory = mkdtempSync(join(tmpdir(), 'dshbot-superagent-net-'))
  chmodSync(directory, 0o700)
  const socket = join(directory, PROXY_SOCKET_RELATIVE)
  try {
    const proxy = await startNetworkProxy(resolveSuperagentProxyTarget, PROXY_TIMEOUT_MS, {
      listenPath: socket,
      exposeRefusal: true,
    })
    return { directory, socket, proxy }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function stopNetwork(network: NetworkRuntime): void {
  try { network.proxy.stop() } catch { /* Closing an already closed proxy is harmless. */ }
}

function removeNetwork(network: NetworkRuntime): void {
  stopNetwork(network)
  try { rmSync(network.directory, { recursive: true, force: true }) } catch { /* Best-effort cleanup after the child owns the mount. */ }
}

export function createSuperagentSupervisor(options: SuperagentSupervisorOptions): {
  start(): Promise<void>
  stop(): Promise<void>
  panic(): void
  running(): boolean
} {
  let active: ActiveRun | undefined
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let desiredStopped = true
  let startGeneration = 0

  const report = (line: string) => {
    try { options.log?.(line) } catch { /* Logging must not change supervision state. */ }
  }

  function handleExit(run: ActiveRun, exit: SuperagentSupervisorExit): void {
    if (active !== run) return
    removeNetwork(run.network)
    active = undefined
    try { options.onExit?.(exit) } catch (error) {
      report(`superagent supervisor onExit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function reapDeadChild(): void {
    const run = active
    if (!run || alive(run.child)) return
    handleExit(run, { code: run.child.exitCode, signal: run.child.signalCode })
  }

  async function start(): Promise<void> {
    reapDeadChild()
    if (active && alive(active.child)) return
    if (startPromise) return startPromise
    desiredStopped = false
    const generation = ++startGeneration
    const pending = (async () => {
      const paths = preparePaths(options)
      const port = panelPort(options)
      const env = childEnvironment(options, port)
      const network = await startNetwork()
      let processChild: ChildProcess | undefined
      try {
        if (desiredStopped || generation !== startGeneration) {
          removeNetwork(network)
          return
        }
        const bwrap = findBubblewrap()
        processChild = spawn(bwrap, sandboxArguments(paths, network, env), {
          cwd: '/',
          detached: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        })
        const run: ActiveRun = { child: processChild, network }
        active = run
        const secrets = Object.entries(env)
          .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|BASE_URL/i.test(key) && value !== undefined)
          .map(([, value]) => value!)
        pipeLog(processChild.stdout, options.log, secrets)
        pipeLog(processChild.stderr, options.log, secrets)
        processChild.on('error', error => report(`superagent supervisor child error: ${error.message}`))
        processChild.once('exit', (code, signal) => handleExit(run, { code, signal }))
        await new Promise<void>((resolve, reject) => {
          const onSpawn = () => { cleanup(); resolve() }
          const onError = (error: Error) => { cleanup(); reject(error) }
          const cleanup = () => {
            processChild!.off('spawn', onSpawn)
            processChild!.off('error', onError)
          }
          processChild!.once('spawn', onSpawn)
          processChild!.once('error', onError)
        }).catch(error => {
          if (active === run) {
            removeNetwork(run.network)
            active = undefined
          }
          throw new Error(`failed to start isolated superagent: ${error instanceof Error ? error.message : String(error)}`)
        })
      } catch (error) {
        if (processChild === undefined) removeNetwork(network)
        throw error
      }
    })()
    startPromise = pending
    try { await pending } finally {
      if (startPromise === pending) startPromise = undefined
    }
  }

  async function stop(): Promise<void> {
    desiredStopped = true
    startGeneration++
    if (stopPromise) return stopPromise
    const pending = (async () => {
      if (startPromise) {
        try { await startPromise } catch { return }
      }
      reapDeadChild()
      const run = active
      if (!run || !alive(run.child)) return
      stopNetwork(run.network)
      signalGroup(run.child, 'SIGTERM')
      if (await waitForExit(run.child, STOP_TIMEOUT_MS)) return
      signalGroup(run.child, 'SIGKILL')
      await waitForExit(run.child, KILL_WAIT_MS)
    })()
    stopPromise = pending
    try { await pending } finally {
      if (stopPromise === pending) stopPromise = undefined
    }
  }

  function panic(): void {
    desiredStopped = true
    startGeneration++
    const run = active
    if (!run || !alive(run.child)) return
    stopNetwork(run.network)
    signalGroup(run.child, 'SIGKILL')
  }

  return {
    start,
    stop,
    panic,
    running: () => active !== undefined && alive(active.child),
  }
}
