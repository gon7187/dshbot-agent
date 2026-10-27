import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createEntryStore, createRecallIndex, readIdentity, startRecallRelay, writeIdentity } from './src/index.js'

const fault = vi.hoisted(() => ({ failWrites: false }))

// While `fault.failWrites` is set, writes put half of the bytes on disk and then throw,
// as a crash in the middle of a write would.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (!fault.failWrites) return actual.writeFileSync(...args)
      const [file, data] = args
      const text = String(data)
      actual.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)))
      throw new Error('simulated write failure')
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (!fault.failWrites) return actual.writeSync(...args)
      throw new Error('simulated write failure')
    },
  }
})

let dir: string
let db: DatabaseSync

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-'))
  db = new DatabaseSync(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// Error text as the agent would see it: the message plus any enumerable fields (e.g. entries)
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return `${error.message} ${JSON.stringify({ ...error })}`
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

test('test_c1_apply_creates_file_with_separator_and_entries', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })

  store.apply([
    { op: 'add', text: 'a' },
    { op: 'add', text: 'b' },
  ])

  expect(existsSync(file)).toBe(true)
  expect(readFileSync(file, 'utf8').trim().split('\n§\n')).toEqual(['a', 'b'])
  expect(store.entries()).toEqual(['a', 'b'])
})

test('test_c2_oversized_batch_is_rejected_file_unchanged_error_lists_entries', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 30 })
  store.apply([{ op: 'add', text: 'alpha' }])
  const before = readFileSync(file)

  let thrown: unknown
  try {
    store.apply([{ op: 'add', text: 'x'.repeat(40) }])
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(Error)
  expect(errorText(thrown)).toContain('alpha')
  expect(readFileSync(file).equals(before)).toBe(true)
})

test('test_c3_remove_plus_add_fits_limit_even_though_add_alone_would_not', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 40 })
  store.apply([{ op: 'add', text: 'O'.repeat(30) }])

  store.apply([
    { op: 'remove', match: 'OOOO' },
    { op: 'add', text: 'N'.repeat(30) },
  ])

  expect(store.entries()).toEqual(['N'.repeat(30)])
})

test('test_c4_remove_with_zero_matches_rejects_whole_batch', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })
  store.apply([
    { op: 'add', text: 'alpha' },
    { op: 'add', text: 'beta' },
  ])
  const before = readFileSync(file)

  expect(() =>
    store.apply([
      { op: 'add', text: 'gamma' },
      { op: 'remove', match: 'zzz' },
    ]),
  ).toThrow()

  expect(readFileSync(file).equals(before)).toBe(true)
  expect(store.entries()).toEqual(['alpha', 'beta'])
})

test('test_c4_replace_with_several_matches_rejects_whole_batch', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })
  store.apply([
    { op: 'add', text: 'alpha one' },
    { op: 'add', text: 'alpha two' },
  ])
  const before = readFileSync(file)

  expect(() =>
    store.apply([
      { op: 'add', text: 'gamma' },
      { op: 'replace', match: 'alpha', text: 'x' },
    ]),
  ).toThrow()

  expect(readFileSync(file).equals(before)).toBe(true)
  expect(store.entries()).toEqual(['alpha one', 'alpha two'])
})

test('test_c5_adding_identical_text_again_does_not_duplicate', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })

  store.apply([{ op: 'add', text: 'alpha' }])
  store.apply([{ op: 'add', text: 'alpha' }])

  expect(store.entries()).toEqual(['alpha'])
})

test('test_c6_read_identity_returns_text_and_sha256_revision', () => {
  const file = join(dir, 'identity.md')
  const content = 'Я — личность.\nВторая строка.'
  writeFileSync(file, content)

  const identity = readIdentity(file)

  expect(identity.text).toBe(content)
  expect(identity.revision).toBe(sha256Hex(Buffer.from(content, 'utf8')))
})

test('test_c7_write_identity_with_current_revision_writes_text', () => {
  const file = join(dir, 'identity.md')
  writeFileSync(file, 'версия один')
  const { revision } = readIdentity(file)

  writeIdentity(file, 'версия два', revision)

  expect(readIdentity(file).text).toBe('версия два')
})

test('test_c7_write_identity_with_stale_revision_throws_and_keeps_file', () => {
  const file = join(dir, 'identity.md')
  writeFileSync(file, 'версия один')
  const stale = readIdentity(file).revision
  writeIdentity(file, 'версия два', stale)
  const before = readFileSync(file)

  expect(() => writeIdentity(file, 'версия три', stale)).toThrow()

  expect(readFileSync(file).equals(before)).toBe(true)
  expect(readIdentity(file).text).toBe('версия два')
})

test('test_c8_write_identity_rejects_empty_or_blank_text_and_keeps_file', () => {
  const file = join(dir, 'identity.md')
  writeFileSync(file, 'личность')
  const { revision } = readIdentity(file)
  const before = readFileSync(file)

  expect(() => writeIdentity(file, '', revision)).toThrow()
  expect(() => writeIdentity(file, ' \n\t ', revision)).toThrow()

  expect(readFileSync(file).equals(before)).toBe(true)
})

test('test_c9_search_finds_document_with_fields_and_snippet', () => {
  const index = createRecallIndex(db)
  index.index({ id: 'chat-1', source: 'telegram', kind: 'chat', text: 'Владелец спросил про погоду в Казани', ts: 1700000000000 })

  const hits = index.search('погоду', { limit: 10 })

  expect(hits).toHaveLength(1)
  expect(hits[0]).toMatchObject({ id: 'chat-1', source: 'telegram', kind: 'chat', ts: 1700000000000 })
  expect(JSON.stringify(hits[0])).toContain('погоду')
})

test('test_c10_reindex_with_same_id_replaces_document', () => {
  const index = createRecallIndex(db)
  index.index({ id: 'doc-1', source: 'journal', kind: 'journal', text: 'старый текст про кошку', ts: 1 })
  index.index({ id: 'doc-1', source: 'journal', kind: 'journal', text: 'новый текст про собаку', ts: 2 })

  expect(index.search('кошку', { limit: 10 }).map((hit) => hit.id)).not.toContain('doc-1')
  expect(index.search('собаку', { limit: 10 }).map((hit) => hit.id)).toContain('doc-1')
})

test('test_c11_schedule_ranks_below_journal_for_equal_text', () => {
  const index = createRecallIndex(db)
  // schedule is indexed first so insertion order does not explain the expected ranking
  index.index({ id: 'sched-1', source: 'cron', kind: 'schedule', text: 'проверить сервер утром', ts: 1 })
  index.index({ id: 'journal-1', source: 'owner', kind: 'journal', text: 'проверить сервер утром', ts: 1 })

  const ids = index.search('сервер', { limit: 10 }).map((hit) => hit.id)

  expect(ids).toContain('journal-1')
  expect(ids).toContain('sched-1')
  expect(ids.indexOf('journal-1')).toBeLessThan(ids.indexOf('sched-1'))
})

test('test_c12_search_with_fts_special_characters_does_not_throw', () => {
  const index = createRecallIndex(db)
  index.index({ id: 'doc-1', source: 'telegram', kind: 'chat', text: 'кто-то написал "привет" в чат', ts: 1 })

  for (const query of ['"привет', 'при*', 'time:12', 'кто-то', 'NEAR(', '"', '-', '*', ':', 'a"b*c:d-e']) {
    expect(() => index.search(query, { limit: 5 })).not.toThrow()
  }
})

test('test_c13_search_respects_limit', () => {
  const index = createRecallIndex(db)
  index.index({ id: 'doc-1', source: 'journal', kind: 'journal', text: 'отчёт один', ts: 1 })
  index.index({ id: 'doc-2', source: 'journal', kind: 'journal', text: 'отчёт два', ts: 2 })
  index.index({ id: 'doc-3', source: 'journal', kind: 'journal', text: 'отчёт три', ts: 3 })

  expect(index.search('отчёт', { limit: 2 })).toHaveLength(2)
})

test('test_c1_atomic_identity_write_replaces_file_inode_and_leaves_no_temp_file', () => {
  const file = join(dir, 'identity.md')
  writeFileSync(file, 'версия один')
  const { revision } = readIdentity(file)
  const inodeBefore = statSync(file).ino

  writeIdentity(file, 'версия два', revision)

  expect(statSync(file).ino).not.toBe(inodeBefore)
  expect(readFileSync(file, 'utf8')).toBe('версия два')
  expect(readdirSync(dir)).toEqual(['identity.md'])
})

test('test_c2_atomic_apply_replaces_memory_file_inode_and_leaves_no_temp_file', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })
  store.apply([{ op: 'add', text: 'alpha' }])
  const inodeBefore = statSync(file).ino

  store.apply([{ op: 'add', text: 'beta' }])

  expect(statSync(file).ino).not.toBe(inodeBefore)
  expect(readFileSync(file, 'utf8').split('\n§\n')).toEqual(['alpha', 'beta'])
  expect(store.entries()).toEqual(['alpha', 'beta'])
  expect(readdirSync(dir)).toEqual(['MEMORY.md'])
})

test('test_c3_atomic_identity_write_failure_rethrows_keeps_bytes_and_leaves_no_temp_file', () => {
  const file = join(dir, 'identity.md')
  writeFileSync(file, 'личность до сбоя')
  const { revision } = readIdentity(file)
  const before = readFileSync(file)

  fault.failWrites = true
  try {
    expect(() => writeIdentity(file, 'личность после сбоя', revision)).toThrow(/simulated write failure/)
  } finally {
    fault.failWrites = false
  }

  expect(readFileSync(file).equals(before)).toBe(true)
  expect(readdirSync(dir)).toEqual(['identity.md'])
})

test('test_c4_atomic_apply_write_failure_rethrows_keeps_bytes_and_leaves_no_temp_file', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 1000 })
  store.apply([{ op: 'add', text: 'alpha' }])
  const before = readFileSync(file)

  fault.failWrites = true
  try {
    expect(() => store.apply([{ op: 'add', text: 'beta' }])).toThrow(/simulated write failure/)
  } finally {
    fault.failWrites = false
  }

  expect(readFileSync(file).equals(before)).toBe(true)
  expect(readdirSync(dir)).toEqual(['MEMORY.md'])
})

test('test_c5_the_relay_uses_the_top_level_system_marker_and_needs_the_whole_turn', async () => {
  const received: string[] = []
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const port = (upstream.address() as AddressInfo).port
  const relay = await startRecallRelay({ upstream: `http://127.0.0.1:${port}` })
  if (relay === undefined) throw new Error('relay did not start')

  const mainSystem = 'Ты — личный ассистент владельца. Устав и правила основной сессии.'
  const childSystem = 'Ты — субагент. Выполни только задачу, которую тебе дали.'
  const turn = 'Что мы решили про оплату договора с поставщиком?'
  const block = '<recall_block_zz>2026-10-01 journal/a: оплата договора</recall_block_zz>'
  const send = async (body: string): Promise<string> => {
    const answer = await fetch(`${relay.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    await answer.text()
    const seen = received.at(-1)
    if (seen === undefined) throw new Error('upstream got nothing')
    return seen
  }

  try {
    relay.attach(turn, block, mainSystem)

    const child = JSON.stringify({ model: 'm', system: childSystem, messages: [{ role: 'user', content: turn }] })
    expect(await send(child)).toBe(child)

    const quoted = JSON.stringify({ model: 'm', system: mainSystem, messages: [{ role: 'user', content: `перешли: ${turn}` }] })
    expect(await send(quoted)).toBe(quoted)

    // The daemon route carries the prompt in the top-level `system` field; a
    // later section after the persona marker does not make it another session.
    const main = JSON.stringify({
      model: 'm',
      system: `${mainSystem}\n\nДополнительный раздел`,
      messages: [{ role: 'user', content: turn }],
    })
    const got = await send(main)
    expect(got).not.toBe(main)
    expect(got).toContain(turn)
    expect(got).toContain(block)
  } finally {
    await relay.close()
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve())
      upstream.closeAllConnections()
    })
  }
})
