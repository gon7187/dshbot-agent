// Output paths of `list` and `grep` must be unambiguous: `list` names the
// absolute directory it showed on its first line, and every `grep` row starts
// with the absolute path of its file. Both are checked by feeding the path
// back to `read`, the way the model does.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFsTools, GREP_TOOL_NAME, LIST_TOOL_NAME, READ_TOOL_NAME, type FsTool } from './src/index.js'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-tools-fs-abs-')))
  mkdirSync(join(home, 'workspace'), { recursive: true })
  mkdirSync(join(home, 'app', 'packages', 'tools-fs', 'src'), { recursive: true })
  mkdirSync(join(home, 'app', 'packages', 'runner'), { recursive: true })
  writeFileSync(join(home, 'app', 'packages', 'tools-fs', 'src', 'index.ts'), 'export const NEEDLE = 1\n', 'utf8')
  writeFileSync(join(home, 'app', 'packages', 'runner', 'main.ts'), 'const a = 1\nNEEDLE again\n', 'utf8')
  writeFileSync(join(home, 'app', 'packages', 'top.md'), 'NEEDLE at the top\n', 'utf8')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function tool(name: string): FsTool {
  const found = createFsTools({ home }).find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`the ${name} tool is missing`)
  return found
}

/** Body of the tool's untrusted frame, or the text itself when there is no frame. */
function frameBody(text: string): string {
  const open = /^<<<EXTERNAL_UNTRUSTED_CONTENT id="([^"]+)">>>$/m.exec(text)
  if (open === null) return text
  const closing = `<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${open[1]}">>>`
  const afterOpen = text.indexOf('\n', open.index) + 1
  const noticeEnd = text.indexOf('\n', afterOpen)
  const body = text.slice(noticeEnd + 1, text.lastIndexOf(closing))
  return body.endsWith('\n') ? body.slice(0, -1) : body
}

function answer(value: unknown): string {
  if (typeof value === 'string') return frameBody(value)
  throw new Error(`the tool answered a non-string value: ${JSON.stringify(value)}`)
}

/** Relative paths of the file entries of a `list` answer, directory marks stripped. */
function listedFiles(text: string): string[] {
  const files: string[] = []
  for (const line of text.split('\n').slice(1)) {
    const match = /^file\s+(\S.*?)\s+\d+ bytes$/.exec(line)
    if (match !== null) files.push(match[1] as string)
  }
  return files
}

async function readable(path: string): Promise<boolean> {
  try {
    await tool(READ_TOOL_NAME).execute({ path })
    return true
  } catch {
    return false
  }
}

test('test_listbase_recursive_list_of_a_nested_directory_starts_with_its_absolute_realpath', async () => {
  const base = join(home, 'app', 'packages')

  const text = answer(tool(LIST_TOOL_NAME).execute({ path: base, recursive: true }))
  const [first] = text.split('\n')

  expect(first, 'the first line names the listed directory').toBe(`Каталог: ${base}`)
  const files = listedFiles(text)
  expect(files, 'nested files are listed relative to the base').toEqual(
    expect.arrayContaining(['tools-fs/src/index.ts', 'runner/main.ts', 'top.md']),
  )
  for (const rel of files) {
    const joined = join(base, rel)
    expect(await readable(joined), `base + ${rel} is a path read can open`).toBe(true)
  }
})

test('test_listbase_relative_input_and_symlinked_input_report_the_realpath', async () => {
  const base = join(home, 'app', 'packages')
  symlinkSync(base, join(home, 'workspace', 'shortcut'))

  const viaLink = answer(tool(LIST_TOOL_NAME).execute({ path: 'shortcut' }))
  expect(viaLink.split('\n')[0], 'a symlinked input shows the real directory').toBe(`Каталог: ${base}`)

  const relative = answer(tool(LIST_TOOL_NAME).execute({ path: '../app/packages/tools-fs' }))
  const inner = join(base, 'tools-fs')
  expect(relative.split('\n')[0], 'a relative input shows the absolute directory').toBe(`Каталог: ${inner}`)
  const entries = relative.split('\n').slice(1).join('\n')
  expect(entries, 'entries stay relative to the base').toMatch(/^dir\s+src\/\s+\d+ bytes$/m)
  expect(await readable(join(inner, 'src', 'index.ts'))).toBe(true)
})

test('test_grepabs_every_directory_match_starts_with_an_absolute_readable_path', async () => {
  const text = answer(tool(GREP_TOOL_NAME).execute({ regex: 'NEEDLE', path: join(home, 'app', 'packages') }))
  const rows = text.split('\n').filter((line) => line !== '')

  expect(rows, 'three files match').toHaveLength(3)
  const seen = new Set<string>()
  for (const row of rows) {
    const match = /^(.+?):(\d+):(.*)$/.exec(row)
    expect(match, `row is path:line:text: ${row}`).not.toBeNull()
    const path = (match as RegExpExecArray)[1] as string
    expect(isAbsolute(path), `the path is absolute: ${path}`).toBe(true)
    expect(await readable(path), `read opens ${path}`).toBe(true)
    seen.add(path)
  }
  expect([...seen].sort()).toEqual(
    [
      join(home, 'app', 'packages', 'runner', 'main.ts'),
      join(home, 'app', 'packages', 'tools-fs', 'src', 'index.ts'),
      join(home, 'app', 'packages', 'top.md'),
    ].sort(),
  )
})

test('test_grepabs_single_file_and_relative_input_give_the_absolute_path', async () => {
  const file = join(home, 'app', 'packages', 'runner', 'main.ts')

  const single = answer(tool(GREP_TOOL_NAME).execute({ regex: 'NEEDLE', path: file }))
  expect(single).toBe(`${file}:2:NEEDLE again`)

  const relative = answer(tool(GREP_TOOL_NAME).execute({ regex: 'NEEDLE', path: '../app/packages/runner' }))
  expect(relative, 'a relative input still prints the absolute file path').toBe(`${file}:2:NEEDLE again`)
  expect(await readable(file)).toBe(true)
})
