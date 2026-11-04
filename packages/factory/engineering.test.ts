import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { sandboxArgs, sandboxedTests } from '../evolve/src/index.js'
import { sandboxProfile } from '../tools-exec/src/index.js'
import { createEngineeringRuntime, createEngineeringGitView, engineeringHiddenPaths, isEngineeringPrivatePath, isSafeEngineeringNpmrc } from './src/engineering.js'

const scratch = mkdtempSync(join(tmpdir(), 'dshbot-engineering-test-'))
const probe = sandboxProfile({ home: homedir(), workspace: scratch, roPaths: [] })
const sandboxed = spawnSync(probe[0]!, [...probe.slice(1), '/bin/true'], { timeout: 10_000 }).status === 0
let runtime: Awaited<ReturnType<typeof createEngineeringRuntime>> | undefined

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  rmSync(scratch, { recursive: true, force: true })
})

function fixture(): { worktree: string; owner: string } {
  const worktree = join(scratch, 'candidate')
  const owner = join(scratch, 'owner')
  mkdirSync(worktree, { recursive: true })
  mkdirSync(owner, { recursive: true })
  writeFileSync(join(owner, 'sentinel'), 'OWNER-PRIVATE')
  writeFileSync(join(worktree, '.env'), 'CREDENTIAL-SENTINEL')
  writeFileSync(join(worktree, '.npmrc'), 'PRIVATE-REGISTRY-CREDENTIAL')
  mkdirSync(join(worktree, 'SeCrEtS'))
  writeFileSync(join(worktree, 'SeCrEtS/private'), 'NESTED-CREDENTIAL-SENTINEL')
  mkdirSync(join(worktree, 'src'))
  writeFileSync(join(worktree, 'src/secrets.ts'), 'export const fixtureValue: number = 42\n')
  writeFileSync(join(worktree, 'src/secret-input.ts'), "import { fixtureValue } from './secrets.ts'; if (fixtureValue !== 42) throw new Error('fixture import'); console.log('source-import-ready')\n")
  mkdirSync(join(worktree, 'fixture-package'), { recursive: true })
  writeFileSync(join(worktree, 'fixture-package/package.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', main: 'index.cjs' }))
  writeFileSync(join(worktree, 'fixture-package/index.cjs'), 'module.exports = 42\n')
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "require(\'node:assert/strict\').equal(require(\'local-fixture\'),42)"' } }))
  writeFileSync(join(worktree, '.gitignore'), 'node_modules/\n')
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: worktree, encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost',
    } })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  git('init', '--template=', '--initial-branch=main', '--separate-git-dir=' + join(owner, 'gitdir'))
  git('add', 'src', 'fixture-package', 'package.json', '.gitignore')
  git('commit', '-m', 'Private owner history sentinel')
  git('config', 'remote.origin.url', 'https://fixture-token@example.invalid/private')
  return { worktree, owner }
}

test.skipIf(!sandboxed)('autonomous commands install dependencies, test and keep tools without exposing owner or Git state', { timeout: 120_000 }, async () => {
  const { worktree, owner } = fixture()
  runtime = await createEngineeringRuntime({ worktree })
  const install = await runtime.run('npm install --offline --ignore-scripts ./fixture-package && npm test')
  expect(install.ok, install.output).toBe(true)
  const source = await runtime.run('node src/secret-input.ts')
  expect(source.ok, source.output).toBe(true)
  expect(source.output).toContain('source-import-ready')
  expect((await runtime.run('echo candidate > result.txt')).ok).toBe(true)
  expect(readFileSync(join(worktree, 'result.txt'), 'utf8')).toBe('candidate\n')
  expect((await runtime.run('mkdir -p "$NPM_CONFIG_PREFIX/bin"; printf "#!/bin/sh\\necho tool-ready\\n" > "$NPM_CONFIG_PREFIX/bin/candidate-tool"; chmod +x "$NPM_CONFIG_PREFIX/bin/candidate-tool"')).ok).toBe(true)
  const tool = await runtime.run('candidate-tool')
  expect(tool.ok, tool.output).toBe(true)
  expect(tool.output).toContain('tool-ready')
  for (const path of [join(owner, 'sentinel'), join(worktree, '.env'), join(worktree, '.npmrc')]) {
    const read = await runtime.run(`cat '${path}'`)
    expect(read.ok, read.output).toBe(false)
    expect(read.output).not.toContain('OWNER-PRIVATE')
    expect(read.output).not.toContain('CREDENTIAL-SENTINEL')
    const write = await runtime.run(`echo changed > '${path}'`)
    expect(write.ok, write.output).toBe(false)
  }
  const pointer = await runtime.run('cat .git')
  expect(pointer.ok, pointer.output).toBe(true)
  expect(pointer.output).toContain('gitdir: /tmp/dshbot-engineering-git')
  expect(pointer.output).not.toContain(owner)
  expect((await runtime.run('echo changed > .git')).ok).toBe(false)
  expect((await runtime.run('cat SeCrEtS/private')).ok).toBe(false)
  await runtime.run('echo private-write > SeCrEtS/private')
  expect(readFileSync(join(worktree, 'SeCrEtS/private'), 'utf8')).toBe('NESTED-CREDENTIAL-SENTINEL')
  expect(readFileSync(join(owner, 'sentinel'), 'utf8')).toBe('OWNER-PRIVATE')
  expect(readFileSync(join(worktree, '.env'), 'utf8')).toBe('CREDENTIAL-SENTINEL')
  await runtime.stop()
  const safe = 'ignore-scripts=true\nsave-exact=true\n'
  writeFileSync(join(worktree, '.npmrc'), safe)
  runtime = await createEngineeringRuntime({ worktree })
  expect((await runtime.run('cat .npmrc')).output).toContain('ignore-scripts=true')
  expect((await runtime.run('echo credential > .npmrc')).ok).toBe(false)
  await runtime.stop()
  const gitView = await createEngineeringGitView(worktree)
  try {
    const gate = await sandboxedTests({
      ownerHome: homedir(), candidate: worktree, liveModules: join(owner, 'node_modules'), modules: 'candidate',
      toolsDir: `${worktree}.tools`, hiddenPaths: engineeringHiddenPaths(worktree),
      readOnlyPaths: [join(worktree, '.npmrc')], ...(gitView === undefined ? {} : { gitView }),
      command: ['bash', '-c', 'node src/secret-input.ts && candidate-tool && grep -qx "ignore-scripts=true" .npmrc && ! echo changed > .npmrc && ! cat .env && ! cat SeCrEtS/private && ! echo changed > "$NPM_CONFIG_PREFIX/bin/candidate-tool"'],
    })
    expect(gate.ok, gate.output).toBe(true)
    expect(gate.output).toContain('tool-ready')
    expect(gate.output).not.toContain('CREDENTIAL-SENTINEL')
  } finally { gitView?.stop() }
  expect(readFileSync(join(worktree, '.npmrc'), 'utf8')).toBe(safe)
})

test.skipIf(!sandboxed)('stop kills background writers before a candidate can be verified', { timeout: 120_000 }, async () => {
  const { worktree } = fixture()
  runtime = await createEngineeringRuntime({ worktree })
  const tool = runtime.tools.find((candidate) => candidate.name === 'exec')!
  await tool.execute({ command: 'while true; do echo tick >> heartbeat; sleep 0.02; done', background: true }, { signal: new AbortController().signal })
  await expect.poll(() => {
    try { return readFileSync(join(worktree, 'heartbeat'), 'utf8').length } catch { return 0 }
  }).toBeGreaterThan(0)
  await runtime.stop()
  const stopped = readFileSync(join(worktree, 'heartbeat'), 'utf8')
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(readFileSync(join(worktree, 'heartbeat'), 'utf8')).toBe(stopped)
  await expect(runtime.run('echo late >> heartbeat')).rejects.toThrow()
})

test.skipIf(!sandboxed)('neutral Git views support repository checks and nested fixtures without exposing or mutating owner history', { timeout: 120_000 }, async () => {
  const { worktree, owner } = fixture()
  const originalPointer = readFileSync(join(worktree, '.git'), 'utf8')
  runtime = await createEngineeringRuntime({ worktree })
  const checked = await runtime.run('git ls-files --error-unmatch package.json && git status --porcelain && git log -1 --format=%s && git remote -v')
  expect(checked.ok, checked.output).toBe(true)
  expect(checked.output).toContain('Engineering candidate snapshot')
  expect(checked.output).not.toContain('Private owner history sentinel')
  expect(checked.output).not.toContain('fixture-token')
  expect(checked.output).not.toContain(owner)
  const nested = await runtime.run('mkdir /tmp/nested && cd /tmp/nested && git init --template= --initial-branch=fixture && echo fixture > fixture.txt && git add fixture.txt && git ls-files --error-unmatch fixture.txt')
  expect(nested.ok, nested.output).toBe(true)
  expect((await runtime.run('git rm --cached package.json')).ok).toBe(true)
  await runtime.stop()
  expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(originalPointer)
  const originalIndex = spawnSync('git', ['-C', worktree, 'ls-files', '--error-unmatch', 'package.json'], { encoding: 'utf8' })
  expect(originalIndex.status, originalIndex.stderr).toBe(0)
  const gitView = await createEngineeringGitView(worktree)
  try {
    const gate = await sandboxedTests({
      ownerHome: homedir(), candidate: worktree, liveModules: join(owner, 'node_modules'), modules: 'candidate',
      toolsDir: `${worktree}.tools`, hiddenPaths: engineeringHiddenPaths(worktree), gitView: gitView!,
      command: ['bash', '-c', 'git ls-files --error-unmatch package.json && git log -1 --format=%s && git status --porcelain && test -z "$(git remote)" && ! git add package.json && mkdir /tmp/gate-nested && cd /tmp/gate-nested && git init --template= --initial-branch=fixture && echo gate-fixture > gate.txt && git add gate.txt && git ls-files --error-unmatch gate.txt'],
    })
    expect(gate.ok, `${gate.sandboxError ?? ''}\n${gate.output}`).toBe(true)
    expect(gate.output).toContain('Engineering candidate snapshot')
    expect(gate.output).not.toContain('Private owner history sentinel')
    expect(gate.output).not.toContain('fixture-token')
  } finally {
    gitView?.stop()
  }
})

test.skipIf(!sandboxed)('trusted dependency refresh ignores task npm, node and bash shadows and replaces the installed runner', { timeout: 120_000 }, async () => {
  const { worktree } = fixture()
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'npm run verify', verify: 'fixture-runner' } }))
  writeFileSync(join(worktree, 'fixture-package/package.json'), JSON.stringify({
    name: 'local-fixture', version: '1.0.0', main: 'index.cjs', bin: { 'fixture-runner': 'runner.cjs' },
  }))
  writeFileSync(join(worktree, 'fixture-package/runner.cjs'), '#!/usr/bin/env node\nconsole.log("HONEST-RUNNER")\n', { mode: 0o755 })
  runtime = await createEngineeringRuntime({ worktree })
  const installed = await runtime.run('npm install --offline --ignore-scripts --install-links ./fixture-package')
  expect(installed.ok, installed.output).toBe(true)
  const tool = runtime.tools.find((candidate) => candidate.name === 'exec')!
  const poison = [
    `printf '%s\\n' '#!/usr/bin/env node' 'console.log("TAINTED-RUNNER")' > node_modules/local-fixture/runner.cjs`,
    'task_tools="${CARGO_INSTALL_ROOT%/cargo}"',
    'for dir in "$task_tools/bin" "$task_tools/pyenv/bin"; do',
    'mkdir -p "$dir"',
    'printf "%s\\n" "#!/bin/sh" "echo SHADOW-NPM; touch shadow-npm-invoked" > "$dir/npm"',
    'printf "%s\\n" "#!/bin/sh" "echo SHADOW-NODE; touch shadow-node-invoked" > "$dir/node"',
    'printf "%s\\n" "#!/bin/sh" "echo SHADOW-BASH; touch shadow-bash-invoked" > "$dir/bash"',
    'chmod +x "$dir/npm" "$dir/node" "$dir/bash"',
    'done',
    'printf "%s\\n" "#!/bin/sh" "echo private-python" > "$task_tools/pyenv/bin/python3"',
    'cp "$task_tools/pyenv/bin/python3" "$task_tools/pyenv/bin/pip"',
    'chmod +x "$task_tools/pyenv/bin/python3" "$task_tools/pyenv/bin/pip"',
  ].join('\n')
  await tool.execute({ command: poison }, { signal: new AbortController().signal })
  const rolePath = String(await tool.execute({ command: 'command -v npm' }, { signal: new AbortController().signal }))
  expect(rolePath).toContain(`${worktree}.tools/pyenv/bin/npm`)
  const refreshed = await runtime.run(`npm ci --ignore-scripts --offline --install-links && node -e 'console.log("TRUSTED-NODE")' && node_modules/.bin/fixture-runner`)
  expect(refreshed.ok, refreshed.output).toBe(true)
  expect(refreshed.output).toContain('HONEST-RUNNER')
  expect(refreshed.output).toContain('TRUSTED-NODE')
  expect(refreshed.output).not.toContain('SHADOW-')
  expect(existsSync(join(worktree, 'shadow-npm-invoked'))).toBe(false)
  expect(existsSync(join(worktree, 'shadow-node-invoked'))).toBe(false)
  expect(existsSync(join(worktree, 'shadow-bash-invoked'))).toBe(false)
  expect(readFileSync(join(worktree, 'node_modules/local-fixture/runner.cjs'), 'utf8')).toContain('HONEST-RUNNER')
  const python = await runtime.run('command -v python3')
  expect(python.output).toContain(`${worktree}.tools/pyenv/bin/python3`)
  await runtime.stop()
  const gitView = await createEngineeringGitView(worktree)
  try {
    const gate = await sandboxedTests({
      ownerHome: homedir(), candidate: worktree, liveModules: join(worktree, 'node_modules'), modules: 'candidate',
      toolsDir: `${worktree}.tools`, hiddenPaths: engineeringHiddenPaths(worktree), gitView: gitView!,
      command: ['bash', '-c', 'npm test && command -v python3'],
    })
    expect(gate.ok, `${gate.sandboxError ?? ''}\n${gate.output}`).toBe(true)
    expect(gate.output).toContain('HONEST-RUNNER')
    expect(gate.output).toContain(`${worktree}.tools/pyenv/bin/python3`)
    expect(gate.output).not.toContain('SHADOW-')
  } finally { gitView?.stop() }
  rmSync(join(worktree, '.git'))
  runtime = await createEngineeringRuntime({ worktree })
  const withoutGit = await runtime.run('npm test && command -v python3')
  expect(withoutGit.ok, withoutGit.output).toBe(true)
  expect(withoutGit.output).toContain('HONEST-RUNNER')
  expect(withoutGit.output).toContain(`${worktree}.tools/pyenv/bin/python3`)
  expect(withoutGit.output).not.toContain('SHADOW-')
})
