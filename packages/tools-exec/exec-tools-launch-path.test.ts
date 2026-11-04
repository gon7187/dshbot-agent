// The bwrap seam records its own environment before emulating --setenv and
// executing the command. This tests the launcher even without user namespaces.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { expect, test } from 'vitest'

import { createExecTools } from './src/index.js'

test('h1 installed programs cannot replace the sandbox launcher or env', { timeout: 120_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dshbot-exec-launch-path-'))
  const launcherBin = join(scratch, 'launcher')
  const toolsDir = join(scratch, 'tools')
  const toolsBin = join(toolsDir, 'bin')
  const workspace = join(scratch, 'workspace')
  const calls = join(scratch, 'calls')
  const marker = join(scratch, 'hijacked')
  const originalPath = process.env.PATH
  const originalExecPath = process.execPath
  let exec: Awaited<ReturnType<typeof createExecTools>> | undefined
  try {
    mkdirSync(launcherBin)
    mkdirSync(toolsBin, { recursive: true })
    mkdirSync(workspace)
    const fakeBwrap = `#!/bin/sh
printf '%s\\n' "$PATH" >> '${calls}'
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  if [ "$1" = "--setenv" ]; then export "$2=$3"; shift 3; else shift; fi
done
shift
if [ "$1" = /bin/bash ] && [ "$2" = -c ] && [ "$4" = dshbot-exec ]; then exec /bin/bash -c "$5"; fi
exec "$@"
`
    writeFileSync(join(launcherBin, 'bwrap'), fakeBwrap, { mode: 0o755 })
    symlinkSync(originalExecPath, join(launcherBin, 'node'))
    for (const name of ['bwrap', 'env']) {
      writeFileSync(join(toolsBin, name), `#!/bin/sh\nprintf '${name}\\n' >> '${marker}'\nexit 99\n`)
      chmodSync(join(toolsBin, name), 0o755)
    }
    process.env.PATH = [launcherBin, originalPath ?? '/usr/bin:/bin'].join(delimiter)
    const daemonPath = process.env.PATH
    Object.defineProperty(process, 'execPath', { value: join(launcherBin, 'node'), configurable: true, writable: true })
    exec = await createExecTools({ workspace, home: resolve(process.env.HOME ?? homedir()), toolsDir })
    const tool = exec.tools.find((candidate) => candidate.name === 'exec')
    expect(tool).toBeDefined()
    const result = String(await tool!.execute({ command: 'printf "sandbox-path=%s\\n" "$PATH"; printf "command-ran\\n"' }, { signal: new AbortController().signal }))

    expect(existsSync(marker), 'neither installed launcher may run').toBe(false)
    expect(result, 'the command runs through bwrap').toMatch(/^exit 0\b/)
    expect(result).toContain('command-ran')
    expect(result).toContain(toolsBin)
    const launcherPaths = readFileSync(calls, 'utf8').trim().split('\n')
    expect(launcherPaths, 'both the probe and the command invoke bwrap').toHaveLength(2)
    expect(launcherPaths[0], 'the probe and the launch use the same PATH').toBe(launcherPaths[1])
    for (const path of launcherPaths) expect(path.split(delimiter)).not.toContain(toolsBin)
    expect(process.env.PATH, 'the daemon PATH remains unchanged').toBe(daemonPath)
  } finally {
    if (exec !== undefined) await exec.stop()
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true, writable: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})
