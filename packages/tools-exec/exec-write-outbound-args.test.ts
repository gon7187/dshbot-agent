// [h1.5] The outbound rules of the daemon (canary, vault values; the private-fragment rule does not
// apply to the local exec tools) read the arguments of the exec tools whole. `exec_write` writes
// `text` to the job's stdin; a `command` field the schema does not name must not hide that text from
// the check, and neither may any other extra field of exec, exec_write or host_exec.

import { expect, test } from 'vitest'

import { outgoingStrings } from '../app/src/index.js'

const FRAGMENT = 'PrivateMemoryFragment_0123456789_abcdefghi'

test('test_h1_exec_write_text_is_checked_even_beside_an_extra_command_field', () => {
  const strings = outgoingStrings('exec_write', { id: 'job-1', command: 'echo public', text: FRAGMENT })
  expect(strings).toContain(FRAGMENT)
  expect(strings).toContain('echo public')
})

test('test_h1_exec_tools_check_every_nested_extra_argument', () => {
  for (const name of ['exec', 'exec_write', 'host_exec']) {
    const strings = outgoingStrings(name, { command: 'echo public', extra: [{ nested: FRAGMENT }], [FRAGMENT]: 1 })
    expect(strings, name).toContain(FRAGMENT)
    expect(strings!.filter((value) => value === FRAGMENT), `${name}: key and value both`).toHaveLength(2)
  }
})

test('test_c8_message_and_local_tools_have_no_outgoing_arguments', () => {
  expect(outgoingStrings('message', { text: FRAGMENT })).toBeUndefined()
  expect(outgoingStrings('read', { path: FRAGMENT })).toBeUndefined()
})
