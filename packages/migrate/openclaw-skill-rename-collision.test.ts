// The rename policy of the content step must reserve the target name at plan
// time: two source skills may not be planned into the same directory.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createSkillStore } from '../learn/src/index.js'
import { applyContent, planContent, type ContentResult } from './src/content.js'
import type { OpenClawSource } from './src/openclaw.js'

let root: string
let source: OpenClawSource
let workspace: string
let home: string

function put(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function document(name: string, body: string): string {
  return ['---', `name: ${name}`, 'description: Imported reference', '---', '', body, ''].join('\n')
}

function nativeDocument(name: string, body: string): string {
  return ['---', `name: ${name}`, 'description: Owner skill', '---', '', '## Procedure', body, '', '## Pitfalls', 'None.', '', '## Verification', 'Read it.', ''].join('\n')
}

function options(): Parameters<typeof planContent>[0] {
  return { home, dryRun: false, includeSecrets: false, overwrite: false, skillConflict: 'rename' }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dshbot-skill-reservation-'))
  const state = join(root, 'state')
  workspace = join(state, 'workspace')
  home = join(root, 'home')
  for (const dir of [state, workspace, home]) mkdirSync(dir, { recursive: true })
  put(join(state, 'openclaw.json'), '{}\n')
  source = { dir: state, configName: 'openclaw.json', configPath: join(state, 'openclaw.json') }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

test('rename reserves planned targets so foo and foo-openclaw never collide', () => {
  createSkillStore({ home }).create('foo', nativeDocument('foo', 'Owner foo survives.'))
  put(join(workspace, 'skills', 'foo', 'SKILL.md'), document('foo', 'Source foo.'))
  put(join(workspace, 'skills', 'foo-openclaw', 'SKILL.md'), document('foo-openclaw', 'Source foo-openclaw.'))

  const first: ContentResult = planContent(options(), source, [])
  const applied = first.actions.filter((action) => action.kind === 'skill')
  const targets = applied.map((action) => action.target)
  expect(new Set(targets).size, 'no target receives two skills').toBe(targets.length)
  expect(targets.map((target) => target.split(/[/\\]/).pop()).sort()).toEqual(['foo-openclaw', 'foo-openclaw-openclaw'])
  expect(first.items.filter((entry) => entry.kind === 'skill' && entry.status === 'conflict')).toEqual([])

  applyContent(first, undefined, home, [])
  for (const [name, body] of [['foo-openclaw', 'Source foo.'], ['foo-openclaw-openclaw', 'Source foo-openclaw.']]) {
    expect(readFileSync(join(home, 'skills', name, 'SKILL.md'), 'utf8')).toContain(body)
  }
  expect(readFileSync(join(home, 'skills', 'foo', 'SKILL.md'), 'utf8')).toContain('Owner foo survives.')

  const second = planContent(options(), source, [])
  expect(second.actions.filter((action) => action.kind === 'skill')).toEqual([])
  expect(second.items.filter((entry) => entry.status === 'conflict' || entry.status === 'error')).toEqual([])
})
