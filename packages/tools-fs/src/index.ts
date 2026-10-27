// Compact `read`, `edit`, `list` and `grep` tools of the bot over `node:fs`.
//
// The harness ships a model-facing file package of its own, but mounting it
// brings a schema and prompt section the bot cannot afford (docs/research/
// capability-gaps.md, "Принцип подключения"). This package keeps the four tools
// small and puts the policy the charter needs in code:
//
//   * two roots: `DSHBOT_HOME/workspace` (read-write) and `DSHBOT_HOME/app`
//     (the bot's own code, read-only). Every tool's description names both
//     absolute paths, so the model never guesses a root. Everything outside is
//     refused, including escapes through `..` and symlinks (checked on the real
//     path);
//   * `read` returns numbered lines, pages with `offset`/`limit`, bounds the
//     answer size and describes binaries instead of dumping them;
//   * `edit` replaces exactly one occurrence, creates new files, requires a
//     prior read and refuses when the file changed on disk since that read;
//     writes are atomic (temporary file + rename);
//   * `list` starts with the absolute path of the listed directory, then shows
//     its entries as paths relative to that base, with kind and size, sorted by
//     name, capped at 500 entries; it never follows a symlink out of a root;
//   * `grep` searches contents and answers `absolute-path:line:text`, capped at
//     200 matches and 2000 files, skipping binaries, files over 2 MB and
//     vendored `node_modules`/`.git` directories;
//   * `write` creates or replaces a whole file from text or base64 bytes (and
//     appends with `append: true`), only in a read-write root and under a 20 MB
//     cap;
//   * `guard.isProtected` paths are listed but never written or read by `grep`;
//   * the key material and the credential stores of the owner (`~/.ssh`,
//     `~/.gnupg`, cloud and registry tokens, git and package manager files,
//     CLI-agent accounts, keyrings and browser profiles) plus `~/.config/dshbot`
//     and DSHBOT_HOME outside its default roots stay hidden even inside a root
//     the owner declared.
//
// The tool shape below is structural: it matches the `RunnerTool` item of the
// runner tool seam (`name`, `description`, `inputSchema`, `execute(args)`), so
// this package depends on neither the runner nor the harness tool package.
//
// Read-before-write evidence lives in a per-instance store. The runner seam
// hands `execute` only the model arguments, not the session id, but the daemon
// gives these tools to the owner's `main` session alone (a guest gets none), so
// one store per runner instance is exactly one session's evidence.
//
// Tests live in packages/app/fs-tools.test.ts: the daemon is exercised through a
// fake Telegram Bot API and a local DeepSeek stub.

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { frameData } from '../../app/src/untrusted-frame.js'
import { isProtected } from '../../guard/src/index.js'
import {
  snapshotCreatedFile,
  snapshotExistingFile,
  snapshotsDir,
  SNAPSHOT_SKIPPED_NOTE,
  type SnapshotSave,
} from './snapshots.js'

export {
  listSnapshots,
  rollbackSnapshot,
  snapshotsDir,
  SNAPSHOT_LIST_LIMIT,
  SNAPSHOT_MAX_COUNT,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  SNAPSHOT_SKIPPED_NOTE,
} from './snapshots.js'
export type { SnapshotRecord, SnapshotRollback, SnapshotSave } from './snapshots.js'

/** Name of the read tool as the model sees it. */
export const READ_TOOL_NAME = 'read'

/** Name of the edit tool as the model sees it. */
export const EDIT_TOOL_NAME = 'edit'

/** Name of the directory overview tool as the model sees it. */
export const LIST_TOOL_NAME = 'list'

/** Name of the content search tool as the model sees it. */
export const GREP_TOOL_NAME = 'grep'

/** Name of the binary-safe whole-file writer as the model sees it. */
export const WRITE_TOOL_NAME = 'write'

/** All tool names. */
export const FS_TOOL_NAMES = [READ_TOOL_NAME, EDIT_TOOL_NAME, LIST_TOOL_NAME, GREP_TOOL_NAME, WRITE_TOOL_NAME] as const

/** Lines returned when the caller gives no `limit`. */
const DEFAULT_LINE_LIMIT = 2_000

/** A single line longer than this is clipped (minified files, base64 blobs). */
const MAX_LINE_CHARS = 2_000

/** Upper bound of the text answer of one `read`, marking the cut when exceeded. */
const MAX_READ_OUTPUT_CHARS = 20_000

/** Prefix read when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8_192

/** Entries returned by one `list` before the answer is cut. */
const LIST_LIMIT = 500

/** Safety valve for one recursive `list`; a real corpus stays far below it. */
const MAX_WALK_ENTRIES = 50_000

/** Matches returned by one `grep` before the answer is cut. */
const GREP_MATCH_LIMIT = 200

/** Files one `grep` examines before it stops. */
const GREP_FILE_LIMIT = 2_000

/** Files larger than this are not searched. */
const GREP_MAX_FILE_BYTES = 2 * 1_024 * 1_024

/** Vendored directories a search walks past unless the caller names them. */
const SKIPPED_DIRECTORIES = ['node_modules', '.git'] as const

/** Hard cap of one `write` payload, in bytes. */
export const WRITE_MAX_BYTES = 20 * 1_024 * 1_024

/** The cap as the refusal names it. */
const WRITE_MAX_TEXT = `20 MB (${WRITE_MAX_BYTES} bytes)`

/** One allowed directory with its write permission. */
export interface FsRoot {
  /** Directory the tool may touch. Relative paths resolve against the first root. */
  readonly path: string
  /** Read-only roots allow `read` and refuse every write. */
  readonly readOnly?: boolean
}

/**
 * A path that stays hidden even inside an allowed root.
 *
 * `allow` names the descendants that remain visible: the default roots inside
 * DSHBOT_HOME (the workspace, the bot's code and the candidates).
 */
export interface HiddenPath {
  readonly path: string
  readonly allow?: readonly string[]
}

/**
 * Directories of the owner that hold credentials as a whole: keys, cloud and
 * registry tokens, CLI-agent accounts, keyrings and browser profiles with
 * cookies. They stay hidden even when the owner declares HOME as a root.
 */
const HIDDEN_CREDENTIAL_DIRECTORIES = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.claude',
  '.codex',
  '.mozilla',
  '.password-store',
  '.local/share/keyrings',
  '.config/dshbot',
  '.config/gh',
  '.config/typesafe',
  '.config/gcloud',
  '.config/google-chrome',
  '.config/chromium',
] as const

/**
 * Single credential files of the owner that live directly in HOME, so hiding
 * their directory would hide the rest of HOME too.
 */
const HIDDEN_CREDENTIAL_FILES = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.claude.json'] as const

/**
 * The key material and the credential stores of the owner that the tools never
 * expose: the directories of {@link HIDDEN_CREDENTIAL_DIRECTORIES}, the files
 * of {@link HIDDEN_CREDENTIAL_FILES}, the private state of the bot
 * (`~/.config/dshbot`) and DSHBOT_HOME outside its default roots. The paths are
 * resolved through symlinks as far as they exist.
 */
export function hiddenFsPaths(ownerHome: string, dshbotHome: string, allow: readonly string[]): HiddenPath[] {
  return [
    ...HIDDEN_CREDENTIAL_DIRECTORIES.map((relative) => ({ path: realPathOf(join(ownerHome, relative)) })),
    ...HIDDEN_CREDENTIAL_FILES.map((relative) => ({ path: realPathOf(join(ownerHome, relative)) })),
    { path: realPathOf(dshbotHome), allow: allow.map((entry) => realPathOf(entry)) },
  ]
}

/** Options of {@link createFsTools}. */
export interface FsToolOptions {
  /** `DSHBOT_HOME`; the default roots and the protected root live under it. */
  readonly home: string
  /**
   * Directories the tools may reach, in preference order. Defaults to
   * {@link defaultFsRoots} — `workspace` and `app` under {@link home}.
   */
  readonly roots?: readonly FsRoot[]
  /** Paths hidden even inside a root; see {@link hiddenFsPaths}. */
  readonly hidden?: readonly HiddenPath[]
  /** Repository root for `guard.isProtected`; defaults to `app` under {@link home}. */
  readonly protectedRoot?: string
}

/** A tool definition shaped like the runner tool seam's `RunnerTool`. */
export interface FsTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  /** See {@link RunnerTool.isConcurrencySafe}: only the read-only tools opt in. */
  isConcurrencySafe?(args: unknown): boolean
  execute(args: Record<string, unknown>): unknown
}

/** The production layout: workspace is writable, the bot's own code is read-only. */
export function defaultFsRoots(home: string): FsRoot[] {
  return [
    { path: join(home, 'workspace') },
    { path: join(home, 'app'), readOnly: true },
  ]
}

interface Root {
  readonly path: string
  readonly readOnly: boolean
}

/** What a successful read recorded for read-before-write. */
interface ReadStamp {
  readonly size: number
  readonly mtimeMs: number
  readonly ino: number
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

/**
 * Resolve symlinks in `path` as far as the filesystem allows.
 *
 * A path that does not exist yet is resolved through its nearest existing
 * parent, so the missing leaf cannot be used to step outside a root and a
 * symlinked parent still yields its real target.
 */
function realPathOf(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : resolve(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/** `root` with exactly one trailing separator, so the filesystem root `/` stays `/`. */
function withSep(root: string): string {
  return root.endsWith(sep) ? root : `${root}${sep}`
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(withSep(root))
}

/** Slash-separated path relative to `base`; `path` itself when it is not below `base`. */
function relativePath(base: string, path: string): string {
  if (path === base) return ''
  const prefix = withSep(base)
  if (path.startsWith(prefix)) return path.slice(prefix.length).split(sep).join('/')
  return path.split(sep).join('/')
}

/** Longest match wins, so a writable root nested in a read-only one stays writable. */
function matchRoot(path: string, roots: readonly Root[]): Root | undefined {
  let found: Root | undefined
  for (const root of roots) {
    if (!isWithin(path, root.path)) continue
    if (found === undefined || root.path.length > found.path.length) found = root
  }
  return found
}

function stampOf(path: string): ReadStamp {
  const stats = statSync(path)
  return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino }
}

function sameStamp(left: ReadStamp, right: ReadStamp): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino
}

function sniff(path: string): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const read = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** A NUL byte or a noticeable share of control bytes means "not a text file". */
function looksBinary(head: Buffer): boolean {
  if (head.length === 0) return false
  let control = 0
  for (const byte of head) {
    if (byte === 0) return true
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  }
  return control / head.length > 0.01
}

/** The `grep` rule: a NUL byte in the first 8 KB marks a binary file. */
function hasNul(head: Buffer): boolean {
  return head.includes(0)
}

function escapeRegExpChar(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
}

/**
 * Translate one glob to a regular expression over slash-separated paths.
 *
 * `*` stays inside one path segment, `**` crosses separators (`**\/` also
 * matches zero directories), `?` is one non-separator character, and every
 * other character is literal. No brace or character-class extension: the
 * tools need the two forms the model actually writes.
 */
function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += escapeRegExpChar(char)
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Match a relative path against a glob. A pattern without `/` is a file-name
 * pattern at any depth, like the usual search tools; a pattern with `/` is
 * matched against the whole relative path.
 */
function matchesGlob(relativePath: string, glob: string): boolean {
  const candidate = glob.includes('/') ? relativePath : basename(relativePath)
  return globToRegExp(glob).test(candidate)
}

/** One entry of a `list` answer. */
interface ListEntry {
  readonly rel: string
  readonly kind: 'dir' | 'file' | 'link' | 'other'
  readonly size: number
}

function kindOf(stats: Stats): ListEntry['kind'] {
  if (stats.isSymbolicLink()) return 'link'
  if (stats.isDirectory()) return 'dir'
  if (stats.isFile()) return 'file'
  return 'other'
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.some((directory) => directory === name)
}

/** First line of a directory `list` answer: the absolute base the entries are relative to. */
function formatListBase(base: string): string {
  return `Каталог: ${base}`
}

/** One line of a `list` answer: kind, relative path and size. */
function formatListEntry(entry: ListEntry): string {
  const label = entry.kind === 'dir' ? 'dir' : entry.kind === 'file' ? 'file' : entry.kind
  const suffix = entry.kind === 'dir' ? '/' : ''
  return `${label}  ${entry.rel}${suffix}  ${entry.size} bytes`
}

/** Files one `grep` walk found, with the path shown to the model. */
interface GrepFile {
  readonly path: string
  readonly rel: string
  readonly size: number
}

/** Write `content` through a temporary file in the same directory and rename it. */
function atomicWrite(path: string, content: string | Buffer, mode: number): void {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', mode)
    if (typeof content === 'string') writeSync(fd, content, null, 'utf8')
    else writeSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // the write already failed; the original error is the one to report
      }
    }
    try {
      unlinkSync(temporary)
    } catch {
      // nothing was created or the rename already moved it
    }
    throw error
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let at = text.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = text.indexOf(needle, at + needle.length)
  }
  return count
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/** Bytes of one `write` call: exactly one of `content` (UTF-8) and `content_base64`. */
function writeContentOf(args: Record<string, unknown>): Buffer {
  const text = stringArg(args, 'content')
  const encoded = stringArg(args, 'content_base64')
  if ((text === undefined) === (encoded === undefined)) {
    throw new Error('write needs exactly one of content or content_base64')
  }
  if (text !== undefined) return Buffer.from(text, 'utf8')
  const compact = (encoded as string).replace(/\s+/g, '')
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error('content_base64 is not valid base64')
  }
  return Buffer.from(compact, 'base64')
}

/** `offset`/`limit` as positive integers; anything else falls back to the default. */
function countArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.trunc(value))
}

/** Mode bits of an existing file, so an atomic replace keeps its permissions. */
function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

/** The sentence a tool answer carries when the previous version was too big to keep. */
function snapshotNoteOf(saved: SnapshotSave): string {
  return saved.status === 'too-big' ? ` ${SNAPSHOT_SKIPPED_NOTE}` : ''
}

/**
 * Create the `read` and `edit` tool definitions bound to one root list.
 *
 * The returned definitions are ready for the runner tool seam. All state
 * (read-before-write stamps) is private to this call, so one daemon owns one
 * policy and tests can build isolated instances.
 */
export function createFsTools(options: FsToolOptions): FsTool[] {
  if (options.home.trim() === '') throw new Error('fs tools need DSHBOT_HOME')
  const home = resolve(options.home)
  const specs = options.roots ?? defaultFsRoots(home)
  if (specs.length === 0) throw new Error('fs tools need at least one root')

  const roots: Root[] = specs.map((spec) => {
    if (spec.path.trim() === '') throw new Error('fs root must not be empty')
    if (!isAbsolute(spec.path)) throw new Error(`fs root must be absolute: ${spec.path}`)
    return { path: realPathOf(spec.path), readOnly: spec.readOnly === true }
  })
  const protectedRoot = realPathOf(options.protectedRoot ?? join(home, 'app'))
  const fallbackRoot = roots[0] as Root
  // The previous versions of files the tools change live here; `/rollback`
  // reads the same directory. It is outside the roots, so the model itself
  // cannot read or rewrite snapshots through a tool.
  const snapshotsRoot = snapshotsDir(home)
  const hidden: Array<{ path: string; allow: string[] }> = (options.hidden ?? []).map((entry) => ({
    path: realPathOf(entry.path),
    allow: (entry.allow ?? []).map((allowed) => realPathOf(allowed)),
  }))

  /** True for a path the owner's key material and private bot state live under. */
  function isHidden(real: string): boolean {
    for (const entry of hidden) {
      if (!isWithin(real, entry.path)) continue
      if (entry.allow.some((allowed) => isWithin(real, allowed))) continue
      return true
    }
    return false
  }

  function refuseHidden(real: string): void {
    if (isHidden(real)) {
      throw new Error(`path is hidden and cannot be read or written: ${real}`)
    }
  }

  /** The allowed descendants of a hidden directory that a walk may still enter. */
  function visibleBranches(directory: string): string[] {
    const branches = new Set<string>()
    for (const entry of hidden) {
      if (!isWithin(entry.path, directory)) continue
      for (const allowed of entry.allow) {
        if (isWithin(allowed, directory)) branches.add(allowed)
      }
    }
    return [...branches]
  }

  // Every tool description carries the absolute roots and their permission. The
  // text is built once from the resolved roots, so it is byte-identical on every
  // turn and the model never has to guess where "workspace" or "app" live.
  const rootsSummary = `Roots: ${roots
    .map((root) =>
      root.readOnly
        ? `${root.path} (read-only: read only, no writes)`
        : `${root.path} (read-write: read and write)`,
    )
    .join('; ')}. Relative paths resolve against ${fallbackRoot.path}.`

  const readStamps = new Map<string, ReadStamp>()

  function absolutePath(input: string): string {
    if (input.trim() === '') throw new Error('path is required')
    return isAbsolute(input) ? resolve(input) : resolve(fallbackRoot.path, input)
  }

  /**
   * Resolve `input` to its real path and the root that owns it. Containment is
   * decided on the real path, so `..` and symlinks cannot leave the roots.
   */
  function locate(input: string): { real: string; root: Root } {
    const absolute = absolutePath(input)
    const real = realPathOf(absolute)
    const root = matchRoot(real, roots)
    if (root === undefined) throw new Error(`path is outside the allowed roots: ${absolute}`)
    refuseHidden(real)
    return { real, root }
  }

  /**
   * Resolve a write target. The last component is resolved even when it is a
   * dangling symlink, so a link that points out of the roots is refused instead
   * of being replaced by a rename.
   */
  function locateForWrite(input: string): { real: string; root: Root } {
    const absolute = absolutePath(input)
    let real = realPathOf(absolute)
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        const target = resolve(dirname(absolute), readlinkSync(absolute))
        real = realPathOf(target)
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const root = matchRoot(real, roots)
    if (root === undefined) throw new Error(`path is outside the allowed roots: ${absolute}`)
    refuseHidden(real)
    return { real, root }
  }

  function refuseProtected(real: string): void {
    if (isProtected(real, protectedRoot)) {
      throw new Error(`path is protected by the charter and cannot be edited: ${real}`)
    }
  }

  /** Entries of one directory, sorted by relative path. Symlinks are listed, never followed. */
  function walkListing(
    base: string,
    recursive: boolean,
    glob: string | undefined,
  ): { entries: ListEntry[]; truncated: boolean } {
    const entries: ListEntry[] = []
    let visited = 0
    let truncated = false
    const include = (rel: string): boolean => glob === undefined || matchesGlob(rel, glob)

    const visit = (directory: string, prefix: string): void => {
      let children: Dirent[]
      try {
        children = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      children.sort((left, right) => compareNames(left.name, right.name))
      for (const child of children) {
        if (visited >= MAX_WALK_ENTRIES) {
          truncated = true
          return
        }
        const full = join(directory, child.name)
        const rel = prefix === '' ? child.name : `${prefix}/${child.name}`
        if (isHidden(full)) {
          // A hidden tree stays out of the answer, but the default roots nested
          // in it (the workspace inside DSHBOT_HOME) are still visible.
          if (recursive) {
            for (const branch of visibleBranches(full)) {
              let branchStats: Stats
              try {
                branchStats = statSync(branch)
              } catch {
                continue
              }
              if (branchStats.isDirectory()) visit(branch, relativePath(base, branch))
            }
          }
          continue
        }
        let stats: Stats
        try {
          stats = lstatSync(full)
        } catch {
          continue
        }
        visited += 1
        const kind = kindOf(stats)
        if (include(rel)) entries.push({ rel, kind, size: stats.size })
        // A symlinked directory is never descended into: its target may be outside the roots.
        if (recursive && kind === 'dir') {
          visit(full, rel)
          if (truncated) return
        }
      }
    }

    visit(base, '')
    entries.sort((left, right) => compareNames(left.rel, right.rel))
    return { entries, truncated }
  }

  /** Directory names named by the caller's own path are not skipped by `grep`. */
  function explicitDirectories(base: string): Set<string> {
    const parts = base.split(sep)
    return new Set(SKIPPED_DIRECTORIES.filter((name) => parts.includes(name)))
  }

  /** Files under `base`, in name order, without following symlinks or vendored directories. */
  function collectGrepFiles(base: string): { files: GrepFile[]; truncated: boolean } {
    const explicit = explicitDirectories(base)
    const files: GrepFile[] = []
    let truncated = false

    const visit = (directory: string, prefix: string): void => {
      let children: Dirent[]
      try {
        children = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      children.sort((left, right) => compareNames(left.name, right.name))
      for (const child of children) {
        if (truncated) return
        const full = join(directory, child.name)
        const rel = prefix === '' ? child.name : `${prefix}/${child.name}`
        if (isHidden(full)) {
          // Hidden trees are not searched, but their default roots are.
          for (const branch of visibleBranches(full)) {
            let branchStats: Stats
            try {
              branchStats = statSync(branch)
            } catch {
              continue
            }
            if (branchStats.isDirectory()) visit(branch, relativePath(base, branch))
          }
          continue
        }
        let stats: Stats
        try {
          stats = lstatSync(full)
        } catch {
          continue
        }
        // Symlinks are not followed at all: a link out of a root would read outside it.
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) {
          if (!explicit.has(child.name) && isSkippedDirectory(child.name)) continue
          visit(full, rel)
          continue
        }
        if (!stats.isFile()) continue
        if (files.length >= GREP_FILE_LIMIT) {
          truncated = true
          return
        }
        files.push({ path: full, rel, size: stats.size })
      }
    }

    visit(base, '')
    return { files, truncated }
  }

  /**
   * Matching `path:line:text` rows of one file. A protected path, a binary file
   * and a file over the size bound all yield no rows, so their bytes are never
   * turned into model-visible text.
   */
  function grepFile(file: GrepFile, regex: RegExp): string[] {
    if (isProtected(file.path, protectedRoot)) return []
    if (isHidden(file.path)) return []
    if (file.size > GREP_MAX_FILE_BYTES) return []
    try {
      if (hasNul(sniff(file.path))) return []
      const content = readFileSync(file.path, 'utf8')
      const rows: string[] = []
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index] as string
        if (!regex.test(text)) continue
        const clipped = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
        rows.push(`${file.path}:${index + 1}:${clipped}`)
      }
      return rows
    } catch {
      return []
    }
  }

  /**
   * Matching rows of `files`, in walk order, capped at {@link GREP_MATCH_LIMIT}.
   * Both the single-file and the directory branch go through here, so the cap
   * and its truncation mark cannot diverge between them.
   */
  function grepFiles(
    files: readonly GrepFile[],
    regex: RegExp,
    glob: string | undefined,
  ): { rows: string[]; limited: boolean } {
    const rows: string[] = []
    let limited = false
    for (const file of files) {
      if (glob !== undefined && !matchesGlob(file.rel, glob)) continue
      for (const row of grepFile(file, regex)) {
        if (rows.length >= GREP_MATCH_LIMIT) {
          limited = true
          break
        }
        rows.push(row)
      }
      if (limited) break
    }
    return { rows, limited }
  }

  /** The answer of a `grep` run, with a mark when a bound cut it short. */
  function grepAnswer(rows: readonly string[], limited: boolean, filesTruncated: boolean): string {
    const notes: string[] = []
    if (limited) notes.push(`[truncated: showing the first ${GREP_MATCH_LIMIT} matches]`)
    else if (filesTruncated) notes.push(`[truncated: examined the first ${GREP_FILE_LIMIT} files]`)
    if (rows.length === 0 && notes.length === 0) return 'No matches.'
    return [...rows, ...notes].join('\n')
  }

  function lineOf(number: number, text: string): string {
    const clipped = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… [line truncated]` : text
    return `${number}: ${clipped}`
  }

  async function readLines(real: string, offset?: number, limit?: number): Promise<string> {
    const stats = statSync(real)
    if (!stats.isFile()) throw new Error(`not a regular file: ${real}`)
    if (looksBinary(sniff(real))) {
      return `Binary file (${stats.size} bytes), content is not shown.`
    }
    if (stats.size === 0) return 'Empty file (0 bytes).'

    const start = offset ?? 1
    const maxLines = limit ?? DEFAULT_LINE_LIMIT
    const rows: string[] = []
    let length = 0
    let lineNumber = 0
    let lastShown = 0
    let truncated = false

    const stream = createReadStream(real, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const text of lines) {
        lineNumber += 1
        if (lineNumber < start) continue
        if (rows.length >= maxLines) {
          truncated = true
          break
        }
        const row = lineOf(lineNumber, text)
        if (length + row.length + 1 > MAX_READ_OUTPUT_CHARS) {
          truncated = true
          break
        }
        rows.push(row)
        length += row.length + 1
        lastShown = lineNumber
      }
    } finally {
      lines.close()
      stream.destroy()
    }

    if (rows.length === 0) {
      return `No lines to show: the file has ${lineNumber} line(s) and offset ${start} is past its end.`
    }

    const body = rows.join('\n')
    return truncated
      ? `${body}\n[truncated: showing lines ${start}-${lastShown}; use offset ${lastShown + 1} to continue]`
      : body
  }

  function editExisting(real: string, args: Record<string, unknown>): string {
    const known = readStamps.get(real)
    if (known === undefined) {
      throw new Error('refusing to edit a file that was not read in this session; read it first')
    }
    if (!sameStamp(known, stampOf(real))) {
      throw new Error('the file changed on disk since it was read; read it again before editing')
    }

    const oldString = stringArg(args, 'old_string')
    if (oldString === undefined || oldString.length === 0) {
      throw new Error('old_string must be a non-empty string when editing an existing file')
    }
    const replacement = stringArg(args, 'new_string') ?? stringArg(args, 'content') ?? ''
    const before = readFileSync(real, 'utf8')
    const matches = countOccurrences(before, oldString)
    if (matches !== 1) {
      throw new Error(`old_string occurs ${matches} time(s) in the file; it must occur exactly once`)
    }

    const at = before.indexOf(oldString)
    const after = before.slice(0, at) + replacement + before.slice(at + oldString.length)
    // The version before the change is kept first: a failed write or a wrong
    // edit is then recoverable through `/rollback`.
    const note = snapshotNoteOf(snapshotExistingFile(snapshotsRoot, real, EDIT_TOOL_NAME))
    atomicWrite(real, after, statMode(real))
    readStamps.set(real, stampOf(real))
    return `Edited ${real}: replaced 1 occurrence.${note}`
  }

  function createNew(real: string, args: Record<string, unknown>): string {
    const oldString = stringArg(args, 'old_string')
    if (oldString !== undefined && oldString.length > 0) {
      throw new Error('old_string was given but the file does not exist; pass content to create it')
    }
    const content = stringArg(args, 'content') ?? stringArg(args, 'new_string')
    if (content === undefined) {
      throw new Error('the file does not exist; pass content to create it')
    }
    mkdirSync(dirname(real), { recursive: true })
    // A marker instead of content: rolling the creation back deletes the file.
    snapshotCreatedFile(snapshotsRoot, real, EDIT_TOOL_NAME)
    atomicWrite(real, content, 0o644)
    readStamps.set(real, stampOf(real))
    return `Created ${real}.`
  }

  const readTool: FsTool = {
    name: READ_TOOL_NAME,
    description:
      'Read a text file and return its lines with 1-based line numbers. Use offset and limit to page ' +
      'through large files. Binary files are described instead of returned. ' +
      rootsSummary,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path; absolute or relative to the workspace.' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return, 1-based. Default 1.' },
        limit: { type: 'integer', minimum: 1, description: `Maximum number of lines, default ${DEFAULT_LINE_LIMIT}.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
    // A read only touches the private read-before-write stamps of its own
    // instance; concurrent reads of one step commute and never change a file.
    isConcurrencySafe: () => true,
    async execute(args) {
      const input = stringArg(args, 'path')
      if (input === undefined) throw new Error('path is required')
      const { real } = locate(input)
      let text: string
      try {
        text = await readLines(real, countArg(args, 'offset'), countArg(args, 'limit'))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new Error(`file not found: ${input}`)
        throw error
      }
      // A read is valid evidence for a later edit even when the answer was cut.
      readStamps.set(real, stampOf(real))
      // The file belongs to the world outside the trust boundary: its text is
      // data of the `read` tool, not instructions, and gets the common frame.
      return frameData(text, { source: 'read' })
    },
  }

  const editTool: FsTool = {
    name: EDIT_TOOL_NAME,
    description:
      'Replace exactly one occurrence of old_string with new_string in an existing file, or create a file ' +
      'with content. An existing file must have been read in this session and must be unchanged since that ' +
      'read. Protected paths are never written and writes are atomic. ' +
      rootsSummary,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path; absolute or relative to the workspace.' },
        old_string: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
        new_string: { type: 'string', description: 'Replacement text; empty string deletes the match.' },
        content: { type: 'string', description: 'Whole content when creating a new file.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute(args) {
      const input = stringArg(args, 'path')
      if (input === undefined) throw new Error('path is required')
      const { real, root } = locateForWrite(input)
      refuseProtected(real)
      if (root.readOnly) throw new Error(`path is in a read-only root and cannot be edited: ${input}`)

      let stats: ReturnType<typeof statSync> | undefined
      try {
        stats = statSync(real)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        stats = undefined
      }
      if (stats !== undefined && !stats.isFile()) throw new Error(`not a regular file: ${input}`)

      return stats === undefined ? createNew(real, args) : editExisting(real, args)
    },
  }

  const writeTool: FsTool = {
    name: WRITE_TOOL_NAME,
    description:
      'Create a file or replace its whole content from text (content) or from exact bytes (content_base64, ' +
      'for binary files), or append to its end with append true. Writing is allowed only in a read-write root; ' +
      `a payload over ${WRITE_MAX_TEXT} is refused and the file stays untouched. Protected and hidden paths are ` +
      'never written. ' +
      rootsSummary,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path; absolute or relative to the workspace.' },
        content: { type: 'string', description: 'Whole text content (UTF-8) to write.' },
        content_base64: { type: 'string', description: 'Whole content as base64, for binary files.' },
        append: { type: 'boolean', description: 'Append to the end of the file instead of replacing it.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute(args) {
      const input = stringArg(args, 'path')
      if (input === undefined) throw new Error('path is required')
      const data = writeContentOf(args)
      if (data.length > WRITE_MAX_BYTES) {
        throw new Error(
          `write refused: content is ${data.length} bytes, the limit is ${WRITE_MAX_TEXT}; nothing was written`,
        )
      }
      const append = args.append === true
      const { real, root } = locateForWrite(input)
      refuseProtected(real)
      if (root.readOnly) throw new Error(`path is in a read-only root and cannot be written: ${input}`)

      let stats: Stats | undefined
      try {
        stats = lstatSync(real)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        stats = undefined
      }
      if (stats !== undefined && !stats.isFile()) throw new Error(`not a regular file: ${input}`)

      mkdirSync(dirname(real), { recursive: true })
      // Keep the version before the change. A file that does not exist yet is
      // marked as created, so a rollback of this snapshot deletes it.
      const note =
        stats === undefined
          ? snapshotNoteOf({ status: 'created', record: snapshotCreatedFile(snapshotsRoot, real, WRITE_TOOL_NAME) })
          : snapshotNoteOf(snapshotExistingFile(snapshotsRoot, real, WRITE_TOOL_NAME))
      if (append) {
        const fd = openSync(real, 'a', 0o644)
        try {
          writeSync(fd, data)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } else {
        atomicWrite(real, data, stats === undefined ? 0o644 : stats.mode & 0o777)
      }
      readStamps.set(real, stampOf(real))
      const bytes = data.length
      return append ? `Appended ${bytes} bytes to ${real}.${note}` : `Wrote ${real} (${bytes} bytes).${note}`
    },
  }

  const listTool: FsTool = {
    name: LIST_TOOL_NAME,
    description:
      'List a directory without reading file contents: the first line is the absolute path of the listed ' +
      'directory ("Каталог: <path>") and every entry line follows with its kind (dir, file or link), path ' +
      'relative to that base and size in bytes. Entries are sorted by name; use ' +
      `recursive to descend and glob (for example "*.md" or "**/*.ts") to filter. At most ${LIST_LIMIT} ` +
      'entries are returned and the answer says when it was cut. Symlinks are shown but never followed. ' +
      rootsSummary,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory or file; absolute or relative to the first root. Default: the workspace root.',
        },
        glob: { type: 'string', description: 'Glob filter over the names, e.g. "*.md" or "**/*.ts".' },
        recursive: { type: 'boolean', description: 'Descend into subdirectories. Default false.' },
      },
      additionalProperties: false,
    },
    // A listing walks the filesystem and writes nothing.
    isConcurrencySafe: () => true,
    execute(args) {
      const given = stringArg(args, 'path')
      const input = given === undefined || given.trim() === '' ? fallbackRoot.path : given
      const { real } = locate(input)
      let stats: Stats
      try {
        stats = lstatSync(real)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new Error(`path not found: ${input}`)
        throw error
      }

      const globArg = stringArg(args, 'glob')
      const glob = globArg === undefined || globArg.trim() === '' ? undefined : globArg.trim()

      if (!stats.isDirectory()) {
        const entry: ListEntry = { rel: basename(real), kind: kindOf(stats), size: stats.size }
        if (glob !== undefined && !matchesGlob(entry.rel, glob)) return `No entries match ${glob}.`
        return formatListEntry(entry)
      }

      const walked = walkListing(real, args.recursive === true, glob)
      const shown = walked.entries.slice(0, LIST_LIMIT)
      if (shown.length === 0) {
        const empty = glob === undefined ? 'Empty directory.' : `No entries match ${glob}.`
        return `${formatListBase(real)}\n${empty}`
      }

      const rows = [formatListBase(real), ...shown.map(formatListEntry)]
      if (walked.entries.length > LIST_LIMIT || walked.truncated) {
        const total = walked.truncated ? `at least ${walked.entries.length}` : String(walked.entries.length)
        rows.push(`[truncated: showing ${shown.length} of ${total} entries; narrow the path or glob for the rest]`)
      }
      return rows.join('\n')
    },
  }

  const grepTool: FsTool = {
    name: GREP_TOOL_NAME,
    description:
      'Search file contents with a regular expression and return one "path:line:text" row per matching ' +
      'line, where path is the absolute path of the file. The path may be a file or a directory; glob ' +
      'filters the files (for example "*.ts"). Binary ' +
      `files (a NUL byte in the first 8 KB) and files over 2 MB are skipped, as are node_modules and .git ` +
      `unless the path itself names them. At most ${GREP_MATCH_LIMIT} matches and ${GREP_FILE_LIMIT} files ` +
      'are examined; the answer says when it was cut. Protected paths are never read. ' +
      rootsSummary,
    inputSchema: {
      type: 'object',
      properties: {
        regex: { type: 'string', description: 'Regular expression to search for in each line.' },
        path: {
          type: 'string',
          description: 'File or directory; absolute or relative to the first root. Default: the workspace root.',
        },
        glob: { type: 'string', description: 'Glob filter over file names, e.g. "*.ts".' },
      },
      required: ['regex'],
      additionalProperties: false,
    },
    // A search reads the files it walks and changes nothing.
    isConcurrencySafe: () => true,
    execute(args) {
      const pattern = stringArg(args, 'regex')
      if (pattern === undefined || pattern === '') throw new Error('regex is required')
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
      }

      const given = stringArg(args, 'path')
      const input = given === undefined || given.trim() === '' ? fallbackRoot.path : given
      const { real } = locate(input)
      let stats: Stats
      try {
        stats = lstatSync(real)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') throw new Error(`path not found: ${input}`)
        throw error
      }

      const globArg = stringArg(args, 'glob')
      const glob = globArg === undefined || globArg.trim() === '' ? undefined : globArg.trim()

      if (!stats.isDirectory()) {
        if (isProtected(real, protectedRoot)) {
          return frameData('Path is protected by the charter; its content is not shown.', { source: 'grep' })
        }
        const file: GrepFile = { path: real, rel: basename(real), size: stats.size }
        if (glob !== undefined && !matchesGlob(file.rel, glob)) {
          return frameData(`No files match ${glob}.`, { source: 'grep' })
        }
        const { rows, limited } = grepFiles([file], regex, undefined)
        return frameData(grepAnswer(rows, limited, false), { source: 'grep' })
      }

      const collected = collectGrepFiles(real)
      const { rows, limited } = grepFiles(collected.files, regex, glob)
      return frameData(grepAnswer(rows, limited, collected.truncated), { source: 'grep' })
    },
  }

  return [readTool, editTool, listTool, grepTool, writeTool]
}
