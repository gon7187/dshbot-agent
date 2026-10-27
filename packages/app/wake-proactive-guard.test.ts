// Unit regressions for the delivery seams of a wake-up. No daemon, database or services.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import { ownerInitiativeHold, PROACTIVE_COOLDOWN_MS } from '../consciousness/src/index.js'
import { SCRATCHPAD_LIMIT } from '../memory/src/scratchpad.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { guardWakeMessage, keepWithheldWakeText, trackOwnerDeliveries } from './src/index.js'
import { createBotMessageRegistry, createMessageTool, createReplyButtonRegistry } from './src/message-tool.js'

const OWNER = 7
const AT = Date.UTC(2026, 9, 25, 12)
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const path = mkdtempSync(join(tmpdir(), 'wake-proactive-guard-'))
  homes.push(path)
  return path
}

function fakeTelegram(): { api: TelegramApi; calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({ message_id: 17 }))
  return {
    api: { async call<T>(method: string, params?: Record<string, unknown>): Promise<T> { return await calls(method, params) as T } },
    calls,
  }
}

test.each(['owner waiting', 'cooldown'])('message send is withheld before Telegram when %s, with an allowed control', async (state) => {
  const path = home()
  const pad = join(path, 'scratchpad.md')
  const { api, calls } = fakeTelegram()
  const tool = createMessageTool({
    home: path, api, ownerChatId: () => OWNER,
    buttons: createReplyButtonRegistry(), messages: createBotMessageRegistry(),
  })
  let now = AT
  let lastBot = AT - 60_000
  const lastOwner = state === 'owner waiting' ? AT - 30_000 : AT - 120_000
  const hold = () => ownerInitiativeHold({ now, lastOwnerMessageAt: lastOwner, lastBotMessageAt: lastBot })
  const keep = (text: string, reason: string) => keepWithheldWakeText(pad, text, reason, now, 'UTC')
  const args = { action: 'send', text: `WITHHELD-TOOL-${state}` }
  const decision = guardWakeMessage(args, hold, keep)
  if (decision === undefined) await tool.execute(args)
  expect(decision?.kind).toBe('deny')
  expect(calls).not.toHaveBeenCalled()
  expect(readFileSync(pad, 'utf8')).toContain(args.text)
  expect(readFileSync(pad, 'utf8')).toMatch(/не отправлено/)

  // A genuine allowed send proves that the Telegram fake can observe delivery.
  lastBot = AT
  now = AT + PROACTIVE_COOLDOWN_MS
  expect(guardWakeMessage(args, hold, keep)).toBeUndefined()
  await tool.execute(args)
  expect(calls).toHaveBeenCalled()
  expect(JSON.stringify(calls.mock.calls)).toContain(args.text)
})

test.each(['album', 'video', 'animation'])('message %s cannot bypass the guard with a caption', (action) => {
  const keep = vi.fn()
  expect(guardWakeMessage({ action, caption: `CAPTION-${action}` }, () => 'cooldown', keep)?.kind).toBe('deny')
  expect(keep).toHaveBeenCalledWith(`CAPTION-${action}`, 'cooldown')
})

test('editing existing messages does not run the new-message guard', () => {
  const hold = vi.fn(() => 'cooldown')
  const keep = vi.fn()
  expect(guardWakeMessage({ action: 'edit', text: 'edit' }, hold, keep)).toBeUndefined()
  expect(hold).not.toHaveBeenCalled()
  expect(keep).not.toHaveBeenCalled()
})

test('a failed scratchpad write fails the guard instead of claiming that the thought was saved', () => {
  expect(() => guardWakeMessage({ action: 'send', text: 'thought' }, () => 'cooldown', () => {
    throw new Error('disk unavailable')
  })).toThrow('disk unavailable')
})

test('plain notifications (mail watcher and /notify) start the wake-up cooldown', async () => {
  const { api: base } = fakeTelegram()
  let lastBot: number | undefined
  let now = AT
  const api = trackOwnerDeliveries(base, (chat) => { if (chat === OWNER) lastBot = now })
  const hold = () => ownerInitiativeHold({ now, ...(lastBot === undefined ? {} : { lastBotMessageAt: lastBot }) })
  expect(hold()).toBeUndefined()
  await api.call('sendMessage', { chat_id: OWNER, text: 'notification' })
  expect(lastBot).toBe(AT)
  now += PROACTIVE_COOLDOWN_MS - 1
  expect(hold()).toContain('10 минут')
  now += 1
  expect(hold()).toBeUndefined()
})

test('partial notifications retain the timestamp of the successful piece; failed sends never move it', async () => {
  let now = AT
  let lastBot: number | undefined
  const base: TelegramApi = {
    async call<T>(_method: string, params?: Record<string, unknown>): Promise<T> {
      if (params?.text === 'fail') throw new Error('Telegram unavailable')
      return { message_id: 1 } as T
    },
  }
  const api = trackOwnerDeliveries(base, () => { lastBot = now })
  await expect(api.call('sendMessage', { chat_id: OWNER, text: 'fail' })).rejects.toThrow('Telegram unavailable')
  expect(lastBot).toBeUndefined()
  await api.call('sendMessage', { chat_id: OWNER, text: 'piece one' })
  now += 1_000
  await expect(api.call('sendMessage', { chat_id: OWNER, text: 'fail' })).rejects.toThrow()
  expect(lastBot).toBe(AT)
})

test('all new message routes count, but typing, drafts, edits, reactions and other chats do not', async () => {
  const { api: base } = fakeTelegram()
  const delivered = vi.fn()
  const api = trackOwnerDeliveries(base, (chat) => { if (chat === OWNER) delivered() })
  for (const method of ['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendVoice', 'sendMediaGroup', 'copyMessage', 'forwardMessage']) {
    await api.call(method, { chat_id: String(OWNER) })
  }
  expect(delivered).toHaveBeenCalledTimes(7)
  for (const method of ['sendChatAction', 'sendMessageDraft', 'editMessageText', 'deleteMessage', 'setMessageReaction']) {
    await api.call(method, { chat_id: OWNER })
  }
  await api.call('sendMessage', { chat_id: OWNER + 1 })
  expect(delivered).toHaveBeenCalledTimes(7)
})

test('the shared API wrapper forwards uploads, downloads and the original response', async () => {
  const response = { message_id: 41 }
  const bytes = new Uint8Array([1, 2, 3])
  const call = vi.fn(async (..._args: Parameters<TelegramApi['call']>) => response)
  const downloadFile = vi.fn(async () => bytes)
  const base: TelegramApi = { call: async <T>(...args: Parameters<TelegramApi['call']>) => await call(...args) as T, downloadFile }
  const api = trackOwnerDeliveries(base, vi.fn())
  const params = { chat_id: OWNER }
  const files = { photo: { name: 'image.png', data: bytes } }
  expect(await api.call('sendPhoto', params, files)).toBe(response)
  expect(call).toHaveBeenCalledWith('sendPhoto', params, files)
  expect(await api.downloadFile?.('remote/file')).toBe(bytes)
  expect(downloadFile).toHaveBeenCalledWith('remote/file')
})

test('a full pad retains the entire new thought and the most recent older notes within its Unicode limit', () => {
  const pad = join(home(), 'scratchpad.md')
  const recent = 'RECENT-NOTES'
  writeFileSync(pad, 'x'.repeat(SCRATCHPAD_LIMIT - [...recent].length) + recent)
  const thought = 'WITHHELD-FULL-PAD: мысль с emoji 🌅 и важным концом.'
  keepWithheldWakeText(pad, thought, 'владелец ждёт ответа', AT, 'UTC')
  const saved = readFileSync(pad, 'utf8')
  expect(saved).toContain(thought)
  expect(saved).toContain('RECENT-NOTES')
  expect(saved).toContain('не отправлено владельцу (владелец ждёт ответа)')
  expect([...saved].length).toBeLessThanOrEqual(SCRATCHPAD_LIMIT)
})

test('an oversized thought is explicitly shortened without splitting emoji or dropping its marker', () => {
  const pad = join(home(), 'scratchpad.md')
  keepWithheldWakeText(pad, 'WITHHELD-LONG: ' + '🌅'.repeat(SCRATCHPAD_LIMIT), 'cooldown', AT, 'UTC')
  const saved = readFileSync(pad, 'utf8')
  expect(saved).toContain('WITHHELD-LONG:')
  expect(saved).toMatch(/не отправлено/)
  expect(saved).toContain('[Текст сокращён до лимита блокнота.]')
  expect([...saved].length).toBe(SCRATCHPAD_LIMIT)
  expect(saved).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
})
