// The absolute floor of the identity shrink guard covers every non-empty
// identity, including one that is itself under 200 characters.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { readIdentity } from './src/identity.js'
import { createUpdateIdentityTool } from './src/tools.js'

let home: string
let identityPath: string
let archiveDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'identity-shrink-floor-'))
  const memoryDir = join(home, 'memory')
  mkdirSync(memoryDir)
  identityPath = join(memoryDir, 'identity.md')
  archiveDir = join(memoryDir, 'identity-archive')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function archiveFiles(): string[] {
  return existsSync(archiveDir) ? readdirSync(archiveDir) : []
}

async function update(text: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return createUpdateIdentityTool(identityPath).execute({
    text,
    expected_revision: readIdentity(identityPath).revision,
    ...extra,
  })
}

test.each([
  { currentLength: 199, newLength: 1 },
  { currentLength: 150, newLength: 10 },
  { currentLength: 50, newLength: 120 }, // Growth that still stays under the floor.
])('rejects a text under 200 characters for a short non-empty identity ($currentLength -> $newLength)', async ({
  currentLength,
  newLength,
}) => {
  const previous = 'Я'.repeat(currentLength)
  writeFileSync(identityPath, previous)
  const before = readIdentity(identityPath)

  let failure: unknown
  try {
    await update('Н'.repeat(newLength))
  } catch (error) {
    failure = error
  }

  expect(failure, 'the tool must report a rejected update to the model').toBeInstanceOf(Error)
  const message = String(failure)
  expect(message).toMatch(new RegExp(`\\b${currentLength}\\b`))
  expect(message).toMatch(new RegExp(`\\b${newLength}\\b`))
  expect(message).toMatch(/\bforce\b/)
  expect(message).toMatch(/\breason\b/)
  expect(readIdentity(identityPath)).toEqual(before)
  expect(archiveFiles()).toEqual([])
})

test('force with a reason replaces a short identity and archives it with the reason first (199 -> 1)', async () => {
  const previous = 'Я'.repeat(198) + '\n'
  const reason = 'Оставлено одно слово по просьбе владельца.'
  writeFileSync(identityPath, previous)

  await update('Н', { force: true, reason })

  expect(readFileSync(identityPath, 'utf8')).toBe('Н')
  const files = archiveFiles()
  expect(files, 'the previous identity must be archived in memory/identity-archive').toHaveLength(1)
  expect(files[0]).toMatch(/\.md$/)
  const archived = readFileSync(join(archiveDir, files[0] as string), 'utf8')
  const previousStart = archived.indexOf(previous)
  expect(previousStart, 'the archive must preserve the complete previous text').toBeGreaterThan(0)
  expect(archived.slice(0, previousStart), 'the reason must precede the previous identity').toContain(reason)
})

test('force with a blank reason keeps a short identity (199 -> 1)', async () => {
  writeFileSync(identityPath, 'Я'.repeat(199))
  const before = readIdentity(identityPath)

  await expect(update('Н', { force: true, reason: '  ' })).rejects.toThrow(/reason/)

  expect(readIdentity(identityPath)).toEqual(before)
  expect(archiveFiles()).toEqual([])
})

test('a whitespace-only identity counts as empty and has no length limit', async () => {
  writeFileSync(identityPath, ' \n\t\n')

  await update('Н'.repeat(10))

  expect(readFileSync(identityPath, 'utf8')).toBe('Н'.repeat(10))
  expect(archiveFiles()).toEqual([])
})
