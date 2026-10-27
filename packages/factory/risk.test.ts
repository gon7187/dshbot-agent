// A footprint entry is risky not only when it names a risky path but also when
// it contains one: `.github/` lets the executor change `.github/workflows/`,
// the project root and the parent of `migrations/` let it change everything
// below. The rule raises such a footprint to high over the model's `low` and
// the card names the reason.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { assessFactoryRisk, createFactory, type Factory } from './src/index.js'

const OWNER = 4243
const PROJECT = '/srv/project'
const PATHS = ['src/search.ts', 'db/migrations/001-add.sql', 'db/schema.ts', '.github/dependabot.yml', 'docs/guide.md']
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function risk(footprint: string[], projectPaths: readonly string[] = PATHS) {
  return assessFactoryRisk({ body: 'Поправить подпись кнопки', footprint, modelRisk: 'low', projectRoot: PROJECT, projectPaths })
}

test('a directory or root footprint that contains a risky path is high with a reason', () => {
  const cases: Array<[string, RegExp]> = [
    ['.github/', /workflow/],
    ['.github', /workflow/],
    ['.', /миграции, workflow, \.env, секреты/],
    ['./', /миграции, workflow, \.env, секреты/],
    ['.//', /миграции, workflow, \.env, секреты/],
    ['', /миграции, workflow, \.env, секреты/],
    ['//', /миграции, workflow, \.env, секреты/],
    [`${PROJECT}/`, /миграции, workflow, \.env, секреты/],
    ['db/', /миграции/],
    ['db', /миграции/],
    ['./db//', /миграции/],
    ['src/../db/', /миграции/],
    ['DB/', /миграции/],
  ]
  for (const [entry, reason] of cases) {
    const assessment = risk([entry])
    expect(assessment.risk, `footprint ${JSON.stringify(entry)}`).toBe('high')
    expect(assessment.reason, `footprint ${JSON.stringify(entry)}`).toMatch(/^Причина: footprint задевает рисковые пути/)
    expect(assessment.reason).toMatch(reason)
  }
})

test('a risky entry itself and a path inside a risky directory stay high', () => {
  for (const entry of ['migrations/', 'db/migrations/001-add.sql', '.github/workflows/', '.github/workflows/ci.yml', 'config/secret.txt', 'secrets/']) {
    expect(risk([entry]).risk, entry).toBe('high')
  }
})

test('a footprint outside the project root is high and says so', () => {
  for (const entry of ['../other/src.ts', 'src/../../other/', '/etc/hosts']) {
    const assessment = risk([entry])
    expect(assessment.risk, entry).toBe('high')
    expect(assessment.reason, entry).toMatch(/выходит за корень проекта/)
  }
})

test('files and directories without risky paths below them stay low', () => {
  for (const footprint of [['src/search.ts'], ['src/'], ['docs'], ['db/schema.ts'], ['.github/dependabot.yml'], [`${PROJECT}/src/search.ts`], ['./src/search.ts']]) {
    expect(risk(footprint), footprint.join(',')).toEqual({ risk: 'low' })
  }
  // A sibling with the same prefix is not inside the directory.
  expect(risk(['db'], ['dbx/migrations/1.sql', 'db/schema.ts'])).toEqual({ risk: 'low' })
})

let root: string
let store: Store
let calls: Array<{ method: string; params: Record<string, unknown> }>
let factory: Factory
let reply: string

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-factory-risk-'))
  const project = join(root, 'app-root')
  mkdirSync(join(root, 'home'))
  mkdirSync(project)
  git(project, 'init', '-q')
  put(join(project, 'src/search.ts'), 'export const search = () => []\n')
  put(join(project, 'store/migrations/001-add.sql'), 'CREATE TABLE t (id INTEGER);\n')
  put(join(project, 'vault/notes.md'), 'tracked\n')
  // Untracked: only the risk rule sees it, the model's tree does not.
  put(join(project, 'vault/keys/secrets.json'), '{}\n')
  // Ignored: listed for the risk rule although git does not track it.
  put(join(project, '.gitignore'), '*.secret\n')
  put(join(project, 'conf/app.secret'), 'ignored\n')
  put(join(project, 'conf/app.toml'), 'tracked\n')
  git(project, 'add', '--', '.gitignore', 'src/search.ts', 'store/migrations/001-add.sql', 'vault/notes.md', 'conf/app.toml')
  store = openStore(join(root, 'home', 'state.db'))
  calls = []
  const api: TelegramApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      return { message_id: calls.length, chat: { id: params.chat_id } } as T
    },
  }
  factory = createFactory({
    store,
    home: join(root, 'home'),
    appRoot: project,
    api,
    ownerId: () => OWNER,
    catalogue: async () => [{ provider: 'risk-provider', id: 'risk-model', name: 'Risk Model' }],
    analysis: async () => reply,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

async function analysedRisk(footprint: string[]): Promise<{ risk: string; reason: string | null; card: string }> {
  reply = JSON.stringify({ criteria: ['Поиск показывает результаты.'], footprint, risk: 'low' })
  expect(await factory.handleCallback({ id: 'cb', chatId: OWNER, fromId: OWNER, messageId: 1, data: 'f1:s:n' })).toBe(true)
  const mark = calls.length
  expect(await factory.takeInput(OWNER, `Поправить подпись кнопки ${footprint.join(' ')}`)).toBe(true)
  let row: { status: string; risk: string; risk_reason: string | null } | undefined
  await vi.waitFor(() => {
    row = store.db.prepare('SELECT status, risk, risk_reason FROM factory_tasks ORDER BY id DESC LIMIT 1').get() as typeof row
    expect(row?.status).toBe('awaiting_approval')
    expect(calls.slice(mark).some((call) => JSON.stringify(call.params).includes('Одобрить'))).toBe(true)
  })
  const card = calls.slice(mark).filter((call) => JSON.stringify(call.params).includes('Одобрить')).at(-1)!
  return { risk: row!.risk, reason: row!.risk_reason, card: JSON.stringify(card.params) }
}

test('the analysis flow raises the parent of a tracked migrations directory, an untracked and an ignored secret to high', async () => {
  const parent = await analysedRisk(['store/'])
  expect(parent.risk).toBe('high')
  expect(parent.reason).toMatch(/миграции/)
  expect(parent.card).toMatch(/миграции/)

  const vault = await analysedRisk(['vault'])
  expect(vault.risk).toBe('high')
  expect(vault.reason).toMatch(/секреты/)

  const ignored = await analysedRisk(['conf/'])
  expect(ignored.risk).toBe('high')
  expect(ignored.reason).toMatch(/секреты/)

  const whole = await analysedRisk(['./'])
  expect(whole.risk).toBe('high')
  expect(whole.card).toMatch(/workflow/)

  expect((await analysedRisk(['src/'])).risk).toBe('low')
})
