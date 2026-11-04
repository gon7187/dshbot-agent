# Full Superagent runtime

The runtime is assembled from the DeepSeek Superagent prototype at
`https://github.com/deepseek-ai/dsh-superagent-prototype`, commit
`6337fc823ce20251c8de8085948165c81aaa701e`. The installer verifies that commit,
runs the upstream `pnpm check` once for a fresh clone, packs the built package,
and keeps its MIT `LICENSE` in `upstream/`. The source checkout is never edited;
the packed copy receives one recorded adapter overlay so the runtime keeps the
upstream package name and `dsh.client` metadata while its server entry is gated
by the Telegram guard.

The local CLI is pinned to `@deepseek-ai/dsh@0.2.1-rc.3`; its entry point is
`node_modules/@deepseek-ai/dsh/lib/bin.js`. Runtime dependencies are installed
under the output directory with the checked-in npm lockfile. The output pins
the upstream runtime's `proper-lockfile` and `zod` dependencies locally, plus
the stable `@deepseek-ai/schemastery@3.18.5` required by the rc.3 CLI, and
`pnpm@11.7.0` for profile-local plugin management. The runtime is intended to
be mounted read-only at `/opt/superagent`; profile state and credentials belong
under the sandbox's `$DSH_HOME`, not in this tree.

## Build

Build with Node `>=24.0.0` and pnpm 11.7.0 on `PATH` (the checked verification
run used Node 26; the assembled runtime declares the same Node 24 floor as the
upstream and production runtime):

```sh
node integrations/superagent/prepare.mjs --output /opt/superagent
```

An already-built, clean checkout at the pinned commit can be reused without
running the upstream test suite again:

```sh
node integrations/superagent/prepare.mjs \
  --output /opt/superagent \
  --source /home/user/.cache/dsh-superagent-upstream
```

The output contains `upstream/`, `telegram/`, `guard.ts` plus its
`explain.ts`/JS loader seam, `bootstrap.mjs`, the local DSH CLI, and
`receipt.json` with the upstream SHA, source-package hash, adapted-package
hash, artifact hash, Node, pnpm, DSH version, and the adapter id/files. The
packed `upstream/lib/index.js` is a tiny adapter; the original upstream entry
is retained as `upstream/lib/runtime-original.js`, while the upstream
`package.json`, `dsh.client` declaration, `./client` export, and built client
bundle remain in place. This is what lets `dsh-client-modules` keep the
Superagent UI row instead of treating the Telegram runtime subpath as a
non-client package. An existing non-empty output is always rejected; publish
a new runtime directory for a new immutable release.

The installer applies the same narrow compatibility overlay to the copied
Telegram files: its runtime adapter imports
`../upstream/lib/runtime-original.js`, and its bundle patch inserts the
guard/Telegram rows without replacing the `dsh-superagent` row. Keeping that
row name is part of the packaging contract: the upstream manifest, not the
Telegram runtime subpath, owns the browser client metadata and bundle. The
source checkout is not modified.

## Fixed sandbox contract

The host supervisor mounts each project into its own bubblewrap instance. The
runtime release and bridge mounts are read-only; only the private project
home is writable:

| Path inside bwrap | Purpose |
| --- | --- |
| `/opt/superagent` | immutable runtime release |
| `/opt/node` | selected Node binary |
| `/home/user` | private per-project home and `$DSH_HOME` |
| `/run/superagent` | private bridge sockets |
| `/run/superagent-net/proxy.sock` | the only allowed network egress socket |
| `/home/user/panel.sock` | panel UDS used by the host relay |

The fixed child environment is `HOME=/home/user`,
`DSH_HOME=/home/user/.dsh`, and
`PATH=/opt:/opt/superagent/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`.
The supervisor injects model settings only as ephemeral environment variables;
credentials are not written into the runtime, profile patch, or image.

The corresponding bwrap shape is:

```sh
bwrap --die-with-parent --new-session --unshare-pid --unshare-net \
  --unshare-ipc --unshare-uts \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin \
  --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc \
  --proc /proc --dev /dev --tmpfs /tmp --dir /home --dir /opt --dir /run \
  --bind "$PROJECT_HOME" /home/user \
  --ro-bind "$RUNTIME_DIR" /opt/superagent \
  --ro-bind "$NODE_BIN" /opt/node \
  --ro-bind "$BRIDGE_DIR" /run/superagent \
  --ro-bind "$NETWORK_DIR" /run/superagent-net \
  --chdir /home/user \
  --setenv HOME /home/user \
  --setenv DSH_HOME /home/user/.dsh \
  --setenv PATH /opt:/opt/superagent/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /opt/node /opt/superagent/bootstrap.mjs
```

`PROJECT_HOME`, `RUNTIME_DIR`, `NODE_BIN`, `BRIDGE_DIR`, and `NETWORK_DIR`
are host-side paths supplied by the supervisor, not user-controlled profile
values. `NETWORK_DIR` contains the already-created `proxy.sock`; the runtime
cannot create a direct network namespace route.

## Bootstrap a sandbox profile

Profile initialization is deliberately separate from the runtime build. Every
factory project gets a separate private `PROJECT_HOME` mount and therefore a
separate `DSH_HOME`, profile, state directory, credentials namespace and
working tree. The profile name remains `superagent` because `bootstrap.mjs`
uses that fixed name; never point two projects at the same home.

Inside the bwrap sandbox, with `DSH_HOME=/home/user/.dsh` and the
working directory set to `/home/user`, expose the bundled CLI tools:

```sh
export PATH=/opt/superagent/node_modules/.bin:/opt:$PATH
```

Initialize a missing custom profile once. The guard refuses to replace an
existing profile; do not run `--from-default-profile` for upgrades:

```sh
PROFILE_DIR="$DSH_HOME/profiles/superagent"
if [ -e "$PROFILE_DIR" ]; then
  test -f "$PROFILE_DIR/package.json" || { echo 'profile exists but is incomplete' >&2; exit 1; }
else
  /opt/node /opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js \
    --profile superagent --from-default-profile web --dump-config >/dev/null
fi
```

Install the two immutable links through the runtime-local pnpm:

```sh
/opt/node /opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile superagent add link:/opt/superagent/upstream
/opt/node /opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile superagent add link:/opt/superagent/telegram
```

The shipped `web` template only creates the base bundle layer. Before launch,
the separate profile initializer must add the upstream `stateDir` and project
settings. A minimal project-local patch, with no credentials, is:

```sh
umask 077
STATE_DIR=/home/user/state
# Set PROJECT_ID and TELEGRAM_OWNER_ID to the connected factory project and owner.
: "${PROJECT_ID:?}" "${TELEGRAM_OWNER_ID:?}"
mkdir -p "$STATE_DIR"
cat > "$DSH_HOME/profiles/superagent/cordis.patch.yml" <<YAML
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: $STATE_DIR
- id: dshbot-superagent-guard
  config:
    socketPath: /run/superagent/superagent.sock
    projectId: $PROJECT_ID
    stateDir: $STATE_DIR
- id: dshbot-superagent-telegram
  config:
    socketPath: /run/superagent/superagent.sock
    projectId: $PROJECT_ID
    ownerId: $TELEGRAM_OWNER_ID
YAML
```

Use `/home/user/state` for `stateDir`: the owner panel reads its private
`panel-auth.json` handshake there. The host's initializer must keep state under
this private home and must not bind another
project's home, profile or credential directory.

The prototype's manifest targets the alpha.2 DSH line, declares
`@deepseek-ai/cordis@4.0.5-alpha.1`; this runtime and the local Telegram
adapter use DSH rc.3 (whose
bundled dependencies are the stable `~4.0.5` Cordis and `~3.18.5`
Schemastery lines). npm cannot install both Schemastery lines at the runtime
root because rc.3 peers require stable `~3.18.5`; the local Telegram adapter
therefore declares the stable version used by this runtime. With the pinned rc.3 CLI and plugin manager, both `link:`
installs above were tested successfully without an exemption. If a later CLI
rejects the upstream manifest with `incompatible-version`, inspect it with:

```sh
/opt/node /opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile superagent version-exemptions
```

Then, only after accepting that exact compatibility risk for this sandbox
profile, grant the exact pair the CLI names (currently):

```sh
/opt/node /opt/superagent/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile superagent allow-version dsh-superagent@0.1.0 \
  --dsh-version 0.2.1-rc.3 --accept-risk
```

Retry the two `add link:` commands after the grant. The Telegram plugin has no
separate DSH engine range; its linked package is resolved against the stable
Schemastery pinned in the read-only runtime. No global DSH install, profile,
credential, or production service is created by `prepare.mjs`.

## Host configuration

Install each private home under `$DSHBOT_HOME/superagent/projects/<project-id>`
with mode `0700`. The bot binds only that project's bridge directory and
starts a separate network namespace. Register the immutable runtime and
project ports in `$DSHBOT_HOME/superagent/runtime.json`, for example:

```json
{
  "runtimeDir": "/opt/dshbot-superagent/releases/verified-sha",
  "projects": [{ "id": 0, "port": 3082 }]
}
```

Every ID must come from `/factory`; assign distinct ports and match each
profile's webserver port. The optional feature is absent when this file is
absent. The initial state is paused. `/superagent status` returns private
loopback panel links with a browser authentication handoff; never
publish or log those links. Use an SSH local tunnel to the chosen host port
when opening the panel from another machine.

## GitHub and local delivery gate

The owner authorized the existing GitHub account for projects connected in
`/factory`, with local tests and independent review in place of unavailable
CI. The broker is available when the configured profile is explicitly resumed.
Credentials stay in the host bot's existing `gh` configuration. Do not copy
`GH_TOKEN`, `hosts.yml`, SSH keys or credential helpers into a profile, the
runtime release, or a factory image.

Every `/factory` project must use its own isolated profile, private
`DSH_HOME`, state directory, working tree, bridge socket and network namespace;
sharing a profile or home between projects is unsupported.

Set the GitHub Source's `cli` to
`/opt/superagent/telegram/github-cli.mjs` and its repository to the connected
project's canonical GitHub repository. The wrapper calls the project-bound
host socket: setup and repository reads are scoped there, and only the
supported discussion replies can mutate GitHub through this route. Repository
deletion, arbitrary API writes, credentials and cross-project access are not
available. The upstream excludes events authored by its own account; send
owner tasks through Telegram when sharing that account.

For the Execution prepare command, use the credential-free checkout wrapper
from the execution root, targeting the directory that the pinned Executor
creates after prepare:

```sh
/opt/superagent/telegram/github-cli.mjs dshbot checkout "$DSH_SUPERAGENT_DIR"
```

The pinned Executor runs prepare in `dirname "$DSH_SUPERAGENT_DIR"` before the
ticket directory exists; targeting `.` would clone into that shared parent and
make the first ticket poison later tickets. The wrapper validates that the
expanded absolute target is a new child of the prepare cwd, refreshes the
host's project mirror, and clones its read-only mount into that ticket
directory. To update an existing checkout, call `dshbot refresh` with the same
CLI, then fetch its local mirror remote. No GitHub token is returned.

A new profile installs delivery instructions naming this fixed helper:

```sh
/opt/node /opt/superagent/telegram/delivery-cli.mjs "Describe the change"
```

Run it from a clean, committed ticket checkout. It submits a bounded patch;
the native upstream supplies `DSH_SUPERAGENT_NAME` for the active ticket. The
wrapper validates that slug, includes it in the request and deterministic
delivery id, and the host uses it as the final branch segment; an absent
value is retained only for manual compatibility probes.
The host reconstructs the candidate at the current default-branch commit,
checks the actual changed paths, runs the project's `/factory` test command
in the existing isolated gate, and independently reviews the exact diff.
Worker-written test or review receipts are never accepted. Protected paths,
unsupported dependency changes, oversized/binary patches, changed test trees
and stale bases fail closed.

After those checks, the host opens a PR and attempts a normal, non-force push
of the checked merge commit to the default branch. This preserves ancestry
and rejects a concurrently advanced base. GitHub branch protections still
apply: a rejected integration leaves the PR open and reports that state.
Only a verified merged receipt means success. Interrupted jobs do not resume
external writes automatically. Pause prevents new requests; an external request
already accepted by GitHub may still finish and must be reconciled before retrying.
Existing customized prompt revisions are kept;
their delivery section must name the same helper before enabling work.

Deployment always requires a separate owner command. Each factory project
retains its own isolated profile, state and bound bridge socket.

## THIRD_PARTY_NOTICES

- The source checkout for `upstream/` is the pinned DeepSeek Superagent
  prototype above; its MIT license is preserved at `upstream/LICENSE`. The
  packaged copy has only the recorded `dsh-superagent-runtime-wrapper-v1`
  adapter overlay described above; that overlay also normalizes the copied
  Telegram runtime/patch seam. The original server entry remains beside it as
  `upstream/lib/runtime-original.js`.
- `@deepseek-ai/dsh@0.2.1-rc.3`, `pnpm@11.7.0`, and the npm dependency tree are
  installed from the checked-in npm lockfile. Their package license and
  integrity metadata remain in `package-lock.json` and the installed package
  manifests; the runtime does not relicense or patch them.
- The copied Telegram and guard modules remain project-owned source. The
  runtime installer does not edit that source checkout; the immutable output
  receives only the recorded runtime/patch seam normalization above.
