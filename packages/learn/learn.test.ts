// Unit tests of the learning package: the turn-kind gate of the nudge counters,
// the skill library with read-before-write and the linter, the tail index and the
// deterministic curator. The full daemon flow (DeepSeek stub, fake Telegram) is
// covered by packages/app/experience-review.test.ts.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  buildExperienceReviewPrompt,
  buildLearnPrompt,
  createCurator,
  createLearning,
  createReadTracker,
  createSkillStore,
  createSkillTools,
  decodeProposalCallback,
  encodeProposalCallback,
  extractSkillDocument,
  NUDGE_SKILL_ITERATIONS,
  REVIEW_MAX_ITERATIONS,
  REVIEW_TOOL_NAMES,
  SKILL_PROPOSAL_TOOL_NAME,
  SKILLS_ARCHIVE_DIR,
  type KvStore,
  type SkillProposal,
  type TurnKind,
  validateSkillDocument,
} from './src/index.js'
import type { RunnerTool } from '../runner/src/index.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MEMORY_COUNTER_KEY = 'learn.owner_turns_since_memory_review'
const SKILLS_COUNTER_KEY = 'learn.tool_iterations_since_skills_review'

function memoryKv(): { kv: KvStore; map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    kv: {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value)
      },
    },
  }
}

function skillMd(name: string, description: string, extra = 'Step one of the procedure.'): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    '## Procedure',
    '',
    `1. ${extra}`,
    '',
    '## Pitfalls',
    '',
    '- Do not skip the check.',
    '',
    '## Verification',
    '',
    '- Run the check and read its output.',
    '',
  ].join('\n')
}

function toolNamed(tools: readonly RunnerTool[], name: string): RunnerTool {
  const found = tools.find((tool) => tool.name === name)
  expect(found, `tool ${name}`).toBeDefined()
  return found as RunnerTool
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-learn-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('nudge counters', () => {
  test('test_skip_scheduled_turns_keep_stored_counters_and_send_no_deepseek_review_until_tenth_owner_turn', async () => {
    const { startRunner } = await import('../runner/src/index.js')
    const requests: Record<string, unknown>[] = []
    const stub = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      const event = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        event('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_scheduled_review',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        event('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Nothing to save.' },
        }),
        event('content_block_stop', { type: 'content_block_stop', index: 0 }),
        event('message_delta', {
          type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 },
        }),
        event('message_stop', { type: 'message_stop' }),
      ].join(''))
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const { kv } = memoryKv()
    kv.set(MEMORY_COUNTER_KEY, '0')
    // Nonzero skill progress also catches an accidental reset by scheduled work.
    kv.set(SKILLS_COUNTER_KEY, '3')
    const initialCounters = [kv.get(MEMORY_COUNTER_KEY), kv.get(SKILLS_COUNTER_KEY)]
    let now = 1_000_000_000
    const failures: string[] = []
    vi.stubEnv('DSH_HOME', join(home, 'dsh'))
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-scheduled-review-key')
    const learning = createLearning({
      home,
      kv,
      now: () => now,
      log: (message) => failures.push(message),
      launchReview: async (prompt) => {
        const runner = await startRunner({
          dshHome: join(home, 'dsh'),
          cwd: home,
          baseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/anthropic`,
          apiKey: 'test-scheduled-review-key',
          systemPrefix: 'DSHBOT scheduled-turn regression',
          tools: [
            ...learning.reviewTools(),
            { name: 'read', description: 'Read a file', execute: () => '' },
          ],
          maxTurnIterations: REVIEW_MAX_ITERATIONS,
        })
        try {
          await runner.prompt(prompt, { sessionId: 'experience-review-scheduled-test', tools: REVIEW_TOOL_NAMES })
        } finally {
          await runner.stop()
        }
      },
    })

    try {
      // The same accounting and post-delivery review seam is used for every kind.
      const deliverTurn = async (kind: TurnKind, iterations: number): Promise<void> => {
        now += 60_000
        const outcome = learning.noteTurn(kind, iterations)
        if (outcome.review) learning.startReview({ userText: `${kind} at ${now}`, reply: 'delivered' })
        await learning.stop()
        expect(failures).toEqual([])
      }
      for (let turn = 1; turn <= 12; turn += 1) {
        await deliverTurn('scheduled', turn % 2 === 0 ? 40 : 0)
        expect([kv.get(MEMORY_COUNTER_KEY), kv.get(SKILLS_COUNTER_KEY)]).toEqual(initialCounters)
        expect(requests).toHaveLength(0)
      }

      for (let turn = 1; turn <= 10; turn += 1) {
        await deliverTurn('owner', 0)
        expect(requests, `DeepSeek requests after owner turn ${turn}`).toHaveLength(turn === 10 ? 1 : 0)
        expect(kv.get(MEMORY_COUNTER_KEY)).toBe(String(turn % 10))
        expect(kv.get(SKILLS_COUNTER_KEY)).toBe('3')
      }
      expect(requests[0]?.model).toBe('deepseek-flash')
    } finally {
      await learning.stop()
      vi.unstubAllEnvs()
      stub.closeAllConnections()
      await new Promise<void>((resolve, reject) => stub.close((error) => error ? reject(error) : resolve()))
    }
  }, 30_000)

  test('twelve tool iterations of owner turns ask for a skill review', async () => {
    const { kv } = memoryKv()
    const learning = createLearning({ home, kv, now: () => Date.now(), launchReview: () => undefined })
    let due = false
    for (let i = 0; i < NUDGE_SKILL_ITERATIONS; i += 1) due = learning.noteTurn('owner', 1).review
    expect(due).toBe(true)
  })
})

describe('skill library', () => {
  const storeOf = (): ReturnType<typeof createSkillStore> => createSkillStore({ home, now: () => 5_000 })

  test('create validates the document before the directory appears', () => {
    const store = storeOf()
    const longDescription = 'This description is deliberately much longer than sixty characters in total'
    expect(longDescription.length).toBeGreaterThan(60)
    expect(() => store.create('long-desc', skillMd('long-desc', longDescription))).toThrow(/60/)
    expect(existsSync(join(home, 'skills', 'long-desc'))).toBe(false)

    const noVerification = skillMd('no-verify', 'Skill without the last section').split('## Verification')[0] as string
    expect(() => store.create('no-verify', noVerification)).toThrow(/Verification/)
    expect(existsSync(join(home, 'skills', 'no-verify'))).toBe(false)

    store.create('good-skill', skillMd('good-skill', 'A valid skill that passes the linter'))
    const file = join(home, 'skills', 'good-skill', 'SKILL.md')
    expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: good-skill\ndescription: A valid skill that passes the linter\n---/)
  })

  test('read-before-write is per review: patch needs skill_view first', async () => {
    const store = storeOf()
    store.create('seed-skill', skillMd('seed-skill', 'A seeded skill', 'OLD-STEP-MARK to be replaced.'))
    const tools = createSkillTools(store, createReadTracker())
    const manage = toolNamed(tools, 'skill_manage')
    const view = toolNamed(tools, 'skill_view')
    const file = join(home, 'skills', 'seed-skill', 'SKILL.md')
    const before = readFileSync(file, 'utf8')

    expect(() =>
      manage.execute({ action: 'patch', name: 'seed-skill', old_string: 'OLD-STEP-MARK', new_string: 'NEW' }),
    ).toThrow(/read-before-write/)
    expect(readFileSync(file, 'utf8')).toBe(before)

    await view.execute({ name: 'seed-skill' })
    await manage.execute({ action: 'patch', name: 'seed-skill', old_string: 'OLD-STEP-MARK', new_string: 'NEW-STEP-MARK' })
    expect(readFileSync(file, 'utf8')).toContain('NEW-STEP-MARK')

    // A second review starts with an empty tracker: reading in the first one does
    // not carry over.
    const nextReview = createSkillTools(store, createReadTracker())
    expect(() =>
      toolNamed(nextReview, 'skill_manage').execute({
        action: 'patch',
        name: 'seed-skill',
        old_string: 'NEW-STEP-MARK',
        new_string: 'OLDER',
      }),
    ).toThrow(/read-before-write/)
  })

  test('the owner tool creates, updates and deletes its own skill while a shipped one stays read-only', () => {
    const builtinDir = join(home, 'builtin')
    mkdirSync(join(builtinDir, 'shipped-skill'), { recursive: true })
    writeFileSync(join(builtinDir, 'shipped-skill', 'SKILL.md'), skillMd('shipped-skill', 'A skill shipped with the daemon'))
    const store = createSkillStore({ home, now: () => 5_000, builtinDir })
    const tools = createSkillTools(store, createReadTracker(), {
      readBeforeWrite: false,
      allowDelete: true,
      ownerCatalog: true,
    })
    const manage = toolNamed(tools, 'skill_manage')
    expect(store.indexLines()).toContain('- shipped-skill — A skill shipped with the daemon')

    manage.execute({ action: 'create', name: 'owner-made', content: skillMd('owner-made', 'Made by the owner tool') })
    expect(store.indexLines()).toContain('- owner-made — Made by the owner tool')
    manage.execute({
      action: 'patch',
      name: 'owner-made',
      old_string: 'Made by the owner tool',
      new_string: 'Updated by the owner tool',
    })
    expect(store.indexLines()).toContain('- owner-made — Updated by the owner tool')

    manage.execute({ action: 'delete', name: 'owner-made' })
    expect(existsSync(join(home, 'skills', 'owner-made'))).toBe(false)
    expect(() => manage.execute({ action: 'delete', name: 'shipped-skill' })).toThrow(/встроенный/)
    expect(existsSync(join(home, 'skills', 'shipped-skill', 'SKILL.md'))).toBe(true)
  })

  test('the owner tool refuses an unsafe name and a document without frontmatter', () => {
    const store = createSkillStore({ home, now: () => 5_000 })
    const tools = createSkillTools(store, createReadTracker(), { readBeforeWrite: false, allowDelete: true })
    const manage = toolNamed(tools, 'skill_manage')
    expect(() => manage.execute({ action: 'create', name: '../escaped', content: skillMd('x', 'Escapes') })).toThrow()
    expect(() => manage.execute({ action: 'create', name: 'plain', content: '# no frontmatter' })).toThrow()
    expect(existsSync(join(home, 'skills', 'escaped'))).toBe(false)
    expect(existsSync(join(home, 'skills', 'plain'))).toBe(false)
  })

  test('the tail index lists name and description and is empty without skills', () => {
    const { kv } = memoryKv()
    const learning = createLearning({ home, kv, now: () => Date.now(), launchReview: () => undefined })
    expect(learning.skillsIndex()).toBe('')

    createSkillStore({ home, now: () => Date.now() }).create(
      'tail-probe-skill',
      skillMd('tail-probe-skill', 'Check the tail probe before shipping'),
    )
    const index = learning.skillsIndex()
    expect(index).toContain('- tail-probe-skill — Check the tail probe before shipping')
    expect(buildExperienceReviewPrompt({ userText: 'u', reply: 'r' })).not.toContain('tail-probe-skill')
  })

  test('the cached index follows a created, changed and removed SKILL.md', () => {
    const store = createSkillStore({ home, now: () => 5_000 })
    store.create('cached-alpha', skillMd('cached-alpha', 'Alpha first description'))
    expect(store.indexLines()).toEqual(['- cached-alpha — Alpha first description'])

    // An unchanged document is served from the cache; only its file time moved.
    const alpha = join(home, 'skills', 'cached-alpha', 'SKILL.md')
    const later = new Date(Date.now() + 30_000)
    utimesSync(alpha, later, later)
    expect(store.indexLines()).toEqual(['- cached-alpha — Alpha first description'])

    // A rewrite of the same size is still another text and rides at once.
    store.patch('cached-alpha', 'Alpha first description', 'Alpha other description')
    expect(store.indexLines()).toEqual(['- cached-alpha — Alpha other description'])

    store.create('cached-beta', skillMd('cached-beta', 'Beta description'))
    expect(store.indexLines()).toEqual([
      '- cached-alpha — Alpha other description',
      '- cached-beta — Beta description',
    ])

    store.remove('cached-alpha')
    expect(store.indexLines()).toEqual(['- cached-beta — Beta description'])
  })
})

describe('curator', () => {
  test('archives a skill unused for 30 fake days and marks stale at 14, without a model', () => {
    const { kv } = memoryKv()
    let now = 1_700_000_000_000
    const store = createSkillStore({ home, now: () => now })
    store.create('curated-note', skillMd('curated-note', 'A note the curator will archive'))
    const curator = createCurator({ store, kv, now: () => now })

    curator.touch(now)
    now += 20 * DAY_MS
    const stale = curator.runIfDue()
    expect(stale.ran).toBe(true)
    expect(stale.archived).toEqual([])
    expect(stale.stale).toContain('curated-note')
    expect(existsSync(join(home, 'skills', 'curated-note', 'SKILL.md'))).toBe(true)

    now += 11 * DAY_MS
    const archived = curator.runIfDue()
    expect(archived.archived).toContain('curated-note')
    expect(existsSync(join(home, 'skills', 'curated-note', 'SKILL.md'))).toBe(false)
    const archive = join(home, 'skills', SKILLS_ARCHIVE_DIR)
    expect(readdirSync(archive)).toContain('curated-note')
  })

  test('a fresh skill is not archived on the first pass', () => {
    const { kv } = memoryKv()
    let now = 1_700_000_000_000
    const store = createSkillStore({ home, now: () => now })
    store.create('fresh-skill', skillMd('fresh-skill', 'Just created'))
    const curator = createCurator({ store, kv, now: () => now })
    curator.touch(now - 3 * 60 * 60 * 1000)
    expect(curator.runIfDue().archived).toEqual([])
    expect(existsSync(join(home, 'skills', 'fresh-skill', 'SKILL.md'))).toBe(true)
  })
})

describe('skill proposals', () => {
  const proposed = (name: string): string => skillMd(name, `Черновик ${name}`)

  test('a draft waits for Apply: it is listed but absent from the library until the owner decides', async () => {
    const { kv } = memoryKv()
    const cards: SkillProposal[] = []
    const learning = createLearning({
      home,
      kv,
      now: () => 5_000,
      launchReview: () => undefined,
      proposalChatId: () => 42,
      onProposal: (proposal) => {
        cards.push(proposal)
      },
    })

    const proposal = await learning.proposeSkill({ content: proposed('owner-learn'), chatId: 42, source: 'learn' })
    expect(cards.map((card) => card.id)).toEqual([proposal.id])
    expect(existsSync(join(home, 'skills', 'owner-learn', 'SKILL.md')), 'a draft is not a skill').toBe(false)
    expect(learning.proposalListText()).toContain('owner-learn')

    const applied = learning.decideProposal(proposal.id, 'apply')
    expect(applied.ok).toBe(true)
    expect(readFileSync(join(home, 'skills', 'owner-learn', 'SKILL.md'), 'utf8')).toContain('## Procedure')
    expect(learning.proposalListText()).not.toContain('owner-learn')

    // A repeated press is terminal: a skill removed by hand is not brought back.
    rmSync(join(home, 'skills', 'owner-learn'), { recursive: true, force: true })
    expect(learning.decideProposal(proposal.id, 'apply').ok).toBe(false)
    expect(existsSync(join(home, 'skills', 'owner-learn', 'SKILL.md'))).toBe(false)
  })

  test('Reject drops the draft and a repeated press of either button changes nothing', async () => {
    const { kv } = memoryKv()
    const learning = createLearning({ home, kv, now: () => 5_000, launchReview: () => undefined })
    const proposal = await learning.proposeSkill({ content: proposed('owner-reject'), chatId: 42, source: 'tool' })

    expect(learning.decideProposal(proposal.id, 'reject').ok).toBe(true)
    expect(learning.decideProposal(proposal.id, 'apply').ok).toBe(false)
    expect(learning.decideProposal(proposal.id, 'reject').ok).toBe(false)
    expect(existsSync(join(home, 'skills', 'owner-reject', 'SKILL.md'))).toBe(false)
    expect(learning.proposalListText()).not.toContain('owner-reject')
  })

  test('the proposal tool creates the same draft and never writes the library itself', async () => {
    const { kv } = memoryKv()
    const cards: SkillProposal[] = []
    const learning = createLearning({
      home,
      kv,
      now: () => 5_000,
      launchReview: () => undefined,
      proposalChatId: () => 42,
      onProposal: (proposal) => {
        cards.push(proposal)
      },
    })
    const tool = toolNamed(learning.mainTools(), SKILL_PROPOSAL_TOOL_NAME)
    const result = await tool.execute({
      name: 'tool-offered',
      description: 'Предложен моделью',
      content: proposed('tool-offered'),
    })
    expect(String(result)).toContain('Применить')
    expect(cards).toHaveLength(1)
    expect(existsSync(join(home, 'skills', 'tool-offered', 'SKILL.md'))).toBe(false)
    expect(learning.proposalListText()).toContain('tool-offered')
  })

  test('callback data names one draft and round-trips only its own prefix', () => {
    expect(decodeProposalCallback(encodeProposalCallback('apply', 'abc123'))).toEqual({
      decision: 'apply',
      id: 'abc123',
    })
    expect(decodeProposalCallback(encodeProposalCallback('reject', 'abc123'))).toEqual({
      decision: 'reject',
      id: 'abc123',
    })
    expect(decodeProposalCallback('tga1:e:a:exec-1')).toBeUndefined()
    expect(decodeProposalCallback('lp1:x:abc')).toBeUndefined()
  })

  test('the drafts prompt carries the conversation and parses a fenced SKILL.md', () => {
    const prompt = buildLearnPrompt('релиз по пятницам', [
      { role: 'user', text: 'turn-lc-1 расскажи про релиз' },
      { role: 'assistant', text: 'выкатываем в пятницу' },
    ])
    expect(prompt).toContain('релиз по пятницам')
    expect(prompt).toContain('turn-lc-1')
    const document = extractSkillDocument(`Вот черновик:\n\n\`\`\`markdown\n${proposed('fenced-skill')}\`\`\`\n`)
    expect(document).toContain('name: fenced-skill')
    expect(extractSkillDocument('без документа')).toBeUndefined()
  })

  test('a SKILL.md answer keeps its body after the frontmatter, plain and fenced', () => {
    const withCode = skillMd('body-skill', 'Черновик с кодом', 'Run:\n\n```bash\nnpm test\n```\n\n2. Read the output.')
    const answers = {
      plain: `Вот черновик:\n\n${withCode}`,
      fenced: `Вот черновик:\n\n\`\`\`markdown\n${withCode}\`\`\`\n\nПримените, если подходит.`,
      crlf: `\`\`\`md\r\n${withCode.replace(/\n/g, '\r\n')}\`\`\``,
    }
    for (const [kind, answer] of Object.entries(answers)) {
      const document = extractSkillDocument(answer)
      expect(document, kind).toBeDefined()
      for (const part of ['## Procedure', '```bash', '2. Read the output.', '## Pitfalls', '## Verification']) {
        expect(document, `${kind}: ${part}`).toContain(part)
      }
      expect(document, kind).not.toContain('Примените')
      expect(document, kind).not.toContain('Вот черновик')
      expect(() => validateSkillDocument('body-skill', document as string), kind).not.toThrow()
    }
    expect(extractSkillDocument('---\nname: open-frontmatter\n')).toBeUndefined()
  })
})

// A copy of a skill from ~/.agents/skills has no metadata; the curator must age
// it by the file time instead of archiving it as if it were decades old.
test('a skill without metadata is aged by its file time', () => {
  mkdirSync(join(home, 'skills', 'copied-skill'), { recursive: true })
  writeFileSync(join(home, 'skills', 'copied-skill', 'SKILL.md'), skillMd('copied-skill', 'Copied from agents'))
  const now = Date.now()
  const store = createSkillStore({ home, now: () => now })
  const curator = createCurator({ store, kv: memoryKv().kv, now: () => now })
  expect(curator.runIfDue().archived).toEqual([])
  expect(existsSync(join(home, 'skills', 'copied-skill', 'SKILL.md'))).toBe(true)
})

describe('imported skill frontmatter is read as YAML', () => {
  function installImported(name: string, frontmatter: readonly string[], body = 'Free-form body without the strict sections.\n'): string {
    const base = join(home, 'skills', name)
    mkdirSync(base, { recursive: true })
    const content = ['---', ...frontmatter, '---', '', body].join('\n')
    writeFileSync(join(base, 'SKILL.md'), content)
    writeFileSync(join(base, '.meta.json'), JSON.stringify({ imported: true, createdAt: 1, lastUsedAt: 1 }))
    return content
  }

  async function view(name: string, secretNames: readonly string[] = []): Promise<string> {
    const store = createSkillStore({ home })
    const tools = createSkillTools(store, createReadTracker(), { secretNames: () => secretNames })
    return String(await toolNamed(tools, 'skill_view').execute({ name }))
  }

  test('test_imported_comment_after_name_and_folded_description_are_indexed_and_viewed', async () => {
    const description = 'я'.repeat(400)
    const content = installImported('wb-report', [
      'name: wb-report # report skill',
      'description: >',
      `  ${description.slice(0, 200)}`,
      `  ${description.slice(200)}`,
      '# a comment line of the frontmatter',
    ])
    installImported('wb-literal', ["name: 'wb-literal'", 'description: |', '  first line', '  second line'])
    installImported('wb-quoted', ['name: "wb-quoted" # q', 'description: "quoted # not a comment', '  continued"'])
    const store = createSkillStore({ home })
    const lines = store.indexLines()
    expect(lines).toContain(`- wb-report — ${'я'.repeat(60)}`)
    expect(lines).toContain('- wb-literal — first line second line')
    expect(lines).toContain('- wb-quoted — quoted # not a comment continued')
    expect(await view('wb-report')).toContain(content.trimEnd())
  })

  test('test_imported_strict_reader_does_not_accept_the_yaml_forms', () => {
    const document = ['---', 'name: wb-report # report skill', `description: ${'я'.repeat(400)}`, '---', '', 'Body.', ''].join('\n')
    expect(() => validateSkillDocument('wb-report', document)).toThrow()
  })

  test('test_imported_one_line_flow_metadata_reports_missing_commands', async () => {
    installImported('flow-bins', [
      'name: flow-bins',
      'description: Flow bins',
      'metadata: {"openclaw": {"requires": {"bins": ["nosuchbin-xyz", "sh"]}}}',
    ])
    installImported('flow-hermes', [
      'name: flow-hermes',
      'description: Flow Hermes',
      'prerequisites: {commands: [nosuchbin-xyz], env_vars: []}',
    ])
    installImported('flow-multiline', [
      'name: flow-multiline',
      'description: Multi-line flow',
      'metadata:',
      '  {',
      '    "openclaw":',
      '      {',
      '        "emoji": "📦",',
      '        "requires": { "bins": ["nosuchbin-xyz"] }, # a comment',
      '        "install": [{ "id": "brew", "kind": "brew" }],',
      '      },',
      '  }',
    ])
    for (const name of ['flow-bins', 'flow-hermes', 'flow-multiline']) {
      const result = await view(name)
      const missing = result.split('\n').filter((line) => line.includes('не найдено'))
      expect(missing, name).toHaveLength(1)
      expect(missing[0], name).toContain('nosuchbin-xyz')
      expect(missing[0], name).not.toMatch(/\bsh\b/)
    }
    const lines = createSkillStore({ home }).indexLines()
    expect(lines).toContain('- flow-bins — Flow bins')
    expect(lines).toContain('- flow-hermes — Flow Hermes')
    expect(lines).toContain('- flow-multiline — Multi-line flow')
  })

  test('test_imported_any_bins_reports_each_missing_command_even_when_one_exists', async () => {
    installImported('any-mixed', [
      'name: any-mixed',
      'description: Any bins mixed',
      'metadata:',
      '  openclaw:',
      '    requires:',
      '      anyBins: [nosuchbin-xyz, sh, nosuchbin-abc]',
    ])
    const result = await view('any-mixed')
    const missing = result.split('\n').filter((line) => line.includes('не найдено'))
    expect(missing).toHaveLength(2)
    expect(missing.some((line) => line.includes('nosuchbin-xyz'))).toBe(true)
    expect(missing.some((line) => line.includes('nosuchbin-abc'))).toBe(true)
    expect(missing.every((line) => !/\bsh\b/.test(line))).toBe(true)
    expect(createSkillStore({ home }).indexLines()).toContain('- any-mixed — Any bins mixed')
  })

  test('test_imported_flow_env_forms_name_secrets_and_mark_presence', async () => {
    installImported('flow-env', [
      'name: flow-env',
      'description: Flow env',
      'metadata: {"openclaw": {"requires": {"env": ["WB_API_TOKEN", "NO_SUCH_KEY"]}, "primaryEnv": "WB_API_TOKEN"}}',
    ])
    installImported('flow-required', [
      'name: flow-required',
      'description: Flow required',
      'required_environment_variables: [WB_API_TOKEN, "NO_SUCH_KEY"]',
    ])
    installImported('flow-env-vars', [
      'name: flow-env-vars',
      'description: Flow env vars',
      "prerequisites: {env_vars: ['WB_API_TOKEN', NO_SUCH_KEY]}",
    ])
    for (const name of ['flow-env', 'flow-required', 'flow-env-vars']) {
      const result = await view(name, ['WB_API_TOKEN'])
      const present = result.split('\n').filter((line) => line.includes('WB_API_TOKEN') && line.includes('secrets') && line.includes('exec'))
      const absent = result.split('\n').filter((line) => line.includes('NO_SUCH_KEY') && line.includes('secrets') && line.includes('exec'))
      expect(present, name).toHaveLength(1)
      expect(absent, name).toHaveLength(1)
      expect(present[0], name).toContain('есть в хранилище секретов')
      expect(absent[0], name).toContain('нет в хранилище секретов')
    }
  })
})
