// Краевые случаи chunkText: атомарные теги и сущности на границе части и
// лимит меньше самого тега. Основные требования c12 проверяет rich.test.ts;
// здесь — случаи, на которых прежняя реализация рвала разметку через slice.

import { expect, test } from 'vitest'
import { chunkText } from './html.js'

function expectSane(parts: string[], max: number): void {
  for (const part of parts) {
    expect(part.length, `часть не длиннее ${max}: ${JSON.stringify(part)}`).toBeLessThanOrEqual(max)
    expect(part, 'нет оборванного тега').not.toMatch(/<[^>]*$/)
    expect(part, 'нет оборванной сущности').not.toMatch(/&[#a-zA-Z][^;]*$/)
    const opens = part.match(/<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g) ?? []
    const closes = part.match(/<\/[a-zA-Z][a-zA-Z0-9-]*>/g) ?? []
    expect(closes.length, `теги сбалансированы: ${JSON.stringify(part)}`).toBe(opens.length)
  }
}

test('chunkText переносит длинный <a> целиком и оставляет текст ссылки', () => {
  const html = '<a href="https://example.com/very/long/path?query=1">ссылка</a>'
  const parts = chunkText(html, 20)
  expectSane(parts, 20)
  expect(parts.join('')).toContain('ссылка')
  expect(parts.join(''), 'неподъёмный тег выброшен, а не разрезан').not.toContain('<a')
})

test('chunkText не рвёт сущность на границе части', () => {
  const text = `${'&amp; '.repeat(10)}конец`
  const parts = chunkText(text, 10)
  expectSane(parts, 10)
  expect(parts.join('')).toContain('конец')
  expect(parts.every((part) => !part.includes('&am') || part.includes('&amp;'))).toBe(true)
})

test('chunkText с max меньше длины сущности заменяет её символом', () => {
  const parts = chunkText('&amp;', 4)
  expectSane(parts, 4)
  expect(parts.join('')).toBe('&')
})

test('chunkText с max меньше длины тега не оставляет оборванной разметки', () => {
  const parts = chunkText('<b>x</b>', 3)
  expectSane(parts, 3)
  expect(parts.join('')).toContain('x')
})

test('chunkText выбрасывает длинный <a> посреди текста', () => {
  const text = `префикс <a href="https://example.com/${'x'.repeat(40)}">link</a> суффикс`
  const parts = chunkText(text, 16)
  expectSane(parts, 16)
  expect(parts.join('')).toContain('префикс')
  expect(parts.join('')).toContain('суффикс')
  expect(parts.join('')).toContain('link')
})

test('chunkText закрывает и заново открывает вложенные теги на границе', () => {
  const text = `<b><i>${'x '.repeat(40)}</i></b>`
  const parts = chunkText(text, 24)
  expectSane(parts, 24)
  parts.forEach((part, i) => {
    if (i < parts.length - 1) expect(part.endsWith('</i></b>'), 'закрывает вложенные теги').toBe(true)
    if (i > 0) expect(part.startsWith('<b><i>'), 'заново открывает вложенные теги').toBe(true)
  })
})

test('chunkText переносит сущность, не влезающую в остаток части', () => {
  const parts = chunkText('<b>слово &amp; слово</b>', 14)
  expectSane(parts, 14)
  expect(parts.join('')).toContain('слово')
})
