// The owner may declare their whole HOME as a root. The usual places of credentials inside it (cloud keys, git
// and package manager tokens, CLI agent accounts, keyrings, browser profiles with cookies) stay hidden from
// read, grep and the writers, while the rest of ~/.config and HOME stays visible.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  createFsTools,
  EDIT_TOOL_NAME,
  GREP_TOOL_NAME,
  hiddenFsPaths,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
  type FsTool,
} from './src/index.js'

const CREDENTIAL_FILES = [
  '.aws/credentials',
  '.azure/accessTokens.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  '.kube/config',
  '.claude/.credentials.json',
  '.claude.json',
  '.codex/auth.json',
  '.config/gh/hosts.yml',
  '.config/typesafe/key',
  '.config/gcloud/credentials.db',
  '.local/share/keyrings/login.keyring',
  '.password-store/item.gpg',
  '.mozilla/firefox/profile/cookies.sqlite',
  '.config/google-chrome/Default/Cookies',
  '.config/chromium/Default/Cookies',
]

const VISIBLE_FILES = ['.config/visible.txt', 'notes.txt', '.config/someapp/settings.json', '.local/share/other/data.txt']

const marker = (index: number): string => `CREDENTIAL-MARKER-${String(index).padStart(2, '0')}-x9q`
const visibleMarker = (index: number): string => `VISIBLE-MARKER-${String(index).padStart(2, '0')}-x9q`

let scratch: string
let owner: string
let dshbotHome: string
let workspace: string

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-fs-credentials-')))
  owner = join(scratch, 'owner')
  dshbotHome = join(owner, '.local', 'share', 'dshbot')
  workspace = join(dshbotHome, 'workspace')
  mkdirSync(join(dshbotHome, 'app'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  CREDENTIAL_FILES.forEach((relative, index) => {
    mkdirSync(dirname(join(owner, relative)), { recursive: true })
    writeFileSync(join(owner, relative), `${marker(index)}\n`)
  })
  VISIBLE_FILES.forEach((relative, index) => {
    mkdirSync(dirname(join(owner, relative)), { recursive: true })
    writeFileSync(join(owner, relative), `${visibleMarker(index)}\n`)
  })
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function toolsFor(readOnly: boolean): (name: string) => FsTool {
  const tools = createFsTools({
    home: dshbotHome,
    roots: [
      { path: workspace },
      { path: join(dshbotHome, 'app'), readOnly: true },
      { path: owner, readOnly },
    ],
    hidden: hiddenFsPaths(owner, dshbotHome, [workspace, join(dshbotHome, 'app')]),
  })
  return (name) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`the ${name} tool is missing`)
    return found
  }
}

/** What the call returned or the text of its refusal. */
async function outcome(call: () => unknown): Promise<string> {
  try {
    return String(await call())
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

test('test_c1_home_root_hides_credential_files_from_read_and_grep', async () => {
  const tool = toolsFor(true)
  for (const [index, relative] of CREDENTIAL_FILES.entries()) {
    const path = join(owner, relative)
    const read = await outcome(() => tool(READ_TOOL_NAME).execute({ path }))
    expect(read, `read ${relative}`).not.toContain(marker(index))
    const grep = await outcome(() => tool(GREP_TOOL_NAME).execute({ regex: 'MARKER', path }))
    expect(grep, `grep ${relative}`).not.toContain(marker(index))
  }

  // A sweep over the whole HOME finds the visible files and none of the credentials.
  const sweep = await outcome(() => tool(GREP_TOOL_NAME).execute({ regex: 'MARKER', path: owner }))
  CREDENTIAL_FILES.forEach((relative, index) => expect(sweep, `grep sweep ${relative}`).not.toContain(marker(index)))
  expect(sweep).toContain(visibleMarker(0))
})

test('test_c1_home_root_refuses_writes_to_credential_files', async () => {
  for (const readOnly of [true, false]) {
    const tool = toolsFor(readOnly)
    for (const [index, relative] of CREDENTIAL_FILES.entries()) {
      const path = join(owner, relative)
      await outcome(() => tool(READ_TOOL_NAME).execute({ path }))
      await outcome(() => tool(WRITE_TOOL_NAME).execute({ path, content: 'OVERWRITTEN\n' }))
      expect(readFileSync(path, 'utf8'), `write ${relative}, readOnly=${readOnly}`).toBe(`${marker(index)}\n`)
      await outcome(() => tool(WRITE_TOOL_NAME).execute({ path, content: 'APPENDED\n', append: true }))
      expect(readFileSync(path, 'utf8'), `append ${relative}, readOnly=${readOnly}`).toBe(`${marker(index)}\n`)
      await outcome(() =>
        tool(EDIT_TOOL_NAME).execute({ path, old_string: marker(index), new_string: 'EDITED' }),
      )
      expect(readFileSync(path, 'utf8'), `edit ${relative}, readOnly=${readOnly}`).toBe(`${marker(index)}\n`)
    }
  }
})

test('test_c2_home_root_keeps_other_files_and_config_readable', async () => {
  const tool = toolsFor(true)
  for (const [index, relative] of VISIBLE_FILES.entries()) {
    const read = await outcome(() => tool(READ_TOOL_NAME).execute({ path: join(owner, relative) }))
    expect(read, `read ${relative}`).toContain(visibleMarker(index))
    const grep = await outcome(() => tool(GREP_TOOL_NAME).execute({ regex: 'VISIBLE-MARKER', path: join(owner, relative) }))
    expect(grep, `grep ${relative}`).toContain(visibleMarker(index))
  }
  const sweep = await outcome(() => tool(GREP_TOOL_NAME).execute({ regex: 'VISIBLE-MARKER', path: owner }))
  VISIBLE_FILES.forEach((relative, index) => expect(sweep, `grep sweep ${relative}`).toContain(visibleMarker(index)))

  // A writable HOME root still lets the owner's tools write ordinary files.
  const writable = toolsFor(false)
  const target = join(owner, '.config', 'written.txt')
  expect(await outcome(() => writable(WRITE_TOOL_NAME).execute({ path: target, content: 'ok\n' }))).toContain('Wrote')
  expect(readFileSync(target, 'utf8')).toBe('ok\n')
})
