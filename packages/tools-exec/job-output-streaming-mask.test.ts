import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { expect, test } from 'vitest'

import { JobOutput, OutputPump } from './src/index.js'

const VALUE = 'ABCDEFGHABCD'

function job(values: string[], cap = 256) {
  const collectors = [new OutputCollector(cap, 'stdout', undefined), new OutputCollector(cap, 'stderr', undefined)]
  const output = new JobOutput(cap, () => values.map((value) => ({ name: 'KEY', value })))
  const pumps = collectors.map((collector) => new OutputPump(collector, output))
  const check = () => {
    // Inspect both consumer surfaces after every poll, including one-byte reads.
    let pages = ''
    for (let offset = output.earliest; offset < output.total;) {
      const page = output.read(offset, 1)
      expect(page.next).toBeGreaterThan(offset)
      pages += page.text
      offset = page.next
    }
    for (const text of [pages, output.tail(1024)]) {
      for (const value of captured) {
        for (let at = 0; at + 4 <= value.length; at++) expect(text).not.toContain(value.slice(at, at + 4))
      }
      expect(text).not.toContain('�')
    }
  }
  const captured = [...values]
  return {
    output,
    write(stream: 0 | 1, text: string | Buffer) {
      collectors[stream]!.push(typeof text === 'string' ? Buffer.from(text) : text)
      for (const pump of pumps) pump.poll()
      check()
    },
    finish() {
      for (const pump of pumps) pump.finish()
      check()
    },
  }
}

test.each(['split', 'repeating', 'repeating-overflow', 'overlapping', 'overflow', 'utf8', 'unfinished'] as const)(
  'streaming secret masking survives %s without leaking through pages or tail', (shape) => {
    const value = shape.startsWith('repeating') ? 'ABABABABABAB' : VALUE
    const vault = [value]
    const run = job(vault)
    if (shape.includes('overflow')) run.write(0, '.'.repeat(260) + value.slice(0, 5))
    else if (shape === 'overlapping') run.write(0, 'ABCDEFGH'.repeat(12) + 'ABCD')
    else if (shape === 'utf8') {
      const bytes = Buffer.from('Я')
      run.write(0, bytes.subarray(0, 1))
      run.write(1, 'progress\n')
      run.write(0, Buffer.concat([bytes.subarray(1), Buffer.from(value.slice(0, 5))]))
    } else run.write(0, value.slice(0, 5))
    run.write(1, 'progress\n')
    if (shape !== 'unfinished') run.write(0, value.slice(shape === 'overlapping' ? 4 : 5) + '\ndone\n')
    run.finish()
    expect(run.output.tail(1024)).toContain('progress')
    if (shape !== 'unfinished') expect(run.output.tail(1024)).toContain('done')
    if (shape === 'utf8') expect(run.output.tail(1024)).toContain('Я')
  },
)

test('byte-at-a-time overlapping values stay hidden when the other stream interleaves', () => {
  const run = job([VALUE, 'EFGHABCDEFGH'])
  for (const byte of Buffer.from(`x ${VALUE}EFGHABCD y\n`)) {
    run.write(0, Buffer.from([byte]))
    run.write(1, '.')
  }
  run.finish()
  const text = run.output.tail(1024).replaceAll('.', '')
  expect(text).toMatch(/^x \*+ y\n$/)
})
