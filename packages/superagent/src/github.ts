import { execFile, type ExecFileOptions } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { FactoryProject } from '../../factory/src/index.js'

const GIT_TIMEOUT_MS = 10_000
const GH_TIMEOUT_MS = 60_000
const GH_OUTPUT_LIMIT = 8 * 1024 * 1024
const JQ_LIMIT = 512
const COMMENT_LIMIT = 16_000

type ExecResult = { stdout: string; stderr?: string }

export interface GithubResult {
  stdout: string
  exitCode?: number
  httpStatus?: number
}

/** The host command seam is intentionally injectable so policy tests never need public GitHub. */
export type GithubExec = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecResult>

export interface ProjectGithubOptions {
  home: string
  projects: () => FactoryProject[]
  exec?: GithubExec
}

export interface GithubProject {
  repository: string
  remote: string
  url: string
  baseBranch: string
}

const execFileAsync = (file: string, args: readonly string[], options: ExecFileOptions): Promise<ExecResult> => {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error !== null) {
        Object.assign(error, { stdout, stderr })
        reject(error)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const defaultExec: GithubExec = execFileAsync

class GithubCommandError extends Error {
  readonly httpStatus?: number

  constructor(file: string, error: unknown) {
    super(`${file} не выполнился`)
    const failure = error as { message?: unknown; stderr?: unknown }
    const text = [failure.stderr, failure.message].filter((value): value is string => typeof value === 'string').join('\n')
    const match = /\bHTTP\s+([1-5][0-9]{2})\b/i.exec(text)
    if (match !== null) this.httpStatus = Number(match[1])
  }
}

function sanitizedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? homedir(),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
    ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

function hostGithubEnv(): NodeJS.ProcessEnv {
  const env = sanitizedGitEnv()
  for (const key of ['XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function commandOptions(cwd: string, env: NodeJS.ProcessEnv, timeout: number, maxBuffer = GH_OUTPUT_LIMIT): ExecFileOptions {
  return { cwd, env, encoding: 'utf8', shell: false, timeout, windowsHide: true, maxBuffer }
}

async function runCommand(
  runExecutable: GithubExec,
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<string> {
  try {
    const result = await runExecutable(file, args, options)
    return typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? '')
  } catch (error) {
    // Never copy host command output into a broker error: gh/git diagnostics
    // can contain credential-helper material or a private remote URL.
    throw new GithubCommandError(file, error)
  }
}

function hostGitEnv(): NodeJS.ProcessEnv {
  const env = hostGithubEnv()
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'credential.helper'
  env.GIT_CONFIG_VALUE_0 = '!gh auth git-credential'
  return env
}

async function tryGit(
  exec: GithubExec,
  projectPath: string,
  args: readonly string[],
  env = sanitizedGitEnv(),
): Promise<string | undefined> {
  try {
    return await runCommand(exec, 'git', ['-C', projectPath, ...args], commandOptions(projectPath, env, GIT_TIMEOUT_MS))
  } catch {
    return undefined
  }
}

function remoteConfig(stdout: string): Map<string, string[]> {
  const remotes = new Map<string, string[]>()
  for (const record of stdout.split('\0')) {
    if (record === '') continue
    const separator = record.indexOf('\n')
    if (separator <= 0) continue
    const key = record.slice(0, separator)
    const url = record.slice(separator + 1).trim()
    const match = /^remote\.([A-Za-z0-9._-]+)\.url$/.exec(key)
    if (match === null || url === '') continue
    const existing = remotes.get(match[1]!) ?? []
    existing.push(url)
    remotes.set(match[1]!, existing)
  }
  return remotes
}

function branchName(value: string): string | undefined {
  const branch = value.trim()
  if (branch === '' || branch.length > 256 || branch.startsWith('-') || branch.includes('..')
    || branch.includes('@{') || branch.includes('\\') || /[\u0000-\u001f\u007f]/.test(branch)
    || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.endsWith('.') || branch.endsWith('/') || branch.endsWith('.lock')
    || branch.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return branch
}

function upstreamOf(value: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
  const raw = value.trim()
  const matches = remotes.filter(remote => raw.startsWith(`${remote}/`))
  if (matches.length !== 1) return undefined
  const remote = matches[0]!
  const branch = branchName(raw.slice(remote.length + 1))
  return branch === undefined ? undefined : { remote, branch }
}

function githubRepository(url: string): string | undefined {
  const value = url.trim()
  if (value === '' || value.includes('%') || /[\u0000-\u0020\u007f]/.test(value) || value.includes('?') || value.includes('#')) return undefined
  let owner: string | undefined
  let name: string | undefined
  if (/^https:\/\/github\.com\//i.test(value) || /^ssh:\/\/git@github\.com\//i.test(value)) {
    try {
      const parsed = new URL(value)
      if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.username !== (parsed.protocol === 'https:' ? '' : 'git')
        || parsed.password !== '' || parsed.port !== '' || parsed.pathname.split('/').filter(Boolean).length !== 2) return undefined
      const parts = parsed.pathname.split('/').filter(Boolean)
      owner = parts[0]
      name = parts[1]
    } catch {
      return undefined
    }
  } else {
    const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value)
    if (scp === null) return undefined
    owner = scp[1]
    name = scp[2]
  }
  if (name?.endsWith('.git')) name = name.slice(0, -4)
  if (owner === undefined || name === undefined || owner === '' || name === '') return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined
  return `${owner}/${name}`
}

function remoteHead(value: string, remote: string): string | undefined {
  const raw = value.trim()
  const prefix = `${remote}/`
  if (!raw.startsWith(prefix)) return undefined
  return branchName(raw.slice(prefix.length))
}

function remoteHeadFromLsRemote(value: string): string | undefined {
  const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD\s*$/m.exec(value)
  return match === null ? undefined : branchName(match[1]!)
}

function execFor(options?: { exec?: GithubExec } | GithubExec): GithubExec {
  if (typeof options === 'function') return options
  return options?.exec ?? defaultExec
}

/** Resolve the trusted factory project's GitHub repository and base branch. */
export async function resolveGithubProject(project: FactoryProject, options?: { exec?: GithubExec } | GithubExec): Promise<GithubProject> {
  if (typeof project.path !== 'string' || project.path === '' || !project.path.startsWith('/')) throw new Error('путь проекта должен быть абсолютным')
  const exec = execFor(options)
  const config = await tryGit(exec, project.path, ['config', '--null', '--get-regexp', '^remote\\..*\\.url$'])
  if (config === undefined) throw new Error('не удалось прочитать Git remote проекта')
  const configured = remoteConfig(config)
  if (configured.size === 0) throw new Error('у проекта нет Git remote')
  const remoteNames = [...configured.keys()]
  const upstreamValue = await tryGit(exec, project.path, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const upstream = upstreamValue === undefined ? undefined : upstreamOf(upstreamValue, remoteNames)
  if (upstreamValue?.trim() !== '' && upstreamValue !== undefined && upstream === undefined) {
    throw new Error('текущий upstream проекта неоднозначен')
  }

  let remoteName: string
  if (upstream !== undefined) {
    remoteName = upstream.remote
  } else {
    const githubRemotes = remoteNames.filter(name => configured.get(name)?.length === 1 && githubRepository(configured.get(name)![0]!) !== undefined)
    if (githubRemotes.length !== 1) throw new Error('GitHub remote проекта неоднозначен')
    remoteName = githubRemotes[0]!
  }

  const urls = configured.get(remoteName)
  if (urls === undefined || urls.length !== 1) throw new Error('Git remote проекта неоднозначен')
  const url = urls[0]!
  const repository = githubRepository(url)
  if (repository === undefined) throw new Error('remote проекта не является GitHub')

  let baseBranch: string | undefined
  const localHead = await tryGit(exec, project.path, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`])
  if (localHead !== undefined) baseBranch = remoteHead(localHead, remoteName)
  if (baseBranch === undefined) {
    const remoteListing = await tryGit(exec, project.path, ['ls-remote', '--symref', remoteName, 'HEAD'], hostGitEnv())
    if (remoteListing !== undefined) baseBranch = remoteHeadFromLsRemote(remoteListing)
  }
  if (baseBranch === undefined) throw new Error('не удалось определить основную ветку GitHub проекта')
  return {
    repository,
    remote: `https://github.com/${repository}.git`,
    url: `https://github.com/${repository}`,
    baseBranch,
  }
}

function safeQuery(query: string): boolean {
  if (query === '') return true
  if (/[\u0000-\u0020\u007f#]/.test(query)) return false
  const allowed = new Set([
    'affiliation', 'all', 'assignee', 'author', 'base', 'branch', 'created', 'direction', 'event', 'head', 'in',
    'labels', 'language', 'milestone', 'mentioned', 'page', 'per_page', 'q', 'search', 'since', 'sort',
    'state', 'status', 'type', 'until', 'visibility', 'workflow_id', 'sha', 'ref',
  ])
  for (const part of query.split('&')) {
    if (part === '') return false
    const equal = part.indexOf('=')
    const rawKey = equal < 0 ? part : part.slice(0, equal)
    const rawValue = equal < 0 ? '' : part.slice(equal + 1)
    let key: string
    let value: string
    try {
      key = decodeURIComponent(rawKey.replaceAll('+', ' '))
      value = decodeURIComponent(rawValue.replaceAll('+', ' '))
    } catch {
      return false
    }
    if (!allowed.has(key) || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) return false
  }
  return true
}

function parseEndpoint(endpoint: string, repository: string): { path: string[]; query: string; endpoint: string } {
  if (endpoint === '' || endpoint.includes('\\') || endpoint.includes('#')
    || endpoint.startsWith('/') || endpoint.startsWith('//') || endpoint.includes('://')
    || /[\u0000-\u0020\u007f]/.test(endpoint)) throw new Error('небезопасный GitHub endpoint')
  const question = endpoint.indexOf('?')
  const pathText = question < 0 ? endpoint : endpoint.slice(0, question)
  const query = question < 0 ? '' : endpoint.slice(question + 1)
  if (!safeQuery(query)) throw new Error('небезопасный GitHub query')
  const rawPath = pathText.split('/')
  if (rawPath.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error('путь GitHub содержит traversal')
  if (rawPath.slice(0, 3).some(segment => segment.includes('%'))) throw new Error('owner/repository нельзя кодировать')
  const path = rawPath.map((segment, index) => {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new Error('некорректное percent-кодирование GitHub endpoint')
    }
    if (index < 3 && decoded !== segment) throw new Error('owner/repository нельзя кодировать')
    if (decoded.includes('%') || decoded.includes('\\') || decoded.includes('#') || decoded.includes('?')
      || /[\u0000-\u0020\u007f]/.test(decoded) || /(?:^|\/)\.\.(?:\/|$)/.test(decoded)
      || /(?:^|\/)\.(?:\/|$)/.test(decoded) || /(?:^|\/)\/(?:\/|$)/.test(decoded)) throw new Error('путь GitHub содержит traversal')
    return decoded
  })
  if (path[0] === 'notifications') {
    if (path.length !== 1) throw new Error('разрешён только endpoint notifications')
    const scopedEndpoint = `repos/${repository}/notifications${query === '' ? '' : `?${query}`}`
    return { path: ['repos', ...repository.split('/'), 'notifications'], query, endpoint: scopedEndpoint }
  }
  if (path[0] === 'user') {
    if (path.length !== 1) throw new Error(`разрешён только endpoint ${path[0]}`)
    return { path, query, endpoint }
  }
  if (path[0] !== 'repos' || path.length < 3 || `${path[1]}/${path[2]}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub endpoint выходит за пределы проекта')
  }
  for (const segment of path.slice(3)) {
    if (segment.length > 256 || /[\u0000-\u001f\u007f]/.test(segment)) throw new Error('небезопасный GitHub endpoint')
  }
  return { path, query, endpoint }
}

function validateJq(value: string): void {
  if (value.length === 0 || value.length > JQ_LIMIT || /[\u0000\r\n]/.test(value)) throw new Error('недопустимое выражение --jq')
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized !== '{name: .full_name, push: .permissions.push}') throw new Error('разрешена только безопасная проекция --jq')
}

function validateHeader(value: string): void {
  const match = /^([A-Za-z-]+):[ \t]*(.*)$/.exec(value)
  if (match === null || /[\u0000\r\n]/.test(value)) throw new Error('недопустимый GitHub header')
  const name = match[1]!.toLowerCase()
  const headerValue = match[2]!
  if (headerValue.length > 512 || !['accept', 'if-none-match'].includes(name)) throw new Error('GitHub header запрещён')
  if (name === 'accept' && headerValue !== 'application/vnd.github.raw'
    && !/^application\/vnd\.github(?:\.[a-z0-9-]+)?\+json$/i.test(headerValue)) throw new Error('GitHub Accept header запрещён')
  if (name === 'if-none-match' && !/^(?:W\/)?"[\x20-\x7e]*"$|^\*$/.test(headerValue)) throw new Error('GitHub If-None-Match header запрещён')
}

function issueNumber(value: string): boolean {
  return /^[1-9][0-9]{0,8}$/.test(value)
}

function validateEndpointPolicy(path: string[], method: string, bodyCount: number, flags: { paginate: boolean; slurp: boolean }): void {
  if (path[0] === 'user') {
    if (method !== 'GET' || bodyCount !== 0) throw new Error('endpoint user доступен только для GET')
    return
  }
  const tail = path.slice(3)
  const lowerTail = tail.map(segment => segment.toLowerCase())
  if (lowerTail.includes('merge') || lowerTail.includes('delete') || (lowerTail[0] === 'actions' && lowerTail[1] === 'secrets')) {
    throw new Error('GitHub endpoint запрещён')
  }
  const issueComment = tail.length === 3 && tail[0] === 'issues' && issueNumber(tail[1]!) && tail[2] === 'comments'
  const pullReply = tail.length === 5 && tail[0] === 'pulls' && issueNumber(tail[1]!) && tail[2] === 'comments'
    && issueNumber(tail[3]!) && tail[4] === 'replies'
  if (method === 'POST') {
    if ((!issueComment && !pullReply) || bodyCount !== 1) throw new Error('разрешены только комментарии GitHub')
    if (flags.paginate || flags.slurp) throw new Error('POST GitHub endpoint не поддерживает pagination')
    return
  }
  if (method !== 'GET' || bodyCount !== 0) throw new Error('метод GitHub запрещён')
}

/** Whether a broker argv would request the only allowed state-changing method. */
export function isGithubMutation(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv[0] !== 'api') return false
  let possiblePost = false
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '-f') possiblePost = true
    if (arg === '--method' || arg === '-X') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-') || value.toUpperCase() === 'POST') possiblePost = true
    }
    if (typeof arg === 'string' && arg.startsWith('--method=')
      && arg.slice('--method='.length).toUpperCase() === 'POST') possiblePost = true
  }
  return possiblePost
}

/** Short alias used by bridge policy code. */
export const isMutation = isGithubMutation

function validateApiArgv(argv: readonly string[], repository: string): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] !== 'api') throw new Error('разрешён только вызов gh api')
  let endpoint: string | undefined
  let method = 'GET'
  let explicitMethod = false
  let methodFlagSeen = false
  let bodyCount = 0
  let paginate = false
  let slurp = false
  let endpointOutputIndex = -1
  const output = ['api']
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--method' || arg === '-X') {
      if (methodFlagSeen) throw new Error('флаг метода gh api повторён')
      methodFlagSeen = true
      const value = argv[++index]
      if (value === undefined || !['GET', 'POST'].includes(value.toUpperCase())) throw new Error('метод GitHub запрещён')
      method = value.toUpperCase()
      explicitMethod = true
      output.push(arg, value)
      continue
    }
    if (arg.startsWith('--method=')) {
      if (methodFlagSeen) throw new Error('флаг метода gh api повторён')
      methodFlagSeen = true
      const value = arg.slice('--method='.length)
      if (!['GET', 'POST'].includes(value.toUpperCase())) throw new Error('метод GitHub запрещён')
      method = value.toUpperCase()
      explicitMethod = true
      output.push(arg)
      continue
    }
    if (arg === '--paginate' || arg === '--slurp' || arg === '--include' || arg === '-i') {
      if (arg === '--paginate') paginate = true
      if (arg === '--slurp') slurp = true
      output.push(arg)
      continue
    }
    if (arg === '--jq' || arg === '-q') {
      const value = argv[++index]
      if (value === undefined) throw new Error('отсутствует выражение --jq')
      validateJq(value)
      output.push(arg, value)
      continue
    }
    if (arg.startsWith('--jq=')) {
      const value = arg.slice('--jq='.length)
      validateJq(value)
      output.push(arg)
      continue
    }
    if (arg === '-H') {
      const value = argv[++index]
      if (value === undefined) throw new Error('отсутствует GitHub header')
      validateHeader(value)
      output.push(arg, value)
      continue
    }
    if (arg === '-f') {
      const value = argv[++index]
      if (value === undefined || !value.startsWith('body=') || value.length > COMMENT_LIMIT + 5 || value.slice(5).startsWith('@') || value.includes('\0')) {
        throw new Error('разрешён только literal -f body=...')
      }
      if (!explicitMethod) method = 'POST'
      bodyCount++
      output.push(arg, value)
      continue
    }
    if (arg.startsWith('-')) throw new Error('неизвестный флаг gh api')
    if (endpoint !== undefined) throw new Error('разрешён только один GitHub endpoint')
    endpoint = arg
    endpointOutputIndex = output.length
    output.push(arg)
  }
  if (endpoint === undefined) throw new Error('отсутствует GitHub endpoint')
  const parsed = parseEndpoint(endpoint, repository)
  validateEndpointPolicy(parsed.path, method, bodyCount, { paginate, slurp })
  output[endpointOutputIndex] = parsed.endpoint
  return output
}

function privateDirectory(path: string): void {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('cache path is not a directory')
    if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(path, { mode: 0o700 })
}

function mirrorGitEnv(): NodeJS.ProcessEnv {
  const env = hostGitEnv()
  env.GIT_CONFIG_COUNT = '2'
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
  env.GIT_CONFIG_VALUE_0 = '/dev/null'
  env.GIT_CONFIG_KEY_1 = 'credential.helper'
  env.GIT_CONFIG_VALUE_1 = '!gh auth git-credential'
  return env
}

function mirrorPath(home: string, projectId: number): string {
  if (!isAbsolute(home) || home.includes('\0') || !Number.isSafeInteger(projectId) || projectId < 0) {
    throw new Error('некорректный путь GitHub mirror')
  }
  const root = realpathSync(home)
  if (!statSync(root).isDirectory()) throw new Error('home не является каталогом')
  const superagent = join(root, 'superagent')
  const bridge = join(superagent, 'bridge')
  const project = join(bridge, String(projectId))
  privateDirectory(superagent)
  privateDirectory(bridge)
  privateDirectory(project)
  return join(project, 'repository.git')
}

async function refreshProjectMirror(
  home: string,
  projectId: number,
  metadata: GithubProject,
  exec: GithubExec,
): Promise<string> {
  const mirror = mirrorPath(home, projectId)
  let present = true
  try {
    const info = lstatSync(mirror)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('GitHub mirror path is not a directory')
    if ((info.mode & 0o077) !== 0) chmodSync(mirror, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    present = false
  }
  const env = mirrorGitEnv()
  if (!present) {
    await runCommand(exec, 'git', ['init', '--bare', '--quiet', '--template=/dev/null', mirror], commandOptions(home, env, GIT_TIMEOUT_MS))
    const config = join(mirror, 'config')
    try { chmodSync(config, 0o600) } catch { /* git reports a broken cache below */ }
  } else {
    const bare = (await runCommand(exec, 'git', ['-C', mirror, 'rev-parse', '--is-bare-repository'], commandOptions(home, env, GIT_TIMEOUT_MS))).trim()
    if (bare !== 'true') throw new Error('GitHub mirror is not bare')
  }
  await runCommand(exec, 'git', ['-C', mirror, 'config', '--local', 'core.hooksPath', '/dev/null'], commandOptions(home, env, GIT_TIMEOUT_MS))
  try { chmodSync(join(mirror, 'config'), 0o600) } catch { /* rev-parse below reports a broken cache */ }
  await runCommand(exec, 'git', [
    '-C', mirror, 'fetch', '--no-tags', '--depth=1', '--force', metadata.remote,
    `+refs/heads/${metadata.baseBranch}:refs/heads/${metadata.baseBranch}`,
  ], commandOptions(home, env, GH_TIMEOUT_MS))
  await runCommand(exec, 'git', ['-C', mirror, 'symbolic-ref', 'HEAD', `refs/heads/${metadata.baseBranch}`], commandOptions(home, env, GIT_TIMEOUT_MS))
  const head = (await runCommand(exec, 'git', ['-C', mirror, 'rev-parse', `refs/heads/${metadata.baseBranch}^{commit}`], commandOptions(home, env, GIT_TIMEOUT_MS))).trim()
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('GitHub mirror вернул некорректный HEAD')
  return `${JSON.stringify({ repository: metadata.repository, baseBranch: metadata.baseBranch, head })}\n`
}

/** Host-side, project-scoped GitHub API broker. */
export function createProjectGithub(options: ProjectGithubOptions): (projectId: number, argv: string[]) => Promise<GithubResult> {
  const exec = options.exec ?? defaultExec
  if (!isAbsolute(options.home) || options.home.includes('\0')) throw new Error('home должен быть абсолютным путём')
  return async (projectId, argv) => {
    const matches = options.projects().filter(project => project.id === projectId)
    if (matches.length !== 1) throw new Error(`проект #${projectId} не найден или неоднозначен`)
    const project = matches[0]!
    const resolved = await resolveGithubProject(project, { exec })
    if (argv.length === 2 && argv[0] === 'dshbot' && argv[1] === 'refresh') {
      return { stdout: await refreshProjectMirror(options.home, projectId, resolved, exec) }
    }
    const args = validateApiArgv(argv, resolved.repository)
    try {
      const stdout = await runCommand(exec, 'gh', args, commandOptions(project.path, hostGithubEnv(), GH_TIMEOUT_MS))
      return { stdout }
    } catch (error) {
      const httpStatus = error instanceof GithubCommandError ? error.httpStatus : undefined
      if (httpStatus !== undefined) return { stdout: '', exitCode: 1, httpStatus }
      throw error
    }
  }
}
