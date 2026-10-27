// A state.db written before the ingress table counted processing attempts must open without errors: the old rows get
// the counter 0 and the unprocessed ones are still served by pending(). The database is built with the old schema by
// hand (the three steps of the `store` namespace as they were), then opened with the current openStore.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore } from '../src/index.js'

type Store = ReturnType<typeof openStore>

const OLD_COLUMNS = ['id', 'channel', 'external_id', 'payload', 'received_at', 'processed_at']
const COUNTER_NAME_RE = /attempt|tries|retr|crash|count/i

let dir = ''
const opened: Store[] = []

function dbPath(): string {
  return join(dir, 'state.db')
}

function seedLegacyDatabase(): void {
  const db = new DatabaseSync(dbPath())
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('CREATE TABLE _store_migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL)')
  db.exec(`CREATE TABLE ingress (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,
    external_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    processed_at INTEGER,
    UNIQUE (channel, external_id)
  )`)
  db.exec('CREATE INDEX ingress_pending_idx ON ingress (id) WHERE processed_at IS NULL')
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec("INSERT INTO _store_migrations (namespace, version) VALUES ('store', 3)")
  const insert = db.prepare(
    'INSERT INTO ingress (channel, external_id, payload, received_at, processed_at) VALUES (?, ?, ?, ?, ?)',
  )
  insert.run('telegram', '100', JSON.stringify({ n: 100 }), 1_000, 1_500)
  insert.run('telegram', '101', JSON.stringify({ n: 101 }), 2_000, null)
  insert.run('telegram', '102', JSON.stringify({ n: 102 }), 3_000, null)
  db.close()
}

function counterColumn(store: Store): string {
  const columns = (store.db.prepare('PRAGMA table_info(ingress)').all() as Array<{ name: string }>).map((c) => c.name)
  const added = columns.filter((name) => !OLD_COLUMNS.includes(name))
  expect(added.length, `the ingress table has no new column for the attempts, columns: ${columns.join(', ')}`).toBeGreaterThan(0)
  return added.find((name) => COUNTER_NAME_RE.test(name)) ?? (added[0] as string)
}

function counters(store: Store, column: string): Array<{ external_id: string; value: unknown }> {
  return store.db.prepare(`SELECT external_id, ${column} AS value FROM ingress ORDER BY id`).all() as Array<{
    external_id: string
    value: unknown
  }>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-ingress-legacy-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('test_c6_a_database_without_the_attempt_counter_opens_and_old_rows_start_at_zero', () => {
  seedLegacyDatabase()

  const store = openStore(dbPath())
  opened.push(store)

  const column = counterColumn(store)
  const rows = counters(store, column)
  expect(rows.map((row) => row.external_id)).toEqual(['100', '101', '102'])
  for (const row of rows) expect(Number(row.value), `counter of ${row.external_id}`).toBe(0)
  expect(rows.every((row) => row.value !== null)).toBe(true)
})

test('test_c6_unprocessed_rows_of_the_old_database_are_still_pending_in_order_and_new_rows_work', () => {
  seedLegacyDatabase()

  const store = openStore(dbPath())
  opened.push(store)

  const pending = store.ingress.pending()
  expect(pending.map((row) => row.externalId)).toEqual(['101', '102'])
  expect(pending.map((row) => row.payload)).toEqual([{ n: 101 }, { n: 102 }])

  const put = store.ingress.put({ channel: 'telegram', externalId: '103', payload: { n: 103 } })
  expect(put.isNew).toBe(true)
  expect(store.ingress.pending().map((row) => row.externalId)).toEqual(['101', '102', '103'])
  const column = counterColumn(store)
  expect(Number(counters(store, column).at(-1)?.value)).toBe(0)

  store.ingress.markProcessed((pending[0] as { id: number }).id)
  expect(store.ingress.pending().map((row) => row.externalId)).toEqual(['102', '103'])
})

test('test_c6_reopening_the_upgraded_database_keeps_rows_and_zero_counters', () => {
  seedLegacyDatabase()
  openStore(dbPath()).close()

  const again = openStore(dbPath())
  opened.push(again)

  const column = counterColumn(again)
  expect(counters(again, column).map((row) => Number(row.value))).toEqual([0, 0, 0])
  expect(again.ingress.pending().map((row) => row.externalId)).toEqual(['101', '102'])
})
