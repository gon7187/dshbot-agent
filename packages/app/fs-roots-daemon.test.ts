import { expect, test } from 'vitest'

import { spawn, type ChildProcess } from 'node:child_process'

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import type { AddressInfo } from 'node:net'

import { tmpdir } from 'node:os'

import { delimiter, dirname, join } from 'node:path'

import { fileURLToPath } from 'node:url'

import type {
  Daemon,
  DsEvent,
  Event,
  FakeTelegram,
  Holder,
  JsonObject,
  Outcome,
  QueuedUpdate,
  Stub,
  TgEvent,
  Timeline,
  ToolCall,
  ToolResult,
  World,
} from './test-support/fs-roots-daemon-harness.js'

import {
  BOT_TOKEN,
  DEEPSEEK_KEY,
  FAILURE_WORDS,
  GUEST_CHAT,
  LONG_POLL_HOLD_MS,
  MIB,
  OWNER_CHAT,
  READ_ONLY_WORDS,
  TEST_TIMEOUT_MS,
  WAIT_MS,
  admitGuest,
  asObject,
  ask,
  callsMentioning,
  closeServer,
  codeLike,
  createIt,
  declareRoots,
  deepStrings,
  editIt,
  expectOk,
  expectReadOnlyRefusal,
  expectRefused,
  flatten,
  flushQueue,
  fsRootsFile,
  grepIt,
  lastToolResult,
  listIt,
  makeRoot,
  makeScratch,
  markerOf,
  messageEnd,
  messageStart,
  nextMessageId,
  okResult,
  output,
  pairOwner,
  pairingCandidates,
  parseObject,
  pongMessage,
  pongStream,
  pongsTo,
  privateMessage,
  put,
  q,
  readBody,
  readIt,
  repoRoot,
  runIt,
  runTool,
  say,
  scratch,
  sentTo,
  sleep,
  slurp,
  spawnDaemon,
  sse,
  startDaemon,
  startOwnerDaemon,
  startScript,
  startStub,
  startTelegram,
  textsSince,
  toolNames,
  toolSchemas,
  toolUseStream,
  updateCounter,
  useTool,
  userTexts,
  waitFor,
  world,
  writeBytes,
  writeText,
} from './test-support/fs-roots-daemon-harness.js'

test('test_c1_ro_root_is_readable_but_edit_and_write_are_refused_and_a_root_without_mode_is_ro', { timeout: TEST_TIMEOUT_MS }, async () => {
  const explicit = makeRoot('ro')
  const bare = makeRoot('bare')
  put(join(explicit, 'a.txt'), 'RO-ALPHA-MARKER-1\nsecond line\n')
  put(join(bare, 'p.txt'), 'BARE-BETA-MARKER-2\nsecond line\n')
  declareRoots([{ path: explicit, mode: 'ro' }, { path: bare }])
  const d = await startOwnerDaemon()

  for (const [root, name, marker] of [
    [explicit, 'a.txt', 'RO-ALPHA-MARKER-1'],
    [bare, 'p.txt', 'BARE-BETA-MARKER-2'],
  ] as const) {
    const file = join(root, name)
    const read = await useTool(d, readIt(file))
    expectOk(read, `read in ${root}`)
    expect(read.text).toContain(marker)

    const listed = await useTool(d, listIt(root))
    expectOk(listed, `list of ${root}`)
    expect(listed.text, 'list shows the file of the extra root').toContain(name)

    const found = await useTool(d, grepIt(marker, root))
    expectOk(found, `grep in ${root}`)
    expect(found.text, 'grep finds the line and names the file').toContain(file)
    expect(found.text).toContain(marker)

    // the read above is the evidence an edit asks for, so the refusal is about the mode
    expectReadOnlyRefusal(await useTool(d, editIt(file, 'second', 'CHANGED')), `edit in ${root}`)
    expectReadOnlyRefusal(await useTool(d, createIt(join(root, 'new-by-edit.txt'), 'HACKED')), `edit-create in ${root}`)
    expectReadOnlyRefusal(await useTool(d, writeText(join(root, 'new-by-write.txt'), 'HACKED')), `write of a new file in ${root}`)
    expectReadOnlyRefusal(await useTool(d, writeText(file, 'HACKED')), `write over a file in ${root}`)
    expectReadOnlyRefusal(await useTool(d, writeText(file, 'HACKED', true)), `append in ${root}`)

    expect(slurp(file), `${file} is unchanged`).toBe(`${marker}\nsecond line\n`)
    expect(existsSync(join(root, 'new-by-edit.txt'))).toBe(false)
    expect(existsSync(join(root, 'new-by-write.txt'))).toBe(false)
  }
})
test('test_c3_write_creates_overwrites_writes_exact_bytes_and_appends', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rw = makeRoot('rw')
  declareRoots([{ path: rw, mode: 'rw' }])
  const d = await startOwnerDaemon()

  const text = join(rw, 't.txt')
  expectOk(await useTool(d, writeText(text, 'Привет, мир\nвторая строка\n')), 'create from text')
  expect(slurp(text), 'content is written as given').toBe('Привет, мир\nвторая строка\n')

  expectOk(await useTool(d, writeText(text, 'short')), 'overwrite from text')
  expect(slurp(text), 'the file is replaced as a whole').toBe('short')

  expectOk(await useTool(d, writeText(text, '+tail\n', true)), 'append text')
  expect(slurp(text), 'append adds to the end').toBe('short+tail\n')

  const binary = Buffer.concat([
    Buffer.from([0x00, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) % 256)),
  ])
  const bin = join(rw, 'b.bin')
  expectOk(await useTool(d, writeBytes(bin, binary)), 'create from base64')
  expect(readFileSync(bin).equals(binary), 'the binary file matches byte for byte').toBe(true)

  const more = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x80])
  expectOk(await useTool(d, writeBytes(bin, more, true)), 'append base64')
  expect(readFileSync(bin).equals(Buffer.concat([binary, more])), 'append of bytes adds exactly these bytes').toBe(true)

  expectOk(await useTool(d, writeBytes(text, binary.subarray(0, 64))), 'overwrite a text file with bytes')
  expect(readFileSync(text).equals(binary.subarray(0, 64)), 'bytes replace the whole text file').toBe(true)

  // the workspace is a read-write root of its own, and a relative path resolves against it
  expectOk(await useTool(d, writeText('rel.txt', 'in the workspace')), 'write with a relative path')
  expect(slurp(join(world.workspace, 'rel.txt'))).toBe('in the workspace')
})
test('test_c4_write_outside_roots_in_ro_in_protected_paths_and_through_symlinks_is_refused', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rw = makeRoot('rw')
  const ro = makeRoot('ro')
  const guardDir = join(world.appDir, 'packages', 'guard')
  put(join(ro, 'exists.txt'), 'ro-original')
  put(join(guardDir, 'x.ts'), 'guard-original')
  put(join(world.appDir, 'CHARTER.md'), 'charter-original')
  put(join(world.outside, 'target.txt'), 'target-original')
  put(join(world.dshbotHome, 'home-level.txt'), 'home-level-original')
  symlinkSync(join(world.outside, 'target.txt'), join(rw, 'link-file'))
  symlinkSync(world.outside, join(rw, 'link-dir'))
  symlinkSync(join(ro, 'exists.txt'), join(rw, 'link-ro'))
  symlinkSync(join(world.outside, 'not-yet.txt'), join(rw, 'dangling'))
  // a writable root that sits on a protected tree of the bot's own code
  declareRoots([{ path: rw, mode: 'rw' }, { path: ro, mode: 'ro' }, { path: guardDir, mode: 'rw' }])
  const d = await startOwnerDaemon()

  expectOk(await useTool(d, writeText(join(rw, 'control.txt'), 'control')), 'control write into the rw root')
  expect(slurp(join(rw, 'control.txt'))).toBe('control')

  expectRefused(await useTool(d, writeText(join(world.outside, 'direct.txt'), 'HACKED')), 'write outside the roots')
  expectRefused(await useTool(d, writeText(join(world.outside, 'target.txt'), 'HACKED')), 'overwrite outside the roots')
  expectRefused(await useTool(d, writeText(`${rw}/../dotdot.txt`, 'HACKED')), 'write leaving the root through ..')
  expectRefused(await useTool(d, writeText(join(world.dshbotHome, 'home-level.txt'), 'HACKED')), 'write into DSHBOT_HOME outside the roots')
  expectRefused(await useTool(d, writeText(join(world.dshbotHome, 'home-new.txt'), 'HACKED')), 'new file in DSHBOT_HOME outside the roots')

  expectReadOnlyRefusal(await useTool(d, writeText(join(ro, 'exists.txt'), 'HACKED')), 'overwrite in the ro root')
  expectReadOnlyRefusal(await useTool(d, writeText(join(ro, 'new.txt'), 'HACKED')), 'new file in the ro root')

  expectRefused(await useTool(d, writeText(join(guardDir, 'x.ts'), 'HACKED')), 'overwrite of a protected file')
  expectRefused(await useTool(d, writeText(join(guardDir, 'x.ts'), 'HACKED', true)), 'append to a protected file')
  expectRefused(await useTool(d, writeText(join(guardDir, 'new.ts'), 'HACKED')), 'new file in a protected directory')
  expectRefused(await useTool(d, writeText(join(world.appDir, 'CHARTER.md'), 'HACKED')), 'write over the charter')

  expectRefused(await useTool(d, writeText(join(rw, 'link-file'), 'HACKED')), 'write through a symlink to a file outside')
  expectRefused(await useTool(d, writeText(join(rw, 'link-file'), 'HACKED', true)), 'append through a symlink to a file outside')
  expectRefused(await useTool(d, writeText(join(rw, 'link-dir', 'new.txt'), 'HACKED')), 'new file through a symlinked directory')
  expectRefused(await useTool(d, writeText(join(rw, 'link-ro'), 'HACKED')), 'write through a symlink into the ro root')
  await useTool(d, writeText(join(rw, 'dangling'), 'HACKED'))

  expect(slurp(join(world.outside, 'target.txt')), 'the target of the symlink is unchanged').toBe('target-original')
  expect(existsSync(join(world.outside, 'direct.txt'))).toBe(false)
  expect(existsSync(join(world.outside, 'new.txt'))).toBe(false)
  expect(existsSync(join(world.outside, 'not-yet.txt')), 'a dangling link does not create its target').toBe(false)
  expect(existsSync(join(dirname(rw), 'dotdot.txt'))).toBe(false)
  expect(slurp(join(world.dshbotHome, 'home-level.txt'))).toBe('home-level-original')
  expect(existsSync(join(world.dshbotHome, 'home-new.txt'))).toBe(false)
  expect(slurp(join(ro, 'exists.txt'))).toBe('ro-original')
  expect(existsSync(join(ro, 'new.txt'))).toBe(false)
  expect(slurp(join(guardDir, 'x.ts'))).toBe('guard-original')
  expect(existsSync(join(guardDir, 'new.ts'))).toBe(false)
  expect(slurp(join(world.appDir, 'CHARTER.md'))).toBe('charter-original')
})
test('test_c6_root_equal_to_or_containing_dshbot_home_is_ro_only_and_logged', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rw = makeRoot('rw')
  put(join(world.home, 'notes.txt'), 'HOME-NOTES-MARKER-6\n')
  declareRoots([
    { path: world.home, mode: 'rw' },
    { path: world.dshbotHome, mode: 'rw' },
    { path: rw, mode: 'rw' },
  ])
  const d = await startOwnerDaemon()
  expect(d.stdout + d.stderr, 'the downgrade is written to the journal').toMatch(/fs-roots/i)

  const read = await useTool(d, readIt(join(world.home, 'notes.txt')))
  expectOk(read, 'read in the HOME root')
  expect(read.text, 'the root that contains DSHBOT_HOME is accepted as ro').toContain('HOME-NOTES-MARKER-6')

  expectReadOnlyRefusal(await useTool(d, writeText(join(world.home, 'notes.txt'), 'HACKED')), 'write over a file in the HOME root')
  expectReadOnlyRefusal(await useTool(d, writeText(join(world.home, 'new.txt'), 'HACKED')), 'new file in the HOME root')
  expectReadOnlyRefusal(await useTool(d, editIt(join(world.home, 'notes.txt'), 'MARKER', 'CHANGED')), 'edit in the HOME root')
  expectRefused(await useTool(d, writeText(join(world.dshbotHome, 'extra.txt'), 'HACKED')), 'new file in the DSHBOT_HOME root')

  // only the offending entries are downgraded: the honest rw root and the workspace still work
  expectOk(await useTool(d, writeText(join(rw, 'ok.txt'), 'rw-ok')), 'write into the honest rw root')
  expect(slurp(join(rw, 'ok.txt'))).toBe('rw-ok')
  expectOk(await useTool(d, writeText(join(world.workspace, 'ok.txt'), 'ws-ok')), 'write into the workspace')

  expect(slurp(join(world.home, 'notes.txt'))).toBe('HOME-NOTES-MARKER-6\n')
  expect(existsSync(join(world.home, 'new.txt'))).toBe(false)
  expect(existsSync(join(world.dshbotHome, 'extra.txt'))).toBe(false)
})
test('test_c6_broken_fs_roots_json_is_logged_and_the_bot_starts_with_the_default_roots', { timeout: TEST_TIMEOUT_MS }, async () => {
  mkdirSync(world.dshbotHome, { recursive: true })
  writeFileSync(fsRootsFile(), '{ this is not json')
  put(join(world.workspace, 'w.txt'), 'WS-MARKER-6\n')
  put(join(world.outside, 'o.txt'), 'OUTSIDE-6\n')
  const d = await startOwnerDaemon()

  expect(d.exited, `the daemon keeps running\n${output(d)}`).toBe(false)
  expect(d.stdout + d.stderr, 'the broken file is written to the journal').toMatch(/fs-roots/i)

  const read = await useTool(d, readIt(join(world.workspace, 'w.txt')))
  expectOk(read, 'read in the workspace')
  expect(read.text).toContain('WS-MARKER-6')
  expectRefused(await useTool(d, readIt(join(world.outside, 'o.txt'))), 'read outside the default roots', 'OUTSIDE-6')
  expectOk(await useTool(d, writeText(join(world.workspace, 'new.txt'), 'ws-ok')), 'write into the workspace')
})
test('test_h1_write_is_not_in_the_tools_of_the_first_owner_request_and_comes_through_tool_search', { timeout: TEST_TIMEOUT_MS }, async () => {
  const rw = makeRoot('rw')
  declareRoots([{ path: rw, mode: 'rw' }])
  const d = await startOwnerDaemon()
  await ask(d, 'owner-schema-probe-xyz', OWNER_CHAT)

  const probe = callsMentioning(world.timeline, 'owner-schema-probe-xyz')
  expect(probe.length).toBeGreaterThan(0)
  const names = toolNames((probe[0] as DsEvent).body)
  expect(names, 'the core tools stay in the prefix').toContain('read')
  expect(names, 'the prefix carries tool_search').toContain('tool_search')
  expect(names, 'write is not in tools[] of the first request').not.toContain('write')

  const { outcome } = await runTool(d, writeText(join(rw, 'lazy.txt'), 'lazy'))
  expect(outcome?.missing, 'tool_search brings write into the turn').toBeUndefined()
  expect(outcome?.searches, 'write was loaded through tool_search').toBeGreaterThan(0)
  expect(slurp(join(rw, 'lazy.txt'))).toBe('lazy')
})
