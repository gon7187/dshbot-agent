import { expect, test } from 'vitest'
import type { TelegramApi } from './api.js'
import { TelegramApiError } from './api.js'
import { createPlan } from './plan.js'

// Assumed API: createPlan(api, chatId, tasks) sends the plan message and returns { render(tasks), update(index, checked) }.
// update edits that message with a rich_message list (blocks[].type === 'list', items[].is_checked);
// when the rich edit fails with 400 it falls back to editMessageText with parse_mode 'HTML' and ☑/☐.

const CHAT = 1001
const PLAN_MESSAGE = 42

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi(respond: (method: string, params: Params) => unknown = defaultRespond) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      return (await respond(method, params)) as T
    },
  }
  return { api, calls }
}

function defaultRespond(method: string): unknown {
  if (method.startsWith('send')) return { message_id: PLAN_MESSAGE, date: 0, chat: { id: CHAT, type: 'private' } }
  return true
}

const tasks = [
  { title: 'собрать', done: false },
  { title: 'проверить', done: false },
  { title: 'отправить', done: false },
]

test('test_c13_render_gives_markdown_checklist_lines', async () => {
  const { api } = fakeApi()
  const done = [
    { title: 'собрать', done: true },
    { title: 'проверить', done: false },
  ]
  const plan = await createPlan(api, CHAT, done)

  const markdown = plan.render(done)
  expect(markdown).toMatch(/^- \[x\] собрать$/m)
  expect(markdown).toMatch(/^- \[ \] проверить$/m)
})

test('test_c13_update_edits_plan_with_rich_list_where_only_item_is_checked', async () => {
  const { api, calls } = fakeApi()
  const plan = await createPlan(api, CHAT, tasks)

  const before = calls.length
  await plan.update(1, true)

  const edits = calls.slice(before).filter((c) => c.method === 'editMessageText')
  expect(edits.length).toBeGreaterThan(0)
  expect(edits[0].params.chat_id).toBe(CHAT)
  expect(edits[0].params.message_id).toBe(PLAN_MESSAGE)

  const rich = edits[0].params.rich_message as {
    blocks: Array<{ type: string; items?: Array<{ has_checkbox?: boolean; is_checked?: boolean }> }>
  }
  const list = rich.blocks.find((b) => b.type === 'list')
  const items = list?.items ?? []
  expect(items.map((i) => i.is_checked === true)).toEqual([false, true, false])
  expect(items.every((i) => i.has_checkbox === true)).toBe(true)
})

test('test_c13_rich_edit_400_falls_back_to_html_with_checkbox_symbols', async () => {
  const { api, calls } = fakeApi((method, params) => {
    if (method === 'editMessageText' && params.rich_message !== undefined) {
      throw new TelegramApiError('editMessageText', 400, 'Bad Request: rich message is invalid')
    }
    return true
  })
  const plan = await createPlan(api, CHAT, tasks)

  const before = calls.length
  await plan.update(1, true)

  const edits = calls.slice(before).filter((c) => c.method === 'editMessageText')
  const fallback = edits.find((c) => c.params.parse_mode === 'HTML')
  expect(fallback).toBeDefined()
  const text = String(fallback?.params.text)
  expect(text).toContain('☑')
  expect(text).toContain('☐')
})
