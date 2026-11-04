// A task's engineering shell owns only its candidate and persistent task tools.
import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { RunnerTool } from '../../runner/src/index.js'
import { createExecTools, createTrustedNpmBin, ENGINEERING_GIT_DIRECTORY } from '../../tools-exec/src/index.js'

export interface EngineeringRuntime {
  tools: readonly RunnerTool[]
  run(command: string): Promise<{ ok: boolean; output: string }>
  stop(): Promise<void>
}

/** Paths a role must never read from its repository, regardless of letter case. */
export function isEngineeringPrivatePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const name = part.toLowerCase()
    return name === '.git' || name.startsWith('.env') ||
      ['.npmrc', '.netrc', '.pypirc', '.ssh', 'secret', 'secrets', '.secrets', 'credentials', '.credentials'].includes(name) ||
      ((name.includes('secret') || name.startsWith('credentials')) && /\.(?:jsonl?|ya?ml|toml|ini|conf|db|sqlite|txt|key|pem)$/.test(name))
  })
}

/** The repository's exact non-secret install policy may be read, never rewritten. */
export function isSafeEngineeringNpmrc(root: string): boolean {
  try {
    const path = join(root, '.npmrc')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 256) return false
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).map((line) => line.trim())
    return lines.length === 2 &&
      lines.filter((line) => /^ignore-scripts\s*=\s*true$/.test(line)).length === 1 &&
      lines.filter((line) => /^save-exact\s*=\s*true$/.test(line)).length === 1
  } catch { return false }
}

/** Hide repository credentials as well as the worktree's pointer to the owner's Git state. */
export function engineeringHiddenPaths(root: string): string[] {
  const hidden: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') continue
      if (directory === root && entry.name === '.npmrc' && isSafeEngineeringNpmrc(root)) continue
      if (isEngineeringPrivatePath(entry.name)) {
        hidden.push(path)
      } else if (entry.isDirectory()) pending.push(path)
    }
  }
  return hidden
}

/** A disposable repository containing only the candidate's accessible current files. */
export async function createEngineeringGitView(worktree: string): Promise<{
  directory: string; pointerFile: string; stop(): void
} | undefined> {
  const original = join(worktree, '.git')
  if (!existsSync(original)) return undefined
  if (!lstatSync(original).isFile()) throw new Error('engineering requires a regular worktree Git pointer')
  const root = mkdtempSync(join(tmpdir(), 'dshbot-engineering-git-'))
  const stop = (): void => rmSync(root, { recursive: true, force: true })
  const git = promisify(execFile)
  const env = {
    PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'core.attributesFile', GIT_CONFIG_VALUE_2: '/dev/null',
    GIT_AUTHOR_NAME: 'Engineering Sandbox', GIT_AUTHOR_EMAIL: 'sandbox@localhost',
    GIT_COMMITTER_NAME: 'Engineering Sandbox', GIT_COMMITTER_EMAIL: 'sandbox@localhost',
  }
  const run = (args: string[]) => git('git', args, { env, maxBuffer: 32 * 1024 * 1024 })
  try {
    const listed = await run(['-C', worktree, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    const paths = [...new Set(listed.stdout.split('\0').filter((path) => {
      if (path === '' || (isEngineeringPrivatePath(path) && !(path === '.npmrc' && isSafeEngineeringNpmrc(worktree))) ||
          path.split('/').includes('node_modules')) return false
      try { return !lstatSync(join(worktree, path)).isDirectory() } catch { return false }
    }))]
    const repo = join(root, 'snapshot')
    const template = join(root, 'empty-template')
    mkdirSync(template)
    await run(['init', '--template=' + template, '--initial-branch=engineering', repo])
    const directory = join(repo, '.git')
    const base = ['--git-dir=' + directory, '--work-tree=' + worktree]
    if (paths.length > 0) {
      const manifest = join(root, 'paths')
      writeFileSync(manifest, paths.join('\0') + '\0')
      await run([...base, '--literal-pathspecs', 'add', '-f', '--pathspec-from-file=' + manifest, '--pathspec-file-nul'])
    }
    await run([...base, 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'Engineering candidate snapshot'])
    const pointerFile = join(root, 'gitfile')
    writeFileSync(pointerFile, `gitdir: ${ENGINEERING_GIT_DIRECTORY}\n`, { mode: 0o400 })
    return { directory, pointerFile, stop }
  } catch (error) {
    stop()
    throw error
  }
}

export async function createEngineeringRuntime(options: { worktree: string; prepareDependencies?: boolean }): Promise<EngineeringRuntime> {
  const worktree = realpathSync(options.worktree)
  const gitView = await createEngineeringGitView(worktree)
  let trusted: ReturnType<typeof createTrustedNpmBin> | undefined
  let exec: Awaited<ReturnType<typeof createExecTools>>
  try {
    trusted = createTrustedNpmBin()
    exec = await createExecTools({
      workspace: worktree,
      home: homedir(),
      // Mount the exact Node install, never the owner's full mise or program tree.
      roPaths: [dirname(dirname(realpathSync(process.execPath))), trusted.bin],
      hidden: engineeringHiddenPaths(worktree).map((path) => ({ path })),
      ...(isSafeEngineeringNpmrc(worktree) ? { roots: [{ path: join(worktree, '.npmrc'), readOnly: true }] } : {}),
      ...(gitView === undefined ? {} : { gitView }),
      toolsDir: `${worktree}.tools`,
      approval: async () => 'allow',
      maxTimeoutMs: 10 * 60_000,
    })
  } catch (error) {
    trusted?.stop()
    gitView?.stop()
    throw error
  }
  const runtime: EngineeringRuntime = {
    tools: exec.tools,
    async run(command) {
      const trustedPath = `${trusted!.bin}:${trusted!.nodeBin}`.replaceAll("'", "'\\''")
      const result = await exec.runDirect(`export PATH='${trustedPath}':"$PATH"\n${command}`, {
        approval: async () => 'allow', timeoutSec: 600,
      })
      return {
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
        output: result.output.length > 24_000 ? `[output truncated]\n${result.output.slice(-24_000)}` : result.output,
      }
    },
    async stop() {
      try { await exec.stop() } finally { gitView?.stop(); trusted?.stop() }
    },
  }
  try {
    if (options.prepareDependencies !== false && (existsSync(join(worktree, 'package-lock.json')) || existsSync(join(worktree, 'npm-shrinkwrap.json'))) &&
        !existsSync(join(worktree, 'node_modules'))) {
      const installed = await runtime.run('npm ci')
      if (!installed.ok) throw new Error(`factory dependency installation failed:\n${installed.output}`)
    }
    return runtime
  } catch (error) {
    await runtime.stop()
    throw error
  }
}
