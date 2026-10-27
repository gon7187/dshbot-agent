import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramApiError } from './api.js'
import type { TelegramApi } from './api.js'
import * as streamModule from './stream.js'

const CHAT = 2002
const THREAD = 91
const PREVIEW_ID = 55

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

interface Stream {
  update(markdown: string): unknown
  finish(markdown: string): unknown
  abort(): unknown
  onStopped(draftId: number): unknown
}

const createReplyStream = streamModule.createReplyStream as unknown as (options: Params) => Stream

const FINAL_MD = 'Итоговый **ответ** про zebra\n\n- first-item\n- second-item'
const FINAL_WORDS = ['ответ', 'zebra', 'first-item', 'second-item']

// Первый sendMessage отдаёт PREVIEW_ID (превью в режиме edit), следующие — другие id,
// чтобы финальные сообщения не путались с превью.
function fakeApi(failing: string[]) {
  const calls: Call[] = []
  let nextMessageId = PREVIEW_ID
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (failing.includes(method)) throw new TelegramApiError(method, 400, 'Bad Request: not supported in this chat')
      if (method === 'sendMessage') {
        const id = nextMessageId
        nextMessageId = id === PREVIEW_ID ? 700 : id + 1
        return { message_id: id } as T
      }
      if (method === 'sendRichMessage') return { message_id: 600 } as T
      return true as T
    },
  }
  return { api, calls }
}

function plainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function runFinish(stream: Stream, markdown: string): Promise<unknown> {
  return Promise.resolve(stream.finish(markdown)).then(
    () => undefined,
    (error: unknown) => error ?? new Error('finish rejected'),
  )
}

function hasStopButton(markup: unknown): boolean {
  if (!markup || typeof markup !== 'object') return false
  const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard
  return Array.isArray(rows) && rows.flat().length > 0
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

test('test_h1_final_rich_400_still_delivers_whole_text_via_send_message_with_thread_id', async () => {
  const { api, calls } = fakeApi(['sendRichMessage'])
  const stream = createReplyStream({ api, chatId: CHAT, threadId: THREAD })

  await stream.update('черновик')
  await vi.advanceTimersByTimeAsync(0)
  const before = calls.length
  const failure = await runFinish(stream, FINAL_MD)

  const sent = calls.slice(before).filter((c) => c.method === 'sendMessage')
  expect(sent.length).toBeGreaterThanOrEqual(1)
  const delivered = sent.map((c) => plainText(c.params.text)).join('\n')
  for (const word of FINAL_WORDS) expect(delivered).toContain(word)
  for (const call of sent) {
    expect(call.params.chat_id).toBe(CHAT)
    expect(call.params.message_thread_id).toBe(THREAD)
  }
  expect(failure).toBeUndefined()
})

test('test_h1_final_after_ladder_fell_to_text_draft_is_delivered_when_rich_does_not_work', async () => {
  const { api, calls } = fakeApi(['sendRichMessageDraft', 'sendRichMessage'])
  const stream = createReplyStream({ api, chatId: CHAT, threadId: THREAD })

  await stream.update('первый кусок')
  await vi.advanceTimersByTimeAsync(1100)
  await stream.update('первый кусок и ещё')
  await vi.advanceTimersByTimeAsync(1100)
  expect(calls.some((c) => c.method === 'sendMessageDraft')).toBe(true)

  const before = calls.length
  const failure = await runFinish(stream, FINAL_MD)

  const sent = calls.slice(before).filter((c) => c.method === 'sendMessage')
  expect(sent.length).toBeGreaterThanOrEqual(1)
  const delivered = sent.map((c) => plainText(c.params.text)).join('\n')
  for (const word of FINAL_WORDS) expect(delivered).toContain(word)
  for (const call of sent) expect(call.params.message_thread_id).toBe(THREAD)
  expect(failure).toBeUndefined()
})

test('test_h1_edit_mode_final_removes_stop_button_from_preview_message', async () => {
  const { api, calls } = fakeApi([])
  const stream = createReplyStream({ api, chatId: CHAT, threadId: THREAD, mode: 'edit' })

  await stream.update('черновик в режиме edit')
  await vi.advanceTimersByTimeAsync(1100)
  const preview = calls.find((c) => c.method === 'sendMessage')
  expect(preview).toBeDefined()
  expect(hasStopButton(preview?.params.reply_markup)).toBe(true)

  const before = calls.length
  const failure = await runFinish(stream, FINAL_MD)

  const after = calls.slice(before)
  const delivered = after
    .filter((c) => c.method === 'sendRichMessage' || c.method === 'sendMessage' || c.method === 'editMessageText')
    .map((c) => JSON.stringify(c.params) + plainText(c.params.text))
    .join('\n')
  for (const word of FINAL_WORDS) expect(delivered).toContain(word)

  const cleanups = after.filter(
    (c) =>
      (c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup') &&
      c.params.message_id === PREVIEW_ID,
  )
  expect(cleanups.length).toBeGreaterThanOrEqual(1)
  expect(hasStopButton(cleanups[cleanups.length - 1].params.reply_markup)).toBe(false)
  expect(failure).toBeUndefined()
})

test('test_h1_edit_mode_with_rich_400_delivers_text_and_still_removes_stop_button', async () => {
  const { api, calls } = fakeApi(['sendRichMessage'])
  const stream = createReplyStream({ api, chatId: CHAT, threadId: THREAD, mode: 'edit' })

  await stream.update('черновик в режиме edit')
  await vi.advanceTimersByTimeAsync(1100)

  const before = calls.length
  const failure = await runFinish(stream, FINAL_MD)

  const after = calls.slice(before)
  const delivered = after
    .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
    .map((c) => plainText(c.params.text))
    .join('\n')
  for (const word of FINAL_WORDS) expect(delivered).toContain(word)
  for (const call of after.filter((c) => c.method === 'sendMessage')) {
    expect(call.params.message_thread_id).toBe(THREAD)
  }

  const cleanups = after.filter(
    (c) =>
      (c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup') &&
      c.params.message_id === PREVIEW_ID,
  )
  expect(cleanups.length).toBeGreaterThanOrEqual(1)
  expect(hasStopButton(cleanups[cleanups.length - 1].params.reply_markup)).toBe(false)
  expect(failure).toBeUndefined()
})
