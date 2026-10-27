// Кнопки инструмента message: цвет (style) и кнопка копирования текста (copy -> copy_text).
// Настоящий createMessageTool на фейковом Bot API, без демона и сети (как в message-rich-native.test.ts).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TelegramApi } from '../telegram/src/api.js'
import {
  createBotMessageRegistry,
  createMessageTool,
  createReplyButtonRegistry,
  trackTelegramMessages,
  type ReplyButtonRegistry,
} from './src/message-tool.js'

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
  home = mkdtempSync(join(tmpdir(), 'dshbot-message-button-style-'))
  calls = []
  nextId = 0
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const fake: TelegramApi = {
  async call<T>(method: string, params: Params = {}): Promise<T> {
    calls.push({ method, params })
    if (method.startsWith('send')) {
      nextId += 1
      return { message_id: nextId, chat: { id: OWNER } } as T
    }
    return true as T
  },
}

function setup() {
  const messages = createBotMessageRegistry()
  const buttons: ReplyButtonRegistry = createReplyButtonRegistry()
  const api = trackTelegramMessages(fake, messages)
  const message = createMessageTool({ home, api, ownerChatId: () => OWNER, buttons, messages })
  return { message, buttons }
}

function sentButtons(): Params[] {
  const sent = calls.filter((call) => call.method === 'sendMessage' || call.method === 'sendRichMessage')
  expect(sent, 'ушла ровно одна отправка текста').toHaveLength(1)
  const keyboard = (sent[0]?.params.reply_markup as { inline_keyboard?: Params[][] } | undefined)?.inline_keyboard
  expect(keyboard, 'клавиатура в запросе').toBeDefined()
  return (keyboard ?? []).flat()
}

function sendCalls(): Call[] {
  return calls.filter((call) => call.method.startsWith('send'))
}

test('test_c1_reply_button_style_goes_to_telegram_with_registry_callback_data', async () => {
  for (const style of ['success', 'primary', 'danger']) {
    calls = []
    const { message, buttons } = setup()

    await message.execute({ action: 'send', text: 'Готово?', buttons: [[{ text: 'Готово', style }]] })

    const [button] = sentButtons()
    expect(button?.text).toBe('Готово')
    expect(button?.style).toBe(style)
    expect(typeof button?.callback_data).toBe('string')
    expect(buttons.textOf(String(button?.callback_data))).toBe('Готово')
    expect(button?.url).toBeUndefined()
    expect(button?.copy_text).toBeUndefined()
    expect(button?.copy, 'поле copy не уходит в Telegram').toBeUndefined()
  }
})

test('test_c1_url_button_keeps_style', async () => {
  const { message } = setup()

  await message.execute({
    action: 'send',
    text: 'Открой',
    buttons: [[{ text: 'Сайт', url: 'https://example.com', style: 'primary' }]],
  })

  expect(sentButtons()).toEqual([{ text: 'Сайт', url: 'https://example.com', style: 'primary' }])
})

test('test_c2_copy_button_goes_as_copy_text_without_callback_data_and_url', async () => {
  const { message } = setup()

  await message.execute({ action: 'send', text: 'Код', buttons: [[{ text: 'Скопировать', copy: 'ABC-123' }]] })

  expect(sentButtons()).toEqual([{ text: 'Скопировать', copy_text: { text: 'ABC-123' } }])
})

test('test_c2_copy_button_with_style_keeps_both', async () => {
  const { message } = setup()

  await message.execute({
    action: 'send',
    text: 'Код',
    buttons: [[{ text: 'Скопировать', copy: 'ABC-123', style: 'success' }]],
  })

  expect(sentButtons()).toEqual([{ text: 'Скопировать', copy_text: { text: 'ABC-123' }, style: 'success' }])
})

test('test_c3_invalid_style_is_refused_before_any_send', async () => {
  const { message } = setup()

  await expect(
    message.execute({ action: 'send', text: 'Привет', buttons: [[{ text: 'Да', style: 'green' }]] }),
  ).rejects.toThrow(/style/)
  expect(sendCalls(), 'в Telegram ничего не ушло').toEqual([])

  // Контроль: допустимое значение проходит.
  await message.execute({ action: 'send', text: 'Привет', buttons: [[{ text: 'Да', style: 'danger' }]] })
  expect(sendCalls()).toHaveLength(1)
})

test('test_c3_copy_over_256_chars_is_refused_before_any_send', async () => {
  const { message } = setup()

  await expect(
    message.execute({ action: 'send', text: 'Код', buttons: [[{ text: 'Копия', copy: 'x'.repeat(257) }]] }),
  ).rejects.toThrow(/copy/)
  expect(sendCalls(), 'в Telegram ничего не ушло').toEqual([])

  // Граница: ровно 256 символов допустимы.
  const edge = 'x'.repeat(256)
  await message.execute({ action: 'send', text: 'Код', buttons: [[{ text: 'Копия', copy: edge }]] })
  expect(sentButtons()).toEqual([{ text: 'Копия', copy_text: { text: edge } }])
})

test('test_c3_url_together_with_copy_is_refused_before_any_send', async () => {
  const { message } = setup()

  const failure = await message
    .execute({
      action: 'send',
      text: 'Код',
      buttons: [[{ text: 'Оба', url: 'https://example.com', copy: 'ABC-123' }]],
    })
    .then(
      () => undefined,
      (error: unknown) => error as Error,
    )

  expect(failure, 'инструмент вернул ошибку').toBeInstanceOf(Error)
  expect(failure?.message).toMatch(/copy/)
  expect(failure?.message).toMatch(/url/)
  expect(sendCalls(), 'в Telegram ничего не ушло').toEqual([])
})

test('test_c4_schema_describes_style_and_copy', () => {
  const { message } = setup()

  const schema = message.inputSchema as {
    properties?: { buttons?: { items?: { items?: { properties?: Record<string, Params> } } } }
  }
  const properties = schema.properties?.buttons?.items?.items?.properties ?? {}

  expect(properties.text).toBeDefined()
  expect(properties.url).toBeDefined()

  const style = properties.style
  expect(style, 'в схеме кнопки есть style').toBeDefined()
  expect(style?.type).toBe('string')
  const styleText = JSON.stringify(style)
  for (const value of ['success', 'primary', 'danger']) expect(styleText).toContain(value)
  expect(typeof style?.description === 'string' && style.description.trim() !== '', 'style описан').toBe(true)

  const copy = properties.copy
  expect(copy, 'в схеме кнопки есть copy').toBeDefined()
  expect(copy?.type).toBe('string')
  expect(typeof copy?.description === 'string' && copy.description.trim() !== '', 'copy описан').toBe(true)
})
