import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../src/index.js'

type Store = ReturnType<typeof openStore>

let dir = ''
const opened: Store[] = []

function dbPath(): string {
  return join(dir, 'state.sqlite')
}

function track(store: Store): Store {
  opened.push(store)
  return store
}

function tableNames(store: Store): string[] {
  const rows = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  return rows.map((row) => row.name)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-test-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('test_c3_failing step throws, leaves no objects from that step, and applies after the step is fixed', () => {
  const store = track(openStore(dbPath()))
  const ok = 'CREATE TABLE c3_ok (id INTEGER PRIMARY KEY)'
  const broken = 'CREATE TABLE c3_half (id INTEGER PRIMARY KEY);\nNOT VALID SQL;'
  const fixed = 'CREATE TABLE c3_half (id INTEGER PRIMARY KEY)'

  expect(() => store.migrate('x', [ok, broken])).toThrow()
  expect(tableNames(store)).not.toContain('c3_half')

  expect(() => store.migrate('x', [ok, fixed])).not.toThrow()
  expect(tableNames(store)).toContain('c3_half')
  expect(() => store.migrate('x', [ok, fixed])).not.toThrow()
  store.migrate('other', ['CREATE TABLE independent (id INTEGER)'])
  expect(tableNames(store)).toContain('independent')
})

test('test_c5_ingress.put returns isNew true for a new pair and the same id with isNew false on repeat', () => {
  const store = track(openStore(dbPath()))
  const payload = { text: 'hi' }

  const first = store.ingress.put({ channel: 'telegram', externalId: '42', payload })
  expect(first.isNew).toBe(true)

  const second = store.ingress.put({ channel: 'telegram', externalId: '42', payload })
  expect(second.isNew).toBe(false)
  expect(second.id).toBe(first.id)

  expect(store.ingress.pending()).toHaveLength(1)
  const third = store.ingress.put({ channel: 'telegram', externalId: '43', payload: { n: 2 } })
  expect(store.ingress.pending().map((row) => row.id)).toEqual([first.id, third.id])
  store.ingress.markProcessed(first.id)
  expect(store.ingress.pending().map((row) => row.id)).toEqual([third.id])
})

test('test_c7_ingress rows and kv values survive close and reopen of the same file', () => {
  const first = openStore(dbPath())
  first.ingress.put({ channel: 'telegram', externalId: '7', payload: { text: 'persist me' } })
  first.kv.set('offset', '101')
  first.close()

  const store = track(openStore(dbPath()))
  const pending = store.ingress.pending()
  expect(pending).toHaveLength(1)
  expect(pending[0]?.payload).toEqual({ text: 'persist me' })
  expect(store.kv.get('offset')).toBe('101')
})

test('test_c9_approvals keep an exact kind, host and command and ignore a repeat', () => {
  const store = track(openStore(dbPath()))
  expect(store.approvals.list()).toEqual([])

  const exec = store.approvals.add('exec', '', 'rm -rf build', 1_700_000_000_000)
  const host = store.approvals.add('host', 'prod', 'systemctl restart nginx', 1_700_000_000_001)
  const repeated = store.approvals.add('exec', '', 'rm -rf build', 1_800_000_000_000)

  expect(exec.createdAt).toBe(1_700_000_000_000)
  expect(repeated.id).toBe(exec.id)
  expect(repeated.createdAt, 'the first date of a permission is kept').toBe(1_700_000_000_000)
  expect(store.approvals.list().map((row) => row.id)).toEqual([exec.id, host.id])
  expect(store.approvals.has('exec', '', 'rm -rf build')).toBe(true)
  expect(store.approvals.has('exec', '', 'rm -rf build ')).toBe(false)
  expect(store.approvals.has('exec', 'prod', 'rm -rf build')).toBe(false)
  expect(store.approvals.has('host', 'prod', 'systemctl restart nginx')).toBe(true)
  expect(store.approvals.has('host', 'staging', 'systemctl restart nginx')).toBe(false)
})

test('test_c5_approvals ids stay unique across close and reopen after the newest row is revoked', () => {
  const first = openStore(dbPath())
  const a = first.approvals.add('exec', '', 'echo A')
  first.approvals.remove(a.id)
  first.close()

  const store = track(openStore(dbPath()))
  const b = store.approvals.add('exec', '', 'echo B')
  expect(b.id).toBeGreaterThan(a.id)
  expect(store.approvals.remove(a.id)).toBe(false)
  expect(store.approvals.has('exec', '', 'echo B')).toBe(true)
})

test('c2 opening an existing database tightens all existing files and preserves data', () => {
  const first = track(openStore(dbPath()))
  first.kv.set('private', 'dialogue')
  const paths = [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]
  for (const path of paths) {
    expect(existsSync(path), path).toBe(true)
    chmodSync(path, 0o644)
    expect(statSync(path).mode & 0o777, path).toBe(0o644)
  }

  const reopened = track(openStore(dbPath()))
  expect(reopened.kv.get('private')).toBe('dialogue')
  for (const path of paths) expect(statSync(path).mode & 0o777, path).toBe(0o600)
})

const OLD_COLUMNS = ['id', 'channel', 'external_id', 'payload', 'received_at', 'processed_at']
const COUNTER_NAME_RE = /attempt|tries|retr|crash|count/i

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

test('legacy ingress counters upgrade once without losing ordered pending rows', () => {
  seedLegacyDatabase()
  const first = openStore(dbPath())
  const column = counterColumn(first)
  expect(counters(first, column).map((row) => Number(row.value))).toEqual([0, 0, 0])
  expect(first.ingress.pending().map((row) => row.externalId)).toEqual(['101', '102'])
  const head = first.ingress.pending()[0]!
  first.ingress.markProcessed(head.id)
  first.ingress.put({ channel: 'telegram', externalId: '103', payload: { n: 103 } })
  first.close()
  const reopened = track(openStore(dbPath()))
  expect(reopened.ingress.pending().map((row) => row.externalId)).toEqual(['102', '103'])
  expect(counters(reopened, column).every((row) => Number(row.value) === 0)).toBe(true)
})
