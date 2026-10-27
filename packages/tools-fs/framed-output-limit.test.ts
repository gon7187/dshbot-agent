// The runner caps every tool result with limitToolOutput. Matches of grep, the
// text of an office document and an MCP result longer than the owner's cap
// must lose data inside their frame, never its closing line. The MCP and
// office seams are those of packages/app/external-tool-data.test.ts.
import { Client } from '@modelcontextprotocol/client'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createMcpTools } from '../tools-mcp/src/index.js'
import { createOfficeTool } from '../tools-office/src/index.js'
import { limitToolOutput } from '../runner/src/index.js'
import { createFsTools } from './src/index.js'

const WORD = 'EXTERNAL_UNTRUSTED_CONTENT'
const LIMIT = 60_000
const OWNER = { sessionId: 'main', signal: new AbortController().signal }
const LONG = `head-marker\n${'x'.repeat(70_000)}\ntail-marker`
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dshbot-framed-limit-'))
  mkdirSync(join(home, 'workspace'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/** Caps `raw` as the runner does and checks that its one frame stays closed at the end. */
function expectClosedAfterCap(raw: string): void {
  expect(raw.length, 'the tool result is longer than the cap').toBeGreaterThan(LIMIT)
  const text = limitToolOutput(raw, LIMIT)
  expect(text.length).toBeLessThanOrEqual(LIMIT)
  const openings = [...text.matchAll(/^<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{32})">>>$/gm)]
  expect(openings, 'one frame survives the cap').toHaveLength(1)
  const closing = `<<<END_${WORD} id="${openings[0]![1]}">>>`
  expect(text.endsWith(`\n${closing}`), 'the closing line with the opening id ends the result').toBe(true)
  expect(text.split(WORD), 'no other boundary word').toHaveLength(3)
  expect(text).toMatch(new RegExp(`\\n…\\[вывод обрезан: показано \\d+ из ${raw.length} символов\\]\\n${closing}$`))
  expect(text, 'the start of the data is kept').toContain('head-marker')
  expect(text, 'the data after the cut is gone').not.toContain('tail-marker')
}

test('grep matches longer than the cap keep their frame closed', async () => {
  const path = join(home, 'workspace', 'lines.txt')
  writeFileSync(path, ['head-marker', ...Array.from({ length: 150 }, (_, i) => `${i} ${'y'.repeat(900)}`), 'tail-marker'].join('\n'))
  const grep = createFsTools({ home }).find((tool) => tool.name === 'grep')!
  expectClosedAfterCap(String(await grep.execute({ path, regex: '.' })))
})

test('office text and PDF pages longer than the cap keep their frame closed', async () => {
  for (const name of ['letter.docx', 'pages.pdf']) {
    const extract = vi.fn(async () =>
      name.endsWith('.pdf') ? { ok: true, pages: [{ page: 1, text: LONG }], pageCount: 1 } : { ok: true, text: LONG },
    )
    const path = join(home, 'workspace', name)
    writeFileSync(path, 'file passed to the injected extractor')
    const tool = createOfficeTool({ home, extract, ownerSessionId: 'main' })
    expectClosedAfterCap(String(await tool.execute({ action: 'read', path }, OWNER)))
    expect(extract).toHaveBeenCalledOnce()
  }
})

test('an MCP result and an MCP error longer than the cap keep their frame closed', async () => {
  writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { catalogue: { url: 'http://127.0.0.1:1/mcp' } } }))
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
  vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] })
  const call = vi.spyOn(Client.prototype, 'callTool')
  const mcp = createMcpTools({ home })
  try {
    await mcp.ready()
    const tool = mcp.tools().find((item) => item.name === 'mcp__catalogue__lookup')!
    call.mockResolvedValueOnce({ content: [{ type: 'text', text: LONG }] })
    expectClosedAfterCap(String(await tool.execute({}, OWNER)))
    call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: LONG }] })
    let error = ''
    try {
      await tool.execute({}, OWNER)
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    expect(error, 'the error stays a tool error').toMatch(/^Ошибка MCP-инструмента/)
    expectClosedAfterCap(error)
  } finally {
    await mcp.stop()
  }
})
