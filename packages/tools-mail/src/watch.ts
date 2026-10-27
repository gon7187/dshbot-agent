// Periodic read-only checks of one mailbox for the owner's mail watcher.
//
// The watcher has a mark of its own, apart from the checkpoint of the `mail`
// tool: the tool still shows every letter above its checkpoint as new after a
// watcher notification. A file in DSHBOT_HOME keeps the mark and survives a
// restart of the daemon.
//
// One check opens the box, reads its UIDVALIDITY and asks for the UIDs above the
// mark. Without a mark, or when UIDVALIDITY changed, the caller gets `reset` and
// the current highest UID: the mark is placed there and no old letter is
// announced. A new letter comes back with its sender, subject and date from the
// header block only; the body is never fetched.

import {
  closeQuietly,
  fetchMessages,
  searchUids,
  type ImapConnection,
} from './imap.js'
import { decodeWords, headersOf } from './message.js'
import { openBox, passwordOf, readBoxes, type BoxConfig } from './index.js'

/** The mark of the watcher for one box, tied to the UIDVALIDITY of the box. */
export interface MailWatchMark {
  uidvalidity: number
  uid: number
}

/** One letter as a notification names it. */
export interface MailWatchLetter {
  uid: number
  /** Sender name or address, decoded and on one line. */
  from: string
  subject: string
  date: Date | undefined
}

/** The outcome of one check of one box. */
export interface MailWatchPoll {
  uidvalidity: number
  /** Highest UID in the box at the moment of the check. */
  maxUid: number
  /** No usable mark (first check or a changed UIDVALIDITY): set the mark, say nothing. */
  reset: boolean
  /** How many letters are above the mark, including those beyond the listed ones. */
  newCount: number
  /** The earliest letters above the mark, at most {@link MAIL_WATCH_LIST_LIMIT}. */
  letters: MailWatchLetter[]
}

/** How many letters one notification lists; the rest is only counted. */
export const MAIL_WATCH_LIST_LIMIT = 10

export interface PollMailBoxOptions {
  /** DSHBOT_HOME with `mail.json`. */
  home: string
  /** Name of the box in `mail.json`. */
  box: string
  /** The stored mark; undefined means the box has not been checked yet. */
  mark?: MailWatchMark | undefined
  /** Socket timeout of one IMAP command. */
  timeoutMs?: number
  signal?: AbortSignal
}

function headerText(headers: Map<string, string>, name: string): string {
  return decodeWords(headers.get(name) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function dateHeader(headers: Map<string, string>): Date | undefined {
  const raw = headers.get('date')
  if (raw === undefined) return undefined
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

function maxUidOf(uids: readonly number[]): number {
  let max = 0
  for (const uid of uids) if (uid > max) max = uid
  return max
}

function boxByName(home: string, name: string): BoxConfig {
  const boxes = readBoxes(home)
  const box = boxes.get(name)
  if (box === undefined) {
    const known = [...boxes.keys()].sort().join(', ')
    throw new Error(
      `наблюдатель почты: ящик ${JSON.stringify(name)} не описан в mail.json${known === '' ? '' : ` (есть: ${known})`}`,
    )
  }
  return box
}

function allUids(connection: ImapConnection): Promise<number[]> {
  return connection.command('UID SEARCH ALL').then((reply) => searchUids(reply))
}

/**
 * One check of one box. Throws on a connection, login or protocol failure; the
 * caller decides how to report it. The connection is always closed.
 */
export async function pollMailBox(options: PollMailBoxOptions): Promise<MailWatchPoll> {
  const box = boxByName(options.home, options.box)
  const password = passwordOf(box)
  const session = await openBox(
    box,
    password,
    { home: options.home, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
    options.signal,
  )
  try {
    const uidvalidity = session.uidvalidity
    const mark = options.mark
    if (mark === undefined || mark.uidvalidity !== uidvalidity) {
      return {
        uidvalidity,
        maxUid: maxUidOf(await allUids(session.connection)),
        reset: true,
        newCount: 0,
        letters: [],
      }
    }
    const reply = await session.connection.command(`UID SEARCH UID ${Math.max(1, mark.uid + 1)}:*`)
    const uids = [...new Set(searchUids(reply))]
      .filter((uid) => uid > mark.uid)
      .sort((left, right) => left - right)
    const maxUid = uids.length === 0 ? mark.uid : maxUidOf(uids)
    const shown = uids.slice(0, MAIL_WATCH_LIST_LIMIT)
    const letters: MailWatchLetter[] = []
    if (shown.length > 0) {
      const fetched = await fetchMessages(
        session.connection,
        shown.join(','),
        'BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]',
      )
      const byUid = new Map(fetched.map((item) => [item.uid, item]))
      for (const uid of shown) {
        const raw = byUid.get(uid)?.literals[0]
        if (raw === undefined) continue
        const headers = headersOf(raw)
        letters.push({ uid, from: headerText(headers, 'from'), subject: headerText(headers, 'subject'), date: dateHeader(headers) })
      }
    }
    return { uidvalidity, maxUid, reset: false, newCount: uids.length, letters }
  } finally {
    closeQuietly(session.connection)
  }
}
