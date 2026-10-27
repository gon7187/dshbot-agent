// Reading a Hermes installation. Like the OpenClaw adapter this module never
// writes to the source: `.env`, `auth.json`, `config.yaml`, credentials, skills,
// memory and cron jobs are read into the candidates of the shared planner.
//
// Hermes has one directory per profile: `~/.hermes` (or `$HERMES_HOME`, or
// `--from`) is the main profile and `<root>/profiles/<name>` is a named one.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { parseYamlDocument, validateImportedSkillName, type YamlValue } from '../../learn/src/skills.js'
import {
  Collector,
  asRecord,
  asString,
  isDirectory,
  isFile,
  readDotEnv,
  secretTarget,
  warningItem,
} from './openclaw.js'
import { DAEMON_ENV_KEYS, SECRET_FIELD_RE, SECRET_NAME_RE, derivedName, providerKeyName } from './naming.js'
import type { Collected, ManualCandidate, MemoryCandidate, PlanItem, ScheduleCandidate, SkillCandidate } from './types.js'

export interface HermesSource {
  readonly dir: string
  readonly profile?: string
}

export type HermesDiscovery =
  | { readonly ok: true; readonly source: HermesSource }
  | { readonly ok: false; readonly message: string }

/** Root of the installation: `--from`, then `$HERMES_HOME`, then `~/.hermes`. */
export function hermesRoot(from: string | undefined, env: NodeJS.ProcessEnv): string {
  if (from !== undefined && from.trim() !== '') return resolve(from)
  const configured = env.HERMES_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.hermes')
}

export function discoverHermes(from: string | undefined, profile: string | undefined, env: NodeJS.ProcessEnv): HermesDiscovery {
  const root = hermesRoot(from, env)
  const name = profile === undefined ? '' : profile.trim()
  const dir = name === '' ? root : join(root, 'profiles', name)
  if (!isDirectory(dir)) {
    return {
      ok: false,
      message:
        `каталог Hermes не найден: ${dir}\n` +
        'Укажите каталог явно: --from <каталог> или --profile <имя> для каталога profiles/<имя>',
    }
  }
  return { ok: true, source: { dir, ...(name === '' ? {} : { profile: name }) } }
}

const SECRET_ENV_NAME = /key|token|secret|password/i
const BASE_URL_SUFFIX = '_BASE_URL'

function isSecretEnvName(name: string, names: ReadonlySet<string>): boolean {
  if (SECRET_ENV_NAME.test(name)) return true
  if (!name.toUpperCase().endsWith(BASE_URL_SUFFIX)) return false
  const base = name.slice(0, name.length - BASE_URL_SUFFIX.length)
  return names.has(`${base}_API_KEY`)
}

function telegramId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const match = /^(?:telegram:)?(-?\d+)$/.exec(value.trim())
  return match?.[1]
}

function firstAllowedUser(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  for (const part of value.split(',')) {
    const id = telegramId(part.trim())
    if (id !== undefined) return id
  }
  return undefined
}

function pairedOwner(dir: string): string | undefined {
  const path = join(dir, 'telegram-pairing', 'telegram-approved.json')
  if (!isFile(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const record = asRecord(parsed)
    if (record === undefined) return undefined
    for (const [key, entry] of Object.entries(record)) {
      const value = asRecord(entry)
      const id = telegramId(value?.user_id) ?? telegramId(value?.chat_id) ?? telegramId(value?.id) ?? telegramId(key)
      if (id !== undefined) return id
    }
  } catch {
    // A broken pairing file only loses this fallback.
  }
  return undefined
}

function yamlObject(value: YamlValue | undefined): Record<string, YamlValue> {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function yamlStrings(value: YamlValue | undefined): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value]
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === 'string' && item !== '' ? [item] : []))
}

function yamlBoolean(value: YamlValue | undefined): boolean | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (text === 'true') return true
  if (text === 'false') return false
  return undefined
}

function yamlPlain(value: YamlValue): unknown {
  if (Array.isArray(value)) return value.map(yamlPlain)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = yamlPlain(item)
    return out
  }
  return value
}

/** Split a `§`-delimited memory file into its entries. */
export function memoryEntries(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n§\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function collectMemory(dir: string): MemoryCandidate[] {
  const result: MemoryCandidate[] = []
  for (const name of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, 'memories', name)
    if (!isFile(path)) continue
    try {
      result.push({ name, source: `memories/${name}`, entries: memoryEntries(readFileSync(path, 'utf8')) })
    } catch {
      // An unreadable memory file is simply not imported.
    }
  }
  return result
}

interface RawSkill {
  readonly base: string
  readonly category?: string
  readonly dir: string
  readonly source: string
}

function rawSkills(dir: string): RawSkill[] {
  const root = join(dir, 'skills')
  if (!isDirectory(root)) return []
  const result: RawSkill[] = []
  let entries: string[]
  try {
    entries = readdirSync(root).sort()
  } catch {
    return []
  }
  for (const name of entries) {
    const path = join(root, name)
    if (!isDirectory(path) || name.startsWith('.')) continue
    if (isFile(join(path, 'SKILL.md'))) {
      result.push({ base: name, dir: path, source: `skills/${name}` })
      continue
    }
    let children: string[]
    try {
      children = readdirSync(path).sort()
    } catch {
      continue
    }
    for (const child of children) {
      const childDir = join(path, child)
      if (!isDirectory(childDir) || child.startsWith('.')) continue
      if (!isFile(join(childDir, 'SKILL.md'))) continue
      result.push({ base: child, category: name, dir: childDir, source: `skills/${name}/${child}` })
    }
  }
  return result
}

function frontmatter(text: string): Record<string, YamlValue> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
  if (match === null) return undefined
  try {
    return parseYamlDocument(match[1] as string)
  } catch {
    return undefined
  }
}

function collectSkills(dir: string, disabled: readonly string[]): { skills: SkillCandidate[]; warnings: PlanItem[] } {
  const warnings: PlanItem[] = []
  const raw = rawSkills(dir)
  const counts = new Map<string, number>()
  for (const skill of raw) counts.set(skill.base, (counts.get(skill.base) ?? 0) + 1)
  const skills: SkillCandidate[] = []
  const used = new Set<string>()
  for (const skill of raw) {
    const collides = (counts.get(skill.base) ?? 0) > 1
    const name = collides && skill.category !== undefined ? `${skill.category}-${skill.base}` : skill.base
    const source = skill.source
    const label = `навык ${source}`
    let text: string
    try {
      text = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')
    } catch {
      warnings.push(warningItem('skill', name, source, `skills/${name}`, `${label} — SKILL.md не читается`, source))
      continue
    }
    const meta = frontmatter(text)
    const skillName = typeof meta?.name === 'string' ? meta.name : name
    const disabledHit = [name, skill.base, skillName].find((candidate) => disabled.includes(candidate))
    if (disabledHit !== undefined) {
      warnings.push(warningItem('skill', name, source, `skills/${name}`, `${label} — отключён в config.yaml (skills.disabled)`, source))
      continue
    }
    const platforms = meta === undefined ? [] : yamlStrings(meta.platforms)
    if (platforms.length > 0 && !platforms.includes('linux')) {
      warnings.push(
        warningItem('skill', name, source, `skills/${name}`, `${label} — platforms без linux: ${platforms.join(', ')}`, source),
      )
      continue
    }
    try {
      validateImportedSkillName(name)
    } catch (error) {
      warnings.push(
        warningItem('skill', name, source, `skills/${name}`, `${label} — недопустимое имя импортируемого навыка: ${messageOf(error)}`, source),
      )
      continue
    }
    if (used.has(name)) {
      warnings.push(warningItem('skill', name, source, `skills/${name}`, `${label} — имя уже занято другим навыком`, source))
      continue
    }
    used.add(name)
    skills.push({ name, dir: skill.dir, source })
  }
  return { skills, warnings }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function collectMcp(collector: Collector, config: Record<string, YamlValue>, sourceName: string): void {
  const servers = asRecord(yamlPlain(yamlObject(config.mcp_servers))) 
  if (servers === undefined) return
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw)
    if (server === undefined) continue
    const output: Record<string, unknown> = {}
    for (const key of ['command', 'args', 'cwd', 'url'] as const) {
      if (server[key] !== undefined) output[key] = server[key]
    }
    const enabled = yamlBoolean(server.enabled as YamlValue | undefined)
    if (enabled !== undefined) output.enabled = enabled
    const tools = asRecord(server.tools)
    for (const key of ['include', 'exclude'] as const) {
      const list = tools?.[key]
      if (Array.isArray(list)) output[key] = list.filter((item): item is string => typeof item === 'string')
    }
    for (const field of ['env', 'headers'] as const) {
      const values = asRecord(server[field])
      if (values === undefined) continue
      const next: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string' && SECRET_FIELD_RE.test(key) && !value.startsWith('${secret:')) {
          const secretName = derivedName(['mcp', 'servers', name, field, key])
          const path = `mcp_servers.${name}.${field}.${key}`
          collector.secret(secretName, value, `${sourceName}:${path}`, path)
          next[key] = `\${secret:${secretName}}`
        } else {
          next[key] = value
        }
      }
      output[field] = next
    }
    collector.server(name, `${sourceName}:mcp_servers.${name}`, output, [])
  }
}

function collectCron(dir: string, now: Date): {
  schedules: ScheduleCandidate[]
  manual: ManualCandidate[]
  warnings: PlanItem[]
} {
  const path = join(dir, 'cron', 'jobs.json')
  const schedules: ScheduleCandidate[] = []
  const manual: ManualCandidate[] = []
  const warnings: PlanItem[] = []
  if (!isFile(path)) return { schedules, manual, warnings }
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    warnings.push(warningItem('schedule', 'cron/jobs.json', 'cron/jobs.json', 'state.db', 'cron/jobs.json не читается'))
    return { schedules, manual, warnings }
  }
  const jobs = asRecord(doc)?.jobs
  if (!Array.isArray(jobs)) return { schedules, manual, warnings }
  for (const raw of jobs) {
    const job = asRecord(raw)
    if (job === undefined) continue
    const id = asString(job.id) ?? asString(job.name) ?? 'job'
    const name = asString(job.name) ?? id
    const prompt = asString(job.prompt) ?? ''
    const source = `cron/jobs.json:${id}`
    if (job.script !== undefined || job.no_agent === true) {
      manual.push({
        name,
        reason:
          job.script !== undefined
            ? 'задача со скриптом (script) не переносится автоматически'
            : 'задача без агента (no_agent) не переносится автоматически',
        ...(prompt.trim() === '' ? {} : { prompt }),
        ...(typeof job.script === 'string' ? { detail: job.script } : {}),
      })
      continue
    }
    const schedule = asRecord(job.schedule)
    if (schedule === undefined || prompt.trim() === '') {
      warnings.push(warningItem('schedule', name, source, 'state.db', 'расписание или текст задания отсутствует', source))
      continue
    }
    let spec: string | undefined
    const kind = asString(schedule.kind)
    if (kind === 'cron') {
      const expr = asString(schedule.expr)
      if (expr !== undefined && expr.trim() !== '') spec = expr.trim()
    } else if (kind === 'interval') {
      const minutes = schedule.minutes
      const value = typeof minutes === 'number' ? minutes : Number(minutes)
      if (Number.isSafeInteger(value) && value > 0) spec = `every ${value}m`
    } else if (kind === 'once') {
      const runAt = asString(schedule.run_at)
      if (runAt !== undefined) {
        const at = new Date(runAt)
        if (!Number.isNaN(at.getTime()) && at.getTime() > now.getTime()) spec = at.toISOString()
        else {
          warnings.push(warningItem('schedule', name, source, 'state.db', `разовый запуск в прошлом: ${runAt}`, source))
          continue
        }
      }
    }
    if (spec === undefined) {
      warnings.push(warningItem('schedule', name, source, 'state.db', 'неизвестный формат расписания Hermes', source))
      continue
    }
    const repeat = asRecord(job.repeat)
    const times = repeat?.times
    const maxRuns = typeof times === 'number' && Number.isSafeInteger(times) && times >= 1 ? times : undefined
    schedules.push({
      id,
      name,
      source,
      task: prompt,
      spec,
      ...(maxRuns === undefined ? {} : { maxRuns }),
      paused: job.enabled === false || asString(job.state) === 'paused',
    })
  }
  return { schedules, manual, warnings }
}

function skippedItem(kind: string, name: string, source: string, target: string, reason: string): PlanItem {
  return { kind, name, source, target, status: 'skipped', reason }
}

/** Service data of Hermes that DSHBOT does not import, listed in the report. */
function unsupportedEntries(dir: string): PlanItem[] {
  const result: PlanItem[] = []
  const add = (name: string, reason: string): void => {
    result.push(skippedItem('unsupported', name, name, '—', reason))
  }
  if (existsSync(join(dir, 'sessions'))) add('sessions', 'сессии Hermes не переносятся: это служебные данные источника')
  if (existsSync(join(dir, 'state.db'))) add('state.db', 'база состояния Hermes не переносится: DSHBOT хранит своё состояние в state.db')
  if (existsSync(join(dir, 'kanban'))) add('kanban', 'канбан Hermes не переносится: это служебные данные источника')
  if (existsSync(join(dir, 'webhook'))) add('webhook', 'вебхуки Hermes не переносятся: DSHBOT их не использует')
  return result
}

/** Read one Hermes profile into candidates. Never throws for missing pieces. */
export function collectHermes(source: HermesSource, now = new Date()): Collected {
  const collector = new Collector()
  const dotenv = readDotEnv(join(source.dir, '.env'))
  collector.dotenv = dotenv
  const names = new Set(dotenv.keys())
  for (const [name, value] of dotenv) {
    const upper = name.toUpperCase()
    if (isSecretEnvName(name, names)) {
      collector.secret(upper, value, `.env:${name}`)
      continue
    }
    if (DAEMON_ENV_KEYS.has(upper)) {
      collector.env(upper, value, `.env:${name}`)
      continue
    }
    collector.warning(
      warningItem('config', name, `.env:${name}`, '—', `настройка Hermes не переносится в DSHBOT: ${name}`, `.env.${name}`),
    )
  }

  for (const item of unsupportedEntries(source.dir)) collector.warning(item)

  collectAuth(collector, source)
  collectTelegram(collector, source, dotenv)
  collectCredentials(collector, source)
  collectConfig(collector, source)

  const skillsRoot = source.dir
  const disabled = disabledSkills(source.dir)
  const skills = collectSkills(skillsRoot, disabled)
  for (const warning of skills.warnings) collector.warning(warning)

  const cron = collectCron(source.dir, now)
  for (const warning of cron.warnings) collector.warning(warning)

  const identity = readFileMaybe(join(source.dir, 'SOUL.md'))?.trim()
  const collected = collector.collected()
  return {
    ...collected,
    ...(identity === undefined || identity === '' ? {} : { identity: { text: `${identity}\n`, source: 'SOUL.md' } }),
    memory: collectMemory(source.dir),
    skills: skills.skills,
    schedules: cron.schedules,
    manual: cron.manual,
  }
}

function readFileMaybe(path: string): string | undefined {
  try {
    return isFile(path) ? readFileSync(path, 'utf8') : undefined
  } catch {
    return undefined
  }
}

function collectAuth(collector: Collector, source: HermesSource): void {
  const path = join(source.dir, 'auth.json')
  if (!isFile(path)) return
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    collector.warning(warningItem('auth', 'auth.json', 'auth.json', 'secrets/', 'auth.json не читается'))
    return
  }
  const pool = asRecord(asRecord(doc)?.credential_pool)
  if (pool === undefined) return
  for (const [provider, raw] of Object.entries(pool)) {
    const records = Array.isArray(raw) ? raw : [raw]
    for (const item of records) {
      const record = asRecord(item)
      if (record === undefined) continue
      const type = asString(record.auth_type) ?? 'api_key'
      const field = `auth.json:credential_pool.${provider}`
      if (type !== 'api_key' || record.access_token !== undefined || record.refresh_token !== undefined) {
        collector.warning(
          warningItem('auth', providerKeyName(provider), field, 'secrets/', `OAuth-запись ${provider} не переносится`, field),
        )
        continue
      }
      const reference = asString(record.source)
      const match = reference === undefined ? null : /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference)
      if (match !== null && match[1] !== undefined) {
        const value = collector.dotenv?.get(match[1])
        if (value !== undefined && value !== '') collector.secret(match[1].toUpperCase(), value, `${field}.source`, field)
        else collector.warning(warningItem('auth', providerKeyName(provider), field, secretTarget(providerKeyName(provider)), `переменная ${match[1]} из source не найдена`, field))
        continue
      }
      const inline = asString(record.key) ?? asString(record.api_key)
      if (inline !== undefined && inline !== '') {
        collector.secret(providerKeyName(provider), inline, field, field)
        continue
      }
      collector.warning(warningItem('auth', providerKeyName(provider), field, secretTarget(providerKeyName(provider)), `запись api_key без значения не переносится`, field))
    }
  }
}

function collectTelegram(collector: Collector, source: HermesSource, dotenv: Map<string, string>): void {
  const token = dotenv.get('TELEGRAM_BOT_TOKEN')
  if (token !== undefined && token !== '') collector.env('TELEGRAM_BOT_TOKEN', token, '.env:TELEGRAM_BOT_TOKEN')
  const home = dotenv.get('TELEGRAM_HOME_CHANNEL')
  const owner =
    firstAllowedUser(dotenv.get('TELEGRAM_ALLOWED_USERS')) ??
    pairedOwner(source.dir) ??
    (home === undefined ? undefined : telegramId(home))
  if (owner !== undefined) {
    collector.owner(
      owner,
      dotenv.get('TELEGRAM_ALLOWED_USERS') !== undefined
        ? '.env:TELEGRAM_ALLOWED_USERS'
        : pairedOwner(source.dir) !== undefined
          ? 'telegram-pairing/telegram-approved.json'
          : '.env:TELEGRAM_HOME_CHANNEL',
    )
  }
}

function collectCredentials(collector: Collector, source: HermesSource): void {
  const dir = join(source.dir, 'credentials')
  if (!isDirectory(dir)) return
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      continue
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue
    // The vault keeps the exact bytes: a credentials file may be binary.
    let value: Buffer
    try {
      value = readFileSync(path)
    } catch {
      continue
    }
    const label = `credentials/${name}`
    collector.secret(derivedName(['credentials', name]), value, label, label)
  }
}

function disabledSkills(dir: string): string[] {
  const path = join(dir, 'config.yaml')
  if (!isFile(path)) return []
  try {
    const config = parseYamlDocument(readFileSync(path, 'utf8'))
    return yamlStrings(yamlObject(config.skills).disabled as YamlValue | undefined)
  } catch {
    return []
  }
}

function collectConfig(collector: Collector, source: HermesSource): void {
  const path = join(source.dir, 'config.yaml')
  if (!isFile(path)) return
  let config: Record<string, YamlValue>
  try {
    config = parseYamlDocument(readFileSync(path, 'utf8'))
  } catch {
    collector.warning(warningItem('config', 'config.yaml', 'config.yaml', '—', 'config.yaml не читается как YAML'))
    return
  }
  collectMcp(collector, config, 'config.yaml')
  for (const key of Object.keys(config)) {
    if (key === 'mcp_servers' || key === 'skills') continue
    collector.warning(
      warningItem('config', key, `config.yaml:${key}`, '—', `раздел Hermes не переносится (DSHBOT работает на DeepSeek): ${key}`),
    )
  }
}

function isPid(name: string): boolean {
  return /^\d+$/.test(name)
}

function processTokens(pid: string, procRoot = '/proc'): string[] | undefined {
  try {
    return readFileSync(join(procRoot, pid, 'cmdline'), 'utf8').split('\0').filter((part) => part !== '')
  } catch {
    return undefined
  }
}

function pathParts(path: string): string[] {
  return path.split(/[\\/]/).filter((part) => part !== '')
}

function baseName(path: string): string {
  return (pathParts(path).pop() ?? path).toLowerCase()
}

/** Directory names of a Hermes installation: `/opt/hermes`, `~/.hermes`, `hermes-agent`. */
const HERMES_DIR_RE = /^\.?hermes(?:-agent)?$/i

/**
 * Is `program` itself the Hermes gateway? `hermes-gateway`, `hermes … gateway`,
 * an executable `gateway` inside a Hermes directory and the module file
 * `hermes_cli/main.py … gateway`. Only the program counts: words that are mere
 * operands of another program (`printf hermes gateway`) never do.
 */
function isHermesGatewayProgram(program: string, args: readonly string[]): boolean {
  const name = baseName(program)
  if (name === 'hermes-gateway') return true
  if (name === 'hermes') return args.includes('gateway')
  const dirs = pathParts(program).slice(0, -1)
  if (name === 'gateway') return dirs.some((part) => HERMES_DIR_RE.test(part))
  if (name === 'main.py' || name === '__main__.py') return dirs.at(-1)?.toLowerCase() === 'hermes_cli' && args.includes('gateway')
  return false
}

/**
 * `python [options] (-m <module> | <script>) …`: the options end at `-c`,
 * `-m`, `-`, `--` or the first positional argument, the script. A `-m` after
 * the script is an argument of that script, not a module of the interpreter.
 */
function isPythonGateway(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--') {
      const script = args[index + 1]
      return script !== undefined && isHermesGatewayProgram(script, args.slice(index + 2))
    }
    if (arg === '-') return false
    if (arg.startsWith('--')) {
      if (arg === '--check-hash-based-pycs') index += 1
      continue
    }
    if (arg.startsWith('-')) {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at]
        // Inline code has no script file; its words are not a command line.
        if (flag === 'c') return false
        if (flag === 'm') {
          const attached = arg.slice(at + 1)
          const module = attached === '' ? args[index + 1] : attached
          const rest = args.slice(attached === '' ? index + 2 : index + 1)
          return (module === 'hermes_cli' || module === 'hermes_cli.main') && rest.includes('gateway')
        }
        // `-W arg` and `-X opt`, also attached as `-Wignore`.
        if (flag === 'W' || flag === 'X') {
          if (at === arg.length - 1) index += 1
          break
        }
      }
      continue
    }
    return isHermesGatewayProgram(arg, args.slice(index + 1))
  }
  return false
}

/** Options of node that take the next argument as their value. */
const NODE_VALUE_OPTIONS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type',
  '--title', '--env-file', '--env-file-if-exists', '--inspect-port', '--debug-port', '--redirect-warnings',
  '--watch-path', '--test-reporter', '--test-reporter-destination', '--diagnostic-dir', '--report-dir',
])

/**
 * `node [options] <script> …`: the script file decides, not the words after it.
 * Inline code (`-e`, `-p`) has no script file; the words after the code are
 * the command line the process presents as its own (`process.argv`), so
 * `node -e <code> hermes gateway` counts and `node /srv/report.js hermes
 * gateway` does not.
 */
function isNodeGateway(args: readonly string[]): boolean {
  const presented = (rest: readonly string[]): boolean => {
    const words = rest[0] === '--' ? rest.slice(1) : rest
    return words[0] !== undefined && isHermesGatewayProgram(words[0], words.slice(1))
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--') {
      const script = args[index + 1]
      return script !== undefined && isHermesGatewayProgram(script, args.slice(index + 2))
    }
    if (arg === '-') return false
    if (arg === '-e' || arg === '--eval' || arg === '-p' || arg === '--print' || arg === '-pe') return presented(args.slice(index + 2))
    if (arg.startsWith('--eval=') || arg.startsWith('--print=')) return presented(args.slice(index + 1))
    if (arg.startsWith('-')) {
      if (NODE_VALUE_OPTIONS.has(arg)) index += 1
      continue
    }
    return isHermesGatewayProgram(arg, args.slice(index + 1))
  }
  return false
}

/** `sh [options] <script> …`; `-c` runs a command string whose programs are processes of their own. */
function isShellGateway(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--') {
      const script = args[index + 1]
      return script !== undefined && isHermesGatewayProgram(script, args.slice(index + 2))
    }
    if (arg === '--rcfile' || arg === '--init-file') {
      index += 1
      continue
    }
    if (arg.startsWith('--')) continue
    if (/^[-+]./.test(arg)) {
      if (arg.slice(1).includes('c')) return false
      if (/[oO]$/.test(arg)) index += 1
      continue
    }
    return isHermesGatewayProgram(arg, args.slice(index + 1))
  }
  return false
}

const PYTHON_RE = /^(?:python|pypy)[0-9.]*$/
const NODE_NAMES = new Set(['node', 'nodejs'])
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh'])

/**
 * Is this command line a Hermes gateway (a second bot on its token gets 409)?
 * The program decides: `hermes-gateway`, `hermes gateway`, `.../hermes/.../gateway`,
 * or an interpreter running such a script or the module `hermes_cli[.main] gateway`.
 */
export function isHermesGatewayCommand(tokens: readonly string[]): boolean {
  let index = 0
  // `env [-i] [-u NAME] [VAR=value]… <program>` runs the same program.
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] as string)) index += 1
  if (tokens[index] !== undefined && baseName(tokens[index] as string) === 'env') {
    index += 1
    while (index < tokens.length) {
      const arg = tokens[index] as string
      if (arg === '-u' || arg === '-C' || arg === '--unset' || arg === '--chdir') index += 2
      else if (arg.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) index += 1
      else break
    }
  }
  const program = tokens[index]
  if (program === undefined) return false
  const args = tokens.slice(index + 1)
  const name = baseName(program)
  if (PYTHON_RE.test(name)) return isPythonGateway(args)
  if (NODE_NAMES.has(name)) return isNodeGateway(args)
  if (SHELL_NAMES.has(name)) return isShellGateway(args)
  return isHermesGatewayProgram(program, args)
}

export function liveHermesGateway(procRoot = '/proc'): boolean {
  if (process.platform !== 'linux') return false
  let pids: string[]
  try {
    pids = readdirSync(procRoot)
  } catch {
    return false
  }
  for (const pid of pids) {
    if (!isPid(pid) || Number(pid) === process.pid) continue
    const tokens = processTokens(pid, procRoot)
    if (tokens !== undefined && isHermesGatewayCommand(tokens)) return true
  }
  return false
}

/** Kept for symmetry with the OpenClaw adapter and for readable report labels. */
export function relativeLabel(root: string, path: string): string {
  return relative(root, path)
}

export { SECRET_NAME_RE }
