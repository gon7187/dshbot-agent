import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tracked = join(root, 'docs/bench/daemon.md')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const hasProc = existsSync('/proc/self/status')

const RUN_TIMEOUT_MS = 240_000
const TEST_TIMEOUT_MS = 300_000
const NUM = String.raw`(\d+(?:\.\d+)?)`

let scratch = ''
let tmpRoot = ''

interface BenchRun {
  status: number | null
  error: Error | undefined
  stdout: string
  output: string
}

interface DaemonSample {
  pid: number
  home: string
  rssMb: number
}

/** Daemon processes (`node ... main.ts`) whose DSHBOT_HOME lies in this test's private TMPDIR. */
function scanDaemons(): DaemonSample[] {
  if (!hasProc) return []
  const found: DaemonSample[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (!cmdline.includes('main.ts')) continue
      // argv[0], not `Name:` of status: Node names its main thread `MainThread`
      // or `node-MainThread` depending on the version.
      if (!/^node(\.exe)?$/.test(basename(cmdline.split('\0')[0] ?? ''))) continue
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      const rss = /VmRSS:\s*(\d+) kB/.exec(status)
      const home = readFileSync(`/proc/${name}/environ`, 'utf8')
        .split('\0')
        .find((entry) => entry.startsWith('DSHBOT_HOME='))
        ?.slice('DSHBOT_HOME='.length)
      if (!rss || !home || !home.startsWith(tmpRoot)) continue
      found.push({ pid: Number(name), home, rssMb: Number(rss[1]) / 1024 })
    } catch {
      // the process went away or is not readable
    }
  }
  return found
}

function benchEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    // the bench brings its own fake endpoints and keys: nothing real may leak in
    TELEGRAM_BOT_TOKEN: undefined,
    TELEGRAM_API_ROOT: undefined,
    DEEPSEEK_API_KEY: undefined,
    DEEPSEEK_BASE_URL: undefined,
    DSHBOT_HOME: undefined,
    BENCH_OUT: undefined,
    TMPDIR: tmpRoot,
    ...extra,
  }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return merged as NodeJS.ProcessEnv
}

function runBench(script: string, cwd: string, extra: Record<string, string | undefined>, samples?: DaemonSample[]): Promise<BenchRun> {
  return new Promise((resolve) => {
    const child = spawn(npm, ['run', '--silent', script], { cwd, env: benchEnv(extra), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let error: Error | undefined
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (e) => {
      error = e
    })
    const sampler = samples ? setInterval(() => samples.push(...scanDaemons()), 100) : undefined
    const killer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('close', (status) => {
      clearTimeout(killer)
      if (sampler) clearInterval(sampler)
      resolve({ status, error, stdout, output: `${stdout}${stderr}` })
    })
  })
}

function trackedReport(): string | undefined {
  return existsSync(tracked) ? readFileSync(tracked, 'utf8') : undefined
}

function pick(text: string, pattern: string, what: string): number[] {
  const match = new RegExp(pattern).exec(text)
  expect(match, `no "${what}" line in:\n${text}`).not.toBeNull()
  return (match as RegExpExecArray).slice(1).map(Number)
}

/** Checks the c1-c4 lines of a report and returns their numbers. */
function expectReportLines(text: string) {
  const [coldStart] = pick(text, String.raw`Cold start to first getUpdates:\s*${NUM}\s*ms`, 'Cold start to first getUpdates')
  const [rssIdle] = pick(text, String.raw`RSS idle:\s*${NUM}\s*MB`, 'RSS idle')
  const [rssAfter] = pick(text, String.raw`RSS after 20 turns:\s*${NUM}\s*MB`, 'RSS after 20 turns')
  const [inMedian, inP95] = pick(text, String.raw`Turn overhead inbound:\s*median\s*${NUM}\s*ms,\s*p95\s*${NUM}\s*ms`, 'Turn overhead inbound')
  const [outMedian, outP95] = pick(text, String.raw`Turn overhead outbound:\s*median\s*${NUM}\s*ms,\s*p95\s*${NUM}\s*ms`, 'Turn overhead outbound')
  const prefixMatch = /Prefix:\s*(\d+)\s*bytes,\s*~(\d+)\s*tokens\s*\(([^)]+)\)/.exec(text)
  expect(prefixMatch, `no "Prefix: <N> bytes, ~<M> tokens (<method>)" line in:\n${text}`).not.toBeNull()
  const [, bytes, tokens, method] = prefixMatch as RegExpExecArray
  return {
    coldStart: coldStart as number,
    rssIdle: rssIdle as number,
    rssAfter: rssAfter as number,
    inMedian: inMedian as number,
    inP95: inP95 as number,
    outMedian: outMedian as number,
    outP95: outP95 as number,
    bytes: Number(bytes),
    tokens: Number(tokens),
    method: (method as string).trim(),
  }
}

let plain: BenchRun
const samples: DaemonSample[] = []
let trackedBefore: string | undefined
let trackedBeforeExisted = false

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'daemon-bench-gate-'))
  tmpRoot = join(scratch, 'tmp')
  mkdirSync(tmpRoot)
  trackedBefore = trackedReport()
  trackedBeforeExisted = trackedBefore !== undefined
  plain = await runBench('bench:daemon', root, {}, samples)
}, TEST_TIMEOUT_MS)

afterAll(() => {
  for (const sample of scanDaemons()) {
    try {
      process.kill(sample.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  rmSync(scratch, { recursive: true, force: true })
})

test('test_c1_bench_daemon_runs_the_real_daemon_and_prints_cold_start_to_first_getupdates', { timeout: TEST_TIMEOUT_MS }, () => {
  expect(plain.error, plain.output).toBeUndefined()
  expect(plain.status, plain.output).toBe(0)
  const { coldStart } = expectReportLines(plain.stdout)
  expect(coldStart).toBeGreaterThan(0)
  expect(coldStart, 'cold start of a node process cannot be minutes').toBeLessThan(120_000)
  if (hasProc) {
    expect(samples.length, 'the bench never ran a `node ... main.ts` daemon process with a temporary DSHBOT_HOME').toBeGreaterThan(0)
  }
})

test('test_c2_rss_is_taken_from_the_daemon_node_process', { timeout: TEST_TIMEOUT_MS }, () => {
  expect(plain.status, plain.output).toBe(0)
  const { rssIdle, rssAfter } = expectReportLines(plain.stdout)
  expect(rssIdle).toBeGreaterThan(0)
  expect(rssAfter).toBeGreaterThan(0)
  if (!hasProc) return
  expect(samples.length, 'no daemon process was observed while the bench ran').toBeGreaterThan(0)
  const peak = Math.max(...samples.map((s) => s.rssMb))
  for (const [name, value] of [
    ['RSS idle', rssIdle],
    ['RSS after 20 turns', rssAfter],
  ] as const) {
    // a wrapper (npm, sh) would sit far below the daemon; the number must also be one the daemon really had
    expect(value, `${name} is below what the daemon process held (peak ${peak.toFixed(1)} MB)`).toBeGreaterThanOrEqual(peak * 0.6 - 2)
    expect(value, `${name} is above what the daemon process held (peak ${peak.toFixed(1)} MB)`).toBeLessThanOrEqual(peak * 1.1 + 2)
    expect(
      samples.some((s) => Math.abs(s.rssMb - value) <= s.rssMb * 0.15 + 3),
      `${name} = ${value} MB matches no RSS sample of the daemon process`,
    ).toBe(true)
  }
})

test('test_c3_twenty_turns_report_inbound_and_outbound_overhead_median_and_p95', { timeout: TEST_TIMEOUT_MS }, () => {
  expect(plain.status, plain.output).toBe(0)
  const r = expectReportLines(plain.stdout)
  for (const [name, median, p95] of [
    ['inbound', r.inMedian, r.inP95],
    ['outbound', r.outMedian, r.outP95],
  ] as const) {
    expect(Number.isFinite(median) && Number.isFinite(p95), `${name} numbers must be finite`).toBe(true)
    expect(median, `${name} median`).toBeGreaterThanOrEqual(0)
    expect(p95, `${name} p95 must not be below the median`).toBeGreaterThanOrEqual(median)
    expect(p95, `${name} overhead of a turn without a model cannot be seconds`).toBeLessThan(5_000)
  }
})

test('test_c4_prefix_reports_system_and_tools_size_with_the_estimation_method', { timeout: TEST_TIMEOUT_MS }, () => {
  expect(plain.status, plain.output).toBe(0)
  const { bytes, tokens, method } = expectReportLines(plain.stdout)
  const charter = readFileSync(join(root, 'CHARTER.md'), 'utf8').trim()
  // system starts with the charter and tools[] come on top of it
  expect(bytes).toBeGreaterThan(Buffer.byteLength(charter, 'utf8'))
  expect(tokens).toBeGreaterThan(0)
  expect(tokens, 'a token is at least a byte').toBeLessThanOrEqual(bytes)
  expect(tokens * 10, 'a token is not more than ten bytes').toBeGreaterThanOrEqual(bytes)
  expect(method.length, 'the estimation method must be named').toBeGreaterThanOrEqual(5)
  expect(method).toMatch(/[A-Za-zА-Яа-я]{3}/)
})

test('test_c5_bench_out_writes_the_report_and_leaves_the_committed_file_alone', { timeout: TEST_TIMEOUT_MS }, async () => {
  expect(trackedReport(), 'the plain run must not touch docs/bench/daemon.md').toBe(trackedBefore)
  const out = join(scratch, 'out', 'daemon.md')
  const run = await runBench('bench:daemon', root, { BENCH_OUT: out })
  expect(run.error, run.output).toBeUndefined()
  expect(run.status, run.output).toBe(0)
  expect(existsSync(out), `BENCH_OUT file was not created\n${run.output}`).toBe(true)
  expectReportLines(readFileSync(out, 'utf8'))
  expect(trackedReport(), 'BENCH_OUT must not change docs/bench/daemon.md').toBe(trackedBefore)
  expect(existsSync(tracked), 'BENCH_OUT must not create docs/bench/daemon.md').toBe(trackedBeforeExisted)
})

test('test_c5_bench_daemon_write_fills_docs_bench_daemon_md_with_node_version_and_commit', { timeout: TEST_TIMEOUT_MS }, async () => {
  // Run in a throwaway copy of the repo so the committed report is never written by the test.
  const copy = join(scratch, 'repo')
  cpSync(root, copy, {
    recursive: true,
    // Other test files create and delete scratch directories in the root while this copy runs.
    filter: (src) =>
      !/[\\/](node_modules|refs|\.git|\.zavod-out|__typecheck_gate_[^\\/]*|\.host-exec-local-regression-[^\\/]*)$/.test(src),
  })
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir')
  rmSync(join(copy, 'docs/bench/daemon.md'), { force: true })

  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...args], { cwd: copy, encoding: 'utf8' })
  expect(git('init', '-q').status).toBe(0)
  expect(git('commit', '-q', '--allow-empty', '-m', 'bench copy').status).toBe(0)
  const head = git('rev-parse', 'HEAD')
  expect(head.status).toBe(0)
  const commit = head.stdout.trim()
  expect(commit).toMatch(/^[0-9a-f]{40}$/)

  const run = await runBench('bench:daemon:write', copy, {})
  expect(run.error, run.output).toBeUndefined()
  expect(run.status, run.output).toBe(0)

  const written = join(copy, 'docs/bench/daemon.md')
  expect(existsSync(written), `bench:daemon:write did not create docs/bench/daemon.md\n${run.output}`).toBe(true)
  const markdown = readFileSync(written, 'utf8')
  expectReportLines(markdown)
  expect(markdown, 'the report must name the Node version').toContain(process.version)
  expect(markdown, 'the report must name the git commit').toContain(commit.slice(0, 7))
  expect(trackedReport(), 'the write run in the copy must not change the committed report').toBe(trackedBefore)
})

test('test_c6_daemon_is_gone_and_temporary_home_removed_after_the_bench', { timeout: TEST_TIMEOUT_MS }, async () => {
  expect(plain.error, plain.output).toBeUndefined()
  expect(plain.status, plain.output).toBe(0)
  if (!hasProc) return
  expect(samples.length, 'no daemon process was observed while the bench ran').toBeGreaterThan(0)

  for (let i = 0; i < 30 && scanDaemons().length > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  const alive = scanDaemons()
  expect(alive, `daemon processes are still alive: ${JSON.stringify(alive)}`).toHaveLength(0)

  for (const home of new Set(samples.map((s) => s.home))) {
    expect(existsSync(home), `DSHBOT_HOME ${home} was not removed`).toBe(false)
    const top = relative(tmpRoot, home).split(sep)[0] as string
    expect(existsSync(join(tmpRoot, top)), `temporary directory ${top} was not removed`).toBe(false)
  }
})
