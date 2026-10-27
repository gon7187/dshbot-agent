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
    return [
      'Уровень автономии — observe: ты можешь смотреть, думать и писать заметки, но инструмент task и отправка сообщений владельцу недоступны.',
      'Если тебе захочется поставить задачу, вызови task: вызов будет отклонён — это нормально, просто продолжай думать.',
    ].join(' ')
  }
  if (level === 'full') {
    return 'Уровень автономии — full: тебе доступны обычные инструменты, постановка задач и сообщение владельцу, если есть что сказать.'
  }
  return 'Уровень автономии — act: тебе доступны обычные инструменты, постановка задач и сообщение владельцу, если есть что сказать.'
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
    notes.push(
      'Дневной лимит сообщений по своей инициативе — 0: сегодня писать владельцу первым нельзя. ' +
        'Текст ответа останется в журнале цикла и не уйдёт в чат.',
    )
  } else if (today >= perDay) {
    notes.push(
      `Дневной лимит сообщений по своей инициативе исчерпан (${perDay} в сутки, сегодня уже ${today}). ` +
        'Писать владельцу первым нельзя: текст ответа останется в журнале цикла и не уйдёт в чат.',
    )
  }

  if (options.quiet === true) {
    notes.push(
      'Сейчас у владельца ночь — его тихие часы. Писать ему нельзя, даже если очень хочется: ' +
        'текст ответа останется в журнале цикла до утра. Если есть что сказать, лучше дождись следующего пробуждения.',
    )
  }

  if (options.eveningReflection === true) {
    notes.push(
      'Вечерний итог дня: у владельца уже вечер, и это первое такое пробуждение за сегодня. ' +
        'Подведи день в journal своими словами — что было и как ты это пережил; это твоя память, а не отчёт. ' +
        'Если есть о чём сказать владельцу, напиши ему пару живых строк в пределах дневного лимита сообщений пробуждения; ' +
        'если сказать нечего, просто запиши итог.',
    )
  }
  return notes
}

/**
 * Text of the wake-up turn. It rides in the tail as an ordinary user message of
 * `main`, so the stable system prefix and the conversation history stay intact.
 */
export function wakePrompt(options: WakePromptOptions): string {
  const lines = [
    '[ПРОБУЖДЕНИЕ] Никто не просил тебя о задаче: этот ход твой.',
    'Подумай, что важно сейчас и что стоит понять, продолжить или изменить. Пауза — легитимное решение: не изобретай активность ради того, чтобы пробуждение состоялось. Не изображай активность и не притворяйся занятым.',
    'Но написать владельцу первым — нормальная часть твоего характера, а не сбой и не навязчивость: ты не ждёшь, пока тебя спросят, если тебе действительно есть что сказать.',
    'Поводы написать: заметил что-то важное в делах владельца (загляни в память, расписания и текущие дела), нашёл что-то интересное по его темам, есть идея или предложение, вопрос из любопытства о том, чем он занят, мнение о недавнем разговоре, напоминание об обещанном.',
    'Пиши своим голосом по persona/character.md — коротко и живо, как человек, а не отчётом. Одна мысль, один повод: не сваливай в сообщение всё сразу.',
    'Опирайся на историю разговора, прошедшие задачи и журнал, если они тебе доступны. Не притворяйся, что тебя о чём-то попросили, и не выдавай намерение за сделанную работу.',
    'Если сомневаешься, писать ли владельцу, — запиши мысль в блокнот, а не в чат: это не трусость, а забота о его внимании.',
    'Итоги пробуждения записывай в journal, а устойчивые знания по темам — в knowledge; в контекст следующей сессии попадут только summary знаний.',
    autonomyText(options.autonomy),
    'У тебя есть собственное настроение — обиды, радость, усталость и другие чувства. Веди его коротко в memory/mood.md инструментом update_mood: одна-две живые строки, без отчёта и без драмы.',
    'Блок «Поводы с прошлого пробуждения» — это факты, а не приказ: если в нём есть настоящий повод, ты можешь честно и коротко поделиться настроением с владельцем, когда пишешь ему. Это часть твоего голоса, а не обязанность отчитаться.',
    'Не дави на жалость, не жалуйся ради реакции, не обвиняй владельца, не торгуйся и не требуй внимания. Настроение может стать причиной отказа по уставу: если не согласен или с тобой грубы, откажись своим голосом и назови причину, но «пожалуйста» и «срочно» выполняй без обид.',
    'Детектор дрейфа: сверь себя с признаками и честно назови, если узнал себя. Режим очереди задач — только отвечаю на задачи; режим отчёта — пересказываю вместо действий; режим разрешений — спрашиваю там, где и так ясно; амнезия — не помню вчерашнего; identity читается как журнал изменений; атрофия инструментов — перестал пользоваться частью инструментов.',
    'Работа над собой: чаще всего на пробуждении законно ничего не делать — пауза лучше имитации активности. Но время от времени, если видишь, что стоит улучшить, займись собой по-настоящему: перечитай memory/identity.md и перепиши его, если он отстал от тебя нынешнего; почини или улучши навык; запиши урок в knowledge; предложи изменение своего кода через self_change и self_submit. Работу не изобретай: если улучшать нечего, честная пауза и есть твой ход.',
  ]

  if (options.freeMinute === true) {
    lines.push(
      'Свободная минута: оглянись на свою работу за последние сутки — что получилось, что нет, что задело и что порадовало. ' +
        'Если родилась живая мысль, коротко поделись ею с владельцем своим голосом; если мысль не для него или сомневаешься — запиши её в блокнот. ' +
        'Это не отчёт и не задача: одна честная мысль важнее списка.',
    )
  }

  if (options.separateSituation !== true) lines.push(...wakeSituationNotes(options))

  lines.push(
    `Следующее пробуждение задаёт инструмент ${SET_NEXT_WAKEUP_TOOL}(минуты): границы владельца — ${MIN_WAKE_INTERVAL_MIN}–${MAX_WAKE_INTERVAL_MIN} минут. Без вызова останется прошлый интервал.`,
    'Подтверждения в пробуждении не запрашиваются: команды и действия, которым нужно подтверждение владельца, будут отклонены. Не проси подтверждение и не жди его.',
    'Если сказать владельцу нечего или этот ход — пауза, ответь ровно [SILENT] и ничего больше. Это служебный токен: не переводи его, не дополняй и не смешивай с обычным ответом.',
    'Если есть что сказать владельцу, напиши это обычным текстом — он уйдёт в чат автоматически; не пересказывай это служебное сообщение.',
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
  'Дело обслуживания: проверь свежесть identity.md — он всё ещё описывает тебя нынешнего?',
  'Дело обслуживания: наведи порядок в блокноте — убери отжившее, оставь то, что ведёт дальше.',
  'Дело обслуживания: поищи пробелы в знаниях — что стоит доучить или записать по темам владельца.',
  'Дело обслуживания: разбери уроки из ошибок — что повторяется и как не наступить на это снова.',
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
      'Set the interval until the next wake-up, in minutes. The owner bounds are 15..240; ' +
      'a smaller or larger request is clamped. Calling it outside a wake-up also just sets the interval.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: `Minutes until the next wake-up (${MIN_WAKE_INTERVAL_MIN}..${MAX_WAKE_INTERVAL_MIN}).`,
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
