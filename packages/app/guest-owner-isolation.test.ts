// Exercise the definitions actually sent to the model and the real guest
// bwrap runtime. The preload only records argv; it never replaces execution.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'

import { SecretVault } from './src/secrets.js'
import {
  GUEST_A, GROUP_CHAT, OWNER_CHAT, SUPERGROUP_CHAT,
  asObject, clockPreload, groupMessage, joinGuest, modelCalls,
  pairOwner, pongsTo, repoRoot, say, seedOwnerFiles, startDaemon, waitFor, world,
  type Daemon, type DsEvent, type JsonObject, type ToolResultSeen,
} from './test-support/guest-redteam-harness.js'

const TIMEOUT = 170_000
const SECRET_NAME = 'OWNER_PRIVATE_ACCOUNT_CANARY_8421'
const SECRET_VALUE = 'fictional-vault-value-7193'
const layouts: string[] = []

afterAll(() => {
  for (const layout of layouts) rmSync(layout, { recursive: true, force: true })
})

const RECORD_BWRAP = String.raw`
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
for (const method of ['spawn', 'spawnSync']) {
  const original = childProcess[method]
  childProcess[method] = function(command, args, ...rest) {
    if (basename(String(command)) === 'bwrap' && Array.isArray(args)) {
      appendFileSync(process.env.GUEST_BWRAP_LOG, JSON.stringify(args) + '\n')
    }
    return original.call(this, command, args, ...rest)
  }
}
syncBuiltinESMExports()
`

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function within(path: string, root: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep))
}

async function allowGroup(d: Daemon, chatId: number): Promise<void> {
  const mark = d.stderr.length
  world.tg.push(groupMessage(chatId, chatId === SUPERGROUP_CHAT ? 'supergroup' : 'group', OWNER_CHAT, '/group_allow'))
  await waitFor('the group to be allowed', () => d.stderr.slice(mark).includes(`group ${chatId} allowed`), d)
}

async function turn(d: Daemon, chatId: number, text: string): Promise<DsEvent[]> {
  const before = world.timeline.seq
  const pongs = pongsTo(world.timeline, chatId).length
  if (chatId < 0) {
    const mention = '@dshbot_test_bot'
    const update = groupMessage(chatId, chatId === SUPERGROUP_CHAT ? 'supergroup' : 'group', GUEST_A, `${mention} ${text}`)
    asObject(update.message).entities = [{ type: 'mention', offset: 0, length: mention.length }]
    world.tg.push(update)
  } else {
    say(chatId, text)
  }
  await waitFor('the model answer to finish', () => pongsTo(world.timeline, chatId).length > pongs, d, 80_000)
  const calls = modelCalls(world.timeline).filter((call) => call.n > before)
  expect(calls.length, 'the turn must reach the runner and the model').toBeGreaterThan(0)
  return calls
}

function definitions(call: DsEvent): JsonObject[] {
  expect(Array.isArray(call.body.tools), 'the model request includes tool definitions').toBe(true)
  return (call.body.tools as unknown[]).map(asObject)
}

function execDefinition(call: DsEvent): JsonObject {
  const exec = definitions(call).find((tool) => tool.name === 'exec')
  expect(exec, 'exec must actually be offered to this principal').toBeDefined()
  return exec!
}

async function execTurn(d: Daemon, chatId: number, command: string, text: string): Promise<ToolResultSeen> {
  const sent = world.stub.sentIds.length
  world.stub.forge = [{ name: 'exec', input: { command } }]
  await turn(d, chatId, text)
  const ids = world.stub.sentIds.slice(sent)
  expect(ids, 'the model requested one real exec').toHaveLength(1)
  const result = world.stub.results.get(ids[0]!)
  expect(result, 'the exec result must return through the runner').toBeDefined()
  expect(result!.isError, result!.text).toBe(false)
  expect(result!.text).toMatch(/^exit 0\n/)
  return result!
}

test.each(['defaults', 'configured'] as const)(
  'test_c2_guest_exec_hides_owner_roPaths_and_omits_their_binds_%s',
  { timeout: TIMEOUT },
  async (mode) => {
    // The usual harness HOME is below /tmp. A guest tmpfs covers /tmp after
    // roPaths are mounted, accidentally concealing the very leak under test.
    // Keep this fixture outside /tmp, like a normal owner's /home directory.
    const layout = realpathSync(mkdtempSync(join(repoRoot, '.guest-isolation-')))
    layouts.push(layout)
    world.home = join(layout, 'home')
    world.dshbotHome = join(layout, 'state')
    world.workspace = join(world.dshbotHome, 'workspace')
    mkdirSync(world.home)
    seedOwnerFiles()
    const homeBin = join(world.home, '.local', 'bin')
    const stateBin = join(world.dshbotHome, 'private-toolchain')
    const roots = mode === 'defaults' ? [homeBin] : [homeBin, stateBin]
    const filename = 'owner-ro-path-marker-5d8a.txt'
    const marker = 'OWNER-RO-PATH-CONTENT-84e7'
    for (const root of roots) {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, filename), marker)
    }
    const log = join(world.home, 'bwrap-argv.jsonl')
    const preload = join(world.home, 'record-bwrap.mjs')
    writeFileSync(log, '')
    writeFileSync(preload, RECORD_BWRAP)
    const d = await startDaemon({
      DSHBOT_DEBOUNCE_MS: '0',
      DSHBOT_GUEST_MIN_INTERVAL_MS: '0',
      NODE_OPTIONS: `--import ${pathToFileURL(clockPreload).href} --import ${pathToFileURL(preload).href}`,
      GUEST_BWRAP_LOG: log,
      ...(mode === 'configured' ? { DSHBOT_EXEC_RO_PATHS: roots.join(delimiter) } : {}),
    })
    await pairOwner(d)
    const control = await execTurn(d, OWNER_CHAT, `cat ${quote(join(homeBin, filename))}`, `owner-ro-path-control-${mode}`)
    expect(control.text, 'the owner retains read access to its toolchain roPath').toContain(marker)
    await joinGuest(d, GUEST_A)

    const paths = roots.flatMap((root) => {
      const path = join(root, filename)
      return [path, `/proc/self/root${path}`, `/proc/1/root${path}`, `/work/../${path.slice(1)}`]
    })
    const command = [
      "printf 'guest-probe-start\\n'",
      `for file in ${paths.map(quote).join(' ')}; do if test -r "$file"; then cat "$file"; fi; done`,
      // Also find a copy exposed at any other mount point. Do not traverse proc
      // or dev, which contain synthetic aliases rather than ordinary files.
      `find / \\( -path /proc -o -path /dev \\) -prune -o -name ${quote(filename)} -print 2>/dev/null`,
      "printf 'guest-probe-finished\\n'",
    ].join('\n')
    const result = await execTurn(d, GUEST_A, command, `probe-owner-ro-paths-${mode}`)
    expect(result.text).toContain('guest-probe-start')
    expect(result.text).toContain('guest-probe-finished')
    expect.soft(result.text, 'no spelling of an owner roPath reveals its contents').not.toContain(marker)
    expect.soft(result.text, 'no alternate mount exposes the marker file').not.toContain(filename)

    const profiles = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args.some((arg, index) => arg === '--chdir' && args[index + 1] === '/work'))
    expect(profiles.length, 'the production guest bwrap profile was actually used').toBeGreaterThan(0)
    for (const profile of profiles) {
      const masks = profile.flatMap((arg, index) => arg === '--tmpfs' ? [profile[index + 1]] : [])
      expect.soft(masks, 'owner HOME is always masked in the guest profile').toContain(world.home)
      for (let at = 0; at < profile.indexOf('--'); at += 1) {
        if (profile[at] !== '--ro-bind') continue
        for (const path of [profile[at + 1]!, profile[at + 2]!]) {
          expect.soft(within(path, world.home), `guest bind under owner HOME: ${path}`).toBe(false)
          expect.soft(within(path, world.dshbotHome), `guest bind under DSHBOT_HOME: ${path}`).toBe(false)
        }
      }
    }
    for (const root of roots) expect(readFileSync(join(root, filename), 'utf8')).toBe(marker)
  },
)

test('test_c7_guest_tool_definitions_hide_owner_vault_metadata_in_private_and_group_turns', { timeout: TIMEOUT }, async () => {
  const vault = new SecretVault(world.dshbotHome)
  vault.set(SECRET_NAME, SECRET_VALUE)
  const ownerRoPath = join(world.home, '.local', 'bin')
  mkdirSync(ownerRoPath, { recursive: true })
  const d = await startDaemon({
    DSHBOT_DEBOUNCE_MS: '0',
    DSHBOT_GUEST_MIN_INTERVAL_MS: '0',
    DSHBOT_EXEC_RO_PATHS: ownerRoPath,
  })
  await pairOwner(d)
  const [ownerBefore] = await turn(d, OWNER_CHAT, 'OWNER schema before guest turns')
  const ownerExec = execDefinition(ownerBefore!)
  expect(String(ownerExec.description), 'owner still sees vault names in the exec description').toContain(SECRET_NAME)
  expect(JSON.stringify(ownerExec.input_schema), 'owner still sees vault names in the exec schema').toContain(SECRET_NAME)
  expect(ownerExec.input_schema).toMatchObject({
    type: 'object',
    properties: {
      command: { type: 'string' },
      background: { type: 'boolean' },
      secrets: { type: 'array', items: { type: 'string' } },
      timeout_sec: { type: 'number' },
    },
    required: ['command'],
  })

  await joinGuest(d, GUEST_A)
  for (const chatId of [GUEST_A, GROUP_CHAT, SUPERGROUP_CHAT]) {
    if (chatId < 0) await allowGroup(d, chatId)
    const calls = await turn(d, chatId, `guest-schema-probe-${chatId}`)
    for (const call of calls) {
      execDefinition(call)
      for (const tool of definitions(call)) {
        expect(typeof tool.description).toBe('string')
        expect(tool.input_schema).toBeDefined()
        for (const metadata of [SECRET_NAME, SECRET_VALUE, world.home, world.dshbotHome, world.workspace, ownerRoPath]) {
          expect.soft(String(tool.description), `${chatId}: ${String(tool.name)} description`).not.toContain(metadata)
          expect.soft(JSON.stringify(tool.input_schema), `${chatId}: ${String(tool.name)} inputSchema`).not.toContain(metadata)
        }
      }
    }
  }
  const [ownerAfter] = await turn(d, OWNER_CHAT, 'OWNER schema after guest turns')
  const afterExec = execDefinition(ownerAfter!)
  expect(afterExec.description, 'guest sessions must not change the owner definition').toEqual(ownerExec.description)
  expect(afterExec.input_schema, 'owner schema remains unchanged').toEqual(ownerExec.input_schema)
})
