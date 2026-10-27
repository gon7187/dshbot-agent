import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { openStore } from '../src/index.js'
import { createRepeatOfferAutomation, type RepeatOfferAutomation } from '../../app/src/repeat-offer.js'

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

test('test_c1_openStore creates a missing database file and enables WAL', () => {
  expect(existsSync(dbPath())).toBe(false)

  const store = track(openStore(dbPath()))

  expect(existsSync(dbPath())).toBe(true)
  const row = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined
  expect(row?.journal_mode).toBe('wal')
})

test('test_c2_migrate applies each new step once and only the new suffix on later calls', () => {
  const store = track(openStore(dbPath()))
  const s1 = 'CREATE TABLE c2_one (id INTEGER PRIMARY KEY)'
  const s2 = 'CREATE TABLE c2_two (id INTEGER PRIMARY KEY)'
  const s3 = 'CREATE TABLE c2_three (id INTEGER PRIMARY KEY)'

  expect(() => store.migrate('x', [s1, s2])).not.toThrow()
  expect(tableNames(store)).toContain('c2_one')
  expect(tableNames(store)).toContain('c2_two')

  // Re-running s1 and s2 would fail with "table already exists", so a clean call proves they were skipped
  expect(() => store.migrate('x', [s1, s2])).not.toThrow()

  expect(() => store.migrate('x', [s1, s2, s3])).not.toThrow()
  expect(tableNames(store)).toContain('c2_three')
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
})

test('test_c4_namespace versions are independent', () => {
  const store = track(openStore(dbPath()))
  expect(() => store.migrate('a', ['CREATE TABLE c4_a (id INTEGER PRIMARY KEY)'])).not.toThrow()

  // Namespace "a" has one applied step; if versions were shared, "b" would skip its first step
  expect(() =>
    store.migrate('b', ['CREATE TABLE c4_b1 (id INTEGER PRIMARY KEY)', 'CREATE TABLE c4_b2 (id INTEGER PRIMARY KEY)']),
  ).not.toThrow()
  expect(tableNames(store)).toContain('c4_b1')
  expect(tableNames(store)).toContain('c4_b2')
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
})

test('test_c6_ingress.pending returns unprocessed rows in arrival order with object payloads', () => {
  const store = track(openStore(dbPath()))
  const a = store.ingress.put({ channel: 'telegram', externalId: '1', payload: { n: 1 } })
  const b = store.ingress.put({ channel: 'telegram', externalId: '2', payload: { n: 2 } })
  const c = store.ingress.put({ channel: 'telegram', externalId: '3', payload: { n: 3 } })

  const before = store.ingress.pending()
  expect(before.map((row) => row.id)).toEqual([a.id, b.id, c.id])
  expect(before.map((row) => row.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])

  store.ingress.markProcessed(b.id)
  expect(store.ingress.pending().map((row) => row.id)).toEqual([a.id, c.id])
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

test('test_c8_kv.get returns undefined for a missing key and set overwrites the value', () => {
  const store = track(openStore(dbPath()))
  expect(store.kv.get('mode')).toBeUndefined()

  store.kv.set('mode', 'first')
  expect(store.kv.get('mode')).toBe('first')

  store.kv.set('mode', 'second')
  expect(store.kv.get('mode')).toBe('second')
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

test('test_c10_approvals remove is by id and the rows survive close and reopen', () => {
  const first = openStore(dbPath())
  const exec = first.approvals.add('exec', '', 'echo keep')
  const host = first.approvals.add('host', 'prod', 'echo drop')
  first.close()

  const store = track(openStore(dbPath()))
  expect(store.approvals.list().map((row) => row.command)).toEqual(['echo keep', 'echo drop'])
  expect(store.approvals.remove(host.id)).toBe(true)
  expect(store.approvals.remove(host.id)).toBe(false)
  expect(store.approvals.list().map((row) => row.command)).toEqual(['echo keep'])
  expect(store.approvals.has('host', 'prod', 'echo drop')).toBe(false)
  expect(store.approvals.has('exec', '', 'echo keep')).toBe(true)
  expect(exec.id).toBeGreaterThan(0)
})

test('test_c5_approvals a revoked id is never handed out again, so a stale revoke cannot hit a newer permission', () => {
  const store = track(openStore(dbPath()))
  const a = store.approvals.add('host', 'prod', 'echo A')
  expect(store.approvals.remove(a.id)).toBe(true)

  // the table is empty again: a reused rowid would give B the id of A
  const b = store.approvals.add('host', 'prod', 'echo B')
  expect(b.id, 'a new permission does not take the id of a revoked one').not.toBe(a.id)
  const again = store.approvals.add('host', 'prod', 'echo A')
  expect(again.id, 'granting the same command again gives it a fresh id').not.toBe(a.id)

  // the second "Отозвать" button of A from an older /approvals list
  expect(store.approvals.remove(a.id)).toBe(false)
  expect(store.approvals.has('host', 'prod', 'echo B')).toBe(true)
  expect(store.approvals.has('host', 'prod', 'echo A')).toBe(true)
  expect(store.approvals.list().map((row) => row.command)).toEqual(['echo B', 'echo A'])
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

// The repeat-offer choice over a real store: a silenced tool leaves the
// comparison before one tool is picked, so it never hides another match.
const REPEAT_ZONE = 'Europe/Moscow'
const YESTERDAY_10_07 = Date.UTC(2026, 9, 24, 7, 7)
const TODAY_10_31 = Date.UTC(2026, 9, 25, 7, 31)

function repeatOffersOf(store: Store): RepeatOfferAutomation {
  const schedules = { list: () => [] } as unknown as Parameters<typeof createRepeatOfferAutomation>[0]['schedules']
  return createRepeatOfferAutomation({ store: store.repeatOffers, schedules, timeZone: REPEAT_ZONE })
}

function observeTwoDays(offers: RepeatOfferAutomation, tools: string[]): ReturnType<RepeatOfferAutomation['observe']> {
  const first = offers.observe({ chatId: 1, startedAt: YESTERDAY_10_07, request: 'статистика WB', tools, now: YESTERDAY_10_07 })
  expect(first, 'the first day has nothing to compare with').toBeUndefined()
  return offers.observe({ chatId: 1, startedAt: TODAY_10_31, request: 'статистика WB', tools, now: TODAY_10_31 })
}

test('test_c1_repeat_offer a tool silenced for good does not hide another matching tool of the turn', () => {
  const store = track(openStore(dbPath()))
  store.repeatOffers.suppress('mcp__s__a', null, YESTERDAY_10_07 - 1000)
  const card = observeTwoDays(repeatOffersOf(store), ['mcp__s__a', 'mcp__s__b'])
  expect(card?.card.tool).toBe('mcp__s__b')
  expect(card?.card.time).toBe('10:05')
  expect(card?.text).toContain('статистика WB')
})

test('test_c1_repeat_offer a tool declined for a week does not hide another matching tool of the turn', () => {
  const store = track(openStore(dbPath()))
  const offers = repeatOffersOf(store)
  const old = store.repeatOffers.addCard({ chatId: 1, tool: 'mcp__s__a', time: '09:00', request: 'старый', createdAt: YESTERDAY_10_07 - 1000 })
  expect(offers.decide({ cardId: old.id, chatId: 1, decision: 'no', now: YESTERDAY_10_07 - 1000 })?.card.status).toBe('declined')
  const card = observeTwoDays(offers, ['mcp__s__a', 'mcp__s__b'])
  expect(card?.card.tool).toBe('mcp__s__b')
})

test('test_c4_repeat_offer no card while every matching tool of the turn is silenced', () => {
  const store = track(openStore(dbPath()))
  store.repeatOffers.suppress('mcp__s__a', null, YESTERDAY_10_07 - 1000)
  store.repeatOffers.suppress('mcp__s__b', TODAY_10_31 + 86_400_000, YESTERDAY_10_07 - 1000)
  expect(observeTwoDays(repeatOffersOf(store), ['mcp__s__a', 'mcp__s__b'])).toBeUndefined()
})

test('test_c6_repeat_offer two allowed matching tools still give one card', () => {
  const store = track(openStore(dbPath()))
  const card = observeTwoDays(repeatOffersOf(store), ['mcp__s__b', 'mcp__s__a'])
  expect(card?.card.tool).toBe('mcp__s__a')
  const cards = store.db.prepare('SELECT COUNT(*) AS n FROM repeat_offer_cards').get() as { n: number }
  expect(Number(cards.n)).toBe(1)
})

test('c1 a new database and its WAL files are private even with a permissive umask', () => {
  const previousUmask = process.umask(0o022)
  try {
    const store = track(openStore(dbPath()))
    store.kv.set('private', 'dialogue')
    for (const path of [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]) {
      expect(existsSync(path), path).toBe(true)
      expect(statSync(path).mode & 0o777, path).toBe(0o600)
    }
  } finally {
    process.umask(previousUmask)
  }
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

test('c3 an in-memory store still supports reads and writes', () => {
  const store = track(openStore(':memory:'))
  store.kv.set('private', 'dialogue')
  expect(store.kv.get('private')).toBe('dialogue')
})
