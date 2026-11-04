#!/opt/node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { PROJECT_PATH, SOCKET_PATH, readProjectId } from './github-cli.mjs'
import { requestUnix } from './bridge.mjs'

export const MAX_TITLE_CODEPOINTS = 200
export const MAX_PATCH_BYTES = 200 * 1024
export const MAX_DELIVERY_REQUEST_BYTES = 256 * 1024
export const DELIVERY_TIMEOUT_MS = 30 * 60 * 1000
export const MAX_SUPERAGENT_NAME_LENGTH = 128
const RPC_TIMEOUT_MS = 120_000
const SAFE_GIT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ']

function projectId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('projectId must be a non-negative safe integer')
  return value
}

function text(value, name) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${name} must be a string without NUL`)
  return value
}

function titleOf(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) throw new Error('delivery CLI requires exactly one title argument')
  const title = text(argv[0], 'title')
  if (title.trim() === '') throw new Error('title must not be empty')
  if (Array.from(title).length > MAX_TITLE_CODEPOINTS) throw new Error(`title must be at most ${MAX_TITLE_CODEPOINTS} characters`)
  return title
}

export function superagentNameOf(value) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new Error('DSH_SUPERAGENT_NAME must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
  }
  return value
}

function environment(input = process.env) {
  const env = {}
  for (const key of SAFE_GIT_ENV) {
    const value = input[key]
    if (typeof value === 'string' && !value.includes('\0')) env[key] = value
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

function bytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value === undefined || value === null) return Buffer.alloc(0)
  throw new Error('git returned non-text output')
}

function gitResult(cwd, args, run, env) {
  let result
  try {
    result = run('git', args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: null,
    })
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result === null || typeof result !== 'object') throw new Error(`git ${args.join(' ')} returned no result`)
  const stdout = bytes(result.stdout)
  const stderr = bytes(result.stderr).toString('utf8').trim()
  if (result.error !== undefined && result.error !== null) throw new Error(`git ${args.join(' ')} failed: ${String(result.error.message ?? result.error)}`)
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed${stderr === '' ? '' : `: ${stderr}`}`)
  return stdout
}

function gitText(cwd, args, run, env) {
  const output = gitResult(cwd, args, run, env).toString('utf8')
  if (output.includes('\0')) throw new Error(`git ${args.join(' ')} returned NUL`)
  return output
}

function repositoryRoot(cwd, run, env) {
  const root = gitText(cwd, ['rev-parse', '--show-toplevel'], run, env).trim()
  if (root === '' || root.includes('\0')) throw new Error('git repository root is empty')
  return root
}

function originBase(cwd, run, env) {
  const ref = gitText(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], run, env).trim()
  if (!/^origin\/[A-Za-z0-9._/-]+$/.test(ref) || ref.endsWith('/HEAD') || ref.includes('..')) {
    throw new Error('origin/HEAD does not name a safe origin branch')
  }
  return ref
}

function shaOf(value) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('base commit is not a hexadecimal Git object id')
  return value
}

export function deliveryId(project, baseSha, patch, ticket = '') {
  const id = projectId(project)
  text(baseSha, 'baseSha')
  text(patch, 'patch')
  const name = superagentNameOf(ticket)
  const material = `${id}\0${baseSha}\0${patch}${name === '' ? '' : `\0${name}`}`
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

function responseObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} returned a non-object response`)
  return value
}

function assertRequestSize(body) {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  if (bytes > MAX_DELIVERY_REQUEST_BYTES) throw new Error(`serialized delivery request exceeds ${MAX_DELIVERY_REQUEST_BYTES} bytes`)
}

function pollState(value) {
  const body = responseObject(value, 'delivery broker')
  if (!['pending', 'queued', 'testing', 'review', 'publishing', 'pr_open', 'merged', 'failed'].includes(body.state)) {
    throw new Error('delivery broker returned an invalid state')
  }
  return body
}

function errorDetail(body) {
  for (const key of ['error', 'reason', 'message']) if (typeof body[key] === 'string' && body[key] !== '') return body[key]
  return 'broker reported failed delivery'
}

export async function runDelivery({
  argv = process.argv.slice(2),
  projectPath = PROJECT_PATH,
  projectId: configuredProjectId,
  socketPath = SOCKET_PATH,
  cwd = process.cwd(),
  run = spawnSync,
  request = requestUnix,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  deadlineMs = DELIVERY_TIMEOUT_MS,
  intervalMs = 5_000,
  writeStdout = value => process.stdout.write(value),
  superagentName: configuredSuperagentName,
} = {}) {
  const title = titleOf(argv)
  const id = configuredProjectId === undefined ? readProjectId(projectPath) : projectId(configuredProjectId)
  const ticket = superagentNameOf(configuredSuperagentName === undefined
    ? process.env.DSH_SUPERAGENT_NAME
    : configuredSuperagentName)
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('deadlineMs must be a positive integer')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('intervalMs must be a non-negative integer')
  const env = environment()
  const root = repositoryRoot(cwd, run, env)
  const base = originBase(root, run, env)
  const baseSha = shaOf(gitText(root, ['rev-parse', base], run, env).trim())
  const status = gitText(root, ['status', '--porcelain', '--untracked-files=all'], run, env)
  if (status.trim() !== '') throw new Error('delivery requires a clean committed working tree')
  const patchBytes = gitResult(root, ['diff', '--binary', `${base}..HEAD`, '--no-ext-diff'], run, env)
  if (patchBytes.byteLength > MAX_PATCH_BYTES) throw new Error(`diff exceeds ${MAX_PATCH_BYTES} bytes`)
  const patch = patchBytes.toString('utf8')
  if (!Buffer.from(patch, 'utf8').equals(patchBytes)) throw new Error('diff is not valid UTF-8; broker rejects binary patches')
  const idValue = deliveryId(id, baseSha, patch, ticket)
  const body = { projectId: id, id: idValue, baseSha, patch, title, ...(ticket === '' ? {} : { ticket }) }
  assertRequestSize(body)
  const posted = responseObject(await request(socketPath, '/delivery', { method: 'POST', body, timeoutMs: RPC_TIMEOUT_MS }), 'delivery broker')
  if (posted.state === 'failed') throw new Error(`delivery failed: ${errorDetail(posted)}`)
  const started = now()
  let polls = 0
  while (true) {
    const state = pollState(await request(socketPath, `/delivery?projectId=${encodeURIComponent(id)}&id=${encodeURIComponent(idValue)}`, { timeoutMs: RPC_TIMEOUT_MS }))
    polls += 1
    if (state.state === 'merged') {
      const receipt = state.receipt ?? state
      writeStdout(`${JSON.stringify(receipt)}\n`)
      return { exit: 0, id: idValue, receipt, polls }
    }
    if (state.state === 'failed') throw new Error(`delivery failed: ${errorDetail(state)}`)
    if (state.state === 'pr_open' && (state.terminal === true
      || ['error', 'reason', 'message'].some(key => typeof state[key] === 'string' && state[key].trim() !== ''))) {
      throw new Error(`delivery did not merge: ${errorDetail(state)}`)
    }
    const elapsed = now() - started
    if (!Number.isFinite(elapsed) || elapsed >= deadlineMs) throw new Error(`delivery did not merge within ${deadlineMs}ms`)
    await sleep(Math.min(intervalMs, deadlineMs - elapsed))
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDelivery().then(() => {
    process.exitCode = 0
  }).catch(error => {
    process.stderr.write(`delivery-cli: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
