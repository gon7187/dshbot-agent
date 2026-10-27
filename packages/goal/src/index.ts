// Durable goals and iteration loops: the state that lets the bot keep working
// on a condition without the owner in the chat.
//
// This package owns no model and no Telegram API. It keeps the goal (and the
// iteration loops) in the daemon's key-value store, builds the service
// insertion of a continuation turn, asks the small judge model whether the
// condition is met, and measures what the main session spent from its durable
// event log.

import { readFileSync, statSync } from 'node:fs'
import { costOf, DEFAULT_PRICES, type TokenUsage } from '../../guard/src/index.js'

/** kv key of the single active goal. */
export const GOAL_KV_KEY = 'goal.active'

/** kv key of the iteration loops (`/loop <task>` without an interval). */
export const LOOPS_KV_KEY = 'loop.active'

/** kv key of the interval loops kept in the schedule registry (`/loop 5m <task>`). */
export const SCHEDULED_LOOPS_KV_KEY = 'loop.scheduled'

/** Model used by the judge; the same one as the owner session. */
export const JUDGE_MODEL = 'deepseek-flash'

/** Same prices as the daemon's usage ledger, in USD per million tokens. */
export const INPUT_USD_PER_MTOK = DEFAULT_PRICES[JUDGE_MODEL].input
export const OUTPUT_USD_PER_MTOK = DEFAULT_PRICES[JUDGE_MODEL].output

/** What the judge answered about one turn. */
export interface CycleVerdict {
  done: boolean
  reason: string
}

/** One active goal. `token` invalidates continuation rows of a replaced goal. */
export interface GoalState {
  token: string
  condition: string
  turns: number
  spendUsd: number
  /** Byte offset in the main session log that the spend is already counted up to. */
  usageOffset: number
  startedAt: number
  lastReason?: string
  threadId?: number
}

/** One active iteration loop (`/loop <task>` without an interval). */
export interface LoopState extends GoalState {
  id: string
}

/** One interval loop: a repeating row of the schedule registry. */
export interface ScheduledLoop {
  /** Id of the schedule row; the owner stops the loop by it. */
  id: string
  task: string
  intervalMs: number
  createdAt: number
}

/** The part of the daemon store this package needs. */
export interface GoalStorage {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export interface GoalStore {
  loadGoal(): GoalState | undefined
  saveGoal(state: GoalState): void
  clearGoal(): void
  listLoops(): LoopState[]
  saveLoop(state: LoopState): void
  getLoop(token: string): LoopState | undefined
  removeLoop(token: string): boolean
  listScheduledLoops(): ScheduledLoop[]
  saveScheduledLoop(state: ScheduledLoop): void
  removeScheduledLoop(id: string): boolean
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizedGoal(value: unknown): GoalState | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.token !== 'string' || raw.token === '') return undefined
  if (typeof raw.condition !== 'string' || raw.condition.trim() === '') return undefined
  return {
    token: raw.token,
    condition: raw.condition,
    turns: isFiniteNumber(raw.turns) && raw.turns >= 0 ? Math.trunc(raw.turns) : 0,
    spendUsd: isFiniteNumber(raw.spendUsd) && raw.spendUsd >= 0 ? raw.spendUsd : 0,
    usageOffset: isFiniteNumber(raw.usageOffset) && raw.usageOffset >= 0 ? Math.trunc(raw.usageOffset) : 0,
    startedAt: isFiniteNumber(raw.startedAt) ? raw.startedAt : Date.now(),
    ...(typeof raw.lastReason === 'string' ? { lastReason: raw.lastReason } : {}),
    ...(isFiniteNumber(raw.threadId) ? { threadId: Math.trunc(raw.threadId) } : {}),
  }
}

/** Open the durable goal state in the daemon's kv store. */
export function createGoalStore(storage: GoalStorage): GoalStore {
  function loadGoal(): GoalState | undefined {
    return normalizedGoal(parseJson<unknown>(storage.get(GOAL_KV_KEY)))
  }

  function saveGoal(state: GoalState): void {
    storage.set(GOAL_KV_KEY, JSON.stringify(state))
  }

  function clearGoal(): void {
    storage.set(GOAL_KV_KEY, '')
  }

  function listLoops(): LoopState[] {
    const raw = parseJson<unknown>(storage.get(LOOPS_KV_KEY))
    if (!Array.isArray(raw)) return []
    const loops: LoopState[] = []
    for (const item of raw) {
      const goal = normalizedGoal(item)
      if (goal === undefined) continue
      const id = (item as Record<string, unknown>).id
      if (typeof id !== 'string' || id === '') continue
      loops.push({ ...goal, id })
    }
    return loops
  }

  function saveLoop(state: LoopState): void {
    const loops = listLoops().filter((loop) => loop.token !== state.token && loop.id !== state.id)
    loops.push(state)
    storage.set(LOOPS_KV_KEY, JSON.stringify(loops))
  }

  function getLoop(token: string): LoopState | undefined {
    return listLoops().find((loop) => loop.token === token)
  }

  function removeLoop(token: string): boolean {
    const loops = listLoops()
    const rest = loops.filter((loop) => loop.token !== token)
    if (rest.length === loops.length) return false
    storage.set(LOOPS_KV_KEY, rest.length === 0 ? '' : JSON.stringify(rest))
    return true
  }

  function listScheduledLoops(): ScheduledLoop[] {
    const raw = parseJson<unknown>(storage.get(SCHEDULED_LOOPS_KV_KEY))
    if (!Array.isArray(raw)) return []
    const loops: ScheduledLoop[] = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || record.id === '') continue
      if (typeof record.task !== 'string' || record.task.trim() === '') continue
      if (!isFiniteNumber(record.intervalMs) || record.intervalMs <= 0) continue
      loops.push({
        id: record.id,
        task: record.task,
        intervalMs: Math.trunc(record.intervalMs),
        createdAt: isFiniteNumber(record.createdAt) ? record.createdAt : Date.now(),
      })
    }
    return loops
  }

  function saveScheduledLoop(state: ScheduledLoop): void {
    const loops = listScheduledLoops().filter((loop) => loop.id !== state.id)
    loops.push(state)
    storage.set(SCHEDULED_LOOPS_KV_KEY, JSON.stringify(loops))
  }

  function removeScheduledLoop(id: string): boolean {
    const loops = listScheduledLoops()
    const rest = loops.filter((loop) => loop.id !== id)
    if (rest.length === loops.length) return false
    storage.set(SCHEDULED_LOOPS_KV_KEY, rest.length === 0 ? '' : JSON.stringify(rest))
    return true
  }

  return {
    loadGoal,
    saveGoal,
    clearGoal,
    listLoops,
    saveLoop,
    getLoop,
    removeLoop,
    listScheduledLoops,
    saveScheduledLoop,
    removeScheduledLoop,
  }
}

/** Human text of `/goal` without an argument. */
export function formatGoal(state: GoalState): string {
  return [`Цель: ${state.condition}`, `Ходов: ${state.turns}`, `Расход: $${state.spendUsd.toFixed(4)}`].join('\n')
}

/** The shortest interval `/loop <interval> <task>` accepts. */
export const MIN_LOOP_INTERVAL_MS = 5 * 60_000

/**
 * Parse the interval token of `/loop 5m <task>` (`5m`, `30m`, `1h`, `1d`).
 * Returns undefined when the token is not an interval at all; a valid but too
 * short interval is returned and the caller rejects it with the minimum.
 */
export function parseLoopInterval(token: string): number | undefined {
  const match = /^(\d+)\s*([mhd])$/i.exec(token.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined
  const unit = (match[2] as string).toLowerCase()
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const ms = amount * factor
  return Number.isSafeInteger(ms) ? ms : undefined
}

/** One short owner-facing line about a loop iteration. */
export function formatProgress(id: string, turns: number, reason: string): string {
  const tail = reason.trim() === '' ? 'продолжаю.' : `продолжаю — ${reason.trim()}`
  const text = `Итерация ${turns} (${id}): ${tail}`
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}

/** The service insertion of a continuation turn. */
export function continuationPrompt(condition: string, reason: string): string {
  const left = reason.trim() === '' ? 'проверь, что осталось' : reason.trim()
  return `продолжай к цели: ${condition}; что осталось по мнению судьи: ${left}`
}

/** The owner-facing report of a reached limit. */
export function limitReport(maxTurns: number, maxUsd: number, turns: number, spendUsd: number): string {
  return (
    `Предел цели достигнут: ${turns} ход(ов), расход $${spendUsd.toFixed(4)}. ` +
    `Лимиты: ${maxTurns} ход(ов) и $${maxUsd}. Цель снята; скажите /goal, чтобы посмотреть, или поставьте новую.`
  )
}

// --- the judge -----------------------------------------------------------------------------------

export interface JudgeOptions {
  /** Messages API root, e.g. `https://api.deepseek.com/anthropic`. */
  baseUrl: string
  apiKey: string
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch
  model?: string
  maxTokens?: number
  timeoutMs?: number
}

export type GoalJudge = (condition: string, lastAnswer: string) => Promise<CycleVerdict>

/** Extract the first complete JSON object from `text` (tolerates code fences and prose). */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Parse the answer of the judge; throws when it is not a valid verdict. */
export function parseVerdict(text: string): CycleVerdict {
  const json = extractJsonObject(text)
  if (json === undefined) throw new Error('судья не вернул JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('судья вернул невалидный JSON')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('судья вернул не объект')
  const raw = parsed as Record<string, unknown>
  if (typeof raw.done !== 'boolean') throw new Error('судья не вернул done')
  const reason = typeof raw.reason === 'string' ? raw.reason : raw.reason === undefined ? '' : String(raw.reason)
  return { done: raw.done, reason }
}

/** Text sent to the judge: the condition and the last answer, nothing else. */
export function judgePrompt(condition: string, lastAnswer: string): string {
  return [
    'Ты судья автономной работы бота. Реши, выполнено ли условие целиком по последнему ответу.',
    'Ответь строго одним JSON-объектом без пояснений: {"done": true|false, "reason": "коротко, что осталось"}',
    'done=true только когда условие выполнено по существу, а не обещано.',
    '',
    `Условие: ${condition.trim()}`,
    '',
    `Последний ответ: ${lastAnswer.trim()}`,
  ].join('\n')
}

function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/messages`
}

/** A short, tool-less request to the judge model over the Messages API. */
export function createGoalJudge(options: JudgeOptions): GoalJudge {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const model = options.model ?? JUDGE_MODEL
  const maxTokens = options.maxTokens ?? 300
  const timeoutMs = options.timeoutMs ?? 60_000

  return async function judge(condition: string, lastAnswer: string): Promise<CycleVerdict> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetchImpl(messagesUrl(options.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          stream: false,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: judgePrompt(condition, lastAnswer) }],
            },
          ],
        }),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`судья ответил HTTP ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`)
      }
      const payload = (await response.json()) as { content?: unknown }
      const blocks = Array.isArray(payload.content) ? payload.content : []
      const text = blocks
        .map((block) => {
          if (block === null || typeof block !== 'object') return ''
          const item = block as Record<string, unknown>
          return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
        })
        .join('')
      return parseVerdict(text)
    } finally {
      clearTimeout(timer)
    }
  }
}

// --- spend measurement ---------------------------------------------------------------------------

/** What the main session log says about the tokens of the new events. */
export interface UsageSlice {
  usd: number
  inputTokens: number
  outputTokens: number
  /** Offset to pass to the next call. */
  offset: number
}

export interface UsageMeter {
  /** Current byte length of the log; the baseline for a freshly started goal. */
  size(): number
  /** Tokens of the complete events after `offset`, priced in USD. */
  readSince(offset: number): UsageSlice
}

function usageOf(value: unknown): TokenUsage {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const number = (item: unknown): number =>
    typeof item === 'number' && Number.isFinite(item) && item > 0 ? item : 0
  return {
    inputTokens: number(raw.inputTokens),
    cacheReadTokens: number(raw.cacheReadTokens),
    cacheWriteTokens: number(raw.cacheWriteTokens),
    outputTokens: number(raw.outputTokens),
  }
}

/**
 * Reads the durable JSONL log of the `main` session and prices the tokens of
 * assistant messages. Only complete lines are consumed, so a log that is being
 * appended to never loses or double-counts an event.
 */
export function createUsageMeter(file: string): UsageMeter {
  return {
    size() {
      try {
        return statSync(file).size
      } catch {
        return 0
      }
    },
    readSince(offset: number): UsageSlice {
      let raw: Buffer
      try {
        raw = readFileSync(file)
      } catch {
        return { usd: 0, inputTokens: 0, outputTokens: 0, offset }
      }
      // A log replaced by a shorter one cannot satisfy the old offset.
      let position = offset > raw.length ? 0 : Math.max(0, Math.trunc(offset))
      const totals: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
      while (position < raw.length) {
        const newline = raw.indexOf(0x0a, position)
        if (newline < 0) break
        const line = raw.subarray(position, newline).toString('utf8')
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch {
          // A torn tail line: leave it for the next read.
          break
        }
        position = newline + 1
        if (event === null || typeof event !== 'object') continue
        const record = event as Record<string, unknown>
        if (record.type !== 'assistant/message') continue
        const data = record.data
        if (data === null || typeof data !== 'object') continue
        const usage = usageOf((data as Record<string, unknown>).usage)
        totals.inputTokens += usage.inputTokens
        totals.cacheReadTokens += usage.cacheReadTokens
        totals.cacheWriteTokens += usage.cacheWriteTokens
        totals.outputTokens += usage.outputTokens
      }
      const usd = costOf(JUDGE_MODEL, totals)
      if (usd === null) throw new Error(`No valid goal usage price for ${JUDGE_MODEL}`)
      const inputTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
      return { usd, inputTokens, outputTokens: totals.outputTokens, offset: position }
    },
  }
}
