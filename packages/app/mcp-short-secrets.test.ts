// Regression for transport errors quoting credentials shorter than four characters.
// The locked daemon suite covers normal awareness; this seam makes both transports
// fail with their credentials in the error without starting a daemon or a server.
import { Client } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'

import { createMcpTools } from '../tools-mcp/src/index.js'
import { formatMcpReport, mcpAwarenessText, mcpStatusLine } from './src/mcp-awareness.js'

test.each([
  { env: 'X7q', header: 'H9z' },
  { env: 'X7', header: 'H9' },
  // Punctuation cannot accidentally occur in mkdtemp's alphanumeric suffix,
  // unlike a one-letter credential that could also occur in the report path.
  { env: '!', header: '~' },
  { env: 'X7q', header: 'X7' },
])('short credentials $env / $header stay out of all MCP awareness surfaces', async ({ env, header }) => {
  const home = mkdtempSync(join(tmpdir(), 'dshbot-mcp-short-'))
  const configPath = join(home, 'mcp.json')
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      local: { command: process.execPath, env: { TOKEN: env, EMPTY: '' } },
      remote: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: header, 'X-Empty': '' } },
    },
  }))
  const rawError = `Rejected credentials: env=${env}, header=${header}`
  // Positive control: the foreign error really contains both secrets.
  expect(rawError).toContain(env)
  expect(rawError).toContain(header)
  const connect = vi.spyOn(Client.prototype, 'connect').mockRejectedValue(new Error(rawError))
  const journal: string[] = []
  const mcp = createMcpTools({ home, log: (line) => journal.push(line) })
  try {
    await mcp.ready()
    expect(connect).toHaveBeenCalledTimes(2)
    const states = mcp.status()
    expect(states.map(({ state }) => state)).toEqual(['failed', 'failed'])
    expect(mcp.problems()).toEqual([])
    const prompt = mcpAwarenessText(states)
    const report = formatMcpReport(states, mcp.problems(), configPath)
    const status = mcpStatusLine(states, mcp.problems())
    expect(prompt).toContain('local (stdio)')
    expect(prompt).toContain('remote (http)')
    expect(prompt).toContain('ошибка:')
    expect(report).toContain(configPath)
    expect(status).toBe('MCP: 2 сервера, 0 инструментов, 2 с ошибкой')
    expect(journal).toHaveLength(2)
    expect(journal.every((line) => line.includes('не подключён'))).toBe(true)
    for (const [surface, text] of Object.entries({
      journal: journal.join('\n'),
      state: JSON.stringify(states),
      prompt,
      '/mcp': report,
      '/status': status,
    })) {
      expect(text, `${surface} must hide the env credential`).not.toContain(env)
      expect(text, `${surface} must hide the header credential`).not.toContain(header)
    }
  } finally {
    await mcp.stop()
    connect.mockRestore()
    rmSync(home, { recursive: true, force: true })
  }
})
