// `mail` — the owner's mailboxes: reading by IMAP, sending by SMTP, drafting by
// IMAP APPEND.
//
// The boxes live in `DSHBOT_HOME/mail.json`: an object `name -> entry` with
// `host`, `port`, `login` (also accepted as `user`), `password_env` (the NAME
// of an environment variable of the daemon that holds the password) and
// `tls: true`; an optional `smtp: { host, port }` is the sending side of the
// same account (port 465 is implicit TLS, every other port starts TLS with
// STARTTLS, and the login and password are the IMAP ones). A box without TLS is
// refused before any connection, so no password ever travels in clear text. A
// missing variable is an error and the value itself never enters an answer, the
// journal or the model request.
//
// Six actions:
//
//   * `list`   — the 50 earliest letters with a UID above the checkpoint of the
//                box (with a note outside the frame when more are left), or the
//                last 20 without one; sender, subject, date and UID;
//   * `read`   — the letter as text (HTML translated), its attachments with
//                names and sizes; a very long text is cut with a note;
//   * `save_attachment` — one attachment of the letter into
//                `DSHBOT_HOME/workspace/inbox/`; `..` and `/` are defused;
//   * `checkpoint` — read (no `uid`) or set the UID mark of the box;
//   * `send`   — one letter over SMTP, after the owner pressed "Отправить" on
//                the card that shows the box, every recipient, the subject and
//                the start of the text; without the card no SMTP socket opens;
//   * `draft`  — the same letter appended to the drafts folder by IMAP, with no
//                card and no SMTP connection.
//
// Attachments are files of the roots of the owner, read before the card; a
// path outside them or a hidden path is a refusal of the call. `reply_to` names
// a UID of the INBOX: its `Message-ID` goes to `In-Reply-To` and `References`
// and the subject gets one `Re: ` prefix.
//
// The checkpoint is one JSON file in DSHBOT_HOME and survives a restart. It is
// tied to the UIDVALIDITY of the mailbox: when the server renumbers the box,
// the old UID means nothing, so the mark is reset and `list` says so once.
//
// Everything a letter carries is untrusted data: `list` and `read` wrap their
// content in one EXTERNAL_UNTRUSTED_CONTENT frame with a fresh random boundary
// per call (src/untrusted-frame.ts). The tool itself is lazy and owner-only:
// the app registers it in the light prefix index and `tool_search` loads it
// into the owner's main session; a guest and a delegated child never get it.

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { RunnerTool, RunnerToolContext } from '../../runner/src/index.js'

import { composeMail, replySubject, type MailAttachment } from './compose.js'
import {
  appendMailbox,
  closeQuietly,
  connectImap,
  draftsMailbox,
  fetchMessages,
  listMailboxes,
  login,
  searchUids,
  selectInbox,
  type ImapConnection,
} from './imap.js'
import { dateOf, headersOf, parseMessage, decodeWords, senderOf, subjectOf, type ParsedMessage } from './message.js'
import { sendSmtp } from './smtp.js'
// The common frame of the bot, not a mail-only copy: the model sees the same
// opening, notice and closing lines as in web_fetch, and the notice names mail.
import { frameData } from '../../app/src/untrusted-frame.js'

/** Model-facing name of the tool. */
export const MAIL_TOOL_NAME = 'mail'

/** Actions the schema and the error of an unknown action name. */
export const MAIL_ACTIONS = ['list', 'read', 'save_attachment', 'checkpoint', 'send', 'draft'] as const
export type MailAction = (typeof MAIL_ACTIONS)[number]

/** The card text of `send` never shows more than this many characters of the letter. */
export const MAIL_CARD_TEXT_LIMIT = 1_200

/**
 * The whole card of `send`, with room for the deadline line, in one Telegram
 * message. The box, every recipient, the subject and the attachment names are
 * never cut: a letter whose card would not fit is refused before the card.
 */
export const MAIL_CARD_LIMIT = 3_800

/** A longer subject is refused by `send`: the owner must see the whole subject on the card. */
export const MAIL_SUBJECT_LIMIT = 300

/** The card always keeps at least this many characters for the start of the text. */
const MAIL_CARD_TEXT_MIN = 200

/** How many letters `list` shows when the box has no checkpoint. */
export const MAIL_WITHOUT_CHECKPOINT = 20

/**
 * Cap on the letters `list` shows after a checkpoint: the earliest ones, so a
 * long absence does not put hundreds of letters into one tool answer.
 */
export const MAIL_LIST_LIMIT = 50

/** Cap on the text of one letter in a `read` answer. */
export const MAIL_TEXT_LIMIT = 100_000

/** The card of `send` lives 30 minutes; the turn gets the wait plus a margin. */
export const MAIL_APPROVAL_WAIT_MS = 36 * 60_000

/** File of the per-box checkpoints inside DSHBOT_HOME. */
const CHECKPOINTS_FILE = 'mail-checkpoints.json'

export interface MailToolDeps {
  /** `DSHBOT_HOME`: `mail.json`, the checkpoint file and `workspace/inbox`. */
  home: string
  /** Session of the owner; the tool refuses every other session. Defaults to `main`. */
  ownerSessionId?: string
  /** Socket timeout of one IMAP command. */
  timeoutMs?: number
  /**
   * Owner confirmation of `send`. The app answers with `unavailable` outside
   * the turn of the owner, so a planned, wake-up or guest call never draws a
   * card and never sends. Without the callback `send` is refused as well.
   */
  approval?: MailApproval
  /** Allowed file roots of the owner; defaults to `workspace` and `app` under {@link home}. */
  roots?: readonly MailRoot[]
  /** Paths that stay hidden even inside a root; defaults to the private state of the bot. */
  hidden?: readonly MailHiddenPath[]
}

/** A directory attachments may come from, with the real path already resolved by the caller. */
export interface MailRoot {
  path: string
}

/** A path hidden even inside a root, with the roots it may still be read from. */
export interface MailHiddenPath {
  path: string
  allow?: readonly string[]
}

/** What the owner is asked to confirm before a letter leaves the machine. */
export interface MailApprovalRequest {
  box: string
  /** The address the letter is sent from. */
  from: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  /** File names, already checked and read; the card shows them, not the paths. */
  attachments: string[]
  /** True when the letter answers a letter of the inbox (the card says «ответ»). */
  reply?: boolean
}

export type MailApprovalDecision = 'allow' | 'deny' | 'expired' | 'unavailable'

/** Asks the owner; resolves `unavailable` when there is nobody to ask. */
export type MailApproval = (request: MailApprovalRequest) => Promise<MailApprovalDecision>

export interface BoxConfig {
  name: string
  host: string
  port: number
  login: string
  passwordEnv: string
  tls: boolean
  /** Optional sending side of the same account; the login and password are the IMAP ones. */
  smtp?: { host: string; port: number }
}

interface Checkpoint {
  uidvalidity: number
  uid: number
}

type CheckpointFile = Record<string, Checkpoint>

// --- configuration ----------------------------------------------------------------------------------

function readJson(path: string, what: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${what} не найден: ${path}`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error(`${what} не разобран как JSON: ${path}`)
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function readBoxes(home: string): Map<string, BoxConfig> {
  const path = join(home, 'mail.json')
  const parsed = asObject(readJson(path, 'mail.json'))
  const boxes = new Map<string, BoxConfig>()
  for (const [name, raw] of Object.entries(parsed)) {
    const entry = asObject(raw)
    const host = typeof entry.host === 'string' ? entry.host.trim() : ''
    const port = typeof entry.port === 'number' ? entry.port : Number.NaN
    const loginValue = entry.login ?? entry.user
    const login = typeof loginValue === 'string' ? loginValue.trim() : ''
    const passwordEnv = typeof entry.password_env === 'string' ? entry.password_env.trim() : ''
    if (host === '') throw new Error(`Ящик "${name}" в mail.json: не задан imap-хост (host)`)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Ящик "${name}" в mail.json: порт должен быть целым числом 1..65535`)
    }
    if (login === '') throw new Error(`Ящик "${name}" в mail.json: не задан логин (login)`)
    if (passwordEnv === '') {
      throw new Error(`Ящик "${name}" в mail.json: не задан password_env с именем переменной окружения`)
    }
    // TLS is not a preference: a box that does not say `tls: true` is refused
    // here, before any socket exists.
    if (entry.tls !== true) {
      throw new Error(`Ящик "${name}" отклонён: только TLS. Укажите "tls": true в mail.json`)
    }
    if (host.startsWith('-')) throw new Error(`Ящик "${name}" в mail.json: host не должен начинаться с дефиса`)
    let smtp: { host: string; port: number } | undefined
    if (entry.smtp !== undefined && entry.smtp !== null) {
      const smtpEntry = asObject(entry.smtp)
      const smtpHost = typeof smtpEntry.host === 'string' ? smtpEntry.host.trim() : ''
      const smtpPort = typeof smtpEntry.port === 'number' ? smtpEntry.port : Number.NaN
      if (smtpHost === '') throw new Error(`Ящик "${name}" в mail.json: у smtp не задан хост (smtp.host)`)
      if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
        throw new Error(`Ящик "${name}" в mail.json: порт smtp должен быть целым числом 1..65535`)
      }
      if (smtpHost.startsWith('-')) {
        throw new Error(`Ящик "${name}" в mail.json: smtp.host не должен начинаться с дефиса`)
      }
      smtp = { host: smtpHost, port: smtpPort }
    }
    boxes.set(name, { name, host, port, login, passwordEnv, tls: true, ...(smtp === undefined ? {} : { smtp }) })
  }
  return boxes
}

function boxOf(home: string, name: unknown): BoxConfig {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('mail: не указан ящик box')
  const boxes = readBoxes(home)
  const box = boxes.get(name.trim())
  if (box === undefined) {
    const known = [...boxes.keys()].sort().join(', ')
    throw new Error(`mail: ящик ${JSON.stringify(name)} не описан в mail.json${known === '' ? '' : ` (есть: ${known})`}`)
  }
  return box
}

export function passwordOf(box: BoxConfig): string {
  const password = process.env[box.passwordEnv]
  if (password === undefined || password === '') {
    throw new Error(`Ящик "${box.name}": переменная окружения ${box.passwordEnv} с паролем не задана`)
  }
  return password
}

// --- checkpoints ------------------------------------------------------------------------------------

function checkpointPath(home: string): string {
  return join(home, CHECKPOINTS_FILE)
}

function loadCheckpoints(home: string): CheckpointFile {
  try {
    return asObject(JSON.parse(readFileSync(checkpointPath(home), 'utf8')) as unknown) as CheckpointFile
  } catch {
    return {}
  }
}

/** Writes through a sibling temporary file, so a crash cannot leave half JSON. */
function saveCheckpoints(home: string, checkpoints: CheckpointFile): void {
  const path = checkpointPath(home)
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(checkpoints, null, 2), 'utf8')
  renameSync(temporary, path)
}

/** UIDVALIDITY comparison; a changed value drops the old mark and asks for one note. */
function applyUidvalidity(
  home: string,
  box: string,
  uidvalidity: number,
): { checkpoint: Checkpoint | undefined; reset: boolean } {
  const checkpoints = loadCheckpoints(home)
  const stored = checkpoints[box]
  if (stored === undefined || stored.uidvalidity === uidvalidity) return { checkpoint: stored, reset: false }
  const reset: Checkpoint = { uidvalidity, uid: 0 }
  checkpoints[box] = reset
  saveCheckpoints(home, checkpoints)
  return { checkpoint: reset, reset: true }
}

// --- formatting -------------------------------------------------------------------------------------

function two(value: number): string {
  return String(value).padStart(2, '0')
}

/** `2024-03-17 12:00` in UTC; the tests and the owner read the date, not a locale. */
export function formatMailDate(date: Date | undefined): string {
  if (date === undefined) return 'дата неизвестна'
  return (
    `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`
  )
}

function headerText(headers: Map<string, string>, name: string): string {
  return decodeWords(headers.get(name) ?? '').replace(/\s+/g, ' ').trim()
}

function dateHeader(headers: Map<string, string>): Date | undefined {
  const raw = headers.get('date')
  if (raw === undefined) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * The name of an incoming attachment after `..`, `/` and control characters
 * are defused. The name is never shortened: an outgoing letter needs the whole
 * name, and RFC 2231 carries however long it is.
 */
export function safeAttachmentName(raw: string): string {
  const slashed = raw.replace(/\\/g, '/')
  let name = slashed.slice(slashed.lastIndexOf('/') + 1)
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  name = name.replace(/^\.+$/, '')
  if (name === '') name = 'attachment'
  return name
}

/**
 * The name a file of the owner travels under: the base name of the path as it
 * was given, not the name of the target a symlink points to. A path whose base
 * name carries a control character (CR, LF, NUL, DEL) cannot be sent unchanged
 * and is refused before the owner sees a card.
 */
function outgoingAttachmentName(path: string, action: string): string {
  const name = basename(path)
  if (name === '' || name === '.' || name === '..') {
    throw new Error(`mail ${action}: у пути вложения нет имени файла: ${path}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(
      `mail ${action}: имя вложения содержит управляющие символы (CR, LF или NUL) и не может ` +
        `быть передано без изменений: ${JSON.stringify(name)}`,
    )
  }
  return name
}

function attachmentLabel(name: string, size: number): string {
  return `${name} (${size} байт)`
}

/** Cut a long letter's text at a character boundary, with a visible note. */
export function cutMailText(text: string, limit = MAIL_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  let end = limit
  const lastNewline = text.lastIndexOf('\n', limit)
  if (lastNewline > limit - 2000) end = lastNewline
  return `${text.slice(0, end)}\n\n[текст письма обрезан: показано ${end} из ${text.length} символов]`
}

// --- connection -------------------------------------------------------------------------------------

export interface BoxSession {
  connection: ImapConnection
  uidvalidity: number
  exists: number
}

export async function openBox(box: BoxConfig, password: string, deps: MailToolDeps, signal: AbortSignal | undefined): Promise<BoxSession> {
  const connection = await connectImap({
    host: box.host,
    port: box.port,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  })
  const abort = (): void => {
    try {
      connection.socket.destroy(new Error('операция IMAP отменена'))
    } catch {
      // Already closed.
    }
  }
  if (signal?.aborted === true) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    await login(connection, box.login, password)
    const selected = await selectInbox(connection)
    return { connection, uidvalidity: selected.uidvalidity, exists: selected.exists }
  } catch (error) {
    signal?.removeEventListener('abort', abort)
    closeQuietly(connection)
    throw error
  }
}

function requireUid(value: unknown, action: string): number {
  const uid = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`mail ${action}: нужен положительный целый uid`)
  return uid
}

function requireText(value: unknown, action: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`mail ${action}: нужен непустой ${field}`)
  return value
}

// --- sending and drafting --------------------------------------------------------------------------

/** True when `path` is `root` or lives below it, on already-resolved absolute paths. */
function withinPath(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realPathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** One address per element; a single string is accepted too. `Name <a@b>` keeps only the address. */
function addressesFrom(value: unknown, action: string, field: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) throw new Error(`mail ${action}: нужен непустой ${field}`)
    return []
  }
  const raw = typeof value === 'string' ? [value] : value
  if (!Array.isArray(raw)) throw new Error(`mail ${action}: ${field} должен быть адресом или списком адресов`)
  const addresses: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error(`mail ${action}: ${field} должен содержать строки-адреса`)
    const angle = /<([^<>]+)>/.exec(item)
    const address = (angle === null ? item : (angle[1] as string)).trim()
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address)) {
      throw new Error(`mail ${action}: ${field} содержит неверный адрес ${JSON.stringify(item)}`)
    }
    addresses.push(address)
  }
  if (required && addresses.length === 0) throw new Error(`mail ${action}: нужен хотя бы один адрес в ${field}`)
  return addresses
}

/** Paths of the attachments as the model named them; every element must be a non-empty string. */
function attachmentPaths(value: unknown, action: string): string[] {
  if (value === undefined || value === null) return []
  const raw = typeof value === 'string' ? [value] : value
  if (!Array.isArray(raw)) throw new Error(`mail ${action}: attachments должен быть списком путей`)
  const paths: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`mail ${action}: attachments должен содержать непустые пути`)
    }
    // The path is kept exactly as it was given: a trailing space belongs to the
    // file name, and a trailing line break is caught by the name check below,
    // not silently cut into a path that names another file.
    paths.push(item)
  }
  return paths
}

/**
 * Reads every attachment before the owner is asked: a missing file, a path
 * outside the roots of the owner or a hidden path is a refusal of the call, so
 * no card is drawn and no letter leaves the machine.
 */
function readAttachments(deps: MailToolDeps, paths: readonly string[], action: string): MailAttachment[] {
  if (paths.length === 0) return []
  const workspace = join(deps.home, 'workspace')
  const configured = deps.roots ?? [{ path: workspace }, { path: join(deps.home, 'app') }]
  const roots = configured.map((root) => realPathOr(root.path))
  const hidden = deps.hidden ?? []
  const result: MailAttachment[] = []
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : resolve(workspace, path)
    // The name comes from the path the owner (or the model) gave, so a symlink
    // `report.csv -> data.csv` is attached as `report.csv`; `real` only proves
    // that the target is a file inside the allowed roots. The name is checked
    // before the file is looked up: a control character at the end of the path
    // is a refusal with its own reason, not a "file not found" of a trimmed path.
    const name = outgoingAttachmentName(absolute, action)
    let real: string
    try {
      real = realpathSync(absolute)
    } catch {
      throw new Error(`mail ${action}: файл вложения не найден: ${path}`)
    }
    if (!roots.some((root) => withinPath(real, root))) {
      throw new Error(`mail ${action}: путь вложения вне разрешённых корней: ${path}`)
    }
    for (const entry of hidden) {
      const hiddenPath = realPathOr(entry.path)
      const allowed = (entry.allow ?? []).map((item) => realPathOr(item))
      if (withinPath(real, hiddenPath) && !allowed.some((item) => withinPath(real, item))) {
        throw new Error(`mail ${action}: скрытый путь нельзя приложить к письму: ${path}`)
      }
    }
    let stats
    try {
      stats = statSync(real)
    } catch {
      throw new Error(`mail ${action}: файл вложения недоступен: ${path}`)
    }
    if (!stats.isFile()) throw new Error(`mail ${action}: вложение не является файлом: ${path}`)
    result.push({ name, content: readFileSync(real) })
  }
  return result
}

/** The lines of the card above the text: box, every recipient, the subject and the attachments, uncut. */
function mailCardHead(request: MailApprovalRequest): string {
  const lines = [
    'Отправить письмо?',
    `Ящик: ${request.box} <${request.from}>`,
    `Кому: ${request.to.join(', ')}`,
    ...(request.cc.length === 0 ? [] : [`Копия: ${request.cc.join(', ')}`]),
    `Тема: ${request.subject.replace(/\s+/g, ' ')}`,
    ...(request.attachments.length === 0 ? [] : [`Вложения: ${request.attachments.join(', ')}`]),
    '',
    'Начало текста:',
  ]
  return lines.join('\n')
}

/**
 * Why the letter cannot be shown to the owner whole, or `undefined` when its
 * card fits: a subject over {@link MAIL_SUBJECT_LIMIT} or so many recipients
 * and attachments that the start of the text would not fit any more.
 */
export function mailCardRefusal(request: MailApprovalRequest): string | undefined {
  if (request.subject.length > MAIL_SUBJECT_LIMIT) {
    return (
      `Отказ: тема письма длиннее ${MAIL_SUBJECT_LIMIT} символов (${request.subject.length}), ` +
      'владелец не увидит её в карточке подтверждения целиком; сократите тему. Письмо не отправлено.'
    )
  }
  const head = mailCardHead(request)
  if (head.length + 2 + MAIL_CARD_TEXT_MIN > MAIL_CARD_LIMIT) {
    return (
      `Отказ: адресаты (${request.to.length + request.cc.length}) и вложения письма не помещаются ` +
      'в карточку подтверждения вместе с началом текста; разделите письмо на несколько ' +
      'с меньшим числом адресатов или вложений. Письмо не отправлено.'
    )
  }
  return undefined
}

/**
 * The plain-Russian explanation of a letter card: what is sent and to whom.
 * It is built from the action itself (send or reply, the addresses of the
 * envelope), never from the subject or the body, which the model writes.
 */
export function mailExplanation(request: MailApprovalRequest): string {
  const recipients = [...request.to, ...request.cc]
  const who = recipients.length === 0 ? 'без указанных адресатов' : recipients.join(', ')
  const action = request.reply === true ? 'Отправлю ответ' : 'Отправлю письмо'
  return `${action}: ${who}. После отправки отозвать его будет нельзя.`
}

/**
 * What the owner confirms before a letter is sent: box, every recipient, the
 * subject and the start of the text. Only the text is shortened; a request
 * {@link mailCardRefusal} rejects throws instead of drawing a cut card.
 */
export function mailConfirmationText(request: MailApprovalRequest): string {
  const refusal = mailCardRefusal(request)
  if (refusal !== undefined) throw new Error(refusal)
  const head = mailCardHead(request)
  const limit = Math.min(MAIL_CARD_TEXT_LIMIT, MAIL_CARD_LIMIT - head.length - 2)
  const text = request.text.length <= limit ? request.text : `${request.text.slice(0, limit)}…`
  return `${head}\n${text}`
}

/** The Message-ID of the letter a reply answers. */
async function originalLetterHeaders(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  uid: number,
  action: string,
  signal: AbortSignal | undefined,
): Promise<{ messageId: string }> {
  const session = await openBox(box, password, deps, signal)
  try {
    const fetched = await fetchMessages(session.connection, String(uid), 'BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]')
    const raw = fetched.find((item) => item.uid === uid)?.literals[0]
    if (raw === undefined) throw new Error(`mail ${action}: письмо с uid ${uid} не найдено в ящике ${box.name}`)
    const messageId = (headersOf(raw).get('message-id') ?? '').replace(/\s+/g, '').trim()
    if (messageId === '') {
      throw new Error(`mail ${action}: у письма uid ${uid} нет заголовка Message-ID, отвечать не на что`)
    }
    return { messageId }
  } finally {
    closeQuietly(session.connection)
  }
}
// --- actions ----------------------------------------------------------------------------------------

async function listAction(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const session = await openBox(box, password, deps, signal)
  try {
    const { checkpoint, reset } = applyUidvalidity(deps.home, box.name, session.uidvalidity)
    const mark = checkpoint?.uid ?? 0
    const search = mark > 0 ? await session.connection.command(`UID SEARCH UID ${mark + 1}:*`) : await session.connection.command('UID SEARCH ALL')
    let uids = searchUids(search)
    if (mark > 0) uids = uids.filter((uid) => uid > mark)
    uids = [...new Set(uids)].sort((left, right) => left - right)
    // After a checkpoint only the earliest letters fit into one answer; the rest
    // waits for the next call with the mark moved to the last shown UID.
    const shown = mark === 0 ? uids.slice(-MAIL_WITHOUT_CHECKPOINT) : uids.slice(0, MAIL_LIST_LIMIT)
    if (shown.length === 0) {
      return `${reset ? resetNote(session.uidvalidity) : ''}Новых писем нет.`
    }
    const fetched = await fetchMessages(
      session.connection,
      shown.join(','),
      'INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]',
    )
    const byUid = new Map(fetched.map((item) => [item.uid, item]))
    const lines: string[] = []
    let displayed = 0
    let lastUid = shown[shown.length - 1] ?? 0
    for (const uid of shown) {
      const item = byUid.get(uid)
      const raw = item?.literals[0]
      if (raw === undefined) continue
      const headers = headersOf(raw)
      lines.push(
        `UID ${uid} | ${formatMailDate(dateHeader(headers))} | ${headerText(headers, 'from')} | ${headerText(headers, 'subject')}`,
      )
      displayed += 1
      lastUid = uid
    }
    const note = reset ? `${resetNote(session.uidvalidity)}\n\n` : ''
    const header = `Письма ящика ${box.name}: ${displayed}`
    const answer = `${note}${frameData([header, ...lines].join('\n'), { source: 'mail' })}`
    const remaining = mark > 0 ? uids.length - displayed : 0
    return remaining > 0 ? `${answer}\n\n${remainingNote(remaining, lastUid)}` : answer
  } finally {
    closeQuietly(session.connection)
  }
}

function resetNote(uidvalidity: number): string {
  return (
    `Отметка сброшена: UIDVALIDITY ящика изменился (сейчас ${uidvalidity}), ` +
    'старый UID больше не значит ничего. Показаны последние письма без отметки.'
  )
}

/** Outside the frame: how many letters wait past the shown portion and how to read them. */
function remainingNote(remaining: number, lastUid: number): string {
  return (
    `Осталось ещё ${remaining} писем с UID больше отметки. ` +
    `Чтобы прочитать следующие, поставьте отметку на последний показанный UID ${lastUid}: ` +
    `mail checkpoint uid=${lastUid}.`
  )
}

async function fetchLetter(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  uid: number,
  signal: AbortSignal | undefined,
): Promise<{ session: BoxSession; message: ParsedMessage }> {
  const session = await openBox(box, password, deps, signal)
  try {
    const fetched = await fetchMessages(session.connection, String(uid), 'BODY.PEEK[]')
    const raw = fetched.find((item) => item.uid === uid)?.literals[0]
    if (raw === undefined) throw new Error(`mail: письмо с uid ${uid} не найдено в ящике ${box.name}`)
    return { session, message: parseMessage(raw) }
  } catch (error) {
    closeQuietly(session.connection)
    throw error
  }
}

async function readAction(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  uid: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { session, message } = await fetchLetter(deps, box, password, uid, signal)
  try {
    const attachmentLines =
      message.attachments.length === 0
        ? ['Вложений нет.']
        : ['Вложения:', ...message.attachments.map((item) => `- ${attachmentLabel(item.name, item.size)}`)]
    const text = cutMailText(message.text.trim() === '' ? '(текст письма пуст)' : message.text)
    const content = [
      `Письмо UID ${uid}`,
      `От: ${senderOf(message)}`,
      `Тема: ${subjectOf(message)}`,
      `Дата: ${formatMailDate(dateOf(message))}`,
      ...attachmentLines,
      'Текст:',
      text,
    ].join('\n')
    return frameData(content, { source: 'mail' })
  } finally {
    closeQuietly(session.connection)
  }
}

async function saveAttachmentAction(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  uid: number,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { session, message } = await fetchLetter(deps, box, password, uid, signal)
  try {
    const wanted = safeAttachmentName(name)
    const attachment = message.attachments.find(
      (item) => item.name === name || safeAttachmentName(item.name) === wanted,
    )
    if (attachment === undefined) {
      throw new Error(`mail save_attachment: у письма ${uid} нет вложения ${JSON.stringify(name)}`)
    }
    const inbox = join(deps.home, 'workspace', 'inbox')
    mkdirSync(inbox, { recursive: true })
    const target = join(inbox, safeAttachmentName(attachment.name))
    // Defence in depth: even a pathological name stays a child of the inbox.
    if (!resolve(target).startsWith(`${resolve(inbox)}${sep}`)) {
      throw new Error('mail save_attachment: имя вложения выводит файл за пределы inbox')
    }
    writeFileSync(target, attachment.content)
    return `Вложение сохранено: ${target}`
  } finally {
    closeQuietly(session.connection)
  }
}

async function checkpointAction(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  uid: unknown,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (uid === undefined || uid === null || uid === '') {
    const checkpoints = loadCheckpoints(deps.home)
    const stored = checkpoints[box.name]
    if (stored === undefined || stored.uid === 0) {
      return `Отметка ящика ${box.name} не установлена.`
    }
    return `Отметка ящика ${box.name}: UID ${stored.uid} (UIDVALIDITY ${stored.uidvalidity}).`
  }
  const value = requireUid(uid, 'checkpoint')
  const session = await openBox(box, password, deps, signal)
  try {
    const checkpoints = loadCheckpoints(deps.home)
    checkpoints[box.name] = { uidvalidity: session.uidvalidity, uid: value }
    saveCheckpoints(deps.home, checkpoints)
    return `Отметка ящика ${box.name} установлена на UID ${value} (UIDVALIDITY ${session.uidvalidity}).`
  } finally {
    closeQuietly(session.connection)
  }
}

async function sendOrDraftAction(
  deps: MailToolDeps,
  box: BoxConfig,
  password: string,
  args: Record<string, unknown>,
  draft: boolean,
  context: RunnerToolContext | undefined,
): Promise<string> {
  const action = draft ? 'draft' : 'send'
  const signal = context?.signal
  // A box that cannot send is refused before any socket: not even the IMAP side
  // of the same account is opened for a request that must not go out.
  if (!draft && box.smtp === undefined) throw new Error(`SMTP не настроен для ящика ${box.name}`)
  const to = addressesFrom(args.to, action, 'to', true)
  const cc = addressesFrom(args.cc, action, 'cc', false)
  const subject = requireText(args.subject, action, 'subject')
  const text = requireText(args.text, action, 'text')
  const attachments = readAttachments(deps, attachmentPaths(args.attachments, action), action)

  const replyUid =
    args.reply_to === undefined || args.reply_to === null || args.reply_to === ''
      ? undefined
      : requireUid(args.reply_to, action)
  if (!draft) {
    // The card must show the whole letter head; one that would not fit is
    // refused before the card, before IMAP and before SMTP.
    const refusal = mailCardRefusal({
      box: box.name,
      from: box.login,
      to,
      cc,
      subject: replyUid === undefined ? subject : replySubject(subject),
      text,
      attachments: attachments.map((item) => item.name),
    })
    if (refusal !== undefined) throw new Error(refusal)
  }
  const original =
    replyUid === undefined
      ? undefined
      : await originalLetterHeaders(deps, box, password, replyUid, action, signal)
  const finalSubject = original === undefined ? subject : replySubject(subject)

  if (!draft) {
    const approval = deps.approval
    if (approval === undefined) {
      throw new Error('Отказ: подтверждение владельца недоступно, письмо не отправлено.')
    }
    // Waiting for the owner is not model work: the card lives 30 minutes and
    // the turn must not be cancelled by its own wall-clock cap while it waits.
    context?.extendTimeout?.(MAIL_APPROVAL_WAIT_MS)
    let decision: MailApprovalDecision
    try {
      decision = await approval({
        box: box.name,
        from: box.login,
        to,
        cc,
        subject: finalSubject,
        text,
        attachments: attachments.map((item) => item.name),
        reply: replyUid !== undefined,
      })
    } catch {
      decision = 'unavailable'
    }
    if (decision === 'expired') throw new Error('Отказ: срок подтверждения истёк, письмо не отправлено.')
    if (decision === 'unavailable') {
      throw new Error('Отказ: подтверждение владельца недоступно в этом ходе, письмо не отправлено.')
    }
    if (decision !== 'allow') throw new Error('Отказ: владелец отклонил отправку письма.')
  }

  const composed = composeMail({
    from: box.login,
    to,
    cc,
    subject: finalSubject,
    text,
    attachments,
    ...(original === undefined ? {} : { inReplyTo: original.messageId }),
  })

  if (draft) {
    const session = await openBox(box, password, deps, signal)
    try {
      const mailbox = draftsMailbox(await listMailboxes(session.connection))
      await appendMailbox(session.connection, mailbox, Buffer.from(composed.raw, 'utf8'))
      return `Черновик сохранён в папку «${mailbox}» ящика ${box.name}.`
    } finally {
      closeQuietly(session.connection)
    }
  }

  const smtp = box.smtp
  if (smtp === undefined) throw new Error(`SMTP не настроен для ящика ${box.name}`)
  try {
    await sendSmtp(
      {
        host: smtp.host,
        port: smtp.port,
        user: box.login,
        password,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      },
      { from: box.login, to, cc, raw: composed.raw },
    )
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    throw new Error(raw.startsWith('SMTP:') ? raw : `SMTP: ${raw}`)
  }
  const recipients = [...to, ...cc].join(', ')
  return `Письмо отправлено (${recipients}). Message-ID: ${composed.messageId}`
}

// --- errors -----------------------------------------------------------------------------------------
function knownPassword(box: BoxConfig): string {
  const password = process.env[box.passwordEnv]
  return password === undefined ? '' : password
}

/** Maps a transport failure to a readable error and never echoes a password. */
export function mailError(error: unknown, secret?: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  const server = /\bSMTP\b/i.test(`${raw} ${code}`) ? 'SMTP' : 'IMAP'
  let text: string
  if (/отклон|авториз|аутентиф/i.test(raw)) {
    text = raw
  } else if (/cert|сертиф|self.signed|SELF_SIGNED|verify|trust|TLS|SSL/i.test(`${raw} ${code}`)) {
    text = `Ошибка подключения к серверу ${server} по TLS: сертификат сервера не проверен (${code || raw})`
  } else if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|таймаут|timeout|ETIMEDOUT/i.test(`${raw} ${code}`)) {
    text = `Ошибка подключения к серверу ${server}: ${raw}`
  } else {
    text = raw
  }
  return secret === undefined || secret === '' ? text : text.split(secret).join('[скрыто]')
}

// --- the tool ----------------------------------------------------------------------------------------

export function createMailTool(deps: MailToolDeps): RunnerTool {
  const ownerSession = deps.ownerSessionId ?? 'main'

  async function run(args: Record<string, unknown>, context: RunnerToolContext | undefined): Promise<string> {
    const action = typeof args.action === 'string' ? args.action : ''
    if (!(MAIL_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`mail: неизвестное действие ${JSON.stringify(action)}; действия: ${MAIL_ACTIONS.join(', ')}`)
    }
    const box = boxOf(deps.home, args.box)
    // A box without a sending side answers at once, before its password
    // variable is even read.
    if (action === 'send' && box.smtp === undefined) throw new Error(`SMTP не настроен для ящика ${box.name}`)
    const password = passwordOf(box)
    try {
      if (action === 'list') return await listAction(deps, box, password, context?.signal)
      if (action === 'read') {
        return await readAction(deps, box, password, requireUid(args.uid, 'read'), context?.signal)
      }
      if (action === 'save_attachment') {
        const uid = requireUid(args.uid, 'save_attachment')
        const name = requireText(args.name, 'save_attachment', 'name')
        return await saveAttachmentAction(deps, box, password, uid, name, context?.signal)
      }
      if (action === 'send' || action === 'draft') {
        return await sendOrDraftAction(deps, box, password, args, action === 'draft', context)
      }
      return await checkpointAction(deps, box, password, args.uid, context?.signal)
    } catch (error) {
      throw new Error(mailError(error, knownPassword(box)))
    }
  }

  return {
    name: MAIL_TOOL_NAME,
    description:
      'Почта владельца: list/read/save_attachment/checkpoint читают ящик по IMAP; send отправляет письмо по SMTP (to: один или несколько адресов, subject, text, необязательные cc, attachments и reply_to — uid письма для ответа, ставит In-Reply-To/References и префикс «Re: »); каждое письмо send перед отправкой показывается владельцу карточкой подтверждения «Отправить» — без подтверждения письмо не уходит; draft с теми же полями кладёт письмо в папку черновиков ящика по IMAP без отправки и без карточки. Ящики — из DSHBOT_HOME/mail.json: IMAP только TLS, необязательный smtp {host, port} (465 — TLS сразу, 587 — STARTTLS); логин и пароль те же, что у IMAP.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...MAIL_ACTIONS],
          description: 'Что сделать: list, read, save_attachment, checkpoint, send или draft',
        },
        box: {
          type: 'string',
          description: 'Имя ящика из DSHBOT_HOME/mail.json (например, personal или work)',
        },
        uid: {
          type: 'number',
          description: 'read и save_attachment: UID письма; checkpoint: новый UID отметки (без uid — прочитать отметку)',
        },
        name: {
          type: 'string',
          description: 'save_attachment: имя вложения, как его несёт письмо',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'send и draft: один или несколько адресов получателей',
        },
        cc: {
          type: 'array',
          items: { type: 'string' },
          description: 'send и draft: необязательные адреса копии',
        },
        subject: {
          type: 'string',
          description: 'send и draft: тема письма',
        },
        text: {
          type: 'string',
          description: 'send и draft: текст письма в UTF-8',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'send и draft: пути к файлам в разрешённых корнях владельца (обычно DSHBOT_HOME/workspace)',
        },
        reply_to: {
          type: 'number',
          description: 'send и draft: UID письма из INBOX ящика, на которое отвечаем (In-Reply-To и References)',
        },
      },
      required: ['action', 'box'],
    },
    async execute(args: Record<string, unknown>, context?: RunnerToolContext): Promise<string> {
      // Owner-only at execution time too: a guest never gets the schema, and a
      // delegated child is dropped by the runner, but a loaded lazy tool must
      // also refuse a session that is not the owner's main one.
      const sessionId = context?.sessionId
      if (sessionId !== undefined && sessionId !== ownerSession) {
        throw new Error(`mail: инструмент доступен только в main-сессии владельца (${sessionId})`)
      }
      return await run(args, context)
    },
  }
}
