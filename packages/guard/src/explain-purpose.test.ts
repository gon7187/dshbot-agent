import { expect, test } from 'vitest'
import { checkCommand, explainCommand } from './index.js'

test('a supplied purpose replaces generic script narration while known consequences remain', () => {
  const purpose = 'Проверю диагностику и очищу временные файлы'
  const script = `python3 -c 'print("fixture")'`
  for (const command of [script, `${script}; rm -rf /tmp/approval-fixture`, 'rm -rf /tmp/approval-fixture']) {
    const verdict = checkCommand(command)
    expect(verdict.verdict).toBe('confirm')
    const text = explainCommand(command, verdict.reason ?? '', { purpose, host: 'fixture-host' })
    expect(text.split(purpose)).toHaveLength(2)
    expect(text).toContain('fixture-host')
    expect(text).not.toMatch(/заранее понять|не могу заранее понять|последствия зависят/i)
    if (command.includes('rm -rf')) {
      expect(text).toContain('/tmp/approval-fixture')
      expect(text).toMatch(/удалю|восстановить|безвозврат/i)
    }
  }
})

test.each([
  'D=/tmp/approval-fixture; read D; rm -rf "$D"',
  "D=/tmp/approval-fixture; printf -v $'D' %s /changed; rm -rf $D",
])('a supplied purpose does not hide an unknown destructive target: %s', (command) => {
  const verdict = checkCommand(command)
  const text = explainCommand(command, verdict.reason ?? '', { purpose: 'Очищу временные файлы' })
  expect(text).toMatch(/удалю/i)
  expect(text).toMatch(/значение\s+\$D\s+заранее\s+неизвестно/i)
  expect(text).not.toContain('/tmp/approval-fixture')
})

test('test_h2_irreversible_steps_survive_the_length_limit_among_many_reversible_ones', () => {
  const kills = Array.from({ length: 80 }, (_, i) => `pkill -f proc-${i}`)
  const steps = [...kills, 'rm -rf /srv/y/cache', ...kills.slice(0, 20), 'git push origin main']
  const text = explainCommand(steps.join('; '), checkCommand(steps.join('; ')).reason)
  expect(text).toContain('/srv/y/cache')
  expect(text).toMatch(/git|push|origin|main/i)
  expect(text.length).toBeLessThanOrEqual(3500)
})
