// Focused checks of the MCP awareness surface. The end-to-end daemon scenarios
// (tail, /mcp, /status, guests) live in the locked mcp-awareness-daemon.test.ts;
// here are the two corners that test cannot reach safely: a broken mcp.json is
// parsed before any server is known, so the scrub list of env/headers is empty,
// and the line of a server that never connected still has to carry its tool
// count.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { readMcpConfig } from '../tools-mcp/src/config.js'
import { createMcpTools } from '../tools-mcp/src/index.js'
import { formatMcpReport, mcpServerLine, mcpStatusLine } from './src/mcp-awareness.js'

const EMAIL = 'envmark-broken-a41f'
const HEADER = 'Bearer hdrmark-broken-93c2'

let scratch: string | undefined

function home(): string {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-mcp-awareness-unit-'))
  return scratch
}

afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

test('test_broken_mcp_json_keeps_env_and_headers_values_out_of_journal_report_and_status', () => {
  const dir = home()
  // Unterminated JSON with both secrets inside: the engine message may quote the
  // source, and a broken file gives no parsed servers to build a scrub list from.
  writeFileSync(
    join(dir, 'mcp.json'),
    `{"mcpServers":{"remote":{"url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"${HEADER}"},"env":{"TOKEN":"${EMAIL}"}}`,
  )

  const config = readMcpConfig(dir)
  expect(config.servers, 'a broken file starts no server').toEqual([])
  expect(config.problems.length, 'a broken file is one problem').toBe(1)
  const message = config.problems[0]?.message ?? ''
  expect(message, 'the problem keeps the shape the owner can read').toMatch(/^это не JSON: некорректный JSON/)
  // The engine text quotes the file (`Unexpected token ...`) and is a leak vector.
  expect(message, 'the raw engine message is not forwarded').not.toMatch(/Unexpected|Expected|is not valid JSON/)
  expect(message, 'no key of the file is quoted').not.toContain('headers')

  const journal: string[] = []
  const mcp = createMcpTools({ home: dir, log: (line) => journal.push(line) })
  const status = mcpStatusLine([], mcp.problems())
  const report = formatMcpReport([], mcp.problems(), join(dir, 'mcp.json'))
  expect(status, 'the status line counts the broken file as an error').toMatch(/^MCP: 0 серверов, 0 инструментов, 1 с ошибкой$/)
  expect(report, 'the report names the file and the problem').toContain('mcp.json')

  for (const [what, text] of [
    ['the problem message', message],
    ['the journal of the client', journal.join('\n')],
    ['the /mcp answer', report],
    ['the /status line', status],
  ] as const) {
    expect(text, `${what} does not print the header value`).not.toContain(HEADER)
    expect(text, `${what} does not print the env value`).not.toContain(EMAIL)
  }
})

test('test_a_server_that_never_connected_still_shows_its_transport_and_zero_tools', () => {
  const line = mcpServerLine({
    name: 'broken',
    transport: 'streamable-http',
    state: 'failed',
    tools: 0,
    toolDetails: [],
    error: 'connect ECONNREFUSED 127.0.0.1:1',
  })
  expect(line, 'the name is on the line').toContain('broken')
  expect(line, 'the transport of an http server').toMatch(/\bhttp\b/)
  expect(line, 'the number of tools is there even when it is zero').toMatch(/инструментов 0/)
  expect(line, 'the state is an error with a short text').toMatch(/ошибка: connect ECONNREFUSED/)
})
