import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const cli = join(repoRoot, 'scripts', 'dshbot-migrate')
const TIMEOUT = 180_000
interface Item { kind: string; name: string; target: string; status: string; reason?: string }
interface Run { code: number | null; stdout: string; stderr: string }
let root: string
let source: string
let home: string

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

// Every run is a fresh CLI process, so the identity map must survive on disk.
function migrate(flags: string[] = []): Promise<Run> {
  const child = spawn('/bin/sh', ['-c', 'exec "$@"', 'content-reimport-chain-test', cli,
    'openclaw', '--from', source, '--home', home, '--env-file', join(root, 'daemon-vars.conf'),
    '--json', '--yes', ...flags], {
    cwd: repoRoot,
    env: {
      HOME: join(root, 'runtime-user'), USERPROFILE: join(root, 'runtime-user'), LANG: 'C.UTF-8',
      PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin?.end()
  })
}

async function items(flags: string[] = [], conflict = false): Promise<Item[]> {
  const run = await migrate(flags)
  expect(run.code, run.stderr).toBe(conflict ? 1 : 0)
  return (JSON.parse(run.stdout) as { items: Item[] }).items
}

function scheduleItem(list: Item[], id: string): Item {
  const found = list.filter((entry) => entry.kind === 'schedule' && entry.name === id && entry.status !== 'warning')
  expect(found).toHaveLength(1)
  return found[0]
}

function writeJobs(tasks: Record<string, string>): void {
  const jobs = Object.entries(tasks).map(([id, message]) => ({
    id, name: `Job ${id}`, enabled: true, agentId: 'main',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message },
  }))
  put(join(source, 'cron', 'jobs.json'), JSON.stringify({ jobs }, null, 2) + '\n')
}

function rows(): { id: string; spec: string; task: string }[] {
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
  try {
    return db.prepare('SELECT id, spec, task FROM schedules ORDER BY id').all() as { id: string; spec: string; task: string }[]
  } finally { db.close() }
}

const knowledge = (): string => join(home, 'memory', 'knowledge', 'openclaw-tools.md')
const guidance = (revision: string): string => `# TOOLS\n\n${revision} guidance.\n`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-content-reimport-chain-'))
  source = join(root, 'source')
  home = join(root, 'destination')
  for (const dir of [source, home, join(root, 'runtime-user')]) mkdirSync(dir, { recursive: true })
  put(join(source, 'openclaw.json'), '{}\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('identical source jobs with different ids keep separate rows and a later change of one conflicts or updates its own row', { timeout: TIMEOUT }, async () => {
  writeJobs({ first: 'Same task', second: 'Same task' })
  await items()
  const before = rows()
  expect(before).toHaveLength(2)

  writeJobs({ first: 'Same task', second: 'Changed task' })
  const conflict = await items([], true)
  expect(scheduleItem(conflict, 'second')).toMatchObject({ status: 'conflict' })
  expect(scheduleItem(conflict, 'second').reason).toMatch(/текст/)
  expect(scheduleItem(conflict, 'first').status).toBe('skipped')
  expect(rows()).toEqual(before)

  const updated = await items(['--overwrite'])
  expect(scheduleItem(updated, 'second').status).toBe('applied')
  const after = rows()
  expect(after).toHaveLength(2)
  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id))
  expect(after.map((row) => row.task).sort()).toEqual(['Changed task', 'Same task'])

  const repeat = await items()
  expect(repeat.filter((entry) => entry.status === 'conflict' || entry.status === 'applied')).toEqual([])
  expect(rows()).toEqual(after)
})

test('an unedited knowledge file follows every source change A to B to C', { timeout: TIMEOUT }, async () => {
  put(join(source, 'workspace', 'TOOLS.md'), guidance('A'))
  await items()
  for (const revision of ['B', 'C']) {
    put(join(source, 'workspace', 'TOOLS.md'), guidance(revision))
    const list = await items()
    const entry = list.find((candidate) => candidate.target.endsWith('openclaw-tools.md'))
    expect(entry?.status).toBe('applied')
    expect(readFileSync(knowledge(), 'utf8')).toBe(guidance(revision))
  }
})

test('an owner edit back to an older import is a conflict after the last migration wrote a newer text', { timeout: TIMEOUT }, async () => {
  put(join(source, 'workspace', 'TOOLS.md'), guidance('A'))
  await items()
  put(join(source, 'workspace', 'TOOLS.md'), guidance('B'))
  await items()
  expect(readFileSync(knowledge(), 'utf8')).toBe(guidance('B'))

  writeFileSync(knowledge(), guidance('A'))
  put(join(source, 'workspace', 'TOOLS.md'), guidance('C'))
  const list = await items([], true)
  const entry = list.find((candidate) => candidate.target.endsWith('openclaw-tools.md'))
  expect(entry?.status).toBe('conflict')
  expect(entry?.reason).toMatch(/владел/)
  expect(existsSync(knowledge())).toBe(true)
  expect(readFileSync(knowledge(), 'utf8')).toBe(guidance('A'))
})
