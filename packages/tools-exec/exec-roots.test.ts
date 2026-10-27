// Extra roots of the owner inside the exec sandbox must carry the permission
// the file tools give them (the longest matching root wins), and the hidden
// trees (keys of the owner, the private state of the bot) must stay hidden even
// when declared roots overlap. The tests drive createExecTools against the real
// bwrap with a scratch owner HOME; where bwrap cannot start they are skipped.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { hiddenFsPaths } from '../tools-fs/src/index.js'
import { createExecTools, sandboxProfile, type ExecRoot, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())

function bwrapWorks(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-roots-probe-'))
  try {
    const profile = sandboxProfile({ home: HOME, workspace: scratch, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const sandboxed = bwrapWorks()

const SSH_KEY = 'PRIVATE-KEY-MATERIAL-7f3a'
const BOT_ENV = 'DSHBOT_SECRET_ENV_91c2'
const BOT_STATE = 'BOT-PRIVATE-STATE-55de'

let scratch = ''
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

/** A scratch owner HOME with key material and a DSHBOT_HOME inside it. */
function ownerLayout(): { owner: string; dshbotHome: string; workspace: string } {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-exec-roots-')))
  const owner = join(scratch, 'owner')
  const dshbotHome = join(owner, '.local', 'share', 'dshbot')
  const workspace = join(dshbotHome, 'workspace')
  mkdirSync(join(owner, '.ssh'), { recursive: true })
  mkdirSync(join(owner, '.config', 'dshbot'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(owner, '.ssh', 'id_ed25519'), `${SSH_KEY}\n`)
  writeFileSync(join(owner, '.config', 'dshbot', 'dshbot.env'), `${BOT_ENV}\n`)
  writeFileSync(join(owner, '.config', 'visible.txt'), 'CONFIG-VISIBLE\n')
  writeFileSync(join(dshbotHome, 'state.json'), `${BOT_STATE}\n`)
  return { owner, dshbotHome, workspace }
}

test.skipIf(!sandboxed)('test_exec_nested_rw_root_inside_a_ro_root_in_the_workspace_stays_writable', { timeout: 120_000 }, async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-exec-roots-')))
  const workspace = join(scratch, 'workspace')
  const outside = join(scratch, 'outside')
  for (const dir of [join(workspace, 'ro', 'rw'), join(outside, 'rw')]) mkdirSync(dir, { recursive: true })
  const roots: ExecRoot[] = [
    { path: workspace },
    { path: join(workspace, 'ro'), readOnly: true },
    { path: join(workspace, 'ro', 'rw') },
    { path: outside, readOnly: true },
    { path: join(outside, 'rw') },
  ]
  exec = await createExecTools({ workspace, home: join(scratch, 'home'), roPaths: [], roots })

  const nested = await run(`echo NESTED > ${join(workspace, 'ro', 'rw', 'a.txt')}`)
  expect(nested.exit, nested.text).toBe(0)
  expect(readFileSync(join(workspace, 'ro', 'rw', 'a.txt'), 'utf8')).toBe('NESTED\n')

  const parent = await run(`echo PARENT > ${join(workspace, 'ro', 'b.txt')}`)
  expect(parent.exit, parent.text).not.toBe(0)
  expect(() => readFileSync(join(workspace, 'ro', 'b.txt'))).toThrow()

  const outsideNested = await run(`echo OUT > ${join(outside, 'rw', 'c.txt')}`)
  expect(outsideNested.exit, outsideNested.text).toBe(0)
  const outsideParent = await run(`echo OUT > ${join(outside, 'd.txt')}`)
  expect(outsideParent.exit, outsideParent.text).not.toBe(0)
  expect(() => readFileSync(join(outside, 'd.txt'))).toThrow()

  const top = await run(`echo TOP > ${join(workspace, 'e.txt')}`)
  expect(top.exit, top.text).toBe(0)
})

test.skipIf(!sandboxed)('test_exec_overlapping_roots_never_reveal_the_hidden_trees', { timeout: 120_000 }, async () => {
  const { owner, dshbotHome, workspace } = ownerLayout()
  const roots: ExecRoot[] = [
    { path: workspace },
    { path: owner, readOnly: true },
    { path: join(owner, '.config'), readOnly: true },
    { path: join(owner, '.ssh'), readOnly: true },
    { path: dshbotHome, readOnly: true },
  ]
  exec = await createExecTools({
    workspace,
    home: owner,
    roPaths: [],
    roots,
    hidden: hiddenFsPaths(owner, dshbotHome, [workspace]),
  })

  for (const secret of [
    join(owner, '.ssh', 'id_ed25519'),
    join(owner, '.config', 'dshbot', 'dshbot.env'),
    join(dshbotHome, 'state.json'),
  ]) {
    const answer = await run(`cat ${secret}`)
    expect(answer.exit, answer.text).not.toBe(0)
    for (const value of [SSH_KEY, BOT_ENV, BOT_STATE]) expect(answer.text).not.toContain(value)
  }
  const listing = await run(`ls -a ${join(owner, '.ssh')} ${join(owner, '.config', 'dshbot')}; grep -r . ${owner} 2>/dev/null; true`)
  for (const value of [SSH_KEY, BOT_ENV, BOT_STATE, 'id_ed25519', 'dshbot.env']) expect(listing.text).not.toContain(value)

  const visible = await run(`cat ${join(owner, '.config', 'visible.txt')}`)
  expect(visible.exit, visible.text).toBe(0)
  expect(visible.text).toContain('CONFIG-VISIBLE')
  const write = await run(`echo WS > ${join(workspace, 'w.txt')}`)
  expect(write.exit, write.text).toBe(0)
  const roWrite = await run(`echo NO > ${join(owner, '.config', 'x.txt')}`)
  expect(roWrite.exit, roWrite.text).not.toBe(0)
})

test.skipIf(!sandboxed)('test_exec_filesystem_root_keeps_the_private_proc_and_hides_the_keys', { timeout: 120_000 }, async () => {
  const { owner, dshbotHome, workspace } = ownerLayout()
  exec = await createExecTools({
    workspace,
    home: owner,
    roPaths: [],
    roots: [{ path: workspace }, { path: '/', readOnly: true }],
    hidden: hiddenFsPaths(owner, dshbotHome, [workspace]),
  })

  const key = await run(`cat ${join(owner, '.ssh', 'id_ed25519')}`)
  expect(key.exit, key.text).not.toBe(0)
  expect(key.text).not.toContain(SSH_KEY)
  // The PID namespace stays private: the daemon process is not visible.
  const proc = await run(`test ! -e /proc/${process.pid}/status || grep -q '^Name:.*bwrap' /proc/${process.pid}/status; echo PROC=$?`)
  expect(proc.text).toContain('PROC=0')
  const roWrite = await run(`echo NO > ${join(scratch, 'outside.txt')}`)
  expect(roWrite.exit, roWrite.text).not.toBe(0)
  const visible = await run(`cat ${join(owner, '.config', 'visible.txt')}`)
  expect(visible.text).toContain('CONFIG-VISIBLE')
  const write = await run(`echo WS > ${join(workspace, 'w.txt')}`)
  expect(write.exit, write.text).toBe(0)
})
