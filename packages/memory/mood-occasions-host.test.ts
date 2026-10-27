import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect, test } from 'vitest'

import { buildMoodOccasions, countToolErrors, MOOD_OCCASIONS_HEADER } from './src/index.js'

const SINCE = 1_000_000
const NOW = 2_000_000

// The same tool/call -> tool/result envelope used in mood-occasions.test.ts.
// host_exec returns these statuses as ordinary text, without isError.
function call(id: string, name: string, text: string): string[] {
  return [
    JSON.stringify({ type: 'tool/call', time: SINCE + 1000, data: { turn: 1, step: 0, callId: id, name, arguments: '{}' } }),
    JSON.stringify({
      type: 'tool/result',
      time: SINCE + 1001,
      data: {
        turn: 1,
        step: 0,
        message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError: false },
      },
    }),
  ]
}

test.each([
  { status: 'exit 1', text: 'exit 1\n--- stderr ---\ncommand failed' },
  { status: 'timeout', text: 'Таймаут: команда убита через 1 с.\n(нет вывода)' },
  { status: 'signal', text: 'Завершено сигналом SIGTERM.\n(нет вывода)' },
])('test_c3_host_exec_$status: failure is a mood occasion like exec', ({ text }) => {
  const dir = mkdtempSync(join(tmpdir(), 'mood-host-occasions-'))
  const db = new DatabaseSync(':memory:')
  try {
    const controls = [
      // Status is the first line: failure-looking stdout is not a failed call.
      call('ok', 'host_exec', `exit 0\n${text}`),
      call('other', 'web_fetch', text),
    ]
    const hostLog = [...call('failed', 'host_exec', text), ...controls.flat()].join('\n') + '\n'
    const execLog = [...call('failed', 'exec', text), ...controls.flat()].join('\n') + '\n'
    expect(countToolErrors(execLog, SINCE, NOW), 'exec already recognizes this failure status').toBe(1)
    expect(countToolErrors(hostLog, SINCE, NOW), 'host_exec must recognize the same failure exactly once').toBe(1)

    const sessionLogPath = join(dir, 'events.jsonl')
    writeFileSync(sessionLogPath, hostLog)
    const block = buildMoodOccasions({
      db,
      boundary: { ingressId: 0, taskEventId: 0, at: SINCE },
      now: NOW,
      ownerChatId: null,
      sessionLogPath,
    })
    expect(block.split('\n')).toEqual([MOOD_OCCASIONS_HEADER, '- Ошибок инструментов: 1'])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
