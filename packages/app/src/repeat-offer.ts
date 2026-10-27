// The repeat-offer initiative: notice that the owner asked the same thing two
// calendar days in a row at nearly the same time and offer to run it every day.
//
// The decision is deterministic and model-free. After an owner turn, its start
// time and the MCP tools it called are compared with the owner turns of the
// previous calendar day (the owner's zone). One tool and a start time within
// 60 minutes is enough for one card; built-in tools never count, because almost
// every turn uses them.
//
// The card has three answers: «Да» creates a daily cron job in the owner zone,
// «Нет» silences the tool for seven days, «Не предлагать» silences it for good.
// Both silences and the turn history live in state.db, so the daemon restart
// keeps them.

import type {
  RepeatOfferCard,
  RepeatOfferCardStatus,
  RepeatOfferStore,
  RepeatOfferTurn,
} from '../../store/src/index.js'
import type { ScheduleRegistry } from '../../scheduler/src/index.js'

/** Prefix of the callback_data of the three buttons of the card. */
export const REPEAT_OFFER_CALLBACK_PREFIX = 'ro1'

/** How close two starts must be to look like "the same time of day". */
export const REPEAT_OFFER_WINDOW_MINUTES = 60

/** The step the offered time is rounded down to. */
export const REPEAT_OFFER_ROUND_MINUTES = 5

/** How long «Нет» keeps the card away from one tool. */
export const REPEAT_OFFER_DECLINE_DAYS = 7

const DAY_MS = 86_400_000

export type RepeatOfferDecision = 'yes' | 'no' | 'never'

export interface RepeatOfferCandidate {
  /** Full name of the matching MCP tool. */
  tool: string
  /** `ЧЧ:ММ` of the daily run: the earlier of the two starts, rounded down. */
  time: string
  /** Earlier start as minutes from midnight. */
  minutes: number
  /** The turn of the previous day that matched. */
  previous: RepeatOfferTurn
}

export interface RepeatOfferObservation {
  card: RepeatOfferCard
  text: string
}

export interface RepeatOfferDecided {
  answer: string
  card: RepeatOfferCard
  /** The text the card becomes after the press; undefined when nothing changed. */
  editText?: string
}

export interface RepeatOfferAutomation {
  /**
   * Records one finished owner turn and returns the card to send, if this turn
   * is a repeat of the previous day.
   */
  observe(input: {
    chatId: number
    startedAt: number
    request: string
    tools: readonly string[]
    now?: number
  }): RepeatOfferObservation | undefined
  /** Applies a press of one of the three buttons of a card. */
  decide(input: { cardId: string; chatId: number; decision: RepeatOfferDecision; now?: number }): RepeatOfferDecided | undefined
}

export interface RepeatOfferAutomationOptions {
  store: RepeatOfferStore
  schedules: ScheduleRegistry
  /** IANA zone of the owner; the day, the time of day and the job live in it. */
  timeZone: string
  now?: () => number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

interface LocalMinute {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

/** Wall-clock reading of an instant in the owner's zone. */
export function ownerLocalMinute(at: number, timeZone: string): LocalMinute {
  const values = new Map<string, string>()
  for (const part of formatterFor(timeZone).formatToParts(at)) values.set(part.type, part.value)
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `YYYY-MM-DD` of the owner's calendar day. */
export function ownerDayKey(at: number, timeZone: string): string {
  const local = ownerLocalMinute(at, timeZone)
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`
}

/** The owner's calendar day before `day` (`YYYY-MM-DD`). */
export function previousOwnerDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) throw new Error(`repeat-offer: bad owner day "${day}"`)
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - DAY_MS
  const date = new Date(at)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Minutes from midnight of an instant in the owner's zone. */
export function ownerMinutesOfDay(at: number, timeZone: string): number {
  const local = ownerLocalMinute(at, timeZone)
  return local.hour * 60 + local.minute
}

/** `ЧЧ:ММ` of minutes from midnight. */
export function formatMinutes(minutes: number): string {
  const whole = ((Math.trunc(minutes) % 1440) + 1440) % 1440
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`
}

/** Distance of two times of day, across midnight. */
export function minutesApart(left: number, right: number): number {
  const direct = Math.abs(left - right) % 1440
  return Math.min(direct, 1440 - direct)
}

/**
 * The candidate of this turn: a tool of the previous day whose start is within
 * the window. The closest match wins, then the alphabetically first tool, so
 * one turn never yields two cards for the same pair of turns. A tool that
 * `allowed` refuses (a silenced one) is dropped before the choice, so it never
 * hides another matching tool of the same turn.
 */
export function findRepeatCandidate(
  current: { startMinutes: number; tools: readonly string[] },
  previous: readonly RepeatOfferTurn[],
  timeZone: string,
  allowed: (tool: string) => boolean = () => true,
): RepeatOfferCandidate | undefined {
  let best: { tool: string; distance: number; previous: RepeatOfferTurn; previousMinutes: number } | undefined
  for (const tool of [...new Set(current.tools)].sort()) {
    if (!allowed(tool)) continue
    for (const turn of previous) {
      if (!turn.tools.includes(tool)) continue
      const previousMinutes = ownerMinutesOfDay(turn.startedAt, timeZone)
      const distance = minutesApart(current.startMinutes, previousMinutes)
      if (distance > REPEAT_OFFER_WINDOW_MINUTES) continue
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && tool < best.tool)
      ) {
        best = { tool, distance, previous: turn, previousMinutes }
      }
    }
  }
  if (best === undefined) return undefined
  const earlier = Math.min(current.startMinutes, best.previousMinutes)
  const rounded = earlier - (earlier % REPEAT_OFFER_ROUND_MINUTES)
  return {
    tool: best.tool,
    time: formatMinutes(rounded),
    minutes: rounded,
    previous: best.previous,
  }
}

/** The text of the card: today's request, the offered time and what the buttons do. */
export function repeatOfferCardText(request: string, time: string): string {
  return [
    'Похоже, вчера вы просили то же самое примерно в то же время.',
    `Сегодняшний запрос: ${request}`,
    '',
    `Присылать его каждый день в ${time}?`,
  ].join('\n')
}

/** The text the card keeps after «Да». */
export function repeatOfferAcceptedText(request: string, time: string): string {
  return `Создано: каждый день в ${time}\nЗапрос: ${request}`
}

/** callback_data of one button of the card. */
export function encodeRepeatOfferCallback(decision: RepeatOfferDecision, id: string): string {
  const code = decision === 'yes' ? 'y' : decision === 'no' ? 'n' : 'v'
  return `${REPEAT_OFFER_CALLBACK_PREFIX}:${code}:${id}`
}

/** The decision carried by a card button, or undefined for foreign data. */
export function decodeRepeatOfferCallback(
  data: string,
): { decision: RepeatOfferDecision; id: string } | undefined {
  const match = /^ro1:([ynv]):([a-f0-9]{1,40})$/.exec(data)
  if (match === null) return undefined
  return {
    decision: match[1] === 'y' ? 'yes' : match[1] === 'n' ? 'no' : 'never',
    id: match[2] as string,
  }
}

/** A daily cron expression at `ЧЧ:ММ`; the registry evaluates it in the owner zone. */
export function dailyCronOf(time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (match === null) throw new Error(`repeat-offer: bad card time "${time}"`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error(`repeat-offer: bad card time "${time}"`)
  return `${minute} ${hour} * * *`
}

function statusText(card: RepeatOfferCard, status: RepeatOfferCardStatus): string {
  if (status === 'accepted') return repeatOfferAcceptedText(card.request, card.time)
  if (status === 'declined') {
    return `Хорошо, не буду предлагать это неделю.\nЗапрос: ${card.request}`
  }
  return `Хорошо, больше не буду предлагать это.\nЗапрос: ${card.request}`
}

export function createRepeatOfferAutomation(options: RepeatOfferAutomationOptions): RepeatOfferAutomation {
  const { store, schedules, timeZone } = options
  const now = options.now ?? (() => Date.now())

  /** The same request is already planned: no card, the automation exists. */
  function alreadyPlanned(request: string, at: number): boolean {
    const wanted = request.trim()
    if (wanted === '') return true
    return schedules.list().some((job) => {
      if (job.task.trim() !== wanted) return false
      if (job.paused) return false
      if (job.until !== null && job.until.getTime() <= at) return false
      if (job.maxRuns !== null && job.runs >= job.maxRuns) return false
      return true
    })
  }

  function rememberTurn(input: {
    startedAt: number
    request: string
    tools: readonly string[]
  }, at: number): void {
    store.recordTurn(
      {
        day: ownerDayKey(input.startedAt, timeZone),
        startedAt: input.startedAt,
        request: input.request,
        tools: input.tools,
      },
      at,
    )
  }

  return {
    observe(input) {
      const at = input.now ?? now()
      const tools = input.tools.filter((tool) => tool.startsWith('mcp__'))
      const today = ownerDayKey(input.startedAt, timeZone)
      const previous = store.turnsOfDay(previousOwnerDay(today))
      // Silenced tools leave the comparison first: «Нет» or «Не предлагать» for
      // one tool must not take the card away from another matching tool.
      const candidate = findRepeatCandidate(
        { startMinutes: ownerMinutesOfDay(input.startedAt, timeZone), tools },
        previous,
        timeZone,
        (tool) => !store.isSuppressed(tool, at),
      )
      rememberTurn({ startedAt: input.startedAt, request: input.request, tools }, at)
      if (candidate === undefined) return undefined
      if (alreadyPlanned(input.request, at)) return undefined
      const card = store.addCard({
        chatId: input.chatId,
        tool: candidate.tool,
        time: candidate.time,
        request: input.request,
        createdAt: at,
      })
      return { card, text: repeatOfferCardText(card.request, card.time) }
    },

    decide(input) {
      const at = input.now ?? now()
      const card = store.card(input.cardId)
      if (card === undefined) return undefined
      if (card.chatId !== input.chatId) return undefined
      if (card.status !== 'pending') {
        return { answer: 'Решение уже принято', card }
      }
      if (input.decision === 'yes') {
        try {
          schedules.create({
            spec: dailyCronOf(card.time),
            task: card.request,
            tz: timeZone,
          })
        } catch (error) {
          return {
            answer: `Не удалось создать задание: ${error instanceof Error ? error.message : String(error)}`,
            card,
          }
        }
        const decided = store.setCardStatus(card.id, 'accepted') ?? card
        return { answer: 'Создано', card: decided, editText: statusText(decided, 'accepted') }
      }
      const until =
        input.decision === 'no' ? at + REPEAT_OFFER_DECLINE_DAYS * DAY_MS : null
      store.suppress(card.tool, until, at)
      const status: RepeatOfferCardStatus = input.decision === 'no' ? 'declined' : 'never'
      const decided = store.setCardStatus(card.id, status) ?? card
      return {
        answer: input.decision === 'no' ? 'Не буду предлагать неделю' : 'Больше не предложу',
        card: decided,
        editText: statusText(decided, status),
      }
    },
  }
}
