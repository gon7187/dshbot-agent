import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const MODES = [
  { name: 'host', options: { sandbox: false } },
  { name: 'sandbox', options: { sandbox: true } },
] as const

function expectVerdict(commands: readonly string[], verdict: 'allow' | 'confirm' | 'deny'): void {
  for (const mode of MODES) {
    for (const command of commands) {
      expect(checkCommand(command, mode.options).verdict, `${mode.name}: ${command}`).toBe(verdict)
    }
  }
}

test('test_c1_compound_commands_do_not_hide_a_destructive_command', () => {
  expectVerdict(
    [
      'if true; then rm -rf x; fi',
      'for f in a; do rm -rf $f; done',
      'while false; do git push --force; done',
      'until true; do rm -rf x; done',
      'select a in b; do rm -rf x; done',
      'case a in a) rm -rf x;; esac',
      '{ rm -rf x; }',
      '( rm -rf x )',
      'f() { rm -rf x; }; f',
      'true && { git push origin main; }',
      '! rm -rf x',
      'coproc rm -rf x',
    ],
    'confirm',
  )
})

test('test_c2_denied_command_stays_denied_inside_any_compound_construction', () => {
  const inner = 'gh repo create x --public'
  expectVerdict([inner], 'deny')
  expectVerdict(
    [
      `if true; then ${inner}; fi`,
      `if true; then\\\n ${inner}; fi`,
      `for f in a; do ${inner}; done`,
      `while false; do ${inner}; done`,
      `until true; do ${inner}; done`,
      `select a in b; do ${inner}; done`,
      `case a in a) ${inner};; esac`,
      `{ ${inner}; }`,
      `( ${inner} )`,
      `f() { ${inner}; }; f`,
      `true && { ${inner}; }`,
      `! ${inner}`,
      `coproc ${inner}`,
    ],
    'deny',
  )
})

test('test_c3_code_fed_to_a_shell_through_stdin_needs_confirmation', () => {
  expectVerdict(
    [
      'echo "rm -rf x" | sh',
      'printf %s x | bash',
      'bash -s <<< "rm -rf x"',
      'cat script.sh | sh -s',
      'echo "rm -rf x" | sh | cat',
      'echo "rm -rf x" | sh; echo ok | cat',
    ],
    'confirm',
  )
})

test('test_c4_safe_compound_commands_are_allowed', () => {
  expectVerdict(
    ['if true; then echo ok; fi', 'for f in a b; do echo $f; done', '{ echo a; echo b; }', '( cd /tmp && ls )'],
    'allow',
  )
})

test('test_c6_braces_in_arguments_are_not_command_grouping', () => {
  expectVerdict(['xargs -I {} gh repo create {} --public'], 'deny')
  expectVerdict(['find . -name x -exec rm -rf {} ;'], 'confirm')
  expectVerdict(['echo {a,b}'], 'allow')
})

test('test_c7_redirection_before_or_glued_to_the_command_does_not_hide_it', () => {
  expectVerdict(['>/dev/null rm -rf x', '2>&1 rm -rf x', 'rm>out -rf x'], 'confirm')
})

test('test_c8_wrappers_do_not_soften_the_verdict', () => {
  expectVerdict(
    [
      'timeout 5 rm -rf x',
      'nice -n 5 rm -rf x',
      'ionice -c3 rm -rf x',
      'stdbuf -o0 rm -rf x',
      'setsid rm -rf x',
      'flock /tmp/l rm -rf x',
      'echo x | timeout 5 sh',
    ],
    'confirm',
  )
  expectVerdict(['timeout 5 gh repo create x --public'], 'deny')
})
