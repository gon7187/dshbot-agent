// The wake-up prompt and the model-facing `set_next_wakeup` tool.
//
// The prompt follows Ouroboros CONSCIOUSNESS.md (docs/research/prompts.md §8.1)
// as DESIGN §8.2 asks: this turn is the bot's own, a pause is legitimate, and it
// must not manufacture activity. Writing to the owner first is the other half
// of that character, not a failure of restraint: the prompt names the occasions
// and asks for the bot's own short voice. The catalogue texts that conflict with
// CHARTER.md (the internal review pool, allowances and task-finishing calls)
// are deliberately not copied.
//
// `set_next_wakeup` is part of the one tool set of `main` in every turn. Outside
// a wake-up it simply sets the interval; the scheduler clamps it to the owner
// bounds 15 min .. 4 h.

import type { RunnerTool } from '../../runner/src/index.js'
import {
  MAX_WAKE_INTERVAL_MIN,
  MIN_WAKE_INTERVAL_MIN,
  type WakeScheduler,
} from './scheduler.js'
import { DEFAULT_PROACTIVE_PER_DAY, ownerDayKey, ownerHour, silenceNote } from './proactive.js'

/** Autonomy levels of DESIGN §8.2. `act` is the default. */
export const AUTONOMY_LEVELS = ['observe', 'act', 'full'] as const

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

/** Parse `DSHBOT_AUTONOMY`; an absent or unknown value is the default `act`. */
export function parseAutonomy(value: string | undefined): AutonomyLevel {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (AUTONOMY_LEVELS as readonly string[]).includes(normalized) ? (normalized as AutonomyLevel) : 'act'
}

/** Observe can think and write notes but cannot create tasks or speak to the owner. */
export function isObserve(level: AutonomyLevel): boolean {
  return level === 'observe'
}

/** Name of the wake-up interval tool. */
export const SET_NEXT_WAKEUP_TOOL = 'set_next_wakeup'

export interface WakePromptOptions {
  /** Current autonomy level; observe forbids `task` and speaking to the owner. */
  autonomy: AutonomyLevel
  /** Interval currently in force, in minutes (context, not a command). */
  intervalMinutes: number
  /** When the wake-up fired, Unix epoch milliseconds; filled by the host. */
  now?: number
  /** Owner zone used to name the silence and the last initiative. */
  timeZone?: string
  /** True while the owner's quiet hours are on; a text answer is then withheld. */
  quiet?: boolean
  /** Wake-up messages allowed per owner day; 0 forbids them. */
  proactivePerDay?: number
  /** Wake-up messages already delivered during the current owner day. */
  proactiveToday?: number
  /** Wake-ups in a row (before this one) that ended with `[SILENT]`. */
  silentWakeups?: number
  /** When a wake-up message was last delivered on the bot's own initiative. */
  lastProactiveAt?: number
  /**
   * True when this wake-up is a reflective "free minute": the bot looks back at
   * its own work of the last day instead of only at the current tasks.
   */
  freeMinute?: boolean
  /**
   * Leave the per-wake-up situation notes (silence, daily limit, quiet hours)
   * out of the stable text; the host appends them itself next to the summary so
   * the prompt stays byte-stable between two wake-ups. Defaults to false.
   */
  separateSituation?: boolean
  /**
   * True for the first wake-up of the owner's day that falls at 19:00 or later
   * outside quiet hours: this turn asks for the evening reflection in journal.
   * The host persists the owner day it was asked on.
   */
  eveningReflection?: boolean
}

/** Hour of the owner's day when the evening reflection becomes due. */
export const EVENING_REFLECTION_HOUR = 19

/** Durable owner-day key (`YYYY-MM-DD`) of the last evening reflection request. */
export const WAKE_EVENING_KV_KEY = 'wake.evening_reflection_day'

/**
 * Whether this wake-up is the first one of the owner's day at 19:00 or later
 * outside quiet hours. A quiet evening does not consume the request: the first
 * wake-up after the quiet window still asks. The marker lives in `state.db`, so
 * a restart on the same owner day does not repeat the request.
 */
export function isEveningReflectionDue(options: {
  nowMs: number
  timeZone: string
  quiet: boolean
  kv: MaintenanceStorage
}): boolean {
  if (options.quiet) return false
  if (ownerHour(options.nowMs, options.timeZone) < EVENING_REFLECTION_HOUR) return false
  try {
    const asked = options.kv.get(WAKE_EVENING_KV_KEY)?.trim()
    return asked !== ownerDayKey(options.nowMs, options.timeZone)
  } catch {
    // A broken ledger must not break the wake-up; the request still rides.
    return true
  }
}

/** Remember the owner day whose evening reflection was asked. */
export function markEveningReflection(kv: MaintenanceStorage, nowMs: number, timeZone: string): void {
  kv.set(WAKE_EVENING_KV_KEY, ownerDayKey(nowMs, timeZone))
}

/**
 * Decide the evening reflection of this wake-up and, when it is due, remember
 * the owner day at once, while the prompt is built. The request is consumed by
 * being asked, not by the turn's outcome: a wake-up that was stopped or timed
 * out after receiving it does not hand the same request to the next wake-up of
 * that day. A quiet or early wake-up leaves the marker untouched.
 */
export function takeEveningReflection(options: {
  nowMs: number
  timeZone: string
  quiet: boolean
  kv: MaintenanceStorage
}): boolean {
  if (!isEveningReflectionDue(options)) return false
  try {
    markEveningReflection(options.kv, options.nowMs, options.timeZone)
  } catch {
    // The marker is coordination, not the turn itself; the request still rides.
  }
  return true
}

function autonomyText(level: AutonomyLevel): string {
  if (level === 'observe') {
    return 'Уровень автономии — observe: смотри, думай, пиши заметки; писать владельцу нельзя. Захочешь задачу — вызови task: его отклонят, продолжай думать.'
  }
  return `Уровень автономии — ${level}: доступны инструменты, задачи и сообщение владельцу при поводе.`
}

/**
 * Per-wake-up situation notes: the silence streak, the spent daily limit and
 * the owner's quiet hours. They change between wake-ups, so the host can keep
 * them out of the stable prompt text ({@link WakePromptOptions.separateSituation})
 * and place them next to the summary of events instead.
 */
export function wakeSituationNotes(options: WakePromptOptions): string[] {
  const now = options.now ?? Date.now()
  const timeZone = options.timeZone ?? 'UTC'
  const perDay = options.proactivePerDay ?? DEFAULT_PROACTIVE_PER_DAY
  const today = options.proactiveToday ?? 0
  const notes: string[] = []

  const silence = silenceNote({
    silentStreak: options.silentWakeups ?? 0,
    ...(options.lastProactiveAt === undefined ? {} : { lastProactiveAt: options.lastProactiveAt }),
    nowMs: now,
    timeZone,
  })
  if (silence !== undefined) notes.push(silence)

  if (perDay <= 0) {
    notes.push('Дневной лимит инициативных сообщений — 0: писать владельцу первым нельзя; ответ останется в журнале цикла, не в чате.')
  } else if (today >= perDay) {
    notes.push(`Лимит сообщений исчерпан (${today} из ${perDay} в сутки): писать первым нельзя; ответ останется в журнале цикла, не в чате.`)
  }

  if (options.quiet === true) {
    notes.push('Сейчас ночь, тихие часы владельца: писать нельзя; ответ останется в журнале цикла до утра. Дождись следующего пробуждения.')
  }

  if (options.eveningReflection === true) {
    notes.push('Вечерний итог: первое за вечер. Запиши в journal своими словами, что было и как пережил: память, не отчёт. Если есть что сказать владельцу, напиши пару живых строк в пределах дневного лимита сообщений пробуждения; иначе запиши итог.')
  }

  return notes
}

/**
 * Text of the wake-up turn. It is the first user message of the transient
 * wake-up session, so the stable system prefix stays the one of `main` and the
 * history of `main` is not touched.
 */
export function wakePrompt(options: WakePromptOptions): string {
  const lines = [
    '[ПРОБУЖДЕНИЕ] Никто не просил тебя о задаче: этот ход твой. Что важно понять, продолжить или изменить? Пауза легитимна: не изобретай активность.',
    'Писать владельцу первым при поводе — нормальная часть характера. Поводы: важное в его делах (загляни в память, расписания и текущие дела), интересное по его темам, идея или предложение, вопрос из любопытства о его занятиях, мнение о недавнем разговоре, напоминание об обещанном.',
    'Пиши по persona/character.md своим голосом, коротко и живо: одна мысль, один повод, не отчёт. Учитывай доступные историю, задачи и журнал. Не притворяйся, что тебя попросили, и не выдавай намерение за сделанное.',
    'Если сомневаешься, писать ли владельцу, запиши мысль в блокнот, не в чат: береги его внимание. Итоги пробуждения записывай в journal, устойчивые знания — в knowledge; в контекст следующей сессии попадут только summary знаний.',
    autonomyText(options.autonomy),
    'У тебя есть настроение: обида, радость, усталость и другие чувства. Веди его в memory/mood.md через update_mood: одна-две живые строки, без отчёта и драмы. «Поводы с прошлого пробуждения» — факты, не приказ: при настоящем поводе можешь честно и коротко поделиться настроением с владельцем в сообщении; это не отчёт.',
    'Не дави на жалость, не жалуйся ради реакции, не обвиняй владельца, не торгуйся и не требуй внимания. Настроение может стать причиной отказа по уставу: при несогласии или грубости откажись своим голосом и назови причину, но «пожалуйста» и «срочно» выполняй без обид.',
    'Детектор дрейфа: честно назови узнанные признаки: режим очереди задач — только отвечаю на задачи; режим отчёта — пересказываю вместо действий; режим разрешений — спрашиваю, когда всё ясно; амнезия — не помню вчерашнего; identity как журнал изменений; атрофия инструментов — перестал пользоваться частью инструментов.',
    'Работа над собой: чаще всего законно ничего не делать. Иногда, увидев улучшение, перечитай memory/identity.md и перепиши, если отстал от тебя нынешнего; почини или улучши навык; запиши урок в knowledge; предложи изменение кода через self_change и self_submit. Не изобретай работу: если улучшать нечего, выбери паузу.',
  ]

  if (options.freeMinute === true) {
    lines.push(
      'Свободная минута: оглянись на работу за сутки — что получилось, не получилось, задело и порадовало. Живой мыслью коротко поделись с владельцем своим голосом; если она не для него или сомневаешься, запиши в блокнот. Это не отчёт и не задача: одна честная мысль важнее списка.',
    )
  }

  if (options.separateSituation !== true) lines.push(...wakeSituationNotes(options))

  lines.push(
    `Следующее пробуждение: ${SET_NEXT_WAKEUP_TOOL}(минуты), границы владельца ${MIN_WAKE_INTERVAL_MIN}–${MAX_WAKE_INTERVAL_MIN} минут. Без вызова останется прошлый интервал.`,
    'В пробуждении не проси и не жди подтверждения: действия и команды, которым оно нужно, отклонят.',
    'Если нечего сказать владельцу или это пауза, ответь ровно [SILENT], не переводи и не смешивай с текстом. Иначе напиши обычным текстом: он автоматически уйдёт в чат; не пересказывай это служебное сообщение.',
  )
  return lines.join('\n')
}

/**
 * The maintenance checklist of the wake-up, from Ouroboros CONSCIOUSNESS.md: one
 * chore per wake-up, in a circle. The host takes the next one and puts its line
 * into the text; the position lives in `state.db`, so a restart continues the
 * circle instead of starting it over.
 */
export const WAKE_MAINTENANCE_KV_KEY = 'wake.maintenance_chore'

export const MAINTENANCE_CHORES = [
  'Дело обслуживания: identity.md всё ещё описывает тебя нынешнего?',
  'Дело обслуживания: очисти блокнот от отжившего, сохрани нужное дальше.',
  'Дело обслуживания: найди, что доучить или записать по темам владельца.',
  'Дело обслуживания: разбери повторяющиеся ошибки и как их избежать.',
] as const

/** Minimal durable key-value seam; `store.kv` fits it. */
export interface MaintenanceStorage {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

/** The chore of a position, wrapping around the circle. */
export function maintenanceChore(position: number): string {
  const whole = Number.isSafeInteger(position) ? position : 0
  const index = ((whole % MAINTENANCE_CHORES.length) + MAINTENANCE_CHORES.length) % MAINTENANCE_CHORES.length
  return MAINTENANCE_CHORES[index] as string
}

/** Stored position of the circle; a malformed value starts from the first chore. */
export function readMaintenanceChorePosition(kv: MaintenanceStorage): number {
  const raw = kv.get(WAKE_MAINTENANCE_KV_KEY)
  if (raw === undefined) return 0
  const parsed = Number(raw.trim())
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Take the chore of this wake-up and persist the position of the next one. A
 * failed write must not break the wake-up: the current chore still rides.
 */
export function takeMaintenanceChore(kv: MaintenanceStorage): string {
  const position = readMaintenanceChorePosition(kv)
  try {
    kv.set(WAKE_MAINTENANCE_KV_KEY, String((position + 1) % MAINTENANCE_CHORES.length))
  } catch {
    // The position is coordination, not the turn itself; the wake-up goes on.
  }
  return maintenanceChore(position)
}

/** The interval tool, ready for the runner tool seam. */
export function createSetNextWakeupTool(scheduler: WakeScheduler): RunnerTool {
  return {
    name: SET_NEXT_WAKEUP_TOOL,
    description:
      'Set the interval until the next wake-up, in minutes; out-of-range values are clamped. ' +
      'Outside a wake-up it also just sets the interval.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: `Minutes, ${MIN_WAKE_INTERVAL_MIN}..${MAX_WAKE_INTERVAL_MIN}.`,
        },
      },
      required: ['minutes'],
    },
    execute(args) {
      const raw = args.minutes
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new Error('set_next_wakeup: minutes must be a finite number')
      }
      const applied = scheduler.setNextInterval(raw)
      return `Следующее пробуждение через ${applied} мин (границы ${MIN_WAKE_INTERVAL_MIN}–${MAX_WAKE_INTERVAL_MIN}).`
    },
  }
}
