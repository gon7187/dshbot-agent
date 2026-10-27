// The contract of the `mail` tool for sending: what it tells the model about `send` and `draft`, and that a session
// that is not the owner's main one gets neither of them. The servers here are plain TCP listeners that only count
// connections: a refused call must not even knock.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createMailTool } from './src/index.js'
import type { RunnerToolContext } from '../runner/src/index.js'

const BOX = 'personal'
const PASSWORD_ENV = 'MAIL_SEND_CONTRACT_PASSWORD'
const ACTIONS = ['list', 'read', 'save_attachment', 'checkpoint', 'send', 'draft']

let home = ''
let listeners: Server[] = []

function context(sessionId: string): RunnerToolContext {
  return { sessionId } as unknown as RunnerToolContext
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-mail-send-contract-'))
  process.env[PASSWORD_ENV] = 'contract-secret'
})

afterEach(async () => {
  for (const listener of listeners) await new Promise<void>((resolve) => listener.close(() => resolve()))
  listeners = []
  rmSync(home, { recursive: true, force: true })
})

/** A listener that counts the connections it gets and drops them. */
async function countingListener(): Promise<{ port: number; connections(): number }> {
  let connections = 0
  const server = createServer((socket: Socket) => {
    connections += 1
    socket.on('error', () => {})
    socket.destroy()
  })
  listeners.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, connections: () => connections }
}

interface Schema {
  properties?: Record<string, { enum?: unknown[] }>
}

test('test_c9_the_description_names_send_and_draft_and_says_send_needs_the_owner', () => {
  const tool = createMailTool({ home })
  expect(tool.description).toMatch(/\bsend\b/)
  expect(tool.description).toMatch(/\bdraft\b/)
  expect(tool.description, 'the description says that send waits for the owner').toMatch(
    /send[\s\S]{0,300}подтвержд|подтвержд[\s\S]{0,300}send/i,
  )

  const properties = (tool.inputSchema as Schema).properties ?? {}
  expect(properties.action?.enum, 'the schema offers the new actions').toEqual(expect.arrayContaining(['send', 'draft']))
  for (const field of ['to', 'cc', 'subject', 'text', 'attachments', 'reply_to']) {
    expect(Object.keys(properties), `the schema has the field ${field}`).toContain(field)
  }
})

test('test_c9_the_error_of_an_unknown_action_lists_send_and_draft_with_the_old_actions', async () => {
  writeFileSync(join(home, 'mail.json'), JSON.stringify({}))
  const tool = createMailTool({ home })
  let failed = ''
  try {
    await tool.execute({ action: 'forward', box: BOX }, undefined)
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error)
  }
  expect(failed, 'an unknown action is an error').not.toBe('')
  for (const action of ACTIONS) expect(failed, `the error lists ${action}`).toContain(action)
})

test('test_c8_send_is_refused_in_the_session_of_a_guest_a_subagent_and_a_task_without_a_connection', async () => {
  const smtp = await countingListener()
  const imap = await countingListener()
  writeFileSync(
    join(home, 'mail.json'),
    JSON.stringify({
      [BOX]: {
        host: '127.0.0.1',
        port: imap.port,
        login: 'owner@example.org',
        password_env: PASSWORD_ENV,
        tls: true,
        smtp: { host: '127.0.0.1', port: smtp.port },
      },
    }),
  )
  const tool = createMailTool({ home, timeoutMs: 5_000 })
  const input = { action: 'send', box: BOX, to: ['ivan@example.org'], subject: 'hi', text: 'hello' }

  for (const sessionId of ['guest-5550001', 'subagent-abc123', 'task-def456']) {
    await expect(tool.execute(input, context(sessionId)), `send in ${sessionId} is refused`).rejects.toThrow()
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(smtp.connections(), 'the SMTP port was never knocked on').toBe(0)
  expect(imap.connections(), 'the IMAP port was never knocked on').toBe(0)
})
