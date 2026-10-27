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
  home = mkdtempSync(join(tmpdir(), 'identity-shrink-guard-'))
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

const shrinkCases = [
  { currentLength: 800, newLength: 399 }, // Ratio alone: the replacement still exceeds 200 characters.
  { currentLength: 400, newLength: 199 }, // The relative guard includes a current length of exactly 400.
  { currentLength: 250, newLength: 199 }, // Absolute floor alone: more than half of the current text remains.
  { currentLength: 12_409, newLength: 224 },
]

test.each(shrinkCases)(
  'test_c1_rejects_identity_shrink_with_actionable_error ($currentLength -> $newLength)',
  async ({ currentLength, newLength }) => {
    const previous = 'Я'.repeat(currentLength)
    const replacement = 'Н'.repeat(newLength)
    writeFileSync(identityPath, previous)
    const before = readIdentity(identityPath)

    let failure: unknown
    try {
      await update(replacement)
    } catch (error) {
      failure = error
    }

    expect(failure, 'the tool must report a rejected update to the model').toBeInstanceOf(Error)
    const message = String(failure)
    expect(message).toMatch(new RegExp(`\\b${currentLength}\\b`))
    expect(message).toMatch(new RegExp(`\\b${newLength}\\b`))
    expect(message).toMatch(/\bforce\b/)
    expect(message).toMatch(/reason|причин/iu)
    expect(readFileSync(identityPath, 'utf8')).toBe(previous)
    expect(readIdentity(identityPath)).toEqual(before)
  },
)

test.each(shrinkCases)(
  'test_c2_force_with_reason_archives_previous_identity ($currentLength -> $newLength)',
  async ({ currentLength, newLength }) => {
    const previous = 'Я'.repeat(currentLength - 1) + '\n'
    const replacement = 'Н'.repeat(newLength)
    const reason = 'Удалены устаревшие повторы; основные черты личности сохранены.'
    writeFileSync(identityPath, previous)
    const oldRevision = readIdentity(identityPath).revision

    await update(replacement, { force: true, reason })

    expect(readFileSync(identityPath, 'utf8')).toBe(replacement)
    expect(readIdentity(identityPath).revision).not.toBe(oldRevision)
    const files = archiveFiles()
    expect(files, 'the previous identity must be archived in memory/identity-archive').toHaveLength(1)
    const archiveName = files[0] as string
    expect(archiveName).toMatch(/^.+\.md$/)
    const archived = readFileSync(join(archiveDir, archiveName), 'utf8')
    const previousStart = archived.indexOf(previous)
    expect(previousStart, 'the archive must preserve the complete previous text').toBeGreaterThan(0)
    expect(archived.slice(0, previousStart), 'the reason must precede the previous identity').toContain(reason)
  },
)

test.each([
  { label: 'missing', extra: { force: true } },
  { label: 'empty', extra: { force: true, reason: '' } },
  { label: 'whitespace', extra: { force: true, reason: ' \n\t ' } },
])('test_c3_force_is_rejected_and_keeps_identity ($label reason)', async ({ extra }) => {
  const previous = 'Я'.repeat(800)
  writeFileSync(identityPath, previous)
  const before = readIdentity(identityPath)

  for (const newLength of [199, 500]) {
    let failure: unknown
    try {
      await update('Н'.repeat(newLength), extra)
    } catch (error) {
      failure = error
    }

    expect(failure, 'force requires a nonblank reason even when the new text has a normal length').toBeInstanceOf(Error)
    expect(readFileSync(identityPath, 'utf8')).toBe(previous)
    expect(readIdentity(identityPath)).toEqual(before)
  }
})

test.each([
  { label: 'missing_identity', previous: undefined, newLength: 10 },
  { label: 'empty_identity', previous: '', newLength: 10 },
  { label: 'exactly_half', previous: 'Я'.repeat(800), newLength: 400 },
  { label: 'exactly_200', previous: 'Я'.repeat(400), newLength: 200 },
  { label: 'below_400_current', previous: 'Я'.repeat(399), newLength: 200 },
  { label: 'ordinary_edit', previous: 'Я'.repeat(800), newLength: 700 },
  { label: 'growth', previous: 'Я'.repeat(250), newLength: 500 },
])('test_c4_allows_normal_update_without_archive ($label)', async ({ previous, newLength }) => {
  if (previous !== undefined) writeFileSync(identityPath, previous)
  const replacement = 'Н'.repeat(newLength)

  await update(replacement)

  expect(readFileSync(identityPath, 'utf8')).toBe(replacement)
  expect(readIdentity(identityPath).text).toBe(replacement)
  expect(archiveFiles(), 'an ordinary update must not archive the previous identity').toEqual([])
})
