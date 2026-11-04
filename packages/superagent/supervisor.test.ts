import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, test, vi } from 'vitest'
import { createSuperagentSupervisor, resolveSuperagentProxyTarget } from './src/supervisor.js'

describe('own sandbox process lifetime', () => {
const fixtures: string[] = []
const diagnostics: string[] = []
const bwrapAvailable = spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).status === 0

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
  diagnostics.length = 0
})

function fixture(script: string): { root: string; runtime: string; home: string; bridge: string; entrypoint: string; bootstrap: string } {
  const root = mkdtempSync(join(tmpdir(), 'dshbot-supervisor-'))
  fixtures.push(root)
  const runtime = join(root, 'runtime')
  const entrypoint = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const bootstrap = join(runtime, 'bootstrap.mjs')
  mkdirSync(dirname(entrypoint), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}\n')
  writeFileSync(entrypoint, 'export {}\n')
  writeFileSync(bootstrap, script)
  const home = join(root, 'home')
  const bridge = join(root, 'bridge')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(bridge, { mode: 0o700 })
  return { root, runtime, home, bridge, entrypoint, bootstrap }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for supervisor fixture\n${diagnostics.join('\n')}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function supervisor(f: ReturnType<typeof fixture>, options: Partial<Parameters<typeof createSuperagentSupervisor>[0]> = {}) {
  return createSuperagentSupervisor({
    runtimeDir: f.runtime,
    homeDir: f.home,
    bridgeDir: f.bridge,
    ...options,
    log: line => { diagnostics.push(line); options.log?.(line) },
    onExit: exit => { diagnostics.push(`supervisor exit ${JSON.stringify(exit)}`); options.onExit?.(exit) },
  })
}


test('S-CANCEL-START never spawns after pending setup is cancelled', { timeout: 60_000 }, async () => {
  {
    for (const action of ['stop', 'panic'] as const) {
      vi.resetModules()
      let networkStarted = false
      let networkStops = 0
      let releaseNetwork: ((network: { server: string; stop(): void }) => void) | undefined
      const networkReady = new Promise<{ server: string; stop(): void }>(resolve => { releaseNetwork = resolve })
      vi.doMock('../guard/src/network-proxy.js', () => ({
        startNetworkProxy: async () => {
          networkStarted = true
          return networkReady
        },
      }))
      const { createSuperagentSupervisor: create } = await import('./src/supervisor.js')
      const f = fixture('setInterval(() => {}, 1_000)')
      const bin = join(f.root, 'bin')
      const marker = join(f.root, 'spawned')
      const bwrap = join(bin, 'bwrap')
      mkdirSync(bin)
      writeFileSync(bwrap, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')
`)
      chmodSync(bwrap, 0o755)
      const previousPath = process.env.PATH
      process.env.PATH = bin
      let starting: Promise<void> | undefined
      let stopping: Promise<void> | undefined
      try {
        const child = create({ runtimeDir: f.runtime, homeDir: f.home, bridgeDir: f.bridge })
        starting = child.start()
        await waitFor(() => networkStarted)
        if (action === 'stop') stopping = child.stop()
        else child.panic()
        releaseNetwork?.({ server: '', stop: () => { networkStops++ } })
        await starting
        if (stopping !== undefined) await stopping
        expect(existsSync(marker)).toBe(false)
        expect(networkStops).toBe(1)
        expect(child.running()).toBe(false)
      } finally {
        releaseNetwork?.({ server: '', stop: () => { networkStops++ } })
        await starting?.catch(() => undefined)
        await stopping?.catch(() => undefined)
        if (previousPath === undefined) delete process.env.PATH
        else process.env.PATH = previousPath
        vi.doUnmock('../guard/src/network-proxy.js')
        vi.resetModules()
      }
    }

  }
})

test.skipIf(!bwrapAvailable)('S-LIFECYCLE confines secrets and network and kills the owned process tree', { timeout: 60_000 }, async () => {
  {
    const f = fixture(`
      import { existsSync, writeFileSync } from 'node:fs'
      writeFileSync('/home/user/inspection.json', JSON.stringify({
        home: process.env.HOME,
        dshHome: process.env.DSH_HOME,
        env: Object.keys(process.env).sort(),
        roots: Object.fromEntries(['/root', '/var', '/workspace', '/run/superagent/bridge.txt', '/run/superagent/write.txt']
          .map(path => [path, existsSync(path)])),
      }))
      try { writeFileSync('/run/superagent/write.txt', 'must fail') } catch {}
      setInterval(() => {}, 1_000)
    `)
    writeFileSync(join(f.bridge, 'bridge.txt'), 'bridge')
    const child = supervisor(f, { env: { DEEPSEEK_API_KEY: 'fixture-smoke-secret' } })
    await child.start()
    await waitFor(() => existsSync(join(f.home, 'inspection.json')))
    const inspection = JSON.parse(readFileSync(join(f.home, 'inspection.json'), 'utf8')) as {
      home: string; dshHome: string; env: string[]; roots: Record<string, boolean>
    }
    expect(inspection.home).toBe('/home/user')
    expect(inspection.dshHome).toBe('/home/user/.dsh')
    expect(inspection.env).toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY', 'DSH_HOME', 'HOME', 'LANG', 'PATH']))
    expect(inspection.env).not.toContain('DSHBOT_HOME')
    expect(inspection.roots).toMatchObject({ '/root': false, '/var': false, '/workspace': false, '/run/superagent/bridge.txt': true, '/run/superagent/write.txt': false })
    await child.stop()
    expect(child.running()).toBe(false)

  }
  {
    const host = createServer(socket => socket.end('host-reached'))
    await new Promise<void>((resolve, reject) => {
      host.once('error', reject)
      host.listen(0, '127.0.0.1', resolve)
    })
    const hostPort = (host.address() as { port: number }).port
    const f = fixture(`
      import { existsSync, writeFileSync } from 'node:fs'
      import { connect } from 'node:net'
      const marker = '/home/user/network-blocked'
      const socket = connect(${hostPort}, '127.0.0.1')
      socket.once('connect', () => writeFileSync('/home/user/host-reached', 'bad'))
      socket.once('error', () => writeFileSync(marker, 'yes'))
      setTimeout(() => { if (!existsSync(marker)) writeFileSync(marker, 'timeout') }, 1_000)
      setInterval(() => {}, 1_000)
    `)
    try {
      const child = supervisor(f)
      await child.start()
      await waitFor(() => existsSync(join(f.home, 'network-blocked')))
      expect(existsSync(join(f.home, 'host-reached'))).toBe(false)
      expect(readFileSync(join(f.home, 'network-blocked'), 'utf8')).toBe('yes')
      await child.stop()
    } finally {
      await new Promise<void>(resolve => host.close(() => resolve()))
    }

  }
  {
    const f = fixture(`
      import { writeFileSync } from 'node:fs'
      import { connect } from 'node:net'
      const chunks = []
      const socket = connect('/run/superagent-net/proxy.sock')
      socket.on('data', chunk => chunks.push(chunk))
      socket.once('error', error => writeFileSync('/home/user/proxy-error', error.code ?? String(error)))
      socket.once('end', () => writeFileSync('/home/user/proxy-response', Buffer.concat(chunks).toString()))
      socket.once('connect', () => socket.end('GET http://127.0.0.1/ HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n'))
      setInterval(() => {}, 1_000)
    `)
    const child = supervisor(f)
    await child.start()
    await waitFor(() => existsSync(join(f.home, 'proxy-response')) || existsSync(join(f.home, 'proxy-error')))
    expect(existsSync(join(f.home, 'proxy-error'))).toBe(false)
    expect(readFileSync(join(f.home, 'proxy-response'), 'utf8')).toMatch(/^HTTP\/1\.1 403 Forbidden/)
    await child.stop()

  }
  {
    const f = fixture(`
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      const grandchild = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('/home/user/grandchild-ready', 'yes'); setTimeout(() => { require('node:fs').writeFileSync('/home/user/grandchild-survived', 'bad') }, 500)"], { stdio: 'ignore' })
      writeFileSync('/home/user/grandchild-started', String(grandchild.pid))
      setInterval(() => {}, 1_000)
    `)
    const child = supervisor(f)
    await child.start()
    await waitFor(() => existsSync(join(f.home, 'grandchild-started')) && existsSync(join(f.home, 'grandchild-ready')))
    await child.stop()
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(existsSync(join(f.home, 'grandchild-survived'))).toBe(false)
    expect(child.running()).toBe(false)

  }
  {
    const f = fixture(`
      import { writeFileSync } from 'node:fs'
      process.on('SIGTERM', () => {})
      writeFileSync('/home/user/panic-ready', 'yes')
      setInterval(() => {}, 1_000)
    `)
    const exits: unknown[] = []
    const child = supervisor(f, { onExit: exit => exits.push(exit) })
    await child.start()
    await waitFor(() => existsSync(join(f.home, 'panic-ready')))
    child.panic()
    await waitFor(() => !child.running())
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ signal: 'SIGKILL' })

  }
  {
    const f = fixture(`
      import { writeFileSync } from 'node:fs'
      writeFileSync('/home/user/ready', 'yes')
      setTimeout(() => writeFileSync('/home/user/survived-parent', 'bad'), 500)
      setInterval(() => {}, 1_000)
    `)
    const helper = join(f.root, 'helper.mjs')
    const source = JSON.stringify(join(process.cwd(), 'packages/superagent/src/supervisor.ts'))
    writeFileSync(helper, `
      import { existsSync } from 'node:fs'
      import { createSuperagentSupervisor } from ${source}
      const supervisor = createSuperagentSupervisor({ ...${JSON.stringify({ runtimeDir: f.runtime, homeDir: f.home, bridgeDir: f.bridge })}, log: line => console.error(line) })
      await supervisor.start()
      const deadline = Date.now() + 5_000
      while (!existsSync(${JSON.stringify(join(f.home, 'ready'))}) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      if (!existsSync(${JSON.stringify(join(f.home, 'ready'))})) throw new Error('superagent fixture did not become ready')
      process.exit(0)
    `)
    const result = spawnSync(process.execPath, ['--import', join(process.cwd(), 'packages/app/register.mjs'), helper], { cwd: process.cwd(), encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(existsSync(join(f.home, 'survived-parent'))).toBe(false)

  }
})

})
