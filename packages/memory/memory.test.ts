import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

import { createKnowledgeTool } from './src/knowledge.js'
import { createUpdateIdentityTool } from './src/tools.js'

test('M-ATOMIC rejected batches stale revisions and interrupted writes preserve prior bytes', () => {
  const file = join(dir, 'MEMORY.md')
  const store = createEntryStore(file, { limit: 30 })
  store.apply([{ op: 'add', text: 'alpha' }])
  const before = readFileSync(file)
  for (const edits of [
    [{ op: 'add' as const, text: 'x'.repeat(40) }],
    [{ op: 'add' as const, text: 'beta' }, { op: 'remove' as const, match: 'missing' }],
  ]) {
    expect(() => store.apply(edits)).toThrow()
    expect(readFileSync(file)).toEqual(before)
  }
  const identity = join(dir, 'identity.md')
  writeFileSync(identity, 'original identity')
  const { revision } = readIdentity(identity)
  writeIdentity(identity, 'new identity', revision)
  expect(() => writeIdentity(identity, 'stale replacement', revision)).toThrow()
  const identityBefore = readFileSync(identity)
  fault.failWrites = true
  try {
    expect(() => store.apply([{ op: 'add', text: 'beta' }])).toThrow('simulated write failure')
    expect(() => writeIdentity(identity, 'partial identity', readIdentity(identity).revision)).toThrow('simulated write failure')
  } finally { fault.failWrites = false }
  expect(readFileSync(file)).toEqual(before)
  expect(readFileSync(identity)).toEqual(identityBefore)
  expect(readdirSync(dir).sort()).toEqual(['MEMORY.md', 'identity.md'])
})

test('M-RESTORE archives forced identity edits and restores knowledge without losing versions', async () => {
  const identity = join(dir, 'identity.md')
  const original = 'original identity '.repeat(50)
  writeFileSync(identity, original)
  const update = createUpdateIdentityTool(identity)
  const args = { text: 'replacement', expected_revision: readIdentity(identity).revision, force: true }
  await expect(async () => update.execute(args)).rejects.toThrow()
  expect(readFileSync(identity, 'utf8')).toBe(original)
  await update.execute({ ...args, reason: 'remove duplicate history' })
  const archive = join(dir, 'identity-archive')
  const archived = readdirSync(archive)
  expect(archived).toHaveLength(1)
  expect(readFileSync(join(archive, archived[0]!), 'utf8')).toContain(original)
  expect(readFileSync(identity, 'utf8')).toBe('replacement')
  const tool = createKnowledgeTool(join(dir, 'knowledge'), { timeZone: 'UTC' })
  await tool.execute({ action: 'write', topic: 'threshold', summary: 'first', text: 'first content' })
  await tool.execute({ action: 'write', topic: 'threshold', summary: 'second', text: 'second content' })
  const history = String(await tool.execute({ action: 'history', topic: 'threshold' }))
  const selected = history.split('\n').find(line => line.includes('first')) ?? ''
  const version = selected.match(/\bthreshold-\d{4}-\d{2}-\d{2}[^\s,;|]*\.md\b/)?.[0]
    ?? selected.match(/^\s*(?:[-*]\s*)?(\d+)\s*[.):|—-]/)?.[1]
  expect(version, history).toBeDefined()
  const reopened = createKnowledgeTool(join(dir, 'knowledge'))
  await reopened.execute({ action: 'restore', topic: 'threshold', version })
  expect(String(await reopened.execute({ action: 'read', topic: 'threshold' }))).toContain('first content')
  const after = String(await reopened.execute({ action: 'history', topic: 'threshold' }))
  expect(after).toContain('first')
  expect(after).toContain('second')
})

test('M-RECALL-BOUNDARY only the exact owner turn receives private recall', async () => {
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
