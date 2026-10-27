import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const host = { sandbox: false }
const MODES = [
  { name: 'host', options: { sandbox: false } },
  { name: 'sandbox', options: { sandbox: true } },
] as const

test('test_c1_dollar_inside_single_quotes_is_a_literal_for_owner_mode', () => {
  const commands = [
    "awk '{print $1}' data.txt",
    "awk '{print $1, $3}' a.csv",
    "sed 's/$HOME/x/' f",
    "grep '$USER' notes.txt",
  ]
  for (const command of commands) {
    expect(checkCommand(command, host), command).toEqual({
      verdict: 'allow',
      reason: 'no restricted operation detected',
    })
  }
})

test('test_c2_dollar_that_the_shell_expands_still_asks_confirmation_in_owner_mode', () => {
  const flagPosition = [
    'chmod $FLAGS dir',
    'awk "{print $1}" f',
    "echo '$a'$B c",
  ]
  for (const command of flagPosition) {
    expect(checkCommand(command, host), command).toEqual({
      verdict: 'confirm',
      reason: 'unparseable: variable in flag position',
    })
  }
  for (const command of ['rm build $FLAGS', 'rm build "$X"']) {
    expect(checkCommand(command, host), command).toEqual({
      verdict: 'confirm',
      reason: 'unparseable: variable in the arguments of rm',
    })
  }
})

test('test_c3_single_quoted_dollar_gives_the_same_verdict_as_the_plain_word_in_both_modes', () => {
  const pairs = [
    ["rm build '$X'", 'rm build X'],
    ["find . -name '$x' -delete", 'find . -name x -delete'],
  ]
  for (const mode of MODES) {
    for (const [quoted, plain] of pairs) {
      expect(checkCommand(quoted, mode.options), `${mode.name}: ${quoted}`).toEqual(checkCommand(plain, mode.options))
    }
  }
})

test('test_h1_ansi_c_and_locale_quotes_are_expanded_before_classifying_the_word', () => {
  const commands = ["$'\\x72m' -rf /tmp/x", "$'rm' -rf /tmp/x", '$"rm" -rf /tmp/x']
  for (const mode of MODES) {
    for (const command of commands) {
      expect(checkCommand(command, mode.options), `${mode.name}: ${command}`).toEqual({
        verdict: 'confirm',
        reason: 'irreversible: recursive rm',
      })
    }
    expect(checkCommand("awk '{print $1}' data.txt", mode.options), `${mode.name}: awk`).toEqual({
      verdict: 'allow',
      reason: 'no restricted operation detected',
    })
  }
})
