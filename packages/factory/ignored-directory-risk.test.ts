import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createFactory, type Factory } from './src/index.js'

const OWNER = 4244
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

interface Call {
  method: string
  params: Record<string, unknown>
}

interface TaskRisk {
  status: string
  risk: string | null
  risk_reason: string | null
}

let root: string
let project: string
let store: Store
let calls: Call[]
let factory: Factory
let reply: string

function put(relativePath: string, content: string): void {
  const path = join(project, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-factory-ignored-risk-'))
  project = join(root, 'app-root')
  const home = join(root, 'home')
  mkdirSync(project)
  mkdirSync(home)
  execFileSync('git', ['-C', project, 'init', '-q'], { env: GIT_ENV, stdio: 'pipe' })
  // These rules collapse whole directories in git's ignored-path listing.
  // None of their names alone matches a risky-path category.
  put('.gitignore', '/config/\n/bundle/config/\n/node_modules/\n')
  put('src/search.ts', 'export const label = "Поиск"\n')
  put('config-sibling/notes.md', 'Notes\n')
  put('config/public/notes.md', 'Notes\n')
  put('bundle/notes.md', 'Notes\n')
  put('node_modules/example/secrets.json', '{}\n')
  execFileSync('git', ['-C', project, 'add', '--', '.gitignore', 'src/search.ts', 'config-sibling/notes.md', 'bundle/notes.md'], {
    env: GIT_ENV,
    stdio: 'pipe',
  })
  store = openStore(join(home, 'state.db'))
  calls = []
  reply = ''
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      return { message_id: calls.length, chat: { id: params.chat_id } } as T
    },
  }
  factory = createFactory({
    store,
    home,
    appRoot: project,
    api,
    ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'risk-provider', id: 'risk-model', name: 'Risk Model' }],
    analysis: async () => reply,
  })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

async function analyse(footprint: string[]): Promise<{ task: TaskRisk; card: string }> {
  reply = JSON.stringify({ criteria: ['Кнопка поиска показывает подпись «Найти».'], footprint, risk: 'low' })
  expect(await factory.handleCallback({ id: 'cb', chatId: OWNER, fromId: OWNER, messageId: 1, data: 'f1:s:n' })).toBe(true)
  const mark = calls.length
  // The task text cannot independently trigger the risk rule.
  expect(await factory.takeInput(OWNER, 'Поправить подпись кнопки поиска')).toBe(true)
  let task: TaskRisk | undefined
  let card: Call | undefined
  await vi.waitFor(() => {
    task = store.db.prepare('SELECT status, risk, risk_reason FROM factory_tasks ORDER BY id DESC LIMIT 1').get() as TaskRisk | undefined
    expect(task?.status).toBe('awaiting_approval')
    card = calls.slice(mark).find((call) => call.params.chat_id === OWNER &&
      call.method.startsWith('send') && JSON.stringify(call.params.reply_markup ?? {}).includes('Одобрить'))
    expect(card).toBeDefined()
  })
  const rich = card!.params.rich_message as { markdown?: string } | undefined
  return { task: task!, card: rich?.markdown ?? String(card!.params.text ?? '') }
}

test.each([
  { label: 'the ignored directory itself', path: 'config/secrets.json', footprint: ['config/'], reason: /секрет/i },
  { label: 'a directory inside the ignored directory', path: 'config/nested/secrets.json', footprint: ['config/nested/'], reason: /секрет/i },
  { label: 'a non-root ancestor of the ignored directory', path: 'bundle/config/secrets.json', footprint: ['bundle/'], reason: /секрет/i },
  { label: 'the project root', path: 'config/secrets.json', footprint: ['.'], reason: /секрет/i },
  { label: 'migrations inside the ignored directory', path: 'config/migrations/001.sql', footprint: ['config/'], reason: /миграц/i },
  { label: 'workflows inside the ignored directory', path: 'config/.github/workflows/check.yml', footprint: ['config/'], reason: /workflow/i },
])('test_h1_high_risk_and_card_reason_for_$label', async ({ path, footprint, reason }) => {
  put(path, '{}\n')
  const result = await analyse(footprint)
  expect(result.task.risk).toBe('high')
  expect(result.task.risk_reason).toMatch(reason)
  expect(result.card).toMatch(/Риск[^\n]*high/)
  expect(result.card).toMatch(/Причина/)
  expect(result.card).toMatch(reason)
})

test.each([
  ['src/'],
  ['config-sibling/'],
  ['config/public/'],
])('test_h1_low_risk_for_a_footprint_without_ignored_risky_descendants: %j', async (entry) => {
  put('config/secrets.json', '{}\n')
  put('bundle/config/secrets.json', '{}\n')
  const result = await analyse([entry])
  expect(result.task.risk).toBe('low')
  expect(result.task.risk_reason).toBeNull()
  expect(result.card).toMatch(/Риск[^\n]*low/)
})
