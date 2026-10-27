import { expect, test } from 'vitest'
import type { TelegramApi } from './api.js'
import { setCommands } from './commands.js'

// Assumed API: setCommands(api, list) with list of { command, description }; sends setMyCommands.

type Params = Record<string, unknown>
interface Call {
  method: string
  params: Params
}

function fakeApi() {
  const calls: Call[] = []
  const api: TelegramApi = {
    async call<T = unknown>(method: string, params: Params = {}): Promise<T> {
      calls.push({ method, params })
      return true as T
    },
  }
  return { api, calls }
}

function menu(): Array<{ command: string; description: string }> {
  return [
    { command: 'stop', description: 'Остановить задачу' },
    { command: 'status', description: 'Показать статус' },
  ]
}

test('test_c14_same_command_list_is_sent_only_once', async () => {
  const { api, calls } = fakeApi()

  await setCommands(api, menu())
  await setCommands(api, menu())

  expect(calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(1)
})

test('test_c14_more_than_100_commands_are_cut_to_first_100', async () => {
  const { api, calls } = fakeApi()
  const list = Array.from({ length: 101 }, (_, i) => ({ command: `cmd${i}`, description: `Команда ${i}` }))

  await setCommands(api, list)

  const sent = calls.filter((c) => c.method === 'setMyCommands')
  expect(sent).toHaveLength(1)
  const commands = sent[0].params.commands as Array<{ command: string }>
  expect(commands).toHaveLength(100)
  expect(commands[0].command).toBe('cmd0')
  expect(commands[99].command).toBe('cmd99')
})
