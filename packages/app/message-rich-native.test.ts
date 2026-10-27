// Инструмент message и send_file на уровне инструментов, без демона: настоящие createMessageTool и
// createSendFileTool работают на фейковом Bot API (как в message-tool.test.ts).
//   - send и edit текста уходят тем же rich-путём, что и ответ: sendRichMessage / editMessageText с rich_message.markdown;
//   - подпись медиа длиннее 1024 символов отклоняется ошибкой до любого запроса в Telegram.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TelegramApi } from '../telegram/src/api.js'
import {
  createBotMessageRegistry,
  createMessageTool,
  createReplyButtonRegistry,
  trackTelegramMessages,
} from './src/message-tool.js'
import { createSendFileTool } from './src/outgoing-files.js'

const OWNER = 1001

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

let home = ''
let calls: Call[] = []
let nextId = 0

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-message-rich-'))
  mkdirSync(join(home, 'workspace', 'outbox'), { recursive: true })
  for (const name of ['a.png', 'b.png', 'clip.mp4', 'report.pdf']) {
    writeFileSync(join(home, 'workspace', 'outbox', name), `data of ${name}`)
  }
  calls = []
  nextId = 0
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const fake: TelegramApi = {
  async call<T>(method: string, params: Params = {}): Promise<T> {
    calls.push({ method, params })
    if (method === 'sendMediaGroup') {
      nextId += 1
      return [{ message_id: nextId, chat: { id: OWNER } }, { message_id: nextId + 1, chat: { id: OWNER } }] as T
    }
    if (method.startsWith('send')) {
      nextId += 1
      return { message_id: nextId, chat: { id: OWNER } } as T
    }
    return true as T
  },
}

function setup() {
  const messages = createBotMessageRegistry()
  const api = trackTelegramMessages(fake, messages)
  const ownerChatId = () => OWNER
  const message = createMessageTool({ home, api, ownerChatId, buttons: createReplyButtonRegistry(), messages })
  const sendFile = createSendFileTool({ home, api, ownerChatId })
  return { message, sendFile }
}

function richOf(call: Call | undefined): { markdown?: unknown; blocks?: unknown } {
  return (call?.params.rich_message ?? {}) as { markdown?: unknown; blocks?: unknown }
}

function messageIdIn(answer: unknown): number {
  const found = /message_id (\d+)/.exec(String(answer))
  expect(found, `the answer names the message_id: ${String(answer)}`).not.toBeNull()
  return Number(found![1])
}

test('test_c6_send_goes_through_send_rich_message_with_markdown', async () => {
  const { message } = setup()

  await message.execute({ action: 'send', text: '**жирный**' })

  expect(calls.map((call) => call.method)).toEqual(['sendRichMessage'])
  expect(calls[0]?.params.chat_id).toBe(OWNER)
  expect(richOf(calls[0]).markdown).toBe('**жирный**')
  expect(richOf(calls[0]).blocks).toBeUndefined()
})

test('test_c6_send_keeps_buttons_reply_to_and_hard_breaks', async () => {
  const { message } = setup()

  await message.execute({
    action: 'send',
    text: 'первая\nвторая',
    buttons: [[{ text: 'Да' }, { text: 'Сайт', url: 'https://example.com' }]],
    reply_to: 77,
  })

  const sent = calls.filter((call) => call.method === 'sendRichMessage')
  expect(sent).toHaveLength(1)
  expect(String(richOf(sent[0]).markdown)).toMatch(/первая(?: {2,}\n|\\\n|<br\s*\/?>\n?)вторая/)
  const keyboard = (sent[0]?.params.reply_markup as { inline_keyboard?: Array<Array<Params>> }).inline_keyboard
  expect(keyboard).toHaveLength(1)
  expect(keyboard?.[0]?.[0]?.text).toBe('Да')
  expect(typeof keyboard?.[0]?.[0]?.callback_data).toBe('string')
  expect(keyboard?.[0]?.[1]).toEqual({ text: 'Сайт', url: 'https://example.com' })
  const reply = sent[0]?.params
  expect(reply?.reply_to_message_id ?? (reply?.reply_parameters as Params | undefined)?.message_id).toBe(77)
})

test('test_c6_edit_of_own_rich_message_calls_edit_message_text_with_rich_message', async () => {
  const { message } = setup()
  const id = messageIdIn(await message.execute({ action: 'send', text: 'старый' }))

  await message.execute({ action: 'edit', message_id: id, text: '**новый** ||текст||' })

  const edits = calls.filter((call) => call.method.startsWith('edit'))
  expect(edits.map((call) => call.method)).toEqual(['editMessageText'])
  expect(edits[0]?.params).toMatchObject({ chat_id: OWNER, message_id: id })
  expect(richOf(edits[0]).markdown).toBe('**новый** ||текст||')
  expect(richOf(edits[0]).blocks).toBeUndefined()
})

const LONG = 'x'.repeat(1025)
const EDGE = 'x'.repeat(1024)

test('test_c7_album_caption_over_1024_is_refused_before_any_request', async () => {
  const { message } = setup()
  const paths = ['outbox/a.png', 'outbox/b.png']

  await expect(message.execute({ action: 'album', paths, caption: LONG })).rejects.toThrow(/1024/)
  expect(calls, 'в Telegram ничего не ушло').toEqual([])

  await message.execute({ action: 'album', paths, caption: EDGE })
  expect(calls.map((call) => call.method)).toEqual(['sendMediaGroup'])
})

test('test_c7_video_caption_over_1024_is_refused_before_any_request', async () => {
  const { message } = setup()

  await expect(message.execute({ action: 'video', path: 'outbox/clip.mp4', caption: LONG })).rejects.toThrow(/1024/)
  expect(calls, 'в Telegram ничего не ушло').toEqual([])

  await message.execute({ action: 'video', path: 'outbox/clip.mp4', caption: EDGE })
  expect(calls.map((call) => call.method)).toEqual(['sendVideo'])
})

test('test_c7_send_file_caption_over_1024_is_refused_before_any_request', async () => {
  const { sendFile } = setup()

  await expect(sendFile.execute({ path: 'outbox/report.pdf', caption: LONG })).rejects.toThrow(/1024/)
  expect(calls, 'в Telegram ничего не ушло').toEqual([])

  await sendFile.execute({ path: 'outbox/report.pdf', caption: EDGE })
  expect(calls.map((call) => call.method)).toEqual(['sendDocument'])
})
