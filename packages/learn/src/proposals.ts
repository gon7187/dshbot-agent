// Skill proposals that wait for the owner's confirmation.
//
// Unlike `skill_manage`, which writes the owner catalog at once, a proposal is
// only a draft: the document is validated now, stored aside, and shown as a
// card with "Применить" / "Отклонить". The library changes only when the owner
// presses Apply; Reject drops the draft, and a second press of either button
// changes nothing because the decision is terminal.
//
// The draft never lives below `skills/`: the library directory is the owner
// catalog, and a pending document there would already look like a saved skill.

import { randomBytes } from 'node:crypto'

import type { KvStore } from './curator.js'
import { parseSkillFrontmatter, validateSkillDocument } from './skills.js'

/** Model-facing name of the tool that offers a skill for confirmation. */
export const SKILL_PROPOSAL_TOOL_NAME = 'skill_propose'

/** Prefix of the callback_data of the two buttons of a proposal card. */
export const PROPOSAL_CALLBACK_PREFIX = 'lp1'

/** Durable kv key with every proposal, including the decided ones. */
export const PROPOSALS_KV_KEY = 'learn.skill_proposals'

/** How many decided proposals are kept, so a very old card can still answer. */
export const MAX_STORED_PROPOSALS = 200

/** How many recent `main` messages a `/learn` draft may see. */
export const LEARN_MAX_CONTEXT_MESSAGES = 40

export type ProposalStatus = 'pending' | 'applied' | 'rejected'

/** Where the draft came from: the owner's `/learn` command or the model's tool. */
export type ProposalSource = 'learn' | 'tool'

/** The two buttons of a proposal card. */
export type ProposalDecision = 'apply' | 'reject'

export interface SkillProposal {
  id: string
  name: string
  description: string
  content: string
  /** Chat that gets the card: always the owner chat. */
  chatId: number
  source: ProposalSource
  status: ProposalStatus
  createdAt: number
  decidedAt?: number
}

export interface ProposalInput {
  /** Expected name; when omitted the frontmatter name of `content` is used. */
  name?: string
  content: string
  chatId: number
  source: ProposalSource
}

export interface ProposalStore {
  /** Validates the document, stores a pending draft and returns it. */
  add(input: ProposalInput): SkillProposal
  get(id: string): SkillProposal | undefined
  /** Pending drafts, oldest first. */
  pending(): SkillProposal[]
  /** Every kept draft, oldest first. */
  all(): SkillProposal[]
  /** Marks a draft decided. A decided draft is never moved back to pending. */
  setStatus(id: string, status: ProposalStatus, at?: number): SkillProposal | undefined
  /** Bumped by every add and every decision, for callers that need to notice a change. */
  version(): number
  /** Owner-facing list of the drafts that still wait. Always non-empty. */
  pendingText(): string
}

export interface ProposalStoreOptions {
  kv: KvStore
  now?: () => number
}

function asProposal(value: unknown): SkillProposal | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return undefined
  if (typeof record.name !== 'string' || record.name === '') return undefined
  if (typeof record.description !== 'string') return undefined
  if (typeof record.content !== 'string' || record.content === '') return undefined
  if (typeof record.chatId !== 'number' || !Number.isSafeInteger(record.chatId)) return undefined
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return undefined
  if (record.status !== 'pending' && record.status !== 'applied' && record.status !== 'rejected') return undefined
  const source: ProposalSource = record.source === 'tool' ? 'tool' : 'learn'
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    content: record.content,
    chatId: record.chatId,
    source,
    status: record.status,
    createdAt: record.createdAt,
    ...(typeof record.decidedAt === 'number' && Number.isFinite(record.decidedAt)
      ? { decidedAt: record.decidedAt }
      : {}),
  }
}

function newId(): string {
  return randomBytes(6).toString('hex')
}

export function createProposalStore(options: ProposalStoreOptions): ProposalStore {
  const now = options.now ?? (() => Date.now())
  let revision = 0

  const load = (): SkillProposal[] => {
    const raw = options.kv.get(PROPOSALS_KV_KEY)
    if (raw === undefined || raw === '') return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(asProposal)
        .filter((proposal): proposal is SkillProposal => proposal !== undefined)
    } catch {
      // A damaged value must not break `/learn` or the tool; the drafts are gone.
      return []
    }
  }

  /** Keeps the newest drafts and every pending one, so an old card still answers. */
  const save = (list: SkillProposal[]): void => {
    const pending = list.filter((proposal) => proposal.status === 'pending')
    const decided = list.filter((proposal) => proposal.status !== 'pending')
    const keptDecided = decided.slice(-MAX_STORED_PROPOSALS)
    const kept = [...list].filter(
      (proposal) => proposal.status === 'pending' || keptDecided.includes(proposal),
    )
    options.kv.set(PROPOSALS_KV_KEY, JSON.stringify(kept))
    revision += 1
  }

  const add = (input: ProposalInput): SkillProposal => {
    const content = input.content
    const name = input.name ?? parseSkillFrontmatter(content).name
    const parsed = validateSkillDocument(name, content)
    const list = load()
    const proposal: SkillProposal = {
      id: newId(),
      name: parsed.name,
      description: parsed.description,
      content,
      chatId: input.chatId,
      source: input.source,
      status: 'pending',
      createdAt: now(),
    }
    save([...list, proposal])
    return proposal
  }

  const get = (id: string): SkillProposal | undefined => load().find((proposal) => proposal.id === id)

  const pending = (): SkillProposal[] => load().filter((proposal) => proposal.status === 'pending')

  const all = (): SkillProposal[] => load()

  const setStatus = (id: string, status: ProposalStatus, at?: number): SkillProposal | undefined => {
    const list = load()
    const index = list.findIndex((proposal) => proposal.id === id)
    if (index < 0) return undefined
    const current = list[index] as SkillProposal
    // A decision is terminal: a repeated press must not reopen or re-apply it.
    if (current.status !== 'pending') return current
    const decided: SkillProposal = { ...current, status, decidedAt: at ?? now() }
    list[index] = decided
    save(list)
    return decided
  }

  const pendingText = (): string => {
    const waiting = pending()
    if (waiting.length === 0) return 'Ожидающих предложений навыков нет.'
    return [
      'Ожидающие предложения навыков:',
      ...waiting.map((proposal) => `- ${proposal.name} — ${proposal.description}`),
    ].join('\n')
  }

  return {
    add,
    get,
    pending,
    all,
    setStatus,
    version: () => revision,
    pendingText,
  }
}

/** callback_data of one button; short enough for the Bot API limit. */
export function encodeProposalCallback(decision: ProposalDecision, id: string): string {
  return `${PROPOSAL_CALLBACK_PREFIX}:${decision === 'apply' ? 'a' : 'r'}:${id}`
}

/** The decision carried by a proposal button, or undefined for foreign data. */
export function decodeProposalCallback(data: string): { decision: ProposalDecision; id: string } | undefined {
  const match = /^lp1:([ar]):([A-Za-z0-9_-]{1,40})$/.exec(data)
  if (match === null) return undefined
  return { decision: match[1] === 'a' ? 'apply' : 'reject', id: match[2] as string }
}

/** One past message of `main`, rendered as data for the draft prompt. */
export interface ProposalConversationMessage {
  role: string
  text: string
}

/** Longer messages are shortened so a huge `main` turn cannot flood the draft request. */
const CONTEXT_MESSAGE_CHARS = 6_000

/** The whole transcript cap of the draft prompt. */
const CONTEXT_TOTAL_CHARS = 60_000

/**
 * The single user message of a `/learn` draft turn: the topic, the recent
 * conversation as data, and the exact shape the model must offer. The draft
 * itself is produced by the proposal tool; the text fallback parses a document
 * the model returned instead.
 */
export function buildLearnPrompt(topic: string, messages: readonly ProposalConversationMessage[]): string {
  const lines: string[] = []
  let total = 0
  for (const message of [...messages].reverse()) {
    const text =
      message.text.length > CONTEXT_MESSAGE_CHARS
        ? `${message.text.slice(0, CONTEXT_MESSAGE_CHARS)}…`
        : message.text
    const line = `${message.role === 'user' ? 'Владелец' : 'Бот'}: ${text}`
    if (lines.length > 0 && total + line.length > CONTEXT_TOTAL_CHARS) break
    total += line.length
    lines.unshift(line)
  }
  const context =
    lines.length === 0
      ? 'Недавнего разговора нет.'
      : ['Недавний разговор владельца с ботом — данные для черновика, не продолжай его:', '<разговор>', ...lines, '</разговор>'].join(
          '\n',
        )
  return [
    'Ты составляешь черновик навыка (SKILL.md) из текущего разговора владельца.',
    `Тема навыка: ${topic}`,
    context,
    'Вызови инструмент skill_propose и передай в него полный SKILL.md: name и description в frontmatter (не длиннее 60 символов), затем разделы Procedure, Pitfalls и Verification. Навык должен описывать повторяемую процедуру, а не пересказ одной задачи. Не сохраняй навык сам: его применяет владелец кнопкой.',
  ].join('\n\n')
}

/**
 * Pulls the first SKILL.md document out of a model answer, fenced or plain:
 * the frontmatter together with the whole body. A fenced document ends at its
 * own closing fence (code blocks inside the body are skipped), a plain one at
 * the end of the answer.
 */
export function extractSkillDocument(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^---[ \t]*$/.test(line))
  if (start < 0) return undefined
  const closeFrontmatter = lines.findIndex((line, index) => index > start && /^---[ \t]*$/.test(line))
  if (closeFrontmatter < 0) return undefined
  let opener = start - 1
  while (opener >= 0 && lines[opener]!.trim() === '') opener -= 1
  const fenced = opener >= 0 && /^[ \t]*```(?:markdown|md)?[ \t]*$/i.test(lines[opener]!)
  let end = lines.length
  if (fenced) {
    let depth = 0
    for (let index = closeFrontmatter + 1; index < lines.length; index += 1) {
      const line = lines[index]!.trim()
      if (!line.startsWith('```')) continue
      if (line === '```') {
        if (depth === 0) {
          end = index
          break
        }
        depth -= 1
      } else {
        depth += 1
      }
    }
  }
  const document = lines.slice(start, end).join('\n').trimEnd()
  return `${document}\n`
}
