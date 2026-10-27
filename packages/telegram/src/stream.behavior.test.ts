import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramApiError } from './api.js'
import type { TelegramApi } from './api.js'
import { normalizeMarkdownHardBreaks, splitMarkdown } from './rich/index.js'
import * as streamModule from './stream.js'

// Assumed API: createReplyStream({ api, chatId, threadId?, mode?, onStop? }) returns
// { update, status, finish, abort, onStopped }. The turn-stop callback is passed as `onStop`
// (a property of the returned object with that name is also set when it is not a function).

const CHAT = 1001

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
  at: number
}

interface Stream {
  update(markdown: string): unknown
  status(text: string): unknown
  finish(markdown: string): unknown
  abort(): unknown
  onStopped(draftId: number): unknown
  onStop?: unknown
}

const createReplyStream = streamModule.createReplyStream as unknown as (options: Params) => Stream

function fakeApi(respond: (method: string, params: Params) => unknown = () => undefined) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params, at: Date.now() })
      const custom = await respond(method, params)
      if (custom !== undefined) return custom as T
      if (method === 'sendMessage' || method === 'sendRichMessage') return { message_id: 55 } as T
      return true as T
    },
  }
  return { api, calls }
}

function open(api: TelegramApi, extra: Params = {}) {
  const onStop = vi.fn()
  const stream = createReplyStream({ api, chatId: CHAT, onStop, ...extra })
  if (typeof stream.onStop !== 'function') stream.onStop = onStop
  return { stream, onStop }
}

function methodCalls(calls: Call[], ...methods: string[]): Call[] {
  return calls.filter((c) => methods.includes(c.method))
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

test('test_c1_five_updates_in_300ms_give_one_draft_now_and_one_after_a_second_with_latest_text', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo']

  for (const word of words) {
    await stream.update(word)
    await tick(75)
  }
  await tick(0)

  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(1)
  expect(json(calls[0].params.rich_message)).toContain('alpha')

  await tick(1100)

  const drafts = methodCalls(calls, 'sendRichMessageDraft')
  expect(drafts).toHaveLength(2)
  expect(json(drafts[1].params.rich_message)).toContain('echo')
  expect(json(drafts[1].params.rich_message)).not.toContain('delta')

  const ids = new Set(drafts.map((d) => d.params.draft_id))
  expect(ids.size).toBe(1)
  const id = drafts[0].params.draft_id
  expect(typeof id).toBe('number')
  expect(id).not.toBe(0)
  for (const draft of drafts) {
    expect(draft.params.chat_id).toBe(CHAT)
    expect(draft.params.can_stop).toBe(true)
    expect(draft.params.keep_on_stop).toBe(true)
  }
})

test('test_c2_silence_for_25s_resends_the_same_draft_before_it_expires', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)
  const start = Date.now()

  await stream.update('hold this text')
  await tick(25_000)

  const drafts = methodCalls(calls, 'sendRichMessageDraft')
  expect(drafts.length).toBeGreaterThanOrEqual(2)
  expect(drafts[1].at - start).toBeLessThan(30_000)
  expect(drafts[1].params.draft_id).toBe(drafts[0].params.draft_id)
  expect(drafts[1].params.rich_message).toEqual(drafts[0].params.rich_message)
})

test('test_c3_status_adds_thinking_tag_to_draft_but_not_to_final_message', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)

  await stream.update('working on it')
  await tick(0)
  await stream.status('запускаю тесты')
  await tick(1100)

  const drafts = methodCalls(calls, 'sendRichMessageDraft')
  const last = drafts[drafts.length - 1]
  const rich = last.params.rich_message as { markdown?: string; blocks?: unknown }
  expect(rich.blocks, 'черновик не превращается в blocks').toBeUndefined()
  expect(typeof rich.markdown, 'черновик несёт markdown').toBe('string')
  expect(rich.markdown).toContain('<tg-thinking>запускаю тесты</tg-thinking>')
  expect(rich.markdown).toContain('working on it')

  await stream.finish('working on it, done')
  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals.length).toBeGreaterThanOrEqual(1)
  for (const final of finals) {
    const markdown = (final.params.rich_message as { markdown?: string }).markdown ?? ''
    expect(markdown).not.toContain('tg-thinking')
    expect(markdown).not.toContain('запускаю тесты')
  }
})

test('test_c4_finish_sends_full_text_as_one_rich_message_and_stops_drafts', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)
  const md = 'Hello **world**\n\n- one\n- two'

  await stream.update(md)
  await tick(0)
  await stream.finish(md)

  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals).toHaveLength(1)
  expect(finals[0].params.chat_id).toBe(CHAT)
  expect((finals[0].params.rich_message as { markdown?: string }).markdown).toBe(normalizeMarkdownHardBreaks(md))

  const before = calls.length
  await stream.update('late update')
  await tick(60_000)
  expect(calls.length).toBe(before)
})

test('test_c4_finish_over_limits_sends_several_rich_messages_in_order', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)
  const md = Array.from({ length: 1200 }, (_, i) => `Paragraph number ${i}`).join('\n\n')
  const expected = splitMarkdown(normalizeMarkdownHardBreaks(md))
  expect(expected.length).toBeGreaterThan(1)

  await stream.finish(md)

  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals).toHaveLength(expected.length)
  finals.forEach((final, i) => {
    expect((final.params.rich_message as { markdown?: string }).markdown).toBe(expected[i])
  })

  const before = calls.length
  await tick(60_000)
  expect(calls.length).toBe(before)
  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(0)
})

test('test_c5_on_stopped_ignores_foreign_draft_id', async () => {
  const { api, calls } = fakeApi()
  const { stream, onStop } = open(api)

  await stream.update('partial text')
  await tick(0)
  const draftId = methodCalls(calls, 'sendRichMessageDraft')[0].params.draft_id as number

  await stream.onStopped(draftId + 12345)

  expect(onStop).not.toHaveBeenCalled()
})

test('test_c5_on_stopped_with_own_draft_id_calls_stop_once_and_finish_marks_stopped', async () => {
  const { api, calls } = fakeApi()
  const { stream, onStop } = open(api)

  await stream.update('partial text')
  await tick(0)
  const draftId = methodCalls(calls, 'sendRichMessageDraft')[0].params.draft_id as number

  await stream.onStopped(draftId + 1)
  expect(onStop).not.toHaveBeenCalled()
  await stream.onStopped(draftId)
  expect(onStop).toHaveBeenCalledTimes(1)

  await stream.finish('partial text')

  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals.length).toBeGreaterThanOrEqual(1)
  const sent = finals.map((f) => json(f.params.rich_message)).join('\n')
  expect(sent).toContain('partial text')
  expect(sent.toLowerCase()).toContain('остановлен')
  expect(onStop).toHaveBeenCalledTimes(1)
})

test('test_c6_rich_draft_400_switches_to_send_message_draft', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'sendRichMessageDraft') throw new TelegramApiError(method, 400, 'Bad Request: method is not supported')
    return undefined
  })
  const { stream } = open(api)

  await stream.update('first text')
  await tick(1100)
  await stream.update('first text and more')
  await tick(1100)

  const textDrafts = methodCalls(calls, 'sendMessageDraft')
  expect(textDrafts.length).toBeGreaterThanOrEqual(1)
  expect(textDrafts[0].params.chat_id).toBe(CHAT)
  expect(typeof textDrafts[0].params.draft_id).toBe('number')
  expect(textDrafts[0].params.draft_id).not.toBe(0)
  expect(typeof textDrafts[0].params.text).toBe('string')
  expect(textDrafts[0].params.can_stop).toBe(true)
  expect(textDrafts[0].params.keep_on_stop).toBe(true)
  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(1)
})

test('test_c6_text_draft_failure_switches_to_edit_mode_with_stop_button_and_throttled_edits', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'sendRichMessageDraft' || method === 'sendMessageDraft') {
      throw new TelegramApiError(method, 400, 'Bad Request: draft is not available')
    }
    return undefined
  })
  const { stream } = open(api)
  const filler = 'x'.repeat(200)

  for (let i = 0; i < 8; i += 1) {
    await stream.update(`${filler} ${i}`)
    await tick(400)
  }
  await tick(3000)

  const sends = methodCalls(calls, 'sendMessage')
  expect(sends).toHaveLength(1)
  const markup = sends[0].params.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }
  const buttons = markup.inline_keyboard.flat()
  const withData = buttons.filter((b) => typeof b.callback_data === 'string')
  expect(withData.length).toBeGreaterThanOrEqual(1)
  for (const button of withData) {
    const size = Buffer.byteLength(button.callback_data as string)
    expect(size).toBeGreaterThanOrEqual(1)
    expect(size).toBeLessThanOrEqual(64)
  }

  const edits = methodCalls(calls, 'editMessageText')
  expect(edits.length).toBeGreaterThanOrEqual(2)
  for (const edit of edits) {
    expect(edit.params.chat_id).toBe(CHAT)
    expect(edit.params.message_id).toBe(55)
  }
  for (let i = 1; i < edits.length; i += 1) {
    expect(edits[i].at - edits[i - 1].at).toBeGreaterThanOrEqual(1000)
  }
})

test('test_c7_message_is_not_modified_is_not_an_error_and_keeps_preview_alive', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'editMessageText') {
      throw new TelegramApiError(method, 400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same')
    }
    return undefined
  })
  const { stream } = open(api, { mode: 'edit' })
  const filler = 'y'.repeat(200)

  await stream.update(`${filler} 0`)
  await tick(1100)
  for (let i = 1; i <= 6; i += 1) {
    await stream.update(`${filler} ${i}`)
    await tick(1100)
  }

  expect(methodCalls(calls, 'sendMessage')).toHaveLength(1)
  expect(methodCalls(calls, 'editMessageText')).toHaveLength(6)

  await stream.finish(`${filler} final`)
  const delivered = methodCalls(calls, 'sendRichMessage', 'sendMessage')
  expect(delivered.length).toBeGreaterThanOrEqual(2)
})

test('test_c8_three_failed_preview_updates_disable_preview_but_finish_still_sends', async () => {
  const { api, calls } = fakeApi((method) => {
    if (method === 'sendRichMessageDraft') throw new TelegramApiError(method, 500, 'Internal Server Error')
    return undefined
  })
  const { stream } = open(api)

  for (let i = 0; i < 6; i += 1) {
    await stream.update(`text number ${i}`)
    await tick(1100)
  }
  await tick(60_000)

  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(3)
  expect(methodCalls(calls, 'sendMessageDraft')).toHaveLength(0)

  await stream.finish('the final answer')

  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals.length).toBeGreaterThanOrEqual(1)
  expect(json(finals[0].params.rich_message)).toContain('the final answer')
  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(3)
})

test('test_c9_updates_during_429_pause_are_skipped_and_collapse_into_one_call_after', async () => {
  let failed = false
  const { api, calls } = fakeApi((method) => {
    if (method === 'sendRichMessageDraft' && !failed) {
      failed = true
      throw new TelegramApiError(method, 429, 'Too Many Requests: retry after 5', 5000)
    }
    return undefined
  })
  const { stream } = open(api)

  await stream.update('one')
  await tick(1000)
  await stream.update('two')
  await tick(1000)
  await stream.update('three')
  await tick(1000)
  await stream.update('four')
  await tick(1400)

  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(1)

  await tick(2000)

  const drafts = methodCalls(calls, 'sendRichMessageDraft')
  expect(drafts).toHaveLength(2)
  expect(json(drafts[1].params.rich_message)).toContain('four')
  expect(json(drafts[1].params.rich_message)).not.toContain('three')
  expect(drafts[1].at).toBeGreaterThanOrEqual(5000)
})

test('test_c9_finish_waits_for_the_429_pause_to_end_and_then_sends_final', async () => {
  let failed = false
  const { api, calls } = fakeApi((method) => {
    if (method === 'sendRichMessageDraft' && !failed) {
      failed = true
      throw new TelegramApiError(method, 429, 'Too Many Requests: retry after 5', 5000)
    }
    return undefined
  })
  const { stream } = open(api)

  await stream.update('draft text')
  await tick(1000)
  const done = Promise.resolve(stream.finish('final text'))
  await tick(3000)

  expect(methodCalls(calls, 'sendRichMessage')).toHaveLength(0)

  await tick(2000)
  await done

  const finals = methodCalls(calls, 'sendRichMessage')
  expect(finals).toHaveLength(1)
  expect(json(finals[0].params.rich_message)).toContain('final text')
  expect(finals[0].at).toBeGreaterThanOrEqual(5000)
})

test('test_c10_thread_id_is_present_in_every_draft_and_final_call', async () => {
  for (const mode of ['rich-draft', 'text-draft']) {
    const { api, calls } = fakeApi()
    const { stream } = open(api, { threadId: 77, mode })

    await stream.update('threaded text')
    await tick(0)
    await stream.status('thinking about it')
    await tick(1100)
    await stream.update('threaded text, more')
    await tick(1100)
    await stream.finish('threaded text, final')

    const relevant = methodCalls(calls, 'sendRichMessageDraft', 'sendMessageDraft', 'sendRichMessage', 'sendMessage')
    expect(relevant.length).toBeGreaterThanOrEqual(3)
    expect(methodCalls(calls, 'sendRichMessage').length).toBeGreaterThanOrEqual(1)
    for (const call of relevant) {
      expect(call.params.message_thread_id).toBe(77)
    }
  }
})

test('test_c11_abort_cancels_pending_timers_and_makes_no_more_api_calls', async () => {
  const { api, calls } = fakeApi()
  const { stream } = open(api)

  await stream.update('first')
  await tick(0)
  await stream.update('second, throttled and pending')
  expect(methodCalls(calls, 'sendRichMessageDraft')).toHaveLength(1)

  await stream.abort()
  const before = calls.length

  await tick(60_000)
  await stream.update('after abort')
  await stream.status('after abort')
  await tick(60_000)

  expect(calls.length).toBe(before)
  expect(methodCalls(calls, 'deleteMessage', 'deleteMessages')).toHaveLength(0)
})
