import { expect, test } from 'vitest'
import { checkCommand, type CommandCheck, type CommandCheckOptions } from './index.js'

// Fixed input/output cases from the guard tests, including host and sandbox
// modes. Explanations may resolve variables; classification and its reason stay
// unchanged. These expectations never derive from the implementation under test.
interface Cases {
  options: CommandCheckOptions
  expected: CommandCheck
  commands: string[]
}

const cases: Cases[] = [
  {
    options: {},
    expected: { verdict: 'deny', reason: 'publication: gh repo create --public' },
    commands: [
      'gh repo create foo --public',
      'ls && gh repo create x --public',
      'gh repo create x --public',
    ],
  },
  {
    options: {},
    expected: { verdict: 'deny', reason: 'publication: gh repo edit --visibility public' },
    commands: [
      'gh repo edit --visibility public',
    ],
  },
  {
    options: {},
    expected: { verdict: 'deny', reason: 'publication: gh gist create --public' },
    commands: [
      'gh gist create -p a.txt',
      'gh gist create --public a.txt',
    ],
  },
  {
    options: {},
    expected: { verdict: 'deny', reason: 'publication: gh api sets private=false or visibility=public' },
    commands: [
      'gh api -X PATCH repos/o/r -F private=false',
    ],
  },
  {
    options: {},
    expected: { verdict: 'deny', reason: 'publication: gh api call to the pages endpoint' },
    commands: [
      'gh api -X POST repos/o/r/pages',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: git push' },
    commands: [
      'git push origin main',
      'git push --force',
      'git push -f origin x',
      'npm test; git push',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: recursive rm' },
    commands: [
      'rm -rf build',
      'rm -r dir',
      'rm -r /srv/old',
      'echo a | xargs rm -rf',
      'rm -r build',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: git reset --hard' },
    commands: [
      'git reset --hard HEAD~1',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: git clean -f' },
    commands: [
      'git clean -fd',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: SQL DROP TABLE or DROP DATABASE' },
    commands: [
      'psql -c "DROP TABLE users"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: systemctl stops or restarts a service' },
    commands: [
      'systemctl stop nginx',
      'systemctl restart nginx',
      'systemctl --user try-restart dshbot',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: service stops or restarts a service' },
    commands: [
      'service nginx restart',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: reboot interrupts the host' },
    commands: [
      'reboot',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: shutdown interrupts the host' },
    commands: [
      'shutdown -h now',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: kill interrupts the host' },
    commands: [
      'kill 4242',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: pkill interrupts the host' },
    commands: [
      'pkill -f node',
      'pkill -f "vitest run"; sleep 2; C=/srv/x; rm -rf $C/node_modules; uptime',
    ],
  },
  {
    options: {},
    expected: { verdict: 'allow', reason: 'no restricted operation detected' },
    commands: [
      'systemctl status nginx',
      'journalctl -u nginx -n 50',
      'df -h',
      'ls -la',
      'git log --oneline',
      'git commit -m fix',
      'npm test',
      'gh pr view 1',
      'cat README.md',
      'cat a | grep b',
      'find . -name "*.ts"',
      'echo $HOME',
      'node script.js',
      'python3 tool.py',
      'cat $FILE',
      'ls $DIR',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: nested bash -c' },
    commands: [
      'bash -c "ls"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: nested sh -c' },
    commands: [
      'sh -c "x"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: eval' },
    commands: [
      'eval x',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: command substitution' },
    commands: [
      'echo $(whoami)',
      'echo `whoami`',
      'echo $(date)',
      'L=$(ls -t /var/log/app-*.log | head -1); rm -f "$L"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'irreversible: find deletes files or runs a program' },
    commands: [
      'find . -name x -delete',
      'find . -exec rm {} +',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: python3 inline code' },
    commands: [
      'python3 -c "import shutil"',
      'python3 -c "print(1)"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: node inline code' },
    commands: [
      'node -e "1"',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: perl inline code' },
    commands: [
      'perl -e 1',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of rm' },
    commands: [
      'rm $FLAGS dir',
      'D="-rf /"; rm $D',
      'rm build $FLAGS',
      'rm build ${FLAGS}',
      'C=/srv/data/cand; rm -rf $C/node_modules',
      'rm -rf $TARGET/build',
      'D=/a; D=/b; rm -rf $D',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in command position' },
    commands: [
      '$CMD x',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of find' },
    commands: [
      'find . -name $PATTERN',
      'find $DIR -name x',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in wrapper arguments' },
    commands: [
      'echo a | xargs -n 1 $TOOL',
      'env KEY="$VALUE" echo ok',
      'env X=$Y rm -r build',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of git' },
    commands: [
      'git log $BRANCH',
      'git clean $FLAGS',
    ],
  },
  {
    options: {},
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of gh' },
    commands: [
      'gh pr view $NUMBER',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'allow', reason: 'no restricted operation detected' },
    commands: [
      'python3 -c "print(1)"',
      'node -e "console.log(1)"',
      'echo $(date)',
      'echo `date`',
      'eval "ls"',
      '$SHELL --version',
      'bash -c "$CMD"',
      'echo "abc',
      'bash -c "ls -la"',
      'echo $(git log --oneline)',
      'find . -name "*.ts" -exec grep -l foo {} +',
      'ls | xargs wc -l',
      'echo \'$(rm -r build)\'',
      'echo $((6*7))',
      'kill 4242',
      'pkill node',
      'killall python3',
      'echo $(true; git log --oneline)',
      'echo `date; ls | wc -l`',
      'echo $(ls && pwd) | wc -c',
      'env KEY="$VALUE" echo ok',
      'KEY=$VALUE echo ok',
      'sudo -u $USER ls',
      'env -u $NAME ls',
      'echo "<(rm -r build)"',
      'echo \'<(rm -r build)\'',
      'echo "<(rm -r build)" ">(rm -r build)"',
      'echo `ls -la src`',
      'echo `echo \\`ls -la src\\``',
      'echo `echo \\`echo \\\\\\`ls -la src\\\\\\`\\``',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: recursive rm' },
    commands: [
      'bash -c "rm -r build"',
      'echo $(rm -r build)',
      'echo `rm -r build`',
      'find . -name "*.log" -exec rm -r {} +',
      'ls | xargs rm -r',
      'eval "rm -r build"',
      'echo "it\'s $(rm -r build)"',
      'diff <(rm -r build) out.txt',
      'rm -r build',
      'rm -rf build',
      'echo $(true && rm -r build)',
      'echo `true && rm -r build`',
      'echo $(ls | xargs rm -r)',
      'echo `ls | xargs rm -r`',
      'echo "$(true; rm -rf build)"',
      'X=$(echo a b) rm -r build',
      'env X=$Y rm -r build',
      'echo `echo \\`rm -r build\\``',
      'echo "$(rm -r build)"',
      'echo "`rm -r build`"',
      'tee >(rm -r build)',
      'echo `echo \\`echo \\\\\\`rm -r build\\\\\\`\\``',
      'echo `echo \\`echo \\\\\\`echo \\\\\\\\\\\\\\`rm -r build\\\\\\\\\\\\\\`\\\\\\`\\``',
      'echo `echo \\$(rm -r build)`',
      'echo "<(ls)" $(rm -r build)',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: git push' },
    commands: [
      'sh -c "git push origin main"',
      'git push origin main',
      'echo $(false || git push origin main)',
      'echo `false || git push origin main`',
      'KEY=$VALUE git push',
      'echo `echo \\`git push origin main\\``',
      'echo `echo \\`echo \\\\\\`git push origin main\\\\\\`\\``',
      'echo `echo \\`echo \\\\\\`echo \\\\\\\\\\\\\\`git push origin main\\\\\\\\\\\\\\`\\\\\\`\\``',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: find deletes files' },
    commands: [
      'find . -name "*.tmp" -delete',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: git reset --hard' },
    commands: [
      'git reset --hard',
      'echo $(true; git reset --hard)',
      'echo `true; git reset --hard`',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: git clean -f' },
    commands: [
      'git clean -fd',
      'bash -c "true; git clean -fd"',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: SQL DROP TABLE or DROP DATABASE' },
    commands: [
      'psql -c "DROP TABLE users"',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: reboot interrupts the host' },
    commands: [
      'reboot',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'irreversible: systemctl stops or restarts a service' },
    commands: [
      'systemctl --user restart dshbot',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of rm' },
    commands: [
      'rm $TARGET',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'deny', reason: 'publication: gh repo create --public' },
    commands: [
      'gh repo create x --public',
      'bash -c "gh repo create x --public"',
      'rm $(gh repo create x --public)',
      'rm `gh repo create x --public`',
      'rm -r $(gh repo create x --public)',
      'echo $(gh repo create x --public)',
      'echo $(true; gh repo create x --public)',
      'echo `true; gh repo create x --public`',
      'bash -c "true; gh repo create x --public"',
      'git push $(gh repo create x --public)',
      'find . -delete -exec gh repo create x --public \\;',
      'ls | xargs -I $R sh -c "gh repo create x --public"',
      'env X=$Y bash -c "gh repo create x --public"',
      'echo `gh repo create x --public`',
      'echo `echo \\`gh repo create x --public\\``',
      'echo `echo \\`echo \\\\\\`gh repo create x --public\\\\\\`\\``',
      'echo `echo \\`echo \\\\\\`echo \\\\\\\\\\\\\\`gh repo create x --public\\\\\\\\\\\\\\`\\\\\\`\\``',
    ],
  },
  {
    options: { sandbox: true },
    expected: { verdict: 'confirm', reason: 'unparseable: variable in the arguments of xargs' },
    commands: [
      'xargs -I $REPL echo',
      'ls | xargs echo $X',
    ],
  },
]

function backtickedTimes(inner: string, levels: number): string {
  let command = inner
  for (let level = 0; level < levels; level += 1) {
    command = 'echo `' + command.replace(/[\\`$]/g, (char) => '\\' + char) + '`'
  }
  return command
}

test('test_c5_checkCommand_keeps_verdicts_and_reasons_for_assignments_and_existing_guard_cases', () => {
  for (const group of cases) {
    for (const command of group.commands) {
      expect(checkCommand(command, group.options), `${JSON.stringify(group.options)}: ${command}`).toEqual(group.expected)
    }
  }

  // Keep the existing deeply nested cases as expressions, without storing huge
  // escaped strings. Their reasons, as well as verdicts, are fixed below.
  for (const levels of [9, 10, 16]) {
    for (const [inner, expected] of [
      ['gh repo create x --public', { verdict: 'deny', reason: 'publication: gh repo create --public' }],
      ['rm -r build', { verdict: 'confirm', reason: 'irreversible: recursive rm' }],
      ['ls -la', { verdict: 'allow', reason: 'no restricted operation detected' }],
    ] as const) {
      expect(checkCommand(backtickedTimes(inner, levels), { sandbox: true }), `${inner} at depth ${levels}`).toEqual(expected)
    }
  }
  const subshells = 'echo ' + '$('.repeat(3000) + 'gh repo create x --public' + ')'.repeat(3000)
  expect(checkCommand(subshells, { sandbox: true })).toEqual({ verdict: 'deny', reason: 'publication: gh repo create --public' })
  expect(checkCommand('bash -c '.repeat(1000) + 'ls -la', { sandbox: true })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })
  // The nested cases take under a second alone but exceed the default 5 s
  // when the full suite saturates the CPU.
}, 30_000)
