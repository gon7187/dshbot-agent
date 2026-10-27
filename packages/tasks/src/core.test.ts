import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// Модуль задач лежит рядом с тестом; грузим его динамически, чтобы отсутствие API
// проваливало тест на проверке, а не на импорте.
const entry = fileURLToPath(new URL('./index.ts', import.meta.url))

type TaskState = 'queued' | 'running' | 'verifying' | 'done' | 'waiting_owner' | 'blocked' | 'paused'
type TaskEvent =
  | 'start'
  | 'complete'
  | 'verify_passed'
  | 'verify_failed'
  | 'escalate'
  | 'owner_reply'
  | 'block'
  | 'pause'
  | 'resume'

interface Acceptance {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  tail: string
  refused?: string
}

interface SandboxCall {
  command: string
  timeoutMs: number
}

interface SandboxResult {
  exitCode: number | null
  timedOut: boolean
  output: string
}

interface AcceptanceSandbox {
  run(command: string, timeoutMs: number): Promise<SandboxResult>
}

interface Verdict {
  verdict: string
  reason: string
}

type JudgeAction = 'continue_task' | 'finish' | 'block' | 'wait' | 'pause_task'

interface JudgeTracker {
  record(verdict: Verdict | null): JudgeAction
}

interface TasksApi {
  transition(state: TaskState, event: TaskEvent): TaskState
  runAcceptance(options: {
    command: string
    timeoutMs?: number
    sandbox?: AcceptanceSandbox
  }): Promise<Acceptance>
  parseVerdict(text: string): Verdict | null
  createJudgeTracker(options: { maxParseFailures: number }): JudgeTracker
}

const allEvents: TaskEvent[] = [
  'start',
  'complete',
  'verify_passed',
  'verify_failed',
  'escalate',
  'owner_reply',
  'block',
  'pause',
  'resume',
]

async function loadTasks(): Promise<TasksApi> {
  const loaded: unknown = await import(entry).catch((error: unknown) => error)
  expect(loaded, 'packages/tasks/src/index.ts должен экспортировать API задач').not.toBeInstanceOf(Error)
  return loaded as TasksApi
}

/** A sandbox double: remembers the call and answers with the preset result. */
function fakeSandbox(result: SandboxResult | ((command: string) => SandboxResult)): AcceptanceSandbox & {
  calls: SandboxCall[]
} {
  const calls: SandboxCall[] = []
  return {
    calls,
    async run(command: string, timeoutMs: number): Promise<SandboxResult> {
      calls.push({ command, timeoutMs })
      return typeof result === 'function' ? result(command) : result
    },
  }
}

test('test_c1_start_complete_verify_passed_reaches_done', async () => {
  const tasks = await loadTasks()
  let state = tasks.transition('queued', 'start')
  state = tasks.transition(state, 'complete')
  state = tasks.transition(state, 'verify_passed')
  expect(state).toBe('done')
})

test('test_c1_start_complete_verify_failed_returns_to_running', async () => {
  const tasks = await loadTasks()
  let state = tasks.transition('queued', 'start')
  state = tasks.transition(state, 'complete')
  state = tasks.transition(state, 'verify_failed')
  expect(state).toBe('running')
})

test('test_c2_escalate_moves_running_to_waiting_owner_and_owner_reply_back', async () => {
  const tasks = await loadTasks()
  const waiting = tasks.transition('running', 'escalate')
  expect(waiting).toBe('waiting_owner')
  expect(tasks.transition(waiting, 'owner_reply')).toBe('running')
})

test('test_c2_block_moves_running_to_blocked', async () => {
  const tasks = await loadTasks()
  expect(tasks.transition('running', 'block')).toBe('blocked')
})

test('test_c3_pause_from_queued_running_verifying_and_waiting_owner_gives_paused', async () => {
  const tasks = await loadTasks()
  const sources: TaskState[] = ['queued', 'running', 'verifying', 'waiting_owner']
  for (const source of sources) {
    expect(tasks.transition(source, 'pause'), `pause из ${source}`).toBe('paused')
  }
})

test('test_c3_resume_from_paused_gives_running', async () => {
  const tasks = await loadTasks()
  expect(tasks.transition('paused', 'resume')).toBe('running')
})

test('test_c4_invalid_transitions_throw', async () => {
  const tasks = await loadTasks()
  expect(() => tasks.transition('queued', 'complete')).toThrow()
  expect(() => tasks.transition('running', 'verify_passed')).toThrow()
  for (const terminal of ['done', 'blocked'] as const) {
    for (const event of allEvents) {
      expect(() => tasks.transition(terminal, event), `${event} из ${terminal}`).toThrow()
    }
  }
})

test('test_c5_runAcceptance_exit_0_is_ok_and_exit_3_is_not', async () => {
  const tasks = await loadTasks()
  const passed = await tasks.runAcceptance({
    command: 'exit 0',
    sandbox: fakeSandbox({ exitCode: 0, timedOut: false, output: '' }),
  })
  expect(passed.ok).toBe(true)
  expect(passed.exitCode).toBe(0)

  const failed = await tasks.runAcceptance({
    command: 'exit 3',
    sandbox: fakeSandbox({ exitCode: 3, timedOut: false, output: '' }),
  })
  expect(failed.ok).toBe(false)
  expect(failed.exitCode).toBe(3)
})

test('test_c6_runAcceptance_hands_the_command_and_timeout_to_the_sandbox', async () => {
  const tasks = await loadTasks()
  const sandbox = fakeSandbox({ exitCode: 0, timedOut: false, output: 'from the sandbox\n' })
  const result = await tasks.runAcceptance({ command: 'pwd', timeoutMs: 12_345, sandbox })
  expect(sandbox.calls).toEqual([{ command: 'pwd', timeoutMs: 12_345 }])
  expect(result.tail).toContain('from the sandbox')
})

test('test_c7_tail_keeps_last_3000_chars_of_the_sandbox_output', async () => {
  const tasks = await loadTasks()
  const long = await tasks.runAcceptance({
    command: 'generate output',
    sandbox: fakeSandbox({ exitCode: 0, timedOut: false, output: `${'a'.repeat(10_000)}END` }),
  })
  expect(long.tail.length).toBe(3000)
  expect(long.tail).toBe(`${'a'.repeat(2997)}END`)

  const stderr = await tasks.runAcceptance({
    command: 'print to stderr',
    sandbox: fakeSandbox({ exitCode: 0, timedOut: false, output: 'oops-on-stderr\n' }),
  })
  expect(stderr.tail).toContain('oops-on-stderr')
})

test('test_c8_timeout_is_not_a_success', async () => {
  const tasks = await loadTasks()
  const result = await tasks.runAcceptance({
    command: 'sleep forever',
    timeoutMs: 300,
    sandbox: fakeSandbox({ exitCode: null, timedOut: true, output: 'killed' }),
  })
  expect(result.timedOut).toBe(true)
  expect(result.ok).toBe(false)
})

test('test_c8b_confirm_class_acceptance_is_refused_before_the_sandbox', async () => {
  const tasks = await loadTasks()
  const sandbox = fakeSandbox({ exitCode: 0, timedOut: false, output: 'RAN' })
  const result = await tasks.runAcceptance({ command: 'rm -rf /tmp/doomed', sandbox })
  expect(sandbox.calls, 'the confirm-class command never reaches the sandbox').toEqual([])
  expect(result.ok).toBe(false)
  expect(result.refused).toBe('confirm')
  expect(result.tail).toContain('требует подтверждения владельца')
  expect(result.tail).toContain('неразрушающ')
})

test('test_c8c_acceptance_without_a_sandbox_is_refused_not_run_on_the_host', async () => {
  const tasks = await loadTasks()
  const result = await tasks.runAcceptance({ command: 'printf RAN' })
  expect(result.ok).toBe(false)
  expect(result.refused).toBe('missing-sandbox')
  expect(result.tail).toContain('песочница exec недоступна')
})

test('test_c9_parseVerdict_reads_plain_fenced_and_surrounded_json', async () => {
  const tasks = await loadTasks()
  const plain = tasks.parseVerdict('{"verdict": "continue", "reason": "осталось проверить тесты"}')
  expect(plain).toMatchObject({ verdict: 'continue', reason: 'осталось проверить тесты' })

  const fenced = tasks.parseVerdict('```json\n{"verdict": "done", "reason": "приёмка пройдена"}\n```')
  expect(fenced).toMatchObject({ verdict: 'done', reason: 'приёмка пройдена' })

  const surrounded = tasks.parseVerdict('Мой вердикт: {"verdict": "wait", "reason": "нужен владелец"} Спасибо.')
  expect(surrounded).toMatchObject({ verdict: 'wait', reason: 'нужен владелец' })
})

test('test_c10_parseVerdict_returns_null_for_invalid_answers', async () => {
  const tasks = await loadTasks()
  expect(tasks.parseVerdict('это не JSON {verdict: done')).toBeNull()
  expect(tasks.parseVerdict('{"verdict": "maybe", "reason": "не знаю"}')).toBeNull()
  expect(tasks.parseVerdict('{"reason": "нет поля verdict"}')).toBeNull()
})

test('test_c11_tracker_pauses_on_third_consecutive_parse_failure', async () => {
  const tasks = await loadTasks()
  const tracker = tasks.createJudgeTracker({ maxParseFailures: 3 })
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('pause_task')
})

test('test_c11_valid_verdict_resets_parse_failure_counter', async () => {
  const tasks = await loadTasks()
  const tracker = tasks.createJudgeTracker({ maxParseFailures: 3 })
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record({ verdict: 'continue', reason: 'работаем' })).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
})

test('test_c12_tracker_maps_verdicts_to_actions', async () => {
  const tasks = await loadTasks()
  const cases: [string, JudgeAction][] = [
    ['done', 'finish'],
    ['blocked', 'block'],
    ['wait', 'wait'],
    ['continue', 'continue_task'],
  ]
  for (const [verdict, action] of cases) {
    const tracker = tasks.createJudgeTracker({ maxParseFailures: 3 })
    expect(tracker.record({ verdict, reason: 'тест' }), `verdict ${verdict}`).toBe(action)
  }
})
