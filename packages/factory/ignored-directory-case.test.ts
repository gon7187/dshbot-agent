// The risk rule matches paths case-insensitively, but the scan of a collapsed
// ignored directory reads the filesystem. On a case-sensitive filesystem
// `Config/` and `config/` are different directories, so the scan has to get
// the directory as git listed it, not a lower-cased copy that may point at a
// harmless sibling.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { openStore, type Store } from '../store/src/index.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { assessFactoryRisk, createFactory, type Factory, type FactoryRiskInput } from './src/index.js'

const OWNER = 4245
const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

const BASE: Omit<FactoryRiskInput, 'footprint' | 'ignoredDirectories' | 'scanIgnoredDirectory'> = {
  body: 'Поправить подпись кнопки поиска',
  modelRisk: 'low',
  projectRoot: '/srv/project',
  projectPaths: ['src/search.ts', 'config/public.json', 'Config/'],
}

// Two directories that differ only by case, as a case-sensitive filesystem keeps them.
const LISTINGS: Record<string, string[]> = {
  Config: ['Config/secrets.json'],
  config: ['config/public.json'],
}

function scanner(scanned: string[]): (directory: string) => readonly string[] | undefined {
  return (directory) => {
    scanned.push(directory)
    return Object.hasOwn(LISTINGS, directory) ? LISTINGS[directory] : undefined
  }
}

test('the scan keeps the spelling of a collapsed ignored directory', () => {
  const scanned: string[] = []
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['Config/'],
    ignoredDirectories: ['Config/'],
    scanIgnoredDirectory: scanner(scanned),
  })
  expect(scanned).toEqual(['Config'])
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/секреты/)
})

test('a footprint spelled differently still scans the directory git listed', () => {
  const scanned: string[] = []
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['CONFIG/'],
    ignoredDirectories: ['Config/'],
    scanIgnoredDirectory: scanner(scanned),
  })
  expect(scanned).toEqual(['Config'])
  expect(assessment.risk).toBe('high')
})

test('an ancestor footprint scans the ignored directory in its own spelling', () => {
  const scanned: string[] = []
  assessFactoryRisk({
    ...BASE,
    footprint: ['Bundle/'],
    ignoredDirectories: ['Bundle/Config/'],
    scanIgnoredDirectory: (directory) => {
      scanned.push(directory)
      return []
    },
  })
  expect(scanned).toEqual(['Bundle/Config'])
})

test('a footprint inside the ignored directory keeps its own segments below it', () => {
  const scanned: string[] = []
  assessFactoryRisk({
    ...BASE,
    footprint: ['Config/Nested/'],
    ignoredDirectories: ['Config/'],
    scanIgnoredDirectory: (directory) => {
      scanned.push(directory)
      return []
    },
  })
  expect(scanned).toEqual(['Config/Nested'])
})

test('a failed scan names the directory in its own spelling', () => {
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['Config/'],
    ignoredDirectories: ['Config/'],
    scanIgnoredDirectory: () => undefined,
  })
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/перечислить[^.]*\(Config\)/)
})

let root: string
let project: string
let store: Store
let calls: Array<{ method: string; params: Record<string, unknown> }>
let factory: Factory
let reply: string

function put(relativePath: string, content: string): void {
  const path = join(project, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function caseSensitiveTmp(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'dshbot-factory-case-probe-'))
  try {
    writeFileSync(join(probe, 'probe'), '')
    return !existsSync(join(probe, 'PROBE'))
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

const CASE_SENSITIVE = caseSensitiveTmp()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-factory-ignored-case-'))
  project = join(root, 'app-root')
  const home = join(root, 'home')
  mkdirSync(project)
  mkdirSync(home)
  execFileSync('git', ['-C', project, 'init', '-q'], { env: GIT_ENV, stdio: 'pipe' })
  put('.gitignore', '/Config/\n')
  put('src/search.ts', 'export const label = "Поиск"\n')
  if (CASE_SENSITIVE) {
    put('Config/secrets.json', '{}\n')
    put('config/public.json', '{}\n')
    execFileSync('git', ['-C', project, 'add', '--', '.gitignore', 'src/search.ts', 'config/public.json'], { env: GIT_ENV, stdio: 'pipe' })
  }
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
    catalogue: async () => [{ provider: 'case-provider', id: 'case-model', name: 'Case Model' }],
    analysis: async () => reply,
  })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(!CASE_SENSITIVE)('an ignored Config/ with a secret beside a harmless config/ is high on the card', async () => {
  reply = JSON.stringify({ criteria: ['Кнопка поиска показывает подпись «Найти».'], footprint: ['Config/'], risk: 'low' })
  expect(await factory.handleCallback({ id: 'cb', chatId: OWNER, fromId: OWNER, messageId: 1, data: 'f1:s:n' })).toBe(true)
  const mark = calls.length
  expect(await factory.takeInput(OWNER, 'Поправить подпись кнопки поиска')).toBe(true)
  let task: { status: string; risk: string | null; risk_reason: string | null } | undefined
  let card: { method: string; params: Record<string, unknown> } | undefined
  await vi.waitFor(() => {
    task = store.db.prepare('SELECT status, risk, risk_reason FROM factory_tasks ORDER BY id DESC LIMIT 1').get() as typeof task
    expect(task?.status).toBe('awaiting_approval')
    card = calls.slice(mark).find((call) => call.params.chat_id === OWNER &&
      call.method.startsWith('send') && JSON.stringify(call.params.reply_markup ?? {}).includes('Одобрить'))
    expect(card).toBeDefined()
  })
  const rich = card!.params.rich_message as { markdown?: string } | undefined
  const text = rich?.markdown ?? String(card!.params.text ?? '')
  expect(task!.risk).toBe('high')
  expect(task!.risk_reason).toMatch(/секрет/i)
  expect(text).toMatch(/Риск[^\n]*high/)
  expect(text).toMatch(/Причина[^\n]*секрет/i)
})
