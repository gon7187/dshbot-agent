import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

test('root tsconfig covers packages and tests with strict NodeNext noEmit', () => {
  const raw = readFileSync(join(root, 'tsconfig.json'), 'utf8')
  const config = JSON.parse(raw) as {
    compilerOptions?: Record<string, unknown>
    include?: string[]
    exclude?: string[]
  }
  const options = config.compilerOptions ?? {}
  const include = config.include ?? []
  const exclude = config.exclude ?? []

  expect(options.strict).toBe(true)
  expect(options.module).toBe('NodeNext')
  expect(options.moduleResolution).toBe('NodeNext')
  expect(options.noEmit).toBe(true)
  expect(include).toContain('packages/**/*.ts')
  expect(include).toContain('tests/**/*.ts')
  expect(exclude).toContain('refs')
  expect(exclude).toContain('node_modules')
})
