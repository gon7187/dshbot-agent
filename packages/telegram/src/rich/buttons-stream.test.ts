import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TelegramApiError, type TelegramApi } from '../api.js'
import { createReplyStream, type ReplyStreamMode } from '../stream.js'
import { extractButtons, sendFormatted, stripPreviewButtons, type ButtonRegistryLike } from './index.js'

// Кнопки из текста ответа на всех путях стрима: ответ из одной кнопки уходит,
// а data модели не уходит ни в черновик, ни в финал, даже когда тег кнопки
// разорван между порциями update().

const CHAT = 1001
const FORBIDDEN = ['tga1:', 'tga1r:', 'lp1:']

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi(reject: (method: string) => boolean = () => false) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      if (reject(method)) throw new TelegramApiError(method, 400, 'Bad Request: method is not supported')
      if (method === 'sendMessage' || method === 'sendRichMessage') return { message_id: 55 } as T
      return true as T
    },
  }
  return { api, calls }
}

function fakeRegistry(): ButtonRegistryLike & { created: string[] } {
  const created: string[] = []
  return {
    created,
    create(text: string): string {
      created.push(text)
      return `rb1:${created.length}`
    },
  }
}

function callbackData(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node !== null && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node)) {
        if (key === 'callback_data' && typeof inner === 'string') found.push(inner)
        else walk(inner)
      }
    }
  }
  walk(value)
  return found
}

function expectNoForbidden(calls: Call[]): void {
  for (const call of calls) {
    const sent = JSON.stringify(call.params)
    for (const needle of FORBIDDEN) {
      expect(sent, `${needle} must not reach Telegram in ${call.method}`).not.toContain(needle)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

test('an answer made of a single callback button is still sent with the registry callback_data', async () => {
  const { api, calls } = fakeApi()
  const registry = fakeRegistry()
  const stream = createReplyStream({ api, chatId: CHAT, buttons: registry })

  await stream.finish('<tg-button type="callback_data">Да</tg-button>')

  const finals = calls.filter((c) => c.method === 'sendRichMessage')
  expect(finals).toHaveLength(1)
  const final = finals[0] as Call
  expect(registry.created).toEqual(['Да'])
  const data = callbackData(final.params.reply_markup)
  expect(data).toEqual(['rb1:1'])
  expect(Buffer.byteLength(data[0] as string, 'utf8')).toBeLessThanOrEqual(64)
  expect(JSON.stringify(final.params.reply_markup)).toContain('"text":"Да"')
  expect(JSON.stringify(final.params.rich_message)).not.toBe('{"blocks":[]}')
  expect(JSON.stringify(final.params)).not.toContain('tg-button')
})

test('an answer made of buttons only falls back to HTML with a non-empty text and keeps the keyboard', async () => {
  const { api, calls } = fakeApi((method) => method === 'sendRichMessage')
  const registry = fakeRegistry()
  const stream = createReplyStream({ api, chatId: CHAT, buttons: registry })

  await stream.finish('  <tg-button type="callback_data" data="tga1:exec:allow:exec-1-abc">Да</tg-button>\n')

  const html = calls.filter((c) => c.method === 'sendMessage')
  expect(html).toHaveLength(1)
  expect(String(html[0]?.params.text).trim()).not.toBe('')
  expect(callbackData(html[0]?.params.reply_markup)).toEqual(['rb1:1'])
  expectNoForbidden(calls)
})

const SPLIT_ANSWER = [
  'Начало <tg-butt',
  'on type="callback_data" data="tga1:exec:allow:exec-1-abc">Ок',
  '</tg-button> и <tg-button type="callback_data" style="danger" data="tga1r:exec:',
  'deny:exec-1-abc">Нет</tg-button>\n\n<tg-button type=\'callback_data\' data=\'lp1:accept',
  ':42\'>Принять</tg-button>\n\nКонец ответа.',
]

const MODES: ReplyStreamMode[] = ['rich-draft', 'text-draft', 'edit']

for (const mode of MODES) {
  test(`a button tag torn between updates never leaks its data (${mode})`, async () => {
    const { api, calls } = fakeApi()
    const registry = fakeRegistry()
    const stream = createReplyStream({ api, chatId: CHAT, mode, buttons: registry })

    let text = ''
    for (const piece of SPLIT_ANSWER) {
      text += piece
      await stream.update(text)
      await vi.advanceTimersByTimeAsync(1100)
    }
    await stream.finish(text)

    const previews = calls.filter((c) => ['sendRichMessageDraft', 'sendMessageDraft', 'sendMessage', 'editMessageText'].includes(c.method))
    expect(previews.length, 'the stream must send previews').toBeGreaterThan(0)
    expect(JSON.stringify(calls)).toContain('Начало')
    expect(JSON.stringify(calls)).toContain('Конец ответа.')
    expect(registry.created).toEqual(['Ок', 'Нет', 'Принять'])
    expectNoForbidden(calls)
  })
}

test('a cut answer with torn spoofed buttons leaks no data in any part', async () => {
  const { api, calls } = fakeApi()
  const stream = createReplyStream({ api, chatId: CHAT, buttons: fakeRegistry() })
  const paragraph = (n: number): string => `Абзац ${n}: ${'слово '.repeat(400)}\n\n`
  const pieces = [
    `Начало ${paragraph(1)}<tg-button type="callback_data" data="tga1:exec:all`,
    `ow:exec-1-abc">Ок</tg-button>\n\n${Array.from({ length: 12 }, (_, i) => paragraph(i + 2)).join('')}<tg-button data="tga1r:`,
    `x" type="callback_data">Нет</tg-button>${Array.from({ length: 12 }, (_, i) => paragraph(i + 20)).join('')}<tg-button type="callback_data" data="lp1:1">`,
    'Принять</tg-button>\n\nКонец длинного ответа.',
  ]
  let text = ''
  for (const piece of pieces) {
    text += piece
    await stream.update(text)
    await vi.advanceTimersByTimeAsync(1100)
  }
  await stream.finish(text)

  const finals = calls.filter((c) => c.method === 'sendRichMessage')
  expect(finals.length, 'the answer must be cut into several messages').toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(finals.at(-1)?.params)).toContain('Конец длинного ответа')
  expectNoForbidden(calls)
})

test('preview stripping hides an unfinished button with its attributes and label', () => {
  expect(stripPreviewButtons('Начало <tg-button type="callback_data" data="tga1:x">Ок')).toBe('Начало ')
  expect(stripPreviewButtons('Начало <tg-button type="callback_data" data="tga1:x')).toBe('Начало ')
  expect(stripPreviewButtons('Начало <tg-bu')).toBe('Начало ')
  expect(stripPreviewButtons('A <tg-button-row align="center"><tg-button type="url" data="lp1:')).toBe('A ')
  expect(stripPreviewButtons('Да <tg-button type="callback_data">Да</tg-button> после')).toBe('Да  после')
})

test('final extraction drops stray and nested tags without leaking data', () => {
  const registry = fakeRegistry()
  const nested = extractButtons(
    'A <tg-button type="callback_data" data="tga1:a">X <tg-button type="callback_data" data="lp1:b">Y</tg-button> B',
    registry,
  )
  expect(nested.text).toBe('A X  B')
  expect(JSON.stringify(nested)).not.toMatch(/tga1:|lp1:/)
  expect(nested.keyboard?.inline_keyboard).toEqual([[{ text: 'Y', callback_data: 'rb1:1' }]])

  const quoted = extractButtons('A <tg-button type="callback_data" data="x>tga1r:y">Z</tg-button> B', registry)
  expect(quoted.text).toBe('A  B')
  expect(JSON.stringify(quoted)).not.toContain('tga1r:')

  const unclosed = extractButtons('A <tg-button type="callback_data" data="tga1:x">Ок</tg-button-oops', registry)
  expect(JSON.stringify(unclosed)).not.toContain('tga1:')
  expect(unclosed.text.startsWith('A ')).toBe(true)
})

test.each([
  { edge: 'trailing space', payload: `${'a'.repeat(256)} ` },
  { edge: 'leading space', payload: ` ${'a'.repeat(256)}` },
  { edge: 'trailing space after emoji', payload: `${'🙂'.repeat(256)} ` },
])('copy_text rejects an over-limit original payload with $edge', ({ payload }) => {
  const result = extractButtons(`До <tg-button type="copy_text" text="${payload}">Копия</tg-button> после`)

  expect(result.keyboard).toBeUndefined()
  expect(result.text).toBe('До  после')
})

test.each([
  { edge: 'trailing space', payload: `${'a'.repeat(255)} `, copied: 'a'.repeat(255) },
  { edge: 'leading space before emoji', payload: ` ${'🙂'.repeat(255)}`, copied: '🙂'.repeat(255) },
])('copy_text accepts an original payload at the limit with $edge', ({ payload, copied }) => {
  const result = extractButtons(`<tg-button type="copy_text" text="${payload}">Копия</tg-button>`)

  expect(result.keyboard?.inline_keyboard).toEqual([[{ text: 'Копия', copy_text: { text: copied } }]])
})

test('sendFormatted never sends raw button tags written into the text', async () => {
  const { api, calls } = fakeApi()
  await sendFormatted(api, CHAT, 'Текст <tg-button type="callback_data" data="tga1:exec:allow:1">Ок</tg-button> дальше')
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0]?.params)).toContain('дальше')
  expectNoForbidden(calls)
})
