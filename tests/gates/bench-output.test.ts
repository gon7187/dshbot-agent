import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tracked = join(root, 'docs/bench/runner.md')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'bench-output-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function trackedReport(): string | undefined {
  return existsSync(tracked) ? readFileSync(tracked, 'utf8') : undefined
}

function npmRun(script: string, cwd: string, env: Record<string, string | undefined>) {
  const merged: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', ...env }
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  const run = spawnSync(npm, ['run', '--silent', script], {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: merged as NodeJS.ProcessEnv,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  expect(run.error, output).toBeUndefined()
  expect(run.status, output).toBe(0)
  return { stdout: run.stdout ?? '', output }
}

function expectMeasured(markdown: string): void {
  const coldStart = /Cold start to readiness:\s*(\d+(?:\.\d+)?)\s*ms/.exec(markdown)
  const rss = /RSS after one turn:\s*(\d+(?:\.\d+)?)\s*MB/.exec(markdown)
  expect(coldStart, markdown).not.toBeNull()
  expect(rss, markdown).not.toBeNull()
  expect(Number(coldStart?.[1])).toBeGreaterThan(0)
  expect(Number(rss?.[1])).toBeGreaterThan(0)
}

test('test_h1_bench_runner_writes_report_to_bench_out_only', { timeout: 180_000 }, () => {
  const before = trackedReport()
  const out = join(scratch, 'report.md')

  npmRun('bench:runner', root, { BENCH_OUT: out })

  expect(existsSync(out), 'BENCH_OUT file was not created').toBe(true)
  expectMeasured(readFileSync(out, 'utf8'))
  expect(trackedReport(), 'bench:runner with BENCH_OUT must not touch docs/bench/runner.md').toBe(before)
})

test('test_h1_bench_runner_defaults_to_stdout', { timeout: 180_000 }, () => {
  const before = trackedReport()

  const { stdout, output } = npmRun('bench:runner', root, { BENCH_OUT: undefined })

  expectMeasured(stdout || output)
  expect(trackedReport(), 'bench:runner without BENCH_OUT must not touch docs/bench/runner.md').toBe(before)
})

test('test_h1_bench_write_updates_docs_bench_runner_md', { timeout: 180_000 }, () => {
  // Run in a throwaway copy of the repo so the tracked report is never written by the test.
  const copy = join(scratch, 'repo')
  cpSync(root, copy, {
    recursive: true,
    // Other gate files create and drop __typecheck_gate_* dirs under packages/ while this copy runs.
    filter: (src) => !/[\\/](node_modules|refs|\.git|\.zavod-out|__typecheck_gate_[^\\/]*)$/.test(src),
  })
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir')
  rmSync(join(copy, 'docs/bench/runner.md'), { force: true })

  npmRun('bench:write', copy, { BENCH_OUT: undefined })

  const written = join(copy, 'docs/bench/runner.md')
  expect(existsSync(written), 'bench:write did not create docs/bench/runner.md').toBe(true)
  const markdown = readFileSync(written, 'utf8')
  expectMeasured(markdown)
  expect(markdown).toContain('bench:runner')
})
