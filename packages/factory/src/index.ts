// Embedded factory: projects, tasks, role models, autoaccept, the owner's
// `/factory` menu on Telegram Rich, the read-only analysis of a task, execution
// in a task worktree, and acceptance: autoaccept, the owner's rich card, and a
// GitHub PR or a local fast-forward merge into the project's base branch.
//
// Nothing here shells out to the external `zavod` CLI.

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

import {
  gateCommand,
  gateTimeoutMs,
  GATE_TIMEOUT_ENV,
  parseReview,
  sandboxedTests,
  SANDBOX_TIMEOUT_PREFIX,
  type SandboxResult,
  type SandboxRunner,
} from '../../evolve/src/index.js'
import { DEFAULT_MODEL, REASONING_EFFORTS, type ReasoningEffort, type RunnerTool } from '../../runner/src/index.js'
import type { TelegramApi } from '../../telegram/src/api.js'
import { TelegramApiError } from '../../telegram/src/api.js'
import { markdownToHtml, markdownToPlain } from '../../telegram/src/rich/html.js'
import { sendFormatted } from '../../telegram/src/rich/send.js'

/** Callback prefix of every button of the embedded factory menu. */
const CALLBACK_PREFIX = 'f1'
/** Models on one page of a provider on the role screen; Telegram keyboards stay small. */
const ROLE_MODELS_PAGE_SIZE = 20

/** How long a provider sign-in waits for the owner before it withdraws. */
const PROVIDER_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/** Statuses of a factory task, in the order the menu names them. */
export const FACTORY_TASK_STATUSES = [
  'incoming',
  'analysis',
  'awaiting_approval',
  'queued',
  'running',
  'awaiting_human',
  'merged',
  'rejected',
] as const

export type FactoryTaskStatus = (typeof FACTORY_TASK_STATUSES)[number]

/** Russian names of the task statuses, used by the list and the card. */
export const FACTORY_STATUS_LABELS: Readonly<Record<FactoryTaskStatus, string>> = {
  incoming: 'входящее',
  analysis: 'разбор',
  awaiting_approval: 'ждёт одобрения',
  queued: 'в очереди',
  running: 'в работе',
  awaiting_human: 'ждёт человека',
  merged: 'влито',
  rejected: 'отклонено',
}

/** Roles of the factory whose model choice the owner configures. */
export const FACTORY_ROLES = [
  { key: 'analysis', label: 'разбор' },
  { key: 'test_writer', label: 'тестописец' },
  { key: 'executor', label: 'исполнитель' },
  { key: 'reviewer', label: 'ревьюер' },
] as const

export type FactoryRole = (typeof FACTORY_ROLES)[number]['key']

/** One model the harness adapter advertises for a connected provider. */
export interface FactoryModel {
  provider: string
  id: string
  name: string
}

/** One way the owner can sign in to a provider route. */
export interface FactoryProviderMethod {
  /** Flow-owned identifier passed back to {@link FactoryOptions.connectProvider}. */
  id: string
  kind: 'api-key' | 'oauth'
  label: string
}

/** One connectable provider route and whether a sign-in is stored. */
export interface FactoryProviderInfo {
  id: string
  name: string
  connected: boolean
  methods: FactoryProviderMethod[]
}

/** One question a sign-in flow asks the owner. */
export interface FactoryProviderPrompt {
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

/** One notice a sign-in flow reports: the text, and its page or code when it has one. */
export interface FactoryProviderNotice {
  message: string
  url?: string
  code?: string
}

/** The surface that talks to the owner during one provider sign-in. */
export interface FactoryProviderInteraction {
  prompt(request: FactoryProviderPrompt): Promise<string | undefined>
  notify(notice: FactoryProviderNotice): void
  signal: AbortSignal
}

export type FactoryProviderStatus = 'connected' | 'cancelled' | 'failed'

export interface FactoryProject {
  /** `0` is the bot repository itself; it is never stored and never removable. */
  id: number
  path: string
  name: string
  testCommand: string
  own: boolean
}

/** Risk verdict of one analysis. */
export type FactoryRisk = 'low' | 'high'

export interface FactoryTask {
  id: number
  title: string
  body: string
  status: FactoryTaskStatus
  projectId: number
  projectName: string
  projectPath: string
  createdAt: number
  criteria: string[]
  footprint: string[]
  risk?: FactoryRisk
  riskReason?: string
  /** Last execution remark: a gate tail, a review issue or the acceptance reason. */
  reason?: string
  /** Files the accepted task changed, relative to the project root. */
  changedFiles: string[]
  /** Stage and round of a running execution. */
  progress?: FactoryExecutionProgress
}

/** Stages of one execution, in the order they are shown on the task card. */
export const FACTORY_EXECUTION_STAGES = ['tests', 'execution', 'gate', 'review'] as const

export type FactoryExecutionStage = (typeof FACTORY_EXECUTION_STAGES)[number]

export const FACTORY_STAGE_LABELS: Readonly<Record<FactoryExecutionStage, string>> = {
  tests: 'тесты',
  execution: 'исполнение',
  gate: 'гейт',
  review: 'ревью',
}

export interface FactoryExecutionProgress {
  stage: FactoryExecutionStage
  /** Executor round, 1-based; the card renders «круг N из 3». */
  round: number
}

/** Rounds one execution may fail (gate, review or scope) before it waits for the owner. */
export const FACTORY_MAX_ROUNDS = 3

/** The durable slice of the application store the factory needs. */
export interface FactoryStore {
  db: DatabaseSync
  migrate(namespace: string, steps: readonly string[]): void
  kv: {
    get(key: string): string | undefined
    set(key: string, value: string): void
  }
}

export interface FactoryCallback {
  id: string
  chatId: number
  fromId: number
  messageId: number
  data: string
}

/** One read-only analysis turn handed to the host harness. */
export interface FactoryAnalysisTurn {
  provider: string
  model: string
  modelName: string
  /** Root of the project; tools must read only below it. */
  cwd: string
  systemPrefix: string
  prompt: string
  /** Unique transient harness session of this turn. */
  sessionId: string
  /**
   * Reasoning level of the analysis session, resolved from the role choice and
   * the first enabled model. Absent means the model default.
   */
  reasoningEffort?: string
  tools: readonly RunnerTool[]
}

/** Runs one agent-loop turn and returns the model's final text. */
export type FactoryAnalysisRunner = (turn: FactoryAnalysisTurn) => Promise<string>

/** One execution-role turn (test writer, executor or reviewer) on a task worktree. */
export interface FactoryRoleTurn {
  role: Exclude<FactoryRole, 'analysis'>
  provider: string
  model: string
  modelName: string
  /** Worktree of the task; every role tool and the runner are rooted here. */
  cwd: string
  systemPrefix: string
  prompt: string
  /** Unique session of this turn; role turns never share a session. */
  sessionId: string
  /**
   * Reasoning level of this role session, resolved from the role choice and
   * the first enabled model. Absent means the model default.
   */
  reasoningEffort?: string
  tools: readonly RunnerTool[]
}

/** Runs one execution-role turn and returns the model's final text. */
export type FactoryRoleRunner = (turn: FactoryRoleTurn) => Promise<string>

export interface FactoryOptions {
  store: FactoryStore
  /** `DSHBOT_HOME`; the bot's own repository defaults to `<home>/app`. */
  home: string
  /** Repository root of the running bot, used when `<home>/app` is absent. */
  appRoot: string
  api: TelegramApi
  /** The paired owner, or `null` before pairing. */
  ownerId: () => number | null
  /** Models the harness adapter currently advertises. */
  catalogue: () => Promise<readonly FactoryModel[]>
  /**
   * Reasoning levels reported by the adapter for one exact model. `catalogue`
   * is the list of bare identities and carries no capabilities; `undefined`
   * means the route advertises none, so the menu offers the generic four.
   */
  modelLevels?: (provider: string, id: string) => Promise<readonly string[] | undefined>
  /** Runs the read-only analysis of a task through the harness. */
  analysis?: FactoryAnalysisRunner
  /** Runs one test-writer, executor or reviewer turn through the harness. */
  roleTurn?: FactoryRoleRunner
  /** Connectable provider routes, in the order the provider screen shows them. */
  providers?: () => Promise<readonly FactoryProviderInfo[]>
  /**
   * Sign in to one provider route. `method` is the id the owner pressed;
   * `interaction` reaches this owner alone and is withdrawn through its signal.
   */
  connectProvider?: (
    id: string,
    method: string | undefined,
    interaction: FactoryProviderInteraction,
  ) => Promise<FactoryProviderStatus>
  /** Remove the stored sign-in of one provider route. */
  disconnectProvider?: (id: string) => Promise<void>
  /** HOME of the daemon, an empty tmpfs inside the gate sandbox. */
  ownerHome?: string
  /** Test seam for the sandboxed project tests; the real bwrap gate by default. */
  sandbox?: SandboxRunner
  log?: (message: string) => void
}

/** Programmatic submission of one factory task (the owner's `zavod` tool). */
export interface FactoryTaskInput {
  /** Task text; the first line becomes the title when `title` is absent. */
  text: string
  /** Optional explicit title. */
  title?: string
  /** Connected project name; absent means the bot's own repository. */
  project?: string
}

export interface Factory {
  /** `/factory`: one message with the main menu. */
  open(chatId: number, threadId?: number): Promise<void>
  /** True when the callback belongs to the factory and was handled. */
  handleCallback(callback: FactoryCallback): Promise<boolean>
  /**
   * Consume the owner's next message when the menu waits for input. The
   * message id lets a provider sign-in delete the message that carried a
   * secret after it has been read.
   */
  takeInput(chatId: number, text: string, messageId?: number): Promise<boolean>
  /** Whether the menu currently waits for an owner message in this chat. */
  waitingForInput(chatId: number): boolean
  /**
   * The provider sign-in of this chat: `none` without one, `answer` when its
   * flow waits for a typed text or secret, `active` otherwise.
   */
  signInState(chatId: number): 'none' | 'active' | 'answer'
  /**
   * Creates a task and starts its analysis exactly like the menu does: the
   * owner receives the usual analysis card with «Одобрить / Править / Отменить».
   * Throws when the project is not connected; no task is stored then.
   */
  createTask(input: FactoryTaskInput): FactoryTask
  /** All tasks, newest first. */
  listTasks(): FactoryTask[]
  /** One task by id, or undefined. */
  findTask(id: number): FactoryTask | undefined
  /** Connected projects: the bot's own repository first. */
  listProjects(): FactoryProject[]
}

const FACTORY_STEPS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS factory_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    test_command TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS factory_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'incoming'
      CHECK (status IN ('incoming', 'analysis', 'awaiting_approval', 'running', 'awaiting_human', 'merged', 'rejected')),
    project_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // Analysis fields and the `queued` status. Rebuilding is the only portable
  // way to widen a CHECK constraint in SQLite; existing rows keep their data.
  `CREATE TABLE factory_tasks_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'incoming'
      CHECK (status IN ('incoming', 'analysis', 'awaiting_approval', 'queued', 'running', 'awaiting_human', 'merged', 'rejected')),
    project_id INTEGER NOT NULL,
    project_name TEXT NOT NULL,
    project_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    criteria TEXT,
    footprint TEXT,
    risk TEXT,
    risk_reason TEXT,
    remark TEXT
  );
  INSERT INTO factory_tasks_analysis
    (id, title, body, status, project_id, project_name, project_path, created_at)
  SELECT id, title, body, status, project_id, project_name, project_path, created_at FROM factory_tasks;
  DROP TABLE factory_tasks;
  ALTER TABLE factory_tasks_analysis RENAME TO factory_tasks`,
  // Execution state. The role worktree is durable so a restart can remove the
  // abandoned tree; `queued_at` marks an owner approval instead of a status the
  // owner (or a test) typed by hand.
  `ALTER TABLE factory_tasks ADD COLUMN analysis_running INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE factory_tasks ADD COLUMN execution_stage TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN execution_round INTEGER`,
  `ALTER TABLE factory_tasks ADD COLUMN execution_note TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN result_files TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN worktree TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN queued_at INTEGER`,
  // Acceptance state: the diffs of the accepted commit, the worktree identity
  // captured before project code ran, the owner's card and a pending remark of
  // the «Вернуть» button.
  `ALTER TABLE factory_tasks ADD COLUMN result_base TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN result_stats TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN worktree_identity TEXT`,
  `ALTER TABLE factory_tasks ADD COLUMN acceptance_message_id INTEGER`,
  `ALTER TABLE factory_tasks ADD COLUMN acceptance_chat_id INTEGER`,
  `ALTER TABLE factory_tasks ADD COLUMN resume_remark TEXT`,
  // Paths the test writer declared or changed: a returned task keeps them
  // locked even when their names do not look like tests.
  `ALTER TABLE factory_tasks ADD COLUMN writer_tests TEXT`,
  // The writer tests' content (and type) right after the writer: a restart
  // restores them even if the interrupted executor changed or removed a file.
  // A row without this snapshot (an older daemon) starts over instead.
  `ALTER TABLE factory_tasks ADD COLUMN writer_snapshot TEXT`,
  // The commit the task worktree started from, so a resumed execution diffs
  // and gates against the same base as the interrupted one.
  `ALTER TABLE factory_tasks ADD COLUMN worktree_base TEXT`,
]

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 10_000
const AUTOACCEPT_KV_KEY = 'factory.autoaccept'
const TASK_TITLE_LIMIT = 80
const ROLE_MODELS_KV_PREFIX = 'factory.role_models.'
const ROLE_EFFORT_KV_PREFIX = 'factory.role_effort.'
/** Level a role runs on until the owner picks another one. */
const DEFAULT_ROLE_EFFORT: ReasoningEffort = 'high'
/**
 * The expensive model the owner reserves for an explicit `/model pro` in their
 * own session. Factory roles neither offer it nor run on it: the catalogue of
 * every role drops it, so a default or a saved legacy choice cannot select it.
 */
const FACTORY_EXCLUDED_MODEL_ID = 'deepseek-v4-pro'
const TASK_PAGE_SIZE = 8
const ANALYSIS_MAX_ITERATIONS = 8
const ANALYSIS_TIMEOUT_MS = 10 * 60_000
const ANALYSIS_READ_LIMIT = 40_000
const ANALYSIS_TREE_LIMIT = 2_000
/**
 * Entry budget of one ignored-directory scan. A footprint that reaches an
 * ignored directory gets its contents listed; an oversized tree is treated as
 * high risk instead of silently missing a risky file.
 */
const IGNORED_SCAN_LIMIT = 2_000

/** How much of a failed gate output is handed to the next executor round. */
const GATE_TAIL_CHARS = 4_000

/** Model iterations of one role turn: read, write and a closing JSON answer. */
const ROLE_MAX_ITERATIONS = 16

/** Wall-clock cap of one role turn; a large task still fits. */
const ROLE_TIMEOUT_MS = 10 * 60_000

/** Default wall-clock cap of the sandboxed project tests, as evolve's gate. */
const DEFAULT_TEST_COMMAND = 'npm test'
/**
 * Remark the first executor round gets when a daemon restart resumes the task
 * in its recorded worktree instead of starting it over.
 */
const RESTART_RESUME_REMARK =
  'Прошлый круг прерван перезапуском демона: работа в worktree сохранена, ' +
  'тесты тестописца восстановлены. Продолжи с текущего состояния.'
/** Cap of a reviewer remark carried into the next executor round. */
const REVIEW_REMARK_LIMIT = 4_000
/** Cap of a transport failure carried from a merge into the owner's card. */
const MERGE_REASON_LIMIT = 1_500
/** Lines of a failed command kept in its error: push and gh print the cause last. */
const FAILURE_TAIL_LINES = 6
/** Wall-clock cap of one gh call of the acceptance phase. */
const GH_TIMEOUT_MS = 60_000

interface ProjectRow {
  id: number
  path: string
  name: string
  test_command: string
  created_at: number
}

interface TaskRow {
  id: number
  title: string
  body: string
  status: string
  project_id: number
  project_name: string
  project_path: string
  created_at: number
  criteria: string | null
  footprint: string | null
  risk: string | null
  risk_reason: string | null
  remark: string | null
  analysis_running: number | null
  execution_stage: string | null
  execution_round: number | null
  execution_note: string | null
  result_files: string | null
  worktree: string | null
  queued_at: number | null
  result_base: string | null
  result_stats: string | null
  worktree_identity: string | null
  acceptance_message_id: number | null
  acceptance_chat_id: number | null
  resume_remark: string | null
  writer_tests: string | null
  writer_snapshot: string | null
  worktree_base: string | null
}

type PendingInput =
  | { chatId: number; kind: 'project' }
  | { chatId: number; kind: 'task'; projectId: number }
  | { chatId: number; kind: 'remark'; taskId: number }
  | { chatId: number; kind: 'acceptance-remark'; taskId: number }

/** One question of a provider sign-in that waits for the owner. */
interface SignInPrompt {
  request: FactoryProviderPrompt
  resolve: (answer: string | undefined) => void
  reject: (error: Error) => void
}

/** The sign-in of one provider route that the owner is in the middle of. */
interface ProviderSignIn {
  chatId: number
  providerId: string
  providerName: string
  controller: AbortController
  /** Question the next owner message answers; absent while the flow works alone. */
  prompt?: SignInPrompt
  /** `select` options in the order of the buttons; the callback carries the index. */
  options?: ReadonlyArray<{ id: string; label: string }>
  /** Serializes notices and questions so the owner reads them in flow order. */
  outbox: Promise<void>
  /** Cancels the attempt after five minutes without an answer. */
  timer?: ReturnType<typeof setTimeout>
  /** True once the owner, the timeout or the flow itself ended the attempt. */
  settled: boolean
}

interface Screen {
  markdown: string
  keyboard: Array<Array<Record<string, unknown>>>
}

interface CallbackResult {
  screen?: Screen
  /** Short answer of the callback; an empty string is the ordinary acknowledgement. */
  notice?: string
  /** Explain without editing the menu (a refused toggle must leave it unchanged). */
  answerOnly?: boolean
}

interface AnalysisJob {
  taskId: number
  chatId: number
  threadId?: number
  remark?: string
}

interface ParsedAnalysis {
  criteria: string[]
  footprint: string[]
  risk: FactoryRisk
}

function modelKey(model: FactoryModel): string {
  return `${model.provider}\u0000${model.id}`
}

function modelHash(model: FactoryModel): string {
  return createHash('sha256').update(modelKey(model)).digest('hex').slice(0, 16)
}

function providerHash(provider: string): string {
  return createHash('sha256').update(provider).digest('hex').slice(0, 16)
}

/** Providers of the catalogue in the order they first appear. */
function providersOf(models: readonly FactoryModel[]): string[] {
  return [...new Set(models.map((model) => model.provider))]
}

function button(text: string, data: string, style?: 'success' | 'danger'): Record<string, unknown> {
  return { text, ...(style === undefined ? {} : { style }), callback_data: `${CALLBACK_PREFIX}:${data}` }
}

/** A button that opens a page; the address itself is the payload. */
function linkButton(text: string, url: string): Record<string, unknown> {
  return { text, url }
}

/** A button that puts the code on the clipboard; Telegram copies the payload. */
function copyButton(text: string, value: string): Record<string, unknown> {
  return { text, copy_text: { text: value } }
}

function literal(value: string): string {
  const runs = value.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map((run) => run.length + 1)))
  return `${fence}\n${value}\n${fence}`
}

function titleOf(body: string): string {
  const line = body.split(/\r?\n/).find((candidate) => candidate.trim() !== '') ?? ''
  return [...line.trim()].slice(0, TASK_TITLE_LIMIT).join('')
}

function isBadRequest(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.errorCode === 400
}

function isEntityParseError(error: TelegramApiError): boolean {
  return error.description.toLowerCase().includes('parse entit')
}

/** Telegram refuses an edit whose text and keyboard are already there. */
function isNotModified(error: unknown): boolean {
  return isBadRequest(error) && error.description.toLowerCase().includes('not modified')
}

function statusOf(raw: string): FactoryTaskStatus {
  return (FACTORY_TASK_STATUSES as readonly string[]).includes(raw)
    ? (raw as FactoryTaskStatus)
    : 'incoming'
}

function riskOf(raw: string | null): FactoryRisk | undefined {
  return raw === 'low' || raw === 'high' ? raw : undefined
}

function listOf(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  } catch {
    return []
  }
}

/**
 * Why `path` is not the root of a usable git work tree, or `undefined` when it
 * is. A `.git` marker alone proves nothing: an empty `.git` directory or a
 * gitfile pointing at a missing gitdir must be refused, so git itself decides.
 * Inherited `GIT_*` variables are dropped (a stray `GIT_DIR` would answer for
 * another repository) and discovery stops at `path`, so an enclosing
 * repository cannot vouch for a subdirectory.
 */
export async function gitRepositoryProblem(path: string): Promise<string | undefined> {
  try {
    if (!statSync(path).isDirectory()) return 'это не каталог'
  } catch {
    return 'каталог не существует'
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CEILING_DIRECTORIES = dirname(path)
  let toplevel: string
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    toplevel = stdout.trim()
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    if (failure.code === 'ENOENT') return 'git не найден'
    if (failure.killed === true) return 'git не ответил вовремя'
    const reason = (failure.stderr ?? '').split(/\r?\n/).find((line) => line.trim() !== '')?.trim()
    return reason === undefined ? 'git отверг каталог' : reason.slice(0, 200)
  }
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return 'каталог не существует'
  }
  if (toplevel === '' || resolve(toplevel) !== real) return 'это не корень рабочего дерева'
  return undefined
}

function pathSegments(path: string): string[] {
  return path.replaceAll('\\', '/').split('/').filter((segment) => segment !== '' && segment !== '.')
}

/**
 * A path the analysis model must never see: `.env*` names, any segment that
 * mentions a secret, and the `.git` directory. Case-insensitive because the
 * same tree may be checked out on a case-insensitive filesystem.
 */
function isForbiddenAnalysisPath(path: string): boolean {
  return pathSegments(path).some((segment) => {
    const lower = segment.toLowerCase()
    return lower === '.git' || lower.startsWith('.env') || lower.includes('secret')
  })
}

/** `git ls-files -z` of the project with extra arguments; empty when git fails. */
async function gitListedPaths(root: string, args: readonly string[]): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z', ...args], {
      encoding: 'utf8',
      env,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout.split('\u0000').filter((path) => path !== '')
  } catch {
    return []
  }
}

/** Tracked files of the project, without the paths the model may not read. */
async function trackedProjectFiles(root: string): Promise<string[]> {
  return (await gitListedPaths(root, []))
    .filter((path) => !isForbiddenAnalysisPath(path))
    .slice(0, ANALYSIS_TREE_LIMIT)
}

interface ProjectRiskListing {
  /** Tracked, untracked and ignored paths; a collapsed ignored directory stays one entry. */
  paths: string[]
  /** Root-relative ignored directories git collapsed to a single entry (`--directory`). */
  ignoredDirectories: string[]
}

/**
 * Every path of the project the risk rule must see: tracked and untracked
 * files plus ignored ones (`.env` is usually ignored), a wholly ignored
 * directory such as `node_modules/` collapsed to its name. Nothing here
 * reaches the model.
 */
async function projectRiskPaths(root: string): Promise<ProjectRiskListing> {
  const [tracked, untracked, ignored] = await Promise.all([
    gitListedPaths(root, []),
    gitListedPaths(root, ['--others', '--exclude-standard']),
    gitListedPaths(root, ['--others', '--ignored', '--exclude-standard', '--directory']),
  ])
  // Only collapsed directories carry a trailing slash in `--directory` output;
  // ignored individual files are already in `paths` as themselves.
  const ignoredDirectories = ignored.filter((path) => path.endsWith('/') || path.endsWith('\\'))
  return { paths: [...tracked, ...untracked, ...ignored], ignoredDirectories }
}

/**
 * Paths below one root-relative ignored directory, without following symbolic
 * links. `undefined` when the directory cannot be read or holds more than
 * `limit` entries: the risk rule then answers high rather than guessing.
 */
function scanIgnoredDirectory(projectRoot: string, directory: string, limit: number): string[] | undefined {
  let root: string
  let start: string
  try {
    root = realpathSync(projectRoot)
    start = realpathSync(resolve(projectRoot, directory))
  } catch {
    return undefined
  }
  if (start !== root && !start.startsWith(`${root}${sep}`)) return undefined
  const entries: string[] = []
  const stack: Array<{ absolute: string; relative: string }> = [
    { absolute: start, relative: pathSegments(directory).join('/') },
  ]
  while (stack.length > 0) {
    const current = stack.pop() as { absolute: string; relative: string }
    let children: Dirent[]
    try {
      children = readdirSync(current.absolute, { withFileTypes: true })
    } catch {
      return undefined
    }
    for (const child of children) {
      const relative = current.relative === '' ? child.name : `${current.relative}/${child.name}`
      entries.push(relative)
      if (entries.length > limit) return undefined
      // A symlink keeps its own name (which may be risky) but is never followed.
      if (child.isDirectory()) stack.push({ absolute: join(current.absolute, child.name), relative })
    }
  }
  return entries
}

/** How the risk rule reaches content below an ignored directory. */
interface IgnoredDirectoryScan {
  directories: readonly string[]
  list: ((directory: string) => readonly string[] | undefined) | undefined
  limit: number
}

/**
 * The read capability of the analysis turn. It resolves the requested path,
 * refuses anything outside the project root (including a symlink that points
 * out of it) and every forbidden name, and never returns a directory.
 */
function analysisReadTool(projectRoot: string): RunnerTool {
  let root = resolve(projectRoot)
  try {
    root = realpathSync(root)
  } catch {
    // The project may have disappeared after the task was created; the tool
    // then refuses every path instead of reading relative to the process cwd.
  }
  return {
    name: 'read_file',
    description: 'Прочитать файл проекта (только чтение). Путь задаётся относительно корня проекта.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу относительно корня проекта' },
      },
      required: ['path'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const requested = typeof args.path === 'string' ? args.path.trim() : ''
      const refusal = 'Файл недоступен для чтения разбора.'
      if (requested === '' || isAbsolute(requested) || isForbiddenAnalysisPath(requested)) {
        return refusal
      }
      const lexical = resolve(root, requested)
      if (lexical !== root && !lexical.startsWith(`${root}${sep}`)) return refusal
      let real: string
      try {
        real = realpathSync(lexical)
      } catch {
        return refusal
      }
      if (real !== root && !real.startsWith(`${root}${sep}`)) return refusal
      if (isForbiddenAnalysisPath(real.slice(root.length).replaceAll(sep, '/'))) return refusal
      let stats
      try {
        stats = statSync(real)
      } catch {
        return refusal
      }
      if (!stats.isFile()) return refusal
      let content: string
      try {
        content = readFileSync(real, 'utf8')
      } catch {
        return refusal
      }
      const capped = content.length > ANALYSIS_READ_LIMIT ? `${content.slice(0, ANALYSIS_READ_LIMIT)}\n… (файл усечён)` : content
      return `Содержимое ${requested}:\n${capped}`
    },
  }
}

/** Risky path categories, in the order the card names them. */
const RISK_CATEGORIES = ['миграции', 'workflow', '.env', 'секреты'] as const
type RiskCategory = (typeof RISK_CATEGORIES)[number]

/** The risky category of a path by its own segments (lower-cased). */
function riskyPathCategory(segments: readonly string[]): RiskCategory | undefined {
  if (segments.some((segment) => segment === 'migrations' || segment === 'migration')) return 'миграции'
  if (segments.some((segment, index) => segment === '.github' && segments[index + 1] === 'workflows')) return 'workflow'
  if (segments.some((segment) => segment.startsWith('.env'))) return '.env'
  if (segments.some((segment) => segment.includes('secret'))) return 'секреты'
  return undefined
}

/**
 * Root-relative segments of a footprint entry in its own spelling after
 * resolving `./`, `//`, `..` and a trailing `/`; an absolute entry is taken
 * against the project root. `undefined` when the entry leaves the root without
 * containing it; an ancestor of the root (`/`, `..`) is the whole project, `[]`.
 */
function footprintScope(entry: string, projectRoot: string): string[] | undefined {
  const root = posix.resolve(resolve(projectRoot).replaceAll(sep, '/'))
  const target = posix.resolve(root, entry.trim().replaceAll('\\', '/'))
  const segments = posix.relative(root, target).split('/').filter((segment) => segment !== '')
  if (segments.every((segment) => segment === '..')) return []
  return segments[0] === '..' ? undefined : segments
}

/**
 * The deeper of a footprint scope and an ignored directory when one contains
 * the other, else `undefined`. Segments match case-insensitively, but the
 * result keeps the spelling the filesystem knows: the directory as git listed
 * it and the footprint's own segments below it. Lower-casing the path here
 * would scan a different directory on a case-sensitive filesystem.
 */
function ignoredIntersection(scope: readonly string[], directory: readonly string[]): string[] | undefined {
  const shared = Math.min(scope.length, directory.length)
  for (let index = 0; index < shared; index += 1) {
    if (scope[index].toLowerCase() !== directory[index].toLowerCase()) return undefined
  }
  return [...directory, ...scope.slice(directory.length)]
}

/**
 * Categories of risky paths a footprint entry lets the executor change: the
 * entry itself or anything above it is risky, or the entry is a directory
 * above a risky path — lexically (the project root, a `.github` directory) or
 * by an existing path of the project below it.
 *
 * Git collapses a wholly ignored directory (`config/`) into one entry, hiding
 * the files inside. When a footprint touches such an entry, only the
 * intersection is listed: the whole ignored directory when the footprint is
 * above it, or just the footprint subtree when it points inside. A failed or
 * oversized listing is recorded in `unscanned` so the caller can answer high.
 * The project root (`scope` `[]`) already contains every risky category and is
 * high without any listing.
 */
function footprintRiskCategories(
  scope: readonly string[],
  projectPaths: readonly string[],
  scan: IgnoredDirectoryScan,
  unscanned: Set<string>,
): Set<RiskCategory> {
  const categories = new Set<RiskCategory>()
  if (scope.length === 0) return new Set(RISK_CATEGORIES)
  const lower = scope.map((segment) => segment.toLowerCase())
  const own = riskyPathCategory(lower)
  if (own !== undefined) categories.add(own)
  if (lower.at(-1) === '.github') categories.add('workflow')
  for (const path of projectPaths) {
    const segments = pathSegments(path.toLowerCase())
    if (segments.length <= lower.length || lower.some((segment, index) => segments[index] !== segment)) continue
    const category = riskyPathCategory(segments)
    if (category !== undefined) categories.add(category)
  }
  if (scan.list === undefined || scan.directories.length === 0) return categories
  const visited = new Set<string>()
  for (const directory of scan.directories) {
    const intersection = ignoredIntersection(scope, pathSegments(directory))
    if (intersection === undefined || intersection.length === 0) continue
    const key = intersection.join('/')
    if (visited.has(key)) continue
    visited.add(key)
    const listing = scan.list(key)
    if (listing === undefined || listing.length > scan.limit) {
      unscanned.add(key)
      continue
    }
    for (const entry of listing) {
      const category = riskyPathCategory(pathSegments(entry.toLowerCase()))
      if (category !== undefined) categories.add(category)
    }
  }
  return categories
}

/** Task text that the rule raises to high risk even with a harmless footprint. */
function riskyTaskTextReason(body: string): string | undefined {
  if (/(?:деньг|оплат|платеж|платёж|биллинг|авторизац|аутентификац|логин|парол|секрет|токен|удалени|удалить|удалят|миграц|migration|payment|billing|auth|password|secret|token|delete|drop\s+table)/i.test(body)) {
    return 'текст задачи касается денег, авторизации, секретов, удаления данных или миграций'
  }
  return undefined
}

export interface FactoryRiskInput {
  body: string
  footprint: readonly string[]
  modelRisk: FactoryRisk
  projectRoot: string
  /** Project paths relative to the root (`git ls-files`), used to see what a directory contains. */
  projectPaths: readonly string[]
  /** Ignored directories git collapsed to one entry (`--directory`). */
  ignoredDirectories?: readonly string[]
  /** Lists paths below an ignored directory; `undefined` when the listing failed. */
  scanIgnoredDirectory?: (directory: string) => readonly string[] | undefined
  /** Entry budget of one ignored-directory scan. */
  ignoredScanLimit?: number
}

/**
 * The rule over the model's risk: high when the model says so, when the task
 * text touches money, auth, secrets, deletion or migrations, or when a
 * footprint entry is, lies inside or contains a risky path; the reason names why.
 */
export function assessFactoryRisk(input: FactoryRiskInput): { risk: FactoryRisk; reason?: string } {
  const reasons: string[] = []
  if (input.modelRisk === 'high') reasons.push('модель отметила риск high')
  const categories = new Set<RiskCategory>()
  const unscanned = new Set<string>()
  const scan: IgnoredDirectoryScan = {
    directories: input.ignoredDirectories ?? [],
    list: input.scanIgnoredDirectory,
    limit: input.ignoredScanLimit ?? IGNORED_SCAN_LIMIT,
  }
  let outside = false
  for (const entry of input.footprint) {
    const scope = footprintScope(entry, input.projectRoot)
    if (scope === undefined) outside = true
    else for (const category of footprintRiskCategories(scope, input.projectPaths, scan, unscanned)) categories.add(category)
  }
  const footprintReasons = RISK_CATEGORIES.filter((category) => categories.has(category))
  if (footprintReasons.length > 0) reasons.push(`footprint задевает рисковые пути (${footprintReasons.join(', ')})`)
  if (unscanned.size > 0) {
    reasons.push(`содержимое игнорируемых каталогов footprint не удалось перечислить или превышает предел (${[...unscanned].sort().join(', ')})`)
  }
  if (outside) reasons.push('footprint выходит за корень проекта')
  const textReason = riskyTaskTextReason(input.body)
  if (textReason !== undefined && footprintReasons.length === 0) reasons.push(textReason)
  if (reasons.length === 0) return { risk: 'low' }
  return { risk: 'high', reason: `Причина: ${reasons.join('; ')}.` }
}

/** The JSON contract of the analysis role. */
function analysisSystemPrefix(task: { title: string; body: string; project_name: string; project_path: string }, tree: readonly string[]): string {
  return [
    'Ты — роль «разбор» завода бота.',
    'Прочитай текст задачи и код проекта (только чтение) и верни разбор.',
    'Ответь только JSON без пояснений:',
    '{"criteria":["..."],"footprint":["..."],"risk":"low"}',
    'Правила:',
    '- критерий — одно наблюдаемое поведение на критерий (каждый критерий проверяем отдельно);',
    '- footprint — пути проекта, которые разрешено менять;',
    '- risk — строго low или high;',
    '- high ставь, если задача трогает деньги, авторизацию, секреты, удаление данных или миграции,',
    '  либо если footprint задевает migrations/, .github/workflows/, .env* или пути с secret/secrets',
    '  (в том числе каталогом, который их содержит, или корнем проекта);',
    '- чтобы прочитать файл, вызови инструмент read_file с путём относительно корня проекта;',
    '- файлы .env*, пути с secret/secrets и всё вне корня проекта читать нельзя.',
    '',
    `Проект: ${task.project_name}`,
    `Корень проекта: ${task.project_path}`,
    'Отслеживаемые git-файлы проекта:',
    tree.length === 0 ? '(дерево пусто или недоступно)' : tree.join('\n'),
    '',
    `Задача: ${task.title}`,
    task.body,
  ].join('\n')
}

function analysisPrompt(
  task: { title: string; body: string },
  remark: string | undefined,
  retryNote: string | undefined,
): string {
  const lines = [`Разбери задачу «${task.title}».`, '', task.body]
  if (remark !== undefined && remark.trim() !== '') {
    lines.push('', 'Замечание владельца к прошлому разбору:', remark.trim())
  }
  if (retryNote !== undefined) {
    lines.push('', `Предыдущий ответ не разобран: ${retryNote}`, 'Верни только JSON разбора.')
  }
  return lines.join('\n')
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates: string[] = [trimmed]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim())
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next shape.
    }
  }
  return undefined
}

function parseAnalysis(text: string): { ok: true; value: ParsedAnalysis } | { ok: false; error: string } {
  const parsed = extractJson(text)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'ответ модели не разобран как JSON разбора' }
  }
  const raw = parsed as Record<string, unknown>
  const criteria = Array.isArray(raw.criteria)
    ? raw.criteria
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
    : []
  if (criteria.length === 0) return { ok: false, error: 'в разборе нет критериев' }
  const footprint = Array.isArray(raw.footprint)
    ? raw.footprint
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        // `./src` reads as `src`; `./` alone is the project root and stays visible.
        .map((entry) => entry.replace(/^(?:\.\/+)+/, '') || '.')
    : []
  if (footprint.length === 0) return { ok: false, error: 'в разборе нет footprint (путей, которые можно менять)' }
  const risk = typeof raw.risk === 'string' ? raw.risk.trim().toLowerCase() : ''
  if (risk !== 'low' && risk !== 'high') {
    return { ok: false, error: 'риск должен быть low или high' }
  }
  return { ok: true, value: { criteria, footprint, risk } }
}

// ---------------------------------------------------------------------------
// Trusted git and the role worktree
// ---------------------------------------------------------------------------

/**
 * Git environment of the trusted factory commands. The owner's own config must
 * not choose hooks, filters or signing for a task worktree, and an inherited
 * `GIT_DIR` must not answer for another repository.
 */
function factoryGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME ?? 'dshbot'
  env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? 'dshbot@localhost'
  env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME ?? env.GIT_AUTHOR_NAME
  env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL ?? env.GIT_AUTHOR_EMAIL
  return env
}

/** Run one trusted git command; a failure carries the tail of git's own output. */
async function gitOutput(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: factoryGitEnv(),
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean }
    const detail = failureTail(failure.stderr, failure.stdout)
    throw new Error(`git ${args.join(' ')}: ${detail ?? failure.message}`)
  }
}

/** Same command, `undefined` when git says no. */
async function tryGit(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string | undefined> {
  try {
    return await gitOutput(cwd, args, timeoutMs)
  } catch {
    return undefined
  }
}

/**
 * Identity of a task worktree as git itself sees it. Captured while the
 * worktree is still trusted and read again before every host git command
 * that follows project code: a gate can rewrite the writable `.git` link and
 * redirect git at the owner's repository (the same guard as the evolve gate).
 */
interface WorktreeIdentity {
  /** Real git directory the worktree's `.git` link names. */
  gitDir: string
  /** Real git directory git reports for the worktree. */
  reported: string
  /** Real worktree root git reports. */
  toplevel: string
}

async function worktreeIdentity(path: string): Promise<WorktreeIdentity | undefined> {
  let link: string
  try {
    link = readFileSync(join(path, '.git'), 'utf8')
  } catch {
    return undefined
  }
  const match = /^gitdir:\s*(.+)\s*$/m.exec(link)
  if (match === null) return undefined
  const reported = await tryGit(path, ['rev-parse', '--git-dir'])
  const toplevel = await tryGit(path, ['rev-parse', '--show-toplevel'])
  if (reported === undefined || toplevel === undefined) return undefined
  return {
    gitDir: realOrResolved(resolve(path, match[1].trim())),
    reported: realOrResolved(resolve(path, reported.trim())),
    toplevel: realOrResolved(resolve(path, toplevel.trim())),
  }
}

/** True while the worktree still answers with the identity captured at creation. */
async function sameWorktree(path: string, expected: WorktreeIdentity): Promise<boolean> {
  const current = await worktreeIdentity(path)
  return current !== undefined &&
    current.gitDir === expected.gitDir &&
    current.reported === expected.reported &&
    current.toplevel === expected.toplevel
}

/** Characters that mean something only to a shell when they stand unquoted. */
const SHELL_ONLY = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', '\n'])

function shellCharName(char: string): string {
  return char === '\n' ? 'перевод строки' : `«${char}»`
}

/**
 * Split a project test command into argv. The gate starts no shell, not even
 * inside the sandbox: quotes and backslashes group words the way sh does,
 * leading `NAME=value` words go through `env`, and anything only a shell
 * understands (operators, redirections, expansions, globs, comments) is
 * refused instead of reaching the program as a literal argument.
 */
export function testCommandArgv(command: string): { argv: string[] } | { error: string } {
  const words: string[] = []
  const assignments: boolean[] = []
  let word = ''
  let inWord = false
  // Length of `word` before its first quoted or escaped character.
  let literal = Number.POSITIVE_INFINITY
  let quote: "'" | '"' | undefined
  const refuse = (char: string) => ({ error: `символ ${shellCharName(char)} понимает только оболочка` })
  const markQuoted = (): void => {
    inWord = true
    if (literal === Number.POSITIVE_INFINITY) literal = word.length
  }
  const endWord = (): void => {
    if (!inWord) return
    const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(word)
    assignments.push(name !== null && name[0].length <= literal)
    words.push(word)
    word = ''
    inWord = false
    literal = Number.POSITIVE_INFINITY
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (quote === '"') {
      const next = command[index + 1]
      if (char === '"') quote = undefined
      else if (char === '\\' && next !== undefined && '"\\$`\n'.includes(next)) {
        if (next !== '\n') word += next
        index += 1
      } else if (char === '$' || char === '`') return refuse(char)
      else word += char
      continue
    }
    if (char === ' ' || char === '\t') {
      endWord()
      continue
    }
    if (char === "'" || char === '"') {
      markQuoted()
      quote = char
      continue
    }
    if (char === '\\') {
      const next = command[index + 1]
      if (next === undefined) return { error: 'команда заканчивается обратной косой чертой' }
      index += 1
      if (next === '\n') continue
      markQuoted()
      word += next
      continue
    }
    if (SHELL_ONLY.has(char) || (!inWord && (char === '#' || char === '~'))) return refuse(char)
    word += char
    inWord = true
  }
  if (quote !== undefined) return { error: 'незакрытая кавычка' }
  endWord()
  const leading = assignments.findIndex((assignment) => !assignment)
  const split = leading === -1 ? words.length : leading
  const program = words.slice(split)
  if (program.length === 0) return { error: 'в команде нет программы' }
  if (program[0] === '') return { error: 'пустое имя программы' }
  if (split === 0) return { argv: program }
  // `env` would read a program name with `=` as one more assignment.
  if (program[0]!.includes('=')) return { error: `имя программы «${program[0]!}» содержит «=»` }
  return { argv: ['env', ...words.slice(0, split), ...program] }
}

/** Last characters of a failed gate, the remark of the next round. */
function outputTail(output: string): string {
  const text = output.trim()
  return text.length > GATE_TAIL_CHARS ? text.slice(text.length - GATE_TAIL_CHARS) : text
}

function roleLabelOf(role: FactoryRole): string {
  return FACTORY_ROLES.find((entry) => entry.key === role)?.label ?? role
}

/**
 * The stable system prompt of one execution role. The label comes first so the
 * harness session is recognisable in the journal; the reviewer prompt names no
 * other role, so it cannot inherit a misleading label.
 */
function roleSystemPrefix(
  role: Exclude<FactoryRole, 'analysis'>,
  task: { title: string; body: string; criteria: readonly string[]; footprint: readonly string[] },
): string {
  const lines = [
    `Ты — роль «${roleLabelOf(role)}» завода бота.`,
    `Задача: ${task.title}`,
    '',
    task.body,
    '',
    'Критерии приёмки:',
    ...task.criteria.map((criterion) => `- ${criterion}`),
    '',
    'Footprint задачи (разрешённые пути):',
    ...task.footprint.map((path) => `- ${path}`),
    '',
    'Ты работаешь в отдельной рабочей копии задачи. Инструменты чтения и записи',
    'принимают пути относительно её корня; всё вне копии, .env* и пути с secret/secrets запрещены.',
  ]
  if (role === 'test_writer') {
    lines.push(
      '',
      'Напиши красные тесты по критериям: они должны падать на текущем коде и проходить',
      'после правильной реализации. Меняй только тестовые файлы; продовый код не трогай.',
      'В конце верни только JSON без пояснений:',
      '{"tests":["путь/к/тесту"],"summary":"что покрыто"}',
    )
  } else if (role === 'executor') {
    lines.push(
      '',
      'Измени только файлы внутри footprint и не меняй тесты тестописца.',
      'В конце верни только JSON без пояснений:',
      '{"summary":"что изменено","files":["путь"]}',
    )
  } else {
    lines.push(
      '',
      'Проверь изменённые файлы против критериев приёмки. Тесты и код уже написаны;',
      'тебе доступно только чтение. Верни только JSON без пояснений:',
      '{"verdict":"approve","approved":true,"summary":"итог","issues":[],"comments":[]}',
      'Если есть замечания, верни verdict "reject", approved false и перечисли их в issues.',
    )
  }
  return lines.join('\n')
}

function writerPrompt(remark: string | undefined): string {
  const lines = ['Напиши красные тесты задачи по критериям и заверши ответом JSON.']
  if (remark !== undefined && remark.trim() !== '') {
    lines.push('', 'Замечание к прошлой попытке:', remark.trim())
  }
  return lines.join('\n')
}

function executorPrompt(remark: string | undefined): string {
  const lines = ['Выполни задачу: измени код внутри footprint, чтобы критерии выполнялись.']
  if (remark !== undefined && remark.trim() !== '') {
    lines.push('', 'Замечание прошлого круга (обязательно исправь):', remark.trim())
  }
  return lines.join('\n')
}

function reviewerPrompt(diff: string, stat: string): string {
  return [
    'Проверь дифф рабочей копии задачи против критериев.',
    '',
    'Изменённые файлы:',
    stat.trim() === '' ? '(пусто)' : stat.trim(),
    '',
    'Дифф:',
    diff.trim() === '' ? '(пусто)' : diff,
  ].join('\n')
}

/** Whether a changed path looks like a test file the writer owns. */
function looksLikeTestFile(path: string): boolean {
  const segments = pathSegments(path)
  return segments.some((segment) => ['tests', 'test', '__tests__', 'spec'].includes(segment)) ||
    /(?:^|\/)[^/]*(?:\.test\.|\.spec\.|test_[^/]*\.py|[^/]*_test\.(?:py|go|rs)$|conftest\.py$)/i.test(path)
}

/** Paths declared by the writer, plus any test file its turn changed. */
function writerTestPaths(text: string, changed: readonly string[]): string[] {
  const parsed = extractJson(text)
  const declared: string[] = []
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const tests = (parsed as Record<string, unknown>).tests
    if (Array.isArray(tests)) {
      for (const entry of tests) {
        if (typeof entry === 'string' && entry.trim() !== '') declared.push(entry.trim())
      }
    }
  }
  const paths = new Set(declared)
  for (const path of changed) if (looksLikeTestFile(path)) paths.add(path)
  return [...paths]
}

/** Whether a changed path is covered by one footprint entry. */
function footprintAllows(entry: string, path: string): boolean {
  const normalized = entry.trim().replaceAll('\\', '/').replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '')
  const target = path.replaceAll('\\', '/').replace(/^\/+/, '')
  if (normalized === '' || normalized === '.') return true
  return target === normalized || target.startsWith(`${normalized}/`)
}

/** Real absolute path of a role request, or a refusal. */
function resolveRoleTarget(root: string, requested: string): { path: string; relative: string } | { error: string } {
  const refusal = 'Путь недоступен: он вне рабочей копии задачи или запрещён.'
  const cleaned = requested.trim()
  if (cleaned === '' || isAbsolute(cleaned) || isForbiddenAnalysisPath(cleaned)) return { error: refusal }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return { error: refusal }
  }
  const lexical = resolve(realRoot, cleaned)
  if (lexical !== realRoot && !lexical.startsWith(`${realRoot}${sep}`)) return { error: refusal }
  if (isForbiddenAnalysisPath(lexical.slice(realRoot.length))) return { error: refusal }
  let real: string
  try {
    if (lstatSync(lexical).isSymbolicLink()) return { error: refusal }
    real = realpathSync(lexical)
  } catch {
    // A write may create a new file (and its directories): resolve the nearest
    // existing ancestor and append the missing components unchanged.
    let existing = dirname(lexical)
    const missing: string[] = [basename(lexical)]
    real = ''
    for (;;) {
      try {
        real = join(realpathSync(existing), ...[...missing].reverse())
        break
      } catch {
        const parent = dirname(existing)
        if (parent === existing) return { error: refusal }
        missing.push(basename(existing))
        existing = parent
      }
    }
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return { error: refusal }
  if (isForbiddenAnalysisPath(real.slice(realRoot.length))) return { error: refusal }
  return { path: real, relative: real.slice(realRoot.length).replaceAll(sep, '/') }
}

function roleReadTool(root: string): RunnerTool {
  return {
    name: 'read_file',
    description: 'Прочитать файл рабочей копии задачи (только чтение).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу относительно корня рабочей копии' },
      },
      required: ['path'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const requested = typeof args.path === 'string' ? args.path : ''
      const target = resolveRoleTarget(root, requested)
      if ('error' in target) return target.error
      let stats
      try {
        stats = statSync(target.path)
      } catch {
        return 'Файл не найден.'
      }
      if (!stats.isFile()) return 'Это не файл.'
      let content: string
      try {
        content = readFileSync(target.path, 'utf8')
      } catch {
        return 'Файл недоступен для чтения.'
      }
      const capped = content.length > ANALYSIS_READ_LIMIT
        ? `${content.slice(0, ANALYSIS_READ_LIMIT)}\n… (файл усечён)`
        : content
      return `Содержимое ${target.relative}:\n${capped}`
    },
  }
}

/**
 * One path as a snapshot sees it. The type is read with `lstat`, so a regular
 * file and a symlink carrying the same bytes are different states: a gate or an
 * executor can replace a locked test with a link to an allowed file, and only
 * the link itself, never the content it resolves to, belongs in the snapshot.
 * `none` stands for a missing path or an entry that is not a regular file.
 */
type EntryState =
  | { kind: 'file'; content: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'none' }

const ABSENT: EntryState = { kind: 'none' }

/** State of one path without following a symlink at any component. */
function entryState(path: string): EntryState {
  let stats
  try {
    stats = lstatSync(path)
  } catch {
    return ABSENT
  }
  if (stats.isSymbolicLink()) {
    try {
      return { kind: 'symlink', target: readlinkSync(path) }
    } catch {
      return ABSENT
    }
  }
  if (!stats.isFile()) return ABSENT
  try {
    return { kind: 'file', content: readFileSync(path, 'utf8') }
  } catch {
    return ABSENT
  }
}

/** Whether two captured states describe the same entry type and bytes/target. */
function sameEntryState(first: EntryState | undefined, second: EntryState | undefined): boolean {
  if (first === undefined || second === undefined) return first === second
  if (first.kind !== second.kind) return false
  if (first.kind === 'file' && second.kind === 'file') return first.content === second.content
  if (first.kind === 'symlink' && second.kind === 'symlink') return first.target === second.target
  return true
}

function isEntryState(value: unknown): value is EntryState {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (entry.kind === 'none') return true
  if (entry.kind === 'file') return typeof entry.content === 'string'
  if (entry.kind === 'symlink') return typeof entry.target === 'string' && entry.target !== ''
  return false
}

/**
 * Writer test snapshot stored in `writer_snapshot`, or undefined when the row
 * has none (an older daemon) or it cannot be trusted. Restart recovery uses
 * this marker to tell a recorded writer round from a status typed by hand.
 */
function parseEntrySnapshot(raw: string | null): Map<string, EntryState> | undefined {
  if (raw === null || raw.trim() === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const snapshot = new Map<string, EntryState>()
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length !== 2) return undefined
    const [path, state] = item as [unknown, unknown]
    if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path) || path.includes('\\') ||
      path.split('/').some((piece) => piece === '..') || !isEntryState(state)) {
      return undefined
    }
    snapshot.set(path, state)
  }
  return snapshot.size === 0 ? undefined : snapshot
}

/**
 * Absolute path of one worktree entry with every symlinked component removed.
 * Git never lists a path below a symlink, so such a link was planted later by
 * code run in the gate; restoring through it would write outside the worktree.
 */
function detachedPath(worktree: string, path: string): string {
  let current = worktree
  for (const part of path.split('/').filter((piece) => piece !== '' && piece !== '.')) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) rmSync(current, { force: true })
    } catch {
      // A missing component is created by the restore itself.
    }
  }
  return current
}

/**
 * Whether git ignores one path of the task worktree. `--no-index` also answers
 * for a file that does not exist yet, so the write tool refuses before it
 * creates something the accepted commit would silently drop.
 */
async function gitIgnores(root: string, relative: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', root, 'check-ignore', '--no-index', '-q', '--', relative], {
      encoding: 'utf8',
      env: factoryGitEnv(),
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    })
    return true
  } catch (error) {
    // Exit code 1 is git's "not ignored"; any other failure is not a licence to write.
    return (error as { code?: unknown }).code !== 1
  }
}

/**
 * The write tool records each path's content before its first write in
 * `journal`: git listings skip ignored files, the journal does not.
 */
function roleWriteTool(root: string, journal?: Map<string, EntryState>): RunnerTool {
  return {
    name: 'write_file',
    description: 'Записать файл рабочей копии задачи.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь к файлу относительно корня рабочей копии' },
        content: { type: 'string', description: 'Новое содержимое файла' },
      },
      required: ['path', 'content'],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const requested = typeof args.path === 'string' ? args.path : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const target = resolveRoleTarget(root, requested)
      if ('error' in target) return target.error
      const key = target.relative.replace(/^\/+/, '')
      if (await gitIgnores(root, key)) {
        return `Запись в ${target.relative} отклонена: путь игнорируется git и не попадёт в коммит задачи.`
      }
      if (journal !== undefined && !journal.has(key)) journal.set(key, entryState(target.path))
      try {
        mkdirSync(dirname(target.path), { recursive: true })
        writeFileSync(target.path, content)
      } catch (error) {
        return `Запись не удалась: ${error instanceof Error ? error.message : String(error)}`
      }
      return `Записан ${target.relative}.`
    },
  }
}

function roleTools(
  role: Exclude<FactoryRole, 'analysis'>,
  root: string,
  journal?: Map<string, EntryState>,
): RunnerTool[] {
  return role === 'reviewer' ? [roleReadTool(root)] : [roleReadTool(root), roleWriteTool(root, journal)]
}

/** Whether one absolute path is the other or lies inside it. */
function pathsOverlap(first: string, second: string): boolean {
  return first === second || first.startsWith(`${second}${sep}`) || second.startsWith(`${first}${sep}`)
}

/** Real form of a path that may not exist yet: its nearest existing ancestor is resolved. */
function realOrResolved(path: string): string {
  const missing: string[] = []
  let existing = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(existing), ...missing.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(path)
      missing.push(basename(existing))
      existing = parent
    }
  }
}

/** Text the executor needs from a rejecting review: the summary and every issue. */
function reviewRemark(verdict: { summary: string; raw: string }): string {
  const summary = verdict.summary.trim()
  const raw = verdict.raw.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(fenced?.[1]?.trim() ?? raw)
  } catch {
    // A free-form answer is the remark itself.
    const text = raw.length > REVIEW_REMARK_LIMIT ? `${raw.slice(0, REVIEW_REMARK_LIMIT)}\n… (усечено)` : raw
    return text === '' ? 'ревьюер не одобрил изменения' : text
  }
  const object = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const list = object.issues ?? object.findings ?? object.blocking
  const issues = (Array.isArray(list) ? list : [])
    .map((issue) => (typeof issue === 'string' ? issue : JSON.stringify(issue)).trim())
    .filter((issue) => issue !== '')
  const lines = [
    ...(summary === '' ? [] : [summary]),
    ...(issues.length === 0 ? [] : ['Замечания ревьюера:', ...issues.map((issue) => `- ${issue}`)]),
  ]
  if (lines.length === 0) return raw === '' ? 'ревьюер не одобрил изменения' : raw.slice(0, REVIEW_REMARK_LIMIT)
  const text = lines.join('\n')
  return text.length > REVIEW_REMARK_LIMIT ? `${text.slice(0, REVIEW_REMARK_LIMIT)}\n… (усечено)` : text
}

/** One row of `git diff --numstat` between the task base and its commit. */
interface DiffStat {
  path: string
  added: number
  removed: number
}

/** Parse `git diff --numstat` output; binary rows (`-`) count as zero lines. */
function parseDiffStats(output: string): DiffStat[] {
  const rows: DiffStat[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [added, removed, ...rest] = line.split('\t')
    const path = rest.join('\t').trim()
    if (added === undefined || removed === undefined || path === '') continue
    rows.push({
      path,
      added: added === '-' ? 0 : Number.parseInt(added, 10) || 0,
      removed: removed === '-' ? 0 : Number.parseInt(removed, 10) || 0,
    })
  }
  return rows.sort((first, second) => first.path.localeCompare(second.path))
}

/** Read back the stored diff rows; an old or broken value is an empty list. */
function statsOf(raw: string | null): DiffStat[] {
  if (raw === null || raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is DiffStat => {
      if (entry === null || typeof entry !== 'object') return false
      const row = entry as Record<string, unknown>
      return typeof row.path === 'string' && typeof row.added === 'number' && typeof row.removed === 'number'
    })
  } catch {
    return []
  }
}

/** Host of a git remote URL, so `notgithub.com` is not mistaken for GitHub. */
function remoteHost(url: string): string | undefined {
  const trimmed = url.trim()
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/.exec(trimmed)
  if (withScheme?.[1] !== undefined) return withScheme[1].toLowerCase()
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(trimmed)
  if (scp?.[1] !== undefined) return scp[1].toLowerCase()
  return undefined
}

/** Whether a remote URL points at github.com (https, ssh or scp syntax). */
function isGithubRemote(url: string): boolean {
  return remoteHost(url) === 'github.com'
}

/** Bounded reason of a failed merge stage; the cause comes last, so the end stays. */
function mergeReason(message: string): string {
  const text = message.trim()
  return text.length > MERGE_REASON_LIMIT ? `… (усечено)\n${text.slice(-MERGE_REASON_LIMIT)}` : text
}

/** Last non-empty lines of a failed command's first non-empty stream. */
function failureTail(...streams: ReadonlyArray<string | undefined>): string | undefined {
  for (const stream of streams) {
    const lines = (stream ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    if (lines.length > 0) return lines.slice(-FAILURE_TAIL_LINES).join('\n')
  }
  return undefined
}

/** Factory data and the `/factory` navigation built on it. */
export function createFactory(options: FactoryOptions): Factory {
  const { store, api, home } = options
  store.migrate('factory', FACTORY_STEPS)

  const appDirectory = join(home, 'app')
  const ownPath = existsSync(appDirectory) && statSync(appDirectory).isDirectory() ? appDirectory : options.appRoot
  const ownProject: FactoryProject = {
    id: 0,
    path: ownPath,
    name: basename(ownPath),
    testCommand: DEFAULT_TEST_COMMAND,
    own: true,
  }

  const listProjectsStatement = store.db.prepare(
    'SELECT id, path, name, test_command, created_at FROM factory_projects ORDER BY id',
  )
  const findProjectStatement = store.db.prepare(
    'SELECT id, path, name, test_command, created_at FROM factory_projects WHERE id = ?',
  )
  const findProjectByPathStatement = store.db.prepare(
    'SELECT id, path, name, test_command, created_at FROM factory_projects WHERE path = ?',
  )
  const insertProjectStatement = store.db.prepare(
    'INSERT INTO factory_projects (path, name, test_command, created_at) VALUES (?, ?, ?, ?)',
  )
  const updateProjectCommandStatement = store.db.prepare(
    'UPDATE factory_projects SET test_command = ? WHERE id = ?',
  )
  const deleteProjectStatement = store.db.prepare('DELETE FROM factory_projects WHERE id = ?')
  const TASK_COLUMNS = `id, title, body, status, project_id, project_name, project_path, created_at,
    criteria, footprint, risk, risk_reason, remark, analysis_running, execution_stage,
    execution_round, execution_note, result_files, worktree, queued_at, result_base, result_stats,
    worktree_identity, acceptance_message_id, acceptance_chat_id, resume_remark, writer_tests,
    writer_snapshot, worktree_base`
  const listTasksStatement = store.db.prepare(
    `SELECT ${TASK_COLUMNS} FROM factory_tasks ORDER BY id DESC`,
  )
  const findTaskStatement = store.db.prepare(
    `SELECT ${TASK_COLUMNS} FROM factory_tasks WHERE id = ?`,
  )
  const insertTaskStatement = store.db.prepare(
    `INSERT INTO factory_tasks (title, body, status, project_id, project_name, project_path, created_at)
     VALUES (?, ?, 'incoming', ?, ?, ?, ?)`,
  )
  const markAnalysisStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'analysis', remark = ?, analysis_running = 1 WHERE id = ?`,
  )
  const saveAnalysisStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'awaiting_approval', criteria = ?, footprint = ?, risk = ?,
       risk_reason = ?, remark = NULL, analysis_running = 0, execution_stage = NULL,
       execution_round = NULL, execution_note = NULL, result_files = NULL, worktree = NULL,
       queued_at = NULL WHERE id = ?`,
  )
  const failAnalysisStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'incoming', criteria = NULL, footprint = NULL, risk = NULL,
       risk_reason = NULL, remark = NULL, analysis_running = 0 WHERE id = ?`,
  )
  const setStatusStatement = store.db.prepare('UPDATE factory_tasks SET status = ? WHERE id = ?')
  const approveStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'queued', queued_at = ? WHERE id = ?`,
  )
  const setWorktreeStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'running', worktree = ?, execution_stage = 'tests',
       execution_round = 1, execution_note = NULL, result_files = NULL, result_base = NULL,
       result_stats = NULL, worktree_identity = NULL, resume_remark = NULL, writer_tests = NULL,
       writer_snapshot = NULL, worktree_base = NULL WHERE id = ?`,
  )
  const saveIdentityStatement = store.db.prepare(
    'UPDATE factory_tasks SET worktree_identity = ? WHERE id = ?',
  )
  const saveWorktreeBaseStatement = store.db.prepare(
    'UPDATE factory_tasks SET worktree_base = ? WHERE id = ?',
  )
  const saveWriterTestsStatement = store.db.prepare(
    'UPDATE factory_tasks SET writer_tests = ?, writer_snapshot = ? WHERE id = ?',
  )
  const progressStatement = store.db.prepare(
    'UPDATE factory_tasks SET execution_stage = ?, execution_round = ? WHERE id = ?',
  )
  const finishStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'awaiting_human', execution_note = ?, result_files = ?,
       result_base = ?, result_stats = ?, execution_stage = NULL, execution_round = NULL,
       resume_remark = NULL WHERE id = ?`,
  )
  const failMergeStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'awaiting_human', execution_note = ?, execution_stage = NULL,
       execution_round = NULL, resume_remark = NULL WHERE id = ?`,
  )
  const markMergedStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'merged', execution_note = NULL, execution_stage = NULL,
       execution_round = NULL, resume_remark = NULL WHERE id = ?`,
  )
  const saveAcceptanceCardStatement = store.db.prepare(
    'UPDATE factory_tasks SET acceptance_message_id = ?, acceptance_chat_id = ? WHERE id = ?',
  )
  const retryResumeStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'queued', queued_at = ?, resume_remark = ?, execution_note = ?,
       execution_stage = 'execution', execution_round = 1 WHERE id = ?`,
  )
  const countByStatusStatement = store.db.prepare(
    'SELECT COUNT(*) AS count FROM factory_tasks WHERE status IN (?, ?)',
  )
  const resetRunningStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'running', worktree = NULL, execution_stage = 'tests',
       execution_round = 1, execution_note = NULL, result_files = NULL, resume_remark = NULL,
       writer_tests = NULL, writer_snapshot = NULL, worktree_base = NULL WHERE id = ?`,
  )
  const requeueStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'queued', queued_at = COALESCE(queued_at, ?), worktree = NULL,
       execution_stage = NULL, execution_round = NULL, execution_note = NULL, result_files = NULL,
       resume_remark = NULL, writer_tests = NULL, writer_snapshot = NULL, worktree_base = NULL WHERE id = ?`,
  )
  /** Keep the recorded worktree and start its first executor round after a restart. */
  const resumeRunningStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'running', execution_stage = 'execution', execution_round = 1,
       execution_note = NULL, result_files = NULL, resume_remark = ? WHERE id = ?`,
  )
  const resumeQueuedStatement = store.db.prepare(
    `UPDATE factory_tasks SET status = 'queued', queued_at = COALESCE(queued_at, ?),
       execution_stage = 'execution', execution_round = 1, execution_note = NULL,
       result_files = NULL, resume_remark = ? WHERE id = ?`,
  )
  const clearApprovalStatement = store.db.prepare(
    'UPDATE factory_tasks SET queued_at = NULL WHERE id = ?',
  )

  let pending: PendingInput | undefined
  /** At most one provider sign-in runs at a time: a second attempt would prompt the same owner. */
  let providerSignIn: ProviderSignIn | undefined

  /** Chat and topic a task's analysis card must reach (the owner's chat). */
  const taskTargets = new Map<number, { chatId: number; threadId?: number }>()
  const analysisQueue: AnalysisJob[] = []
  let analysisRunning = false
  let analysisSequence = 0

  /**
   * Execution runs one task at a time. The queue holds ids approved by the
   * owner; a second approval waits in `queued` until the first task settles.
   */
  const executionQueue: number[] = []
  let executionRunning = false
  /** Restart recovery holds the queue until interrupted worktrees are gone. */
  let executionHeld = false
  let executionSequence = 0
  let roleSequence = 0
  /** Provider of the model the executor of a task last worked on. */
  const executorProviders = new Map<number, string>()
  /** Acceptance/merge queue: one task at a time, like execution. */
  const acceptanceQueue: number[] = []
  let acceptanceRunning = false
  /**
   * Identifies this daemon generation. Role session ids include it so a task
   * resumed after a restart never reopens the interrupted run's history.
   */
  const executionGeneration = randomUUID()
  /** Messages showing one task detail card (`messageId → chatId`); progress edits them in place. */
  const taskCards = new Map<number, Map<number, number>>()
  const sandbox: SandboxRunner = options.sandbox ?? sandboxedTests
  const ownerHome = resolve(options.ownerHome ?? process.env.HOME ?? homedir())

  function log(message: string): void {
    options.log?.(`factory: ${message}`)
  }

  function projectOf(row: ProjectRow): FactoryProject {
    return { id: row.id, path: row.path, name: row.name, testCommand: row.test_command, own: false }
  }

  function projects(): FactoryProject[] {
    const rows = listProjectsStatement.all() as unknown as ProjectRow[]
    return [ownProject, ...rows.map(projectOf)]
  }

  function projectById(id: number): FactoryProject | undefined {
    if (id === ownProject.id) return ownProject
    const row = findProjectStatement.get(id) as ProjectRow | undefined
    return row === undefined ? undefined : projectOf(row)
  }

  function taskOf(row: TaskRow): FactoryTask {
    const stage = row.execution_stage === 'tests' || row.execution_stage === 'execution' ||
      row.execution_stage === 'gate' || row.execution_stage === 'review'
      ? row.execution_stage
      : undefined
    const round = typeof row.execution_round === 'number' && Number.isSafeInteger(row.execution_round)
      ? row.execution_round
      : undefined
    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: statusOf(row.status),
      projectId: row.project_id,
      projectName: row.project_name,
      projectPath: row.project_path,
      createdAt: row.created_at,
      criteria: listOf(row.criteria),
      footprint: listOf(row.footprint),
      ...(riskOf(row.risk) === undefined ? {} : { risk: riskOf(row.risk)! }),
      ...(row.risk_reason === null ? {} : { riskReason: row.risk_reason }),
      ...(row.execution_note === null ? {} : { reason: row.execution_note }),
      changedFiles: listOf(row.result_files),
      ...(stage === undefined || round === undefined ? {} : { progress: { stage, round } }),
    }
  }

  function tasks(): FactoryTask[] {
    const rows = listTasksStatement.all() as unknown as TaskRow[]
    return rows.map(taskOf)
  }

  function taskCounts(): { running: number; waitingOwner: number } {
    const running = countByStatusStatement.get('running', 'running') as { count: number } | undefined
    const waiting = countByStatusStatement.get('awaiting_approval', 'awaiting_human') as
      | { count: number }
      | undefined
    return { running: Number(running?.count ?? 0), waitingOwner: Number(waiting?.count ?? 0) }
  }

  function autoacceptEnabled(): boolean {
    return store.kv.get(AUTOACCEPT_KV_KEY) !== '0'
  }

  async function catalogue(): Promise<FactoryModel[]> {
    let raw: readonly FactoryModel[]
    try {
      raw = await options.catalogue()
    } catch (error) {
      log(`model catalogue failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const seen = new Set<string>()
    const models: FactoryModel[] = []
    for (const model of raw) {
      if (typeof model?.provider !== 'string' || model.provider === '') continue
      if (typeof model.id !== 'string' || model.id === '') continue
      if (model.id === FACTORY_EXCLUDED_MODEL_ID) continue
      const key = modelKey(model)
      if (seen.has(key)) continue
      seen.add(key)
      models.push({
        provider: model.provider,
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
      })
    }
    return models
  }

  /** The saved choice of a role in priority order, or undefined before any choice. */
  function storedRoleModels(role: FactoryRole): string[] | undefined {
    const raw = store.kv.get(`${ROLE_MODELS_KV_PREFIX}${role}`)
    if (raw === undefined) return undefined
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return undefined
      const keys = [...new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))]
      return keys.length === 0 ? undefined : keys
    } catch {
      return undefined
    }
  }

  /**
   * The models of a role in priority order; the first one runs its turns. A
   * role without a usable choice runs on the stock flash, or on the first
   * catalogue model when the catalogue has no flash.
   */
  function rolePriority(role: FactoryRole, models: readonly FactoryModel[]): FactoryModel[] {
    const byKey = new Map(models.map((model) => [modelKey(model), model]))
    // A role the owner saved with `pro` keeps its other choices; the excluded
    // model itself becomes flash, so an old all-pro choice runs on flash.
    const flash = models.find((model) => model.id === DEFAULT_MODEL)
    const excludedSuffix = `\u0000${FACTORY_EXCLUDED_MODEL_ID}`
    const ordered: FactoryModel[] = []
    for (const key of storedRoleModels(role) ?? []) {
      const model = byKey.get(key) ?? (key.endsWith(excludedSuffix) ? flash : undefined)
      if (model !== undefined && !ordered.includes(model)) ordered.push(model)
    }
    if (ordered.length > 0) return ordered
    const fallback = flash ?? models[0]
    return fallback === undefined ? [] : [fallback]
  }

  function enabledModels(role: FactoryRole, models: readonly FactoryModel[]): Set<string> {
    return new Set(rolePriority(role, models).map(modelKey))
  }

  function saveRolePriority(role: FactoryRole, ordered: readonly FactoryModel[]): void {
    store.kv.set(`${ROLE_MODELS_KV_PREFIX}${role}`, JSON.stringify(ordered.map(modelKey)))
  }

  function roleOf(index: string | undefined): FactoryRole | undefined {
    if (index === undefined) return undefined
    const numeric = Number(index)
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < FACTORY_ROLES.length
      ? FACTORY_ROLES[numeric]!.key
      : undefined
  }

  /** The stored reasoning level of a role, or undefined before any choice. */
  function storedRoleEffort(role: FactoryRole): string | undefined {
    const raw = store.kv.get(`${ROLE_EFFORT_KV_PREFIX}${role}`)?.trim().toLowerCase()
    return raw === undefined || raw === '' ? undefined : raw
  }

  /**
   * Levels the adapter reports for one exact model. A failed lookup is the
   * same as no capabilities: the generic four keep the menu usable.
   */
  async function modelReasoningLevels(model: FactoryModel): Promise<readonly string[] | undefined> {
    if (options.modelLevels === undefined) return undefined
    try {
      const levels = await options.modelLevels(model.provider, model.id)
      if (levels === undefined) return undefined
      const seen = new Set<string>()
      const normalized: string[] = []
      for (const level of levels) {
        if (typeof level !== 'string') continue
        const value = level.trim().toLowerCase()
        if (value === '' || seen.has(value)) continue
        seen.add(value)
        normalized.push(value)
      }
      return normalized.length > 0 ? normalized : undefined
    } catch (error) {
      log(`model levels of "${model.provider}/${model.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** The model of a role with priority 1: the one that runs its turns. */
  function firstEnabledModel(role: FactoryRole, models: readonly FactoryModel[]): FactoryModel | undefined {
    return rolePriority(role, models)[0]
  }

  /** Levels offered on the role screen: those of the first enabled model. */
  async function roleReasoningLevels(
    role: FactoryRole,
    models: readonly FactoryModel[],
  ): Promise<readonly string[]> {
    const model = firstEnabledModel(role, models)
    const levels = model === undefined ? undefined : await modelReasoningLevels(model)
    return levels ?? REASONING_EFFORTS
  }

  /** The level marked on the role screen: the stored one when the model offers it. */
  function shownRoleEffort(role: FactoryRole, levels: readonly string[]): string | undefined {
    const stored = storedRoleEffort(role)
    if (stored !== undefined) return levels.includes(stored) ? stored : undefined
    return levels.includes(DEFAULT_ROLE_EFFORT) ? DEFAULT_ROLE_EFFORT : undefined
  }

  /**
   * Level of a role turn. A stored level the current model no longer offers is
   * dropped instead of sent: the harness refuses an unsupported effort before
   * the request, and the role must fall back to the model default. Without a
   * choice the role keeps the historical `high` when the model supports it.
   */
  async function roleTurnEffort(role: FactoryRole, model: FactoryModel): Promise<string | undefined> {
    const stored = storedRoleEffort(role)
    const levels = await modelReasoningLevels(model)
    if (stored !== undefined) {
      return levels !== undefined && levels.includes(stored) ? stored : undefined
    }
    if (levels !== undefined && levels.includes(DEFAULT_ROLE_EFFORT)) return DEFAULT_ROLE_EFFORT
    return undefined
  }

  function modelOf(models: readonly FactoryModel[], hash: string | undefined): FactoryModel | undefined {
    if (hash === undefined) return undefined
    return models.find((model) => modelHash(model) === hash)
  }

  function analysisMarkdown(task: FactoryTask, footer?: string): string {
    const lines = [`**Разбор задачи #${task.id}**`, `**Проект:** ${task.projectName}`]
    if (task.criteria.length > 0) {
      lines.push('', '**Критерии:**', ...task.criteria.map((criterion) => `- ${criterion}`))
    }
    if (task.footprint.length > 0) {
      lines.push('', '**Footprint:**', ...task.footprint.map((path) => `- ${path}`))
    }
    if (task.risk !== undefined) {
      lines.push('', `**Риск:** ${task.risk}`)
      if (task.riskReason !== undefined) lines.push(`**Причина:** ${task.riskReason}`)
    }
    if (footer !== undefined) lines.push('', footer)
    return lines.join('\n')
  }

  function analysisKeyboard(taskId: number): Array<Array<Record<string, unknown>>> {
    return [[
      button('Одобрить', `aa:${taskId}`, 'success'),
      button('Править', `ae:${taskId}`),
      button('Отменить', `ar:${taskId}`, 'danger'),
    ]]
  }

  function taskScreen(id: number): Screen {
    const row = findTaskStatement.get(id) as TaskRow | undefined
    if (row === undefined) {
      return { markdown: 'Задача не найдена.', keyboard: [[button('Назад', 's:t')]] }
    }
    const task = taskOf(row)
    const lines = [
      `#${row.id}`,
      `Проект: ${row.project_name}`,
      `Статус: ${FACTORY_STATUS_LABELS[task.status]}`,
    ]
    if (task.progress !== undefined) {
      lines.push('', `**Этап:** ${FACTORY_STAGE_LABELS[task.progress.stage]} · круг ${task.progress.round} из ${FACTORY_MAX_ROUNDS}`)
    }
    if (task.reason !== undefined && task.reason !== '') lines.push('', `**Причина:** ${task.reason}`)
    if (task.criteria.length > 0) lines.push('', '**Критерии:**', ...task.criteria.map((criterion) => `- ${criterion}`))
    if (task.footprint.length > 0) lines.push('', '**Footprint:**', ...task.footprint.map((path) => `- ${path}`))
    if (task.changedFiles.length > 0) {
      lines.push('', '**Изменённые файлы:**', ...task.changedFiles.map((path) => `- ${path}`))
    }
    if (task.risk !== undefined) {
      lines.push('', `**Риск:** ${task.risk}`)
      if (task.riskReason !== undefined) lines.push(`**Причина:** ${task.riskReason}`)
    }
    lines.push('', literal(row.body))
    // The panel is the one place a task stays reachable after its card has
    // scrolled away, so the actions of the current status belong here too: a
    // task waiting for acceptance with no buttons anywhere is a dead end.
    const keyboard: Array<Array<Record<string, unknown>>> = []
    if (task.status === 'awaiting_approval') keyboard.push(...analysisKeyboard(row.id))
    else if (task.status === 'awaiting_human') keyboard.push(...acceptanceKeyboard(row.id, hasResult(row)))
    keyboard.push([button('Назад', 's:t')])
    return {
      markdown: lines.join('\n'),
      keyboard,
    }
  }

  function homeScreen(): Screen {
    const counts = taskCounts()
    return {
      markdown: [
        '**🏭 Завод**',
        '',
        `В работе: ${counts.running} · ждут владельца: ${counts.waitingOwner}`,
        `Автоприёмка: ${autoacceptEnabled() ? 'включена' : 'выключена'}`,
      ].join('\n'),
      keyboard: [
        [button('Задачи', 's:t'), button('Новая задача', 's:n', 'success')],
        [button('Проекты', 's:p'), button('Модели', 's:m')],
        [button('Провайдеры', 's:v'), button('Автоприёмка', 's:a')],
      ],
    }
  }

  function tasksScreen(pageIndex = 0): Screen {
    const rows = tasks()
    const pages = Math.max(1, Math.ceil(rows.length / TASK_PAGE_SIZE))
    const page = Math.min(Math.max(0, Math.trunc(pageIndex)), pages - 1)
    const visible = rows.slice(page * TASK_PAGE_SIZE, (page + 1) * TASK_PAGE_SIZE)
    const keyboard: Array<Array<Record<string, unknown>>> = visible.map((task) => [
      button(`#${task.id} ${FACTORY_STATUS_LABELS[task.status]} ${task.title}`, `t:${task.id}`),
    ])
    const navigation: Array<Record<string, unknown>> = []
    if (page > 0) navigation.push(button('← Предыдущая', `s:t:${page - 1}`))
    if (page + 1 < pages) navigation.push(button('Следующая →', `s:t:${page + 1}`))
    if (navigation.length > 0) keyboard.push(navigation)
    keyboard.push([button(page === 0 ? 'Назад' : '🏠 Меню', 'h')])
    const heading = rows.length === 0
      ? '**Задачи**\nПока пусто.'
      : `**Задачи**\nСтраница ${page + 1} из ${pages}`
    return { markdown: heading, keyboard }
  }

  function projectsScreen(): Screen {
    return {
      markdown: '**Проекты**\nСвой репозиторий подключён всегда.',
      keyboard: [
        ...projects().map((project) => [
          button(`${project.own ? '🟢' : '📁'} ${project.name}`, `p:${project.id}`),
        ]),
        [button('Добавить', 'pa')],
        [button('Назад', 'h')],
      ],
    }
  }

  function projectScreen(id: number): Screen {
    const project = projectById(id)
    if (project === undefined) {
      return { markdown: 'Проект не найден.', keyboard: [[button('Назад', 's:p')]] }
    }
    const rows: Array<Array<Record<string, unknown>>> = []
    if (!project.own) rows.push([button('Удалить', `pd:${project.id}`, 'danger')])
    rows.push([button('Назад', 's:p')])
    return {
      markdown: [
        `**${project.own ? '🟢' : '📁'} ${project.name}**`,
        literal(project.path),
        'Команда тестов:',
        literal(project.testCommand),
      ].join('\n'),
      keyboard: rows,
    }
  }

  function addProjectScreen(): Screen {
    return {
      markdown: [
        '**Новый проект**',
        'Пришлите двумя строками:',
        '1. путь к git-репозиторию',
        '2. команда тестов (запускается без оболочки: `&&`, `;`, перенаправления и `$` выносите в скрипт проекта)',
      ].join('\n'),
      keyboard: [[button('Назад', 's:p')]],
    }
  }

  function newTaskScreen(projectId: number): Screen {
    const project = projectById(projectId) ?? ownProject
    return {
      markdown: ['**Новая задача**', `Проект: ${project.name}`, 'Пришлите текст задачи.'].join('\n'),
      keyboard: [
        ...projects().map((entry) => [button(`📁 ${entry.name}`, `np:${entry.id}`)]),
        [button('Назад', 'h')],
      ],
    }
  }

  function modelsScreen(): Screen {
    return {
      markdown: '**Модели**\nВыберите роль.',
      keyboard: [
        ...FACTORY_ROLES.map((role, index) => [button(role.label, `m:${index}`)]),
        [button('Назад', 'h')],
      ],
    }
  }

  /** Connectable providers in the order the runner advertises them. */
  async function providerList(): Promise<readonly FactoryProviderInfo[]> {
    if (options.providers === undefined) return []
    try {
      return await options.providers()
    } catch (error) {
      log(`provider list failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  function providerById(list: readonly FactoryProviderInfo[], id: string): FactoryProviderInfo | undefined {
    return list.find((provider) => provider.id === id)
  }

  async function providersScreen(): Promise<Screen> {
    const list = await providerList()
    const keyboard: Array<Array<Record<string, unknown>>> = list.map((provider) => [
      button(`${provider.connected ? '✅' : '⬜'} ${provider.name} (${provider.id})`, `pr:${provider.id}`),
    ])
    keyboard.push([button('Назад', 'h')])
    return {
      markdown: [
        '**Провайдеры**',
        list.length === 0
          ? 'Провайдеров для подключения нет.'
          : 'Выберите провайдера, чтобы подключить или отключить вход.',
      ].join('\n'),
      keyboard,
    }
  }

  async function providerScreen(id: string): Promise<Screen> {
    const list = await providerList()
    const provider = providerById(list, id)
    if (provider === undefined) {
      return { markdown: 'Провайдер не найден.', keyboard: [[button('Назад', 's:v')]] }
    }
    const keyboard: Array<Array<Record<string, unknown>>> = provider.methods.map((method, index) => [
      button(method.label, `pm:${provider.id}:${index}`),
    ])
    if (provider.connected) keyboard.push([button('Отключить', `po:${provider.id}`, 'danger')])
    keyboard.push([button('Назад', 's:v')])
    return {
      markdown: [
        `**${provider.name}** (${provider.id})`,
        '',
        `Состояние: ${provider.connected ? 'подключён' : 'не подключён'}`,
        provider.methods.length === 0
          ? 'Способ входа не объявлен.'
          : 'Выберите способ входа.',
      ].join('\n'),
      keyboard,
    }
  }

  async function roleScreen(index: string | undefined): Promise<Screen> {
    const role = roleOf(index)
    if (role === undefined) return modelsScreen()
    const models = await catalogue()
    const priority = rolePriority(role, models)
    const label = FACTORY_ROLES.find((entry) => entry.key === role)?.label ?? role
    if (models.length === 0) {
      return {
        markdown: `**${label}**\nМодели не подключены.`,
        keyboard: [[button('Назад', 's:m')]],
      }
    }
    const levels = await roleReasoningLevels(role, models)
    const marked = shownRoleEffort(role, levels)
    const enabled = new Set(priority.map(modelKey))
    const providers = providersOf(models)
    return {
      markdown: [
        `**${label}**`,
        'Сверху включённые модели по приоритету: ход роли идёт на первой, «⬆️» поднимает модель на одну позицию.',
        'Провайдер открывает свои модели: там их можно включить или выключить.',
        'Уровень рассуждения роли — ряд кнопок под провайдерами; по умолчанию `high`.',
      ].join('\n'),
      keyboard: [
        ...priority.map((model, position) => [
          button(`✅ ${position + 1}. ${model.name}`, `mg:${index}:${modelHash(model)}`),
          ...(position === 0 ? [] : [button('⬆️', `mu:${index}:${modelHash(model)}`)]),
        ]),
        ...providers.map((provider) => {
          const all = models.filter((model) => model.provider === provider)
          const on = all.filter((model) => enabled.has(modelKey(model))).length
          return [button(`${provider} ${on}/${all.length}`, `mp:${index}:${providerHash(provider)}:0`)]
        }),
        levels.map((level) =>
          button(`${marked === level ? '✅' : '⬜'} ${level}`, `me:${index}:${level}`)),
        [button('Назад', 's:m')],
      ],
    }
  }

  /** One page of a provider's models as switches; the model reaches its page by position. */
  async function roleProviderScreen(index: string | undefined, provider: string, page: number): Promise<Screen> {
    const role = roleOf(index)
    if (role === undefined) return modelsScreen()
    const models = await catalogue()
    const own = models.filter((model) => model.provider === provider)
    if (own.length === 0) return roleScreen(index)
    const enabled = enabledModels(role, models)
    const pages = Math.ceil(own.length / ROLE_MODELS_PAGE_SIZE)
    const current = Math.min(Math.max(page, 0), pages - 1)
    const label = FACTORY_ROLES.find((entry) => entry.key === role)?.label ?? role
    const hash = providerHash(provider)
    const navigation = [
      ...(current > 0 ? [button('◀️', `mp:${index}:${hash}:${current - 1}`)] : []),
      ...(current < pages - 1 ? [button('▶️', `mp:${index}:${hash}:${current + 1}`)] : []),
    ]
    return {
      markdown: [
        `**${label}: ${provider}**`,
        `Страница ${current + 1} из ${pages}. Нажмите модель, чтобы включить или выключить её; включённая встаёт в конец приоритета.`,
      ].join('\n'),
      keyboard: [
        ...own.slice(current * ROLE_MODELS_PAGE_SIZE, (current + 1) * ROLE_MODELS_PAGE_SIZE).map((model) => [
          button(`${enabled.has(modelKey(model)) ? '✅' : '⬜'} ${model.name}`, `mt:${index}:${modelHash(model)}`),
        ]),
        ...(navigation.length === 0 ? [] : [navigation]),
        [button('Назад', `m:${index}`)],
      ],
    }
  }

  /** The provider page that holds the model. */
  async function roleModelPage(index: string | undefined, model: FactoryModel): Promise<Screen> {
    const own = (await catalogue()).filter((candidate) => candidate.provider === model.provider)
    const position = own.findIndex((candidate) => modelKey(candidate) === modelKey(model))
    return roleProviderScreen(index, model.provider, Math.floor(Math.max(position, 0) / ROLE_MODELS_PAGE_SIZE))
  }

  function autoacceptScreen(): Screen {
    const enabled = autoacceptEnabled()
    return {
      markdown: [
        '**Автоприёмка**',
        `Автоприёмка: ${enabled ? 'включена' : 'выключена'}`,
        'Низкий риск — автоматически, высокий — всегда через владельца.',
      ].join('\n'),
      keyboard: [
        [button(enabled ? 'Выключить автоприёмку' : 'Включить автоприёмку', 'at')],
        [button('Назад', 'h')],
      ],
    }
  }

  /** Send the home screen as one new message with the ordinary rich → HTML → plain ladder. */
  async function sendHome(chatId: number, threadId?: number): Promise<void> {
    const screen = homeScreen()
    await sendFormatted(api, chatId, screen.markdown, {
      ...(threadId === undefined ? {} : { threadId }),
      replyMarkup: { inline_keyboard: screen.keyboard },
    })
  }

  /**
   * Edit the menu message in place. Rich Markdown is tried first; a 400 falls
   * back to HTML and then to plain text of the same markup. A refusal of the
   * text itself never turns navigation into a new message.
   */
  async function editScreen(chatId: number, messageId: number, screen: Screen): Promise<void> {
    const replyMarkup = { inline_keyboard: screen.keyboard }
    try {
      await api.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        rich_message: { markdown: screen.markdown },
        reply_markup: replyMarkup,
      })
      return
    } catch (error) {
      // "message is not modified" means the card already shows exactly this:
      // a repeated press changed nothing and must not count as a failure.
      if (isNotModified(error)) return
      if (!isBadRequest(error)) throw error
    }
    try {
      await api.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: markdownToHtml(screen.markdown),
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      })
      return
    } catch (error) {
      if (isNotModified(error)) return
      if (!isBadRequest(error) || !isEntityParseError(error)) throw error
    }
    try {
      await api.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: markdownToPlain(screen.markdown),
        reply_markup: replyMarkup,
      })
    } catch (error) {
      if (!isNotModified(error)) throw error
    }
  }

  async function answer(callbackId: string, text: string): Promise<void> {
    try {
      await api.call('answerCallbackQuery', { callback_query_id: callbackId, text })
    } catch (error) {
      log(`callback answer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function isOwner(callback: FactoryCallback): boolean {
    const owner = options.ownerId()
    return owner !== null && callback.chatId === owner && callback.fromId === owner
  }

  async function addProject(text: string): Promise<string> {
    const lines = text.split(/\r?\n/)
    const first = lines.findIndex((line) => line.trim() !== '')
    if (first < 0) return 'Пришлите путь и команду тестов двумя строками.'
    const rawPath = lines[first]!.trim()
    const rawCommand = lines.slice(first + 1).join('\n').trim()
    const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(home, rawPath)
    if (!existsSync(path)) return `Каталог не существует: ${path}`
    const problem = await gitRepositoryProblem(path)
    if (problem !== undefined) return `Не является git-репозиторием: ${path}\n${problem}`
    if (rawCommand === '') return 'Пришлите команду тестов второй строкой.'
    const parsed = testCommandArgv(rawCommand)
    if ('error' in parsed) {
      return `Команда тестов не запускается без оболочки: ${parsed.error}. Вынесите её в скрипт проекта (например, npm run <скрипт>).`
    }
    const name = basename(path)
    const existing = findProjectByPathStatement.get(path) as ProjectRow | undefined
    if (existing !== undefined) {
      updateProjectCommandStatement.run(rawCommand, existing.id)
      return `Проект ${name} обновлён: команда тестов сохранена.`
    }
    insertProjectStatement.run(path, name, rawCommand, Date.now())
    return `Проект ${name} добавлен.`
  }

  function insertTask(text: string, projectId: number, title?: string): number {
    const project = projectById(projectId) ?? ownProject
    const body = text.trim() === '' ? '' : text
    if (body.trim() === '') throw new Error('текст задачи пуст')
    const heading = title === undefined || title.trim() === '' ? titleOf(body) : title.trim()
    const result = insertTaskStatement.run(
      [...heading].slice(0, TASK_TITLE_LIMIT).join(''),
      body,
      project.id,
      project.name,
      project.path,
      Date.now(),
    )
    return Number(result.lastInsertRowid)
  }

  async function sendCard(job: AnalysisJob, markdown: string, keyboard: Array<Array<Record<string, unknown>>>): Promise<void> {
    await sendFormatted(api, job.chatId, markdown, {
      ...(job.threadId === undefined ? {} : { threadId: job.threadId }),
      replyMarkup: { inline_keyboard: keyboard },
    })
  }

  async function sendAnalysisCard(job: AnalysisJob, row: TaskRow): Promise<void> {
    const task = taskOf(row)
    await sendCard(job, analysisMarkdown(task), analysisKeyboard(task.id))
  }

  async function sendAnalysisFailure(job: AnalysisJob, reason: string): Promise<void> {
    await sendCard(
      job,
      [
        `**Разбор задачи #${job.taskId} не удался**`,
        'Задача возвращена во входящие.',
        `Причина: ${reason}`,
      ].join('\n'),
      [[button('Повторить разбор', `ay:${job.taskId}`)]],
    )
  }

  /**
   * Analysis turns are serial across the whole factory: the second incoming
   * task waits in `incoming` until the first turn finishes.
   */
  function enqueueAnalysis(job: AnalysisJob): void {
    analysisQueue.push(job)
    void drainAnalysis()
  }

  async function drainAnalysis(): Promise<void> {
    if (analysisRunning) return
    analysisRunning = true
    try {
      while (analysisQueue.length > 0) {
        const job = analysisQueue.shift()!
        try {
          await runAnalysis(job)
        } catch (error) {
          log(`analysis of task #${job.taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
          try {
            failAnalysisStatement.run(job.taskId)
            await sendAnalysisFailure(job, 'внутренняя ошибка разбора')
          } catch (sendError) {
            log(`analysis failure card failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`)
          }
        }
      }
    } finally {
      analysisRunning = false
      if (analysisQueue.length > 0) void drainAnalysis()
    }
  }

  async function runAnalysis(job: AnalysisJob): Promise<void> {
    const row = findTaskStatement.get(job.taskId) as TaskRow | undefined
    if (row === undefined) return
    const status = statusOf(row.status)
    if (job.remark === undefined && status !== 'incoming' && status !== 'analysis') return
    if (job.remark !== undefined && (status === 'rejected' || status === 'merged' || status === 'queued')) return

    markAnalysisStatement.run(job.remark ?? null, job.taskId)
    const task = taskOf(row)

    if (options.analysis === undefined) {
      failAnalysisStatement.run(job.taskId)
      await sendAnalysisFailure(job, 'разбор недоступен: харнесс не подключён')
      return
    }
    const models = await catalogue()
    const model = firstEnabledModel('analysis', models)
    if (model === undefined) {
      failAnalysisStatement.run(job.taskId)
      await sendAnalysisFailure(job, 'нет подключённой модели роли «разбор»')
      return
    }
    const reasoningEffort = await roleTurnEffort('analysis', model)

    const tree = await trackedProjectFiles(task.projectPath)
    const systemPrefix = analysisSystemPrefix(
      { title: task.title, body: task.body, project_name: task.projectName, project_path: task.projectPath },
      tree,
    )
    const tools = [analysisReadTool(task.projectPath)]
    let retryNote: string | undefined
    let parsed: ParsedAnalysis | undefined
    let lastError = 'ответ модели не разобран как разбор'

    for (let attempt = 0; attempt < 2; attempt += 1) {
      analysisSequence += 1
      const text = await options.analysis({
        provider: model.provider,
        model: model.id,
        modelName: model.name,
        cwd: task.projectPath,
        systemPrefix,
        prompt: analysisPrompt(task, job.remark, retryNote),
        sessionId: `factory-analysis-${job.taskId}-${analysisSequence}`,
        reasoningEffort,
        tools,
      })
      const result = parseAnalysis(text)
      if (result.ok) {
        parsed = result.value
        break
      }
      lastError = result.error
      retryNote = result.error
    }

    if (parsed === undefined) {
      failAnalysisStatement.run(job.taskId)
      await sendAnalysisFailure(job, lastError)
      return
    }

    const riskListing = await projectRiskPaths(task.projectPath)
    const assessment = assessFactoryRisk({
      body: task.body,
      footprint: parsed.footprint,
      modelRisk: parsed.risk,
      projectRoot: task.projectPath,
      projectPaths: riskListing.paths,
      ignoredDirectories: riskListing.ignoredDirectories,
      scanIgnoredDirectory: (directory) => scanIgnoredDirectory(task.projectPath, directory, IGNORED_SCAN_LIMIT),
    })
    saveAnalysisStatement.run(
      JSON.stringify(parsed.criteria),
      JSON.stringify(parsed.footprint),
      assessment.risk,
      assessment.reason ?? null,
      job.taskId,
    )
    const saved = findTaskStatement.get(job.taskId) as TaskRow | undefined
    if (saved !== undefined) await sendAnalysisCard(job, saved)
  }

  // -------------------------------------------------------------------------
  // Execution: worktree, roles, sandboxed gate, rounds
  // -------------------------------------------------------------------------

  function aborted(error: unknown): boolean {
    return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ABORTED'
  }

  /** A statement of a store that the daemon already closed is not a failure. */
  function finalized(error: unknown): boolean {
    return /statement has been finalized/i.test(error instanceof Error ? error.message : String(error))
  }

  async function refreshCards(taskId: number): Promise<void> {
    const ids = taskCards.get(taskId)
    if (ids === undefined || ids.size === 0) return
    const screen = taskScreen(taskId)
    for (const [messageId, chatId] of [...ids]) {
      try {
        await editScreen(chatId, messageId, screen)
      } catch (error) {
        log(`task card edit failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Acceptance: autoaccept, the owner's rich card, GitHub PR or local merge
  // -------------------------------------------------------------------------

  /**
   * A task that finished without a commit has nothing to accept: the card and
   * the task screen offer return and reject instead of accept.
   */
  function hasResult(row: TaskRow): boolean {
    return listOf(row.result_files).length > 0
  }

  function acceptanceKeyboard(taskId: number, withResult = true): Array<Array<Record<string, unknown>>> {
    return [[
      ...(withResult ? [button('Принять', `ac:${taskId}`, 'success')] : []),
      button('Вернуть', `rv:${taskId}`, 'danger'),
      ...(withResult ? [] : [button('Отклонить', `ar:${taskId}`, 'danger')]),
    ]]
  }

  /** The owner's acceptance card: a compact diff table, the reason and the actions of its state. */
  function acceptanceMarkdown(row: TaskRow, note?: string): string {
    const task = taskOf(row)
    const stats = statsOf(row.result_stats)
    const added = stats.reduce((sum, entry) => sum + entry.added, 0)
    const removed = stats.reduce((sum, entry) => sum + entry.removed, 0)
    const lines = [`**Приёмка задачи #${task.id}: ${task.title}**`, '']
    if (stats.length > 0) {
      lines.push(
        '| Файл | Добавлено | Удалено |',
        '| --- | --- | --- |',
        ...stats.map((entry) => `| ${entry.path} | +${entry.added} | −${entry.removed} |`),
        '',
        `**Итого:** +${added} −${removed}, ${added + removed} изменённых строк`,
      )
    } else if (hasResult(row)) {
      lines.push('Изменения готовы к приёмке.')
    } else {
      lines.push('Задача закончилась без изменений относительно базы: принимать нечего. Верните её с замечанием или отклоните.')
    }
    if (task.risk !== undefined) lines.push('', `**Риск:** ${task.risk}`)
    if (note !== undefined && note.trim() !== '') lines.push('', `**Причина:** ${note.trim()}`)
    return lines.join('\n')
  }

  async function showAcceptanceCard(taskId: number): Promise<void> {
    const row = findTaskStatement.get(taskId) as TaskRow | undefined
    if (row === undefined) return
    const markdown = acceptanceMarkdown(row, row.execution_note ?? undefined)
    const keyboard = acceptanceKeyboard(taskId, hasResult(row))
    const chatId = row.acceptance_chat_id ?? options.ownerId()
    if (chatId === null) return
    if (row.acceptance_message_id !== null) {
      await editScreen(chatId, row.acceptance_message_id, { markdown, keyboard })
      return
    }
    try {
      const ids = await sendFormatted(api, chatId, markdown, { replyMarkup: { inline_keyboard: keyboard } })
      const messageId = ids.at(-1)
      if (messageId !== undefined) saveAcceptanceCardStatement.run(messageId, chatId, taskId)
    } catch (error) {
      log(`acceptance card failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Show the running stage of a resumed task in its existing acceptance card. */
  async function showAcceptanceProgress(taskId: number, stage: FactoryExecutionStage, round: number): Promise<void> {
    const row = findTaskStatement.get(taskId) as TaskRow | undefined
    if (row === undefined || row.acceptance_message_id === null) return
    const task = taskOf(row)
    const chatId = row.acceptance_chat_id ?? options.ownerId()
    if (chatId === null) return
    const lines = [
      `**Задача #${task.id}: ${task.title}**`,
      '',
      `**Этап:** ${FACTORY_STAGE_LABELS[stage]} · круг ${round} из ${FACTORY_MAX_ROUNDS}`,
    ]
    if (task.reason !== undefined && task.reason.trim() !== '') lines.push('', `**Причина:** ${task.reason}`)
    try {
      await editScreen(chatId, row.acceptance_message_id, { markdown: lines.join('\n'), keyboard: [] })
    } catch (error) {
      log(`acceptance progress edit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Rewrite the existing card as the final «влито» state, without buttons. */
  async function finishAcceptanceCard(row: TaskRow, project: FactoryProject, where: string): Promise<void> {
    const task = taskOf(row)
    const files = task.changedFiles.length
    const ownNote = project.own || realOrResolved(project.path) === realOrResolved(ownProject.path)
      ? '\nИзменения придут в работающего бота через /update.'
      : ''
    const markdown = [
      `**Задача #${task.id} «${task.title}»: влито**`,
      '',
      `Файлов: ${files}.`,
      `Куда: ${where}.${ownNote}`,
    ].join('\n')
    const chatId = row.acceptance_chat_id ?? options.ownerId()
    if (row.acceptance_message_id !== null && chatId !== null) {
      try {
        await editScreen(chatId, row.acceptance_message_id, { markdown, keyboard: [] })
        return
      } catch (error) {
        log(`acceptance final edit failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (chatId !== null) await sendFormatted(api, chatId, markdown)
  }

  /** The short one-message notice of an automatic acceptance. */
  async function sendMergeSummary(row: TaskRow, project: FactoryProject, where: string): Promise<void> {
    const chatId = options.ownerId()
    if (chatId === null) return
    const task = taskOf(row)
    const ownNote = project.own || realOrResolved(project.path) === realOrResolved(ownProject.path)
      ? '\nИзменения придут в работающего бота через /update.'
      : ''
    const markdown = [
      `Задача #${task.id} «${task.title}» влито.`,
      `Файлов: ${task.changedFiles.length}.`,
      `Куда: ${where}.${ownNote}`,
    ].join('\n')
    try {
      await sendFormatted(api, chatId, markdown)
    } catch (error) {
      log(`merge summary failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Default branch of a GitHub origin asked from the remote itself. The usual
   * install has only the local `live` branch and no remote-tracking refs, so
   * `origin/HEAD` cannot answer: the remote's symbolic HEAD can.
   */
  async function remoteHeadBranch(projectPath: string): Promise<string | undefined> {
    const url = (await tryGit(projectPath, ['config', '--get', 'remote.origin.url']))?.trim()
    if (url === undefined || url === '' || !isGithubRemote(url)) return undefined
    const listing = await tryGit(projectPath, ['ls-remote', '--symref', 'origin', 'HEAD'], 60_000)
    if (listing === undefined) return undefined
    const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD\s*$/m.exec(listing)
    const name = match?.[1]?.trim()
    return name === undefined || name === '' || name === 'HEAD' ? undefined : name
  }

  /**
   * Base branch by the documented order: origin/HEAD, the remote HEAD of a
   * GitHub origin, then main and master among local and origin/* branches.
   */
  async function baseBranchOf(projectPath: string): Promise<string> {
    const originHead = (await tryGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']))?.trim()
    if (originHead !== undefined && originHead.startsWith('origin/')) {
      const name = originHead.slice('origin/'.length)
      if (name !== '' && name !== 'HEAD') return name
    }
    const remoteHead = await remoteHeadBranch(projectPath)
    if (remoteHead !== undefined) return remoteHead
    const branches = (await tryGit(
      projectPath,
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
    ) ?? '')
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
    if (branches.includes('main') || branches.includes('origin/main')) return 'main'
    if (branches.includes('master') || branches.includes('origin/master')) return 'master'
    throw new Error('не найдена основная ветка проекта (origin/HEAD, HEAD удалённого репозитория, main или master)')
  }

  /** Push/PR/merge availability: a GitHub origin plus a logged-in gh. */
  async function githubReady(projectPath: string): Promise<boolean> {
    // Read the configured URL, not `remote get-url`: the latter expands
    // url.*.insteadOf and can hide the real GitHub origin behind a mirror.
    const url = (await tryGit(projectPath, ['config', '--get', 'remote.origin.url']))?.trim()
    if (url === undefined || !isGithubRemote(url)) return false
    try {
      await execFileAsync('gh', ['auth', 'status'], {
        encoding: 'utf8',
        env: factoryGitEnv(),
        shell: false,
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether autoaccept may merge this task by itself. The bot's own checkout is
   * the one case it cannot: while the base branch is checked out here, a local
   * merge would replace the files of the running bot, and without GitHub there
   * is no other way. Such a successful task stays for the owner's decision
   * instead of turning into a merge error.
   */
  async function autoacceptCanMerge(projectPath: string): Promise<boolean> {
    if (realOrResolved(projectPath) !== realOrResolved(ownProject.path)) return true
    try {
      const base = await baseBranchOf(projectPath)
      const copy = await baseWorktreeOf(projectPath, base)
      if (copy === undefined || realOrResolved(copy) !== realOrResolved(ownProject.path)) return true
      return await githubReady(projectPath)
    } catch {
      // Let the ordinary acceptance path report a broken repository.
      return true
    }
  }

  async function ghOutput(cwd: string, args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('gh', [...args], {
        cwd,
        encoding: 'utf8',
        env: factoryGitEnv(),
        shell: false,
        timeout: GH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      return stdout.trim()
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean }
      if (failure.code === 'ENOENT') throw new Error('gh не найден')
      if (failure.killed === true) throw new Error(`gh ${args.slice(0, 2).join(' ')}: превышено время ожидания`)
      const detail = failureTail(failure.stderr, failure.stdout)
      throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${detail ?? failure.message}`)
    }
  }

  /**
   * Owner's working copy where the base branch is checked out: the project
   * itself or any of its other worktrees (`git worktree list`).
   */
  async function baseWorktreeOf(projectPath: string, base: string): Promise<string | undefined> {
    const listing = await tryGit(projectPath, ['worktree', 'list', '--porcelain'])
    if (listing === undefined) {
      const current = (await tryGit(projectPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim()
      return current === base ? projectPath : undefined
    }
    for (const block of listing.split(/\r?\n\s*\r?\n/)) {
      const lines = block.split(/\r?\n/).map((line) => line.trim())
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
      if (path === undefined || lines.includes('bare')) continue
      if (!lines.includes(`branch refs/heads/${base}`)) continue
      if (existsSync(path)) return path
    }
    return undefined
  }

  /** Paths of the task with uncommitted owner changes in the base branch copy. */
  async function ownerChangesOnTaskPaths(row: TaskRow, copy: string | undefined): Promise<string[]> {
    if (copy === undefined) return []
    const paths = [...new Set([...listOf(row.result_files), ...listOf(row.footprint)])]
      .filter((path) => path.trim() !== '')
    if (paths.length === 0) return []
    const status = await gitOutput(copy, ['status', '--porcelain', '--', ...paths])
    return status.split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => line.slice(3).trim())
      .filter((path) => path !== '')
  }

  /**
   * Move the task commits onto the base branch and fast-forward the owner's
   * copy. A base branch that exists only on the remote (origin/HEAD points at
   * origin/release, no local release) is rebased onto the tracking branch and
   * created locally at the rebased tip.
   */
  async function mergeLocally(
    project: FactoryProject,
    worktree: string,
    branch: string,
    base: string,
    copy: string | undefined,
  ): Promise<string> {
    let upstream = base
    const local = (await tryGit(project.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]))?.trim()
    let onto = local
    if (local === undefined) {
      const tracking = (await tryGit(project.path, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]))?.trim()
      if (tracking !== undefined) {
        upstream = `origin/${base}`
        onto = tracking
      } else {
        // Installs without a fetch refspec keep no remote-tracking refs at all.
        await gitOutput(project.path, ['fetch', '--quiet', 'origin', base], 60_000)
        onto = (await gitOutput(project.path, ['rev-parse', 'FETCH_HEAD'])).trim()
        upstream = onto
      }
    }
    try {
      await gitOutput(worktree, ['rebase', onto ?? upstream], 60_000)
    } catch (error) {
      const conflicts = ((await tryGit(worktree, ['diff', '--name-only', '--diff-filter=U'])) ?? '')
        .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
      await tryGit(worktree, ['rebase', '--abort'], 60_000)
      const detail = conflicts.length > 0 ? conflicts.join(', ') : (error instanceof Error ? error.message : String(error))
      throw new Error(`rebase на ${upstream} дал конфликт: ${detail}`)
    }
    const sha = (await gitOutput(worktree, ['rev-parse', 'HEAD'])).trim()
    // A checked-out base moves only together with its files and index.
    if (copy !== undefined) {
      await gitOutput(copy, ['merge', '--ff-only', '--no-edit', branch], 60_000)
    } else {
      // Compare-and-swap against the rebased-on tip: a base the owner moved
      // meanwhile (or created, when it was remote-only) is never overwritten.
      await gitOutput(project.path, ['update-ref', `refs/heads/${base}`, sha, local ?? ''])
    }
    return `локально в ${base}`
  }

  /** Push the task branch, reuse or create its PR, and rebase-merge it. */
  async function mergeThroughGithub(
    row: TaskRow,
    worktree: string,
    branch: string,
    base: string,
  ): Promise<string> {
    await gitOutput(worktree, ['push', 'origin', `${branch}:${branch}`], 60_000)
    let pullRequests: Array<{ url?: unknown; number?: unknown; state?: unknown; headRefName?: unknown }> = []
    try {
      const raw = await ghOutput(worktree, [
        'pr', 'list', '--head', branch, '--state', 'all',
        '--json', 'url,number,state,headRefName,baseRefName',
      ])
      const parsed: unknown = raw === '' ? [] : JSON.parse(raw)
      pullRequests = Array.isArray(parsed) ? parsed as typeof pullRequests : []
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`gh pr list: ${error.message}`)
      throw error
    }
    const mine = pullRequests.filter((entry) => entry.headRefName === branch && typeof entry.url === 'string')
    const existing = mine.find((entry) => String(entry.state).toUpperCase() === 'OPEN') ?? mine[0]
    let url: string
    if (existing !== undefined) {
      url = String(existing.url)
      if (String(existing.state).toUpperCase() === 'MERGED') return url
    } else {
      const title = `factory: задача #${row.id} — ${row.title}`.slice(0, 200)
      const output = await ghOutput(worktree, [
        'pr', 'create', '--head', branch, '--base', base,
        '--title', title, '--body', `Задача #${row.id}: ${row.title}`,
      ])
      url = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? ''
      if (url === '') throw new Error('gh pr create: не вернул ссылку на PR')
    }
    await ghOutput(worktree, ['pr', 'merge', url, '--rebase'])
    return `PR ${url}`
  }

  async function removeTaskBranch(projectPath: string, taskId: number): Promise<void> {
    await tryGit(projectPath, ['branch', '-D', `factory/${taskId}`], 60_000)
  }

  async function performAcceptance(taskId: number): Promise<void> {
    const row = findTaskStatement.get(taskId) as TaskRow | undefined
    if (row === undefined) return
    if (row.status !== 'awaiting_human') {
      // A click on an outdated card must not look like nothing happened.
      const chatId = row.acceptance_chat_id ?? options.ownerId()
      if (chatId !== null) {
        const label = FACTORY_STATUS_LABELS[taskOf(row).status]
        await sendFormatted(api, chatId, `**Задача #${taskId}:** вливать нечего — статус «${label}», приёмка её уже не ждёт.`)
      }
      return
    }
    if (!hasResult(row)) {
      // A run that ended without a commit has nothing to merge. Never ask git
      // or gh to publish an empty branch: report it and keep the task waiting.
      const chatId = row.acceptance_chat_id ?? options.ownerId()
      if (chatId !== null) {
        await sendFormatted(api, chatId, `**Задача #${taskId}:** принимать нечего: в задаче нет изменений. Верните её с замечанием или отклоните.`)
      }
      return
    }
    const project = projectById(row.project_id) ?? ownProject
    const worktree = row.worktree
    if (worktree === null || worktree === '' || !existsSync(worktree)) {
      throw new Error('worktree задачи не найден: вливание невозможно')
    }
    const problem = await gitRepositoryProblem(project.path)
    if (problem !== undefined) throw new Error(`основной репозиторий проекта недоступен: ${problem}`)
    // The identity captured before project code ran must still answer. A gate
    // that redirected .git at the owner's copy must never be merged.
    if (row.worktree_identity !== null && row.worktree_identity !== '') {
      try {
        const parsed = JSON.parse(row.worktree_identity) as Partial<WorktreeIdentity>
        if (typeof parsed.gitDir !== 'string' || typeof parsed.reported !== 'string' || typeof parsed.toplevel !== 'string') {
          throw new Error('invalid')
        }
        if (!(await sameWorktree(worktree, parsed as WorktreeIdentity))) {
          throw new Error('worktree задачи больше не принадлежит задаче: .git или git-каталог подменены')
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('worktree задачи больше не принадлежит задаче: отметка worktree повреждена')
        }
        throw error
      }
    }
    const branch = `factory/${taskId}`
    const base = await baseBranchOf(project.path)
    // The owner's copy of the base branch is checked before either way of
    // merging: neither push nor a local move may proceed over its changes.
    const copy = await baseWorktreeOf(project.path, base)
    const dirty = await ownerChangesOnTaskPaths(row, copy)
    if (dirty.length > 0) {
      throw new Error(
        `в рабочей копии владельца (${copy}) есть незакоммиченные изменения или неотслеживаемые файлы на путях задачи: ${dirty.join(', ')}`,
      )
    }
    // The factory's own repository runs from this checkout: a local merge over
    // it would replace the files of the running bot. Only move the branch ref
    // (the usual case: the bot runs on `live`); a base checked out right here
    // may go through a GitHub PR, but never through a local fast-forward.
    const own = project.own || realOrResolved(project.path) === realOrResolved(ownProject.path)
    const botCopy = own && copy !== undefined && realOrResolved(copy) === realOrResolved(ownProject.path)
    const github = await githubReady(project.path)
    if (botCopy && !github) {
      throw new Error(
        `основная ветка ${base} выписана в рабочей копии работающего бота (${project.path}); ` +
        'локальное вливание не выполняется, чтобы не менять файлы запущенного бота. ' +
        'Изменения придут в бота через /update после слияния вручную.',
      )
    }
    const where = github
      ? await mergeThroughGithub(row, worktree, branch, base)
      : await mergeLocally(project, worktree, branch, base, botCopy ? undefined : copy)
    await removeTaskWorktrees(project.path, taskId, worktree)
    await removeTaskBranch(project.path, taskId)
    const mergedRow = findTaskStatement.get(taskId) as TaskRow | undefined
    if (mergedRow !== undefined) {
      if (mergedRow.acceptance_message_id !== null) await finishAcceptanceCard(mergedRow, project, where)
      else await sendMergeSummary(mergedRow, project, where)
    }
    markMergedStatement.run(taskId)
  }

  function failAcceptance(taskId: number, error: unknown): void {
    const reason = mergeReason(error instanceof Error ? error.message : String(error))
    try {
      failMergeStatement.run(reason, taskId)
    } catch (failure) {
      if (!finalized(failure)) log(`merge failure note failed: ${failure instanceof Error ? failure.message : String(failure)}`)
      return
    }
    void showAcceptanceCard(taskId).catch((cardError) => {
      log(`acceptance failure card failed: ${cardError instanceof Error ? cardError.message : String(cardError)}`)
    })
    log(`acceptance of task #${taskId} failed: ${reason}`)
  }

  function enqueueAcceptance(taskId: number): void {
    if (!acceptanceQueue.includes(taskId)) acceptanceQueue.push(taskId)
    void drainAcceptance()
  }

  async function drainAcceptance(): Promise<void> {
    if (acceptanceRunning) return
    acceptanceRunning = true
    try {
      while (acceptanceQueue.length > 0) {
        const taskId = acceptanceQueue.shift()!
        try {
          await performAcceptance(taskId)
        } catch (error) {
          failAcceptance(taskId, error)
        }
      }
    } finally {
      acceptanceRunning = false
    }
  }

  /** Drop every task binding of one message: it now shows another screen. */
  function forgetTaskCard(messageId: number, chatId: number): void {
    for (const [taskId, ids] of taskCards) {
      if (ids.get(messageId) === chatId) ids.delete(messageId)
      if (ids.size === 0) taskCards.delete(taskId)
    }
  }

  function rememberTaskCard(taskId: number, messageId: number, chatId: number): void {
    const ids = taskCards.get(taskId) ?? new Map<number, number>()
    ids.set(messageId, chatId)
    taskCards.set(taskId, ids)
  }

  /**
   * Directories that may hold task worktrees: the daemon home first, the
   * temporary directory when the home lies inside (or around) the project.
   */
  function worktreeRoots(): string[] {
    const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
    return [join(home, 'factory', 'worktrees'), join(tmpdir(), `dshbot-factory-worktrees-${user}`)]
  }

  /**
   * Path of a new task worktree outside the owner's working copy. Nothing is
   * created on disk except its parent, so the caller can persist the path first.
   */
  function planWorktree(projectPath: string, taskId: number): string {
    const project = realOrResolved(projectPath)
    const root = worktreeRoots().find((candidate) => !pathsOverlap(realOrResolved(candidate), project))
    if (root === undefined) {
      throw new Error(`каталог worktree пересекается с рабочей копией проекта ${projectPath}`)
    }
    mkdirSync(root, { recursive: true })
    executionSequence += 1
    return join(root, `task-${taskId}-${Date.now().toString(36)}-${executionSequence}`)
  }

  async function createWorktree(projectPath: string, taskId: number, path: string): Promise<void> {
    await gitOutput(projectPath, ['worktree', 'add', '-q', '-B', `factory/${taskId}`, path, 'HEAD'], 60_000)
  }

  /**
   * Remove a task's recorded worktree and any worktree of ours still checked
   * out on its branch (a restart may land before the path was recorded).
   * Worktrees outside the factory roots, the owner's copy included, stay.
   */
  async function removeTaskWorktrees(projectPath: string, taskId: number, recorded: string | null): Promise<void> {
    const project = realOrResolved(projectPath)
    const roots = worktreeRoots().map(realOrResolved)
    const paths = new Set<string>()
    if (recorded !== null && recorded !== '') paths.add(recorded)
    let current: string | undefined
    for (const line of (await tryGit(projectPath, ['worktree', 'list', '--porcelain'], 60_000) ?? '').split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
      else if (line === `branch refs/heads/factory/${taskId}` && current !== undefined) paths.add(current)
    }
    for (const path of paths) {
      const real = realOrResolved(path)
      if (pathsOverlap(real, project)) continue
      if (!roots.some((root) => real.startsWith(`${root}${sep}`))) continue
      await removeWorktree(projectPath, path)
    }
  }

  async function removeWorktree(projectPath: string, path: string): Promise<void> {
    if (existsSync(path)) {
      await tryGit(projectPath, ['worktree', 'remove', '--force', path], 60_000)
    }
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // A tree that cannot be removed now is retried by the next restart.
    }
    await tryGit(projectPath, ['worktree', 'prune'], 60_000)
  }

  /** Changed paths of the worktree against `base` (its initial commit by default). */
  async function changedPaths(worktree: string, base = 'HEAD'): Promise<string[]> {
    const tracked = (await gitOutput(worktree, ['diff', '--name-only', '-z', base]))
      .split('\u0000').filter((path) => path !== '')
    const untracked = (await gitOutput(worktree, ['ls-files', '--others', '--exclude-standard', '-z']))
      .split('\u0000').filter((path) => path !== '')
    return [...new Set([...tracked, ...untracked])].sort()
  }

  /** Put one path back to its writer-round state, never touching another path. */
  async function restorePath(worktree: string, path: string, snapshot: ReadonlyMap<string, EntryState>): Promise<void> {
    if (snapshot.has(path)) {
      restoreState(worktree, path, snapshot)
      return
    }
    const target = detachedPath(worktree, path)
    if (await tryGit(worktree, ['checkout', '--', path]) !== undefined) return
    rmSync(target, { recursive: true, force: true })
  }

  /** Content and type of every path that currently differs from the worktree base. */
  async function worktreeSnapshot(worktree: string): Promise<Map<string, EntryState>> {
    const snapshot = new Map<string, EntryState>()
    for (const path of await changedPaths(worktree)) snapshot.set(path, entryState(join(worktree, path)))
    return snapshot
  }

  /** Paths one executor turn actually touched, with the state before the turn. */
  async function touchedByRound(
    worktree: string,
    before: ReadonlyMap<string, EntryState>,
  ): Promise<{ paths: string[]; after: Map<string, EntryState> }> {
    const after = await worktreeSnapshot(worktree)
    const touched: string[] = []
    for (const [path, entry] of after) {
      if (!before.has(path) || !sameEntryState(before.get(path), entry)) touched.push(path)
    }
    for (const path of before.keys()) if (!after.has(path)) touched.push(path)
    return { paths: [...new Set(touched)].sort(), after }
  }

  /** Put one path back to a captured state, never touching another path. */
  function restoreState(worktree: string, path: string, state: ReadonlyMap<string, EntryState>): boolean {
    if (!state.has(path)) return false
    const entry = state.get(path)!
    const target = detachedPath(worktree, path)
    if (entry.kind === 'none') {
      rmSync(target, { recursive: true, force: true })
      return true
    }
    if (entry.kind === 'symlink') {
      rmSync(target, { recursive: true, force: true })
      mkdirSync(dirname(target), { recursive: true })
      symlinkSync(entry.target, target)
      return true
    }
    try {
      if (!lstatSync(target).isFile()) rmSync(target, { recursive: true, force: true })
    } catch {
      // A missing target is created below.
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.content)
    return true
  }

  /**
   * The project test command runs with write access to the worktree. Every
   * path one gate run changed that the task may not change (a writer test or a
   * path outside the footprint) goes back to its state before that run.
   */
  async function undoGateWrites(
    worktree: string,
    gateBefore: ReadonlyMap<string, EntryState>,
    forbidden: (path: string) => boolean,
    snapshot: ReadonlyMap<string, EntryState>,
  ): Promise<string[]> {
    const violations = (await touchedByRound(worktree, gateBefore)).paths.filter(forbidden)
    for (const path of violations) {
      if (!restoreState(worktree, path, gateBefore)) await restorePath(worktree, path, snapshot)
    }
    return violations
  }

  /** The project test command from its settings; `npm test` when it is blank. */
  function testCommandOf(row: TaskRow): string {
    const command = (projectById(row.project_id)?.testCommand ?? '').trim()
    return command === '' ? DEFAULT_TEST_COMMAND : command
  }

  /**
   * Command line of one gate run. A project whose tests are plain `npm test`
   * uses evolve's light gate: the project `gate` script gets the changed code
   * files, so it type-checks the tree and runs only the related tests. A
   * project with its own test command keeps that command, parsed into argv.
   */
  function gateArgv(
    row: TaskRow,
    worktree: string,
    changed: readonly string[],
    ownArgv: readonly string[],
  ): string[] {
    if (testCommandOf(row) !== DEFAULT_TEST_COMMAND) return [...ownArgv]
    return gateCommand(worktree, changed).command
  }

  /** Explain an exceeded gate deadline in minutes and name the env knob. */
  function gateTimeoutNote(timeoutMs: number): string {
    const minutes = timeoutMs / 60_000
    const shown = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1).replace('.', ',')
    return `тесты не уложились в лимит ${shown} мин (${String(timeoutMs)} мс): ` +
      `прогон тестов в песочнице прерван по таймауту. Лимит задаётся переменной ${GATE_TIMEOUT_ENV}; ` +
      'тесты на хосте не запускаются.'
  }

  /**
   * Note of a gate whose sandbox reported a failure. An exceeded deadline is
   * not a missing sandbox: the owner must see that the tests did not fit the
   * limit. A real bwrap probe or start failure keeps the old text.
   */
  function gateSandboxNote(
    gate: Pick<SandboxResult, 'sandboxError' | 'timedOut'> & { timeoutMs: number },
  ): string | undefined {
    if (gate.sandboxError === undefined) return undefined
    if (gate.timedOut === true || gate.sandboxError.includes(SANDBOX_TIMEOUT_PREFIX)) {
      return gateTimeoutNote(gate.timeoutMs)
    }
    return `песочница bwrap недоступна: ${gate.sandboxError}. Тесты на хосте не запускаются.`
  }

  /** Run the project gate in the evolve sandbox on the task worktree. */
  async function runGate(
    row: TaskRow,
    worktree: string,
    changed: readonly string[],
    ownArgv: readonly string[],
  ): Promise<SandboxResult & { timeoutMs: number }> {
    const timeoutMs = gateTimeoutMs()
    const result = await sandbox({
      ownerHome,
      candidate: worktree,
      liveModules: join(row.project_path, 'node_modules'),
      command: gateArgv(row, worktree, changed, ownArgv),
      timeoutMs,
    })
    return { ...result, timeoutMs }
  }

  /**
   * Models a role turn tries, in order. The reviewer of a round starts with the
   * first model whose provider differs from the one the executor just worked
   * on; without such a model the role priority stays as it is.
   */
  function roleCandidates(
    row: TaskRow,
    role: Exclude<FactoryRole, 'analysis'>,
    models: readonly FactoryModel[],
  ): FactoryModel[] {
    const ordered = rolePriority(role, models)
    if (role !== 'reviewer') return ordered
    const executorProvider = executorProviders.get(row.id)
    const other = executorProvider === undefined
      ? undefined
      : ordered.find((model) => model.provider !== executorProvider)
    return other === undefined ? ordered : [other, ...ordered.filter((model) => model !== other)]
  }

  async function runRole(
    row: TaskRow,
    role: Exclude<FactoryRole, 'analysis'>,
    worktree: string,
    prompt: string,
    journal?: Map<string, EntryState>,
  ): Promise<string> {
    if (options.roleTurn === undefined) throw new Error(`роль «${roleLabelOf(role)}» недоступна: харнесс не подключён`)
    const models = await catalogue()
    const candidates = roleCandidates(row, role, models)
    if (candidates.length === 0) throw new Error(`нет подключённой модели роли «${roleLabelOf(role)}»`)
    const task = taskOf(row)
    const failures: string[] = []
    for (const model of candidates) {
      const reasoningEffort = await roleTurnEffort(role, model)
      roleSequence += 1
      try {
        const answer = await options.roleTurn({
          role,
          provider: model.provider,
          model: model.id,
          modelName: model.name,
          cwd: worktree,
          systemPrefix: roleSystemPrefix(role, task),
          prompt,
          sessionId: `factory-${role}-${executionGeneration}-${row.id}-${roleSequence}`,
          reasoningEffort,
          tools: roleTools(role, worktree, journal),
        })
        if (role === 'executor') executorProviders.set(row.id, model.provider)
        return answer
      } catch (error) {
        // A stop of the daemon or of the task is not a model failure: the next
        // model must not take over a turn the owner or the bot ended.
        if (aborted(error)) throw error
        const saved = findTaskStatement.get(row.id) as TaskRow | undefined
        if (saved === undefined || saved.status !== 'running') throw error
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${model.provider}/${model.id}: ${reason}`)
        log(`task #${row.id}: роль «${roleLabelOf(role)}» (${role}), модель ${model.provider}/${model.id} отказала: ${reason}`)
      }
    }
    throw new Error(`роль «${roleLabelOf(role)}»: все модели отказали: ${failures.join('; ')}`)
  }

  async function writeDiff(worktree: string): Promise<{ diff: string; stat: string }> {
    await tryGit(worktree, ['add', '-N', '--', '.'])
    return {
      diff: await gitOutput(worktree, ['diff', '--no-color', '--no-textconv', 'HEAD']),
      stat: await gitOutput(worktree, ['diff', '--stat', 'HEAD']),
    }
  }

  /**
   * Whether a commit would record anything. A returned round may pass its gate
   * and review without touching the tree; `git commit` then fails and must not
   * discard the previous task commit and its acceptance data.
   */
  async function hasPendingChanges(worktree: string): Promise<boolean> {
    const status = await gitOutput(worktree, ['status', '--porcelain', '--untracked-files=normal'])
    return status.split(/\r?\n/).some((line) => line.trim() !== '')
  }

  async function commitResult(worktree: string, base: string, taskId: number): Promise<string[]> {
    await gitOutput(worktree, ['add', '-A'])
    await gitOutput(worktree, ['commit', '--no-gpg-sign', '-q', '-m', `factory: задача #${taskId}`])
    return (await gitOutput(worktree, ['diff', '--name-only', base, 'HEAD']))
      .split('\n').map((path) => path.trim()).filter((path) => path !== '')
  }

  async function finishExecution(
    taskId: number,
    note: string,
    files: readonly string[] = [],
    result?: { base: string; stats: readonly DiffStat[] },
  ): Promise<void> {
    finishStatement.run(
      note,
      JSON.stringify(files),
      result?.base ?? null,
      result === undefined ? null : JSON.stringify(result.stats),
      taskId,
    )
    await refreshCards(taskId)
    const saved = findTaskStatement.get(taskId) as TaskRow | undefined
    // A card exists already or the finished run produced nothing to accept:
    // either way the owner must see the reason and the actions left to them.
    if (saved !== undefined && (saved.acceptance_message_id !== null || files.length === 0)) {
      await showAcceptanceCard(taskId)
    }
  }

  /**
   * Finish a task whose gate could not run and show its reason on a card even
   * when no acceptance card existed yet: the owner must see the failure.
   */
  async function finishGateFailure(taskId: number, note: string): Promise<void> {
    await finishExecution(taskId, note)
    const saved = findTaskStatement.get(taskId) as TaskRow | undefined
    if (saved !== undefined && saved.acceptance_message_id === null) await showAcceptanceCard(taskId)
  }

  function enqueueExecution(taskId: number): void {
    if (!executionQueue.includes(taskId)) executionQueue.push(taskId)
    void drainExecution()
  }

  async function drainExecution(): Promise<void> {
    if (executionRunning || executionHeld) return
    executionRunning = true
    try {
      while (executionQueue.length > 0) {
        const taskId = executionQueue.shift()!
        const row = findTaskStatement.get(taskId) as TaskRow | undefined
        if (row === undefined) continue
        if (row.status !== 'queued' && row.status !== 'running') continue
        setStatusStatement.run('running', taskId)
        try {
          await runExecution(taskId)
        } catch (error) {
          if (aborted(error)) return
          log(`execution of task #${taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
          try {
            await finishExecution(taskId, `исполнение не удалось: ${error instanceof Error ? error.message : String(error)}`)
          } catch (finishError) {
            if (!finalized(finishError)) {
              log(`execution failure card failed: ${finishError instanceof Error ? finishError.message : String(finishError)}`)
            }
          }
        }
      }
    } finally {
      executionRunning = false
    }
  }

  async function runExecution(taskId: number): Promise<void> {
    const row = findTaskStatement.get(taskId) as TaskRow | undefined
    if (row === undefined) return
    // A command that needs a shell cannot run in the gate: stop before any
    // worktree or model turn is spent on a task whose tests never start.
    const testCommand = testCommandOf(row)
    const parsed = testCommandArgv(testCommand)
    if ('error' in parsed) {
      await finishExecution(
        taskId,
        `команда тестов проекта «${testCommand}» не запускается без оболочки: ${parsed.error}. Вынесите её в скрипт проекта (например, npm run <скрипт>) и поправьте команду тестов в настройках проекта.`,
      )
      return
    }

    // A remark of the owner's «Вернуть» resumes the recorded worktree from
    // round one. The committed task branch and every writer test stay, so the
    // next round never repeats the writer or loses the previous commit.
    const resumeRemark = row.resume_remark !== null && row.resume_remark.trim() !== ''
      ? row.resume_remark
      : undefined
    const resuming = resumeRemark !== undefined && row.worktree !== null && row.worktree !== '' &&
      existsSync(row.worktree)
    let worktree: string
    let base: string
    let current: TaskRow
    if (resuming) {
      worktree = row.worktree as string
      current = row
      base = row.worktree_base ?? row.result_base ??
        (await tryGit(worktree, ['rev-list', '--max-parents=0', 'HEAD']))?.trim() ?? ''
      if (base === '') {
        await finishExecution(taskId, 'не удалось определить базовый коммит задачи для нового круга')
        return
      }
      progressStatement.run('execution', 1, taskId)
      await refreshCards(taskId)
      await showAcceptanceProgress(taskId, 'execution', 1)
    } else {
      // Record the path together with `running` before git creates it: a restart
      // at any point after this finds the row and removes whatever was created.
      worktree = planWorktree(row.project_path, taskId)
      setWorktreeStatement.run(worktree, taskId)
      await removeTaskWorktrees(row.project_path, taskId, row.worktree)
      await createWorktree(row.project_path, taskId, worktree)
      await refreshCards(taskId)
      base = (await gitOutput(worktree, ['rev-parse', 'HEAD'])).trim()
      saveWorktreeBaseStatement.run(base, taskId)
      current = findTaskStatement.get(taskId) as unknown as TaskRow
    }
    const task = taskOf(current)

    // Trusted identity captured before any role or project code runs. Every
    // host git command after that code re-checks it: a gate can rewrite the
    // writable `.git` link and point git at the owner's repository.
    let identity: WorktreeIdentity | undefined
    if (resuming && current.worktree_identity !== null && current.worktree_identity !== '') {
      try {
        const parsedIdentity = JSON.parse(current.worktree_identity) as Partial<WorktreeIdentity>
        if (typeof parsedIdentity.gitDir === 'string' && typeof parsedIdentity.reported === 'string' &&
          typeof parsedIdentity.toplevel === 'string') {
          identity = parsedIdentity as WorktreeIdentity
        }
      } catch {
        // A damaged marker is handled by the ordinary check below.
      }
    }
    identity ??= await worktreeIdentity(worktree)
    if (identity === undefined) {
      await finishExecution(taskId, 'worktree задачи не удалось проверить: .git или git-каталог не совпадают с ожидаемыми. Git-операции на хосте не выполняются.')
      return
    }
    saveIdentityStatement.run(JSON.stringify(identity), taskId)
    const stillOwned = async (): Promise<boolean> => {
      if (await sameWorktree(worktree, identity!)) return true
      await finishExecution(
        taskId,
        'worktree задачи больше не принадлежит задаче: .git или git-каталог подменены после запуска кода проекта. Git-операции на хосте не выполняются, нужна проверка владельца.',
      )
      return false
    }
    if (!(await stillOwned())) return

    let writerTests: string[]
    let snapshot = new Map<string, EntryState>()
    const capture = (): void => {
      snapshot = new Map()
      for (const path of writerTests) snapshot.set(path, entryState(join(worktree, path)))
      saveWriterTestsStatement.run(JSON.stringify(writerTests), JSON.stringify([...snapshot]), taskId)
    }
    if (resuming) {
      // Writer tests are already committed; they are still off-limits to the
      // executor, so the same footprint guard protects them. The saved list
      // keeps declared paths with any name; a task from before it falls back
      // to the committed paths that look like tests.
      writerTests = current.writer_tests !== null
        ? listOf(current.writer_tests)
        : (await gitOutput(worktree, ['diff', '--name-only', base, 'HEAD']))
          .split(/\r?\n/).map((path) => path.trim()).filter((path) => path !== '')
          .filter(looksLikeTestFile)
      // A restart after the writer puts the tests back exactly as the writer
      // left them: the interrupted executor may have edited or removed one.
      // The rest of its work in the worktree stays untouched.
      const savedSnapshot = parseEntrySnapshot(current.writer_snapshot)
      if (savedSnapshot !== undefined) {
        for (const path of savedSnapshot.keys()) {
          if (!writerTests.includes(path)) writerTests.push(path)
        }
        for (const path of savedSnapshot.keys()) restoreState(worktree, path, savedSnapshot)
        log(`task #${taskId}: writer tests restored after the restart: ${[...savedSnapshot.keys()].join(', ')}`)
      }
      capture()
    } else {
      // Test writer: the gate must be red after it; one retry with a remark.
      const firstWriter = await runRole(current, 'test_writer', worktree, writerPrompt(undefined))
      writerTests = writerTestPaths(firstWriter, await changedPaths(worktree))
      capture()
    }
    const forbidden = (path: string): boolean =>
      writerTests.includes(path) || !task.footprint.some((entry) => footprintAllows(entry, path))
    let gate: Awaited<ReturnType<typeof runGate>> = {
      ok: false,
      status: null,
      output: '',
      timeoutMs: gateTimeoutMs(),
    }
    // A writer gate runs project code too: whatever it changes in a writer test
    // or outside the footprint must not become the executor's starting point.
    const writerGate = async (): Promise<boolean> => {
      const gateBefore = await worktreeSnapshot(worktree)
      const changed = [...new Set([...writerTests, ...(await changedPaths(worktree, base))])]
      gate = await runGate(current, worktree, changed, parsed.argv)
      const note = gateSandboxNote(gate)
      if (note !== undefined) {
        await finishGateFailure(taskId, note)
        return false
      }
      if (!(await stillOwned())) return false
      const undone = await undoGateWrites(worktree, gateBefore, forbidden, snapshot)
      if (undone.length > 0) log(`task #${taskId}: writer gate changes restored: ${undone.join(', ')}`)
      return true
    }
    if (!resuming) {
      if (!(await writerGate())) return
      if (gate.ok) {
        const retryWriter = await runRole(
          current,
          'test_writer',
          worktree,
          writerPrompt('Тесты тестописца не красные: гейт прошёл зелёным. Напиши тесты, которые падают на текущем коде.'),
        )
        writerTests = [...new Set([...writerTests, ...writerTestPaths(retryWriter, await changedPaths(worktree))])]
        capture()
        if (!(await writerGate())) return
        if (gate.ok) {
          await finishExecution(taskId, 'тесты тестописца не красные')
          return
        }
      }
    }

    let remark: string | undefined = resumeRemark
    for (let round = 1; round <= FACTORY_MAX_ROUNDS; round += 1) {
      progressStatement.run('execution', round, taskId)
      await refreshCards(taskId)
      await showAcceptanceProgress(taskId, 'execution', round)
      const before = await worktreeSnapshot(worktree)
      const journal = new Map<string, EntryState>()
      await runRole(current, 'executor', worktree, executorPrompt(remark), journal)
      if (!(await stillOwned())) return

      const roundState = await touchedByRound(worktree, before)
      const written = [...journal]
        .filter(([path, previous]) => !sameEntryState(entryState(join(worktree, path)), previous))
        .map(([path]) => path)
      const violations = [...new Set([...roundState.paths, ...written])].sort().filter(forbidden)
      if (violations.length > 0) {
        for (const path of violations) {
          if (restoreState(worktree, path, journal)) continue
          if (!restoreState(worktree, path, before)) await restorePath(worktree, path, snapshot)
        }
        remark = `Круг не засчитан: изменены пути вне footprint или тесты тестописца: ${violations.join(', ')}. Правь только разрешённые пути.`
        if (round === FACTORY_MAX_ROUNDS) await finishExecution(taskId, remark)
        continue
      }

      progressStatement.run('gate', round, taskId)
      await refreshCards(taskId)
      await showAcceptanceProgress(taskId, 'gate', round)
      const gateBefore = await worktreeSnapshot(worktree)
      const changed = [...new Set([...writerTests, ...(await changedPaths(worktree, base))])]
      gate = await runGate(current, worktree, changed, parsed.argv)
      const note = gateSandboxNote(gate)
      if (note !== undefined) {
        await finishGateFailure(taskId, note)
        return
      }
      if (!(await stillOwned())) return
      const failed = gate.ok
        ? ''
        : `Гейт не пройден (exit ${String(gate.status)}). Хвост вывода тестов:\n${outputTail(gate.output)}`

      // The project test command runs with write access to the worktree: it can
      // rewrite a locked writer test or a path outside the footprint after the
      // pre-gate check. Repeat that check after every gate, red or green, so the
      // next round never starts from (and no commit ever takes) a tree it changed.
      const gateViolations = await undoGateWrites(worktree, gateBefore, forbidden, snapshot)
      if (gateViolations.length > 0) {
        remark = `Круг не засчитан: гейт изменил пути вне footprint или тесты тестописца: ${gateViolations.join(', ')}. Правь только разрешённые пути.`
        if (failed !== '') remark += `\n${failed}`
        if (round === FACTORY_MAX_ROUNDS) await finishExecution(taskId, remark)
        continue
      }
      if (!gate.ok) {
        remark = failed
        if (round === FACTORY_MAX_ROUNDS) await finishExecution(taskId, remark)
        continue
      }

      progressStatement.run('review', round, taskId)
      await refreshCards(taskId)
      await showAcceptanceProgress(taskId, 'review', round)
      if (!(await stillOwned())) return
      const diff = await writeDiff(worktree)
      const answer = await runRole(current, 'reviewer', worktree, reviewerPrompt(diff.diff, diff.stat))
      const verdict = parseReview(answer)
      if (!verdict.approved) {
        remark = reviewRemark(verdict)
        if (round === FACTORY_MAX_ROUNDS) await finishExecution(taskId, remark)
        continue
      }

      if (!(await stillOwned())) return
      let files: string[]
      let stats: DiffStat[]
      let resultBase = base
      if (await hasPendingChanges(worktree)) {
        files = await commitResult(worktree, base, taskId)
        stats = parseDiffStats(await gitOutput(worktree, ['diff', '--numstat', base, 'HEAD']))
      } else {
        // Nothing new: keep the previous task commit, its base and its stats.
        const savedBase = current.result_base ?? base
        files = current.result_files !== null
          ? listOf(current.result_files)
          : (await gitOutput(worktree, ['diff', '--name-only', savedBase, 'HEAD']))
            .split(/\r?\n/).map((path) => path.trim()).filter((path) => path !== '')
        stats = current.result_stats !== null && savedBase === base
          ? statsOf(current.result_stats)
          : parseDiffStats(await gitOutput(worktree, ['diff', '--numstat', savedBase, 'HEAD']))
        resultBase = savedBase
      }
      await finishExecution(taskId, 'готово к приёмке', files, { base: resultBase, stats })
      const saved = findTaskStatement.get(taskId) as TaskRow | undefined
      if (saved === undefined) return
      if (hasResult(saved) && task.risk === 'low' && autoacceptEnabled() && await autoacceptCanMerge(task.projectPath)) {
        enqueueAcceptance(taskId)
      } else if (saved.acceptance_message_id === null) {
        await showAcceptanceCard(taskId)
      }
      return
    }
  }

  /**
   * Whether a restart can continue a task in its recorded worktree: the writer
   * round really finished (its tests and their content were recorded), the
   * worktree exists and is still checked out on the task branch. Anything less
   * starts the task over, exactly as before this recovery path existed.
   */
  async function canResumeFromExecutor(row: TaskRow): Promise<boolean> {
    if (listOf(row.writer_tests).length === 0) return false
    if (parseEntrySnapshot(row.writer_snapshot) === undefined) return false
    const worktree = row.worktree
    if (worktree === null || worktree === '') return false
    try {
      if (!statSync(worktree).isDirectory()) return false
    } catch {
      return false
    }
    if (await worktreeIdentity(worktree) === undefined) return false
    const branch = (await tryGit(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim()
    return branch !== undefined && branch === `factory/${row.id}`
  }

  /**
   * Restart recovery. Only a durable marker proves a phase really ran: a status
   * typed by hand (or a row that never reached execution) must not start a run.
   * A running task that is still on its task branch with its writer tests and
   * their content recorded goes on from the executor in that worktree; any
   * other running task loses its old worktree and starts over from round one.
   * The interrupted task stays first, the queued tasks keep their approval
   * order behind it.
   */
  async function resumeInterrupted(): Promise<void> {
    const rows = (listTasksStatement.all() as unknown as TaskRow[]).sort((first, second) => first.id - second.id)
    const interrupted = rows.filter((row) =>
      row.status === 'running' && ((row.worktree !== null && row.worktree !== '') || row.queued_at !== null))
    const waiting = rows
      .filter((row) => row.status === 'queued' && row.queued_at !== null)
      .sort((first, second) => Number(first.queued_at) - Number(second.queued_at) || first.id - second.id)
    for (const row of rows) {
      if (row.status === 'analysis' && Number(row.analysis_running ?? 0) === 1) {
        const target = taskTargets.get(row.id) ?? { chatId: options.ownerId() ?? 0 }
        enqueueAnalysis({
          taskId: row.id,
          chatId: target.chatId,
          ...('threadId' in target && target.threadId !== undefined ? { threadId: target.threadId } : {}),
          ...(row.remark === null ? {} : { remark: row.remark }),
        })
      }
    }

    // The queue is held while old worktrees are removed: an approval arriving
    // meanwhile lines up behind the resumed tasks instead of overtaking them.
    const resumed = [...interrupted, ...waiting].map((row) => row.id)
    executionQueue.splice(0, executionQueue.length, ...resumed, ...executionQueue.filter((id) => !resumed.includes(id)))
    executionHeld = true
    try {
      for (const [index, row] of interrupted.entries()) {
        if (await canResumeFromExecutor(row)) {
          if (index === 0) resumeRunningStatement.run(RESTART_RESUME_REMARK, row.id)
          else resumeQueuedStatement.run(Date.now(), RESTART_RESUME_REMARK, row.id)
          continue
        }
        await removeTaskWorktrees(row.project_path, row.id, row.worktree)
        // Only one task executes; any other interrupted row waits as queued.
        if (index === 0) resetRunningStatement.run(row.id)
        else requeueStatement.run(Date.now(), row.id)
      }
    } finally {
      executionHeld = false
    }
    void drainExecution()
  }

  /** Reset the five-minute wait after every message the flow puts to the owner. */
  function armSignInTimeout(state: ProviderSignIn): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      if (providerSignIn === state) endProviderSignIn(state, 'expired')
    }, PROVIDER_SIGN_IN_TIMEOUT_MS)
  }

  /**
   * End one attempt for good: release whoever waits for an answer, withdraw the
   * flow and tell the owner. A late second call (the flow finishing after the
   * timeout, two presses of «Отмена») is silent.
   */
  function endProviderSignIn(state: ProviderSignIn, reason: 'cancelled' | 'expired'): void {
    if (state.settled) return
    state.settled = true
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const prompt = state.prompt
    state.prompt = undefined
    state.options = undefined
    prompt?.reject(new Error('provider sign-in was withdrawn'))
    state.controller.abort()
    if (providerSignIn === state) providerSignIn = undefined
    const text = reason === 'expired'
      ? 'Ожидание ответа истекло: вход отменён.'
      : 'Вход отменён.'
    void sendFormatted(api, state.chatId, text).catch((error) => {
      log(`provider sign-in notice failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** One notice of the flow: the page becomes a link, the code stays copyable. */
  async function showProviderNotice(state: ProviderSignIn, notice: FactoryProviderNotice): Promise<void> {
    if (state.settled) return
    const lines = [notice.message]
    const keyboard: Array<Array<Record<string, unknown>>> = []
    if (notice.code !== undefined && notice.code !== '') lines.push('', `Код: ${notice.code}`)
    if (notice.url !== undefined && notice.url !== '') keyboard.push([linkButton('Открыть страницу', notice.url)])
    if (notice.code !== undefined && notice.code !== '') keyboard.push([copyButton('Скопировать код', notice.code)])
    await sendFormatted(api, state.chatId, lines.join('\n'), keyboard.length === 0 ? {} : { replyMarkup: { inline_keyboard: keyboard } })
    armSignInTimeout(state)
  }

  /** Put one question to the owner; the next message or button answers it. */
  async function askProvider(state: ProviderSignIn, request: FactoryProviderPrompt): Promise<string | undefined> {
    if (state.settled) throw new Error('provider sign-in was withdrawn')
    const keyboard: Array<Array<Record<string, unknown>>> = []
    const lines = [request.message]
    if (request.kind === 'select') {
      state.options = request.options ?? []
      for (const [index, option] of state.options.entries()) keyboard.push([button(option.label, `ps:${index}`)])
      lines.push('', 'Выберите вариант кнопкой.')
    } else {
      state.options = undefined
      lines.push('', 'Пришлите ответ следующим сообщением.')
    }
    keyboard.push([button('Отмена', 'pc', 'danger')])
    const answer = new Promise<string | undefined>((resolve, reject) => {
      state.prompt = { request, resolve, reject }
    })
    try {
      await sendFormatted(api, state.chatId, lines.join('\n'), { replyMarkup: { inline_keyboard: keyboard } })
      armSignInTimeout(state)
    } catch (error) {
      if (state.prompt?.request === request) {
        state.prompt = undefined
        state.options = undefined
      }
      throw error
    }
    return answer
  }

  /** Run one sign-in to its end and report it in the chat. */
  async function runProviderSignIn(state: ProviderSignIn, method: FactoryProviderMethod | undefined): Promise<void> {
    let status: FactoryProviderStatus = 'failed'
    if (options.connectProvider !== undefined) {
      const interaction: FactoryProviderInteraction = {
        signal: state.controller.signal,
        notify: (notice) => {
          state.outbox = state.outbox.then(() => showProviderNotice(state, notice)).catch((error) => {
            log(`provider sign-in notice failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        },
        prompt: (request) => {
          const answer = state.outbox.then(() => askProvider(state, request))
          state.outbox = answer.then(() => undefined, () => undefined)
          return answer
        },
      }
      try {
        status = await options.connectProvider(state.providerId, method?.id, interaction)
      } catch (error) {
        // The reason may quote what the owner sent; only the outcome is safe to
        // repeat, and the caller's journal scrubs what it does write.
        log(`provider sign-in of "${state.providerId}" failed: ${error instanceof Error ? error.name : 'error'}`)
        status = 'failed'
      }
    }
    if (state.settled) return
    state.settled = true
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    state.prompt = undefined
    state.options = undefined
    if (providerSignIn === state) providerSignIn = undefined
    const who = `${state.providerName} (${state.providerId})`
    const text = status === 'connected'
      ? `${who} подключён.`
      : status === 'cancelled'
        ? 'Вход отменён.'
        : `Не удалось войти в ${who}. Попробуйте ещё раз.`
    // A finished sign-in changes the list: the message carries the fresh
    // «Провайдеры» screen, where the provider is already marked.
    if (status !== 'connected') {
      await sendFormatted(api, state.chatId, text)
      return
    }
    const screen = await providersScreen()
    await sendFormatted(api, state.chatId, text, { replyMarkup: { inline_keyboard: screen.keyboard } })
  }

  /** Begin one sign-in unless another is already prompting this owner. */
  function startProviderSignIn(chatId: number, provider: FactoryProviderInfo, method: FactoryProviderMethod | undefined): void {
    const state: ProviderSignIn = {
      chatId,
      providerId: provider.id,
      providerName: provider.name,
      controller: new AbortController(),
      outbox: Promise.resolve(),
      settled: false,
    }
    providerSignIn = state
    void runProviderSignIn(state, method)
  }

  async function callbackScreen(callback: FactoryCallback): Promise<CallbackResult> {
    const parts = callback.data.split(':')
    const op = parts[1]
    if (op === 'h') return { screen: homeScreen() }
    if (op === 's') {
      switch (parts[2]) {
        case 't': {
          const page = Number(parts[3] ?? '0')
          return { screen: tasksScreen(Number.isSafeInteger(page) ? page : 0) }
        }
        case 'n': {
          const id = 0
          pending = { chatId: callback.chatId, kind: 'task', projectId: id }
          return { screen: newTaskScreen(id) }
        }
        case 'p':
          return { screen: projectsScreen() }
        case 'm':
          return { screen: modelsScreen() }
        case 'v':
          return { screen: await providersScreen() }
        case 'a':
          return { screen: autoacceptScreen() }
        default:
          return { screen: homeScreen() }
      }
    }
    if (op === 't') {
      const id = Number(parts[2])
      return { screen: Number.isSafeInteger(id) ? taskScreen(id) : tasksScreen() }
    }
    if (op === 'p') {
      const id = Number(parts[2])
      return { screen: Number.isSafeInteger(id) ? projectScreen(id) : projectsScreen() }
    }
    if (op === 'pa') {
      pending = { chatId: callback.chatId, kind: 'project' }
      return { screen: addProjectScreen() }
    }
    if (op === 'pd') {
      const id = Number(parts[2])
      if (Number.isSafeInteger(id) && id !== ownProject.id) deleteProjectStatement.run(id)
      return { screen: projectsScreen() }
    }
    if (op === 'np') {
      const id = Number(parts[2])
      const selected = Number.isSafeInteger(id) ? id : ownProject.id
      pending = { chatId: callback.chatId, kind: 'task', projectId: selected }
      return { screen: newTaskScreen(selected) }
    }
    if (op === 'pr') {
      const id = parts[2]
      return { screen: await providerScreen(id ?? '') }
    }
    if (op === 'pm') {
      const id = parts[2] ?? ''
      const list = await providerList()
      const provider = providerById(list, id)
      const index = Number(parts[3])
      const method = provider?.methods[Number.isSafeInteger(index) ? index : -1]
      if (provider === undefined || method === undefined) {
        return { screen: await providersScreen(), notice: 'Способ входа больше не доступен' }
      }
      if (providerSignIn !== undefined) {
        return { notice: `Вход уже идёт: ${providerSignIn.providerName} (${providerSignIn.providerId})`, answerOnly: true }
      }
      startProviderSignIn(callback.chatId, provider, method)
      return { screen: await providerScreen(provider.id), notice: 'Вход начат' }
    }
    if (op === 'po') {
      const id = parts[2] ?? ''
      try {
        await options.disconnectProvider?.(id)
      } catch (error) {
        log(`provider "${id}" sign-out failed: ${error instanceof Error ? error.name : 'error'}`)
        return { screen: await providerScreen(id), notice: 'Не удалось отключить провайдера' }
      }
      return { screen: await providerScreen(id), notice: 'Провайдер отключён' }
    }
    if (op === 'pc') {
      if (providerSignIn === undefined) return { answerOnly: true, notice: 'Вход уже не идёт' }
      endProviderSignIn(providerSignIn, 'cancelled')
      return { screen: homeScreen(), notice: 'Вход отменён' }
    }
    if (op === 'ps') {
      const state = providerSignIn
      const index = Number(parts[2])
      const option = state?.prompt?.request.kind === 'select' && Number.isSafeInteger(index)
        ? state.options?.[index]
        : undefined
      if (state === undefined || option === undefined || state.prompt === undefined) {
        return { answerOnly: true, notice: 'Вход уже не идёт' }
      }
      const prompt = state.prompt
      state.prompt = undefined
      state.options = undefined
      prompt.resolve(option.id)
      return { screen: await providerScreen(state.providerId), notice: 'Выбрано' }
    }
    if (op === 'm') return { screen: await roleScreen(parts[2]) }
    if (op === 'me') {
      const role = roleOf(parts[2])
      const level = parts[3]
      if (role === undefined || level === undefined) {
        return { screen: await roleScreen(parts[2]), notice: 'Уровень больше не поддерживается' }
      }
      // The row shows the levels of the first enabled model: only those are
      // selectable, including levels beyond the four of DeepSeek.
      const levels = await roleReasoningLevels(role, await catalogue())
      if (!levels.includes(level.trim().toLowerCase())) {
        return { screen: await roleScreen(parts[2]), notice: 'Уровень больше не поддерживается' }
      }
      store.kv.set(`${ROLE_EFFORT_KV_PREFIX}${role}`, level.trim().toLowerCase())
      return { screen: await roleScreen(parts[2]), notice: 'Готово' }
    }
    if (op === 'mp') {
      const models = await catalogue()
      const provider = providersOf(models).find((candidate) => providerHash(candidate) === parts[3])
      if (provider === undefined) return { screen: await roleScreen(parts[2]), notice: 'Провайдер больше не подключён' }
      const page = Number(parts[4])
      return { screen: await roleProviderScreen(parts[2], provider, Number.isSafeInteger(page) ? page : 0) }
    }
    if (op === 'mg') {
      const model = modelOf(await catalogue(), parts[3])
      if (model === undefined) return { screen: await roleScreen(parts[2]), notice: 'Модель больше не подключена' }
      return { screen: await roleModelPage(parts[2], model) }
    }
    if (op === 'mu') {
      const role = roleOf(parts[2])
      const models = await catalogue()
      const model = modelOf(models, parts[3])
      if (role === undefined || model === undefined) {
        return { screen: await roleScreen(parts[2]), notice: 'Модель больше не подключена' }
      }
      const ordered = rolePriority(role, models)
      const position = ordered.findIndex((candidate) => modelKey(candidate) === modelKey(model))
      if (position > 0) {
        ;[ordered[position - 1], ordered[position]] = [ordered[position]!, ordered[position - 1]!]
        saveRolePriority(role, ordered)
      }
      return { screen: await roleScreen(parts[2]), notice: 'Готово' }
    }
    if (op === 'mt') {
      const role = roleOf(parts[2])
      const models = await catalogue()
      const model = modelOf(models, parts[3])
      if (role === undefined || model === undefined) {
        return { screen: await roleScreen(parts[2]), notice: 'Модель больше не подключена' }
      }
      // The default list is switched at once: a role without a saved choice
      // does not need a second press to turn its stock model off.
      const ordered = rolePriority(role, models)
      const key = modelKey(model)
      const position = ordered.findIndex((candidate) => modelKey(candidate) === key)
      if (position >= 0 && ordered.length <= 1) {
        return {
          notice: 'Нельзя выключить последнюю модель роли: хотя бы одна должна остаться.',
          answerOnly: true,
        }
      }
      if (position >= 0) ordered.splice(position, 1)
      else ordered.push(model)
      saveRolePriority(role, ordered)
      return { screen: await roleModelPage(parts[2], model), notice: 'Готово' }
    }
    if (op === 'at') {
      store.kv.set(AUTOACCEPT_KV_KEY, autoacceptEnabled() ? '0' : '1')
      return { screen: autoacceptScreen() }
    }
    if (op === 'ac' || op === 'rv') {
      const id = Number(parts[2])
      const row = Number.isSafeInteger(id) ? (findTaskStatement.get(id) as TaskRow | undefined) : undefined
      if (row === undefined) return { screen: tasksScreen(), notice: 'Задача не найдена' }
      if (row.status !== 'awaiting_human') {
        const label = FACTORY_STATUS_LABELS[taskOf(row).status]
        const markdown = `**Задача #${id}:** вливать нечего — статус «${label}», приёмка её уже не ждёт.`
        if (row.acceptance_message_id === null) {
          await sendFormatted(api, callback.chatId, markdown)
        } else {
          await editScreen(row.acceptance_chat_id ?? callback.chatId, row.acceptance_message_id, { markdown, keyboard: [] })
        }
        return { notice: 'Задача уже не ждёт приёмки', answerOnly: true }
      }
      if (op === 'ac' && !hasResult(row)) {
        // An old card may still offer «Принять» on a task without a result:
        // answer the owner plainly and leave the status and the branch alone.
        await sendFormatted(
          api,
          callback.chatId,
          `**Задача #${id}:** принимать нечего: в задаче нет изменений. Верните её с замечанием или отклоните.`,
        )
        return { notice: 'принимать нечего: в задаче нет изменений', answerOnly: true }
      }
      if (op === 'ac') {
        enqueueAcceptance(id)
        // The card itself says what the press started: the toast of a callback
        // answer lives a second and leaves an old card looking untouched.
        if (row.acceptance_message_id !== null) {
          await editScreen(row.acceptance_chat_id ?? callback.chatId, row.acceptance_message_id, {
            markdown: `**Задача #${id}: ${row.title}**\n\n**Вливаю изменения.** Если не выйдет, пришлю причину.`,
            keyboard: [],
          })
        }
        return { notice: 'Вливаю изменения' }
      }
      pending = { chatId: callback.chatId, kind: 'acceptance-remark', taskId: id }
      return {
        screen: {
          markdown: [
            `**Задача #${id}: ${row.title}**`,
            '',
            '**Вернуть:** пришлите текст замечания — исполнитель начнёт новый круг с этого замечания.',
          ].join('\n'),
          keyboard: [],
        },
      }
    }
    if (op === 'ar') {
      const id = Number(parts[2])
      const row = Number.isSafeInteger(id) ? (findTaskStatement.get(id) as TaskRow | undefined) : undefined
      if (row !== undefined && row.status === 'awaiting_human' && !hasResult(row)) {
        // Rejecting an empty result ends the task for good: its worktree has no
        // commit to keep, so both the tree and the branch go away. The same
        // callback stands on «Отменить» of the analysis card: a task with a
        // result keeps its worktree and branch through the old aa/ar path.
        setStatusStatement.run('rejected', id)
        clearApprovalStatement.run(id)
        await removeTaskWorktrees(row.project_path, id, row.worktree)
        await removeTaskBranch(row.project_path, id)
        const markdown = [
          `**Задача #${id} «${row.title}»: отклонено**`,
          '',
          'Worktree задачи удалён, задача больше не ждёт приёмки.',
        ].join('\n')
        if (row.acceptance_message_id !== null) {
          await editScreen(row.acceptance_chat_id ?? callback.chatId, row.acceptance_message_id, { markdown, keyboard: [] })
          return { notice: 'Задача отклонена', answerOnly: true }
        }
        return { screen: { markdown, keyboard: [[button('Назад', 's:t')]] }, notice: 'Задача отклонена' }
      }
    }
    if (op === 'aa' || op === 'ar') {
      const id = Number(parts[2])
      const row = Number.isSafeInteger(id) ? (findTaskStatement.get(id) as TaskRow | undefined) : undefined
      if (row === undefined) return { screen: tasksScreen(), notice: 'Задача не найдена' }
      const rejected = op === 'ar'
      if (rejected) {
        setStatusStatement.run('rejected', id)
        clearApprovalStatement.run(id)
      } else {
        approveStatement.run(Date.now(), id)
        enqueueExecution(id)
      }
      const updated = findTaskStatement.get(id) as TaskRow | undefined
      const footer = rejected
        ? '**Решение:** Отклонено.'
        : '**Решение:** ✅ Одобрено — задача в очереди.'
      return {
        screen: { markdown: analysisMarkdown(taskOf(updated ?? row), footer), keyboard: [] },
        notice: rejected ? 'Задача отклонена' : 'Задача в очереди',
      }
    }
    if (op === 'ae') {
      const id = Number(parts[2])
      const row = Number.isSafeInteger(id) ? (findTaskStatement.get(id) as TaskRow | undefined) : undefined
      if (row === undefined) return { screen: tasksScreen(), notice: 'Задача не найдена' }
      pending = { chatId: callback.chatId, kind: 'remark', taskId: id }
      return {
        screen: {
          markdown: analysisMarkdown(taskOf(row), '**Править:** пришлите замечание — разбор повторится с ним.'),
          keyboard: [],
        },
      }
    }
    if (op === 'ay') {
      const id = Number(parts[2])
      const row = Number.isSafeInteger(id) ? (findTaskStatement.get(id) as TaskRow | undefined) : undefined
      if (row === undefined) return { screen: tasksScreen(), notice: 'Задача не найдена' }
      const target = taskTargets.get(id) ?? { chatId: callback.chatId }
      enqueueAnalysis({ taskId: id, chatId: target.chatId, ...(target.threadId === undefined ? {} : { threadId: target.threadId }) })
      return {
        screen: { markdown: `**Разбор задачи #${id}**\nПовторяю разбор…`, keyboard: [] },
      }
    }
    return { screen: homeScreen() }
  }

  // A restart resumes the phases that carry a durable marker: an interrupted
  // analysis with its remark and a running execution from round one. A status
  // typed by hand has no marker and starts nothing. The timer lets the daemon
  // finish constructing its runner before the first resume is requested.
  setTimeout(() => {
    void resumeInterrupted().catch((error) => {
      if (!finalized(error)) log(`resume failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 0)

  return {
    async open(chatId: number, threadId?: number): Promise<void> {
      // `/factory` is routed before the input lane, so the menu itself has to
      // withdraw a sign-in that waited for the owner: a command is never an
      // answer to a provider flow.
      if (providerSignIn !== undefined && providerSignIn.chatId === chatId) {
        endProviderSignIn(providerSignIn, 'cancelled')
      }
      pending = undefined
      await sendHome(chatId, threadId)
    },

    async handleCallback(callback: FactoryCallback): Promise<boolean> {
      // Cards sent before the `f1:` namespace carry bare acceptance data; the
      // owner's old «Принять» must still be answered instead of looking dead.
      const prefixed = callback.data.startsWith(`${CALLBACK_PREFIX}:`)
      if (!prefixed && !/^(?:ac|rv|ar):\d+$/.test(callback.data)) return false
      const data = prefixed ? callback.data : `${CALLBACK_PREFIX}:${callback.data}`
      const normalized = data === callback.data ? callback : { ...callback, data }
      if (!isOwner(normalized)) {
        await answer(normalized.id, 'Недостаточно прав')
        return true
      }
      try {
        const result = await callbackScreen(normalized)
        if (!result.answerOnly && result.screen !== undefined) {
          forgetTaskCard(normalized.messageId, normalized.chatId)
          await editScreen(normalized.chatId, normalized.messageId, result.screen)
          const detail = /^f1:t:(\d+)$/.exec(data)
          if (detail !== null) rememberTaskCard(Number(detail[1]), normalized.messageId, normalized.chatId)
        }
        await answer(normalized.id, result.notice ?? '')
      } catch (error) {
        // A press that dies inside an edit leaves no trace at all: the toast is
        // never sent and the card stays as it was, so the button looks dead.
        const reason = error instanceof Error ? error.message : String(error)
        log(`factory callback ${data} failed: ${reason}`)
        await answer(normalized.id, 'Не сработало')
        try {
          await sendFormatted(api, normalized.chatId, `**Кнопка не сработала.** Причина:\n${literal(reason)}`)
        } catch (noticeError) {
          if (!finalized(noticeError)) {
            log(`callback failure notice failed: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`)
          }
        }
      }
      return true
    },

    async takeInput(chatId: number, text: string, messageId?: number): Promise<boolean> {
      const signIn = providerSignIn
      if (signIn !== undefined && signIn.chatId === chatId) {
        // A command is never an answer: the attempt is withdrawn and the
        // command runs through the ordinary lane.
        if (text.startsWith('/')) {
          endProviderSignIn(signIn, 'cancelled')
          return false
        }
        if (signIn.prompt !== undefined && signIn.prompt.request.kind !== 'select') {
          const request = signIn.prompt.request
          const prompt = signIn.prompt
          signIn.prompt = undefined
          signIn.options = undefined
          if (request.kind === 'secret' && messageId !== undefined) {
            // The value leaves the chat before it reaches the flow; the store
            // of the flow is the only place that may keep it.
            try {
              await api.call('deleteMessage', { chat_id: chatId, message_id: messageId })
            } catch (error) {
              log(`deleteMessage of a provider secret failed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          prompt.resolve(text)
          return true
        }
      }
      if (pending === undefined || pending.chatId !== chatId) return false
      const current = pending
      pending = undefined
      if (current.kind === 'project') {
        const message = await addProject(text)
        await sendFormatted(api, chatId, message)
        return true
      }
      if (current.kind === 'acceptance-remark') {
        retryResumeStatement.run(Date.now(), text, text, current.taskId)
        await showAcceptanceProgress(current.taskId, 'execution', 1)
        enqueueExecution(current.taskId)
        return true
      }
      if (current.kind === 'remark') {
        const target = taskTargets.get(current.taskId) ?? { chatId }
        enqueueAnalysis({
          taskId: current.taskId,
          chatId: target.chatId,
          ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
          remark: text,
        })
        await sendFormatted(api, chatId, 'Замечание принято, повторяю разбор.')
        return true
      }
      try {
        const id = insertTask(text, current.projectId)
        taskTargets.set(id, { chatId })
        await sendFormatted(api, chatId, `Задача #${id} создана. Отправляю на разбор.`)
        enqueueAnalysis({ taskId: id, chatId })
      } catch (error) {
        log(`task creation failed: ${error instanceof Error ? error.message : String(error)}`)
        await sendFormatted(api, chatId, 'Не удалось создать задачу: текст пуст.')
      }
      return true
    },

    waitingForInput(chatId: number): boolean {
      if (pending !== undefined && pending.chatId === chatId) return true
      return providerSignIn !== undefined && providerSignIn.chatId === chatId && providerSignIn.prompt !== undefined
    },

    signInState(chatId: number): 'none' | 'active' | 'answer' {
      const signIn = providerSignIn
      if (signIn === undefined || signIn.chatId !== chatId) return 'none'
      return signIn.prompt !== undefined && signIn.prompt.request.kind !== 'select' ? 'answer' : 'active'
    },

    createTask(input: FactoryTaskInput): FactoryTask {
      const name = input.project === undefined ? undefined : input.project.trim()
      const project = name === undefined
        ? ownProject
        : projects().find((candidate) => candidate.name === name)
      if (project === undefined) {
        throw new Error(
          `Проект ${String(name)} не подключён. Подключённые проекты: ${projects().map((entry) => entry.name).join(', ')}.`,
        )
      }
      const id = insertTask(input.text, project.id, input.title)
      // The owner gets the same analysis card as a task typed into the menu.
      const chatId = options.ownerId()
      if (chatId !== null) {
        taskTargets.set(id, { chatId })
        enqueueAnalysis({ taskId: id, chatId })
      }
      const row = findTaskStatement.get(id) as TaskRow | undefined
      if (row === undefined) throw new Error('задача не найдена после создания')
      return taskOf(row)
    },

    listTasks(): FactoryTask[] {
      return tasks()
    },

    findTask(id: number): FactoryTask | undefined {
      const row = findTaskStatement.get(id) as TaskRow | undefined
      return row === undefined ? undefined : taskOf(row)
    },

    listProjects(): FactoryProject[] {
      return projects()
    },
  }
}
