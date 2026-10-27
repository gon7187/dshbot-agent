// A `..` segment is refused before the path is resolved, even when the path
// would stay inside the owner's workspace after normalization
// (`downloads/../outbox/report.pdf`). The check happens before any Bot API
// request, so the positive control below proves the fake API is reached only
// when the path is clean.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'vitest'

import type { FileUpload, TelegramApi } from '../telegram/src/api.js'
import { createSendFileTool, resolveOutgoingFile } from './src/outgoing-files.js'

interface ApiCall {
  method: string
  params: Record<string, unknown> | undefined
  files: Record<string, FileUpload> | undefined
}

let scratch: string
let home: string
let workspace: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-dotdot-test-'))
  home = join(scratch, 'dshbot')
  workspace = join(home, 'workspace')
  mkdirSync(join(workspace, 'outbox'), { recursive: true })
  mkdirSync(join(workspace, 'downloads'), { recursive: true })
  writeFileSync(join(workspace, 'outbox', 'report.pdf'), Buffer.from('%PDF-1.4\nDOTDOT-BODY\n', 'latin1'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fakeApi(calls: ApiCall[]): TelegramApi {
  return {
    async call<T = unknown>(method: string, params?: Record<string, unknown>, files?: Record<string, FileUpload>): Promise<T> {
      calls.push({ method, params, files })
      return { message_id: 4242 } as T
    },
  }
}

test('a .. segment inside the workspace is refused before resolve and before the API', async () => {
  const calls: ApiCall[] = []
  const tool = createSendFileTool({
    home,
    api: fakeApi(calls),
    ownerChatId: () => 7,
  })

  const detours = [
    'downloads/../outbox/report.pdf',
    './downloads/../outbox/report.pdf',
    'downloads\\..\\outbox\\report.pdf',
    `${workspace}/downloads/../outbox/report.pdf`,
  ]
  for (const path of detours) {
    expect(() => resolveOutgoingFile(home, path), `${path} must be refused`).toThrow(/\.\./)
    await expect(tool.execute({ path }), `${path} must be refused by the tool`).rejects.toThrow(/\.\./)
  }
  expect(calls, 'a refused .. path makes no Bot API request').toEqual([])

  // positive control: the very same file without a detour is resolved and sent
  const resolved = resolveOutgoingFile(home, 'outbox/report.pdf')
  expect(resolved.name).toBe('report.pdf')
  const answer = await tool.execute({ path: 'outbox/report.pdf' })
  expect(answer).toContain('4242')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.method).toBe('sendDocument')
})
