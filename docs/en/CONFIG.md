# Environment variables

The code reads variables from the process environment. In a service installation they live in `~/.config/dshbot/dshbot.env`, which systemd loads through `EnvironmentFile`; the installer creates the file with mode `600`. Empty values are usually treated as unset, with exceptions noted in the tables. The full list of owner commands is in [COMMANDS.md](COMMANDS.md), installation is in [INSTALL.md](INSTALL.md).

[Русская версия](../CONFIG.md)

## Connection, paths and time

| Variable | Purpose | Default |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from [@BotFather](https://t.me/BotFather); the daemon does not start without it. | required |
| `DEEPSEEK_API_KEY` | DeepSeek API key; the daemon does not start without it. | required |
| `DEEPSEEK_BASE_URL` | Base address of the DeepSeek Messages API. | `https://api.deepseek.com/anthropic` |
| `TELEGRAM_API_ROOT` | Base address of the Telegram Bot API; needed for a local mirror or proxy. | `https://api.telegram.org` |
| `DSHBOT_HOME` | Data directory: `state.db`, memory, sessions, workspace and the bot's caches. | required in the service; the installer sets `~/.local/share/dshbot` |
| `DSHBOT_ISOLATION` | How the daemon runs: `container` (bwrap with a fake root) or `host` (directly). | `host` |
| `DSHBOT_TZ` | The owner's time zone in IANA form, for example `Europe/Moscow`; it sets schedules, quiet hours and the evening summary. | the host time zone |
| `DSHBOT_SHA` | Short sha of the running code for `/status`; needed when the application directory is not a git repository. | HEAD of the current checkout, then `stable` from `adopt.json` |
| `DSHBOT_DOCTOR_GRACE_MS` | Recovery doctor grace window in milliseconds: while the unit is not active, the doctor waits this long for it to become `active` before telling the owner it is down. An empty, non-numeric, zero or negative value gives the default. | `30000` |
| `HOME` | The owner's home directory: the path to `~/.config/dshbot`, migration and the host command profile. | the user's home directory |
| `PATH` | Lookup path for executables, Chromium and sandbox tools. | the daemon process PATH without mise shim directories |

## Owner character

The owner's personal style is not stored in the repository: the file lives in `DSHBOT_HOME/persona/`. Guests receive neither the owner's personal file nor the neutral `persona/character.md` from the repository.

| File | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_HOME/persona/character.md` | The owner's personal character: a non-empty file replaces the repository's neutral `persona/character.md` in the owner system prompt. An empty or missing file keeps the repository character. | the repository `persona/character.md` |

The file is read when the daemon starts. Restart the bot after changing the character.

## Model providers

Besides DeepSeek through `DEEPSEEK_API_KEY`, the runner can call the harness
providers of `dsh-llm-pi-ai`: `zai` (z.ai Coding Plan by key), `openai-codex`
(ChatGPT OAuth sign-in), `openai`, `anthropic`, `google`, `xai`, `moonshotai`,
`kimi-coding`, `minimax`, `openrouter`, `github-copilot` and `qwen-token-plan`.
A key or OAuth sign-in is stored in the harness credential file
`DSHBOT_HOME/dsh/.credentials.yaml` with mode `0600`; the DeepSeek key is never
written there. The file lives outside the workspace, and the agent tools
(`read`, `list`, `grep`, `exec`) cannot read it.

The model catalogue (`runner.models()`, the factory «Models» menu and the role
menus) lists only providers with a stored sign-in. Removing a sign-in record
removes that provider's models from the catalogue; the `deepseek-official`
route works from `DEEPSEEK_API_KEY` and needs no record.

A model declares its own reasoning levels through the adapter
(`resolveModelInfo`): for DeepSeek they are `off`, `low`, `high` and `max`, for
provider models their own set (`minimal`, `medium`, `xhigh` and so on).
`/effort` and the role screen list the levels of the current model; a saved
level the model does not offer is not sent, and the turn runs on the model
default.

## Turns, limits and guests

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_TURN_TIMEOUT_MS` | Ceiling for one model turn in milliseconds; the turn is cancelled when it expires. | `1800000` (30 minutes) |
| `DSHBOT_TURN_TIMEOUT_SEC` | The same turn ceiling in seconds; used only when `DSHBOT_TURN_TIMEOUT_MS` is unset. | `1800` |
| `DSHBOT_TEST_TURN_EVENTS` | Tests only: `1` enables the journal lines `test:turn-complete` after a turn, once all its Telegram sends are done, and `test:update-complete update_id=<id>` after an incoming update is handled, including updates without a turn; harnesses wait for these events instead of a quiet window. | unset (events disabled) |
| `DSHBOT_MAX_TURN_ITERATIONS` | Limit of model iterations in one turn. | `210` |
| `DSHBOT_DEBOUNCE_MS` | Pause that collects nearly simultaneous owner messages (a forwarded burst, a long text Telegram split into parts) into one turn. | `300` |
| `DSHBOT_INGRESS_MAX_ATTEMPTS` | How many times an incoming message handler is retried after a failure. | `3` |
| `DSHBOT_POLL_STALL_MS` | How long the Telegram poll may go without completing a cycle before the daemon exits for a systemd restart. | `300000` (5 minutes) |
| `DSHBOT_AUTO_COMPACT_TOKENS` | Threshold for automatic compaction of the main context in tokens; `0` disables automatic compaction, `/compact` always works. An owner turn waits for compaction only when the context is at least twice the threshold (the hard limit); between the threshold and that limit the turn runs at once on the uncompacted history and the compaction runs in the idle time after the reply. | `128000` |
| `DSHBOT_TASK_PARALLELISM` | How many autonomous tasks may run at the same time; `0` removes the global limit, the per-project lease remains. | `0` (no global limit) |
| `DSHBOT_GOAL_MAX_TURNS` | Turn limit for one `/goal` goal or `/loop` cycle. | `20` |
| `DSHBOT_GOAL_MAX_USD` | Spending limit for one goal or cycle in US dollars. | `2` |
| `DSHBOT_GUEST_DAILY_LIMIT` | Guest or group messages per UTC day. | `50` |
| `DSHBOT_GUEST_DAILY_USD` | Guest or group spending per UTC day in US dollars. | `1` |
| `DSHBOT_GUEST_MIN_INTERVAL_MS` | Minimum interval between messages from one guest or group; `0` disables the check. | `3000` |
| `DSHBOT_GUEST_TOOLS` | `off` gives a guest a turn without the `exec`, `web_search` and `web_fetch` tools. | `on` |

## Autonomy and schedules

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_AUTONOMY` | Wake-up autonomy level: `observe`, `act` or `full`. | `act` |
| `DSHBOT_QUIET_HOURS` | The owner's quiet hours in `HH-HH` form; an empty value disables the window. | `23-9` |
| `DSHBOT_PROACTIVE_PER_DAY` | How many messages on its own initiative the bot may start per owner day. | `6` |
| `DSHBOT_WAKE_JITTER` | Relative spread of the wake-up interval from 0 to 1; `0` gives exactly the base. | `0.3` |
| `DSHBOT_FREE_WAKE_CHANCE` | Probability that a wake-up becomes a reflective "free minute". | `0.25` |
| `DSHBOT_DREAM_AT` | Time of the nightly memory consolidation `HH:MM`, or `off` to disable it. | `03:00` |
| `DSHBOT_BACKUP_AT` | Time of the daily snapshot of `state.db` and the bot files `HH:MM`. | `04:00` |
| `DSHBOT_BACKUP_KEEP` | How many recent snapshots stay in `backups/`. | `7` |
| `DSHBOT_SYNC_AT` | Time of the daily `origin/main` check `HH:MM`. | `04:00` |
| `DSHBOT_AUTO_SYNC` | `off` disables the daily automatic sync; `/update` always works. | `on` |
| `DSHBOT_EVOLVE_INTERVAL` | Interval of self-development cycles: `30m`, `2h` or `1d`, at least `30m`. | `2h` |
| `DSHBOT_EVOLVE_AUTO_ADOPT` | Comma-separated path prefixes whose changes the bot adopts without an owner card. | empty (auto-adoption disabled) |
| `DSHBOT_EVOLVE_GATE_TIMEOUT_MS` | Limit for the whole self-change gate in the sandbox in milliseconds: the typecheck and the related tests must both fit the deadline, which can be tight on a slow host. The ordinary gate runs the candidate's `gate` script (`npm run typecheck` over the whole tree, then `vitest related --run` only for tests related to the changed files); the full `npm test` runs when the candidate has no `gate` script or changes `vitest.config.*` or `tsconfig*.json`. An empty, non-numeric, zero, negative or fractional value gives the usual limit; an explicit `timeoutMs` from the caller wins over the variable. Any integer up to `9007199254740991` is accepted: a limit above `2147483647` ms (about 24.8 days, the ceiling of one Node timer) is waited out with several consecutive timers and does not fire early. | `600000` |
| `DSHBOT_UPSTREAM` | `off` disables pushing accepted changes to `main`: the bot only counts its own commits. | `on` |

## Tools and sandbox

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_EXEC_RO_PATHS` | Extra toolchain directories mounted read-only in the sandbox; a colon-separated list. | `~/.local/share/mise:~/.local/bin:~/.cargo/bin:~/.rustup` |
| `DSHBOT_HOST_WRITABLE` | Directories additionally opened for writing in `host_exec`; a colon-separated list. | only `DSHBOT_HOME` and `/tmp` |
| `DSHBOT_SUBAGENT_PARALLELISM` | How many subagents may work at the same time. | `3` |
| `DSHBOT_FETCH_SAVE_MAX_BYTES` | Ceiling for a response body that `web_fetch` saves to a file. | `5242880` (5 MiB) |
| `DSHBOT_BROWSER_PATH` | Path to Chromium for the `browser` tool. | Chromium found in `PATH` |
| `DSHBOT_BROWSER_IDLE_MS` | After how much idle time the browser closes. | `300000` (5 minutes) |
| `DSHBOT_BROWSER_CDP_URL` | CDP address of an already running owner browser; only loopback is allowed. | unset (the bot starts its own Chromium) |
| `DSHBOT_NOTIFY_QUEUE` | Directory of the collector card queue: the daemon takes JSON cards from it and sends them to the owner. PNG artifacts of the cards live next to it, in the sibling `artifacts/` directory; an empty value returns the queue to `DSHBOT_HOME`. | `DSHBOT_HOME/notification-queue` |
| `DSHBOT_NOTIFY_POLL_MS` | Poll period of the collector card queue directory (`DSHBOT_NOTIFY_QUEUE`) in milliseconds: the daemon looks into the directory right after start and then with this period, and a card reaches the owner on the nearest poll. A short period, for example `200`, speeds up delivery at the cost of more frequent directory reads; tests use it. An empty value, a non-integer, zero and a negative number give the usual period. | `1000` |
| `DSHBOT_NOTIFY_TOKEN` | Bearer token of the local HTTP intake for external events; without it the listener is disabled. | unset |
| `DSHBOT_NOTIFY_PORT` | TCP port of the local HTTP intake for external events. | unset (listener disabled) |
| `DSHBOT_VOICE_MAX_SECONDS` | Duration limit for a voice message or audio the bot accepts. | `300` |
| `DSHBOT_VOICE_TEST_STUB` | Speech recognition stub directory for tests instead of the real model. | unset (the real model) |
| `DSHBOT_VOICE_TTS_TEST_STUB` | Speech synthesis stub directory for tests instead of the real model. | unset (real synthesis) |

## Tests

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_TEST_WORKERS` | Number of vitest workers instead of the computed value: a positive integer sets it explicitly, while an empty, zero, negative, fractional or non-numeric value is ignored. Without the variable a free machine gets two workers per core, and under a growing load average (`os.loadavg`) proportionally fewer, but never fewer than one. | unset (two workers per core on a free machine) |

## OpenAI-compatible API for voice clients

The `POST /v1/chat/completions` endpoint accepts requests from voice and other OpenAI-compatible clients and hands the task to the owner's model turn. Xiaozhi is one example of such a client; setup and an example `LLM` block are described in [OpenAI-compatible API](INSTALL.md#openai-compatible-api).

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_OPENAI_PORT` | TCP port of the OpenAI-compatible `/v1/chat/completions` endpoint for the voice speaker; without it, together with the token, the endpoint is disabled. | unset (endpoint disabled) |
| `DSHBOT_OPENAI_TOKEN` | Bearer token of the OpenAI-compatible endpoint: the `Authorization: Bearer <token>` header; without it, together with the port, the endpoint is disabled. | unset (endpoint disabled) |
| `DSHBOT_OPENAI_HOST` | Listen address of the OpenAI-compatible endpoint. | `127.0.0.1` |
| `DSHBOT_OPENAI_TLS_CERT` | Path to the PEM certificate of the HTTPS endpoint; set together with the key. | unset (HTTP is used without a key pair) |
| `DSHBOT_OPENAI_TLS_KEY` | Path to the PEM key of the HTTPS endpoint certificate; set together with the certificate. | unset (HTTP is used without a certificate pair) |

## External commands, migration and Git

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENCLAW_STATE_DIR` | OpenClaw state directory from which `dshbot-migrate` transfers data. | `~/.openclaw` |
| `HERMES_HOME` | Hermes installation directory from which `dshbot-migrate` transfers data. | `~/.hermes` |
| `GIT_AUTHOR_NAME` | Author name of commits the bot makes during self-development and sync. | `dshbot` |
| `GIT_AUTHOR_EMAIL` | Author email of these commits; the bot's commit is also recognized by it. | `dshbot@localhost` |
| `GIT_COMMITTER_NAME` | Committer name of the bot's commits. | `dshbot` |
| `GIT_COMMITTER_EMAIL` | Committer email of the bot's commits. | `dshbot@localhost` |

## Launcher and installer

These variables are read by `scripts/install.sh` and `scripts/dshbot-run.sh`, not by the daemon. Installation details are in [INSTALL.md](INSTALL.md).

| Variable | Purpose | Default |
| --- | --- | --- |
| `DSHBOT_CONTAINER_RO` | Extra owner paths for MCP and the browser, mounted read-only in the container; a colon-separated list. | empty (only the toolchain and system directories) |
| `DSHBOT_INSTALL_SRC` | Source directory for installation or update instead of the current repository root. | the repository root from which the installer was started |
| `DSHBOT_INSTALL_ORIGIN` | `remote origin` address of the application instead of the source origin. | the source origin, if it exists |

## Inherited command environment

The bot does not configure these variables itself: it passes them to child `host_exec` and `exec` commands when they are set on the process. Daemon secrets do not enter that environment.

| Variable | Purpose | Default |
| --- | --- | --- |
| `LANG` | Locale of child commands. | `C.UTF-8` |
| `LC_ALL` | Priority locale of child commands. | unset |
| `LC_CTYPE` | Character classification for child commands. | unset |
| `USER` | User name in the `host_exec` environment. | unset |
| `LOGNAME` | User name for login utilities in the `host_exec` environment. | unset |
| `SHELL` | Shell of child commands. | `/bin/bash` in the sandbox |
| `TMPDIR` | Temporary directory of child commands. | `/tmp` in the sandbox |
| `TERM` | Terminal type of child commands. | `dumb` in the sandbox |
| `TZ` | Time zone of child commands. | the host time zone |
| `PAGER` | Pager of child commands. | `cat` in the sandbox |
| `GIT_PAGER` | Git pager in child commands. | `cat` in the sandbox |
| `NO_COLOR` | Disables colored output of child commands. | `1` in the sandbox |
| `FORCE_COLOR` | Enables colored output of child commands. | unset |
| `SSH_AUTH_SOCK` | ssh-agent socket for host commands. | unset |
| `SSH_AGENT_PID` | ssh-agent PID for host commands. | unset |
| `XDG_CONFIG_HOME` | XDG config directory for host commands. | `~/.config` |
| `XDG_DATA_HOME` | XDG data directory for host commands. | `~/.local/share` |
| `XDG_CACHE_HOME` | XDG cache directory for host commands. | `~/.cache` |
| `XDG_RUNTIME_DIR` | XDG runtime directory for host commands. | unset |
