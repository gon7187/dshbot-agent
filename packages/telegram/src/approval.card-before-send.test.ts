import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { TelegramApi } from './api.js'
import { encode, handleCallback, sendApproval, type ApprovalRecord } from './approval.js'

const OWNER = 1001
const STRANGER = 2002
const CHAT = OWNER
const CARD = 77
const NOW = Date.parse('2026-10-23T10:00:00Z')
const TTL = 30 * 60_000

const request = { id: 'appr-race', kind: 'exec', action: 'удалить каталог build', expiresAt: NOW + TTL }

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

// An api whose sendMessage stays pending until `finishSend` / `failSend` is called.
function slowSendApi() {
  const calls: Call[] = []
  let finishSend: () => void = () => {}
  let failSend: (error: Error) => void = () => {}
  let sendStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    sendStarted = resolve
  })
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (method === 'sendMessage') {
        sendStarted()
        await new Promise<void>((resolve, reject) => {
          finishSend = resolve
          failSend = reject
        })
        return { message_id: CARD, date: 0, chat: { id: CHAT, type: 'private' } } as T
      }
      return true as T
    },
  }
  return {
    api,
    calls,
    started,
    finishSend: () => finishSend(),
    failSend: (error: Error) => failSend(error),
  }
}

function buttonData(calls: Call[], style: string): string {
  const card = calls.find((c) => c.method === 'sendMessage')
  const markup = card?.params.reply_markup as
    | { inline_keyboard: Array<Array<{ style?: string; callback_data?: string }>> }
    | undefined
  const data = markup?.inline_keyboard.flat().find((b) => b.style === style)?.callback_data
  expect(data).toBeTypeOf('string')
  return data as string
}

function click(from: number, data: string) {
  return {
    id: 'cbq-race',
    from: { id: from, is_bot: false, first_name: 'Tester' },
    chat_instance: 'ci-1',
    data,
    message: { message_id: CARD, date: 0, chat: { id: CHAT, type: 'private' } },
  }
}

function answerTexts(calls: Call[], from = 0): string[] {
  return calls
    .slice(from)
    .filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => String(c.params.text))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

test('test_c1_click_handled_before_sendmessage_returns_records_decision', async () => {
  for (const [style, decision] of [
    ['success', 'allow'],
    ['danger', 'deny'],
  ] as const) {
    const { api, calls, started, finishSend } = slowSendApi()
    const store = new Map<string, ApprovalRecord>()
    const id = `appr-${decision}`
    const sending = sendApproval(api, CHAT, { ...request, id }, store)
    await started

    const data = buttonData(calls, style)
    const before = calls.length
    await handleCallback(api, click(OWNER, data), { ownerId: OWNER, store })

    const answers = answerTexts(calls, before)
    expect(answers, decision).toHaveLength(1)
    expect(answers[0], decision).not.toMatch(/не найден|устарел/)
    expect(store.get(id)?.decision, decision).toBe(decision)

    finishSend()
    await sending
    expect(store.get(id)?.decision, decision).toBe(decision)
  }
})

test('test_c2_message_id_is_filled_after_send_and_expiry_edits_that_card', async () => {
  const { api, calls, started, finishSend } = slowSendApi()
  const store = new Map<string, ApprovalRecord>()
  const sending = sendApproval(api, CHAT, request, store)
  await started
  finishSend()
  const sent = await sending

  expect(sent.messageId).toBe(CARD)
  expect(store.get(request.id)?.messageId).toBe(CARD)

  const before = calls.length
  await vi.advanceTimersByTimeAsync(TTL + 1000)

  expect(store.get(request.id)?.decision).toBe('deny')
  const edits = calls.slice(before).filter((c) => c.method.startsWith('edit'))
  expect(edits.length).toBeGreaterThan(0)
  expect(edits.every((c) => c.params.message_id === CARD && c.params.chat_id === CHAT)).toBe(true)
  expect(JSON.stringify(edits.at(-1)?.params)).toMatch(/истекло|истёк|истек/)
})

test('test_c3_failed_sendmessage_removes_record_and_rejects_with_the_error', async () => {
  const { api, calls, started, failSend } = slowSendApi()
  const store = new Map<string, ApprovalRecord>()
  const sending = sendApproval(api, CHAT, request, store)
  const outcome = sending.then(
    () => null,
    (error: unknown) => error,
  )
  await started

  const failure = new Error('sendMessage boom')
  failSend(failure)

  expect(await outcome).toBe(failure)
  expect(store.has(request.id)).toBe(false)
  expect([...store.values()].some((r) => r.id === request.id)).toBe(false)

  // No expiry timer survives for the removed record.
  const before = calls.length
  await vi.advanceTimersByTimeAsync(TTL + 1000)
  expect(calls.slice(before).filter((c) => c.method.startsWith('edit'))).toHaveLength(0)
})

test('test_c4_stranger_and_stale_card_clicks_are_handled_as_before', async () => {
  const { api, calls, started, finishSend } = slowSendApi()
  const store = new Map<string, ApprovalRecord>()
  const sending = sendApproval(api, CHAT, request, store)
  await started
  const allow = buttonData(calls, 'success')

  // A stranger pressing the live card is refused and nothing is recorded.
  let before = calls.length
  await handleCallback(api, click(STRANGER, allow), { ownerId: OWNER, store })
  expect(answerTexts(calls, before)).toEqual(['Недостаточно прав'])
  expect(store.get(request.id)?.decision ?? null).toBeNull()
  expect(calls.slice(before).some((c) => c.method.startsWith('edit'))).toBe(false)

  finishSend()
  await sending
  expect(store.get(request.id)?.decision ?? null).toBeNull()

  // A card nobody registered is stale.
  const stale = encode({ kind: 'exec', decision: 'allow', id: 'appr-unknown' })
  before = calls.length
  await handleCallback(api, click(OWNER, stale), { ownerId: OWNER, store })
  expect(answerTexts(calls, before)).toEqual(['Запрос не найден или устарел'])
  expect(store.has('appr-unknown')).toBe(false)

  // A repeat click after the decision is still "already decided".
  await handleCallback(api, click(OWNER, allow), { ownerId: OWNER, store })
  expect(store.get(request.id)?.decision).toBe('allow')
  before = calls.length
  await handleCallback(api, click(OWNER, buttonData(calls, 'danger')), { ownerId: OWNER, store })
  expect(answerTexts(calls, before)).toEqual(['Уже решено'])
  expect(store.get(request.id)?.decision).toBe('allow')
})
