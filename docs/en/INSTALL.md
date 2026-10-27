# Installing DSHBOT

The installer is `scripts/install.sh` in the repository root. One command installs the application, dependencies, settings and systemd user services, starts the bot and helps with owner pairing.

[Русская версия](../INSTALL.md)

## Requirements

- Linux with a user systemd (`systemctl --user`).
- Node.js no older than the version in `engines` in `package.json`.
- `git`.
- `bwrap` (bubblewrap) — required for the `container` mode, optional for `host`.

The installer checks all of this before making any changes: on error it prints a clear message, exits non-zero and creates nothing.

## Guest exec and Node outside HOME

A guest `exec` runs the sandbox proxy and the command itself on a Node outside the user's `HOME`: the guest sandbox masks the home directory, so mise and nvm installations under `HOME` are not visible to a guest. The installer checks this and, if the only Node lives under `HOME`, completes the installation as usual but prints a warning with a hint. Install a system Node with the package manager, for example `sudo apt install nodejs` or `sudo dnf install nodejs`, or point the daemon PATH at a Node outside `HOME`. Without such a Node every guest `exec` is refused with a clear "no Node outside the owner directories" error, while the rest of the guest turn stays available.

## Quick start

Interactive mode:

```sh
scripts/install.sh
```

The installer asks for:

1. the Telegram bot token (`TELEGRAM_BOT_TOKEN`);
2. the DeepSeek key (`DEEPSEEK_API_KEY`);
3. the isolation mode `container` or `host` (`DSHBOT_ISOLATION`).

The entered token and key are never printed. If a variable is already set in the environment, the corresponding question is skipped.

Non-interactive mode:

```sh
TELEGRAM_BOT_TOKEN=... \
DEEPSEEK_API_KEY=... \
DSHBOT_ISOLATION=container \
scripts/install.sh --yes
```

With `--yes` there are no questions: missing values come only from the environment, and installation fails when they are absent. The flag can be written as `--yes` or `-y`.

## Migrating from OpenClaw or Hermes

After a successful installation `scripts/install.sh` checks whether data from another agent already exists:

- OpenClaw — the directory from `$OPENCLAW_STATE_DIR`, otherwise `~/.openclaw`;
- Hermes — the directory from `$HERMES_HOME`, otherwise `~/.hermes`.

A file with that name does not count as a source: it must be a directory. If no directory is found, the installer asks nothing and does not mention migration.

When a source is found, the installer prints its name and path. In a terminal it asks whether to move the data now; if both directories are found, it offers `openclaw`, `hermes` or refusal. On agreement it first runs `dshbot-migrate --dry-run`: the installer shows the plan and separately asks for confirmation to apply it. Only after the second "yes" is the migration applied (with `dshbot-migrate --yes`). Application happens with the `dshbot.service` stopped, after which the installer starts it again. If the service cannot be stopped, the migration is not applied: the installer warns about it and prints the ready command, and the service keeps running.

Without `--migrate`, under `--yes` or without a terminal, the installer asks no questions and does not start the migration: it prints the ready `dshbot-migrate` command with the source and the found path. Copy it if you want to move the data later: in a terminal it shows the plan and asks for confirmation. Stop the service before running it (`systemctl --user stop dshbot.service`) and start it again afterwards; the installer does the same for automatic application. The command uses the full path to the installed `dshbot-migrate` copy and the pinned `node` from the units, so it works even when `node` is not in `PATH`.

The source can be chosen without a question with `--migrate=openclaw|hermes|none`:

| Value | Behaviour |
| --- | --- |
| `--migrate=openclaw` | run an OpenClaw dry run immediately, without the first question |
| `--migrate=hermes` | run a Hermes dry run immediately, without the first question |
| `--migrate=none` | do not offer or run migration |

Without `--yes` the question about applying is still asked after the dry run; without a terminal the question is not asked and counts as refusal: the installer shows the plan and prints the ready command. With `--yes` the migration is applied without questions. If the directory of the chosen source is missing, the installer warns, does not call `dshbot-migrate`, but the installation still succeeds. An unknown value (for example `--migrate=foo`) is rejected with a message about the allowed values before any changes.

A migration error does not cancel the installation: the installer reports that the migration failed and prints its exit code, but the bot stays installed and the service running. The installer runs the migration with `--include-secrets` to transfer key values, but `install.sh` output contains no secrets — neither the ones entered during installation nor the ones read from `dshbot.env`: the plan and report show only names.

More about the transfer itself — `docs/MIGRATION.md`.

## Where things are installed

| What | Path |
| --- | --- |
| Application (git clone, `live` branch) | `~/.local/share/dshbot/app` (or `$DSHBOT_HOME/app`) |
| Bot data, memory, `state.db` | `~/.local/share/dshbot` (or `$DSHBOT_HOME`) |
| Settings | `~/.config/dshbot/dshbot.env` (mode `600`) |
| Services | `~/.config/systemd/user/dshbot.service`, `~/.config/systemd/user/dshbot-doctor.service` |

Settings and services always live under `~/.config`; `XDG_CONFIG_HOME` is ignored: the doctor reads exactly `~/.config/dshbot/dshbot.env`, and the bot's file tools hide exactly `~/.config/dshbot`. A key file elsewhere would become available to the bot.

The installer assembles the units from `deploy/*.service` in the application directory and writes them as ordinary files. It finds the `node` path itself (`process.execPath`) and substitutes it for the mise shim. In the main unit `ExecStart` begins with that `node` path and runs the bridge `<DSHBOT_HOME>/dshbot-launch.mjs`, which hands over to `app/scripts/dshbot-run.sh`: the `host`/`container` choice stays with the launcher. If a custom `DSHBOT_HOME` is set, it replaces `%h/.local/share/dshbot` in `WorkingDirectory`, `Environment=DSHBOT_HOME`, `NODE_COMPILE_CACHE`, `ExecStartPre` and `ExecStart`. The unit files in the repository remain working templates with `%h/.local/share/mise/shims/node`: existing installations that linked `deploy/*.service` keep working.

## Origin and self-update

`/update` and pushing accepted changes to main work through the application's `remote origin`. On a fresh installation the installer takes the source `remote.origin.url` — the checkout from `DSHBOT_INSTALL_SRC` or the repository root — and adds that address to the application. The local source path does not enter origin: it becomes, for example, a GitHub address. A relative source origin path (`../remote.git`) is resolved to an absolute path from the source directory, and credentials (`https://user:token@host/repo.git`) are stripped from the address so the token does not enter the application `.git/config` or the installer output. Only the part before `@` in the host name counts as credentials: `@` in a path (`file:///srv/upstream@mirror.git`) and addresses like `git@github.com:owner/dshbot.git` stay as they are, while `ssh://git@host/repo.git` keeps the ssh user name — only the password is removed.

The address can be set explicitly with `DSHBOT_INSTALL_ORIGIN`; it wins over the source origin:

```sh
DSHBOT_INSTALL_ORIGIN=git@github.com:owner/dshbot.git scripts/install.sh --yes
```

When updating an installation created by the installer, a missing origin is added by the same rules. An existing application origin is not changed, even when `DSHBOT_INSTALL_ORIGIN` is set. A linked worktree of another repository is not touched: its remote config is shared with that repository.

### GitHub authorization for /update and pushing changes

If the application origin is `https://github.com/...`, the installer checks `gh` in `PATH` and its authorization (`gh auth status`). When `gh` is authorized, a credential helper is written into the application repository's local config:

```sh
credential.https://github.com.helper = "!<absolute path to gh> auth git-credential"
```

The path is the one where `gh` was found in `PATH`, made absolute; a symbolic link is not resolved. For `/snap/bin/gh`, for example, the helper gets `/snap/bin/gh`, not the link target `/usr/bin/snap`: that dispatcher selects a program by the name it was invoked with. git runs such a helper through `sh -c`, so a path with a space or another shell-special character is written in single quotes, for example `!'/opt/GitHub CLI/gh' auth git-credential`, and a single quote inside the path as `'\''`: for `/opt/owner's-tools/gh` the helper gets `!'/opt/owner'\''s-tools/gh' auth git-credential`. Any absolute path to an authorized `gh` is written this way.

This is needed because evolution and sync run git with `GIT_CONFIG_GLOBAL=/dev/null`; the global helper created by `gh auth setup-git` is not visible to them. Re-running the installer does not add a second helper with the same value. A linked worktree (`.git` is a file) is not changed: its config is shared with another repository.

If `gh` is missing from `PATH` or not authorized, installation still succeeds, no helper is written, and the installer prints a hint. Run:

```sh
gh auth login
scripts/install.sh --yes
```

The second run writes the helper, after which `/update` and pushing changes to main can work without access to the global git config. Check the entry with:

```sh
git -C ~/.local/share/dshbot/app config --local --get-all credential.https://github.com.helper
```

If the source has no origin and `DSHBOT_INSTALL_ORIGIN` is not set, no origin is created. Installation succeeds, but the installer warns that self-update (`/update` and pushing changes to main) will be unavailable and prints the ready command:

```sh
git -C ~/.local/share/dshbot/app remote add origin <url>
```

## Env file variables

`~/.config/dshbot/dshbot.env` is read by the services through `EnvironmentFile`. The installer creates the file once and never overwrites an existing one.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token from [@BotFather](https://t.me/BotFather) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DSHBOT_ISOLATION` | run mode: `container` or `host` |
| `DSHBOT_OPENAI_PORT` | port of the OpenAI-compatible endpoint for voice clients (together with the token) |
| `DSHBOT_OPENAI_TOKEN` | bearer token of the OpenAI-compatible endpoint; without it the endpoint does not start |
| `DSHBOT_OPENAI_HOST` | listen address of the OpenAI-compatible endpoint, `127.0.0.1` by default |
| `DSHBOT_OPENAI_TLS_CERT` | path to the PEM certificate for the HTTPS endpoint |
| `DSHBOT_OPENAI_TLS_KEY` | path to the PEM certificate key |
| `DSHBOT_NOTIFY_QUEUE` | queue directory of collector cards; `$DSHBOT_HOME/notification-queue` by default |

Additional parameters can be appended to the file by hand: when updating, the installer keeps the file as is.

### OpenAI-compatible API

The `POST /v1/chat/completions` endpoint is a shared OpenAI-compatible API for voice and other clients. Xiaozhi is one example of such a client: a xiaozhi-server on the same machine can hand voice-model tasks to DSHBOT instead of the OpenClaw gateway. The endpoint mirrors an OpenAI-compatible call: the `Authorization: Bearer <DSHBOT_OPENAI_TOKEN>` header, a body with `model`, `user` (device id), `stream: false` and `messages`, and an ordinary `chat.completion` response. Each `user` gets its own session: the next request sees the previous context, while the owner chat in Telegram does not change. The session survives a daemon restart and update: history a device accumulated under an earlier version is moved into the new version's session on its first request. The task runs as an owner model turn with its tools; `tool_choice: "none"` asks for a result without new actions: in such a turn the model receives no tools, even ones connected earlier through `tool_search`. The bot always chooses flash itself, so `model` in the body is only the client's label: clients with `model: "dshbot"` and with any other value are served the same way.

An API request writes nothing to Telegram: the `message`, `plan`, `send_file`, `skill_propose`, `ask_owner`, `self_change` and `self_submit` tools are refused in its turn, background `delegate`, `task create` and immediate schedule runs (`schedule run_now`) are not started: their result would go to the owner chat. A synchronous subagent inherits the same ban. An action that needs an owner confirmation card is refused without a card, and the canary warning stays in the daemon journal. A client may create, change or inspect a future schedule and call `set_next_wakeup`. The API port opens after the command menu is published at daemon start. The request turn joins the shared queue with owner turns and wake-ups, like `/wake`: if the owner is chatting with the bot right now, the request waits for the end of that turn (clients usually wait up to 180 s).

The port and token are set in `~/.config/dshbot/dshbot.env`:

```sh
DSHBOT_OPENAI_PORT=8765
DSHBOT_OPENAI_TOKEN=<long random token>
# Optional: listen address, 127.0.0.1 by default.
DSHBOT_OPENAI_HOST=127.0.0.1
```

Without `DSHBOT_OPENAI_PORT` or `DSHBOT_OPENAI_TOKEN` the listener does not open and the daemon works as before. A port taken by another process does not stop the daemon either: the reason goes to the journal and Telegram keeps working.

To make a client pin the certificate in `tls_ca_file`, set both PEM files. The certificate must be issued for the name the client passes in `tls_server_name` (for example `xiaozhi.test` or the server DNS name); without the `DSHBOT_OPENAI_TLS_CERT` and `DSHBOT_OPENAI_TLS_KEY` pair the endpoint works over HTTP.

```sh
DSHBOT_OPENAI_TLS_CERT=/etc/dshbot/api-server.pem
DSHBOT_OPENAI_TLS_KEY=/etc/dshbot/api-server.key
```

An example LLM block in a voice client config (in xiaozhi-server it is `data/.config.yaml` or a provider profile):

```yaml
LLM:
  provider: openai
  model: "dshbot"
  base_url: https://127.0.0.1:8765/v1
  api_key: <DSHBOT_OPENAI_TOKEN>
  tls_ca_file: /etc/dshbot/api-server.pem
  tls_server_name: xiaozhi.test
```

`base_url` must start with `https://` and end with `/v1` — the client appends `/chat/completions`. The token and certificate in the block must match the daemon env file. After changing the env file restart the service: `systemctl --user restart dshbot.service`.

### Collector notification queue

Collectors put `<sha256>.json` cards into the `DSHBOT_NOTIFY_QUEUE` directory (`$DSHBOT_HOME/notification-queue` by default) and images into `<queue parent>/artifacts/<id>.png`. Create the directories and let the collector write to them:

```sh
mkdir -p "$DSHBOT_HOME/notification-queue" "$DSHBOT_HOME/artifacts"
```

The daemon polls the directory once a second and sends cards to the owner in Telegram without a model turn. After a successful send the file gets the `.accepted` suffix, a broken file gets `.rejected`; a Telegram error leaves `.json` until the next poll. Cards older than 24 hours at first discovery arrive as one summary per source. Before sending, the daemon stores the first-discovery time and the card SHA-256 in `<name>.json.seen` next to it: keep these service files together with pending cards when moving the queue. They survive a restart and are removed after a card is accepted or rejected. The daemon needs permission to create and rename files in the queue directory; a read or write error of the mark pauses delivery with a journal entry. If `DSHBOT_NOTIFY_QUEUE` points to another directory, `artifacts/` lives next to it, not in `DSHBOT_HOME`.

A `url` is included in a normal card, in an image caption or its continuation, and in a v3 report heading. A v3 report preserves the order of text blocks, photos, tables and dividers; v2 is shown as a normal card. Text is escaped for Telegram HTML. The limits of 4096 UTF-16 units for a message and 1024 for a caption count emoji; the rest of a long caption and long cells goes in following messages without losing text. All card PNGs are checked before the first message is sent: valid chunks with CRCs and non-empty IDAT data are required, a single IHDR and IEND are not enough.

### Isolation modes

- `container` — the whole daemon runs inside `bwrap` with a fake root: the application directory and toolchain are read-only, `DSHBOT_HOME` is writable, the network is shared. `bwrap` is required; without it installation stops and running without the container is forbidden.
- `host` — the daemon runs directly as your user, without a sandbox. This is the default mode (including an empty value). Without `bwrap` the installer only warns.

More about startup — `scripts/dshbot-run.sh` and `docs/DESIGN.md`.

## Service and autostart

The installer runs `systemctl --user daemon-reload` and `systemctl --user enable --now dshbot.service`. The second service, `dshbot-doctor.service`, is started by systemd through the main unit's `OnFailure=` and is not enabled separately.

User services run while there is an active login session. For the bot to live after logout, lingering is needed:

```sh
sudo loginctl enable-linger "$USER"
```

The installer does not call `sudo`: if `Linger=no`, it prints this command with an explanation.

Useful commands:

```sh
systemctl --user status dshbot.service
systemctl --user restart dshbot.service
journalctl --user -u dshbot.service -f
```

## Owner pairing

After the first private message the bot prints a one-time code into the journal:

```text
pairing code for private chat <id>: <code>
```

The installer looks for the code only among the records of the current service run: after `start`/`restart` it takes the `InvocationID` (`systemctl --user show -p InvocationID --value dshbot.service`) and the start time, then reads the journal filtered by `_SYSTEMD_INVOCATION_ID` and `--since`. A code from a previous installation left in the journal after `--purge` or a restart is therefore not printed instead of the new one.

In interactive mode the installer itself asks you to message the bot and waits up to 120 seconds for a code from the current run, then prints the code and explains what to send.

In `--yes` mode the installer does not wait: it prints the ready command with the `InvocationID` and start time already substituted, which can show the code. The same manually:

```sh
journalctl --user -u dshbot.service -n 200 --no-pager \
  "_SYSTEMD_INVOCATION_ID=$(systemctl --user show -p InvocationID --value dshbot.service)"
```

The code must be sent to the bot in a private message as one message — after that the chat becomes the owner.

## Updating

Running `scripts/install.sh` again (interactively or with `--yes`) updates the installation:

1. fetches a new tip from the source;
2. runs `npm ci` in the application directory;
3. installs the units again with the current `node` path;
4. restarts `dshbot.service`.

If `~/.config/systemd/user/dshbot.service` or `dshbot-doctor.service` is a symbolic link from an earlier manual installation to `deploy/*.service` in the application directory, the installer replaces the link itself with an ordinary file. The templates in `deploy/` are not changed and the application working tree stays clean.

The existing `dshbot.env`, `state.db` and memory are not changed.

The update protects data:

- if the application working tree has uncommitted changes, installation stops with a message and changes nothing;
- if the `live` branch has local commits (self-evolution changes) that are not in the new version, the old tip is tagged `pre-install-<time>` and the tag name is printed;
- if the `app` directory exists but is not a DSHBOT installation (no git repository or no `live` branch), it is not deleted but moved next to itself in the data directory: `~/.local/share/dshbot/app.prev-<time>` (or `$DSHBOT_HOME/app.prev-<time>`); the path is printed.

The default code source is the repository root from which the script was started. For another checkout set `DSHBOT_INSTALL_SRC=/path/to/dshbot`.

## Removal

Remove the services and code while keeping memory and settings:

```sh
scripts/install.sh --uninstall
```

Both services are stopped and disabled, the unit files and the application directory are removed. `DSHBOT_HOME` (memory, `state.db`) and `~/.config/dshbot/dshbot.env` remain.

Full removal, including memory and settings:

```sh
scripts/install.sh --purge
```

Before removal the installer prints the exact paths and asks you to type the word `удалить`; any other answer cancels removal and nothing is deleted. The `--yes` flag replaces this confirmation: the paths are printed and removal happens immediately, without a question.

The `DSHBOT_HOME` path is first reduced to canonical form (symbolic links and `.` and `..` segments resolved); exactly that path is checked, printed and removed. If `DSHBOT_HOME` itself is a symbolic link, it is removed too. Removal refuses to work even with `--yes` if the path is empty, not absolute, does not exist, points to `/`, the home directory or a directory above it, or has no `state.db`. Non-interactive variant:

```sh
DSHBOT_HOME=~/.local/share/dshbot scripts/install.sh --purge --yes
```

## Installer environment variables

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token; without it interactive mode asks, `--yes` fails |
| `DEEPSEEK_API_KEY` | DeepSeek key; the same rule |
| `DSHBOT_ISOLATION` | `container` or `host` (`host` by default) |
| `DSHBOT_HOME` | data directory instead of `~/.local/share/dshbot`; the application goes to `$DSHBOT_HOME/app` and the path is written into the units. An absolute path is required, without `.` and `..` segments, spaces, quotes or the characters `\ % $`, and not equal to the home directory. For update, `--uninstall` and `--purge`, set the same `DSHBOT_HOME` |
| `DSHBOT_INSTALL_SRC` | source directory instead of the current repository root |
| `DSHBOT_INSTALL_ORIGIN` | `remote origin` address of the application for `/update` and pushing changes to main instead of the source origin |

## If something went wrong

- `node ... below the required version` — update Node.js to the version in `engines` in `package.json`.
- `git not found` — install git.
- `container mode requires bwrap` — install bubblewrap or use `DSHBOT_ISOLATION=host`.
- The service does not start — `journalctl --user -u dshbot.service -n 100 --no-pager`; the separate doctor `dshbot-doctor.service` messages the owner in Telegram when the main service has crashed.
- The pairing code did not appear — make sure the bot received a private message and inspect the log of the current run: `journalctl --user -u dshbot.service -f "_SYSTEMD_INVOCATION_ID=$(systemctl --user show -p InvocationID --value dshbot.service)"`. If the output shows a code from a previous installation, check `InvocationID`: it changes after a service restart, while old journal records remain.
