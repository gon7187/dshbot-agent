// Containment must hold for every root the owner may declare: the filesystem
// root `/` itself (its descendants are inside it) and roots that overlap each
// other. Overlapping roots never reveal the hidden trees (keys of the owner and
// the private state of the bot) to read, list or grep.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  createFsTools,
  EDIT_TOOL_NAME,
  GREP_TOOL_NAME,
  hiddenFsPaths,
  LIST_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  type FsRoot,
  type FsTool,
} from './src/index.js'

const SSH_KEY = 'PRIVATE-KEY-MATERIAL-7f3a'
const BOT_ENV = 'DSHBOT_SECRET_ENV_91c2'
const BOT_STATE = 'BOT-PRIVATE-STATE-55de'

let scratch: string
let owner: string
let home: string
let workspace: string

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-tools-fs-roots-')))
  owner = join(scratch, 'owner')
  home = join(owner, '.local', 'share', 'dshbot')
  workspace = join(home, 'workspace')
  mkdirSync(join(owner, '.ssh'), { recursive: true })
  mkdirSync(join(owner, '.config', 'dshbot'), { recursive: true })
  mkdirSync(join(home, 'app'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(scratch, 'outside'), { recursive: true })
  writeFileSync(join(owner, '.ssh', 'id_ed25519'), `${SSH_KEY}\n`)
  writeFileSync(join(owner, '.config', 'dshbot', 'dshbot.env'), `${BOT_ENV}\n`)
  writeFileSync(join(owner, '.config', 'visible.txt'), 'NEEDLE in config\n')
  writeFileSync(join(home, 'state.json'), `${BOT_STATE}\n`)
  writeFileSync(join(scratch, 'outside', 'note.txt'), 'NEEDLE outside\n')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function toolsFor(extra: readonly FsRoot[]): (name: string) => FsTool {
  const tools = createFsTools({
    home,
    roots: [{ path: workspace }, { path: join(home, 'app'), readOnly: true }, ...extra],
    hidden: hiddenFsPaths(owner, home, [workspace, join(home, 'app')]),
  })
  return (name) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`the ${name} tool is missing`)
    return found
  }
}

async function refusal(call: () => unknown): Promise<string> {
  try {
    const value = await call()
    throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('test_filesystem_root_reads_lists_and_greps_its_descendants_and_refuses_writes', async () => {
  const tool = toolsFor([{ path: '/', readOnly: true }])
  const note = join(scratch, 'outside', 'note.txt')

  expect(String(await tool(READ_TOOL_NAME).execute({ path: note }))).toContain('NEEDLE outside')
  const listing = String(await tool(LIST_TOOL_NAME).execute({ path: join(scratch, 'outside') }))
  expect(listing).toContain(`Каталог: ${join(scratch, 'outside')}`)
  expect(listing).toMatch(/file\s+note\.txt\s+\d+ bytes/)
  const found = String(await tool(GREP_TOOL_NAME).execute({ regex: 'NEEDLE', path: join(scratch, 'outside') }))
  expect(found).toContain(`${note}:1:`)

  expect(await refusal(() => tool(WRITE_TOOL_NAME).execute({ path: note, content: 'x' }))).toMatch(/read-only/)
  expect(await refusal(() => tool(WRITE_TOOL_NAME).execute({ path: join(scratch, 'outside', 'new.txt'), content: 'x' }))).toMatch(
    /read-only/,
  )
  await tool(READ_TOOL_NAME).execute({ path: note })
  expect(
    await refusal(() => tool(EDIT_TOOL_NAME).execute({ path: note, old_string: 'NEEDLE', new_string: 'CHANGED' })),
  ).toMatch(/read-only/)
  expect(readFileSync(note, 'utf8')).toBe('NEEDLE outside\n')
  expect(existsSync(join(scratch, 'outside', 'new.txt'))).toBe(false)

  // The workspace keeps its own permission inside the read-only `/`.
  expect(String(await tool(WRITE_TOOL_NAME).execute({ path: join(workspace, 'w.txt'), content: 'ok' }))).toContain('Wrote')
  // Hidden trees stay hidden under `/` too.
  expect(await refusal(() => tool(READ_TOOL_NAME).execute({ path: join(owner, '.ssh', 'id_ed25519') }))).not.toContain(SSH_KEY)
})

test('test_overlapping_roots_keep_the_hidden_trees_out_of_read_list_and_grep', async () => {
  const tool = toolsFor([
    { path: owner, readOnly: true },
    { path: join(owner, '.config'), readOnly: true },
    { path: join(owner, '.ssh'), readOnly: true },
    { path: home, readOnly: true },
  ])

  for (const secret of [
    join(owner, '.ssh', 'id_ed25519'),
    join(owner, '.config', 'dshbot', 'dshbot.env'),
    join(home, 'state.json'),
  ]) {
    const message = await refusal(() => tool(READ_TOOL_NAME).execute({ path: secret }))
    for (const value of [SSH_KEY, BOT_ENV, BOT_STATE]) expect(message).not.toContain(value)
    const grepAnswer = await (async () => {
      try {
        return String(await tool(GREP_TOOL_NAME).execute({ regex: '.', path: secret }))
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()
    for (const value of [SSH_KEY, BOT_ENV, BOT_STATE]) expect(grepAnswer).not.toContain(value)
  }

  for (const base of [owner, join(owner, '.config')]) {
    const listing = String(await tool(LIST_TOOL_NAME).execute({ path: base, recursive: true }))
    for (const name of ['id_ed25519', 'dshbot.env', 'state.json']) expect(listing).not.toContain(name)
    const grepAnswer = String(await tool(GREP_TOOL_NAME).execute({ regex: '.', path: base }))
    for (const value of [SSH_KEY, BOT_ENV, BOT_STATE]) expect(grepAnswer).not.toContain(value)
  }
  expect(String(await tool(GREP_TOOL_NAME).execute({ regex: 'NEEDLE', path: join(owner, '.config') }))).toContain(
    'NEEDLE in config',
  )
})
