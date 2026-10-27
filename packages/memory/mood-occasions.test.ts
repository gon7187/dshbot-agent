import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, expect, test } from 'vitest'

import { buildMoodOccasions, countToolErrors, MOOD_OCCASIONS_HEADER } from './src/index.js'

const SINCE = 1_000_000
const NOW = 2_000_000

/** One tool call and its result, as the agent loop appends them to events.jsonl. */
function call(id: string, name: string, text: string, options: { isError?: boolean; time?: number } = {}): string[] {
  const time = options.time ?? SINCE + 1000
  return [
    JSON.stringify({ type: 'tool/call', time, data: { turn: 1, step: 0, callId: id, name, arguments: '{}' } }),
    JSON.stringify({
      type: 'tool/result',
      time: time + 1,
      data: {
        turn: 1,
        step: 0,
        message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text }], isError: options.isError === true },
      },
    }),
  ]
}

function log(...calls: string[][]): string {
  return calls.flat().join('\n') + '\n'
}

test('exec with a non-zero exit, a timeout or a signal is a tool error, exit 0 and /stop are not', () => {
  const text = log(
    call('a', 'exec', 'exit 3\n--- stderr ---\nboom'),
    call('b', 'exec', 'Таймаут: команда и её дочерние процессы убиты через 1 с.\n'),
    call('c', 'exec', 'signal SIGKILL\n'),
    call('d', 'exec', 'exit 0\n--- stdout ---\nok'),
    call('e', 'exec', 'Команда прервана.\n'),
  )
  expect(countToolErrors(text, SINCE, NOW)).toBe(3)
  // Positive control: each failing exec alone is counted once.
  expect(countToolErrors(log(call('a', 'exec', 'exit 3')), SINCE, NOW)).toBe(1)
  expect(countToolErrors(log(call('b', 'exec', 'Таймаут: команда убита через 1 с.')), SINCE, NOW)).toBe(1)
  expect(countToolErrors(log(call('d', 'exec', 'exit 0')), SINCE, NOW)).toBe(0)
})

test('host_exec status line counts as a tool error too, exit 0 does not', () => {
  const text = log(
    call('a', 'host_exec', 'exit 1\n--- stderr ---\nls: cannot access /nope'),
    call('b', 'host_exec', 'Таймаут: команда убита через 2 с.\n(нет вывода)'),
    call('c', 'host_exec', 'Завершено сигналом SIGKILL.\n(нет вывода)'),
    // Only the first line is the status: failure-looking output is not a failure.
    call('d', 'host_exec', 'exit 0\n--- stdout ---\nexit 1'),
    call('e', 'read', 'exit 1'),
  )
  expect(countToolErrors(text, SINCE, NOW)).toBe(3)
})

test('isError counts for any tool; an exit line of another tool is no exec failure', () => {
  const text = log(
    call('r', 'read', 'ENOENT: no such file', { isError: true }),
    call('w', 'web_fetch', 'exit 1'),
  )
  expect(countToolErrors(text, SINCE, NOW)).toBe(1)
})

test('only results inside the window are counted, broken lines are skipped', () => {
  const text = log(
    call('old', 'exec', 'exit 1', { time: SINCE - 10 }),
    call('new', 'exec', 'exit 1'),
    call('late', 'exec', 'exit 1', { time: NOW + 10 }),
  ) + '{not json\n'
  expect(countToolErrors(text, SINCE, NOW)).toBe(1)
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('the block lists only non-zero facts and is absent without any', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mood-occasions-'))
  dirs.push(dir)
  const db = new DatabaseSync(':memory:')
  const boundary = { ingressId: 0, taskEventId: 0, at: SINCE }
  const empty = join(dir, 'empty.jsonl')
  writeFileSync(empty, log(call('ok', 'exec', 'exit 0')))
  expect(buildMoodOccasions({ db, boundary, now: NOW, ownerChatId: null, sessionLogPath: empty })).toBe('')

  const failing = join(dir, 'failing.jsonl')
  writeFileSync(failing, log(call('x', 'exec', 'exit 2'), call('y', 'exec', 'Таймаут: убита через 1 с.')))
  const block = buildMoodOccasions({
    db,
    boundary,
    now: NOW,
    ownerChatId: null,
    sessionLogPath: failing,
    rejectedCards: [SINCE - 1, SINCE + 5],
  })
  expect(block.split('\n')).toEqual([MOOD_OCCASIONS_HEADER, '- Отклонённых карточек: 1', '- Ошибок инструментов: 2'])
  db.close()
})

test('the silence of the owner is told in hours and without «молч», the word of the silent wake-ups line', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE ingress (id INTEGER PRIMARY KEY, channel TEXT, payload TEXT, received_at INTEGER)')
  const owner = 42
  const sentAt = 1_000
  const payload = { message: { message_id: 1, chat: { id: owner }, from: { id: owner, is_bot: false }, text: 'ок' } }
  db.prepare('INSERT INTO ingress (id, channel, payload, received_at) VALUES (1, ?, ?, ?)').run('telegram', JSON.stringify(payload), sentAt)
  const boundary = { ingressId: 1, taskEventId: 0, at: sentAt }
  const block = buildMoodOccasions({ db, boundary, now: sentAt + 4.25 * 3_600_000, ownerChatId: owner })
  expect(block.split('\n')).toEqual([MOOD_OCCASIONS_HEADER, '- Владелец не пишет 4,3 ч'])
  expect(block, 'the wake-up keeps «молч» for the silent wake-ups of the bot').not.toMatch(/молч/i)
  // Six minutes are the threshold: a reply that has just arrived is no silence.
  expect(buildMoodOccasions({ db, boundary, now: sentAt + 359_999, ownerChatId: owner })).toBe('')
  db.close()
})
