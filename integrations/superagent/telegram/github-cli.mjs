#!/opt/node

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { requestUnix } from './bridge.mjs'

export const PROJECT_PATH = '/run/superagent/project.json'
export const SOCKET_PATH = '/run/superagent/superagent.sock'
export const REPOSITORY_PATH = '/run/superagent/repository.git'
const RPC_TIMEOUT_MS = 120_000

function projectId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('project.json projectId must be a non-negative safe integer')
  return value
}

export function readProjectId(path = PROJECT_PATH, read = readFileSync) {
  let parsed
  try { parsed = JSON.parse(String(read(path, 'utf8'))) } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`)
  return projectId(parsed.projectId)
}

function argvOf(value) {
  if (!Array.isArray(value) || value.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new Error('GitHub CLI arguments must be strings without NUL')
  }
  return [...value]
}

function safeEnvironment(input = process.env) {
  const env = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    const value = input[key]
    if (typeof value === 'string' && !value.includes('\0')) env[key] = value
  }
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

function checkoutTarget(value, cwd) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.startsWith('-')) {
    throw new Error('dshbot checkout path must be non-empty and stay inside the project home')
  }
  const root = realpathSync(cwd)
  const target = resolve(root, value)
  const remainder = relative(root, target)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error('dshbot checkout path must stay inside the project home')
  }
  if (remainder === '') {
    if (readdirSync(root).length !== 0) throw new Error('dshbot checkout target must be an empty directory')
    return '.'
  }
  const parent = dirname(target)
  if (realpathSync(parent) !== parent) throw new Error('dshbot checkout parent must be a real project path')
  if (existsSync(target)) throw new Error('dshbot checkout target already exists')
  return remainder
}

function refreshOf(result) {
  if (result.exit !== 0) return undefined
  let value
  try { value = JSON.parse(result.stdout) } catch (error) {
    throw new Error(`dshbot refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const repo = value?.repo
  const repository = value?.repository
  const base = value?.base ?? value?.baseBranch
  const validRepository = repo === undefined
    ? typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    : repo === REPOSITORY_PATH
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !validRepository
    || typeof base !== 'string' || base === ''
    || !/^[A-Za-z0-9._/-]+$/u.test(base) || base.includes('..') || base.includes('//') || base.endsWith('/')
    || typeof value.head !== 'string' || !/^[0-9a-f]{40}$/iu.test(value.head)
    || base.includes('\0') || value.head.includes('\0')) {
    throw new Error('dshbot refresh returned an invalid repository receipt')
  }
  return value
}

export function cloneCheckout(cwd, target, run = spawnSync, repositoryPath = REPOSITORY_PATH) {
  let result
  try {
    result = run('git', ['-c', 'credential.helper=', 'clone', '--no-local', '--no-hardlinks', repositoryPath, target], {
      cwd,
      env: safeEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
  } catch (error) {
    throw new Error(`git clone failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result === null || typeof result !== 'object' || (result.error !== undefined && result.error !== null) || result.status !== 0) {
    const detail = typeof result?.stderr === 'string' && result.stderr.trim() !== '' ? `: ${result.stderr.trim()}` : ''
    const code = Number.isSafeInteger(result?.status) ? ` (${result.status})` : ''
    throw new Error(`git clone failed${code}${detail}`)
  }
}

function responseOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub broker returned a non-object response')
  const stdout = value.stdout === undefined ? '' : value.stdout
  const stderr = value.stderr === undefined ? '' : value.stderr
  // The bridge returns stdout only for successful legacy calls and exitCode for
  // brokered gh failures. Keep exit as a compatibility seam for old fixtures.
  const exit = value.exitCode === undefined
    ? (value.exit === undefined ? 0 : value.exit)
    : value.exitCode
  if (typeof stdout !== 'string' || typeof stderr !== 'string') throw new Error('GitHub broker output must be strings')
  if (!Number.isSafeInteger(exit) || exit < 0 || exit > 255) throw new Error('GitHub broker exit must be an integer from 0 to 255')
  const httpStatus = value.httpStatus
  if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw new Error('GitHub broker HTTP status must be an integer from 100 to 599')
  }
  return { stdout, stderr, exit, httpStatus }
}

export async function runGithubCli({
  argv = process.argv.slice(2),
  projectPath = PROJECT_PATH,
  socketPath = SOCKET_PATH,
  projectId: configuredProjectId,
  request = requestUnix,
  cwd = process.cwd(),
  run = spawnSync,
  repositoryPath = REPOSITORY_PATH,
  writeStdout = value => process.stdout.write(value),
  writeStderr = value => process.stderr.write(value),
} = {}) {
  const id = configuredProjectId === undefined ? readProjectId(projectPath) : projectId(configuredProjectId)
  const parsedArgv = argvOf(argv)
  const checkout = parsedArgv[0] === 'dshbot' && parsedArgv[1] === 'checkout'
  if (checkout && parsedArgv.length !== 3) throw new Error('dshbot checkout requires exactly one path')
  const brokerArgv = checkout ? ['dshbot', 'refresh'] : parsedArgv
  const result = responseOf(await request(socketPath, '/github', {
    method: 'POST',
    body: { projectId: id, argv: brokerArgv },
    timeoutMs: RPC_TIMEOUT_MS,
  }))
  if (result.stderr !== '') writeStderr(result.stderr)
  if (result.exit !== 0) {
    if (result.httpStatus !== undefined) throw new Error(`gh: HTTP ${result.httpStatus}`)
    return result.exit
  }
  if (result.stdout !== '') writeStdout(result.stdout)
  if (checkout && result.exit === 0) {
    refreshOf(result)
    cloneCheckout(cwd, checkoutTarget(parsedArgv[2], cwd), run, repositoryPath)
  }
  return result.exit
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runGithubCli().then(exit => {
    process.exitCode = exit
  }).catch(error => {
    process.stderr.write(`github-cli: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
