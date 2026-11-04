import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyContent, planContent } from './src/content.js'

let root: string
let source: string
let home: string
function put(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-reconciliation-'))
  source = join(root, 'source')
  home = join(root, 'home')
  mkdirSync(home)
  put(join(source, 'openclaw.json'), '{}')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function migrate(overwrite = false) {
  const plan = planContent({ home, overwrite, dryRun: false, includeSecrets: false, skillConflict: 'skip' },
    { dir: source, configName: 'openclaw.json', configPath: join(source, 'openclaw.json') }, [])
  applyContent(plan, join(root, 'report'), home, [])
  expect(plan.items.filter(item => item.status === 'error')).toEqual([])
  return plan
}
function rows() {
  const db = new DatabaseSync(join(home, 'state.db'), { readOnly: true })
  try { return db.prepare('SELECT id, spec, task FROM schedules ORDER BY id').all() }
  finally { db.close() }
}
function jobs(second: string) {
  put(join(source, 'cron/jobs.json'), JSON.stringify({ jobs: ['first', 'second'].map(id => ({
    id, name: id, enabled: true, agentId: 'main', schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
    payload: { kind: 'agentTurn', message: id === 'second' ? second : 'Same task' },
  })) }))
}

test('M1 source identity preserves distinct schedules through conflict, overwrite and repeat', () => {
  jobs('Same task')
  migrate()
  const before = rows()
  expect(before).toHaveLength(2)
  jobs('Changed task')
  expect(migrate().items.some(item => item.name === 'second' && item.status === 'conflict')).toBe(true)
  expect(rows()).toEqual(before)
  migrate(true)
  const after = rows()
  expect(after.map(row => row.id)).toEqual(before.map(row => row.id))
  expect(after.map(row => row.task).sort()).toEqual(['Changed task', 'Same task'])
  expect(migrate().actions).toEqual([])
  expect(rows()).toEqual(after)
})

test('M2 knowledge follows versions but preserves owner edits and exact overwrite backup', () => {
  const input = join(source, 'workspace/TOOLS.md')
  const output = join(home, 'memory/knowledge/openclaw-tools.md')
  for (const version of ['A', 'B', 'C']) {
    put(input, version + '\n')
    migrate()
    expect(readFileSync(output, 'utf8')).toBe(version + '\n')
  }
  const owned = Buffer.from('Owner correction\r\n')
  put(output, owned)
  put(input, 'D\n')
  expect(migrate().items.some(item => item.target.endsWith('knowledge/openclaw-tools.md') && item.status === 'conflict')).toBe(true)
  expect(readFileSync(output)).toEqual(owned)
  migrate(true)
  expect(readFileSync(output, 'utf8')).toBe('D\n')
  const backups = readdirSync(join(root, 'report/before')).map(name => readFileSync(join(root, 'report/before', name)))
  expect(backups.some(bytes => bytes.equals(owned))).toBe(true)
  const previous = readFileSync(output)
  expect(migrate().actions).toEqual([])
  expect(readFileSync(output)).toEqual(previous)
})
