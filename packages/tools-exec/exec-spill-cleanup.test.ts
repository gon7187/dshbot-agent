// Spill files of the output buffer: a command whose stdout and stderr overflow the buffer makes the harness
// write each stream whole into a spill file under the private `dsh-subprocess-*` directory of the process.
// The model's foreground exec and the background jobs only read the tail or the ring, so once the answer is
// given the files of the command must be gone, while the answer itself and `exec_status` stay as they are.
// The tests drive createExecTools directly against the real bwrap sandbox (same wiring as
// exec-background-output.test.ts); the files of this process are told apart by the pid in their name.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const ROWS = 30_000
// `out-<n>` rows are about 240 KB per stream, far over the 64000 bytes the buffer keeps in memory.
const OUT_ROWS = `seq -f 'out-%g' 1 ${ROWS}`
const ERR_ROWS = `seq -f 'err-%g' 1 ${ROWS} >&2`
// Rows of one repeated letter per stream: the interleaving of the two streams in the ring does not matter
// when only the number of letters is counted.
const ROW_LENGTH = 11
// A background job keeps a 4 MiB ring, so its streams have to overflow that: 480000 rows are 5.28 MB each.
const BG_ROWS = 480_000
const RING_BYTES = 4 * 1024 * 1024
const A_ROWS = `yes aaaaaaaaaa | head -n ${BG_ROWS}`
const B_ROWS = `yes bbbbbbbbbb | head -n ${BG_ROWS} >&2`

let workspace = ''
let exec: ExecTools
const started: string[] = []

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-spill-'))
  exec = await createExecTools({ workspace, home: HOME })
})

afterAll(async () => {
  if (exec !== undefined) {
    for (const id of started) {
      try {
        await callTool('exec_stop', { id })
      } catch {
        // already gone
      }
    }
    await exec.stop()
  }
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

type Args = Record<string, unknown>

async function callTool(name: string, args: Args, signal: AbortSignal = new AbortController().signal): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal }))
}

/** Spill files this process left in the private spill directories of the harness. */
function spillFiles(): string[] {
  const found: string[] = []
  const base = tmpdir()
  let entries: string[] = []
  try {
    entries = readdirSync(base)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.startsWith('dsh-subprocess-')) continue
    const dir = join(base, entry)
    try {
      for (const file of readdirSync(dir)) {
        if (file.startsWith(`dsh-subprocess-${process.pid}-`)) found.push(join(dir, file))
      }
    } catch {
      // not a directory, or gone meanwhile
    }
  }
  return found.sort()
}

/** Files that appeared since `before` and are still on disk. */
function leftovers(before: string[]): string[] {
  return spillFiles().filter((file) => !before.includes(file) && existsSync(file))
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

/** Body of the one untrusted frame, without its notice and boundary lines. */
function frameBody(text: string): string {
  const open = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>$/m.exec(text)
  if (open === null) return text
  const closing = `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${open[1]}">>>`
  const afterOpen = text.indexOf('\n', open.index) + 1
  const noticeEnd = text.indexOf('\n', afterOpen)
  const body = text.slice(noticeEnd + 1, text.lastIndexOf(closing))
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

/** Read the ring page by page with offset and limit, from the start of what it still holds. */
async function readRing(id: string): Promise<{ text: string; total: number; first: number; lossLabel: boolean }> {
  let offset = 0
  let text = ''
  let total = -1
  let first = -1
  let lossLabel = false
  for (let pages = 0; pages < 200; pages += 1) {
    const answer = await callTool('exec_status', { id, offset, limit: 200_000 })
    const header = /--- вывод: offset (\d+), (\d+) из (\d+) байт ---\n/.exec(answer)
    expect(header, `a page answer has the header: ${answer.slice(0, 200)}`).not.toBeNull()
    if (header === null) break
    if (first < 0) first = Number(header[1])
    if (answer.includes('начало вывода потеряно')) lossLabel = true
    total = Number(header[3])
    const bodyStart = (header.index ?? 0) + header[0].length
    const bodyEnd = answer.lastIndexOf('\n--- next offset:')
    const next = Number(/--- next offset: (\d+) ---/.exec(answer)?.[1])
    text += frameBody(answer.slice(bodyStart, bodyEnd))
    if (!(next > offset)) break
    offset = next
    if (offset >= total) break
  }
  return { text, total, first, lossLabel }
}

function count(text: string, letter: string): number {
  return text.split(letter).length - 1
}

/** The ring of a finished job holds the last 4 MiB of both streams, so the output is what it was before. */
function expectRetainedRing(ring: { text: string; total: number; first: number; lossLabel: boolean }): void {
  const printed = BG_ROWS * ROW_LENGTH * 2
  expect(ring.total, 'the job printed both streams whole').toBe(printed)
  expect(ring.first, 'the ring keeps exactly the last 4 MiB').toBe(printed - RING_BYTES)
  expect(ring.lossLabel, 'the answer says the head of the output was dropped').toBe(true)
  expect(Buffer.byteLength(ring.text, 'utf8'), 'the pages cover the whole ring').toBe(RING_BYTES)
  const letters = count(ring.text, 'a') + count(ring.text, 'b')
  const newlines = count(ring.text, '\n')
  expect(letters + newlines, 'nothing but the rows of the two streams').toBe(RING_BYTES)
  expect(newlines, 'a row is 11 bytes with its newline').toBeGreaterThan(RING_BYTES / ROW_LENGTH - 4)
  expect(newlines).toBeLessThan(RING_BYTES / ROW_LENGTH + 4)
}

async function waitRingTotal(id: string, total: number): Promise<void> {
  const from = Date.now()
  let seen = ''
  while (Date.now() - from < 60_000) {
    seen = await callTool('exec_status', { id, offset: 0, limit: 1 })
    const reported = Number(/из (\d+) байт/.exec(seen)?.[1] ?? '0')
    if (reported >= total) return
    await sleep(150)
  }
  throw new Error(`the job ${id} did not print ${total} bytes: ${seen.slice(0, 300)}`)
}

/** The spill files of a finished command vanish; a short wait covers a cleanup done right after the exit. */
async function expectNoLeftovers(before: string[], what: string): Promise<void> {
  const from = Date.now()
  while (Date.now() - from < 5000 && leftovers(before).length > 0) await sleep(100)
  expect(leftovers(before), `${what}: no spill file of the command stays on disk`).toEqual([])
}

// --- [c1] ------------------------------------------------------------------------------------------------------------

test('test_c1_foreground_exec_with_overflowing_output_leaves_no_spill_file_and_answers_as_before', { timeout: 120_000 }, async () => {
  const before = spillFiles()
  const answer = await callTool('exec', { command: `${OUT_ROWS}; ${ERR_ROWS}`, timeout_sec: 60 })

  // the answer is the tail of each stream, as it was
  expect(answer.startsWith('exit 0\n'), answer.slice(0, 80)).toBe(true)
  expect(answer).toContain(`out-${ROWS}\n`)
  expect(answer).toContain('--- stderr ---\n')
  expect(answer).toContain(`err-${ROWS}`)
  expect(answer, 'the head of the overflowing stream is not in the answer').not.toContain('out-1\n')
  expect(answer).not.toContain('err-1\n')

  // the same again: nothing piles up from call to call
  await callTool('exec', { command: `${OUT_ROWS}; ${ERR_ROWS}`, timeout_sec: 60 })
  expect(leftovers(before), 'no spill file stays on disk after the answer').toEqual([])
})

test('test_c1_foreground_exec_that_times_out_leaves_no_spill_file_and_reports_the_timeout', { timeout: 120_000 }, async () => {
  const before = spillFiles()
  const answer = await callTool('exec', { command: `${OUT_ROWS}; ${ERR_ROWS}; sleep 60`, timeout_sec: 3 })

  expect(answer.startsWith('Таймаут: '), answer.slice(0, 80)).toBe(true)
  expect(answer).toContain(`out-${ROWS}\n`)
  expect(answer).toContain('--- stderr ---\n')
  expect(answer).toContain(`err-${ROWS}`)
  expect(leftovers(before), 'no spill file stays on disk after the timeout').toEqual([])
})

test('test_c1_foreground_exec_that_is_interrupted_leaves_no_spill_file', { timeout: 120_000 }, async () => {
  const before = spillFiles()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 2500)
  // the command ends by itself soon after the abort, so the answer comes whether or not the signal reaches it
  const answer = await callTool(
    'exec',
    { command: `${OUT_ROWS}; ${ERR_ROWS}; sleep 6`, timeout_sec: 60 },
    controller.signal,
  )

  expect(answer).toContain(`out-${ROWS}`)
  expect(answer).toContain(`err-${ROWS}`)
  expect(leftovers(before), 'no spill file stays on disk after the interrupted command').toEqual([])
})

// --- [c2] ------------------------------------------------------------------------------------------------------------

test('test_c2_background_job_with_overflowing_output_leaves_no_spill_file_after_it_finishes', { timeout: 150_000 }, async () => {
  const before = spillFiles()
  const id = await startJob(`${A_ROWS}; ${B_ROWS}`)
  const finished = await waitFinished(id)
  expect(finished).toContain('Статус: completed')
  expect(finished).toContain('exit code: 0')

  await expectNoLeftovers(before, 'finished job')

  // the output is the same as it was: the ring has both streams whole, page by page
  expectRetainedRing(await readRing(id))
  const tail = await callTool('exec_status', { id })
  expect(tail).toContain('--- вывод (хвост) ---')
  expect(tail).toContain('bbbbbbbbbb')
  expect(tail, 'the tail of a 10 MB output is cut').toContain('показан хвост')

  // a page from the middle does not depend on the cleanup
  const from = BG_ROWS * ROW_LENGTH * 2 - 1000
  const middle = await callTool('exec_status', { id, offset: from, limit: 50 })
  expect(middle).toContain(`--- вывод: offset ${from}, 50 из ${BG_ROWS * ROW_LENGTH * 2} байт ---`)
  expect(middle).toContain(`--- next offset: ${from + 50} ---`)
})

test('test_c2_background_job_stopped_by_exec_stop_leaves_no_spill_file', { timeout: 150_000 }, async () => {
  const before = spillFiles()
  const id = await startJob(`${A_ROWS}; ${B_ROWS}; sleep 120`)
  await waitRingTotal(id, BG_ROWS * ROW_LENGTH * 2)

  const stopped = await callTool('exec_stop', { id })
  expect(stopped).toContain(id)
  const finished = await waitFinished(id)
  expect(finished).toContain('Статус: killed')

  await expectNoLeftovers(before, 'stopped job')

  // what the job printed before the stop is still readable
  expectRetainedRing(await readRing(id))
})
