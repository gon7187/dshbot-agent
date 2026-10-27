// Approval cards for the owner: compact callback_data codec, an inline-keyboard card
// with Bot API 10.x styles, a click handler and an expiry timer.
//
// callback_data is limited to 64 bytes. Short ids travel inline ("tga1:<kind>:<decision>:<id>");
// longer ids are replaced by a deterministic ref stored in the caller-provided store and
// travel as "tga1r:<kind>:<decision>:<ref>". The same store also keeps the pending
// approval record, so a click is authorised against the canonical record, never against
// the raw callback string.

import { createHash } from 'node:crypto'
import type { TelegramApi } from './api.js'

/** Hard Bot API limit for callback_data, in UTF-8 bytes. */
export const CALLBACK_DATA_LIMIT = 64

/** Default lifetime of an approval card. */
export const APPROVAL_TTL_MS = 30 * 60_000

export type ApprovalKind = 'exec' | 'prompt' | 'session'
export type ApprovalDecision = 'allow' | 'always' | 'deny'

export interface ApprovalPayload {
  // Kept wide so plain object literals from callers type-check; known values are
  // validated at runtime.
  kind: string
  decision: string
  id: string
}

export interface ApprovalRequest {
  id: string
  kind: string
  /** Human-readable description of the action being approved. */
  action: string
  /**
   * Plain-Russian explanation of what pressing «Разрешить» will do, built from
   * the action itself. It is the last paragraph of the card, right above the
   * buttons, and stays there after the decision.
   */
  explanation?: string
  /** Unix epoch milliseconds. */
  expiresAt: number
  /** Offer the third, "Всегда" button: the exact command is permitted from now on. */
  always?: boolean
}

export interface ApprovalRecord {
  id: string
  kind?: string
  decision?: string | null
  action?: string
  explanation?: string
  expiresAt?: number
  chatId?: number
  messageId?: number
  decidedAt?: number
  decidedBy?: number
  reason?: 'click' | 'timeout' | 'expired'
}

/** Map-like storage keyed by string: pending records plus long-id refs. */
export type ApprovalStore = Map<string, ApprovalRecord>

export interface CallbackQueryLike {
  id: string
  from: { id: number }
  data?: string
  message?: { message_id: number; chat?: { id: number } }
}

export interface HandleCallbackOptions {
  /** Numeric Telegram user id of the only person allowed to decide. */
  ownerId: number
  store: ApprovalStore
}

export interface SentApproval {
  messageId: number | undefined
  record: ApprovalRecord | undefined
}

const PREFIX = 'tga1'
const REF_PREFIX = 'tga1r'
const REF_STORE_PREFIX = 'approval-ref:'

const KIND_CODES: Record<ApprovalKind, string> = { exec: 'e', prompt: 'p', session: 's' }
const DECISION_CODES: Record<ApprovalDecision, string> = { allow: 'a', always: 'w', deny: 'd' }
const KIND_BY_CODE = new Map(Object.entries(KIND_CODES).map(([kind, code]) => [code, kind]))
const DECISION_BY_CODE = new Map(Object.entries(DECISION_CODES).map(([decision, code]) => [code, decision]))

const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function refFor(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)
}

function refKey(ref: string): string {
  return `${REF_STORE_PREFIX}${ref}`
}

/**
 * Encode an approval decision for callback_data. Returns a string of at most 64 bytes.
 * For ids that do not fit (or contain the field separator) a short deterministic ref is
 * written to `store` and used instead.
 */
export function encode(payload: ApprovalPayload, store?: ApprovalStore): string {
  const kind = KIND_CODES[payload.kind as ApprovalKind]
  const decision = DECISION_CODES[payload.decision as ApprovalDecision]
  if (!kind) throw new Error(`unknown approval kind: ${String(payload.kind)}`)
  if (!decision) throw new Error(`unknown approval decision: ${String(payload.decision)}`)
  if (!payload.id) throw new Error('approval id is empty')

  const direct = `${PREFIX}:${kind}:${decision}:${payload.id}`
  if (!payload.id.includes(':') && byteLength(direct) <= CALLBACK_DATA_LIMIT) return direct

  if (!store) {
    throw new Error('approval id does not fit callback_data and no store was provided')
  }
  const ref = refFor(payload.id)
  store.set(refKey(ref), { id: payload.id })
  const shortened = `${REF_PREFIX}:${kind}:${decision}:${ref}`
  if (byteLength(shortened) > CALLBACK_DATA_LIMIT) {
    throw new Error('approval ref does not fit callback_data')
  }
  return shortened
}

/** Decode callback_data, returning null for foreign, malformed or unknown refs. */
export function decode(data: string, store?: ApprovalStore): ApprovalPayload | null {
  if (typeof data !== 'string' || data.length === 0) return null
  if (byteLength(data) > CALLBACK_DATA_LIMIT) return null

  const parts = data.split(':')
  if (parts.length !== 4) return null

  const [prefix, kindCode, decisionCode, tail] = parts
  if (prefix !== PREFIX && prefix !== REF_PREFIX) return null
  if (!tail) return null

  const kind = KIND_BY_CODE.get(kindCode)
  const decision = DECISION_BY_CODE.get(decisionCode)
  if (kind === undefined || decision === undefined) return null

  if (prefix === PREFIX) return { kind, decision, id: tail }

  const record = store?.get(refKey(tail))
  if (!record || typeof record.id !== 'string' || record.id.length === 0) return null
  return { kind, decision, id: record.id }
}

function formatDeadline(expiresAt: number): string {
  const date = new Date(expiresAt)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const leftMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))
  return `до ${hours}:${minutes} (${leftMinutes} мин)`
}

function clearExpiryTimer(record: ApprovalRecord): void {
  const key = timerKey(record)
  const timer = expiryTimers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    expiryTimers.delete(key)
  }
}

function timerKey(record: ApprovalRecord): string {
  return `${record.chatId ?? ''}:${record.id}`
}

function scheduleExpiry(api: TelegramApi, record: ApprovalRecord): void {
  clearExpiryTimer(record)
  if (record.expiresAt === undefined) return
  const delay = Math.max(0, record.expiresAt - Date.now())
  const timer = setTimeout(() => {
    expiryTimers.delete(timerKey(record))
    void expireApproval(api, record).catch(() => {
      // A failed auto-expiry edit must not crash the process; the record is already denied.
    })
  }, delay)
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
  expiryTimers.set(timerKey(record), timer)
}

async function expireApproval(api: TelegramApi, record: ApprovalRecord): Promise<void> {
  if (record.decision != null) return
  if (record.expiresAt !== undefined && Date.now() < record.expiresAt) {
    // The clock moved backwards; wait for the real deadline instead of expiring early.
    scheduleExpiry(api, record)
    return
  }
  record.decision = 'deny'
  record.reason = 'timeout'
  record.decidedAt = Date.now()
  await editCard(api, record, 'истекло')
}

/** Hard Bot API limit for the text of one message, in characters. */
export const CARD_TEXT_LIMIT = 4096

function editParams(record: ApprovalRecord, text: string): Record<string, unknown> | null {
  if (record.messageId === undefined) return null
  const params: Record<string, unknown> = {
    message_id: record.messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  }
  if (record.chatId !== undefined) params.chat_id = record.chatId
  return params
}

/**
 * Keep the card within one Telegram message without losing the explanation:
 * only the action is shortened, the deadline line and the explanation stay
 * whole.
 */
function cardAction(action: string, suffix: string): string {
  const room = CARD_TEXT_LIMIT - suffix.length
  if (room <= 0) return ''
  if (action.length <= room) return action
  return `${action.slice(0, Math.max(0, room - 1))}…`
}

async function editCard(api: TelegramApi, record: ApprovalRecord, status: string): Promise<void> {
  const action = record.action ?? 'Запрос'
  const explanation = record.explanation?.trim() ?? ''
  const body = explanation === '' ? action : `${action}\n${explanation}`
  const params = editParams(record, `${body}\nСтатус: ${status}`)
  if (params === null) return
  await api.call('editMessageText', params)
}

async function answer(api: TelegramApi, callbackQueryId: string, text: string): Promise<void> {
  await api.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
}

/**
 * Send the approval card: one message with the action, its deadline and two
 * styled buttons (three when the caller offers "Всегда"). When a store is
 * given, the pending record is registered before the card is sent and the
 * expiry timer starts once its message id is known.
 */
export async function sendApproval(
  api: TelegramApi,
  chatId: number,
  request: ApprovalRequest,
  store?: ApprovalStore,
): Promise<SentApproval> {
  const allowData = encode({ kind: request.kind, decision: 'allow', id: request.id }, store)
  const denyData = encode({ kind: request.kind, decision: 'deny', id: request.id }, store)
  const alwaysData =
    request.always === true ? encode({ kind: request.kind, decision: 'always', id: request.id }, store) : undefined

  const explanation = request.explanation?.trim() ?? ''
  const deadline = `Срок действия: ${formatDeadline(request.expiresAt)}`
  const suffix = explanation === '' ? `\n${deadline}` : `\n${deadline}\n\n${explanation}`
  const action = cardAction(request.action, suffix)
  const text = `${action}${suffix}`

  const buttons: Array<Record<string, unknown>> = [
    { text: 'Разрешить', style: 'success', callback_data: allowData },
  ]
  if (alwaysData !== undefined) {
    buttons.push({ text: 'Всегда', style: 'primary', callback_data: alwaysData })
  }
  buttons.push({ text: 'Отклонить', style: 'danger', callback_data: denyData })

  // Register the pending record before the card is sent. The poller may deliver a click
  // that the Bot API created while sendMessage was still in flight; such a click must find
  // the canonical record and record the decision instead of "запрос не найден".
  let record: ApprovalRecord | undefined
  if (store) {
    record = {
      id: request.id,
      kind: request.kind,
      action,
      ...(explanation === '' ? {} : { explanation }),
      expiresAt: request.expiresAt,
      decision: null,
      chatId,
    }
    store.set(request.id, record)
  }

  let message: { message_id?: number } | undefined
  try {
    message = await api.call<{ message_id?: number }>('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [buttons],
      },
    })
  } catch (error) {
    if (store && record !== undefined) {
      // The card was never delivered: drop the record (and the long-id ref encode wrote)
      // so a stray click cannot decide an approval the owner never saw.
      clearExpiryTimer(record)
      if (store.get(request.id) === record) store.delete(request.id)
      const ref = refKey(refFor(request.id))
      if (store.get(ref)?.id === request.id) store.delete(ref)
    }
    throw error
  }

  if (!store || record === undefined) return { messageId: message?.message_id, record: undefined }

  // The response can arrive after a click decided this approval; the record already holds
  // the decision, so only the message id still has to be attached.
  record.messageId = message?.message_id
  if (record.decision != null) {
    // That click could not edit the card (its message id was unknown then), so apply the
    // decided state now. A failed cosmetic edit must not turn a sent card into an error.
    await editCard(api, record, decidedStatus(record)).catch(() => {
      // The decision is recorded; a stale card with buttons is the only side effect.
    })
  } else {
    scheduleExpiry(api, record)
  }
  return { messageId: record.messageId, record }
}

function decidedStatus(record: ApprovalRecord): string {
  if (record.reason === 'timeout' || record.reason === 'expired') return 'истекло'
  if (record.decision === 'always') return 'разрешено всегда'
  return record.decision === 'allow' ? 'разрешено' : 'отклонено'
}

/**
 * Handle a click on an approval card. answerCallbackQuery is always the first call and
 * only the configured owner may record a decision.
 */
export async function handleCallback(
  api: TelegramApi,
  query: CallbackQueryLike,
  options: HandleCallbackOptions,
): Promise<void> {
  const decoded = typeof query.data === 'string' ? decode(query.data, options.store) : null
  if (decoded === null) {
    await answer(api, query.id, 'Кнопка не распознана')
    return
  }

  const record = options.store.get(decoded.id)
  if (!record) {
    await answer(api, query.id, 'Запрос не найден или устарел')
    return
  }

  if (query.from?.id !== options.ownerId) {
    await answer(api, query.id, 'Недостаточно прав')
    return
  }

  if (record.decision != null) {
    await answer(api, query.id, 'Уже решено')
    return
  }

  if (record.expiresAt !== undefined && Date.now() >= record.expiresAt) {
    await answer(api, query.id, 'Срок истёк')
    clearExpiryTimer(record)
    record.decision = 'deny'
    record.reason = 'expired'
    record.decidedAt = Date.now()
    record.decidedBy = query.from.id
    await editCard(api, record, 'истекло')
    return
  }

  const allowed = decoded.decision === 'allow' || decoded.decision === 'always'
  const always = decoded.decision === 'always'
  await answer(api, query.id, always ? 'Разрешено всегда' : allowed ? 'Разрешено' : 'Отклонено')
  clearExpiryTimer(record)
  record.decision = decoded.decision
  record.reason = 'click'
  record.decidedAt = Date.now()
  record.decidedBy = query.from.id
  await editCard(api, record, decidedStatus(record))
}
