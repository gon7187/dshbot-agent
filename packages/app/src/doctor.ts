// Self-diagnostics of the daemon: `/doctor` of the owner and the lazy `doctor`
// tool answer with one line per check. The report is for the owner, so it never
// prints a value of an environment variable, a token, a key or a value of
// `env`/`headers` of `mcp.json`: only names, states and hints.
//
// Every check is isolated: a failing service, a closed port or a broken file
// becomes one line of the report and never stops the others. The whole report
// has a wall-clock budget (30 s by contract, less here so the Telegram delivery
// still fits), and every network probe is bounded by the remaining budget.

import { createHash } from 'node:crypto'
import { constants as fsConstants, readdirSync, statfsSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { delimiter, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type { RunnerTool } from '../../runner/src/index.js'
import type { TelegramApi } from '../../telegram/src/index.js'
import {
  readMcpConfig,
  type McpConfigProblem,
  type McpServer,
  type McpServerState,
} from '../../tools-mcp/src/index.js'
import { probeProgramVersion, SANDBOX_PROGRAM } from '../../tools-exec/src/index.js'
import { MODEL_DIRECTORY, MODEL_FILES } from '../../voice/src/model.js'
import { formatBytes, formatSnapshotTime, lastSnapshot } from './backup.js'

/** Name of the lazy tool the owner model loads through `tool_search`. */
export const DOCTOR_TOOL_NAME = 'doctor'

/** One check of the report has exactly one of these states. */
export type DoctorStatus = 'ok' | 'warn' | 'error'

/** One line of the report: a stable id (for tests and logs), the state, the text. */
export interface DoctorCheck {
  readonly id: string
  readonly status: DoctorStatus
  readonly text: string
}

/** Default budget of the whole report; the contract is 30 s including delivery. */
export const DOCTOR_BUDGET_MS = 24_000

/** Cap on one probe of a remote service; a silent service never eats the budget. */
export const DOCTOR_PROBE_TIMEOUT_MS = 8_000

/** Cap on an error string copied into a line: the report stays readable. */
const DETAIL_LIMIT = 220

/** Free space below this is a warning, below the second number an error. */
const SPACE_WARN_BYTES = 1 * 1024 * 1024 * 1024
const SPACE_ERROR_BYTES = 100 * 1024 * 1024

/** Age after which the last successful turn is a warning and then an error. */
const TURN_WARN_MS = 24 * 60 * 60_000
const TURN_ERROR_MS = 7 * 24 * 60 * 60_000

/** The model probe is a Messages request with one token; the answer is not read. */
const PROBE_MODEL = 'deepseek-v4-flash'
const PROBE_MAX_TOKENS = 1

/** Everything the checks need, injected by the daemon (and replaceable in tests). */
export interface DoctorDeps {
  /** `DSHBOT_HOME`: state.db, mcp.json and the speech models live here. */
  readonly home: string
  /** Environment of the process; only the presence of a variable is reported. */
  readonly env?: NodeJS.ProcessEnv
  /** Telegram Bot API client (the daemon's own). */
  readonly telegram: Pick<TelegramApi, 'call'>
  /** Messages API root and key of the owner's route. */
  readonly deepseek: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly model?: string
    readonly fetch?: typeof globalThis.fetch
  }
  /** MCP client of the daemon: its live states, not a second connection. */
  readonly mcp: {
    status(): readonly McpServerState[]
    problems(): readonly McpConfigProblem[]
  }
  /** Store handle: `PRAGMA quick_check` runs on the daemon's own connection. */
  readonly db: DatabaseSync
  /** Configured Chromium (`DSHBOT_BROWSER_PATH`). */
  readonly browserPath?: string
  /** CDP endpoint of the owner's browser (`DSHBOT_BROWSER_CDP_URL`). */
  readonly browserCdpUrl?: string
  /** Unix time of the last successful turn, or undefined when there was none. */
  readonly lastTurnAt?: () => number | undefined
  /** Values that must never be printed (the daemon's known secrets). */
  readonly secretValues?: readonly string[]
  /** Clock seam. */
  readonly now?: () => number
  /** IANA zone of the owner for the times in the report; the process zone when absent. */
  readonly timeZone?: string
  /** Budget of the whole report, milliseconds. */
  readonly budgetMs?: number
  /** Cap on one remote probe, milliseconds. */
  readonly probeTimeoutMs?: number
}

/** One check as it is rendered; the status words are the public contract. */
const STATUS_ICON: Readonly<Record<DoctorStatus, string>> = { ok: '✅', warn: '⚠', error: '❌' }
const STATUS_WORD: Readonly<Record<DoctorStatus, string>> = {
  ok: 'ок',
  warn: 'предупреждение',
  error: 'ошибка',
}

function render(subject: string, status: DoctorStatus, detail: string): string {
  return `${subject}: ${STATUS_ICON[status]} ${STATUS_WORD[status]} — ${detail}`
}

function check(id: string, subject: string, status: DoctorStatus, detail: string): DoctorCheck {
  return { id, status, text: render(subject, status, detail) }
}

/**
 * Collapses a detail to one bounded line. Control characters, tabs and line
 * breaks of a foreign error would otherwise turn one check into several
 * "lines" and could forge a status of another check.
 */
function oneLine(text: string, limit = DETAIL_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Removes every known secret from a text. The daemon passes the values it
 * knows itself (bot token, API key); the values of `env` and `headers` of
 * `mcp.json` are added from the file, and two patterns cover a key the daemon
 * did not receive. The result is used for every line of the report.
 */
function createScrubber(values: readonly string[]): (text: string) => string {
  const secrets = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) continue
    secrets.add(value)
    try {
      secrets.add(encodeURIComponent(value))
    } catch {
      // A value that cannot be encoded is still scrubbed verbatim.
    }
    const colon = value.indexOf(':')
    if (colon >= 0 && colon + 1 < value.length) secrets.add(value.slice(colon + 1))
  }
  const ordered = [...secrets].sort((left, right) => right.length - left.length)
  return (text: string): string => {
    let result = text
    for (const secret of ordered) result = result.split(secret).join('[скрыто]')
    result = result.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[скрыто]')
    result = result.replace(/\b\d{6,}:AA[A-Za-z0-9_-]{10,}\b/g, '[скрыто]')
    return result
  }
}

/** Every value of `env` and `headers` of the parsed `mcp.json`, for the scrubber. */
export function mcpSecretValues(servers: readonly McpServer[]): string[] {
  const values: string[] = []
  for (const server of servers) {
    const map = server.transport === 'stdio' ? server.env : server.headers
    for (const value of Object.values(map)) {
      if (typeof value === 'string' && value.length > 0) values.push(value)
    }
  }
  return values
}

function remaining(deadline: number, cap: number): number {
  return Math.max(1, Math.min(cap, deadline - Date.now()))
}

/** Rejects with a timeout error when `promise` does not settle in `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет ответа за ${Math.round(ms / 1000)} с`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Turns an executable on `PATH`, or undefined. */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? ''
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of path.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      try {
        const info = statSync(candidate)
        if (info.isFile() && (process.platform === 'win32' || (info.mode & fsConstants.X_OK) !== 0)) {
          return candidate
        }
      } catch {
        // Try the next directory.
      }
    }
  }
  return undefined
}

/** A runnable external command and its state. */
async function probeExecutable(
  name: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ path: string; status: DoctorStatus; detail: string } | undefined> {
  const path = findOnPath(name, env)
  if (path === undefined) return undefined
  try {
    const result = await probeProgramVersion(path, args, timeoutMs)
    if (result.error !== undefined) {
      return { path, status: 'error', detail: `${path} не запускается: ${describeError(result.error)}` }
    }
    if (result.status !== 0) {
      return { path, status: 'error', detail: `${path} ответил кодом ${result.status ?? 'нет'}` }
    }
    return { path, status: 'ok', detail: path }
  } catch (error) {
    return { path, status: 'error', detail: `${path} не запускается: ${describeError(error)}` }
  }
}

interface FoundFile {
  path: string
  size: number
}

/** Recursive files by base name; symlinks are ignored like the voice loader does. */
function findFiles(directory: string, depth = 0, found: FoundFile[] = []): FoundFile[] {
  if (depth > 4) return found
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      findFiles(path, depth + 1, found)
      continue
    }
    if (!entry.isFile()) continue
    try {
      found.push({ path, size: statSync(path).size })
    } catch {
      // A file that vanished between readdir and stat is simply absent.
    }
  }
  return found
}

function bytesText(bytes: number): string {
  const gib = bytes / 1024 / 1024 / 1024
  if (gib >= 1) return `${gib.toFixed(1)} ГБ`
  return `${Math.max(0, bytes / 1024 / 1024).toFixed(0)} МБ`
}

function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} с назад`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} мин назад`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ч назад`
  return `${Math.round(hours / 24)} дн назад`
}

function transportLabel(transport: McpServer['transport']): string {
  if (transport === 'stdio') return 'stdio'
  if (transport === 'sse') return 'sse'
  return 'http'
}

/** A TCP connection to a loopback CDP endpoint: the browser or nothing. */
/**
 * A CDP address fit for the report: scheme, host, port and path only. Userinfo,
 * query and fragment may carry a password or a token and are never printed.
 */
function redactUrl(url: string): string {
  try {
    const target = new URL(url)
    return `${target.protocol}//${target.host}${target.pathname === '/' ? '' : target.pathname}`
  } catch {
    return '(адрес не разобран)'
  }
}

function cdpReachable(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      resolve(false)
      return
    }
    const host = target.hostname.replace(/^\[|\]$/g, '')
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      resolve(false)
      return
    }
    const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
    const socket = connect({ host, port })
    const done = (reachable: boolean): void => {
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Runs every check and returns the lines in a stable order. Never throws: an
 * unexpected failure of one check becomes that check's error line.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const now = deps.now ?? Date.now
  const env = deps.env ?? process.env
  const deadline = now() + (deps.budgetMs ?? DOCTOR_BUDGET_MS)
  const probeCap = deps.probeTimeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS
  let fresh: ReturnType<typeof readMcpConfig>
  try {
    fresh = readMcpConfig(deps.home)
  } catch {
    // The MCP check reports the file itself; the other checks must still run.
    fresh = { servers: [], problems: [] }
  }
  const scrub = createScrubber([
    deps.deepseek.apiKey,
    ...(env.TELEGRAM_BOT_TOKEN === undefined ? [] : [env.TELEGRAM_BOT_TOKEN]),
    ...(deps.secretValues ?? []),
    ...mcpSecretValues(fresh.servers),
  ])
  /** Scrub first, collapse second: a truncated line can never carry half a secret. */
  const clean = (text: string, limit = DETAIL_LIMIT): string => oneLine(scrub(text), limit)
  const checks: DoctorCheck[] = []

  /** `body` runs in isolation: its throw becomes an error line of `id`. */
  const guarded = async (id: string, subject: string, body: () => Promise<DoctorCheck>): Promise<void> => {
    try {
      checks.push(await body())
    } catch (error) {
      checks.push(check(id, subject, 'error', `${clean(describeError(error))}; подробности в журнале бота`))
    }
  }

  // --- environment: names only, never values ---------------------------------
  for (const name of ['TELEGRAM_BOT_TOKEN', 'DEEPSEEK_API_KEY', 'DSHBOT_HOME'] as const) {
    await guarded(`env.${name}`, `Переменная ${name}`, async () => {
      const value = env[name]
      if (typeof value === 'string' && value.trim() !== '') return check(`env.${name}`, `Переменная ${name}`, 'ok', 'задана')
      const hint =
        name === 'DSHBOT_HOME'
          ? 'задайте DSHBOT_HOME в окружении службы и перезапустите демон'
          : `задайте ${name} в окружении службы и перезапустите демон`
      return check(`env.${name}`, `Переменная ${name}`, 'error', `не задана; ${hint}`)
    })
  }

  // --- Telegram: the bot itself answers getMe ---------------------------------
  await guarded('telegram', 'Telegram getMe', async () => {
    const started = Date.now()
    try {
      const me = await withTimeout(
        deps.telegram.call<{ username?: unknown; id?: unknown }>('getMe'),
        remaining(deadline, probeCap),
      )
      const username = typeof me?.username === 'string' && me.username !== '' ? `@${me.username}` : ''
      const id = typeof me?.id === 'number' ? `id ${me.id}` : ''
      const who = [username, id].filter((part) => part !== '').join(', ')
      return check('telegram', 'Telegram getMe', 'ok', `${who === '' ? 'ответ получен' : who}, ${Date.now() - started} мс`)
    } catch (error) {
      return check(
        'telegram',
        'Telegram getMe',
        'error',
        `${clean(describeError(error))}; проверьте токен бота, сеть и TELEGRAM_API_ROOT`,
      )
    }
  })

  // --- DeepSeek: one tiny Messages request ------------------------------------
  await guarded('deepseek', 'DeepSeek API', async () => {
    const base = deps.deepseek.baseUrl.replace(/\/+$/, '')
    const url = `${base}/messages`
    const started = Date.now()
    const fetchFn = deps.deepseek.fetch ?? globalThis.fetch
    const timeoutMs = remaining(deadline, probeCap)
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': deps.deepseek.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: deps.deepseek.model ?? PROBE_MODEL,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        let detail = ''
        try {
          detail = await response.text()
        } catch {
          // The status alone is enough for the line.
        }
        return check(
          'deepseek',
          'DeepSeek API',
          'error',
          `API ответил ${response.status}${detail === '' ? '' : `: ${clean(detail, 120)}`}; ` +
            'проверьте ключ DeepSeek, DEEPSEEK_BASE_URL и сеть',
        )
      }
      await response.body?.cancel().catch(() => undefined)
      return check('deepseek', 'DeepSeek API', 'ok', `ответ получен за ${Date.now() - started} мс`)
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      return check(
        'deepseek',
        'DeepSeek API',
        'error',
        aborted
          ? `API не ответил за ${Math.round(timeoutMs / 1000)} с; проверьте ключ DeepSeek, DEEPSEEK_BASE_URL и сеть`
          : `${clean(describeError(error))}; проверьте ключ DeepSeek, DEEPSEEK_BASE_URL и сеть`,
      )
    }
  })

  // --- MCP: the live state plus the current file ------------------------------
  try {
    const liveStates = deps.mcp.status()
    const states = new Map(liveStates.map((state) => [state.name, state]))
    const problemNames = new Set(fresh.problems.map((problem) => problem.name))
    const lines: DoctorCheck[] = []
    for (const server of fresh.servers) {
      const state = states.get(server.name)
      const subject = `MCP ${server.name} (${transportLabel(server.transport)})`
      if (state === undefined) {
        lines.push(
          check(
            `mcp.${server.name}`,
            subject,
            'warn',
            'есть в mcp.json, но этот процесс его ещё не подключил; выполните /mcp reload',
          ),
        )
        continue
      }
      if (state.state === 'ready') {
        lines.push(check(`mcp.${server.name}`, subject, 'ok', `подключён, инструментов ${state.tools}`))
      } else if (state.state === 'starting') {
        lines.push(
          check(`mcp.${server.name}`, subject, 'warn', 'запускается; если это длится долго, выполните /mcp reload'),
        )
      } else if (state.state === 'stopped') {
        lines.push(
          check(`mcp.${server.name}`, subject, 'warn', 'остановлен; выполните /mcp reload или перезапустите демон'),
        )
      } else if (state.state === 'disabled') {
        lines.push(check(`mcp.${server.name}`, subject, 'ok', 'выключен в mcp.json (enabled: false), не запускается'))
      } else {
        lines.push(
          check(
            `mcp.${server.name}`,
            subject,
            'error',
            `${state.error === undefined ? 'не удалось подключиться' : clean(state.error)}; ` +
              'проверьте command, args и env в mcp.json',
          ),
        )
      }
    }
    for (const problem of fresh.problems) {
      lines.push(
        check(
          `mcp.problem.${problem.name}`,
          `MCP ${problem.name} (запись mcp.json)`,
          'error',
          `${clean(problem.message)}; исправьте mcp.json и выполните /mcp reload`,
        ),
      )
    }
    const configured = new Set<string>([...fresh.servers.map((server) => server.name), ...problemNames])
    for (const state of liveStates) {
      if (configured.has(state.name)) continue
      lines.push(
        check(
          `mcp.stale.${state.name}`,
          `MCP ${state.name} (${transportLabel(state.transport)})`,
          'warn',
          'больше нет в mcp.json; выполните /mcp reload',
        ),
      )
    }
    if (lines.length === 0) lines.push(check('mcp.none', 'MCP-серверы', 'ok', 'серверы не настроены'))
    checks.push(...lines)
  } catch (error) {
    checks.push(
      check('mcp', 'MCP-серверы', 'error', `${clean(describeError(error))}; проверьте mcp.json`),
    )
  }

  // --- free space of the state directory -------------------------------------
  await guarded('space', 'Свободное место в DSHBOT_HOME', async () => {
    try {
      const stats = statfsSync(deps.home)
      const free = Number(stats.bavail) * Number(stats.bsize)
      const status: DoctorStatus = free < SPACE_ERROR_BYTES ? 'error' : free < SPACE_WARN_BYTES ? 'warn' : 'ok'
      const hint =
        status === 'ok'
          ? 'запас достаточный'
          : 'освободите место в DSHBOT_HOME: база, модели и рабочая папка растут'
      return check('space', 'Свободное место в DSHBOT_HOME', status, `${bytesText(free)} свободно; ${hint}`)
    } catch (error) {
      return check(
        'space',
        'Свободное место в DSHBOT_HOME',
        'error',
        `не удалось измерить: ${clean(describeError(error))}; ` +
          'проверьте, что каталог DSHBOT_HOME существует и доступен демону на чтение и запись',
      )
    }
  })

  // --- integrity of the durable state ----------------------------------------
  await guarded('state.db', 'state.db', async () => {
    try {
      const row = deps.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      const value = row === undefined ? '' : String(Object.values(row)[0] ?? '')
      if (value.toLowerCase() === 'ok') return check('state.db', 'state.db', 'ok', 'PRAGMA quick_check: ok')
      return check(
        'state.db',
        'state.db',
        'error',
        `PRAGMA quick_check: ${clean(value)}; ` +
          'остановите демон и восстановите state.db из резервной копии',
      )
    } catch (error) {
      return check(
        'state.db',
        'state.db',
        'error',
        `PRAGMA quick_check не выполнен: ${clean(describeError(error))}; проверьте права и диск`,
      )
    }
  })

  // --- last snapshot of the bot's own state -----------------------------------
  await guarded('backup', 'Бэкап', async () => {
    const snapshot = lastSnapshot(deps.home)
    if (snapshot === undefined) {
      return check(
        'backup',
        'Бэкап',
        'warn',
        'снимков нет; демон сделает первый по расписанию, или выполните /backup',
      )
    }
    const age = Date.now() - snapshot.createdAt
    const stale = age > 48 * 60 * 60_000
    return check(
      'backup',
      'Бэкап',
      stale ? 'warn' : 'ok',
      `последний снимок ${formatSnapshotTime(snapshot.createdAt, deps.timeZone)} (${formatBytes(snapshot.sizeBytes)}), ` +
        `${ageText(age)}; ` +
        (stale ? 'проверьте расписание, или выполните /backup' : 'свежий снимок на месте'),
    )
  })

  // --- speech models ----------------------------------------------------------
  await guarded('voice', 'Модели голоса', async () => {
    const found = findFiles(join(deps.home, MODEL_DIRECTORY))
    let matched = 0
    const missing: string[] = []
    for (const pin of MODEL_FILES) {
      const hit = found.find(
        (file) => (file.path.endsWith(`/${pin.name}`) || file.path.endsWith(`\\${pin.name}`)) && file.size === pin.size,
      )
      if (hit === undefined) missing.push(pin.name)
      else matched += 1
    }
    if (matched === MODEL_FILES.length) {
      return check('voice', 'Модели голоса', 'ok', `${matched} из ${MODEL_FILES.length} файлов на месте`)
    }
    if (matched === 0) {
      return check(
        'voice',
        'Модели голоса',
        'warn',
        'не найдены; скачаются при первом голосовом сообщении, нужна сеть до huggingface.co или hf-mirror.com',
      )
    }
    return check(
      'voice',
      'Модели голоса',
      'warn',
      `${matched} из ${MODEL_FILES.length} файлов на месте (нет: ${missing.join(', ')}); ` +
        'недостающие скачаются при первом голосовом сообщении',
    )
  })

  // --- browser ----------------------------------------------------------------
  await guarded('browser', 'Браузер', async () => {
    if (deps.browserCdpUrl !== undefined && deps.browserCdpUrl.trim() !== '') {
      const raw = deps.browserCdpUrl.trim()
      const reachable = await cdpReachable(raw, Math.min(1_500, remaining(deadline, probeCap)))
      const url = clean(redactUrl(raw), 120)
      return reachable
        ? check('browser', 'Браузер', 'ok', `CDP ${url} отвечает`)
        : check(
            'browser',
            'Браузер',
            'warn',
            `CDP ${url} не отвечает; запустите браузер с --remote-debugging-port или уберите DSHBOT_BROWSER_CDP_URL`,
          )
    }
    const configured = deps.browserPath !== undefined && deps.browserPath.trim() !== ''
    const candidates = configured
      ? [deps.browserPath as string]
      : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome']
    for (const candidate of candidates) {
      const path = candidate.includes('/') ? candidate : findOnPath(candidate, env)
      if (path === undefined) continue
      try {
        if (statSync(path).isFile()) return check('browser', 'Браузер', 'ok', `Chromium найден: ${clean(path)}`)
      } catch {
        // The next candidate.
      }
    }
    return check(
      'browser',
      'Браузер',
      'warn',
      configured
        ? `DSHBOT_BROWSER_PATH не указывает на файл: ${clean(deps.browserPath as string)}`
        : 'Chromium не найден; задайте DSHBOT_BROWSER_PATH или установите chromium',
    )
  })

  // --- media and sandbox tools ------------------------------------------------
  for (const [id, subject, binary, args] of [
    ['ffmpeg', 'ffmpeg', 'ffmpeg', ['-version']],
    [SANDBOX_PROGRAM, SANDBOX_PROGRAM, SANDBOX_PROGRAM, ['--version']],
  ] as const) {
    await guarded(id, subject, async () => {
      const probe = await probeExecutable(binary, args, env, Math.min(2_500, remaining(deadline, probeCap)))
      if (probe === undefined) {
        return check(
          id,
          subject,
          'warn',
          `${binary} не найден в PATH; голосовые и аудио-инструменты без него не работают`,
        )
      }
      if (probe.status === 'ok') return check(id, subject, 'ok', clean(probe.detail))
      return check(
        id,
        subject,
        probe.status,
        `${clean(probe.detail)}; переустановите ${binary} или укажите в PATH рабочий бинарник`,
      )
    })
  }

  // --- age of the last successful turn ---------------------------------------
  await guarded('age', 'Последний успешный ход', async () => {
    let at: number | undefined
    try {
      at = deps.lastTurnAt?.()
    } catch (error) {
      return check(
        'age',
        'Последний успешный ход',
        'warn',
        `не удалось прочитать отметку: ${clean(describeError(error))}`,
      )
    }
    if (at === undefined || !Number.isFinite(at) || at <= 0) {
      return check(
        'age',
        'Последний успешный ход',
        'warn',
        'ещё не было; отправьте боту сообщение, чтобы проверить модель и Telegram',
      )
    }
    const age = Math.max(0, now() - at)
    const status: DoctorStatus = age > TURN_ERROR_MS ? 'error' : age > TURN_WARN_MS ? 'warn' : 'ok'
    return check(
      'age',
      'Последний успешный ход',
      status,
      `${ageText(age)}; ${status === 'ok' ? 'ходы идут' : 'проверьте модель, сеть и журнал бота'}`,
    )
  })

  return checks
}

/** The whole report as the owner sees it: a title and one line per check. */
export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return ['Самодиагностика бота', ...checks.map((item) => item.text)].join('\n')
}

/** The rows that need a repair: every `warn` and `error` of the report, text as the owner sees it. */
export function doctorProblemLines(checks: readonly DoctorCheck[]): string[] {
  return checks.filter((item) => item.status !== 'ok').map((item) => item.text)
}

/** Label of the button under a report that has problem rows. */
export const DOCTOR_REPAIR_BUTTON_TEXT = 'Починить'

const DOCTOR_REPAIR_PREFIX = 'doctor:fix:'

/** Stable id of one set of problem rows: the same problems press the same button. */
export function doctorRepairId(problems: readonly string[]): string {
  return createHash('sha256').update(problems.join('\n')).digest('hex').slice(0, 16)
}

export function encodeDoctorRepairCallback(id: string): string {
  return `${DOCTOR_REPAIR_PREFIX}${id}`
}

export function decodeDoctorRepairCallback(data: string): string | undefined {
  if (!data.startsWith(DOCTOR_REPAIR_PREFIX)) return undefined
  const id = data.slice(DOCTOR_REPAIR_PREFIX.length)
  return /^[0-9a-f]{16}$/.test(id) ? id : undefined
}

/**
 * The goal of a repair task: only the problem rows, already masked by the
 * report, so a secret that a probe echoed never reaches the task session.
 */
export function doctorRepairGoal(problems: readonly string[]): string {
  return [
    'Устранить проблемы, которые нашла самодиагностика бота (/doctor). Ниже только строки со статусом ' +
      'предупреждение или ошибка; значения секретов в них скрыты, не восстанавливай и не печатай их.',
    ...problems,
  ].join('\n')
}

/** Runs the checks and renders the report. */
export async function doctorReport(deps: DoctorDeps): Promise<string> {
  return formatDoctorReport(await runDoctor(deps))
}

const DOCTOR_DESCRIPTION =
  'Самодиагностика бота: переменные окружения (только имена), Telegram getMe, DeepSeek API, каждый MCP-сервер ' +
  'из mcp.json, свободное место в DSHBOT_HOME, PRAGMA quick_check state.db, модели голоса, браузер, ffmpeg, ' +
  'bwrap и возраст последнего успешного хода. Одна строка на проверку со статусом ок, предупреждение ' +
  'или ошибка и подсказкой; секреты не печатаются.'

/** The lazy `doctor` tool of the owner: the same report as `/doctor`, no arguments. */
export function createDoctorTool(run: () => Promise<string>): RunnerTool {
  return {
    name: DOCTOR_TOOL_NAME,
    description: DOCTOR_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute(): Promise<string> {
      return run()
    },
  }
}
