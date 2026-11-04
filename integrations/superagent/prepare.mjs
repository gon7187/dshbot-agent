import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPSTREAM_REPOSITORY = 'https://github.com/deepseek-ai/dsh-superagent-prototype.git'
export const UPSTREAM_SHA = '6337fc823ce20251c8de8085948165c81aaa701e'
export const PNPM_VERSION = '11.7.0'
export const DSH_VERSION = '0.2.1-rc.3'
export const NODE_MAJOR = 24
export const RUNTIME_ADAPTATION = 'dsh-superagent-runtime-wrapper-v1'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '../..')
const OWNER_MARKER = '.dshbot-superagent-runtime'
const RECEIPT = 'receipt.json'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function requiredPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty path`)
  }
  return resolve(value)
}

function pathValue(args, index, flag) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a path`)
  return value
}

export function parseArgs(argv) {
  const options = { output: undefined, source: undefined, telegram: undefined, guard: undefined, pnpm: process.env.PNPM_BIN ?? 'pnpm', npm: process.env.NPM_BIN ?? 'npm' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)
    const value = inline ?? pathValue(argv, index, flag)
    if (inline === undefined && argument !== '--help' && argument !== '-h') index += 1
    if (flag === '--output' || flag === '--runtime-dir' || flag === '--dest') options.output = value
    else if (flag === '--source' || flag === '--upstream-source') options.source = value
    else if (flag === '--telegram' || flag === '--telegram-source') options.telegram = value
    else if (flag === '--guard' || flag === '--guard-source') options.guard = value
    else if (flag === '--pnpm') options.pnpm = value
    else if (flag === '--npm') options.npm = value
    else throw new Error(`unknown option ${argument}`)
  }
  if (options.output === undefined) throw new Error('--output is required')
  return {
    ...options,
    output: requiredPath(options.output, '--output'),
    source: options.source === undefined ? undefined : requiredPath(options.source, '--source'),
    telegram: options.telegram === undefined ? join(REPOSITORY_ROOT, 'integrations/superagent/telegram') : requiredPath(options.telegram, '--telegram'),
    guard: options.guard === undefined ? join(REPOSITORY_ROOT, 'packages/guard/src/index.ts') : requiredPath(options.guard, '--guard'),
  }
}

function run(command, args, { cwd, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
    throw new Error(`${command} ${args.join(' ')} failed with ${String(result.status)}${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout ?? ''
}

function assertNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isSafeInteger(major) || major < NODE_MAJOR) throw new Error(`Node ${NODE_MAJOR}+ is required; got ${process.version}`)
}

function assertDirectory(path, name) {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${name} is unavailable: ${errorMessage(error)}`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${name} must be a real directory`)
}

function assertFile(path, name) {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${name} is unavailable: ${errorMessage(error)}`) }
  if (!stat.isFile()) throw new Error(`${name} must be a regular file`)
}

function json(path, name) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { throw new Error(`${name} is not valid JSON: ${errorMessage(error)}`) }
}

function verifySource(source) {
  assertDirectory(source, 'upstream source')
  const root = run('git', ['-C', source, 'rev-parse', '--show-toplevel']).trim()
  if (resolve(root) !== resolve(source)) throw new Error('upstream source is not the requested Git worktree')
  const sha = run('git', ['-C', source, 'rev-parse', 'HEAD']).trim()
  if (sha !== UPSTREAM_SHA) throw new Error(`upstream source is ${sha}; expected ${UPSTREAM_SHA}`)
  if (run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=all']).trim() !== '') {
    throw new Error('upstream source has uncommitted or untracked files')
  }
  const manifest = json(join(source, 'package.json'), 'upstream package.json')
  const main = typeof manifest.main === 'string' ? manifest.main : 'lib/index.js'
  for (const path of [main, 'lib/client.js', 'LICENSE']) assertFile(join(source, path), `upstream ${path}`)
  return { source, manifest }
}

function verifyPnpm(pnpm) {
  const version = run(pnpm, ['--version']).trim()
  if (version !== PNPM_VERSION) throw new Error(`pnpm ${PNPM_VERSION} is required; got ${version || 'no version'}`)
}

function cloneAndBuild(stage, pnpm) {
  const source = join(stage, 'build', 'upstream')
  mkdirSync(join(stage, 'build'), { recursive: true })
  run('git', ['clone', '--no-checkout', UPSTREAM_REPOSITORY, source])
  run('git', ['-C', source, 'fetch', '--depth=1', 'origin', UPSTREAM_SHA])
  run('git', ['-C', source, 'checkout', '--detach', UPSTREAM_SHA])
  run(pnpm, ['install', '--frozen-lockfile'], { cwd: source })
  run(pnpm, ['run', 'check'], { cwd: source })
  return verifySource(source)
}

function packUpstream(source, stage, pnpm) {
  const packDirectory = join(stage, 'pack')
  const unpackDirectory = join(stage, 'unpack')
  mkdirSync(packDirectory)
  mkdirSync(unpackDirectory)
  run(pnpm, ['pack', '--pack-destination', packDirectory], { cwd: source })
  const archives = readdirSync(packDirectory).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error(`expected one upstream package archive, got ${archives.length}`)
  const archive = join(packDirectory, archives[0])
  run('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', unpackDirectory])
  const packageDirectory = join(unpackDirectory, 'package')
  assertDirectory(packageDirectory, 'packed upstream package')
  const destination = join(stage, 'upstream')
  renameSync(packageDirectory, destination)
  rmSync(packDirectory, { recursive: true, force: true })
  rmSync(unpackDirectory, { recursive: true, force: true })
  assertFile(join(destination, 'LICENSE'), 'packed upstream LICENSE')
  assertFile(join(destination, 'lib/index.js'), 'packed upstream lib/index.js')
  return destination
}

export function adaptUpstreamRuntime(upstream) {
  const lib = join(upstream, 'lib')
  const index = join(lib, 'index.js')
  const original = join(lib, 'runtime-original.js')
  assertFile(index, 'packed upstream lib/index.js')
  if (existsSync(original)) throw new Error('packed upstream already contains lib/runtime-original.js')
  renameSync(index, original)
  const sourceMap = join(lib, 'index.js.map')
  if (existsSync(sourceMap)) renameSync(sourceMap, join(lib, 'runtime-original.js.map'))
  writeFileSync(index, [
    '/* dshbot-superagent runtime adapter; upstream source remains at runtime-original.js. */',
    "import { apply as guardedApply, inject as guardedInject } from '../../telegram/runtime.mjs'",
    "export * from './runtime-original.js'",
    'export const inject = guardedInject',
    'export const apply = guardedApply',
    '',
  ].join('\n'), { mode: 0o444 })
  return { id: RUNTIME_ADAPTATION, files: ['upstream/lib/index.js', 'upstream/lib/runtime-original.js'] }
}

function copyTelegram(source, stage) {
  assertDirectory(source, 'Telegram plugin')
  assertFile(join(source, 'package.json'), 'Telegram plugin package.json')
  assertFile(join(source, 'index.mjs'), 'Telegram plugin index.mjs')
  const destination = join(stage, 'telegram')
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      const name = path.slice(source.length + 1)
      return name === '' || (!name.startsWith('.git') && !name.startsWith('node_modules') && !/(?:^|\.)test\.[cm]?[jt]s$/.test(name))
    },
  })
  assertFile(join(destination, 'github-cli.mjs'), 'Telegram GitHub CLI')
  assertFile(join(destination, 'delivery-cli.mjs'), 'Telegram delivery CLI')
  chmodSync(join(destination, 'github-cli.mjs'), 0o755)
  return destination
}

export function adaptTelegramRuntime(telegram) {
  const runtimePath = join(telegram, 'runtime.mjs')
  const patchPath = join(telegram, 'cordis.patch.yml')
  assertFile(runtimePath, 'Telegram runtime adapter')
  assertFile(patchPath, 'Telegram cordis patch')

  let runtime = readFileSync(runtimePath, 'utf8')
  const oldImport = "import * as upstream from '../upstream/lib/index.js'"
  const newImport = "import * as upstream from '../upstream/lib/runtime-original.js'"
  if (runtime.includes(oldImport)) runtime = runtime.replace(oldImport, newImport)
  if (!runtime.includes(newImport)) throw new Error('Telegram runtime adapter must import upstream/lib/runtime-original.js')
  writeFileSync(runtimePath, runtime)

  let patch = readFileSync(patchPath, 'utf8')
  const legacyOverride = [
    '    # Last-id-wins composition replaces the upstream Runtime implementation while preserving its id/config.',
    '    - id: dsh-superagent',
    '      name: dshbot-superagent-telegram/runtime',
  ].join('\n')
  if (patch.includes(legacyOverride)) patch = patch.replace(`${legacyOverride}\n`, '')
  if (patch.includes('name: dshbot-superagent-telegram/runtime')) {
    throw new Error('Telegram cordis patch still replaces the dsh-superagent entry')
  }
  writeFileSync(patchPath, patch)
  return {
    id: RUNTIME_ADAPTATION,
    files: [
      'upstream/lib/index.js',
      'upstream/lib/runtime-original.js',
      'telegram/runtime.mjs',
      'telegram/cordis.patch.yml',
    ],
  }
}

function copyGuard(source, stage) {
  assertFile(source, 'guard source')
  const destination = join(stage, 'guard.ts')
  cpSync(source, destination)
  if (!readFileSync(destination).equals(readFileSync(source))) throw new Error('guard.ts was not copied byte-for-byte')
  const explainSource = join(dirname(source), 'explain.ts')
  assertFile(explainSource, 'guard explanation source')
  cpSync(explainSource, join(stage, 'explain.ts'))
  writeFileSync(join(stage, 'explain.js'), "export * from './explain.ts'\n", { mode: 0o444 })
  writeFileSync(join(stage, 'index.js'), "export * from './guard.ts'\n", { mode: 0o444 })
  return destination
}

function copyBootstrap(stage) {
  const source = join(SCRIPT_DIR, 'bootstrap.mjs')
  assertFile(source, 'superagent bootstrap')
  const destination = join(stage, 'bootstrap.mjs')
  cpSync(source, destination)
  if (!readFileSync(destination).equals(readFileSync(source))) throw new Error('bootstrap.mjs was not copied byte-for-byte')
  return destination
}

function updateHash(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  hash.update(String(bytes.length))
  hash.update('\0')
  hash.update(bytes)
  hash.update('\0')
}

export function hashTree(root, excluded = new Set()) {
  assertDirectory(root, 'hash root')
  const hash = createHash('sha256')
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excluded.has(name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        updateHash(hash, `d:${name}`)
        visit(path, name)
      } else if (entry.isSymbolicLink()) {
        updateHash(hash, `l:${name}:${readlinkSync(path)}`)
      } else if (entry.isFile()) {
        updateHash(hash, `f:${name}`)
        updateHash(hash, readFileSync(path))
      } else throw new Error(`unsupported artifact entry ${name}`)
    }
  }
  visit(root, '')
  return hash.digest('hex')
}

function prepareOutput(output) {
  mkdirSync(dirname(output), { recursive: true })
  if (!existsSync(output)) return { replace: false }
  const stat = lstatSync(output)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output must be a real directory')
  const entries = readdirSync(output)
  if (entries.length === 0) return { replace: true }
  throw new Error('refusing non-empty output; use a new runtime directory')
}

function publish(stage, output, replace) {
  if (replace && existsSync(output)) {
    const stat = lstatSync(output)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('output changed during preparation')
    if (readdirSync(output).length > 0) throw new Error('output changed during preparation')
    rmdirSync(output)
  }
  renameSync(stage, output)
}

export function prepareRuntime(options) {
  assertNode()
  if (options === undefined || options === null || typeof options !== 'object') throw new Error('prepare options are required')
  const output = requiredPath(options.output, '--output')
  const telegram = requiredPath(options.telegram ?? join(REPOSITORY_ROOT, 'integrations/superagent/telegram'), '--telegram')
  const guard = requiredPath(options.guard ?? join(REPOSITORY_ROOT, 'packages/guard/src/index.ts'), '--guard')
  const sourceArgument = options.source === undefined ? undefined : requiredPath(options.source, '--source')
  const pnpm = options.pnpm ?? process.env.PNPM_BIN ?? 'pnpm'
  const npm = options.npm ?? process.env.NPM_BIN ?? 'npm'
  const { replace } = prepareOutput(output)
  const parent = dirname(output)
  const stage = mkdtempSync(join(parent, `.${output.slice(parent.length + 1)}.stage-`))
  writeFileSync(join(stage, OWNER_MARKER), 'dshbot-superagent-runtime\n', { mode: 0o600 })
  try {
    verifyPnpm(pnpm)
    const built = sourceArgument === undefined ? cloneAndBuild(stage, pnpm) : verifySource(sourceArgument)
    const upstream = packUpstream(built.source, stage, pnpm)
    const upstreamSourcePackageSha = hashTree(upstream)
    adaptUpstreamRuntime(upstream)
    const telegramOutput = copyTelegram(telegram, stage)
    const runtimeAdaptation = adaptTelegramRuntime(telegramOutput)
    copyGuard(guard, stage)
    copyBootstrap(stage)
    cpSync(join(SCRIPT_DIR, 'runtime/package.json'), join(stage, 'package.json'))
    cpSync(join(SCRIPT_DIR, 'runtime/package-lock.json'), join(stage, 'package-lock.json'))
    run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage })
    assertFile(join(stage, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'installed dsh CLI')
    const dsh = json(join(stage, 'node_modules/@deepseek-ai/dsh/package.json'), 'installed dsh package')
    if (dsh.version !== DSH_VERSION) throw new Error(`installed dsh is ${dsh.version}; expected ${DSH_VERSION}`)
    assertFile(join(stage, 'node_modules/pnpm/bin/pnpm.mjs'), 'installed pnpm CLI')
    const runtimePnpm = json(join(stage, 'node_modules/pnpm/package.json'), 'installed pnpm package')
    if (runtimePnpm.version !== PNPM_VERSION) throw new Error(`installed runtime pnpm is ${runtimePnpm.version}; expected ${PNPM_VERSION}`)
    const artifactSha = hashTree(stage, new Set([OWNER_MARKER, RECEIPT]))
    const receipt = {
      schema: 1,
      upstreamRepository: UPSTREAM_REPOSITORY,
      upstreamSha: UPSTREAM_SHA,
      upstreamPackageSha: hashTree(upstream),
      upstreamSourcePackageSha,
      runtimeAdaptation,
      artifactSha,
      dsh: DSH_VERSION,
      pnpm: PNPM_VERSION,
      node: process.version,
    }
    writeFileSync(join(stage, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o444 })
    publish(stage, output, replace)
    return receipt
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

const HELP = `Usage: node integrations/superagent/prepare.mjs --output DIR [options]

Options:
  --source DIR       Reuse a clean, exact-SHA upstream checkout with built lib/ files.
  --telegram DIR     Telegram plugin source (default: integrations/superagent/telegram).
  --guard FILE       Guard source (default: packages/guard/src/index.ts).
  --pnpm PATH        pnpm executable (must report ${PNPM_VERSION}).
  --npm PATH         npm executable used for local runtime dependencies.
`

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) process.stdout.write(HELP)
    else process.stdout.write(`${JSON.stringify(prepareRuntime(options), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`superagent runtime prepare: ${errorMessage(error)}\n`)
    process.exitCode = 1
  }
}
