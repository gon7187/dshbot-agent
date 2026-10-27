// Deterministic guard rails for the bot.
//
// Everything here is pure and dependency-free so the charter floor can be
// enforced by code instead of by prompt text: model cost accounting, shell
// command classification, protected-path checks and the panic exit code.

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Exit code used by /panic: systemd is configured not to restart on it. */
export const PANIC_EXIT_CODE = 77

// ---------------------------------------------------------------------------
// Cost accounting
// ---------------------------------------------------------------------------

/** Token usage of one model call. `inputTokens` excludes cached tokens. */
export interface TokenUsage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** Price in US dollars per 1M tokens. */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type PriceTable = Readonly<Record<string, ModelPrice>>

/**
 * Default prices, USD per 1M tokens. Source: the DeepSeek model catalog of the
 * OpenClaw plugin, October 2026.
 */
export const DEFAULT_PRICES: PriceTable = Object.freeze({
  'deepseek-flash': Object.freeze({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }),
  'deepseek-v4-flash': Object.freeze({ input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 }),
  'deepseek-v4-pro': Object.freeze({ input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 }),
})

const TOKENS_PER_MILLION = 1_000_000

function priceFor(prices: PriceTable, model: string): ModelPrice | undefined {
  // hasOwnProperty keeps names such as "constructor" from resolving through
  // the prototype chain to something that is not a price row.
  return Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined
}

/**
 * Cost of one model call in US dollars.
 *
 * Returns `null` when the model is missing from the price table: an unknown
 * price is never treated as zero.
 */
export function costOf(model: string, usage: TokenUsage, prices: PriceTable = DEFAULT_PRICES): number | null {
  const price = priceFor(prices, model)
  if (price === undefined) return null

  const cost =
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.outputTokens * price.output) /
    TOKENS_PER_MILLION

  return Number.isFinite(cost) ? cost : null
}

// ---------------------------------------------------------------------------
// Shell command classification
// ---------------------------------------------------------------------------

export type CommandVerdict = 'allow' | 'confirm' | 'deny'

export interface CommandCheck {
  verdict: CommandVerdict
  reason: string
}

export interface CommandCheckOptions {
  /**
   * True when the command runs inside the bwrap sandbox of exec: its own
   * process space, and writes only to the workspace and the owner's read-write
   * roots. There unreadable syntax alone is no reason for a card, except shell
   * code supplied through stdin: its source cannot be inspected here.
   * kill/pkill/killall only reach that process space, and the text
   * nested in `bash -c`, `$(…)`, backticks, `find -exec`, `eval` and `xargs` is
   * judged by the same rules. The default is the host, with the old strict
   * rules.
   */
  sandbox?: boolean
}

interface Finding {
  verdict: CommandVerdict
  reason: string
  unparseable?: boolean
}

const VERDICT_RANK: Record<CommandVerdict, number> = {
  allow: 0,
  confirm: 1,
  deny: 2,
}

const SQL_DROP = /\bDROP\s+(?:TABLE|DATABASE)\b/i

/** Service managers whose stop/restart verbs interrupt a running service. */
const SERVICE_MANAGERS = new Set(['systemctl', 'service', 'rc-service', 'rcctl'])

/** Verbs of a service manager that stop, restart or power down the machine. */
const SERVICE_DANGER_VERBS = new Set([
  'stop',
  'restart',
  'try-restart',
  'reload-or-restart',
  'reload-or-try-restart',
  'condrestart',
  'force-reload',
  'reboot',
  'poweroff',
  'halt',
  'kexec',
  'emergency',
  'rescue',
  'kill',
])

/** Commands that power the machine down or reboot it. */
const POWER_COMMANDS = new Set(['reboot', 'shutdown', 'poweroff', 'halt', 'kexec'])

/** Commands that kill processes of the machine. */
const KILL_COMMANDS = new Set(['kill', 'killall', 'pkill', 'skill'])
// `private=false`, `private: false`, `"private": false`, `visibility=public`.
const PUBLICATION_FIELD = /(?:private|visibility)["']?\s*[=:]\s*["']?(?:false|public)\b/i
const PAGES_ENDPOINT = /(?:^|\/)pages(?:\/|$|\?|#)/

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const STDIN_SHELLS = new Set([...SHELLS, 'ash', 'mksh', 'ksh93', 'yash', 'csh', 'tcsh', 'rbash'])
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'builtin', 'nohup', 'time', 'exec', 'xargs',
  'timeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'flock',
  // `busybox <applet> ...` runs the applet with the remaining arguments.
  'busybox',
])

/** Interpreters that can run inline code supplied on the command line. */
const INTERPRETER_EVAL_FLAGS = new Map<string, RegExp>([
  ['python', /^-[A-Za-z]*c[A-Za-z]*$/],
  ['python2', /^-[A-Za-z]*c[A-Za-z]*$/],
  ['python3', /^-[A-Za-z]*c[A-Za-z]*$/],
  ['pypy', /^-[A-Za-z]*c[A-Za-z]*$/],
  ['pypy3', /^-[A-Za-z]*c[A-Za-z]*$/],
  ['node', /^-[A-Za-z]*[ep][A-Za-z]*$/],
  ['nodejs', /^-[A-Za-z]*[ep][A-Za-z]*$/],
  ['perl', /^-[A-Za-z]*[eE][A-Za-z]*$/],
  ['ruby', /^-[A-Za-z]*e[A-Za-z]*$/],
  ['php', /^-[A-Za-z]*[rR][A-Za-z]*$/],
  ['lua', /^-[A-Za-z]*e[A-Za-z]*$/],
  ['luajit', /^-[A-Za-z]*e[A-Za-z]*$/],
  ['bun', /^-[A-Za-z]*e[A-Za-z]*$/],
  ['Rscript', /^-[A-Za-z]*e[A-Za-z]*$/],
])
const INTERPRETER_EVAL_LONG_FLAGS = new Set(['--eval', '--print'])

/**
 * Interpreters that read their program from stdin when no script operand is
 * given (or when the operand is `-`). Code supplied that way is as opaque as
 * `-c`, so the host asks for a card.
 */
const STDIN_CODE_INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'pypy', 'pypy3',
  'node', 'nodejs', 'perl', 'ruby',
  'php', 'lua', 'luajit', 'deno', 'bun', 'Rscript', 'tclsh',
])

/** Commands that run `awk` programs; a program can call system() or pipes. */
const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/** Editors whose `-c`/`+` command line can invoke a shell (`!cmd`). */
const EDITOR_COMMANDS = new Set(['vim', 'nvim', 'vi', 'view', 'vimdiff', 'gvim', 'mvim'])

/**
 * Git configuration keys whose value names a program git runs for the user
 * (`git -c core.pager=… log`). `alias.*` is handled separately: only a `!`
 * alias is a shell command.
 */
const GIT_EXEC_CONFIG_KEY = new RegExp(
  [
    /^core\.(?:pager|sshcommand|editor|fsmonitor|askpass|hookspath|gitproxy)$/,
    /^diff\.external$/,
    /^diff\..+\.(?:command|textconv)$/,
    /^filter\..+\.(?:clean|smudge|process)$/,
    /^gpg\.(?:.*\.)?program$/,
    /^credential(?:\..+)?\.helper$/,
    /^sequence\.editor$/,
    /^pager\..+$/,
    /^(?:diff|merge)tool\..+\.(?:cmd|path)$/,
    /^man\.viewer$/,
    /^web\.browser$/,
    /^browser\..+\.(?:cmd|path)$/,
    /^help\.browser$/,
    /^interactive\.difffilter$/,
    /^tar\.(?:cmd|.*command)$/,
  ]
    .map((pattern) => pattern.source)
    .join('|'),
)

/** Python-family interpreters, whose `-m` selects a module and leaves stdin as data. */
const PYTHON_INTERPRETERS = new Set(['python', 'python2', 'python3', 'pypy', 'pypy3'])

/**
 * Interpreter options whose value is a separate word. That word is not the
 * program file: `python3 -W ignore` and `node -r ./x.js` still take their
 * program from stdin. A value attached to the option (`-Wignore`, `-Ilib`) is
 * part of the same flag and consumes nothing.
 */
const NODE_VALUE_FLAGS = [
  '-r', '-C', '--require', '--conditions', '--import', '--loader', '--experimental-loader',
  '--allow-fs-read', '--allow-fs-write', '--build-sea', '--build-snapshot-config',
  '--cpu-prof-dir', '--cpu-prof-interval', '--cpu-prof-name', '--debug-port', '--diagnostic-dir',
  '--disable-proto', '--disable-warning', '--dns-result-order', '--env-file',
  '--env-file-if-exists', '--experimental-config-file', '--experimental-package-map',
  '--experimental-sea-config', '--experimental-test-tag-filter', '--heap-prof-dir',
  '--heap-prof-interval', '--heap-prof-name', '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal', '--icu-data-dir', '--input-type',
  '--inspect-port', '--inspect-publish-uid', '--localstorage-file',
  '--max-http-header-size', '--max-old-space-size', '--max-old-space-size-percentage',
  '--network-family-autoselection-attempt-timeout', '--openssl-config', '--redirect-warnings',
  '--report-dir', '--report-directory', '--report-filename', '--report-signal', '--secure-heap',
  '--secure-heap-min', '--snapshot-blob', '--test-concurrency', '--test-coverage-branches',
  '--test-coverage-exclude', '--test-coverage-functions', '--test-coverage-include',
  '--test-coverage-lines', '--test-global-setup', '--test-isolation', '--test-name-pattern',
  '--test-random-seed', '--test-reporter', '--test-reporter-destination',
  '--test-rerun-failures', '--test-shard', '--test-skip-pattern', '--test-timeout', '--title',
  '--tls-cipher-list', '--tls-keylog', '--trace-event-categories', '--trace-event-file-pattern',
  '--trace-require-module', '--unhandled-rejections', '--use-largepages', '--v8-pool-size',
  '--watch-kill-signal', '--watch-path',
]

const INTERPRETER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  python: new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']),
  python2: new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']),
  python3: new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']),
  pypy: new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']),
  pypy3: new Set(['-W', '-X', '-Q', '--check-hash-based-pycs']),
  node: new Set(NODE_VALUE_FLAGS),
  nodejs: new Set(NODE_VALUE_FLAGS),
  perl: new Set(['-I', '-M', '-m']),
  ruby: new Set([
    '-I', '-r', '-C', '-E', '--encoding', '--external-encoding', '--internal-encoding',
  ]),
}

/** `find` actions that delete files or run arbitrary programs. */
const FIND_DANGEROUS_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])

/**
 * Commands whose arguments can turn into destructive flags or operands when a
 * variable expands. They accept flags after operands (`rm build $FLAGS`) and
 * actions after paths (`find . $ARGS`), so a variable anywhere in the argument
 * list must not stay `allow`.
 */
const VARIABLE_SENSITIVE_COMMANDS = new Set(['rm', 'find', 'xargs', 'git', 'gh'])

/** A shell variable or positional parameter expansion such as `$FLAGS` or `${DIR}`. */
const EXPANDS_VARIABLE = /\$(?:[A-Za-z_0-9{(]|[@*#?$!-])/
// Wrapper flags whose value is a separate token, e.g. `sudo -u root cmd`.
const SUDO_VALUE_FLAGS = new Set([
  '-u',
  '-g',
  '-p',
  '-C',
  '-h',
  '-U',
  '-r',
  '-t',
  '--user',
  '--group',
  '--prompt',
  '--close-from',
  '--host',
  '--other-user',
  '--role',
  '--type',
])
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string'])
// xargs flags whose value is a separate token, e.g. `xargs -I {} rm`.
const XARGS_VALUE_FLAGS = new Set([
  '-I',
  '-n',
  '-P',
  '-L',
  '-s',
  '-a',
  '-d',
  '-E',
  '--arg-file',
  '--delimiter',
  '--eof',
  '--max-args',
  '--max-chars',
  '--max-lines',
  '--max-procs',
  '--process-slot-var',
  '--replace',
])

const EXTRA_WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  flock: new Set(['-w', '--wait', '--timeout', '-E', '--conflict-exit-code']),
}

interface ShellToken {
  text: string
  operator: boolean
  heredocBody: boolean
}

/** Heredoc words undergo quote removal; double quotes retain most backslashes. */
function heredocDelimiter(word: string): string {
  return word.replace(
    /"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/gs,
    (_match, double: string | undefined, single: string | undefined, escaped: string | undefined) =>
      double !== undefined ? double.replace(/\\([$`"\\])/g, '$1') : single ?? escaped ?? '',
  )
}

/** Lex operators separately, retaining raw quoting to distinguish words from keywords. */
function shellTokens(command: string, heredocBody = false): { tokens: ShellToken[]; balanced: boolean } {
  const tokens: ShellToken[] = []
  let current = ''
  let quote: '"' | "'" | 'ansi' | null = null
  const heredocs: { delimiter: string; stripTabs: boolean }[] = []
  let delimiterStripTabs: boolean | undefined
  let bodiesBalanced = true
  let arithmeticEnd = -1

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push({ text: current, operator: false, heredocBody })
      if (delimiterStripTabs !== undefined) {
        // A heredoc delimiter undergoes quote removal, not expansion.
        heredocs.push({ delimiter: heredocDelimiter(current), stripTabs: delimiterStripTabs })
        delimiterStripTabs = undefined
      }
    }
    current = ''
  }

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]

    if (quote === "'") {
      current += ch
      if (ch === "'") quote = null
      continue
    }

    // ANSI-C quoting keeps every character except its own escapes, so a `\'`
    // does not close `$'…'`. Keep the raw text for the word tokenizer, which
    // decodes it later exactly like the shell does.
    if (quote === 'ansi') {
      current += ch
      if (ch === '\\' && i + 1 < command.length) {
        current += command[i + 1]
        i += 1
      } else if (ch === "'") {
        quote = null
      }
      continue
    }

    const end = substitutionEnd(command, i, quote === null)
    if (end !== -1) {
      current += command.slice(i, end + 1)
      i = end
      continue
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < command.length) {
        // Backslash-newline is a line continuation inside double quotes too.
        if (command[i + 1] === '\n') {
          i += 1
          continue
        }
        current += ch + command[i + 1]
        i += 1
      } else {
        current += ch
        if (ch === '"') quote = null
      }
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }

    // `$'…'` is an ANSI-C string and `$"…"` is a locale string. Both prefixes
    // are syntax, not part of the word: record the quote that follows.
    if (ch === '$' && command[i + 1] === "'") {
      quote = 'ansi'
      current += ch + command[i + 1]
      i += 1
      continue
    }
    if (ch === '$' && command[i + 1] === '"') {
      quote = '"'
      current += ch + command[i + 1]
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < command.length) {
      // A backslash-newline is removed by the shell: the command continues.
      if (command[i + 1] === '\n') {
        i += 1
        continue
      }
      if (command[i + 1] === '\r' && command[i + 2] === '\n') {
        i += 2
        continue
      }
      current += ch + command[i + 1]
      i += 1
      continue
    }

    if (ch === ' ' || ch === '\t') {
      flush()
      continue
    }

    // Hashes in heredoc data are literal, so they must not hide expansions.
    if (!heredocBody && ch === '#' && current.length === 0) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1
      continue
    }

    // Parentheses in an array assignment are data, not a subshell. Preserve
    // substitutions within the value for the usual nested-code checks.
    if (!heredocBody && ch === '(' && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(current)) {
      const read = readParens(command, i + 1)
      current += command.slice(i, read.end + 1)
      i = read.end
      continue
    }

    // `<<` in ((...)) is a shift, not a pending heredoc on the next line.
    if (!heredocBody && ch === '(' && command[i + 1] === '(' && i > arithmeticEnd) {
      arithmeticEnd = readParens(command, i + 1).end
    }

    // Preserve the old simple-command checks inside heredoc text. Its words,
    // parentheses and redirections must not change the surrounding grammar.
    const operator = (heredocBody
      ? /^(?:&&|\|\||[;&|\n\r])/
      : /^(?:;;&|<<<|<<-|&>>|&&|\|\||\|&|;;|;&|<<|>>|<&|>&|<>|>\||&>|[;&|()<>\n\r])/
    ).exec(command.slice(i))?.[0]
    if (operator !== undefined) {
      // A descriptor belongs to its redirection only when it is unquoted and
      // adjacent: `2>out`, but not `"2">out` or `echo 2 >out`.
      const descriptor = /^[<>]/.test(operator) && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(current) ? current : ''
      if (descriptor !== '') current = ''
      flush()
      tokens.push({ text: descriptor + operator, operator: true, heredocBody })
      i += operator.length - 1
      if (i > arithmeticEnd && (operator === '<<' || operator === '<<-')) delimiterStripTabs = operator === '<<-'

      if ((operator === '\n' || operator === '\r') && heredocs.length > 0) {
        if (operator === '\r' && command[i + 1] === '\n') i += 1
        const start = i + 1
        let end = start
        for (const { delimiter, stripTabs } of heredocs) {
          while (end < command.length) {
            const newline = command.indexOf('\n', end)
            const lineEnd = newline === -1 ? command.length : newline
            let line = command.slice(end, lineEnd).replace(/\r$/, '')
            if (stripTabs) line = line.replace(/^\t+/, '')
            end = newline === -1 ? command.length : newline + 1
            if (line === delimiter) break
          }
        }
        // Include delimiter lines in the legacy checks too, but keep every
        // body token separate from the outer compound-command state.
        const body = shellTokens(command.slice(start, end), true)
        for (const token of body.tokens) tokens.push(token)
        bodiesBalanced = bodiesBalanced && body.balanced
        heredocs.length = 0
        i = end - 1
      }
      continue
    }

    current += ch
  }

  flush()
  return { tokens, balanced: quote === null && bodiesBalanced }
}

interface ShellPart {
  /** Original words, including redirection targets, for expansion checks. */
  text: string
  /** Command/argument words only; redirections cannot hide the executable. */
  words: string[]
  pipedInput: boolean
  /** Last stdin redirect in the innermost scope wins over inherited input. */
  input?: { source: 'hereString' | 'heredoc' | 'file'; depth: number }
}

interface ShellFrame {
  kind: 'group' | 'if' | 'loop' | 'case'
  pipedInput: boolean
  partStart: number
  phase?: 'header' | 'pattern' | 'body'
  headerBoundary?: boolean
  subjectSeen?: boolean
  /** Loop header: the iteration variable has been seen. */
  loopNameSeen?: boolean
  /** Loop header: the `in` word of a for/select list has been seen. */
  loopInSeen?: boolean
  /** Case pattern: a word has been seen since the last alternative separator. */
  patternWordSeen?: boolean
}

/**
 * Flatten shell control flow into simple commands without executing it. Every
 * branch/body is checked, including branches a shell would never reach. Only
 * unquoted words in grammar positions are keywords: `{}` in xargs/find and
 * brace expansion in an argument remain ordinary words.
 */
function splitTopLevel(command: string): { parts: ShellPart[]; balanced: boolean; grammarIssue?: string } {
  const { tokens, balanced } = shellTokens(command)
  const parts: ShellPart[] = []
  const frames: ShellFrame[] = []
  let grammarIssue: string | undefined
  // A `|`/`|&` at the end of a line keeps the pipeline open: newlines and
  // comments between the operator and its target are not command boundaries.
  let pendingPipe = false
  const makePart = (pipedInput: boolean): ShellPart => ({
    text: '', words: [], pipedInput,
  })
  let part = makePart(false)
  let closedParts: ShellPart[] | undefined
  const inheritedPipe = (): boolean => frames.some((frame) => frame.pipedInput)
  const flush = (): void => {
    if (part.text.length > 0) parts.push(part)
    part = makePart(inheritedPipe())
  }
  const appendRaw = (text: string, target = part): void => {
    target.text += (target.text.length === 0 ? '' : ' ') + text
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const { text, operator, heredocBody } = tokens[i]
    const frame = frames.at(-1)

    if (heredocBody) {
      // Retain the pre-compound-parser checks of each body command without
      // treating prose such as "for the record" as an unfinished shell loop.
      // Use separate parts: body delimiters must not flush the outer command
      // or reset its pending pipeline, inherited input or closed group.
      let bodyPart = makePart(false)
      for (; i < tokens.length && tokens[i].heredocBody; i += 1) {
        const token = tokens[i]
        if (token.operator) {
          if (bodyPart.text.length > 0) parts.push(bodyPart)
          bodyPart = makePart(false)
        } else {
          appendRaw(token.text, bodyPart)
          bodyPart.words.push(token.text)
        }
      }
      if (bodyPart.text.length > 0) parts.push(bodyPart)
      i -= 1
      continue
    }

    // for/select headers and case subjects/patterns contain data, not commands.
    // Keep that text for substitution checks but never treat list/pattern words
    // as executable names. A nested case has its own independent frame.
    if (frame?.phase === 'header') {
      // The arithmetic form `for ((…))` has its own header grammar: everything
      // up to the matching `))` is data, and the body may start after it with
      // `do` or with a brace group.
      if (frame.kind === 'loop' && frame.loopNameSeen !== true && text === '(' && tokens[i + 1]?.text === '(') {
        let depth = 0
        let closeIndex = -1
        for (let j = i; j < tokens.length; j += 1) {
          const token = tokens[j]
          appendRaw(token.text)
          if (!token.operator) continue
          if (token.text === '(') depth += 1
          else if (token.text === ')') {
            depth -= 1
            if (depth === 0) {
              closeIndex = j
              break
            }
          }
        }
        flush()
        if (closeIndex === -1) {
          grammarIssue ??= 'unparseable: unclosed arithmetic for header'
          i = tokens.length
        } else {
          i = closeIndex
          frame.loopNameSeen = true
          frame.headerBoundary = true
        }
        continue
      }

      if (frame.kind === 'case') {
        if (!operator && text === 'esac') {
          // `esac` before `in` means the header never ended: the rest of the
          // line was not case data and must not be swallowed silently.
          grammarIssue ??= 'unparseable: malformed case header'
          flush()
          frames.pop()
          continue
        }
        if (!operator && text === 'in' && frame.subjectSeen) {
          flush()
          frame.phase = 'pattern'
          continue
        }
        // A case header has one subject followed by `in`, not an arbitrary
        // tail that could contain commands or control operators.
        if (operator ? !['\n', '\r'].includes(text) || !frame.subjectSeen : frame.subjectSeen) {
          grammarIssue ??= 'unparseable: malformed case header'
        }
        appendRaw(text)
        if (!operator) frame.subjectSeen = true
        continue
      }

      if (!operator) {
        if (frame.headerBoundary === true && text !== 'do' && text !== '{') {
          grammarIssue ??= 'unparseable: unexpected word after loop header'
        }
        if (frame.loopNameSeen !== true) {
          frame.loopNameSeen = true
          appendRaw(text)
          continue
        }
        // `do` right after the variable name (no `in`) starts the body, and so
        // does `do` after the end of an `in` list or after the header boundary.
        if (text === 'do' && (frame.headerBoundary === true || frame.loopInSeen !== true)) {
          flush()
          frame.phase = 'body'
          continue
        }
        if (text === 'in' && frame.loopInSeen !== true && frame.headerBoundary !== true) {
          frame.loopInSeen = true
          appendRaw(text)
          continue
        }
        // Bash accepts a brace group as the loop body instead of do/done.
        if (text === '{' && frame.headerBoundary === true) {
          flush()
          const pipedInput = frame.pipedInput
          frames.pop()
          frames.push({ kind: 'group', pipedInput, partStart: parts.length })
          continue
        }
        if (frame.loopInSeen !== true) grammarIssue ??= 'unparseable: malformed loop header'
      } else if (![';', '\n', '\r'].includes(text)) {
        grammarIssue ??= 'unparseable: unexpected operator in loop header'
      }
      appendRaw(text)
      if ([';', '\n', '\r'].includes(text)) frame.headerBoundary = true
      continue
    }
    if (frame?.kind === 'case' && frame.phase === 'pattern') {
      if (!operator && text === 'esac') {
        if (part.text.length > 0) grammarIssue ??= 'unparseable: unfinished case pattern'
        flush()
        closedParts = parts.slice(frame.partStart)
        frames.pop()
      } else if (operator && text === ')') {
        if (frame.patternWordSeen !== true) grammarIssue ??= 'unparseable: missing case pattern'
        flush()
        frame.phase = 'body'
      } else {
        // Leading newlines separate arms, and `|` separates pattern words.
        // Other control operators (or a newline in an unfinished pattern)
        // cannot silently turn the remainder of the line into pattern data.
        if (operator) {
          if (['\n', '\r'].includes(text) && part.text.length === 0) continue
          if (text === '|' && frame.patternWordSeen === true) frame.patternWordSeen = false
          else if (text !== '(' || part.text.length > 0) grammarIssue ??= 'unparseable: unexpected operator in case pattern'
        } else {
          if (frame.patternWordSeen === true) grammarIssue ??= 'unparseable: unexpected word in case pattern'
          frame.patternWordSeen = true
        }
        appendRaw(text)
      }
      continue
    }

    if (operator && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|>>|<&|>&|<>|>\||[<>])$|^&>>?$/.test(text)) {
      appendRaw(text)
      const descriptor = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(text)?.[0]
      const redirect = descriptor === undefined ? text : text.slice(descriptor.length)
      const input = descriptor === undefined ? redirect.startsWith('<') : Number(descriptor) === 0
      if (input) {
        for (const target of closedParts ?? [part]) {
          if (target.input !== undefined && target.input.depth > frames.length) continue
          target.input = {
            source: redirect === '<<<' ? 'hereString' : redirect === '<<' || redirect === '<<-' ? 'heredoc' : 'file',
            depth: frames.length,
          }
        }
      }
      if (tokens[i + 1] !== undefined && !tokens[i + 1].operator) appendRaw(tokens[++i].text)
      continue
    }

    if (operator) {
      // A newline or `\r` right after `|`/`|&` only continues the pipeline:
      // comments were already removed by the tokenizer.
      if ((text === '\n' || text === '\r') && pendingPipe) continue
      // Only a command (including a subshell) may follow a pipe. A different
      // control operator cannot erase the missing target or invent a source.
      if (pendingPipe && text !== '(') grammarIssue ??= 'unparseable: missing pipeline target'
      if ((text === '|' || text === '|&') && part.text.length === 0 && closedParts === undefined) {
        grammarIssue ??= 'unparseable: missing pipeline source'
      }
      closedParts = undefined
      const pipedInput = part.pipedInput
      flush()
      pendingPipe = false
      if (text === '(') {
        frames.push({ kind: 'group', pipedInput, partStart: parts.length })
        part.pipedInput = pipedInput
      } else if (text === ')') {
        if (frame?.kind === 'group') {
          closedParts = parts.slice(frame.partStart)
          frames.pop()
        }
      } else if (text === '|' || text === '|&') {
        part.pipedInput = true
        pendingPipe = true
      } else if (text === ';;' || text === ';&' || text === ';;&') {
        if (frame?.kind === 'case') {
          frame.phase = 'pattern'
          frame.patternWordSeen = false
        }
      }
      continue
    }

    if (part.words.length === 0) {
      // A function signature is syntax, never an invocation. Its body is
      // visited normally, with no recursion or nesting limit.
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && tokens[i + 1]?.text === '(' && tokens[i + 2]?.text === ')') {
        i += 2
        continue
      }
      if (text === 'function') {
        if (tokens[i + 1] !== undefined) i += 1
        if (tokens[i + 1]?.text === '(' && tokens[i + 2]?.text === ')') i += 2
        continue
      }
      if (text === '{') {
        closedParts = undefined
        frames.push({ kind: 'group', pipedInput: part.pipedInput, partStart: parts.length })
        continue
      }
      if (text === '}') {
        if (frame?.kind === 'group') {
          closedParts = parts.slice(frame.partStart)
          frames.pop()
        }
        continue
      }
      if (text === 'if' || text === 'while' || text === 'until' || text === 'for' || text === 'select' || text === 'case') {
        frames.push({
          kind: text === 'if' ? 'if' : text === 'case' ? 'case' : 'loop',
          pipedInput: part.pipedInput,
          partStart: parts.length,
          phase: text === 'for' || text === 'select' || text === 'case' ? 'header' : 'body',
        })
        continue
      }
      if (text === 'fi' || text === 'done' || text === 'esac') {
        if (frame !== undefined) closedParts = parts.slice(frame.partStart)
        frames.pop()
        continue
      }
      if (text === 'then' || text === 'elif' || text === 'else' || text === 'do' || text === '!') continue
      if (text === 'time') {
        let body = i + 1
        if (tokens[body]?.text === '-p') body += 1
        if (['{', '(', 'if', 'for', 'while', 'until', 'select', 'case', '!'].includes(tokens[body]?.text)) {
          i = body - 1
          continue
        }
      }
      if (text === 'coproc') {
        // Bash permits a name before a compound coprocess body.
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[i + 1]?.text ?? '') && ['{', '('].includes(tokens[i + 2]?.text)) i += 1
        continue
      }
    }

    closedParts = undefined
    pendingPipe = false
    appendRaw(text)
    part.words.push(text)
  }

  flush()
  if (pendingPipe) grammarIssue ??= 'unparseable: unfinished pipeline'
  if (frames.length > 0) {
    const kinds = [...new Set(frames.map((open) => open.kind))]
    grammarIssue ??= `unparseable: unclosed ${kinds.join('/')}`
  }
  return { parts, balanced, grammarIssue }
}

/**
 * True when the `$` at `start` begins an expansion the shell performs. The
 * caller must already know the position is not inside single quotes, where a
 * `$` is an ordinary character.
 */
function startsVariableExpansion(text: string, start: number): boolean {
  return text[start] === '$' && EXPANDS_VARIABLE.test(text.slice(start, start + 2))
}

/**
 * Decode one backslash escape inside a `$'…'` ANSI-C string. Bash translates
 * the C escapes and leaves an unknown backslash sequence as it was written.
 * The return value is the produced text and how many source characters it
 * consumed (the backslash included).
 */
function ansiCEscape(text: string, start: number): { value: string; length: number } {
  const next = text[start + 1]
  if (next === undefined) return { value: '\\', length: 1 }
  const simple: Record<string, string> = {
    a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', "'": "'", '"': '"', '?': '?',
  }
  if (Object.prototype.hasOwnProperty.call(simple, next)) return { value: simple[next], length: 2 }
  if (next === 'x') {
    // Bash reads one or two hexadecimal digits; with none the text stays.
    const digits = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(start + 2))?.[0]
    if (digits === undefined) return { value: '\\x', length: 2 }
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), length: 2 + digits.length }
  }
  if (next === 'u' || next === 'U') {
    const max = next === 'u' ? 4 : 8
    const digits = new RegExp(`^[0-9A-Fa-f]{1,${max}}`).exec(text.slice(start + 2))?.[0]
    if (digits === undefined) return { value: `\\${next}`, length: 2 }
    const code = Number.parseInt(digits, 16)
    return {
      value: code <= 0x10ffff ? String.fromCodePoint(code) : `\\${next}${digits}`,
      length: 2 + digits.length,
    }
  }
  if (next === 'c' && text[start + 2] !== undefined) {
    return { value: String.fromCharCode(text.charCodeAt(start + 2) & 0x1f), length: 3 }
  }
  if (/[0-7]/.test(next)) {
    const digits = /^[0-7]{1,3}/.exec(text.slice(start + 1))?.[0] ?? next
    return { value: String.fromCharCode(Number.parseInt(digits, 8) & 0xff), length: 1 + digits.length }
  }
  return { value: `\\${next}`, length: 2 }
}

/**
 * End index of the `$'…'` string whose opening apostrophe is at `start`, or -1
 * when it is not closed. Bash lexes the string before decoding it: a backslash
 * escapes exactly one next character and the first unescaped apostrophe closes
 * it, so `\c` never hides the closing quote.
 */
function ansiCStringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
    } else if (text[i] === "'") {
      return i
    }
  }
  return -1
}

/**
 * Decode the contents of a `$'…'` string that the lexer already delimited. A
 * NUL ends the produced word, but only after the boundary is known, so a
 * following escape cannot run past the closing quote.
 */
function decodeAnsiCString(content: string): string {
  let value = ''
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (ch !== '\\') {
      value += ch
      continue
    }
    const escape = ansiCEscape(content, i)
    const nul = escape.value.indexOf('\0')
    if (nul !== -1) return value + escape.value.slice(0, nul)
    value += escape.value
    i += escape.length - 1
  }
  return value
}

/**
 * Split one command part into shell words, dropping quoting characters. With
 * `keepSubstitutions` a substitution stays inside its word as written, so
 * `X=$(echo a b) rm -r x` still finds `rm` in command position.
 *
 * `expands` reports for each token whether the shell expands a variable there,
 * which the removed quotes would otherwise hide.
 */
function tokenize(
  text: string,
  keepSubstitutions = false,
): { tokens: string[]; balanced: boolean; expands: boolean[] } {
  const tokens: string[] = []
  // `grep '$USER' f` passes a literal while `grep "$USER" f` expands: the
  // removed quotes leave both tokens `$USER`, so the verdict needs this flag.
  const expands: boolean[] = []
  let current = ''
  let currentExpands = false
  let inToken = false
  let quote: '"' | "'" | 'ansi' | null = null

  const markExpansion = (index: number): void => {
    if (startsVariableExpansion(text, index)) currentExpands = true
  }
  const pushToken = (): void => {
    tokens.push(current)
    expands.push(currentExpands)
  }

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      inToken = true
      continue
    }

    if (keepSubstitutions) {
      const end = substitutionEnd(text, i, quote === null)
      if (end !== -1) {
        markExpansion(i)
        current += text.slice(i, end + 1)
        i = end
        inToken = true
        continue
      }
    }

    if (quote === '"') {
      if (ch === '\\' && i + 1 < text.length) {
        if (text[i + 1] === '\n') {
          i += 1
          continue
        }
        // Inside double quotes the shell drops the backslash only before
        // these characters; `"\_"` reaches the program (env -S) as `\_`.
        if (!'$`"\\'.includes(text[i + 1])) current += ch
        current += text[i + 1]
        i += 1
      } else if (ch === '"') {
        quote = null
      } else {
        // Double quotes do not suppress variable expansion.
        markExpansion(i)
        current += ch
      }
      inToken = true
      continue
    }

    // `$'…'` is literal for the shell: no variable expands inside it. Bash
    // finds the end of the string first, then decodes that slice, so `\c` at
    // the end stays literal and cannot swallow the closing apostrophe.
    // `$'\x72m'` is the word `rm`, and a NUL ends the produced word.
    if (ch === '$' && text[i + 1] === "'") {
      const end = ansiCStringEnd(text, i + 1)
      current += decodeAnsiCString(text.slice(i + 2, end === -1 ? undefined : end))
      inToken = true
      if (end === -1) {
        // Leave the quote open so the caller reports an unbalanced string.
        quote = 'ansi'
        i = text.length
      } else {
        i = end
      }
      continue
    }
    if (ch === '$' && text[i + 1] === '"') {
      quote = '"'
      i += 1
      inToken = true
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      inToken = true
      continue
    }

    if (ch === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') {
        i += 1
        continue
      }
      current += text[i + 1]
      i += 1
      inToken = true
      continue
    }

    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        pushToken()
        current = ''
        currentExpands = false
        inToken = false
      }
      continue
    }

    // Unquoted text is expanded by the shell.
    markExpansion(i)
    current += ch
    inToken = true
  }

  if (inToken) pushToken()
  return { tokens, balanced: quote === null, expands }
}

/**
 * True when the text expands something the classifier cannot see into:
 * `$(...)` or backticks outside single quotes.
 */
function hasUnsafeExpansion(text: string): boolean {
  let quote: '"' | "'" | 'ansi' | null = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }

    // ANSI-C strings are literal too, but only inside the matching quote:
    // `\'` inside one is an apostrophe, not the closing quote.
    if (quote === 'ansi') {
      if (ch === '\\') i += 1
      else if (ch === "'") quote = null
      continue
    }

    if (ch === "'" && quote === null) {
      quote = "'"
      continue
    }

    if (ch === '$' && text[i + 1] === "'" && quote === null) {
      quote = 'ansi'
      i += 1
      continue
    }

    if (quote === '"') {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '"') {
        quote = null
        continue
      }
    } else if (ch === '"') {
      quote = '"'
      continue
    } else if (ch === '\\') {
      i += 1
      continue
    }

    if (ch === '`') return true
    if (ch === '$' && text[i + 1] === '(') return true
  }

  return false
}

function baseName(command: string): string {
  const slash = Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\'))
  return slash === -1 ? command : command.slice(slash + 1)
}

/** Strip a version suffix so `python3.12`, `node22` and `perl5.38` map to their family. */
function interpreterBase(command: string): string {
  return command.replace(/[\d.]+$/, '') || command
}

/** Whether the interpreter takes its program from stdin rather than a script file. */
function interpreterReadsStdin(command: string, args: string[], part: ShellPart): boolean {
  if (command === 'deno') {
    const subIndex = args.findIndex((arg) => !arg.startsWith('-'))
    if (args[subIndex] !== 'run') return false
    const rest = args.slice(subIndex + 1)
    if (rest.some((arg) => arg === '-')) return true
    return rest.every((arg) => arg.startsWith('-')) && (part.pipedInput || part.input !== undefined)
  }
  if (args.includes('-')) return true
  // Informational flags do not read a program from stdin.
  if (args.some((arg) => /^--(?:version|help)$/.test(arg) || /^-[hVv?]$/.test(arg))) return false
  // A script operand makes stdin data, not code.
  if (args.some((arg) => !arg.startsWith('-'))) return false
  return part.pipedInput || part.input !== undefined
}

/** Program text of an awk invocation, or undefined when it comes from a file. */
function awkProgram(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') return args[i + 1]
    if (arg === '-F' || arg === '-v') {
      i += 1
      continue
    }
    if (arg === '-f' || arg === '--file' || arg.startsWith('--file=')) return undefined
    if (arg.startsWith('-') && arg !== '-') continue
    return arg
  }
  return undefined
}

/** Index of the closing quote of the string literal that starts at `start`. */
function skipQuoted(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === '"') return i
  }
  return text.length
}

/** `print`/`printf` redirecting to a file with `>` or `>>`. */
function awkPrintRedirects(program: string): boolean {
  const word = /\b(?:print|printf)\b/g
  for (let match = word.exec(program); match !== null; match = word.exec(program)) {
    let depth = 0
    for (let i = match.index + match[0].length; i < program.length; i += 1) {
      const ch = program[i]
      if (ch === '"') {
        i = skipQuoted(program, i)
        continue
      }
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === '(') {
        depth += 1
        continue
      }
      if (ch === ')') {
        if (depth === 0) break
        depth -= 1
        continue
      }
      if (depth > 0) continue
      if (ch === ';' || ch === '\n' || ch === '}') break
      if (ch === '>') return true
    }
  }
  return false
}

/** Whether an awk program runs a program or writes a file. */
function awkProgramNeedsConfirm(program: string): boolean {
  for (let i = 0; i < program.length; i += 1) {
    const ch = program[i]
    if (ch === '"') {
      i = skipQuoted(program, i)
      continue
    }
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '|') {
      // `||` is a logical operator; any other pipe runs a command.
      if (program[i + 1] === '|') {
        i += 1
        continue
      }
      return true
    }
    if (program.startsWith('system', i) && !/[A-Za-z0-9_]/.test(program[i - 1] ?? '')) {
      let j = i + 'system'.length
      while (j < program.length && (program[j] === ' ' || program[j] === '\t')) j += 1
      if (program[j] === '(') return true
    }
  }
  return awkPrintRedirects(program)
}

/** Index just past the next unescaped `delim` in a sed script. */
function skipSedDelimited(script: string, i: number, delim: string): number {
  while (i < script.length) {
    if (script[i] === '\\') {
      i += 2
      continue
    }
    if (script[i] === delim) return i + 1
    i += 1
  }
  return i
}

/** Index just past one sed address (none when the text is not an address). */
function skipSedAddress(script: string, i: number): number {
  const ch = script[i]
  if (ch !== undefined && ch >= '0' && ch <= '9') {
    i += 1
    while (i < script.length && script[i] >= '0' && script[i] <= '9') i += 1
    if (script[i] === '~') {
      i += 1
      while (i < script.length && script[i] >= '0' && script[i] <= '9') i += 1
    }
    return i
  }
  if (ch === '$') return i + 1
  if (ch === '/') return skipSedDelimited(script, i + 1, '/')
  if (ch === '\\' && i + 1 < script.length && script[i + 1] !== '\n') {
    return skipSedDelimited(script, i + 2, script[i + 1])
  }
  return i
}

/** Index of the first command letter after addresses and an optional `!`. */
function skipSedAddresses(script: string, i: number): number {
  const first = skipSedAddress(script, i)
  if (first !== i) i = first
  let j = i
  while (j < script.length && (script[j] === ' ' || script[j] === '\t')) j += 1
  if (script[j] === ',') {
    j += 1
    while (j < script.length && (script[j] === ' ' || script[j] === '\t')) j += 1
    if (script[j] === '+' || script[j] === '~') {
      j += 1
      while (j < script.length && script[j] >= '0' && script[j] <= '9') j += 1
    } else {
      const second = skipSedAddress(script, j)
      if (second !== j) j = second
    }
    i = j
  }
  let k = i
  while (k < script.length && (script[k] === ' ' || script[k] === '\t')) k += 1
  if (script[k] === '!') {
    k += 1
    while (k < script.length && (script[k] === ' ' || script[k] === '\t')) k += 1
    i = k
  }
  return i
}

/** Whether a sed script executes a command (`e`) or writes a file (`w`, `W`). */
function sedScriptNeedsConfirm(script: string): boolean {
  let i = 0
  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i += 1
    if (i >= script.length) break
    i = skipSedAddresses(script, i)
    while (i < script.length && (script[i] === ' ' || script[i] === '\t')) i += 1
    if (i >= script.length) break
    const command = script[i]
    if (command === 'e' || command === 'w' || command === 'W') return true
    if (command === 's') {
      i += 1
      if (i >= script.length) break
      const delim = script[i]
      i = skipSedDelimited(script, i + 1, delim)
      i = skipSedDelimited(script, i, delim)
      while (i < script.length && /[A-Za-z0-9]/.test(script[i])) {
        if (script[i] === 'e' || script[i] === 'w' || script[i] === 'W') return true
        i += 1
      }
      continue
    }
    if (command === 'y') {
      i += 1
      if (i >= script.length) break
      const delim = script[i]
      i = skipSedDelimited(script, i + 1, delim)
      i = skipSedDelimited(script, i, delim)
      continue
    }
    if (command === 'a' || command === 'i' || command === 'c') {
      // Text follows to the end of the line; escaped newlines continue it.
      i += 1
      while (i < script.length && script[i] !== '\n') {
        if (script[i] === '\\' && i + 1 < script.length) i += 1
        i += 1
      }
      continue
    }
    if (command === 'b' || command === 't' || command === 'T' || command === ':' ||
        command === 'r' || command === 'R' || command === 'v' || command === '#') {
      while (i < script.length && script[i] !== ';' && script[i] !== '\n') i += 1
      continue
    }
    i += 1
  }
  return false
}

/** Script texts of sed arguments; a script from `-f` stays uninspected. */
function sedScripts(args: string[]): string[] {
  const scripts: string[] = []
  let explicit = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') {
      if (!explicit && args[i + 1] !== undefined) scripts.push(args[i + 1])
      break
    }
    if (arg === '-e' || arg === '--expression') {
      if (args[i + 1] !== undefined) scripts.push(args[++i])
      explicit = true
      continue
    }
    if (arg.startsWith('--expression=')) {
      scripts.push(arg.slice('--expression='.length))
      explicit = true
      continue
    }
    if (arg === '-f' || arg === '--file') {
      i += 1
      explicit = true
      continue
    }
    if (arg.startsWith('--file=')) {
      explicit = true
      continue
    }
    if (arg.startsWith('-e') && arg.length > 2) {
      scripts.push(arg.slice(2))
      explicit = true
      continue
    }
    if (arg.startsWith('-')) continue
    if (!explicit) scripts.push(arg)
    break
  }
  return scripts
}

/** Whether a `git -c key=value` names something git will execute. */
function gitConfigRunsProgram(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    let value: string | undefined
    if (arg === '-c') {
      value = args[i + 1]
      i += 1
    } else if (arg.startsWith('-c') && arg.length > 2) {
      value = arg.slice(2)
    } else if (arg === '--config-env') {
      // `git --config-env=<key>=<envvar>` takes the setting from the
      // environment. Its content is as opaque as an inline `-c` value, so a
      // key that names a program git runs still needs a card.
      const spec = args[i + 1]
      i += 1
      if (spec !== undefined) {
        const split = spec.indexOf('=')
        if (split !== -1) {
          const key = spec.slice(0, split).toLowerCase()
          if (key.startsWith('alias.') || GIT_EXEC_CONFIG_KEY.test(key)) return true
        }
      }
      continue
    } else if (arg.startsWith('--config-env=')) {
      const spec = arg.slice('--config-env='.length)
      const split = spec.indexOf('=')
      if (split !== -1) {
        const key = spec.slice(0, split).toLowerCase()
        if (key.startsWith('alias.') || GIT_EXEC_CONFIG_KEY.test(key)) return true
      }
      continue
    }
    if (value === undefined) continue
    const equals = value.indexOf('=')
    if (equals === -1) continue
    const key = value.slice(0, equals).toLowerCase()
    const setting = value.slice(equals + 1)
    if (key.startsWith('alias.') && setting.startsWith('!')) return true
    if (GIT_EXEC_CONFIG_KEY.test(key)) return true
  }
  return false
}

/** Whether a vim/nvim `-c`, `--cmd` or `+` command line invokes a shell. */
function editorRunsShell(args: string[]): boolean {
  const shellCommand = (value: string): boolean => /(?:^|[\s:])!/.test(value)
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-c' || arg === '--cmd') {
      if (args[i + 1] !== undefined && shellCommand(args[i + 1])) return true
      i += 1
      continue
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      if (shellCommand(arg.slice(2))) return true
      continue
    }
    if (arg.startsWith('--cmd=')) {
      if (shellCommand(arg.slice('--cmd='.length))) return true
      continue
    }
    if (arg.startsWith('+') && shellCommand(arg.slice(1))) return true
  }
  return false
}

interface CommandPosition {
  /** Index of the command word, or `tokens.length` for an empty command. */
  index: number
  /**
   * True when a token skipped while looking for the command (a `VAR=value`
   * assignment, a wrapper flag or a wrapper flag value) expands a shell
   * variable. This matters for wrappers such as `xargs`: its arguments are not
   * the inner command's arguments, but they still decide what gets executed or
   * deleted, so `xargs -I $REPL echo` must not stay `allow`.
   */
  skippedVariable: boolean
  /**
   * True when the variable is in the arguments of a wrapper that is itself
   * sensitive to variables (xargs): its arguments name what gets executed or
   * deleted. The sandbox asks only for this one.
   */
  sensitiveVariable: boolean
  /** flock -c invokes a shell rather than a command/argument vector. */
  inlineCode?: string
  /**
   * env -S/--split-string expands its value into the command and its first
   * arguments; the words after the value follow as further arguments. This is
   * the whole resulting command line.
   */
  splitString?: string
}

/**
 * Text of the backtick substitution that starts at `start`, and its end index.
 *
 * The value has one level of backtick escaping removed (`\`` becomes a
 * backtick, `\\` a backslash, `\$` a dollar sign), because that is the text the
 * shell runs: `echo \`echo \\\`rm -r x\\\`\`` nests another substitution one
 * level deeper. The caller parses the unescaped text by the same rules, so a
 * nested command cannot hide behind the escape characters.
 */
function readBacktick(text: string, start: number): { value: string; end: number } {
  let value = ''
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1]
      value += next === '`' || next === '\\' || next === '$' ? next : ch + next
      i += 1
      continue
    }
    if (ch === '`') return { value, end: i }
    value += ch
  }
  // The substitution is not closed: parse what is here instead of asking for a
  // card over a syntax error the shell would refuse to run anyway.
  return { value, end: text.length - 1 }
}

/** Text of the parenthesised substitution whose body starts at `start`, and its end index. */
function readParens(text: string, start: number): { value: string; end: number } {
  let value = ''
  let depth = 1
  let quote: '"' | "'" | 'ansi' | null = null

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]

    if (quote === "'") {
      value += ch
      if (ch === "'") quote = null
      continue
    }

    if (quote === 'ansi') {
      value += ch
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1]
        i += 1
      } else if (ch === "'") {
        quote = null
      }
      continue
    }

    if (quote === '"') {
      value += ch
      if (ch === '\\' && i + 1 < text.length) {
        value += text[i + 1]
        i += 1
      } else if (ch === '"') {
        quote = null
      }
      continue
    }

    if (ch === '$' && text[i + 1] === "'") {
      quote = 'ansi'
      value += ch + text[i + 1]
      i += 1
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      value += ch
      continue
    }

    if (ch === '\\' && i + 1 < text.length) {
      value += ch + text[i + 1]
      i += 1
      continue
    }

    if (ch === '(') {
      depth += 1
      value += ch
      continue
    }

    if (ch === ')') {
      depth -= 1
      if (depth === 0) return { value, end: i }
      value += ch
      continue
    }

    value += ch
  }

  return { value, end: text.length - 1 }
}

/**
 * End index of the substitution that starts at `start` (`$(…)`, `$((…))`,
 * backticks, and `<(…)`/`>(…)` outside double quotes), or -1 when none starts
 * there. The caller has already excluded single quotes.
 */
function substitutionEnd(text: string, start: number, unquoted: boolean): number {
  const ch = text[start]
  if (ch === '`') return readBacktick(text, start + 1).end
  if (text[start + 1] !== '(') return -1
  if (ch === '$' || (unquoted && (ch === '<' || ch === '>'))) return readParens(text, start + 2).end
  return -1
}

/**
 * Command text nested in `text` through `$(…)`, `<(...)`, `>(...)` and
 * backticks. Single quotes hide a substitution; double quotes do not, because
 * the shell runs it there too. The text is returned as written, without the
 * delimiters, so the caller can parse it by the same rules.
 */
function nestedSubstitutions(text: string): string[] {
  const found: string[] = []
  let quote: '"' | "'" | 'ansi' | null = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }

    // An ANSI-C string is literal like a single-quoted one, so it hides every
    // substitution; its own `\'` escape does not close it.
    if (quote === 'ansi') {
      if (ch === '\\') i += 1
      else if (ch === "'") quote = null
      continue
    }

    if (quote === null && ch === "'") {
      quote = "'"
      continue
    }

    if (quote === null && ch === '$' && text[i + 1] === "'") {
      quote = 'ansi'
      i += 1
      continue
    }

    if (ch === '\\') {
      i += 1
      continue
    }

    if (ch === '"') {
      quote = quote === '"' ? null : '"'
      continue
    }

    if (ch === '`') {
      const read = readBacktick(text, i + 1)
      found.push(read.value)
      i = read.end
      continue
    }

    if ((ch === '$' || (quote === null && (ch === '<' || ch === '>'))) && text[i + 1] === '(') {
      // `$((…))` is arithmetic expansion: it runs no command.
      if (ch === '$' && text[i + 2] === '(') continue
      const read = readParens(text, i + 2)
      found.push(read.value)
      i = read.end
    }
  }

  return found
}

/** The strictest of `findings`, falling back to `fallback` when there are none. */
function strictest(findings: readonly Finding[], fallback: Finding): Finding {
  let best = fallback
  for (const finding of findings) {
    if (VERDICT_RANK[finding.verdict] > VERDICT_RANK[best.verdict]) best = finding
  }
  return best
}

/** Whether a wrapper option consumes the following word (rather than an attached value). */
function wrapperFlagTakesValue(wrapper: string, flag: string, valueFlags: ReadonlySet<string> | undefined): boolean {
  if (valueFlags?.has(flag)) return true
  if (EXTRA_WRAPPER_VALUE_FLAGS[wrapper] === undefined || !/^-[^-]/.test(flag)) return false
  for (let i = 1; i < flag.length; i += 1) {
    if (valueFlags?.has(`-${flag[i]}`)) return i === flag.length - 1
  }
  return false
}

/** Value of an env -S option and the number of words it occupies. */
function envSplitString(flag: string, next: string | undefined): { value: string; words: number } | undefined {
  if (flag === '-S' || flag === '--split-string') return { value: next ?? '', words: next === undefined ? 1 : 2 }
  if (flag.startsWith('--split-string=')) return { value: flag.slice('--split-string='.length), words: 1 }
  if (flag.startsWith('-S') && flag.length > 2) return { value: flag.slice(2), words: 1 }
  return undefined
}

const ENV_S_ESCAPES: Record<string, string> = {
  f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '#': '#', $: '$', '"': '"', "'": "'", '\\': '\\',
}

/**
 * Split an env -S value the way env itself does: whitespace separates words,
 * quotes group them, `#` at the start of a word comments out the rest of the
 * value and `\c` ends it. Shell operators inside the value are plain text.
 */
function envSplitWords(value: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '' | "'" | '"' = ''
  const finish = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      else if (ch === '\\' && (value[i + 1] === "'" || value[i + 1] === '\\')) word += value[++i]
      else word += ch
      continue
    }
    if (ch === '\\') {
      const next = value[i + 1]
      if (next === 'c') break
      i += 1
      if (next === '_') {
        if (quote) word += ' '
        else finish()
      } else if (next !== undefined) {
        word += ENV_S_ESCAPES[next] ?? `\\${next}`
        inWord = true
      }
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      else word += ch
      continue
    }
    if (/\s/.test(ch)) {
      finish()
    } else if (ch === '#' && !inWord) {
      break
    } else if (ch === "'" || ch === '"') {
      quote = ch
      inWord = true
    } else {
      word += ch
      inWord = true
    }
  }
  finish()
  return words
}

/**
 * Re-quote an already split word so that the shell parser reads it back as
 * the same single word. A word with an expansion keeps it visible to the
 * expansion rules inside double quotes.
 */
function shellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  if (word.includes('$')) return `"${word.replace(/["\\`]/g, '\\$&')}"`
  return `'${word.replace(/'/g, "'\\''")}'`
}

function flockInlineCode(flag: string, next: string | undefined): string | undefined {
  if (flag === '--command') return next ?? ''
  if (flag.startsWith('--command=')) return flag.slice('--command='.length)
  if (!/^-[^-]/.test(flag)) return undefined
  for (let i = 1; i < flag.length; i += 1) {
    if (flag[i] === 'c') return flag.slice(i + 1) || next || ''
    if (EXTRA_WRAPPER_VALUE_FLAGS.flock.has(`-${flag[i]}`)) break
  }
  return undefined
}

/**
 * Position of the executable, skipping assignments, wrapper options and
 * operands. `expands` reports, per token, whether the shell expands a variable
 * there; without it the check falls back to the raw token text.
 */
function commandIndex(tokens: string[], expands?: readonly boolean[]): CommandPosition {
  const expandsAt = (index: number): boolean =>
    expands === undefined ? EXPANDS_VARIABLE.test(tokens[index]) : expands[index] === true
  let i = 0
  let skippedVariable = false
  let sensitiveVariable = false

  for (;;) {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      if (expandsAt(i)) skippedVariable = true
      i += 1
    }
    if (i >= tokens.length) return { index: i, skippedVariable, sensitiveVariable }

    const wrapper = baseName(tokens[i])
    if (!WRAPPERS.has(wrapper)) return { index: i, skippedVariable, sensitiveVariable }
    const wrapperIndex = i
    // Preserve the wrapper's own variable policy before discarding it: xargs
    // arguments include the inner command and all of its operands, even when
    // that command (for example echo) normally allows variable operands.
    if (
      VARIABLE_SENSITIVE_COMMANDS.has(wrapper) &&
      tokens.slice(i + 1).some((_token, offset) => expandsAt(i + 1 + offset))
    ) {
      skippedVariable = true
      sensitiveVariable = true
    }
    i += 1

    const valueFlags =
      wrapper === 'sudo' || wrapper === 'doas'
        ? SUDO_VALUE_FLAGS
        : wrapper === 'env'
          ? ENV_VALUE_FLAGS
          : wrapper === 'xargs'
            ? XARGS_VALUE_FLAGS
            : EXTRA_WRAPPER_VALUE_FLAGS[wrapper]
    // `env NAME=value -S "…"` still has options after the assignments, so the
    // option scan must not stop at the first assignment and hand `-S` to the
    // classifier as an executable name.
    while (
      i < tokens.length &&
      (tokens[i].startsWith('-') || (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))
    ) {
      if (expandsAt(i)) skippedVariable = true
      if (wrapper === 'env') {
        // `env -S "python3 -c 1"` runs the words of the value as a command,
        // exactly like the bare command line. Classify that text instead of
        // silently skipping it as an option value.
        const split = envSplitString(tokens[i], tokens[i + 1])
        if (split !== undefined) {
          // Split only the value; the remaining argv words are appended as
          // they are, so a `#` or `;` in either never reaches the shell parser.
          const words = [...envSplitWords(split.value), ...tokens.slice(i + split.words)]
          return {
            index: wrapperIndex, skippedVariable, sensitiveVariable,
            splitString: words.map(shellWord).join(' '),
          }
        }
      }
      const inlineCode = wrapper === 'flock' ? flockInlineCode(tokens[i], tokens[i + 1]) : undefined
      if (inlineCode !== undefined) {
        return {
          index: wrapperIndex, skippedVariable, sensitiveVariable,
          inlineCode,
        }
      }
      const takesValue = wrapperFlagTakesValue(wrapper, tokens[i], valueFlags)
      const endOptions = tokens[i] === '--'
      i += 1
      if (takesValue && i < tokens.length) {
        if (expandsAt(i)) skippedVariable = true
        i += 1
      }
      if (endOptions) break
    }
    // These wrappers have one positional operand before the actual command.
    if ((wrapper === 'timeout' || wrapper === 'flock') && i < tokens.length) {
      if (expandsAt(i)) skippedVariable = true
      i += 1
    }
    // flock accepts its options after the lock file as well, including the
    // common `flock lockfile -c 'shell code'` form.
    if (wrapper === 'flock') {
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const flag = tokens[i]
        if (expandsAt(i)) skippedVariable = true
        const inlineCode = flockInlineCode(flag, tokens[i + 1])
        if (inlineCode !== undefined) {
          return {
            index: wrapperIndex, skippedVariable, sensitiveVariable,
            inlineCode,
          }
        }
        i += 1
        if (wrapperFlagTakesValue(wrapper, flag, valueFlags) && i < tokens.length) {
          if (expandsAt(i)) skippedVariable = true
          i += 1
        }
        if (flag === '--') break
      }
    }
  }
}

/**
 * Index of the command word of one simple command split into words, after
 * assignments and wrappers with their flags (`sudo -u git rm` gives `rm`).
 * The explanation of the owner card finds the command the same way the
 * classifier does.
 */
export function commandWordIndex(tokens: string[]): number {
  return commandIndex(tokens).index
}

function hasSequence(tokens: string[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= tokens.length; i += 1) {
    let matches = true
    for (let j = 0; j < sequence.length; j += 1) {
      if (tokens[i + j] !== sequence[j]) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

/** True for `--flag` and `--flag=true`, false for `--flag=false`. */
function hasEnabledFlag(tokens: string[], flag: string): boolean {
  return tokens.some((token) => token === flag || token === `${flag}=true`)
}

function flagValue(tokens: string[], flag: string): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === flag) return tokens[i + 1]
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  }
  return undefined
}

function hasShortFlag(tokens: string[], flag: string): boolean {
  // `flag` is a single letter, e.g. "p" for `gh gist create -p`.
  return tokens.some((token) => token === `-${flag}` || token === `-${flag}=true`)
}

function hasCombinedShortFlag(tokens: string[], flag: string): boolean {
  // Matches `-f`, `-fd`, `-xdf` and similar bundles for a single letter.
  const pattern = new RegExp(`^-[A-Za-z]*${flag}[A-Za-z]*$`)
  return tokens.some((token) => pattern.test(token))
}

function firstNonFlag(tokens: string[]): string | undefined {
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token === '-R' || token === '--repo' || token === '--hostname') {
      i += 2
      continue
    }
    if (!token.startsWith('-')) return token
    i += 1
  }
  return undefined
}

function ghFinding(args: string[], partText: string): Finding | null {
  const group = firstNonFlag(args)

  if (group === 'api') {
    const endpoint = args.some((token) => !token.startsWith('-') && PAGES_ENDPOINT.test(token))
    if (endpoint) return { verdict: 'deny', reason: 'publication: gh api call to the pages endpoint' }
    if (PUBLICATION_FIELD.test(partText)) {
      return { verdict: 'deny', reason: 'publication: gh api sets private=false or visibility=public' }
    }
  }

  if (hasSequence(args, ['repo', 'create'])) {
    if (hasEnabledFlag(args, '--public')) {
      return { verdict: 'deny', reason: 'publication: gh repo create --public' }
    }
    if ((flagValue(args, '--visibility') ?? '').toLowerCase() === 'public') {
      return { verdict: 'deny', reason: 'publication: gh repo create --visibility public' }
    }
  }

  if (hasSequence(args, ['repo', 'edit'])) {
    if ((flagValue(args, '--visibility') ?? '').toLowerCase() === 'public') {
      return { verdict: 'deny', reason: 'publication: gh repo edit --visibility public' }
    }
  }

  if (hasSequence(args, ['gist', 'create'])) {
    if (hasEnabledFlag(args, '--public') || hasShortFlag(args, 'p')) {
      return { verdict: 'deny', reason: 'publication: gh gist create --public' }
    }
  }

  return null
}

function gitSubcommand(args: string[]): string | undefined {
  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree') {
      i += 2
      continue
    }
    if (token.startsWith('-')) {
      i += 1
      continue
    }
    return token
  }
  return undefined
}

/**
 * Command text that `command` runs from its own arguments: the code after
 * `bash -c`, the arguments of `eval` and the program of `find -exec`.
 */
function nestedArguments(command: string, args: string[]): string[] {
  const found: string[] = []

  if (SHELLS.has(command)) {
    const flagIndex = args.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token))
    if (flagIndex !== -1) found.push(args.slice(flagIndex + 1).join(' '))
  }

  if (command === 'eval') found.push(args.join(' '))

  if (command === 'find') {
    for (let i = 0; i < args.length; i += 1) {
      if (!FIND_DANGEROUS_ACTIONS.has(args[i]) || args[i] === '-delete') continue
      let end = i + 1
      while (end < args.length && args[end] !== ';' && args[end] !== '+') end += 1
      found.push(args.slice(i + 1, end).join(' '))
      i = end
    }
  }

  return found.filter((code) => code.trim().length > 0)
}

/** Whether a shell's program comes from stdin rather than -c or a script file. */
function shellReadsStdin(args: string[]): boolean {
  let stdin = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--version' || arg === '--help') return false
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(arg) || arg === '--command') return false
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) stdin = true
    if (arg === '--') return stdin || i === args.length - 1 || args[i + 1] === '-'
    if (arg === '-' || !/^[+-]/.test(arg)) return stdin || arg === '-'
    // Bash/zsh options with a separate option value, not a script filename.
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(arg)) i += 1
  }
  return true
}

/** Whether an option consumes the following word instead of an attached value. */
function interpreterOptionTakesValue(flag: string, valueFlags: ReadonlySet<string>): boolean {
  if (valueFlags.has(flag)) return true
  if (flag.startsWith('--') || !/^-[^-]/.test(flag)) return false
  for (let i = 1; i < flag.length; i += 1) {
    if (!valueFlags.has(`-${flag[i]}`)) continue
    // A value at the end of a short bundle (`-uW`) is the next word; an
    // attached value (`-Wignore`) belongs to the option itself.
    return i === flag.length - 1
  }
  return false
}

/** Whether a Python short-option bundle selects a module (`-m mod`, `-um mod`, `-mmod`). */
function pythonModuleOption(flag: string, valueFlags: ReadonlySet<string>): boolean {
  if (!/^-[^-]/.test(flag)) return false
  for (let i = 1; i < flag.length; i += 1) {
    if (flag[i] === 'm') return true
    // A value-taking option ends the bundle: the rest is its value (`-Wm`).
    if (valueFlags.has(`-${flag[i]}`)) return false
  }
  return false
}

/**
 * Whether an interpreter runs its program from stdin: no program file operand
 * is left (`python3`, `python3 -u`, `python3 -`, `node -r ./x.js`) and stdin
 * comes from a pipeline, a redirect or `<<<`/heredoc, or the operand is `-`.
 * A program file or a Python `-m` module makes stdin ordinary data instead.
 */
function interpreterStdinProgram(command: string, args: string[], part: ShellPart): boolean {
  // hasOwnProperty keeps names such as "constructor" from resolving through
  // the prototype chain to a non-Set value.
  if (!Object.prototype.hasOwnProperty.call(INTERPRETER_VALUE_FLAGS, command)) return false
  const valueFlags = INTERPRETER_VALUE_FLAGS[command]
  const redirected = part.pipedInput || part.input !== undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    // Version/help flags (`-v`, `--version`, `-h`, `-V`) do not stop operand
    // parsing: `ruby -v - < x.rb` still runs the program supplied on stdin,
    // while `ruby -v` alone has no operand and stays data-only.
    if (arg === '--') {
      const operand = args[i + 1]
      return operand === undefined ? redirected : operand === '-'
    }
    if (arg === '-') return true
    if (!arg.startsWith('-')) return false
    // Python's `-m` names a module: the program is not read from stdin.
    if (PYTHON_INTERPRETERS.has(command) && pythonModuleOption(arg, valueFlags)) return false
    if (arg.startsWith('--') && arg.includes('=')) continue
    if (interpreterOptionTakesValue(arg, valueFlags)) i += 1
  }

  return redirected
}

/**
 * Verdict of the part's own command. In the sandbox the command text nested in
 * it is appended to `nested`; the caller judges that text by the same rules
 * before any rule below returns, so an early return never skips it.
 */
function classifyOwn(part: ShellPart, sandbox: boolean, nested: string[]): Finding {
  const { text } = part
  const { tokens, balanced, expands } = tokenize(part.words.join(' '), sandbox)
  /** Whether the shell expands a variable in the token at `index`. */
  const expandsAt = (index: number): boolean => expands[index] === true

  // Also visit substitutions in loop/case headers and redirection targets,
  // which are not command/argument words.
  if (sandbox) nested.push(...nestedSubstitutions(text))

  // The host is not sandboxed, so a syntax the classifier cannot read is a
  // reason for a card. In the sandbox it only matters when it hides a
  // destructive command, and the nested text is parsed below.
  if (!sandbox) {
    if (!balanced) return { verdict: 'confirm', reason: 'unparseable: unbalanced quotes', unparseable: true }
    if (hasUnsafeExpansion(text)) {
      return { verdict: 'confirm', reason: 'unparseable: command substitution', unparseable: true }
    }
  }
  if (tokens.length === 0) return { verdict: 'allow', reason: 'empty command' }

  const { index, skippedVariable, sensitiveVariable, inlineCode, splitString } = commandIndex(tokens, expands)
  const command = index < tokens.length ? baseName(tokens[index]) : ''
  const args = tokens.slice(index + 1)

  // In the sandbox the text of `$(…)`, `<(...)`, `>(...)` and backticks runs
  // too, and so does the code after `bash -c`, `eval` and `find -exec`: it is
  // judged by the same rules as the line around it, before any rule below
  // returns.
  if (sandbox) {
    nested.push(...nestedArguments(command, args))
    if (inlineCode !== undefined) nested.push(inlineCode)
  } else if (inlineCode !== undefined) {
    return { verdict: 'confirm', reason: 'unparseable: flock -c', unparseable: true }
  }

  // `env -S "python3 -c 1"` splits its value into a command line, followed by
  // the remaining words (`env -S "rm" -rf x`). Judge that line exactly as if it
  // had been typed bare, with the same stdin, in both modes.
  if (splitString !== undefined) return classifyCommandLine(splitString, sandbox, part)

  // stdin is executable source for a shell with no script/-c argument (or
  // with -s). It cannot be inspected by following command-line arguments.
  // Here-documents are already present in the line and checked as before.
  if (
    STDIN_SHELLS.has(command) && shellReadsStdin(args) && part.input?.source !== 'heredoc' &&
    (part.pipedInput || part.input !== undefined || args.includes('-') || args.some((arg) => /^-[A-Za-z]*s[A-Za-z]*$/.test(arg)))
  ) {
    return { verdict: 'confirm', reason: `unparseable: ${command} code from stdin`, unparseable: true }
  }

  // The same hole exists for other interpreters: `python3`, `node`, `perl` and
  // `ruby` run the program from stdin when no script file or module is named.
  // That program is a different language the classifier cannot read, exactly
  // like inline code after -c/-e, so it needs a card on the host. A here-document
  // program is unreadable in the same way. In the sandbox the bwrap boundary
  // contains it and the verdict stays allow, as for inline code.
  if (!sandbox && interpreterStdinProgram(interpreterBase(command), args, part)) {
    return { verdict: 'confirm', reason: `unparseable: ${command} code from stdin`, unparseable: true }
  }

  // Wrapper arguments and assignment prefixes are skipped when locating the
  // command, but a variable there can still change what is executed or deleted
  // (`xargs -I $REPL rm`, `env -u $NAME cmd`). They are never parsed reliably.
  // In the sandbox only the arguments of xargs count, as for rm/find/git/gh
  // below: a variable in `env KEY="$VALUE"` or `sudo -u $USER` changes nothing
  // the classifier would judge, and the command itself is still checked.
  if (sandbox ? sensitiveVariable : skippedVariable) {
    return {
      verdict: 'confirm',
      reason: sandbox ? 'unparseable: variable in the arguments of xargs' : 'unparseable: variable in wrapper arguments',
      unparseable: true,
    }
  }

  if (index >= tokens.length) return { verdict: 'allow', reason: 'empty command' }

  if (!sandbox && expandsAt(index)) {
    return { verdict: 'confirm', reason: 'unparseable: variable in command position', unparseable: true }
  }

  // Inline code and code from stdin are opaque on the host: the classifier can
  // follow neither. Versioned names (`python3.12`, `node22`) resolve to their
  // family before the flags are matched.
  const interpreter = interpreterBase(command)
  const evalFlags = INTERPRETER_EVAL_FLAGS.get(interpreter)
  if (!sandbox) {
    // Deno's subcommand may follow global flags (`deno --allow-all eval …`).
    const denoSubcommand = args.find((token) => !token.startsWith('-'))
    if (interpreter === 'deno' && denoSubcommand === 'eval') {
      return { verdict: 'confirm', reason: `unparseable: ${command} inline code`, unparseable: true }
    }
    if (
      evalFlags !== undefined &&
      args.some((token) => evalFlags.test(token) || INTERPRETER_EVAL_LONG_FLAGS.has(token))
    ) {
      return { verdict: 'confirm', reason: `unparseable: ${command} inline code`, unparseable: true }
    }
    if (
      STDIN_CODE_INTERPRETERS.has(interpreter) &&
      !Object.prototype.hasOwnProperty.call(INTERPRETER_VALUE_FLAGS, interpreter) &&
      interpreterReadsStdin(interpreter, args, part)
    ) {
      return { verdict: 'confirm', reason: `unparseable: ${command} code from stdin`, unparseable: true }
    }

    // awk, sed, git -c and editor command lines can carry arbitrary code in
    // their arguments; ordinary programs and data operands stay allowed.
    if (AWK_COMMANDS.has(command)) {
      const program = awkProgram(args)
      if (program !== undefined && awkProgramNeedsConfirm(program)) {
        return { verdict: 'confirm', reason: `unparseable: ${command} program runs a command or writes a file`, unparseable: true }
      }
    }
    if (command === 'sed' && sedScripts(args).some(sedScriptNeedsConfirm)) {
      return { verdict: 'confirm', reason: 'unparseable: sed script executes a command or writes a file', unparseable: true }
    }
    if (command === 'git' && gitConfigRunsProgram(args)) {
      return { verdict: 'confirm', reason: 'unparseable: git -c runs a program', unparseable: true }
    }
    if (EDITOR_COMMANDS.has(command) && editorRunsShell(args)) {
      return { verdict: 'confirm', reason: `unparseable: ${command} runs a shell command`, unparseable: true }
    }
  }

  if (command === 'find') {
    if (!sandbox) {
      if (args.some((token) => FIND_DANGEROUS_ACTIONS.has(token))) {
        return { verdict: 'confirm', reason: 'irreversible: find deletes files or runs a program' }
      }
    } else if (args.includes('-delete')) {
      // `-exec` and its variants run another command, already judged above.
      return { verdict: 'confirm', reason: 'irreversible: find deletes files' }
    }
  }

  // Commands that accept flags or actions after operands are sensitive to a
  // variable anywhere in their arguments: GNU rm takes flags after operands
  // (`rm build $FLAGS`) and find takes actions after paths (`find . $ARGS`).
  if (
    VARIABLE_SENSITIVE_COMMANDS.has(command) &&
    args.some((_token, offset) => expandsAt(index + 1 + offset))
  ) {
    return {
      verdict: 'confirm',
      reason: `unparseable: variable in the arguments of ${command}`,
      unparseable: true,
    }
  }

  // Elsewhere only a variable in flag position (`chmod $FLAGS dir`,
  // `chmod -$FLAGS dir`) may expand into flags the classifier never sees. A
  // lone operand such as `echo $HOME` stays allowed. In the sandbox this is
  // not a reason for a card: the command can only touch the workspace and the
  // owner's read-write roots.
  const variableIndex = args.findIndex((_token, offset) => expandsAt(index + 1 + offset))
  if (
    !sandbox &&
    variableIndex !== -1 &&
    (args[variableIndex].startsWith('-') || (variableIndex === 0 && args.length > 1))
  ) {
    return { verdict: 'confirm', reason: 'unparseable: variable in flag position', unparseable: true }
  }

  if (!sandbox && SHELLS.has(command) && args.some((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token))) {
    return {
      verdict: 'confirm',
      reason: `unparseable: nested ${command} -c`,
      unparseable: true,
    }
  }

  if (command === 'eval' && !sandbox) {
    return { verdict: 'confirm', reason: 'unparseable: eval', unparseable: true }
  }

  if (SQL_DROP.test(text)) {
    return { verdict: 'confirm', reason: 'irreversible: SQL DROP TABLE or DROP DATABASE' }
  }

  if (command === 'gh') {
    const finding = ghFinding(args, text)
    if (finding !== null) return finding
  }

  if (command === 'git') {
    const subcommand = gitSubcommand(args)
    if (subcommand === 'push') {
      return { verdict: 'confirm', reason: 'irreversible: git push' }
    }
    if (subcommand === 'reset' && hasEnabledFlag(args, '--hard')) {
      return { verdict: 'confirm', reason: 'irreversible: git reset --hard' }
    }
    if (subcommand === 'clean' && (hasEnabledFlag(args, '--force') || hasCombinedShortFlag(args, 'f'))) {
      return { verdict: 'confirm', reason: 'irreversible: git clean -f' }
    }
  }

  // Host operations that interrupt the owner's services or the machine:
  // stopping/restarting a unit, reboot/shutdown and killing processes always
  // wait for the owner's confirmation. Read-only verbs (status, journalctl,
  // start of a stopped unit) stay allowed. Inside the sandbox kill/pkill/killall
  // only reach its own process space, so they ask nobody.
  if (POWER_COMMANDS.has(command) || (!sandbox && KILL_COMMANDS.has(command))) {
    return { verdict: 'confirm', reason: `irreversible: ${command} interrupts the host` }
  }
  if (SERVICE_MANAGERS.has(command) && args.some((token) => SERVICE_DANGER_VERBS.has(token))) {
    return { verdict: 'confirm', reason: `irreversible: ${command} stops or restarts a service` }
  }

  if (command === 'rm') {
    let recursive = false
    for (const token of args) {
      if (token === '--') break
      if (token === '--recursive' || (/^-[A-Za-z]*[rR][A-Za-z]*$/.test(token) && !token.startsWith('--'))) {
        recursive = true
        break
      }
    }
    if (recursive) {
      return { verdict: 'confirm', reason: 'irreversible: recursive rm' }
    }
  }

  return { verdict: 'allow', reason: 'no restricted operation detected' }
}

/**
 * Classify a compound command line in one mode, keeping the strictest part.
 *
 * In the sandbox every command text nested in a part (`bash -c "…"`, `$(…)`,
 * backticks, `find -exec`) is queued and split and judged the same way, at any
 * depth. The queue replaces recursion, so deep nesting cannot overflow the
 * stack, and it ends because nested text is always shorter than the text
 * around it. The verdict is the strictest over every level, so a nested `deny`
 * (publication) is never lowered to an outer `confirm`.
 */
function classifyCommandLine(command: string, sandbox: boolean, stdin?: Pick<ShellPart, 'pipedInput' | 'input'>): Finding {
  const findings: Finding[] = []
  const queue = [command]
  let unparseableReason: string | undefined
  let grammarReason: string | undefined

  for (let next = 0; next < queue.length; next += 1) {
    const text = queue[next]
    const { parts, balanced, grammarIssue } = splitTopLevel(text)
    if (!balanced && !sandbox && unparseableReason === undefined) {
      unparseableReason = 'unparseable: unbalanced quotes'
    }
    if (grammarIssue !== undefined && grammarReason === undefined) grammarReason = grammarIssue

    for (const part of parts) {
      // A command line unwrapped from `env -S` reads the wrapper's stdin.
      if (next === 0 && stdin !== undefined) {
        part.pipedInput ||= stdin.pipedInput
        part.input ??= stdin.input
      }
      const finding = classifyOwn(part, sandbox, queue)
      findings.push(finding)
      if (!sandbox && finding.unparseable && unparseableReason === undefined) {
        unparseableReason = finding.reason
      }
    }
  }

  let best = strictest(findings, { verdict: 'allow', reason: 'no restricted operation detected' })

  // A header or pipeline boundary the classifier cannot follow reliably asks
  // for a card even in the sandbox: the unreadable tail of the line must never
  // be silently treated as header data.
  if (grammarReason !== undefined && VERDICT_RANK[best.verdict] < VERDICT_RANK.confirm) {
    best = { verdict: 'confirm', reason: grammarReason }
  }

  // In the sandbox an unreadable syntax is not a verdict by itself; the host
  // keeps the old rule and asks.
  if (unparseableReason !== undefined && VERDICT_RANK[best.verdict] < VERDICT_RANK.confirm) {
    best = { verdict: 'confirm', reason: unparseableReason }
  }

  return best
}

/**
 * Classify a shell command line.
 *
 * Compound commands get the strictest verdict of their parts. On the host
 * anything the classifier cannot parse reliably (nested `bash -c`, `eval`,
 * substitutions, unbalanced quotes) is at least `confirm`. Shell code from an
 * unreadable stdin source requires confirmation in both modes. In the exec sandbox
 * (see {@link CommandCheckOptions.sandbox}) only destructive actions ask: the
 * unreadable syntax is followed into its nested command text instead.
 */
export function checkCommand(command: string, options: CommandCheckOptions = {}): CommandCheck {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { verdict: 'allow', reason: 'empty command' }
  }

  const best = classifyCommandLine(command, options.sandbox === true)
  return { verdict: best.verdict, reason: best.reason }
}

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------

// Paths are matched case-insensitively (see isProtected), so file entries are
// kept lowercase as well.
const PROTECTED_FILES = new Set(['charter.md', 'checklist.md'])
const PROTECTED_DIRECTORIES = [
  'packages/guard',
  // The self-rewrite gate lives here (isProtected call, dependency refusal, the
  // bwrap run of npm test, the review, adopt.json and evolve-state/stable). A
  // candidate must not be able to remove or weaken its own checks, so this
  // package changes only through the factory, never through self-rewriting.
  'packages/evolve',
  // The bwrap sandbox of the exec tool: loosening its mounts must go through the
  // factory, otherwise a self-rewrite candidate could open the host while keeping
  // the gate green.
  'packages/tools-exec',
  'deploy',
  'tests/character',
  'scripts',
]

function isWithin(relativePath: string, directory: string): boolean {
  return relativePath === directory || relativePath.startsWith(`${directory}/`)
}

/**
 * Resolve symlinks in `path` as far as the filesystem allows.
 *
 * For a path that does not exist yet, the real path of the nearest existing
 * parent is used and the missing components are appended unchanged. That keeps
 * `g/src/x.ts` protected when `g` is a symlink to a protected directory and
 * `x.ts` has not been created.
 */
function realPathOf(path: string): string {
  const absolute = resolve(path)
  const missing: string[] = []
  let current = absolute

  for (;;) {
    try {
      const real = realpathSync(current)
      return missing.length === 0 ? real : resolve(real, ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * True when `path` points at a path the bot may not edit on its own:
 * `CHARTER.md`, `CHECKLIST.md`, anything under `packages/guard/`,
 * `packages/evolve/` (the self-rewrite gate), `packages/tools-exec/` (the exec
 * sandbox), `deploy/`, `tests/character/` or the adoption/rollback scripts in
 * `scripts/`.
 *
 * Relative paths are resolved against `repoRoot`; paths outside `repoRoot`
 * are never protected. Symlinks are resolved to their real targets first, so a
 * link inside the repo cannot be used to reach a protected path. Letter case is
 * ignored, so a case variant does not slip past on a case-insensitive
 * filesystem (on a case-sensitive one it is a different, harmless path).
 */
export function isProtected(path: string, repoRoot: string): boolean {
  const root = realPathOf(repoRoot)
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const real = realPathOf(absolute)
  const relativePath = relative(root, real)

  if (relativePath.length === 0) return false
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return false
  }

  const normalized = relativePath.split(sep).join('/').toLowerCase()
  return (
    PROTECTED_FILES.has(normalized) ||
    PROTECTED_DIRECTORIES.some((directory) => isWithin(normalized, directory))
  )
}

// Plain-Russian explanation of a confirm-class command for the owner card.
export { explainCommand, type ExplainCommandOptions } from './explain.js'
