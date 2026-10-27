// Approval cards for commands of the exec sandbox, through the daemon: the direct shell of the owner ("!command"),
// the exec tool of the model, the command of a stream watcher (schedule, action "watch") and host_exec. A command
// that runs in the sandbox draws a card only when it is destructive; an unparseable syntax or kill/pkill/killall
// inside the sandbox is not a reason. A command nested in `bash -c`, `$(…)` or `find -exec` is judged by the same
// rules. host_exec runs on the host, outside the sandbox, and keeps the old rules.
//
// Same harness as mail-send-daemon.test.ts (test-support/wake-harness.ts): the daemon runs as a child process
// against the fake Telegram Bot API and the DeepSeek stub. The stub plays the model: an owner message `own-<tag>`
// makes it call one tool with the scripted input (loading a lazy tool through `tool_search` first) and answer
// `pong-<tag>` once it has the tool result. An approval card is a message with an inline keyboard whose buttons
// carry the callback_data of the approval codec (`tga1[r]:<kind>:a|d:<id>`); every test declines the cards it
// sees, so a destructive command never runs. The outputs that prove a command ran are made of a word with a split
// inside ("BAN""G-21"): the shell glues it back, the text of the command never holds it whole.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import {
  OWNER_CHAT,
  TEST_TIMEOUT_MS,
  asObject,
  deepStrings,
  ownerTexts,
  sleep,
  startOwnerDaemon,
  toolNames,
  waitFor,
  world,
} from './test-support/wake-harness.js'
import type { DsEvent, Daemon, JsonObject, Plan, TgEvent, ToolResult } from './test-support/wake-harness.js'

// --- the fake Telegram side: updates and cards ----------------------------------------------------------------

// The ids of the updates of this file start far above those of the harness (its pairing uses a few), and only this
// file pushes updates after the pairing, so the ids stay strictly increasing.
let updateId = 800_000
let messageCounter = 8_000

function ownerSays(text: string): void {
  updateId += 1
  messageCounter += 1
  world.tg.push({
    update_id: updateId,
    message: {
      message_id: messageCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      text,
    },
  })
}

interface Card {
  messageId: number
  text: string
  allow: string
  deny: string
}

function sentMessages(): TgEvent[] {
  return world.timeline.events.filter(
    (event): event is TgEvent => event.src === 'tg' && (event.method === 'sendMessage' || event.method === 'sendRichMessage'),
  )
}

/** Approval cards sent to the owner: a message with an allow and a deny button of the approval codec. */
function cards(): Card[] {
  const found: Card[] = []
  sentMessages().forEach((event, index) => {
    if (event.params.chat_id !== OWNER_CHAT) return
    const rows = asObject(event.params.reply_markup).inline_keyboard
    if (!Array.isArray(rows)) return
    const data = rows
      .flatMap((row) => (Array.isArray(row) ? row.map(asObject) : []))
      .map((button) => (typeof button.callback_data === 'string' ? button.callback_data : ''))
    const allow = data.find((entry) => /^tga1r?:[a-z]:a:/.test(entry))
    const deny = data.find((entry) => /^tga1r?:[a-z]:d:/.test(entry))
    if (allow === undefined || deny === undefined) return
    // the fake API numbers the sent messages 9001, 9002, ... in the order it saw them
    const visible = deepStrings({ ...event.params, reply_markup: undefined }).join('\n')
    found.push({ messageId: 9001 + index, text: visible, allow, deny })
  })
  return found
}

/** Texts the owner chat got that are not cards. */
function plainTexts(): string[] {
  return sentMessages()
    .filter((event) => event.params.chat_id === OWNER_CHAT && asObject(event.params.reply_markup).inline_keyboard === undefined)
    .map((event) => deepStrings(event.params).join('\n'))
}

function press(card: Card, data: string): void {
  updateId += 1
  world.tg.push({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: OWNER_CHAT, is_bot: false, first_name: 'T' },
      chat_instance: 'dshbot-test-instance',
      data,
      message: {
        message_id: card.messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT, type: 'private', first_name: 'T' },
        text: 'card',
      },
    },
  })
}

async function nextCard(d: Daemon, seen: number, what: string): Promise<Card> {
  await waitFor(`an approval card for ${what}`, () => cards().length > seen, d)
  return cards()[seen] as Card
}

// --- the direct shell of the owner ------------------------------------------------------------------------------

/** "!command" must draw a card: the card is declined and the command does not run. */
async function bangWithCard(d: Daemon, command: string): Promise<void> {
  const seen = cards().length
  ownerSays(`!${command}`)
  const card = await nextCard(d, seen, `!${command}`)
  press(card, card.deny)
  await sleep(1_500)
}

/** "!command" must run without a card and print `marker`. */
async function bangWithoutCard(d: Daemon, command: string, marker: string): Promise<void> {
  const seen = cards().length
  ownerSays(`!${command}`)
  await waitFor(
    `the output ${marker} of !${command} or a card`,
    () => cards().length > seen || plainTexts().some((text) => text.includes(marker)),
    d,
  )
  expect(cards().length, `no card for !${command}`).toBe(seen)
}

// --- the scripted model ------------------------------------------------------------------------------------------

interface ToolRun {
  called: boolean
  result: ToolResult | undefined
}

/** The tools the latest model request offers. */
function offeredTools(): string[] {
  const asked = world.timeline.events.filter((event): event is DsEvent => event.src === 'ds')
  const last = asked[asked.length - 1]
  return last === undefined ? [] : toolNames(last.body)
}

/** Loads the tool through tool_search when it is lazy, calls it once with `input`, then ends with `final`. */
function toolPlan(name: string, input: JsonObject, run: ToolRun, final: string): Plan {
  return (turn) => {
    if (run.called) {
      run.result = turn.result
      return { text: final }
    }
    if (offeredTools().includes(name)) {
      run.called = true
      return { tool: name, input }
    }
    if (turn.step === 0) return { tool: 'tool_search', input: { query: name } }
    return { text: final }
  }
}

function startToolTurn(tag: string, name: string, input: JsonObject): ToolRun {
  const run: ToolRun = { called: false, result: undefined }
  world.stub.owner.set(tag, toolPlan(name, input, run, `pong-${tag}`))
  ownerSays(`own-${tag} выполни`)
  return run
}

const finished = (tag: string): boolean => ownerTexts().some((text) => text.includes(`pong-${tag}`))

/** The model calls the tool and the call must draw a card: it is declined and the tool answers with a refusal. */
async function toolWithCard(d: Daemon, tag: string, name: string, input: JsonObject): Promise<void> {
  const seen = cards().length
  const withPurpose =
    name === 'exec' || name === 'host_exec' ? { ...input, purpose: 'проверяю карточку подтверждения команды' } : input
  const run = startToolTurn(tag, name, withPurpose)
  const card = await nextCard(d, seen, `${name} ${JSON.stringify(withPurpose)}`)
  press(card, card.deny)
  await waitFor(`the answer pong-${tag}`, () => finished(tag), d)
  expect(run.called, `the model reached the tool ${name}\n${d.stderr.slice(-1500)}`).toBe(true)
  expect(run.result?.isError, `the declined call is an error result: ${run.result?.text.slice(0, 300)}`).toBe(true)
}

/** The model calls the tool and the call must go through without a card. */
async function toolWithoutCard(d: Daemon, tag: string, name: string, input: JsonObject): Promise<ToolResult> {
  const seen = cards().length
  const run = startToolTurn(tag, name, input)
  await waitFor(`the answer pong-${tag} or a card`, () => finished(tag) || cards().length > seen, d)
  expect(cards().length, `no card for ${name} ${JSON.stringify(input)}`).toBe(seen)
  expect(run.called, `the model reached the tool ${name}\n${d.stderr.slice(-1500)}`).toBe(true)
  return run.result as ToolResult
}

/** A read-only git command, spelled out in parts. */
const GIT_READ = ['git', 'sta' + 'tus'].join(' ')

let watchCounter = 0

function watchInput(command: string): JsonObject {
  watchCounter += 1
  return {
    action: 'watch',
    command,
    pattern: 'NEVER-MATCHES-ANY-LINE',
    window_sec: 30,
    deliver: 'raw',
    task: `watch number ${watchCounter}`,
  }
}

let tagCounter = 0

/** A tag of an owner turn: letters only after the prefix, and different every call. */
function nextTag(prefix: string): string {
  tagCounter += 1
  return `${prefix}${String.fromCharCode(97 + (tagCounter % 26))}${Math.floor(tagCounter / 26)}`
}

async function watchWithoutCard(d: Daemon, command: string): Promise<void> {
  const result = await toolWithoutCard(d, nextTag('w'), 'schedule', watchInput(command))
  expect(result.isError, `the watch is created: ${result.text.slice(0, 400)}`).toBe(false)
}

async function watchWithCard(d: Daemon, command: string): Promise<void> {
  await toolWithCard(d, nextTag('w'), 'schedule', watchInput(command))
}

function seedWorkspace(): void {
  const workspace = join(world.dshbotHome, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'mk-1'), 'BANG-23\n')
}

// --- [c1] unparseable syntax alone draws no card -------------------------------------------------------------------

test('test_c1_unparseable_syntax_in_the_sandbox_draws_no_card_in_bang_exec_and_watch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  await bangWithoutCard(d, `python3 -c "print('BA'+'NG-11')"`, 'BANG-11')
  await bangWithoutCard(d, 'echo BAN""G-12$(echo)', 'BANG-12')
  await bangWithoutCard(d, 'echo BAN""G-13`echo`', 'BANG-13')
  await bangWithoutCard(d, 'eval "echo BAN""G-14"', 'BANG-14')
  await bangWithoutCard(d, `node -e "console.log('BA'+'NG-15')"`, 'BANG-15')
  await bangWithoutCard(d, 'CMD="echo BAN""G-16"; bash -c "$CMD"', 'BANG-16')

  const model = await toolWithoutCard(d, nextTag('e'), 'exec', { command: `python3 -c "print('BA'+'NG-17')"` })
  expect(model.isError, `exec of the model runs: ${model.text.slice(0, 300)}`).toBe(false)
  expect(model.text).toContain('BANG-17')

  await watchWithoutCard(d, `python3 -c "import time; time.sleep(600)"`)
  await watchWithoutCard(d, 'echo $(date); sleep 600')
  await watchWithoutCard(d, 'echo `date`; sleep 601')
})

// --- [c2] a nested command is judged by the same rules ---------------------------------------------------------------

test('test_c2_a_destructive_nested_command_in_the_sandbox_draws_a_card_in_bang_and_watch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  await bangWithCard(d, 'bash -c "rm -r build-c2"')
  await bangWithCard(d, 'sh -c "git push origin main"')
  await bangWithCard(d, 'echo $(rm -r build-c2)')
  await bangWithCard(d, 'find . -name "*.log" -exec rm -r {} +')
  await bangWithCard(d, 'ls | xargs rm -r')

  await watchWithCard(d, 'bash -c "rm -r build-c2"; sleep 600')
  await watchWithCard(d, 'sh -c "git push origin main"; sleep 600')
  await watchWithCard(d, 'echo $(rm -r build-c2); sleep 600')
})

test('test_c2_a_harmless_nested_command_in_the_sandbox_draws_no_card_in_bang_and_watch', { timeout: TEST_TIMEOUT_MS }, async () => {
  seedWorkspace()
  const d = await startOwnerDaemon()

  await bangWithoutCard(d, 'bash -c "echo BAN""G-21"', 'BANG-21')
  await bangWithoutCard(d, 'echo $(echo BAN""G-22)', 'BANG-22')
  await bangWithoutCard(d, 'find . -maxdepth 1 -name "mk-*" -exec cat {} +', 'BANG-23')
  await bangWithoutCard(d, 'echo x | xargs echo BAN""G-24', 'BANG-24')

  await watchWithoutCard(d, 'bash -c "ls -la"; sleep 600')
  await watchWithoutCard(d, `echo $(${GIT_READ}); sleep 600`)
  await watchWithoutCard(d, 'find . -name "*.ts" -exec grep -l foo {} +; sleep 600')
  await watchWithoutCard(d, 'ls | xargs wc -l; sleep 600')
})

// --- [c3] kill in the sandbox ----------------------------------------------------------------------------------------

test('test_c3_kill_pkill_and_killall_in_the_sandbox_draw_no_card_in_bang_exec_and_watch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  await bangWithoutCard(d, 'kill 4242; echo BAN""G-31', 'BANG-31')
  await bangWithoutCard(d, 'pkill node; echo BAN""G-32', 'BANG-32')
  await bangWithoutCard(d, 'killall python3; echo BAN""G-33', 'BANG-33')

  const model = await toolWithoutCard(d, nextTag('k'), 'exec', { command: 'kill 4242; echo BAN""G-34' })
  expect(model.text).toContain('BANG-34')

  await watchWithoutCard(d, 'kill 4242; sleep 600')
  await watchWithoutCard(d, 'pkill node; sleep 601')
  await watchWithoutCard(d, 'killall python3; sleep 602')
})

// --- [c4] destructive commands still ask; publication is still refused ---------------------------------------------

const DESTRUCTIVE = [
  'rm -r build-c4',
  'rm -rf build-c4',
  'find . -name "*.tmp" -delete',
  'git push origin main',
  'git reset --hard',
  'git clean -fd',
  'psql -c "DROP TABLE users"',
  'reboot',
  'systemctl --user restart dshbot',
  'rm $TARGET',
]

test('test_c4_destructive_commands_in_the_sandbox_still_draw_a_card_in_bang_exec_and_watch', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()

  for (const command of DESTRUCTIVE) await bangWithCard(d, command)
  await toolWithCard(d, nextTag('x'), 'exec', { command: 'rm -rf build-c4' })
  await toolWithCard(d, nextTag('x'), 'exec', { command: 'rm $TARGET' })
  await watchWithCard(d, 'find . -name "*.tmp" -delete; sleep 600')
  await watchWithCard(d, 'git reset --hard; sleep 600')
})

test('test_c4_publication_in_the_sandbox_is_still_refused_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const d = await startOwnerDaemon()
  const seen = cards().length

  ownerSays('!gh repo create x --public')
  const watch = await toolWithoutCard(d, nextTag('p'), 'schedule', watchInput('gh repo create x --public'))
  expect(watch.isError, `the watch with a publication is refused: ${watch.text.slice(0, 300)}`).toBe(true)
  const model = await toolWithoutCard(d, nextTag('p'), 'exec', { command: 'gh repo create x --public' })
  expect(model.isError, `exec with a publication is refused: ${model.text.slice(0, 300)}`).toBe(true)

  await sleep(1_500)
  expect(cards().length, 'a denied command asks nobody').toBe(seen)
})

// --- [c5] host_exec keeps the old rules ----------------------------------------------------------------------------

test('test_c5_host_exec_still_draws_a_card_for_unparseable_syntax_and_kill', { timeout: TEST_TIMEOUT_MS }, async () => {
  writeFileSync(join(world.dshbotHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))
  const d = await startOwnerDaemon()

  await toolWithCard(d, nextTag('h'), 'host_exec', { host: 'box', command: 'python3 -c "print(1)"' })
  await toolWithCard(d, nextTag('h'), 'host_exec', { host: 'box', command: 'echo $(date)' })
  await toolWithCard(d, nextTag('h'), 'host_exec', { host: 'box', command: 'kill 4242' })
})
