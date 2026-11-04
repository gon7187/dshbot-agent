import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, test, vi } from 'vitest'
import { type FactoryProject } from '../factory/src/index.js'
import { createProjectGithub, isGithubMutation, resolveGithubProject, type GithubExec } from './src/github.js'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createDeliveryService, parseDeliveryReview, runDeliveryCommand, type DeliveryCommand, type DeliveryCommandOptions, type GithubProject, validateDeliveryPatch } from './src/delivery.js'

describe('own scoped GitHub broker', () => {
const TEST_TMP = join(homedir(), '.cache', 'dshbot-superagent-tests')
mkdirSync(TEST_TMP, { recursive: true, mode: 0o700 })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function project(path = '/fixture/project'): FactoryProject {
  return { id: 0, path, name: 'widget', testCommand: 'true', own: false }
}

function seam(overrides: {
  config?: string
  upstream?: string
  head?: string
  remoteHead?: string
  remoteListing?: string
  ghHttpStatus?: number
} = {}): {
  calls: Array<{ file: string; args: string[]; options: Parameters<GithubExec>[2] }>
  exec: GithubExec
} {
  const calls: Array<{ file: string; args: string[]; options: Parameters<GithubExec>[2] }> = []
  const exec: GithubExec = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (file === 'gh') {
      if (overrides.ghHttpStatus !== undefined) {
        const error = Object.assign(new Error(`gh: HTTP ${overrides.ghHttpStatus}: fixture-secret`), {
          stderr: `gh: HTTP ${overrides.ghHttpStatus}: fixture-secret`,
        })
        throw error
      }
      return { stdout: '{"ok":true}\n' }
    }
    const command = args[2]
    if (command === 'config') return { stdout: overrides.config ?? 'remote.origin.url\nhttps://github.com/acme/widget.git\0' }
    if (command === 'rev-parse' && args.includes('--abbrev-ref')) {
      if (overrides.upstream === undefined) throw new Error('no upstream')
      return { stdout: overrides.upstream }
    }
    if (command === 'symbolic-ref' && args.includes('--quiet')) {
      if (overrides.remoteHead === undefined) throw new Error('no local remote HEAD')
      return { stdout: overrides.remoteHead }
    }
    if (command === 'ls-remote') {
      if (overrides.remoteListing === undefined) throw new Error('remote HEAD unavailable')
      return { stdout: overrides.remoteListing }
    }
    if (command === 'init' || command === 'fetch' || command === 'symbolic-ref' || command === 'config') return { stdout: '' }
    if (command === 'rev-parse') return { stdout: overrides.head ?? `${'a'.repeat(40)}\n` }
    return { stdout: '' }
  }
  return { calls, exec }
}


test('S-BROKER confines repository and never exports host credentials', { timeout: 60_000 }, async () => {
  {
    const fixture = seam({ upstream: 'origin/main\n', remoteHead: 'origin/main\n' })
    vi.stubEnv('GITHUB_TOKEN', 'host-only-fixture-token')
    const metadata = await resolveGithubProject(project(), { exec: fixture.exec })
    expect(metadata).toEqual({
      repository: 'acme/widget',
      remote: 'https://github.com/acme/widget.git',
      url: 'https://github.com/acme/widget',
      baseBranch: 'main',
    })

    const github = createProjectGithub({ home: '/host/dshbot', projects: () => [project()], exec: fixture.exec })
    const result = await github(0, [
      'api', 'repos/acme/widget/issues?state=open', '--method', 'GET', '--paginate', '--slurp',
      '--jq', '{name: .full_name, push: .permissions.push}', '-H', 'Accept: application/vnd.github+json', '-H', 'If-None-Match: "fixture"',
    ])
    expect(result).toEqual({ stdout: '{"ok":true}\n' })
    const call = fixture.calls.at(-1)!
    expect(call.file).toBe('gh')
    expect(call.args).toEqual([
      'api', 'repos/acme/widget/issues?state=open', '--method', 'GET', '--paginate', '--slurp',
      '--jq', '{name: .full_name, push: .permissions.push}', '-H', 'Accept: application/vnd.github+json', '-H', 'If-None-Match: "fixture"',
    ])
    expect(call.options.cwd).toBe('/fixture/project')
    expect(call.args.join('\0')).not.toContain('host-only-fixture-token')
    const gitCall = fixture.calls.find(item => item.file === 'git')!
    expect(gitCall.options.env?.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(gitCall.options.env?.GIT_CONFIG_NOSYSTEM).toBe('1')

  }
  {
    const home = mkdtempSync(join(TEST_TMP, 'github-home-'))
    roots.push(home)
    const fixture = seam({ upstream: 'origin/main\n', remoteHead: 'origin/main\n' })
    vi.stubEnv('GH_TOKEN', 'host-only-fixture-token')
    const github = createProjectGithub({ home, projects: () => [project()], exec: fixture.exec })
    const response = await github(0, ['dshbot', 'refresh'])
    expect(JSON.parse(response.stdout)).toEqual({ repository: 'acme/widget', baseBranch: 'main', head: 'a'.repeat(40) })
    expect(fixture.calls.filter(call => call.file === 'gh')).toHaveLength(0)
    const gitArgs = fixture.calls.filter(call => call.file === 'git').map(call => call.args)
    expect(gitArgs).toContainEqual(['init', '--bare', '--quiet', '--template=/dev/null', join(home, 'superagent/bridge/0/repository.git')])
    expect(gitArgs).toContainEqual([
      '-C', join(home, 'superagent/bridge/0/repository.git'), 'fetch', '--no-tags', '--depth=1', '--force',
      'https://github.com/acme/widget.git', '+refs/heads/main:refs/heads/main',
    ])
    const fetch = fixture.calls.find(call => call.file === 'git' && call.args.includes('fetch'))!
    expect(fetch.options.env?.GIT_CONFIG_VALUE_1).toBe('!gh auth git-credential')
    expect(gitArgs.flat().join('\0')).not.toContain('host-only-fixture-token')

  }
  {
    const fixture = seam({ upstream: 'origin/main\n', remoteHead: 'origin/main\n' })
    const github = createProjectGithub({ home: '/host/dshbot', projects: () => [project()], exec: fixture.exec })
    for (const argv of [
      ['api', 'repos/other/repo/issues'],
      ['api', 'repos/acme/widget/issues/1/comments', '--method', 'POST', '-f', 'body=@/tmp/secret'],
      ['api', 'repos/acme/widget/issues', '-H', 'Authorization: Bearer fixture'],
      ['api', 'repos/acme/widget/pulls/1/merge'],
    ]) await expect(github(0, argv)).rejects.toThrow()
    expect(fixture.calls.filter(call => call.file === 'gh')).toHaveLength(0)

  }
})

})
describe('own reviewed publication', () => {
const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(process.cwd(), '.delivery-test-'))
  roots.push(path)
  return path
}

function processCommand(command: string, args: readonly string[], options: DeliveryCommandOptions = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }))
    child.once('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(options.input)
  })
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const result = await processCommand('git', args, { cwd, input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function waitForTerminal(service: ReturnType<typeof createDeliveryService>, projectId: number, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await service.status(projectId, id)
    if (status !== undefined && (status.state === 'merged' || status.state === 'failed' || (status.state === 'pr_open' && status.error !== undefined))) return status
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`delivery ${projectId}/${id} did not finish: ${JSON.stringify(await service.status(projectId, id))}`)
}

function project(path: string) {
  return { id: 7, path, name: 'fixture', testCommand: 'true', own: false }
}

const metadata: GithubProject = {
  repository: 'acme/widgets',
  remote: '',
  url: 'https://github.com/acme/widgets',
  baseBranch: 'main',
}

async function gitFixture() {
  const outer = root()
  const source = join(outer, 'source')
  const bare = join(outer, 'remote.git')
  await git(outer, ['init', '--bare', '--initial-branch=main', bare])
  await git(outer, ['init', '--initial-branch=main', source])
  await git(source, ['config', 'user.name', 'fixture'])
  await git(source, ['config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(source, 'README.md'), 'old\n')
  await git(source, ['add', 'README.md'])
  await git(source, ['commit', '-m', 'base'])
  await git(source, ['remote', 'add', 'origin', bare])
  await git(source, ['push', 'origin', 'main'])
  return {
    outer,
    source,
    bare,
    baseSha: await git(source, ['rev-parse', 'HEAD']),
    metadata: { ...metadata, remote: bare },
    patch: 'diff --git a/README.md b/README.md\nindex 3367afd..3e75765 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n',
  }
}

afterEach(() => {
  for (const path of roots.splice(0).reverse()) rmSync(path, { recursive: true, force: true })
})


test('S-PUBLICATION publishes only the exact reviewed diff without force', { timeout: 60_000 }, async () => {
  {
    expect(parseDeliveryReview('{"verdict":"approve","summary":"ok"}')).toEqual({ approved: true, summary: 'ok' })
    expect(parseDeliveryReview('{"verdict":"reject","summary":"no"}')).toEqual({ approved: false, summary: 'no' })
    for (const answer of ['LGTM', '```json\n{"verdict":"approve","summary":"ok"}\n```', '{"verdict":"approve"}', '{"verdict":"maybe","summary":"x"}']) {
      expect(() => parseDeliveryReview(answer)).toThrow()
    }

  }
  {
    const repo = root()
    const normal = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(validateDeliveryPatch(normal, repo)).toEqual(['src/a.ts'])
    expect(() => validateDeliveryPatch(normal.replaceAll('src/a.ts', 'CHARTER.md'), repo)).toThrow(/protected/u)
    expect(() => validateDeliveryPatch(normal.replaceAll('src/a.ts', 'package.json'), repo)).toThrow(/refused/u)
    expect(() => validateDeliveryPatch(normal.replaceAll('src/a.ts', '../outside'), repo)).toThrow(/escapes/u)
    expect(() => validateDeliveryPatch(`${normal}\nGIT binary patch\n`, repo)).toThrow(/binary/u)
    expect(() => validateDeliveryPatch(normal.replace('@@', 'new file mode 120000\n@@'), repo)).toThrow(/binary|symlink/u)

  }
  {
    const outer = root()
    const inheritedCwd = join(outer, 'hidden-owner-metadata')
    mkdirSync(inheritedCwd)
    writeFileSync(join(inheritedCwd, '.git'), 'gitdir: /missing-owner-metadata\n')
    const source = join(outer, 'source')
    const bare = join(outer, 'remote.git')
    await git(outer, ['init', '--bare', '--initial-branch=main', bare])
    await git(outer, ['init', '--initial-branch=main', source])
    await git(source, ['config', 'user.name', 'fixture'])
    await git(source, ['config', 'user.email', 'fixture@example.invalid'])
    writeFileSync(join(source, 'README.md'), 'old\n')
    await git(source, ['add', 'README.md'])
    await git(source, ['commit', '-m', 'base'])
    await git(source, ['remote', 'add', 'origin', bare])
    await git(source, ['push', 'origin', 'main'])
    const baseSha = await git(source, ['rev-parse', 'HEAD'])
    const projectMetadata = { ...metadata, remote: bare }
    const patch = 'diff --git a/README.md b/README.md\nindex 3367afd..3e75765 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'
    const db = new DatabaseSync(':memory:')
    const calls: Array<{ command: string; args: string[]; options?: DeliveryCommandOptions }> = []
    let headSha = ''
    let mergeSha = ''
    let branchName = ''
    let viewCalls = 0
    const command: DeliveryCommand = async (commandName, args, options) => {
      calls.push({ command: commandName, args: [...args], options })
      if (commandName === 'gh') {
        expect(options?.cwd).toBe('/')
        if (args.includes('list')) return { status: 0, stdout: '', stderr: '' }
        if (args.includes('create')) return { status: 0, stdout: 'https://github.com/acme/widgets/pull/1\n', stderr: '' }
        if (args.includes('view')) {
          viewCalls += 1
          if (viewCalls === 1) return {
            status: 0,
            stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, headRefOid: headSha, baseRefOid: baseSha, headRefName: branchName, baseRefName: 'main' }),
            stderr: '',
          }
          return {
            status: 0,
            stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-02T00:00:00Z', headRefOid: headSha || mergeSha, baseRefOid: baseSha, headRefName: branchName, baseRefName: 'main', mergeCommit: { oid: mergeSha } }),
            stderr: '',
          }
        }
      }
      if (commandName === 'git' && args[0] === 'push') {
        const ref = args.at(-1) ?? ''
        if (ref.includes('refs/heads/zavod/superagent-')) {
          headSha = ref.split(':')[0]!
          branchName = ref.split('refs/heads/')[1]!.split(':')[0]!
        }
        if (ref.endsWith(':refs/heads/main')) mergeSha = ref.split(':')[0]!
      }
      return processCommand(commandName, args, { ...options, cwd: options?.cwd ?? inheritedCwd })
    }
    let reviewPrompt = ''
    const service = createDeliveryService({
      home: outer,
      db,
      projects: () => [project(source)],
      resolveProject: async () => projectMetadata,
      command,
      reviewerModel: 'reviewer-1',
      sandbox: async sandboxOptions => {
        expect(sandboxOptions.command).toEqual(['true'])
        expect(sandboxOptions.ownerHome).toBe(outer)
        writeFileSync(join(sandboxOptions.candidate, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
        return { ok: true, status: 0, output: '' }
      },
      review: async prompt => { reviewPrompt = prompt; return '{"verdict":"approve","summary":"exact diff checked"}' },
    })

    const accepted = await service.submit(7, { id: 'job-1', baseSha, patch, title: 'change README' })
    expect(['queued', 'testing', 'review']).toContain(accepted.state)
    const result = await waitForTerminal(service, 7, 'job-1')
    expect(result.state, result.error).toBe('merged')
    expect(result.prUrl).toBe('https://github.com/acme/widgets/pull/1')
    expect(result.sha).toBe(mergeSha)
    expect(reviewPrompt).toContain('--- BEGIN EXACT DIFF ---')
    expect(reviewPrompt).toContain('+new')
    const create = calls.find(call => call.command === 'gh' && call.args.includes('create'))
    expect(create?.args.join('\n')).toContain('Tests: true')
    expect(create?.args.join('\n')).toContain('Reviewer model: reviewer-1')
    expect(calls.some(call => call.command === 'gh' && call.args.includes('merge'))).toBe(false)
    expect(calls.some(call => call.command === 'git' && call.args.includes('--force'))).toBe(false)
    const push = calls.find(call => call.command === 'git' && call.args[0] === 'push')
    expect(push?.options?.env?.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(push?.options?.env?.GIT_CONFIG_VALUE_3).toBe('!gh auth git-credential')
    expect(push?.options?.env?.GH_TOKEN).toBeUndefined()
    expect(await git(source, ['show', 'main:README.md'])).toBe('old')
    expect(await git(bare, ['show', 'main:README.md'])).toBe('new')
    await service.stop()
    db.close()

  }
  for (const bad of ['tests', 'review']) {
    const f = await gitFixture()
    const db = new DatabaseSync(':memory:')
    const calls: string[] = []
    const service = createDeliveryService({
      home: f.outer, db, projects: () => [project(f.source)], resolveProject: async () => f.metadata,
      command: async (name, args, options) => {
        calls.push(`${name} ${args[0]}`)
        return processCommand(name, args, options)
      },
      sandbox: async () => ({ ok: bad !== 'tests', status: bad === 'tests' ? 1 : 0, output: '' }),
      review: async () => '{"verdict":"reject","summary":"refused"}',
    })
    try {
      await service.submit(7, { id: bad, baseSha: f.baseSha, patch: f.patch, title: bad })
      expect((await waitForTerminal(service, 7, bad)).state).toBe('failed')
      expect(calls.some(call => call.startsWith('gh ') || call === 'git push')).toBe(false)
      expect(await git(f.bare, ['rev-parse', 'main'])).toBe(f.baseSha)
    } finally { await service.stop(); db.close() }
  }

})

test('S-UNCERTAIN verifies a lost receipt read-only without another push', { timeout: 60_000 }, async () => {
  {
    const fixture = await gitFixture()
    const db = new DatabaseSync(':memory:')
    let merge = ''
    let reachable = false
    let pushes = 0
    const command: DeliveryCommand = async (name, args, options) => {
      if (name === 'gh') {
        if (args[1] === 'list') return { status: 0, stdout: '', stderr: '' }
        if (args[1] === 'create') return { status: 0, stdout: `${metadata.url}/pull/1`, stderr: '' }
        if (args[1] === 'view') return reachable
          ? { status: 0, stderr: '', stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-04T00:00:00Z',
            baseRefName: 'main', mergeCommit: { oid: merge } }) }
          : { status: 1, stdout: '', stderr: 'network unavailable' }
      }
      if (name === 'git' && args[0] === 'push') {
        pushes++
        const ref = args.at(-1) ?? ''
        if (ref.endsWith(':refs/heads/main')) merge = ref.split(':')[0]!
      }
      return processCommand(name, args, options)
    }
    const service = createDeliveryService({
      home: fixture.outer, db, projects: () => [project(fixture.source)],
      resolveProject: async () => fixture.metadata, command,
      sandbox: async () => ({ ok: true, status: 0, output: '' }),
      review: async () => '{"verdict":"approve","summary":"ok"}',
    })
    try {
      await service.submit(7, { id: 'lost-verification', baseSha: fixture.baseSha, patch: fixture.patch, title: 'change README' })
      expect(await waitForTerminal(service, 7, 'lost-verification')).toMatchObject({
        state: 'pr_open', sha: merge, error: expect.stringContaining('delivery outcome uncertain'),
      })
      expect(await git(fixture.bare, ['rev-parse', 'main'])).toBe(merge)
      reachable = true
      expect(await service.status(7, 'lost-verification')).toMatchObject({ state: 'merged', sha: merge })
      expect(pushes).toBe(2)
    } finally {
      await service.stop()
      db.close()
    }

  }
})

})
