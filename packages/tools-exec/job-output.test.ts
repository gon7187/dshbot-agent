// The output ring of a background job, driven directly: pages of multibyte output always move forward
// and cover the stream without gaps or repeats, the tail is counted in characters and never starts
// inside one, and an overflow drops exactly the excess so the ring keeps the last `cap` bytes. The pump
// from a real collector keeps a character whole when its bytes arrive in different polls.

import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { expect, test } from 'vitest'

import { JobOutput, OutputPump } from './src/index.js'

/** Read the whole ring page by page from `from`, checking that every page advances. */
function readAll(output: JobOutput, from: number, limit: number): string {
  let offset = from
  let text = ''
  let pages = 0
  while (offset < output.total) {
    const page = output.read(offset, limit)
    expect(page.next, `the page at ${offset} (limit ${limit}) moves forward`).toBeGreaterThan(offset)
    expect(page.text).not.toContain('�')
    expect(Buffer.byteLength(page.text, 'utf8')).toBe(page.next - page.start)
    text += page.text
    offset = page.next
    pages += 1
    expect(pages, 'the reading ends').toBeLessThan(100_000)
  }
  return text
}

test('pages of cyrillic output with limit 1 and 3 read everything in order', () => {
  const source = 'Яя' + 'привет, мир! ' + 'ёж'.repeat(50)
  for (const limit of [1, 3]) {
    const output = new JobOutput(1024 * 1024)
    output.append(source.slice(0, 7))
    output.append(source.slice(7))
    expect(readAll(output, 0, limit), `limit ${limit}`).toBe(source)
  }

  const output = new JobOutput(1024)
  output.append('Яя')
  expect(output.read(0, 1)).toMatchObject({ text: 'Я', start: 0, next: 2, total: 4 })
  expect(output.read(2, 1)).toMatchObject({ text: 'я', start: 2, next: 4 })
  expect(output.read(4, 1)).toMatchObject({ text: '', start: 4, next: 4 })
  // an offset inside a character starts the page at the next one
  expect(output.read(1, 10)).toMatchObject({ text: 'я', start: 2, next: 4 })
  // limit counts characters, not bytes: three characters are three letters
  expect(output.read(0, 3)).toMatchObject({ text: 'Яя', next: 4 })
  // one character of an astral pair is the whole character, never half of it
  const astral = new JobOutput(1024)
  astral.append('😀x')
  expect(astral.read(0, 1)).toMatchObject({ text: '😀', start: 0, next: 4 })
  expect(astral.read(4, 1)).toMatchObject({ text: 'x', next: 5 })
  expect(readAll(astral, 0, 1)).toBe('😀x')
})

test('the tail is limited in characters and starts on a character boundary', () => {
  const output = new JobOutput(1024 * 1024)
  output.append('я'.repeat(7000))
  output.append('ж'.repeat(7000))
  const tail = output.tail(12_000)
  expect(tail.length).toBe(12_000)
  expect(tail).not.toContain('�')
  expect(tail).toBe('я'.repeat(5000) + 'ж'.repeat(7000))

  const short = new JobOutput(1024)
  short.append('hello, мир')
  expect(short.tail(12_000)).toBe('hello, мир')

  const astral = new JobOutput(1024)
  astral.append('a😀b😀')
  expect(astral.tail(3)).toBe('b😀')
  expect(astral.tail(2)).toBe('😀')
})

test('an overflow drops only the excess, so the ring keeps exactly the last cap bytes', () => {
  const cap = 4 * 1024 * 1024
  const output = new JobOutput(cap)
  output.append('a'.repeat(cap))
  output.append('b')
  expect(output.total).toBe(cap + 1)
  expect(output.size).toBe(cap)
  expect(output.earliest).toBe(output.total - cap)
  const page = output.read(0, 10)
  expect(page.lossy).toBe(true)
  expect(page.start).toBe(1)
  expect(page.text).toBe('a'.repeat(10))
  expect(output.read(output.total - 3, 10).text).toBe('aab')

  // several chunks: the oldest are dropped whole, the boundary one is cut
  const ring = new JobOutput(10)
  ring.append('0123')
  ring.append('4567')
  ring.append('89ab')
  expect(ring.size).toBe(10)
  expect(ring.earliest).toBe(2)
  expect(readAll(ring, ring.earliest, 3)).toBe('23456789ab')
})

test('a window that begins inside a character is read from the next whole character', () => {
  const output = new JobOutput(5)
  output.append('яяя')
  // 6 bytes, cap 5: the first byte of the first «я» is dropped
  expect(output.earliest).toBe(1)
  expect(output.read(0, 100)).toMatchObject({ text: 'яя', start: 2, next: 6, lossy: true })
  expect(output.tail(10)).toBe('яя')
  expect(readAll(output, output.earliest, 1)).toBe('яя')
})

/** Feed `bytes` into a real collector portion by portion, polling the pump after each one. */
function pumpPortions(portions: number[][], cap = 1024 * 1024): { output: JobOutput; source: Buffer } {
  const collector = new OutputCollector(cap, 'stdout', undefined)
  const output = new JobOutput(cap)
  const pump = new OutputPump(collector, output)
  for (const portion of portions) {
    collector.push(Buffer.from(portion))
    pump.poll()
  }
  pump.finish()
  return { output, source: Buffer.concat(portions.map((portion) => Buffer.from(portion))) }
}

test('a character whose bytes arrive in different polls reaches the ring whole', () => {
  // «Я» is D0 AF, «😀» is F0 9F 98 80: every split point of both, each byte in its own poll
  const bytes = [...Buffer.from('aЯb😀cЯ', 'utf8')]
  const splits = [bytes.map((byte) => [byte]), [bytes.slice(0, 2), bytes.slice(2, 5), bytes.slice(5, 7), bytes.slice(7)]]
  for (const portions of splits) {
    const { output, source } = pumpPortions(portions)
    expect(output.total, 'total is the real number of bytes').toBe(source.length)
    for (const limit of [1, 3]) {
      expect(readAll(output, 0, limit), `limit ${limit}`).toBe('aЯb😀cЯ')
    }
  }

  // the bytes of «Я» alone, polled apart: one character of two bytes, not two U+FFFD
  const { output } = pumpPortions([[0xd0], [0xaf]])
  expect(output.total).toBe(2)
  expect(output.read(0, 1)).toMatchObject({ text: 'Я', start: 0, next: 2 })
})

test('a held character of one stream is not split by the bytes of the other', () => {
  const stdout = new OutputCollector(1024, 'stdout', undefined)
  const stderr = new OutputCollector(1024, 'stderr', undefined)
  const output = new JobOutput(1024)
  const pumps = [new OutputPump(stdout, output), new OutputPump(stderr, output)]
  stdout.push(Buffer.from([0xf0, 0x9f]))
  stderr.push(Buffer.from('ж', 'utf8'))
  for (const pump of pumps) pump.poll()
  stdout.push(Buffer.from([0x98, 0x80]))
  for (const pump of pumps) pump.poll()
  for (const pump of pumps) pump.finish()
  expect(output.total).toBe(6)
  expect(readAll(output, 0, 1)).toBe('ж😀')
})

test('a stream that ends inside a character keeps its bytes and offsets', () => {
  const { output } = pumpPortions([[0x61], [0xd0]])
  expect(output.total).toBe(2)
  expect(output.read(0, 1)).toMatchObject({ text: 'a', next: 1 })
})

test('bytes the collector dropped between polls stay a gap of the right size', () => {
  const collector = new OutputCollector(4, 'stdout', undefined)
  const output = new JobOutput(1024)
  const pump = new OutputPump(collector, output)
  collector.push(Buffer.from([0x61, 0xd0]))
  pump.poll()
  collector.push(Buffer.from('bcdefgh', 'utf8'))
  pump.finish()
  // 9 bytes in the stream, the collector kept the last 4: the held D0 and «bcd» are the gap
  expect(output.total).toBe(9)
  expect(output.earliest).toBe(5)
  expect(output.read(0, 100)).toMatchObject({ text: 'efgh', start: 5, next: 9, lossy: true })
})

// --- secrets: the job's values are masked when read, never in the stored bytes -------------------------------

const VALUE = 'ABCDEFGHIJKLMNOPQRSTUVWX'
const CYRILLIC = 'КЛЮЧ-секрет-значение-42'

/** The first piece of `value` of at least four characters that `text` shows, or undefined. */
function visiblePiece(text: string, value: string): string | undefined {
  for (let size = value.length; size >= 4; size -= 1) {
    for (let at = 0; at + size <= value.length; at += 1) {
      const piece = value.slice(at, at + size)
      if (text.includes(piece)) return piece
    }
  }
  return undefined
}

/** Every surface a reader of the job gets: pages at many offsets and limits, the whole window paged, the tail. */
function surfaces(output: JobOutput): string[] {
  const texts = [output.tail(12_000), output.tail(30), output.tail(7)]
  const from = output.earliest
  for (const offset of [0, from, from + 1, from + 5, from + 12, from + 23, output.total - 40, output.total - 13, output.total - 1]) {
    for (const limit of [1, 4, 10, 40, 400]) texts.push(output.read(Math.max(0, offset), limit).text)
  }
  if (output.total - from <= 4096) {
    for (const limit of [1, 3, 7, 400]) texts.push(readAll(output, from, limit))
  }
  return texts
}

function expectNoPiece(output: JobOutput, values: readonly string[], step: string): void {
  for (const text of surfaces(output)) {
    for (const value of values) {
      expect(visiblePiece(text, value), `${step}: a piece of the secret is visible in:\n${text.slice(-600)}`).toBeUndefined()
    }
  }
}

test('a secret split between polls with a read in between leaves no piece of it on any surface', () => {
  for (const value of [VALUE, CYRILLIC]) {
    const bytes = Buffer.from(value, 'utf8')
    for (let split = 1; split < bytes.length; split += 1) {
      // the captured values of the job: the vault may have deleted or replaced the secret since, the job keeps them
      const captured = [{ name: 'KEY', value }]
      const collector = new OutputCollector(1024, 'stdout', undefined)
      const output = new JobOutput(1024, () => captured)
      const pump = new OutputPump(collector, output)
      collector.push(Buffer.concat([Buffer.from('KEY='), bytes.subarray(0, split)]))
      pump.poll()
      expectNoPiece(output, [value], `split ${split}, the head of the value arrived`)
      collector.push(Buffer.concat([bytes.subarray(split), Buffer.from('\nAGAIN=')]))
      pump.poll()
      expectNoPiece(output, [value], `split ${split}, the rest of the value arrived`)
      collector.push(Buffer.concat([bytes, Buffer.from('\n')]))
      pump.finish()
      expectNoPiece(output, [value], `split ${split}, the job finished`)
      expect(output.tail(12_000), 'the text around the value stays').toMatch(/^KEY=\*+\nAGAIN=\*+\n$/)
    }
  }
})

test('the stored bytes stay whole, so the continuation of a masked partial value is still matched', () => {
  const captured = [{ name: 'KEY', value: VALUE }]
  const output = new JobOutput(1024, () => captured)
  output.append(VALUE.slice(0, 12))
  expect(output.read(0, 100).text).toBe('*'.repeat(12))
  output.append(`${VALUE.slice(12)}\nok\n`)
  expect(output.read(0, 100).text).toBe(`${'*'.repeat(VALUE.length)}\nok\n`)
  expect(output.read(12, 5).text).toBe('*****')
})

test('a collector overflow before a poll leaves no suffix of the secret, before and after its continuation', { timeout: 30_000 }, () => {
  // the reviewer's order on the real ring size: the value, filler and 12 characters of the value, 8 bytes
  // over the cap, so the collector drops the head; then poll, read, the other 12 characters and the end
  const cap = 4 * 1024 * 1024
  const captured = [{ name: 'BIGKEY', value: VALUE }]
  const collector = new OutputCollector(cap, 'stdout', undefined)
  const output = new JobOutput(cap, () => captured)
  const pump = new OutputPump(collector, output)
  const filler = '.'.repeat(cap + 8 - VALUE.length - 12)
  collector.push(Buffer.from(VALUE + filler + VALUE.slice(0, 12)))
  pump.poll()
  expect(output.earliest).toBe(8)
  expectNoPiece(output, [VALUE], 'after the overflow')
  expect(output.read(8, 30).text, 'the head is replaced up to the longest value minus one byte').toBe(`${'*'.repeat(VALUE.length - 1)}.......`)
  collector.push(Buffer.from(`${VALUE.slice(12)}\n`))
  pump.poll()
  expectNoPiece(output, [VALUE], 'after the continuation')
  pump.finish()
  expectNoPiece(output, [VALUE], 'after the end')
  expect(output.read(cap + 8 - 12, 100).text).toBe(`${'*'.repeat(VALUE.length)}\n`)

  // the same on small rings, for every place of the cut and of the split
  for (let drop = 1; drop <= VALUE.length + 2; drop += 1) {
    for (const split of [1, 4, 12, 20, 23]) {
      const small = 128
      const ringCollector = new OutputCollector(small, 'stdout', undefined)
      const ring = new JobOutput(small, () => captured)
      const ringPump = new OutputPump(ringCollector, ring)
      const pad = '.'.repeat(small + drop - VALUE.length - split)
      ringCollector.push(Buffer.from(VALUE + pad + VALUE.slice(0, split)))
      ringPump.poll()
      expectNoPiece(ring, [VALUE], `drop ${drop}, split ${split}, after the overflow`)
      ringCollector.push(Buffer.from(`${VALUE.slice(split)}\n${VALUE}`))
      ringPump.poll()
      expectNoPiece(ring, [VALUE], `drop ${drop}, split ${split}, after the continuation`)
      ringPump.finish()
      expectNoPiece(ring, [VALUE], `drop ${drop}, split ${split}, after the end`)
    }
  }
})

test('a full value right after a lost head is still recognised and masked', () => {
  const captured = [{ name: 'KEY', value: VALUE }]
  const output = new JobOutput(1024, () => captured)
  output.skip(5)
  output.append(`${VALUE}\n${VALUE}`)
  expect(output.read(0, 100).text).toBe(`${'*'.repeat(VALUE.length)}\n${'*'.repeat(VALUE.length)}`)
})
