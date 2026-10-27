// Bot command menu with a hash cache: setMyCommands is called only when the effective
// list changes, and Bot API's 100-command ceiling is enforced before sending.

import { createHash } from 'node:crypto'
import type { TelegramApi } from './api.js'

/** Bot API cap for setMyCommands. */
export const MAX_BOT_COMMANDS = 100

export interface BotCommand {
  command: string
  description: string
}

/** Bot API scope of one command menu. */
export interface BotCommandScope {
  type: 'default' | 'chat'
  chat_id?: number | string
}

const sentListHash = new WeakMap<TelegramApi, Map<string, string>>()

function hashCommands(commands: readonly BotCommand[]): string {
  return createHash('sha256').update(JSON.stringify(commands), 'utf8').digest('hex')
}

function scopeKey(scope: BotCommandScope | undefined): string {
  return scope === undefined ? 'default' : JSON.stringify(scope)
}

/**
 * Publish a bot command menu. The list belongs to one scope (the owner's chat
 * or the default guest list); repeating the same list in the same scope is a
 * no-op for the same API instance.
 */
export async function setCommands(
  api: TelegramApi,
  list: readonly BotCommand[],
  scope?: BotCommandScope,
): Promise<void> {
  const commands = list
    .slice(0, MAX_BOT_COMMANDS)
    .map(({ command, description }) => ({ command, description }))
  const hash = hashCommands(commands)

  let sent = sentListHash.get(api)
  if (sent === undefined) {
    sent = new Map<string, string>()
    sentListHash.set(api, sent)
  }
  const key = scopeKey(scope)
  if (sent.get(key) === hash) return

  await api.call('setMyCommands', { commands, ...(scope === undefined ? {} : { scope }) })
  sent.set(key, hash)
}
