// MCP servers of the owner for the bot: the tools of `<DSHBOT_HOME>/mcp.json`
// as lazy tools of the owner's runner.
//
// The bot consumes the harness packages `@deepseek-ai/dsh-mcp-client` (server
// naming `mcp__<server>__<tool>`, stdio, Streamable HTTP and the old HTTP+SSE)
// and `@deepseek-ai/dsh-mcp-resources` (pinned next to it, see
// docs/research/tools-deps-review.md). The tools do not enter the tool prefix:
// each one is a lazy `RunnerTool` (`lazy: true`) that `tool_search` enables by
// request. The tail of the owner turn carries a short block about the servers.
//
// The policy lives here, not in the prompt:
//
//   * the server list comes from one file, `<DSHBOT_HOME>/mcp.json`, in the
//     Claude Code shape (`command`/`args`/`env` or `url`/`headers` plus
//     `type: "sse"`). The bot never adds a server and never writes that file;
//   * every server may carry a tool policy: `include` (only these raw names),
//     `exclude` (these raw names are hidden, applied after `include`),
//     `confirm` (these raw names need the owner's button) and `enabled: false`
//     (the entry stays in the file, no process starts). The policy is applied
//     when the tools are published, so a reload updates a live server;
//   * the file is read again on the owner command `/mcp reload`: unchanged
//     servers keep their process and connection, changed ones are restarted,
//     removed ones are stopped and new ones are started; a broken file changes
//     nothing, and one failing server never stops the others;
//   * a stdio server gets PATH, HOME, LANG and its own `env` and nothing else:
//     the keys of the bot never reach it;
//   * the tools are owner-only (`guestAllowed` is false) and lazy; a guest turn
//     opens with `tools: []`, so it sees neither the schemas nor the index;
//   * a tool the server marks `annotations.destructiveHint` needs the owner's
//     button; an autonomous turn refuses it without a card;
//   * a server that does not start or dies does not throw into the daemon: its
//     state is kept, its tools answer with a readable error, the other servers
//     keep working, and `stop()` terminates every child with the daemon.

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { frameData } from '../../app/src/untrusted-frame.js'

import { readMcpConfig, MCP_CONFIG_FILE, type McpConfig, type McpConfigProblem, type McpServer } from './config.js'
import { EnvOnlyStdioTransport } from './transport.js'

export { mcpConfigPath, MCP_CONFIG_FILE, readMcpConfig } from './config.js'
export type {
  McpConfig,
  McpConfigProblem,
  McpHttpServer,
  McpServer,
  McpSseServer,
  McpStdioServer,
} from './config.js'

/** Timeout of one `tools/call`, in milliseconds. */
export const MCP_TOOL_TIMEOUT_MS = 60_000

/** How long the initial connection of one server may take before it is declared broken. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000

/** Name prefix the harness puts in front of every MCP tool. */
const TOOL_PREFIX = 'mcp__'

/** DeepSeek function-name contract: at most 64 characters, `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

/** One tool of a connected server, as the runner needs it. */
export interface McpToolInfo {
  /** Model-facing name (`mcp__<server>__<tool>`). */
  readonly name: string
  /** Name on the wire, never parsed back out of {@link name}. */
  readonly rawName: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  /** The server advertised `annotations.destructiveHint: true`. */
  readonly destructive: boolean
  /** The server advertised `annotations.readOnlyHint: true`: the call only reads. */
  readonly readOnly: boolean
}

/** One tool of a server as the owner command `/mcp` lists it. */
export interface McpToolSummary {
  /** Model-facing name (`mcp__<server>__<tool>`). */
  readonly name: string
  readonly description: string
}

/** Transport of one configured server. */
export type McpTransportType = 'stdio' | 'streamable-http' | 'sse'

/** State of one configured server, for `/status` and error messages. */
export interface McpServerState {
  readonly name: string
  readonly transport: McpTransportType
  /** `disabled` is the owner's `enabled: false`: kept in the file, never started. */
  readonly state: 'starting' | 'ready' | 'failed' | 'stopped' | 'disabled'
  readonly tools: number
  /** Tool names and descriptions for `/mcp`; empty until the server connected. */
  readonly toolDetails: readonly McpToolSummary[]
  readonly error?: string
}

/**
 * What `/mcp reload` did, per server name. `ok: false` means the file itself
 * was unusable: no server was stopped, started or restarted then, so every
 * running server keeps its process and its tools.
 */
export interface McpReloadReport {
  readonly ok: boolean
  /** Problem of `mcp.json` itself; present only when {@link ok} is false. */
  readonly error?: string
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly restarted: readonly string[]
  /** Policy of a live server changed (`include`, `exclude` or `confirm`): the process was kept. */
  readonly updated: readonly string[]
  readonly unchanged: readonly string[]
}

/** A tool shaped like the runner seam's `RunnerTool`. */
export interface McpRunnerTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly lazy: true
  /**
   * Not in the stable prefix index: the servers of `mcp.json` and their tools
   * can change through `/mcp reload`, so the tail block of the owner turn
   * describes them and the cached prefix stays byte-identical.
   */
  readonly indexed: false
  readonly guestAllowed: false
  /**
   * Opt-in of a tool the server itself marks `readOnlyHint: true`. A
   * `destructiveHint` or an owner `confirm` entry always wins and keeps the
   * call in turn, because the call may then write or ask for a button.
   */
  readonly isConcurrencySafe?: (args: unknown) => boolean
  execute(args: Record<string, unknown>, context?: { signal?: AbortSignal }): unknown | Promise<unknown>
}

/** The MCP client of one daemon: the servers, their tools and their children. */
export interface McpTools {
  /** Tools of all connected servers; empty until {@link ready} resolved and after a failure. */
  tools(): readonly McpRunnerTool[]
  /** Resolves when every configured server finished its connection attempt. */
  ready(): Promise<void>
  /** Whether the connected server marked this tool destructive. */
  isDestructive(name: string): boolean
  /** Whether the owner's `confirm` list covers this tool. */
  needsConfirmation(name: string): boolean
  /** Whether the server advertised `readOnlyHint: true` for this tool. */
  isReadOnly(name: string): boolean
  /** Current state of every configured server and of every broken entry of the file. */
  status(): readonly McpServerState[]
  /** Problems of `mcp.json` itself, one line each. */
  problems(): readonly McpConfigProblem[]
  /** Names of `include`/`exclude`/`confirm` the server does not have, one line each. */
  warnings(): readonly McpConfigProblem[]
  /** Replace every value of `env`, `headers` and the vault in a text (card of a call). */
  scrub(text: string): string
  /**
   * Read `mcp.json` again and apply the difference: start new servers, stop
   * removed ones, restart changed ones, leave unchanged ones untouched. One
   * failing server does not stop the others and a broken file changes nothing.
   * Concurrent calls are serialized.
   */
  reload(): Promise<McpReloadReport>
  /** Terminates every child process; idempotent. */
  stop(): Promise<void>
}

/** A secret the daemon holds, with the name the owner gave it. */
export interface McpSecretEntry {
  readonly name: string
  readonly value: string
}

/**
 * The vault of the owner as `mcp.json` needs it: resolve `${secret:NAME}` in
 * `env` and `headers`, and list the values that must never reach a surface.
 * The history keeps deleted and replaced values, so a live server process that
 * still holds one cannot quote it to the model after `/unsecret`.
 */
export interface McpSecretSource {
  resolve(text: string): { text: string; missing: string[] }
  known(): readonly McpSecretEntry[]
}

export interface McpToolsOptions {
  /** `DSHBOT_HOME`; the configuration is `<home>/mcp.json`. */
  readonly home: string
  /** Diagnostic sink; a throw here never breaks the daemon. */
  readonly log?: (message: string) => void
  /** Test seam: the file reader; defaults to {@link readMcpConfig}. */
  readonly readConfig?: (home: string) => McpConfig
  /** Vault of the owner: resolves references and supplies the scrub history. */
  readonly secrets?: McpSecretSource
}

/**
 * Server-qualified public name. The clean case is `mcp__<server>__<tool>`; a
 * lossy normalization appends a short hash so distinct tools never collapse.
 */
export function mcpToolName(server: string, tool: string): string {
  const joined = `${TOOL_PREFIX}${server}__${tool}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_TOOL_NAME_LENGTH) return joined
  let hash = 0
  for (const char of `${server}\0${tool}`) hash = (Math.imul(hash, 31) + char.codePointAt(0)!) | 0
  const suffix = (hash >>> 0).toString(16).padStart(8, '0').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${suffix}`
}

/** Environment of a stdio server: PATH, HOME, LANG and the entries of `mcp.json`. */
export function childEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) result[key] = value
  }
  return { ...result, ...env }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One line, no stack: what the model reads when a server is unavailable. */
function cleanMessage(text: string): string {
  return text.replace(/\s*\n\s*at\s+.*$/u, '').replace(/\s+/gu, ' ').trim()
}

/**
 * A server error without an embedded stack, with its line breaks kept. The
 * model reads every line of the failure, while the tool-notes of a turn keep
 * the first one; collapsing them into a single line would hide the boundary.
 */
function cleanToolMessage(text: string): string {
  return text.replace(/\s*\n\s*at\s+.*$/u, '').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function toolInfoOf(server: string, raw: unknown): McpToolInfo | undefined {
  const tool = asRecord(raw)
  if (tool === undefined || typeof tool.name !== 'string' || tool.name.trim() === '') return undefined
  const inputSchema = asRecord(tool.inputSchema)
  const annotations = asRecord(tool.annotations)
  return {
    name: mcpToolName(server, tool.name),
    rawName: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: inputSchema ?? { type: 'object', properties: {} },
    destructive: annotations?.destructiveHint === true,
    readOnly: annotations?.readOnlyHint === true,
  }
}

/** Text of one MCP result, without protocol noise. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const block = asRecord(raw)
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      parts.push(`[ресурс ${typeof block.name === 'string' ? block.name : ''}: ${block.uri}]`.replace('  ', ' '))
    } else if (block.type === 'image') parts.push('[изображение от MCP-сервера не передаётся в этот ход]')
    else if (block.type === 'audio') parts.push('[аудио от MCP-сервера не передаётся]')
    else if (block.type === 'resource') parts.push('[встроенный ресурс от MCP-сервера не передаётся]')
  }
  return parts.join('\n')
}

/** The live connection of one configured server. */
type McpClientTransport = EnvOnlyStdioTransport | StreamableHTTPClientTransport | SSEClientTransport

interface ServerRuntime {
  config: McpServer
  state: 'starting' | 'ready' | 'failed' | 'stopped' | 'disabled'
  error?: string
  client?: Client
  transport?: McpClientTransport
  tools: McpToolInfo[]
  /** Raw names the server listed, including the tools hidden because of a secret. */
  rawNames: string[]
  /** Tools hidden because their name or a schema key quoted a secret. */
  hiddenProblems: string[]
  /** Names of the policy lists the server does not have. */
  policyProblems: string[]
  /** The server was removed (or changed) by a reload: a late connect must not resurrect it. */
  closed?: boolean
}

function serverSummary(server: McpServer): string {
  if (server.transport === 'stdio') return `stdio ${server.command}`
  return `${server.transport} ${server.url}`
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Equal key sets with equal values, independent of the order keys were written in. */
function sameMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameStrings(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key])
}

/** Whether reloading this server would change anything the process or connection depends on. */
function sameServer(left: McpServer, right: McpServer): boolean {
  if (left.transport !== right.transport) return false
  if (left.transport === 'stdio') {
    const next = right as typeof left
    return (
      left.command === next.command &&
      left.cwd === next.cwd &&
      sameStrings(left.args, next.args) &&
      sameMap(left.env, next.env)
    )
  }
  const next = right as Exclude<McpServer, { transport: 'stdio' }>
  return left.url === next.url && sameMap(left.headers, next.headers)
}

/** Equal name sets, independent of the order the owner wrote them in. */
function sameNameSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = new Set(left ?? [])
  const b = new Set(right ?? [])
  return a.size === b.size && [...a].every((name) => b.has(name))
}

/**
 * Whether only the tool policy changed. Such a change never restarts the
 * process: the policy is read at every publication of the tools.
 */
function samePolicy(left: McpServer, right: McpServer): boolean {
  // A missing `include` shows every tool while `include: []` shows none, so
  // for `include` (unlike `exclude` and `confirm`) the two are different
  // policies.
  return (
    (left.include === undefined) === (right.include === undefined) &&
    sameNameSet(left.include, right.include) &&
    sameNameSet(left.exclude, right.exclude) &&
    sameNameSet(left.confirm, right.confirm)
  )
}

/**
 * Tools the model may see: `include` first (only the listed raw names), then
 * `exclude` (the listed raw names are hidden, even when `include` kept them).
 * Names are the ones the server sends, never the `mcp__` form.
 */
function visibleTools(runtime: ServerRuntime): McpToolInfo[] {
  const include = runtime.config.include
  const exclude = runtime.config.exclude
  return runtime.tools.filter((tool) => {
    if (include !== undefined && !include.includes(tool.rawName)) return false
    if (exclude !== undefined && exclude.includes(tool.rawName)) return false
    return true
  })
}

/**
 * Names of `include`/`exclude`/`confirm` the server did not list. They are a
 * warning of `/mcp`, not a broken entry: the rest of the policy still works.
 */
function policyWarningsOf(runtime: ServerRuntime): string[] {
  if (runtime.state !== 'ready') return []
  const known = new Set(runtime.rawNames)
  const missing: string[] = []
  for (const field of ['include', 'exclude', 'confirm'] as const) {
    for (const name of runtime.config[field] ?? []) {
      if (!known.has(name)) missing.push(`${name} (${field})`)
    }
  }
  if (missing.length === 0) return []
  return [`предупреждение: сервер не отдаёт ${missing.join(', ')}`]
}

/**
 * Values of `env` and `headers` from `mcp.json`. They may be tokens, so the
 * client never prints them: even an error text of a foreign transport is
 * scrubbed before it reaches the journal, the owner or the prompt. Short
 * values can be credentials too: only empty values are excluded, since they
 * carry no text to redact.
 */
function secretValuesOf(config: McpConfig): string[] {
  const values: string[] = []
  for (const server of config.servers) {
    const map = server.transport === 'stdio' ? server.env : server.headers
    for (const value of Object.values(map)) {
      if (value.length > 0) values.push(value)
    }
  }
  return values.sort((left, right) => right.length - left.length)
}

/** Text with every value of `env`/`headers` replaced; foreign text may quote them. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) result = result.split(secret).join('[скрыто]')
  return result
}

/** The configuration with `${secret:NAME}` resolved in `env` and `headers`. */
function withSecrets(config: McpConfig, source: McpSecretSource | undefined): {
  config: McpConfig
  problems: McpConfigProblem[]
} {
  if (source === undefined) return { config, problems: [] }
  const servers: McpServer[] = []
  const problems: McpConfigProblem[] = []
  for (const server of config.servers) {
    // A switched-off server never starts, so a missing credential is not a
    // reason to hide it from /mcp: the entry stays exactly as the owner wrote it.
    if (!server.enabled) {
      servers.push(server)
      continue
    }
    const fields = server.transport === 'stdio' ? server.env : server.headers
    const expanded: Record<string, string> = {}
    const missing = new Set<string>()
    for (const [key, value] of Object.entries(fields)) {
      const resolved = source.resolve(value)
      expanded[key] = resolved.text
      for (const name of resolved.missing) missing.add(name)
    }
    if (missing.size > 0) {
      // The server is not started: a server without its credential would fail
      // later with a foreign error that may quote whatever it got instead.
      problems.push({ name: server.name, message: `секрет ${[...missing].sort().join(', ')} не найден` })
      continue
    }
    servers.push(
      server.transport === 'stdio'
        ? { ...server, env: expanded }
        : { ...server, headers: expanded },
    )
  }
  return { config: { servers, problems: config.problems }, problems }
}

/** Values of the configuration plus every value the vault ever held. */
function scrubEntries(
  config: McpConfig,
  source: McpSecretSource | undefined,
): McpSecretEntry[] {
  const byValue = new Map<string, string>()
  for (const entry of source?.known() ?? []) byValue.set(entry.value, entry.name)
  for (const value of secretValuesOf(config)) {
    if (!byValue.has(value)) byValue.set(value, source?.known().find((entry) => entry.value === value)?.name ?? '')
  }
  return [...byValue.entries()]
    .filter(([value]) => value.length > 0)
    .map(([value, name]) => ({ name, value }))
    .sort((left, right) => right.value.length - left.value.length)
}

/** The name of the secret a value belongs to, for a problem line. */
function secretNameOf(value: string, entries: readonly McpSecretEntry[]): string {
  return entries.find((entry) => entry.value === value)?.name || 'секрет'
}

/** Replace every value of the vault in one string. */
function maskText(text: string, entries: readonly McpSecretEntry[]): string {
  let result = text
  for (const entry of entries) result = result.split(entry.value).join('[скрыто]')
  return result
}

/** Whether a string carries one of the values. */
function quotesValue(text: string, entries: readonly McpSecretEntry[]): boolean {
  return entries.some((entry) => text.includes(entry.value))
}

/** Whether a key of the schema carries one of the values; such a tool is hidden. */
function schemaKeyQuotes(value: unknown, entries: readonly McpSecretEntry[]): boolean {
  if (Array.isArray(value)) return value.some((item) => schemaKeyQuotes(item, entries))
  const record = asRecord(value)
  if (record === undefined) return false
  for (const [key, item] of Object.entries(record)) {
    if (quotesValue(key, entries)) return true
    if (schemaKeyQuotes(item, entries)) return true
  }
  return false
}

/** The schema with every value of the vault masked; keys are checked separately. */
function maskSchema(value: unknown, entries: readonly McpSecretEntry[]): unknown {
  if (typeof value === 'string') return maskText(value, entries)
  if (Array.isArray(value)) return value.map((item) => maskSchema(item, entries))
  const record = asRecord(value)
  if (record === undefined) return value
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) result[key] = maskSchema(item, entries)
  return result
}

/** Create the MCP client and connect the servers of the owner's file. */
export function createMcpTools(options: McpToolsOptions): McpTools {
  const log = options.log ?? ((): void => undefined)
  const readConfig = options.readConfig ?? readMcpConfig
  const initial = withSecrets(readConfig(options.home), options.secrets)
  let config = initial.config
  let problems: readonly McpConfigProblem[] = [...config.problems, ...initial.problems]
  // Values of servers that were removed by a reload stay in the list: a late
  // error of their old process must not quote a credential again.
  let secrets = secretValuesOf(config)
  /** Values to scrub right now: the configuration and the whole vault history. */
  const entries = (): McpSecretEntry[] => scrubEntries(config, options.secrets)
  const redact = (text: string): string => maskText(text, entries())

  function rememberSecrets(next: McpConfig): void {
    const all = new Set(secrets)
    for (const value of secretValuesOf(next)) all.add(value)
    secrets = [...all].sort((left, right) => right.length - left.length)
  }

  const runtimes: ServerRuntime[] = config.servers.map((entry) => ({
    config: entry,
    state: entry.enabled ? 'starting' : 'disabled',
    tools: [],
    rawNames: [],
    hiddenProblems: [],
    policyProblems: [],
  }))
  let stopped = false
  let connecting: Promise<void> = Promise.resolve()

  for (const problem of problems) {
    log(redact(`mcp.json: сервер "${problem.name}" пропущен: ${problem.message}`))
  }

  async function connectOne(runtime: ServerRuntime): Promise<void> {
    const server = runtime.config
    if (!server.enabled) {
      runtime.state = 'disabled'
      runtime.tools = []
      runtime.rawNames = []
      runtime.policyProblems = []
      return
    }
    try {
      if (stopped) throw new Error('демон останавливается')
      const client = new Client({ name: 'dshbot', version: '1.0.0' })
      let transport: McpClientTransport
      if (server.transport === 'stdio') {
        const stdio = new EnvOnlyStdioTransport({
          command: server.command,
          args: server.args,
          // The whole environment: PATH, HOME, LANG and the server's own env.
          env: childEnvironment(server.env),
          ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        })
        transport = stdio
        runtime.transport = stdio
        await withTimeout(client.connect(stdio), MCP_CONNECT_TIMEOUT_MS, server.name)
      } else if (server.transport === 'sse') {
        // The old HTTP+SSE protocol: one long-lived GET stream plus POSTs to the
        // endpoint announced on it. `requestInit.headers` reaches both, so an
        // `Authorization` of mcp.json goes with the stream and every message.
        const sse = new SSEClientTransport(new URL(server.url), {
          requestInit: { headers: { ...server.headers } },
        })
        transport = sse
        runtime.transport = sse
        await withTimeout(client.connect(sse), MCP_CONNECT_TIMEOUT_MS, server.name)
      } else {
        const http = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { ...server.headers } },
        })
        transport = http
        runtime.transport = http
        await withTimeout(client.connect(http), MCP_CONNECT_TIMEOUT_MS, server.name)
      }
      if (stopped || runtime.closed) {
        await client.close().catch(() => undefined)
        return
      }
      const listed = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, server.name)
      const values = entries()
      const vaultValues = values.filter((entry) => entry.name !== '')
      const hidden: string[] = []
      const tools: McpToolInfo[] = []
      const rawNames: string[] = []
      for (const raw of listed.tools ?? []) {
        const tool = toolInfoOf(server.name, raw)
        if (tool === undefined) continue
        rawNames.push(tool.rawName)
        // A value in the tool name or in a key of the schema cannot be masked
        // without renaming the tool or its property, so the tool is not
        // published at all; the problem names the secret, never the value.
        // Only values of the vault hide a tool: a literal of mcp.json such as
        // `on` would match ordinary names and keys (`description`).
        const nameHit = vaultValues.find((entry) => tool.rawName.includes(entry.value))
        const keyHit = vaultValues.find((entry) => schemaKeyQuotes(tool.inputSchema, [entry]))
        if (nameHit !== undefined || keyHit !== undefined) {
          const hit = (nameHit ?? keyHit) as McpSecretEntry
          const where = nameHit !== undefined ? 'имени' : 'ключе схемы'
          hidden.push(`инструмент скрыт, в его ${where} найдено значение секрета ${secretNameOf(hit.value, values)}`)
          continue
        }
        tools.push({
          ...tool,
          // The schema and the description are part of the prompt: only the
          // values of the vault are secrets there, not every literal of `env`
          // (an ordinary `MODE: on` must not replace enum values). Errors of
          // the server and the journal still mask every value of `env`.
          description: maskText(tool.description, vaultValues),
          inputSchema: maskSchema(tool.inputSchema, vaultValues) as Record<string, unknown>,
        })
      }
      runtime.hiddenProblems = hidden
      runtime.rawNames = rawNames
      runtime.client = client
      runtime.tools = tools
      runtime.state = 'ready'
      runtime.policyProblems = policyWarningsOf(runtime)
      runtime.error = undefined
      log(redact(`MCP-сервер "${server.name}" подключён (${serverSummary(server)}): инструментов ${tools.length}`))
      for (const problem of hidden) log(redact(`MCP-сервер "${server.name}": ${problem}`))
      for (const problem of runtime.policyProblems) log(redact(`MCP-сервер "${server.name}": ${problem}`))
    } catch (error) {
      const transport = runtime.transport
      runtime.transport = undefined
      if (transport !== undefined) await transport.close().catch(() => undefined)
      // A server stopped on purpose by reload is not an error of the new file.
      if (stopped || runtime.closed) return
      runtime.state = 'failed'
      runtime.error = redact(cleanMessage(errorText(error)))
      log(redact(`MCP-сервер "${server.name}" не подключён (${serverSummary(server)}): ${runtime.error}`))
    }
  }

  /** Close one connection without touching the others; idempotent. */
  async function stopRuntime(runtime: ServerRuntime): Promise<void> {
    runtime.closed = true
    runtime.state = 'stopped'
    runtime.tools = []
    runtime.rawNames = []
    runtime.hiddenProblems = []
    runtime.policyProblems = []
    runtime.error = undefined
    const client = runtime.client
    runtime.client = undefined
    if (client !== undefined) await client.close().catch(() => undefined)
    const transport = runtime.transport
    runtime.transport = undefined
    if (transport !== undefined) await transport.close().catch(() => undefined)
  }

  async function doReload(): Promise<McpReloadReport> {
    const idle = { added: [], removed: [], restarted: [], updated: [], unchanged: [] }
    if (stopped) return { ok: false, error: 'демон останавливается', ...idle }
    await connecting.catch(() => undefined)
    const raw = readConfig(options.home)
    const applied = withSecrets(raw, options.secrets)
    const next = applied.config
    rememberSecrets(next)
    const fileProblem = next.problems.find((problem) => problem.name === MCP_CONFIG_FILE)
    if (fileProblem !== undefined) {
      // The file itself is unusable: no parsed list exists, so a diff would
      // stop every running server. Refuse and keep the current set untouched.
      problems = next.problems
      log(redact(`mcp.json: перезагрузка отменена: ${fileProblem.message}`))
      return { ok: false, error: fileProblem.message, ...idle }
    }
    config = next
    problems = [...next.problems, ...applied.problems]
    for (const problem of problems) {
      log(redact(`mcp.json: сервер "${problem.name}" пропущен: ${problem.message}`))
    }

    const wanted = new Map(next.servers.map((server) => [server.name, server]))
    const current = new Map(runtimes.map((runtime) => [runtime.config.name, runtime]))
    const added: string[] = []
    const removed: string[] = []
    const restarted: string[] = []
    const updated: string[] = []
    const unchanged: string[] = []

    // Stop first: a changed server must release its name, port and child
    // before the replacement starts, and the report must name it once. A
    // policy-only change keeps the live process: the filter is applied when
    // the tools are published, so no reconnect is needed.
    for (const [name, runtime] of current) {
      const target = wanted.get(name)
      if (target === undefined) {
        await stopRuntime(runtime)
        removed.push(name)
        continue
      }
      if (!target.enabled) {
        if (runtime.state === 'disabled') {
          unchanged.push(name)
          continue
        }
        await stopRuntime(runtime)
        runtime.state = 'disabled'
        restarted.push(name)
        continue
      }
      if (runtime.state === 'disabled') {
        // Switched on again: the fresh runtime is created below.
        restarted.push(name)
        continue
      }
      if (sameServer(runtime.config, target) && runtime.state === 'ready') {
        if (!samePolicy(runtime.config, target)) {
          runtime.config = target
          runtime.policyProblems = policyWarningsOf(runtime)
          for (const message of runtime.policyProblems) log(redact(`MCP-сервер "${name}": ${message}`))
          updated.push(name)
        } else {
          unchanged.push(name)
        }
        continue
      }
      // A changed command, url or env restarts the server; so does an
      // unchanged one that failed before, so `/mcp reload` is also the way to
      // retry a server that was down when the daemon started.
      await stopRuntime(runtime)
      restarted.push(name)
    }

    const nextRuntimes: ServerRuntime[] = []
    const toStart: ServerRuntime[] = []
    for (const server of next.servers) {
      const runtime = current.get(server.name)
      if (!server.enabled) {
        if (runtime === undefined) added.push(server.name)
        nextRuntimes.push({
          config: server,
          state: 'disabled',
          tools: [],
          rawNames: [],
          hiddenProblems: [],
          policyProblems: [],
          closed: true,
        })
        continue
      }
      if (runtime !== undefined && !runtime.closed && runtime.state === 'ready' && sameServer(runtime.config, server)) {
        nextRuntimes.push(runtime)
        continue
      }
      if (runtime === undefined) added.push(server.name)
      const fresh: ServerRuntime = {
        config: server,
        state: 'starting',
        tools: [],
        rawNames: [],
        hiddenProblems: [],
        policyProblems: [],
      }
      nextRuntimes.push(fresh)
      toStart.push(fresh)
    }
    runtimes.splice(0, runtimes.length, ...nextRuntimes)

    connecting = Promise.allSettled(toStart.map((runtime) => connectOne(runtime))).then(() => undefined)
    await connecting
    log(
      redact(
        `mcp.json перечитан: добавлено ${added.length}, удалено ${removed.length}, ` +
          `перезапущено ${restarted.length}, обновлено ${updated.length}, без изменений ${unchanged.length}`,
      ),
    )
    return { ok: true, added, removed, restarted, updated, unchanged }
  }

  let reloadQueue: Promise<unknown> = Promise.resolve()

  function reload(): Promise<McpReloadReport> {
    const run = reloadQueue.then(() => doReload())
    reloadQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  connecting = Promise.allSettled(runtimes.map((runtime) => connectOne(runtime))).then(() => undefined)

  function toolOf(runtime: ServerRuntime, info: McpToolInfo): McpRunnerTool {
    return {
      name: info.name,
      description: info.description,
      inputSchema: info.inputSchema,
      lazy: true,
      indexed: false,
      guestAllowed: false,
      // The server's own annotations decide, read at call time so a policy-only
      // reload that adds `confirm` makes an already published tool a barrier.
      isConcurrencySafe: () =>
        info.readOnly &&
        !info.destructive &&
        !(runtime.config.confirm ?? []).includes(info.rawName),
      async execute(args, context) {
        const client = runtime.client
        if (client === undefined) {
          throw new Error(
            `MCP-сервер "${runtime.config.name}" не запущен: ${redact(runtime.error ?? 'нет соединения')}. ` +
              'Проверьте DSHBOT_HOME/mcp.json и /mcp.',
          )
        }
        // A policy-only reload keeps this runtime, so a tool published before
        // it must not outlive an `include` or `exclude` that now hides it.
        if (!visibleTools(runtime).some((tool) => tool.name === info.name)) {
          throw new Error(
            `MCP-инструмент "${info.name}" скрыт политикой сервера "${runtime.config.name}" в mcp.json (include/exclude).`,
          )
        }
        try {
          const result = await client.callTool(
            { name: info.rawName, arguments: args },
            {
              timeout: MCP_TOOL_TIMEOUT_MS,
              ...(context?.signal === undefined ? {} : { signal: context.signal }),
            },
          )
          // Every text part of the result is foreign content: the model reads
          // it inside the common frame, never as instructions of the owner.
          const text = redact(resultText(result.content))
          if (result.isError === true) throw new Error(text === '' ? 'MCP-сервер вернул ошибку' : text)
          return text === '' ? 'MCP-сервер вернул пустой результат.' : frameData(text, { source: `mcp ${info.name}` })
        } catch (error) {
          // The server may have died: the call must stay a readable tool error,
          // not a rejected daemon promise and not a stack in the chat. The text
          // of the error is foreign content too, so it is framed like a result.
          const message = cleanToolMessage(errorText(error))
          throw new Error(
            redact(
              `Ошибка MCP-инструмента "${info.name}" (сервер "${runtime.config.name}"):\n` +
                frameData(message === '' ? 'MCP-сервер вернул ошибку' : message, { source: `mcp ${info.name}` }),
            ),
          )
        }
      },
    }
  }

  function tools(): McpRunnerTool[] {
    return runtimes.flatMap((runtime) => visibleTools(runtime).map((info) => toolOf(runtime, info)))
  }

  return {
    tools,
    ready: () => connecting,
    isDestructive: (name) =>
      runtimes.some((runtime) => visibleTools(runtime).some((info) => info.name === name && info.destructive)),
    needsConfirmation: (name) =>
      runtimes.some((runtime) =>
        visibleTools(runtime).some(
          (info) => info.name === name && (runtime.config.confirm ?? []).includes(info.rawName),
        ),
      ),
    isReadOnly: (name) =>
      runtimes.some((runtime) => visibleTools(runtime).some((info) => info.name === name && info.readOnly)),
    status: () => [
      ...runtimes.map((runtime): McpServerState => {
        const tools = visibleTools(runtime)
        return {
          name: runtime.config.name,
          transport: runtime.config.transport,
          state: runtime.state,
          tools: tools.length,
          toolDetails: tools.map((tool) => ({ name: tool.name, description: tool.description })),
          ...(runtime.error === undefined ? {} : { error: runtime.error }),
        }
      }),
      ...problems.map(
        (problem): McpServerState => ({
          name: problem.name,
          transport: 'stdio',
          state: 'failed',
          tools: 0,
          toolDetails: [],
          error: problem.message,
        }),
      ),
    ],
    problems: () => [
      ...problems,
      ...runtimes.flatMap((runtime) =>
        runtime.hiddenProblems.map((message) => ({ name: `${runtime.config.name} (инструмент)`, message })),
      ),
    ],
    warnings: () =>
      runtimes.flatMap((runtime) =>
        runtime.policyProblems.map((message) => ({ name: `${runtime.config.name} (инструменты)`, message })),
      ),
    scrub: (text) => redact(text),
    reload,
    async stop() {
      if (stopped) return
      stopped = true
      await reloadQueue.catch(() => undefined)
      await connecting.catch(() => undefined)
      await Promise.all(runtimes.map(async (runtime) => stopRuntime(runtime)))
    },
  }
}

/** Reject after `ms` with a message that names the server; the caller closes the transport. */
async function withTimeout<T>(promise: Promise<T>, ms: number, server: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`нет ответа за ${Math.round(ms / 1000)} с`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
