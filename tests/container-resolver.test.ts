// Like container-launcher.test.ts, run the real launcher with a shell probe and a private HOME.
// An outer bwrap supplies a deterministic host /etc and /run, without changing the real host.
// No DNS request is needed: reading resolv.conf is the prerequisite that localhost API tests miss.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const bash = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

const resolverLinks = [
  '../run/systemd/resolve/stub-resolv.conf',
  '/run/NetworkManager/resolv.conf',
  '../run/resolvconf/resolv.conf',
]

test.each(resolverLinks)('test_h1_container_reads_the_host_resolver_through_symlink_%s_without_exposing_run', { timeout: 60_000 }, (link) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dshbot-resolver-test-')))
  try {
    const home = join(scratch, 'owner')
    const dshbotHome = join(home, '.local', 'share', 'dshbot')
    const app = join(dshbotHome, 'app')
    const launcher = join(app, 'scripts', 'dshbot-run.sh')
    const etc = join(scratch, 'host-etc')
    const run = join(scratch, 'host-run')
    const target = link.replace(/^(?:\.\.)?\/run\//, '')
    const resolver = join(run, target)
    const contents = '# resolver fixture\nnameserver 127.0.0.53\nsearch owner.example\noptions edns0 trust-ad\n'
    mkdirSync(dirname(launcher), { recursive: true })
    mkdirSync(etc, { recursive: true })
    mkdirSync(dirname(resolver), { recursive: true })
    mkdirSync(join(run, 'unrelated-service'), { recursive: true })
    copyFileSync(join(repoRoot, 'scripts', 'dshbot-run.sh'), launcher)
    symlinkSync(link, join(etc, 'resolv.conf'))
    writeFileSync(resolver, contents)
    writeFileSync(join(run, 'unrelated-service', 'private'), 'UNRELATED-RUN-SECRET\n')

    const probe = [
      'echo CONTAINER-RESOLVER-BEGIN',
      'cat /etc/resolv.conf',
      'echo CONTAINER-RESOLVER-END',
      'if printf "unexpected-write\\n" >> /etc/resolv.conf 2>/dev/null; then echo RESOLVER-WRITABLE; else echo RESOLVER-READ-ONLY; fi',
      'if [ -e /run/unrelated-service/private ]; then echo UNRELATED-RUN-VISIBLE; fi',
      'echo "CONTAINER-UID=$(id -u)"',
      'echo CONTAINER-PROBE-DONE',
    ].join('\n')
    const launch = (resolverMount?: string) => spawnSync('bwrap', [
      '--unshare-user', '--uid', '0', '--gid', '0',
      // Linux >= 5.12 requires this to map the outer fake root into the launcher's user namespace.
      '--cap-add', 'CAP_SETFCAP',
      '--die-with-parent',
      // The evolve sandbox has no /run; its read-only root cannot create that mount point.
      ...['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/opt', '/nix']
        .filter((path) => existsSync(path))
        .flatMap((path) => ['--ro-bind', path, path]),
      '--dev', '/dev', '--proc', '/proc',
      '--bind', scratch, scratch,
      '--ro-bind', etc, '/etc',
      '--bind', run, '/run',
      '--', bash, '-c', [
        'echo HOST-RESOLVER-BEGIN',
        'cat /etc/resolv.conf || exit 91',
        'echo HOST-RESOLVER-END',
        '[ -r /run/unrelated-service/private ] || exit 92',
        'echo HOST-RUN-CONTROL-READABLE',
        'exec "$@"',
      ].join('\n'),
      'host-probe', bash, launcher, '/bin/sh', '-c', probe,
    ], {
      cwd: app,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        DSHBOT_HOME: dshbotHome,
        DSHBOT_ISOLATION: 'container',
        ...(resolverMount === undefined ? {} : { DSHBOT_CONTAINER_RO: resolverMount }),
      },
      encoding: 'utf8',
      timeout: 45_000,
    })
    // The same fixture works when the resolver directory is explicitly allowed through the existing
    // read-only mount option. This distinguishes the missing automatic mount from a broken nested sandbox.
    const control = launch(dirname(`/run/${target}`))
    const controlDetails = `status=${String(control.status)} error=${String(control.error)}\n${control.stdout}\n${control.stderr}`
    expect(control.status, controlDetails).toBe(0)
    expect(control.stdout, controlDetails).toContain(`CONTAINER-RESOLVER-BEGIN\n${contents}CONTAINER-RESOLVER-END`)
    expect(control.stdout, controlDetails).toContain('RESOLVER-READ-ONLY')
    expect(control.stdout, controlDetails).not.toContain('UNRELATED-RUN-VISIBLE')

    const result = launch()
    const details = `status=${String(result.status)} error=${String(result.error)}\n${result.stdout}\n${result.stderr}`
    expect(result.status, details).toBe(0)
    expect(result.stdout, `the outer host fixture resolves the symlink\n${details}`).toContain(`HOST-RESOLVER-BEGIN\n${contents}HOST-RESOLVER-END`)
    expect(result.stdout, details).toContain('HOST-RUN-CONTROL-READABLE')
    expect(result.stdout, `the real container probe must execute\n${details}`).toContain('CONTAINER-PROBE-DONE')
    expect(result.stdout, details).toContain('CONTAINER-UID=0')
    expect(result.stdout, `resolv.conf must retain the host contents for ${link}\n${details}`).toContain(`CONTAINER-RESOLVER-BEGIN\n${contents}CONTAINER-RESOLVER-END`)
    expect(result.stdout, 'the resolver is mounted read-only').toContain('RESOLVER-READ-ONLY')
    expect(result.stdout).not.toContain('RESOLVER-WRITABLE')
    expect(result.stdout, 'fixing DNS must not expose all of /run').not.toContain('UNRELATED-RUN-VISIBLE')
    expect(readFileSync(resolver, 'utf8'), 'the host resolver is unchanged').toBe(contents)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
