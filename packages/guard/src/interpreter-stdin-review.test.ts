import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const HOST = { sandbox: false } as const
const SANDBOX = { sandbox: true } as const

// An info flag before the `-` operand does not stop the interpreter from
// running the program it reads from stdin.
const INFO_FLAG_THEN_STDIN = [
  'ruby -v - < x.rb',
  'printf "puts :x" | ruby -v -',
  'ruby --version - < x.rb',
  'ruby -h - < x.rb',
  'python3 -V - < x.py',
  'python3 --version - < x.py',
  'cat x | python3 -V -',
  'node -v - < x.js',
  'node --version - < x.js',
  'cat x | node -v -',
  'perl -v - < x.pl',
  'cat x | perl -v -',
]

// A flag without a value must not swallow the program file that follows it.
const FLAG_THEN_PROGRAM_FILE = [
  'node --inspect script.js < in.txt',
  'node --inspect-brk script.js < in.txt',
  'cat x | node --inspect script.js',
  'node --trace-warnings script.js < in.txt',
  'python3 -B script.py < in.txt',
  'python3 -u script.py < in.txt',
  'cat x | python3 -B -u script.py',
  'perl -w script.pl < in.txt',
  'ruby -w script.rb < in.txt',
]

// The same flags still leave the program on stdin when no file follows.
const FLAG_THEN_STDIN = [
  'cat x | node --inspect',
  'node --inspect < x.js',
  'cat x | node --inspect -',
  'cat x | python3 -B',
  'perl -w < x.pl',
]

test('test_h1_info_flag_does_not_hide_interpreter_code_from_stdin', () => {
  for (const command of INFO_FLAG_THEN_STDIN) {
    const result = checkCommand(command, HOST)
    expect(result.verdict, command).toBe('confirm')
    expect(result.reason, command).toMatch(/^unparseable:/)
  }
})

test('test_h1_info_flag_without_program_from_stdin_stays_allowed', () => {
  for (const command of ['ruby -v', 'node --version', 'python3 -V', 'python3 --version', 'perl -v', 'node -h']) {
    expect(checkCommand(command, HOST).verdict, command).toBe('allow')
  }
})

test('test_h1_valueless_flag_does_not_eat_program_file_operand', () => {
  for (const command of FLAG_THEN_PROGRAM_FILE) {
    expect(checkCommand(command, HOST).verdict, command).toBe('allow')
  }
})

test('test_h1_valueless_flag_without_program_file_still_reads_code_from_stdin', () => {
  for (const command of FLAG_THEN_STDIN) {
    const result = checkCommand(command, HOST)
    expect(result.verdict, command).toBe('confirm')
    expect(result.reason, command).toMatch(/^unparseable:/)
  }
})

test('test_h1_sandbox_keeps_allow_for_these_commands', () => {
  for (const command of [...INFO_FLAG_THEN_STDIN, ...FLAG_THEN_PROGRAM_FILE, ...FLAG_THEN_STDIN]) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
})
