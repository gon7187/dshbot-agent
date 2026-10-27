// Unit checks of the overview tools that are easier to state on a temporary
// root than through the daemon: the 200-match cap of `grep` must apply to a
// single-file path exactly as it does to a directory walk.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFsTools, GREP_TOOL_NAME, type FsTool } from './src/index.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-tools-fs-'))
  mkdirSync(join(home, 'workspace'), { recursive: true })
  mkdirSync(join(home, 'app'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function grepTool(): FsTool {
  const tool = createFsTools({ home }).find((candidate) => candidate.name === GREP_TOOL_NAME)
  if (tool === undefined) throw new Error('the grep tool is missing')
  return tool
}

function answer(value: unknown): string {
  if (typeof value === 'string') return value
  throw new Error(`the tool answered a non-string value: ${JSON.stringify(value)}`)
}

function writeRows(name: string, count: number): string {
  const file = join(home, 'workspace', name)
  const lines = Array.from({ length: count }, (_, index) => `HIT row ${index + 1}`)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

test('test_grep_caps_a_single_file_at_200_matches_and_marks_the_cut', () => {
  const file = writeRows('many.txt', 250)

  const text = answer(grepTool().execute({ regex: 'HIT', path: file }))
  const shown = text.split('\n').filter((line) => line.startsWith(`${file}:`))

  expect(shown, 'only the first 200 of 250 matches are returned').toHaveLength(200)
  expect(shown[0]).toBe(`${file}:1:HIT row 1`)
  expect(shown[199]).toBe(`${file}:200:HIT row 200`)
  expect(text, 'the 201st match is not returned').not.toContain(`${file}:201:`)
  expect(text, 'the answer says it was cut').toMatch(/\[truncated: showing the first 200 matches\]/)
})

test('test_grep_does_not_mark_a_single_file_with_exactly_200_matches', () => {
  const file = writeRows('exact.txt', 200)

  const text = answer(grepTool().execute({ regex: 'HIT', path: file }))
  const shown = text.split('\n').filter((line) => line.startsWith(`${file}:`))

  expect(shown, 'all 200 matches fit').toHaveLength(200)
  expect(text, 'nothing was omitted, so no truncation mark').not.toMatch(/trunc/i)
})
