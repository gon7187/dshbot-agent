import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore } from '../store/src/index.js'
import type { TelegramUpdate } from '../telegram/src/index.js'
import type { CreatePollerOptions } from '../telegram/src/poller.js'
import { markdownToPlain } from '../telegram/src/rich/index.js'
import { OWNER_KV_KEY, startDshbot } from './src/index.js'
import type { Runner, RunnerOptions } from '../runner/src/index.js'

// A sign-in that ends in an error whose text carries the key the owner just sent: the owner gets a message about the
// failed sign-in without the value, and neither the journal of the process (stderr and stdout), nor a message of the
// bot, nor a file of the home holds it. The daemon runs in this process with the poller replaced by a handle the test
// calls, as packages/factory/role-reasoning-effort.test.ts does; the runner is the real one, but its connectProvider
// asks for the secret through the interaction the bot gave it and then fails with the key in the error text, the way
// a provider flow that echoes its input would.

const seam = vi.hoisted(() => ({
  handle: undefined as CreatePollerOptions['handle'] | undefined,
  runners: [] as Runner[],
}))

vi.mock('../telegram/src/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telegram/src/index.js')>()),
  createPoller: (options: CreatePollerOptions) => {
    seam.handle = options.handle
    return { start: async () => undefined, stop: () => undefined }
  },
}))
vi.mock('../runner/src/index.js', async (original) => {
  const actual = await original<typeof import('../runner/src/index.js')>()
  return {
    ...actual,
    startRunner: async (options: RunnerOptions) => {
      const runner = await actual.startRunner(options)
      seam.runners.push(runner)
      runner.connectProvider = async (_id, interaction) => {
        const answer = await interaction.prompt({ kind: 'secret', message: 'Enter the key' })
        throw new Error(`provider rejected the key ${String(answer)}`)
      }
      return runner
    },
  }
})

const OWNER = 7
const WAIT = 20_000
const KEY = 'zai-scrub-test-Pz94Kd20Vm37Xc11'

type Json = Record<string, unknown>
interface Call {
  method: string
  params: Json
  messageId?: number
}
interface Screen {
  id: number
  text: string
  buttons: Json[]
}

let root: string
let home: string
let calls: Call[]
let written: string[]
let sequence: number
let messageId: number
let savedEnv: Record<string, string | undefined>
let bot: Awaited<ReturnType<typeof startDshbot>> | undefined

const object = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

const telegramFetch: typeof fetch = async (input, init) => {
  const method = String(input).split('/').at(-1) ?? ''
  const params = object(JSON.parse(String(init?.body ?? '{}')) as unknown)
  const call: Call = { method, params }
  calls.push(call)
  if (method === 'getMe') return Response.json({ ok: true, result: { id: 4242, username: 'provider_scrub_bot' } })
  if (['sendMessage', 'sendRichMessage'].includes(method)) {
    messageId += 1
    call.messageId = messageId
    return Response.json({ ok: true, result: { message_id: messageId, chat: { id: params.chat_id } } })
  }
  if (method.startsWith('editMessage')) {
    return Response.json({ ok: true, result: { message_id: params.message_id, chat: { id: params.chat_id } } })
  }
  return Response.json({ ok: true, result: true })
}

function screenOf(call: Call): Screen {
  const markdown = object(call.params.rich_message).markdown
  const text =
    typeof markdown === 'string' && markdown !== ''
      ? markdownToPlain(markdown)
      : String(call.params.text ?? '').replace(/<[^>]+>/g, '')
  const rows = object(call.params.reply_markup).inline_keyboard
  const buttons = Array.isArray(rows) ? rows.flatMap((row: unknown) => (Array.isArray(row) ? row.map(object) : [])) : []
  const id = call.method === 'editMessageText' ? Number(call.params.message_id) : (call.messageId ?? 0)
  return { id, text, buttons }
}

function shownSince(mark: number): Screen[] {
  return calls
    .slice(mark)
    .filter((call) => call.params.chat_id === OWNER && ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(call.method))
    .map(screenOf)
}

async function shown(what: string, mark: number, matches: (screen: Screen) => boolean): Promise<Screen> {
  await vi.waitFor(() => expect(shownSince(mark).some(matches), what).toBe(true), { timeout: WAIT })
  return shownSince(mark).filter(matches).at(-1) as Screen
}

const hasButton = (screen: Screen, label: string): boolean => screen.buttons.some((entry) => String(entry.text).includes(label))

function buttonOf(screen: Screen, matches: (text: string) => boolean): Json {
  const found = screen.buttons.find((entry) => matches(String(entry.text)))
  expect(found, `a button on\n${screen.text}\n${screen.buttons.map((entry) => String(entry.text)).join(' | ')}`).toBeDefined()
  return found as Json
}

async function press(screen: Screen, entry: Json): Promise<number> {
  const mark = calls.length
  sequence += 1
  await seam.handle!({
    update_id: sequence,
    callback_query: {
      id: `scrub-callback-${sequence}`,
      from: { id: OWNER, is_bot: false, first_name: 'Owner' },
      chat_instance: 'provider-scrub',
      data: String(entry.callback_data),
      message: { message_id: screen.id, date: 1, chat: { id: OWNER, type: 'private' }, text: screen.text },
    },
  } as unknown as TelegramUpdate)
  return mark
}

async function say(text: string): Promise<number> {
  sequence += 1
  await seam.handle!({
    update_id: sequence,
    message: { message_id: sequence, chat: { id: OWNER, type: 'private' }, text },
  } as TelegramUpdate)
  return sequence
}

/** Files below `dir`, with the content, for the search of the key. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : []
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-provider-scrub-')))
  home = join(root, 'bot')
  mkdirSync(home, { recursive: true })
  calls = []
  written = []
  sequence = 6000
  messageId = 9000
  bot = undefined
  seam.handle = undefined
  seam.runners = []
  savedEnv = Object.fromEntries(['DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'DEEPSEEK_API_KEY'].map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries({
    HOME: root,
    DSHBOT_UPSTREAM: 'off',
    DSHBOT_AUTO_SYNC: 'off',
    DSHBOT_DREAM_AT: 'off',
    DSHBOT_BACKUP_AT: '',
  })) vi.stubEnv(key, value)
  const store = openStore(join(home, 'state.db'))
  try {
    store.kv.set(OWNER_KV_KEY, String(OWNER))
  } finally {
    store.close()
  }
  // the journal of the process: everything written to stderr and stdout while the test runs
  const collect = (chunk: unknown): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }
  vi.spyOn(process.stderr, 'write').mockImplementation(collect as typeof process.stderr.write)
  vi.spyOn(process.stdout, 'write').mockImplementation(collect as typeof process.stdout.write)
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Unexpected external fetch in the provider sign-in test')
  }))
})

afterEach(async () => {
  try {
    await Promise.allSettled(seam.runners.map((runner) => runner.stop()))
    await bot?.stop()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 })

test('c5: a sign-in that fails with the key in its error gives the owner an error message without the key, and the key is in no journal line, message or file', async () => {
  bot = await startDshbot({
    dshbotHome: home,
    telegramBotToken: 'provider-scrub-test-token',
    deepseekApiKey: 'provider-scrub-test-key',
    fetch: telegramFetch,
    ownerDebounceMs: 0,
    exitProcess: () => undefined,
  })
  expect(seam.handle, 'the daemon installed its real update handler').toBeDefined()

  // the screens: «Провайдеры» → zai → the method of the key
  const first = calls.length
  await say('/factory')
  const main = await shown('the main screen', first, (screen) => hasButton(screen, 'Новая задача'))
  const listMark = await press(main, buttonOf(main, (text) => text.includes('Провайдеры')))
  const list = await shown('the list of providers', listMark, (screen) => screen.buttons.length > 6)
  const zaiMark = await press(list, buttonOf(list, (text) => /(^|[^\w-])zai($|[^\w-])/.test(text)))
  const zai = await shown('the screen of zai', zaiMark, (screen) => /подключ/i.test(screen.text) && screen.buttons.length >= 2)
  const methods = zai.buttons.filter((entry) => !/Назад|Отключить/.test(String(entry.text)))
  expect(methods.length, 'zai offers a method').toBeGreaterThan(0)
  const askMark = await press(zai, methods[0] as Json)
  await shown('the request of the key', askMark, (screen) => hasButton(screen, 'Отмена') && /следующ/i.test(screen.text))

  // the owner sends the key; the flow fails with the key in its error
  const answerMark = calls.length
  const keyMessage = await say(KEY)
  const failure = await shown('a message about the failed sign-in', answerMark, (screen) => /ошиб|не удал/i.test(screen.text))
  expect(failure.text, 'the message names no value').not.toContain(KEY)
  expect(
    calls.some((call) => call.method === 'deleteMessage' && call.params.chat_id === OWNER && call.params.message_id === keyMessage),
    'the message with the key was deleted from the chat',
  ).toBe(true)

  // the key is on no surface: not in a message of the bot, not in the journal, not in a file of the home
  await vi.waitFor(() => expect(calls.some((call) => call.method === 'deleteMessage')).toBe(true), { timeout: WAIT })
  const needle = Buffer.from(KEY, 'utf8')
  expect(JSON.stringify(calls), 'the key is in no request to Telegram').not.toContain(KEY)
  expect(written.join(''), 'the key is in no line of the journal').not.toContain(KEY)
  const leaks = filesUnder(root).filter((path) => readFileSync(path).includes(needle))
  expect(leaks, 'the key is in no file of the home').toEqual([])
})
