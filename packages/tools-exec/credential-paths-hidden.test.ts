// The owner may declare their whole HOME as a root. Inside the exec sandbox the usual places of credentials
// (cloud keys, git and package manager tokens, CLI agent accounts, keyrings, browser profiles with cookies)
// stay hidden from `cat` and unchanged by writes, while the rest of ~/.config and HOME stays usable. The tests
// drive createExecTools against the real bwrap with a scratch owner HOME; where bwrap cannot start they are skipped.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { hiddenFsPaths } from '../tools-fs/src/index.js'
import { createExecTools, sandboxProfile, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())

function bwrapWorks(): boolean {
  const scratchDir = mkdtempSync(join(tmpdir(), 'dshbot-exec-credentials-probe-'))
  try {
    const profile = sandboxProfile({ home: HOME, workspace: scratchDir, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

const sandboxed = bwrapWorks()

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

let scratch = ''
let owner = ''
let exec: ExecTools | undefined

afterEach(async () => {
  if (exec !== undefined) await exec.stop()
  exec = undefined
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

async function run(command: string): Promise<{ exit: number | null; text: string }> {
  const tool = exec?.tools.find((candidate) => candidate.name === 'exec')
  if (tool === undefined) throw new Error('exec tool is missing')
  const text = String(await tool.execute({ command, timeout_sec: 60 }, { signal: new AbortController().signal }))
  const match = /^exit (\d+)\n/.exec(text)
  return { exit: match === null ? null : Number(match[1]), text }
}

/** A scratch owner HOME with every credential file and a few ordinary ones, declared as an exec root. */
async function startWithHomeRoot(readOnly: boolean): Promise<void> {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-exec-credentials-')))
  owner = join(scratch, 'owner')
  const dshbotHome = join(owner, '.local', 'share', 'dshbot')
  const workspace = join(dshbotHome, 'workspace')
  mkdirSync(workspace, { recursive: true })
  CREDENTIAL_FILES.forEach((relative, index) => {
    mkdirSync(dirname(join(owner, relative)), { recursive: true })
    writeFileSync(join(owner, relative), `${marker(index)}\n`)
  })
  VISIBLE_FILES.forEach((relative, index) => {
    mkdirSync(dirname(join(owner, relative)), { recursive: true })
    writeFileSync(join(owner, relative), `${visibleMarker(index)}\n`)
  })
  exec = await createExecTools({
    workspace,
    home: owner,
    roPaths: [],
    roots: [{ path: workspace }, { path: owner, readOnly }],
    hidden: hiddenFsPaths(owner, dshbotHome, [workspace]),
  })
}

test.skipIf(!sandboxed)('test_c1_exec_home_root_hides_credential_files_from_cat_and_grep', { timeout: 240_000 }, async () => {
  await startWithHomeRoot(true)
  for (const [index, relative] of CREDENTIAL_FILES.entries()) {
    const answer = await run(`cat ${join(owner, relative)}`)
    expect(answer.text, `cat ${relative}`).not.toContain(marker(index))
  }
  // A recursive sweep over the whole HOME finds the ordinary files and no credentials.
  const sweep = await run(`grep -r MARKER ${owner} 2>/dev/null; true`)
  CREDENTIAL_FILES.forEach((relative, index) => expect(sweep.text, `grep -r ${relative}`).not.toContain(marker(index)))
  expect(sweep.text).toContain(visibleMarker(0))
})

test.skipIf(!sandboxed)('test_c1_exec_home_root_does_not_change_credential_files', { timeout: 240_000 }, async () => {
  for (const readOnly of [true, false]) {
    await startWithHomeRoot(readOnly)
    for (const [index, relative] of CREDENTIAL_FILES.entries()) {
      const path = join(owner, relative)
      await run(`echo OVERWRITTEN > ${path}`)
      await run(`echo APPENDED >> ${path}`)
      await run(`sed -i s/CREDENTIAL/EDITED/ ${path}`)
      await run(`rm -f ${path}`)
      expect(existsSync(path), `${relative} exists, readOnly=${readOnly}`).toBe(true)
      expect(readFileSync(path, 'utf8'), `${relative}, readOnly=${readOnly}`).toBe(`${marker(index)}\n`)
    }
    await exec?.stop()
    exec = undefined
    rmSync(scratch, { recursive: true, force: true })
    scratch = ''
  }
})

test.skipIf(!sandboxed)('test_c2_exec_home_root_keeps_other_files_and_config_usable', { timeout: 240_000 }, async () => {
  await startWithHomeRoot(false)
  for (const [index, relative] of VISIBLE_FILES.entries()) {
    const answer = await run(`cat ${join(owner, relative)}`)
    expect(answer.exit, answer.text).toBe(0)
    expect(answer.text, `cat ${relative}`).toContain(visibleMarker(index))
  }
  const sweep = await run(`grep -r VISIBLE-MARKER ${owner} 2>/dev/null; true`)
  VISIBLE_FILES.forEach((relative, index) => expect(sweep.text, `grep -r ${relative}`).toContain(visibleMarker(index)))

  const write = await run(`echo ok > ${join(owner, '.config', 'written.txt')}`)
  expect(write.exit, write.text).toBe(0)
  expect(readFileSync(join(owner, '.config', 'written.txt'), 'utf8')).toBe('ok\n')
})
