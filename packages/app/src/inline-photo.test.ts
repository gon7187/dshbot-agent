import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { embedInlinePhotos } from './inline-photo.js'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const homes: string[] = []

function makeHome(files: Record<string, Buffer> = { 'outbox/chart.png': PNG }): string {
  const home = mkdtempSync(join(tmpdir(), 'inline-photo-'))
  homes.push(home)
  mkdirSync(join(home, 'workspace', 'outbox'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, 'workspace', name), body)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('маркер с путём вкладывает картинку и оставляет ссылку tg://', () => {
  const home = makeHome()
  const result = embedInlinePhotos(home, 'Отчёт\n\n[[фото: outbox/chart.png]]\n\nХвост')
  expect(result.markdown).toBe('Отчёт\n\n![](tg://photo?id=photo1)\n\nХвост')
  expect(result.media).toHaveLength(1)
  expect(result.media[0]).toMatchObject({ id: 'photo1', name: 'chart.png', contentType: 'image/png' })
  expect(Buffer.from(result.media[0]?.data ?? []).equals(PNG)).toBe(true)
  expect(result.skipped).toEqual([])
})

test('обычная картинка Markdown тоже становится вложением', () => {
  const home = makeHome()
  const result = embedInlinePhotos(home, 'текст\n\n![](outbox/chart.png)')
  expect(result.markdown).toBe('текст\n\n![](tg://photo?id=photo1)')
  expect(result.media).toHaveLength(1)
})

test('маркер без пути берёт единственную картинку ответа', () => {
  const home = makeHome()
  const result = embedInlinePhotos(home, '[[фото]]\n\n![](outbox/chart.png)')
  expect(result.markdown).toBe('![](tg://photo?id=photo1)\n\n![](tg://photo?id=photo1)')
  expect(result.media).toHaveLength(1)
})

test('маркер без пути убирается, когда картинок несколько', () => {
  const home = makeHome({ 'outbox/a.png': PNG, 'outbox/b.png': PNG })
  const result = embedInlinePhotos(home, '[[фото]]\n![](outbox/a.png)\n![](outbox/b.png)')
  expect(result.markdown).toBe('\n![](tg://photo?id=photo1)\n![](tg://photo?id=photo2)')
  expect(result.media.map((item) => item.id)).toEqual(['photo1', 'photo2'])
})

test('повторная ссылка на тот же файл не дублирует вложение', () => {
  const home = makeHome()
  const result = embedInlinePhotos(home, '![](outbox/chart.png)\n![](outbox/chart.png)')
  expect(result.media).toHaveLength(1)
  expect(result.markdown.match(/tg:\/\/photo\?id=photo1/g)).toHaveLength(2)
})

test('пропавший файл и путь вне workspace не ломают ответ', () => {
  const home = makeHome()
  const result = embedInlinePhotos(home, '![](outbox/missing.png)\n![](../secret.png)')
  expect(result.media).toEqual([])
  expect(result.markdown).toBe('![](outbox/missing.png)\n![](../secret.png)')
  expect(result.skipped).toEqual(['outbox/missing.png', '../secret.png'])
})

test('не картинка и внешняя ссылка не уходят вложением', () => {
  const home = makeHome({ 'outbox/report.xlsx': PNG })
  const result = embedInlinePhotos(home, '![](outbox/report.xlsx)\n![](https://example.com/a.png)')
  expect(result.media).toEqual([])
  expect(result.markdown).toBe('![](outbox/report.xlsx)\n![](https://example.com/a.png)')
  expect(result.skipped).toEqual(['outbox/report.xlsx'])
})

test('текст без картинок не меняется', () => {
  const home = makeHome()
  const text = 'KPI 219 649,93 ₽\n| a | b |'
  const result = embedInlinePhotos(home, text)
  expect(result).toEqual({ markdown: text, media: [], skipped: [] })
})
