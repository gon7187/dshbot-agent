import { spawn } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

import { markdownToPlain } from '../telegram/src/rich/index.js'
import {
  asObject,
  call,
  deletedIn,
  filesUnder,
  lastResults,
  OWNER_CHAT,
  ownerTurn,
  privateMessage,
  repoRoot,
  say,
  search,
  sleep,
  startDaemon,
  startOwnerDaemon,
  stopDaemon,
  surfaces,
  TEST_TIMEOUT_MS,
  waitFor,
  world,
} from './test-support/owner-secret-vault-harness.js'
import type { Daemon, JsonObject, TgEvent } from './test-support/owner-secret-vault-harness.js'

// The sign-in file of a model provider (the credential store of the harness) through the daemon: a key saved by the
// runner lands in one file of 0600 inside DSHBOT_HOME, outside the workspace, and the tools of the agent never show
// it: read, list and grep refuse the path (also when the owner declares HOME as a file root), the sandbox of exec
// does not see it, and host_exec on the machine of the bot returns output without the key. The key is on no other
// surface: model requests, messages of the bot, the journal and every other file of the home.
//
// The sign-in itself is made by a runner process on the harness home of the daemon (DSHBOT_HOME/dsh), the way the
// provider screen will do it. The runner API is the one of packages/runner/model-providers.test.ts:
// runner.connectProvider('zai', { prompt, notify }) answers { status: 'connected' }.

const ZAI_KEY = 'zai-daemon-test-Wx58Rt21Lm90Qd34'
const SIGN_IN_MARK = '@@SIGN-IN@@'
const CONTROL_TEXT = 'VISIBLE-CONTROL-FILE-TEXT'

const SIGN_IN_DRIVER = `
const cfg = JSON.parse(process.argv[2])
let status = 'error'
try {
  const { startRunner } = await import(cfg.entry)
  const runner = await startRunner({
    dshHome: cfg.dshHome,
    cwd: cfg.cwd,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.deepseekKey,
    systemPrefix: 'Provider sign-in.',
  })
  try {
    const result = await runner.connectProvider('zai', { prompt: async () => cfg.zaiKey, notify: () => undefined })
    status = result.status
  } finally {
    await runner.stop()
  }
} catch (error) {
  status = String(error && error.stack ? error.stack : error)
}
console.log('${SIGN_IN_MARK}' + status)
process.exit(0)
`

/** Sign in to zai by key with a runner process on the harness home of the daemon; returns its status. */
async function signInToZai(): Promise<string> {
  const script = join(world.dataDir, 'sign-in.mjs')
  writeFileSync(script, SIGN_IN_DRIVER)
  const cfg = {
    entry: pathToFileURL(join(repoRoot, 'packages/runner/src/index.ts')).href,
    dshHome: join(world.dshbotHome, 'dsh'),
    cwd: world.workspace,
    baseUrl: `${world.stub.origin}/anthropic`,
    zaiKey: ZAI_KEY,
    deepseekKey: 'sk-dshbot-test-secret-key-0123456789abcdef',
  }
  const env = { PATH: process.env.PATH ?? '', HOME: world.home, USERPROFILE: world.home }
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(repoRoot, 'packages/app/register.mjs'), script, JSON.stringify(cfg)], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let text = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.stdout.on('data', (data: Buffer) => {
      text += data.toString('utf8')
    })
    child.stderr.on('data', (data: Buffer) => {
      text += data.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })
  const line = output.split('\n').find((candidate) => candidate.startsWith(SIGN_IN_MARK))
  expect(line, `the sign-in process reported\n${output.slice(-3000)}`).toBeDefined()
  return (line as string).slice(SIGN_IN_MARK.length)
}

/** Files below DSHBOT_HOME that hold the key. */
const filesWithKey = (): string[] =>
  filesUnder(world.dshbotHome, '').filter((path) => readFileSync(path).includes(Buffer.from(ZAI_KEY, 'utf8')))

test('test_c7_c9_provider_store_is_0600_hidden_from_agent_tools_and_the_key_is_on_no_other_surface', { timeout: TEST_TIMEOUT_MS }, async () => {
  // c7: the first write of a sign-in makes one file of 0600 inside DSHBOT_HOME, outside the workspace
  expect(await signInToZai(), 'the key sign-in succeeded').toBe('connected')
  const stores = filesWithKey()
  expect(stores.length, 'the key is in exactly one file of DSHBOT_HOME').toBe(1)
  const store = stores[0] as string
  expect(store.startsWith(`${world.workspace}${sep}`), 'the store is outside the workspace').toBe(false)
  expect(statSync(store).mode & 0o777, 'the store is readable by its owner alone').toBe(0o600)

  // The owner declares HOME as a file root, so DSHBOT_HOME lies inside a root; a host to run commands on is the machine itself.
  writeFileSync(join(world.home, 'notes.txt'), `${CONTROL_TEXT}\n`)
  writeFileSync(join(world.dshbotHome, 'fs-roots.json'), JSON.stringify([{ path: world.home, mode: 'ro' }]))
  writeFileSync(join(world.dshbotHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))

  const d = await startOwnerDaemon()
  world.stub.scripts.set('turn-pc-1', [
    call('read', { path: join(world.home, 'notes.txt') }),
    call('read', { path: store }),
    call('grep', { regex: 'zai', path: store }),
    call('list', { path: store }),
    call('grep', { regex: ZAI_KEY.slice(0, 14), path: dirname(store) }),
    call('exec', { command: `echo EXEC-RAN; cat '${store}' 2>&1; true` }),
    search('host_exec'),
    call('host_exec', { host: 'box', command: `cat '${store}'` }),
  ])
  const calls = await ownerTurn(d, 'turn-pc-1')
  const resultOf = (index: number): { text: string; isError: boolean } => {
    const next = calls[index + 1]
    expect(next, `the model asked again after call ${index}`).toBeDefined()
    const blocks = lastResults((next as (typeof calls)[number]).body)
    return { text: blocks.map((block) => block.text).join('\n'), isError: blocks.some((block) => block.isError) }
  }
  expect(calls.length, 'the model went through every scripted call').toBeGreaterThanOrEqual(9)

  // c7: control, the tools read ordinary files of the same root
  expect(resultOf(0).text, 'read sees a file of HOME').toContain(CONTROL_TEXT)
  // c7: read, grep and list refuse the path of the store
  for (const [index, tool] of [[1, 'read'], [2, 'grep'], [3, 'list']] as const) {
    expect(resultOf(index).isError, `${tool} refuses the store`).toBe(true)
    expect(resultOf(index).text, `${tool} shows no key`).not.toContain(ZAI_KEY)
  }
  expect(resultOf(4).text, 'a sweep of the directory finds no key').not.toContain(ZAI_KEY)
  // c7: exec ran in its sandbox and did not get the content
  expect(resultOf(5).text, 'exec ran').toContain('EXEC-RAN')
  expect(resultOf(5).text, 'the sandbox of exec does not show the store').not.toContain(ZAI_KEY)
  // c9: host_exec on the machine of the bot returns no key
  expect(resultOf(7).text, 'host_exec returns output without the key').not.toContain(ZAI_KEY)

  // c9: the key is in no file of the home but the store, and in no request, message or journal line
  const storeSurface = `file ${store.slice(world.home.length)}`
  const needle = Buffer.from(ZAI_KEY, 'utf8')
  const leaks = surfaces()
    .filter(({ where, data }) => where !== storeSurface && data.includes(needle))
    .map(({ where }) => where)
  expect(leaks, 'the key is on no surface outside the store').toEqual([])
  expect(filesWithKey(), 'the store is still the only file with the key').toEqual([store])
  expect(statSync(store).mode & 0o777, 'the store is still 0600 after the daemon ran').toBe(0o600)
})

// --- the sign-in from the «Провайдеры» screen of /factory ---------------------------------------------------

interface Shown {
  n: number
  messageId: number
  text: string
  buttons: JsonObject[]
}

/** Every message or edit of the bot in the owner chat after event number `mark`. */
function shownSince(mark: number): Shown[] {
  return world.timeline.events.flatMap((event) => {
    if (event.src !== 'tg' || event.n <= mark || event.params.chat_id !== OWNER_CHAT) return []
    if (!['sendMessage', 'sendRichMessage', 'editMessageText'].includes(event.method)) return []
    const markdown = asObject(event.params.rich_message).markdown
    const text =
      typeof markdown === 'string' && markdown !== '' ? markdownToPlain(markdown) : String(event.params.text ?? '').replace(/<[^>]+>/g, '')
    const rows = asObject(event.params.reply_markup).inline_keyboard
    const buttons = Array.isArray(rows) ? rows.flatMap((row: unknown) => (Array.isArray(row) ? row.map(asObject) : [])) : []
    const messageId = event.method === 'editMessageText' ? Number(event.params.message_id) : (event.messageId ?? 0)
    return [{ n: event.n, messageId, text, buttons }]
  })
}

async function waitShown(what: string, mark: number, matches: (shown: Shown) => boolean, d: Daemon): Promise<Shown> {
  await waitFor(what, () => shownSince(mark).some(matches), d)
  return shownSince(mark).filter(matches).at(-1) as Shown
}

let callbackCounter = 800_000

/** The owner presses the first button of `screen` whose text matches `label`; returns the mark before the press. */
function press(screen: Shown, label: (text: string) => boolean): number {
  const entry = screen.buttons.find((button) => label(String(button.text)))
  expect(entry, `a button on\n${screen.text}\n${screen.buttons.map((button) => String(button.text)).join(' | ')}`).toBeDefined()
  const mark = world.timeline.seq
  callbackCounter += 1
  world.tg.push({
    update_id: callbackCounter,
    callback_query: {
      id: `hidden-cb-${callbackCounter}`,
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      chat_instance: 'provider-hidden',
      data: String((entry as JsonObject).callback_data),
      message: {
        message_id: screen.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
        text: screen.text,
      },
    },
  })
  return mark
}

const isZai = (text: string): boolean => /(^|[^\w-])zai($|[^\w-])/.test(text)
const isRequest = (shown: Shown): boolean => shown.buttons.some((button) => String(button.text).includes('Отмена')) && /следующ/i.test(shown.text)

/** /factory → «Провайдеры» → zai → its method by key; resolves with the request of the key. */
async function askForZaiKey(d: Daemon): Promise<Shown> {
  let mark = world.timeline.seq
  say(OWNER_CHAT, '/factory')
  const home = await waitShown('the main screen of /factory', mark, (shown) => shown.buttons.some((b) => String(b.text).includes('Провайдеры')), d)
  mark = press(home, (text) => text.includes('Провайдеры'))
  const list = await waitShown('the list of providers', mark, (shown) => shown.messageId === home.messageId && shown.buttons.some((b) => isZai(String(b.text))), d)
  mark = press(list, isZai)
  const screen = await waitShown('the screen of zai', mark, (shown) => shown.messageId === home.messageId && isZai(shown.text) && /подключ/i.test(shown.text), d)
  mark = press(screen, (text) => !text.includes('Назад') && !text.includes('Отключить'))
  return waitShown('the request of the key', mark, isRequest, d)
}

test('a vault command withdraws a waiting sign-in, and a key answer delivered again after a restart reaches no file and no turn', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  // c9: /secrets while the key is awaited: the sign-in is cancelled, the command runs, the next text is a turn
  await askForZaiKey(d)
  const commandMark = world.timeline.seq
  say(OWNER_CHAT, '/secrets')
  await waitFor('the cancellation and the answer of /secrets', () => {
    const said = shownSince(commandMark).map((shown) => shown.text).join('\n')
    return /отменён|отменен/i.test(said) && /Секрет/.test(said)
  }, d)
  await ownerTurn(d, 'turn-pc-1')
  expect(filesWithKey(), 'nothing was signed in').toEqual([])

  // c5: the key answer is consumed by the flow and its message deleted
  await askForZaiKey(d)
  const answer = privateMessage(OWNER_CHAT, ZAI_KEY, Date.now())
  const answerMark = world.timeline.seq
  world.tg.push(answer.update)
  await waitFor('the key message to be deleted', () => deletedIn(OWNER_CHAT).includes(answer.messageId), d)
  await waitShown('the result of the sign-in', answerMark, (shown) => isZai(shown.text) && /подключ[её]н/i.test(shown.text) && !/не подключ/i.test(shown.text), d)
  const stores = filesWithKey()
  expect(stores.length, 'the key is in the credential store alone').toBe(1)

  // The daemon stops before a getUpdates confirms the answer: Telegram delivers the same update to the next one.
  await stopDaemon(d)
  world.tg.push(answer.update)
  const restarted = await startDaemon()
  const requestsBefore = world.timeline.events.filter((event) => event.src === 'ds').length
  await ownerTurn(restarted, 'turn-pc-2')
  // the turn after the copy was answered, so the poller is past the copy; a short pause lets its writes settle
  await sleep(500)
  const requests = world.timeline.events.filter((event) => event.src === 'ds').slice(requestsBefore)
  expect(requests.some((event) => JSON.stringify(event.body).includes(ZAI_KEY)), 'the copy did not become a turn of the agent').toBe(false)
  const storeSurface = `file ${(stores[0] as string).slice(world.home.length)}`
  const needle = Buffer.from(ZAI_KEY, 'utf8')
  const leaks = surfaces()
    .filter(({ where, data }) => where !== storeSurface && data.includes(needle))
    .map(({ where }) => where)
  expect(leaks, 'the copy left the key in no ingress row, history or journal').toEqual([])
  expect(filesWithKey(), 'the store is still the only file with the key').toEqual(stores)
  const sent = world.timeline.events.filter((event): event is TgEvent => event.src === 'tg' && event.method !== 'getUpdates')
  expect(sent.some((event) => JSON.stringify(event.params).includes(ZAI_KEY)), 'no message of the bot carries the key').toBe(false)
})
