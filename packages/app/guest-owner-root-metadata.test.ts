// The guest exec profile and definition in isolation: owner roots are never
// mounted or advertised. The daemon red-team of the same behaviour is
// packages/app/guest-owner-isolation.test.ts; this file pins the two rules the
// profile builder and the tool definition own by themselves.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { createExecTools, GUEST_EXEC_DEFINITION, guestSandboxProfile, type ExecTools } from '../tools-exec/src/index.js'

const SECRET_NAME = 'FICTIONAL_OWNER_VAULT_NAME_6157'
const SECRET_VALUE = 'fictional-value-6157'

let scratch = ''
let ownerExec: ExecTools | undefined
let guestExec: ExecTools | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dshbot-guest-metadata-'))
})

afterEach(async () => {
  if (ownerExec !== undefined) await ownerExec.stop()
  if (guestExec !== undefined) await guestExec.stop()
  ownerExec = undefined
  guestExec = undefined
  rmSync(scratch, { recursive: true, force: true })
})

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

test('owner roots under HOME and DSHBOT_HOME are never ro-binds in the guest profile, and HOME is always masked', () => {
  const ownerHome = join(scratch, 'home')
  const stateHome = join(scratch, 'state')
  const roPath = join(ownerHome, '.local', 'bin')
  const stateToolchain = join(stateHome, 'private-toolchain')
  mkdirSync(roPath, { recursive: true })
  mkdirSync(stateToolchain, { recursive: true })
  writeFileSync(join(roPath, 'owner-marker.txt'), 'must-not-be-mounted')
  const ownerRoots = [ownerHome, stateHome]
  const profile = guestSandboxProfile({
    roPaths: [roPath, stateToolchain],
    masks: ownerRoots,
    ownerRoots,
  })

  for (let at = 0; at < profile.indexOf('--'); at += 1) {
    if (profile[at] !== '--ro-bind') continue
    for (const path of [profile[at + 1]!, profile[at + 2]!]) {
      for (const root of ownerRoots) expect(within(path, root), `${path} is not mounted from ${root}`).toBe(false)
    }
  }
  const masks = profile.flatMap((arg, index) => (arg === '--tmpfs' ? [profile[index + 1]] : []))
  for (const root of ownerRoots) expect(masks, `${root} is masked`).toContain(root)
})

test('the guest exec definition names no owner vault entry, while the owner definition still does', async () => {
  const workspace = join(scratch, 'workspace')
  const ownerHome = join(scratch, 'home')
  mkdirSync(workspace)
  mkdirSync(ownerHome)
  ownerExec = await createExecTools({
    workspace,
    home: ownerHome,
    secrets: {
      get: (name) => (name === SECRET_NAME ? SECRET_VALUE : undefined),
      names: () => [SECRET_NAME],
      known: () => [{ name: SECRET_NAME, value: SECRET_VALUE }],
    },
  })
  guestExec = await createExecTools({ workspace, home: ownerHome, guest: true })
  const ownerTool = ownerExec.tools.find((tool) => tool.name === 'exec')!
  const guestTool = guestExec.tools.find((tool) => tool.name === 'exec')!

  expect(ownerTool.description, 'the owner keeps the vault names').toContain(SECRET_NAME)
  expect(JSON.stringify(guestTool.description), 'the guest runtime names no vault entry').not.toContain(SECRET_NAME)
  const definition = guestTool.guest ?? GUEST_EXEC_DEFINITION
  const text = `${definition.description}\n${JSON.stringify(definition.inputSchema)}`
  expect(text).not.toContain(SECRET_NAME)
  expect(text).not.toContain(SECRET_VALUE)
  expect(text).not.toContain('DSHBOT_HOME')
  expect(text, 'no owner roPath or state path').not.toContain(ownerHome)
  const properties = (definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
  expect(Object.keys(properties), 'the owner-only arguments are not offered').not.toContain('secrets')
  expect(Object.keys(properties)).not.toContain('background')
})
