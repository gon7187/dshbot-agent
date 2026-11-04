// Money accounting of the daemon (DESIGN §10, §11): every model call becomes one
// row of the `usage` table, priced with the deterministic guard table. Unknown
// prices stay NULL and are reported on their own line, never summed as zero.
// There are no caps here on purpose: the owner's decision is "count, do not limit".

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { costOf } from '../../guard/src/index.js'
import type { RunnerTool, RunnerUsage } from '../../runner/src/index.js'
import type { Store, Usage, UsageJobSummary, UsageReport, UsageSummary } from '../../store/src/index.js'

/** Turns one harness usage report into a priced store row. */
export function createUsageRecorder(store: Store): (usage: RunnerUsage) => void {
  return (usage) => {
    const costUsd = costOf(usage.model, {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
    })
    store.usage.record({ ...usage, costUsd })
  }
}

/** Three decimals keep a single cheap call visible; the report is not an invoice. */
function usd(value: number): string {
  return `$${value.toFixed(3)}`
}

function share(report: UsageReport): string {
  return report.cacheReadShare === null ? 'нет данных' : `${Math.round(report.cacheReadShare * 100)}%`
}

/** Owner `/budget`: today, seven and thirty day dollars plus the cache share and call counts. */
export function budgetText(report: UsageReport): string {
  return [
    'Расходы на модель:',
    `Сегодня: ${usd(report.today.costUsd)} (вызовов: ${report.today.calls})`,
    `7 дней: ${usd(report.last7Days.costUsd)} (вызовов: ${report.last7Days.calls})`,
    `30 дней: ${usd(report.last30Days.costUsd)} (вызовов: ${report.last30Days.calls})`,
    `Доля cacheRead во входе: ${share(report)}`,
    `Вызовов без цены за 30 дней: ${report.last30Days.unpricedCalls}`,
  ].join('\n')
}

/** Owner `/status`: today's spend on one line. */
export function statusText(report: UsageReport): string {
  return `Сегодня: ${usd(report.today.costUsd)} (вызовов: ${report.today.calls})`
}

/** The three windows of `/tokens` and of the owner's summary tool. */
export interface TokenWindows {
  /** Calls since 00:00 UTC, the same boundary as `/budget`. */
  today: UsageSummary
  /** Calls in the rolling seven days. */
  last7Days: UsageSummary
  /** Calls in the rolling thirty days. */
  last30Days: UsageSummary
  /** Calls since the current `main` session began (the last `/new`, or the daemon start). */
  session: UsageSummary
}

/**
 * Token report windows of the owner's usage table. The session boundary is the
 * start of the current `main` session, so calls of delegated child sessions in
 * that period are included and rows written before `/new` are not.
 */
export function tokenWindows(usage: Usage, sessionStart: number, now = Date.now()): TokenWindows {
  const report = usage.report(now)
  return {
    today: report.today,
    last7Days: report.last7Days,
    last30Days: report.last30Days,
    session: usage.summarySince(sessionStart),
  }
}

function tokenBlock(title: string, summary: UsageSummary): string {
  return [
    `${title}:`,
    `вход: ${summary.inputTokens}`,
    `чтение кэша: ${summary.cacheReadTokens}`,
    `запись в кэш: ${summary.cacheWriteTokens}`,
    `выход: ${summary.outputTokens}`,
    `сумма: ${usd(summary.costUsd)}`,
  ].join('\n')
}

/** Owner `/tokens`: the three windows with the token split and an estimated price. */
export function tokensText(windows: TokenWindows): string {
  return [
    'Расход токенов (оценка по прайсу модели, не счёт провайдера):',
    '',
    tokenBlock('Сегодня', windows.today),
    '',
    tokenBlock('30 дней', windows.last30Days),
    '',
    tokenBlock('Сессия', windows.session),
    `Вызовов без цены: ${windows.last30Days.unpricedCalls}`,
  ].join('\n')
}

/** Name of the owner-only read-only usage tool; no guest schema carries it. */
export const USAGE_SUMMARY_TOOL_NAME = 'usage_summary'

export interface UsageSummaryToolOptions {
  usage: Usage
  /** Start of the current `main` session, read at call time (it moves on `/new`). */
  sessionStart: () => number
  /** Clock seam of the tests; `Date.now` in the daemon. */
  now?: () => number
  /** `dsh/sessions` directory; without it the `speed` report has no logs to read. */
  sessionsDir?: string
  /** Task text of a schedule job by id, for the per-job rows; absent for a removed job. */
  jobTask?: (jobId: string) => string | undefined
}

/** One schedule job's planned-run spend; owner turns carry no job id and are not in these rows. */
function jobRows(options: UsageSummaryToolOptions, now: number): (UsageJobSummary & { task?: string })[] {
  return options.usage.jobsSince(now - WEEK_MS).map((row) => {
    const task = options.jobTask?.(row.jobId)
    return task === undefined ? row : { ...row, task }
  })
}

const HOUR_MS = 3_600_000
const WEEK_MS = 7 * 24 * HOUR_MS
/** Window of the `speed` report. */
const SPEED_WINDOW_HOURS = 24
/** Longest tools listed by the `speed` report. */
const SPEED_TOOL_LIMIT = 8

/** Nearest-rank percentile of an ascending list; null for an empty list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
}

function seconds(ms: number): number {
  return Math.round(ms) / 1000
}

function spread(values: number[]): { p50: number | null; p90: number | null } {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number | null => {
    const value = percentile(sorted, p)
    return value === null ? null : seconds(value)
  }
  return { p50: at(50), p90: at(90) }
}

interface LogEvent {
  type: string
  time: number
  data: Record<string, unknown>
}

function parseEvents(path: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      const event = JSON.parse(line) as Partial<LogEvent>
      if (typeof event.type === 'string' && typeof event.time === 'number') {
        events.push({ type: event.type, time: event.time, data: event.data ?? {} })
      }
    } catch {
      // A torn last line of a live log is not an event.
    }
  }
  return events
}

function resultText(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => ((part as { text?: unknown }).text as string | undefined) ?? '').join('\n')
}

/** Raw measurements of the `main` logs, all inside the window. */
interface SpeedSamples {
  turns: number
  steps: number[]
  firstSteps: number[]
  tools: Map<string, number[]>
  toolSearchCalls: number
  unknownToolErrors: number
  compactions: number
}

/**
 * Reads one session log. A turn counts for the owner only when it holds a
 * `user/message`: the runner writes the cancellation note as a separate turn
 * without one, and that note is not the owner's wait. Only finished turns count.
 */
function collectSpeed(events: LogEvent[], since: number, samples: SpeedSamples): void {
  let turn: { start: number; owner: boolean; steps: number[] } | undefined
  let pendingOwner = false
  let stepStart: number | undefined
  const calls = new Map<string, { name: string; time: number }>()
  const flush = (finished: boolean): void => {
    if (finished && turn !== undefined && turn.owner && turn.start >= since) {
      samples.turns += 1
      samples.steps.push(...turn.steps)
      if (turn.steps.length > 0) samples.firstSteps.push(turn.steps[0]!)
    }
    turn = undefined
    pendingOwner = false
    stepStart = undefined
  }
  for (const event of events) {
    const { data } = event
    if (event.type === 'turn/start') {
      flush(false)
      turn = { start: event.time, owner: pendingOwner, steps: [] }
    } else if (event.type === 'user/message') {
      if (turn === undefined) pendingOwner = true
      else turn.owner = true
    } else if (event.type === 'step/start') {
      stepStart = event.time
    } else if (event.type === 'assistant/message') {
      if (turn !== undefined && stepStart !== undefined) turn.steps.push(event.time - stepStart)
      stepStart = undefined
    } else if (event.type === 'turn/end') {
      flush(true)
    } else if (event.type === 'tool/call') {
      if (typeof data.callId === 'string' && typeof data.name === 'string') {
        calls.set(data.callId, { name: data.name, time: event.time })
        if (data.name === 'tool_search' && event.time >= since) samples.toolSearchCalls += 1
      }
    } else if (event.type === 'tool/result') {
      const id = (data.message as { toolCallId?: unknown } | undefined)?.toolCallId
      const call = typeof id === 'string' ? calls.get(id) : undefined
      if (call !== undefined && call.time >= since) {
        const durations = samples.tools.get(call.name) ?? []
        durations.push(event.time - call.time)
        samples.tools.set(call.name, durations)
      }
      if (event.time >= since && /unknown tool/i.test(resultText(data))) samples.unknownToolErrors += 1
    } else if (event.type === 'compaction/prune' && event.time >= since) {
      samples.compactions += 1
    }
  }
  // A turn without `turn/end` is still running (the one that asked for this report): not a sample.
  flush(false)
}

/** Speed report of the last day: model steps, tool latency, prompt size and compactions of `main`. */
function speedReport(options: UsageSummaryToolOptions, now: number): Record<string, unknown> {
  const since = now - SPEED_WINDOW_HOURS * HOUR_MS
  const samples: SpeedSamples = {
    turns: 0, steps: [], firstSteps: [], tools: new Map(), toolSearchCalls: 0, unknownToolErrors: 0, compactions: 0,
  }
  if (options.sessionsDir !== undefined) {
    let names: string[] = []
    try {
      names = readdirSync(options.sessionsDir).filter((name) => name === 'main' || name.startsWith('main.bak-'))
    } catch {
      // No sessions directory yet: the report says there is no data.
    }
    for (const name of names) {
      const path = join(options.sessionsDir, name, 'events.jsonl')
      try {
        if (statSync(path).mtimeMs < since) continue
        collectSpeed(parseEvents(path), since, samples)
      } catch {
        // An unreadable archive must not hide the others.
      }
    }
  }
  if (samples.turns === 0) return { windowHours: SPEED_WINDOW_HOURS, note: 'нет данных: за последние 24 часа нет ходов владельца в журналах' }
  const tools = [...samples.tools.entries()]
    .map(([name, durations]) => ({ name, calls: durations.length, ...spreadSeconds(durations) }))
    .sort((a, b) => b.p90Seconds! - a.p90Seconds! || b.p50Seconds! - a.p50Seconds! || a.name.localeCompare(b.name))
    .slice(0, SPEED_TOOL_LIMIT)
  const prompt = options.usage.promptSince('main', since)
  const model = spread(samples.steps)
  const first = spread(samples.firstSteps)
  return {
    windowHours: SPEED_WINDOW_HOURS,
    ownerTurns: samples.turns,
    modelSteps: samples.steps.length,
    stepsPerTurn: Math.round((samples.steps.length / samples.turns) * 100) / 100,
    modelStepSeconds: { p50: model.p50, p90: model.p90 },
    firstStepSeconds: { p50: first.p50, p90: first.p90 },
    slowestTools: tools,
    tool_search_calls: samples.toolSearchCalls,
    unknown_tool_errors: samples.unknownToolErrors,
    mainAveragePromptTokens: prompt.averagePromptTokens === null ? 'нет данных' : Math.round(prompt.averagePromptTokens),
    mainCompactions: samples.compactions,
  }
}

function spreadSeconds(durations: number[]): { p50Seconds: number | null; p90Seconds: number | null } {
  const { p50, p90 } = spread(durations)
  return { p50Seconds: p50, p90Seconds: p90 }
}

/**
 * Read-only tool of the owner's turn: the same three windows as `/tokens`, as
 * JSON for the model. It reads the usage table and never records a row, so the
 * ordinary per-call accounting of the turn stays the only writer.
 */
export function createUsageSummaryTool(options: UsageSummaryToolOptions): RunnerTool {
  return {
    name: USAGE_SUMMARY_TOOL_NAME,
    description:
      'Сводка расхода токенов: сегодня (с полуночи UTC), 7 дней, 30 дней и текущая сессия с последнего /new, ' +
      'включая дочерние сессии. Для каждого окна input, cache read, cache write, output и оценка ' +
      'стоимости по прайсу модели; вызовы без известной цены учтены отдельно. ' +
      'scheduleJobsLast7Days — отдельная строка на каждое задание расписания (вызовы плановых запусков, без ходов владельца).',
    inputSchema: {
      type: 'object',
      properties: {
        speed: {
          type: 'boolean',
          description:
            'true — вместо токенов показать скорость за 24 часа: ходы владельца и шаги модели, ' +
            'p50/p90 шага и первого шага, самые долгие инструменты, tool_search, unknown tool, ' +
            'средний промпт main и число сжатий.',
        },
      },
      additionalProperties: false,
    },
    execute(args?: Record<string, unknown>): string {
      const now = options.now === undefined ? Date.now() : options.now()
      if (args?.speed === true) return JSON.stringify(speedReport(options, now), null, 2)
      const windows = tokenWindows(options.usage, options.sessionStart(), now)
      const jobs = jobRows(options, now)
      return JSON.stringify(
        {
          today: windows.today,
          last7Days: windows.last7Days,
          last30Days: windows.last30Days,
          session: windows.session,
          ...(jobs.length === 0 ? {} : { scheduleJobsLast7Days: jobs }),
          note: 'Суммы — оценка по прайсу модели, не счёт провайдера.',
        },
        null,
        2,
      )
    },
  }
}

/** Token usage of one owner turn, as the runner reported it. */
export interface TurnFooterUsage {
  model: string
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  cacheWriteTokens?: number
}

/**
 * Footer of `/usage on`: the model, the tokens of this turn and its price from
 * the guard table. An unknown model keeps the token line and says so instead
 * of pretending the call was free.
 */
export function turnFooterText(usage: TurnFooterUsage): string {
  const costUsd = costOf(usage.model, {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
  })
  const price = costUsd === null ? 'цена неизвестна' : usd(costUsd)
  return [
    `Модель: ${usage.model}`,
    `вход: ${usage.inputTokens} (кэш: ${usage.cacheReadTokens})`,
    `выход: ${usage.outputTokens}`,
    `стоимость: ${price}`,
  ].join(' · ')
}

/** Token counts of one or several model calls; the model route is the base's. */
export interface TurnTokens {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** `base` plus `extra`; either may be absent when its turn made no completed call. */
export function addTurnUsage<T extends TurnTokens>(base: T | undefined, extra: T | undefined): T | undefined {
  if (extra === undefined) return base
  if (base === undefined) return extra
  return {
    ...base,
    inputTokens: base.inputTokens + extra.inputTokens,
    cacheReadTokens: base.cacheReadTokens + extra.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + extra.cacheWriteTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
  }
}

/**
 * Runs a follow-up turn of the same owner turn (the promised-work nudge) and
 * adds its usage to `base` exactly once: from its own outcome when it
 * finished, from `failedUsage(error)` when it threw. The usage of the turn
 * before it is never taken again, so a failed follow-up does not double it.
 * `outcome` is absent when the follow-up threw; the caller keeps its own.
 */
export async function withFollowUpUsage<O extends { usage?: T }, T extends TurnTokens>(
  base: T | undefined,
  run: () => Promise<O>,
  failedUsage: (error: unknown) => T | undefined,
): Promise<{ outcome?: O; error?: unknown; usage: T | undefined }> {
  try {
    const outcome = await run()
    return { outcome, usage: addTurnUsage(base, outcome.usage) }
  } catch (error) {
    return { error, usage: addTurnUsage(base, failedUsage(error)) }
  }
}
