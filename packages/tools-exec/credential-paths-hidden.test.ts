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

test.skipIf(!sandboxed).each([true, false])('broad home root keeps credentials hidden and immutable (readOnly=%s)', { timeout: 30_000 }, async (readOnly) => {
  await startWithHomeRoot(readOnly)
  const paths = CREDENTIAL_FILES.map((relative) => join(owner, relative))
  const attack = await run(paths.map((path) => `cat '${path}'; echo OVERWRITTEN > '${path}'; echo APPENDED >> '${path}'; sed -i s/CREDENTIAL/EDITED/ '${path}'; rm -f '${path}'`).join('; ') + '; true')
  const sweep = await run(`grep -r MARKER '${owner}' 2>/dev/null; true`)
  for (const [index, relative] of CREDENTIAL_FILES.entries()) {
    expect(attack.text, relative).not.toContain(marker(index))
    expect(sweep.text, relative).not.toContain(marker(index))
    expect(readFileSync(join(owner, relative), 'utf8'), relative).toBe(`${marker(index)}\n`)
  }
  for (const [index, relative] of VISIBLE_FILES.entries()) expect(sweep.text, relative).toContain(visibleMarker(index))
  const target = join(owner, '.config', 'written.txt')
  await run(`echo ok > '${target}'`)
  if (readOnly) expect(existsSync(target)).toBe(false)
  else expect(readFileSync(target, 'utf8')).toBe('ok\n')
})
