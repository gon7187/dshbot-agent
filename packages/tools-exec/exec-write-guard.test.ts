// exec_write goes through the same guard and the same owner approval as exec: a line that checkCommand
// denies is never written to the stdin of a live job, a line that needs confirmation is written only after
// the owner allows it, and a plain line (an answer such as «y») is written without a card. The tests drive
// createExecTools against the real sandbox, with a spy as the approval; the job is `cat`, so everything that
// reached the stdin comes back in the output and the status tells what was really written.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { checkCommand } from '../guard/src/index.js'
import { createExecTools, type ExecApproval, type ExecApprovalRequest, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const DENIED = 'gh repo create foo --public'
const CONFIRMED = 'rm -rf build-dir-h1'

let workspace = ''
const created: ExecTools[] = []

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-write-guard-'))
})

afterAll(async () => {
  for (const tools of created) await tools.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function makeExec(approval: ExecApproval | undefined): Promise<ExecTools> {
  const tools = await createExecTools({ workspace, home: HOME, ...(approval === undefined ? {} : { approval }) })
  created.push(tools)
  return tools
}

async function call(tools: ExecTools, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools of exec`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

/** The answer of a call, or the message of the error it threw. */
async function answerOrError(tools: ExecTools, name: string, args: Record<string, unknown>): Promise<{ text: string; threw: boolean }> {
  try {
    return { text: await call(tools, name, args), threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

async function startJob(tools: ExecTools, command: string): Promise<string> {
  const answer = await call(tools, 'exec', { command, background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(answer)?.[1]
  expect(id, `a background start names the job id: ${answer}`).toBeDefined()
  return id as string
}

/** Name of the property of exec_write that carries the text: the string property that is not the id. */
function textProperty(tools: ExecTools): string {
  const tool = tools.tools.find((candidate) => candidate.name === 'exec_write')
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, { type?: unknown }> }
  const names = Object.entries(schema.properties ?? {})
    .filter(([name, spec]) => name !== 'id' && spec.type === 'string')
    .map(([name]) => name)
  expect(names.length, 'exec_write takes the id and a string to write').toBeGreaterThan(0)
  return names[0] as string
}

/** Wait until the status of the job shows `needle`; returns the last status. */
async function statusWith(tools: ExecTools, id: string, needle: string): Promise<string> {
  let status = ''
  const from = Date.now()
  while (Date.now() - from < 30_000) {
    status = await call(tools, 'exec_status', { id })
    if (status.includes(needle)) return status
    await sleep(150)
  }
  return status
}

function spy(decision: 'allow' | 'deny'): { approval: ExecApproval; asked: ExecApprovalRequest[] } {
  const asked: ExecApprovalRequest[] = []
  return {
    asked,
    approval: async (request) => {
      asked.push(request)
      return decision
    },
  }
}

test('the guard verdicts the tests rely on', () => {
  expect(checkCommand(DENIED).verdict).toBe('deny')
  expect(checkCommand(CONFIRMED).verdict).toBe('confirm')
  expect(checkCommand('y').verdict).toBe('allow')
})

test('test_h1_exec_write_of_a_denied_line_writes_nothing_and_returns_an_error', { timeout: 120_000 }, async () => {
  const { approval, asked } = spy('allow')
  const tools = await makeExec(approval)
  const id = await startJob(tools, 'cat')
  await sleep(500)
  const property = textProperty(tools)

  const refused = await answerOrError(tools, 'exec_write', { id, [property]: DENIED })
  expect(refused.threw || /отказ|запрещ|error|denied/i.test(refused.text), `a denied line is refused, got: ${refused.text}`).toBe(true)
  expect(refused.text, 'the refusal is not a success message').not.toMatch(/отправлена/)
  expect(asked, 'a denied line gets no approval card').toHaveLength(0)

  // a marker written after it proves the stdin was working and that the denied line never came through
  await call(tools, 'exec_write', { id, [property]: 'marker-h1-after-deny' })
  const status = await statusWith(tools, id, 'marker-h1-after-deny')
  expect(status).toContain('marker-h1-after-deny')
  expect(status, 'the denied line did not reach the stdin').not.toContain('gh repo create')
  await call(tools, 'exec_stop', { id })
})

test('test_h1_exec_write_of_a_confirm_line_without_an_approval_is_not_written', { timeout: 120_000 }, async () => {
  const tools = await makeExec(undefined)
  const id = await startJob(tools, 'cat')
  await sleep(500)
  const property = textProperty(tools)

  const refused = await answerOrError(tools, 'exec_write', { id, [property]: CONFIRMED })
  expect(refused.threw || /отказ|error|denied/i.test(refused.text), `a confirm line without approval is refused, got: ${refused.text}`).toBe(true)
  expect(refused.text).not.toMatch(/отправлена/)

  await call(tools, 'exec_write', { id, [property]: 'marker-h1-no-approval' })
  const status = await statusWith(tools, id, 'marker-h1-no-approval')
  expect(status).toContain('marker-h1-no-approval')
  expect(status, 'the confirm line did not reach the stdin').not.toContain('build-dir-h1')
  await call(tools, 'exec_stop', { id })
})

test('test_h1_exec_write_of_a_confirm_line_is_written_only_after_the_owner_allows_it', { timeout: 120_000 }, async () => {
  // the owner declines: a card is shown, nothing is written
  const declined = spy('deny')
  const strict = await makeExec(declined.approval)
  const first = await startJob(strict, 'cat')
  await sleep(500)
  const property = textProperty(strict)
  const refused = await answerOrError(strict, 'exec_write', { id: first, [property]: CONFIRMED })
  expect(refused.threw || /отказ|отклон|error|denied/i.test(refused.text), `a declined line is refused, got: ${refused.text}`).toBe(true)
  expect(declined.asked.map((request) => request.command), 'the card carries the line to be written').toEqual([CONFIRMED])
  await call(strict, 'exec_write', { id: first, [property]: 'marker-h1-declined' })
  const seen = await statusWith(strict, first, 'marker-h1-declined')
  expect(seen).toContain('marker-h1-declined')
  expect(seen, 'a declined line did not reach the stdin').not.toContain('build-dir-h1')
  await call(strict, 'exec_stop', { id: first })

  // the owner allows: the card is shown once and the line is written
  const allowed = spy('allow')
  const open = await makeExec(allowed.approval)
  const second = await startJob(open, 'cat')
  await sleep(500)
  const written = await call(open, 'exec_write', { id: second, [textProperty(open)]: CONFIRMED })
  expect(written).not.toBe('')
  expect(allowed.asked.map((request) => request.command), 'one card for the allowed line').toEqual([CONFIRMED])
  const status = await statusWith(open, second, 'build-dir-h1')
  expect(status, 'an allowed line reached the stdin').toContain(CONFIRMED)
  await call(open, 'exec_stop', { id: second })
})

test('test_h1_exec_write_of_a_plain_line_is_written_without_a_card', { timeout: 120_000 }, async () => {
  const { approval, asked } = spy('deny')
  const tools = await makeExec(approval)
  const id = await startJob(tools, 'read x; echo got:$x')
  await sleep(500)
  const written = await call(tools, 'exec_write', { id, [textProperty(tools)]: 'y' })
  expect(written).not.toBe('')
  const status = await statusWith(tools, id, 'got:y')
  expect(status, 'the answer reached the job').toContain('got:y')
  expect(asked, 'a plain line needs no approval card').toHaveLength(0)
  await call(tools, 'exec_stop', { id })
})
