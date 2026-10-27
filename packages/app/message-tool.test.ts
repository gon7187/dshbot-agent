// The registry of bot messages behind the `message` tool is keyed by chat and message id. A Telegram
// message_id is unique only inside its chat, and the same tracked client serves the guest lanes too: a send
// into a guest chat must neither grant edit/delete rights on the message with the same id in the owner chat
// nor change how an owner message of that id is edited.
//
// No daemon and no network: the real `send_file` and `message` tools run against a fake Bot API wrapped by
// `trackTelegramMessages`, and the fake hands out ids per chat, so a guest and the owner get the same id.

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
const GUEST = 2002

interface Call {
  method: string
  params: Record<string, unknown>
}

let home = ''
let calls: Call[] = []
let nextIds = new Map<string, number>()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-message-tool-'))
  mkdirSync(join(home, 'workspace', 'outbox'), { recursive: true })
  writeFileSync(join(home, 'workspace', 'outbox', 'report.pdf'), '%PDF-1.4 report')
  calls = []
  nextIds = new Map()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Fake Bot API: every chat counts its own message ids from 1, like Telegram. */
const fake: TelegramApi = {
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    calls.push({ method, params })
    if (method.startsWith('send')) {
      const chat = String(params.chat_id)
      const id = (nextIds.get(chat) ?? 0) + 1
      nextIds.set(chat, id)
      return { message_id: id, chat: { id: Number(params.chat_id) } } as T
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
  return { api, message, sendFile }
}

function messageIdIn(answer: unknown): number {
  const text = String(answer)
  const found = /message_id (\d+)/.exec(text)
  expect(found, `the answer names the message_id: ${text}`).not.toBeNull()
  return Number(found![1])
}

function editsAndDeletes(): Call[] {
  return calls.filter((call) => call.method.startsWith('edit') || call.method === 'deleteMessage')
}

test('test_guest_send_with_the_same_id_grants_no_rights_in_the_owner_chat', async () => {
  const { api, message } = setup()
  // The bot answers a guest: message 1 of the guest chat. Message 1 of the owner chat is the owner's own.
  const guest = await api.call<{ message_id: number }>('sendMessage', { chat_id: GUEST, text: 'Ответ гостю' })
  expect(guest.message_id).toBe(1)

  await expect(message.execute({ action: 'edit', message_id: 1, text: 'Чужое' })).rejects.toThrow(/не бот/)
  await expect(message.execute({ action: 'delete', message_id: 1 })).rejects.toThrow(/не бот/)
  expect(editsAndDeletes(), 'no edit or delete reaches Telegram').toEqual([])

  // Positive control: a message the bot itself sent into the owner chat is still editable and deletable.
  const own = messageIdIn(await message.execute({ action: 'send', text: 'Своё' }))
  await message.execute({ action: 'edit', message_id: own, text: 'Своё, исправлено' })
  await message.execute({ action: 'delete', message_id: own })
  expect(editsAndDeletes().map((call) => [call.method, call.params.chat_id, call.params.message_id])).toEqual([
    ['editMessageText', OWNER, own],
    ['deleteMessage', OWNER, own],
  ])
})

test('test_guest_text_with_the_id_of_an_owner_file_keeps_the_caption_edit', async () => {
  const { api, message, sendFile } = setup()
  const fileId = messageIdIn(await sendFile.execute({ path: 'outbox/report.pdf', caption: 'Отчёт' }))
  // A text answer to the guest gets the same id in the guest chat.
  const guest = await api.call<{ message_id: number }>('sendMessage', { chat_id: GUEST, text: 'Ответ гостю' })
  expect(guest.message_id).toBe(fileId)

  await message.execute({ action: 'edit', message_id: fileId, text: 'Новая подпись' })
  const edits = editsAndDeletes()
  expect(edits.map((call) => call.method)).toEqual(['editMessageCaption'])
  expect(edits[0]?.params).toMatchObject({ chat_id: OWNER, message_id: fileId, caption: 'Новая подпись' })
})

test('test_deleting_a_guest_message_keeps_the_owner_message_with_the_same_id', async () => {
  const { api, message } = setup()
  const own = messageIdIn(await message.execute({ action: 'send', text: 'Своё' }))
  await api.call('sendMessage', { chat_id: GUEST, text: 'Ответ гостю' })
  await api.call('deleteMessage', { chat_id: GUEST, message_id: own })

  await message.execute({ action: 'delete', message_id: own })
  expect(editsAndDeletes().map((call) => [call.params.chat_id, call.params.message_id])).toEqual([
    [GUEST, own],
    [OWNER, own],
  ])
  // Once deleted in the owner chat, the id is no longer the bot's there.
  await expect(message.execute({ action: 'delete', message_id: own })).rejects.toThrow(/не бот/)
})
