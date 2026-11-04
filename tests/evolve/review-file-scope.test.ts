import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createEvolve, type Evolve, type SandboxRunner } from '../../packages/evolve/src/index.js'

const env = {
  PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
let root: string
let home: string
let live: string
let origin: string
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'review-scope-')))
  home = join(root, 'home')
  live = join(home, 'app')
  origin = join(root, 'origin')
  mkdirSync(origin, { recursive: true })
  mkdirSync(live, { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  for (const file of ['CHECKLIST.md', '.github/workflows/ci.yml', 'docs/CONFIG.md', 'README.md']) put(join(origin, file), `base ${file}\n`)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'base')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'remote', 'add', 'origin', origin)
  git(live, 'fetch', '-q', 'origin')
  git(live, 'reset', '-q', '--hard', 'origin/main')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function world(sandbox: SandboxRunner = () => ({ ok: true, status: 0, output: '' })) {
  const reviewer = vi.fn(async (_request: { model: string; prompt: string }) => JSON.stringify({ verdict: 'reject', summary: 'code rejected' }))
  const gate = vi.fn(sandbox)
  const evolve = createEvolve({ home, live, ownerHome: root, review: { baseUrl: 'http://127.0.0.1:9', apiKey: 'unused' }, reviewer,
    sandbox: gate, card: async () => undefined, log: () => undefined })
  return { evolve, reviewer, gate }
}
async function candidate(evolve: Evolve, description = 'edit files'): Promise<{ id: string; path: string }> {
  const start = evolve.tools.find((tool) => tool.name === 'self_change')!
  const result = String(await start.execute({ description }))
  const id = /^id:\s*(\S+)/m.exec(result)?.[1]
  const path = /^Кандидат:\s*(.+)$/m.exec(result)?.[1]?.trim()
  if (id === undefined || path === undefined) throw new Error(`missing candidate: ${result}`)
  return { id, path }
}
async function submit(evolve: Evolve, id: string): Promise<string> {
  try { return String(await evolve.tools.find((tool) => tool.name === 'self_submit')!.execute({ id })) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}
function upstream(files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) put(join(origin, file), content)
  git(origin, 'add', '-A')
  git(origin, 'commit', '-q', '-m', 'upstream')
  return git(origin, 'rev-parse', 'HEAD')
}

function ownCommit(): string {
  put(join(live, 'packages/app/src/own.ts'), 'export const own = true\n')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'evolve: own behavior')
  return git(live, 'rev-parse', 'HEAD')
}

test('c5 synchronization reviews behavior and protected files; self changes reject protected and dependency files before review', async () => {
  ownCommit()
  const paths = ['prompts/rules.md', 'persona/rules.md', 'CHARTER.md', 'CHECKLIST.md', 'scripts/example.sh', 'package.json']
  upstream(Object.fromEntries(paths.map((path, i) => [path, `SYNC_MARKER_${i}\n`])))
  const { evolve, reviewer } = world()
  const report = await evolve.syncMain()
  expect(report.state).toBe('gate-failed')
  expect(reviewer).toHaveBeenCalled()
  const prompt = reviewer.mock.calls[0]![0].prompt
  for (let i = 0; i < paths.length; i++) expect(prompt).toContain(`SYNC_MARKER_${i}`)
  reviewer.mockClear()
  const editable = await candidate(evolve)
  for (const [i, path] of ['prompts/rules.md', 'persona/rules.md', 'packages/app/src/example.ts'].entries()) put(join(editable.path, path), `SELF_MARKER_${i}\n`)
  expect(await submit(evolve, editable.id)).toContain('code rejected')
  expect(reviewer).toHaveBeenCalled()
  const selfPrompt = reviewer.mock.calls[0]![0].prompt
  for (let i = 0; i < 3; i++) expect(selfPrompt).toContain(`SELF_MARKER_${i}`)
  for (const path of ['CHARTER.md', 'CHECKLIST.md', 'scripts/example.sh', 'package.json']) {
    reviewer.mockClear()
    const item = await candidate(evolve)
    put(join(item.path, path), 'forbidden change\n')
    expect(await submit(evolve, item.id)).toMatch(/Гейт не пройден/)
    expect(reviewer).not.toHaveBeenCalled()
  }
})

test('c6 h1 protected github changes including symlink to documentation fail before review', async () => {
  const { evolve, reviewer } = world()
  for (const mode of ['file', 'with-doc', 'symlink', 'target-protected']) {
    const item = await candidate(evolve)
    const workflow = join(item.path, '.github/workflows/ci.yml')
    if (mode === 'symlink') { rmSync(workflow); symlinkSync('../../docs/CONFIG.md', workflow) }
    else if (mode === 'target-protected') symlinkSync('../.github/workflows/ci.yml', join(item.path, 'docs/alias.md'))
    else put(workflow, 'changed workflow\n')
    if (mode === 'with-doc') put(join(item.path, 'docs/CONFIG.md'), 'changed docs\n')
    expect(await submit(evolve, item.id)).toMatch(/защищённые пути/)
    expect(reviewer).not.toHaveBeenCalled()
  }
})

test('h1 symlink under docs is reviewed as a change', async () => {
  const { evolve, reviewer } = world()
  const item = await candidate(evolve)
  const path = join(item.path, 'docs/CONFIG.md')
  rmSync(path)
  symlinkSync('../README.md', path)
  expect(await submit(evolve, item.id)).toContain('code rejected')
  expect(reviewer).toHaveBeenCalled()
  expect(reviewer.mock.calls[0]![0].prompt).toContain('../README.md')
})

test('h2 self change through a symlinked workflow directory is rejected before review', async () => {
  const { evolve, reviewer } = world()
  const item = await candidate(evolve)
  const workflows = join(item.path, '.github/workflows')
  rmSync(workflows, { recursive: true })
  symlinkSync('../docs', workflows)
  put(join(item.path, '.github/workflows/ci.yml'), 'changed through link\n')
  expect(await submit(evolve, item.id)).toMatch(/защищённые пути/)
  expect(reviewer).not.toHaveBeenCalled()
})

test('h3 deletion beneath a symlinked docs ancestor is reviewed in full', async () => {
  put(join(live, 'docs/sub/deep/deleted.md'), 'DELETED_REVIEW_MARKER\n')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'add nested documentation')
  const { evolve, reviewer } = world()
  const item = await candidate(evolve)
  rmSync(join(item.path, 'docs/sub'), { recursive: true })
  mkdirSync(join(item.path, 'target'))
  symlinkSync('../target', join(item.path, 'docs/sub'))

  expect(await submit(evolve, item.id)).toContain('code rejected')
  expect(reviewer).toHaveBeenCalled()
  const prompt = reviewer.mock.calls[0]![0].prompt
  expect(prompt).toContain('docs/sub/deep/deleted.md')
  expect(prompt).toContain('-DELETED_REVIEW_MARKER')
  expect(prompt).not.toContain(JSON.stringify('docs/sub/deep/deleted.md'))
})


test('canonical fast-forward uses full tests without LLM; replayed own changes retain mandatory review and self-change policy', async () => {
  baseline({ 'package.json': '{"private":true,"scripts":{"gate":"node gate.js"}}\n' })
  const mainSha = upstream({
    'packages/evolve/src/example.ts': 'UPSTREAM_GATE_CODE\n',
    'packages/tools-exec/src/example.ts': 'UPSTREAM_SANDBOX_CODE\n',
    'CHECKLIST.md': 'CANDIDATE_POLICY_MUST_NOT_AUTHORIZE_REVIEW\n',
  })
  let testedSha = ''
  const { evolve, reviewer, gate } = world((options) => {
    testedSha = git(options.candidate, 'rev-parse', 'HEAD')
    return { ok: true, status: 0, output: '' }
  })
  reviewer.mockRejectedValue(new Error('LLM must not gate exact trusted main'))
  const canonical = await evolve.syncMain()
  expect(canonical.state, JSON.stringify(canonical)).toBe('adopted')
  expect(canonical.sha).toBe(mainSha)
  expect(gate.mock.calls[0]![0].command).toEqual(['npm', 'test'])
  expect(reviewer).not.toHaveBeenCalled()
  rmSync(join(home, 'adopt.json'))
  const liveSha = ownCommit()
  reviewer.mockResolvedValue(JSON.stringify({ verdict: 'reject', summary: 'sandbox would expose owner credentials' }))
  const refused = await evolve.syncMain()
  expect(refused.state).toBe('gate-failed')
  expect(refused.error).toContain('sandbox would expose owner credentials')
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)
  const prompt = reviewer.mock.calls[0]![0].prompt
  expect(prompt).toContain('## Режим: sync-main')
  expect(prompt).toContain(mainSha)
  expect(prompt).toContain(liveSha)
  expect(prompt).toContain('UPSTREAM_GATE_CODE')
  expect(prompt).toContain('UPSTREAM_SANDBOX_CODE')
  expect(testedSha).not.toBe(mainSha)
  expect(gateEvidence(prompt)).toMatchObject({ mainSha, liveSha, candidateSha: testedSha,
    gate: { status: 0, sandbox: true, testedSha } })
  const policy = prompt.split('## Trusted sync-review checklist')[1]?.split('## ')[0]
  expect(policy).toBeTruthy()
  expect(policy).not.toContain('CANDIDATE_POLICY_MUST_NOT_AUTHORIZE_REVIEW')
  reviewer.mockResolvedValue(JSON.stringify({ verdict: 'approve', summary: 'reviewed main update' }))
  const accepted = await evolve.syncMain()
  expect(accepted.state, JSON.stringify(accepted)).toBe('adopted')
  expect(accepted.sha).toBe(testedSha)
  expect(accepted.sha).not.toBe(mainSha)
  expect(JSON.parse(readFileSync(join(home, 'adopt.json'), 'utf8')).sha).toBe(testedSha)
  reviewer.mockClear()
  reviewer.mockResolvedValue(JSON.stringify({ verdict: 'reject', summary: 'code rejected' }))
  const own = await candidate(evolve, 'sync-main origin/main: update controller')
  put(join(own.path, 'packages/app/src/example.ts'), 'SELF_CHANGE_CODE\n')
  expect(await submit(evolve, own.id)).toContain('code rejected')
  const ownPrompt = reviewer.mock.calls[0]![0].prompt
  expect(ownPrompt).not.toContain('## Режим: sync-main')
  expect(ownPrompt).toContain('base CHECKLIST.md')
  reviewer.mockClear()
  const protectedOwn = await candidate(evolve, 'sync-main origin/main: update controller')
  put(join(protectedOwn.path, 'packages/evolve/src/example.ts'), 'forbidden autonomous edit\n')
  expect(await submit(evolve, protectedOwn.id)).toContain('защищённые пути')
  expect(reviewer).not.toHaveBeenCalled()
})


test('sync review refuses provenance when the gate moves the candidate off captured main', async () => {
  const liveSha = git(live, 'rev-parse', 'HEAD')
  upstream({ 'packages/app/src/example.ts': 'MAIN_CODE\n' })
  const { evolve, reviewer } = world((options) => {
    git(options.candidate, 'reset', '--hard', liveSha)
    return { ok: true, status: 0, output: '' }
  })
  const report = await evolve.syncMain()
  expect(report.state).toBe('gate-failed')
  expect(report.error).toContain('больше не основан на проверенном origin/main')
  expect(reviewer).not.toHaveBeenCalled()
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)
  expect(git(live, 'rev-parse', 'HEAD')).toBe(liveSha)
})

function gateEvidence(prompt: string): Record<string, unknown> {
  const section = prompt.split('## Controller-verified gate evidence')[1]
  const block = section?.match(/```json\s*([\s\S]*?)```/)
  expect(block, 'controller supplies machine-readable gate proof').toBeTruthy()
  return JSON.parse(block![1]!)
}
function baseline(files: Record<string, string>): void {
  upstream(files)
  git(live, 'fetch', '-q', 'origin')
  git(live, 'reset', '-q', '--hard', 'origin/main')
}

test.each(['tracked', 'untracked', 'head'] as const)('sync rejects successful gate with %s candidate drift before review', async (drift) => {
  const liveSha = git(live, 'rev-parse', 'HEAD')
  upstream({ 'packages/app/src/example.ts': 'VERIFIED_SOURCE\n' })
  const { evolve, reviewer } = world((options) => {
    if (drift === 'tracked') put(join(options.candidate, 'packages/app/src/example.ts'), 'UNTESTED_SOURCE\n')
    else put(join(options.candidate, 'untracked.ts'), 'UNTESTED_SOURCE\n')
    if (drift === 'head') {
      git(options.candidate, 'add', '-A')
      git(options.candidate, 'commit', '-q', '-m', 'gate changed candidate')
    }
    return { ok: true, status: 0, output: '' }
  })
  reviewer.mockResolvedValue(JSON.stringify({ verdict: 'approve', summary: 'approved' }))
  const result = await evolve.syncMain()
  expect(result.state, JSON.stringify(result)).toBe('gate-failed')
  expect(reviewer).not.toHaveBeenCalled()
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)
  expect(git(live, 'rev-parse', 'HEAD')).toBe(liveSha)
})

test('sync rejects staged changes made during review before adoption', async () => {
  const liveSha = ownCommit()
  upstream({ 'packages/app/src/example.ts': 'VERIFIED_SOURCE\n' })
  let candidatePath = ''
  const { evolve, reviewer } = world((options) => {
    candidatePath = options.candidate
    return { ok: true, status: 0, output: '' }
  })
  reviewer.mockImplementation(async () => {
    put(join(candidatePath, 'packages/app/src/example.ts'), 'AFTER_REVIEW_SOURCE\n')
    git(candidatePath, 'add', '-A')
    return JSON.stringify({ verdict: 'approve', summary: 'approved' })
  })
  expect((await evolve.syncMain()).state).toBe('gate-failed')
  expect(reviewer).toHaveBeenCalled()
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)
  expect(git(live, 'rev-parse', 'HEAD')).toBe(liveSha)
})

test('sync reviews complete bounded executable packets and every deletion; any rejected packet blocks adoption', async () => {
  baseline({
    'packages/app/src/deleted.ts': 'DELETED_PRODUCTION_BODY\n',
    'tests/importable.test.ts': 'DELETED_IMPORTABLE_TEST_BODY\n',
  })
  const liveSha = ownCommit()
  rmSync(join(origin, 'packages/app/src/deleted.ts'))
  rmSync(join(origin, 'tests/importable.test.ts'))
  const mainSha = upstream({
    'packages/app/src/a.ts': `//${'a'.repeat(105000)}\nexport const a = 'PACKET_A_TAIL'\n`,
    'packages/app/src/b.ts': `//${'b'.repeat(105000)}\nexport const b = 'PACKET_B_TAIL'\n`,
  })
  let testedSha = ''
  const { evolve, reviewer } = world((options) => {
    testedSha = git(options.candidate, 'rev-parse', 'HEAD')
    return { ok: true, status: 0, output: '' }
  })
  for (const rejected of ['PACKET_A_TAIL', 'PACKET_B_TAIL', null]) {
    reviewer.mockClear()
    const finding = 'Reviewed installer disables lifecycle scripts; preserve this verified finding across packets.'
    let reviewedPackets = 0
    reviewer.mockImplementation(async ({ prompt }) => {
      const first = reviewedPackets++ === 0
      return JSON.stringify({
        verdict: rejected !== null && prompt.includes(rejected) ? 'reject' : 'approve',
        summary: rejected === null && first ? finding : 'packet reviewed',
      })
    })
    const result = await evolve.syncMain()
    expect(result.state, `${rejected}: ${JSON.stringify(result)}`).toBe(rejected === null ? 'adopted' : 'gate-failed')
    expect(existsSync(join(home, 'adopt.json'))).toBe(rejected === null)
    expect(git(live, 'rev-parse', 'HEAD')).toBe(liveSha)
    if (rejected !== null) continue
    const prompts = reviewer.mock.calls.map(([request]) => request.prompt)
    expect(prompts.length).toBeGreaterThan(1)
    expect(prompts[0]!.includes(finding)).toBe(false)
    expect(prompts[1]!.includes(finding), 'next packet receives previous approved finding').toBe(true)
    const contexts = prompts.map(gateEvidence)
    expect(contexts[0]).toMatchObject({ dependencyPreparation: { performed: false },
      packet: { index: 1, total: prompts.length, files: expect.arrayContaining(['packages/app/src/a.ts']) } })
    expect(contexts[1]).toMatchObject({ dependencyPreparation: { performed: false },
      packet: { index: 2, total: prompts.length, files: expect.arrayContaining(['packages/app/src/b.ts']) } })
    const continuity = [...prompts[1]!.matchAll(/```json\s*([\s\S]*?)```/g)]
      .map((match) => JSON.parse(match[1]!)).find((value) => Array.isArray(value.priorApprovedPackets))
    expect(continuity?.priorApprovedPackets).toContainEqual({ packet: 1, summary: finding })
    for (const [index, prompt] of prompts.entries()) {
      const global = prompt.split('\n').filter((line) => line.startsWith('{') && line.includes('\"reviewedFiles\"'))
        .map((line) => JSON.parse(line)).find((value) => value.reviewedFiles === 4)
      expect(global).toMatchObject({ reviewedFiles: 4, deletedFiles: 2 })
      const files = (contexts[index]!.packet as { files: string[] }).files
      expect(files.length).toBeLessThan(global.reviewedFiles)
      expect(files.includes(index === 0 ? 'packages/app/src/b.ts' : 'packages/app/src/a.ts')).toBe(false)
    }
    for (const marker of ['PACKET_A_TAIL', 'PACKET_B_TAIL', '-DELETED_PRODUCTION_BODY', '-DELETED_IMPORTABLE_TEST_BODY'])
      expect(prompts.some((prompt) => prompt.includes(marker)), marker).toBe(true)
    expect(prompts.some((prompt) => prompt.includes('PACKET_A_TAIL') && prompt.includes('PACKET_B_TAIL'))).toBe(false)
    for (const prompt of prompts) {
      expect(prompt.length).toBeLessThanOrEqual(160000)
      expect(gateEvidence(prompt)).toMatchObject({ mainSha, liveSha, candidateSha: testedSha,
        gate: { status: 0, sandbox: true, testedSha } })
    }
  }
})

test('sync fails closed for a single executable diff exceeding the complete prompt budget', async () => {
  ownCommit()
  upstream({ 'packages/app/src/oversized.ts': `//${'x'.repeat(170000)}\nexport const end = 'OVERSIZED_TAIL'\n` })
  const { evolve, reviewer } = world()
  reviewer.mockResolvedValue(JSON.stringify({ verdict: 'approve', summary: 'approved' }))
  expect((await evolve.syncMain()).state).toBe('gate-failed')
  expect(reviewer).not.toHaveBeenCalled()
  expect(existsSync(join(home, 'adopt.json'))).toBe(false)
})

test('sync lock packets preserve complete changed entries and metadata without unchanged lock bulk', async () => {
  const packages: Record<string, unknown> = { '': { name: 'fixture', version: '1.0.0' } }
  for (let i = 0; i < 1200; i++) packages[`node_modules/unchanged-${i}`] = {
    version: '1.0.0', resolved: `https://registry.npmjs.org/unchanged-${i}/-/unchanged-${i}-1.0.0.tgz`, integrity: 'sha512-unchanged',
  }
  const oldEntry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/payload/-/payload-1.0.0.tgz', integrity: 'sha512-old', unknownBefore: 'KEEP_OLD_FIELD' }
  packages['node_modules/payload'] = oldEntry
  const lock = { name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }
  baseline({ 'package.json': '{"name":"fixture","version":"1.0.0","private":true}\n', 'package-lock.json': JSON.stringify(lock) })
  ownCommit()
  const entry = { version: '2.0.0', resolved: 'https://untrusted.invalid/payload.tgz', hasInstallScript: true,
    bin: { payload: 'BIN_PAYLOAD_SENTINEL.js' }, unknownField: { marker: 'UNKNOWN_PACKAGE_FIELD' } }
  lock.packages['node_modules/payload'] = entry
  const mainSha = upstream({
    'package-lock.json': JSON.stringify({ ...lock, unknownMetadata: { marker: 'UNKNOWN_ROOT_METADATA' } }),
    'packages/app/src/example.ts': 'LOCK_UPDATE_RUNTIME_MARKER\n',
  })
  const bin = join(root, 'bin')
  put(join(bin, 'npm'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'npm'), 0o755)
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
  try {
    const { evolve, reviewer } = world()
    reviewer.mockResolvedValue(JSON.stringify({ verdict: 'approve', summary: 'approved' }))
    const result = await evolve.syncMain()
    expect(result.state, JSON.stringify(result)).toBe('adopted')
    expect(result.sha).not.toBe(mainSha)
    expect(git(live, 'merge-base', '--is-ancestor', mainSha, result.sha!)).toBe('')
    const prompts = reviewer.mock.calls.map(([request]) => request.prompt)
    expect(prompts.some((prompt) => prompt.includes('LOCK_UPDATE_RUNTIME_MARKER'))).toBe(true)
    const objects = prompts.flatMap((prompt) => [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!)))
    const delta = objects.find((value) => value.package === 'node_modules/payload')
    expect(delta?.before).toEqual(oldEntry)
    expect(delta?.after).toEqual(entry)
    expect(objects.some((value) => value.metadata?.after?.unknownMetadata?.marker === 'UNKNOWN_ROOT_METADATA')).toBe(true)
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(160000)
  } finally { vi.unstubAllEnvs() }
})
