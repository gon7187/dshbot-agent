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

/** The role screen of «Модели»: the labels of its buttons. */
async function roleLabels(d: Daemon): Promise<string[]> {
  const models = await tap(await factoryHome(d), 'Модели', d)
  const role = await tap(models, 'разбор', d)
  return role.buttons.map(labelOf)
}

/** Model requests of the main model after `mark`: an owner turn would make one. */
const modelRequestsSince = (mark: number): number =>
  world.timeline.events.filter((event) => event.src === 'ds' && event.n > mark && event.body.stream !== false).length

/** The store file of the credentials: the files of DSHBOT_HOME that hold `value`. */
const filesWith = (value: string): string[] =>
  filesUnder(world.dshbotHome, '').filter((path) => readFileSync(path).includes(Buffer.from(value, 'utf8')))

// --- the tests -------------------------------------------------------------------------------------------

test('c8: successful OAuth sends the updated provider keyboard with its connection notice', { timeout: TEST_TIMEOUT_MS }, async () => {
  const expected = await expectedFromRunner()
  const d = await startOwnerDaemonWithStandIn()
  const codex = expected.providers.find((provider) => provider.id === 'openai-codex')!
  const oauth = codex.methods.find((method) => method.kind === 'oauth')!
  const screen = await providerScreen(await providersList(d), 'openai-codex', d)
  const mark = press(screen, buttonWith(screen, oauth.label))
  const question = await waitShown('the choice of login method', mark, (shown) => hasButton(shown, 'Device code'), d)
  const chosen = press(question, buttonWith(question, 'Device code'))
  const done = await waitShown('the successful sign-in notice', chosen, saysConnected('openai-codex'), d)
  expect(labelOf(providerButton(done, 'openai-codex'))).toContain('✅')
  for (const provider of expected.providers) expect(providerButton(done, provider.name)).toBeDefined()
})
