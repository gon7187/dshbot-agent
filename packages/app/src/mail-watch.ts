// The owner's mail watcher: a periodic check of every box of DSHBOT_HOME/mail.json
// that runs without a model turn and answers with one short Telegram message.
//
// The mark of the watcher lives in its own file (`mail-watch.json`) and is not the
// checkpoint of the `mail` tool: a notification never hides a letter from `list`.
// The file also keeps the switch, the interval and the failure streaks, so a
// restart of the daemon neither forgets the settings nor repeats an old letter.
//
// Only a box that failed is reported: one notice per failure streak and one
// message when the box answers again. Every check is read-only and capped to the
// header block of a letter; the body is never fetched and no model is called.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { formatMailDate, mailError, readBoxes } from '../../tools-mail/src/index.js'
import { pollMailBox, type MailWatchMark, type MailWatchPoll } from '../../tools-mail/src/watch.js'

/** File of the watcher inside DSHBOT_HOME. */
export const MAIL_WATCH_FILE = 'mail-watch.json'

/** The shortest interval the owner may choose. */
export const MAIL_WATCH_MIN_SECONDS = 60

/** Interval of a watcher switched on without one. */
export const MAIL_WATCH_DEFAULT_SECONDS = 300

type MailWatchBoxState = MailWatchMark

/** Durable state of the watcher. */
export interface MailWatchState {
  enabled: boolean
  intervalSeconds: number
  /** Marks by box name. */
  boxes: Record<string, MailWatchBoxState>
  /** Boxes in a failure streak; a repeated failure stays quiet. */
  failing: Record<string, boolean>
}

export interface MailWatcherDeps {
  /** DSHBOT_HOME: `mail.json` and `mail-watch.json`. */
  home: string
  /** Chat of the paired owner, or null when nobody is paired. */
  ownerChatId: () => number | null
  /** Sends one plain-text Telegram message; false when it was not delivered. */
  send: (chatId: number, text: string) => Promise<boolean>
  log: (message: string) => void
  /** State file override (tests); defaults to DSHBOT_HOME/mail-watch.json. */
  stateFile?: string
}

export interface MailWatcher {
  /** Starts the interval when the persisted state is switched on. */
  start(): void
  /** Stops the interval; the persisted state stays as it is. */
  stop(): void
  /** Switches the watcher on with `seconds` and checks the boxes at once. */
  enable: (seconds: number) => void
  /** Switches the watcher off and stops its interval. */
  disable: () => void
  /** One check of every box; exposed for tests and for the immediate check. */
  tick: () => Promise<void>
  /** Current switch and interval. */
  state: () => { enabled: boolean; intervalSeconds: number }
  /** Owner-facing state line used by `/mailwatch`. */
  stateText: () => string
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function emptyState(): MailWatchState {
  return { enabled: false, intervalSeconds: MAIL_WATCH_DEFAULT_SECONDS, boxes: {}, failing: {} }
}

/** Reads the state file; a missing or broken file means a watcher that is off. */
export function readMailWatchState(path: string): MailWatchState {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return emptyState()
  }
  const object = asObject(parsed)
  const state = emptyState()
  state.enabled = object.enabled === true
  const interval = positiveInteger(object.intervalSeconds)
  if (interval !== undefined && interval >= MAIL_WATCH_MIN_SECONDS) state.intervalSeconds = interval
  for (const [name, value] of Object.entries(asObject(object.boxes))) {
    const entry = asObject(value)
    const uidvalidity = nonNegativeInteger(entry.uidvalidity)
    const uid = nonNegativeInteger(entry.uid)
    if (uidvalidity === undefined || uid === undefined) continue
    state.boxes[name] = { uidvalidity, uid }
  }
  for (const [name, value] of Object.entries(asObject(object.failing))) {
    if (value === true) state.failing[name] = true
  }
  return state
}

/** Writes through a sibling file, so a crash cannot leave half JSON. */
export function writeMailWatchState(path: string, state: MailWatchState): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Parses `/mailwatch`'s interval: integer `s`, `m` or `h`, at least one minute. */
export function parseMailWatchInterval(spec: string): number | undefined {
  const match = /^(\d+)\s*([smh])$/i.exec(spec.trim())
  if (match === null) return undefined
  const amount = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const seconds = unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600
  if (!Number.isSafeInteger(seconds) || seconds < MAIL_WATCH_MIN_SECONDS) return undefined
  return seconds
}

/** `7 мин`, `2 ч`, `90 с`; the tests and the owner read a duration, not a locale. */
export function formatMailWatchInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ч`
  if (seconds % 60 === 0) return `${seconds / 60} мин`
  return `${seconds} с`
}

function stateText(state: { enabled: boolean; intervalSeconds: number }): string {
  if (!state.enabled) {
    return `Наблюдатель почты выключен, интервал ${formatMailWatchInterval(state.intervalSeconds)} (${state.intervalSeconds} с). Включить: /mailwatch 5m (s, m, h; не меньше минуты).`
  }
  return `Наблюдатель почты включён: интервал ${formatMailWatchInterval(state.intervalSeconds)} (${state.intervalSeconds} с).`
}

function oneLine(value: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/**
 * One notification of a box: a line per letter with sender, subject and time,
 * at most ten lines and the count of the rest.
 */
export function formatMailWatchNotice(box: string, poll: MailWatchPoll): string {
  const lines = [`Новые письма в ящике ${box}: ${poll.newCount}`]
  for (const letter of poll.letters) {
    const from = oneLine(letter.from, 80) || '(отправитель скрыт)'
    const subject = oneLine(letter.subject, 120) || '(без темы)'
    lines.push(`${from} | ${subject} | ${formatMailDate(letter.date)}`)
  }
  const rest = poll.newCount - poll.letters.length
  if (rest > 0) lines.push(`и ещё ${rest}`)
  return lines.join('\n')
}

function failureText(box: string, error: unknown): string {
  return `Ящик ${box} недоступен: ${mailError(error)}`
}

function recoveredText(box: string): string {
  return `Ящик ${box} снова доступен.`
}

export function createMailWatcher(deps: MailWatcherDeps): MailWatcher {
  const path = deps.stateFile ?? join(deps.home, MAIL_WATCH_FILE)
  const state = readMailWatchState(path)
  const log = deps.log
  const send = deps.send

  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let generation = 0
  let inFlight: Promise<void> | undefined
  let inFlightGeneration = -1

  function save(): void {
    try {
      writeMailWatchState(path, state)
    } catch (error) {
      log(`mail watch: не удалось сохранить состояние: ${mailError(error)}`)
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  function schedule(): void {
    clearTimer()
    timer = setInterval(() => {
      void tick().catch((error) => log(`mail watch: проверка не выполнена: ${mailError(error)}`))
    }, state.intervalSeconds * 1000)
  }

  function stale(atGeneration: number): boolean {
    return stopped || generation !== atGeneration || !state.enabled
  }

  async function checkBox(chatId: number, name: string, atGeneration: number): Promise<void> {
    const mark = state.boxes[name]
    let poll: MailWatchPoll
    try {
      poll = await pollMailBox({ home: deps.home, box: name, ...(mark === undefined ? {} : { mark }) })
    } catch (error) {
      if (stale(atGeneration)) return
      if (state.failing[name] === true) return
      // One notice per failure streak: the flag is durable before the send, so a
      // failed send cannot turn every tick into another notice.
      state.failing[name] = true
      save()
      await send(chatId, failureText(name, error))
      return
    }
    if (stale(atGeneration)) return

    const wasFailing = state.failing[name] === true
    if (wasFailing) {
      delete state.failing[name]
      save()
      await send(chatId, recoveredText(name))
      if (stale(atGeneration)) return
    }

    // A first check or a changed UIDVALIDITY places the mark on the current
    // highest UID: no old letter is announced.
    if (poll.reset) {
      state.boxes[name] = { uidvalidity: poll.uidvalidity, uid: poll.maxUid }
      save()
      return
    }

    const previous = state.boxes[name]
    const next = { uidvalidity: poll.uidvalidity, uid: poll.maxUid }
    const moved = previous === undefined || previous.uidvalidity !== next.uidvalidity || previous.uid !== next.uid
    if (moved) {
      // The mark is durable before the send: neither a restart during the send
      // nor a later check can announce the same letter again.
      state.boxes[name] = next
      save()
    }
    if (poll.newCount === 0) return
    const delivered = await send(chatId, formatMailWatchNotice(name, poll))
    // An undelivered notice gives the letters back to the next check, unless a
    // later check has already moved the mark on.
    if (!delivered && moved && state.boxes[name] === next) {
      if (previous === undefined) delete state.boxes[name]
      else state.boxes[name] = previous
      save()
    }
  }

  async function checkAll(chatId: number, atGeneration: number): Promise<void> {
    let names: string[]
    try {
      names = [...readBoxes(deps.home).keys()]
    } catch (error) {
      log(`mail watch: mail.json не прочитан: ${mailError(error)}`)
      return
    }
    for (const name of names) {
      if (stale(atGeneration)) return
      await checkBox(chatId, name, atGeneration)
    }
  }

  async function tick(): Promise<void> {
    if (stopped || !state.enabled) return
    const chatId = deps.ownerChatId()
    // Without a paired owner nothing is checked and no mark moves: the letters
    // stay new and are announced once the owner is back.
    if (chatId === null) return
    if (inFlight !== undefined && inFlightGeneration === generation) return inFlight
    const atGeneration = generation
    // Checks never overlap, whatever their generation: a check of a newer
    // generation waits for the running one and then reads the mark it left.
    const previous = inFlight ?? Promise.resolve()
    const run = previous
      .then(() => (stale(atGeneration) ? undefined : checkAll(chatId, atGeneration)))
      .catch((error) => {
        log(`mail watch: проверка не выполнена: ${mailError(error)}`)
      })
    inFlight = run
    inFlightGeneration = atGeneration
    void run.finally(() => {
      if (inFlight === run) {
        inFlight = undefined
        inFlightGeneration = -1
      }
    })
    return run
  }

  function start(): void {
    if (!state.enabled) return
    stopped = false
    generation += 1
    // A restored watcher waits for its interval: the first check of a new
    // process starts from the persisted mark, never from an extra tick that the
    // owner did not ask for.
    schedule()
  }

  function stop(): void {
    stopped = true
    generation += 1
    clearTimer()
  }

  function enable(seconds: number): void {
    state.enabled = true
    state.intervalSeconds = Math.max(MAIL_WATCH_MIN_SECONDS, Math.trunc(seconds))
    save()
    stopped = false
    generation += 1
    schedule()
    void tick().catch((error) => log(`mail watch: проверка не выполнена: ${mailError(error)}`))
  }

  function disable(): void {
    state.enabled = false
    save()
    generation += 1
    clearTimer()
  }

  return {
    start,
    stop,
    enable,
    disable,
    tick,
    state: () => ({ enabled: state.enabled, intervalSeconds: state.intervalSeconds }),
    stateText: () => stateText(state),
  }
}
