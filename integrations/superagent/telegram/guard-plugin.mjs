import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { installConfinementGuards, installUsageReporter } from './guard.mjs'

export const name = 'dshbot-superagent-guard'
export const inject = ['agents', 'connection']

const PANEL_URL = 'http://127.0.0.1:3082/'
const PANEL_AUTH_FILE = 'panel-auth.json'
const PANEL_TOKEN = /^[A-Za-z0-9_-]{16,512}$/u

export const Config = Schema.object({
  socketPath: Schema.string().pattern(/^\/[^\0]*$/).required()
    .description('Absolute Unix HTTP socket owned by the Telegram bot.'),
  projectId: Schema.number().min(0).max(Number.MAX_SAFE_INTEGER).step(1).required()
    .description('Non-negative factory project ID.'),
  stateDir: Schema.string().pattern(/^\/[^\0]*$/).required()
    .description('Absolute private state directory for the usage ledger.'),
})

function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value
}

function absolutePath(value, name, { root = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value) || (!root && value === '/')) {
    throw new TypeError(`${name} must be an absolute path${root ? '' : ' below /'}`)
  }
  return value
}

function projectId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('projectId must be a non-negative safe integer')
  return value
}

export function normalizeGuardConfig(value) {
  const config = record(value, 'guard plugin config')
  const unknown = Object.keys(config).find(key => !['socketPath', 'projectId', 'stateDir'].includes(key))
  if (unknown !== undefined) throw new TypeError(`Unknown guard plugin config key: ${unknown}`)
  return Object.freeze({
    socketPath: absolutePath(config.socketPath, 'socketPath'),
    projectId: projectId(config.projectId),
    stateDir: absolutePath(config.stateDir, 'stateDir'),
  })
}

export function panelAuthPath(stateDir) {
  return join(absolutePath(stateDir, 'stateDir'), PANEL_AUTH_FILE)
}

export function extractPanelToken(authenticatedUrl) {
  let url
  try {
    url = new URL(authenticatedUrl)
  } catch {
    throw new TypeError('connection.authenticatedUrl() must return a URL')
  }
  const tokens = url.searchParams.getAll('token')
  if (tokens.length !== 1 || url.origin !== 'http://127.0.0.1:3082' || url.pathname !== '/' || url.hash !== '' || [...url.searchParams.keys()].some(key => key !== 'token')) {
    throw new TypeError('connection.authenticatedUrl() returned an unexpected panel URL')
  }
  const [token] = tokens
  if (!PANEL_TOKEN.test(token)) throw new TypeError('panel launch token has an invalid format')
  return token
}

/** Persist only the launch token; the parent proxy reads this fixed private handoff. */
export function writePanelAuth(stateDir, token) {
  if (!PANEL_TOKEN.test(token)) throw new TypeError('panel launch token has an invalid format')
  const path = panelAuthPath(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(temporary, `${JSON.stringify({ token })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  return path
}

/** Install confinement and usage before publishing the dependency Runtime waits for. */
export async function installGuardServices(ctx, rawConfig, options = {}) {
  const config = normalizeGuardConfig(rawConfig)
  const guards = await installConfinementGuards(ctx, options)
  let usage
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    usage?.dispose()
    guards.dispose()
  }

  try {
    usage = installUsageReporter(ctx, {
      ...options.usage,
      projectId: config.projectId,
      stateDir: config.stateDir,
      socketPath: config.socketPath,
      log: message => ctx.logger?.warn?.(message),
    })
    const token = extractPanelToken(ctx.connection.authenticatedUrl(PANEL_URL))
    writePanelAuth(config.stateDir, token)
    if (typeof ctx?.effect !== 'function') throw new TypeError('guard plugin requires ctx.effect')
    if (typeof ctx?.provide !== 'function') throw new TypeError('guard plugin requires ctx.provide')
    ctx.effect(() => dispose, 'dshbot-superagent guard and usage services')
    ctx.provide('dshbotSuperagentGuard', { ready: true })
  } catch (error) {
    dispose()
    throw error
  }
  return { config, guards, usage, dispose }
}

export async function apply(ctx, rawConfig, options = {}) {
  await installGuardServices(ctx, rawConfig, options)
}
