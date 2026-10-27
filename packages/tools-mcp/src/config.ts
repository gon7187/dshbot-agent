// The MCP servers of the owner: `<DSHBOT_HOME>/mcp.json`, Claude Code format.
//
// The bot never adds a server itself and never writes this file: the list is
// read at start and again on `/mcp reload` from this one path. Other locations
// a client could look at (`<home>/.mcp.json`, `<home>/.claude.json`, `.mcp.json`
// in the workspace) are deliberately ignored, so the owner has exactly one
// place to describe servers.

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** File name inside `DSHBOT_HOME`. */
export const MCP_CONFIG_FILE = 'mcp.json'

/**
 * Per-server tool policy from `mcp.json`.
 *
 *   * `include`: only the listed raw tool names (as the server sends them, no
 *     `mcp__` prefix) are published to the model;
 *   * `exclude`: the listed raw names are hidden; it is applied after `include`,
 *     so a name in both lists stays hidden;
 *   * `confirm`: the listed raw names need the owner's button before they run;
 *   * `enabled: false`: the server is kept in the file but never started.
 *
 * Policy fields never change how the process or the connection is made, so a
 * reload can apply them to a live server; `enabled` is handled separately.
 */
export interface McpToolPolicy {
  /** `false` keeps the entry in the file but starts no process. Defaults to `true`. */
  readonly enabled: boolean
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly confirm?: readonly string[]
}

/** One stdio server of the owner. */
export interface McpStdioServer extends McpToolPolicy {
  readonly name: string
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** `cwd` of the server process; resolved against `DSHBOT_HOME` when relative. */
  readonly cwd?: string
}

/** One Streamable HTTP server of the owner. */
export interface McpHttpServer extends McpToolPolicy {
  readonly name: string
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

/**
 * One server of the old HTTP+SSE transport. A growing number of servers (the
 * ones moved over from OpenClaw among them) speak only this protocol, so it is
 * a first-class transport next to Streamable HTTP. The `type` key follows the
 * Claude Code format; `transport` is accepted as an alias.
 */
export interface McpSseServer extends McpToolPolicy {
  readonly name: string
  readonly transport: 'sse'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type McpServer = McpStdioServer | McpHttpServer | McpSseServer

/** One entry that could not be used, with a message fit for the owner. */
export interface McpConfigProblem {
  readonly name: string
  readonly message: string
}

export interface McpConfig {
  readonly servers: readonly McpServer[]
  readonly problems: readonly McpConfigProblem[]
}

/** Absolute path of the only MCP configuration the bot reads. */
export function mcpConfigPath(home: string): string {
  return join(resolve(home), MCP_CONFIG_FILE)
}

/** The harness names a tool `<server>__<tool>` under one namespace of at most 32 characters. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return value as string[]
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') result[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') result[key] = String(item)
    else return undefined
  }
  return result
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Place of a `JSON.parse` failure without a single character of the file.
 *
 * The engine quotes the source in its message (`Unexpected token ... "..." is
 * not valid JSON`, `Expected ... in JSON at position N`). The file may carry a
 * token in `env` or `headers`, and a broken file has no parsed servers to build
 * the scrub list from, so the quoted fragment can never reach the journal, the
 * report or the prompt. Only the numbers are kept.
 */
function jsonErrorPlace(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const where = /\bline (\d+) column (\d+)/.exec(message)
  if (where !== null) return ` (строка ${where[1]}, позиция ${where[2]})`
  const position = /\bposition (\d+)/.exec(message)
  return position === null ? '' : ` (позиция ${position[1]})`
}

/**
 * Read and validate `<home>/mcp.json`.
 *
 * A missing file means "no servers": the bot is not a client of anything until
 * the owner says so. A malformed file is reported as one problem and no server
 * starts; one malformed entry never hides the healthy ones.
 */
export function readMcpConfig(home: string): McpConfig {
  const path = mcpConfigPath(home)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], problems: [] }
    return { servers: [], problems: [{ name: MCP_CONFIG_FILE, message: `не удалось прочитать: ${describe(error)}` }] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      servers: [],
      problems: [{ name: MCP_CONFIG_FILE, message: `это не JSON: некорректный JSON${jsonErrorPlace(error)}` }],
    }
  }
  const root = asRecord(parsed)
  const entries = root?.mcpServers
  if (asRecord(entries) === undefined) {
    return {
      servers: [],
      problems: [{ name: MCP_CONFIG_FILE, message: 'нет объекта "mcpServers"' }],
    }
  }
  const servers: McpServer[] = []
  const problems: McpConfigProblem[] = []
  const seen = new Set<string>()
  for (const [name, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (!SERVER_NAME.test(name)) {
      problems.push({ name, message: 'имя сервера должно состоять из [A-Za-z0-9_-], до 32 символов' })
      continue
    }
    if (seen.has(name)) {
      problems.push({ name, message: 'сервер с таким именем уже объявлен' })
      continue
    }
    const entry = asRecord(raw)
    if (entry === undefined) {
      problems.push({ name, message: 'описание сервера должно быть объектом' })
      continue
    }
    // Tool policy is common to every transport. A wrong type is a problem of
    // this entry alone: the healthy servers of the same file still start.
    const policy: {
      enabled: boolean
      include?: readonly string[]
      exclude?: readonly string[]
      confirm?: readonly string[]
    } = { enabled: true }
    let policyOk = true
    for (const key of ['include', 'exclude', 'confirm'] as const) {
      const value = entry[key]
      if (value === undefined) continue
      const list = strings(value)
      if (list === undefined) {
        problems.push({ name, message: `"${key}" должен быть массивом строк` })
        policyOk = false
        break
      }
      policy[key] = list
    }
    if (!policyOk) continue
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') {
        problems.push({ name, message: '"enabled" должен быть boolean (true или false)' })
        continue
      }
      policy.enabled = entry.enabled
    }
    if (typeof entry.command === 'string' && entry.command.trim() !== '') {
      const args = entry.args === undefined ? [] : strings(entry.args)
      if (args === undefined) {
        problems.push({ name, message: '"args" должен быть массивом строк' })
        continue
      }
      const env = entry.env === undefined ? {} : stringMap(entry.env)
      if (env === undefined) {
        problems.push({ name, message: '"env" должен быть объектом строковых значений' })
        continue
      }
      const cwd = entry.cwd
      if (cwd !== undefined && typeof cwd !== 'string') {
        problems.push({ name, message: '"cwd" должен быть строкой' })
        continue
      }
      seen.add(name)
      servers.push({
        name,
        transport: 'stdio',
        command: entry.command,
        args,
        env,
        ...policy,
        ...(typeof cwd !== 'string'
          ? {}
          : { cwd: isAbsolute(cwd) ? cwd : resolve(home, cwd) }),
      })
      continue
    }
    if (typeof entry.url === 'string' && entry.url.trim() !== '') {
      const headers = entry.headers === undefined ? {} : stringMap(entry.headers)
      if (headers === undefined) {
        problems.push({ name, message: '"headers" должен быть объектом строковых значений' })
        continue
      }
      const declared = entry.type ?? entry.transport
      if (declared !== undefined && typeof declared !== 'string') {
        problems.push({ name, message: '"type" должен быть строкой: "stdio", "streamable-http" или "sse"' })
        continue
      }
      const transport =
        declared === 'sse'
          ? 'sse'
          : declared === undefined || declared === 'http' || declared === 'streamable-http'
            ? 'streamable-http'
            : undefined
      if (transport === undefined) {
        problems.push({ name, message: `неизвестный транспорт "${String(declared)}": нужен "sse" или "streamable-http"` })
        continue
      }
      seen.add(name)
      servers.push(
        transport === 'sse'
          ? { name, transport, url: entry.url, headers, ...policy }
          : { name, transport: 'streamable-http', url: entry.url, headers, ...policy },
      )
      continue
    }
    problems.push({ name, message: 'нужен "command" (stdio) или "url" (streamable-http или sse)' })
  }
  return { servers, problems }
}
