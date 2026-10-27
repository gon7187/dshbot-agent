import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The hygiene gate of the public repository: tracked files must carry no
// personal paths, private-network addresses, credential-shaped strings or
// secret-bearing files. Tests and test-support directories are exempt: they
// hold deliberate fixtures. The scan itself runs on any git work tree, so the
// gate can be proven against a planted file without touching the real repo.
const root = fileURLToPath(new URL('../..', import.meta.url))

const ALLOWED_HOME_NAMES = new Set(['user', 'guest'])
const FORBIDDEN_FILE = /(?:^|\/)(?:\.env|[^/]*\.env|[^/]*\.pem|[^/]*\.key|[^/]*\.sqlite|[^/]*\.db)$/

const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
const PRIVATE_IPV4 = new RegExp(
  `(?<![\\d.])(?:10\\.${OCTET}\\.${OCTET}\\.${OCTET}|172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}|192\\.168\\.${OCTET}\\.${OCTET})(?![\\d])(?!\\.\\d)(?!/\\d)`,
  'g',
)

const KEY_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['sk- key', /(?<![A-Za-z0-9_-])sk-(?![A-Za-z0-9_-]*not-a-real)[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,}/],
  ['GitHub fine-grained token', /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}/],
  ['Slack token', /(?<![A-Za-z0-9])xox[bp]-[A-Za-z0-9-]{10,}/],
  ['AWS access key', /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/],
  ['Telegram bot token', /(?<![\d:])\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/],
  ['private key block', /BEGIN (?:[A-Z]+ )*PRIVATE KEY/],
]

function trackedFiles(repo: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repo, maxBuffer: 1 << 28 }).toString('utf8')
  return out.split('\0').filter((path) => path !== '')
}

function exempt(path: string): boolean {
  return /\.test\.ts$/.test(path) || path.split('/').includes('test-support')
}

function scanText(path: string, text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\/home\/([A-Za-z0-9_.-]+)\//g)) {
    if (!ALLOWED_HOME_NAMES.has(match[1]!)) found.push(`${path}: personal absolute path ${match[0]}`)
  }
  for (const match of text.matchAll(PRIVATE_IPV4)) found.push(`${path}: private network address ${match[0]}`)
  for (const [label, shape] of KEY_SHAPES) {
    if (shape.test(text)) found.push(`${path}: ${label}`)
  }
  return found
}

function scan(repo: string): string[] {
  const found: string[] = []
  for (const path of trackedFiles(repo)) {
    if (exempt(path)) continue
    const name = basename(path)
    if (FORBIDDEN_FILE.test(path) && name !== '.env.example') found.push(`${path}: forbidden tracked file`)
    let isFile = false
    try { isFile = lstatSync(join(repo, path)).isFile() } catch { /* deleted but still indexed */ }
    if (!isFile) continue
    const buffer = readFileSync(join(repo, path))
    if (buffer.includes(0)) continue
    found.push(...scanText(path, buffer.toString('utf8')))
  }
  return found
}

function plantedRepo(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dshbot-hygiene-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  execFileSync('git', ['add', '-A', '-f'], { cwd: dir })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('test_c7_hygiene_gate_flags_every_violation_class_and_accepts_allowed_forms', () => {
  const allowed = plantedRepo({
    'docs/paths.md': 'Work in /home/user/project or /home/guest/work; subnet 192.168.0.0/16 and 10.0.0.0/8 are ranges.\n',
    'docs/versions.md': 'Version 1.10.0.1 and 110.1.1.1 and 9.172.16.1.5 are not hosts. A task-queue-with-a-very-long-name is not a key.\n',
    '.env.example': 'TELEGRAM_BOT_TOKEN=\nDEEPSEEK_API_KEY=\n',
    'packages/x/test-support/fixture.ts': `const k = '${'sk-' + 'a'.repeat(30)}'; // /home/someone/x\n`,
    'packages/x/leak.test.ts': `const p = '/home/someone/x'; const ip = '192.168.1.5'\n`,
    'src/mask.ts': 'const re = /-----BEGIN [A-Z ]*PRIVATE KEY-----/\n',
  })
  try {
    expect(scan(allowed.dir)).toEqual([])
  } finally {
    allowed.cleanup()
  }

  const violations: Record<string, string> = {
    'docs/home.md': 'see /home/someone/notes/file.txt\n',
    'docs/ip10.md': 'host 10.1.2.3 is up\n',
    'docs/ip172.md': 'host 172.20.0.7:22\n',
    'docs/ip192.md': 'ssh 192.168.1.50\n',
    'docs/sk.md': `key ${'sk-' + 'A1b2'.repeat(6)}\n`,
    'docs/ghp.md': `token ${'ghp_' + 'a1B2'.repeat(9)}\n`,
    'docs/pat.md': `token ${'github_pat_' + 'a1B2_'.repeat(8)}\n`,
    'docs/xoxb.md': `slack ${'xoxb-' + '1234567890-abcdefghij'}\n`,
    'docs/xoxp.md': `slack ${'xoxp-' + '1234567890-abcdefghij'}\n`,
    'docs/aws.md': `aws ${'AKIA' + 'ABCDEFGHIJKLMNOP'}\n`,
    'docs/tg.md': `bot ${'123456789' + ':' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R'.slice(0, 35)}\n`,
    'docs/pem.md': `${'-----BEGIN ' + 'RSA PRIVATE KEY-----'}\nabc\n`,
    'config/prod.env': 'A=1\n',
    '.env': 'A=1\n',
    'certs/server.pem': 'x\n',
    'certs/server.key': 'x\n',
    'data/state.sqlite': 'x\n',
    'data/state.db': 'x\n',
  }
  const planted = plantedRepo(violations)
  try {
    const found = scan(planted.dir)
    for (const path of Object.keys(violations)) {
      expect(found.some((line) => line.startsWith(`${path}:`)), `${path} must be flagged`).toBe(true)
    }
  } finally {
    planted.cleanup()
  }
})

test('test_c7_tracked_files_of_the_repository_are_clean', () => {
  expect(scan(root)).toEqual([])
})
