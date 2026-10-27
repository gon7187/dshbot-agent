import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const SANDBOX = { sandbox: true } as const

// Puts `inner` into backticks the way a shell needs it nested one level deeper:
// the backslash, the backtick and the dollar sign are escaped with a backslash.
function backticked(inner: string): string {
  return 'echo `' + inner.replace(/[\\`$]/g, (char) => '\\' + char) + '`'
}

function nested(inner: string, levels: number): string {
  let command = inner
  for (let level = 0; level < levels; level += 1) command = backticked(command)
  return command
}

test('test_h1_sandbox_checkCommand unescapes one level of nested backticks and judges the result', () => {
  expect(nested('rm -r build', 2)).toBe('echo `echo \\`rm -r build\\``')
  for (const levels of [1, 2, 3, 4]) {
    const command = nested('rm -r build', levels)
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
  for (const levels of [2, 3, 4]) {
    const command = nested('git push origin main', levels)
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
  // `\$` inside backticks becomes `$`: the command substitution is real after unescaping.
  const dollar = 'echo `echo \\$(rm -r build)`'
  expect(checkCommand(dollar, SANDBOX).verdict, dollar).toBe('confirm')
})

test('test_h1_sandbox_checkCommand never lowers a publication in nested escaped backticks', () => {
  for (const levels of [1, 2, 3, 4]) {
    const command = nested('gh repo create x --public', levels)
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('deny')
  }
})

test('test_h1_sandbox_checkCommand allows a harmless command in nested escaped backticks', () => {
  for (const levels of [1, 2, 3]) {
    const command = nested('ls -la src', levels)
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
})

test('test_h1_sandbox_checkCommand recognizes process substitution only outside quotes', () => {
  for (const command of ['echo "<(rm -r build)"', "echo '<(rm -r build)'", 'echo "<(rm -r build)" ">(rm -r build)"']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
  const destructive = [
    'diff <(rm -r build) out.txt',
    'tee >(rm -r build)',
    'echo "$(rm -r build)"',
    'echo "`rm -r build`"',
    'echo "<(ls)" $(rm -r build)',
  ]
  for (const command of destructive) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
})
