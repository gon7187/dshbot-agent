import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { TelegramApi } from './api.js'
import { decode, encode, handleCallback, sendApproval } from './approval.js'

// Assumed API: encode(payload, store?), decode(data, store?), sendApproval(api, chatId, request, store?),
// handleCallback(api, callbackQuery, { ownerId, store }). A store is a Map-like object keyed by string.

const OWNER = 1001
const STRANGER = 2002
const CHAT = OWNER
const CARD = 42
const NOW = Date.parse('2026-10-23T10:00:00Z')
const TTL = 30 * 60_000

const request = { id: 'appr-1', kind: 'exec', action: 'удалить каталог build', expiresAt: NOW + TTL }

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
  result?: unknown
}

function fakeApi(respond: (method: string, params: Params) => unknown = defaultRespond) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      const call: Call = { method, params }
      calls.push(call)
      call.result = await respond(method, params)
      return call.result as T
    },
  }
  return { api, calls }
}

function defaultRespond(method: string): unknown {
  if (method.startsWith('send')) return { message_id: CARD, date: 0, chat: { id: CHAT, type: 'private' } }
  return true
}

function buttonData(card: Call | undefined, style: string): string | undefined {
  const markup = card?.params.reply_markup as
    | { inline_keyboard: Array<Array<{ style?: string; callback_data?: string }>> }
    | undefined
  return markup?.inline_keyboard.flat().find((b) => b.style === style)?.callback_data
}

function activeButtons(params: Params | undefined): number {
  const markup = params?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined
  return (markup?.inline_keyboard ?? []).flat().filter((b) => b.callback_data !== undefined).length
}

function click(from: number, data: string) {
  return {
    id: 'cbq-1',
    from: { id: from, is_bot: false, first_name: 'Tester' },
    chat_instance: 'ci-1',
    data,
    message: { message_id: CARD, date: 0, chat: { id: CHAT, type: 'private' } },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

test('test_c1_encode_fits_64_bytes_roundtrips_and_rejects_foreign_strings', () => {
  const payload = { kind: 'exec', decision: 'allow', id: 'abc' }
  const data = encode(payload)
  expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
  expect(decode(data)).toEqual(payload)
  for (const bad of ['', 'hello', 'https://example.com/?a=1', 'exec:allow:abc', '\u0000', data.slice(0, 3)]) {
    expect(decode(bad), JSON.stringify(bad)).toBeNull()
  }
})

test('test_c2_long_id_is_shortened_and_decodes_from_store', () => {
  const id = 'ab'.repeat(50)
  const store = new Map()
  const data = encode({ kind: 'exec', decision: 'deny', id }, store)
  expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
  expect(decode(data, store)).toMatchObject({ id })
})

test('test_c3_card_has_success_and_danger_buttons_with_one_callback_action_each', async () => {
  const { api, calls } = fakeApi()
  await sendApproval(api, CHAT, request)
  expect(calls).toHaveLength(1)
  expect(calls[0].method).toMatch(/^send(Message|RichMessage)$/)

  const markup = calls[0].params.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
  const buttons = markup.inline_keyboard.flat()
  expect(buttons).toHaveLength(2)
  expect(buttons.map((b) => b.style).sort()).toEqual(['danger', 'success'])
  for (const button of buttons) {
    const actions = Object.keys(button).filter((k) => !['text', 'style', 'icon_custom_emoji_id'].includes(k))
    expect(actions).toEqual(['callback_data'])
    expect(button.callback_data).toBeTypeOf('string')
  }

  const body = JSON.stringify({ text: calls[0].params.text, rich: calls[0].params.rich_message })
  expect(body).toContain(request.action)
  expect(body).toMatch(/\d{1,2}:\d{2}|\d+\s*мин/)
})

test('test_c3b_always_option_adds_a_third_button_that_records_the_permanent_decision', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, { ...request, always: true }, store)

  const markup = calls[0].params.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }
  const buttons = markup.inline_keyboard.flat()
  expect(buttons).toHaveLength(3)
  expect(buttons.map((b) => b.text)).toEqual(['Разрешить', 'Всегда', 'Отклонить'])
  const always = buttons.find((b) => b.text === 'Всегда')?.callback_data
  expect(always).toBeTypeOf('string')

  await handleCallback(api, click(OWNER, always as string), { ownerId: OWNER, store })
  expect(store.get(request.id)?.decision).toBe('always')
  const answer = calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)
  expect(String(answer?.params.text)).toMatch(/разрешено всегда/i)
  const edit = calls.filter((c) => c.method === 'editMessageText').at(-1)
  expect(JSON.stringify(edit?.params)).toMatch(/разрешено всегда/i)
})

test('test_c4_owner_allow_answers_first_once_records_decision_and_strips_buttons', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, request, store)
  const allow = buttonData(calls[0], 'success')
  expect(allow).toBeTypeOf('string')

  const before = calls.length
  await handleCallback(api, click(OWNER, allow as string), { ownerId: OWNER, store })
  const after = calls.slice(before)

  expect(after[0]?.method).toBe('answerCallbackQuery')
  expect(after.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(1)
  expect([...store.values()].some((r) => r.decision === 'allow')).toBe(true)

  const edits = after.filter((c) => c.method.startsWith('edit') && c.params.message_id === CARD)
  expect(edits.length).toBeGreaterThan(0)
  expect(activeButtons(edits.at(-1)?.params)).toBe(0)
})

test('test_c5_stranger_click_is_answered_but_not_recorded_nor_edits_card', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, request, store)
  const allow = buttonData(calls[0], 'success')
  expect(allow).toBeTypeOf('string')

  const before = calls.length
  await handleCallback(api, click(STRANGER, allow as string), { ownerId: OWNER, store })
  const after = calls.slice(before)

  expect(after.some((c) => c.method === 'answerCallbackQuery')).toBe(true)
  expect([...store.values()].some((r) => r.decision === 'allow' || r.decision === 'deny')).toBe(false)
  expect(after.some((c) => c.method.startsWith('edit'))).toBe(false)
})

test('test_c6_repeat_click_after_decision_keeps_record_and_says_already_decided', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, request, store)
  const allow = buttonData(calls[0], 'success')
  const deny = buttonData(calls[0], 'danger')
  expect(allow).toBeTypeOf('string')
  expect(deny).toBeTypeOf('string')

  await handleCallback(api, click(OWNER, allow as string), { ownerId: OWNER, store })
  const decided = JSON.stringify([...store.values()])

  const before = calls.length
  await handleCallback(api, click(OWNER, deny as string), { ownerId: OWNER, store })

  expect(JSON.stringify([...store.values()])).toBe(decided)
  const answers = calls.slice(before).filter((c) => c.method === 'answerCallbackQuery')
  expect(answers).toHaveLength(1)
  expect(String(answers[0].params.text)).toMatch(/уже|already/i)
})

test('test_c6_click_after_expires_at_is_refused_and_card_marked_expired', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, request, store)
  const allow = buttonData(calls[0], 'success')
  expect(allow).toBeTypeOf('string')

  vi.setSystemTime(request.expiresAt + 1)
  await handleCallback(api, click(OWNER, allow as string), { ownerId: OWNER, store })

  expect([...store.values()].some((r) => r.decision === 'allow')).toBe(false)
  const edits = calls.filter((c) => c.method.startsWith('edit') && c.params.message_id === CARD)
  expect(edits.some((c) => /истекло|истёк|истек|expired/i.test(JSON.stringify(c.params)))).toBe(true)
})

test('test_c8_click_before_send_response_marks_the_delivered_card_decided', async () => {
  const calls: Call[] = []
  let releaseSend: () => void = () => {}
  const api: TelegramApi = {
    call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (method !== 'sendMessage') return Promise.resolve(true as T)
      return new Promise<T>((resolve) => {
        releaseSend = () =>
          resolve({ message_id: CARD, date: 0, chat: { id: CHAT, type: 'private' } } as T)
      })
    },
  }
  const store = new Map()
  const sending = sendApproval(api, CHAT, request, store)

  // The click is handled while sendMessage is still in flight: the record exists, so the
  // decision is taken, but the card id is unknown and cannot be edited yet.
  const allow = buttonData(calls[0], 'success') as string
  await handleCallback(api, click(OWNER, allow), { ownerId: OWNER, store })
  expect(calls.some((c) => c.method.startsWith('edit'))).toBe(false)

  releaseSend()
  await sending

  const edits = calls.filter((c) => c.method.startsWith('edit') && c.params.message_id === CARD)
  expect(edits.length).toBe(1)
  expect(activeButtons(edits[0].params)).toBe(0)
  expect(JSON.stringify(edits[0].params)).toMatch(/разрешено/)
})

test('test_c7_timeout_without_click_records_auto_deny_and_edits_card', async () => {
  const { api, calls } = fakeApi()
  const store = new Map()
  await sendApproval(api, CHAT, request, store)

  await vi.advanceTimersByTimeAsync(TTL + 1000)

  expect([...store.values()].some((r) => r.decision === 'deny')).toBe(true)
  expect(calls.some((c) => c.method.startsWith('edit') && c.params.message_id === CARD)).toBe(true)
})
