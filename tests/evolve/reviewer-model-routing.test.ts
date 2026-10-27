// Same real worktree / HTTP-reviewer seam as review-verdict.test.ts. The
// sandbox result is injected: this test never runs the candidate's commands.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import { createEvolve } from '../../packages/evolve/src/index.js'
import { DEFAULT_MODEL } from '../../packages/runner/src/index.js'

test('test_c1_candidate_review_requests_flash_and_names_it_in_the_owner_card', { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-review-model-')))
  const home = join(root, 'bot')
  const live = join(home, 'app')
  const requests: Record<string, unknown>[] = []
  const cards: string[] = []
  const sandbox = vi.fn(() => ({ ok: true, status: 0, output: '' }))
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: live,
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  try {
    mkdirSync(live, { recursive: true })
    writeFileSync(join(live, 'CHECKLIST.md'), '# Checklist\n- Check the notes.\n')
    writeFileSync(join(live, 'notes.md'), 'original notes\n')
    git('init', '-q', '-b', 'live')
    git('add', '-A')
    git('commit', '-q', '-m', 'fixture')
    const fakeFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        id: 'review-fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"verdict":"approve","summary":"notes approved"}' }],
      })
    }
    const evolve = createEvolve({
      home, live, ownerHome: root, sandbox,
      review: { baseUrl: 'http://review.invalid', apiKey: 'review-test-key', fetch: fakeFetch },
      card: async (card) => { cards.push(card.text) },
    })
    const change = evolve.tools.find((tool) => tool.name === 'self_change')
    const submit = evolve.tools.find((tool) => tool.name === 'self_submit')
    expect(change).toBeDefined()
    expect(submit).toBeDefined()
    const started = String(await change!.execute({ description: 'clarify the notes' }))
    const id = /^id:\s*(\S+)/m.exec(started)?.[1]
    const candidate = /^Кандидат:\s*(.+)$/m.exec(started)?.[1]?.trim()
    expect(id, started).toBeDefined()
    expect(candidate, started).toBeDefined()
    writeFileSync(join(candidate!, 'notes.md'), 'original notes\nREVIEW-DIFF-MARKER\n')

    const result = String(await submit!.execute({ id }))

    expect(result).toContain('прошёл гейт')
    expect(sandbox).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0])).toContain('REVIEW-DIFF-MARKER')
    expect(cards).toHaveLength(1)
    expect.soft(requests[0]?.model, 'the real reviewer serializes the runner default flash model').toBe(DEFAULT_MODEL)
    expect.soft(cards[0], 'the owner sees the model actually used by the gate').toContain(`Ревью (${DEFAULT_MODEL}):`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
