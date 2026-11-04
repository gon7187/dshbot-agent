import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_GUARD_SPECIFIER = '../guard.ts'
const SOURCE_GUARD_SPECIFIER = '../../../packages/guard/src/index.ts'
const LEDGER_VERSION = 1
const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1_000]
const DEFAULT_RETRY_INTERVAL_MS = 5_000
const MAX_RETRY_INTERVAL_MS = 60_000
const MAX_EVENT_TIME_MS = 8_640_000_000_000_000
const SHELL_TOOLS = new Set(['bash', 'exec', 'pwsh', 'shell'])
const FILE_WRITE_TOOLS = new Set(['edit', 'edit_file', 'write', 'write_file'])
const FILE_PATH_KEYS = ['file_path', 'filePath', 'filename', 'path', 'target', 'targetPath']

/** Installed layout: <runtimeRoot>/telegram/guard.mjs -> <runtimeRoot>/guard.ts. */
export const INSTALLED_GUARD_SPECIFIER = DEFAULT_GUARD_SPECIFIER

function ownerAction(reason) {
  return `Owner action required: ${reason}`
}

function moduleWithGuardExports(module) {
  const value = module?.default && typeof module.default === 'object'
    ? { ...module.default, ...module }
    : module
  if (typeof value?.checkCommand !== 'function' || typeof value?.isProtected !== 'function') {
    throw new TypeError('guard module must export checkCommand and isProtected')
  }
  return value
}

function moduleSpecifier(value) {
  if (value instanceof URL) return value.href
  if (typeof value !== 'string') return value
  if (isAbsolute(value)) return pathToFileURL(value).href
  return pathToFileURL(resolve(value)).href
}

/**
 * Load the repository guard rather than maintaining a second command/path policy.
 * The explicit module seam keeps the pure policy testable; production uses the
 * copy installed beside the runtime, or DSHBOT_SUPERAGENT_GUARD_PATH.
 */
export async function loadGuard(options = {}) {
  if (options.guardModule !== undefined) return moduleWithGuardExports(options.guardModule)
  const candidates = [
    options.guardPath,
    process.env.DSHBOT_SUPERAGENT_GUARD_PATH,
    new URL(DEFAULT_GUARD_SPECIFIER, import.meta.url),
    new URL(SOURCE_GUARD_SPECIFIER, import.meta.url),
  ].filter(value => value !== undefined)
  let lastError
  for (const candidate of candidates) {
    try {
      return moduleWithGuardExports(await import(moduleSpecifier(candidate)))
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`Unable to load the shared guard: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function stringArgument(args, keys) {
  for (const key of keys) {
    if (typeof args?.[key] === 'string') return args[key]
  }
  return undefined
}

function fileTargets(args) {
  const targets = []
  for (const key of FILE_PATH_KEYS) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim() !== '') targets.push(value)
  }
  return targets
}

function workspaceOf(agent, fallback) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
  return typeof fallback === 'function' ? fallback(agent) : fallback
}

function shellCommand(args) {
  return stringArgument(args, ['command', 'cmd', 'script'])
}

function isControlledMerge(command) {
  // A shell guard is intentionally conservative here. The actual PR helper is
  // where checks/review/ancestry can be verified; regex cannot prove those facts.
  return /\bgh\s+pr\s+merge(?:\s|$)/u.test(command)
}

function confinementReason(execution, guard, options = {}) {
  const name = String(execution?.name ?? '').toLowerCase()
  const args = execution?.arguments

  if (SHELL_TOOLS.has(name)) {
    const command = shellCommand(args)
    if (name === 'pwsh') return ownerAction('PowerShell commands cannot be classified by the shared shell guard')
    if (command === undefined || command.trim() === '') return ownerAction(`${name} command is missing`)
    if (isControlledMerge(command)) return ownerAction('gh pr merge requires the controlled PR helper and verified checks/review')
    let checked
    try {
      checked = guard.checkCommand(command, { sandbox: true })
    } catch (error) {
      return ownerAction(`shared command guard failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!checked || checked.verdict !== 'allow') {
      const verdict = checked?.verdict ?? 'unknown'
      const reason = checked?.reason ?? 'shared guard returned no reason'
      return ownerAction(`sandbox command is ${verdict}: ${reason}`)
    }
    return undefined
  }

  if (FILE_WRITE_TOOLS.has(name)) {
    const targets = fileTargets(args)
    if (targets.length === 0) return ownerAction(`${name} target path is missing`)
    const workspace = workspaceOf(execution?.agent, options.workspaceOf)
    if (typeof workspace !== 'string' || workspace.trim() === '') return ownerAction('agent workspace is unavailable')
    for (const target of targets) {
      let protectedPath
      try {
        protectedPath = guard.isProtected(target, workspace)
      } catch (error) {
        return ownerAction(`shared protected-path guard failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (protectedPath) return ownerAction(`${name} of protected path ${target} requires the controlled review path`)
    }
  }
  return undefined
}

/** Pure shell/file policy used by each agent-scoped tools.guard callback. */
export function guardExecution(execution, guard, options = {}) {
  return confinementReason(execution, guard, options)
}

/**
 * Install the same guard on every currently live agent and every future agent,
 * including worker subagents. A missing guard service is a startup failure, not
 * a reason to run an unconfined sidecar.
 */
export async function installConfinementGuards(ctx, options = {}) {
  const guard = await loadGuard(options)
  if (!ctx?.agents || typeof ctx.agents.list !== 'function' || typeof ctx.on !== 'function') {
    throw new TypeError('confinement guard requires ctx.agents and ctx.on')
  }
  const installed = new Map()
  let disposed = false

  const install = (agent) => {
    if (disposed || !agent || installed.has(agent)) return
    if (typeof agent.ctx?.tools?.guard !== 'function') throw new Error(`agent ${String(agent.id)} has no tools.guard service`)
    const remove = agent.ctx.tools.guard(execution => guardExecution(execution, guard, options))
    installed.set(agent, typeof remove === 'function' ? remove : () => {})
  }
  const release = (agent) => {
    const remove = installed.get(agent)
    if (remove === undefined) return
    installed.delete(agent)
    remove()
  }

  const createdDisposer = ctx.on('agent/created', event => install(event?.agent ?? event), { global: true })
  const disposedDisposer = ctx.on('agent/disposed', event => release(event?.agent ?? event), { global: true })
  try {
    for (const agent of ctx.agents.list()) install(agent)
  } catch (error) {
    disposedDisposer?.()
    createdDisposer?.()
    for (const remove of installed.values()) remove()
    throw error
  }

  return {
    guard,
    dispose() {
      if (disposed) return
      disposed = true
      disposedDisposer?.()
      createdDisposer?.()
      for (const remove of installed.values()) remove()
      installed.clear()
    },
  }
}

/** Return changed paths that the shared guard marks as protected. */
export function protectedChangedPaths(paths, repoRoot, guard) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array')
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') throw new TypeError('repoRoot must be a non-empty string')
  if (typeof guard?.isProtected !== 'function') throw new TypeError('guard.isProtected is required')
  return [...new Set(paths.filter(path => typeof path === 'string' && guard.isProtected(path, repoRoot)))]
}

/** Gate a publish step before it can send a diff containing a protected path. */
export function assertNoProtectedChanges(paths, repoRoot, guard) {
  const protectedPaths = protectedChangedPaths(paths, repoRoot, guard)
  if (protectedPaths.length > 0) {
    throw new Error(`protected paths require the controlled review path: ${protectedPaths.join(', ')}`)
  }
}

function validProjectId(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function tokenCount(value, field, optional = false) {
  if (value === undefined && optional) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
  return value
}

function eventTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_EVENT_TIME_MS ? value : undefined
}

function usagePayload(projectId, sessionId, at, id, provider, model, usage) {
  if (!validProjectId(projectId) || eventTime(at) === undefined || typeof id !== 'string' || id === ''
    || typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined
  const payload = {
    projectId,
    id,
    provider,
    model,
    inputTokens: tokenCount(usage.inputTokens, 'inputTokens'),
    cacheReadTokens: tokenCount(usage.cacheReadTokens, 'cacheReadTokens', true),
    cacheWriteTokens: tokenCount(usage.cacheWriteTokens, 'cacheWriteTokens', true),
    outputTokens: tokenCount(usage.outputTokens, 'outputTokens'),
    at,
  }
  return typeof sessionId === 'string' && sessionId !== '' ? { ...payload, sessionId } : payload
}

/** Convert the pinned DSH paid events into the bot usage contract. */
export function usagePayloadOf(projectId, sessionId, event) {
  if (event?.type !== 'assistant/message' && event?.type !== 'compaction/summary') return undefined
  const data = event.data
  const usage = data?.usage
  if (!usage) return undefined
  if (event.type === 'assistant/message') {
    const message = data?.message
    const source = message?.source
    if (source?.kind !== 'model') return undefined
    const messageId = message?.id
    const fallbackId = Number.isSafeInteger(event.seq) ? `${String(sessionId)}:${event.seq}` : undefined
    const id = messageId === undefined ? fallbackId : String(messageId)
    return id === undefined ? undefined : usagePayload(projectId, sessionId, event.time, id, source.provider, source.model, usage)
  }
  if (typeof sessionId !== 'string' || sessionId === '' || typeof data?.compactionId !== 'string' || data.compactionId === '') {
    return undefined
  }
  return usagePayload(projectId, sessionId, event.time, `compaction:${sessionId}:${data.compactionId}`, data.provider, data.model, usage)
}

function sleep(milliseconds) {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  })
}

function ledgerFile(options) {
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = options.ledgerPath ?? join(stateDir, 'usage-ledger.json')
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('ledgerPath must be an absolute path')
  return path
}

function emptyLedger() {
  return { version: LEDGER_VERSION, entries: Object.create(null) }
}

function readLedger(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.version !== LEDGER_VERSION || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
      throw new Error('unsupported usage ledger format')
    }
    return { version: LEDGER_VERSION, entries: Object.assign(Object.create(null), value.entries) }
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger()
    if (error instanceof SyntaxError) throw new Error(`usage ledger is corrupt: ${error.message}`)
    throw error
  }
}

function writeLedger(path, ledger) {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  writeFileSync(temporary, JSON.stringify(ledger) + '\n', { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function postJson(socketPath, payload, timeoutMs) {
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new TypeError('socketPath must be an absolute path')
  const body = JSON.stringify(payload)
  return new Promise((resolvePromise, reject) => {
    let settled = false
    const settle = (error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolvePromise()
    }
    const request = httpRequest({
      socketPath,
      method: 'POST',
      path: '/usage',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) },
    }, response => {
      response.resume()
      response.once('end', () => {
        const status = response.statusCode ?? 0
        settle(status >= 200 && status < 300 ? undefined : new Error(`usage endpoint returned HTTP ${status}`))
      })
      response.once('error', error => settle(error))
    })
    request.once('error', settle)
    request.setTimeout(timeoutMs, () => { request.destroy(); settle(new Error('usage endpoint timeout')) })
    request.end(body)
  })
}

function responseSucceeded(value) {
  if (value === false) return false
  if (value && typeof value.status === 'number') return value.status >= 200 && value.status < 300
  return true
}

function samePayload(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Durable, idempotent usage delivery. The ledger is deliberately separate
 * from the bot database: the sidecar keeps only pending UDS rows, while the
 * bot remains the single owner of deduplication/accounting rows. No budget cap
 * is introduced here.
 */
export function createUsageReporter(options) {
  if (!validProjectId(options?.projectId)) throw new TypeError('projectId must be a non-negative safe integer')
  if (typeof options?.postUsage !== 'function' && (typeof options?.socketPath !== 'string' || !isAbsolute(options.socketPath))) {
    throw new TypeError('postUsage or an absolute socketPath is required')
  }
  const path = ledgerFile(options)
  const ledger = readLedger(path)
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  if (!Array.isArray(delays) || delays.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('retryDelaysMs must contain non-negative safe integers')
  }
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS
  const retryMaxIntervalMs = options.retryMaxIntervalMs ?? MAX_RETRY_INTERVAL_MS
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0 || retryIntervalMs > MAX_RETRY_INTERVAL_MS) {
    throw new TypeError(`retryIntervalMs must be a positive safe integer no greater than ${MAX_RETRY_INTERVAL_MS}`)
  }
  if (!Number.isSafeInteger(retryMaxIntervalMs) || retryMaxIntervalMs < retryIntervalMs || retryMaxIntervalMs > MAX_RETRY_INTERVAL_MS) {
    throw new TypeError(`retryMaxIntervalMs must be between retryIntervalMs and ${MAX_RETRY_INTERVAL_MS}`)
  }
  const timeoutMs = options.timeoutMs ?? 5_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive safe integer')
  const send = options.postUsage ?? (payload => postJson(options.socketPath, payload, timeoutMs))
  const inFlight = new Set()
  const sentIds = new Set()
  let pumping = false
  let pumpPromise = Promise.resolve()
  let lastError
  let retryTimer
  let nextRetryMs = retryIntervalMs
  let disposed = false
  let abortListener

  const persist = () => writeLedger(path, ledger)
  let prunedSent = false
  for (const [id, entry] of Object.entries(ledger.entries)) {
    if (entry?.status === 'sent') {
      delete ledger.entries[id]
      prunedSent = true
    }
  }
  if (prunedSent) persist()
  const pending = () => Object.values(ledger.entries).filter(entry => entry?.status === 'pending' && entry.payload)

  const clearRetryTimer = () => {
    if (retryTimer === undefined) return
    clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer !== undefined || pending().length === 0) return
    const delay = nextRetryMs
    nextRetryMs = Math.min(retryMaxIntervalMs, Math.max(retryIntervalMs, nextRetryMs * 2))
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void pump()
    }, delay)
    retryTimer.unref?.()
  }

  const deliver = async (payload) => {
    if (disposed) throw new Error('usage reporter disposed')
    let error
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) await sleep(delays[attempt - 1])
      if (disposed) throw new Error('usage reporter disposed')
      try {
        const result = await send(payload)
        if (disposed) throw new Error('usage reporter disposed')
        if (!responseSucceeded(result)) throw new Error('usage endpoint rejected the payload')
        return
      } catch (caught) {
        error = caught
      }
    }
    throw error instanceof Error ? error : new Error(String(error))
  }

  const pump = () => {
    if (disposed) return Promise.resolve()
    if (pumping) return pumpPromise
    clearRetryTimer()
    pumping = true
    pumpPromise = (async () => {
      const attempted = new Set()
      for (;;) {
        const next = pending().filter(entry => !attempted.has(entry.payload.id) && !inFlight.has(entry.payload.id))
        if (next.length === 0) break
        for (const entry of next) {
          const id = entry.payload.id
          attempted.add(id)
          inFlight.add(id)
          try {
            await deliver(entry.payload)
            delete ledger.entries[id]
            sentIds.add(id)
            persist()
          } catch (error) {
            lastError = error
            options.log?.(`usage delivery ${id} failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            inFlight.delete(id)
          }
        }
      }
    })().catch(error => {
      lastError = error
      options.log?.(`usage ledger pump failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      pumping = false
      if (pending().length > 0) scheduleRetry()
      else nextRetryMs = retryIntervalMs
    })
    return pumpPromise
  }

  const record = (payload) => {
    if (disposed) return false
    if (!samePayload(payload, { ...payload, projectId: options.projectId })) {
      throw new TypeError('usage payload is not JSON-stable')
    }
    if (sentIds.has(payload.id)) return false
    const existing = ledger.entries[payload.id]
    if (existing !== undefined) {
      if (!samePayload(existing.payload, payload)) throw new Error(`usage id ${payload.id} was already used for a different payload`)
      if (inFlight.has(payload.id)) return false
    } else {
      ledger.entries[payload.id] = { status: 'pending', payload }
      persist()
    }
    void pump()
    return true
  }

  const recordEvent = (sessionId, event) => {
    const payload = usagePayloadOf(options.projectId, sessionId, event)
    return payload === undefined ? false : record(payload)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    clearRetryTimer()
    if (abortListener !== undefined) options.signal?.removeEventListener?.('abort', abortListener)
  }

  if (options.signal !== undefined) {
    if (typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function') {
      throw new TypeError('signal must be an AbortSignal')
    }
    abortListener = () => dispose()
    options.signal.addEventListener('abort', abortListener, { once: true })
    if (options.signal.aborted) dispose()
  }

  // Pending rows from an earlier process are retried with their original ids.
  // Start on the next microtask so a just-created reporter can record its first
  // event before the empty-ledger sweep observes and exits; keep that promise in
  // flush() so callers can await the restart sweep too.
  pumpPromise = Promise.resolve().then(() => pump())

  return {
    record,
    recordEvent,
    retry: pump,
    flush: pump,
    dispose,
    get lastError() { return lastError },
    ledgerPath: path,
  }
}

/** Subscribe once at the root context so main, worker and subagent events count. */
export function installUsageReporter(ctx, options) {
  const reporter = createUsageReporter(options)
  if (typeof ctx?.on !== 'function') throw new TypeError('usage reporter requires ctx.on')
  const remove = ctx.on('session/event', (session, event) => {
    reporter.recordEvent(String(session?.id ?? ''), event)
  }, { global: true })
  return {
    reporter,
    dispose() { reporter.dispose(); remove?.() },
  }
}
