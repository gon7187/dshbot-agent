// Review step of the self-rewriting gate: the request of the production reviewer, an empty answer, the reason
// of a rejection and the verdict log.
//
// The reviewer is the real httpReviewer of packages/evolve with a fake fetch; the sandboxed `npm test` is
// replaced by the sandbox seam, so no bwrap is needed. The candidate is a real git worktree of a temporary
// `live` repository, the same way tests/evolve/gate-node-modules.test.ts builds it.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createEvolve, httpReviewer, type Evolve, type EvolveOptions } from '../../packages/evolve/src/index.js'

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

const API_KEY = 'sk-review-test-secret-key-0123456789abcdef'

type Fetch = typeof globalThis.fetch

let root = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-review-verdict-')))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** A fetch answering with the given Messages API payloads one after another (the last one repeats). */
function scriptedFetch(payloads: unknown[]): { fetch: Fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = []
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const payload = payloads[Math.min(bodies.length - 1, payloads.length - 1)]
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as Fetch
  return { fetch, bodies }
}

function textAnswer(text: string): unknown {
  return { id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

function thinkingOnlyAnswer(): unknown {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'let me think about the diff for a long time', signature: 'sig' }],
  }
}

interface World {
  evolve: Evolve
}

/** Extra options reach createEvolve through a cast: the log hook may be named differently by the implementation. */
function makeWorld(fetch: Fetch, log?: (message: string) => void): World {
  const dshbotHome = join(root, 'home')
  const live = join(dshbotHome, 'app')
  put(join(live, 'CHECKLIST.md'), '# Review checklist\n- no secrets in code\n')
  put(join(live, 'notes.md'), 'original notes\n')
  git(live, 'init', '-q', '-b', 'live')
  git(live, 'add', '-A')
  git(live, 'commit', '-q', '-m', 'base')
  const base: EvolveOptions = {
    home: dshbotHome,
    live,
    ownerHome: root,
    review: { baseUrl: 'http://127.0.0.1:9', apiKey: API_KEY, fetch },
    sandbox: () => ({ ok: true, status: 0, output: '' }),
    card: async () => {},
  }
  const options = (log === undefined ? base : { ...base, log, logger: log, onLog: log }) as EvolveOptions
  return { evolve: createEvolve(options) }
}

/** self_change, one edit in the candidate, self_submit; resolves with the text of the gate or rejects with its error. */
async function submitCandidate(world: World, change = 'edited notes\n'): Promise<string> {
  const tools = new Map(world.evolve.tools.map((tool) => [tool.name, tool]))
  const started = String(await tools.get('self_change')?.execute({ description: 'edit the notes' }))
  const id = /^id:\s*(\S+)/m.exec(started)?.[1]
  const path = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
  if (id === undefined || path === undefined) throw new Error(`self_change gave no candidate: ${started}`)
  put(join(path, 'notes.md'), change)
  return String(await tools.get('self_submit')?.execute({ id }))
}

async function gateError(world: World): Promise<string> {
  try {
    await submitCandidate(world)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the gate was expected to fail, but it passed')
}

// --- [nothink] -------------------------------------------------------------------------------------

test('test_c1_nothink_reviewer_request_disables_thinking_and_has_room_for_the_answer', async () => {
  const { fetch, bodies } = scriptedFetch([textAnswer('{"verdict":"approve","summary":"ok"}')])
  const reviewer = httpReviewer({ baseUrl: 'http://deepseek.invalid', apiKey: API_KEY, fetch })

  const answer = await reviewer({ model: 'deepseek-v4-pro', prompt: 'review this' })

  expect(answer).toContain('approve')
  expect(bodies).toHaveLength(1)
  const body = bodies[0] as Record<string, unknown>
  const thinking = body.thinking
  const type = typeof thinking === 'string' ? thinking : (thinking as { type?: unknown } | undefined)?.type
  expect(type, 'the request switches thinking off explicitly').toBe('disabled')
  expect(Number(body.max_tokens), 'the answer has room: max_tokens >= 4000').toBeGreaterThanOrEqual(4000)
})

// --- [empty] ---------------------------------------------------------------------------------------

test('test_c2_empty_answer_of_the_reviewer_is_a_review_error_with_stop_reason_and_block_types', async () => {
  const { fetch, bodies } = scriptedFetch([thinkingOnlyAnswer()])
  const world = makeWorld(fetch)

  const message = await gateError(world)

  expect(message).toContain('пустой ответ')
  expect(message).toContain('max_tokens')
  expect(message).toContain('thinking')
  expect(bodies.length, 'an empty answer is retried like an unavailable review').toBeGreaterThan(1)
})

test('test_c2_empty_answer_is_retried_and_a_later_approval_passes_the_gate', async () => {
  const { fetch, bodies } = scriptedFetch([thinkingOnlyAnswer(), textAnswer('{"verdict":"approve","summary":"fine"}')])
  const world = makeWorld(fetch)

  const outcome = await submitCandidate(world)

  expect(bodies).toHaveLength(2)
  expect(outcome).toContain('прошёл гейт')
})

// --- [reason] --------------------------------------------------------------------------------------

test('test_c3_reason_rejection_error_contains_the_summary_of_the_reviewer', async () => {
  const { fetch } = scriptedFetch([textAnswer('{"verdict":"reject","summary":"SUMMARY_X_4711"}')])
  const world = makeWorld(fetch)

  const message = await gateError(world)

  expect(message).toContain('SUMMARY_X_4711')
})

test('test_c3_reason_rejection_without_summary_shows_the_start_of_the_raw_answer_only', async () => {
  const raw = `{\n  "verdict": "reject",\n  "issues": ["RAW_HEAD_ALPHA"],\n  "detail": "${'q'.repeat(700)}RAW_TAIL_OMEGA"\n}`
  const { fetch } = scriptedFetch([textAnswer(raw)])
  const world = makeWorld(fetch)

  const message = await gateError(world)

  expect(message, 'the start of the raw answer is in the error').toContain('RAW_HEAD_ALPHA')
  expect(message, 'only the first 500 characters of the raw answer').not.toContain('RAW_TAIL_OMEGA')
})

// --- [log] -----------------------------------------------------------------------------------------

test('test_c4_log_every_verdict_is_logged_with_the_start_of_the_summary_and_without_diff_or_key', async () => {
  const captured: string[] = []
  const sink = (message: string): void => {
    captured.push(String(message))
  }
  const grab = (chunk: unknown): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }
  vi.spyOn(process.stderr, 'write').mockImplementation(grab as typeof process.stderr.write)
  vi.spyOn(process.stdout, 'write').mockImplementation(grab as typeof process.stdout.write)
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      captured.push(args.map(String).join(' '))
    })
  }

  const approvedSummary = `APPROVED_SUMMARY_HEAD ${'x'.repeat(800)} APPROVED_SUMMARY_TAIL`
  const { fetch } = scriptedFetch([
    textAnswer('{"verdict":"reject","summary":"REJECTED_SUMMARY_HEAD needs work"}'),
    textAnswer(JSON.stringify({ verdict: 'approve', summary: approvedSummary })),
  ])
  const world = makeWorld(fetch, sink)

  const outcome = await submitCandidate(world, 'DIFF_LINE_ONLY_IN_THE_DIFF_7c1e\n')
  expect(outcome).toContain('прошёл гейт')

  const log = captured.join('\n')
  const lines = log.split('\n')
  const rejected = lines.find((line) => line.includes('REJECTED_SUMMARY_HEAD'))
  const approved = lines.find((line) => line.includes('APPROVED_SUMMARY_HEAD'))
  expect(rejected, 'the rejection is logged').toBeDefined()
  expect(approved, 'the approval is logged').toBeDefined()
  expect(rejected).toMatch(/approved\W{0,3}false/i)
  expect(approved).toMatch(/approved\W{0,3}true/i)
  expect(log, 'the summary is cut to its first 500 characters').not.toContain('APPROVED_SUMMARY_TAIL')
  expect(log, 'the diff is not logged').not.toContain('DIFF_LINE_ONLY_IN_THE_DIFF_7c1e')
  expect(log, 'the API key is not logged').not.toContain(API_KEY)
  expect(readFileSync(join(root, 'home', 'app', 'notes.md'), 'utf8'), 'live is untouched').toBe('original notes\n')
})
