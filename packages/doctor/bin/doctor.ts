// Independent recovery doctor of DSHBOT.
//
// This process is deliberately a single self-contained module of the deployed
// application tree (`%h/.local/share/dshbot/app`): it imports nothing but Node
// built-ins, so it starts when `node_modules` is absent, `packages/app` is
// broken and the main daemon cannot start at all.
//
// It lives in `bin/`, not in `src/`: it is an executable entry point, not a
// library module, and it is the one deliberate exception to "package sources do
// not start a shell" (the bash tool of the doctor exists precisely for that).
//
// systemd starts it through `OnFailure=dshbot-doctor.service` of the main unit.
// The contract with the main daemon is the Telegram long poll: the doctor polls
// `getUpdates` only while `dshbot.service` is not active, and exits as soon as
// the main unit is active again (otherwise both processes would fight over the
// same bot token and Telegram would answer 409). A short grace window before
// the first notice lets a restart already in flight finish: systemd restarts an
// intentionally stopped daemon after RestartSec, and paging the owner in that
// pause would report a false crash.
//
// It speaks only to the owner: the chat id comes from `telegram.owner_chat_id`
// in `DSHBOT_HOME/state.db`, every other chat and every callback of another user
// is ignored. The owner gets `/status`, `/restart` and a free-form DeepSeek turn
// with exactly one `bash` tool. Read-only commands run immediately; anything
// else needs the owner's "Разрешить" button. Every command runs inside bwrap
// with a read-only machine and only DSHBOT_HOME and /tmp writable. Every value
// of the service env-file and of token/key variables is masked in every message
// and model request.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const UNIT = 'dshbot.service'
const OWNER_KV_KEY = 'telegram.owner_chat_id'
/** The main daemon's flash model (MODEL_FLASH of packages/app); there is no separate setting. */
const MODEL = 'deepseek-flash'
const JOURNAL_LINES = 30
const POLL_TIMEOUT_SECONDS = 2
const ACTIVE_CHECK_MS = 1_500
/** Default wait for a systemd restart to bring the unit back after OnFailure. */
const DEFAULT_GRACE_MS = 30_000
/** How often the grace window asks `is-active` before it gives up. */
const GRACE_CHECK_MS = 500
const UNIT_COMMAND_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 60_000
const COMMAND_OUTPUT_LIMIT = 20_000
/** Raw output kept per stream; masking runs on it before the model limit cuts it. */
const COMMAND_CAPTURE_LIMIT = 1024 * 1024
const MODEL_TIMEOUT_MS = 90_000
const MODEL_MAX_TOKENS = 2_000
const MODEL_MAX_STEPS = 10
const CONFIRM_TIMEOUT_MS = 5 * 60_000
const TELEGRAM_CHUNK = 3_800
const MASK = '[скрыто]'

// Whole env-name parts only: GIT_AUTHOR_NAME and SSH_AUTH_SOCK must not be
// mistaken for secrets and masked inside ordinary text.
const SECRET_NAME = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH)(_|$)/i

function isSecretName(name: string): boolean {
  // SSH_AUTH_SOCK is a socket path, not a credential: the bash tool may need it.
  return name !== 'SSH_AUTH_SOCK' && SECRET_NAME.test(name)
}
const SECRET_VALUE_PATTERNS = [/\bsk-[A-Za-z0-9_-]{8,}\b/g, /\b\d{6,}:AA[A-Za-z0-9_-]{10,}\b/g]

const BASH_TOOL = {
  name: 'bash',
  description:
    'Выполнить команду bash на машине владельца в каталоге приложения DSHBOT_HOME. ' +
    'Команды только для чтения выполняются сразу; изменяющие команды требуют подтверждения владельца в Telegram. ' +
    'Писать и удалять можно только внутри DSHBOT_HOME и /tmp.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда bash одной строкой.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
} as const

interface DoctorConfig {
  home: string
  token: string
  apiRoot: string
  modelBaseUrl: string
  apiKey: string
  /** How long to wait for a restarted unit before reporting it as down. */
  graceMs: number
  /** Variable names of the service env-file: the bash tool does not inherit them. */
  envFileNames: readonly string[]
}

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

interface ActiveState {
  active: boolean
  output: string
}

interface TelegramChat {
  id?: number
  type?: string
}

interface TelegramUser {
  id?: number
  is_bot?: boolean
}

interface TelegramMessage {
  message_id?: number
  chat?: TelegramChat
  from?: TelegramUser
  text?: string
}

interface TelegramCallback {
  id?: string
  from?: TelegramUser
  data?: string
  message?: TelegramMessage
}

interface TelegramUpdate {
  update_id?: number
  message?: TelegramMessage
  callback_query?: TelegramCallback
}

interface ModelBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface ModelMessage {
  role: 'user' | 'assistant'
  content: unknown
}

interface ToolOutcome {
  text: string
  error: boolean
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : `${error.name}: ${error.message}`
  return String(error)
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** A configured positive integer of milliseconds; anything else means "unset". */
export function positiveMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Variable names assigned in a systemd EnvironmentFile; a missing file has none.
 * Values are never read from the file: systemd exports them into this process,
 * so the runtime value is the one to mask.
 */
export function readEnvFileNames(path: string): string[] {
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const names: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
    if (match !== null) names.push(match[1] ?? '')
  }
  return names
}

/**
 * A scrubber of the values the process may see: token/key-like variables and
 * the runtime value of every variable the service EnvironmentFile names,
 * whatever its name or length. The file is the operator's list of what must
 * stay private. A one-character value is masked wherever it occurs too: hiding
 * a digit is better than leaking a key.
 */
export function createScrubber(env: NodeJS.ProcessEnv, fileNames: readonly string[] = []): (text: string) => string {
  const secrets = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    secrets.add(value)
    try {
      secrets.add(encodeURIComponent(value))
    } catch {
      // A value that cannot be encoded is still masked verbatim.
    }
    // The secret half of a Telegram token (`<bot id>:<secret>`) on its own.
    const colon = value.indexOf(':')
    if (colon >= 0 && value.length - colon - 1 >= 8) secrets.add(value.slice(colon + 1))
  }

  for (const [name, value] of Object.entries(env)) {
    if (isSecretName(name)) add(value)
  }
  // systemd exports every env-file assignment into this process. The file itself
  // is only parsed for names: a value may be changed or escaped by systemd, but
  // the runtime value of every variable named there must still be masked,
  // whatever the name looks like.
  for (const name of fileNames) add(env[name])

  const ordered = [...secrets].sort((left, right) => right.length - left.length)
  // One alternation, longest first, in a single pass: the mask itself is never
  // matched again by a shorter value.
  const pattern =
    ordered.length === 0
      ? undefined
      : new RegExp(ordered.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return (text: string): string => {
    let result = pattern === undefined ? text : text.replace(pattern, MASK)
    for (const shape of SECRET_VALUE_PATTERNS) result = result.replace(shape, MASK)
    return result
  }
}

/** Deep copy with every string scrubbed: model requests must not carry secrets. */
function scrubDeep(value: unknown, clean: (text: string) => string): unknown {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, clean))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubDeep(item, clean)]),
    )
  }
  return value
}

function bounded(text: string, limit = COMMAND_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n… вывод обрезан (${text.length} символов)`
}

function runCommand(name: string, args: readonly string[], env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(name, [...args], {
    encoding: 'utf8',
    env,
    // Bounded well below the 30 s exit promise: the active-state monitor shares this thread.
    timeout: UNIT_COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: textOf(result.stdout),
    stderr: textOf(result.stderr),
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function nearestRealPath(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(basename(current))
    current = parent
  }
  try {
    current = realpathSync(current)
  } catch {
    // Keep the lexical path when realpath cannot resolve it.
  }
  return tail.length === 0 ? current : join(current, ...tail)
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * bwrap up to the command: the whole machine read-only, DSHBOT_HOME and /tmp
 * writable, the home as working directory. The private PID namespace with its
 * own /proc keeps `/proc/<pid>/root` of a host process (the doctor itself) from
 * being a writable way back to the host root, as in packages/tools-exec.
 */
export function sandboxPrefix(home: string): string[] {
  const homeReal = nearestRealPath(home)
  const roots = [...new Set([nearestRealPath('/tmp'), homeReal])].sort((left, right) => left.length - right.length)
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  for (const root of roots) args.push('--bind', root, root)
  args.push('--chdir', homeReal, '--')
  return args
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** The fake and the real unit both answer `active` only with a zero exit. */
function isActiveState(result: CommandResult): boolean {
  return result.status === 0 && result.stdout.trim() === 'active'
}

/**
 * A conservative static guard for a confirmed command, in front of the bwrap
 * sandbox that actually enforces the write roots. It refuses every absolute,
 * home-relative or parent-relative path that does not resolve into DSHBOT_HOME
 * or /tmp, so the owner gets a clear refusal instead of a read-only error. That
 * covers redirects, `rm`, a symlink inside the home that points outside and an
 * inline `node -e` script that carries an absolute path. Paths are normalized
 * first: `//home/x` and `/tmp/../home/x` are `/home/x`.
 */
export function unsafePathReason(command: string, home: string): string | undefined {
  if (/(^|[\s'"=<>|;&()])(\$HOME|\$\{HOME\})(?=$|[\/\s'"`;|&<>()])/.test(command)) {
    return 'домашний каталог пользователя'
  }
  if (/(^|[\s'"=<>|;&()])~[^\s'"`;|&<>()]*/.test(command)) {
    return 'домашний каталог пользователя'
  }
  if (/(^|[\s'"=<>|;&()])\.\.(?=$|[\s'"`;|&<>()/])/.test(command)) {
    return 'путь с «..»'
  }
  if (/(^|[\s'"=<>|;&()])\/(?=$|[\s'"`;|&<>()])/.test(command)) {
    return 'корень файловой системы'
  }

  const homeReal = nearestRealPath(home)
  const tmpReal = nearestRealPath('/tmp')
  const roots = [homeReal, tmpReal]
  const allowedDevices = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/fd', '/proc/self/fd']
  const words: string[] = []
  const pattern = /(?<![\w:])\/[^\s'"`;|&<>()]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(command)) !== null) words.push(match[0])

  for (const raw of words) {
    const candidate = resolve(home, raw.replace(/[.,:]+$/, '') || '/')
    if (candidate === '/') return 'корень файловой системы'
    if (allowedDevices.some((prefix) => inside(prefix, candidate))) continue
    const real = nearestRealPath(candidate)
    if (roots.some((root) => inside(root, real))) continue
    return candidate
  }
  return undefined
}

/**
 * Only plain words reach the read-only check: no quotes, escapes, `$`,
 * backticks, operators, redirects, groups, comments or braces. Such a line is
 * split by bash exactly on spaces and tabs, so the words checked here are the
 * words the program gets. Anything else needs the owner's button.
 */
const PLAIN_LINE = /^[\p{L}\p{N}_\-./:=,@%+~^*?[\] \t]+$/u
const GLOB = /[*?[\]]/

/** Long options and short letters a program accepts; `values` take an argument. */
interface OptionTable {
  flags: ReadonlySet<string>
  values: ReadonlySet<string>
}

const JOURNALCTL_OPTIONS: OptionTable = {
  flags: new Set([
    '--user', '--system', '--no-pager', '--pager-end', '--reverse', '--catalog', '--quiet', '--utc',
    '--no-hostname', '--all', '--full', '--no-full', '--merge', '--dmesg', '--list-boots', '--disk-usage',
    'e', 'r', 'x', 'q', 'a', 'l', 'm', 'k',
  ]),
  values: new Set([
    '--unit', '--user-unit', '--lines', '--boot', '--since', '--until', '--priority', '--output',
    '--output-fields', '--grep', '--identifier', '--case-sensitive',
    'u', 'n', 'b', 'p', 'o', 'g', 't', 'S', 'U',
  ]),
}

const SYSTEMCTL_OPTIONS: OptionTable = {
  flags: new Set(['--user', '--system', '--no-pager', '--full', '--all', '--quiet', '--no-legend', '--plain', 'l', 'a', 'q']),
  values: new Set(['--lines', '--output', 'n', 'o']),
}

/**
 * Positional words of a command whose every option is in the table. Long
 * options must match exactly (getopt would also accept an unambiguous prefix,
 * so `--rot` would be `--rotate`), short letters may be clustered. An option
 * value is skipped only when it cannot itself be an option: a word starting
 * with `-` is checked as an option, which is the strict reading in every case.
 */
function positionalWords(args: readonly string[], table: OptionTable): string[] | undefined {
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    const skipValue = (): void => {
      if (!(args[index + 1] ?? '-').startsWith('-')) index += 1
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals < 0 ? arg : arg.slice(0, equals)
      if (table.values.has(name)) {
        if (equals < 0) skipValue()
        continue
      }
      if (equals < 0 && table.flags.has(name)) continue
      return undefined
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at] ?? ''
        if (table.flags.has(letter)) continue
        if (!table.values.has(letter)) return undefined
        if (at === arg.length - 1) skipValue()
        break
      }
      continue
    }
    positional.push(arg)
  }
  return positional
}

/**
 * The only git subcommands that only read. Everything else (checkout, reset,
 * fetch, clean, config, the mutating branch forms) always needs the button.
 */
const GIT_READ_SUBCOMMANDS = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'branch'])

/**
 * Long git options that run another program or redirect git itself: git accepts
 * any unambiguous abbreviation, so `--out` is `--output` too.
 */
const GIT_FORBIDDEN_OPTIONS = [
  '--ext-diff', '--textconv', '--config-env', '--exec-path', '--git-dir', '--work-tree', '--output',
]

function gitForbiddenOption(arg: string): boolean {
  if (arg === '-c' || (arg.startsWith('-c') && !arg.startsWith('--'))) return true
  if (!arg.startsWith('--')) return false
  const name = arg.split('=', 1)[0] ?? ''
  return GIT_FORBIDDEN_OPTIONS.some((option) => option.startsWith(name) && name.length >= 3)
}

const BRANCH_FLAGS = new Set([
  '--list', '--all', '--remotes', '--verbose', '--no-abbrev', '--no-column', '--ignore-case',
  '--omit-empty', '--show-current', '--color', '--no-color',
])
const BRANCH_VALUES = new Set([
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
  '--abbrev', '--column',
])

/** `git branch` reads only listing/filter forms; a positional word creates a branch. */
function gitBranchReads(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ''
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = equals < 0 ? arg : arg.slice(0, equals)
      if (BRANCH_VALUES.has(name)) {
        if (equals < 0) {
          const value = args[index + 1] ?? '-'
          if (value.startsWith('-')) return false
          index += 1
        }
        continue
      }
      if (equals < 0 && BRANCH_FLAGS.has(name)) continue
      return false
    }
    if (arg.startsWith('-') && arg.length > 1) {
      if (!/^-(?:a|r|v{1,2}|l|i|q)$/.test(arg)) return false
      continue
    }
    // `git branch new-branch` and `git branch <name> <start>` write refs.
    return false
  }
  return true
}

/** `git <read subcommand>` without global options other than `-C <dir>`. */
function gitReads(args: readonly string[]): boolean {
  let index = 0
  // `-c`, `--exec-path`, `--git-dir` and the like can run arbitrary programs or
  // point git elsewhere; only the directory switch is a plain read.
  while (args[index] === '-C' && !(args[index + 1] ?? '-').startsWith('-')) index += 2
  const subcommand = args[index] ?? ''
  // Any other option before the subcommand is global (`-c core.pager=...`,
  // `--git-dir=...`); only `-C` was consumed above.
  if (subcommand.startsWith('-') || !GIT_READ_SUBCOMMANDS.has(subcommand)) return false
  const rest = args.slice(index + 1)
  if (rest.some(gitForbiddenOption)) return false
  return subcommand === 'branch' ? gitBranchReads(rest) : true
}

/**
 * Commands from the read-only list run without a card. Everything with a shell
 * operator (`;`, `|`, `$(`, backticks, redirects), a quote or an escape is
 * deliberately not "read-only": splitting the line is not a proof that every
 * part only reads, and a quoted word can hide an option from a naive split.
 */
export function isReadOnly(command: string): boolean {
  const text = command.trim()
  if (text === '' || text.length > 2_000) return false
  if (!PLAIN_LINE.test(text)) return false
  const words = text.split(/[ \t]+/)
  // A bare program name: `./cat` or `/tmp/x/cat` is some other program.
  const name = words[0] ?? ''
  const args = words.slice(1)
  if (name === 'cat' || name === 'ls' || name === 'tail' || name === 'grep') return true
  // A glob may expand to a file named like an option (`--rotate`, `--output=x`).
  if (args.some((arg) => GLOB.test(arg))) return false
  if (name === 'journalctl') return positionalWords(args, JOURNALCTL_OPTIONS) !== undefined
  if (name === 'git') return gitReads(args)
  if (name === 'systemctl') {
    const positional = positionalWords(args, SYSTEMCTL_OPTIONS)
    return positional !== undefined && (positional[0] === 'status' || positional[0] === 'is-active')
  }
  return false
}

function readOwner(home: string): number | null {
  let db: DatabaseSync | undefined
  try {
    const file = join(home, 'state.db')
    try {
      db = new DatabaseSync(file, { readOnly: true })
    } catch {
      // A WAL-mode database left by a crashed daemon can refuse a read-only
      // open; the doctor only reads, but opening read-write is harmless.
      db = new DatabaseSync(file)
    }
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(OWNER_KV_KEY) as
      | { value?: unknown }
      | undefined
    const raw = row === undefined ? undefined : String(row.value ?? '')
    if (raw === undefined || !/^-?\d+$/.test(raw)) return null
    const parsed = Number(raw)
    return Number.isSafeInteger(parsed) ? parsed : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // The handle is already unusable; nothing to release.
    }
  }
}

class Doctor {
  private readonly config: DoctorConfig
  private readonly clean: (text: string) => string
  private readonly systemEnv: NodeJS.ProcessEnv
  private readonly childEnv: NodeJS.ProcessEnv
  private owner = 0
  private offset = 0
  private confirmSeq = 0
  private readonly pending = new Map<string, (allow: boolean) => void>()
  private chain: Promise<void> = Promise.resolve()
  private monitor: NodeJS.Timeout | undefined
  private finished = false
  /** bwrap arguments up to the command, or null when bwrap cannot run here. */
  private sandbox: string[] | null | undefined
  private readonly running = new Set<ChildProcess>()

  constructor(config: DoctorConfig, clean: (text: string) => string, env: NodeJS.ProcessEnv) {
    this.config = config
    this.clean = clean
    this.systemEnv = env
    // The bash tool gets neither credentials nor the daemon's env-file settings;
    // the basic process environment stays even when the env-file repeats it.
    const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
    const fileNames = new Set(config.envFileNames.filter((name) => !keep.has(name)))
    this.childEnv = Object.fromEntries(
      Object.entries(env).filter(([name]) => !isSecretName(name) && !fileNames.has(name)),
    )
  }

  async start(): Promise<void> {
    const initial = this.activeState()
    if (initial.active) {
      this.exit(0)
      return
    }
    const owner = readOwner(this.config.home)
    if (owner === null) {
      process.stderr.write('[doctor] telegram.owner_chat_id is not set in state.db\n')
      this.exit(1)
      return
    }
    this.owner = owner

    // OnFailure also fires for a deliberate restart (exit 42 or 75): the unit is
    // not active during RestartSec, and systemd brings it back in a few seconds.
    // Give that restart the whole grace window before treating the unit as down.
    const settled = await this.waitForUnit(initial)
    if (settled.active) {
      this.exit(0)
      return
    }

    // The recovery monitor starts before the failure notice: a stalled Bot API
    // must not delay the exit that releases getUpdates for the main daemon.
    this.monitor = setInterval(() => {
      try {
        if (this.activeState().active) this.exit(0)
      } catch {
        // A broken systemctl must not kill the only recovery channel.
      }
    }, ACTIVE_CHECK_MS)
    this.monitor.unref?.()

    try {
      await this.notifyFailure(settled.output)
    } catch (error) {
      process.stderr.write(`[doctor] failure notice: ${this.clean(errorText(error))}\n`)
    }

    await this.poll()
  }

  /**
   * Wait for the unit to become active again, polling `is-active` up to the
   * configured grace window. Returns the last observed state: an active one
   * ends the doctor silently, so an intentional restart never pages the owner
   * and never starts a second getUpdates beside the returning daemon.
   */
  private async waitForUnit(initial: ActiveState): Promise<ActiveState> {
    const deadline = Date.now() + this.config.graceMs
    let state = initial
    while (!state.active) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(GRACE_CHECK_MS, remaining)))
      if (this.finished) return state
      state = this.activeState()
    }
    return state
  }

  private exit(code: number): void {
    if (this.finished) return
    this.finished = true
    if (this.monitor !== undefined) clearInterval(this.monitor)
    // A bash command still running must not outlive the doctor.
    for (const child of this.running) killGroup(child)
    process.exit(code)
  }

  private unitCommand(name: 'systemctl' | 'journalctl', args: readonly string[]): CommandResult {
    return runCommand(name, args, this.systemEnv)
  }

  private activeState(): ActiveState {
    const result = this.unitCommand('systemctl', ['--user', 'is-active', UNIT])
    const output = result.stdout.trim() === '' ? result.stderr.trim() : result.stdout.trim()
    return { active: isActiveState(result), output }
  }

  private journalTail(lines = JOURNAL_LINES): string {
    const result = this.unitCommand('journalctl', ['--user', '-u', UNIT, '-n', String(lines), '--no-pager'])
    const output = (result.stdout.trimEnd() === '' ? result.stderr.trimEnd() : result.stdout.trimEnd()).trim()
    return output === '' ? '(журнал пуст)' : output
  }

  private async notifyFailure(state: string): Promise<void> {
    const text = [
      `💥 Основной бот DSHBOT лежит: юнит ${UNIT} не active (${state.trim() === '' ? 'нет ответа' : state.trim()}).`,
      `Последние ${JOURNAL_LINES} строк журнала:`,
      this.journalTail(JOURNAL_LINES),
      'Я — доктор и слушаю только владельца. /status — состояние, /restart — перезапуск; ' +
        'любой другой текст — вопрос модели DeepSeek с инструментом bash.',
    ].join('\n')
    await this.sendText(this.owner, text)
  }

  private async status(): Promise<void> {
    const active = this.activeState()
    const show = this.unitCommand('systemctl', [
      '--user',
      'show',
      UNIT,
      '--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus',
    ])
    const showText = show.stdout.trim() === '' ? show.stderr.trim() : show.stdout.trim()
    const text = [
      `Доктор DSHBOT — состояние ${UNIT}`,
      `is-active: ${active.output === '' ? 'нет ответа' : active.output}`,
      'systemctl show:',
      showText === '' ? '(нет данных)' : showText,
      `Последние ${JOURNAL_LINES} строк журнала:`,
      this.journalTail(JOURNAL_LINES),
    ].join('\n')
    await this.sendText(this.owner, text)
  }

  private async restart(): Promise<void> {
    this.unitCommand('systemctl', ['--user', 'reset-failed', UNIT])
    this.unitCommand('systemctl', ['--user', 'start', UNIT])
    try {
      await this.sendText(
        this.owner,
        `Доктор: перезапускаю ${UNIT} и прекращаю getUpdates, чтобы не мешать основному боту.`,
      )
    } catch {
      // The restart has already been issued; the exit is what matters.
    }
    this.exit(0)
  }

  private async poll(): Promise<void> {
    while (!this.finished) {
      if (this.activeState().active) {
        this.exit(0)
        return
      }
      let updates: TelegramUpdate[]
      try {
        const result = await this.telegram<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'callback_query'],
        })
        updates = Array.isArray(result) ? result : []
      } catch (error) {
        if (this.finished) return
        process.stderr.write(`[doctor] getUpdates: ${this.clean(errorText(error))}\n`)
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
        continue
      }
      for (const update of updates) {
        const id = Number(update.update_id)
        if (Number.isSafeInteger(id)) this.offset = Math.max(this.offset, id + 1)
        if (update.callback_query !== undefined) this.onCallback(update.callback_query)
        else if (update.message !== undefined) this.onMessage(update.message)
      }
    }
  }

  private onMessage(message: TelegramMessage): void {
    const chatId = Number(message.chat?.id)
    const fromId = Number(message.from?.id)
    if (!Number.isSafeInteger(chatId) || chatId !== this.owner) return
    if (!Number.isSafeInteger(fromId) || fromId !== this.owner) return
    const text = typeof message.text === 'string' ? message.text : ''
    if (text.trim() === '') return
    this.enqueue(async () => {
      const command = text.trim()
      if (command === '/status' || command.startsWith('/status@')) {
        await this.status()
        return
      }
      if (command === '/restart' || command.startsWith('/restart@')) {
        await this.restart()
        return
      }
      await this.modelTurn(text)
    })
  }

  private onCallback(query: TelegramCallback): void {
    const fromId = Number(query.from?.id)
    const chatId = Number(query.message?.chat?.id)
    if (!Number.isSafeInteger(fromId) || fromId !== this.owner) return
    if (!Number.isSafeInteger(chatId) || chatId !== this.owner) return
    const data = typeof query.data === 'string' ? query.data : ''
    const match = /^doctor:(allow|deny):(\d+)$/.exec(data)
    if (match === null) return
    const resolve = this.pending.get(match[2] ?? '')
    if (resolve === undefined) return
    this.pending.delete(match[2] ?? '')
    resolve(match[1] === 'allow')
    if (typeof query.id === 'string') {
      void this.telegram('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain
      .then(task)
      .catch((error: unknown) => {
        process.stderr.write(`[doctor] ${this.clean(errorText(error))}\n`)
      })
  }

  private async modelTurn(ownerText: string): Promise<void> {
    const messages: ModelMessage[] = [{ role: 'user', content: ownerText }]
    for (let step = 0; step < MODEL_MAX_STEPS; step += 1) {
      let blocks: ModelBlock[]
      try {
        blocks = await this.callModel(messages)
      } catch (error) {
        await this.sendText(
          this.owner,
          `Доктор: не удалось получить ответ модели. ${errorText(error)}`,
        )
        return
      }
      messages.push({ role: 'assistant', content: blocks })
      const uses = blocks.filter((block) => block.type === 'tool_use')
      if (uses.length === 0) {
        const answer = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('')
        await this.sendText(this.owner, answer.trim() === '' ? 'Доктор: модель не ответила текстом.' : answer)
        return
      }
      const results: unknown[] = []
      for (const use of uses) {
        const outcome = await this.runTool(use)
        results.push({
          type: 'tool_result',
          tool_use_id: typeof use.id === 'string' ? use.id : '',
          content: outcome.text,
          ...(outcome.error ? { is_error: true } : {}),
        })
      }
      messages.push({ role: 'user', content: results })
    }
    await this.sendText(this.owner, 'Доктор: модель не завершила ход за отведённое число шагов.')
  }

  private async callModel(messages: ModelMessage[]): Promise<ModelBlock[]> {
    // Same rule as the daemon's Messages transport: append `/v1/messages`, but
    // reuse an explicit final `/v1` so a configured root is not doubled.
    const base = this.config.modelBaseUrl.replace(/\/+$/, '')
    const root = new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
    const url = `${root}/messages`
    // Everything the owner, the journal or a command can put into the request
    // is scrubbed; the fixed model id and tool schema are not data and must
    // reach the API unchanged even if an env-file value happens to occur in them.
    const payload = {
      model: MODEL,
      max_tokens: MODEL_MAX_TOKENS,
      system: this.clean(this.systemPrompt()),
      messages: scrubDeep(messages, this.clean),
      tools: [BASH_TOOL],
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`DeepSeek API ответил ${response.status}: ${bounded(raw, 300)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('DeepSeek API вернул не JSON')
    }
    const object = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const error = object.error
    if (error !== undefined && error !== null) {
      const message =
        typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message?: unknown }).message)
          : 'ошибка API'
      throw new Error(message)
    }
    const content = object.content
    if (!Array.isArray(content)) throw new Error('DeepSeek API вернул ответ без content')
    return content as ModelBlock[]
  }

  private systemPrompt(): string {
    return [
      'Ты — доктор DSHBOT, отдельный аварийный мини-юнит. Основной демон бота сейчас не active, и ты помогаешь владельцу восстановить его через Telegram.',
      `Рабочий каталог твоего инструмента bash — ${this.config.home}.`,
      'У тебя ровно один инструмент: bash. Команды чтения (journalctl, systemctl status/is-active, cat, ls, tail, grep, git status/log/show/diff/rev-parse и список ветвей branch) из простых слов, без кавычек, $, конвейеров и перенаправлений, выполняются сразу. Любая другая команда показывается владельцу с кнопкой «Разрешить»; без нажатия она не выполняется.',
      'Команды идут в песочнице: изменять и удалять файлы можно только внутри рабочего каталога и /tmp, остальная файловая система только для чтения даже после подтверждения.',
      'Не выводи секреты, токены и ключи. Журнал и вывод команд уже маскируются, но не полагайся на это.',
      'Отвечай на языке собеседника, коротко и по делу. Говори, что проверил и что предлагаешь дальше.',
    ].join('\n')
  }

  private async runTool(use: ModelBlock): Promise<ToolOutcome> {
    const input = use.input !== null && typeof use.input === 'object' ? (use.input as Record<string, unknown>) : {}
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (command === '') return { text: 'Отказ: пустая команда.', error: true }
    if (command.length > 4_000) return { text: 'Отказ: команда слишком длинная.', error: true }

    const sandbox = this.sandboxArgs()
    if (sandbox === null) {
      // No confirmation can make an unsandboxed command safe: even a read-only
      // git can run hooks, aliases or a pager from the owner's config, and every
      // confirmed command may write. The refusal is shown without a card.
      return {
        text:
          'Отказ: песочница bwrap недоступна, поэтому инструмент bash ничего не запускает: без неё запись вне ' +
          'DSHBOT_HOME и /tmp не исключить. Проверь, что bwrap установлен и может создать пространство имён. ' +
          '/status и /restart работают без bash.',
        error: true,
      }
    }
    const readonly = isReadOnly(command)
    if (!readonly) {
      const unsafe = unsafePathReason(command, this.config.home)
      if (unsafe !== undefined) {
        return {
          text: `Отказ: ${unsafe} находится вне DSHBOT_HOME и /tmp; изменять этот путь запрещено даже после подтверждения.`,
          error: true,
        }
      }
      const allowed = await this.askPermission(command)
      if (!allowed) {
        return {
          text: 'Отказ: владелец не разрешил выполнение команды; ничего не запущено.',
          error: true,
        }
      }
    }

    // Every command, read-only or confirmed, runs in the same bwrap profile.
    // A read-only git additionally gets a config-isolated environment: aliases,
    // hooks and a pager from the owner's global config must not run anything.
    const isReadOnlyGit = readonly && (command.trim().split(/[ \t]+/)[0] ?? '') === 'git'
    const env = isReadOnlyGit
      ? { ...this.childEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PAGER: 'cat' }
      : this.childEnv
    const result = await this.execBash(command, sandbox, env)
    return { text: bounded(this.clean(result.text)), error: result.status !== 0 }
  }

  /** bwrap prefix for every bash command, probed once; null when bwrap does not work here. */
  private sandboxArgs(): string[] | null {
    if (this.sandbox !== undefined) return this.sandbox
    const args = sandboxPrefix(this.config.home)
    const probe = spawnSync('bwrap', [...args, 'true'], {
      env: this.childEnv,
      stdio: 'ignore',
      timeout: UNIT_COMMAND_TIMEOUT_MS,
    })
    this.sandbox = probe.status === 0 ? args : null
    if (this.sandbox === null) process.stderr.write('[doctor] bwrap is unavailable: the bash tool is disabled\n')
    return this.sandbox
  }

  private askPermission(command: string): Promise<boolean> {
    const nonce = String(++this.confirmSeq)
    const shown = command.length > 3_000 ? `${command.slice(0, 3_000)}…` : command
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce)
        resolve(false)
      }, CONFIRM_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(nonce, (allow) => {
        clearTimeout(timer)
        resolve(allow)
      })
      void this.sendCard(nonce, shown).catch((error: unknown) => {
        clearTimeout(timer)
        this.pending.delete(nonce)
        process.stderr.write(`[doctor] confirmation card: ${this.clean(errorText(error))}\n`)
        resolve(false)
      })
    })
  }

  private async sendCard(nonce: string, command: string): Promise<void> {
    await this.telegram('sendMessage', {
      chat_id: this.owner,
      text: this.clean(`Доктор: команда не входит в список только для чтения.\n\n${command}`),
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Разрешить', callback_data: `doctor:allow:${nonce}` },
            { text: 'Отмена', callback_data: `doctor:deny:${nonce}` },
          ],
        ],
      },
    })
  }

  /**
   * Asynchronous on purpose: the active-state monitor keeps running while a
   * command does, and `exit()` kills the command's whole process group.
   */
  private execBash(
    command: string,
    sandbox: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ text: string; status: number | null }> {
    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let failure: Error | undefined
      const child = spawn('bwrap', [...sandbox, 'bash', '-c', command], {
        cwd: this.config.home,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.running.add(child)
      const timer = setTimeout(() => {
        timedOut = true
        killGroup(child)
      }, COMMAND_TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (stdout.length < COMMAND_CAPTURE_LIMIT) stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < COMMAND_CAPTURE_LIMIT) stderr += chunk
      })
      child.on('error', (error) => {
        failure = error
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        this.running.delete(child)
        const parts = [
          `exit ${code === null ? 'none' : String(code)}${timedOut ? ' (таймаут)' : ''}`,
          '--- stdout ---',
          stdout,
          '--- stderr ---',
          stderr,
        ]
        if (failure !== undefined) parts.push(errorText(failure))
        resolve({ text: parts.join('\n'), status: code })
      })
    })
  }

  private async telegram<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const timeoutSeconds = Number(params.timeout ?? 0)
    const url = `${this.config.apiRoot.replace(/\/+$/, '')}/bot${this.config.token}/${method}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(Math.max(10_000, (timeoutSeconds + 10) * 1_000)),
    })
    const raw = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new Error(`Telegram ${method}: не JSON, HTTP ${response.status}`)
    }
    const object = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    if (!response.ok || object.ok !== true) {
      const description = typeof object.description === 'string' ? object.description : `HTTP ${response.status}`
      throw new Error(`Telegram ${method}: ${bounded(description, 200)}`)
    }
    return object.result as T
  }

  private async sendText(chatId: number, text: string): Promise<void> {
    const cleaned = this.clean(text)
    const chunks = cleaned === '' ? [''] : []
    for (let at = 0; at < cleaned.length; at += TELEGRAM_CHUNK) {
      chunks.push(cleaned.slice(at, at + TELEGRAM_CHUNK))
    }
    for (const chunk of chunks) {
      await this.telegram('sendMessage', { chat_id: chatId, text: chunk })
    }
  }
}

function main(): void {
  const env = process.env
  const userHome = envValue(env, 'HOME') ?? homedir()
  const home = envValue(env, 'DSHBOT_HOME') ?? join(userHome, '.local', 'share', 'dshbot')
  const token = envValue(env, 'TELEGRAM_BOT_TOKEN')
  if (token === undefined) {
    process.stderr.write('[doctor] TELEGRAM_BOT_TOKEN is required\n')
    process.exit(1)
  }
  // The EnvironmentFile of both units (deploy/dshbot*.service).
  const envFileNames = readEnvFileNames(join(userHome, '.config', 'dshbot', 'dshbot.env'))
  const clean = createScrubber(env, envFileNames)
  const config: DoctorConfig = {
    home: isAbsolute(home) ? home : resolve(home),
    token,
    apiRoot: envValue(env, 'TELEGRAM_API_ROOT') ?? 'https://api.telegram.org',
    modelBaseUrl: envValue(env, 'DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com/anthropic',
    apiKey: envValue(env, 'DEEPSEEK_API_KEY') ?? '',
    graceMs: positiveMilliseconds(envValue(env, 'DSHBOT_DOCTOR_GRACE_MS')) ?? DEFAULT_GRACE_MS,
    envFileNames,
  }
  const doctor = new Doctor(config, clean, env)
  void doctor.start().catch((error: unknown) => {
    process.stderr.write(`[doctor] fatal: ${clean(errorText(error))}\n`)
    process.exit(1)
  })
}

/** Tests import the guards; only `node doctor.ts` starts the doctor. */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) main()
