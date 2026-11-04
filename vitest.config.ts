import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig } from 'vitest/config'

// refs/ holds foreign repos with their own test suites; never collect them.
// The cache is kept out of the repository: in a self-rewrite candidate
// `node_modules` is an overlay or a read-only bind, and the default
// `node_modules/.vite` may be unwritable. VITE_CACHE_DIR lets the gate point
// the cache at its own private directory.
const cacheDir = process.env.VITE_CACHE_DIR ?? join(tmpdir(), 'dshbot-vitest-cache')

function workerCount(): number {
  const configured = process.env.DSHBOT_TEST_WORKERS
  if (configured !== undefined && /^\d+$/.test(configured)) {
    const explicit = Number(configured)
    if (Number.isSafeInteger(explicit) && explicit > 0) return explicit
  }

  return Math.max(1, availableParallelism())
}

export default defineConfig({
  cacheDir,
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    maxWorkers: workerCount(),
  },
})
