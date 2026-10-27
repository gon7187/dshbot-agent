// DSHBOT learning loop (DESIGN §8.1): nudge counters, the background experience
// review, the skill library with `skill_manage`, its index in the tail of the
// owner turn, and the deterministic curator.
//
// The package owns no model call and no harness object: the daemon injects
// `launchReview` (a flash request with the review tool whitelist) and a durable
// key/value store (state.db kv). The unit tests inject a fake clock and a
// counting reviewer, so scheduled/guest turns can be checked without a network.
//
// Owners of the package seam:
//   * `noteTurn(kind, toolIterations)` is the single place that moves counters;
//     only `owner` does, so scheduled and guest turns cost nothing;
//   * `skillsIndex()` is the volatile service line for the tail of the next
//     owner turn; it never enters the stable prefix (session `main` survives);
//   * `reviewTools()` returns a fresh read-before-write tracker per review.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { RunnerTool } from '../../runner/src/index.js'
import { createCurator, type Curator, type KvStore } from './curator.js'
import { createMemoryTool } from './memory.js'
import { buildExperienceReviewPrompt, type ReviewContext } from './prompts.js'
import {
  createProposalStore,
  SKILL_PROPOSAL_TOOL_NAME,
  type ProposalDecision,
  type ProposalInput,
  type ProposalStore,
  type SkillProposal,
} from './proposals.js'
import { createReadTracker, createSkillStore, createSkillTools, SKILL_FILE, type SkillStore } from './skills.js'

export { createCurator } from './curator.js'
export type { Curator, CuratorReport, KvStore } from './curator.js'
export {
  CURATOR_IDLE_MS,
  CURATOR_INTERVAL_MS,
  SKILL_ARCHIVE_MS,
  SKILL_STALE_MS,
} from './curator.js'
export {
  builtinSkillsDir,
  commandInPath,
  createReadTracker,
  createSkillStore,
  createSkillTools,
  expandSkillPaths,
  HERMES_SKILL_DIR_TOKEN,
  IMPORTED_SKILL_DESCRIPTION_LIMIT,
  IMPORTED_SKILL_NAME_LIMIT,
  parseSkillFrontmatter,
  REQUIRED_SKILL_SECTIONS,
  SKILL_BASE_DIR_TOKEN,
  SKILL_DESCRIPTION_LIMIT,
  SKILL_FILE,
  SKILL_NAME_LIMIT,
  skillRequirements,
  SKILLS_ARCHIVE_DIR,
  SKILLS_DIR,
  validateImportedSkillDocument,
  validateImportedSkillName,
  validateSkillDocument,
  type ReadTracker,
  type SkillInfo,
  type SkillMeta,
  type SkillRequirements,
  type SkillStore,
  type SkillToolOptions,
} from './skills.js'
export {
  buildLearnPrompt,
  createProposalStore,
  decodeProposalCallback,
  encodeProposalCallback,
  extractSkillDocument,
  LEARN_MAX_CONTEXT_MESSAGES,
  MAX_STORED_PROPOSALS,
  PROPOSALS_KV_KEY,
  PROPOSAL_CALLBACK_PREFIX,
  SKILL_PROPOSAL_TOOL_NAME,
  type ProposalConversationMessage,
  type ProposalDecision,
  type ProposalInput,
  type ProposalSource,
  type ProposalStatus,
  type ProposalStore,
  type SkillProposal,
} from './proposals.js'
export { createMemoryTool, MEMORY_TOOL_NAME } from './memory.js'
export { buildExperienceReviewPrompt, REVIEW_PROMPT_HEAD, type ReviewContext } from './prompts.js'

/** Owner turns between memory reviews. */
export const NUDGE_MEMORY_TURNS = 10

/** Tool iterations between skill reviews. */
export const NUDGE_SKILL_ITERATIONS = 12

/** Iteration cap of the review request; the review must end with an answer. */
export const REVIEW_MAX_ITERATIONS = 16

/** Tools the review may call, in the sorted order the runner sends them. */
export const REVIEW_TOOL_NAMES = ['memory', 'read', 'skill_manage', 'skill_view', 'skills_list'] as const

/** Names of the tools `reviewTools()` contributes (the caller adds `read`). */
export const REVIEW_OWN_TOOL_NAMES = ['memory', 'skill_manage', 'skill_view', 'skills_list'] as const

/** Marker of the service insertion in the tail of an owner turn. */
export const SKILLS_INDEX_OPEN = '<context_не_owner: индекс навыков>'
export const SKILLS_INDEX_CLOSE = '</context_не_owner>'

/** What kind of turn asked for work; only the owner moves the nudge counters. */
export type TurnKind = 'owner' | 'guest' | 'scheduled'

export interface TurnOutcome {
  kind: TurnKind
  /** A review of experience is due after this owner turn. */
  review: boolean
  /** The memory counter reached its interval. */
  memoryDue: boolean
  /** The skills counter reached its interval. */
  skillsDue: boolean
}

export interface LearningOptions {
  /** DSHBOT_HOME; the skill library is `<home>/skills`. */
  home: string
  /** Durable counters: state.db kv in the daemon. */
  kv: KvStore
  now?: () => number
  log?: (message: string) => void
  /**
   * Skills shipped with the daemon. They are copied into the owner catalog and
   * stay read-only there. Omitted by unit tests that own their catalog.
   */
  builtinDir?: string
  /**
   * `DSHBOT_HOME/workspace/.agents/skills`: hand-written skill files the owner
   * or the model may leave in the workspace. They are not the catalog; the turn
   * gets an explicit hint about them instead of losing them silently.
   */
  workspaceSkillsDir?: string
  /**
   * Runs one review prompt. The daemon starts a flash runner with the review
   * tool whitelist; tests count the calls instead of calling a model.
   */
  launchReview: (prompt: string) => Promise<void> | void
  /** Override of the curator cadence, for tests. */
  curatorIntervalMs?: number
  curatorIdleMs?: number
  /**
   * Chat that gets the card of a proposed skill, normally the paired owner.
   * Omitted in unit tests that only inspect the stored drafts.
   */
  proposalChatId?: () => number | undefined
  /**
   * Names in the secret vault of the owner. `skill_view` marks each variable an
   * imported skill asks for as present or missing without reading its value.
   */
  secretNames?: () => readonly string[]
  /**
   * Sends the Apply / Reject card of a proposal. The daemon owns the Telegram
   * call; the package only says which draft waits for a decision.
   */
  onProposal?: (proposal: SkillProposal) => Promise<void> | void
}

export interface Learning {
  /**
   * Accounts one completed turn. Only `owner` increments the memory counter by
   * one and the skills counter by `toolIterations`; the returned `review` flag
   * says whether the caller must start the review after delivering the answer.
   */
  noteTurn(kind: TurnKind, toolIterations?: number): TurnOutcome
  /** Compact index block for the tail of the next owner turn, or an empty string. */
  skillsIndex(): string
  /** Fresh skill/memory tools of one review: a new read tracker every call. */
  reviewTools(): RunnerTool[]
  /** The skill tools of the owner's main session: create/patch/delete of the owner catalog. */
  mainTools(): RunnerTool[]
  /**
   * Drafts a skill and shows the confirmation card. Nothing reaches the
   * library here: only {@link Learning.decideProposal} with `apply` saves it.
   */
  proposeSkill(input: ProposalInput): Promise<SkillProposal>
  /** Pending drafts of the owner, oldest first. */
  pendingProposals(): SkillProposal[]
  /** Owner-facing list of the pending drafts; never an empty string. */
  proposalListText(): string
  /** Applies or rejects one draft. A decided draft is never changed again. */
  decideProposal(id: string, decision: ProposalDecision): { ok: boolean; message: string; proposal?: SkillProposal }
  /** Bumped whenever a draft is added or decided. */
  proposalVersion(): number
  /**
   * A service insertion for the tail of an owner turn when the workspace has
   * hand-written skill files outside the catalog; empty otherwise.
   */
  externalSkillsHint(): string
  /** Starts the review in the background; never throws and never blocks a turn. */
  startReview(context: ReviewContext): void
  /** Starts the periodic curator and returns its stop function. */
  startCurator(): () => void
  /** The deterministic curator, for tests and diagnostics. */
  curator(): Curator
  /** Waits for the reviews that are still in flight. */
  stop(): Promise<void>
}

const MEMORY_COUNTER_KEY = 'learn.owner_turns_since_memory_review'
const SKILLS_COUNTER_KEY = 'learn.tool_iterations_since_skills_review'

function counter(kv: KvStore, key: string): number {
  const raw = kv.get(key)
  if (raw === undefined || !/^\d+$/.test(raw)) return 0
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : 0
}

function positive(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

export function createLearning(options: LearningOptions): Learning {
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => undefined)
  const store: SkillStore = createSkillStore({
    home: options.home,
    now,
    ...(options.builtinDir === undefined ? {} : { builtinDir: options.builtinDir }),
  })
  // Drafts that wait for the owner's Apply / Reject live in state.db, never in
  // the library directory: a pending document is not a skill yet.
  const proposals: ProposalStore = createProposalStore({ kv: options.kv, now })
  const proposeSkill = async (input: ProposalInput): Promise<SkillProposal> => {
    const proposal = proposals.add(input)
    if (options.onProposal !== undefined) await options.onProposal(proposal)
    return proposal
  }
  // The owner's tools keep one read tracker for the whole session: skill_view
  // in any owner turn is enough evidence before the owner tool changes a skill.
  const ownerTracker = createReadTracker()
  const curator = createCurator({
    store,
    kv: options.kv,
    now,
    log,
    ...(options.curatorIntervalMs === undefined ? {} : { intervalMs: options.curatorIntervalMs }),
    ...(options.curatorIdleMs === undefined ? {} : { idleMs: options.curatorIdleMs }),
  })
  const running = new Set<Promise<void>>()
  let reviewInFlight = false

  const noteTurn = (kind: TurnKind, toolIterations = 0): TurnOutcome => {
    // Activity of every kind postpones the curator; only the owner is a nudge.
    curator.touch(now())
    if (kind !== 'owner') return { kind, review: false, memoryDue: false, skillsDue: false }

    const turns = counter(options.kv, MEMORY_COUNTER_KEY) + 1
    const iterations = counter(options.kv, SKILLS_COUNTER_KEY) + positive(toolIterations)
    const memoryDue = turns >= NUDGE_MEMORY_TURNS
    const skillsDue = iterations >= NUDGE_SKILL_ITERATIONS
    options.kv.set(MEMORY_COUNTER_KEY, String(memoryDue ? 0 : turns))
    options.kv.set(SKILLS_COUNTER_KEY, String(skillsDue ? 0 : iterations))
    return { kind, review: memoryDue || skillsDue, memoryDue, skillsDue }
  }

  const skillsIndex = (): string => {
    const lines = store.indexLines()
    if (lines.length === 0) return ''
    return `${SKILLS_INDEX_OPEN}\n${lines.join('\n')}\n${SKILLS_INDEX_CLOSE}`
  }

  const reviewTools = (): RunnerTool[] => {
    const tracker = createReadTracker()
    return [
      createMemoryTool(options.home),
      ...createSkillTools(store, tracker, options.secretNames === undefined ? {} : { secretNames: options.secretNames }),
    ]
  }

  /**
   * The model's own proposal tool. It is the same draft and the same card as
   * `/learn`, and it never saves: the owner's Apply is the only write path.
   */
  const proposalTool: RunnerTool = {
    name: SKILL_PROPOSAL_TOOL_NAME,
    description:
      'Offer a new skill to the owner for confirmation. Creates a draft and shows a card with Применить (Apply) ' +
      'and Отклонить (Reject); the skill enters the library only after the owner presses Apply. Pass the full ' +
      'SKILL.md in content.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, one path segment.' },
        description: { type: 'string', description: 'One-line description, at most 60 characters.' },
        content: {
          type: 'string',
          description:
            'Full SKILL.md: --- frontmatter with name and description, then Procedure, Pitfalls, Verification.',
        },
      },
      required: ['name', 'content'],
    },
    async execute(args) {
      const name = args.name
      const content = args.content
      if (typeof name !== 'string' || name === '') throw new Error('name is required and must be a non-empty string')
      if (typeof content !== 'string' || content === '') {
        throw new Error('content is required and must be a non-empty string')
      }
      const chatId = options.proposalChatId?.()
      if (chatId === undefined) throw new Error('некому показать карточку: владелец ещё не подключён')
      const proposal = await proposeSkill({ name, content, chatId, source: 'tool' })
      return `Предложение навыка ${proposal.name} показано владельцу: навык появится в библиотеке только после кнопки «Применить».`
    },
  }

  const mainTools = (): RunnerTool[] => [
    ...createSkillTools(store, ownerTracker, {
      readBeforeWrite: false,
      allowDelete: true,
      ownerCatalog: true,
      ...(options.secretNames === undefined ? {} : { secretNames: options.secretNames }),
    }),
    proposalTool,
  ]

  /**
   * Names under the workspace `.agents/skills` that are not in the catalog.
   * The hint is recomputed every owner turn: a file written by hand during the
   * previous turn is named in the next one instead of disappearing silently.
   */
  const externalSkillsHint = (): string => {
    const root = options.workspaceSkillsDir
    if (root === undefined || !existsSync(root)) return ''
    const found: string[] = []
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        // Only a plain skill name reaches the turn: a directory name is data the
        // model wrote and must not smuggle text into the service block.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue
        if (existsSync(join(root, entry.name, SKILL_FILE))) found.push(entry.name)
      }
    } catch {
      // A workspace being rewritten must not break the turn.
    }
    if (found.length === 0) return ''
    found.sort()
    return (
      `${SKILLS_INDEX_OPEN}\n` +
      `В workspace есть файлы навыков вне каталога: ${found.join(', ')} ` +
      '(`.agents/skills`). Они не видны skills_list и следующему ходу. ' +
      'Запиши такой навык через `skill_manage` (create/patch) — это единственный каталог навыков владельца.\n' +
      `${SKILLS_INDEX_CLOSE}`
    )
  }

  const startReview = (context: ReviewContext): void => {
    if (reviewInFlight) {
      log('experience review is already running; this nudge is skipped')
      return
    }
    reviewInFlight = true
    const prompt = buildExperienceReviewPrompt({ ...context, skillsIndex: context.skillsIndex ?? skillsIndex() })
    const run = (async (): Promise<void> => {
      try {
        await options.launchReview(prompt)
      } catch (error) {
        log(`experience review failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        reviewInFlight = false
      }
    })()
    running.add(run)
    void run.finally(() => running.delete(run))
  }

  const startCurator = (): (() => void) => {
    const tick = (): void => {
      try {
        const report = curator.runIfDue()
        if (report.archived.length > 0 || report.stale.length > 0) {
          log(`curator: stale=[${report.stale.join(', ')}] archived=[${report.archived.join(', ')}]`)
        }
      } catch (error) {
        log(`curator failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // A restart is exactly when a long idle period is noticed; the periodic
    // check then only covers a daemon that stays up for days.
    tick()
    const timer = setInterval(tick, 60 * 60 * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  const decideProposal = (
    id: string,
    decision: ProposalDecision,
  ): { ok: boolean; message: string; proposal?: SkillProposal } => {
    const proposal = proposals.get(id)
    if (proposal === undefined) return { ok: false, message: 'Предложение не найдено или устарело' }
    if (proposal.status !== 'pending') {
      return { ok: false, message: 'Решение уже принято', proposal }
    }
    if (decision === 'reject') {
      const decided = proposals.setStatus(id, 'rejected')
      return { ok: true, message: 'Черновик навыка отклонён', ...(decided === undefined ? {} : { proposal: decided }) }
    }
    try {
      const info = store.create(proposal.name, proposal.content)
      const decided = proposals.setStatus(id, 'applied')
      return {
        ok: true,
        message: `Навык ${info.name} сохранён в библиотеку`,
        ...(decided === undefined ? {} : { proposal: decided }),
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Не удалось сохранить навык: ${reason}`, proposal }
    }
  }

  return {
    noteTurn,
    skillsIndex,
    reviewTools,
    mainTools,
    proposeSkill,
    pendingProposals: () => proposals.pending(),
    proposalListText: () => proposals.pendingText(),
    decideProposal,
    proposalVersion: () => proposals.version(),
    externalSkillsHint,
    startReview,
    startCurator,
    curator: () => curator,
    async stop(): Promise<void> {
      await Promise.allSettled([...running])
    },
  }
}
