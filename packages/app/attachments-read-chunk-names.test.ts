// read_file_chunk takes the file name of its own intake. Live case: the model called the tool with the bare name
// from the `<file>` block, the path was resolved from the cwd of the process and never reached the inbox.
//
// The real attachment intake runs in process against a fake Telegram API and a fake runner: the runner stands in
// for the model turn, records the prompt of the analysis and calls the tools of the intake the way the harness
// does (arguments plus a context with the session id of the intake).

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'

import type { Runner, RunnerTool } from '../runner/src/index.js'
import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import type { NormalizedAttachment } from '../telegram/src/update.js'
import { createAttachmentIntake, type AttachmentIntake } from './src/attachments.js'

const OWNER_CHAT = 7
const WAIT_MS = 30_000
const IDLE_STATUS = 'Идущих разборов вложений нет.'

const REPORT_NAME = 'отчёт 15–21.10.xlsx'
const REPORT_BODY = 'REPORT-BODY-179 строка один\nстрока два'
const NOTES_NAME = 'заметки.txt'
const NOTES_BODY = 'NOTES-BODY-179 заметки владельца'

interface Upload {
  name: string
  body: string
  mime: string
}

interface Attempt {
  value?: string
  error?: string
}

interface Probe {
  /** The prompt of the analysis turn. */
  prompt: string
  home: string
  /** Absolute path of the saved copy of an uploaded file. */
  saved: (name: string) => string
  /** Call read_file_chunk from inside the analysis session. */
  read: (path: string) => Promise<Attempt>
}

let scratch: string
const stores: Store[] = []

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-read-chunk-names-'))
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeApi(uploads: Upload[]): TelegramApi {
  const bodies = new Map(uploads.map((upload, index) => [`files/f${index}`, Buffer.from(upload.body, 'utf8')]))
  return {
    async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === 'getFile') return { file_path: `files/${String(params?.file_id)}` } as T
      return { message_id: 900 } as T
    },
    async downloadFile(filePath: string): Promise<Uint8Array> {
      const data = bodies.get(filePath)
      if (data === undefined) throw new Error(`unknown file ${filePath}`)
      return data
    },
  }
}

/** Upload the files in one message and run `script` inside the analysis turn, where the intake session is live. */
async function inAnalysis(uploads: Upload[], script: (probe: Probe) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(scratch, 'home-'))
  const store = openStore(':memory:')
  stores.push(store)

  let intake: AttachmentIntake | undefined
  let scriptError: unknown
  let done = false

  const runner = {
    async promptTurn(prompt: string, session?: { sessionId?: string }) {
      const tool = intake?.tools.find((candidate: RunnerTool) => candidate.name === 'read_file_chunk')
      if (tool === undefined) throw new Error('read_file_chunk is not among the tools of the intake')
      const inbox = join(home, 'workspace', 'inbox')
      const probe: Probe = {
        prompt,
        home,
        saved: (name) => {
          const day = readdirSync(inbox)[0] as string
          return join(inbox, day, name)
        },
        read: async (path) => {
          try {
            const value = await tool.execute(
              { path },
              { signal: new AbortController().signal, ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }) },
            )
            return { value: String(value) }
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      try {
        await script(probe)
      } catch (error) {
        scriptError = error
      }
      done = true
      return { text: 'готово' }
    },
  } as unknown as Runner

  intake = createAttachmentIntake({
    home,
    api: fakeApi(uploads),
    store,
    runner: async () => runner,
    ownerId: () => OWNER_CHAT,
    systemPrefix: 'Ты — тестовый помощник DSHBOT, разбор вложений',
    log: () => undefined,
    send: async () => true,
  })

  const attachments: NormalizedAttachment[] = uploads.map((upload, index) => ({
    kind: 'document',
    fileId: `f${index}`,
    fileSize: Buffer.byteLength(upload.body, 'utf8'),
    fileName: upload.name,
    mimeType: upload.mime,
  }))
  intake.accept({
    kind: 'message',
    updateId: 1,
    chatId: OWNER_CHAT,
    chatType: 'private',
    fromId: OWNER_CHAT,
    messageId: 41,
    text: 'сводка',
    attachments,
  })

  const started = Date.now()
  while ((!done || intake.statusLines()[0] !== IDLE_STATUS) && Date.now() - started < WAIT_MS) await sleep(25)
  intake.shutdown()
  expect(done, 'the analysis turn ran').toBe(true)
  if (scriptError !== undefined) throw scriptError
}

const REPORT: Upload = { name: REPORT_NAME, body: REPORT_BODY, mime: 'text/plain' }
const NOTES: Upload = { name: NOTES_NAME, body: NOTES_BODY, mime: 'text/plain' }

test('test_bare_read_file_chunk_takes_the_bare_file_name_of_the_intake', async () => {
  await inAnalysis([REPORT], async (probe) => {
    const bare = await probe.read(REPORT_NAME)
    expect(bare.error, 'a bare name is looked up in the files of the intake').toBeUndefined()
    expect(bare.value).toContain('REPORT-BODY-179 строка один')
    expect(bare.value).toContain('строка два')
  })
})

test('test_bare_read_file_chunk_resolves_each_bare_name_to_its_own_file', async () => {
  await inAnalysis([REPORT, NOTES], async (probe) => {
    expect((await probe.read(NOTES_NAME)).value).toContain('NOTES-BODY-179')
    expect((await probe.read(REPORT_NAME)).value).toContain('REPORT-BODY-179')
    // The absolute path from the block keeps working as before.
    expect((await probe.read(probe.saved(NOTES_NAME))).value).toContain('NOTES-BODY-179')
  })
})

test('test_escape_read_file_chunk_rejects_paths_that_leave_inbox_and_outbox', async () => {
  await inAnalysis([REPORT], async (probe) => {
    const secret = join(probe.home, 'workspace', 'secret-179.txt')
    writeFileSync(secret, 'SECRET-BODY-179')
    const outside = join(probe.home, 'outside-179.txt')
    writeFileSync(outside, 'OUTSIDE-BODY-179')
    expect(existsSync(secret)).toBe(true)

    // Positive control: the file of the intake is readable, so a refusal below is not a blanket one.
    expect((await probe.read(probe.saved(REPORT_NAME))).value).toContain('REPORT-BODY-179')

    const attempts = {
      etc: await probe.read('../../etc/passwd'),
      deepEtc: await probe.read('../../../../../../../../../../etc/passwd'),
      // inbox/<date>/../../secret-179.txt is workspace/secret-179.txt
      secretByDots: await probe.read('../../secret-179.txt'),
      secretByNameDots: await probe.read(`${REPORT_NAME}/../../../secret-179.txt`),
      absoluteEtc: await probe.read('/etc/passwd'),
      absoluteSecret: await probe.read(secret),
      absoluteOutside: await probe.read(outside),
    }
    for (const [label, attempt] of Object.entries(attempts)) {
      expect(attempt.error, `${label} is refused`).toBeDefined()
      expect(attempt.value, `${label} returns no content`).toBeUndefined()
    }
    for (const attempt of Object.values(attempts)) {
      expect(attempt.error).not.toContain('SECRET-BODY-179')
      expect(attempt.error).not.toContain('OUTSIDE-BODY-179')
    }
  })
})

test('test_frame_file_block_of_the_analysis_prompt_has_the_absolute_path', async () => {
  await inAnalysis([NOTES], async (probe) => {
    const blocks = probe.prompt.match(/<file [^>]*>[\s\S]*?<\/file>/g) ?? []
    expect(blocks, 'the prompt has one file block').toHaveLength(1)
    const block = blocks[0] as string
    expect(block).toContain(NOTES_NAME)
    expect(block, 'the block carries the absolute path of the saved file').toContain(probe.saved(NOTES_NAME))
    expect(probe.saved(NOTES_NAME).startsWith('/')).toBe(true)
    expect(existsSync(probe.saved(NOTES_NAME))).toBe(true)
  })
})

test('test_missing_read_file_chunk_lists_the_file_names_of_the_intake', async () => {
  await inAnalysis([REPORT, NOTES], async (probe) => {
    // A foreign file next to the files of the intake, which this intake never received.
    const foreignName = 'чужой-файл-179.txt'
    const day = readdirSync(join(probe.home, 'workspace', 'inbox'))[0] as string
    writeFileSync(join(probe.home, 'workspace', 'inbox', day, foreignName), 'FOREIGN-BODY-179')

    const missing = await probe.read('нет-такого-файла-179.xlsx')
    expect(missing.value, 'nothing is returned for an unknown name').toBeUndefined()
    expect(missing.error, 'the error is reported').toBeDefined()
    expect(missing.error).toContain(REPORT_NAME)
    expect(missing.error).toContain(NOTES_NAME)
    expect(missing.error, 'only the files of this intake are listed').not.toContain(foreignName)
  })
})
