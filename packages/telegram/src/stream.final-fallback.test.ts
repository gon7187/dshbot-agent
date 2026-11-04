import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramApiError, type TelegramApi } from './api.js'
import { createReplyStream } from './stream.js'
import { sendFormatted } from './rich/index.js'

const CHAT = 2002
const THREAD = 91
type Params = Record<string, unknown>
interface Call { method: string; params: Params; rejected: boolean }
function fakeApi(reject: (method: string, params: Params, nth: number) => string | undefined = () => undefined) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const api: TelegramApi = { async call<T>(method: string, params: Params = {}): Promise<T> {
    const nth = (counts.get(method) ?? 0) + 1
    counts.set(method, nth)
    const reason = reject(method, params, nth)
    calls.push({ method, params, rejected: reason !== undefined })
    if (reason !== undefined) throw new TelegramApiError(method, 400, reason)
    return { message_id: 100 + calls.length } as T
  } }
  return { api, calls }
}
function payload(calls: Call[]): string {
  return calls.filter(c => !c.rejected && ['sendRichMessage', 'sendMessage'].includes(c.method))
    .map(c => c.method === 'sendRichMessage' ? String((c.params.rich_message as Params).markdown) : String(c.params.text)).join('\n')
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
afterEach(() => vi.useRealTimers())

test('F1 rich and HTML rejection after an earlier part conserves ordered payload and thread', async () => {
  const { api, calls } = fakeApi((method, params, nth) =>
    method === 'sendRichMessage' && nth === 2 ? 'Bad Request: rich message is invalid' :
    method === 'sendMessage' && params.parse_mode === 'HTML' && nth === 2 ? "Bad Request: can't parse entities" : undefined)
  const stream = createReplyStream({ api, chatId: CHAT, threadId: THREAD })
  const text = Array.from({ length: 1200 }, (_, i) => `- ITEM-${i}-end`).join('\n')
  await stream.finish(text)
  expect(calls.some(c => c.rejected && c.method === 'sendRichMessage')).toBe(true)
  expect(calls.some(c => c.rejected && c.params.parse_mode === 'HTML')).toBe(true)
  expect([...payload(calls).matchAll(/ITEM-(\d+)-end/g)].map(m => Number(m[1]))).toEqual(Array.from({ length: 1200 }, (_, i) => i))
  for (const call of calls) expect(call.params.message_thread_id).toBe(THREAD)
})

test('F2 keyboard rejection retries unsent part only; missing thread never retries elsewhere', async () => {
  const { api, calls } = fakeApi((_method, params) => params.reply_markup ? 'Bad Request: BUTTON_COPY_TEXT_INVALID' : undefined)
  const text = Array.from({ length: 3 }, (_, i) => `PART-${i} ${'word '.repeat(30)}`).join('\n\n')
  await sendFormatted(api, CHAT, text, { maxChars: 250, threadId: THREAD, replyMarkup: { inline_keyboard: [[{ text: 'Copy', copy_text: { text: 'x' } }]] } })
  expect(calls.some(c => c.rejected)).toBe(true)
  expect([...payload(calls).matchAll(/PART-(\d+)/g)].map(m => Number(m[1]))).toEqual([0, 1, 2])
  const missing = fakeApi(() => 'Bad Request: message thread not found')
  await expect(sendFormatted(missing.api, CHAT, 'thread payload', { threadId: THREAD })).rejects.toThrow(/thread/i)
  expect(missing.calls).toHaveLength(2)
  for (const call of missing.calls) expect(call.params.message_thread_id).toBe(THREAD)
})

test('F3 foreign stop ignored, own stop fires once; finish and abort remove keyboard and cancel drafts', async () => {
  const { api, calls } = fakeApi()
  const onStop = vi.fn()
  const stream = createReplyStream({ api, chatId: CHAT, onStop })
  await stream.update('draft')
  await vi.advanceTimersByTimeAsync(0)
  const draftId = calls.find(c => c.method === 'sendRichMessageDraft')?.params.draft_id as number
  await stream.onStopped(draftId + 1)
  expect(onStop).not.toHaveBeenCalled()
  await stream.onStopped(draftId)
  await stream.onStopped(draftId)
  expect(onStop).toHaveBeenCalledOnce()
  await stream.finish('final payload')
  const finalCount = calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(calls).toHaveLength(finalCount)

  for (const end of ['finish', 'abort'] as const) {
    const fake = fakeApi()
    const edit = createReplyStream({ api: fake.api, chatId: CHAT, mode: 'edit' })
    await edit.update('preview')
    await vi.advanceTimersByTimeAsync(1100)
    const preview = fake.calls.find(c => c.method === 'sendMessage')
    expect(preview?.params.reply_markup).toBeDefined()
    if (end === 'finish') await edit.finish('final')
    else { edit.abort(); await edit.cleanup() }
    const cleanup = fake.calls.filter(c => (c.method.startsWith('edit') || c.method === 'deleteMessage') && c.params.message_id === 101).at(-1)
    expect(cleanup).toBeDefined()
    expect(JSON.stringify(cleanup?.params.reply_markup ?? {})).not.toContain('callback_data')
    const count = fake.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls).toHaveLength(count)
  }
})
