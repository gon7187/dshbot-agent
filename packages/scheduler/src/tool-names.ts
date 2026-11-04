// Tool names in the text of a job. A planned run that names a tool the bot does
// not have gets "unknown tool" from the model host, answers [SILENT] and is
// recorded as ok, so the job silently does nothing. create and update compare
// the names of the text with the tools the run will actually receive.
//
// Two shapes are checked: the full `mcp__<server>__<tool>` and the bare tool
// name of the same family (`wb_get_stocks`: the text before the first
// underscore is the start of the bare name of some MCP tool). Ordinary words
// with an underscore (`report_date`) are not tools and pass. A server that is
// not connected now cannot be checked, so its names pass as well. A word that is
// part of a path or a file name (`/data/wb_hourly.json`, `wb_daily/`) is not a
// tool name either; a full stop that ends a sentence does not make a file name.

const MCP_PREFIX = 'mcp__'
const FULL_NAME = /mcp__[A-Za-z0-9_-]+/g
const WORD = /[A-Za-z0-9_-]+/g
const LISTED_TOOLS_LIMIT = 8
const PATH_SEPARATOR = /[/\\]/u
const FILE_EXTENSION = /^\.[A-Za-z0-9]/u

/** The tools one job is checked against. */
export interface ScheduleToolCatalog {
  /** Tools of every connected MCP server and the bot's own tools (a name without the `mcp__` prefix is an own tool). */
  all(): readonly string[]
  /** Tools the run of a job with this profile receives (profile tools, MCP names only if connected); an empty name is the ordinary run. */
  of(agent: string): readonly string[]
}

/** One name of the task that no run can call. */
export interface UnknownToolName {
  name: string
  /** The nearest existing name of the same family, if any. */
  nearest: string | undefined
  /** The name exists but the profile of the job does not hold it. */
  missingInProfile: boolean
}

function trimTail(token: string): string {
  return token.replace(/[-_]+$/u, '')
}

function serverOf(full: string): string | undefined {
  const rest = full.slice(MCP_PREFIX.length)
  const end = rest.indexOf('__')
  return end > 0 && end + 2 < rest.length ? rest.slice(0, end) : undefined
}

function bareOf(full: string): string {
  return full.slice(MCP_PREFIX.length + (serverOf(full)?.length ?? 0) + 2)
}

function familyOf(bare: string): string {
  const cut = bare.indexOf('_')
  return cut < 0 ? bare : bare.slice(0, cut)
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= b.length; j += 1) {
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    previous = row
  }
  return previous[b.length]!
}

/** The word at `start` is a segment of a path or a file name, not a tool name. */
function isPathPart(text: string, start: number, end: number): boolean {
  const before = text[start - 1]
  if (before !== undefined && PATH_SEPARATOR.test(before)) return true
  const after = text[end]
  if (after !== undefined && PATH_SEPARATOR.test(after)) return true
  return FILE_EXTENSION.test(text.slice(end, end + 2)) || (before === '.' && /[A-Za-z0-9]/u.test(text[start - 2] ?? ''))
}

function nearestOf(name: string, candidates: readonly string[], key: (candidate: string) => string): string | undefined {
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const d = distance(name, key(candidate))
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  return best
}

/** Names of the task that are neither tools of the run nor excused by an unconnected server. */
export function unknownToolNames(task: string, all: readonly string[], run: readonly string[]): UnknownToolName[] {
  const connected = all.filter((name) => name.startsWith(MCP_PREFIX) && serverOf(name) !== undefined)
  if (connected.length === 0) return []
  const servers = new Set(connected.map((name) => serverOf(name)))
  // The bot's own tools (web_search, web_fetch, ...) share a family with MCP
  // tools of the same name start, but they are real: never refused.
  const own = new Set(all.filter((name) => !name.startsWith(MCP_PREFIX)))
  const families = new Set(connected.map((name) => familyOf(bareOf(name))))
  const unknown: UnknownToolName[] = []
  const seen = new Set<string>()
  const add = (entry: UnknownToolName): void => {
    if (seen.has(entry.name)) return
    seen.add(entry.name)
    unknown.push(entry)
  }

  for (const match of task.matchAll(FULL_NAME)) {
    const name = trimTail(match[0])
    const server = serverOf(name)
    if (server === undefined || !servers.has(server) || run.includes(name)) continue
    if (all.includes(name)) add({ name, nearest: name, missingInProfile: true })
    else add({ name, nearest: nearestOf(name, connected, (candidate) => candidate), missingInProfile: false })
  }

  const bareText = task.replace(FULL_NAME, ' ')
  for (const match of bareText.matchAll(WORD)) {
    const name = trimTail(match[0])
    if (isPathPart(bareText, match.index, match.index + match[0].length)) continue
    if (!/^[A-Za-z]/u.test(name) || !name.includes('_') || !families.has(familyOf(name))) continue
    if (own.has(name)) continue
    if (run.some((full) => full.startsWith(MCP_PREFIX) && bareOf(full) === name)) continue
    const existing = connected.find((full) => bareOf(full) === name)
    if (existing !== undefined) add({ name, nearest: existing, missingInProfile: true })
    else {
      const sameFamily = connected.filter((full) => familyOf(bareOf(full)) === familyOf(name))
      add({ name, nearest: nearestOf(name, sameFamily, bareOf), missingInProfile: false })
    }
  }
  return unknown
}

/** The refusal text for create and update; undefined when the task names only tools the run can call. */
export function toolNamesRefusal(
  action: 'create' | 'update',
  task: string,
  agent: string,
  catalog: ScheduleToolCatalog | undefined,
): string | undefined {
  if (catalog === undefined) return undefined
  const all = catalog.all()
  // A profile may hold an MCP name the connected servers do not have; the run
  // cannot call it, so only names of the live catalog count as held.
  const run = catalog.of(agent).filter((name) => !name.startsWith(MCP_PREFIX) || all.includes(name))
  const unknown = unknownToolNames(task, all, run)
  if (unknown.length === 0) return undefined
  const lines = unknown.map((entry) => {
    if (entry.missingInProfile) {
      const held = run.slice(0, LISTED_TOOLS_LIMIT).join(', ')
      return (
        `"${entry.name}" нет у профиля агента "${agent}" ` +
        `(инструменты профиля: ${run.length === 0 ? 'нет' : held + (run.length > LISTED_TOOLS_LIMIT ? ', …' : '')})`
      )
    }
    return entry.nearest === undefined
      ? `инструмента "${entry.name}" нет`
      : `инструмента "${entry.name}" нет, ближайший существующий: "${entry.nearest}"`
  })
  return (
    `schedule ${action}: в task названы инструменты, которых у запуска нет: ${lines.join('; ')}. ` +
    `Задание ${action === 'create' ? 'не создано' : 'не изменено'}; исправь имена и повтори.`
  )
}
