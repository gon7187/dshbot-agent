import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

// bash first finds the end of `$'…'` (a backslash escapes exactly one next
// character, the first unescaped apostrophe closes), and only then decodes the
// slice: `\c` takes the next character of the slice, and a trailing `\c` stays
// literal.
test.each([true, false])('test_h2_checkCommand finds the end of an ANSI-C quote before decoding \\c (sandbox=%s)', (sandbox) => {
  // \c swallows the NUL, the word is still rm
  expect(checkCommand("$'rm\\0\\c' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'confirm',
    reason: 'irreversible: recursive rm',
  })

  // trailing \c is literal: the word is `rm\c`, not rm
  // \c takes the backslash, the apostrophe after it is literal: the word is not rm
  for (const command of ["$'rm\\c' -rf /tmp/x", "$'rm\\c\\'x' -rf /tmp/x"]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'allow',
      reason: 'no restricted operation detected',
    })
  }
})
