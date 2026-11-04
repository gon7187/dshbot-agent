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

test('test_c4_invalid_transitions_throw', async () => {
  const tasks = await loadTasks()
  for (const [from, event, to] of [['queued','start','running'], ['running','complete','verifying'], ['verifying','verify_passed','done'], ['verifying','verify_failed','running'], ['running','escalate','waiting_owner'], ['waiting_owner','owner_reply','running'], ['running','pause','paused'], ['paused','resume','running']] as const) {
    expect(tasks.transition(from, event)).toBe(to)
  }
  expect(() => tasks.transition('queued', 'complete')).toThrow()
  expect(() => tasks.transition('running', 'verify_passed')).toThrow()
  for (const terminal of ['done', 'blocked'] as const) {
    for (const event of allEvents) {
      expect(() => tasks.transition(terminal, event), `${event} из ${terminal}`).toThrow()
    }
  }
})

test('test_c8c_acceptance_without_a_sandbox_is_refused_not_run_on_the_host', async () => {
  const tasks = await loadTasks()
  const result = await tasks.runAcceptance({ command: 'printf RAN' })
  expect(result.ok).toBe(false)
  expect(result.refused).toBe('missing-sandbox')
  expect(result.tail).toContain('песочница exec недоступна')
  const guarded = fakeSandbox({ exitCode: 0, timedOut: false, output: 'must not run' })
  expect((await tasks.runAcceptance({ command: 'rm -rf build', sandbox: guarded })).refused).toBe('confirm')
  expect(guarded.calls).toEqual([])
  for (const outcome of [{ exitCode: 0, timedOut: false, output: 'ok' }, { exitCode: 3, timedOut: false, output: 'failed' }, { exitCode: 0, timedOut: true, output: 'timeout' }]) {
    const sandbox = fakeSandbox(outcome)
    expect((await tasks.runAcceptance({ command: 'pwd', timeoutMs: 1234, sandbox })).ok).toBe(outcome.exitCode === 0 && !outcome.timedOut)
    expect(sandbox.calls).toEqual([{ command: 'pwd', timeoutMs: 1234 }])
  }
})

test('test_c10_parseVerdict_returns_null_for_invalid_answers', async () => {
  const tasks = await loadTasks()
  expect(tasks.parseVerdict('это не JSON {verdict: done')).toBeNull()
  expect(tasks.parseVerdict('{"verdict": "maybe", "reason": "не знаю"}')).toBeNull()
  expect(tasks.parseVerdict('{"reason": "нет поля verdict"}')).toBeNull()
  expect(tasks.parseVerdict('```json\n{"verdict":"done","reason":"checked"}\n```')).toMatchObject({ verdict: 'done', reason: 'checked' })
})

test('test_c11_tracker_pauses_on_third_consecutive_parse_failure', async () => {
  const tasks = await loadTasks()
  const tracker = tasks.createJudgeTracker({ maxParseFailures: 3 })
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('pause_task')
  expect(tracker.record({ verdict: 'continue', reason: 'valid' })).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
  expect(tracker.record(null)).toBe('continue_task')
  for (const [verdict, action] of [['done','finish'], ['blocked','block'], ['wait','wait']] as const) {
    expect(tracker.record({ verdict, reason: 'checked' })).toBe(action)
  }
})
