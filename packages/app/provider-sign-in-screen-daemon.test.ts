import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

import { markdownToPlain } from '../telegram/src/rich/index.js'
import { startRunner } from '../runner/src/index.js'
import {
  asObject,
  BOT_TOKEN,
  clockPreload,
  deletedIn,
  DEEPSEEK_KEY,
  deepStrings,
  filesUnder,
  LANG_VALUE,
  output,
  OWNER_CHAT,
  ownerTurn,
  pairOwner,
  readAck,
  repoRoot,
  say,
  sleep,
  startScript,
  surfaces,
  TEST_TIMEOUT_MS,
  waitFor,
  world,
  writeClock,
} from './test-support/owner-secret-vault-harness.js'
import type { Daemon, JsonObject, TgEvent } from './test-support/owner-secret-vault-harness.js'

// The «Провайдеры» screen of /factory through the daemon: the daemon runs as a child process against a fake Telegram
// Bot API (harness of owner-secret-vault-harness.ts, the same one the provider store test uses). The real runner,
// the real credential store and the real pi-ai sign-in flows work inside the daemon; only the servers of the
// providers are stand-ins: a preload of the daemon process answers global fetch for auth.openai.com (device code and
// tokens), github.com (device code, never confirmed), platform.claude.com (rejects the code), and passes every other
// address through. The tests open the screens by pressing the buttons of the messages the bot sent, as the owner does.
//
// What the tests rely on and what they leave open:
//   - the buttons: «Провайдеры» on the main screen of /factory; on the list one button per provider of
//     runner.providers() in its order, the name and ✅ / ⬜; on the provider screen one button per method with its
//     label (labels and names are read from a runner the test starts itself), «Отключить» and «Назад»;
//   - while a sign-in waits for the owner the message has a button «Отмена» and asks for the answer «следующим
//     сообщением»; the wording of the other messages is open but for «подключён», «не подключён», «уже» (a sign-in
//     is running), «отменён» and «истёк…» (the wait expired), which the criteria name;
//   - a notice with a code is one message: the text with the code, a button with `url` and a button with
//     `copy_text`; a notice without code and address is a plain message without buttons of those two kinds.

const ZAI_KEY = 'zai-screen-test-Rt58Lm90Qd34Wx21'
const CODEX_CODE = 'WXYZ-4821'
const CODEX_URL = 'https://auth.openai.com/codex/device'
const COPILOT_CODE = 'GH-4821'
const COPILOT_URL = 'https://github.com/login/device'

const STAND_IN = `
const real = globalThis.fetch
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
const access = [b64({ alg: 'none' }), b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-screen-test' } }), 'sig'].join('.')
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let url
  try {
    url = new URL(raw)
  } catch {
    return real(input, init)
  }
  if (url.hostname === 'auth.openai.com') {
    if (url.pathname === '/api/accounts/deviceauth/usercode') return json({ device_auth_id: 'dev-auth-1', user_code: '${CODEX_CODE}', interval: '1' })
    if (url.pathname === '/api/accounts/deviceauth/token') return json({ authorization_code: 'authz-code-1', code_verifier: 'verifier-1' })
    if (url.pathname === '/oauth/token') return json({ access_token: access, refresh_token: 'refresh-screen-test', expires_in: 3600 })
    return json({ error: 'unexpected' }, 404)
  }
  if (url.hostname === 'github.com') {
    if (url.pathname === '/login/device/code') {
      return json({ device_code: 'gh-dev-1', user_code: '${COPILOT_CODE}', verification_uri: '${COPILOT_URL}', interval: 1, expires_in: 900 })
    }
    return json({ error: 'authorization_pending' })
  }
  if (url.hostname === 'platform.claude.com') return json({ error: 'invalid_grant' }, 400)
  return real(input, init)
}
`

// --- the daemon with the stand-in servers ------------------------------------------------------------------

function spawnDaemonWithStandIn(standIn: string, fakeClock: boolean): Daemon {
  const imports = [standIn, ...(fakeClock ? [clockPreload] : [])].map((file) => `--import ${pathToFileURL(file).href}`)
  const env: Record<string, string> = {
    HOME: world.home,
    USERPROFILE: world.home,
    LANG: LANG_VALUE,
    PATH: [dirname(process.execPath), join(repoRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter),
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    DEEPSEEK_API_KEY: DEEPSEEK_KEY,
    DSHBOT_HOME: world.dshbotHome,
    DEEPSEEK_BASE_URL: `${world.stub.origin}/anthropic`,
    TELEGRAM_API_ROOT: world.tg.origin,
    XDG_RUNTIME_DIR: world.runtimeDir,
    NODE_OPTIONS: imports.join(' '),
    ...(fakeClock ? { FAKE_CLOCK_CONTROL: world.clock.control } : {}),
  }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  const child = spawn('sh', ['-c', `exec ${startScript()}`], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const daemon: Daemon = {
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exit: new Promise((resolve) => {
      child.on('close', (code, signal) => {
        daemon.exited = true
        resolve({ code, signal })
      })
    }),
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    daemon.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    daemon.stderr += chunk.toString('utf8')
  })
  world.daemons.push(daemon)
  return daemon
}

async function startOwnerDaemonWithStandIn(fakeClock = false): Promise<Daemon> {
  const standIn = join(world.dataDir, 'provider-stand-in.mjs')
  writeFileSync(standIn, STAND_IN)
  const before = world.tg.polls
  const d = spawnDaemonWithStandIn(standIn, fakeClock)
  await waitFor('the daemon to start long polling', () => world.tg.polls > before || d.exited, d)
  expect(d.exited, `daemon exited during start\n${output(d)}`).toBe(false)
  // the daemon polls before its handlers are mounted: the same pause as the harness makes
  await sleep(300)
  await pairOwner(d)
  return d
}

// --- what the owner sees ---------------------------------------------------------------------------------

interface Shown {
  n: number
  method: string
  messageId: number
  text: string
  buttons: JsonObject[]
}

const SHOWN_METHODS = ['sendMessage', 'sendRichMessage', 'editMessageText']

function shownFrom(event: TgEvent): Shown | undefined {
  if (!SHOWN_METHODS.includes(event.method) || event.params.chat_id !== OWNER_CHAT) return undefined
  const markdown = asObject(event.params.rich_message).markdown
  const text =
    typeof markdown === 'string' && markdown !== ''
      ? markdownToPlain(markdown)
      : String(event.params.text ?? '').replace(/<[^>]+>/g, '')
  const rows = asObject(event.params.reply_markup).inline_keyboard
  const buttons = Array.isArray(rows) ? rows.flatMap((row: unknown) => (Array.isArray(row) ? row.map(asObject) : [])) : []
  const messageId = event.method === 'editMessageText' ? Number(event.params.message_id) : (event.messageId ?? 0)
  return { n: event.n, method: event.method, messageId, text, buttons }
}

/** Every message or edit the bot made in the owner chat after event number `mark`. */
function shownSince(mark: number): Shown[] {
  return world.timeline.events.flatMap((event) => {
    if (event.src !== 'tg' || event.n <= mark) return []
    const shown = shownFrom(event)
    return shown === undefined ? [] : [shown]
  })
}

/** Everything the bot said after `mark`, also the short answers to the presses of buttons. */
function saidSince(mark: number): string {
  const answers = world.timeline.events
    .filter((event): event is TgEvent => event.src === 'tg' && event.n > mark && event.method === 'answerCallbackQuery')
    .map((event) => String(event.params.text ?? ''))
  return [...shownSince(mark).map((shown) => shown.text), ...answers].join('\n')
}

const labelOf = (entry: JsonObject): string => String(entry.text)

/** The name stands alone in the text of the button: `openai` is not a part of `openai-codex`. */
const nameIn = (text: string, name: string): boolean =>
  new RegExp(`(^|[^\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)

/** The button with `label` in its text; of several the shortest, so «GitHub Copilot» wins over «GitHub Copilot token». */
function buttonWith(screen: Shown, label: string): JsonObject {
  const found = screen.buttons.filter((entry) => labelOf(entry).includes(label)).sort((a, b) => labelOf(a).length - labelOf(b).length)[0]
  expect(found, `button «${label}» on\n${screen.text}\n${screen.buttons.map(labelOf).join(' | ')}`).toBeDefined()
  return found as JsonObject
}

const hasButton = (screen: Shown, label: string): boolean => screen.buttons.some((entry) => labelOf(entry).includes(label))

let callbackCounter = 900_000

/** The owner presses a button of a message; returns the mark of the timeline before the press. */
function press(screen: Shown, entry: JsonObject): number {
  const mark = world.timeline.seq
  const data = String(entry.callback_data)
  expect(Buffer.byteLength(data, 'utf8'), 'Telegram callback limit').toBeLessThanOrEqual(64)
  callbackCounter += 1
  world.tg.push({
    update_id: callbackCounter,
    callback_query: {
      id: `provider-cb-${callbackCounter}`,
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      chat_instance: 'provider-screen',
      data,
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

/** Wait for the last message or edit after `mark` that satisfies `matches`. */
async function waitShown(what: string, mark: number, matches: (shown: Shown) => boolean, d: Daemon, timeoutMs?: number): Promise<Shown> {
  await waitFor(what, () => shownSince(mark).some(matches), d, timeoutMs)
  return shownSince(mark).filter(matches).at(-1) as Shown
}

/** Press a button of a menu screen: the same message is edited into the next screen. */
async function tap(screen: Shown, label: string, d: Daemon, matches: (next: Shown) => boolean = () => true): Promise<Shown> {
  const mark = press(screen, buttonWith(screen, label))
  return waitShown(`the screen after «${label}»`, mark, (next) => next.method === 'editMessageText' && next.messageId === screen.messageId && matches(next), d)
}

async function factoryHome(d: Daemon): Promise<Shown> {
  const mark = world.timeline.seq
  say(OWNER_CHAT, '/factory')
  return waitShown('the main screen of /factory', mark, (shown) => hasButton(shown, 'Новая задача'), d)
}

async function providersList(d: Daemon): Promise<Shown> {
  return tap(await factoryHome(d), 'Провайдеры', d)
}

/** The button of the provider `name` on the list (the other buttons of the list are «Назад» alone). */
function providerButton(list: Shown, name: string): JsonObject {
  const found = list.buttons.find((entry) => nameIn(labelOf(entry), name))
  expect(found, `provider ${name} on the list\n${list.buttons.map(labelOf).join(' | ')}`).toBeDefined()
  return found as JsonObject
}

async function providerScreen(list: Shown, name: string, d: Daemon): Promise<Shown> {
  const mark = press(list, providerButton(list, name))
  return waitShown(
    `the screen of ${name}`,
    mark,
    (next) => next.method === 'editMessageText' && next.messageId === list.messageId && nameIn(next.text, name) && /подключ/i.test(next.text),
    d,
  )
}

const CANCEL = 'Отмена'
/** The request that waits for an answer: it asks for the next message and offers «Отмена». */
const isRequest = (shown: Shown): boolean => hasButton(shown, CANCEL) && /следующ/i.test(shown.text)
const CONNECTED = /подключ[её]н/i
const NOT_CONNECTED = /не подключ[её]н/i
const CANCELLED = /отменён|отменен/i

/** A message of the bot that tells the provider is connected. */
const saysConnected = (name: string) => (shown: Shown): boolean =>
  nameIn(shown.text, name) && CONNECTED.test(shown.text) && !NOT_CONNECTED.test(shown.text)

/** The names a runner advertises, read from a runner of the test on its own home. */
interface Expected {
  providers: Array<{ id: string; name: string; methods: Array<{ kind: string; label: string }> }>
  zaiModels: string[]
}

async function expectedFromRunner(): Promise<Expected> {
  const home = mkdtempSync(join(tmpdir(), 'provider-screen-expected-'))
  try {
    const runner = await startRunner({
      dshHome: join(home, 'dsh'),
      cwd: home,
      baseUrl: `${world.stub.origin}/anthropic`,
      apiKey: DEEPSEEK_KEY,
      systemPrefix: 'Names of the providers.',
    })
    try {
      const providers = await runner.providers()
      const connected = await runner.connectProvider('zai', { prompt: async () => 'zai-expected-names-key-0000', notify: () => undefined })
      expect(connected.status, 'the runner of the test signs in to zai').toBe('connected')
      const zaiModels = (await runner.models()).filter((model) => model.provider === 'zai').map((model) => model.name)
      expect(zaiModels.length, 'zai advertises models').toBeGreaterThan(0)
      return { providers, zaiModels }
    } finally {
      await runner.stop()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/**
 * The role screen of «Модели»: the labels of its buttons and of every page of
 * every provider, where the models are switched; the screen is left on the role.
 */
async function roleLabels(d: Daemon): Promise<string[]> {
  const models = await tap(await factoryHome(d), 'Модели', d)
  const role = await tap(models, 'разбор', d)
  const labels = role.buttons.map(labelOf)
  for (const provider of labels.filter((label) => /\d+\/\d+$/.test(label))) {
    let page = await tap(role, provider, d)
    for (;;) {
      labels.push(...page.buttons.map(labelOf))
      if (!hasButton(page, '▶️')) break
      page = await tap(page, '▶️', d)
    }
  }
  return labels
}

/** Model requests of the main model after `mark`: an owner turn would make one. */
const modelRequestsSince = (mark: number): number =>
  world.timeline.events.filter((event) => event.src === 'ds' && event.n > mark && event.body.stream !== false).length

/** The store file of the credentials: the files of DSHBOT_HOME that hold `value`. */
const filesWith = (value: string): string[] =>
  filesUnder(world.dshbotHome, '').filter((path) => readFileSync(path).includes(Buffer.from(value, 'utf8')))

// --- the tests -------------------------------------------------------------------------------------------

test('c1 c2 c3 c4 c5 c10: zai key sign-in from the screen, the key is deleted from the chat and stored in the credential file alone, sign-out removes the models', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn()

  // c1: the list has a button per provider in the order of runner.providers(), none signed in yet
  const list = await providersList(d)
  const entries = list.buttons.filter((entry) => !labelOf(entry).includes('Назад'))
  expect(entries.length, 'a button per provider').toBe(expected.providers.length)
  for (const [index, provider] of expected.providers.entries()) {
    const text = labelOf(entries[index] as JsonObject)
    expect(nameIn(text, provider.name), `provider ${index} is ${provider.name}, the button says «${text}»`).toBe(true)
    expect(text.includes('⬜') && !text.includes('✅'), `${provider.name} is marked as not connected: «${text}»`).toBe(true)
  }
  // c1: «Назад» leads to the main screen, and the button leads to the list again
  const home = await tap(list, 'Назад', d, (next) => hasButton(next, 'Новая задача'))
  expect(hasButton(home, 'Провайдеры'), 'the main screen keeps the button of providers').toBe(true)
  const again = await tap(home, 'Провайдеры', d)

  // c2: the screen of zai: the name, the state, a button per method, «Назад», and no «Отключить»
  const zaiMethods = expected.providers.find((provider) => provider.id === 'zai')?.methods ?? []
  expect(zaiMethods.length, 'zai offers a method').toBeGreaterThan(0)
  const zaiScreen = await providerScreen(again, 'zai', d)
  expect(zaiScreen.text, 'the screen names the provider').toContain('zai')
  expect(NOT_CONNECTED.test(zaiScreen.text), `the screen says «не подключён»: ${zaiScreen.text}`).toBe(true)
  for (const method of zaiMethods) expect(hasButton(zaiScreen, method.label), `a button for ${method.label}`).toBe(true)
  expect(hasButton(zaiScreen, 'Назад'), 'a button back to the list').toBe(true)
  expect(hasButton(zaiScreen, 'Отключить'), 'nothing to sign out of yet').toBe(false)

  // c3 (before): the models of zai are not on the role screen
  const before = await roleLabels(d)
  for (const model of expected.zaiModels) expect(before.some((label) => label.includes(model)), `${model} is not offered before the sign-in`).toBe(false)

  // c4: the method opens the request of the key with «Отмена»
  const requestMark = press(zaiScreen, buttonWith(zaiScreen, (zaiMethods.find((method) => method.kind === 'api-key') ?? (zaiMethods[0] as { label: string })).label))
  const request = await waitShown('the request of the key', requestMark, isRequest, d)
  expect(request.text, 'the bot asks for the answer in the next message').toMatch(/следующ/i)

  // c10: pressing a method while a sign-in runs only says so, for the same provider and for another one
  const sameMark = press(zaiScreen, buttonWith(zaiScreen, zaiMethods[0]!.label))
  await waitFor('the answer that a sign-in is already running', () => /уже/i.test(saidSince(sameMark)), d)
  const openai = await providerScreen(again, 'openai', d)
  const openaiMethod = expected.providers.find((provider) => provider.id === 'openai')!.methods[0]!
  const otherFrom = press(openai, buttonWith(openai, openaiMethod.label))
  await waitFor('the answer that a sign-in is already running (another provider)', () => /уже/i.test(saidSince(otherFrom)), d)
  await sleep(500)
  expect(shownSince(sameMark).some((shown) => /следующ/i.test(shown.text)), 'no second request of a key').toBe(false)

  // c4: the next text message is the answer: no turn of the agent, the message is deleted from the chat
  const requestsBefore = modelRequestsSince(0)
  const answerMark = world.timeline.seq
  const keyMessage = say(OWNER_CHAT, ZAI_KEY)
  await waitFor('the key message to be deleted from the chat', () => deletedIn(OWNER_CHAT).includes(keyMessage), d)
  const done = await waitShown('the result of the sign-in', answerMark, saysConnected('zai'), d)
  expect(done.text, 'the result does not repeat the key').not.toContain(ZAI_KEY)
  await sleep(500)
  expect(modelRequestsSince(0), 'the answer did not start a turn of the agent').toBe(requestsBefore)

  // c5: the key is in the file of the credential store alone, and on no other surface
  const stores = filesWith(ZAI_KEY)
  expect(stores.length, 'exactly one file of DSHBOT_HOME holds the key').toBe(1)
  const storeSurface = `file ${(stores[0] as string).slice(world.home.length)}`
  const needle = Buffer.from(ZAI_KEY, 'utf8')
  const leaks = surfaces()
    .filter(({ where, data }) => where !== storeSurface && data.includes(needle))
    .map(({ where }) => where)
  expect(leaks, 'the key is in no history, journal, kv, ingress, request or message').toEqual([])
  expect(deepStrings(world.timeline.events.filter((event): event is TgEvent => event.src === 'tg').map((event) => event.params)).join('\n')).not.toContain(ZAI_KEY)

  // c2 c4: the list marks zai, its screen says «подключён» and offers «Отключить»; the models are on the role screen
  const listNow = await providersList(d)
  expect(labelOf(providerButton(listNow, 'zai')), 'zai is marked on the list').toContain('✅')
  const connected = await providerScreen(listNow, 'zai', d)
  expect(CONNECTED.test(connected.text) && !NOT_CONNECTED.test(connected.text), `the screen says «подключён»: ${connected.text}`).toBe(true)
  expect(hasButton(connected, 'Отключить'), 'a connected provider can be disconnected').toBe(true)
  const withModels = await roleLabels(d)
  for (const model of expected.zaiModels) expect(withModels.some((label) => label.includes(model)), `${model} is offered after the sign-in`).toBe(true)

  // c3: «Отключить» removes the sign-in, the screen goes back to «не подключён», the models leave the role screen
  const after = await tap(connected, 'Отключить', d, (next) => NOT_CONNECTED.test(next.text))
  expect(hasButton(after, 'Отключить'), 'no «Отключить» after the sign-out').toBe(false)
  const without = await roleLabels(d)
  for (const model of expected.zaiModels) expect(without.some((label) => label.includes(model)), `${model} is gone after the sign-out`).toBe(false)
  expect(filesWith(ZAI_KEY), 'the key left the credential file').toEqual([])
})

test('c7 c8 c11: openai-codex offers the way to sign in by buttons, the device code comes with a link and a copy button, the bot waits for the confirmation itself', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn()
  const codex = expected.providers.find((provider) => provider.id === 'openai-codex')!
  const oauth = codex.methods.find((method) => method.kind === 'oauth')!

  const screen = await providerScreen(await providersList(d), 'openai-codex', d)
  expect(hasButton(screen, oauth.label), 'the OAuth method has its button').toBe(true)

  // c7: the question of the flow is a message with a button per option
  const mark = press(screen, buttonWith(screen, oauth.label))
  const question = await waitShown('the choice of the way to sign in', mark, (shown) => hasButton(shown, 'Device code'), d)
  expect(question.text, 'the text of the question').toContain('Select OpenAI Codex login method')
  expect(hasButton(question, 'Browser login'), 'an option for the browser').toBe(true)
  expect(question.buttons.length, 'the options and «Отмена»').toBeGreaterThanOrEqual(2)

  // c7 c8 c11: the chosen option reaches the flow; the notice has the code, a link button and a copy button
  const chosen = press(question, buttonWith(question, 'Device code'))
  const notice = await waitShown('the notice with the device code', chosen, (shown) => shown.buttons.some((entry) => entry.copy_text !== undefined), d)
  expect(notice.text, 'the text has the code').toContain(CODEX_CODE)
  expect(notice.buttons.some((entry) => entry.url === CODEX_URL), 'a link button to the verification page').toBe(true)
  expect(notice.buttons.some((entry) => asObject(entry.copy_text).text === CODEX_CODE), 'a button that copies the code').toBe(true)

  // c11: the stand-in server confirmed the code, the tokens are saved without any further action of the owner
  await waitShown('the result of the sign-in', chosen, saysConnected('openai-codex'), d)
  const list = await providersList(d)
  expect(labelOf(providerButton(list, 'openai-codex')), 'openai-codex is marked as connected').toContain('✅')
})

test('c6 c8: a text request is answered by the next message without a turn of the agent, a progress notice is a plain message, a failed flow says so', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn()
  const anthropic = expected.providers.find((provider) => provider.id === 'anthropic')!
  const oauth = anthropic.methods.find((method) => method.kind === 'oauth')!

  const screen = await providerScreen(await providersList(d), 'anthropic', d)
  const mark = press(screen, buttonWith(screen, oauth.label))
  const question = await waitShown('the choice of the way to sign in', mark, (shown) => hasButton(shown, 'Copy code'), d)

  // c8: a notice with an address and without a code: a link button and no copy button
  const chosen = press(question, buttonWith(question, 'Copy code'))
  const link = await waitShown('the notice with the address', chosen, (shown) => shown.buttons.some((entry) => String(entry.url ?? '').startsWith('https://claude.ai/oauth/authorize')), d)
  expect(link.buttons.some((entry) => entry.copy_text !== undefined), 'no code, no copy button').toBe(false)

  // c6: the request of the text asks for the next message with «Отмена»
  const ask = await waitShown('the request of the code', chosen, isRequest, d)
  expect(ask.text, 'the bot asks for the answer in the next message').toMatch(/следующ/i)

  // c6: the next message of the owner is the answer, the agent does not see it
  const requestsBefore = modelRequestsSince(0)
  const answerMark = world.timeline.seq
  say(OWNER_CHAT, 'plain-code-from-the-browser')
  // c8: the progress notice is a plain message: no link and no copy button
  const progress = await waitShown('the progress notice', answerMark, (shown) => /Exchanging authorization code/i.test(shown.text), d)
  expect(progress.buttons.some((entry) => entry.url !== undefined || entry.copy_text !== undefined), 'a notice without address and code has no such buttons').toBe(false)
  // the server rejected the code: the owner gets a message about the failure, not a connection
  await waitFor('a message about the failed sign-in', () => /ошиб|не удал/i.test(shownSince(answerMark).map((shown) => shown.text).join('\n')), d)
  expect(shownSince(answerMark).some(saysConnected('anthropic')), 'a rejected code does not connect').toBe(false)
  expect(modelRequestsSince(0), 'the answer did not start a turn of the agent').toBe(requestsBefore)

  // the wait is over: the next message is an ordinary one
  await ownerTurn(d, 'turn-ps-1')
})

test('c9: «Отмена» ends the wait for the confirmation of a code, a command ends the wait and runs, both give the next message back to the agent', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn()
  const copilot = expected.providers.find((provider) => provider.id === 'github-copilot')!
  const oauth = copilot.methods.find((method) => method.kind === 'oauth')!

  const list = await providersList(d)
  const screen = await providerScreen(list, 'github-copilot', d)

  // the flow asks for the domain, then waits for the owner to confirm the device code
  const startMark = press(screen, buttonWith(screen, oauth.label))
  const ask = await waitShown('the request of the domain', startMark, isRequest, d)
  expect(ask.text).toMatch(/следующ/i)
  const domainMark = world.timeline.seq
  say(OWNER_CHAT, 'github.com')
  const notice = await waitShown('the notice with the device code', domainMark, (shown) => shown.buttons.some((entry) => entry.copy_text !== undefined), d)
  expect(notice.text).toContain(COPILOT_CODE)
  expect(notice.buttons.some((entry) => entry.url === COPILOT_URL), 'a link button').toBe(true)

  // c9: «Отмена» while the bot waits for the confirmation
  // the button may sit on the notice or stay on the request of the domain: the latest message with it
  const cancelable = shownSince(startMark).filter((shown) => hasButton(shown, CANCEL)).at(-1)
  expect(cancelable, 'a message with «Отмена» while the bot waits for the confirmation').toBeDefined()
  const cancelMark = press(cancelable as Shown, buttonWith(cancelable as Shown, CANCEL))
  await waitFor('the message that the sign-in is cancelled', () => CANCELLED.test(saidSince(cancelMark)), d)
  expect(shownSince(cancelMark).some(saysConnected('github-copilot')), 'a cancelled sign-in is not saved').toBe(false)
  await ownerTurn(d, 'turn-pc-1')

  // c9: a command during the wait for an answer is not an answer: the sign-in is cancelled, the command runs
  const second = await providerScreen(await providersList(d), 'github-copilot', d)
  const againMark = press(second, buttonWith(second, oauth.label))
  await waitShown('the request of the domain', againMark, isRequest, d)
  const commandMark = world.timeline.seq
  say(OWNER_CHAT, '/factory')
  await waitShown('the main screen after the command', commandMark, (shown) => hasButton(shown, 'Новая задача'), d)
  await waitFor('the message that the sign-in is cancelled', () => CANCELLED.test(saidSince(commandMark)), d)
  expect(saidSince(commandMark), 'the command was not sent to the flow as the domain').not.toContain(COPILOT_CODE)
  await ownerTurn(d, 'turn-pc-2')
})

test('c9: without an answer for five minutes the sign-in is cancelled with a message about the expired wait', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn(true)
  const advance = async (minutes: number): Promise<void> => {
    for (let step = 0; step < minutes; step += 1) {
      world.clock.total += 60_000
      writeClock(world.clock, true)
      const seq = world.clock.seq
      await waitFor('the fake clock of the daemon to acknowledge', () => readAck(world.clock) >= seq || d.exited, d)
      // the daemon reacts to a tick on its own schedule: the harness of the secret vault pauses the same way
      await sleep(250)
    }
    expect(d.exited, `daemon exited while the clock moved\n${output(d)}`).toBe(false)
  }

  const zai = expected.providers.find((provider) => provider.id === 'zai')!
  const screen = await providerScreen(await providersList(d), 'zai', d)
  const mark = press(screen, buttonWith(screen, zai.methods[0]!.label))
  await waitShown('the request of the key', mark, isRequest, d)

  // four minutes are still inside the wait
  await advance(4)
  expect(/истек|истёк/i.test(saidSince(mark)), 'four minutes do not end the wait').toBe(false)

  // after five minutes the wait is over
  await advance(2)
  await waitFor('the message about the expired wait', () => /истек|истёк/i.test(saidSince(mark)), d)
  const late = world.timeline.seq
  await ownerTurn(d, 'turn-pt-1')
  expect(shownSince(late).some(saysConnected('zai')), 'a late message does not sign in').toBe(false)
})
