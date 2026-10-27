// Snapshots before a write of the bot: the write and edit tools keep the previous content of an existing
// file under DSHBOT_HOME/snapshots (with the path, the time and the tool), cap the snapshots by count and
// by total size, and say in their answer when a file is too big to be kept. The format inside the
// snapshots directory is the implementation's own: the tests look for the saved content and the metadata
// anywhere in the files and file names of that directory.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createFsTools, EDIT_TOOL_NAME, READ_TOOL_NAME, WRITE_TOOL_NAME, type FsTool } from './src/index.js'

const MIB = 1024 * 1024

let scratch: string
let home: string
let workspace: string

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-tools-fs-snapshots-')))
  home = join(scratch, 'dshbot')
  workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function toolsOf(): (name: string) => FsTool {
  const tools = createFsTools({ home, roots: [{ path: workspace }] })
  return (name) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`the ${name} tool is missing`)
    return found
  }
}

/** Every file below the snapshots directory of DSHBOT_HOME. */
function snapshotFiles(): Array<{ rel: string; data: Buffer }> {
  const root = join(home, 'snapshots')
  const found: Array<{ rel: string; data: Buffer }> = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) visit(join(directory, entry.name), rel)
      else if (entry.isFile()) found.push({ rel, data: readFileSync(join(directory, entry.name)) })
    }
  }
  if (existsSync(root)) visit(root, '')
  return found
}

/** File names and texts of the snapshots directory in one string, for the metadata checks. */
function haystack(): string {
  return snapshotFiles()
    .map((file) => `${file.rel}\n${file.data.toString('utf8')}`)
    .join('\n')
}

/** Some snapshot file holds the whole `content`, as it is or as base64. */
function holdsContent(content: string): boolean {
  const encoded = Buffer.from(content).toString('base64')
  return snapshotFiles().some((file) => {
    const text = file.data.toString('utf8')
    return text.includes(content) || text.includes(encoded)
  })
}

function snapshotBytes(): number {
  return snapshotFiles().reduce((sum, file) => sum + file.data.length, 0)
}

const TIME_MARK = /\d{4}-\d{2}-\d{2}|\b20\d{2}[01]\d[0-3]\d\b|\b1[6-9]\d{8}(?:\d{3})?\b/

function expectMetadata(path: string, toolName: string): void {
  const text = haystack()
  expect(text, 'the snapshot carries the path of the file').toContain(path)
  expect(text, 'the snapshot carries the name of the tool').toContain(toolName)
  expect(text, 'the snapshot carries the time').toMatch(TIME_MARK)
}

test('test_c1_overwrite_by_write_keeps_the_previous_content_with_path_time_and_tool', async () => {
  const file = join(workspace, 'doc-alpha.txt')
  writeFileSync(file, 'OLD-CONTENT-ALPHA-7731\nsecond line\n')
  const tool = toolsOf()

  await tool(WRITE_TOOL_NAME).execute({ path: file, content: 'BRAND-NEW-TEXT-ALPHA' })

  expect(readFileSync(file, 'utf8')).toBe('BRAND-NEW-TEXT-ALPHA')
  expect(holdsContent('OLD-CONTENT-ALPHA-7731\nsecond line\n'), 'the previous content is saved whole').toBe(true)
  expect(haystack(), 'the snapshot is the version before the write').not.toContain('BRAND-NEW-TEXT-ALPHA')
  expectMetadata(file, WRITE_TOOL_NAME)
})

test('test_c1_edit_of_an_existing_file_keeps_the_previous_content_with_path_time_and_tool', async () => {
  const file = join(workspace, 'doc-beta.txt')
  writeFileSync(file, 'head\nOLD-BETA-5521 tail\nend\n')
  const tool = toolsOf()

  await tool(READ_TOOL_NAME).execute({ path: file })
  await tool(EDIT_TOOL_NAME).execute({ path: file, old_string: 'OLD-BETA-5521', new_string: 'FRESH-BETA' })

  expect(readFileSync(file, 'utf8')).toBe('head\nFRESH-BETA tail\nend\n')
  expect(holdsContent('head\nOLD-BETA-5521 tail\nend\n'), 'the file before the edit is saved whole').toBe(true)
  expectMetadata(file, EDIT_TOOL_NAME)
})

test('test_c1_append_by_write_keeps_the_previous_content_with_path_time_and_tool', async () => {
  const file = join(workspace, 'doc-gamma.txt')
  writeFileSync(file, 'OLD-GAMMA-9913\n')
  const tool = toolsOf()

  await tool(WRITE_TOOL_NAME).execute({ path: file, content: 'APPENDED-GAMMA\n', append: true })

  expect(readFileSync(file, 'utf8')).toBe('OLD-GAMMA-9913\nAPPENDED-GAMMA\n')
  expect(holdsContent('OLD-GAMMA-9913\n'), 'the file before the append is saved whole').toBe(true)
  expect(haystack(), 'the snapshot is the version before the append').not.toContain('APPENDED-GAMMA')
  expectMetadata(file, WRITE_TOOL_NAME)
})

test('test_c5_file_over_5_mib_is_not_snapshotted_and_the_tool_answer_says_so', async () => {
  const tool = toolsOf()
  const big = join(workspace, 'big-write.txt')
  writeFileSync(big, `BIG-WRITE-MARKER\n${'y'.repeat(5 * MIB + 16)}`)

  const written = String(await tool(WRITE_TOOL_NAME).execute({ path: big, content: 'small now' }))
  expect(written).toContain('снимок не сделан: файл больше 5 МБ')
  expect(readFileSync(big, 'utf8'), 'the write itself still happens').toBe('small now')
  expect(snapshotBytes(), 'nothing of the big file is kept').toBeLessThan(MIB)

  const bigEdit = join(workspace, 'big-edit.txt')
  writeFileSync(bigEdit, `UNIQUE-EDIT-TOKEN\n${'z'.repeat(5 * MIB + 16)}`)
  await tool(READ_TOOL_NAME).execute({ path: bigEdit, limit: 1 })
  const edited = String(
    await tool(EDIT_TOOL_NAME).execute({ path: bigEdit, old_string: 'UNIQUE-EDIT-TOKEN', new_string: 'CHANGED-TOKEN' }),
  )
  expect(edited).toContain('снимок не сделан: файл больше 5 МБ')
  expect(readFileSync(bigEdit, 'utf8').startsWith('CHANGED-TOKEN\n'), 'the edit itself still happens').toBe(true)
  expect(snapshotBytes(), 'nothing of the big file is kept').toBeLessThan(MIB)

  const append = join(workspace, 'big-append.txt')
  writeFileSync(append, 'q'.repeat(5 * MIB + 16))
  const appended = String(await tool(WRITE_TOOL_NAME).execute({ path: append, content: 'tail', append: true }))
  expect(appended).toContain('снимок не сделан: файл больше 5 МБ')
  expect(readFileSync(append, 'utf8').endsWith('tail'), 'the append itself still happens').toBe(true)
})

test('test_c5_file_of_exactly_5_mib_is_snapshotted_without_a_warning', async () => {
  const tool = toolsOf()
  const file = join(workspace, 'edge.txt')
  writeFileSync(file, `EDGE-MARKER\n${'e'.repeat(5 * MIB - 12)}`)
  expect(statSync(file).size).toBe(5 * MIB)

  const answer = String(await tool(WRITE_TOOL_NAME).execute({ path: file, content: 'next' }))

  expect(answer).not.toContain('снимок не сделан')
  expect(snapshotBytes(), 'the file of the limit size is kept').toBeGreaterThanOrEqual(5 * MIB)
})

test('test_c5_no_more_than_50_snapshots_are_kept_and_the_oldest_go_first', async () => {
  const tool = toolsOf()
  const file = join(workspace, 'counter.txt')
  const versions = 55
  writeFileSync(file, 'v-0-MARK')
  for (let i = 1; i <= versions; i += 1) {
    await tool(WRITE_TOOL_NAME).execute({ path: file, content: `v-${i}-MARK` })
  }

  // the snapshots hold v-0 .. v-54; the last version v-55 is the live file
  const kept: number[] = []
  for (let i = 0; i < versions; i += 1) if (holdsContent(`v-${i}-MARK`)) kept.push(i)
  expect(kept.length, `kept versions: ${kept.join(',')}`).toBeLessThanOrEqual(50)
  expect(kept.length, 'old snapshots are dropped, not all of them').toBeGreaterThanOrEqual(40)
  expect(kept, 'the newest snapshot stays').toContain(versions - 1)
  expect(kept, 'the oldest snapshot is gone').not.toContain(0)
  expect(kept, 'the second oldest is gone').not.toContain(1)
})

test('test_c5_snapshots_together_stay_within_100_mib_and_the_oldest_go_first', async () => {
  const tool = toolsOf()
  const file = join(workspace, 'heavy.txt')
  const body = 'h'.repeat(4 * MIB - 16)
  const content = (i: number): string => `VER-${String(i).padStart(2, '0')}-${body}`
  const versions = 32
  writeFileSync(file, content(0))
  for (let i = 1; i <= versions; i += 1) {
    await tool(WRITE_TOOL_NAME).execute({ path: file, content: content(i) })
  }

  const total = snapshotBytes()
  expect(total, 'the snapshots together stay within 100 MiB').toBeLessThanOrEqual(100 * MIB)
  expect(total, 'old snapshots are dropped, not all of them').toBeGreaterThanOrEqual(50 * MIB)
  const heads = snapshotFiles().map((snapshot) => snapshot.data.toString('latin1'))
  const has = (i: number): boolean => heads.some((text) => text.includes(`VER-${String(i).padStart(2, '0')}-`))
  expect(has(versions - 1), 'the newest snapshot stays').toBe(true)
  expect(has(0), 'the oldest snapshot is gone').toBe(false)
})
