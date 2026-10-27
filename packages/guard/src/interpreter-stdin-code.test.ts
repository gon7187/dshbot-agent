import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const HOST = { sandbox: false } as const
const SANDBOX = { sandbox: true } as const

const STDIN_PROGRAMS = [
  'cat x | python3',
  'echo x | node',
  'cat x | perl',
  'cat x | ruby',
  'cat x | python3 -',
  'cat x | python3 -u',
  'cat x | python3 | cat',
  'python3 <<< "import os"',
  'node < x.js',
  'python3 - < x.py',
  'python3 <<EOF\nimport os\nEOF',
]

const OPTIONS_WITH_VALUE = [
  'cat x | python3 -W ignore',
  'cat x | python3 -X dev',
  'cat x | node --import ./x.mjs',
  'cat x | node -r ./x.js',
  'cat x | perl -I lib',
  'cat x | ruby -r json',
]

const STDIN_AS_DATA = [
  'echo {} | python3 -m json.tool',
  'python3 -m json.tool < x.json',
  'cat x | python3 script.py',
  'cat x | node script.js',
  'node script.js < in.txt',
  'python3 script.py',
  'cat x | jq .',
]

test('test_c1_interpreter_program_from_stdin_asks_for_confirmation_on_host', () => {
  for (const command of STDIN_PROGRAMS) {
    const result = checkCommand(command, HOST)
    expect(result.verdict, command).toBe('confirm')
    expect(result.reason, command).toMatch(/^unparseable:/)
  }
})

test('test_c2_interpreter_option_value_is_not_a_program_file', () => {
  for (const command of OPTIONS_WITH_VALUE) {
    const result = checkCommand(command, HOST)
    expect(result.verdict, command).toBe('confirm')
    expect(result.reason, command).toMatch(/^unparseable:/)
  }
})

test('test_c3_interpreter_with_program_file_or_module_reads_stdin_as_data', () => {
  for (const command of STDIN_AS_DATA) {
    expect(checkCommand(command, HOST).verdict, command).toBe('allow')
  }
})

test('test_c4_sandbox_keeps_allow_for_interpreter_stdin_code', () => {
  expect(checkCommand('python3 -c "print(1)"', SANDBOX).verdict).toBe('allow')
  for (const command of [...STDIN_PROGRAMS, ...OPTIONS_WITH_VALUE]) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
})
