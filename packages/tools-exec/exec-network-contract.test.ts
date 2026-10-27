// What the exec network must look like in the code and in the words the model reads:
//   * [shared-guard] one address-rules module and one proxy module serve exec and browser (web_fetch
//     reaches the same rules); no second copy of the private-address table remains;
//   * [honest-prompt] the description of `exec` tells the truth about the network;
//   * [guest] the exec tools stay owner-only.
// The behaviour itself (real sandbox, real curl) is in exec-network.test.ts.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createExecTools, type ExecTools } from './src/index.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const HOME = resolve(process.env.HOME ?? homedir())

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(path)
  }
  return out
}

function packageSources(name: string): string[] {
  return sourceFiles(join(repoRoot, 'packages', name, 'src'))
}

/** Every non-test source file of every package. */
function allSources(): string[] {
  return readdirSync(join(repoRoot, 'packages')).flatMap((name) => packageSources(name))
}

/** Value imports of a source file that point at repository files, as absolute paths. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const found: string[] = []
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]*)['"]/g
  for (const match of text.matchAll(pattern)) {
    if (match[2] !== undefined) continue
    const base = resolve(dirname(file), (match[3] as string).replace(/\.js$/, '.ts'))
    if (existsSync(base) && statSync(base).isFile()) found.push(base)
    else if (existsSync(join(base, 'index.ts'))) found.push(join(base, 'index.ts'))
  }
  return found
}

/** All files a package can reach: its own sources plus everything they import, transitively. */
function reach(name: string): Set<string> {
  const seen = new Set<string>()
  const queue = [...packageSources(name)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    queue.push(...importsOf(file))
  }
  return seen
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join('/')
}

const ADDRESS_TABLE = /0xfe80|0xfc00|fc00::\/7|fe80::\/10/
// An HTTP server's CONNECT handler takes (request, socket, head); a client socket's `connect` takes none.
const PROXY_CONNECT = /\.on\(\s*['"]connect['"]\s*,\s*(?:async\s*)?\(\s*\w+\s*,\s*\w+\s*,\s*\w+/

function filesMatching(pattern: RegExp): string[] {
  return allSources().filter((file) => pattern.test(readFileSync(file, 'utf8')))
}

test('test_shared_guard_one_private_address_table_used_by_exec_and_browser', () => {
  const browser = readFileSync(join(repoRoot, 'packages/tools-browser/src/index.ts'), 'utf8')
  expect(browser, 'the browser keeps no copy of the private-address functions').not.toMatch(/function\s+private(?:Address|Ipv4|Ipv6)\b/)
  for (const file of [...packageSources('tools-browser'), ...packageSources('tools-exec')]) {
    expect(readFileSync(file, 'utf8'), `${rel(file)} holds no private-address table of its own`).not.toMatch(ADDRESS_TABLE)
  }
  const tables = filesMatching(ADDRESS_TABLE)
  expect(tables.map(rel), 'the rules of the address check live in exactly one module').toHaveLength(1)
  const table = tables[0] as string
  for (const name of ['tools-exec', 'tools-browser', 'tools-web']) {
    expect(reach(name).has(table), `${name} reaches the shared address rules in ${rel(table)}`).toBe(true)
  }
})

test('test_shared_guard_one_proxy_module_serves_exec_and_browser', () => {
  const proxies = filesMatching(PROXY_CONNECT)
  expect(proxies.map(rel), 'exactly one CONNECT proxy implementation exists').toHaveLength(1)
  const proxy = proxies[0] as string
  expect(reach('tools-exec').has(proxy), `exec reaches the proxy in ${rel(proxy)}`).toBe(true)
  expect(reach('tools-browser').has(proxy), `browser reaches the proxy in ${rel(proxy)}`).toBe(true)
})

let workspace = ''
let exec: ExecTools

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dshbot-exec-contract-'))
  exec = await createExecTools({ workspace, home: HOME })
})

afterAll(async () => {
  if (exec !== undefined) await exec.stop()
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true })
})

test('test_honest_prompt_exec_description_tells_the_truth_about_the_network', () => {
  const tool = exec.tools.find((candidate) => candidate.name === 'exec')
  expect(tool, 'exec is registered').toBeDefined()
  const text = `${tool?.description ?? ''}\n${JSON.stringify(tool?.inputSchema ?? {})}`
  expect(text, 'says the public internet is reached through a proxy').toMatch(/prox|прокси/i)
  expect(text, 'says the local network and service addresses are closed').toMatch(
    /(?:local|private|loopback|link-local|metadata|\blan\b|локальн|приватн|служебн|метаданн)/i,
  )
  expect(text, 'tells the model not to route a web_fetch refusal around through exec').toMatch(/web_fetch/)
  expect(text, 'does not claim an unrestricted or absent network').not.toMatch(
    /shared network|unrestricted network|full network access|has no network|no network access|without network|нет сети|без сети|общая сеть/i,
  )
})

test('test_guest_exec_tools_are_owner_only_except_exec_itself', () => {
  expect(exec.tools.map((tool) => tool.name).sort()).toEqual([
    'exec',
    'exec_list',
    'exec_status',
    'exec_stop',
    'exec_write',
  ])
  for (const tool of exec.tools) {
    const guest = (tool as { guestAllowed?: boolean }).guestAllowed === true
    if (tool.name === 'exec') {
      // `exec` has a separate guest implementation in packages/app; the owner's
      // runtime is the one tested here and never reaches a guest.
      expect(guest, 'the owner exec runtime is not itself the guest tool').toBe(false)
    } else {
      expect(guest, `${tool.name} is not offered to a guest`).toBe(false)
    }
  }
})
