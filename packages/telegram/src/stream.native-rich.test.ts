// Черновик стрима идёт через sendRichMessageDraft с rich_message.markdown и не замирает на 4096 символах.
// Фейк TelegramApi и фальшивые часы — как в stream.final-fallback.test.ts.

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { TelegramApi } from './api.js'
import { createReplyStream } from './stream.js'

const CHAT = 3003

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi() {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (method === 'sendRichMessage' || method === 'sendMessage') return { message_id: 700 } as T
      return true as T
    },
  }
  return { api, calls }
}

function draftMarkdown(call: Call): string {
  const rich = call.params.rich_message as { markdown?: unknown; blocks?: unknown } | undefined
  expect(rich?.blocks, 'черновик не конвертируется в blocks').toBeUndefined()
  expect(typeof rich?.markdown, 'rich_message.markdown — строка').toBe('string')
  return rich?.markdown as string
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

test('test_c5_draft_carries_markdown_with_hard_breaks', async () => {
  const { api, calls } = fakeApi()
  const stream = createReplyStream({ api, chatId: CHAT })

  await stream.update('первая\nвторая **жирный**')
  await vi.advanceTimersByTimeAsync(1100)

  const drafts = calls.filter((call) => call.method === 'sendRichMessageDraft')
  expect(drafts.length).toBeGreaterThanOrEqual(1)
  const markdown = draftMarkdown(drafts[drafts.length - 1] as Call)
  expect(markdown).toMatch(/первая(?: {2,}\n|\\\n|<br\s*\/?>\n?)вторая \*\*жирный\*\*/)
  expect(drafts[0]?.params.chat_id).toBe(CHAT)
  expect(typeof drafts[0]?.params.draft_id).toBe('number')
})

test('test_c5_draft_of_10000_chars_does_not_freeze_at_4096', async () => {
  const { api, calls } = fakeApi()
  const stream = createReplyStream({ api, chatId: CHAT })
  const paragraph = (index: number) => `абзац-${index}-${'ы'.repeat(190)}`
  const textOf = (count: number) => Array.from({ length: count }, (_, index) => paragraph(index)).join('\n\n')

  await stream.update(textOf(10))
  await vi.advanceTimersByTimeAsync(1100)
  await stream.update(textOf(30))
  await vi.advanceTimersByTimeAsync(1100)
  await stream.update(textOf(50))
  await vi.advanceTimersByTimeAsync(1100)
  const full = textOf(50)
  expect(full.length).toBeGreaterThanOrEqual(10_000)

  const before = calls.length
  const drafts = calls.slice(0, before).filter((call) => call.method === 'sendRichMessageDraft')
  expect(drafts.length).toBeGreaterThanOrEqual(2)
  const last = draftMarkdown(drafts[drafts.length - 1] as Call)
  expect(last.length).toBeGreaterThan(4096)
  expect(last).toContain('абзац-49-')

  await stream.finish(full)
  const finals = calls.slice(before).filter((call) => call.method === 'sendRichMessage')
  expect(finals.length).toBeGreaterThanOrEqual(1)
})
