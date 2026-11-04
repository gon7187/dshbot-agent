import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { PANIC_EXIT_CODE, checkCommand, costOf, isProtected } from './index.js'

const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 }
const repoRoot = '/work/dshbot'

function withTempRepo(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'guard-repo-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('test_c1_costOf sums input, cache read and output cost by default prices', () => {
  const cost = costOf('deepseek-v4-flash', {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  })
  expect(cost).toBeCloseTo(0.14 + 0.0028 + 0.28, 9)
})

test('test_c2_costOf returns null, not zero, for a model missing from the price table', () => {
  expect(costOf('no-such-model', usage)).toBeNull()
  expect(costOf('no-such-model', usage, { 'other-model': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })).toBeNull()
})

test('test_c3_costOf uses the passed prices table instead of the default one', () => {
  const prices = { 'custom-model': { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } }
  expect(costOf('custom-model', usage, prices)).toBeCloseTo(5, 9)
})

test('test_c4_checkCommand denies publication commands', () => {
  const commands = [
    'gh repo create foo --public',
    'gh repo edit --visibility public',
    'gh gist create -p a.txt',
    'gh gist create --public a.txt',
    'gh api -X PATCH repos/o/r -F private=false',
    'gh api -X POST repos/o/r/pages',
  ]
  for (const command of commands) {
    expect(checkCommand(command).verdict, command).toBe('deny')
  }
})

test('test_c5_checkCommand asks confirmation for irreversible commands', () => {
  const commands = [
    'git push origin main',
    'git push --force',
    'git push -f origin x',
    'rm -rf build',
    'rm -r dir',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'psql -c "DROP TABLE users"',
  ]
  for (const command of commands) {
    expect(checkCommand(command).verdict, command).toBe('confirm')
  }
})

test('test_h2_checkCommand asks confirmation to stop or restart services, reboot and kill', () => {
  const commands = [
    'rm -r /srv/old',
    'systemctl stop nginx',
    'systemctl restart nginx',
    'systemctl --user try-restart dshbot',
    'service nginx restart',
    'reboot',
    'shutdown -h now',
    'kill 4242',
    'pkill -f node',
  ]
  for (const command of commands) {
    expect(checkCommand(command).verdict, command).toBe('confirm')
  }
  // Read-only service inspection stays available without a button.
  for (const command of ['systemctl status nginx', 'journalctl -u nginx -n 50', 'df -h']) {
    expect(checkCommand(command).verdict, command).toBe('allow')
  }
})

test('test_c6_checkCommand allows ordinary commands', () => {
  const commands = ['ls -la', 'git log --oneline', 'git commit -m fix', 'npm test', 'gh pr view 1', 'cat README.md']
  for (const command of commands) {
    expect(checkCommand(command).verdict, command).toBe('allow')
  }
})

test('test_c7_checkCommand gives a compound command the strictest verdict of its parts', () => {
  expect(checkCommand('ls && gh repo create x --public').verdict).toBe('deny')
  expect(checkCommand('npm test; git push').verdict).toBe('confirm')
  expect(checkCommand('cat a | grep b').verdict).toBe('allow')
})

test('test_c8_checkCommand does not allow commands it cannot parse reliably', () => {
  const commands = ['bash -c "ls"', 'sh -c "x"', 'eval x', 'echo $(whoami)', 'echo `whoami`']
  for (const command of commands) {
    expect(['confirm', 'deny'], command).toContain(checkCommand(command).verdict)
  }
})

test('test_c9_isProtected protects charter, guard, deploy and character tests only', () => {
  expect(isProtected('CHARTER.md', repoRoot)).toBe(true)
  expect(isProtected('packages/guard/src/index.ts', repoRoot)).toBe(true)
  expect(isProtected('deploy/dshbot.service', repoRoot)).toBe(true)
  expect(isProtected('tests/character/a.test.ts', repoRoot)).toBe(true)
  expect(isProtected('README.md', repoRoot)).toBe(false)
  expect(isProtected('packages/store/src/index.ts', repoRoot)).toBe(false)
})

test('test_c10_isProtected gives the same answer for equivalent paths and false outside repoRoot', () => {
  expect(isProtected('./CHARTER.md', repoRoot)).toBe(true)
  expect(isProtected(`${repoRoot}/CHARTER.md`, repoRoot)).toBe(true)
  expect(isProtected('packages/../CHARTER.md', repoRoot)).toBe(true)
  expect(isProtected('/work/other/CHARTER.md', repoRoot)).toBe(false)
  expect(isProtected('../CHARTER.md', repoRoot)).toBe(false)
})

test('test_c1_isProtected covers adoption and rollback scripts and CHECKLIST.md', () => {
  expect(isProtected('scripts/adopt.sh', repoRoot)).toBe(true)
  expect(isProtected('scripts/rollback.sh', repoRoot)).toBe(true)
  expect(isProtected('CHECKLIST.md', repoRoot)).toBe(true)
  expect(isProtected('README.md', repoRoot)).toBe(false)
  expect(isProtected('packages/store/src/index.ts', repoRoot)).toBe(false)
})

test('test_c2_isProtected resolves symlinks to file and directory targets', () => {
  withTempRepo((root) => {
    writeFileSync(join(root, 'CHARTER.md'), '# charter\n')
    writeFileSync(join(root, 'README.md'), '# readme\n')
    mkdirSync(join(root, 'packages', 'guard'), { recursive: true })
    symlinkSync(join(root, 'CHARTER.md'), join(root, 'link.md'))
    symlinkSync(join(root, 'README.md'), join(root, 'plain.md'))
    symlinkSync(join(root, 'packages', 'guard'), join(root, 'g'))

    expect(isProtected('link.md', root)).toBe(true)
    expect(isProtected('plain.md', root)).toBe(false)
    // packages/guard/src does not exist and x.ts is not created: the nearest existing parent decides.
    expect(isProtected('g/src/x.ts', root)).toBe(true)
  })
})

test('isProtected covers .github as written and when the link hides it behind an unprotected target', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'CONFIG.md'), '# config\n')
    symlinkSync('../../docs/CONFIG.md', join(root, '.github', 'workflows', 'ci.yml'))

    expect(isProtected('.github/workflows/ci.yml', root)).toBe(true)
    expect(isProtected('.github/workflows/new.yml', root)).toBe(true)
    expect(isProtected('docs/CONFIG.md', root)).toBe(false)
  })
})

test('test_c5_isProtected_ignores_the_letter_case_of_a_protected_path', () => {
  const paths = [
    'charter.md',
    'CHECKLIST.MD',
    'PACKAGES/GUARD/src/index.ts',
    'Packages/Evolve/src/new.ts',
    'PACKAGES/TOOLS-EXEC/SRC/sandbox.ts',
    'DEPLOY/dshbot.service',
    'Tests/Character/a.test.ts',
    'Scripts/adopt.sh',
  ]
  for (const path of paths) {
    expect(isProtected(path, repoRoot), path).toBe(true)
  }

  // A case variant does not turn a neighbour into a protected subtree.
  expect(isProtected('packages/evolve-extra/src/index.ts', repoRoot)).toBe(false)
  expect(isProtected('packages/tools-exec-extra/src/index.ts', repoRoot)).toBe(false)
})

test('test_c2_checkCommand keeps a real variable after an ANSI-C quote with an escaped apostrophe', () => {
  // `\'` does not close `$'…'`, so the `$FLAGS` concatenated with it below
  // stays unquoted and expands.
  expect(checkCommand("rm build $'a\\'b' $FLAGS \\'", { sandbox: false })).toEqual({
    verdict: 'confirm',
    reason: 'unparseable: variable in the arguments of rm',
  })
  expect(checkCommand("chmod $'a\\'b'$FLAGS \\' dir", { sandbox: false })).toEqual({
    verdict: 'confirm',
    reason: 'unparseable: variable in flag position',
  })
})

test.each([true, false])('test_h1_checkCommand ends an ANSI-C quote at its first NUL like bash (sandbox=%s)', (sandbox) => {
  // Bash drops the rest of a `$'…'` string after a NUL in any escape form, but
  // keeps the text after the closing quote.
  const commands = [
    "$'rm\\0ignored' -rf /tmp/x",
    "rm $'-rf\\0ignored' /tmp/x",
    "$'rm\\x00ignored' -rf /tmp/x",
    "$'rm\\x0ignored' -rf /tmp/x",
    "$'rm\\000ignored' -rf /tmp/x",
    "$'rm\\u0000ignored' -rf /tmp/x",
    "$'rm\\0ign\\'ored' -rf /tmp/x",
    "$'r\\0ignored'm -rf /tmp/x",
  ]
  for (const command of commands) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm',
      reason: 'irreversible: recursive rm',
    })
  }
})

test.each([true, false])('test_h2_checkCommand finds the end of an ANSI-C string before decoding \\c (sandbox=%s)', (sandbox) => {
  // Bash lexes `$'…'` first: a backslash escapes exactly one next character,
  // the first unescaped apostrophe closes the string, and only then is the
  // slice decoded. So `\c` must never consume the closing quote, which would
  // otherwise leave the guard seeing an unbalanced string (an allow in the
  // sandbox) while bash runs an ordinary command.
  expect(checkCommand("$'rm\\0\\c' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'confirm',
    reason: 'irreversible: recursive rm',
  })

  // The word is `rm\c`, not rm: a trailing \c stays literal.
  expect(checkCommand("$'rm\\c' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })

  // \c takes the backslash and the apostrophe after it is literal, so the
  // string closes after x and the word is not rm.
  expect(checkCommand("$'rm\\c\\'x' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })
})

test.each([true, false])('test_h2_checkCommand decodes only inside the ANSI-C string boundary (sandbox=%s)', (sandbox) => {
  // After the closing quote the characters are ordinary shell text, so the
  // decoded prefix and the suffix form one word: `rm\x1c\\x` is not rm.
  expect(checkCommand("$'rm\\c\\x' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })
  expect(checkCommand("$'rm\\c\\\\' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })
  // A NUL still truncates the word, and a suffix after the quote joins it.
  expect(checkCommand("$'rm\\0\\c'x -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'allow',
    reason: 'no restricted operation detected',
  })
  expect(checkCommand("$'r\\0ignored'$'m' -rf /tmp/x", { sandbox })).toEqual({
    verdict: 'confirm',
    reason: 'irreversible: recursive rm',
  })
})

// The exec sandbox (its own process space, writes only to the workspace and the
// owner's read-write roots) asks only for destructive actions: an unparseable
// syntax alone is not a reason, kill stays inside the sandbox, and the text
// nested in `bash -c`, `$(…)`, backticks, `find -exec`, `eval` and `xargs` is
// judged by the same rules. The host keeps the old strict rules.
const SANDBOX = { sandbox: true } as const

test('test_s1_sandbox_checkCommand does not ask for unparseable syntax alone', () => {
  const commands = [
    'python3 -c "print(1)"',
    'node -e "console.log(1)"',
    'echo $(date)',
    'echo `date`',
    'eval "ls"',
    '$SHELL --version',
    'bash -c "$CMD"',
    'echo "abc',
  ]
  for (const command of commands) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
})

test('test_s3_sandbox_checkCommand allows kill but keeps the destructive card', () => {
  for (const command of ['kill 4242', 'pkill node', 'killall python3']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
  const destructive = [
    'rm -r build',
    'rm -rf build',
    'find . -name "*.tmp" -delete',
    'git push origin main',
    'git reset --hard',
    'git clean -fd',
    'psql -c "DROP TABLE users"',
    'reboot',
    'systemctl --user restart dshbot',
    'rm $TARGET',
  ]
  for (const command of destructive) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
  expect(checkCommand('gh repo create x --public', SANDBOX).verdict).toBe('deny')
  expect(checkCommand('bash -c "gh repo create x --public"', SANDBOX).verdict).toBe('deny')
})

test('test_s5_sandbox_checkCommand judges compound substitutions part by part', () => {
  const destructive = [
    'echo $(true; git reset --hard)',
    'echo `true; git reset --hard`',
    'echo $(true && rm -r build)',
    'echo `true && rm -r build`',
    'echo $(false || git push origin main)',
    'echo `false || git push origin main`',
    'echo $(ls | xargs rm -r)',
    'echo `ls | xargs rm -r`',
    'echo "$(true; rm -rf build)"',
    'X=$(echo a b) rm -r build',
    'bash -c "true; git clean -fd"',
  ]
  for (const command of destructive) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
  for (const command of ['echo $(true; git status)', 'echo `date; ls | wc -l`', 'echo $(ls && pwd) | wc -c']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
})

test('test_s6_sandbox_checkCommand never lowers a nested publication to a card', () => {
  const published = [
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
  ]
  for (const command of published) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('deny')
  }
})

test('test_s7_sandbox_checkCommand ignores a variable in env and sudo prefixes', () => {
  for (const command of ['env KEY="$VALUE" echo ok', 'KEY=$VALUE echo ok', 'sudo -u $USER ls', 'env -u $NAME ls']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
  for (const command of ['env X=$Y rm -r build', 'KEY=$VALUE git push', 'xargs -I $REPL echo', 'ls | xargs echo $X']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('confirm')
  }
  // The host keeps the strict rule for wrapper variables.
  expect(checkCommand('env KEY="$VALUE" echo ok').verdict).toBe('confirm')
  expect(checkCommand('env X=$Y rm -r build').verdict).toBe('confirm')
})

/** `inner` in backticks, escaped the way a shell needs it nested one level deeper. */
function backticked(inner: string): string {
  return 'echo `' + inner.replace(/[\\`$]/g, (char) => '\\' + char) + '`'
}

/** `inner` nested in backticks `levels` times. */
function backtickedTimes(inner: string, levels: number): string {
  let command = inner
  for (let level = 0; level < levels; level += 1) command = backticked(command)
  return command
}

test('deep pure substitution and shell wrappers preserve each verdict and surrounding commands', () => {
  for (const [leaf, verdict] of [
    ['ls -la', 'allow'], ['rm -r build', 'confirm'], ['gh repo create x --public', 'deny'],
  ] as const) {
    for (const depth of [1, 10, 3000]) {
      const substitution = '$('.repeat(depth) + leaf + ')'.repeat(depth)
      expect(checkCommand(`echo ${substitution}`, SANDBOX).verdict, `${verdict} substitution ${depth}`).toBe(verdict)
      expect(checkCommand('bash -c '.repeat(depth) + leaf, SANDBOX).verdict, `${verdict} shell ${depth}`).toBe(verdict)
    }
  }
  for (const command of [
    'echo $($(ls -la); gh repo create x --public)',
    'echo $($(ls -la)$(gh repo create x --public))',
    'echo $($(ls -la) ; (gh repo create x --public))',
    'echo $(prefix$(gh repo create x --public)suffix)',
    'echo "$( $(gh repo create x --public))"',
    'echo $($((1 + $(gh repo create x --public))))',
    'bash -c "\\$(gh repo create x --public)/bash" -c ls',
  ]) expect(checkCommand(command, SANDBOX).verdict, command).toBe('deny')
  expect(checkCommand("echo '$($(rm -r build))'", SANDBOX).verdict).toBe('allow')
  expect(checkCommand('echo "<(rm -r build)"', SANDBOX).verdict).toBe('allow')
  expect(checkCommand('echo $($((1 + 2)))', SANDBOX).verdict).toBe('allow')
  expect(checkCommand('echo $($(rm -r build)', SANDBOX).verdict).toBe('confirm')
  expect(checkCommand('echo $($(ls -la))').verdict).toBe('confirm')
})

test('test_h2_sandbox_checkCommand recognizes process substitution only outside quotes', () => {
  for (const command of ['echo "<(rm -r build)"', "echo '<(rm -r build)'", 'echo "<(rm -r build)" ">(rm -r build)"']) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('allow')
  }
  // Substitutions inside double quotes still run.
  expect(checkCommand('echo "$(rm -r build)"', SANDBOX).verdict).toBe('confirm')
  expect(checkCommand('echo "`rm -r build`"', SANDBOX).verdict).toBe('confirm')
  // Outside quotes process substitution is a nested command.
  expect(checkCommand('diff <(rm -r build) out.txt', SANDBOX).verdict).toBe('confirm')
  expect(checkCommand('tee >(rm -r build)', SANDBOX).verdict).toBe('confirm')
})

test('compound grammar checks conditions, alternate branches and nested case arms', () => {
  const commands = [
    'if gh gist create -p file; then echo ok; fi',
    'if false; then echo no; elif true; then gh gist create -p file; else echo no; fi',
    'while git clean -fd; do echo ok; done; gh gist create -p file',
    'case x in a|b) echo ok;; x) if true; then gh gist create -p file; fi;; esac',
    'case x in x) case y in y) gh gist create -p file;; esac;; esac',
    'function publish() { gh gist create -p file; }; echo ok',
    'time -p { gh gist create -p file; }',
    'coproc worker { gh gist create -p file; }',
    'for f in a; do (if true; then gh gist create -p file; fi); done',
  ]
  for (const sandbox of [false, true]) {
    for (const command of commands) {
      expect(checkCommand(command, { sandbox }).verdict, command).toBe('deny')
    }
  }
})

test('shell syntax in quoted words, escaped words and arguments stays data', () => {
  const commands = [
    'echo if then else for do done case esac coproc !',
    'echo "( rm -rf x )" "{ rm -rf x; }"',
    'echo \\( rm -rf x \\)',
    'echo \\{ rm -rf x \\}',
    'case x in a|b) echo no;; x) echo "rm -rf x";; esac',
    'for f in "rm -rf x" "gh gist create -p file"; do echo "$f"; done',
    'for f in do rm -rf x; do echo "$f"; done',
    'items=(rm -rf x)',
    'case in in in) echo ok;; esac',
    'echo ok # rm -rf x',
  ]
  for (const sandbox of [false, true]) {
    for (const command of commands) {
      expect(checkCommand(command, { sandbox }).verdict, command).toBe('allow')
    }
    expect(checkCommand('echo ok # comment\ngh gist create -p file', { sandbox }).verdict).toBe('deny')
  }
})

test('for/select without in, brace loop bodies and arithmetic headers expose their commands', () => {
  for (const sandbox of [false, true]) {
    expect(checkCommand('for item do gh repo create y --public; done', { sandbox }).verdict).toBe('deny')
    expect(checkCommand('select item do rm -rf y; done', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('for item in x y; { rm -rf y; }', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('for item in x y; { echo $item; }', { sandbox }).verdict).toBe('allow')
    expect(checkCommand('for ((n=0;n<1;n++)) { gh repo create y --public; }', { sandbox }).verdict).toBe('deny')
  }
})

test('a pipeline continued on the next line or after a comment still feeds the shell', () => {
  for (const sandbox of [false, true]) {
    expect(checkCommand('echo "rm -rf y" |\n dash', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('echo y | # note\n bash -s', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('echo "rm -rf y" |&\n zsh', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('echo y |\n wc -l', { sandbox }).verdict).toBe('allow')
  }
})

test('an unreadable loop or case header never silently becomes an allowed command', () => {
  for (const sandbox of [false, true]) {
    for (const command of [
      'for item in a; rm -rf y',
      'select item in a; echo ok',
      'case item rm -rf y',
      'case item; rm -rf y; esac',
      'for item in a; echo ok; done',
    ]) {
      expect(checkCommand(command, { sandbox }).verdict, command).toBe('confirm')
    }
  }
})

test('pipeline stdin follows groups and wrappers but not a shell script or inline program', () => {
  const unreadable = [
    'echo code | { echo ready; /bin/dash; } | cat',
    'echo code | (echo ready; env FLAG=ok timeout -k 1 5 bash)',
    'echo code | if true; then sh; fi',
    'bash -es -- argument',
    'sh <script.sh',
    'printf code | nice --adjustment=5 mksh',
    '( sh ) <<<"code"',
    '{ echo ready; dash; } <script.sh',
    'if true; then sh; fi <<<"code"',
    'bash <<EOF <<<"code"\necho ok\nEOF',
    '{ sh <<<"code"; } <<EOF\necho ok\nEOF',
  ]
  for (const sandbox of [false, true]) {
    for (const command of unreadable) {
      expect(checkCommand(command, { sandbox }), command).toEqual({
        verdict: 'confirm', reason: expect.stringMatching(/^unparseable: .* code from stdin$/),
      })
    }
    for (const command of [
      'echo data | sh script.sh',
      'echo data | bash --version',
      'sh <<EOF\necho ok\nEOF',
      'bash <<<"code" <<EOF\necho ok\nEOF',
      '{ sh <<EOF\necho ok\nEOF\n} <<<"code"',
    ]) {
      expect(checkCommand(command, { sandbox }).verdict, command).toBe('allow')
    }
    expect(checkCommand('sh -s <<EOF\ngh gist create -p file\nEOF', { sandbox }).verdict).toBe('deny')
  }
  expect(checkCommand('echo data | bash -c "echo ok"', SANDBOX).verdict).toBe('allow')
})

test('redirection operands do not become commands and their substitutions are still checked', () => {
  for (const sandbox of [false, true]) {
    expect(checkCommand('echo ok >"rm -rf x"', { sandbox }).verdict).toBe('allow')
    expect(checkCommand('echo ok 2>&1 >/dev/null', { sandbox }).verdict).toBe('allow')
    expect(checkCommand('2>err >out gh gist create -p file', { sandbox }).verdict).toBe('deny')
    expect(checkCommand('{log}>>out gh gist create -p file', { sandbox }).verdict).toBe('deny')
  }
  for (const command of [
    'echo ok >"$(gh gist create -p file)"',
    'for f in $(gh gist create -p file); do echo "$f"; done',
    'case $(gh gist create -p file) in x) echo ok;; esac',
    'items=($(gh gist create -p file))',
    'bash <<< "$(gh gist create -p file)"',
  ]) {
    expect(checkCommand(command, SANDBOX).verdict, command).toBe('deny')
  }
})

test('wrapper options, duration and lock operands preserve the inner finding', () => {
  const prefixes = [
    'timeout --signal TERM --kill-after=1 -- 5',
    'timeout -vk 1 5',
    'nice --adjustment 5',
    'ionice -tc 3',
    'stdbuf --output 0 --error=0',
    'setsid --wait --',
    'flock --timeout 5 /tmp/lock',
    'flock /tmp/lock -w 5 --',
    'timeout 5 nice -n 5 ionice -c3 stdbuf -o0 setsid flock /tmp/lock',
  ]
  for (const sandbox of [false, true]) {
    for (const prefix of prefixes) {
      for (const inner of ['echo ok', 'git clean -fd', 'gh gist create -p file']) {
        expect(checkCommand(`${prefix} ${inner}`, { sandbox }), `${prefix} ${inner}`).toEqual(checkCommand(inner, { sandbox }))
      }
    }
    expect(checkCommand('flock /tmp/lock -c "git clean -fd"', { sandbox }).verdict).toBe('confirm')
    expect(checkCommand('flock -xc "gh gist create -p file" /tmp/lock', { sandbox }).verdict).toBe(sandbox ? 'deny' : 'confirm')
  }
})

test.each([false, true])('heredoc body hashes do not hide command substitutions (sandbox=%s)', (sandbox) => {
  for (const command of [
    'cat > f <<EOF\n# $(rm -rf ~)\nEOF',
    'cat > f <<EOF\n# `rm -rf ~`\nEOF',
  ]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm',
      reason: sandbox ? 'irreversible: recursive rm' : 'unparseable: command substitution',
    })
  }
})

test.each([false, true])('heredoc body keywords cannot swallow commands after the delimiter (sandbox=%s)', (sandbox) => {
  for (const command of [
    'cat <<EOF\nfor the record\nEOF\nrm -rf y',
    'cat <<EOF\nselect an option\nEOF\nrm -rf y',
    'cat <<EOF\ncase notes\nEOF\nrm -rf y',
    "cat <<'EOF'\nfor the record\nEOF\nrm -rf y",
    'cat <<E"OF"\nselect an option\nEOF\nrm -rf y',
    'cat <<-EOF\n\tfor the record\n\tEOF\nrm -rf y',
    'cat <<for\nnotes\nfor\nrm -rf y',
    'cat <<FIRST <<SECOND\nfor the record\nFIRST\ncase notes\nSECOND\nrm -rf y',
  ]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm', reason: 'irreversible: recursive rm',
    })
  }
})

test.each([false, true])('heredoc body keeps legacy command checks without changing surrounding frames (sandbox=%s)', (sandbox) => {
  expect(checkCommand('sh <<EOF\necho ok; rm -rf x\nEOF', { sandbox }).verdict).toBe('confirm')
  expect(checkCommand('cat <<EOF\n# notes\nfor the record\ncase notes\nEOF', { sandbox }).verdict).toBe('allow')
  expect(checkCommand('case x in x) cat <<EOF\nfor the record\nfi\nesac\nEOF\n;; y) gh gist create -p file;; esac', { sandbox }).verdict).toBe('deny')
  expect(checkCommand('cat <<EOF\nfor the record\nEOF\n# rm -rf x\necho ok', { sandbox }).verdict).toBe('allow')
})

test.each([false, true])('heredoc detection does not consume code after an arithmetic shift (sandbox=%s)', (sandbox) => {
  expect(checkCommand('((1 << 2))\nif true; then gh gist create -p file; fi', { sandbox }).verdict).toBe('deny')
  expect(checkCommand('for ((i=0; i<1<<2; i++)); do echo ok; done\nif true; then gh gist create -p file; fi', { sandbox }).verdict).toBe('deny')
})

test.each([false, true])('heredoc delimiter quote removal retains literal backslashes (sandbox=%s)', (sandbox) => {
  expect(checkCommand('cat <<"E\\OF"\nfor the record\nE\\OF\nif true; then gh gist create -p file; fi', { sandbox }).verdict).toBe('deny')
})

test.each([false, true])('review regression: heredoc bodies preserve the pending pipeline into a shell (sandbox=%s)', (sandbox) => {
  for (const command of [
    "cat <<'EOF' |\n{ rm -rf x; }\nEOF\nsh",
    ': <<EOF; echo "rm -rf x" |\nEOF\nsh',
    'cat <<EOF |& # pipeline continues\nfor the record\nEOF\n# still in the pipeline\nbash',
    'cat <<FIRST <<SECOND |\ncase notes\nFIRST\nfor the record\nSECOND\nsh | cat',
  ]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm', reason: expect.stringMatching(/^unparseable: .* code from stdin$/),
    })
  }

  // The body is data for the producer; it neither becomes the pipe target nor
  // changes stdin for a later command after a completed pipeline.
  for (const command of [
    "cat <<'EOF' |\n{ rm -rf x; }\nEOF\ncat",
    'cat <<EOF |\nfor the record\nEOF\ncat; sh',
    'cat <<EOF |\nfor the record\nEOF\nsh script.sh',
  ]) {
    expect(checkCommand(command, { sandbox }).verdict, command).toBe('allow')
  }
})

test.each([false, true])('review regression: malformed loop and case tails require confirmation even when closed (sandbox=%s)', (sandbox) => {
  for (const command of [
    'for f in a; rm -rf z; do echo; done',
    'select f in a; rm -rf z; do echo; done',
    'for f in a\nrm -rf z\ndo echo; done',
    'for f in a && rm -rf z; do echo; done',
    'for f rm -rf z; do echo; done',
    'case x rm -rf y in a) echo;; esac',
    'case x; rm -rf y in a) echo;; esac',
    'case x in a; rm -rf y; esac',
    'case x in a && rm -rf y; esac',
    'case x in a || rm -rf y; esac',
    'case x in a & rm -rf y; esac',
    'case x in a\nrm -rf y; esac',
    'case x in a |\nrm -rf y; esac',
    'case x in a rm -rf y) echo;; esac',
    'case x in a|) echo;; esac',
    'case x in a esac',
  ]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm', reason: expect.stringMatching(/^unparseable:/),
    })
  }

  // Newlines before a pattern or the loop body are valid shell whitespace;
  // pattern alternatives and list elements remain data.
  for (const command of [
    'for f in rm -rf z;\n do echo "$f"; done',
    'select f in a b;\n { echo "$f"; }',
    'case x in\n a|b) echo ok;;\n x) echo yes;;\n esac',
    'case x\n in\n (a|b) echo ok;;\n esac',
  ]) {
    expect(checkCommand(command, { sandbox }).verdict, command).toBe('allow')
  }
})

test.each([false, true])('review regression: malformed pipeline boundaries cannot discard a pending target (sandbox=%s)', (sandbox) => {
  for (const command of [
    'echo x |; cat',
    'echo x |&& cat',
    'echo x |& ; cat',
    'echo x ||| cat',
    '| cat',
    'cat <<EOF |\nEOF\n; cat',
  ]) {
    expect(checkCommand(command, { sandbox }), command).toEqual({
      verdict: 'confirm', reason: expect.stringMatching(/^unparseable:/),
    })
  }
  for (const command of ['echo x |\n(cat)', 'echo x |\n{ cat; }', '>out | cat']) {
    expect(checkCommand(command, { sandbox }).verdict, command).toBe('allow')
  }
})

test.each([false, true])('review regression: prototype property names are ordinary commands, not interpreters (sandbox=%s)', (sandbox) => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    for (const command of [`${name} -x`, `cat x | ${name}`, `${name} < x`]) {
      expect(checkCommand(command, { sandbox }), command).toEqual(checkCommand(command.replace(name, 'frobnicate'), { sandbox }))
    }
  }
})

test.each([false, true])('review regression: env -S keeps the words after its value and the stdin of the wrapper (sandbox=%s)', (sandbox) => {
  for (const [wrapped, bare] of [
    ['env -S "rm" -rf /tmp/x', 'rm -rf /tmp/x'],
    ['env -S"rm -r" /tmp/x', 'rm -r /tmp/x'],
    ['env --split-string="rm" -r /tmp/x', 'rm -r /tmp/x'],
    ['env -S "rm -rf" "$X"', 'rm -rf "$X"'],
    ['env -S "python3.12" -c 1', 'python3.12 -c 1'],
    ['env -S "echo" "a b" c', 'echo "a b" c'],
    ['cat x | env -S "sh"', 'cat x | sh'],
    ['env -S "sh" < x.sh', 'sh < x.sh'],
    ['cat x | env -S "python3"', 'cat x | python3'],
    ['env FOO=1 -S "rm -rf /tmp/x"', 'rm -rf /tmp/x'],
    ['env -i -S "python3 -c 1"', 'python3 -c 1'],
    ['env -S "deno" --allow-all eval 1', 'deno --allow-all eval 1'],
    ['cat x | busybox sh', 'cat x | sh'],
    ['busybox sh < x.sh', 'sh < x.sh'],
    ['busybox rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['busybox sh -c id', 'sh -c id'],
    ['env -S "rm # comment" -rf /tmp/x', 'rm -rf /tmp/x'],
    ["env -S \"rm\" -rf '/tmp/x;y'", "rm -rf '/tmp/x;y'"],
    ["env -S \"rm\" -rf '/tmp/x # y'", "rm -rf '/tmp/x # y'"],
    ["env -S \"echo\" 'a|sh'", "echo 'a|sh'"],
    ["env -S \"sh -c 'rm -rf /tmp/x'\"", "sh -c 'rm -rf /tmp/x'"],
    ['env -S "rm\\_-rf /tmp/x"', 'rm -rf /tmp/x'],
  ]) {
    expect(checkCommand(wrapped, { sandbox }), wrapped).toEqual(checkCommand(bare, { sandbox }))
  }
  expect(checkCommand('env -S "rm" -rf /tmp/x', { sandbox })).toEqual({ verdict: 'confirm', reason: 'irreversible: recursive rm' })
  expect(checkCommand('cat x | env -S "sh"', { sandbox })).toEqual({ verdict: 'confirm', reason: 'unparseable: sh code from stdin' })
  expect(checkCommand('env -S "rm # comment" -rf /tmp/x', { sandbox })).toEqual({ verdict: 'confirm', reason: 'irreversible: recursive rm' })
  // A shell operator in a tail word is part of that word, not a new command.
  expect(checkCommand("env -S \"echo\" 'a;rm -rf /tmp/x'", { sandbox })).toEqual(checkCommand('echo x', { sandbox }))
})

test.each([false, true])('review regression: git config-env values are as opaque as -c values (sandbox=%s)', (sandbox) => {
  expect(checkCommand('git --config-env=core.pager=PAGER log', { sandbox }).verdict, 'exec key').toBe(
    sandbox ? 'allow' : 'confirm',
  )
  expect(checkCommand('git --config-env=alias.x=ALIAS x', { sandbox }).verdict, 'alias key').toBe(
    sandbox ? 'allow' : 'confirm',
  )
  expect(checkCommand('git --config-env=user.name=NAME log', { sandbox }).verdict, 'plain key').toBe('allow')
})

test.each([
  ['git -C "$d" log -1', 'allow', 'allow'],
  ['git -C "$d" clean -fdx', 'confirm', 'confirm'],
  ['git -C "$d" -c core.pager=less log', 'confirm', 'allow'],
  ['git -C "$d" log $REV', 'confirm', 'confirm'],
  ['git -C "$d$(pwd)" status', 'confirm', 'confirm'],
  ["awk '{print $1}' data.txt", 'allow', 'allow'],
  ['awk "{print $1}" f', 'confirm', 'allow'],
  ["$'\\x72m' -rf /tmp/x", 'confirm', 'confirm'],
  ['printf "print(1)" | python3', 'confirm', 'allow'],
  ['python3 -V - < x.py', 'confirm', 'allow'],
  ['node --inspect script.js < input', 'allow', 'allow'],
  ['node --inspect < code.js', 'confirm', 'allow'],
  ["awk 'BEGIN {system(\"echo x\")}'", 'confirm', 'allow'],
  ["sed '1e echo x' file", 'confirm', 'allow'],
  ['php8.2 -r "echo 1;"', 'confirm', 'allow'],
])('host and sandbox retain interpreter and quoting boundaries: %s', (command, host, sandbox) => {
  expect(checkCommand(command, { sandbox: false }).verdict).toBe(host)
  expect(checkCommand(command, { sandbox: true }).verdict).toBe(sandbox)
})

test('a protected parent symlink cannot make existing or new writes unprotected', () => {
  withTempRepo((root) => {
    mkdirSync(join(root, '.github'), { recursive: true })
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'ci.yml'), 'ordinary docs\n')
    symlinkSync('../docs', join(root, '.github', 'workflows'))
    expect(isProtected('.github/workflows/ci.yml', root)).toBe(true)
    expect(isProtected('.github/workflows/new.yml', root)).toBe(true)
    expect(isProtected('docs/ci.yml', root)).toBe(false)
  })
})
