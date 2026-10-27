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

test('test_h1_for_and_select_without_in_start_the_body_at_do', () => {
  expectVerdict(['for f do gh repo create x --public; done', 'select a do gh repo create x --public; done'], 'deny')
  expectVerdict(['for f do rm -rf x; done', 'select a do rm -rf x; done', 'for f\ndo rm -rf x; done'], 'confirm')
  expectVerdict(['for f do echo $f; done'], 'allow')
})

test('test_h1_brace_body_of_a_bash_loop_starts_after_the_header', () => {
  expectVerdict(['for f in a; { rm -rf x; }', 'for f in a b; {\n rm -rf x\n}', 'for ((i=0;i<1;i++)) { rm -rf x; }'], 'confirm')
  expectVerdict(
    ['select a in b; { gh repo create x --public; }', 'for ((i=0;i<1;i++)) { gh repo create x --public; }'],
    'deny',
  )
  expectVerdict(['for f in a b; { echo $f; }'], 'allow')
})

test('test_h1_pipeline_continued_on_the_next_line_keeps_the_pipe_into_a_shell', () => {
  expectVerdict(
    [
      'echo "rm -rf x" |\n sh',
      'echo x |\n  bash',
      'echo x | # comment\n sh',
      'echo x |\n# comment\n  bash',
      'echo x |\n\n  sh',
      'echo "rm -rf x" |&\n sh',
      'echo x |& # comment\n bash',
      'if true; then echo x |\n sh; fi',
    ],
    'confirm',
  )
  expectVerdict(['echo x |\n cat', 'echo x | # comment\n wc -l', 'echo x |&\n cat'], 'allow')
})

test('test_h1_unreadable_header_tail_is_never_swallowed_silently', () => {
  expectVerdict(
    [
      'for f in a; rm -rf x',
      'for f in a b\nrm -rf x',
      'select a in b; rm -rf x',
      'case a rm -rf x',
      'case a; rm -rf x; esac',
      'for f in a; echo hi; rm -rf x; done',
    ],
    'confirm',
  )
})
