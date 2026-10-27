// The guest exec profile in isolation: the daemon red-team of the same profile
// is packages/app/guest-sandbox-behavior.test.ts. This file pins the shape that
// makes the masks and the disk budget hold on every path, without a daemon.
import { spawnSync } from 'node:child_process'
import { lstatSync, readlinkSync } from 'node:fs'
import { expect, test } from 'vitest'

import {
  GUEST_DISK_BYTES,
  GUEST_MAX_OUTPUT_CHARS,
  GUEST_MAX_TIMEOUT_MS,
  GUEST_MEMORY_BYTES,
  guestSandboxProfile,
} from '../tools-exec/src/index.js'

test('the guest caps are the documented 60 s, 20000 chars, 64 MiB and 1 GiB', () => {
  expect(GUEST_MAX_TIMEOUT_MS).toBe(60_000)
  expect(GUEST_MAX_OUTPUT_CHARS).toBe(20_000)
  expect(GUEST_DISK_BYTES).toBe(64 * 1024 * 1024)
  expect(GUEST_MEMORY_BYTES).toBe(1024 * 1024 * 1024)
})

test('every writable place of the guest is a bounded tmpfs, /dev/shm included', () => {
  const profile = guestSandboxProfile({})
  for (const path of ['/work', '/home/guest', '/tmp', '/dev/shm']) {
    const at = profile.indexOf(path)
    expect(at, `${path} is mounted`).toBeGreaterThan(0)
    expect(profile[at - 3], `${path} carries the disk cap`).toBe('--size')
    expect(profile[at - 2], `${path} has the bounded size`).toBe(String(GUEST_DISK_BYTES))
    expect(profile[at - 1], `${path} is a tmpfs`).toBe('--tmpfs')
  }
})

test('a merged-usr system path is a symlink, not a second bind, and its owner mask is bounded', () => {
  const links = ['/lib', '/bin', '/sbin', '/lib64'].filter((path) => {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch {
      return false
    }
  })
  const profile = guestSandboxProfile({ masks: ['/usr/share/doc'] })
  for (const path of links) {
    expect(profile, `${path} is recreated as a symlink`).toContain(path)
    expect(profile[profile.indexOf(path) - 2], `${path} is created by --symlink`).toBe('--symlink')
    expect(profile[profile.indexOf(path) - 1], `${path} keeps its host target`).toBe(readlinkSync(path))
    expect(profile.includes('--ro-bind') && profile.join(' ').includes(`--ro-bind ${path} ${path}`)).toBe(false)
  }
  const mask = profile.indexOf('/usr/share/doc')
  expect(mask, 'an owner directory inside /usr is masked').toBeGreaterThan(0)
  expect(profile[mask - 3]).toBe('--size')
  expect(profile[mask - 2]).toBe(String(GUEST_DISK_BYTES))
  expect(profile[mask - 1]).toBe('--tmpfs')
})

test('the root, /dev and an owner mask of a real guest sandbox are read-only, the bounded tmpfs stay writable', () => {
  // The root and /dev are tmpfs mounts of bwrap itself, without a size: left
  // writable, they would let a guest fill the host's memory past the disk cap.
  const profile = guestSandboxProfile({ masks: ['/usr/share/doc'] })
  const places = ['/', '/dev', '/usr/share/doc', '/work', '/home/guest', '/tmp', '/dev/shm']
  const probe = places
    .map((path) => `if ( : > ${path.replace(/\/$/, '')}/guest-probe ) 2>/dev/null; then echo "W ${path}"; else echo "RO ${path}"; fi`)
    .join('\n')
  const overflow = `dd if=/dev/zero of=/tmp/guest-overflow.bin bs=1048576 count=65 2>/dev/null && echo TMP_LIMIT_BYPASS || echo tmp-limit-held`
  const result = spawnSync(profile[0]!, [...profile.slice(1), 'bash', '-c', `${probe}\necho hi > /dev/null && echo dev-null-ok\n${overflow}`], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  const lines = result.stdout.split('\n')
  for (const path of ['/', '/dev', '/usr/share/doc']) expect(lines, `${path} is read-only`).toContain(`RO ${path}`)
  for (const path of ['/work', '/home/guest', '/tmp', '/dev/shm']) expect(lines, `${path} is writable`).toContain(`W ${path}`)
  expect(lines, 'device nodes keep working on the read-only /dev').toContain('dev-null-ok')
  expect(lines, 'the bounded /tmp refuses 65 MiB').toContain('tmp-limit-held')
})
