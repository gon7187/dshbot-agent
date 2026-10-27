import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { TelegramApiError, type TelegramApi } from '../api.js'

// Модуль грузится динамически: пока реализации нет, каждый тест падает на своём expect, а не на импорте
type Block = Record<string, unknown>

interface RichModule {
  markdownToRichBlocks: (md: string, opts?: { compactTables?: boolean }) => Block[]
  splitRichBlocks: (blocks: Block[], opts?: { maxBlocks?: number; maxChars?: number }) => Block[][]
  markdownToHtml: (md: string) => string
  chunkText: (text: string, max?: number) => string[]
  sendFormatted: (
    api: TelegramApi,
    chatId: number,
    md: string,
    opts?: { threadId?: number; replyMarkup?: unknown },
  ) => Promise<number[]>
}

const here = dirname(fileURLToPath(import.meta.url))

async function richModule(): Promise<Partial<RichModule>> {
  try {
    return (await import(join(here, 'index.ts'))) as Partial<RichModule>
  } catch {
    return {}
  }
}

async function exported<K extends keyof RichModule>(name: K): Promise<NonNullable<RichModule[K]>> {
  const mod = await richModule()
  expect(mod[name], `${name} экспортирован из rich`).toBeTypeOf('function')
  return mod[name] as NonNullable<RichModule[K]>
}

// Текст RichText в виде строки: строка, массив, либо объект с полем text
function plain(rt: unknown): string {
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(plain).join('')
  if (rt && typeof rt === 'object' && 'text' in rt) return plain(rt.text)
  return ''
}

// Все узлы RichText с заданным type, включая вложенные
function richNodes(rt: unknown, type: string): Block[] {
  if (Array.isArray(rt)) return rt.flatMap((x) => richNodes(x, type))
  if (!rt || typeof rt !== 'object') return []
  const node = rt as Block
  return [...(node.type === type ? [node] : []), ...richNodes(node.text, type)]
}

function childBlocks(v: unknown): Block[] {
  return Array.isArray(v) ? (v as Block[]) : []
}

// Глубина вложенности контейнеров (blocks и items); листья не считаются
function nestingOf(blocks: Block[]): number {
  return blocks.reduce((max, b) => {
    const inner = [...childBlocks(b.blocks), ...childBlocks(b.items)]
    return inner.length ? Math.max(max, 1 + nestingOf(inner)) : max
  }, 0)
}

// Число блоков с вложенными, элементами списков
function countUnits(blocks: Block[]): number {
  return blocks.reduce((sum, b) => sum + 1 + countUnits([...childBlocks(b.blocks), ...childBlocks(b.items)]), 0)
}

// Символы по тексту, с вложенными
function charsOf(blocks: Block[]): number {
  return blocks.reduce(
    (sum, b) => sum + plain(b.text).length + charsOf([...childBlocks(b.blocks), ...childBlocks(b.items)]),
    0,
  )
}

interface Call {
  method: string
  params: Record<string, unknown>
}

function fakeApi(respond: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      return respond(method, params) as T
    },
  }
  return { api, calls }
}

test('test_c1_заголовок_и_жирный_в_абзаце', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const [heading, para] = markdownToRichBlocks('# Т\n\nтекст **жирный**')
  expect(heading).toMatchObject({ type: 'heading', size: 1 })
  expect(plain(heading.text)).toBe('Т')
  expect(para).toMatchObject({ type: 'paragraph' })
  const text = para.text
  expect(Array.isArray(text), 'абзац с жирным задаётся массивом RichText').toBe(true)
  const bold = (text as unknown[]).findIndex((p) => (p as Block | undefined)?.type === 'bold')
  expect(bold).toBeGreaterThan(0)
  expect(plain((text as unknown[]).slice(0, bold))).toBe('текст ')
  expect((text as unknown[])[bold]).toMatchObject({ type: 'bold' })
  expect(plain((text as unknown[])[bold])).toBe('жирный')
})

test('test_c2_таблица_заголовок_выравнивание_и_компакт', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const md = '| Имя | Возраст |\n| :---: | :---: |\n| Аня | 20 |\n| Боб | 30 |'
  const blocks = markdownToRichBlocks(md)
  expect(blocks, 'один блок таблицы').toHaveLength(1)
  expect(blocks[0]).toMatchObject({ type: 'table' })
  const cells = blocks[0].cells as Block[][]
  expect(Array.isArray(cells), 'cells — массив строк').toBe(true)
  expect(cells).toHaveLength(3)
  expect(cells[0].every((c) => c.is_header === true), 'первая строка — заголовок').toBe(true)
  expect(cells[1].some((c) => c.is_header === true), 'тело таблицы не заголовок').toBe(false)
  expect(plain(cells[0][0].text)).toBe('Имя')
  expect(cells.flat().every((c) => c.align === 'center'), 'ячейки выровнены по центру').toBe(true)
  expect(blocks[0].is_compact).not.toBe(true)

  const compact = markdownToRichBlocks(md, { compactTables: true })
  expect(compact[0]).toMatchObject({ type: 'table', is_compact: true })
})

test('test_c3_таблица_шире_20_колонок_становится_pre', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const header = Array.from({ length: 21 }, (_, i) => `к${i}`)
  const row = Array.from({ length: 21 }, (_, i) => String(i))
  const md = `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n| ${row.join(' | ')} |`
  const blocks = markdownToRichBlocks(md)
  expect(blocks, 'один блок').toHaveLength(1)
  expect(blocks[0], 'блок pre, а не table').toMatchObject({ type: 'pre' })
  expect(plain(blocks[0].text)).toBe(md)
})

test('test_c4_список_задач_с_флагами_чекбокса', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const blocks = markdownToRichBlocks('- [x] a\n- [ ] b')
  expect(blocks, 'один блок списка').toHaveLength(1)
  expect(blocks[0]).toMatchObject({ type: 'list' })
  const items = blocks[0].items as Block[]
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ has_checkbox: true, is_checked: true })
  expect(items[1]).toMatchObject({ has_checkbox: true })
  expect(items[1].is_checked).not.toBe(true)
  expect(plain(items[0].blocks)).toBe('a')
  expect(plain(items[1].blocks)).toBe('b')
})

test('test_c5_код_с_языком_без_разбора_разметки', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const blocks = markdownToRichBlocks('```ts\n**не жирный**\n```')
  expect(blocks, 'один блок').toHaveLength(1)
  expect(blocks[0]).toMatchObject({ type: 'pre', language: 'ts' })
  expect(plain(blocks[0].text)).toBe('**не жирный**')
  expect(JSON.stringify(blocks), 'внутри кода нет bold').not.toContain('"bold"')
})

test('test_c6_доллар_остаётся_текстом_без_формул', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const blocks = markdownToRichBlocks('цена $400-600K')
  expect(blocks, 'один блок').toHaveLength(1)
  expect(blocks[0]).toMatchObject({ type: 'paragraph' })
  expect(plain(blocks[0].text)).toBe('цена $400-600K')
  expect(JSON.stringify(blocks), 'формул нет ни в блоках, ни в RichText').not.toContain('mathematical_expression')
})

test('test_c7_инлайн_курсив_зачёркнутый_код_и_ссылка', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const blocks = markdownToRichBlocks('*курсив*, ~~зачёркнутый~~, `код` и [ссылка](https://e.x)')
  expect(blocks[0]).toMatchObject({ type: 'paragraph' })
  const text = blocks[0].text
  expect(plain(richNodes(text, 'italic')[0])).toBe('курсив')
  expect(plain(richNodes(text, 'strikethrough')[0])).toBe('зачёркнутый')
  expect(plain(richNodes(text, 'code')[0])).toBe('код')
  const link = richNodes(text, 'url')[0]
  expect(link).toMatchObject({ type: 'url', url: 'https://e.x' })
  expect(plain(link)).toBe('ссылка')
})

test('test_c8_вложенность_не_глубже_16', async () => {
  const markdownToRichBlocks = await exported('markdownToRichBlocks')
  const blocks = markdownToRichBlocks(`${'> '.repeat(20)}глубоко`)
  expect(blocks.length, 'результат не пуст').toBeGreaterThan(0)
  expect(JSON.stringify(blocks), 'текст цитаты сохранён').toContain('глубоко')
  expect(nestingOf(blocks)).toBeLessThanOrEqual(16)
})

test('test_c9_нарезка_1200_абзацев_по_лимитам', async () => {
  const splitRichBlocks = await exported('splitRichBlocks')
  const blocks: Block[] = Array.from({ length: 1200 }, (_, i) => ({ type: 'paragraph', text: `абзац ${i}` }))
  const parts = splitRichBlocks(blocks)
  expect(parts.length, 'не меньше 3 частей').toBeGreaterThanOrEqual(3)
  for (const part of parts) {
    expect(countUnits(part)).toBeLessThanOrEqual(500)
    expect(charsOf(part)).toBeLessThanOrEqual(32768)
  }
  expect(parts.flat(), 'склейка частей равна исходному массиву').toEqual(blocks)
})

test('test_c10_длинный_pre_режется_по_строкам', async () => {
  const splitRichBlocks = await exported('splitRichBlocks')
  const lines = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, '0')} ${'x'.repeat(95)}`)
  const text = lines.join('\n')
  expect(text.length).toBeGreaterThan(32768)
  const pres = splitRichBlocks([{ type: 'pre', text }]).flat()
  expect(pres.length, 'pre разрезан на несколько блоков').toBeGreaterThanOrEqual(2)
  for (const block of pres) {
    expect(block).toMatchObject({ type: 'pre' })
    expect(plain(block.text).length).toBeLessThanOrEqual(32768)
  }
  const joined = pres.map((b) => plain(b.text)).join('')
  expect(joined.replace(/\n/g, '')).toBe(text.replace(/\n/g, ''))
})

test('test_c11_html_экранирование_и_теги', async () => {
  const markdownToHtml = await exported('markdownToHtml')
  const html = markdownToHtml('a < b & c > d **x** `x`\n\n```ts\nlet a = 1\n```')
  expect(html).toContain('a &lt; b &amp; c &gt; d')
  expect(html).toContain('<b>x</b>')
  expect(html).toContain('<code>x</code>')
  expect(html).toContain('<pre><code class="language-ts">')
})

test('test_c12_chunkText_не_рвёт_теги_и_сущности', async () => {
  const chunkText = await exported('chunkText')
  const lines = Array.from({ length: 12 }, (_, i) => `слово ${i} &amp; текст ${i}`)
  const text = `<b>${lines.join('\n')}</b>`
  const parts = chunkText(text, 60)
  expect(parts.length, 'текст разрезан на части').toBeGreaterThan(1)
  parts.forEach((part, i) => {
    expect(part.length).toBeLessThanOrEqual(60)
    expect(part, 'тег не разорван').not.toMatch(/<[^>]*$/)
    expect(part, 'сущность не разорвана').not.toMatch(/&[#\w]*$/)
    const opened = part.match(/<b>/g)?.length ?? 0
    const closed = part.match(/<\/b>/g)?.length ?? 0
    expect(opened, 'теги в части сбалансированы').toBe(closed)
    if (i < parts.length - 1) expect(part.endsWith('</b>'), 'открытый тег закрыт в конце части').toBe(true)
    if (i > 0) expect(part.startsWith('<b>'), 'тег открыт в начале следующей части').toBe(true)
  })
  expect(parts.join('')).toContain('текст 11')
})

test('test_c13_успех_одним_sendRichMessage_с_markdown', async () => {
  const sendFormatted = await exported('sendFormatted')
  const { api, calls } = fakeApi(() => ({ message_id: 42 }))
  const ids = await sendFormatted(api, 1, '# Заголовок\n\nтекст **жирный**')
  expect(calls, 'ровно один вызов').toHaveLength(1)
  expect(calls[0].method).toBe('sendRichMessage')
  const msg = calls[0].params.rich_message as Block
  expect(typeof msg.markdown, 'rich_message.markdown — строка').toBe('string')
  expect(String(msg.markdown)).toContain('# Заголовок')
  expect(msg.blocks, 'текст не превращается в blocks').toBeUndefined()
  expect(msg).not.toHaveProperty('html')
  expect(ids).toEqual([42])
})

test('test_c14_деградация_rich_в_html_и_в_простой_текст', async () => {
  const sendFormatted = await exported('sendFormatted')
  const markers = Array.from({ length: 300 }, (_, i) => `пункт ${i}.`)
  const md = markers.map((m) => `${m} текст абзаца текст абзаца текст абзаца`).join('\n\n')
  const tooLong = () => new TelegramApiError('sendRichMessage', 400, 'Bad Request: RICH_MESSAGE_TEXT_TOO_LONG')

  // Rich отказал, HTML прошёл: части по 4096 с parse_mode HTML
  const html = fakeApi((method) => {
    if (method === 'sendRichMessage') throw tooLong()
    return { message_id: 7 }
  })
  await sendFormatted(html.api, 1, md)
  const htmlSends = html.calls.filter((c) => c.method === 'sendMessage')
  expect(htmlSends.length, 'текст ушёл несколькими sendMessage').toBeGreaterThan(1)
  for (const c of htmlSends) {
    expect(c.params.parse_mode).toBe('HTML')
    expect(String(c.params.text).length).toBeLessThanOrEqual(4096)
  }

  // HTML тоже отказал с разбором сущностей: весь текст уходит без parse_mode
  const descriptions = [
    "Bad Request: can't parse entities: Can't find end of the entity",
    'Bad Request: can’t parse entities: Can’t find end of the entity',
  ]
  for (const description of descriptions) {
    const plainRun = fakeApi((method, params) => {
      if (method === 'sendRichMessage') throw tooLong()
      if (method === 'sendMessage' && params.parse_mode === 'HTML') {
        throw new TelegramApiError('sendMessage', 400, description)
      }
      return { message_id: 7 }
    })
    await sendFormatted(plainRun.api, 1, md)
    const plainSends = plainRun.calls.filter((c) => c.method === 'sendMessage' && c.params.parse_mode === undefined)
    expect(plainSends.length, 'есть отправка без parse_mode').toBeGreaterThan(0)
    const delivered = plainSends.map((c) => String(c.params.text)).join('')
    const missing = markers.filter((m) => !delivered.includes(m))
    expect(missing, `весь текст доставлен (${description})`).toEqual([])
  }
})

test('test_c15_пустая_строка_не_вызывает_api_и_markup_только_на_последней_части', async () => {
  const sendFormatted = await exported('sendFormatted')

  const empty = fakeApi(() => ({ message_id: 1 }))
  await sendFormatted(empty.api, 1, '')
  await sendFormatted(empty.api, 1, '   \n\t ')
  expect(empty.calls, 'API не вызван').toHaveLength(0)

  const markup = { inline_keyboard: [[{ text: 'ok', callback_data: 'ok' }]] }
  let nextId = 0
  const parts = fakeApi(() => ({ message_id: ++nextId }))
  const big = Array.from({ length: 1200 }, (_, i) => `пункт ${i}.`).join('\n\n')
  await sendFormatted(parts.api, 1, big, { replyMarkup: markup })
  const rich = parts.calls.filter((c) => c.method === 'sendRichMessage')
  expect(rich.length, 'несколько частей').toBeGreaterThan(1)
  for (const c of rich.slice(0, -1)) {
    expect(c.params.reply_markup, 'кроме последней части markup не прикреплён').toBeUndefined()
  }
  expect(rich[rich.length - 1].params.reply_markup).toEqual(markup)
})
