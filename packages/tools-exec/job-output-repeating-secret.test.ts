// A secret whose end is also its beginning (ABCDEFGH three times). A pump that held back only the longest
// beginning of the value at the end of its stream would, once the whole value arrived, still see a suffix that
// is a beginning of the value and send the rest on its own: the other stream then lands inside the value, and
// the ring shows two pieces that no whole-value match covers. The pump must keep every value that begins in
// its unsent bytes whole. The tests drive real collectors, two pumps and one ring and read pages at many
// offsets and limits and the tail (the completion notice is a tail as well).

import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { expect, test } from 'vitest'

import { JobOutput, OutputPump } from './src/index.js'

const REPEATING = 'ABCDEFGHABCDEFGHABCDEFGH'
const REPLACEMENT = 'ZYXWVUTSRQPONMLKJIHGFEDC'

type StreamName = 'stdout' | 'stderr'
type Entry = { name: string; value: string }

function harness(cap: number, captured: () => readonly Entry[], collectorCap = 1024) {
  const collectors = {
    stdout: new OutputCollector(collectorCap, 'stdout', undefined),
    stderr: new OutputCollector(collectorCap, 'stderr', undefined),
  }
  const output = new JobOutput(cap, captured)
  const pumps = [new OutputPump(collectors.stdout, output), new OutputPump(collectors.stderr, output)]
  return {
    output,
    collectors,
    push(stream: StreamName, data: string): void {
      collectors[stream].push(Buffer.from(data, 'utf8'))
    },
    poll(): void {
      for (const pump of pumps) pump.poll()
    },
    finish(): void {
      for (const pump of pumps) pump.finish()
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

function readAll(output: JobOutput, from: number, limit: number): string {
  let offset = from
  let text = ''
  while (offset < output.total) {
    const page = output.read(offset, limit)
    expect(page.next).toBeGreaterThan(offset)
    text += page.text
    offset = page.next
  }
  return text
}

function surfaces(output: JobOutput): string[] {
  const texts = [output.tail(12_000), output.tail(30), output.tail(7)]
  const from = output.earliest
  for (let offset = Math.max(from, output.total - 64); offset < output.total; offset += 1) {
    for (const limit of [1, 4, 9, 40, 400]) texts.push(output.read(offset, limit).text)
  }
  for (const offset of [0, from, from + 1, from + 8]) texts.push(output.read(offset, 400).text)
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

/** The vault after the change; the job keeps the entries it captured at start. */
const VAULT_AFTER: Record<string, Entry[]> = {
  current: [{ name: 'KEY', value: REPEATING }],
  deleted: [],
  replaced: [{ name: 'KEY', value: REPLACEMENT }],
}

test('test_h2_repeating_value_is_not_cut_when_the_whole_value_arrives', () => {
  // the counterexample of the review: 12 bytes, progress, 12 bytes, more, newline
  for (const label of Object.keys(VAULT_AFTER)) {
    for (const holder of ['stdout', 'stderr'] as const) {
      const step = `${label}, ${holder}`
      // the job captured the value at start; the vault may drop or replace it while the process lives
      const vault: Entry[] = [{ name: 'KEY', value: REPEATING }]
      const captured = [...vault]
      const run = harness(1024 * 1024, () => captured)
      run.push(holder, REPEATING.slice(0, 12))
      run.poll()
      vault.splice(0, vault.length, ...(VAULT_AFTER[label] as Entry[]))
      run.push(other(holder), 'progress\n')
      run.poll()
      expectNoPiece(run.output, [REPEATING], `${step}, the other stream wrote`)
      run.push(holder, REPEATING.slice(12))
      run.poll()
      expectNoPiece(run.output, [REPEATING], `${step}, the rest of the value arrived`)
      run.push(other(holder), 'more\n')
      run.poll()
      expectNoPiece(run.output, [REPEATING], `${step}, the other stream wrote again`)
      run.push(holder, '\n')
      run.poll()
      run.finish()
      expectNoPiece(run.output, [REPEATING], `${step}, the job finished`)
      const tail = run.output.tail(12_000)
      expect(tail, step).toContain('*'.repeat(REPEATING.length))
      expect(tail, step).toContain('progress\n')
      expect(tail, step).toContain('more\n')
    }
  }
})

test('test_h2_self_overlapping_values_split_anywhere_leave_no_piece', () => {
  const values = [REPEATING, 'ABABABABABABAB', 'XYZWXYZWQXYZWXYZ', 'AAAAAAAAAAAA']
  for (const value of values) {
    for (let first = 1; first < value.length; first += 1) {
      for (let second = first; second <= value.length; second += 1) {
        const captured = [{ name: 'KEY', value }]
        const run = harness(1024 * 1024, () => captured)
        const step = `${value} cut at ${first} and ${second}`
        run.push('stdout', `x=${value.slice(0, first)}`)
        run.poll()
        run.push('stderr', 'p1\n')
        run.poll()
        run.push('stdout', value.slice(first, second))
        run.poll()
        run.push('stderr', 'p2\n')
        run.poll()
        run.push('stdout', `${value.slice(second)}\n`)
        run.poll()
        run.push('stderr', 'p3\n')
        run.finish()
        expectNoPiece(run.output, [value], step)
        expect(run.output.tail(12_000), step).toContain('*'.repeat(value.length))
      }
    }
  }
}, 120_000)

test('test_h2_value_overlapping_another_secret_is_kept_whole', () => {
  // the end of FIRST is the beginning of SECOND, both printed overlapped
  const captured = [
    { name: 'FIRST', value: 'QWERTYUIOPASDF' },
    { name: 'SECOND', value: 'OPASDFGHJKLZXC' },
  ]
  const text = 'QWERTYUIOPASDFGHJKLZXC'
  for (let split = 1; split < text.length; split += 1) {
    const run = harness(1024 * 1024, () => captured)
    run.push('stdout', text.slice(0, split))
    run.poll()
    run.push('stderr', 'progress\n')
    run.poll()
    run.push('stdout', `${text.slice(split)}\n`)
    run.poll()
    run.finish()
    expectNoPiece(run.output, captured.map((entry) => entry.value), `split ${split}`)
    expect(run.output.tail(12_000)).toContain('progress\n')
  }
})

test('test_h2_repeating_value_on_the_overflow_boundary_leaves_no_piece', () => {
  // the collector drops the head before the first poll; the stream ends with 12 bytes of the value
  const cap = 4 * 1024 * 1024
  for (const label of Object.keys(VAULT_AFTER)) {
    for (const holder of ['stdout', 'stderr'] as const) {
      const step = `${label}, ${holder}`
      // the job captured the value at start; the vault may drop or replace it while the process lives
      const vault: Entry[] = [{ name: 'KEY', value: REPEATING }]
      const captured = [...vault]
      const run = harness(cap, () => captured, cap)
      const filler = '.'.repeat(cap + 8 - REPEATING.length - 12)
      run.push(holder, REPEATING + filler + REPEATING.slice(0, 12))
      run.poll()
      expect(run.collectors[holder].snapshot().totalBytes, step).toBe(cap + 8)
      vault.splice(0, vault.length, ...(VAULT_AFTER[label] as Entry[]))
      expectNoPiece(run.output, [REPEATING], `${step}, after the overflow`)
      run.push(other(holder), 'progress\n')
      run.poll()
      expectNoPiece(run.output, [REPEATING], `${step}, the other stream wrote`)
      run.push(holder, REPEATING.slice(12))
      run.poll()
      run.push(other(holder), 'more\n')
      run.poll()
      expectNoPiece(run.output, [REPEATING], `${step}, the rest arrived, the other stream wrote`)
      run.push(holder, '\n')
      run.finish()
      expectNoPiece(run.output, [REPEATING], `${step}, the job finished`)
      expect(run.output.tail(12_000), step).toContain('*'.repeat(REPEATING.length))
    }
  }
}, 120_000)
