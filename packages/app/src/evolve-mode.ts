// The self-development mode of the owner's bot: the durable switch, the
// interval of the autonomous cycles, the last outcomes and the prompt of a
// cycle.
//
// This module owns no model and no Telegram API. It keeps the mode in the
// daemon's key-value store, so a restart (including the restart after an
// adoption) resumes the switch and the time of the next cycle. The app owns
// the turn itself: a cycle is an ordinary planned turn of `main`.

/** kv key of the self-development mode. */
export const EVOLVE_MODE_KV_KEY = 'evolve.mode'

/** Interval of a cycle when `DSHBOT_EVOLVE_INTERVAL` is unset: two hours. */
export const DEFAULT_EVOLVE_INTERVAL_MS = 2 * 60 * 60 * 1_000

/** The shortest interval the owner may enable: the mode must not become a loop. */
export const MIN_EVOLVE_INTERVAL_MS = 30 * 60 * 1_000

/** The owner sees the last three outcomes of the mode. */
export const MAX_EVOLVE_OUTCOMES = 3

/** How one recorded cycle ended, as far as the mode can tell. */
export type EvolveDecision = 'waiting' | 'accepted' | 'rejected' | 'none'

/** One outcome of a cycle: which candidate it made and whether it was sent. */
export interface EvolveOutcome {
  /** Wall clock of the cycle. */
  at: number
  /** `self_change` candidate of the cycle, when the model made one. */
  candidateId?: string
  /** True when `self_submit` passed the gate; the owner then got the card. */
  submitted: boolean
  /** Current decision of the owner, or `none` for a cycle without a candidate. */
  decision: EvolveDecision
}

/** The durable state of the mode. */
export interface EvolveModeState {
  enabled: boolean
  /** Interval between the cycles of the enabled mode. */
  intervalMs: number
  /** Wall clock of the next scheduled cycle; absent while the mode is off. */
  nextAt?: number
  /**
   * Candidate of the mode that still waits for the owner's decision. It is
   * closed by the owner's Accept/Reject, not by a cycle that drops the
   * candidate: the next cycle only reports while it is open.
   */
  openCandidateId?: string
  /** The last {@link MAX_EVOLVE_OUTCOMES} cycles, oldest first. */
  outcomes: EvolveOutcome[]
}

/** The part of the daemon store this module needs. */
export interface EvolveModeStorage {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function normalizeDecision(value: unknown): EvolveDecision {
  return value === 'waiting' || value === 'accepted' || value === 'rejected' || value === 'none' ? value : 'none'
}

function normalizeOutcome(value: unknown): EvolveOutcome | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!finitePositive(raw.at)) return undefined
  const candidateId = typeof raw.candidateId === 'string' && raw.candidateId !== '' ? raw.candidateId : undefined
  return {
    at: Math.trunc(raw.at),
    ...(candidateId === undefined ? {} : { candidateId }),
    submitted: raw.submitted === true,
    decision: candidateId === undefined && raw.submitted !== true ? 'none' : normalizeDecision(raw.decision),
  }
}

/** The state of a daemon that has never enabled the mode. */
export function defaultEvolveState(intervalMs = DEFAULT_EVOLVE_INTERVAL_MS): EvolveModeState {
  return { enabled: false, intervalMs, outcomes: [] }
}

/** Parse a durable or supplied state, never throwing on an unreadable one. */
export function normalizeEvolveState(value: unknown, fallbackIntervalMs: number): EvolveModeState {
  if (value === null || typeof value !== 'object') return defaultEvolveState(fallbackIntervalMs)
  const raw = value as Record<string, unknown>
  const intervalMs = finitePositive(raw.intervalMs) ? Math.trunc(raw.intervalMs) : fallbackIntervalMs
  const outcomes: EvolveOutcome[] = []
  if (Array.isArray(raw.outcomes)) {
    for (const item of raw.outcomes) {
      const outcome = normalizeOutcome(item)
      if (outcome !== undefined) outcomes.push(outcome)
    }
  }
  const nextAt = finitePositive(raw.nextAt) ? Math.trunc(raw.nextAt) : undefined
  const openCandidateId =
    typeof raw.openCandidateId === 'string' && /^c-[A-Za-z0-9-]+$/.test(raw.openCandidateId)
      ? raw.openCandidateId
      : undefined
  return {
    enabled: raw.enabled === true,
    intervalMs,
    ...(nextAt === undefined ? {} : { nextAt }),
    ...(openCandidateId === undefined ? {} : { openCandidateId }),
    outcomes: outcomes.slice(-MAX_EVOLVE_OUTCOMES),
  }
}

/**
 * Parse an interval token of `/evolve on 1h` or `DSHBOT_EVOLVE_INTERVAL`:
 * `30m`, `2h`, `1d`. Undefined when the token is not an interval at all; a
 * valid but too short interval is returned for the caller to reject.
 */
export function parseEvolveInterval(token: string): number | undefined {
  const match = /^(\d+)\s*([mhd])$/i.exec(token.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined
  const unit = (match[2] as string).toLowerCase()
  const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  const ms = amount * factor
  return Number.isSafeInteger(ms) ? ms : undefined
}

/** Read and write the mode in the shared kv store. */
export function createEvolveModeStore(
  storage: EvolveModeStorage,
  fallbackIntervalMs = DEFAULT_EVOLVE_INTERVAL_MS,
): {
  load(): EvolveModeState
  save(state: EvolveModeState): void
} {
  return {
    load() {
      const raw = storage.get(EVOLVE_MODE_KV_KEY)
      if (raw === undefined || raw.trim() === '') return defaultEvolveState(fallbackIntervalMs)
      try {
        return normalizeEvolveState(JSON.parse(raw) as unknown, fallbackIntervalMs)
      } catch {
        return defaultEvolveState(fallbackIntervalMs)
      }
    },
    save(state) {
      storage.set(EVOLVE_MODE_KV_KEY, JSON.stringify(state))
    },
  }
}

/** Short human interval: `30м`, `2ч`, `1д`. */
export function formatEvolveInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes % 1_440 === 0) return `${minutes / 1_440}д`
  if (minutes % 60 === 0) return `${minutes / 60}ч`
  return `${minutes}м`
}

/** How long until the next cycle, in whole minutes. */
export function minutesUntil(nextAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextAt - now) / 60_000))
}

function outcomeText(outcome: EvolveOutcome): string {
  if (outcome.candidateId === undefined) {
    return outcome.submitted ? '- кандидат не назван: карточка отправлена' : '- кандидата нет: правка не отправлена'
  }
  if (outcome.decision === 'accepted') return `- ${outcome.candidateId}: принят владельцем`
  if (outcome.decision === 'rejected') return `- ${outcome.candidateId}: отклонён владельцем`
  if (outcome.decision === 'waiting' || outcome.submitted) {
    return `- ${outcome.candidateId}: карточка отправлена, ждёт решения владельца`
  }
  return `- ${outcome.candidateId}: кандидат не отправлен`
}

/** The answer of `/evolve` without an argument. */
export function formatEvolveStatus(state: EvolveModeState, now: number): string {
  const lines: string[] = []
  if (state.enabled) {
    lines.push(`Режим саморазвития: включён, интервал ${formatEvolveInterval(state.intervalMs)}.`)
    if (state.nextAt === undefined) {
      lines.push('Следующий цикл: ещё не запланирован.')
    } else {
      const minutes = minutesUntil(state.nextAt, now)
      const at = new Date(state.nextAt)
      const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      lines.push(`Следующий цикл: через ${minutes} мин (${clock}).`)
    }
  } else {
    lines.push('Режим саморазвития: выключен.')
    lines.push('Следующий цикл: не запланирован.')
  }
  if (state.outcomes.length === 0) {
    lines.push('Итогов циклов пока нет.')
  } else {
    lines.push('Последние итоги:')
    for (const outcome of state.outcomes.slice(-MAX_EVOLVE_OUTCOMES)) lines.push(outcomeText(outcome))
  }
  return lines.join('\n')
}

/**
 * The prompt of one autonomous cycle. It names the two steps of a small
 * self-fix, the factory tool for a big one, the silence token and the one
 * candidate rule; the model recognizes its situation from these words alone.
 */
export function evolveCyclePrompt(): string {
  return [
    '[ЦИКЛ САМОРАЗВИТИЯ]',
    'Это автономный ход без владельца: тебя никто не просил о задаче, но режим саморазвития включён и этот ход твой.',
    'Посмотри свежий опыт и выбери одну самую полезную небольшую самоправку: журнал ошибок инструментов, отказы гейтов, жалобы владельца в истории разговора, RUNTIME.md и свои навыки, если они доступны.',
    'Малая самоправка идёт так: self_change с коротким описанием, затем обычные read и edit по абсолютному пути кандидата, затем self_submit с id кандидата. Live-каталог не правь: правки идут только в кандидате.',
    'Если правка большая или рискованная, не делай её сам: поставь задачу во встроенный завод бота инструментом zavod (действие new) и коротко скажи, что поставил. Разбор придёт владельцу карточкой /factory; решения принимает он.',
    'Одновременно может быть только один открытый кандидат. Если предыдущий ждёт решения владельца по карточке, не вызывай self_change: сделай вывод по свежему опыту и отчитайся. Если предыдущий не дошёл до карточки (self_submit не вызван или гейт не прошёл), доведи его правками и self_submit или убери через self_discard, и только потом начинай новый.',
    'Подтверждения в этом ходе не запрашиваются: команды и действия, которым нужно подтверждение владельца, будут сразу отклонены. Не проси подтверждение и не жди его. Карточка «Принять» от self_submit — не подтверждение хода: она уходит владельцу как обычно, и внутри хода её решение не ждётся.',
    'Закончи коротким отчётом владельцу: что заметил, какую правку сделал или какую задачу поставил. Если улучшать нечего или сказать нечего, ответь ровно [SILENT] и ничего больше. Это служебный токен: не переводи его и не смешивай с обычным ответом.',
  ].join('\n')
}
