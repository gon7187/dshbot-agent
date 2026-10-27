// The `host_exec` tool: the owner's commands on the owner's own machines.
//
// Two kinds of target live in `DSHBOT_HOME/hosts.json`:
//
//   * an ssh target, `{ "user": "deploy", "host": "192.0.2.10", "port": 2222 }`:
//     the command runs through the owner's ssh client, non-interactively
//     (`BatchMode=yes`, so a password is never asked and a missing key fails),
//     with the owner's keys (`HOME` of the daemon is inherited unchanged);
//   * the machine of the bot itself, `{ "local": true }`: the command runs
//     right here, outside the bwrap sandbox of `exec`, so systemd, `/var` and
//     the owner's own files are reachable.
//
// A local command is wrapped in its own bwrap write guard: the whole machine is
// mounted read-only, and only `DSHBOT_HOME`, `/tmp` and the colon-separated
// directories of `DSHBOT_HOST_WRITABLE` are mounted read-write. A redirect, an
// interpreter, a variable or a command substitution therefore cannot delete or
// change a file above the bot's own directory, even when the owner presses the
// allow button. Reading everywhere and connecting to existing unix sockets
// (systemd --user, docker) keep working. When bwrap is missing or does not
// start, the command is not run at all: there is no unprotected run.
//
// The command passes the same guard as `exec` (`checkCommand`): a denied
// command never starts a process, and a confirmation-class command runs only
// after the owner pressed the allow button of the card (`approval`). Output is
// bounded, cut with a visible mark, and the values of the bot's own secrets are
// replaced before the model sees anything.
//
// The tool is lazy and belongs to the owner alone: the app adds it to the
// owner's registry only, so `tool_search` loads it for `main` and a guest or a
// delegated child never holds it.

import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { frameData } from '../../app/src/untrusted-frame.js'
import { checkCommand } from '../../guard/src/index.js'
import type { RunnerTool } from '../../runner/src/index.js'
import type { ExecApproval } from './index.js'

/** Model-facing name of the tool. */
export const HOST_EXEC_TOOL_NAME = 'host_exec'

/** Foreground timeout used when the model gives none, in milliseconds. */
export const DEFAULT_HOST_TIMEOUT_MS = 120_000

/** Hard cap on a foreground timeout, in milliseconds. */
export const MAX_HOST_TIMEOUT_MS = 600_000

/** Characters of output returned to the model; the rest is cut with a mark. */
export const MAX_HOST_OUTPUT_CHARS = 120_000

/** Bytes a command may print before the collector stops buffering it. */
const MAX_COLLECTED_BYTES = 4 * 1024 * 1024

/** Stand-in for every value of the bot's own secrets. */
export const SECRET_PLACEHOLDER = '[скрыто]'

/**
 * Parent variables a host command legitimately needs. The child of `host_exec`
 * never inherits the whole environment of the daemon: a command like
 * `echo $DEEPSEEK_API_KEY | base64` would carry the model key past the output
 * scrubber, so only this allowlist survives (the same rule as the exec sandbox,
 * plus the home of the owner and the ssh agent that the keys live in).
 */
const HOST_INHERITED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TERM',
  'SHELL',
  'TZ',
  'PAGER',
  'GIT_PAGER',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
] as const

/**
 * Environment of both kinds of target: no model key, no bot token and no other
 * secret of the daemon. HOME and SSH_AUTH_SOCK stay, because ssh needs the
 * owner's keys; PATH and the locale stay, because the command needs them.
 */
export function hostEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const child: Record<string, string> = {}
  for (const name of HOST_INHERITED_ENV) {
    const value = env[name]
    if (typeof value !== 'string' || value === '') continue
    child[name] = value
  }
  if (child.PATH === undefined) child.PATH = '/usr/local/bin:/usr/bin:/bin'
  return child
}

/**
 * The explanation the model gets when a local write is refused, even if a
 * later shell command succeeds: where writes and deletions are allowed.
 */
export const HOST_WRITE_GUARD_NOTE =
  'Вне каталога бота запись и удаление запрещены: host_exec с локальным алиасом не меняет файлы вне ' +
  'DSHBOT_HOME. Разрешены только DSHBOT_HOME, /tmp и каталоги из DSHBOT_HOST_WRITABLE; остальное ' +
  'доступно только для чтения.'

/** A real existing directory, or `undefined` when the path is not one. */
function realDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/** Whether `child` is `parent` itself or lies below it. */
function isWithin(child: string, parent: string): boolean {
  const rest = relative(parent, child)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * The directories a local command may write to: `DSHBOT_HOME`, `/tmp` and the
 * colon-separated entries of `DSHBOT_HOST_WRITABLE` that exist. A nested entry
 * is dropped when a parent is already open (bwrap binds are recursive), so the
 * mount order can never hide a writable directory behind a read-only one.
 */
export function hostWriteRoots(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [home, '/tmp', ...(env.DSHBOT_HOST_WRITABLE ?? '').split(':')]
  const roots: string[] = []
  for (const candidate of candidates) {
    if (candidate === '') continue
    const directory = realDirectory(candidate)
    if (directory === undefined) continue
    if (roots.some((root) => isWithin(directory, root))) continue
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      const root = roots[index]
      if (root !== undefined && isWithin(root, directory)) roots.splice(index, 1)
    }
    roots.push(directory)
  }
  roots.sort((left, right) => left.length - right.length || left.localeCompare(right))
  return roots
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve a program on the child's `PATH`, as the shell of the child would. */
function findExecutable(name: string, pathValue: string | undefined): string | undefined {
  if (name.includes('/')) return isExecutable(name) ? name : undefined
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** The write guard cannot be switched on: the command must not run unprotected. */
function protectionUnavailable(detail: string): Error {
  return new Error(
    'Отказ: host_exec с локальным алиасом не может включить защиту записи (bwrap), поэтому команда не ' +
      'запущена. Без песочницы запись и удаление вне каталога бота запрещены, а запускать без защиты ' +
      `нельзя. Проверь, что bwrap установлен и работает. ${detail}`,
  )
}

/**
 * bwrap arguments for a local command: read-only machine, writable roots, no
 * network changes. The private PID namespace also keeps `/proc/<pid>/root`
 * from pointing at the host root of another process, which would otherwise be
 * a way around the read-only mount.
 */
function localSandboxArgs(roots: readonly string[], cwd: string, argv: readonly string[]): string[] {
  const args: string[] = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc']
  for (const root of roots) args.push('--bind', root, root)
  args.push('--chdir', cwd, '--', ...argv)
  return args
}

interface ShellWord {
  readonly text: string
  /** The shell may expand this word to something else (`$X`, a glob, backticks). */
  readonly dynamic: boolean
  /** An unquoted shell redirection operator, possibly prefixed by a descriptor. */
  readonly redirection?: boolean
}

/** A redirection operator outside quotes; its target is a separate shell word. */
function shellRedirectionAt(command: string, index: number): string | undefined {
  return /^(?:&>>?|<<<|<<-?|<>|<&|>>|>\||>&|[<>])/.exec(command.slice(index, index + 3))?.[0]
}

/** Top-level parts of a command line, split on `;`, `&&`, `||`, `|` and newlines. */
function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === undefined) break
    if (quote === "'") {
      current += char
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      current += char
      if (char === '\\' && index + 1 < command.length) {
        current += command[index + 1]
        index += 1
      } else if (char === '"') {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += char + command[index + 1]
      index += 1
      continue
    }
    const redirection = shellRedirectionAt(command, index)
    if (redirection !== undefined) {
      current += redirection
      index += redirection.length - 1
      continue
    }
    const next = command[index + 1]
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      segments.push(current)
      current = ''
      index += 1
      continue
    }
    if (char === '&' && command[index - 1] !== '>' && next !== '>') {
      segments.push(current)
      current = ''
      continue
    }
    if (char === ';' || char === '|' || char === '\n' || char === '\r') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments.map((segment) => segment.trim()).filter((segment) => segment !== '')
}

/** Shell words of one part, with quotes removed and expansions marked dynamic. */
function shellWords(segment: string): ShellWord[] {
  const words: ShellWord[] = []
  let text = ''
  let dynamic = false
  let started = false
  let quoted = false
  let quote: '"' | "'" | null = null

  const flush = (): void => {
    if (!started) return
    words.push({ text, dynamic })
    text = ''
    dynamic = false
    started = false
    quoted = false
  }

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]
    if (char === undefined) break
    if (quote === "'") {
      started = true
      if (char === "'") quote = null
      else text += char
      continue
    }
    if (quote === '"') {
      started = true
      if (char === '\\' && index + 1 < segment.length) {
        text += segment[index + 1]
        index += 1
      } else if (char === '"') {
        quote = null
      } else {
        if (char === '$' || char === '`') dynamic = true
        text += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      quoted = true
      continue
    }
    if (char === '\\' && index + 1 < segment.length) {
      started = true
      quoted = true
      text += segment[index + 1]
      index += 1
      continue
    }
    if (char === ' ' || char === '\t') {
      flush()
      continue
    }
    const redirection = shellRedirectionAt(segment, index)
    if (redirection !== undefined) {
      // A quoted numeric word stays an operand rather than a descriptor.
      const descriptor = !quoted && /^[0-9]+$/.test(text) && !redirection.startsWith('&') ? text : ''
      if (descriptor !== '') {
        text = ''
        started = false
      }
      flush()
      words.push({ text: descriptor + redirection, dynamic: false, redirection: true })
      index += redirection.length - 1
      continue
    }
    if (char === '$' || char === '`' || char === '*' || char === '?' || char === '[' || char === '~' || char === '{') {
      dynamic = true
    }
    started = true
    text += char
  }
  flush()
  return words
}

/** Redirections belong to the shell, never to the operands of cd or mv. */
function withoutRedirections(words: readonly ShellWord[]): ShellWord[] {
  const operands: ShellWord[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    if (word?.redirection) {
      // bwrap checks the redirection's own target when the shell opens it.
      index += 1
    } else if (word !== undefined) {
      operands.push(word)
    }
  }
  return operands
}

/** Whether a path is inside any of the directories the local command may write to. */
function writablePath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(path, root))
}

/**
 * bwrap stops every write outside the writable roots, but `mv` first copies a
 * file into a writable destination and only then unlinks the read-only source:
 * the outside file survives, yet a copy would appear in DSHBOT_HOME. A direct
 * `mv` whose source (or target, or any path it cannot resolve before the run)
 * is outside the writable roots is therefore refused before the process starts.
 * Everything else stays with bwrap, which needs no path parsing at all.
 */
function mvOutsideWriteRoots(command: string, cwd: string, roots: readonly string[]): string | undefined {
  // `undefined` after a `cd` the parser cannot follow: a relative `mv` is then unknown.
  let currentCwd: string | undefined = cwd
  for (const segment of shellSegments(command)) {
    const words = withoutRedirections(shellWords(segment))
    const name = words[0]?.text
    if (name === undefined) continue
    if (name === 'cd') {
      const target = words[1]
      if (target === undefined) currentCwd = cwd
      else if (target.dynamic) currentCwd = undefined
      else if (currentCwd === undefined && !isAbsolute(target.text)) currentCwd = undefined
      else currentCwd = isAbsolute(target.text) ? target.text : resolve(currentCwd ?? cwd, target.text)
      continue
    }
    if (name !== 'mv' && !name.endsWith('/mv')) continue

    const operands: ShellWord[] = []
    let targetDirectory: ShellWord | undefined
    let options = true
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]
      if (word === undefined) break
      if (options && word.text === '--') {
        options = false
        continue
      }
      if (options && word.text.startsWith('-') && word.text.length > 1) {
        if (word.text === '-t' || word.text === '--target-directory') {
          targetDirectory = words[index + 1]
          index += 1
        } else if (word.text.startsWith('--target-directory=')) {
          targetDirectory = {
            text: word.text.slice('--target-directory='.length),
            dynamic: word.dynamic,
          }
        } else if (word.text.startsWith('-t') && word.text.length > 2) {
          targetDirectory = { text: word.text.slice(2), dynamic: word.dynamic }
        }
        continue
      }
      operands.push(word)
    }

    let destination = targetDirectory
    const sources = [...operands]
    if (destination === undefined) destination = sources.pop()
    if (destination === undefined || sources.length === 0) return 'mv без понятных источника и цели'
    for (const source of sources) {
      if (source.dynamic) return `mv с неизвестным источником «${source.text}»`
      if (!isAbsolute(source.text) && currentCwd === undefined) return 'mv в неизвестном рабочем каталоге'
      const path = isAbsolute(source.text) ? source.text : resolve(currentCwd ?? cwd, source.text)
      if (!writablePath(path, roots)) return `источник «${source.text}»`
    }
    if (destination.dynamic) return `mv с неизвестной целью «${destination.text}»`
    if (!isAbsolute(destination.text) && currentCwd === undefined) return 'mv в неизвестном рабочем каталоге'
    let path = isAbsolute(destination.text) ? destination.text : resolve(currentCwd ?? cwd, destination.text)
    // `mv a b c dir/` puts every source inside the directory.
    if (realDirectory(path) !== undefined) path = join(path, basename(sources[0]?.text ?? ''))
    if (!writablePath(path, roots)) return `цель «${destination.text}»`
  }
  return undefined
}

/** One target of `hosts.json`: an ssh destination or the bot's own machine. */
export type HostTarget =
  | { readonly kind: 'ssh'; readonly alias: string; readonly user: string; readonly host: string; readonly port: number }
  | { readonly kind: 'local'; readonly alias: string }

export interface HostExecOptions {
  /** `DSHBOT_HOME`; its `hosts.json` names the targets. */
  home: string
  /** Owner approval for confirmation-class commands; absent means every one is refused. */
  approval?: ExecApproval
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound of a foreground timeout in milliseconds. */
  maxTimeoutMs?: number
  /**
   * Values replaced in the output; defaults to the bot's own tokens. A function
   * is read for every command (and may load them), so a sign-in saved while the
   * daemon runs is scrubbed by the very next call.
   */
  secrets?: readonly string[] | (() => readonly string[] | Promise<readonly string[]>)
}

/** The host capability ready for the runner tool seam. */
export interface HostExecTools {
  tools: readonly RunnerTool[]
}

/** Path of the owner's host list. */
export function hostsFilePath(home: string): string {
  return join(home, 'hosts.json')
}

/** Error text of a failed `readFileSync`, with the path the owner must fix. */
function readError(path: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Хосты не настроены: не удалось прочитать ${path}: ${detail}`)
}

/**
 * Read and validate `hosts.json`. The file is read on every call, so the owner
 * may add a machine without restarting the daemon. A missing file is the
 * ordinary "not configured yet" answer, not a crash.
 */
export function readHosts(home: string): Map<string, HostTarget> {
  const path = hostsFilePath(home)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT') {
      throw new Error(
        `Хосты не настроены: файла ${path} нет. Создай его, например: ` +
          '{"prod":{"user":"deploy","host":"192.0.2.10","port":22},"box":{"local":true}}',
      )
    }
    throw readError(path, error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`hosts.json: ${path} не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`hosts.json: ${path} должен быть объектом «алиас → хост»`)
  }
  const hosts = new Map<string, HostTarget>()
  for (const [alias, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`hosts.json: алиас "${alias}" должен быть объектом`)
    }
    const record = entry as Record<string, unknown>
    if (record.local === true) {
      hosts.set(alias, { kind: 'local', alias })
      continue
    }
    const user = record.user
    const host = record.host
    if (typeof user !== 'string' || user.trim() === '' || typeof host !== 'string' || host.trim() === '') {
      throw new Error(`hosts.json: алиасу "${alias}" нужны поля user и host (строками) или "local": true`)
    }
    // A destination that starts with a dash would become an option of ssh
    // (`-oProxyCommand=...`); the owner's host list is not a place for that.
    for (const [field, value] of [
      ['user', user],
      ['host', host],
    ] as const) {
      if (value.trim().startsWith('-')) {
        throw new Error(`hosts.json: поля алиаса "${alias}" не могут начинаться с дефиса (${field})`)
      }
    }
    const port = record.port ?? 22
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`hosts.json: порт алиаса "${alias}" должен быть целым числом 1..65535`)
    }
    hosts.set(alias, { kind: 'ssh', alias, user: user.trim(), host: host.trim(), port })
  }
  return hosts
}

function clampTimeout(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.round(value * 1000), maximum)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Replace the values of the bot's own secrets. The daemon knows them from its
 * environment; a value shorter than four characters is not treated as a secret
 * (and cannot be, without making ordinary output unreadable).
 */
function scrubSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    result = result.split(secret).join(SECRET_PLACEHOLDER)
  }
  return result
}

/** Cut oversized output, keeping its beginning and its end and marking the cut. */
function boundOutput(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.max(1, Math.floor(limit * 0.4))
  const tail = Math.max(1, limit - head)
  return (
    `${text.slice(0, head)}\n` +
    `…[вывод обрезан: показано начало и хвост, всего ${text.length} символов]…\n` +
    `${text.slice(-tail)}`
  )
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall through to the single-process kill below.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The process is already gone.
  }
}

interface HostRun {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
  overflow: boolean
}

/** One started command, bounded by `timeoutMs`; the whole process group is killed on expiry. */
function runProcess(
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string; env: NodeJS.ProcessEnv },
): Promise<HostRun> {
  return new Promise<HostRun>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A new process group lets the timeout take the whole tree, not only
        // the first process (ssh may start helpers).
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(new Error(`не удалось запустить ${file}: ${errorText(error)}`))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let collected = 0
    let overflow = false
    let timedOut = false
    let settled = false

    const collect = (into: Buffer[], chunk: Buffer): void => {
      if (collected >= MAX_COLLECTED_BYTES) {
        overflow = true
        return
      }
      const room = MAX_COLLECTED_BYTES - collected
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (piece.length < chunk.length) overflow = true
      into.push(piece)
      collected += piece.length
    }

    child.stdout?.on('data', (chunk: Buffer) => collect(out, chunk))
    child.stderr?.on('data', (chunk: Buffer) => collect(err, chunk))

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, options.timeoutMs)

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        overflow,
      })
    }

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`не удалось запустить ${file}: ${errorText(error)}`))
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** Ask the guard and, for a confirmation-class command, the owner. */
async function admit(command: string, host: string, approval: ExecApproval | undefined, purpose?: string): Promise<void> {
  const verdict = checkCommand(command)
  if (verdict.verdict === 'deny') {
    throw new Error(`Отказ: команда запрещена (${verdict.reason})`)
  }
  if (verdict.verdict !== 'confirm') return
  if (approval === undefined) {
    throw new Error('Отказ: команда требует подтверждения, но подтверждение недоступно.')
  }
  const decision = await approval({
    command,
    reason: `${verdict.reason}; хост ${host}`,
    ...(purpose === undefined ? {} : { purpose }),
    purposeRequired: true,
  })
  if (decision === 'allow') return
  if (decision === 'purpose') {
    throw new Error(
      'host_exec: укажите purpose — зачем вы запускаете команду, своими словами, — и повторите вызов с purpose.',
    )
  }
  if (decision === 'expired') {
    throw new Error('Отказ: срок подтверждения истёк, команда не запущена.')
  }
  if (decision === 'unavailable') {
    throw new Error('Отказ: поблизости нет владельца, который мог бы подтвердить команду.')
  }
  throw new Error('Отказ: владелец отклонил команду.')
}

/** The text the model gets: status line, framed output, the cut mark and an optional note. */
function formatRun(run: HostRun, timeoutMs: number, secrets: readonly string[], note?: string): string {
  let status: string
  if (run.timedOut) {
    status = `Таймаут: команда убита через ${Math.round(timeoutMs / 1000)} с.`
  } else if (run.signal !== null) {
    status = `Завершено сигналом ${run.signal}.`
  } else {
    status = `exit ${run.code === null ? 'unknown' : run.code}`
  }
  const output = [run.stdout, run.stderr === '' ? '' : `--- stderr ---\n${run.stderr}`]
    .filter((part) => part !== '')
    .join('\n')
  const bounded = boundOutput(scrubSecrets(output === '' ? '(нет вывода)' : output, secrets), MAX_HOST_OUTPUT_CHARS)
  const body = run.overflow ? `${bounded}\n…[вывод обрезан при сборе: команда напечатала слишком много]…` : bounded
  // The status stays the first line outside the frame: the rest of the bot
  // reads it, while everything the host command printed is foreign data.
  const framed = `${status}\n${frameData(body, { source: 'host_exec' })}`
  // The write-guard explanation is the bot's own note, not command output, so
  // it stays outside the data frame, after the closing boundary.
  return note === undefined ? framed : `${framed}\n${note}`
}

/**
 * Run a local command under the write guard. The probe uses the very same bwrap
 * profile, so a bwrap that cannot bind the writable roots is reported before
 * the command runs; the probe is not cached, because a broken bwrap must never
 * turn into a remembered success.
 */
async function runLocalCommand(
  command: string,
  home: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[],
): Promise<string> {
  const bwrap = findExecutable('bwrap', env.PATH)
  if (bwrap === undefined) throw protectionUnavailable('bwrap не найден в PATH.')
  // DSHBOT_HOST_WRITABLE belongs to the daemon, not to the child environment;
  // it is read on every run, so adding or removing a directory needs no restart.
  const roots = hostWriteRoots(home, process.env)
  const mvProblem = mvOutsideWriteRoots(command, cwd, roots)
  if (mvProblem !== undefined) {
    throw new Error(
      `Отказ: перенос файла вне DSHBOT_HOME запрещён без карточки (${mvProblem}), команда не запущена. ` +
        HOST_WRITE_GUARD_NOTE,
    )
  }
  const probe = await runProcess(bwrap, localSandboxArgs(roots, cwd, ['/bin/true']), {
    timeoutMs: Math.min(timeoutMs, 10_000),
    env,
  })
  if (probe.timedOut || probe.code !== 0) {
    const detail = probe.stderr.trim() || probe.stdout.trim() || `bwrap завершился с кодом ${probe.code ?? 'unknown'}`
    throw protectionUnavailable(detail)
  }
  const run = await runProcess(bwrap, localSandboxArgs(roots, cwd, ['/bin/bash', '-c', command]), { timeoutMs, env })
  // A successful shell tail must not hide the diagnostic of a refused write.
  const writeRefused = /\b(?:Read-only file system|Permission denied|Operation not permitted|EROFS|EACCES|EPERM)\b/i.test(run.stderr)
  const note = run.timedOut || run.code !== 0 || writeRefused ? HOST_WRITE_GUARD_NOTE : undefined
  return formatRun(run, timeoutMs, secrets, note)
}

/**
 * Create `host_exec`. Nothing is started before the alias resolves, the guard
 * allows the command and, when the guard asks, the owner allows it.
 */
export function createHostExecTools(options: HostExecOptions): HostExecTools {
  const defaultTimeout = Math.max(1, options.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS)
  const maxTimeout = Math.max(defaultTimeout, options.maxTimeoutMs ?? MAX_HOST_TIMEOUT_MS)
  /** The scrubber's values, read at every command so a fresh sign-in applies at once. */
  const secretValues = async (): Promise<readonly string[]> => {
    // The bot's own secrets are always scrubbed; a function adds the values of
    // provider sign-ins on top of them, an explicit array still replaces them.
    const own = [process.env.TELEGRAM_BOT_TOKEN ?? '', process.env.DEEPSEEK_API_KEY ?? '']
    const source = typeof options.secrets === 'function' ? [...own, ...(await options.secrets())] : (options.secrets ?? own)
    return [
      ...new Set(
        source.filter((secret) => typeof secret === 'string' && secret.length > 0),
      ),
    ]
  }

  const tool: RunnerTool = {
    name: HOST_EXEC_TOOL_NAME,
    lazy: true,
    description:
      'Run a command on one of the owner\'s hosts from DSHBOT_HOME/hosts.json: an ssh target (the owner\'s key, ' +
      'non-interactive) or a local alias (this machine, outside the exec sandbox, so systemctl/journalctl and ' +
      '/var work). Dangerous commands need the owner to press an approval button. The output is bounded and ' +
      'the bot\'s own secrets are hidden. Read-only checks (df, journalctl, systemctl status) need no button.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'Alias of a host from DSHBOT_HOME/hosts.json (for example "prod" or "box").',
        },
        command: {
          type: 'string',
          description: 'Shell command line to run on the host with its default shell.',
        },
        purpose: {
          type: 'string',
          description:
            'Why you are running the command, in your own words. Required when the owner has to confirm a ' +
            'command: the approval card shows it in a signed «Зачем (со слов бота)» block before the ' +
            'explanation built from the command itself.',
        },
        timeout_sec: {
          type: 'number',
          description: 'Foreground timeout in seconds (default 120, maximum 600).',
        },
      },
      required: ['host', 'command'],
      additionalProperties: false,
    },
    async execute(args) {
      const alias = args.host
      if (typeof alias !== 'string' || alias.trim() === '') {
        throw new Error('host_exec: поле host обязательно и должно быть непустой строкой')
      }
      const command = args.command
      if (typeof command !== 'string' || command.trim() === '') {
        throw new Error('host_exec: поле command обязательно и должно быть непустой строкой')
      }
      const hosts = readHosts(options.home)
      const target = hosts.get(alias.trim())
      if (target === undefined) {
        const known = [...hosts.keys()].sort().join(', ')
        throw new Error(
          `host_exec: хост "${alias.trim()}" не описан в ${hostsFilePath(options.home)}. ` +
            `Известные алиасы: ${known === '' ? '(список пуст)' : known}.`,
        )
      }
      await admit(
        command,
        target.alias,
        options.approval,
        typeof args.purpose === 'string' ? args.purpose : undefined,
      )
      const timeoutMs = clampTimeout(args.timeout_sec, defaultTimeout, maxTimeout)
      const secrets = await secretValues()
      // The daemon holds the model key and the bot token; neither the local
      // command nor the ssh client may see them (the output scrubber is not a
      // substitute: an encoded or posted value never matches it).
      const env = hostEnvironment()
      if (target.kind === 'local') {
        const cwd = env.HOME ?? options.home
        if (realDirectory(cwd) === undefined) {
          throw new Error(`host_exec: рабочий каталог "${cwd}" не найден, команда не запущена.`)
        }
        return runLocalCommand(command, options.home, cwd, timeoutMs, env, secrets)
      }
      const run = await runProcess(
        'ssh',
        ['-o', 'BatchMode=yes', '-p', String(target.port), `${target.user}@${target.host}`, command],
        { timeoutMs, env },
      )
      return formatRun(run, timeoutMs, secrets)
    },
  }

  return { tools: [tool] }
}
