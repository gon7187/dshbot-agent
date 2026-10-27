// Background exec jobs: reading the output from a position, writing to stdin, the list of jobs and a
// ring buffer far larger than 32 KiB. The tests drive createExecTools directly against the real bwrap
// sandbox (same wiring as exec-node-path.test.ts), so they see the answers of the tools exactly as the model
// gets them. The wording of the answers is not fixed by the task, so the checks are made on the content:
//   - the output of a job is a row source (`row-000001;row-000002;...`, no newlines), so every position of
//     the stream is known and a page can be compared with the expected slice of the stream;
//   - the next offset is read from a label (`next offset`, `nextOffset`, `следующий offset`), and when the
//     answer carries no such label the number itself must be in the answer next to the page.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const MIB = 1024 * 1024

let workspace = ''
let exec: ExecTools
const started: string[] = []

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-bg-'))
  exec = await createExecTools({ workspace, home: HOME })
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

type Args = Record<string, unknown>

async function callTool(name: string, args: Args): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

/** The answer of a call, or the message of the error it threw: both carry what the model reads. */
async function answerOrError(name: string, args: Args): Promise<{ text: string; threw: boolean }> {
  try {
    return { text: await callTool(name, args), threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

async function startJob(command: string): Promise<string> {
  const answer = await callTool('exec', { command, background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1]
  expect(id, `a background start names the job id: ${answer}`).toBeDefined()
  started.push(id as string)
  return id as string
}

async function waitFinished(id: string, timeoutMs = 90_000): Promise<string> {
  const from = Date.now()
  let last = ''
  while (Date.now() - from < timeoutMs) {
    last = await callTool('exec_status', { id })
    if (/Статус:\s*(completed|failed|killed)/.test(last)) return last
    await sleep(150)
  }
  throw new Error(`the job ${id} did not finish: ${last.slice(0, 300)}`)
}

// --- the row source -----------------------------------------------------------------------------------------

interface Source {
  /** Characters per row. */
  rowLength: number
  width: number
  total: number
  command: string
  slice(from: number, to: number): string
}

/** `rows` rows `row-<n padded to width>;` without any newline, followed by `suffix`. */
function makeSource(width: number, rows: number, suffix = ''): Source {
  const rowLength = width + 5
  const rowText = (n: number): string => `row-${String(n).padStart(width, '0')};`
  const total = rows * rowLength + suffix.length
  return {
    rowLength,
    width,
    total,
    command: `seq -f 'row-%0${width}.0f;' 1 ${rows} | tr -d '\\n'${suffix === '' ? '' : `; printf '${suffix}'`}`,
    slice(from, to) {
      const end = Math.min(to, total)
      if (from >= end) return ''
      const firstRow = Math.floor(from / rowLength) + 1
      const lastRow = Math.min(rows, Math.floor((end - 1) / rowLength) + 1)
      let text = ''
      for (let n = firstRow; n <= lastRow; n += 1) text += rowText(n)
      text += suffix
      const base = (firstRow - 1) * rowLength
      return text.slice(from - base, end - base)
    },
  }
}

/** Number after a "next offset" label, if the answer has one. */
function labeledNext(text: string): number | undefined {
  const match = /(?:next[\s_-]*offset|nextOffset|следующ\S*\s+(?:offset|смещени\S*)|\bnext\b)\D{0,12}?(\d+)/i.exec(text)
  return match === null ? undefined : Number(match[1])
}

/**
 * One page: the chunk is the expected slice of the stream, no longer than the limit, and the answer says
 * where the next page starts. Returns that next offset.
 */
async function readPage(src: Source, id: string, offset: number, limit: number): Promise<number> {
  const end = Math.min(offset + limit, src.total)
  const text = await callTool('exec_status', { id, offset, limit })
  const expected = src.slice(offset, end)
  expect(text.includes(expected), `the page at ${offset} (limit ${limit}) is the expected slice of the output:\n${text.slice(0, 400)}`).toBe(true)
  if (end < src.total) {
    expect(
      text.includes(src.slice(offset, end + 3)),
      `the page at ${offset} is longer than the limit ${limit}`,
    ).toBe(false)
  }
  const firstRow = Math.floor(offset / src.rowLength) + 1
  const lastRow = Math.floor((Math.max(end, offset + 1) - 1) / src.rowLength) + 1
  const rowToken = new RegExp(`row-(\\d{${src.width}})(?!\\d)`, 'g')
  for (const match of text.matchAll(rowToken)) {
    const row = Number(match[1])
    expect(row, `row ${row} in the page at ${offset} (limit ${limit}) is outside of the requested range`).toBeGreaterThanOrEqual(firstRow)
    expect(row, `row ${row} in the page at ${offset} (limit ${limit}) is outside of the requested range`).toBeLessThanOrEqual(lastRow)
  }
  const rest = text.replace(expected, '')
  const labeled = labeledNext(rest)
  if (labeled !== undefined) {
    expect(labeled, `the next offset after the page at ${offset} (limit ${limit}):\n${rest.slice(0, 300)}`).toBe(end)
  } else {
    expect(
      new RegExp(`(?<!\\d)${end}(?!\\d)`).test(rest),
      `the answer names the next offset ${end} after the page at ${offset}:\n${rest.slice(0, 300)}`,
    ).toBe(true)
  }
  return end
}

// --- [c1] ------------------------------------------------------------------------------------------------------------

test('test_c1_exec_status_with_offset_and_limit_returns_a_page_and_the_next_offset_without_gaps_or_repeats', { timeout: 150_000 }, async () => {
  const src = makeSource(6, 300)
  const id = await startJob(src.command)
  await waitFinished(id)

  let offset = 0
  let pages = 0
  while (offset < src.total) {
    offset = await readPage(src, id, offset, 250)
    pages += 1
    expect(pages, 'the reading ends').toBeLessThan(40)
  }
  expect(pages, 'a 3300 character output is read in 14 pages of 250').toBe(Math.ceil(src.total / 250))

  // the end of the output: nothing more, the next offset stays at the end
  expect(await readPage(src, id, src.total, 250)).toBe(src.total)

  // a page from the middle does not depend on the earlier reading
  expect(await readPage(src, id, 1234, 77)).toBe(1234 + 77)
})

// --- [c2] ------------------------------------------------------------------------------------------------------------

test('test_c2_exec_status_without_offset_is_still_the_tail_the_status_and_the_exit_code', { timeout: 150_000 }, async () => {
  const small = await startJob('echo hello-c2; exit 3')
  const finished = await waitFinished(small)
  expect(finished).toContain('Статус: failed')
  expect(finished).toContain('exit code: 3')
  expect(finished).toContain('hello-c2')

  const big = makeSource(6, 3000)
  const id = await startJob(big.command)
  const answer = await waitFinished(id)
  expect(answer).toContain('Статус: completed')
  expect(answer, 'the tail holds the end of the output').toContain(big.slice(big.total - 40, big.total))
  expect(answer, 'the beginning of a 33000 character output is cut off').not.toContain('row-000001;')
  expect(answer.length, 'the tail is the last 12000 characters plus a short frame').toBeLessThan(13_000)
  expect(answer.length).toBeGreaterThan(11_000)

  const running = await startJob('echo early-c2; sleep 60')
  let seen = ''
  const from = Date.now()
  while (Date.now() - from < 20_000 && !seen.includes('early-c2')) {
    seen = await callTool('exec_status', { id: running })
    await sleep(150)
  }
  expect(seen).toContain('Статус: running')
  expect(seen).toContain('early-c2')
  await callTool('exec_stop', { id: running })
})

// --- [c3] ------------------------------------------------------------------------------------------------------------

/** Name of the property of exec_write that carries the text: the string property that is not the id. */
function writeTextProperty(): string {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec_write')
  expect(tool, 'the tool exec_write exists').toBeDefined()
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, { type?: unknown }> }
  const names = Object.entries(schema.properties ?? {})
    .filter(([name, spec]) => name !== 'id' && spec.type === 'string')
    .map(([name]) => name)
  expect(names.length, 'exec_write takes the id and a string to write').toBeGreaterThan(0)
  return names[0] as string
}

test('test_c3_exec_write_puts_a_line_into_the_stdin_of_a_live_job_and_refuses_a_finished_or_unknown_one', { timeout: 150_000 }, async () => {
  const id = await startJob('read x; echo got:$x')
  await sleep(500)
  const text = writeTextProperty()
  const written = await callTool('exec_write', { id, [text]: 'hello' })
  expect(written).not.toBe('')

  let status = ''
  const from = Date.now()
  while (Date.now() - from < 30_000 && !status.includes('got:hello')) {
    status = await callTool('exec_status', { id })
    await sleep(150)
  }
  expect(status, 'the job read the line from its stdin').toContain('got:hello')
  const finished = await waitFinished(id)
  expect(finished).toContain('Статус: completed')

  const afterEnd = await answerOrError('exec_write', { id, [text]: 'late' })
  expect(afterEnd.threw, `writing to a finished job is an error, got: ${afterEnd.text}`).toBe(true)

  const unknown = await answerOrError('exec_write', { id: 'no-such-job-c3', [text]: 'x' })
  expect(unknown.threw, `writing to an unknown job is an error, got: ${unknown.text}`).toBe(true)
})

// --- [c4] ------------------------------------------------------------------------------------------------------------

/** The part of the list that describes one job: the JSON object holding the id, or the lines up to the next job. */
function blockFor(text: string, id: string, ids: readonly string[]): string {
  const holder = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return undefined
    if (!Array.isArray(node)) {
      const record = node as Record<string, unknown>
      for (const [key, value] of Object.entries(record)) {
        if (key === id && value !== null && typeof value === 'object') return value
      }
      if (Object.values(record).some((value) => value === id)) return record
    }
    for (const value of Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)) {
      const found = holder(value)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const from = text.indexOf(open)
    const to = text.lastIndexOf(close)
    if (from < 0 || to <= from) continue
    try {
      const found = holder(JSON.parse(text.slice(from, to + 1)))
      if (found !== undefined) return JSON.stringify(found)
    } catch {
      // not JSON: the line reading below
    }
  }
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.includes(id))
  if (at < 0) return ''
  let end = lines.length
  for (let i = at + 1; i < lines.length; i += 1) {
    if (ids.some((other) => other !== id && (lines[i] as string).includes(other))) {
      end = i
      break
    }
  }
  return lines.slice(at, end).join('\n')
}

test('test_c4_exec_list_shows_every_background_job_with_command_status_exit_code_and_start_time', { timeout: 150_000 }, async () => {
  const live = await startJob('sleep 61')
  const done = await startJob('echo zq; exit 77')
  await waitFinished(done)

  const list = await callTool('exec_list', {})
  for (const id of started) expect(list, `the list names the job ${id}`).toContain(id)

  const liveBlock = blockFor(list, live, started).split(live).join('')
  expect(liveBlock, 'the running job is in the list').toContain('sleep 61')
  expect(liveBlock, 'the running job is shown as running').toMatch(/running|идёт|идет|выполня|активн|работает/i)
  expect(liveBlock, 'the running job is not shown as finished').not.toMatch(/completed|failed|killed|завершен/i)
  expect(liveBlock, 'the start time of the running job').toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\b1[5-9]\d{8,11}\b|назад|ago/)

  const doneBlock = blockFor(list, done, started).split(done).join('')
  expect(doneBlock, 'the finished job is in the list').toContain('echo zq')
  expect(doneBlock, 'the finished job is shown as finished').toMatch(/completed|failed|killed|завершен|finished|exited/i)
  expect(doneBlock, 'the finished job is not shown as running').not.toMatch(/running|идёт|идет|выполня|активн|работает/i)
  expect(doneBlock, 'the exit code of the finished job').toMatch(/(?<!\d)77(?!\d)/)
  expect(doneBlock, 'the start time of the finished job').toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\b1[5-9]\d{8,11}\b|назад|ago/)

  await callTool('exec_stop', { id: live })
})

// --- [c5] ------------------------------------------------------------------------------------------------------------

test('test_c5_one_mebibyte_of_output_is_read_in_full_through_offset', { timeout: 170_000 }, async () => {
  // 95325 rows of 11 characters and one letter: exactly 1 MiB
  const src = makeSource(6, 95_325, 'Z')
  expect(src.total).toBe(MIB)
  const id = await startJob(src.command)
  await waitFinished(id)

  let offset = 0
  let pages = 0
  while (offset < src.total) {
    offset = await readPage(src, id, offset, 10_000)
    pages += 1
    expect(pages, 'the reading ends').toBeLessThan(200)
  }
  expect(pages).toBe(Math.ceil(src.total / 10_000))
})

test('test_c5_overflow_drops_the_oldest_output_and_exec_status_says_from_which_offset_it_is_available', { timeout: 170_000 }, async () => {
  // 2,000,000 rows of 12 characters: 24,000,000 characters, far more than any ring buffer of a few MiB
  const src = makeSource(7, 2_000_000)
  const id = await startJob(src.command)
  await waitFinished(id)

  const first = await answerOrError('exec_status', { id, offset: 0, limit: 64 })
  const numbers = [
    ...new Set(
      [...first.text.split(id).join('').replace(/row-\d+;?/g, '').matchAll(/\d{4,}/g)]
        .map((match) => Number(match[0]))
        .filter((value) => value > 0 && value < src.total),
    ),
  ].sort((a, b) => a - b)

  let available: number | undefined
  for (const candidate of numbers) {
    const probe = await answerOrError('exec_status', { id, offset: candidate, limit: 64 })
    if (probe.text.includes(src.slice(candidate, candidate + 64))) {
      available = candidate
      break
    }
  }
  expect(
    available,
    `a read from offset 0 of an overflowed buffer names the offset from which the output is available:\n${first.text.slice(0, 500)}`,
  ).toBeDefined()
  const from = available as number
  expect(from, 'the oldest output is dropped').toBeGreaterThan(0)
  expect(from, 'the buffer keeps at least 1 MiB of the newest output').toBeLessThanOrEqual(src.total - MIB)

  const below = await answerOrError('exec_status', { id, offset: from - 1, limit: 64 })
  expect(below.text.includes(src.slice(from - 1, from + 63)), 'the dropped output is not served').toBe(false)

  // the newest output is read through to the end
  expect(await readPage(src, id, src.total - 100, 64)).toBe(src.total - 36)
  expect(await readPage(src, id, src.total - 36, 64)).toBe(src.total)
  expect(await readPage(src, id, from, 5000)).toBe(from + 5000)
})
