import { expect, test } from 'vitest'
import { checkCommand } from './index.js'

const HOST = { sandbox: false }
const SANDBOX = { sandbox: true }

function expectUnparseable(commands: readonly string[]): void {
  for (const command of commands) {
    const result = checkCommand(command, HOST)
    expect(result.verdict, `host: ${command}`).toBe('confirm')
    expect(result.reason.startsWith('unparseable:'), `host reason: ${command}: ${result.reason}`).toBe(true)
  }
}

function expectHostAllow(commands: readonly string[]): void {
  for (const command of commands) {
    expect(checkCommand(command, HOST).verdict, `host: ${command}`).toBe('allow')
  }
}

function expectSandboxAllow(commands: readonly string[]): void {
  for (const command of commands) {
    expect(checkCommand(command, SANDBOX).verdict, `sandbox: ${command}`).toBe('allow')
  }
}

const C1_CODE = [
  'python3.12 -c "import os"',
  'python3.11 -c 1',
  'pypy3.10 -c 1',
  'node22 -e 1',
  'perl5.38 -e 1',
  'ruby3.3 -e 1',
  '/usr/bin/python3.12 -c 1',
  'cat x | python3.12',
  'node22 < x.js',
]
const C1_PLAIN = ['python3.12 script.py', 'cat x | python3.12 script.py', 'node22 script.js']

const C2_CODE = [
  'php -r "system(1);"',
  'cat x | php',
  'lua -e "os.execute(1)"',
  'luajit -e 1',
  'cat x | lua -',
  'deno eval "1"',
  'cat x | deno run -',
  'bun -e "1"',
  'bun --eval "1"',
  'Rscript -e "system(1)"',
  'cat x | Rscript -',
  'tclsh <<< "exec id"',
  'cat x | tclsh',
]
const C2_PLAIN = ['php script.php', 'lua script.lua', 'deno run script.ts', 'bun run build', 'Rscript script.R', 'tclsh script.tcl']

const C3_CODE = [
  'awk "BEGIN{system(\\"id\\")}"',
  'gawk "BEGIN{system(\\"id\\")}"',
  'mawk "{print | \\"sh\\"}" x',
  'awk "BEGIN{\\"id\\" | getline v}"',
  'awk "{print > \\"/tmp/out\\"}" x',
  'busybox awk "BEGIN{system(\\"id\\")}"',
]
const C3_PLAIN = ['awk -F: "{print NF}" x', 'awk "NR==1" x', 'gawk "{s+=NF} END{print s}" x']

const C4_CODE = ['sed -n "1e id" x', 'sed "s/a/b/e" x', 'sed "1w /tmp/out" x', 'sed "s/a/b/w /tmp/out" x']
const C4_PLAIN = ['sed -n 1p x', 'sed "s/a/b/g" x', 'sed -n "/err/p" x']

const C5_WRAPPERS = ['env -S "python3 -c 1"', 'busybox sh -c id']
const C5_GIT_VIM = [
  'git -c core.pager=id log',
  'git -c core.sshCommand=id fetch',
  'git -c alias.x=!id x',
  'git -c diff.external=id diff',
  'vim -c "!id"',
  'vim +"!id" x',
  'nvim -c "!id"',
]
const C5_PLAIN = ['git -c user.name=x log', 'vim x']

test('test_c1_versioned_interpreters_with_code_need_confirmation_on_host', () => {
  expectUnparseable(C1_CODE)
  expectHostAllow(C1_PLAIN)
})

test('test_c2_php_lua_deno_bun_r_tcl_code_needs_confirmation_on_host', () => {
  expectUnparseable(C2_CODE)
  expectHostAllow(C2_PLAIN)
})

test('test_c3_awk_programs_that_run_commands_or_write_need_confirmation_on_host', () => {
  expectUnparseable(C3_CODE)
  expectHostAllow(C3_PLAIN)
})

test('test_c4_sed_execute_and_write_commands_need_confirmation_on_host', () => {
  expectUnparseable(C4_CODE)
  expectHostAllow(C4_PLAIN)
})

test('test_c5_wrappers_git_config_and_editor_commands_need_confirmation_on_host', () => {
  expectUnparseable([...C5_WRAPPERS, ...C5_GIT_VIM])
  expectHostAllow(C5_PLAIN)
})

test('test_c6_busybox_and_env_s_wrappers_give_the_verdict_of_the_bare_command', () => {
  const pairs: Array<[string, string]> = [
    ['busybox sh -c "rm -rf /tmp/x"', 'sh -c "rm -rf /tmp/x"'],
    ['busybox rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['env -S "rm -rf /tmp/x"', 'rm -rf /tmp/x'],
    ['env -S "python3 -c 1"', 'python3 -c 1'],
    ['busybox ls', 'ls'],
    ['env FOO=1 ls', 'ls'],
  ]
  for (const [options, mode] of [
    [HOST, 'host'],
    [SANDBOX, 'sandbox'],
  ] as const) {
    for (const [wrapped, bare] of pairs) {
      const got = checkCommand(wrapped, options)
      const want = checkCommand(bare, options)
      expect(got.verdict, `${mode}: ${wrapped}`).toBe(want.verdict)
      expect(got.reason, `${mode} reason: ${wrapped}`).toBe(want.reason)
    }
  }
  // the bare commands themselves keep the verdicts the task names
  expect(checkCommand('sh -c "rm -rf /tmp/x"', SANDBOX).verdict).toBe('confirm')
  expect(checkCommand('python3 -c 1', HOST).verdict).toBe('confirm')
  expect(checkCommand('ls', HOST).verdict).toBe('allow')
})

test('test_c7_sandbox_keeps_allowing_inline_code_and_git_vim_config', () => {
  expectSandboxAllow([
    'python3 -c "print(1)"',
    ...C1_CODE,
    ...C1_PLAIN,
    ...C2_CODE,
    ...C2_PLAIN,
    ...C3_CODE,
    ...C3_PLAIN,
    ...C4_CODE,
    ...C4_PLAIN,
    ...C5_GIT_VIM,
    ...C5_PLAIN,
  ])
})
