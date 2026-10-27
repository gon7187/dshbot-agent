// Groups the bot lives in: a durable allowlist of group chats opened by the
// owner from the group itself, and the rule that decides whether a group
// message is addressed to the bot.
//
// The list lives in the same state.db the rest of the daemon opens (the store
// exposes `migrate`/`db` for exactly this), so a restart with the same
// DSHBOT_HOME keeps every opened group open. A group is never a guest chat:
// it has its own harness session id and its own daily accounting, but the
// turns are non-owner turns and see only the guest toolset.

import type { Store } from '../../store/src/index.js'

/** Prefix of the harness session id owned by one group chat (`group-<chat_id>`). */
export const GROUP_SESSION_PREFIX = 'group-'

const GROUP_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS groups (
    chat_id INTEGER PRIMARY KEY,
    added_at INTEGER NOT NULL
  )`,
]

interface GroupRow {
  chat_id: number | bigint
  added_at: number | bigint
}

/** One allowed group as stored. */
export interface GroupRecord {
  chatId: number
  addedAt: number
}

function toNumber(value: number | bigint | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  return typeof value === 'bigint' ? Number(value) : value
}

/** Whether a Telegram chat type is a group the bot may live in. */
export function isGroupChatType(type: string | undefined): boolean {
  return type === 'group' || type === 'supergroup'
}

/** Durable harness session id of one group chat. */
export function groupSessionId(chatId: number): string {
  return `${GROUP_SESSION_PREFIX}${chatId}`
}

/** Chat id carried by a group harness session id, if it is one. */
export function groupChatOfSession(sessionId: string | undefined): number | undefined {
  if (sessionId === undefined || !sessionId.startsWith(GROUP_SESSION_PREFIX)) return undefined
  const raw = sessionId.slice(GROUP_SESSION_PREFIX.length)
  if (!/^-?\d+$/.test(raw)) return undefined
  const chatId = Number(raw)
  return Number.isSafeInteger(chatId) ? chatId : undefined
}

/** The bot as the Bot API names it: the id tells a reply to this bot from another. */
export interface BotIdentity {
  id?: number
  username?: string
}

/** The addressing facts of one group message. */
export interface GroupAddressing {
  /** Usernames of the `mention`/`text_mention` entities, without the leading `@`. */
  mentions?: readonly string[]
  replyTo?: { fromBot: boolean; fromId?: number }
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '').toLowerCase()
}

/**
 * Whether a group message is addressed to the bot: an `@bot` mention entity or
 * a reply to a message the bot itself sent. A plain text mention without an
 * entity, a mention of another bot and a reply to another member are not.
 */
export function addressesBot(message: GroupAddressing, bot: BotIdentity): boolean {
  const username = bot.username === undefined ? '' : normalizeHandle(bot.username)
  if (username !== '') {
    for (const handle of message.mentions ?? []) {
      if (normalizeHandle(handle) === username) return true
    }
  }
  const reply = message.replyTo
  if (reply !== undefined && reply.fromBot && bot.id !== undefined && reply.fromId === bot.id) return true
  return false
}

/** The durable list of group chats the bot answers in. */
export class GroupRegistry {
  private readonly store: Store

  constructor(store: Store) {
    this.store = store
    store.migrate('groups', GROUP_STEPS)
  }

  /** Adds the group to the allowlist; a repeated allow is a no-op. */
  allow(chatId: number, now: number): void {
    this.store.db
      .prepare('INSERT INTO groups (chat_id, added_at) VALUES (?, ?) ON CONFLICT (chat_id) DO NOTHING')
      .run(chatId, now)
  }

  /** Removes the group from the allowlist; returns whether it was allowed. */
  deny(chatId: number): boolean {
    const removed = this.store.db.prepare('DELETE FROM groups WHERE chat_id = ?').run(chatId)
    return (toNumber(removed.changes) ?? 0) >= 1
  }

  /** Whether the owner has opened the group. */
  isAllowed(chatId: number): boolean {
    const row = this.store.db.prepare('SELECT chat_id FROM groups WHERE chat_id = ?').get(chatId)
    return row !== undefined
  }

  /** Allowed groups in the order the owner opened them. */
  list(): GroupRecord[] {
    const rows = this.store.db
      .prepare('SELECT chat_id, added_at FROM groups ORDER BY added_at, chat_id')
      .all() as unknown as GroupRow[]
    return rows.map((row) => ({
      chatId: Number(row.chat_id),
      addedAt: toNumber(row.added_at) ?? 0,
    }))
  }
}
