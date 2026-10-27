// Reading the OpenClaw state directory. This module never writes there: the
// config is parsed, SQLite databases are read from a temporary copy, and every
// value it finds is handed to the planner as a candidate. Skills, memory,
// persona and schedules are collected by `content.ts`; a new step only adds
// candidates and warnings.

import { accessSync, constants, copyFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { parseJson5 } from './json5.js'
import { DAEMON_ENV_KEYS, SECRET_FIELD_RE, SECRET_NAME_RE, derivedName, providerKeyName } from './naming.js'
import type { Collected, EnvCandidate, PlanItem, SecretCandidate, SecretValue } from './types.js'

/** Configuration file names of the current and the two older OpenClaw names. */
const CONFIG_NAMES = ['openclaw.json', 'clawdbot.json', 'moltbot.json']

/** Telegram allowFrom credential files are ids, not secrets. */
const ALLOW_FROM_FILE = /^telegram-.*allowfrom.*\.json$/i

export interface OpenClawSource {
  readonly dir: string
  readonly configName: string
  readonly configPath: string
}

export type Discovery =
  | { readonly ok: true; readonly source: OpenClawSource }
  | { readonly ok: false; readonly message: string }

/** Checked directories in the documented order, without duplicates. */
export function stateCandidates(env: NodeJS.ProcessEnv): string[] {
  const result: string[] = []
  const fromEnv = env.OPENCLAW_STATE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') result.push(resolve(fromEnv))
  const home = homedir()
  for (const name of ['.openclaw', '.clawdbot', '.moltbot']) result.push(join(home, name))
  return [...new Set(result)]
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function findConfig(dir: string): { name: string; path: string } | undefined {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name)
    if (isFile(path)) return { name, path }
  }
  return undefined
}

/**
 * Locate the state directory. With `--from` only that directory is inspected;
 * otherwise the environment variable comes first, then the three home
 * directories, and the first one that actually holds a known config wins. An
 * existing directory without a config is skipped, not accepted.
 */
export function discover(from: string | undefined, env: NodeJS.ProcessEnv): Discovery {
  const candidates = from === undefined || from.trim() === '' ? stateCandidates(env) : [resolve(from)]
  for (const dir of candidates) {
    if (!isDirectory(dir)) continue
    const config = findConfig(dir)
    if (config !== undefined) return { ok: true, source: { dir, configName: config.name, configPath: config.path } }
  }
  const checked = candidates.map((dir) => `  ${dir}`).join('\n')
  return {
    ok: false,
    message:
      `каталог OpenClaw не найден: ни в одном из проверенных мест нет ${CONFIG_NAMES.join(', ')}:\n${checked}\n` +
      'Укажите каталог явно: --from <каталог>',
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read `.env` lines: `KEY=value`, with an optional `export` and quotes. */
export function readDotEnv(path: string): Map<string, string> {
  const result = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return result
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (match === null || match[1] === undefined) continue
    result.set(match[1], unquote(match[2] ?? ''))
  }
  return result
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * `${NAME}` placeholders OpenClaw substitutes from `.env` and `env.vars`;
 * `$${NAME}` is its escape for a literal `${NAME}`.
 */
const ENV_PLACEHOLDER = /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)\}/g

interface Expanded {
  readonly value: string
  readonly missing: readonly string[]
  /** At least one placeholder was replaced by a variable value. */
  readonly substituted: boolean
}

function expandVariables(value: string, resolve: (name: string) => string | undefined): Expanded {
  const missing: string[] = []
  let substituted = false
  const expanded = value.replace(ENV_PLACEHOLDER, (whole, escape: string, name: string) => {
    if (escape !== '') return whole.slice(1)
    const resolved = resolve(name)
    if (resolved !== undefined) {
      substituted = true
      return resolved
    }
    if (!missing.includes(name)) missing.push(name)
    return whole
  })
  return { value: expanded, missing, substituted }
}

/**
 * The variable environment OpenClaw uses: `.env` first (it never overrides an
 * existing variable, and `env.vars` is applied only to missing ones), then
 * `env.vars` of the config, then the process environment. A config value may
 * itself be a `${NAME}` reference or a SecretRef, so aliases resolve
 * recursively. An empty value counts as missing, as OpenClaw refuses it too.
 */
class VariableResolver {
  private readonly cache = new Map<string, string | undefined>()
  private readonly dotenv: Map<string, string>
  private readonly configEnv: Record<string, unknown> | undefined

  constructor(dotenv: Map<string, string>, config: Record<string, unknown>) {
    this.dotenv = dotenv
    this.configEnv = asRecord(asRecord(config.env)?.vars)
  }

  resolve(name: string, stack: ReadonlySet<string> = new Set()): string | undefined {
    if (this.cache.has(name)) return this.cache.get(name)
    if (stack.has(name)) return undefined
    const value = nonEmpty(this.dotenv.get(name)) ?? this.fromConfig(name, stack) ?? nonEmpty(process.env[name])
    this.cache.set(name, value)
    return value
  }

  private fromConfig(name: string, stack: ReadonlySet<string>): string | undefined {
    const raw = this.configEnv?.[name]
    const next = new Set(stack)
    next.add(name)
    if (typeof raw === 'string') {
      const expanded = expandVariables(raw, (nested) => this.resolve(nested, next))
      return expanded.missing.length === 0 ? nonEmpty(expanded.value) : undefined
    }
    const ref = raw === undefined ? undefined : asSecretRef(raw)
    return ref !== undefined && ref.source === 'env' ? this.resolve(ref.id, next) : undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** Run `read` against a temporary copy so SQLite can never create sidecars in the source. */
function withReadOnlyDatabase<T>(path: string, read: (db: DatabaseSync) => T): T | undefined {
  if (!isFile(path)) return undefined
  let dir: string | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'dshbot-migrate-db-'))
    const copy = join(dir, basename(path))
    copyFileSync(path, copy)
    for (const suffix of ['-wal', '-shm']) {
      if (isFile(path + suffix)) copyFileSync(path + suffix, copy + suffix)
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      return read(db)
    } finally {
      db.close()
    }
  } catch {
    return undefined
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leftover temporary copy holds no secret of the owner's vault.
      }
    }
  }
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  try {
    return db.prepare(sql).all() as Record<string, unknown>[]
  } catch {
    return []
  }
}

interface SecretRef {
  readonly source: 'env' | 'file' | 'exec'
  readonly id: string
}

function asSecretRef(value: unknown): SecretRef | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const source = record.source
  const id = asString(record.id)
  if ((source === 'env' || source === 'file' || source === 'exec') && id !== undefined) return { source, id }
  return undefined
}

/** Telegram id from `telegram:123`, `123` or the number 123; other channels are ignored. */
function telegramId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value !== 'string') return undefined
  const match = /^(?:telegram:)?(-?\d+)$/.exec(value.trim())
  return match?.[1]
}

function firstTelegramId(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined
  for (const value of values) {
    const id = telegramId(value)
    if (id !== undefined) return id
  }
  return undefined
}

/**
 * The account whose token is live: `defaultAccount`, or the only account when
 * there is exactly one. More than one account without a default is ambiguous.
 */
function activeAccount(telegram: Record<string, unknown>): Record<string, unknown> | undefined {
  const accounts = asRecord(telegram.accounts)
  if (accounts === undefined) return undefined
  const explicit = asString(telegram.defaultAccount)
  if (explicit !== undefined) return asRecord(accounts[explicit])
  const ids = Object.keys(accounts)
  return ids.length === 1 ? asRecord(accounts[ids[0] as string]) : undefined
}

function executableInPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.trim() === '') return false
  if (isAbsolute(command)) return isFile(command)
  if (command.includes('/')) return isFile(resolve(command))
  const path = env.PATH ?? ''
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    if (isFile(join(dir, command))) return true
  }
  return false
}

/** Same bytes, whether a value is text or the contents of a binary file. */
export function sameSecretValue(left: SecretValue, right: SecretValue): boolean {
  return Buffer.from(left).equals(Buffer.from(right))
}

/** Accumulates candidates; same name + same value is one entry, different value a conflict. */
export class Collector {
  private readonly secretMap = new Map<string, SecretCandidate>()
  private readonly envMap = new Map<string, EnvCandidate>()
  private readonly servers: Collected['mcp'][number][] = []
  private readonly warningItems: PlanItem[] = []
  private ownerCandidate: Collected['owner']

  warning(item: PlanItem): void {
    this.warningItems.push(item)
  }

  /**
   * The single entry for a secret of any source: the daemon's env keys go to
   * the env file, everything else to the vault.
   */
  secret(name: string, value: SecretValue, source: string, field?: string): void {
    if (value.length === 0) return
    if (DAEMON_ENV_KEYS.has(name)) {
      this.env(name, value.toString(), source)
      return
    }
    this.vault(name, value, source, field)
  }

  private vault(name: string, value: SecretValue, source: string, field?: string): void {
    if (!SECRET_NAME_RE.test(name)) {
      this.warning(this.item('secret', name, source, 'secrets/', 'warning', `недопустимое имя секрета: ${name}`, field))
      return
    }
    if (value.length === 0) return
    const previous = this.secretMap.get(name)
    if (previous === undefined) {
      this.secretMap.set(name, { name, value, sources: [source], fields: field === undefined ? [] : [field] })
      return
    }
    if (sameSecretValue(previous.value, value)) {
      if (!previous.sources.includes(source)) previous.sources.push(source)
      if (field !== undefined && !previous.fields.includes(field)) previous.fields.push(field)
      return
    }
    previous.conflict ??= `разные значения в источниках: ${[previous.sources[0], source].filter(Boolean).join(', ')}`
    if (!previous.sources.includes(source)) previous.sources.push(source)
  }

  env(name: string, value: string, source: string): void {
    if (value === '') return
    const previous = this.envMap.get(name)
    if (previous === undefined) {
      this.envMap.set(name, { name, value, sources: [source] })
      return
    }
    if (previous.value === value) {
      if (!previous.sources.includes(source)) previous.sources.push(source)
      return
    }
    previous.conflict ??= `разные значения в источниках: ${[previous.sources[0], source].filter(Boolean).join(', ')}`
    if (!previous.sources.includes(source)) previous.sources.push(source)
  }

  owner(id: string, source: string): void {
    this.ownerCandidate ??= { id, source }
  }

  server(name: string, source: string, server: Record<string, unknown>, warnings: PlanItem[]): void {
    this.servers.push({ name, source, server, warnings })
  }

  dotenv?: Map<string, string>
  variables?: VariableResolver

  collected(): Collected {
    return {
      secrets: [...this.secretMap.values()],
      env: [...this.envMap.values()],
      owner: this.ownerCandidate,
      mcp: this.servers,
      warnings: this.warningItems,
    }
  }

  item(kind: string, name: string, source: string, target: string, status: PlanItem['status'], reason: string, field?: string): PlanItem {
    return { kind, name, source, target, status, reason, ...(field === undefined ? {} : { field }) }
  }
}

/** Expand `${NAME}` in one config value with the OpenClaw variable environment. */
function expandedValue(collector: Collector, value: string): Expanded {
  return expandVariables(value, (name) => collector.variables?.resolve(name))
}

/** The value of a `source: "env"` SecretRef, resolved like a `${NAME}` placeholder. */
function envReference(collector: Collector, name: string): string | undefined {
  return collector.variables?.resolve(name) ?? nonEmpty(collector.dotenv?.get(name)) ?? nonEmpty(process.env[name])
}

/** Plan reason for a placeholder without a value; only the name, never a value. */
function missingVariable(name: string): string {
  return `переменная окружения ${name} не найдена в .env и env конфигурации`
}

/** Read one OpenClaw state directory into candidates. Never throws for missing pieces. */
export function collectOpenClaw(source: OpenClawSource): Collected {
  const collector = new Collector()
  collector.dotenv = readDotEnv(join(source.dir, '.env'))
  const warnings: PlanItem[] = []
  let config: Record<string, unknown> = {}
  try {
    const parsed = parseJson5(readFileSync(source.configPath, 'utf8'))
    config = asRecord(parsed) ?? {}
  } catch {
    warnings.push({
      kind: 'config',
      name: source.configName,
      source: source.configPath,
      target: source.configPath,
      status: 'error',
      reason: 'не удалось разобрать конфигурацию OpenClaw (JSON5)',
    })
    return { secrets: [], env: [], mcp: [], warnings }
  }

  // `.env` first: a SecretRef below resolves through this map, and the order
  // gives stable source labels for a repeated run.
  for (const [name, value] of collector.dotenv) {
    collector.secret(name, value, `${source.configName}:.env`)
  }
  collector.variables = new VariableResolver(collector.dotenv, config)

  const envVars = asRecord(asRecord(config.env)?.vars)
  if (envVars !== undefined) {
    for (const [name, value] of Object.entries(envVars)) {
      const path = `env.vars.${name}`
      if (typeof value === 'string') {
        const expanded = expandedValue(collector, value)
        for (const variable of expanded.missing) {
          collector.warning(warningItem('secret', name, `${source.configName}:${path}`, secretTarget(name), missingVariable(variable), path))
        }
        // A value with an unresolved placeholder is not what OpenClaw used.
        if (expanded.missing.length === 0) collector.secret(name, expanded.value, `${source.configName}:${path}`, path)
      } else {
        const ref = asSecretRef(value)
        if (ref !== undefined) {
          const resolved = ref.source === 'env' ? envReference(collector, ref.id) : undefined
          if (resolved !== undefined) collector.secret(name, resolved, `${source.configName}:${path}`, path)
          else collector.warning(warningItem('secret', name, `${source.configName}:${path}`, secretTarget(name), referenceReason(ref), path))
        }
      }
    }
  }

  collectProviders(collector, config, source)
  collectPlugins(collector, config, source)
  collectTelegram(collector, config, source)
  collectMcp(collector, config, source)
  collectVault(collector, source)
  collectCredentials(collector, source)
  collectAuthProfiles(collector, source)
  const identity = collectIdentity(source, config)

  const collected = collector.collected()
  return { ...collected, ...(identity === undefined ? {} : { identity }), warnings: [...warnings, ...collected.warnings] }
}

/**
 * The owner's SOUL.md. OpenClaw keeps it in the configured workspace (or the
 * state directory when no workspace is set); every source uses the same
 * identity policy, which the planner applies.
 */
function collectIdentity(source: OpenClawSource, config: Record<string, unknown>): { text: string; source: string } | undefined {
  const workspace = asString(asRecord(asRecord(config.agents)?.defaults)?.workspace)
  const dir = workspace === undefined ? source.dir : resolve(source.dir, workspace)
  const path = join(dir, 'SOUL.md')
  if (!isFile(path)) return undefined
  try {
    return { text: readFileSync(path, 'utf8'), source: 'workspace/SOUL.md' }
  } catch {
    return undefined
  }
}

function collectProviders(collector: Collector, config: Record<string, unknown>, source: OpenClawSource): void {
  const providers = asRecord(asRecord(config.models)?.providers)
  if (providers === undefined) return
  for (const [provider, raw] of Object.entries(providers)) {
    const apiKey = asRecord(raw)?.apiKey
    if (apiKey === undefined) continue
    const name = providerKeyName(provider)
    const field = `models.providers.${provider}.apiKey`
    const label = `${source.configName}:${field}`
    if (typeof apiKey === 'string') {
      const expanded = expandedValue(collector, apiKey)
      if (expanded.missing.length > 0) {
        for (const variable of expanded.missing) {
          collector.warning(warningItem('secret', name, label, secretTarget(name), missingVariable(variable), field))
        }
        continue
      }
      collector.secret(name, expanded.value, label, field)
      continue
    }
    const ref = asSecretRef(apiKey)
    if (ref !== undefined) {
      const resolved = ref.source === 'env' ? envReference(collector, ref.id) : undefined
      if (resolved !== undefined) collector.secret(name, resolved, label, field)
      else collector.warning(warningItem('secret', name, label, secretTarget(name), referenceReason(ref), field))
    }
  }
}

function collectPlugins(collector: Collector, config: Record<string, unknown>, source: OpenClawSource): void {
  const entries = asRecord(asRecord(config.plugins)?.entries)
  if (entries === undefined) return
  for (const [plugin, raw] of Object.entries(entries)) {
    const pluginConfig = asRecord(asRecord(raw)?.config)
    if (pluginConfig === undefined) continue
    walkPluginFields(collector, pluginConfig, `plugins.entries.${plugin}.config`, source)
  }
}

function walkPluginFields(collector: Collector, value: Record<string, unknown>, prefix: string, source: OpenClawSource): void {
  for (const [field, entry] of Object.entries(value)) {
    const path = `${prefix}.${field}`
    const ref = asSecretRef(entry)
    if (ref !== undefined) {
      const resolved = ref.source === 'env' ? envReference(collector, ref.id) : undefined
      if (resolved !== undefined) collector.secret(derivedName(path.split('.')), resolved, `${source.configName}:${path}`, path)
      else collector.warning(warningItem('secret', derivedName(path.split('.')), `${source.configName}:${path}`, 'secrets/', referenceReason(ref), path))
      continue
    }
    const nested = asRecord(entry)
    if (nested !== undefined) {
      walkPluginFields(collector, nested, path, source)
      continue
    }
    if (typeof entry === 'string' && SECRET_FIELD_RE.test(field)) {
      const expanded = expandedValue(collector, entry)
      for (const variable of expanded.missing) {
        collector.warning(warningItem('secret', derivedName(path.split('.')), `${source.configName}:${path}`, 'secrets/', missingVariable(variable), path))
      }
      if (expanded.missing.length === 0) collector.secret(derivedName(path.split('.')), expanded.value, `${source.configName}:${path}`, path)
    }
  }
}

function collectTelegram(collector: Collector, config: Record<string, unknown>, source: OpenClawSource): void {
  const channels = asRecord(config.channels)
  const telegram = asRecord(channels?.telegram)
  if (telegram !== undefined) {
    const account = activeAccount(telegram)
    const rawToken = telegram.botToken !== undefined ? telegram.botToken : account?.botToken
    const field = telegram.botToken !== undefined || account === undefined ? 'channels.telegram.botToken' : `channels.telegram.accounts.${String(telegram.defaultAccount ?? Object.keys(asRecord(telegram.accounts) ?? {})[0])}.botToken`
    if (rawToken !== undefined) {
      const token = resolveTelegramToken(collector, rawToken, `${source.configName}:${field}`, field)
      if (token !== undefined) collector.env('TELEGRAM_BOT_TOKEN', token, `${source.configName}:${field}`)
      else collector.warning(warningItem('env', 'TELEGRAM_BOT_TOKEN', `${source.configName}:${field}`, 'TELEGRAM_BOT_TOKEN', 'не удалось получить значение botToken', field))
    }

    const owner =
      firstTelegramId(commandsOwner(config)) ??
      firstTelegramId(account?.allowFrom) ??
      firstTelegramId(telegram.allowFrom)
    if (owner !== undefined) collector.owner(owner, `${source.configName}:commands.ownerAllowFrom/channels.telegram.allowFrom`)
  } else {
    const owner = firstTelegramId(commandsOwner(config))
    if (owner !== undefined) collector.owner(owner, `${source.configName}:commands.ownerAllowFrom`)
  }
}

function commandsOwner(config: Record<string, unknown>): unknown {
  return asRecord(config.commands)?.ownerAllowFrom
}

function resolveTelegramToken(collector: Collector, value: unknown, source: string, field: string): string | undefined {
  if (typeof value === 'string') {
    const expanded = expandedValue(collector, value)
    for (const variable of expanded.missing) {
      collector.warning(warningItem('env', 'TELEGRAM_BOT_TOKEN', source, 'TELEGRAM_BOT_TOKEN', missingVariable(variable), field))
    }
    return expanded.missing.length === 0 ? expanded.value : undefined
  }
  const ref = asSecretRef(value)
  if (ref === undefined) return undefined
  if (ref.source !== 'env') {
    collector.warning(warningItem('env', 'TELEGRAM_BOT_TOKEN', source, 'TELEGRAM_BOT_TOKEN', `SecretRef source=${ref.source} не разрешается автоматически`, field))
    return undefined
  }
  return envReference(collector, ref.id)
}

/**
 * A file or directory that exists but this user cannot use it with `mode`:
 * a parent without search permission, or a file it cannot read or enter.
 */
function inaccessible(path: string, mode: number): boolean {
  if (!isAbsolute(path)) return false
  try {
    accessSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM'
  }
  try {
    accessSync(path, mode)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM'
  }
}

/** The path part of an argument (`--config=/etc/x` → `/etc/x`), if it may be one. */
function argumentPath(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.startsWith('-')) {
    const equals = trimmed.indexOf('=')
    return equals === -1 ? undefined : trimmed.slice(equals + 1).trim()
  }
  return trimmed
}

/**
 * Absolute paths the server needs at runtime with the access each needs: its
 * command and cwd are entered or executed, files from args and env are read.
 */
function mcpRuntimePaths(output: Record<string, unknown>): { path: string; mode: number }[] {
  const result = new Map<string, number>()
  const add = (value: string | undefined, mode: number): void => {
    if (value !== undefined && value !== '' && isAbsolute(value)) result.set(value, (result.get(value) ?? 0) | mode)
  }
  if (typeof output.command === 'string') add(output.command.trim(), constants.X_OK)
  if (typeof output.cwd === 'string') add(output.cwd.trim(), constants.X_OK)
  if (Array.isArray(output.args)) {
    for (const arg of output.args) {
      if (typeof arg === 'string') add(argumentPath(arg), constants.R_OK)
    }
  }
  const env = asRecord(output.env)
  if (env !== undefined) {
    for (const [key, value] of Object.entries(env)) {
      // A path-bearing value is worth checking; a secret field is never printed
      // as a path even if its value happens to look like one.
      if (typeof value === 'string' && !SECRET_FIELD_RE.test(key)) add(value.trim(), constants.R_OK)
    }
  }
  return [...result].map(([path, mode]) => ({ path, mode }))
}

function collectMcp(collector: Collector, config: Record<string, unknown>, source: OpenClawSource): void {
  const servers = asRecord(asRecord(config.mcp)?.servers)
  if (servers === undefined) return
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw)
    if (server === undefined) continue
    const warnings: PlanItem[] = []
    const output: Record<string, unknown> = {}
    const expandField = (value: string, path: string): Expanded => {
      const expanded = expandedValue(collector, value)
      for (const variable of expanded.missing) {
        warnings.push(warningItem('mcp', name, `${source.configName}:${path}`, 'mcp.json', missingVariable(variable), path))
      }
      return expanded
    }
    for (const key of ['command', 'args', 'cwd', 'url', 'transport', 'type', 'enabled', 'requestTimeoutMs']) {
      const value = server[key]
      if (value === undefined) continue
      if (key === 'args' && Array.isArray(value)) {
        output[key] = value.map((entry) => typeof entry === 'string'
          ? expandField(entry, `mcp.servers.${name}.args`).value
          : entry)
      } else if (typeof value === 'string') {
        output[key] = expandField(value, `mcp.servers.${name}.${key}`).value
      } else {
        output[key] = value
      }
    }
    for (const field of ['env', 'headers'] as const) {
      const values = asRecord(server[field])
      if (values === undefined) continue
      const next: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') {
          next[key] = value
          continue
        }
        const path = `mcp.servers.${name}.${field}.${key}`
        const expanded = expandField(value, path)
        // A substituted variable comes from `.env` or `env.vars`, so the value
        // goes to the vault even under a plain key: `mcp.json` resolves
        // `${secret:NAME}` in `env` and `headers` and never needs the text.
        if ((SECRET_FIELD_RE.test(key) || expanded.substituted) && !expanded.value.startsWith('${secret:')) {
          const secretName = derivedName(['mcp', 'servers', name, field, key])
          // An unresolved placeholder is not the value OpenClaw sent; the
          // reference stays, and DSHBOT reports the missing secret for the server.
          if (expanded.missing.length === 0) collector.secret(secretName, expanded.value, `${source.configName}:${path}`, path)
          next[key] = `\${secret:${secretName}}`
        } else {
          next[key] = expanded.value
        }
      }
      output[field] = next
    }
    const blocked = mcpRuntimePaths(output).filter(({ path, mode }) => inaccessible(path, mode)).map(({ path }) => path)
    for (const path of blocked) {
      warnings.push({
        kind: 'mcp',
        name,
        source: `${source.configName}:mcp.servers.${name}`,
        target: 'mcp.json',
        status: 'warning',
        reason: `путь недоступен текущему пользователю: ${path}`,
      })
    }
    if (blocked.length === 0 && typeof output.command === 'string' && !executableInPath(output.command, process.env)) {
      warnings.push({
        kind: 'mcp',
        name,
        source: `${source.configName}:mcp.servers.${name}`,
        target: 'mcp.json',
        status: 'warning',
        reason: `команда не найдена в PATH и по абсолютному пути: ${output.command}`,
      })
    }
    collector.server(name, `${source.configName}:mcp.servers.${name}`, output, warnings)
  }
}

function collectVault(collector: Collector, source: OpenClawSource): void {
  const path = join(source.dir, 'state', 'openclaw.sqlite')
  const records = withReadOnlyDatabase(path, (db) =>
    rows(db, 'SELECT name, value FROM secret_store_entries WHERE deleted_at_ms IS NULL'),
  )
  for (const record of records ?? []) {
    const name = asString(record.name)
    const value = asString(record.value)
    if (name === undefined || value === undefined) continue
    collector.secret(name, value, 'state/openclaw.sqlite:secret_store_entries')
  }
  const pairing = withReadOnlyDatabase(path, (db) =>
    rows(db, "SELECT channel_key, account_id, entry FROM channel_pairing_allow_entries ORDER BY rowid"),
  )
  for (const record of pairing ?? []) {
    if (asString(record.channel_key) !== 'telegram') continue
    const id = telegramId(asString(record.entry))
    if (id !== undefined) collector.owner(id, 'state/openclaw.sqlite:channel_pairing_allow_entries')
  }
}

function collectCredentials(collector: Collector, source: OpenClawSource): void {
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
    if (!stat.isFile()) continue
    if (ALLOW_FROM_FILE.test(name)) {
      const text = (() => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return undefined
        }
      })()
      if (text === undefined) continue
      try {
        const parsed: unknown = JSON.parse(text)
        const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.allowFrom
        const id = firstTelegramId(list)
        if (id !== undefined) collector.owner(id, `credentials/${name}`)
      } catch {
        // A broken allowFrom file only loses this fallback.
      }
      continue
    }
    // The vault keeps the exact bytes: a credentials file may be binary.
    let value: Buffer
    try {
      value = readFileSync(path)
    } catch {
      continue
    }
    const field = `credentials/${name}`
    collector.secret(derivedName(['credentials', name]), value, field, field)
  }
}

function collectAuthProfiles(collector: Collector, source: OpenClawSource): void {
  const agentsDir = join(source.dir, 'agents')
  if (!isDirectory(agentsDir)) return
  let agents: string[]
  try {
    agents = readdirSync(agentsDir).sort()
  } catch {
    return
  }
  for (const agent of agents) {
    const agentDir = join(agentsDir, agent, 'agent')
    if (!isDirectory(agentDir)) continue
    const legacy = join(agentDir, 'auth-profiles.json')
    if (isFile(legacy)) {
      try {
        addAuthProfiles(collector, JSON.parse(readFileSync(legacy, 'utf8')), `agents/${agent}/agent/auth-profiles.json`)
      } catch {
        collector.warning(warningItem('auth', agent, `agents/${agent}/agent/auth-profiles.json`, 'secrets/', 'профили авторизации не читаются', 'agents'))
      }
    }
    const database = join(agentDir, 'openclaw-agent.sqlite')
    const stores = withReadOnlyDatabase(database, (db) =>
      rows(db, 'SELECT store_key, store_json FROM auth_profile_store ORDER BY rowid'),
    )
    for (const store of stores ?? []) {
      const text = asString(store.store_json)
      if (text === undefined) continue
      try {
        addAuthProfiles(collector, JSON.parse(text), `agents/${agent}/agent/openclaw-agent.sqlite`)
      } catch {
        collector.warning(warningItem('auth', agent, `agents/${agent}/agent/openclaw-agent.sqlite`, 'secrets/', 'профиль авторизации не читается', 'agents'))
      }
    }
  }
}

function addAuthProfiles(collector: Collector, value: unknown, source: string): void {
  const profiles = asRecord(asRecord(value)?.profiles)
  if (profiles === undefined) return
  for (const [id, raw] of Object.entries(profiles)) {
    const profile = asRecord(raw)
    if (profile === undefined) continue
    const provider = asString(profile.provider) ?? id.split(':')[0] ?? 'provider'
    const type = asString(profile.type) ?? 'api_key'
    const field = `${source}:profiles.${id}`
    if (type !== 'api_key') {
      collector.warning(warningItem('auth', providerKeyName(provider), source, 'secrets/', `OAuth-профиль ${id} не переносится`, field))
      continue
    }
    const key = asString(profile.key)
    if (key === undefined || key === '') {
      collector.warning(warningItem('auth', providerKeyName(provider), source, secretTarget(providerKeyName(provider)), `профиль ${id} без ключа api_key`, field))
      continue
    }
    collector.secret(providerKeyName(provider), key, source, field)
  }
}

function referenceReason(ref: SecretRef): string {
  if (ref.source !== 'env') return `SecretRef source=${ref.source} не разрешается автоматически: ${ref.id}`
  return `SecretRef env ${ref.id} не найден в .env и окружении`
}

/** Where a named key would go, for warnings about keys that were not resolved. */
export function secretTarget(name: string): string {
  return DAEMON_ENV_KEYS.has(name) ? name : `secrets/${name}`
}

export function warningItem(kind: string, name: string, source: string, target: string, reason: string, field?: string): PlanItem {
  return { kind, name, source, target, status: 'warning', reason, ...(field === undefined ? {} : { field }) }
}
