import { expect, test } from 'vitest'
import { checkCommand, explainCommand } from './index.js'

// The card text for a command line, built the way the approval card does: from the guard's own reason.
function explanationOf(command: string): string {
  const check = checkCommand(command)
  expect(check.verdict, `${command} needs a confirmation`).toBe('confirm')
  return explainCommand(command, check.reason ?? '')
}

// The card limit that already holds for an explanation (MAX_EXPLANATION_CHARS of the module).
const CARD_LIMIT = 3500

test('test_h2_ansi_c_quoted_name_is_not_a_plain_variable_expansion', () => {
  // `$'D'` is an ANSI-C string «D», not `$D`: a write to D that hides behind it makes the earlier value unreliable.
  for (const command of ["D=/a; printf -v $'D' %s /b; rm -rf $D", "D=/a; read $'D'; rm -rf $D"]) {
    const text = explanationOf(command)
    expect(text, command).toMatch(/значение\s+[«"'`]*\$D[»"'`]*\s+заранее\s+неизвестно/i)
    expect(text, `${command}: the stale value must not be named`).not.toContain('/a')
  }
})

test('test_h2_ansi_c_quoted_name_with_escape_sequences_is_still_unknown', () => {
  // `$'\x44'` is the name «D» written with an escape sequence of the ANSI-C string.
  const text = explanationOf("D=/a; printf -v $'\\x44' %s /b; rm -rf $D")
  expect(text).toMatch(/значение\s+[«"'`]*\$D[»"'`]*\s+заранее\s+неизвестно/i)
  expect(text).not.toContain('/a')
})

test('test_h2_long_run_of_service_restarts_does_not_hide_the_irreversible_step', () => {
  const units = Array.from({ length: 50 }, (_, i) => `worker-${String(i).padStart(2, '0')}.service`)
  const command = `${units.map((unit) => `systemctl restart ${unit}`).join('; ')}; rm -rf /srv/x/node_modules`
  const text = explanationOf(command)
  expect(text).toContain('/srv/x/node_modules')
  expect(text).toMatch(/Удалю/i)
  expect(text.length).toBeLessThanOrEqual(CARD_LIMIT)
})

test('test_h2_irreversible_steps_survive_the_length_limit_among_many_reversible_ones', () => {
  const kills = Array.from({ length: 80 }, (_, i) => `pkill -f proc-${i}`)
  const steps = [...kills, 'rm -rf /srv/y/cache', ...kills.slice(0, 20), 'git push origin main']
  const text = explanationOf(steps.join('; '))
  expect(text).toContain('/srv/y/cache')
  expect(text).toMatch(/git|push|origin|main/i)
  expect(text.length).toBeLessThanOrEqual(CARD_LIMIT)
})
