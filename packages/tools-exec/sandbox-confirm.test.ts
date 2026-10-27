// A command that runs in the exec sandbox (bwrap: its own process space, writes only to the workspace and the
// roots of the owner) draws an approval card only when it is destructive: a syntax the guard cannot parse
// (substitutions, `python -c`, an unclosed quote, a variable in the command position) is not a reason by itself,
// and neither is kill/pkill/killall inside the sandbox. A command nested in `bash -c`, `$(…)`, backticks,
// `find -exec` or `xargs` is judged by the same rules. host_exec runs on the host, outside the sandbox, and keeps
// the old rules. The tests drive createExecTools (exec, exec_write) and createHostExecTools against the real
// sandbox, with a spy as the approval that always declines: a command that the spy saw needed a card, and a
// declined command never starts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createHostExecTools } from './src/host.js'
import { createExecTools, type ExecApprovalRequest, type ExecTools } from './src/index.js'

const HOME = resolve(process.env.HOME ?? homedir())
const TEST_TIMEOUT_MS = 240_000
/** A read-only git command, spelled out in parts. */
const GIT_READ = ['git', 'sta' + 'tus'].join(' ')

let workspace = ''
let hostHome = ''
const created: ExecTools[] = []

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-sandbox-confirm-'))
  hostHome = mkdtempSync(join(tmpdir(), 'dshbot-sandbox-confirm-host-'))
  writeFileSync(join(hostHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))
})

afterAll(async () => {
  for (const tools of created) await tools.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
  if (hostHome !== '') rmSync(hostHome, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface Spy {
  asked: ExecApprovalRequest[]
  approval: (request: ExecApprovalRequest) => Promise<'deny'>
}

function spy(): Spy {
  const asked: ExecApprovalRequest[] = []
  return {
    asked,
    approval: async (request) => {
      asked.push(request)
      return 'deny'
    },
  }
}

async function makeExec(approval: Spy['approval']): Promise<ExecTools> {
  const tools = await createExecTools({ workspace, home: HOME, approval })
  created.push(tools)
  return tools
}

async function call(tools: ExecTools['tools'], name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name)
  expect(tool, `the tool ${name} is among the tools`).toBeDefined()
  if (tool === undefined) return ''
  return String(await tool.execute(args, { signal: new AbortController().signal }))
}

/** The answer of a call, or the message of the error it threw. */
async function attempt(
  tools: Parameters<typeof call>[0],
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; threw: boolean }> {
  try {
    return { text: await call(tools, name, args), threw: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), threw: true }
  }
}

/** Name of the property of exec_write that carries the text: the string property that is not the id. */
function textProperty(tools: ExecTools): string {
  const tool = tools.tools.find((candidate) => candidate.name === 'exec_write')
  const schema = (tool?.inputSchema ?? {}) as { properties?: Record<string, { type?: unknown }> }
  const names = Object.entries(schema.properties ?? {})
    .filter(([name, property]) => name !== 'id' && property.type === 'string')
    .map(([name]) => name)
  expect(names.length, 'exec_write takes the id and a string to write').toBeGreaterThan(0)
  return names[0] as string
}

/** How a command reaches the sandbox: as the command of exec or as a line written to the stdin of a live job. */
type Route = 'exec' | 'exec_write'

interface Rig {
  spy: Spy
  tools: ExecTools
  /** Sends the command by the route; returns the cards it asked for and what the tool answered. */
  send(route: Route, command: string): Promise<{ cards: number; text: string; threw: boolean }>
}

async function makeRig(): Promise<Rig> {
  const probe = spy()
  const tools = await makeExec(probe.approval)
  const started = await call(tools.tools, 'exec', { command: 'cat', background: true })
  const id = /"id"\s*:\s*"([^"]+)"/.exec(started)?.[1]
  expect(id, `a background start names the job id: ${started}`).toBeDefined()
  await sleep(500)
  const property = textProperty(tools)
  return {
    spy: probe,
    tools,
    async send(route, command) {
      const before = probe.asked.length
      const answer =
        route === 'exec'
          ? await attempt(tools.tools, 'exec', { command })
          : await attempt(tools.tools, 'exec_write', { id, [property]: command })
      return { cards: probe.asked.length - before, ...answer }
    },
  }
}

const ROUTES: readonly Route[] = ['exec', 'exec_write']

async function expectNoCard(rig: Rig, commands: readonly string[]): Promise<void> {
  for (const route of ROUTES) {
    for (const command of commands) {
      const sent = await rig.send(route, command)
      expect(sent.cards, `${route}: no card for ${command}\n${sent.text}`).toBe(0)
    }
  }
}

async function expectCard(rig: Rig, commands: readonly string[]): Promise<void> {
  for (const route of ROUTES) {
    for (const command of commands) {
      const sent = await rig.send(route, command)
      expect(sent.cards, `${route}: a card for ${command}`).toBe(1)
      expect(sent.threw, `${route}: the declined ${command} is refused\n${sent.text}`).toBe(true)
    }
  }
}

// --- [c1] unparseable syntax alone draws no card -------------------------------------------------------------------

test('test_c1_unparseable_syntax_in_the_sandbox_runs_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  await expectNoCard(rig, [
    'python3 -c "print(1)"',
    'node -e "console.log(1)"',
    'echo $(date)',
    'echo `date`',
    'eval "ls"',
    '$SHELL --version',
    'bash -c "$CMD"',
    'echo "abc',
  ])
})

// --- [c2] a nested command is judged by the same rules ---------------------------------------------------------------

test('test_c2_a_destructive_nested_command_in_the_sandbox_draws_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  await expectCard(rig, [
    'bash -c "rm -r build"',
    'sh -c "git push origin main"',
    'echo $(rm -r build)',
    'echo `rm -r build`',
    'find . -name "*.log" -exec rm -r {} +',
    'ls | xargs rm -r',
  ])
})

test('test_c2_a_harmless_nested_command_in_the_sandbox_runs_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  await expectNoCard(rig, [
    'bash -c "ls -la"',
    `echo $(${GIT_READ})`,
    'find . -name "*.ts" -exec grep -l foo {} +',
    'ls | xargs wc -l',
  ])
})

// --- [c3] kill in the sandbox ----------------------------------------------------------------------------------------

test('test_c3_kill_pkill_and_killall_in_the_sandbox_run_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  await expectNoCard(rig, ['kill 4242', 'pkill node', 'killall python3'])
})

// --- [c4] destructive commands still ask; publication is still refused ---------------------------------------------

test('test_c4_destructive_commands_in_the_sandbox_still_draw_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  await expectCard(rig, [
    'rm -r build',
    'rm -rf build',
    'find . -name "*.tmp" -delete',
    'git push origin main',
    'git reset --hard',
    'git clean -fd',
    'psql -c "DROP TABLE users"',
    'reboot',
    'systemctl --user restart dshbot',
    'rm $TARGET',
  ])
})

test('test_c4_publication_in_the_sandbox_is_still_refused_without_a_card', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rig = await makeRig()
  for (const route of ROUTES) {
    const sent = await rig.send(route, 'gh repo create x --public')
    expect(sent.cards, `${route}: a denied command asks nobody`).toBe(0)
    expect(sent.threw, `${route}: publication is refused\n${sent.text}`).toBe(true)
  }
})

// --- [c5] host_exec keeps the old rules ----------------------------------------------------------------------------

test('test_c5_host_exec_still_draws_a_card_for_unparseable_syntax_and_kill', { timeout: TEST_TIMEOUT_MS }, async () => {
  const probe = spy()
  const host = createHostExecTools({ home: hostHome, approval: probe.approval })
  for (const command of ['python3 -c "print(1)"', 'echo $(date)', 'kill 4242']) {
    const before = probe.asked.length
    const answer = await attempt(host.tools, 'host_exec', { host: 'box', command })
    expect(probe.asked.length - before, `host_exec: a card for ${command}`).toBe(1)
    expect(answer.threw, `host_exec: the declined ${command} is refused\n${answer.text}`).toBe(true)
  }
})
