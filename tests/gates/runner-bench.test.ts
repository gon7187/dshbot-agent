import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const report = join(root, 'docs/bench/runner.md')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

let scratch = ''

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'runner-bench-gate-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function expectMeasured(markdown: string): { coldStart: number; rss: number } {
  const coldStart = /Cold start to readiness:\s*(\d+(?:\.\d+)?)\s*ms/.exec(markdown)
  const rss = /RSS after one turn:\s*(\d+(?:\.\d+)?)\s*MB/.exec(markdown)
  expect(coldStart, markdown).not.toBeNull()
  expect(rss, markdown).not.toBeNull()
  const values = { coldStart: Number(coldStart?.[1]), rss: Number(rss?.[1]) }
  expect(values.coldStart).toBeGreaterThan(0)
  expect(values.rss).toBeGreaterThan(0)
  return values
}

test('npm run bench:runner measures cold start and RSS into BENCH_OUT', { timeout: 180_000 }, () => {
  const out = join(scratch, 'runner.md')
  const run = spawnSync(npm, ['run', '--silent', 'bench:runner'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, BENCH_OUT: out, NO_COLOR: '1' },
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  expect(run.error, output).toBeUndefined()
  expect(run.status, output).toBe(0)
  expect(existsSync(out), `bench report was not written to BENCH_OUT\n${output}`).toBe(true)
  expectMeasured(readFileSync(out, 'utf8'))
})

test('the committed docs/bench/runner.md holds a real measurement', () => {
  expect(existsSync(report), 'docs/bench/runner.md must stay committed with the benchmark').toBe(true)
  const markdown = readFileSync(report, 'utf8')
  expectMeasured(markdown)
  expect(markdown).toContain('bench:runner')
})
