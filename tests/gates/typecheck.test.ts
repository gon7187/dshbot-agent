import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, expect, test } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const createdDirs: string[] = []

function tempDir(parent: string): string {
  const dir = join(root, parent, `__typecheck_gate_${process.pid}_${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  createdDirs.push(dir)
  return dir
}

function runTypecheck(): { status: number | null; output: string } {
  const result = spawnSync(npm, ['run', '--silent', 'typecheck'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
  }
})

test('type error in packages/ fails typecheck, clean file passes and is removed', () => {
  const dir = tempDir('packages')
  const file = join(dir, 'probe.ts')
  mkdirSync(dirname(file), { recursive: true })

  writeFileSync(file, 'const probe: number = "not a number"\nexport { probe }\n')
  expect(runTypecheck().status).not.toBe(0)

  writeFileSync(file, 'const probe: number = 42\nexport { probe }\n')
  expect(runTypecheck().status).toBe(0)

  rmSync(dir, { recursive: true, force: true })
  expect(existsSync(dir)).toBe(false)
}, 120_000)

test('type error inside refs/ does not affect project typecheck', () => {
  const dir = tempDir('refs')
  const file = join(dir, 'probe.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'const probe: number = "not a number"\nexport { probe }\n')

  expect(runTypecheck().status).toBe(0)

  rmSync(dir, { recursive: true, force: true })
  expect(existsSync(dir)).toBe(false)
}, 120_000)

test('node:sqlite DatabaseSync import typechecks in packages/', () => {
  const dir = tempDir('packages')
  const file = join(dir, 'sqlite.ts')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    "import { DatabaseSync } from 'node:sqlite'\nconst db: DatabaseSync = new DatabaseSync(':memory:')\nexport { db }\n",
  )

  expect(runTypecheck().status).toBe(0)

  rmSync(dir, { recursive: true, force: true })
  expect(existsSync(dir)).toBe(false)
}, 120_000)

test('typescript and @types/node are exact devDependency versions', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const devDependencies = pkg.devDependencies ?? {}
  const exact = /^\d+\.\d+\.\d+$/

  for (const name of ['typescript', '@types/node']) {
    const version = devDependencies[name]
    expect(version, `${name} must be in devDependencies`).toBeTypeOf('string')
    expect(version, `${name} must be an exact version`).toMatch(exact)
    expect(version, `${name} must not use a range`).not.toMatch(/[\^~*xX]/)
  }
})

test('npm test runs typecheck before vitest', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const scripts = pkg.scripts ?? {}
  expect(scripts.typecheck).toBeTypeOf('string')

  const command = scripts.test ?? ''
  const typecheckAt = command.indexOf('typecheck')
  const vitestAt = command.indexOf('vitest')
  expect(typecheckAt).toBeGreaterThanOrEqual(0)
  expect(vitestAt).toBeGreaterThan(typecheckAt)
})
