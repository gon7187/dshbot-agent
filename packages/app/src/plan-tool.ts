// The `plan` tool: one editable progress checklist in the owner's chat.
//
// The model writes the steps of a long task with `set`, moves one step to
// another state with `update`, and the owner sees ONE message that is edited in
// place. A second `set` inside the same owner turn replaces the list of the same
// message; the first `set` of the next owner turn opens a new message.
//
// Card state belongs to the owner turn, not to the session: the tool is a lazy
// owner-only capability, and the app tells it when a turn starts and ends
// (`beginTurn`/`endTurn`). Telegram accepts an edit of one message about once a
// second, so faster updates are merged: the local list changes at once, while at
// most one edit per interval rides to the chat, and the final state is flushed
// when the turn ends.
//
// A refused edit (the message was deleted, or Telegram says the content did not
// change) is not a failed turn: the tool answers with a success text and a note,
// and the local list keeps the state the model set. A merged update is written
// later by a timer; its refusal waits on the card and rides with the next answer
// of the tool in the same turn.

import type { RunnerTool, RunnerToolContext } from '../../runner/src/index.js'
import type { TelegramApi } from '../../telegram/src/api.js'
import {
  PLAN_STATUSES,
  editPlanCard,
  sendPlanCard,
  type PlanStatus,
  type PlanStep,
} from '../../telegram/src/plan.js'

/** Telegram mistakes or refuses two edits of one message within a second. */
export const DEFAULT_PLAN_EDIT_INTERVAL_MS = 1_000

/** A checklist longer than this is not a plan any more, and one Telegram message has to hold it. */
const MAX_PLAN_STEPS = 50

/** A step line must stay readable on a phone; a long title is cut, not rejected. */
const MAX_STEP_TITLE_CHARS = 70

const STATUS_LABELS: Record<PlanStatus, string> = {
  pending: 'ожидает',
  in_progress: 'в работе',
  done: 'готово',
  error: 'ошибка',
}

/** Chat and forum topic of the owner turn that owns the card. */
export interface PlanTurnTarget {
  chatId: number
  threadId?: number
}

export interface PlanCardsOptions {
  api: TelegramApi
  log?: (text: string) => void
  /** Real time between two writes of one message; faster updates are merged. */
  minEditIntervalMs?: number
}

export interface PlanCards {
  /**
   * Open the owner turn: the next `set` starts a new message. A pending state of
   * the previous card is written first, so the new turn never re-targets it.
   */
  beginTurn(target: PlanTurnTarget): Promise<void>
  /**
   * Close the owner turn: whatever changed since the last edit reaches the
   * message, even when it arrived faster than the edit interval.
   */
  endTurn(): Promise<void>
  /** The tool registered in the owner's schema as `plan`. */
  readonly tool: RunnerTool
}

interface WriteOutcome {
  ok: boolean
  error?: string
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return String(error)
}

function parseStatus(value: unknown, step: number): PlanStatus {
  if (typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value)) {
    return value as PlanStatus
  }
  throw new Error(
    `plan: статус шага ${step} должен быть одним из: ${PLAN_STATUSES.join(', ')} (получено ${JSON.stringify(value)})`,
  )
}

function parseSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('plan: для action=set нужен непустой массив steps со списком шагов')
  }
  if (value.length > MAX_PLAN_STEPS) {
    throw new Error(`plan: в чеклисте не больше ${MAX_PLAN_STEPS} шагов, получено ${value.length}`)
  }
  return value.map((raw, at) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`plan: шаг ${at + 1} должен быть объектом { title, status? }`)
    }
    const item = raw as Record<string, unknown>
    if (typeof item.title !== 'string' || item.title.trim() === '') {
      throw new Error(`plan: у шага ${at + 1} должен быть непустой title`)
    }
    return {
      title: item.title.trim().slice(0, MAX_STEP_TITLE_CHARS),
      status: item.status === undefined ? 'pending' : parseStatus(item.status, at + 1),
    }
  })
}

export function createPlanCards(options: PlanCardsOptions): PlanCards {
  const { api } = options
  const log = options.log ?? ((): void => undefined)
  const interval = Math.max(0, options.minEditIntervalMs ?? DEFAULT_PLAN_EDIT_INTERVAL_MS)

  interface Card {
    target: PlanTurnTarget
    steps: PlanStep[]
    /** Undefined until the first send got through: later states edit this id. */
    messageId: number | undefined
    /** When the last send or edit attempt went out; the pacing counts from here. */
    lastWriteAt: number
    /** The local list differs from what the chat has. */
    dirty: boolean
    timer: NodeJS.Timeout | undefined
    writing: boolean
    writingRun: Promise<WriteOutcome[]> | undefined
    /** Why the latest refused write failed, until an answer of the tool tells the model. */
    unreported: string | undefined
  }

  let card: Card | undefined
  /** True only between `beginTurn` and `endTurn`: the owner turn that owns the card. */
  let ownerTurnOpen = false

  function arm(state: Card, delay: number): void {
    if (state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void drain(state)
    }, Math.max(0, delay))
    state.timer.unref()
  }

  /** One write of the current local list: a send for a new card, an edit afterwards. */
  async function write(state: Card): Promise<WriteOutcome> {
    const steps = state.steps.map((step) => ({ ...step }))
    state.lastWriteAt = Date.now()
    try {
      if (state.messageId === undefined) {
        state.messageId = await sendPlanCard(api, state.target.chatId, steps, state.target.threadId)
      } else {
        await editPlanCard(api, state.target.chatId, state.messageId, steps)
      }
      return { ok: true }
    } catch (error) {
      // Telegram refused the write (deleted message, identical content, a
      // network failure): the turn goes on and the model gets a note.
      const reason = reasonOf(error)
      log(`plan: Telegram не принял состояние чеклиста: ${reason}`)
      state.unreported = reason
      return { ok: false, error: reason }
    }
  }

  /**
   * Write the local list to the chat. Without `force` an update that came sooner
   * than the interval is merged into a later edit. Concurrent calls share the
   * running write instead of racing it.
   */
  function drain(state: Card, force = false): Promise<WriteOutcome[]> {
    if (state.writing) return state.writingRun ?? Promise.resolve([])
    state.writing = true
    const run = (async (): Promise<WriteOutcome[]> => {
      const outcomes: WriteOutcome[] = []
      try {
        while (state.dirty) {
          const wait = state.lastWriteAt + interval - Date.now()
          if (wait > 0 && !force) {
            arm(state, wait)
            break
          }
          state.dirty = false
          outcomes.push(await write(state))
        }
      } finally {
        state.writing = false
        state.writingRun = undefined
      }
      return outcomes
    })()
    state.writingRun = run
    return run
  }

  function requireCard(): Card {
    if (!ownerTurnOpen || card === undefined) {
      throw new Error('plan: чеклист доступен только в ходе владельца; сейчас ход владельца не идёт')
    }
    return card
  }

  /**
   * How a written or merged state reads back to the model. A refusal of this
   * write, or of an earlier merged write made by the timer, becomes a note.
   */
  async function deliver(state: Card, successText: string, mergedText: string): Promise<string> {
    let text: string
    if (state.dirty && state.lastWriteAt + interval > Date.now()) {
      arm(state, state.lastWriteAt + interval - Date.now())
      text = mergedText
    } else {
      await drain(state)
      text = successText
    }
    const refused = state.unreported
    if (refused === undefined) return text
    state.unreported = undefined
    return (
      `${text} Не удалось обновить сообщение в Telegram: ${refused}. ` +
      'Чеклист в чате может показывать прежнее состояние, шаги сохранены локально.'
    )
  }

  function noteSent(steps: PlanStep[]): string {
    return `Чеклист отправлен владельцу: ${steps.length} шагов.`
  }

  async function runSet(steps: PlanStep[]): Promise<string> {
    const state = requireCard()
    const replacing = state.messageId !== undefined
    state.steps = steps.map((step) => ({ ...step }))
    state.dirty = true
    return deliver(
      state,
      replacing ? `Чеклист заменён новым списком из ${steps.length} шагов.` : noteSent(steps),
      replacing
        ? `Чеклист заменён новым списком из ${steps.length} шагов; сообщение обновится в ближайшую секунду.`
        : `Чеклист из ${steps.length} шагов сохранён; сообщение появится в ближайшую секунду.`,
    )
  }

  async function runUpdate(stepNumber: number, status: PlanStatus): Promise<string> {
    const state = requireCard()
    if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > state.steps.length) {
      throw new Error(`plan: шага ${stepNumber} нет в чеклисте (в нём ${state.steps.length} шагов, счёт с 1)`)
    }
    state.steps = state.steps.map((step, at) =>
      at === stepNumber - 1 ? { ...step, status } : step,
    )
    state.dirty = true
    const label = `Шаг ${stepNumber} — ${STATUS_LABELS[status]}.`
    return deliver(state, label, `${label} Сообщение обновится в ближайшую секунду.`)
  }

  const tool: RunnerTool = {
    name: 'plan',
    description:
      'Карточка прогресса: один редактируемый чеклист в чате владельца. set задаёт список шагов ' +
      '(ожидает, в работе, готово, ошибка), update переводит один шаг в другой статус. Сообщение ' +
      'правится на месте: владелец видит один чеклист, а не поток новых сообщений.',
    lazy: true,
    loadsMidSession: true,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'update'],
          description: 'set — задать или заменить список шагов, update — сменить статус одного шага',
        },
        steps: {
          type: 'array',
          description:
            'Шаги чеклиста для set: заменяют прежний список целиком, порядок — порядок шагов в карточке',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Короткий текст шага' },
              status: {
                type: 'string',
                enum: [...PLAN_STATUSES],
                description: 'Статус шага: ожидает, в работе, готово или ошибка (по умолчанию ожидает)',
              },
            },
            required: ['title'],
          },
        },
        step: {
          type: 'integer',
          minimum: 1,
          description: 'Номер шага для update, счёт с 1',
        },
        status: {
          type: 'string',
          enum: [...PLAN_STATUSES],
          description: 'Новый статус шага для update: ожидает, в работе, готово или ошибка',
        },
      },
      required: ['action'],
    },
    async execute(args: Record<string, unknown>, _context?: RunnerToolContext): Promise<string> {
      const action = typeof args.action === 'string' ? args.action : ''
      if (action === 'set') return runSet(parseSteps(args.steps))
      if (action === 'update') {
        const rawStep = typeof args.step === 'string' && args.step.trim() !== '' ? Number(args.step) : args.step
        if (typeof rawStep !== 'number' || !Number.isInteger(rawStep)) {
          throw new Error('plan: для update нужен номер шага step (целое число, счёт с 1)')
        }
        return runUpdate(rawStep, parseStatus(args.status, rawStep))
      }
      throw new Error(`plan: неизвестное действие «${action}»; доступно: set, update`)
    },
  }

  return {
    tool,
    async beginTurn(target: PlanTurnTarget): Promise<void> {
      const previous = card
      if (previous !== undefined) {
        if (previous.timer !== undefined) {
          clearTimeout(previous.timer)
          previous.timer = undefined
        }
        // A turn that ended without `endTurn` still owns its last state: write
        // it now, before the new turn opens another message.
        if (previous.dirty) await drain(previous, true)
      }
      card = {
        target: {
          chatId: target.chatId,
          ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
        },
        steps: [],
        messageId: undefined,
        lastWriteAt: 0,
        dirty: false,
        timer: undefined,
        writing: false,
        writingRun: undefined,
        unreported: undefined,
      }
      ownerTurnOpen = true
    },
    async endTurn(): Promise<void> {
      const state = card
      if (state === undefined) {
        ownerTurnOpen = false
        return
      }
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      // A write is already in flight (a timer fired just before the turn end):
      // let it settle, then look at what is still unsent.
      if (state.writing && state.writingRun !== undefined) {
        await state.writingRun.catch(() => undefined)
      }
      if (state.dirty) {
        // Keep the pacing rule even at the end of a turn: two edits of one
        // message closer than the interval are exactly what Telegram rejects.
        const wait = Math.max(0, state.lastWriteAt + interval - Date.now())
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
        await drain(state, true)
      }
      // Outside its owner turn the card is not a target: a planned or wake-up
      // turn must not edit the checklist the owner was just reading.
      ownerTurnOpen = false
      card = undefined
    },
  }
}
