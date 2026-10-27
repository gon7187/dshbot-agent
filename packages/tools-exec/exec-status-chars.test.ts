// The `limit` of exec_status counts characters; `offset` and the next offset stay byte positions of the
// buffer. A page is never longer than `limit` characters, never cuts a character, and with limit >= 1 the
// reading always moves forward, so stepping through multibyte output with a tiny limit collects the whole
// stream without gaps, repeats or U+FFFD. The output is made of letters that service words never contain
// (archaic cyrillic, greek, CJK), so the text of a page is found in the answer by those letters alone.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const POOL = ['ѣ', 'ѳ', 'ѵ', 'α', 'β', 'γ', '日', '本', '語']
const SOURCE = Array.from({ length: 31 }, (_, index) => POOL[(index * 4 + (index % 3)) % POOL.length]).join('')
const MARKED = /[ѣѳѵαβγ日本語]+/g

let workspace = ''
let exec: ExecTools

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-chars-'))
  exec = await createExecTools({ workspace, home: HOME })
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = exec.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

async function finishedJob(): Promise<string> {
  const answer = await callTool('exec', { command: `printf '%s' '${SOURCE}'`, background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1]
  expect(id, `a background start names the job id: ${answer}`).toBeDefined()
  const from = Date.now()
  let last = ''
  while (Date.now() - from < 60_000) {
    last = await callTool('exec_status', { id })
    if (/Статус:\s*(completed|failed|killed)/.test(last)) {
      expect(last, 'the whole output is there').toContain(SOURCE)
      return id as string
    }
    await sleep(150)
  }
  throw new Error(`the job ${String(id)} did not finish: ${last.slice(0, 300)}`)
}

/** Number after a "next offset" label, if the answer has one. */
function labeledNext(text: string): number | undefined {
  const match = /(?:next[\s_-]*offset|nextOffset|следующ\S*\s+(?:offset|смещени\S*))\D{0,12}?(\d+)/i.exec(text)
  return match === null ? undefined : Number(match[1])
}

/** The characters of the stream from the byte `offset` (a character boundary). */
function charsFrom(offset: number): string[] {
  return Array.from(Buffer.from(SOURCE, 'utf8').subarray(offset).toString('utf8'))
}

/** One page: returns the text of the page and the next offset named by the answer. */
async function readPage(id: string, offset: number, limit: number): Promise<{ text: string; next: number }> {
  const answer = await callTool('exec_status', { id, offset, limit })
  expect(answer, `the page at ${offset} (limit ${limit}) has no replacement character`).not.toContain('�')
  const text = (answer.match(MARKED) ?? []).join('')
  const remaining = charsFrom(offset)
  const expected = remaining.slice(0, limit).join('')
  expect(Array.from(text).length, `the page at ${offset} is not longer than the limit ${limit} characters`).toBeLessThanOrEqual(limit)
  expect(text, `the page at ${offset} (limit ${limit}) holds exactly the next ${limit} characters:\n${answer.slice(0, 300)}`).toBe(expected)

  const rest = answer.replace(text, '')
  const next = labeledNext(rest)
  const wanted = offset + Buffer.byteLength(expected, 'utf8')
  if (next !== undefined) {
    expect(next, `the next offset after the page at ${offset} (limit ${limit}) is a byte position`).toBe(wanted)
  } else {
    expect(new RegExp(`(?<!\\d)${wanted}(?!\\d)`).test(rest), `the answer names the next offset ${wanted}:\n${rest.slice(0, 300)}`).toBe(true)
  }
  return { text, next: wanted }
}

test('test_h1_exec_status_limit_counts_characters_and_stepping_with_a_tiny_limit_collects_everything', { timeout: 150_000 }, async () => {
  const id = await finishedJob()
  const total = Buffer.byteLength(SOURCE, 'utf8')
  expect(total, 'the output is multibyte').toBeGreaterThan(SOURCE.length * 2)

  for (const limit of [1, 3]) {
    let offset = 0
    let collected = ''
    let pages = 0
    while (offset < total) {
      const page = await readPage(id, offset, limit)
      expect(page.next, `the reading at ${offset} (limit ${limit}) moves forward`).toBeGreaterThan(offset)
      expect(Array.from(page.text).length, 'a page is not empty while output remains').toBeGreaterThan(0)
      collected += page.text
      offset = page.next
      pages += 1
      expect(pages, 'the reading ends').toBeLessThanOrEqual(SOURCE.length)
    }
    expect(collected, `limit ${limit} collects the whole output without gaps or repeats`).toBe(SOURCE)
    expect(pages).toBe(Math.ceil(Array.from(SOURCE).length / limit))
  }

  // the end of the output: nothing more, the next offset stays at the end
  const end = await callTool('exec_status', { id, offset: total, limit: 3 })
  expect((end.match(MARKED) ?? []).join('')).toBe('')
  expect(labeledNext(end) ?? total).toBe(total)

  // a limit above the rest returns the rest
  const tail = await readPage(id, Buffer.byteLength(Array.from(SOURCE).slice(0, 28).join(''), 'utf8'), 10)
  expect(tail.next).toBe(total)
})

test('test_h1_exec_status_describes_limit_in_characters', () => {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec_status')
  const properties = ((tool?.inputSchema ?? {}) as { properties?: Record<string, { description?: string }> }).properties ?? {}
  const description = properties.limit?.description ?? ''
  expect(description, 'the limit is described in characters').toMatch(/символ|char/i)
  expect(description, 'the limit is no longer described in bytes').not.toMatch(/\bbytes?\b|байт/i)
})
