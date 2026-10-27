import { expect, test } from 'vitest'

import {
  CHILD_FORBIDDEN_TOOLS,
  createDelegateTool,
  DELEGATE_TOOL_NAME,
  SELF_REPORT_MARK,
  type DelegateRequest,
} from './src/index.js'

// The contract of the delegate tool itself: one task plus the tool subset, one
// self-reported result, the abort signal of the parent forwarded, and a stopped
// child reported as a failed call rather than as an answer.
test('delegate_sends_the_task_and_the_tool_subset_and_marks_the_result_as_a_self_report', async () => {
  const seen: DelegateRequest[] = []
  const tool = createDelegateTool({
    run: async (request) => {
      seen.push(request)
      return { text: 'KID-REPORT: notes read' }
    },
  })

  expect(tool.name).toBe(DELEGATE_TOOL_NAME)
  expect(tool.lazy).toBe(true)
  expect(tool.inputSchema).toMatchObject({
    type: 'object',
    properties: {
      task: { type: 'string' },
      tools: { type: 'array' },
      agent: { type: 'string' },
    },
    required: ['task'],
  })

  const controller = new AbortController()
  const text = await tool.execute(
    { task: 'kid-run: list the notes', tools: ['read', 'list', 'read'] },
    { signal: controller.signal, sessionId: 'main' },
  )

  expect(seen).toHaveLength(1)
  expect(seen[0]?.task).toBe('kid-run: list the notes')
  // Duplicates collapse; order follows the request.
  expect(seen[0]?.tools).toEqual(['read', 'list'])
  expect(seen[0]?.signal).toBe(controller.signal)
  // The child is bound to the session whose tool call delegated the task.
  expect(seen[0]?.parentSessionId).toBe('main')
  expect(text).toContain('KID-REPORT: notes read')
  expect(text).toContain(SELF_REPORT_MARK)
  expect(text).toMatch(/не проверенный факт|self-?report/i)
})

test('delegate_can_be_offered_immediately_and_validates_its_arguments', async () => {
  const immediate = createDelegateTool({ lazy: false, run: async () => ({ text: 'ok' }) })
  expect(immediate.lazy).toBeUndefined()

  const tool = createDelegateTool({ run: async () => ({ text: 'ok' }) })
  await expect(tool.execute({ task: '   ', tools: [] })).rejects.toThrow(/task/)
  await expect(tool.execute({ task: 'x', tools: 'read' })).rejects.toThrow(/tools/)
  await expect(tool.execute({ task: 'x', tools: ['read', 7] })).rejects.toThrow(/tools/)
})

test('delegate_reports_a_stopped_child_as_a_failed_call_not_as_a_self_report', async () => {
  const tool = createDelegateTool({ run: async () => ({ text: '', aborted: 'timeout' }) })
  await expect(tool.execute({ task: 'x', tools: [] })).rejects.toThrow(/таймауту/)
  const failed = createDelegateTool({ run: async () => ({ text: '', error: 'boom' }) })
  await expect(failed.execute({ task: 'x', tools: [] })).rejects.toThrow(/boom/)
})

test('delegate_with_an_agent_gives_the_child_only_the_profile_tools_and_instructions', async () => {
  const seen: DelegateRequest[] = []
  const tool = createDelegateTool({
    agents: {
      get: (name) =>
        name === 'mailer'
          ? {
              name: 'mailer',
              description: 'reads notes',
              tools: ['read', 'list', 'schedule'],
              instructions: 'MAILER-RULES: one line',
              model: 'deepseek-v4-pro',
            }
          : undefined,
      list: () => [
        { name: 'mailer', description: 'reads notes', tools: [], instructions: 'x', model: 'deepseek-v4-pro' },
      ],
    },
    run: async (request) => {
      seen.push(request)
      return { text: 'KID-REPORT' }
    },
  })

  // The model-supplied tools cannot widen the profile: the profile list wins.
  await tool.execute({ task: 'kid-agent: read', agent: 'mailer', tools: ['exec'] })
  expect(seen[0]?.tools).toEqual(['read', 'list', 'schedule'])
  expect(seen[0]?.agent).toBe('mailer')
  expect(seen[0]?.instructions).toContain('MAILER-RULES')
  expect(seen[0]?.model).toBe('deepseek-v4-pro')
})

test('delegate_with_an_unknown_agent_lists_the_profiles_and_starts_nothing', async () => {
  const seen: DelegateRequest[] = []
  const tool = createDelegateTool({
    agents: {
      get: () => undefined,
      list: () => [
        { name: 'mailer', description: 'reads', tools: [], instructions: 'x', model: 'deepseek-flash' },
        { name: 'wide', description: 'wide', tools: [], instructions: 'y', model: 'deepseek-flash' },
      ],
    },
    run: async (request) => {
      seen.push(request)
      return { text: 'never' }
    },
  })

  await expect(tool.execute({ task: 'kid-ghost: do it', agent: 'ghost' })).rejects.toThrow(
    /неизвестный профиль агента "ghost".*mailer, wide/s,
  )
  expect(seen).toEqual([])
})

test('delegate_never_offers_the_forbidden_child_tools', () => {
  for (const name of ['delegate', 'task', 'schedule', 'zavod', 'self_discard', 'update_identity', 'host_exec']) {
    expect(CHILD_FORBIDDEN_TOOLS).toContain(name)
  }
  expect(CHILD_FORBIDDEN_TOOLS).toContain('tool_search')
})
