// Unit coverage of the deterministic check helpers: the three outcomes of one
// check tick, the prompt cut and the plain-text split of a raw delivery.

import { spawnSync } from 'node:child_process'

import { expect, test } from 'vitest'

import {
  checkExecCommand,
  checkHasWork,
  checkOutputForPrompt,
  readCheckResult,
  splitPlainText,
  TELEGRAM_TEXT_LIMIT,
} from './src/index.js'

/** The text the `exec` tool builds from one foreground run (tools-exec `outputOf`). */
function execText(code: number, stdout: string, stderr: string): string {
  const sections: string[] = []
  if (stdout !== '') sections.push(stdout)
  if (stderr !== '') sections.push(`--- stderr ---\n${stderr}`)
  return `exit ${code}\n${sections.length === 0 ? '(нет вывода)' : sections.join('\n')}`
}

/** Run a check wrapped exactly as the daemon hands it to `exec`, without the sandbox. */
function runWrapped(command: string): string {
  const result = spawnSync('bash', ['-c', checkExecCommand(command)], { encoding: 'utf8' })
  return execText(result.status ?? 1, result.stdout, result.stderr)
}

test('test_check_logic_nonzero_exit_timeout_and_signal_are_errors', () => {
  expect(readCheckResult('exit 47\n.CHK-FAIL-OUT')).toEqual({
    status: 'error',
    error: 'проверка завершилась с кодом 47',
  })
  // A wrapper that failed before the marker still reports the exit code.
  expect(readCheckResult('exit 1\n--- stderr ---\nexec: прокси песочницы не поднялся за 5 с')).toEqual({
    status: 'error',
    error: 'проверка завершилась с кодом 1',
  })
  expect(readCheckResult('Таймаут: команда и её дочерние процессы убиты через 120 с.\n')).toEqual({
    status: 'error',
    error: 'проверка не уложилась в таймаут',
  })
  expect(readCheckResult('Команда прервана.\n')).toEqual({ status: 'error', error: 'проверка прервана' })
  expect(readCheckResult('signal SIGKILL\n')).toEqual({
    status: 'error',
    error: 'проверка завершилась по сигналу (signal SIGKILL)',
  })
  // Exit 0 without the marker is not a check answer: never a silent skip.
  expect(readCheckResult('exit 0\n(нет вывода)')).toEqual({
    status: 'error',
    error: 'исполнитель не вернул вывод проверки',
  })
})

test('test_check_logic_wrapped_command_returns_stdout_byte_for_byte', () => {
  const lead = "printf -- '--- stderr ---\\nWORK\\n'"
  expect(readCheckResult(runWrapped(lead))).toEqual({ status: 'work', output: '--- stderr ---\nWORK\n' })
  const middle = "printf 'alpha\\n--- stderr ---\\nomega'; echo noise >&2"
  expect(readCheckResult(runWrapped(middle))).toEqual({ status: 'work', output: 'alpha\n--- stderr ---\nomega' })
  expect(readCheckResult(runWrapped('printf "(нет вывода)"'))).toEqual({ status: 'work', output: '(нет вывода)' })
  // stderr alone is no work, and a failing check keeps its own exit code.
  expect(readCheckResult(runWrapped('echo only-stderr >&2'))).toEqual({ status: 'skip' })
  expect(readCheckResult(runWrapped('true'))).toEqual({ status: 'skip' })
  expect(readCheckResult(runWrapped('echo out\necho err >&2\nexit 3'))).toEqual({
    status: 'error',
    error: 'проверка завершилась с кодом 3',
  })
})
