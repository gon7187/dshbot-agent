// Regression cases missed by the original host write-protection tests: a successful
// shell tail must retain the refusal explanation, and mv redirections/options must
// not turn into file operands. Real bwrap verifies behavior at the filesystem boundary.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createHostExecTools, HOST_WRITE_GUARD_NOTE } from './src/host.js'

let base = ''
let botHome = ''
let temporary = ''

function outsideTmp(): string {
  for (const candidate of [process.cwd(), homedir(), '/var/tmp']) {
    try {
      const parent = realpathSync(candidate)
      if (parent === '/tmp' || parent.startsWith('/tmp/')) continue
      return mkdtempSync(join(parent, '.host-exec-local-regression-'))
    } catch {
      // The runner may allow writes only in its checkout; try the next root.
    }
  }
  throw new Error('No writable test fixture directory outside /tmp')
}

beforeEach(() => {
  vi.stubEnv('DSHBOT_HOST_WRITABLE', undefined)
  base = outsideTmp()
  botHome = join(base, 'bot')
  mkdirSync(botHome)
  temporary = mkdtempSync('/tmp/host-exec-local-regression-')
  writeFileSync(join(botHome, 'hosts.json'), JSON.stringify({ box: { local: true } }))
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (base !== '') rmSync(base, { recursive: true, force: true })
  if (temporary !== '') rmSync(temporary, { recursive: true, force: true })
  base = ''
  temporary = ''
})

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

async function run(command: string): Promise<string> {
  const tool = createHostExecTools({ home: botHome, secrets: [], timeoutMs: 10_000, approval: async () => 'allow' }).tools[0]
  if (tool === undefined) throw new Error('host_exec missing')
  return String(await tool.execute({ host: 'box', command }, { signal: new AbortController().signal }))
}

test.each(['; true', '|| true'])('explains a refused write even when the shell ends successfully: %s', async (tail) => {
  const file = join(base, 'precious.txt')
  writeFileSync(file, 'keep me\n')
  const answer = await run(`rm -f ${quote(file)} ${tail}`)
  expect(answer).toMatch(/^exit 0\b/)
  expect(answer).toContain(HOST_WRITE_GUARD_NOTE)
  expect(readFileSync(file, 'utf8')).toBe('keep me\n')
})

test.each(['Read-only file system', 'Permission denied', 'Operation not permitted', 'EROFS', 'EACCES', 'EPERM'])(
  'retains the policy explanation for a successful subprocess with stderr diagnostic: %s',
  async (diagnostic) => {
    // Simulate subprocess diagnostics independent of the host's locale and permissions.
    const bin = join(temporary, 'bin')
    mkdirSync(bin)
    const bwrap = join(bin, 'bwrap')
    writeFileSync(bwrap, `#!/bin/sh\nprintf '%s\\n' ${quote(diagnostic)} >&2\nexit 0\n`)
    chmodSync(bwrap, 0o755)
    vi.stubEnv('PATH', [bin, process.env.PATH ?? '/usr/bin:/bin'].join(delimiter))
    const answer = await run('true')
    expect(answer).toMatch(/^exit 0\b/)
    expect(answer).toContain(HOST_WRITE_GUARD_NOTE)
  },
)

test('a successful read does not acquire a write-refusal explanation from stdout', async () => {
  const file = join(base, 'readable.txt')
  writeFileSync(file, 'Permission denied is just file content\n')
  const answer = await run(`cat ${quote(file)}`)
  expect(answer).toMatch(/^exit 0\b/)
  expect(answer).toContain('Permission denied is just file content')
  expect(answer).not.toContain(HOST_WRITE_GUARD_NOTE)
})

const directoryOptions = ['-t ', '-t', '--target-directory=', '--target-directory '] as const
test.each(['mv', 'cp'].flatMap((program) => directoryOptions.map((option) => ({ program, option }))))(
  '$program accepts target-directory syntax "$option" in both writable roots',
  async ({ program, option }) => {
    for (const root of [botHome, temporary]) {
      const source = join(root, 'source.txt')
      const target = join(root, 'target directory')
      writeFileSync(source, 'payload\n')
      mkdirSync(target)
      const answer = await run(`${program} ${option}${quote(target)} ${quote(source)}`)
      expect(answer).toMatch(/^exit 0\b/)
      expect(readFileSync(join(target, 'source.txt'), 'utf8')).toBe('payload\n')
      expect(existsSync(source)).toBe(program === 'cp')
    }
  },
)

test.each([
  '2>/dev/null', '>/dev/null', '2>&1', '&>LOG', '&>>LOG',
  '2> /dev/null', '> /dev/null', '2>>LOG', '1>|LOG',
  '</dev/null', '0</dev/null', '3<>LOG', '0<&0', '2>&-',
])('mv treats %s as a shell redirection rather than a file operand', async (syntax) => {
  const source = join(temporary, 'source.txt')
  const target = join(temporary, 'target.txt')
  writeFileSync(source, 'payload\n')
  const redirection = syntax.replace('LOG', quote(join(temporary, 'output.log')))
  const answer = await run(`mv ${quote(source)} ${quote(target)} ${redirection}`)
  expect(answer).toMatch(/^exit 0\b/)
  expect(existsSync(source)).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe('payload\n')
})

test.each([
  '2>/dev/null mv SOURCE TARGET',
  'mv SOURCE 2>/dev/null TARGET',
  'mv -- SOURCE TARGET 2>/dev/null',
  'cd ROOT 2>/dev/null && mv source.txt target.txt 2>/dev/null',
])('redirections are removed regardless of position: %s', async (syntax) => {
  const source = join(botHome, 'source.txt')
  const target = join(botHome, 'target.txt')
  writeFileSync(source, 'payload\n')
  const command = syntax.replace('SOURCE', quote(source)).replace('TARGET', quote(target)).replace('ROOT', quote(botHome))
  expect(await run(command)).toMatch(/^exit 0\b/)
  expect(existsSync(source)).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe('payload\n')
})

test('quoted numeric operands and literal redirect characters remain filenames', async () => {
  writeFileSync(join(botHome, '2'), 'payload\n')
  const command = `cd ${quote(botHome)} && mv '2'>output.log 'name>with&operators'`
  expect(await run(command)).toMatch(/^exit 0\b/)
  expect(existsSync(join(botHome, '2'))).toBe(false)
  expect(readFileSync(join(botHome, 'name>with&operators'), 'utf8')).toBe('payload\n')
})

test('the redirection target remains read-only even when mv operands are writable', async () => {
  const source = join(botHome, 'source.txt')
  const target = join(botHome, 'target.txt')
  const outside = join(base, 'precious.txt')
  writeFileSync(source, 'payload\n')
  writeFileSync(outside, 'keep me\n')
  const answer = await run(`mv ${quote(source)} ${quote(target)} 2>${quote(outside)}; true`)
  expect(answer).toMatch(/^exit 0\b/)
  expect(answer).toContain(HOST_WRITE_GUARD_NOTE)
  expect(readFileSync(outside, 'utf8')).toBe('keep me\n')
  expect(readFileSync(source, 'utf8')).toBe('payload\n')
  expect(existsSync(target)).toBe(false)
})

test('target-directory options still refuse an outside mv target', async () => {
  const source = join(botHome, 'source.txt')
  writeFileSync(source, 'payload\n')
  for (const option of directoryOptions) {
    await expect(run(`mv ${option}${quote(base)} ${quote(source)} 2>/dev/null`)).rejects.toThrow(/цель.*DSHBOT_HOME/)
  }
  expect(readFileSync(source, 'utf8')).toBe('payload\n')
  expect(existsSync(join(base, 'source.txt'))).toBe(false)
})
