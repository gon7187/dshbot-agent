import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, test } from 'vitest'

import { startRecallRelay, type RecallRelay } from './src/index.js'

// The relay is given the marker of the owner's `main` session as the third
// argument of attach(): the stable text its system message starts with. Here the
// system message of `main` is exactly that text, so a check by equality, prefix
// or inclusion all see the same thing; a subagent's system message holds none of it.
const MAIN_SYSTEM = 'Ты — личный ассистент владельца. Устав, личность и правила основной сессии.'
const CHILD_SYSTEM = 'Ты — сабагент. Выполни только задачу, которую тебе дали, и верни короткий итог.'
const TURN = 'Что мы решили про оплату договора с поставщиком?\n\n<context_не_owner>память: заметка</context_не_owner>'
const BLOCK = '<recall_block_zz>2026-10-01 journal/a: оплата договора по счёту</recall_block_zz>'

interface Harness {
  relay: RecallRelay
  sent: (body: string) => Promise<string>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function harness(): Promise<Harness> {
  const bodies: string[] = []
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.close(() => resolve())
        upstream.closeAllConnections()
      }),
  )
  const port = (upstream.address() as AddressInfo).port
  const relay = await startRecallRelay({ upstream: `http://127.0.0.1:${port}` })
  if (relay === undefined) throw new Error('relay did not start')
  cleanups.push(() => relay.close())
  return {
    relay,
    async sent(body) {
      const answer = await fetch(`${relay.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      await answer.text()
      const received = bodies.at(-1)
      if (received === undefined) throw new Error('upstream got nothing')
      return received
    },
  }
}

type Attach = (turnText: string, block: string, mainSystem: string) => () => void

function attachOf(relay: RecallRelay): Attach {
  return relay.attach as unknown as Attach
}

// Indented on purpose: a request that is parsed and written back would change bytes.
function request(system: string, ...rest: Array<{ role: string; content: unknown }>): string {
  return JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'system', content: system }, ...rest] }, null, 2)
}

function lastUserText(body: string): string {
  const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages
  const last = messages.filter((message) => message.role === 'user').at(-1)
  if (last === undefined) throw new Error('no user message')
  if (typeof last.content === 'string') return last.content
  return (last.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
}

test('test_c5_a_subagent_request_with_the_full_text_of_the_owner_turn_goes_out_unchanged', async () => {
  const { relay, sent } = await harness()
  attachOf(relay)(TURN, BLOCK, MAIN_SYSTEM)

  const body = request(CHILD_SYSTEM, { role: 'user', content: TURN })
  const received = await sent(body)

  expect(received).toBe(body)
  expect(received).not.toContain('recall_block_zz')
  expect(received).not.toContain('context_recall')

  const wrapped = request(CHILD_SYSTEM, { role: 'user', content: [{ type: 'text', text: TURN }] })
  expect(await sent(wrapped)).toBe(wrapped)
})

test('test_c5_a_main_session_request_with_the_same_turn_gets_the_block', async () => {
  const { relay, sent } = await harness()
  attachOf(relay)(TURN, BLOCK, MAIN_SYSTEM)

  const received = await sent(
    request(MAIN_SYSTEM, { role: 'assistant', content: 'прошлый ответ' }, { role: 'user', content: TURN }),
  )
  const text = lastUserText(received)
  expect(text.startsWith(TURN)).toBe(true)
  expect(text).toContain(BLOCK)

  const parts = await sent(request(MAIN_SYSTEM, { role: 'user', content: [{ type: 'text', text: TURN }] }))
  expect(lastUserText(parts)).toContain(BLOCK)
  expect(lastUserText(parts).startsWith(TURN)).toBe(true)
})

test('test_c5_a_main_session_message_that_only_contains_the_turn_text_gets_no_block', async () => {
  const { relay, sent } = await harness()
  attachOf(relay)(TURN, BLOCK, MAIN_SYSTEM)

  const longer = request(MAIN_SYSTEM, { role: 'user', content: `Перешли это дальше:\n${TURN}\nконец пересылки` })
  expect(await sent(longer)).toBe(longer)

  const longerParts = request(MAIN_SYSTEM, { role: 'user', content: [{ type: 'text', text: `${TURN} и ещё` }] })
  expect(await sent(longerParts)).toBe(longerParts)

  // the turn text sits in an older user message; the last one is something else
  const older = request(
    MAIN_SYSTEM,
    { role: 'user', content: TURN },
    { role: 'assistant', content: 'ответ' },
    { role: 'user', content: 'другое сообщение' },
  )
  expect(await sent(older)).toBe(older)
})
