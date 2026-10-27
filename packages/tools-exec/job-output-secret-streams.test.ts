// A secret that a background job prints in two streams. The two pumps feed one ring, so a value that stdout
// started and stderr interrupted would sit in the ring as two halves with another line between them, and the
// masking of the ring (which looks for the whole value) would find neither. Each pump therefore holds back the
// tail of its stream that is the beginning of a value of the job, until the same stream goes on or ends; the
// value then reaches the ring whole. The tests drive real collectors, two pumps and one ring, and read every
// surface of a job: pages at many offsets and limits, the tail (the completion notice is a tail as well).
// A value is the job's own captured one, so a secret deleted or replaced in the vault while the process lives
// is still hidden.

import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { expect, test } from 'vitest'

import { JobOutput, OutputPump } from './src/index.js'

const VALUE = 'ABCDEFGHIJKLMNOPQRSTUVWX'
const OTHER = 'qrstuvwxyz-0123456789-QRST'
const CYRILLIC = 'КЛЮЧ-секрет-значение-42'

type StreamName = 'stdout' | 'stderr'

interface Harness {
  output: JobOutput
  push(stream: StreamName, data: string | Buffer): void
  /** Poll both pumps, as the job timer does. */
  poll(): void
  finish(): void
  collector(stream: StreamName): OutputCollector
}

function harness(cap: number, captured: readonly { name: string; value: string }[], collectorCap = 1024): Harness {
  const stdout = new OutputCollector(collectorCap, 'stdout', undefined)
  const stderr = new OutputCollector(collectorCap, 'stderr', undefined)
  const output = new JobOutput(cap, () => captured)
  const pumps = [new OutputPump(stdout, output), new OutputPump(stderr, output)]
  return {
    output,
    push(stream, data) {
      ;(stream === 'stdout' ? stdout : stderr).push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    },
    poll() {
      for (const pump of pumps) pump.poll()
    },
    finish() {
      for (const pump of pumps) pump.finish()
    },
    collector(stream) {
      return stream === 'stdout' ? stdout : stderr
    },
  }
}

/** The longest piece of `value`, of at least four characters, that `text` shows, or undefined. */
function visiblePiece(text: string, value: string): string | undefined {
  for (let size = value.length; size >= 4; size -= 1) {
    for (let at = 0; at + size <= value.length; at += 1) {
      const piece = value.slice(at, at + size)
      if (text.includes(piece)) return piece
    }
  }
  return undefined
}

/** Every page of the ring from `from`, walked with `limit` characters at a time. */
function readAll(output: JobOutput, from: number, limit: number): string {
  let offset = from
  let text = ''
  let pages = 0
  while (offset < output.total) {
    const page = output.read(offset, limit)
    expect(page.next, `the page at ${offset} moves forward`).toBeGreaterThan(offset)
    text += page.text
    offset = page.next
    pages += 1
    expect(pages, 'the reading ends').toBeLessThan(100_000)
  }
  return text
}

/** What a reader of the job gets: the tail (also the completion notice) and pages with any offset and limit. */
function surfaces(output: JobOutput): string[] {
  const texts = [output.tail(12_000), output.tail(30), output.tail(7)]
  const from = output.earliest
  const offsets = [0, from, from + 1, from + 5, from + 12, from + 23, output.total - 40, output.total - 13, output.total - 1]
  for (const offset of offsets) {
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

const other = (stream: StreamName): StreamName => (stream === 'stdout' ? 'stderr' : 'stdout')

test('test_h2_value_cut_by_the_other_stream_is_whole_in_the_ring_and_masked', () => {
  // the example of the task: stdout ABCDEFGHIJKL, stderr «progress», stdout MNOPQRSTUVWX
  const captured = [{ name: 'KEY', value: VALUE }]
  const run = harness(1024 * 1024, captured)
  run.push('stdout', VALUE.slice(0, 12))
  run.poll()
  expectNoPiece(run.output, [VALUE], 'the head of the value arrived')
  run.push('stderr', 'progress\n')
  run.poll()
  expectNoPiece(run.output, [VALUE], 'stderr went between the halves')
  expect(run.output.tail(12_000), 'the other stream is not held back').toContain('progress')
  run.push('stdout', `${VALUE.slice(12)}\n`)
  run.poll()
  expectNoPiece(run.output, [VALUE], 'the rest of the value arrived')
  run.finish()
  expectNoPiece(run.output, [VALUE], 'the job finished')
  const tail = run.output.tail(12_000)
  expect(tail, 'the whole value is masked at once').toContain('*'.repeat(VALUE.length))
  expect(tail).toContain('progress')
})

test('test_h2_value_cut_at_every_byte_by_the_other_stream_leaves_no_piece', () => {
  for (const value of [VALUE, CYRILLIC]) {
    const bytes = Buffer.from(value, 'utf8')
    for (const holder of ['stdout', 'stderr'] as const) {
      for (let split = 1; split < bytes.length; split += 1) {
        const captured = [{ name: 'KEY', value }]
        const run = harness(1024 * 1024, captured)
        const step = `${holder}, split ${split} of ${value}`
        run.push(holder, Buffer.concat([Buffer.from('KEY='), bytes.subarray(0, split)]))
        run.poll()
        expectNoPiece(run.output, [value], `${step}, the head arrived`)
        run.push(other(holder), 'progress\n')
        run.poll()
        expectNoPiece(run.output, [value], `${step}, the other stream wrote`)
        run.push(holder, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]))
        run.poll()
        expectNoPiece(run.output, [value], `${step}, the rest arrived`)
        run.finish()
        expectNoPiece(run.output, [value], `${step}, the job finished`)
        const tail = run.output.tail(12_000)
        expect(tail, step).toContain('*'.repeat(bytes.length))
        expect(tail, step).toContain('progress')
      }
    }
  }
})

test('test_h2_value_dribbled_byte_by_byte_with_the_other_stream_between_every_byte', () => {
  for (const value of [VALUE, CYRILLIC]) {
    const bytes = Buffer.from(value, 'utf8')
    const captured = [{ name: 'KEY', value }]
    const run = harness(1024 * 1024, captured)
    for (let index = 0; index < bytes.length; index += 1) {
      run.push('stdout', bytes.subarray(index, index + 1))
      run.poll()
      expectNoPiece(run.output, [value], `byte ${index} of ${value} arrived`)
      run.push('stderr', `p${index}\n`)
      run.poll()
      expectNoPiece(run.output, [value], `byte ${index} of ${value}, stderr wrote`)
    }
    run.push('stdout', '\n')
    run.finish()
    expectNoPiece(run.output, [value], `the job with ${value} finished`)
    expect(run.output.tail(12_000)).toContain('*'.repeat(bytes.length))
  }
})

test('test_h2_the_beginning_of_any_secret_of_the_job_is_held_not_only_the_first', () => {
  const captured = [
    { name: 'FIRST', value: VALUE },
    { name: 'SECOND', value: OTHER },
  ]
  for (const value of [VALUE, OTHER]) {
    for (let split = 1; split < value.length; split += 1) {
      const run = harness(1024 * 1024, captured)
      run.push('stdout', value.slice(0, split))
      run.poll()
      run.push('stderr', 'progress\n')
      run.poll()
      expectNoPiece(run.output, [VALUE, OTHER], `${value} split ${split}, stderr wrote`)
      run.push('stdout', `${value.slice(split)}\n`)
      run.poll()
      run.finish()
      expectNoPiece(run.output, [VALUE, OTHER], `${value} split ${split}, the job finished`)
      expect(run.output.tail(12_000)).toContain('*'.repeat(value.length))
    }
  }
})

test('test_h2_value_deleted_or_replaced_in_the_vault_is_still_held_while_the_process_lives', () => {
  const OLD = VALUE
  const REPLACEMENT = 'ZYXWVUTSRQPONMLKJIHGFEDC'
  const cases = [
    { label: 'deleted', after: [] as { name: string; value: string }[] },
    { label: 'replaced', after: [{ name: 'KEY', value: REPLACEMENT }] },
  ]
  for (const { label, after } of cases) {
    for (const holder of ['stdout', 'stderr'] as const) {
      for (const split of [1, 4, 12, 20, 23]) {
        // the vault holds the old value when the job starts; the job keeps its own copy
        let vault = [{ name: 'KEY', value: OLD }]
        const captured = [...vault]
        const run = harness(1024 * 1024, captured)
        const step = `${label}, ${holder}, split ${split}`
        run.push(holder, `KEY=${OLD.slice(0, split)}`)
        run.poll()
        expectNoPiece(run.output, [OLD], `${step}, the head arrived`)
        vault = after
        expect(vault, 'the vault no longer has the old value').not.toContainEqual({ name: 'KEY', value: OLD })
        run.push(other(holder), 'progress\n')
        run.poll()
        expectNoPiece(run.output, [OLD], `${step}, the secret changed, the other stream wrote`)
        run.push(holder, `${OLD.slice(split)}\nAGAIN=${OLD}\n`)
        run.poll()
        expectNoPiece(run.output, [OLD], `${step}, the rest arrived`)
        run.finish()
        expectNoPiece(run.output, [OLD], `${step}, the job finished`)
        expect(run.output.tail(12_000), step).toContain('*'.repeat(OLD.length))
      }
    }
  }
})

test('test_h2_collector_overflow_then_other_stream_then_rest_of_value_leaves_no_piece', () => {
  // the real ring size: the value, filler and 12 characters of the value, 8 bytes over the cap, so the
  // collector drops the head before the first poll; then the other stream writes; then the rest of the value
  const cap = 4 * 1024 * 1024
  const captured = [{ name: 'BIGKEY', value: VALUE }]
  const OLD = VALUE
  for (const label of ['current', 'deleted', 'replaced']) {
    // the job keeps its captured value whatever the vault does with the secret afterwards
    for (const holder of ['stdout', 'stderr'] as const) {
      const step = `${label}, ${holder}`
      const run = harness(cap, captured, cap)
      const filler = '.'.repeat(cap + 8 - OLD.length - 12)
      run.push(holder, OLD + filler + OLD.slice(0, 12))
      run.poll()
      const snapshot = run.collector(holder).snapshot()
      expect(snapshot.totalBytes, `${step}: the stream is cap + 8 bytes`).toBe(cap + 8)
      expect(snapshot.bytes.length, `${step}: the collector dropped the head`).toBe(cap)
      expectNoPiece(run.output, [OLD], `${step}, after the overflow`)
      run.push(other(holder), 'progress\n')
      run.poll()
      expectNoPiece(run.output, [OLD], `${step}, the other stream wrote`)
      expect(run.output.tail(12_000), `${step}: the other stream is not held back`).toContain('progress')
      run.push(holder, `${OLD.slice(12)}\n`)
      run.poll()
      expectNoPiece(run.output, [OLD], `${step}, the rest of the value arrived`)
      run.finish()
      expectNoPiece(run.output, [OLD], `${step}, the job finished`)
      expect(run.output.tail(12_000), step).toContain(`${'*'.repeat(OLD.length)}\n`)
    }
  }
}, 120_000)
