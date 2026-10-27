import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The table row of DSHBOT_AUTO_COMPACT_TOKENS in a configuration document. */
function thresholdRow(path: string): string {
  const row = readFileSync(join(root, path), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes('`DSHBOT_AUTO_COMPACT_TOKENS`'))
  expect(row, `${path}: описание DSHBOT_AUTO_COMPACT_TOKENS отсутствует`).toBeDefined()
  return row as string
}

// c8: the threshold row tells that the owner turn waits for compaction only at twice the threshold or above,
// and that below that the compaction runs in the idle time. Keyword-level check, wording is free.
test('test_c8_config_docs_say_owner_turn_waits_for_compaction_only_at_twice_the_threshold', () => {
  const ru = thresholdRow('docs/CONFIG.md')
  expect(ru).toMatch(/вдвое|удво|двукрат|2\s*[×x*]|в\s*два\s*раза/i)
  expect(ru).toMatch(/простое|простоя/i)

  const en = thresholdRow('docs/en/CONFIG.md')
  expect(en).toMatch(/twice|double|2\s*[×x*]|two times/i)
  expect(en).toMatch(/idle/i)
})
