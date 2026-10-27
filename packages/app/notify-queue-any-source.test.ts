// A collector card names its source with any non-empty string: the queue has no list of known sources.
// The queue runs in this process against a fake Telegram API and a scratch directory.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { TelegramApi } from '../telegram/src/api.js'
import { createNotifyQueue } from './src/notify-queue.js'

const SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'src', 'notify-queue.ts')
const OWNER_CHAT = 7
const NOW_MS = 1_800_000_000_000

interface Sent {
  method: string
  params: Record<string, unknown>
}

let scratch: string
let queueDir: string
let sent: Sent[]
let logged: string[]

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-notify-source-'))
  queueDir = join(scratch, 'notification-queue')
  mkdirSync(queueDir, { recursive: true })
  sent = []
  logged = []
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function drop(card: Record<string, unknown>): string {
  const raw = JSON.stringify(card)
  const name = `${createHash('sha256').update(raw).digest('hex')}.json`
  writeFileSync(join(queueDir, name), raw)
  return name
}

async function drain(): Promise<void> {
  const api: TelegramApi = {
    call: <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      sent.push({ method, params })
      return Promise.resolve({ message_id: 100 + sent.length } as T)
    },
  }
  const queue = createNotifyQueue({
    home: scratch,
    api,
    ownerChatId: () => OWNER_CHAT,
    log: (message) => logged.push(message),
    env: { DSHBOT_NOTIFY_QUEUE: queueDir },
    now: () => NOW_MS,
  })
  await queue.tick()
}

function card(source: string, id: string): Record<string, unknown> {
  return {
    notification_id: id,
    source,
    category: 'report.daily',
    observed_at: NOW_MS / 1000 - 60,
    title: 'Итог дня',
    summary: 'Всё спокойно.',
  }
}

test('test_c5_card_of_an_unlisted_source_is_delivered_like_a_card_of_a_former_listed_one', async () => {
  const custom = drop(card('my-collector', 'ntf-custom'))
  await drain()
  const customSent = sent.map((entry) => ({ method: entry.method, params: entry.params }))
  expect(customSent.length, `the card is sent\n${logged.join('\n')}`).toBeGreaterThan(0)
  expect(existsSync(join(queueDir, `${custom}.accepted`)), 'the card is accepted').toBe(true)
  expect(existsSync(join(queueDir, `${custom}.rejected`)), 'the card is not rejected').toBe(false)

  sent = []
  const former = drop(card('wb', 'ntf-custom'))
  await drain()
  expect(sent, 'the same text reaches the owner for both sources').toEqual(customSent)
  expect(existsSync(join(queueDir, `${former}.accepted`))).toBe(true)

  // An old card of the new source is summarised under its own name.
  sent = []
  drop({ ...card('my-collector', 'ntf-old'), observed_at: NOW_MS / 1000 - 3 * 24 * 3600 })
  await drain()
  expect(sent.map((entry) => String(entry.params.text)).join('\n')).toContain('my-collector')
})

test('test_c5_the_queue_source_declares_no_closed_list_of_collector_names', () => {
  const text = readFileSync(SOURCE_FILE, 'utf8')
  expect(text).not.toMatch(/'yandex'\s*\|\s*'exchange'\s*\|\s*'bitrix'\s*\|\s*'wb'/)
  const quoted = ['yandex', 'exchange', 'bitrix', 'wb'].filter((name) => text.includes(`'${name}'`))
  expect(quoted, 'no collector name is spelled out as a literal').toEqual([])
})
