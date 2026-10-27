// A multi-byte UTF-8 character whose bytes reach a background job in two polls while the job carries secrets.
// Without secrets the pump holds the incomplete trailing sequence until the rest arrives; with secrets the
// streaming mask used to send the lone lead byte on, and a chunk of the other stream then split the character in
// the shared ring, so a reader got U+FFFD twice around «progress». The tests drive real collectors, two pumps and
// one ring, and compare every surface of the job (pages at any offset and limit, the tail, which is also the
// completion notice) with the same scenario run without a secret snapshot. The secret is the job's own captured
// value, so a secret deleted or replaced in the vault while the process lives changes nothing.

import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { expect, test } from 'vitest'

import { JobOutput, OutputPump } from './src/index.js'

const VALUE = 'ABCDEFGHABCD'
const REPLACEMENT = 'ZYXWVUTSRQPO'
const REPLACEMENT_CHAR = '�'

type StreamName = 'stdout' | 'stderr'
type Captured = ReadonlyArray<{ name: string; value: string }>

interface Harness {
  output: JobOutput
  push(stream: StreamName, data: string | Buffer): void
  poll(): void
  finish(): void
}

/** Real collectors and pumps over one ring; no snapshot means a job without secrets. */
function harness(captured: Captured | undefined): Harness {
  const stdout = new OutputCollector(1024, 'stdout', undefined)
  const stderr = new OutputCollector(1024, 'stderr', undefined)
  const output = new JobOutput(1024 * 1024, captured === undefined ? undefined : () => captured)
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
  }
}

/** Every text a reader of the job can get: tails of any length and pages at any offset with several limits. */
function surfaces(output: JobOutput): string[] {
  const texts: string[] = []
  for (let limit = 1; limit <= output.total + 2; limit += 1) texts.push(output.tail(limit))
  texts.push(output.tail(12_000))
  for (let offset = 0; offset <= output.total + 1; offset += 1) {
    for (const limit of [1, 2, 3, 5, 100]) {
      const page = output.read(offset, limit)
      texts.push(`${page.start}:${page.next}:${page.text}`)
    }
  }
  return texts
}

/** The job with secrets shows what the same job without secrets shows, on every surface. */
function expectSameAs(actual: JobOutput, expected: JobOutput, step: string): void {
  expect(actual.total, `${step}: the stream length`).toBe(expected.total)
  expect(actual.earliest, `${step}: the retained head`).toBe(expected.earliest)
  const want = surfaces(expected)
  const got = surfaces(actual)
  expect(got.length).toBe(want.length)
  for (let index = 0; index < want.length; index += 1) {
    expect(got[index], `${step}: surface ${index}`).toBe(want[index])
  }
}

const other = (stream: StreamName): StreamName => (stream === 'stdout' ? 'stderr' : 'stdout')

const CHARACTERS = ['Я', '€', '😀']

test('test_h4_character_cut_by_the_other_stream_stays_whole_with_a_secret_snapshot', () => {
  const bytes = Buffer.from('Я', 'utf8')
  // the reproduction of the review: the lead byte D0, «progress», the continuation byte AF
  expect([...bytes]).toEqual([0xd0, 0xaf])
  for (const holder of ['stdout', 'stderr'] as const) {
    const withSecret = harness([{ name: 'KEY', value: VALUE }])
    const reference = harness(undefined)
    for (const run of [withSecret, reference]) {
      run.push(holder, bytes.subarray(0, 1))
      run.poll()
      run.push(other(holder), 'progress\n')
      run.poll()
      run.push(holder, bytes.subarray(1))
      run.poll()
      run.finish()
    }
    expect(withSecret.output.tail(100), `${holder}: the tail`).toBe('progress\nЯ')
    expect(withSecret.output.read(0, 100).text, `${holder}: the page`).toBe('progress\nЯ')
    expect(withSecret.output.tail(100)).not.toContain(REPLACEMENT_CHAR)
    expectSameAs(withSecret.output, reference.output, `${holder}, the finished job`)
  }
})

test('test_h4_every_surface_matches_the_job_without_secrets_at_every_step', () => {
  for (const holder of ['stdout', 'stderr'] as const) {
    for (const character of CHARACTERS) {
      const bytes = Buffer.from(character, 'utf8')
      for (let split = 1; split < bytes.length; split += 1) {
        const withSecret = harness([{ name: 'KEY', value: VALUE }])
        const reference = harness(undefined)
        const step = `${holder}, ${character} cut at ${split}`
        // both runs get the same pushes and polls; the comparison runs after each of them
        const pushes: Array<(run: Harness) => void> = [
          (run) => {
            run.push(holder, bytes.subarray(0, split))
            run.poll()
          },
          (run) => {
            run.push(other(holder), 'progress\n')
            run.poll()
          },
          (run) => {
            run.push(holder, bytes.subarray(split))
            run.poll()
          },
          (run) => run.finish(),
        ]
        pushes.forEach((apply, index) => {
          apply(withSecret)
          apply(reference)
          expectSameAs(withSecret.output, reference.output, `${step}, step ${index}`)
        })
        const tail = withSecret.output.tail(100)
        expect(tail, step).toBe(`progress\n${character}`)
        expect(tail, step).not.toContain(REPLACEMENT_CHAR)
      }
    }
  }
})

test('test_h4_deleted_or_replaced_secret_of_the_job_snapshot_changes_nothing', () => {
  const bytes = Buffer.from('Я', 'utf8')
  const cases = [
    { label: 'current', after: [{ name: 'KEY', value: VALUE }] },
    { label: 'deleted', after: [] as Array<{ name: string; value: string }> },
    { label: 'replaced', after: [{ name: 'KEY', value: REPLACEMENT }] },
  ]
  for (const { label, after } of cases) {
    for (const holder of ['stdout', 'stderr'] as const) {
      // the vault holds VALUE when the job starts; the job keeps its own copy of it
      let vault: Array<{ name: string; value: string }> = [{ name: 'KEY', value: VALUE }]
      const captured = [...vault]
      const withSecret = harness(captured)
      const reference = harness(undefined)
      const step = `${label}, ${holder}`
      withSecret.push(holder, bytes.subarray(0, 1))
      reference.push(holder, bytes.subarray(0, 1))
      withSecret.poll()
      reference.poll()
      vault = after
      expect(vault).toEqual(after)
      withSecret.push(other(holder), 'progress\n')
      reference.push(other(holder), 'progress\n')
      withSecret.poll()
      reference.poll()
      expectSameAs(withSecret.output, reference.output, `${step}, the other stream wrote`)
      withSecret.push(holder, bytes.subarray(1))
      reference.push(holder, bytes.subarray(1))
      withSecret.poll()
      reference.poll()
      withSecret.finish()
      reference.finish()
      expectSameAs(withSecret.output, reference.output, `${step}, the job finished`)
      expect(withSecret.output.tail(100), step).toBe('progress\nЯ')
      expect(withSecret.output.read(0, 100).text, step).toBe('progress\nЯ')
    }
  }
})

test('test_h4_holding_the_character_keeps_the_masking_of_a_value_after_it', () => {
  const bytes = Buffer.from('Я', 'utf8')
  for (const holder of ['stdout', 'stderr'] as const) {
    // the second half of the character comes with the beginning of the value, which waits as before
    const run = harness([{ name: 'KEY', value: VALUE }])
    run.push(holder, bytes.subarray(0, 1))
    run.poll()
    run.push(other(holder), 'progress\n')
    run.poll()
    run.push(holder, Buffer.concat([bytes.subarray(1), Buffer.from(VALUE.slice(0, 5))]))
    run.poll()
    run.push(other(holder), 'more\n')
    run.poll()
    run.push(holder, Buffer.from(`${VALUE.slice(5)}\nKEY=${VALUE}\n`))
    run.poll()
    run.finish()
    const text = run.output.tail(12_000)
    expect(text, holder).toContain('Я')
    expect(text, holder).toContain('progress')
    expect(text, holder).toContain('more')
    expect(text, holder).not.toContain(REPLACEMENT_CHAR)
    expect(text, holder).not.toContain('ABCD')
    expect(text, holder).not.toContain('EFGH')
    expect(text, `${holder}: the value is still masked`).toContain('*'.repeat(VALUE.length))
  }
})
