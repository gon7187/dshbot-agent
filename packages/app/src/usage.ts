// Money accounting of the daemon (DESIGN §10, §11): every model call becomes one
// row of the `usage` table, priced with the deterministic guard table. Unknown
// prices stay NULL and are reported on their own line, never summed as zero.
// There are no caps here on purpose: the owner's decision is "count, do not limit".

import { costOf } from '../../guard/src/index.js'
import type { RunnerTool, RunnerUsage } from '../../runner/src/index.js'
import type { Store, Usage, UsageReport, UsageSummary } from '../../store/src/index.js'

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
      'Сводка расхода токенов: сегодня (с полуночи UTC), 30 дней и текущая сессия с последнего /new, ' +
      'включая дочерние сессии. Для каждого окна input, cache read, cache write, output и оценка ' +
      'стоимости по прайсу модели; вызовы без известной цены учтены отдельно.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute(): string {
      const now = options.now === undefined ? Date.now() : options.now()
      const windows = tokenWindows(options.usage, options.sessionStart(), now)
      return JSON.stringify(
        {
          today: windows.today,
          last30Days: windows.last30Days,
          session: windows.session,
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
