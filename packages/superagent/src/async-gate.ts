import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SandboxOptions, SandboxResult } from '../../evolve/src/index.js'

/** Keep the existing gate isolated and make its whole process group cancellable. */
export function asyncDeliveryGate(options: SandboxOptions, signal?: AbortSignal): Promise<SandboxResult> {
  if (signal?.aborted) return Promise.reject(new Error('delivery tests interrupted'))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', fileURLToPath(new URL('../../app/register.mjs', import.meta.url)),
      fileURLToPath(new URL('./delivery-gate.ts', import.meta.url)),
    ], {
      detached: true,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', TMPDIR: process.env.TMPDIR },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let output = ''
    let bytes = 0
    let failure: Error | undefined
    const kill = (): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
    }
    const abort = (): void => { failure = new Error('delivery tests interrupted'); kill() }
    const deadline = setTimeout(() => {
      failure = new Error('delivery test process exceeded its deadline')
      kill()
    }, Math.min((options.timeoutMs ?? 600_000) + 60_000, 2_147_483_647))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 2 * 1024 * 1024) {
        failure = new Error('delivery test result is too large')
        kill()
      } else output += chunk
    })
    child.stdin.on('error', () => { /* close/error supplies the final outcome */ })
    child.once('error', error => { failure = error })
    child.once('close', code => {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', abort)
      if (failure !== undefined) { reject(failure); return }
      if (code !== 0) { reject(new Error('delivery test process failed')); return }
      try {
        const value: unknown = JSON.parse(output)
        if (typeof value !== 'object' || value === null || !('ok' in value) || typeof value.ok !== 'boolean'
          || !('output' in value) || typeof value.output !== 'string' || !('status' in value)
          || (value.status !== null && (!Number.isInteger(value.status) || typeof value.status !== 'number'))) {
          throw new Error('invalid delivery test result')
        }
        resolve(value as SandboxResult)
      } catch { reject(new Error('invalid delivery test result')) }
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.end(JSON.stringify(options))
  })
}
