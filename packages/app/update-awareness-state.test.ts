// Focused state tests for the "what's new" mechanism. The end-to-end scenarios
// (a real daemon, a git checkout of live, /status, guests) live in the locked
// update-awareness.test.ts; here we pin the two corners that decide what gets
// written to state.db and where the insertion text comes from.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'

import type { Kv } from '../store/src/index.js'
import {
  createUpdateAwareness,
  loadWhatsNewTemplate,
  UPDATE_COMMIT_KEY,
  UPDATE_PENDING_KEY,
  UPDATE_ROLLOUT_KEY,
  WHATS_NEW_PROMPT_FILE,
  WHATS_NEW_TITLES_PLACEHOLDER,
  whatsNewText,
} from './src/update-awareness.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dshbot-update-state-${prefix}-`))
  scratchDirs.push(dir)
  return dir
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Tester',
    GIT_AUTHOR_EMAIL: 'tester@example.invalid',
    GIT_COMMITTER_NAME: 'Tester',
    GIT_COMMITTER_EMAIL: 'tester@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: directory,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** A repository with one commit; returns its HEAD. */
function initRepo(directory: string, subject: string): string {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '-q', '-b', 'live')
  git(directory, 'commit', '-q', '--allow-empty', '-m', subject)
  return git(directory, 'rev-parse', 'HEAD')
}

function commit(directory: string, subject: string, body = ''): string {
  const args = ['commit', '-q', '--allow-empty', '-m', subject]
  if (body !== '') args.push('-m', body)
  git(directory, ...args)
  return git(directory, 'rev-parse', 'HEAD')
}

interface MemoryKv extends Kv {
  values: Map<string, string>
}

function memoryKv(initial: Record<string, string> = {}): MemoryKv {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: (key) => values.get(key),
    set: (key, value) => {
      values.set(key, value)
    },
  }
}

function rolloutOf(kv: MemoryKv, sha: string): number | undefined {
  const raw = kv.get(UPDATE_ROLLOUT_KEY)
  if (raw === undefined) return undefined
  const parsed = JSON.parse(raw) as { commit?: unknown; at?: unknown }
  return parsed.commit === sha && typeof parsed.at === 'number' ? parsed.at : undefined
}

test('test_record_a_failed_git_log_still_moves_the_record_to_the_new_head', () => {
  // The previous commit belongs to a history that no longer exists: `git log
  // old..new` exits non-zero, but HEAD itself is readable.
  const oldRepo = scratch('old')
  const oldHead = initRepo(oldRepo, 'base: история, которой больше нет')
  const live = scratch('live')
  const newHead = initRepo(live, 'feat: новая версия после переписанной истории WN-STATE')

  const now = 1_700_000_000_000
  const kv = memoryKv({ [UPDATE_COMMIT_KEY]: oldHead })
  const awareness = createUpdateAwareness(kv, live, { now })

  expect(awareness.commit).toBe(newHead)
  expect(kv.get(UPDATE_COMMIT_KEY), 'state.db remembers the commit the daemon now runs').toBe(newHead)
  expect(kv.get(UPDATE_PENDING_KEY) ?? '', 'nothing to announce without a list').toBe('')
  expect(awareness.takeNews(), 'a failed git log makes no insertion').toBe('')
  expect(awareness.rolloutAt, 'the new commit is a rollout').toBe(now)
  expect(rolloutOf(kv, newHead), 'the rollout moment is stored with the commit').toBe(now)
})

test('test_status_restart_on_the_same_commit_keeps_the_stored_rollout_moment', () => {
  const live = scratch('same')
  const head = initRepo(live, 'base: текущая версия')
  const rolledOutAt = 1_700_000_000_000
  const kv = memoryKv({
    [UPDATE_COMMIT_KEY]: head,
    [UPDATE_ROLLOUT_KEY]: JSON.stringify({ commit: head, at: rolledOutAt }),
  })

  // A restart much later: the daemon started now, but the rollout is old.
  const awareness = createUpdateAwareness(kv, live, { now: rolledOutAt + 3_600_000 })

  expect(awareness.commit).toBe(head)
  expect(awareness.rolloutAt, '/status keeps the date of the rollout, not of the process').toBe(rolledOutAt)
  expect(rolloutOf(kv, head)).toBe(rolledOutAt)
  expect(awareness.takeNews(), 'the same commit has no news').toBe('')
})

test('test_insert_news_comes_from_the_prompt_catalog_with_new_commit_titles', () => {
  const live = scratch('titles')
  const base = initRepo(live, 'base: исходное состояние WN-BASE')
  const kv = memoryKv({
    [UPDATE_COMMIT_KEY]: base,
    [UPDATE_ROLLOUT_KEY]: JSON.stringify({ commit: base, at: 1_700_000_000_000 }),
  })
  const first = commit(live, 'feat: приём файлов и вложений WN-STATE-ALPHA', 'BODYSECRET-STATE')
  const second = commit(live, 'fix: голосовые сообщения WN-STATE-BETA')
  const now = 1_700_000_100_000

  // The real catalogue of the repository, not a fixture: this is what the
  // daemon loads from `prompts/` next to its code.
  const awareness = createUpdateAwareness(kv, live, { now, promptsDir: join(repoRoot, 'prompts') })
  const news = awareness.takeNews()

  expect(news, 'the insertion comes from prompts/whats-new.md').toContain('Тебя обновили')
  expect(news).toContain('WN-STATE-ALPHA')
  expect(news).toContain('WN-STATE-BETA')
  expect(news, 'only titles, never commit bodies').not.toContain('BODYSECRET-STATE')
  expect(news, 'the old commit is not new').not.toContain('WN-BASE')
  expect(awareness.takeNews(), 'one insertion per version change').toBe('')
  expect(awareness.commit).toBe(second)
  expect(kv.get(UPDATE_COMMIT_KEY)).toBe(second)
  expect(awareness.rolloutAt).toBe(now)

  // A restart on the same commit has no pending list and no news.
  const restarted = createUpdateAwareness(kv, live, { now: now + 60_000, promptsDir: join(repoRoot, 'prompts') })
  expect(restarted.takeNews()).toBe('')
  expect(restarted.rolloutAt, 'a restart does not move the rollout').toBe(now)
  expect(first).not.toBe(second)
})

test('test_prompt_catalog_carries_the_whats_new_text_and_the_titles_placeholder', () => {
  const template = loadWhatsNewTemplate(join(repoRoot, 'prompts'))
  expect(template, `prompts/${WHATS_NEW_PROMPT_FILE} exists`).toBeDefined()
  expect(template, 'the list is substituted, not hardcoded').toContain(WHATS_NEW_TITLES_PLACEHOLDER)

  const text = whatsNewText(template as string, ['feat: одна возможность', 'fix: одно исправление'])
  expect(text).toContain('Тебя обновили')
  expect(text).toContain('- feat: одна возможность')
  expect(text).toContain('- fix: одно исправление')
  expect(text).toContain('прежние выводы о том, чего ты не умеешь, могли устареть')
})

test('test_nogit_a_missing_prompt_catalog_records_the_commit_without_news', () => {
  const live = scratch('nocatalog')
  const base = initRepo(live, 'base: без каталога')
  const kv = memoryKv({ [UPDATE_COMMIT_KEY]: base })
  const next = commit(live, 'feat: версия без файла каталога WN-NOCAT')
  const emptyPrompts = scratch('empty-prompts')
  writeFileSync(join(emptyPrompts, 'other.md'), 'не тот файл')

  const awareness = createUpdateAwareness(kv, live, { now: 1_700_000_200_000, promptsDir: emptyPrompts })
  expect(awareness.commit).toBe(next)
  expect(kv.get(UPDATE_COMMIT_KEY)).toBe(next)
  expect(awareness.takeNews(), 'without the template there is no insertion').toBe('')
})
