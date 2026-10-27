// The `exec` tool: the owner's shell commands behind a bwrap allowlist sandbox.
//
// The harness bash executor runs `bash -c` through `ctx.subprocess`; here the
// argv is wrapped in the project's own bwrap profile before it reaches that
// seam, and background work is registered in the harness `ctx.jobs` registry.
// The harness profile (`--ro-bind / /`) would expose the whole machine, so it
// is not used: the sandbox starts from an empty home, a private /tmp and a
// read-only system, then adds only the allowlisted toolchain directories
// (read-only) and the bot workspace (read-write).
//
// Nothing is executed when the sandbox cannot start: every run checks a probe
// of the exact profile, and a failed probe turns into a refusal. A successful
// probe stands for 60 seconds per profile, so ordinary commands do not pay a
// second bwrap start (and its event-loop block) each time; a command that fails
// drops the cached probe, so a sandbox that broke inside the window is reported
// by the next command instead of being trusted for the rest of the window.
//
// A background job keeps a ring of its output with absolute byte offsets. The
// registry (`ctx.jobs`) owns the id, the lifecycle and the exit code; the ring
// belongs here, because a page read has to be able to start at any position of
// the stream, not only at the model cursor, and the smallest useful window
// (1 MiB and more) is far above the registry's default retention. The job also
// owns its stdin pipe: `exec_write` sends one line into a live command.
//
// Network: the profile unshares the network namespace (`--unshare-net`), so a
// command has nothing but its own loopback and no direct TCP/UDP route to the
// host or the LAN. Its only way out is the daemon's HTTP/CONNECT proxy, reached
// through a unix socket bind-mounted into the sandbox and bridged to a loopback
// port by a tiny relay started next to the command. The proxy applies the same
// address rules as `web_fetch` and the browser: public addresses only, resolved
// once and connected by address, so a rebinding name cannot slip through.
// `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (and lowercase) point every ordinary
// client — curl, git, npm, pip, Chromium — at that proxy; `NO_PROXY` is empty.

import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Writable } from 'node:stream'

import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import JobsLocal from '@deepseek-ai/dsh-jobs-local'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'

import { frameData, sanitizeData } from '../../app/src/untrusted-frame.js'
import { checkCommand } from '../../guard/src/index.js'
import { resolvePublicTarget } from '../../guard/src/network.js'
import { startNetworkProxy, type NetworkProxy } from '../../guard/src/network-proxy.js'
import type { RunnerTool } from '../../runner/src/index.js'

/** Default toolchain directories visible read-only inside the sandbox. */
export const DEFAULT_RO_PATHS: readonly string[] = [
  '.local/share/mise',
  '.local/bin',
  '.cargo/bin',
  '.rustup',
]

/** Environment variable replacing {@link DEFAULT_RO_PATHS} (path-delimiter separated). */
export const RO_PATHS_ENV = 'DSHBOT_EXEC_RO_PATHS'

/** Foreground timeout used when the model gives none, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Hard cap on a foreground timeout, in milliseconds. */
export const MAX_TIMEOUT_MS = 600_000

/** Default cap on the tail returned by a status query, in characters. */
export const DEFAULT_TAIL_CHARS = 12_000

/** Page size of an offset read when the model gives no limit, in characters. */
export const DEFAULT_PAGE_CHARS = 12_000

/** Hard cap on one offset page, in characters. */
export const MAX_PAGE_CHARS = 200_000

/**
 * Output retained for one background job, in bytes. It is the ring's live and
 * settled cap: the newest output up to this size survives, older bytes are
 * dropped and reported through the offset they start at.
 */
export const OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024

/** Poll interval of the background output pump, in milliseconds. */
const OUTPUT_POLL_MS = 50

/** Poll interval of an `exec_status` wait, in milliseconds. */
const STATUS_WAIT_POLL_MS = 100

/** Upper bound of the `pattern` argument of `exec_status`, in characters. */
const MAX_WAIT_PATTERN_CHARS = 512

/** Grace period of the subprocess termination ladder, in milliseconds. */
const TERMINATE_GRACE_MS = 3_000

/** Loopback port of the per-command relay inside the sandbox network namespace. */
const RELAY_PORT = 3128

/** File name of the relay program inside the private network directory. */
const RELAY_FILE = 'relay.mjs'

/** File name of the daemon proxy socket inside the private network directory. */
const PROXY_SOCKET = 'proxy.sock'

/** Upper bound of one proxy request; a hung destination must not pin a socket. */
const PROXY_TIMEOUT_MS = 120_000

/**
 * Relay inside the sandbox: accepts the clients' HTTP proxy traffic on loopback
 * and pipes the bytes to the daemon's proxy over a unix socket. It understands
 * no protocol and makes no policy decision — the daemon proxy checks every
 * destination.
 */
const RELAY_SOURCE = `import net from 'node:net'
const [socket, portText] = process.argv.slice(2)
const port = Number(portText)
const server = net.createServer((client) => {
  const upstream = net.connect(socket)
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
})
server.on('error', () => process.exit(1))
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

/**
 * Shell wrapper of every sandboxed command: start the relay, wait until it
 * listens, run the command, stop the relay. The command itself arrives as `$1`,
 * so its quoting is untouched, and the helper variables are removed from the
 * environment the command sees.
 */
const RELAY_WRAPPER = `relay_script=$DSHBOT_EXEC_NET_RELAY
socket=$DSHBOT_EXEC_NET_SOCKET
node_bin=$DSHBOT_EXEC_NET_NODE
command=$1
unset DSHBOT_EXEC_NET_RELAY DSHBOT_EXEC_NET_SOCKET DSHBOT_EXEC_NET_NODE
if [ -z "$command" ]; then echo "exec: пустая команда" >&2; exit 2; fi
"$node_bin" "$relay_script" "$socket" ${RELAY_PORT} >/dev/null 2>&1 &
relay=$!
tries=0
while ! (exec 3<>/dev/tcp/127.0.0.1/${RELAY_PORT}) 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 100 ]; then
    echo "exec: прокси песочницы не поднялся за 5 с" >&2
    kill "$relay" 2>/dev/null
    exit 1
  fi
  sleep 0.05
done
bash -c "$command"
status=$?
kill "$relay" 2>/dev/null
exit "$status"
`

/** System trees a command needs; they are mounted read-only, never the whole root. */
const SYSTEM_READ_ONLY = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc', '/opt', '/nix'] as const

/** Parent variables that are safe and useful for a child command. */
const INHERITED_ENV = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'NO_COLOR',
  'PAGER',
  'GIT_PAGER',
  'FORCE_COLOR',
  'TZ',
])

/** Result of asking the owner to approve one command. */
export type ExecApprovalDecision = 'allow' | 'deny' | 'expired' | 'unavailable' | 'purpose'

export interface ExecApprovalRequest {
  /** What the model is trying to run, ready for the approval card. */
  command: string
  /** Why the guard wants a confirmation. */
  reason: string
  /** Why the model runs the command, in its own words; the card shows it in a signed block. */
  purpose?: string
  /**
   * The caller has a `purpose` parameter of its own (`exec`, `host_exec`): a
   * card cannot be drawn without one. Validation stays in the app, after the
   * stored permission and the automatic paths that need no card.
   */
  purposeRequired?: boolean
}

/** Asks the owner; resolves `unavailable` when there is nobody to ask. */
export type ExecApproval = (request: ExecApprovalRequest) => Promise<ExecApprovalDecision>

/** One secret the daemon holds; `exec` passes it to a command by name only. */
export interface ExecSecretEntry {
  readonly name: string
  readonly value: string
}

/**
 * The vault of the owner as `exec` needs it: a command asks for names, gets
 * their values as environment variables, and every output is scrubbed with the
 * whole history (a deleted or replaced value stays out of a live job's ring).
 */
export interface ExecSecretSource {
  get(name: string): string | undefined
  names(): string[]
  known(): readonly ExecSecretEntry[]
}

export interface ExecToolOptions {
  /** Working directory and the only writable tree, normally `DSHBOT_HOME/workspace`. */
  workspace: string
  /** Home directory of the daemon; its inside view is an empty tmpfs. */
  home?: string
  /** Toolchain paths exposed read-only; defaults to {@link DEFAULT_RO_PATHS} under home. */
  roPaths?: readonly string[]
  /** Extra roots of the owner with their permission; `workspace` is always mounted read-write. */
  roots?: readonly ExecRoot[]
  /** Paths hidden even inside a mounted root (keys of the owner and the private state of the bot). */
  hidden?: readonly ExecHiddenPath[]
  /** Owner approval for `confirm` commands; absent means every confirm is refused. */
  approval?: ExecApproval
  /** Default foreground timeout in milliseconds; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Upper bound of a foreground timeout in milliseconds; defaults to {@link MAX_TIMEOUT_MS}. */
  maxTimeoutMs?: number
  /** Vault of the owner; `exec` sees names and never keeps a value in its text. */
  secrets?: ExecSecretSource
  /**
   * Guest mode: an empty disposable sandbox per call. Nothing of the owner is
   * mounted, the guard allows a `confirm` command without a card, and the
   * limits are fixed by the guest policy rather than by the caller.
   */
  guest?: boolean
  /**
   * Directories and files of the owner that must stay hidden in guest mode,
   * even when a read-only system bind (for example `/usr`) contains them.
   */
  guestMasks?: readonly string[]
  /**
   * Node binary the daemon runs on, `process.execPath` by default. A guest
   * runtime runs its relay on it only outside the owner's directories and
   * otherwise picks another Node, see {@link guestNodeBinary}.
   */
  daemonNode?: string
}

/** One extra directory of the owner inside the sandbox. */
export interface ExecRoot {
  readonly path: string
  readonly readOnly?: boolean
}

/** A path the sandbox never exposes, with the descendants that stay visible (`allow`). */
export interface ExecHiddenPath {
  readonly path: string
  readonly allow?: readonly string[]
}

/** Result of one command the owner typed directly (`!command`). */
export interface DirectExecResult {
  /** Exit code of the command; null when it was killed by a signal. */
  exitCode: number | null
  /** Terminating signal name, when the command was killed by one. */
  signal: string | null
  /** True when the foreground timeout fired and the command was killed. */
  timedOut: boolean
  /** True when the caller's signal (a `/stop`) aborted the command. */
  aborted: boolean
  /** stdout, and stderr under its own header; the same shape the `exec` tool returns. */
  output: string
}

/** Options of one direct owner command; the approval card is mandatory. */
export interface DirectExecOptions {
  /** Owner approval for `confirm` commands: the same card the model gets. */
  approval: ExecApproval
  /** Aborts the sandboxed command, exactly like `/stop` aborts a model tool. */
  signal?: AbortSignal
  /** Timeout in seconds; absent means the default of 120 s, capped by the maximum. */
  timeoutSec?: number
}

/** The exec capability: model tools plus a teardown hook. */
export interface ExecTools {
  /** `exec`, `exec_status`, `exec_stop`, `exec_write` and `exec_list`, ready for the runner tool seam. */
  tools: readonly RunnerTool[]
  /**
   * Programmatic access to background jobs, used by the stream watcher of the
   * schedule: it starts a long command, reads its output by byte offset and
   * stops it, without going through the model-facing tool texts.
   */
  background?: ExecBackground
  /**
   * Run one command the owner typed as `!command`. It goes through the same
   * sandbox, environment and guard as the model's `exec`; no job is registered
   * and nothing is written to any session.
   */
  runDirect(command: string, options: DirectExecOptions): Promise<DirectExecResult>
  /** Kills live jobs, terminates sandboxed processes and disposes the harness context. */
  stop(): Promise<void>
}

/** Lifecycle of a background job as the watcher sees it. */
export interface ExecBackgroundStatus {
  status: JobStatus
  detail?: string
}

/** One page of the output ring of a background job. */
export interface ExecBackgroundRead {
  text: string
  /** Offset of the first returned byte: above the requested one when the head was dropped. */
  start: number
  /** Offset for the next read. */
  next: number
  earliest: number
  total: number
  /** True when the requested offset was already dropped. */
  lossy: boolean
}

/** Programmatic background jobs behind the same sandbox as the `exec` tool. */
export interface ExecBackground {
  /** Start `command` in the sandbox and return the job id at once. */
  start(command: string): string
  status(id: string): ExecBackgroundStatus | undefined
  /** Read at most `limit` characters starting at byte offset `offset`. */
  read(id: string, offset: number, limit?: number): ExecBackgroundRead | undefined
  /** Kill the process and its children; no-op for a job that already ended. */
  stop(id: string, reason?: string): void
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith(`~${sep}`) || path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** Parse `DSHBOT_EXEC_RO_PATHS`, falling back to the toolchain defaults. */
function readRoPaths(home: string, override?: readonly string[]): string[] {
  const raw = override === undefined ? process.env[RO_PATHS_ENV] : undefined
  const values =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_RO_PATHS.map((path) => join(home, path))
      : raw
          .split(delimiter)
          .map((path) => path.trim())
          .filter((path) => path !== '')
          .map((path) => resolve(expandHome(path, home)))
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** True for the `.../mise/shims` directories of a mise-managed host. */
function isMiseShims(entry: string): boolean {
  return /(^|\/)mise\/shims\/?$/.test(entry)
}

/**
 * The PATH of the sandbox: the directory of the daemon node first, then the
 * parent PATH without the mise shims.
 *
 * The daemon is usually started through a mise shim, but inside the sandbox
 * HOME is an empty tmpfs: mise finds no config and cannot resolve a version, so
 * the shims are dead weight that shadow the real binary. The node directory
 * itself is mounted read-only with the toolchain.
 */
function sandboxPath(parentPath: string): string {
  const inherited = parentPath.split(delimiter).filter((entry) => entry !== '' && !isMiseShims(entry))
  return [...new Set([dirname(process.execPath), ...inherited])].join(delimiter)
}

/** A parsed list of explicit parent variables replaced by tombstones for the child. */
function childEnvironment(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: sandboxPath(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'),
    HOME: home,
    TMPDIR: '/tmp',
    TERM: 'dumb',
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
  }
  for (const name of INHERITED_ENV) {
    if (name in env) continue
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  // Everything else is explicitly removed, including keys, tokens, DSH_* facts
  // and arbitrary parent variables the toolchain does not need.
  for (const name of Object.keys(process.env)) {
    if (!(name in env)) env[name] = undefined
  }
  return env
}

/** True when `path` is inside (or equal to) `root`. */
function isWithin(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/** Real path of the node binary that runs the daemon, or the path node reports. */
function nodeBinaryPath(): string {
  try {
    return realpathSync(process.execPath)
  } catch {
    return process.execPath
  }
}

/** Where a system Node usually lives, after the daemon's own node and PATH. */
const SYSTEM_NODE_CANDIDATES = ['/usr/local/bin/node', '/usr/bin/node', '/bin/node'] as const

/**
 * The Node that runs the relay of a guest sandbox: the daemon's own node when
 * it lies outside every owner root, otherwise the first `node` on PATH or in
 * the system locations that does. A mise or nvm install under HOME never
 * qualifies: the guest namespace masks HOME, so a relay started from there
 * would not exist. The real path is returned, because that is what the guest
 * profile mounts; undefined when the host has no such Node.
 */
export function guestNodeBinary(
  ownerRoots: readonly string[],
  daemonNode: string = process.execPath,
  parentPath: string = process.env.PATH ?? '',
): string | undefined {
  const fromPath = parentPath
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry) && !isMiseShims(entry))
    .map((entry) => join(entry, 'node'))
  for (const candidate of [daemonNode, ...fromPath, ...SYSTEM_NODE_CANDIDATES]) {
    const path = resolve(candidate)
    let real: string
    try {
      real = realpathSync(path)
      if (!statSync(real).isFile()) continue
      accessSync(real, fsConstants.X_OK)
    } catch {
      continue
    }
    if (ownerRoots.some((root) => isWithin(path, root) || isWithin(real, root))) continue
    return real
  }
  return undefined
}

/**
 * Private directory for the relay and the proxy socket. A unix socket path is
 * limited to about 107 bytes, so a long TMPDIR falls back to /tmp.
 */
function makeNetworkDir(): string {
  let lastError: unknown
  for (const base of new Set([tmpdir(), '/tmp'])) {
    try {
      const dir = mkdtempSync(join(base, 'dshbot-net-'))
      if (Buffer.byteLength(join(dir, PROXY_SOCKET)) <= 100) return dir
      rmSync(dir, { recursive: true, force: true })
      lastError = new Error(`путь unix-сокета слишком длинный: ${join(dir, PROXY_SOCKET)}`)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`не удалось создать каталог сети песочницы: ${errorText(lastError)}`)
}

/** The program of the exec sandbox profile, for diagnostics that look it up on PATH. */
export const SANDBOX_PROGRAM = 'bwrap'

/**
 * The subprocess runner is a Node process that execs the sandbox, and Node
 * ignores SIGPIPE and SIGXFSZ: the exec keeps them ignored, so `yes | head`
 * reports a broken pipe and a writer that never checks for write errors
 * outlives its reader. env resets every signal to its default first.
 *
 * The runner also reads process.stderr while loading, which makes its stderr
 * socket non-blocking, and the exec keeps that too: a command that writes
 * stderr faster than the bot reads gets EAGAIN. perl clears O_NONBLOCK on
 * 0-2 (Linux F_GETFL 3, F_SETFL 4, O_NONBLOCK 04000) and execs the rest.
 */
// ponytail: without /usr/bin/perl stderr stays non-blocking; it ships with every Debian and Ubuntu (perl-base).
const CLEAN_START = [
  ...(existsSync('/usr/bin/perl')
    ? ['/usr/bin/perl', '-e', 'for (*STDIN, *STDOUT, *STDERR) { my $f = fcntl($_, 3, 0); fcntl($_, 4, $f & ~04000) if $f } exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\\n"']
    : []),
  '/usr/bin/env',
  '--default-signal',
]

/** What one run of `program --version` (or similar) answered. */
export interface VersionProbeResult {
  /** Set when the program did not start or was killed by the timeout. */
  error?: Error
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

const VERSION_PROBE_OUTPUT_CHARS = 16_000

/**
 * Run an installed program once to read its version: no shell, no stdin, only
 * PATH, HOME and LANG from the environment (no secrets), bounded output and a
 * hard timeout. Asynchronous, so a hanging binary never blocks the event loop.
 */
export function probeProgramVersion(
  path: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<VersionProbeResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let error: Error | undefined
    let settled = false
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ...(error === undefined ? {} : { error }), status, signal, stdout, stderr })
    }
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(path, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught))
      resolvePromise({ error, status: null, signal: null, stdout, stderr })
      return
    }
    const timer = setTimeout(() => {
      error = new Error(`не ответил за ${timeoutMs} мс`)
      child.kill('SIGKILL')
    }, Math.max(1, timeoutMs))
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < VERSION_PROBE_OUTPUT_CHARS) stdout += chunk.slice(0, VERSION_PROBE_OUTPUT_CHARS - stdout.length)
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < VERSION_PROBE_OUTPUT_CHARS) stderr += chunk.slice(0, VERSION_PROBE_OUTPUT_CHARS - stderr.length)
    })
    child.on('error', (caught) => {
      error ??= caught
      finish(null, null)
    })
    child.on('close', (status, signal) => finish(status, signal))
  })
}

/**
 * The bwrap profile: empty home, private /tmp, read-only system, allowlisted
 * toolchains read-only, workspace read-write, new PID and network namespaces.
 * The network namespace has its own loopback only; the proxy socket directory is
 * bind-mounted in, and that unix socket is the sandbox's only way out. The
 * trailing `--` separates the profile from the command argv.
 */
export function sandboxProfile(options: {
  home: string
  workspace: string
  roPaths: readonly string[]
  /** Private directory with the relay script and the proxy unix socket, bind-mounted in. */
  networkDir?: string
  /** Extra roots of the owner; their permission is preserved. */
  roots?: readonly ExecRoot[]
  /** Paths never exposed, even inside a mounted root. */
  hidden?: readonly ExecHiddenPath[]
}): string[] {
  const home = resolve(options.home)
  const workspace = resolve(options.workspace)
  const extraRoots = (options.roots ?? []).map((root) => ({
    path: resolve(root.path),
    readOnly: root.readOnly === true,
  }))
  const hidden = (options.hidden ?? []).map((entry) => ({
    path: resolve(entry.path),
    allow: (entry.allow ?? []).map((allowed) => resolve(allowed)),
  }))

  /** A hidden path that is itself inside a mounted tree, unless an allowed root covers it. */
  function hiddenAt(path: string): boolean {
    return hidden.some(
      (entry) => isWithin(path, entry.path) && !entry.allow.some((allowed) => isWithin(path, allowed)),
    )
  }

  /** Permission of a path from the declared roots; the longest match wins, ro by default. */
  function readOnlyOf(path: string): boolean {
    let found: { path: string; readOnly: boolean } | undefined
    for (const root of [{ path: workspace, readOnly: false }, ...extraRoots]) {
      if (!isWithin(path, root.path)) continue
      if (found === undefined || root.path.length > found.path.length) found = root
    }
    return found?.readOnly !== false
  }

  const args: string[] = ['bwrap']

  // As uid 0 (the fake root of container mode, scripts/dshbot-run.sh) bwrap
  // neither creates a user namespace by itself nor drops the caller's
  // capabilities; the container keeps no CAP_SYS_ADMIN for the namespaces, so
  // ask for both explicitly. An ordinary user gets the same profile implicitly.
  if (process.getuid?.() === 0) args.push('--unshare-user', '--cap-drop', 'ALL')
  if (home === sep) args.push('--tmpfs', sep)
  args.push('--unshare-pid', '--unshare-net', '--die-with-parent', '--dev', '/dev', '--proc', '/proc')
  if (home !== sep) args.push('--tmpfs', home)
  args.push('--tmpfs', '/tmp')
  if (options.networkDir !== undefined) {
    const networkDir = resolve(options.networkDir)
    // Read-only: the sandbox may connect to the socket but must not replace the
    // relay program or the socket inode.
    args.push('--ro-bind', networkDir, networkDir)
  }

  for (const path of SYSTEM_READ_ONLY) {
    if (existsSync(path)) args.push('--ro-bind', path, path)
  }

  for (const roPath of options.roPaths) {
    if (!existsSync(roPath)) continue
    // The workspace is mounted read-write below; never shadow it with a read-only bind.
    if (isWithin(workspace, roPath)) continue
    const target = isAbsolute(roPath) ? roPath : resolve(roPath)
    args.push('--ro-bind', target, target)
  }

  // The relay that bridges the sandbox to the proxy runs on the daemon's node.
  // When the daemon HOME is not the owner's (tests, a service account), that
  // binary is not under an allowlisted tree; mount the single executable.
  const nodeBinary = nodeBinaryPath()
  const nodeCovered = [...SYSTEM_READ_ONLY, ...options.roPaths].some((root) => isWithin(nodeBinary, root))
  if (!nodeCovered && existsSync(nodeBinary)) args.push('--ro-bind', nodeBinary, nodeBinary)

  // The workspace and the owner's extra roots form one layered tree, mounted
  // from the outside in: a nested root is mounted after its parent, so every
  // path gets the permission of its longest matching root, as in the file
  // tools. A hidden tree inside a mounted root is covered with an empty tmpfs
  // at its own depth, after every bind that could reveal it; only the default
  // roots allowed inside DSHBOT_HOME (and roots nested in them) are mounted
  // again below it. Sources stay readable to bwrap despite the overlay.
  type Layer = { readonly path: string; readonly mount: '--bind' | '--ro-bind' | '--tmpfs' | '--dev' | '--proc' }
  const binds: Layer[] = []
  const bound = new Set<string>()
  const addBind = (path: string, readOnly: boolean): void => {
    if (bound.has(path) || !existsSync(path)) return
    // A path that is itself hidden (a key directory, the private state of the
    // bot) is not exposed, even when the owner declared it as a root.
    if (hiddenAt(path)) return
    bound.add(path)
    binds.push({ path, mount: readOnly ? '--ro-bind' : '--bind' })
  }
  // The workspace is always mounted read-write, as the working directory.
  bound.add(workspace)
  binds.push({ path: workspace, mount: '--bind' })
  for (const root of extraRoots) addBind(root.path, root.readOnly)

  const masks: Array<{ path: string; mount: '--tmpfs' | '--empty-file' }> = []
  for (const entry of hidden) {
    if (!existsSync(entry.path)) continue
    if (!binds.some((bind) => isWithin(entry.path, bind.path))) continue
    if (masks.some((mask) => mask.path === entry.path)) continue
    // A hidden directory is replaced with an empty tmpfs; a single credential
    // file (`~/.netrc`, `~/.npmrc`) cannot carry a tmpfs, so an unreadable
    // device node is mounted over it: reads and writes fail closed and the file
    // on disk never changes.
    let isDirectory = false
    try {
      isDirectory = statSync(entry.path).isDirectory()
    } catch {
      continue
    }
    masks.push({ path: entry.path, mount: isDirectory ? '--tmpfs' : '--empty-file' })
    for (const allowed of entry.allow) {
      if (isWithin(allowed, entry.path) && allowed !== entry.path) addBind(allowed, readOnlyOf(allowed))
    }
  }

  // A broad root (`/`) would cover the private /dev and /proc and the relay
  // directory mounted above; they are mounted again over it at their depth.
  const sandboxOwn: Layer[] = [
    { path: '/dev', mount: '--dev' } as const,
    { path: '/proc', mount: '--proc' } as const,
    ...(options.networkDir === undefined ? [] : [{ path: resolve(options.networkDir), mount: '--ro-bind' } as const]),
  ].filter((layer) => binds.some((bind) => isWithin(layer.path, bind.path)))

  // Directories bwrap would create between the empty tmpfs HOME and a bound
  // tree are writable by the command, so a command could leave a file next to
  // the workspace instead of inside it. Pre-create the mount points and make
  // every intermediate directory read-only; the bind target itself keeps the
  // permission of its host directory (the workspace stays writable).
  const alreadyMounted = new Set<string>([
    ...options.roPaths.map((path) => resolve(path)),
    ...SYSTEM_READ_ONLY.filter((path) => existsSync(path)),
    ...(options.networkDir === undefined ? [] : [resolve(options.networkDir)]),
    ...(!nodeCovered && existsSync(nodeBinary) ? [resolve(nodeBinary)] : []),
  ])
  const bindTargets = new Set(binds.map((bind) => bind.path))
  const homeDirs = new Set<string>()
  if (home !== sep) {
    for (const bind of binds) {
      if (!isWithin(bind.path, home) || bind.path === home) continue
      let current = bind.path
      while (current !== home) {
        const parent = dirname(current)
        if (parent === current) break
        homeDirs.add(parent)
        current = parent
      }
      try {
        if (statSync(bind.path).isDirectory()) homeDirs.add(bind.path)
      } catch {
        // A target that does not exist cannot be bound anyway.
      }
    }
  }
  const preparedHomeDirs = [...homeDirs]
    .filter((path) => !alreadyMounted.has(path))
    .sort((left, right) => left.length - right.length)
  for (const path of preparedHomeDirs) args.push('--dir', path)
  for (const path of preparedHomeDirs) {
    if (bindTargets.has(path)) continue
    args.push('--chmod', '0555', path)
  }

  // Stable by depth: a parent precedes its descendants, a bind and a mask never
  // share a path (a hidden path is never bound).
  const layers: Array<{ path: string; mount: string }> = [...binds, ...sandboxOwn, ...masks]
  layers.sort((left, right) => left.path.length - right.path.length)
  for (const layer of layers) {
    if (layer.mount === '--bind' || layer.mount === '--ro-bind') args.push(layer.mount, layer.path, layer.path)
    else if (layer.mount === '--empty-file') args.push('--ro-bind', '/dev/null', layer.path)
    else args.push(layer.mount, layer.path)
  }

  args.push('--chdir', workspace, '--')
  return args
}

/** How long a successful probe of one profile stands for later commands, in milliseconds. */
export const SANDBOX_PROBE_TTL_MS = 60_000

/** Size of every writable tmpfs of a guest sandbox, in bytes (64 MiB). */
export const GUEST_DISK_BYTES = 64 * 1024 * 1024

/**
 * Memory limit of one guest command, in bytes (1 GiB). It is an `RLIMIT_DATA`
 * cap, so it bounds the memory the command actually allocates (the data segment
 * and private anonymous mappings) without capping address space: Node reserves
 * a large virtual range for its V8 code range and dies at startup under an
 * `RLIMIT_AS` cap, while an allocation past this data limit fails with an
 * ordinary out-of-memory error.
 */
export const GUEST_MEMORY_BYTES = 1024 * 1024 * 1024

/** Hard cap of one guest command, in milliseconds (60 s). */
export const GUEST_MAX_TIMEOUT_MS = 60_000

/** Largest command output handed to the model in guest mode, in characters. */
export const GUEST_MAX_OUTPUT_CHARS = 20_000

/**
 * Model-facing definition of `exec` for a guest turn. It deliberately names no
 * vault entry, owner toolchain path or state directory: the shared registry
 * definition describes those for the owner, and a guest scope shadows it with
 * this one. The caps below are the fixed guest policy, not caller options.
 */
export const GUEST_EXEC_DEFINITION: {
  readonly description: string
  readonly inputSchema: Record<string, unknown>
} = {
  description:
    'Run a shell command in a disposable, empty sandbox. The call starts from a fresh working ' +
    'directory that disappears when the command ends; nothing of the owner is mounted. The sandbox ' +
    'has no direct route out: public internet is reached through the daemon proxy (http_proxy, ' +
    'https_proxy and all_proxy), which refuses loopback, private, link-local and cloud metadata ' +
    'addresses. One command runs for at most 60 seconds, can write at most 64 MiB in total and ' +
    'uses at most 1 GiB of memory; the whole answer is capped at 20000 characters. There are no ' +
    'approval cards, no background jobs and no secrets: a command that is denied by the guard is ' +
    'refused instead.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command line to run with bash -c.' },
      timeout_sec: {
        type: 'number',
        description: 'Requested timeout in seconds; capped at 60 for a guest command.',
      },
    },
    required: ['command'],
  },
}

/**
 * The bwrap profile of a guest command: an empty, disposable root with no bind
 * of the owner's machine. Every writable place (the working directory, HOME,
 * /tmp and /dev/shm) is a tmpfs of at most {@link GUEST_DISK_BYTES}, so nothing
 * a guest writes survives the call and no writable place can grow past the
 * disk budget; the root, /dev and the masks of owner paths are read-only.
 * Read-only system trees are
 * mounted without the owner's directories; a system path that is a symlink on
 * the host (the merged-usr `/lib`, `/bin`, ... spellings) is recreated with
 * `--symlink`, so a mask under the real path hides the alias too.
 */
export function guestSandboxProfile(options: {
  networkDir?: string
  masks?: readonly string[]
  roPaths?: readonly string[]
  /** Owner directories whose paths are never mounted, even as a toolchain roPath. */
  ownerRoots?: readonly string[]
  /** Node of the relay (see {@link guestNodeBinary}); the daemon's node by default. */
  node?: string
}): string[] {
  const args: string[] = ['bwrap']
  const ownerRoots = (options.ownerRoots ?? []).map((path) => {
    const resolved = resolve(path)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  })
  const ownerPath = (path: string): boolean => ownerRoots.some((root) => isWithin(path, root))
  if (process.getuid?.() === 0) args.push('--unshare-user', '--cap-drop', 'ALL')
  args.push('--unshare-pid', '--unshare-net', '--die-with-parent', '--dev', '/dev', '--proc', '/proc')
  for (const path of SYSTEM_READ_ONLY) {
    if (!existsSync(path)) continue
    let link: string | undefined
    try {
      if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path)
    } catch {
      continue
    }
    if (link !== undefined) {
      args.push('--symlink', link, path)
    } else {
      args.push('--ro-bind', path, path)
    }
  }
  // The toolchain of the host stays available read-only, exactly as in the
  // owner's profile: a guest command may use node, git or curl, but nothing of
  // the owner's home or state directory is mounted.
  const roPathEntries = (options.roPaths ?? []).map((path) => {
    const resolved = resolve(path)
    try {
      return { path: resolved, real: realpathSync(resolved) }
    } catch {
      return { path: resolved, real: resolved }
    }
  })
  const roPaths = roPathEntries
    .filter((entry) => !ownerPath(entry.path) && !ownerPath(entry.real))
    .map((entry) => entry.path)
  for (const roPath of roPaths) {
    if (!existsSync(roPath)) continue
    args.push('--ro-bind', roPath, roPath)
  }
  const nodeBinary = options.node ?? nodeBinaryPath()
  const nodeCovered = [...SYSTEM_READ_ONLY, ...roPaths].some((root) => isWithin(nodeBinary, root))
  if (!nodeCovered && !ownerPath(nodeBinary) && existsSync(nodeBinary)) {
    args.push('--ro-bind', nodeBinary, nodeBinary)
  }
  // Every writable place is a bounded tmpfs: the working directory, HOME,
  // /tmp and /dev/shm. A mask of an owner path below is bounded the same way.
  const writable: Array<{ path: string; mask: boolean }> = [
    { path: '/work', mask: false },
    { path: '/home/guest', mask: false },
    { path: '/tmp', mask: false },
    { path: '/dev/shm', mask: false },
  ]
  const masks = new Set<string>()
  for (const raw of [...(options.masks ?? []), ...ownerRoots]) {
    let real = resolve(raw)
    try {
      real = realpathSync(real)
    } catch {
      // A missing path cannot be mounted over.
    }
    // The owner's own roots are always covered, even when no system bind can
    // reveal them: a mask only hides, so the cost of the guarantee is zero.
    const ownerMask = ownerPath(real)
    if (!ownerMask) {
      // Only a path a read-only system bind (directly or through a symlink) can
      // reveal needs a mask; anything else is absent from this namespace.
      const visible = SYSTEM_READ_ONLY.some((root) => isWithin(real, root))
      if (!visible) continue
    }
    if (real === '/' || SYSTEM_READ_ONLY.some((root) => isWithin(root, real))) continue
    masks.add(real)
  }
  for (const path of [...masks].sort((left, right) => left.length - right.length)) {
    let isDirectory = false
    try {
      isDirectory = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) writable.push({ path, mask: true })
    else args.push('--ro-bind', '/dev/null', path)
  }
  // /dev is mounted above, so /dev/shm already exists; order keeps the tmpfs
  // after the --dev mount.
  const ordered = writable.filter((entry) => entry.path !== '/dev/shm')
  ordered.push(...writable.filter((entry) => entry.path === '/dev/shm'))
  for (const entry of ordered) args.push('--size', String(GUEST_DISK_BYTES), '--tmpfs', entry.path)
  // The relay lives under the host tmpdir, which the bounded /tmp above would
  // otherwise shadow. The bind comes last, read-only, inside the fresh /tmp.
  if (options.networkDir !== undefined) {
    const networkDir = resolve(options.networkDir)
    args.push('--ro-bind', networkDir, networkDir)
  }
  // The root of the namespace and the tmpfs of `--dev` are unbounded tmpfs
  // mounts of bwrap itself, and a mask only hides: all of them become
  // read-only once every mount point exists. The remount is not recursive, so
  // the bounded tmpfs above stay writable and the device nodes keep working.
  for (const entry of ordered) if (entry.mask) args.push('--remount-ro', entry.path)
  args.push('--remount-ro', '/dev', '--remount-ro', '/')
  args.push('--chdir', '/work', '--')
  return args
}

/**
 * Successful probes of sandbox profiles, keyed by the exact profile argv. One
 * cache per exec capability: a profile of another workspace (or another set of
 * roots) has its own entry and is never covered by a foreign probe.
 */
export type SandboxProbeCache = Map<string, number>

/** The identity of a profile in the probe cache: its exact argv. */
function profileKey(profile: readonly string[]): string {
  return profile.join('\0')
}

/** Drop the remembered success of this profile, so the next command probes again. */
function invalidateSandboxProbe(profile: readonly string[], cache: SandboxProbeCache): void {
  cache.delete(profileKey(profile))
}

/**
 * Run the exact profile with a trivial command unless a success within
 * {@link SANDBOX_PROBE_TTL_MS} is remembered; fail closed when it does not
 * start. A failure is never remembered, so the next command tries again.
 */
function probeSandbox(profile: readonly string[], cache: SandboxProbeCache): void {
  const key = profileKey(profile)
  const probedAt = cache.get(key)
  if (probedAt !== undefined) {
    const age = Date.now() - probedAt
    // A clock that went backwards is not evidence that the sandbox still works.
    if (age >= 0 && age < SANDBOX_PROBE_TTL_MS) return
    cache.delete(key)
  }
  const probe = spawnSync(profile[0] as string, [...profile.slice(1), '/bin/true'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
  })
  if (probe.error !== undefined) {
    cache.delete(key)
    throw new Error(`песочница bwrap не запускается, команда отклонена: ${probe.error.message}`)
  }
  if (probe.status !== 0) {
    cache.delete(key)
    const stderr = (probe.stderr ?? '').trim()
    const detail = typeof probe.signal === 'string' ? `signal ${probe.signal}` : `exit ${String(probe.status)}`
    throw new Error(`песочница bwrap не запускается (${detail}), команда отклонена${stderr === '' ? '' : `: ${stderr}`}`)
  }
  cache.set(key, Date.now())
}

function clampTimeout(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.round(value * 1000), maximum)
}

function outputOf(stdout: string, stderr: string): string {
  const sections: string[] = []
  if (stdout !== '') sections.push(stdout)
  if (stderr !== '') sections.push(`--- stderr ---\n${stderr}`)
  if (sections.length === 0) return '(нет вывода)'
  return sections.join('\n')
}

/** Keep text within `budget` characters, with an explicit truncation notice. */
function truncateGuestOutput(text: string, budget: number): string {
  if (text.length <= budget) return text
  const notice = '\n…[вывод обрезан: показаны начало и конец, лимит ответа инструмента]\n'
  const keep = Math.max(0, budget - notice.length)
  // A cut never splits a surrogate pair: half a character is not text.
  let head = Math.ceil(keep * 0.6)
  if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1
  let tail = keep - head
  if (tail > 0 && isLowSurrogate(text.charCodeAt(text.length - tail))) tail -= 1
  return `${text.slice(0, head)}${notice}${tail > 0 ? text.slice(-tail) : ''}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * The whole answer of a guest command: the status line outside, the output in
 * one frame. {@link GUEST_MAX_OUTPUT_CHARS} caps the text the model reads, so
 * the output is defused first and only then cut to the room the status line
 * and the frame leave: defusing replaces a short chat-template token with a
 * longer marker, and a cut before it could not keep that promise. Defused text
 * contains no boundary word or token, so the frame's own defusing leaves it as
 * is and the frame stays whole, with exactly one closing line.
 */
export function guestExecAnswer(status: string, output: string): string {
  const source = 'guest_exec'
  const room = GUEST_MAX_OUTPUT_CHARS - status.length - 1 - frameData('', { source }).length
  return `${status}\n${frameData(truncateGuestOutput(sanitizeData(output), Math.max(0, room)), { source })}`
}

type ControlState = 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'stringEscape'

/** ESC, BEL and the C1 controls (U+0080-U+009F, among them the one-character CSI U+009B and OSC U+009D). */
const CONTROL_PATTERN = /[\u0007\u001b\u0080-\u009f]/

/** ESC-form introducers of OSC, DCS, SOS, PM and APC. */
function isStringIntroducer(code: number): boolean {
  return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f
}

/** C1 introducers of DCS, SOS, OSC, PM and APC. */
function isC1StringIntroducer(code: number): boolean {
  return code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f
}

/**
 * Remove terminal control sequences from text the model reads: CSI (colors,
 * cursor moves, erases), OSC/DCS/SOS/PM/APC (titles, hyperlinks) and the short
 * two-character escapes, both in the ESC form and in the one-character C1 form
 * (U+009B for CSI, U+009D for OSC, ...). A dangling bell and the other C1
 * controls are dropped too. Newlines, tabs and every printable character stay
 * untouched. The parser keeps its state between `feed` calls, so text fed in
 * pieces is cleaned exactly like the same text fed at once.
 */
class ControlStripper {
  private state: ControlState = 'text'

  /** True when the text fed so far ends outside any control sequence. */
  get idle(): boolean {
    return this.state === 'text'
  }

  feed(text: string): string {
    const parts: string[] = []
    let plainFrom = 0
    let index = 0
    while (index < text.length) {
      const code = text.charCodeAt(index)
      switch (this.state) {
        case 'text':
          if (code === 0x1b || code === 0x07 || (code >= 0x80 && code <= 0x9f)) {
            if (index > plainFrom) parts.push(text.slice(plainFrom, index))
            if (code === 0x1b) this.state = 'escape'
            else if (code === 0x9b) this.state = 'csi'
            else if (isC1StringIntroducer(code)) this.state = 'string'
            plainFrom = index + 1
          }
          index += 1
          continue
        case 'escape':
          if (code === 0x5b) {
            this.state = 'csi'
            index += 1
            continue
          }
          if (isStringIntroducer(code)) {
            this.state = 'string'
            index += 1
            continue
          }
          if (code >= 0x20 && code <= 0x2f) {
            this.state = 'intermediate'
            index += 1
            continue
          }
          // A final byte ends the escape; anything else is text again.
          if (code >= 0x30 && code <= 0x7e) index += 1
          this.state = 'text'
          plainFrom = index
          continue
        case 'intermediate':
          if (code >= 0x20 && code <= 0x2f) {
            index += 1
            continue
          }
          if (code >= 0x30 && code <= 0x7e) index += 1
          this.state = 'text'
          plainFrom = index
          continue
        case 'csi':
          // Parameters and intermediates up to a final byte 0x40-0x7e.
          index += 1
          if (code >= 0x40 && code <= 0x7e) {
            this.state = 'text'
            plainFrom = index
          }
          continue
        case 'string':
          // The payload runs up to BEL, ST (U+009C) or the ESC-backslash pair.
          index += 1
          if (code === 0x07 || code === 0x9c) {
            this.state = 'text'
            plainFrom = index
          } else if (code === 0x1b) {
            this.state = 'stringEscape'
          }
          continue
        case 'stringEscape':
          if (code === 0x5c) {
            index += 1
            this.state = 'text'
            plainFrom = index
          } else {
            // A lone ESC inside the payload is payload; the character after it is read again.
            this.state = 'string'
          }
          continue
      }
    }
    if (this.state === 'text' && index > plainFrom) parts.push(text.slice(plainFrom, index))
    return parts.join('')
  }
}

function stripControlSequences(text: string): string {
  if (!CONTROL_PATTERN.test(text)) return text
  return new ControlStripper().feed(text)
}

/**
 * The part of `text` in [from, to) that survives collapsing redraws: every
 * line keeps its last state, which is everything after the final carriage
 * return of the line. A single `\r` before the line end is a CRLF line ending,
 * not a redraw, and is dropped. `text` may reach past the range on both sides
 * so that a line cut by the range collapses as the whole line does.
 */
function collapsedRange(text: string, from: number, to: number): string {
  let out = ''
  let lineStart = 0
  while (lineStart < to) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    if (lineEnd >= from) {
      let contentEnd = lineEnd
      if (contentEnd > lineStart && text.charCodeAt(contentEnd - 1) === 0x0d) contentEnd -= 1
      const redraw = contentEnd > lineStart ? text.lastIndexOf('\r', contentEnd - 1) : -1
      const keepStart = redraw >= lineStart ? redraw + 1 : lineStart
      out += text.slice(Math.max(keepStart, from), Math.min(contentEnd, to))
      if (newline !== -1 && newline < to) out += '\n'
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return out
}

/** Keep the last state of every line that was redrawn through `\r`. */
function collapseCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text
  return collapsedRange(text, 0, text.length)
}

/**
 * Fold a run of three or more identical lines, empty ones included, into one
 * line followed by a `(повтор N раз)` note. Two equal lines in a row carry
 * meaning and stay as they are.
 */
function foldRepeatedLines(text: string): string {
  if (!text.includes('\n')) return text
  const trailingNewline = text.endsWith('\n')
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n')
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] as string
    let run = 1
    while (index + run < lines.length && lines[index + run] === line) run += 1
    if (run >= 3) {
      kept.push(line, `(повтор ${run} раз)`)
    } else {
      for (let repeat = 0; repeat < run; repeat += 1) kept.push(line)
    }
    index += run
  }
  return kept.join('\n') + (trailingNewline ? '\n' : '')
}

/** Compress the noise of one output stream before it reaches the model. */
function compressOutputStream(text: string): string {
  return foldRepeatedLines(collapseCarriageReturns(stripControlSequences(text)))
}

/** True when raw UTF-8 bytes hold ESC or a C1 control (U+0080-U+009F is encoded as C2 80-C2 9F). */
function hasControlIntroducer(bytes: Buffer): boolean {
  if (bytes.includes(0x1b)) return true
  let at = bytes.indexOf(0xc2)
  while (at !== -1 && at + 1 < bytes.length) {
    const next = bytes[at + 1] as number
    if (next >= 0x80 && next <= 0x9f) return true
    at = bytes.indexOf(0xc2, at + 1)
  }
  return false
}

/** Remove the spill file of a stream whose answer is already built; it never changes the answer. */
function discardSpill(stream: { spillPath?: string }): void {
  if (stream.spillPath === undefined) return
  try {
    rmSync(stream.spillPath, { force: true })
  } catch {
    // A spill file left behind does not change the answer.
  }
}

/**
 * Remove the spill file of a captured stream that has settled. The reader
 * still reports the path after the stream is sealed; a read at the end of the
 * stream returns no text, only the fact that a whole-stream file exists.
 */
function discardReaderSpill(reader: { readFrom(fromByte: number): { spillPath?: string } }): void {
  try {
    discardSpill(reader.readFrom(Number.MAX_SAFE_INTEGER))
  } catch {
    // The stream is already closed; nothing left to remove.
  }
}

/**
 * The complete text of one collected stream. The in-memory text is only the
 * tail once the stream overflowed its budget; the spill file then holds the
 * whole stream, so it is read and removed. A lost head without a spill file
 * is marked instead of passing the tail off as the whole output.
 */
function wholeStream(stream: { text: string; truncated: boolean; spillPath?: string }): string {
  try {
    if (!stream.truncated) return stream.text
    if (stream.spillPath !== undefined) {
      try {
        return readFileSync(stream.spillPath).toString('utf8')
      } catch {
        // The spill file is gone; the tail below is all that remains.
      }
    }
    return `(начало вывода потеряно, показан только хвост)\n${stream.text}`
  } finally {
    discardSpill(stream)
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** True for a UTF-8 continuation byte (10xxxxxx). */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/** Length of the UTF-8 sequence that `lead` starts; a stray byte counts as one. */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 1
}

/**
 * Length of the longest prefix of `bytes` that does not end inside a UTF-8
 * character: an incomplete trailing sequence (at most three bytes) is left out.
 */
function completeLength(bytes: Buffer): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] as number
    if (isContinuation(byte)) continue
    return utf8SequenceLength(byte) > back ? bytes.length - back : bytes.length
  }
  return bytes.length
}

/** One page of a job's output. */
interface OutputPage {
  /** Text returned, at most the requested number of characters. */
  text: string
  /** Offset of the first returned byte; it is above the requested one when the head was dropped. */
  start: number
  /** Offset to pass to the next read: the first byte after the page. */
  next: number
  /** Whole-stream offset where the retained output begins. */
  earliest: number
  /** Whole-stream byte count at read time. */
  total: number
  /** True when the requested offset was already dropped. */
  lossy: boolean
}

/**
 * The output ring of one background job: a bounded window over the whole
 * stream with absolute byte coordinates. Once the retained bytes pass the cap
 * exactly the overflow is cut from the oldest chunk, so the ring always keeps
 * the last `cap` bytes, `earliest` only grows and a page never repeats or
 * silently splices bytes. Pages start and end on UTF-8 character boundaries.
 */
export class JobOutput {
  private readonly cap: number
  private chunks: Array<{ at: number; bytes: Buffer }> = []
  private retained = 0
  /** Offset the next appended byte starts at. */
  total = 0
  /** Oldest retained byte. */
  earliest = 0
  /** Values that never reach a reader; the history outlives a deleted secret. */
  private readonly secretSource?: () => readonly ExecSecretEntry[]
  /** The masked copy of the window the last read built, and what it was built from. */
  private masked?: { key: string; bytes: Buffer }

  constructor(cap: number, secretSource?: () => readonly ExecSecretEntry[]) {
    this.cap = cap
    this.secretSource = secretSource
  }

  /** Bytes currently held by the ring. */
  get size(): number {
    return this.retained
  }

  /**
   * Values of the secrets this job carries. A pump asks for them to keep the
   * beginning of a value whole when the other stream writes in between.
   */
  secretValues(): string[] {
    const source = this.secretSource
    if (source === undefined) return []
    return source()
      .map((entry) => (typeof entry.value === 'string' ? entry.value : ''))
      .filter((value) => value.length > 0)
  }

  /** Append text or raw stream bytes; bytes are copied, so the ring never pins the caller's buffer. */
  append(data: string | Uint8Array): void {
    if (data.length === 0) return
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    this.chunks.push({ at: this.total, bytes })
    this.total += bytes.length
    this.retained += bytes.length
    this.trim()
  }

  /**
   * Account for stream bytes that the producer dropped before they reached the
   * ring. Absolute offsets stay coherent with the stream, and the retained head
   * restarts at the new total.
   */
  skip(bytes: number): void {
    const whole = Math.floor(bytes)
    if (!Number.isFinite(whole) || whole <= 0) return
    this.total += whole
    this.chunks = []
    this.retained = 0
    this.earliest = this.total
  }

  private trim(): void {
    while (this.retained > this.cap) {
      const oldest = this.chunks[0]
      if (oldest === undefined) break
      const excess = this.retained - this.cap
      if (oldest.bytes.length <= excess) {
        this.chunks.shift()
        this.retained -= oldest.bytes.length
      } else {
        oldest.bytes = oldest.bytes.subarray(excess)
        oldest.at += excess
        this.retained -= excess
      }
    }
    this.earliest = this.chunks.length === 0 ? this.total : (this.chunks[0] as { at: number }).at
  }

  /**
   * The window as a reader sees it. The stored bytes are never changed: a
   * secret that is still arriving must stay whole in them, or its continuation
   * would no longer match and its suffix would pass. The copy has every known
   * secret replaced with a filler of the same byte length, so offsets stay those
   * of the stream. A head that may begin in the middle of a dropped secret (any
   * byte before `earliest` is lost) is filled up to its first newline or for the
   * longest secret minus one byte, and a tail that is the beginning or the end
   * of a value is filled as well: the stream may still be running or cut by
   * `head -c`. A value deleted after the job started is still in the vault
   * history and never reaches the model.
   */
  private view(): Array<{ at: number; bytes: Buffer }> {
    const source = this.secretSource
    if (source === undefined || this.chunks.length === 0) return this.chunks
    const entries = source().filter((entry) => typeof entry.value === 'string' && entry.value !== '')
    if (entries.length === 0) return this.chunks
    const key = `${this.earliest}:${this.total}:${entries.map((entry) => entry.value).join('\u0000')}`
    if (this.masked?.key === key) return [{ at: this.earliest, bytes: this.masked.bytes }]
    const raw = this.chunks.length === 1 ? (this.chunks[0] as { bytes: Buffer }).bytes : Buffer.concat(this.chunks.map((chunk) => chunk.bytes))
    const buffer = Buffer.from(raw)
    const values = entries.map((entry) => Buffer.from(entry.value, 'utf8'))
    for (const needle of values) {
      // Matches are looked up in the stored bytes, so a filler already placed
      // for another value never hides an occurrence of this one.
      let at = raw.indexOf(needle)
      while (at >= 0) {
        buffer.fill(0x2a, at, at + needle.length)
        at = raw.indexOf(needle, at + 1)
      }
    }
    if (this.earliest > 0) {
      // N is the length of the longest secret of this job minus one: a suffix
      // of any of them is shorter than N, so filling that head removes it all.
      const longest = values.reduce((max, value) => Math.max(max, value.length), 0)
      const limit = Math.max(1, longest - 1)
      const newline = raw.subarray(0, Math.min(limit, raw.length)).indexOf(0x0a)
      let end = newline >= 0 ? newline + 1 : Math.min(limit, raw.length)
      while (end < raw.length && isContinuation(raw[end] as number)) end += 1
      buffer.fill(0x2a, 0, end)
    }
    for (const value of values) {
      const max = Math.min(value.length - 1, raw.length)
      for (let size = max; size >= 1; size -= 1) {
        const tail = raw.subarray(raw.length - size)
        if (tail.equals(value.subarray(0, size)) || tail.equals(value.subarray(value.length - size))) {
          buffer.fill(0x2a, raw.length - size)
          break
        }
      }
    }
    this.masked = { key, bytes: buffer }
    return [{ at: this.earliest, bytes: buffer }]
  }

  /** The byte at absolute offset `at` of `chunks`, or undefined outside the window. */
  private static byteAt(chunks: ReadonlyArray<{ at: number; bytes: Buffer }>, at: number): number | undefined {
    for (const chunk of chunks) {
      if (at < chunk.at) return undefined
      if (at < chunk.at + chunk.bytes.length) return chunk.bytes[at - chunk.at]
    }
    return undefined
  }

  /** Bytes of `chunks` in the absolute range [from, to). */
  private static slice(chunks: ReadonlyArray<{ at: number; bytes: Buffer }>, from: number, to: number): Buffer {
    const parts: Buffer[] = []
    for (const chunk of chunks) {
      const chunkEnd = chunk.at + chunk.bytes.length
      if (chunkEnd <= from) continue
      if (chunk.at >= to) break
      parts.push(chunk.bytes.subarray(Math.max(from, chunk.at) - chunk.at, Math.min(to, chunkEnd) - chunk.at))
    }
    return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts)
  }

  /**
   * Read at most `limit` characters from `from`, with the next offset and the
   * retained window. `from` and `next` are byte positions of the whole stream,
   * while `limit` counts Unicode characters, so a page holds exactly the next
   * characters of the output and never splits one. A caller or a dropped head
   * may point inside a character: the page then starts at the next whole one.
   * With `limit >= 1` the next offset always moves forward while output remains.
   */
  read(from: number, limit: number): OutputPage {
    const chunks = this.view()
    const lossy = from < this.earliest
    let start = Math.min(Math.max(from, this.earliest), this.total)
    // The window or the caller may point inside a character: its bytes
    // belong to the page before, so the page starts at the next character.
    while (start < this.total && isContinuation(JobOutput.byteAt(chunks, start) ?? 0)) start += 1
    const rest = JobOutput.slice(chunks, start, this.total)
    let end = 0
    let characters = 0
    while (end < rest.length && characters < Math.max(0, limit)) {
      const lead = rest[end] as number
      end = Math.min(rest.length, end + utf8SequenceLength(lead))
      characters += 1
    }
    const body = rest.subarray(0, end)
    return {
      text: body.toString('utf8'),
      start,
      next: start + body.length,
      earliest: this.earliest,
      total: this.total,
      lossy,
    }
  }

  /**
   * The text of the absolute range [from, to) as the model reads it: control
   * sequences cut and redrawn lines collapsed, exactly the part of this range
   * that survives cleaning the whole retained window at once. The retained bytes
   * before the range give the state of a control sequence and the line the range
   * starts in, the bytes after it up to the next line end tell whether the last
   * line is redrawn later. Both bounds must be character boundaries; offsets of
   * the raw stream are not changed, and repeats are never folded.
   */
  clean(from: number, to: number): string {
    if (to <= from) return ''
    // The masked view: secrets are cut before cleaning, with byte offsets unchanged.
    const chunks = this.view()
    let begin = this.earliest
    while (begin < from && isContinuation(JobOutput.byteAt(chunks, begin) ?? 0)) begin += 1
    const stripper = new ControlStripper()
    let prefix = ''
    if (from > begin) {
      const before = JobOutput.slice(chunks, begin, from)
      if (hasControlIntroducer(before)) {
        const text = stripper.feed(before.toString('utf8'))
        prefix = text.slice(text.lastIndexOf('\n') + 1)
      } else {
        // No sequence can be open at `from`: only the line it starts in matters.
        prefix = stripper.feed(before.subarray(before.lastIndexOf(0x0a) + 1).toString('utf8'))
      }
    }
    const body = stripper.feed(JobOutput.slice(chunks, from, to).toString('utf8'))
    if (body === '') return ''
    let after = ''
    if (!body.endsWith('\n') && to < this.total) {
      const rest = JobOutput.slice(chunks, to, this.total)
      let cursor = 0
      while (cursor < rest.length) {
        const newline = rest.indexOf(0x0a, cursor)
        const end = newline === -1 ? rest.length : newline + 1
        after += stripper.feed(rest.subarray(cursor, end).toString('utf8'))
        cursor = end
        const lineEnd = after.indexOf('\n')
        if (lineEnd !== -1) {
          after = after.slice(0, lineEnd + 1)
          break
        }
      }
    }
    if (!(prefix + body + after).includes('\r')) return body
    return collapsedRange(prefix + body + after, prefix.length, prefix.length + body.length)
  }

  /**
   * The last `limit` characters (UTF-16 code units, like `String.length`) of
   * the retained window, starting on a character boundary.
   */
  tail(limit: number): string {
    if (limit <= 0 || this.retained === 0) return ''
    const chunks = this.view()
    let units = 0
    let start = this.total
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const chunk = chunks[index] as { at: number; bytes: Buffer }
      for (let position = chunk.bytes.length - 1; position >= 0; position -= 1) {
        const byte = chunk.bytes[position] as number
        if (isContinuation(byte)) continue
        const width = utf8SequenceLength(byte) === 4 ? 2 : 1
        if (units + width > limit) return JobOutput.slice(chunks, start, this.total).toString('utf8')
        units += width
        start = chunk.at + position
      }
    }
    return JobOutput.slice(chunks, start, this.total).toString('utf8')
  }
}

/**
 * Offset reader of one captured stream, as the subprocess seam exposes it. The
 * local collector also offers `snapshot()` with the retained raw bytes.
 */
export interface OutputSource {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
  snapshot?(): { bytes: Buffer; totalBytes: number }
}

/**
 * Label of one masked run of covered bytes. The label is never longer than the
 * longest value of the job: a whole value stays as wide as itself, while a
 * chain of overlapping occurrences of any length becomes one label.
 */
function maskLabel(run: number, longest: number): string {
  return '*'.repeat(Math.max(1, Math.min(run, longest)))
}

/**
 * Length of the longest suffix of `bytes` that is a proper beginning of one of
 * `secrets`. An occurrence may start there once more bytes arrive, so at least
 * that suffix waits; everything before it is decided.
 */
function openPrefixLength(bytes: Buffer, secrets: readonly Buffer[]): number {
  let best = 0
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, bytes.length)
    for (let size = max; size > best; size -= 1) {
      if (bytes.subarray(bytes.length - size).equals(secret.subarray(0, size))) {
        best = size
        break
      }
    }
  }
  return best
}

/**
 * Moves one captured stream into a job's ring. `readFrom` decodes every read on
 * its own, so a character whose bytes arrive across two polls would turn into
 * U+FFFD; the pump therefore takes raw bytes when the source has them and holds
 * back an incomplete trailing sequence until the rest of it arrives.
 *
 * When the job carries secrets, the pump masks its own stream instead of
 * leaving that to the merged ring: a value that another stream interrupts would
 * otherwise arrive as two halves that no whole-value match covers. A byte is
 * sent on only when it is decided whether some occurrence covers it, which
 * needs at most the longest value minus one byte held back. The held bytes keep
 * what is already known about their coverage, so a poll of any size only adds
 * to them and never drops them. Consecutive covered bytes, including a chain of
 * overlapping occurrences spread over many polls, become one label; uncovered
 * bytes pass as they are. A value captured when the job started stays hidden
 * after the vault deleted or replaced it.
 */
export class OutputPump {
  private readonly source: OutputSource
  private readonly output: JobOutput
  /** Stream offset of the next byte to take from the source. */
  private offset = 0
  /** Taken bytes the pump has not sent yet: the undecided tail of the stream. */
  private held: Buffer = Buffer.alloc(0)
  /** For every held byte, 1 when an occurrence already seen covers it. */
  private heldCovered: Uint8Array = new Uint8Array(0)
  /** True while the last sent byte was covered and one label already covers the run. */
  private maskedRun = false

  constructor(source: OutputSource, output: JobOutput) {
    this.source = source
    this.output = output
  }

  /** Take what the source captured since the previous poll. */
  poll(): void {
    const fresh = this.fresh()
    if (fresh.start > this.offset) {
      // The source dropped bytes between two polls: the held head lost its
      // continuation, and both go as a gap so offsets stay those of the stream.
      this.output.skip(this.held.length + fresh.start - this.offset)
      this.reset()
    }
    this.offset = fresh.next
    if (fresh.bytes.length === 0) return
    const secrets = this.secrets()
    const raw = this.held.length === 0 ? fresh.bytes : Buffer.concat([this.held, fresh.bytes])
    if (secrets.length === 0) {
      // No values to hide: only an incomplete trailing character waits.
      const complete = completeLength(raw)
      this.output.append(raw.subarray(0, complete))
      this.held = Buffer.from(raw.subarray(complete))
      this.heldCovered = new Uint8Array(this.held.length)
      this.maskedRun = false
      return
    }
    this.emit(raw, secrets, false)
  }

  /** The stream ended: the rest gets the same coverage check and then goes in. */
  finish(): void {
    try {
      this.poll()
    } finally {
      const secrets = this.secrets()
      if (secrets.length === 0) this.output.append(this.held)
      else if (this.held.length > 0) this.emit(this.held, secrets, true)
      this.reset()
    }
  }

  private reset(): void {
    this.held = Buffer.alloc(0)
    this.heldCovered = new Uint8Array(0)
    this.maskedRun = false
  }

  /** Values of the job's secrets as bytes, longest first. */
  private secrets(): Buffer[] {
    const values = this.output.secretValues()
    const unique = new Map<string, Buffer>()
    for (const value of values) {
      if (value !== '' && !unique.has(value)) unique.set(value, Buffer.from(value, 'utf8'))
    }
    return [...unique.values()].sort((left, right) => right.length - left.length)
  }

  /**
   * Decide the buffered bytes, which are the held bytes and then the fresh
   * ones. No occurrence that is still open can start before the longest suffix
   * that is a proper beginning of a value, so everything before that suffix is
   * decided: a covered run becomes a label, an uncovered run goes as it is. The
   * suffix waits with its coverage bits; on `final` nothing waits. A run that
   * continues the run of the last sent byte adds no second label.
   */
  private emit(raw: Buffer, secrets: readonly Buffer[], final: boolean): void {
    const longest = secrets[0]?.length ?? 0
    const covered = new Uint8Array(raw.length)
    covered.set(this.heldCovered.subarray(0, Math.min(this.heldCovered.length, raw.length)))
    for (const secret of secrets) {
      let at = raw.indexOf(secret)
      while (at >= 0) {
        covered.fill(1, at, at + secret.length)
        at = raw.indexOf(secret, at + 1)
      }
    }
    let end = final ? raw.length : raw.length - openPrefixLength(raw, secrets)
    if (!final) {
      // Only whole characters may enter the shared ring: the other stream can
      // write between two polls, so a lone lead byte would be split by it.
      if (end === raw.length) end = completeLength(raw)
      while (end > 0 && end < raw.length && isContinuation(raw[end] as number)) end -= 1
    }
    const parts: Buffer[] = []
    let index = 0
    while (index < end) {
      let runEnd = index + 1
      const mark = covered[index]
      while (runEnd < end && covered[runEnd] === mark) runEnd += 1
      if (mark === 0) {
        parts.push(raw.subarray(index, runEnd))
        this.maskedRun = false
      } else {
        if (!this.maskedRun) {
          // The width counts the covered bytes that already wait as well, so a
          // whole value split by a poll still gets a label as wide as itself.
          let known = runEnd
          while (known < raw.length && covered[known] === 1) known += 1
          parts.push(Buffer.from(maskLabel(known - index, longest), 'utf8'))
        }
        this.maskedRun = true
      }
      index = runEnd
    }
    if (parts.length > 0) this.output.append(parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts))
    this.held = Buffer.from(raw.subarray(end))
    this.heldCovered = covered.slice(end)
  }

  /** New bytes of the source, the stream offset they start at and the offset after them. */
  private fresh(): { bytes: Buffer; start: number; next: number } {
    if (typeof this.source.snapshot === 'function') {
      const { bytes, totalBytes } = this.source.snapshot()
      const windowStart = totalBytes - bytes.length
      const start = Math.min(Math.max(this.offset, windowStart), totalBytes)
      return { bytes: bytes.subarray(start - windowStart), start, next: totalBytes }
    }
    const read = this.source.readFrom(this.offset)
    const bytes = Buffer.from(read.text, 'utf8')
    const start = read.lossy ? Math.max(this.offset, read.nextOffset - bytes.length) : this.offset
    return { bytes, start, next: read.nextOffset }
  }
}

/** One line for the list of jobs: whitespace folded, long commands shortened. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`
}

/** Russian word for the lifecycle state in the job list. */
function listStatus(status: JobStatus): string {
  if (status === 'running') return 'идёт'
  if (status === 'stopping') return 'останавливается'
  if (status === 'completed') return 'завершена'
  if (status === 'failed') return 'завершена с ошибкой'
  if (status === 'killed') return 'завершена (убита)'
  return status
}

/** Details of a job as the list shows them: the exit code or the kill reason. */
function jobDetail(view: JobView): string {
  return view.detail === undefined ? '' : `, ${oneLine(view.detail)}`
}

/** Approve a command through the guard and the owner, or throw the refusal. */
async function admit(
  command: string,
  approval: ExecApproval | undefined,
  guest = false,
  purpose?: string,
  purposeRequired = false,
): Promise<void> {
  // exec always runs in the bwrap sandbox: only a destructive action asks the
  // owner, the sandbox itself bounds what the command can reach.
  const verdict = checkCommand(command, { sandbox: true })
  if (verdict.verdict === 'deny') {
    throw new Error(`Отказ: команда запрещена (${verdict.reason})`)
  }
  if (verdict.verdict !== 'confirm') return
  // A guest has no owner card and no owner data to protect: a confirmation
  // class command runs inside the guest's own empty sandbox. The guard's deny
  // verdict above still refuses it.
  if (guest) return
  if (approval === undefined) {
    throw new Error('Отказ: команда требует подтверждения, но подтверждение недоступно.')
  }
  const decision = await approval({
    command,
    reason: verdict.reason,
    ...(purpose === undefined ? {} : { purpose }),
    ...(purposeRequired ? { purposeRequired: true } : {}),
  })
  if (decision === 'allow') return
  if (decision === 'purpose') {
    throw new Error(
      'exec: укажите purpose — зачем вы запускаете команду, своими словами, — и повторите вызов с purpose.',
    )
  }
  if (decision === 'expired') {
    throw new Error('Отказ: срок подтверждения истёк, команда не запущена.')
  }
  if (decision === 'unavailable') {
    throw new Error('Отказ: поблизости нет владельца, который мог бы подтвердить команду.')
  }
  throw new Error('Отказ: владелец отклонил команду.')
}

/** Build a shell executor whose argv is wrapped in the project's bwrap profile. */
function sandboxedExecutor(
  profile: readonly string[],
  relay: { readonly script: string; readonly socket: string; readonly node: string } | undefined,
  guest = false,
): typeof LocalBashExecutor {
  return class SandboxedBashExecutor extends LocalBashExecutor {
    override execute(spec: ShellExecSpec): Promise<ShellExecution> {
      // The data cap applies to the command and every child of it. It bounds
      // memory actually allocated, not address space: Node reserves a large
      // virtual range and must still start. The relay is started by the wrapper
      // before this line, so it keeps its own (unrelated) limit and the public
      // network still works.
      const command = guest
        ? `ulimit -d ${Math.floor(GUEST_MEMORY_BYTES / 1024)} 2>/dev/null || ` +
          `{ echo "exec: не удалось установить предел памяти гостя" >&2; exit 1; }; ${spec.command}`
        : spec.command
      if (relay === undefined) return this.executeArgv(spec, [...CLEAN_START, ...profile, 'bash', '-c', command])
      // The command is an argument, not part of the script: no re-quoting.
      return this.executeArgv(spec, [...CLEAN_START, ...profile, 'bash', '-c', RELAY_WRAPPER, 'dshbot-exec', command])
    }
  }
}

/**
 * Create the exec capability. The returned tools share one harness context:
 * `ctx.subprocess` runs the sandbox and `ctx.jobs` owns background ids.
 */
export async function createExecTools(options: ExecToolOptions): Promise<ExecTools> {
  const home = resolve(options.home ?? process.env.HOME ?? homedir())
  const workspace = resolve(options.workspace)
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`exec: workspace ${workspace} is not a directory`)
  }

  const roPaths = readRoPaths(home, options.roPaths)
  const guest = options.guest === true
  // Paths of the owner that must never appear in a guest namespace, mounted as
  // a toolchain directory or as the node binary. HOME itself is always one.
  const realOrResolved = (path: string): string => {
    const resolved = resolve(path)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  const ownerRoots = guest
    ? [...new Set([home, ...(options.guestMasks ?? [])].map(realOrResolved))]
    : []
  const guestRoPaths = guest
    ? roPaths.filter((path) => {
        const real = realOrResolved(path)
        return !ownerRoots.some((root) => isWithin(resolve(path), root) || isWithin(real, root))
      })
    : roPaths
  // The guest relay runs on a Node the guest namespace can see; the daemon's
  // own node under HOME (the mise install of deploy/dshbot.service) is masked
  // there, so another one outside the owner roots is chosen.
  const guestNode = guest
    ? guestNodeBinary(ownerRoots, options.daemonNode ?? process.execPath, process.env.PATH ?? '')
    : undefined
  const defaultTimeout = guest
    ? GUEST_MAX_TIMEOUT_MS
    : Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxTimeout = guest
    ? GUEST_MAX_TIMEOUT_MS
    : Math.max(defaultTimeout, options.maxTimeoutMs ?? MAX_TIMEOUT_MS)

  // The private network directory: the relay program and the proxy unix socket.
  // It is bind-mounted into the sandbox, so the command can reach nothing but
  // this socket and its own loopback.
  let networkDir: string | undefined
  let proxy: NetworkProxy | undefined
  let networkFailure: string | undefined
  let relay: { script: string; socket: string; node: string } | undefined
  try {
    if (guest && guestNode === undefined) {
      throw new Error(
        'нет Node вне каталогов владельца (HOME и DSHBOT_HOME), прокси гостевой песочницы не на чем запустить; ' +
          'установите системный node, например в /usr/bin',
      )
    }
    networkDir = makeNetworkDir()
    const relayScript = join(networkDir, RELAY_FILE)
    const proxySocket = join(networkDir, PROXY_SOCKET)
    writeFileSync(relayScript, RELAY_SOURCE, { mode: 0o600 })
    const resolveAddress = async (url: string): Promise<string> => resolvePublicTarget(url)
    proxy = await startNetworkProxy(resolveAddress, PROXY_TIMEOUT_MS, {
      listenPath: proxySocket,
      exposeRefusal: true,
    })
    relay = { script: relayScript, socket: proxySocket, node: guestNode ?? nodeBinaryPath() }
  } catch (error) {
    // No proxy means no egress at all: the sandbox is still unshared, and every
    // command fails with this reason instead of silently losing its network.
    networkFailure = errorText(error)
    proxy = undefined
    relay = undefined
    if (networkDir !== undefined) {
      try {
        rmSync(networkDir, { recursive: true, force: true })
      } catch {
        // Nothing left to remove.
      }
      networkDir = undefined
    }
  }
  const profile = guest
    ? guestSandboxProfile({
        ...(networkDir === undefined ? {} : { networkDir }),
        masks: [...ownerRoots],
        roPaths: guestRoPaths,
        ownerRoots,
        ...(guestNode === undefined ? {} : { node: guestNode }),
      })
    : sandboxProfile({
        home,
        workspace,
        roPaths,
        ...(networkDir === undefined ? {} : { networkDir }),
        ...(options.roots === undefined ? {} : { roots: options.roots }),
        ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
      })
  /** Successful probes of this capability's profiles, keyed by the exact argv. */
  const probeCache: SandboxProbeCache = new Map()
  const proxyUrl = `http://127.0.0.1:${RELAY_PORT}`

  const ctx = new Context()
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(JobsLocal)
  await ctx.plugin(sandboxedExecutor(profile, relay, guest), {
    cwd: workspace,
    timeoutMs: defaultTimeout,
    maxTimeoutMs: maxTimeout,
  } as unknown as Record<string, never>)
  const detachController = ctx.jobs.attachController('tools-exec')

  const shell = ctx.shell
  const jobs = ctx.jobs
  const baseEnvironment: Record<string, string | undefined> = guest
    ? (() => {
        // No directory of the owner is on the guest PATH, not even the one the
        // daemon node lives in: a path outside the namespace is dead weight,
        // and the system trees below are the only toolchain a guest gets. The
        // relay's own Node comes first, so `node` is the one that is mounted.
        const inherited = sandboxPath(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')
          .split(delimiter)
          .filter((entry) => entry !== '' && !ownerRoots.some((root) => isWithin(resolve(entry), root)))
        const nodeDir = guestNode === undefined ? [] : [dirname(guestNode)]
        const env: Record<string, string | undefined> = {
          PATH: [...new Set([...nodeDir, ...inherited, '/usr/local/bin', '/usr/bin', '/bin'])].join(delimiter),
          HOME: '/home/guest',
          TMPDIR: '/tmp',
          TERM: 'dumb',
          SHELL: '/bin/bash',
          LANG: process.env.LANG ?? 'C.UTF-8',
        }
        // Tombstones: nothing of the daemon's environment (DSHBOT_HOME, keys,
        // tokens) reaches a guest command, exactly like the owner's profile.
        for (const name of Object.keys(process.env)) {
          if (!(name in env)) env[name] = undefined
        }
        return env
      })()
    : childEnvironment(home)
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
    ...(relay === undefined
      ? {}
      : {
          http_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          all_proxy: proxyUrl,
          ALL_PROXY: proxyUrl,
          no_proxy: '',
          NO_PROXY: '',
          DSHBOT_EXEC_NET_RELAY: relay.script,
          DSHBOT_EXEC_NET_SOCKET: relay.socket,
          DSHBOT_EXEC_NET_NODE: relay.node,
        }),
  }

  /** Refuse every command while the network bridge is not usable. */
  function requireNetwork(): void {
    if (networkFailure !== undefined) {
      throw new Error(`exec: сетевой прокси песочницы недоступен, команда не запущена: ${networkFailure}`)
    }
  }

  /** Values of the vault that must never reach the model, in any output. */
  const secretEntries = (): readonly ExecSecretEntry[] => options.secrets?.known() ?? []

  /** Replace every known secret value with the placeholder. */
  function scrubText(text: string): string {
    let result = text
    for (const entry of [...secretEntries()].sort((left, right) => right.value.length - left.value.length)) {
      if (entry.value.length === 0) continue
      result = result.split(entry.value).join('[скрыто]')
    }
    return result
  }

  /**
   * Environment of the secrets the model asked for by name. An unknown name is
   * a tool error: a command must not silently run without its credential.
   */
  function secretEnvironment(value: unknown): Record<string, string> {
    if (value === undefined) return {}
    if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
      throw new Error('exec: secrets должен быть массивом имён секретов')
    }
    const env: Record<string, string> = {}
    for (const name of value as string[]) {
      if (!/^[A-Z0-9_]{1,64}$/.test(name)) throw new Error(`exec: недопустимое имя секрета ${name}`)
      const secret = options.secrets?.get(name)
      if (secret === undefined) throw new Error(`exec: секрет ${name} не найден`)
      env[name] = secret
    }
    return env
  }

  /** `exec` schema: names are visible, values are not. */
  const secretNamesText = (): string => {
    const names = options.secrets?.names() ?? []
    return names.length === 0 ? 'Секретов нет.' : `Доступные секреты: ${names.join(', ')}.`
  }

  function resolveSpec(
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    extraEnv: Record<string, string> = {},
  ): ShellExecSpec {
    return shell.resolve({
      command,
      // The host-side cwd of the bwrap process; the sandbox changes to /work
      // itself with `--chdir` in the guest profile.
      workdir: workspace,
      timeoutMs,
      onExpiry: 'kill',
      // Undefined entries are tombstones: the subprocess seam drops the ambient variable.
      env: { ...environment, ...extraEnv } as unknown as Record<string, string>,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  async function runForeground(
    command: string,
    timeoutSec: unknown,
    secrets: unknown,
  ): Promise<string> {
    if (stopped !== undefined) throw new Error('exec остановлен: сетевой прокси песочницы закрыт, команда не запущена.')
    requireNetwork()
    probeSandbox(profile, probeCache)
    const extraEnv = secretEnvironment(secrets)
    const timeoutMs = clampTimeout(timeoutSec, defaultTimeout, maxTimeout)
    let handle: Awaited<ReturnType<typeof shell.execute>>
    try {
      handle = await shell.execute(resolveSpec(command, timeoutMs, undefined, extraEnv))
    } catch (error) {
      // The sandbox may have failed before the command started.
      invalidateSandboxProbe(profile, probeCache)
      throw error
    }
    let result: Awaited<ReturnType<typeof handle.result>>
    try {
      result = await handle.result()
    } catch (error) {
      // The sandbox may have died before the command started: do not let the
      // rest of the window run on a probe that no longer holds.
      invalidateSandboxProbe(profile, probeCache)
      // The answer is an error, but the whole-stream files of the command are
      // no longer read by anyone and must not outlive the call.
      discardReaderSpill(handle.observed.stdout)
      discardReaderSpill(handle.observed.stderr)
      throw error
    }
    // A non-zero outcome (including a bwrap failure that prevented bash from
    // starting) drops the remembered probe: the next command verifies the
    // sandbox again and reports the clear error instead of trusting the window.
    if (result.exitCode !== 0) invalidateSandboxProbe(profile, probeCache)
    // Secrets are masked both in the raw stream (a value the compression would
    // fold or cut) and after it (a value split by ANSI codes or redraws).
    const body = scrubText(outputOf(
      compressOutputStream(scrubText(result.stdout.text)),
      compressOutputStream(scrubText(result.stderr.text)),
    ))
    // The answer keeps only the in-memory tails; the whole-stream files are no
    // longer needed once the text above is built.
    discardSpill(result.stdout)
    discardSpill(result.stderr)
    // The first line is the status of the process, and other parts of the bot
    // (the notes about repeated failures) read exactly that line. The command
    // output, including the stderr heading, is foreign data and follows inside
    // one frame: the model can use it, but it cannot issue commands. A guest
    // answer is capped as a whole, see guestExecAnswer.
    let status: string
    if (result.timedOut) status = `Таймаут: команда и её дочерние процессы убиты через ${Math.round(timeoutMs / 1000)} с.`
    else if (result.aborted) status = 'Команда прервана.'
    else status = result.exitCode === null ? `signal ${String(result.signal ?? 'unknown')}` : `exit ${result.exitCode}`
    if (guest) return guestExecAnswer(status, body)
    return `${status}\n${frameData(body, { source: 'exec' })}`
  }

  /**
   * One command of the owner's own `!` shell: the same profile, environment
   * and guard as the model's foreground `exec`, without a job and without any
   * session write. The approval callback is the caller's, so an owner command
   * gets its own card even outside a model turn.
   */
  async function runDirect(command: string, options: DirectExecOptions): Promise<DirectExecResult> {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('exec: command must be a non-empty string')
    }
    if (stopped !== undefined) throw new Error('exec остановлен: сетевой прокси песочницы закрыт, команда не запущена.')
    await admit(command, options.approval)
    requireNetwork()
    probeSandbox(profile, probeCache)
    const timeoutMs = clampTimeout(options.timeoutSec, defaultTimeout, maxTimeout)
    try {
      const handle = await shell.execute(resolveSpec(command, timeoutMs, options.signal))
      const result = await handle.result()
      if (result.exitCode !== 0) invalidateSandboxProbe(profile, probeCache)
      return {
        exitCode: result.exitCode,
        signal: result.signal === null ? null : String(result.signal),
        timedOut: result.timedOut === true,
        aborted: result.aborted === true,
        output: scrubText(outputOf(wholeStream(result.stdout), wholeStream(result.stderr))),
      }
    } catch (error) {
      // The command may have failed before the sandbox started it; probe again
      // on the next call instead of trusting the rest of the window.
      invalidateSandboxProbe(profile, probeCache)
      throw error
    }
  }

  /** The live face of one background job: its ring, its stdin and its process range. */
  interface LiveJob {
    readonly output: JobOutput
    /** True once the process settled; a write is refused after that. */
    settled: boolean
    cancelled: boolean
    stdin?: Writable
    terminate(): void
  }

  /** Rings and stdin pipes of the jobs this instance started, keyed by job id. */
  const liveJobs = new Map<string, LiveJob>()

  /**
   * The last tail answer of each job, keyed by the output coordinates it was
   * built from. A settled job cannot change, so a repeated `exec_status` (with
   * or without wait_sec) returns exactly the same text instead of a fresh frame
   * boundary id for identical data.
   */
  const tailAnswers = new Map<string, string>()

  function startJob(command: string, extraEnv: Record<string, string> = {}): string {
    if (stopped !== undefined) throw new Error('exec остановлен: сетевой прокси песочницы закрыт, команда не запущена.')
    requireNetwork()
    probeSandbox(profile, probeCache)
    if (!existsSync(workspace)) throw new Error(`exec: workspace ${workspace} disappeared`)
    const id = jobs.start({
      kind: 'bash',
      label: command,
      run(job) {
        // The values this very command got: a deleted or replaced secret still
        // has its old value scrubbed, because the capture lives with the job.
        const jobSecrets: ExecSecretEntry[] = Object.entries(extraEnv).map(([name, value]) => ({ name, value }))
        const output = new JobOutput(OUTPUT_BUFFER_BYTES, () => jobSecrets)
        const state: LiveJob = {
          output,
          settled: false,
          cancelled: false,
          terminate(): void {},
        }
        // The command is an argument of the wrapper, never part of its script:
        // its quoting stays untouched, exactly like the foreground path.
        const argv =
          relay === undefined
            ? [...CLEAN_START, ...profile, 'bash', '-c', command]
            : [...CLEAN_START, ...profile, 'bash', '-c', RELAY_WRAPPER, 'dshbot-exec', command]
        let spawned: ReturnType<typeof ctx.subprocess.spawn>
        try {
          spawned = ctx.subprocess.spawn({
            argv,
            cwd: workspace,
            stdio: {
              // A live pipe, not an already closed stdin: `exec_write` sends a
              // line into a command that is waiting for one.
              stdin: 'pipe',
              stdout: { maxBytes: OUTPUT_BUFFER_BYTES, spill: { maxBytes: OUTPUT_BUFFER_BYTES } },
              stderr: { maxBytes: OUTPUT_BUFFER_BYTES, spill: { maxBytes: OUTPUT_BUFFER_BYTES } },
            },
            graceMs: TERMINATE_GRACE_MS,
            env: { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', ...environment, ...extraEnv },
          })
        } catch (error) {
          // The sandbox may have failed before the job started; probe again on
          // the next command instead of trusting the rest of the window.
          invalidateSandboxProbe(profile, probeCache)
          throw error
        }
        const stdoutReader = spawned.collected.stdout
        const stderrReader = spawned.collected.stderr
        if (stdoutReader === undefined || stderrReader === undefined) {
          spawned.terminate()
          throw new Error('exec: подпроцесс не отдал потоки вывода')
        }
        state.stdin = spawned.stdin
        state.terminate = () => spawned.terminate()
        // EPIPE after the command exits must not crash the daemon.
        state.stdin?.on('error', () => {})
        liveJobs.set(String(job.id), state)

        // Each stream has its own pump: a character that one stream left
        // incomplete is held there, so the other stream's bytes never split it.
        const pumps = [new OutputPump(stdoutReader, output), new OutputPump(stderrReader, output)]
        const flush = (final = false): void => {
          for (const pump of pumps) {
            try {
              if (final) pump.finish()
              else pump.poll()
            } catch {
              // The stream is already closed; the final read below still runs.
            }
          }
        }
        flush()
        const timer = setInterval(() => flush(), OUTPUT_POLL_MS)
        timer.unref?.()
        const settle = (): void => {
          flush(true)
          clearInterval(timer)
          state.settled = true
          state.stdin = undefined
          // The ring already holds the answer, and the streams are sealed at
          // settlement: the whole-stream files are dead weight from here on.
          discardReaderSpill(stdoutReader)
          discardReaderSpill(stderrReader)
        }
        const done = spawned.done
          .then(
            (outcome) => {
              settle()
              if (state.cancelled) return { status: 'killed' as const, detail: 'задача остановлена' }
              if (outcome.signal !== null) {
                // Killed by a signal, not by the owner: the sandbox may be the
                // reason, so the next command probes it again.
                invalidateSandboxProbe(profile, probeCache)
                return { status: 'killed' as const, detail: `signal ${String(outcome.signal)}` }
              }
              const code = outcome.exitCode
              // A non-zero outcome (a bwrap failure included) drops the
              // remembered probe: the next command verifies the sandbox again.
              if (code !== 0) invalidateSandboxProbe(profile, probeCache)
              return {
                status: code === 0 ? ('completed' as const) : ('failed' as const),
                detail: code === null ? 'exit code: неизвестен' : `exit code: ${code}`,
              }
            },
            (error) => {
              settle()
              if (!state.cancelled) invalidateSandboxProbe(profile, probeCache)
              return { status: state.cancelled ? ('killed' as const) : ('failed' as const), detail: errorText(error) }
            },
          )
          .finally(() => {
            clearInterval(timer)
          })
        return {
          cancel(reason?: string): void {
            state.cancelled = true
            try {
              state.terminate()
            } catch {
              // The process is already gone; nothing left to stop.
            }
            if (reason !== undefined && reason !== '') output.append(`\nостановка: ${reason}\n`)
          },
          done,
        }
      },
    })
    return String(id)
  }

  function startBackground(command: string, extraEnv: Record<string, string> = {}): string {
    const id = startJob(command, extraEnv)
    return `Фоновая задача запущена.\n{"id":${JSON.stringify(id)},"status":"running"}\n` +
      `Статус: exec_status с этим id (offset и limit читают вывод с позиции), ` +
      `ввод: exec_write, список: exec_list, остановка: exec_stop.`
  }

  const background: ExecBackground = {
    start(command: string): string {
      return startJob(command)
    },
    status(id: string): ExecBackgroundStatus | undefined {
      const view = liveJobs.has(id) ? jobs.get(id as never) : undefined
      if (view === undefined) return undefined
      return view.detail === undefined ? { status: view.status } : { status: view.status, detail: view.detail }
    },
    read(id: string, offset: number, limit = DEFAULT_PAGE_CHARS): ExecBackgroundRead | undefined {
      const output = liveJobs.get(id)?.output
      if (output === undefined) return undefined
      const from = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE_CHARS) : DEFAULT_PAGE_CHARS
      const page = output.read(from, size)
      return {
        text: page.text,
        start: page.start,
        next: page.next,
        earliest: page.earliest,
        total: page.total,
        lossy: page.lossy,
      }
    },
    stop(id: string, reason?: string): void {
      const state = liveJobs.get(id)
      if (state === undefined) return
      state.cancelled = true
      try {
        state.terminate()
      } catch {
        // The process is already gone; nothing left to stop.
      }
      if (reason !== undefined && reason !== '') state.output.append(`\nостановка: ${reason}\n`)
    },
  }

  /** Validate the offset of a page read. */
  function readOffset(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('exec_status: offset должен быть неотрицательным целым числом')
    }
    return value
  }

  /** Validate the page size; absent means {@link DEFAULT_PAGE_CHARS}, oversized is capped. */
  function readLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_PAGE_CHARS
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error('exec_status: limit должен быть положительным целым числом')
    }
    return Math.min(value, MAX_PAGE_CHARS)
  }

  /** Validate the wait of `exec_status`; absent means an immediate answer. */
  function readWaitSec(value: unknown): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 600) {
      throw new Error('exec_status: wait_sec должен быть целым числом секунд от 1 до 600')
    }
    return value
  }

  /** Compile the optional line pattern; it is only meaningful together with a wait. */
  function readWaitPattern(value: unknown, waitSec: number | undefined): RegExp | undefined {
    if (value === undefined) return undefined
    if (waitSec === undefined) {
      throw new Error('exec_status: pattern задаётся только вместе с wait_sec')
    }
    if (typeof value !== 'string') {
      throw new Error('exec_status: pattern должен быть строкой с регулярным выражением')
    }
    if (value.length > MAX_WAIT_PATTERN_CHARS) {
      throw new Error(`exec_status: pattern длиннее ${MAX_WAIT_PATTERN_CHARS} символов`)
    }
    try {
      return new RegExp(value)
    } catch (error) {
      throw new Error(`exec_status: неверное регулярное выражение в pattern: ${errorText(error)}`)
    }
  }

  /** True when at least one line of `text` matches the pattern. */
  function matchesLine(text: string, pattern: RegExp): boolean {
    for (const line of text.split('\n')) {
      if (pattern.test(line)) return true
    }
    return false
  }

  /** Sleep at most `ms`, returning false as soon as `signal` aborts the wait. */
  function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((done) => {
      if (signal?.aborted === true) {
        done(false)
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (completed: boolean): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        done(completed)
      }
      const onAbort = (): void => finish(false)
      timer = setTimeout(() => finish(true), ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Wait for a live job: it returns when the job settles, when a line of output
   * written after the wait began matches `pattern`, when `waitSec` runs out, or
   * when the caller's signal aborts the turn. The job itself is never stopped;
   * only the wait ends. The turn deadline is pushed by the whole wait budget, so
   * a long poll is not charged to the wall-clock cap of the turn.
   */
  async function waitForJob(
    id: string,
    waitSec: number,
    pattern: RegExp | undefined,
    context: { readonly signal?: AbortSignal; readonly extendTimeout?: (extraMs: number) => boolean } | undefined,
  ): Promise<void> {
    context?.extendTimeout?.(waitSec * 1_000)
    const output = liveJobs.get(id)?.output
    // Only output written after this call started can end the wait: an old
    // line that already matched does not turn the call into an instant answer.
    const from = output?.total ?? 0
    const deadline = Date.now() + waitSec * 1_000
    for (;;) {
      if (context?.signal?.aborted === true) return
      const status = jobs.get(id as never).status
      if (status !== 'running' && status !== 'stopping') return
      if (pattern !== undefined && output !== undefined) {
        const fresh = output.clean(from, output.total)
        if (fresh !== '' && matchesLine(fresh, pattern)) return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return
      if (!(await pause(Math.min(STATUS_WAIT_POLL_MS, remaining), context?.signal))) return
    }
  }

  const tools: RunnerTool[] = [
    {
      name: 'exec',
      ...(guest ? { guest: GUEST_EXEC_DEFINITION } : {}),
      get description(): string {
        return (
          'Run a shell command in an isolated sandbox. The workspace is writable; the rest of the machine is ' +
          'not. The sandbox has its own network namespace with no direct route out: the public internet is ' +
          'reached through the daemon proxy (http_proxy, https_proxy and all_proxy), which resolves names and ' +
          'allows public addresses only. Local, private, loopback, link-local and cloud metadata addresses ' +
          '(for example 169.254.169.254) are closed by IP and by name, so a web_fetch refusal because of an ' +
          'address must not be routed around through exec. Dangerous commands need the owner to press an ' +
          'approval button. For a long command use background=true: it returns a job id at once, and ' +
          'exec_status with wait_sec (optionally with pattern) waits for that job, so do not sleep in ' +
          'exec to poll it. Job tools: exec_status, exec_write, exec_list and exec_stop. Secrets are ' +
          'passed by name in `secrets` and become environment variables; their values never appear in ' +
          `the output. ${secretNamesText()}`
        )
      },
      get inputSchema(): Record<string, unknown> {
        return {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command line to run with bash -c.' },
            purpose: {
              type: 'string',
              description:
                'Why you are running the command, in your own words. Required when the owner has to confirm a ' +
                'command: the approval card shows it in a signed «Зачем (со слов бота)» block before the ' +
                'explanation built from the command itself.',
            },
            timeout_sec: {
              type: 'number',
              description: 'Foreground timeout in seconds (default 120, maximum 600).',
            },
            background: {
              type: 'boolean',
              description: 'Start the command as a background job and return its id immediately.',
            },
            secrets: {
              type: 'array',
              items: { type: 'string' },
              description: `Names of secrets to pass as environment variables. ${secretNamesText()}`,
            },
          },
          required: ['command'],
        }
      },
      async execute(args) {
        const command = args.command
        if (typeof command !== 'string' || command.trim() === '') {
          throw new Error('exec: command must be a non-empty string')
        }
        if (guest) {
          await admit(command, undefined, true)
          // A guest has no background tools, no secrets and no time beyond the
          // guest cap: every extra argument of a forged call is ignored.
          return runForeground(command, args.timeout_sec, undefined)
        }
        const purpose = typeof args.purpose === 'string' ? args.purpose : undefined
        await admit(command, options.approval, false, purpose, true)
        const extraEnv = secretEnvironment(args.secrets)
        if (args.background === true) return startBackground(command, extraEnv)
        return runForeground(command, args.timeout_sec, args.secrets)
      },
    },
    {
      name: 'exec_status',
      description:
        'Show the state, the exit code and the output of a background exec job. Without wait_sec it ' +
        'answers at once. With wait_sec (whole seconds, 1 to 600) the call waits until the job finishes, ' +
        'until a line of output written during the wait matches the optional pattern (a regular ' +
        'expression), or until wait_sec runs out, and then answers with the same status and output: a job ' +
        'that ends early is reported right away. A finished job answers at once. For long background work ' +
        'start it with exec background=true and wait here with wait_sec (optionally pattern) instead of ' +
        'sleeping in exec. Without offset it returns the tail. With offset and ' +
        'limit (characters) it returns the page that starts at that byte position of the stream and the ' +
        'next offset, so a long log is read in order without gaps or repeats. The retained window is ' +
        '4 MiB; when the oldest output was dropped the answer names the offset it is available from.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job id returned by exec with background=true.' },
          offset: {
            type: 'number',
            description: 'Byte position in the output to read from; omit for the tail of the whole output.',
          },
          limit: {
            type: 'number',
            description: 'Maximum characters of the page (default 12000, maximum 200000).',
          },
          wait_sec: {
            type: 'integer',
            minimum: 1,
            maximum: 600,
            description:
              'Seconds to wait for the job to finish or for pattern to match; omit to answer at once.',
          },
          pattern: {
            type: 'string',
            maxLength: MAX_WAIT_PATTERN_CHARS,
            description:
              'Regular expression matched against each line written during the wait; requires wait_sec. ' +
              'The wait ends on the first matching line.',
          },
        },
        required: ['id'],
      },
      async execute(args, context) {
        const id = args.id
        if (typeof id !== 'string' || id === '') throw new Error('exec_status: id must be a non-empty string')
        const waitSec = readWaitSec(args.wait_sec)
        const pattern = readWaitPattern(args.pattern, waitSec)
        const initial = jobs.get(id as never)
        if (waitSec !== undefined && (initial.status === 'running' || initial.status === 'stopping')) {
          await waitForJob(id, waitSec, pattern, context)
        }
        const view = jobs.get(id as never)
        const state = liveJobs.get(id)
        const output = state?.output
        const detail = view.detail === undefined ? '' : ` (${view.detail})`
        if (args.offset !== undefined) {
          const from = readOffset(args.offset)
          const limit = readLimit(args.limit)
          const page = output === undefined
            ? { text: '', start: 0, next: 0, earliest: 0, total: 0, lossy: false }
            : output.read(from, limit)
          const pageText = output === undefined ? '' : output.clean(page.start, page.next)
          const lost = page.lossy
            ? `\n--- начало вывода потеряно, доступно с offset ${page.earliest} ---`
            : ''
          return (
            `Статус: ${view.status}${detail}\n` +
            `--- вывод: offset ${page.start}, ${Buffer.byteLength(pageText, 'utf8')} из ${page.total} байт ---\n` +
            `${frameData(pageText, { source: 'exec_status' })}\n` +
            `--- next offset: ${page.next} ---${lost}`
          )
        }
        const tail = output === undefined ? '' : output.tail(DEFAULT_TAIL_CHARS)
        const tailStart = output === undefined ? 0 : output.total - Buffer.byteLength(tail, 'utf8')
        const text = output === undefined ? '' : output.clean(tailStart, output.total)
        const body =
          tail === ''
            ? '(пока пусто)'
            : output !== undefined && output.total > Buffer.byteLength(tail, 'utf8')
              ? `…[показан хвост: ${tail.length} символов из ${output.total} байт вывода]\n${text}`
              : text
        const lost =
          output !== undefined && output.earliest > 0
            ? `\n--- начало вывода потеряно, доступно с offset ${output.earliest} ---`
            : ''
        const cacheKey =
          `${id}\u0000${view.status}\u0000${detail}\u0000` +
          `${output?.total ?? 0}\u0000${output?.earliest ?? 0}\u0000${body}`
        const cached = tailAnswers.get(cacheKey)
        if (cached !== undefined) return cached
        const answer = `Статус: ${view.status}${detail}\n--- вывод (хвост) ---\n${frameData(body, { source: 'exec_status' })}${lost}`
        tailAnswers.set(cacheKey, answer)
        if (tailAnswers.size > 16) {
          const oldest = tailAnswers.keys().next()
          if (!oldest.done) tailAnswers.delete(oldest.value)
        }
        return answer
      },
    },
    {
      name: 'exec_stop',
      description: 'Stop a background exec job; the process and its children are killed.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Job id returned by exec with background=true.' } },
        required: ['id'],
      },
      execute(args) {
        const id = args.id
        if (typeof id !== 'string' || id === '') throw new Error('exec_stop: id must be a non-empty string')
        const outcome = jobs.kill(id as never)
        return outcome === 'requested'
          ? `Задача ${id}: остановка запрошена.`
          : `Задача ${id}: уже завершена.`
      },
    },
    {
      name: 'exec_write',
      description:
        'Write one line to the stdin of a live background exec job. The line passes the same guard and ' +
        'owner approval as a command, so a dangerous line needs the owner to press the button. A finished ' +
        'or unknown job is an error: nothing is written to a process that is gone.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job id returned by exec with background=true.' },
          text: { type: 'string', description: 'Line to send to the stdin of the job; a newline is added.' },
        },
        required: ['id', 'text'],
      },
      async execute(args) {
        const id = args.id
        if (typeof id !== 'string' || id === '') throw new Error('exec_write: id must be a non-empty string')
        const text = args.text
        if (typeof text !== 'string') throw new Error('exec_write: text must be a string')
        const view = jobs.get(id as never)
        const state = liveJobs.get(id)
        const stdin = state?.stdin
        if (state === undefined || state.settled || view.status !== 'running' || stdin === undefined || stdin.destroyed) {
          throw new Error(`exec_write: задача ${id} не принимает ввод (${view.status})`)
        }
        // The line reaches the command's stdin, so it passes the same guard and
        // the same owner card as a command line: a denied line is never written,
        // and a confirmation-class line waits for the owner's allow.
        await admit(text, options.approval)
        const line = text.endsWith('\n') ? text : `${text}\n`
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`exec_write: задача ${id} не приняла запись за 10 с`)), 10_000)
          stdin.write(line, (error) => {
            clearTimeout(timer)
            if (error === null || error === undefined) resolve()
            else reject(new Error(`exec_write: запись в задачу ${id} не удалась: ${error.message}`))
          })
        })
        return `Запись отправлена в stdin задачи ${id}.`
      },
    },
    {
      name: 'exec_list',
      description:
        'List the background exec jobs of this bot: id, the beginning of the command, the state (running or ' +
        'finished), the exit code and the start time.',
      inputSchema: { type: 'object', properties: {} },
      execute() {
        const views = jobs.list()
        if (views.length === 0) return 'Фоновых задач нет.'
        const lines = views.map(
          (view) =>
            `- ${view.id} «${oneLine(view.label)}» — ${listStatus(view.status)}${jobDetail(view)}, ` +
            `запущена ${new Date(view.startedAt).toISOString()}`,
        )
        return `Фоновые задачи (${views.length}):\n${lines.join('\n')}`
      },
    },
  ]

  let stopped: Promise<void> | undefined
  return {
    tools,
    background,
    runDirect,
    stop(): Promise<void> {
      stopped ??= (async () => {
        // The proxy goes first: after this line the sandbox has no exit at all,
        // even if disposing a running command takes a moment.
        proxy?.stop()
        if (networkDir !== undefined) {
          try {
            rmSync(networkDir, { recursive: true, force: true })
          } catch {
            // The socket directory is already gone.
          }
        }
        detachController()
        // Disposing the context terminates live jobs and awaited sandboxed processes.
        await ctx.fiber.dispose()
      })()
      return stopped
    },
  }
}
