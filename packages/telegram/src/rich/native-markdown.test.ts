// Rich Markdown уходит в Telegram как есть: поле rich_message.markdown, а не blocks. Проверяется через
// sendFormatted на фейке TelegramApi, записывающем вызовы: сеть и демон не нужны.

import { expect, test } from 'vitest'
import { TelegramApiError, type TelegramApi } from '../api.js'
import { sendFormatted } from './index.js'

const CHAT = 4242

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

interface FakeOptions {
  /** Вызов с этим номером (с 1) метода отвечает 400. */
  failNth?: Partial<Record<string, { nth: number; description: string }>>
  /** sendMessage с parse_mode HTML: какой по счёту вызов отвечает ошибкой разбора. */
  failHtmlNth?: number
}

function fakeApi(options: FakeOptions = {}) {
  const calls: Call[] = []
  const delivered: Call[] = []
  const counts = new Map<string, number>()
  let htmlCalls = 0
  let nextId = 100
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      const count = (counts.get(method) ?? 0) + 1
      counts.set(method, count)
      const rule = options.failNth?.[method]
      if (rule !== undefined && rule.nth === count) throw new TelegramApiError(method, 400, rule.description)
      if (method === 'sendMessage' && params.parse_mode === 'HTML') {
        htmlCalls += 1
        if (options.failHtmlNth === htmlCalls) {
          throw new TelegramApiError(method, 400, "Bad Request: can't parse entities: Unsupported start tag")
        }
      }
      delivered.push({ method, params })
      nextId += 1
      return { message_id: nextId } as T
    },
  }
  return { api, calls, delivered }
}

function richCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'sendRichMessage')
}

function markdownOf(call: Call): string {
  const rich = call.params.rich_message as { markdown?: unknown } | undefined
  expect(typeof rich?.markdown, 'rich_message.markdown — строка').toBe('string')
  return rich?.markdown as string
}

function markdownParts(calls: Call[]): string[] {
  return richCalls(calls).map(markdownOf)
}

// Жёсткий перенос GFM: два пробела, обратная косая черта или <br> перед переводом строки.
const HARD_BREAK = '(?: {2,}\\n|\\\\\\n|<br\\s*/?>\\n?)'

function numbersIn(texts: string[], pattern: RegExp): number[] {
  return texts.flatMap((text) => [...text.matchAll(pattern)].map((match) => Number(match[1])))
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

const DESCRIPTION = 'описание элемента списка'

function listOf(count: number): string {
  return range(count)
    .map((index) => `- эл${index}ент ${DESCRIPTION}`)
    .join('\n')
}

test('test_c1_final_answer_goes_in_one_rich_call_as_markdown_without_blocks', async () => {
  const text = [
    '**ж** _к_ ||спойлер|| ==метка==',
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '<details><summary>S</summary>T</details>',
    'текст со сноской[^1]',
    '[^1]: само определение',
  ].join('\n\n')
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, text)

  const rich = richCalls(calls)
  expect(rich).toHaveLength(1)
  expect(calls.map((call) => call.method)).toEqual(['sendRichMessage'])
  expect(rich[0]?.params.chat_id).toBe(CHAT)
  const message = rich[0]?.params.rich_message as Params
  expect(message.blocks, 'текст не превращается в blocks').toBeUndefined()
  expect(message.html).toBeUndefined()
  expect(message.markdown).toBe(text)
})

test('test_c1_markdown_of_max_size_still_goes_in_a_single_call', async () => {
  const paragraph = `${'я'.repeat(99)}\n\n`
  const text = paragraph.repeat(320).trimEnd()
  expect(text.length).toBeLessThanOrEqual(32768)
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, text)

  expect(richCalls(calls)).toHaveLength(1)
  expect(markdownOf(richCalls(calls)[0] as Call)).toBe(text)
})

test('test_c2_single_newline_in_paragraph_becomes_a_hard_break', async () => {
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, 'первая\nвторая')

  const [markdown] = markdownParts(calls)
  expect(markdown).toMatch(new RegExp(`первая${HARD_BREAK}вторая`))
  expect(markdown, 'это перенос внутри абзаца, а не новый абзац').not.toMatch(/первая\s*\n\s*\n\s*вторая/)
})

test('test_c2_code_table_and_blank_lines_are_kept_as_is', async () => {
  const code = '```js\nа\nб\n```'
  const table = '| a | b |\n|---|---|\n| 1 | 2 |'
  const text = `до\nстрока\n\n${code}\n\n${table}\n\nабзац один\n\nабзац два`
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, text)

  const [markdown] = markdownParts(calls)
  expect(markdown).toMatch(new RegExp(`до${HARD_BREAK}строка`))
  expect(markdown).toContain(code)
  expect(markdown).toContain(table)
  expect(markdown).toContain('\n\nабзац один\n\nабзац два')
})

test('test_c3_list_of_1200_items_splits_into_parts_of_at_most_500_items', async () => {
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, listOf(1200))

  const parts = markdownParts(calls)
  expect(parts.length).toBeGreaterThanOrEqual(3)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(32768)
    expect(numbersIn([part], /эл(\d+)ент/g).length).toBeLessThanOrEqual(500)
  }
  expect(numbersIn(parts, /эл(\d+)ент/g)).toEqual(range(1200))
})

test('test_c3_long_text_splits_on_paragraph_boundaries_within_32768_chars', async () => {
  const paragraphs = range(60).map((index) => `абзац-${index}-${'ы'.repeat(1500)}`)
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, paragraphs.join('\n\n'))

  const parts = markdownParts(calls)
  expect(parts.length).toBeGreaterThanOrEqual(3)
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(32768)
  for (const paragraph of paragraphs) {
    expect(parts.filter((part) => part.includes(paragraph)), `абзац цел и ровно в одной части`).toHaveLength(1)
  }
  expect(numbersIn(parts, /абзац-(\d+)-/g)).toEqual(range(60))
})

test('test_c3_table_rows_are_never_cut_and_each_part_stays_within_500_blocks', async () => {
  const rows = range(1200).map((index) => `| r${index} | значение |`)
  const table = ['| id | значение |', '|---|---|', ...rows].join('\n')
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, table)

  const parts = markdownParts(calls)
  expect(parts.length).toBeGreaterThanOrEqual(3)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(32768)
    const tableLines = part.split('\n').filter((line) => line.startsWith('|'))
    for (const line of tableLines) expect(line.trimEnd(), `строка таблицы цела: ${line}`).toMatch(/^\|.*\|$/)
    expect(numbersIn([part], /^\| r(\d+) \|/gm).length).toBeLessThanOrEqual(499)
  }
  expect(numbersIn(parts, /^\| r(\d+) \| значение \|$/gm)).toEqual(range(1200))
})

test('test_c3_oversized_code_block_is_split_into_closed_blocks_with_the_same_language', async () => {
  const lines = range(4000).map((index) => `значение_${index} = ${index}`)
  const text = `Вступление\n\n\`\`\`python\n${lines.join('\n')}\n\`\`\``
  const { api, calls } = fakeApi()

  await sendFormatted(api, CHAT, text)

  const parts = markdownParts(calls)
  expect(parts.length).toBeGreaterThanOrEqual(3)
  for (const part of parts) {
    expect(part.length).toBeLessThanOrEqual(32768)
    const fences = part.split('\n').filter((line) => line.startsWith('```'))
    expect(fences.length % 2, 'каждый блок кода закрыт в своей части').toBe(0)
    fences.forEach((fence, index) => {
      if (index % 2 === 0) expect(fence).toBe('```python')
      else expect(fence).toBe('```')
    })
  }
  expect(numbersIn(parts, /значение_(\d+) = /g)).toEqual(range(4000))
})

test('test_c4_rich_400_on_the_second_part_sends_that_and_next_parts_as_html_without_duplicates', async () => {
  const { api, calls, delivered } = fakeApi({
    failNth: { sendRichMessage: { nth: 2, description: 'Bad Request: rich message is invalid' } },
  })

  await sendFormatted(api, CHAT, listOf(1200))

  expect(richCalls(calls), 'после отказа rich больше не пробуется').toHaveLength(2)
  const fallback = calls.filter((call) => call.method === 'sendMessage')
  expect(fallback.length).toBeGreaterThanOrEqual(1)
  for (const call of fallback) expect(call.params.parse_mode).toBe('HTML')
  const texts = delivered.map((call) =>
    call.method === 'sendRichMessage' ? markdownOf(call) : String(call.params.text ?? ''),
  )
  expect(numbersIn(texts, /эл(\d+)ент/g), 'каждый пункт доставлен ровно один раз и по порядку').toEqual(range(1200))
})

test('test_c4_html_parse_error_in_the_middle_falls_back_to_plain_text_without_duplicates', async () => {
  const { api, calls, delivered } = fakeApi({
    failNth: { sendRichMessage: { nth: 2, description: 'Bad Request: rich message is invalid' } },
    failHtmlNth: 2,
  })

  await sendFormatted(api, CHAT, listOf(1200))

  const messages = calls.filter((call) => call.method === 'sendMessage')
  expect(messages.some((call) => call.params.parse_mode === 'HTML')).toBe(true)
  expect(messages.some((call) => call.params.parse_mode === undefined), 'есть простой текст').toBe(true)
  const texts = delivered.map((call) =>
    call.method === 'sendRichMessage' ? markdownOf(call) : String(call.params.text ?? ''),
  )
  expect(numbersIn(texts, /эл(\d+)ент/g), 'каждый пункт доставлен ровно один раз и по порядку').toEqual(range(1200))
})
