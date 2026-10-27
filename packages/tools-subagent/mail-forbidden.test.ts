import { expect, test } from 'vitest'

import { CHILD_FORBIDDEN_TOOLS } from './src/index.js'

// A child of `delegate` works on a delegated task with a subset of the parent's tools. The mailboxes of the
// owner are read for the owner alone: the `mail` tool must stay out of every child, whatever the parent asks for.
test('test_c8_a_subagent_never_receives_the_mail_tool', () => {
  expect(CHILD_FORBIDDEN_TOOLS).toContain('mail')
})
