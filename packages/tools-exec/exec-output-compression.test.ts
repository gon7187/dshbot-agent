// Noise compression of the output the model gets from exec: ANSI sequences are cut, a line redrawn through
// "\r" keeps its last state, three or more identical lines in a row fold into one with a repeat note, and
// plain text stays byte for byte. exec_status of a background job cleans the page text the same way but
// keeps the byte offsets of the raw stream and never folds repeats. The whole-stream output of the owner's
// `!command` (runDirect, which reads the spill file of an overflowing stream) stays raw.
// The tests drive createExecTools directly against the real bwrap sandbox (same wiring as
// exec-spill-cleanup.test.ts and exec-status-chars.test.ts).

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const ESC = '\u001b'

let workspace = ''
let exec: ExecTools
const started: string[] = []

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-compress-'))
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

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

/** Body of the one untrusted frame of an answer, with the notice and its boundary lines removed. */
function frameBody(answer: string): string {
  const open = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>$/m.exec(answer)
  if (open === null) return answer
  const closing = `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${open[1]}">>>`
  const afterOpen = answer.indexOf('\n', open.index) + 1
  const noticeEnd = answer.indexOf('\n', afterOpen)
  const body = answer.slice(noticeEnd + 1, answer.lastIndexOf(closing))
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

/** The old answer without the frame around the command output. */
function unframed(answer: string): string {
  const open = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="/m.exec(answer)
  if (open === null) return answer
  return `${answer.slice(0, open.index)}${frameBody(answer)}`
}

/** The foreground answer of the model's exec for a command. */
function run(command: string): Promise<string> {
  return callTool('exec', { command, timeout_sec: 60 }).then(unframed)
}

/** Lines of the answer after the first "exit N" line. */
function bodyLines(answer: string): string[] {
  return answer.split('\n').slice(1)
}

async function startJob(command: string): Promise<string> {
  const answer = await callTool('exec', { command, background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1]
  expect(id, `a background start names the job id: ${answer}`).toBeDefined()
  started.push(id as string)
  return id as string
}

async function waitFinished(id: string): Promise<void> {
  const from = Date.now()
  let last = ''
  while (Date.now() - from < 60_000) {
    last = await callTool('exec_status', { id })
    if (/Статус:\s*(completed|failed|killed)/.test(last)) return
    await sleep(150)
  }
  throw new Error(`the job ${id} did not finish: ${last.slice(0, 300)}`)
}

// --- [c1] ANSI sequences are cut ---------------------------------------------------------------------------------

test('test_c1_ansi_color_cursor_and_osc_sequences_are_cut_from_the_exec_answer', { timeout: 120_000 }, async () => {
  const colored = await run(`printf '\\033[31mERROR\\033[0m'`)
  expect(colored, 'the colored word turns into plain text').toBe('exit 0\nERROR')

  const answer = await run(
    `printf '\\033[1;32mok\\033[0m done\\n\\033[2K\\033[1A\\033[10;5Hmoved\\n\\033]0;window title\\007title-set\\n` +
      `\\033]8;;http://example.test/x\\033\\\\link\\033]8;;\\033\\\\\\n'; printf '\\033[31mBAD\\033[0m\\n' >&2`,
  )
  expect(answer, 'no escape character is left').not.toContain(ESC)
  expect(answer, 'no bell is left').not.toContain('\u0007')
  expect(answer, 'no tail of a control sequence is left').not.toMatch(/\[\d[\d;]*[A-Za-z]/)
  expect(answer.startsWith('exit 0\n'), answer.slice(0, 80)).toBe(true)
  const lines = bodyLines(answer)
  expect(lines, 'the colored line').toContain('ok done')
  expect(lines, 'the text after cursor moves').toContain('moved')
  expect(lines, 'the text after an OSC title').toContain('title-set')
  expect(lines, 'the text of a hyperlink').toContain('link')
  expect(answer, 'the payload of the OSC title is gone').not.toContain('window title')
  expect(answer, 'the payload of the OSC hyperlink is gone').not.toContain('example.test')
  expect(answer).toContain('--- stderr ---\nBAD')
})

// --- [c2] a line redrawn through \r keeps its last state ---------------------------------------------------------

test('test_c2_a_progress_line_redrawn_through_carriage_return_keeps_only_the_last_state', { timeout: 120_000 }, async () => {
  const bar = await run(`printf '10%%\\r50%%\\r100%%\\n'`)
  expect(bar).toBe('exit 0\n100%\n')

  const answer = await run(
    `printf 'before\\nDownloading 10%%\\r\\033[KDownloading 50%%\\r\\033[KDownloading 100%%\\nafter\\n'; ` +
      `printf 'err 1/3\\rerr 2/3\\rerr 3/3\\n' >&2`,
  )
  expect(answer).not.toContain('\r')
  expect(answer).not.toContain(ESC)
  const lines = bodyLines(answer)
  expect(lines.slice(0, 3), 'the redrawn line sits between its neighbours in its last state').toEqual([
    'before',
    'Downloading 100%',
    'after',
  ])
  expect(answer).not.toContain('Downloading 10%')
  expect(answer).not.toContain('Downloading 50%')
  expect(answer, 'the stream of stderr is collapsed too').toContain('--- stderr ---\nerr 3/3')
  expect(answer).not.toContain('err 1/3')
  expect(answer).not.toContain('err 2/3')
})

// --- [c3] identical lines in a row fold into one -----------------------------------------------------------------

test('test_c3_three_or_more_identical_lines_in_a_row_fold_with_a_repeat_note_and_two_stay', { timeout: 120_000 }, async () => {
  const five = await run(`yes 'same line' | head -n 5`)
  expect(five.match(/same line/g)?.length, `five identical lines fold into one:\n${five}`).toBe(1)
  expect(five).toMatch(/\(повтор 5 раз\)/)

  const three = await run(`printf 'x\\nx\\nx\\n'`)
  expect(three.match(/^x/gm)?.length, `three identical lines fold into one:\n${three}`).toBe(1)
  expect(three).toMatch(/\(повтор 3 раз\)/)

  const two = await run(`printf 'dup\\ndup\\n'`)
  expect(two, 'two identical lines in a row stay as they are').toBe('exit 0\ndup\ndup\n')

  const mixed = await run(`printf 'a\\na\\na\\nb\\nb\\nc\\na\\nz\\nz\\nz\\nz\\n'`)
  const lines = bodyLines(mixed)
  expect(lines.filter((line) => line.startsWith('a')).length, 'the group of a and the single a after c are apart').toBe(2)
  expect(mixed).toMatch(/\(повтор 3 раз\)/)
  expect(mixed).toMatch(/\(повтор 4 раз\)/)
  expect(lines, 'a pair inside other lines stays').toContain('b')
  expect(lines.filter((line) => line === 'b').length).toBe(2)
  expect(lines.filter((line) => line.startsWith('z')).length).toBe(1)
  expect(mixed.indexOf('b'), 'the order of the lines is kept').toBeGreaterThan(mixed.indexOf('a'))
  expect(mixed.indexOf('c'), 'the order of the lines is kept').toBeGreaterThan(mixed.indexOf('b'))

  // lines equal only after the redraw and the colors are cut fold as well
  const noisy = await run(`for i in 1 2 3 4; do printf '\\033[32mtick\\033[0m\\n'; done`)
  expect(noisy.match(/tick/g)?.length).toBe(1)
  expect(noisy).toMatch(/\(повтор 4 раз\)/)
})

// --- [c4] plain output stays byte for byte -----------------------------------------------------------------------

test('test_c4_exit_line_stderr_separator_and_plain_text_stay_byte_for_byte', { timeout: 120_000 }, async () => {
  const withCode = await run(`echo out; echo err >&2; exit 3`)
  expect(withCode).toBe('exit 3\nout\n\n--- stderr ---\nerr\n')

  const plain = 'src/a.ts:12:5 - error TS2322: Type "string" is not assignable\n  indented\ttab  \n\nпуть /usr/bin v3.14.15 100%\n{"k": [1, 2]}\n'
  const text = await run(`printf '%s' '${plain}'`)
  expect(text).toBe(`exit 0\n${plain}`)

  const both = await run(`printf 'one\\ntwo\\none\\n'; printf 'warn: 1\\nwarn: 2\\n' >&2`)
  expect(both).toBe('exit 0\none\ntwo\none\n\n--- stderr ---\nwarn: 1\nwarn: 2\n')

  expect(await run('true')).toBe('exit 0\n(нет вывода)')
  expect(await run('exit 7')).toBe('exit 7\n(нет вывода)')
})

// --- [c5] exec_status: clean text, raw offsets, no folding -------------------------------------------------------

// The stream is printed by printf; each part below is a whole number of lines, so a page that ends at the
// end of a part cuts neither a control sequence nor a redrawn line.
const PARTS = [
  `${ESC}[31mERR${ESC}[0m Ж start\n`,
  '10%\r50%\r100%\n',
  'same\nsame\nsame\nsame\n',
  'end\n',
]
const RAW = PARTS.join('')
const RAW_COMMAND =
  `printf '\\033[31mERR\\033[0m Ж start\\n10%%\\r50%%\\r100%%\\nsame\\nsame\\nsame\\nsame\\nend\\n'`

function nextOf(answer: string): number {
  const next = /--- next offset: (\d+) ---/.exec(answer)?.[1]
  expect(next, `the answer names the next offset:\n${answer.slice(0, 300)}`).toBeDefined()
  return Number(next)
}

function startOf(answer: string): number {
  const start = /--- вывод: offset (\d+),/.exec(answer)?.[1]
  expect(start, `the answer names the start offset:\n${answer.slice(0, 300)}`).toBeDefined()
  return Number(start)
}

/** The text of a page between the "--- вывод" header and the "--- next offset" footer. */
function pageText(answer: string): string {
  const match = /--- вывод: offset \d+, [^\n]*---\n([\s\S]*)\n--- next offset: \d+ ---/.exec(answer)
  expect(match, `a page has a header and a footer:\n${answer.slice(0, 300)}`).not.toBeNull()
  return frameBody(match?.[1] ?? '')
}

test('test_c5_exec_status_cleans_page_text_keeps_raw_offsets_and_does_not_fold_repeats', { timeout: 150_000 }, async () => {
  const id = await startJob(RAW_COMMAND)
  await waitFinished(id)
  const total = Buffer.byteLength(RAW, 'utf8')
  expect(total, 'the raw stream has a multibyte character').toBeGreaterThan(Array.from(RAW).length)

  // the tail: clean text, repeats stay as they are
  const tail = await callTool('exec_status', { id })
  expect(tail).not.toContain(ESC)
  expect(tail).not.toContain('\r')
  expect(tail).toContain('ERR Ж start')
  expect(tail).toContain('100%')
  expect(tail).not.toContain('10%')
  expect(tail).not.toContain('50%')
  expect(tail.match(/^same$/gm)?.length, `the repeats stay in exec_status:\n${tail}`).toBe(4)
  expect(tail).not.toMatch(/повтор \d+ раз/)

  // the whole stream in one page: clean text, the offsets are those of the raw stream
  const whole = await callTool('exec_status', { id, offset: 0, limit: 200_000 })
  expect(startOf(whole)).toBe(0)
  expect(nextOf(whole), 'next counts the bytes of the raw stream').toBe(total)
  expect(whole).toContain(`из ${total} байт`)
  expect(pageText(whole).trimEnd()).toBe('ERR Ж start\n100%\nsame\nsame\nsame\nsame\nend')
  expect(whole).not.toMatch(/повтор \d+ раз/)

  // page by page, a page per part: no gaps, no repeats, offsets in raw bytes
  let offset = 0
  const pages: string[] = []
  for (const part of PARTS) {
    const answer = await callTool('exec_status', { id, offset, limit: Array.from(part).length })
    expect(startOf(answer), 'a page starts where the previous one ended').toBe(offset)
    const next = nextOf(answer)
    expect(next, `the page of ${JSON.stringify(part)} ends after its raw bytes`).toBe(offset + Buffer.byteLength(part, 'utf8'))
    expect(answer).not.toContain(ESC)
    expect(answer).not.toContain('\r')
    pages.push(pageText(answer).trimEnd())
    offset = next
  }
  expect(offset).toBe(total)
  expect(pages).toEqual(['ERR Ж start', '100%', 'same\nsame\nsame\nsame', 'end'])

  // the end of the stream: nothing more, next stays at the end
  const end = await callTool('exec_status', { id, offset: total, limit: 100 })
  expect(nextOf(end)).toBe(total)
  expect(pageText(end).trim()).toBe('')
})

// --- [c6] the overflow file and the `!command` output are not changed --------------------------------------------

test('test_c6_direct_owner_command_output_and_its_overflow_file_stay_raw', { timeout: 150_000 }, async () => {
  const approval = async (): Promise<'allow'> => 'allow'

  // small output: every byte is the raw one
  const small = `${ESC}[31mRED${ESC}[0m\n10%\r100%\nsame\nsame\nsame\nsame\n`
  const smallResult = await exec.runDirect(
    `printf '\\033[31mRED\\033[0m\\n10%%\\r100%%\\nsame\\nsame\\nsame\\nsame\\n'; printf 'E1\\rE2\\n' >&2`,
    { approval },
  )
  expect(smallResult.exitCode).toBe(0)
  expect(smallResult.output).toBe(`${small}\n--- stderr ---\nE1\rE2\n`)

  // output over the 64000 bytes of the buffer: the spill file holds the whole stream, and the owner gets it raw
  const rows = 20_000
  const head = `${ESC}[31mHEAD${ESC}[0m\n10%\r100%\n`
  const bigResult = await exec.runDirect(
    `printf '\\033[31mHEAD\\033[0m\\n10%%\\r100%%\\n'; yes aaaaaaaaaa | head -n ${rows}`,
    { approval },
  )
  expect(bigResult.exitCode).toBe(0)
  const expected = head + 'aaaaaaaaaa\n'.repeat(rows)
  expect(Buffer.byteLength(expected, 'utf8'), 'the output overflows the buffer').toBeGreaterThan(64_000)
  expect(bigResult.output.length, 'the whole output comes, nothing folded or cut').toBe(expected.length)
  expect(bigResult.output.startsWith(head), 'the head of the stream is raw').toBe(true)
  expect(bigResult.output).toBe(expected)
})
