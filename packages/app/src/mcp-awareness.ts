// What `main` and the owner know about the MCP servers of `<DSHBOT_HOME>/mcp.json`.
//
// Two shapes of the same facts:
//
//   * the tail insertion of an owner turn, a short block with the name,
//     transport, number of tools and state of every server plus the rule of
//     calling a tool through `tool_search`. It is a service insertion, never a
//     part of the stable system prefix: the cache of the session must not break
//     when a server is added or fixed on the next daemon restart;
//   * the `/mcp` report: the same servers with their tools (name and the first
//     line of the description), the entries of `mcp.json` that could not be
//     parsed, the path of the file and the restart reminder;
//   * the single `/status` line with the counts.
//
// The text of the insertion is a constant here, next to the other formatting of
// the same facts, so the tail and `/mcp` never drift apart. Nothing here prints
// a value of `env` or `headers` of `mcp.json`: the report uses only names,
// transports, counts and the state text of the client, which scrubs those
// values itself.

import type { McpConfigProblem, McpReloadReport, McpServerState } from '../../tools-mcp/src/index.js'

/** Title of the tail block and of the `/mcp` report. */
export const MCP_SERVERS_TITLE = 'MCP-серверы владельца'

/**
 * The rule of the tail: the tools are not in the schema, only `tool_search`
 * reaches them. A model that does not know this hunts for `mcp.json` instead of
 * searching by the tool name.
 */
export const MCP_SERVERS_RULE =
  'Инструменты этих серверов не входят в набор напрямую: их вызывают через tool_search по имени ' +
  'mcp__<server>__<tool> — сначала найди инструмент поиском, затем вызови найденное имя. ' +
  'Значения env и headers из mcp.json не показывай и не пересказывай.'

/** Human word for the transport of a server: the owner sees `stdio`, `http` or `sse`. */
export function mcpTransportLabel(transport: McpServerState['transport']): string {
  if (transport === 'stdio') return 'stdio'
  if (transport === 'sse') return 'sse'
  return 'http'
}

/** Cap on one error string of a server: the tail and the report stay short. */
export const MCP_STATE_ERROR_CHARS = 240

/**
 * One-line state of a server: the number of its tools is always there, even for
 * a server that never connected (then it is `0`), so every line of the list
 * carries the same four facts: name, transport, tools and state.
 */
export function mcpStateText(state: McpServerState): string {
  if (state.state === 'ready') return `подключён, инструментов ${state.tools}`
  if (state.state === 'failed') return `инструментов ${state.tools}, ошибка: ${shortError(state.error)}`
  if (state.state === 'starting') return `запускается, инструментов ${state.tools}`
  if (state.state === 'disabled') return `выключен, инструментов ${state.tools}`
  return `остановлен, инструментов ${state.tools}`
}

/** Short readable error of a server: never empty, never longer than the cap. */
function shortError(error: string | undefined): string {
  const text = error === undefined ? '' : error.trim()
  if (text === '') return 'не удалось подключиться'
  return text.length > MCP_STATE_ERROR_CHARS ? `${text.slice(0, MCP_STATE_ERROR_CHARS - 1)}…` : text
}

/** One server line of the insertion and of `/mcp`. */
export function mcpServerLine(state: McpServerState): string {
  return `- ${state.name} (${mcpTransportLabel(state.transport)}): ${mcpStateText(state)}`
}

/**
 * The block for the tail of an owner turn: `''` when `mcp.json` declares no
 * server, so an installation without MCP keeps the turn exactly as before.
 */
export function mcpAwarenessText(servers: readonly McpServerState[]): string {
  if (servers.length === 0) return ''
  const list = servers.map(mcpServerLine).join('\n')
  return [MCP_SERVERS_TITLE, '', list, '', MCP_SERVERS_RULE].join('\n')
}

function plural(count: number, one: string, few: string, many: string): string {
  const tail = count % 100
  if (tail >= 11 && tail <= 14) return many
  const last = count % 10
  if (last === 1) return one
  if (last >= 2 && last <= 4) return few
  return many
}

/** The one `/status` line: servers, their tools and the entries with a problem. */
export function mcpStatusLine(
  servers: readonly McpServerState[],
  problems: readonly McpConfigProblem[],
): string {
  const tools = servers.reduce((sum, server) => sum + server.tools, 0)
  const errors = servers.filter((server) => server.state === 'failed').length + problems.length
  return (
    `MCP: ${servers.length} ${plural(servers.length, 'сервер', 'сервера', 'серверов')}, ` +
    `${tools} ${plural(tools, 'инструмент', 'инструмента', 'инструментов')}, ` +
    `${errors} с ошибкой`
  )
}

/** First line of a tool description, as `/mcp` shows it. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? ''
}

/** Servers, their tools, the broken entries of the file, its warnings and its path. */
function reportBody(
  servers: readonly McpServerState[],
  problems: readonly McpConfigProblem[],
  configPath: string,
  warnings: readonly McpConfigProblem[] = [],
): string[] {
  const lines: string[] = []
  if (servers.length === 0) {
    lines.push('', 'Серверов нет.')
  } else {
    lines.push('')
    for (const server of servers) {
      lines.push(mcpServerLine(server))
      for (const tool of server.toolDetails) {
        const description = firstLine(tool.description)
        lines.push(description === '' ? `    ${tool.name}` : `    ${tool.name} — ${description}`)
      }
    }
  }
  if (problems.length > 0) {
    lines.push('', 'Проблемы mcp.json:')
    for (const problem of problems) lines.push(`- ${problem.name}: ${problem.message}`)
  }
  if (warnings.length > 0) {
    lines.push('', 'Предупреждения mcp.json:')
    for (const warning of warnings) lines.push(`- ${warning.name}: ${warning.message}`)
  }
  lines.push('', `Файл: ${configPath}`)
  return lines
}

/** The owner command `/mcp`: servers, tools, problems of the file and the reload hint. */
export function formatMcpReport(
  servers: readonly McpServerState[],
  problems: readonly McpConfigProblem[],
  configPath: string,
  warnings: readonly McpConfigProblem[] = [],
): string {
  return [
    MCP_SERVERS_TITLE,
    ...reportBody(servers, problems, configPath, warnings),
    'Изменения применяются командой /mcp reload.',
  ].join('\n')
}

function nameList(names: readonly string[]): string {
  return names.length === 0 ? 'нет' : names.join(', ')
}

/**
 * The answer to `/mcp reload`: what changed, then the same server list as
 * `/mcp` so every server has a visible result, including the one that failed.
 */
export function formatMcpReloadReport(
  report: McpReloadReport,
  servers: readonly McpServerState[],
  problems: readonly McpConfigProblem[],
  configPath: string,
  warnings: readonly McpConfigProblem[] = [],
): string {
  const lines: string[] = [MCP_SERVERS_TITLE]
  if (!report.ok) {
    lines.push(
      '',
      `Перезагрузка не выполнена: ${shortError(report.error)}.`,
      'Работающие серверы не остановлены и не перезапущены.',
    )
  } else {
    lines.push(
      '',
      'mcp.json перечитан, демон не перезапускался.',
      `Добавлены: ${nameList(report.added)}`,
      `Остановлены: ${nameList(report.removed)}`,
      `Перезапущены: ${nameList(report.restarted)}`,
      `Обновлены без перезапуска: ${nameList(report.updated)}`,
      `Без изменений: ${nameList(report.unchanged)}`,
    )
  }
  lines.push(...reportBody(servers, problems, configPath, warnings))
  return lines.join('\n')
}
