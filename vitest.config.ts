import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig } from 'vitest/config'

// refs/ holds foreign repos with their own test suites; never collect them.
// The cache is kept out of the repository: in a self-rewrite candidate
// `node_modules` is an overlay or a read-only bind, and the default
// `node_modules/.vite` may be unwritable. VITE_CACHE_DIR lets the gate point
// the cache at its own private directory.
const cacheDir = process.env.VITE_CACHE_DIR ?? join(tmpdir(), 'dshbot-vitest-cache')

// Two workers per core on an idle machine: most test time is spent waiting on
// daemons, fake clocks and timers, so oversubscribing keeps cores busy. When the
// machine is already loaded (parallel full runs on a shared builder), extra
// workers only fight each other, so the share shrinks with the recent load
// average but never drops below a single worker.
const workersPerCore = 2

// A numeric value is required for maxWorkers: a percentage string would be
// capped at one per core.
function workerCount(): number {
  const configured = process.env.DSHBOT_TEST_WORKERS
  if (configured !== undefined && /^\d+$/.test(configured)) {
    const explicit = Number(configured)
    if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  }

  const cores = Math.max(1, availableParallelism())
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = loadavg()
  const load = (oneMinute + fiveMinutes + fifteenMinutes) / 3
  // Model the idle capacity of 2 * cores workers shrinking in proportion to how
  // much of the machine other processes already occupy: load ~ cores halves it,
  // and a saturated machine still keeps one worker.
  const scaled = (workersPerCore * cores * cores) / (cores + Math.max(0, load))
  return Math.max(1, Math.round(scaled))
}

export default defineConfig({
  cacheDir,
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    maxWorkers: workerCount(),
  },
})
