// [lifecycle] The proxy of the exec sandbox lives with the exec tools: it exists while they run (in
// this process or as a child of it), it is gone after `stop()`, and a stopped exec never falls back to
// a sandbox with open network. This file runs without any other exec instance in the process, so the
// count of listening servers before and after is the count of this instance alone.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, sandboxProfile } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const SECRET = 'LIFECYCLE-PRIVATE-SECRET'

function bwrapWorks(): boolean {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-life-probe-'))
  try {
    const profile = sandboxProfile({ home: HOME, workspace: scratch, roPaths: [] })
    const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], { encoding: 'utf8', timeout: 10_000 })
    return probe.error === undefined && probe.status === 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const hasCurl = spawnSync('curl', ['--version'], { encoding: 'utf8' }).error === undefined
const sandboxed = bwrapWorks() && hasCurl
const procfs = existsSync('/proc/self/stat')

function listeningServers(): number {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
  return handles.filter((handle) => handle instanceof net.Server && handle.listening).length
}

/** Pids of the direct children of this process. */
function children(): Set<number> {
  const found = new Set<number>()
  if (!procfs) return found
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (parent === process.pid) found.add(Number(name))
    } catch {
      // The process exited while the directory was scanned.
    }
  }
  return found
}

async function settle(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
}

let sink: http.Server
let sinkHits: string[] = []
let sinkPort = 0
let workspace = ''

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-life-'))
  sink = http.createServer((request, response) => {
    sinkHits.push(request.url ?? '')
    response.end(SECRET)
  })
  await new Promise<void>((done) => sink.listen(0, '127.0.0.1', () => done()))
  sinkPort = (sink.address() as AddressInfo).port
})

afterAll(async () => {
  sink.closeAllConnections()
  await new Promise<void>((done) => sink.close(() => done()))
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

test.skipIf(!sandboxed || !procfs)('test_lifecycle_proxy_exists_while_exec_runs_and_is_gone_after_stop', { timeout: 120_000 }, async () => {
  const serversBefore = listeningServers()
  const childrenBefore = children()
  const exec = await createExecTools({ workspace, home: HOME })
  try {
    const tool = exec.tools.find((candidate) => candidate.name === 'exec')
    const answer = String(await tool?.execute({ command: 'echo alive', timeout_sec: 30 }, { signal: new AbortController().signal }))
    expect(answer, 'the command runs in the sandbox').toContain('alive')
    const proxyInProcess = listeningServers() > serversBefore
    const proxyAsChild = [...children()].some((pid) => !childrenBefore.has(pid))
    expect(proxyInProcess || proxyAsChild, 'a proxy listener or a proxy child process serves the sandbox').toBe(true)
  } finally {
    await exec.stop()
  }
  await settle(() => listeningServers() <= serversBefore && [...children()].every((pid) => childrenBefore.has(pid)))
  expect(listeningServers(), 'no listener of the proxy is left after stop()').toBeLessThanOrEqual(serversBefore)
  const leftovers = [...children()].filter((pid) => !childrenBefore.has(pid))
  expect(leftovers, 'no child process of the proxy is left after stop()').toEqual([])
})

test.skipIf(!sandboxed)('test_lifecycle_stopped_exec_does_not_reach_the_host_network', { timeout: 120_000 }, async () => {
  sinkHits = []
  const exec = await createExecTools({ workspace, home: HOME })
  await exec.stop()
  const tool = exec.tools.find((candidate) => candidate.name === 'exec')
  let text = ''
  try {
    text = String(
      await tool?.execute(
        { command: `curl -sS -m 5 --noproxy '*' http://127.0.0.1:${sinkPort}/after-stop`, timeout_sec: 30 },
        { signal: new AbortController().signal },
      ),
    )
  } catch (error) {
    text = error instanceof Error ? error.message : String(error)
  }
  expect(sinkHits, `a stopped exec reached the host loopback\n${text}`).toEqual([])
  expect(text).not.toContain(SECRET)
})
