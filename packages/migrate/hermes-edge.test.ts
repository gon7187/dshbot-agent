// Edge cases of the Hermes source beyond the public contract of
// hermes-cli.test.ts: binary credentials, secret values inside skills, quoted
// YAML keys on a renamed skill, exact prompts and repeated runs with jobs that
// share one prompt. Every credential here is synthetic.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createSkillStore, parseSkillFrontmatter } from '../learn/src/skills.js'
import { createScheduleRegistry } from '../scheduler/src/index.js'
import { openStore } from '../store/src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 120_000

let root: string
let source: string
let home: string
let envFile: string

function put(path: string, value: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function migrate(...flags: string[]): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(cli, ['hermes', '--from', source, '--home', home, '--env-file', envFile, ...flags], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { HOME: join(root, 'user'), LANG: 'C.UTF-8', TZ: 'UTC', PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
  })
  return { code: run.status, stdout: run.stdout, stderr: run.stderr }
}

function apply(): { code: number | null; stdout: string; stderr: string } {
  return migrate('--yes', '--include-secrets')
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {}
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else result[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return result
}

function reports(): string {
  const dir = join(home, 'migration')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'report.json')))
    .map((name) => readFileSync(join(dir, name, 'report.json'), 'utf8'))
    .join('\n')
}

function expectRepeatChangesNothing(): void {
  const before = snapshot(home)
  const sourceBefore = snapshot(source)
  const again = apply()
  expect(again.code, 'repeated application exit code').toBe(0)
  expect(snapshot(home), 'repeat does not rewrite data or create another report').toEqual(before)
  expect(snapshot(source)).toEqual(sourceBefore)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-hermes-edge-'))
  source = join(root, 'hermes')
  home = join(root, 'home')
  envFile = join(root, 'config', 'dshbot.env')
  mkdirSync(join(root, 'user'), { recursive: true })
  mkdirSync(home, { recursive: true })
  put(join(source, '.env'), '')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('a binary credentials file reaches the vault with the exact bytes and mode 0600', { timeout: TIMEOUT }, () => {
  const bytes = Buffer.from([0x30, 0x82, 0xff, 0x80, 0x00, 0x0a])
  put(join(source, 'credentials', 'client.der'), bytes)
  const run = apply()
  expect(run.code).toBe(0)
  const path = join(home, 'secrets', 'CREDENTIALS_CLIENT_DER')
  expect(readFileSync(path).equals(bytes), 'exact bytes of a binary credential').toBe(true)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expectRepeatChangesNothing()
})

test('secret values inside copied skill files become ${secret:NAME}; binary files stay byte-exact', { timeout: TIMEOUT }, () => {
  const key = 'fixture-skill-api-key-0123456789'
  const token = '700020:AAFixtureSkillTelegramToken2020202'
  put(join(source, '.env'), `SAMPLE_API_KEY=${key}\nTELEGRAM_BOT_TOKEN=${token}\n`)
  put(join(source, 'skills', 'notes', 'SKILL.md'), `---\nname: notes\ndescription: Notes with a key\n---\n\nCall the API with ${key}.\n`)
  put(join(source, 'skills', 'notes', 'references', 'setup.txt'), `token=${token}\nkey=${key}\n`)
  const binary = Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(key)])
  put(join(source, 'skills', 'notes', 'assets', 'blob.bin'), binary)
  const sourceBefore = snapshot(source)
  const run = apply()
  expect(run.code).toBe(0)
  const skill = readFileSync(join(home, 'skills', 'notes', 'SKILL.md'), 'utf8')
  expect(skill).toContain('Call the API with ${secret:SAMPLE_API_KEY}.')
  expect(skill).not.toContain(key)
  const setup = readFileSync(join(home, 'skills', 'notes', 'references', 'setup.txt'), 'utf8')
  expect(setup).toBe('token=${secret:TELEGRAM_BOT_TOKEN}\nkey=${secret:SAMPLE_API_KEY}\n')
  expect(readFileSync(join(home, 'skills', 'notes', 'assets', 'blob.bin')).equals(binary)).toBe(true)
  expect(snapshot(source)).toEqual(sourceBefore)
  for (const surface of [run.stdout, run.stderr, reports()]) {
    expect(surface.includes(key)).toBe(false)
    expect(surface.includes(token)).toBe(false)
  }
  expect(createSkillStore({ home }).list().find((entry) => entry.name === 'notes')).toMatchObject({ imported: true })
  expectRepeatChangesNothing()
})

test('a renamed skill gets its new name for quoted and multi-line YAML name keys', { timeout: TIMEOUT }, () => {
  put(join(source, 'skills', 'devops', 'toolbox', 'SKILL.md'), '---\n"name": toolbox\ndescription: Devops toolbox\n---\n\nDevops body.\n')
  put(join(source, 'skills', 'docs', 'toolbox', 'SKILL.md'), "---\ndescription: Docs toolbox\n'name': >-\n  toolbox\n---\n\nDocs body.\n")
  put(join(source, 'skills', 'ops', 'toolbox', 'SKILL.md'), '---\r\nname: "toolbox" # comment\r\ndescription: Ops toolbox\r\n---\r\n\r\nOps body.\r\n')
  const run = apply()
  expect(run.code).toBe(0)
  const names = createSkillStore({ home }).list().filter((entry) => entry.imported).map((entry) => entry.name).sort()
  expect(names).toEqual(['devops-toolbox', 'docs-toolbox', 'ops-toolbox'])
  for (const [name, body] of [['devops-toolbox', 'Devops body.'], ['docs-toolbox', 'Docs body.'], ['ops-toolbox', 'Ops body.']]) {
    const text = readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')
    expect(parseSkillFrontmatter(text).name).toBe(name)
    expect(text).toContain(body)
  }
  expect(existsSync(join(home, 'skills', 'toolbox'))).toBe(false)
  expectRepeatChangesNothing()
})

test('prompts keep their exact text and a repeat with shared prompts changes nothing', { timeout: TIMEOUT }, () => {
  const shared = 'Shared task text.\n'
  const trailing = '  Indented task with trailing lines.\n\n'
  const jobs = [
    { id: 'a', name: 'Shared interval', prompt: shared, schedule: { kind: 'interval', minutes: 90 }, enabled: true },
    { id: 'b', name: 'Shared cron', prompt: shared, schedule: { kind: 'cron', expr: '0 9 * * *' }, enabled: true },
    { id: 'c', name: 'Same twice', prompt: 'Twice.', schedule: { kind: 'cron', expr: '0 7 * * *' }, enabled: true },
    { id: 'd', name: 'Same twice again', prompt: 'Twice.', schedule: { kind: 'cron', expr: '0 7 * * *' }, enabled: true },
    { id: 'e', name: 'Trailing', prompt: trailing, schedule: { kind: 'interval', minutes: 15 }, repeat: { times: 2 }, enabled: false },
  ]
  put(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs }, null, 2))
  const run = apply()
  expect(run.code).toBe(0)
  const read = () => {
    const store = openStore(join(home, 'state.db'))
    try {
      return createScheduleRegistry(store, { timeZone: 'UTC' })
        .list()
        .map((entry) => ({ task: entry.task, spec: entry.spec, maxRuns: entry.maxRuns, paused: entry.paused }))
        .sort((left, right) => `${left.task}|${left.spec}`.localeCompare(`${right.task}|${right.spec}`))
    } finally {
      store.close()
    }
  }
  const expected = [
    { task: trailing, spec: 'every 15m', maxRuns: 2, paused: true },
    { task: shared, spec: '0 9 * * *', maxRuns: null, paused: false },
    { task: shared, spec: 'every 90m', maxRuns: null, paused: false },
    { task: 'Twice.', spec: '0 7 * * *', maxRuns: null, paused: false },
    { task: 'Twice.', spec: '0 7 * * *', maxRuns: null, paused: false },
  ].sort((left, right) => `${left.task}|${left.spec}`.localeCompare(`${right.task}|${right.spec}`))
  expect(read()).toEqual(expected)
  expectRepeatChangesNothing()
  expect(read()).toEqual(expected)
})

test('manual-review.md carries the prompt and the script with secret values replaced', { timeout: TIMEOUT }, () => {
  const password = 'fixture-manual-password-998877'
  put(join(source, '.env'), `BACKUP_PASSWORD=${password}\n`)
  const jobs = [
    { id: 's', name: 'Backup script', prompt: 'Report the backup result.\nMention failures.', script: `restic backup --password ${password} /srv`, schedule: { kind: 'interval', minutes: 60 } },
    { id: 'n', name: 'Plain notifier', prompt: 'Ping ``` the owner', no_agent: true, schedule: { kind: 'interval', minutes: 60 } },
  ]
  put(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs }))
  const run = apply()
  expect(run.code).toBe(0)
  const manual = readFileSync(join(home, 'migration', 'manual-review.md'), 'utf8')
  expect(manual).toContain('Report the backup result.\nMention failures.')
  expect(manual).toContain('restic backup --password ${secret:BACKUP_PASSWORD} /srv')
  expect(manual).toContain('````\nPing ``` the owner\n````')
  expect(manual).not.toContain(password)
  expectRepeatChangesNothing()
})
