// Which tool definitions let the harness run them in parallel inside one assistant step. The harness pool takes
// a call only when its tool answers `isConcurrencySafe(args) === true`; every tool that writes, runs commands,
// sends messages, changes the bot or may ask the owner for a button must stay a barrier. The real factories run
// in-process, without a daemon and without a network: the definitions are inspected, no tool is executed.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createSkillStore, createSkillTools, createReadTracker } from '../learn/src/skills.js'
import { createRecallTool } from '../memory/src/tools.js'
import type { TelegramApi } from '../telegram/src/api.js'
import { createExecTools, type ExecTools } from '../tools-exec/src/index.js'
import { createHostExecTools } from '../tools-exec/src/host.js'
import { createFsTools } from '../tools-fs/src/index.js'
import { createWebTools } from '../tools-web/src/index.js'
import { createBotMessageRegistry, createMessageTool, createReplyButtonRegistry } from './src/message-tool.js'
import { createSessionSearchTool } from './src/session-search.js'
import { createViewImageTool } from './src/view-image.js'

interface Definition {
  name: string
  isConcurrencySafe?: (args: unknown) => boolean
}

let home = ''
let exec: ExecTools | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-concurrency-defs-'))
  mkdirSync(join(home, 'workspace'), { recursive: true })
})

afterEach(async () => {
  if (exec !== undefined) await exec.stop()
  exec = undefined
  rmSync(home, { recursive: true, force: true })
})

function definition(tools: readonly unknown[], name: string): Definition {
  const found = (tools as Definition[]).find((tool) => tool.name === name)
  expect(found, `the tool ${name} is defined`).toBeDefined()
  return found as Definition
}

/** What the harness would ask: the declaration, called with the arguments of an ordinary call. */
function safe(tool: Definition, args: unknown): boolean {
  return typeof tool.isConcurrencySafe === 'function' && tool.isConcurrencySafe(args) === true
}

test('test_c2_read_only_tools_declare_that_a_parallel_run_is_safe', () => {
  const fs = createFsTools({ home })
  const skills = createSkillTools(createSkillStore({ home }), createReadTracker(), { readBeforeWrite: false })
  const web = createWebTools({ apiKey: 'sk-test', workspace: join(home, 'workspace') })

  expect(safe(definition(fs, 'read'), { path: 'notes.txt' }), 'read').toBe(true)
  expect(safe(definition(fs, 'list'), { path: '.' }), 'list').toBe(true)
  expect(safe(definition(fs, 'grep'), { pattern: 'x', path: '.' }), 'grep').toBe(true)
  expect(safe(definition(skills, 'skills_list'), {}), 'skills_list').toBe(true)
  expect(safe(definition(skills, 'skill_view'), { name: 'any' }), 'skill_view').toBe(true)
  expect(safe(definition(web, 'web_search'), { query: 'weather' }), 'web_search').toBe(true)
})

test('test_c7_tools_that_write_run_or_need_the_owner_do_not_declare_parallel_safety', async () => {
  exec = await createExecTools({ workspace: join(home, 'workspace'), home })
  const fs = createFsTools({ home })
  const hostExec = createHostExecTools({ home }).tools
  const message = createMessageTool({
    home,
    api: {} as TelegramApi,
    ownerChatId: () => 1,
    buttons: createReplyButtonRegistry(),
    messages: createBotMessageRegistry(),
  })
  const recall = createRecallTool({} as never)
  const sessionSearch = createSessionSearchTool({} as never)
  const viewImage = createViewImageTool({
    home,
    workspace: join(home, 'workspace'),
    roots: [{ path: join(home, 'workspace') }],
  })

  const cases: Array<[Definition, unknown]> = [
    [definition([recall], 'recall'), { query: 'x' }],
    [definition([sessionSearch], 'session_search'), { query: 'x' }],
    [definition([viewImage], 'view_image'), { path: 'a.png' }],
    [definition(exec.tools, 'exec'), { command: 'ls' }],
    [definition(hostExec, 'host_exec'), { host: 'box', command: 'df' }],
    [definition(fs, 'edit'), { path: 'a.txt', old_string: 'a', new_string: 'b' }],
    [definition(fs, 'write'), { path: 'a.txt', content: 'a' }],
    [definition([message], 'message'), { action: 'send', text: 'hi' }],
  ]
  for (const [tool, args] of cases) {
    expect(safe(tool, args), `${tool.name} stays a barrier`).toBe(false)
  }
})
