# Migrating from OpenClaw

[Русская версия](../MIGRATION.md)

`scripts/dshbot-migrate` moves an OpenClaw installation into DSHBOT with one command: keys, the Telegram bot with its owner, MCP servers, skills, memory, identity and schedules. The tool first builds a plan and writes only after explicit confirmation. It never changes the OpenClaw directory: the config is read, SQLite is opened read-only (from a temporary copy), and source files are not touched.

If DSHBOT was just installed with `scripts/install.sh`, a separate command is usually unnecessary: the installer finds `~/.openclaw` (or the directory from `OPENCLAW_STATE_DIR`) and `~/.hermes` (or `HERMES_HOME`), shows the plan in `--dry-run` mode and offers to apply the transfer. The `--migrate=openclaw|hermes|none` flag sets the source without the first question. Without `--migrate`, under `--yes` or without a terminal, the installer does not run the migration and prints the ready `dshbot-migrate` command for a manual run, while `--migrate=openclaw` or `--migrate=hermes` with `--yes` shows the plan and applies the transfer without questions. Details — `docs/INSTALL.md`.

```sh
# show the plan without writing anything
scripts/dshbot-migrate openclaw --dry-run

# apply (a terminal asks for confirmation; --yes skips the question)
scripts/dshbot-migrate openclaw --yes --include-secrets
```

`--yes` is also required in a non-interactive run (systemd, cron, a script): without it only the plan and a hint are printed, with exit code 0.

The `openclaw.json` config (and the older `clawdbot.json`, `moltbot.json`) is read as JSON5: comments, trailing commas, unquoted keys, single-quoted strings and numbers such as `0x7b`, `+123`, `.5`, `5.`, `Infinity`, `NaN`.

## Flags

| Flag | Meaning |
| --- | --- |
| `--from <directory>` | OpenClaw state directory; without it — auto-discovery: `$OPENCLAW_STATE_DIR`, then `~/.openclaw`, `~/.clawdbot`, `~/.moltbot` with a `openclaw.json`, `clawdbot.json` or `moltbot.json` file |
| `--home <directory>` | `DSHBOT_HOME`; `$DSHBOT_HOME` or `~/.local/share/dshbot` by default |
| `--env-file <path>` | daemon environment file (read by systemd through `EnvironmentFile`); `~/.config/dshbot/dshbot.env` by default |
| `--dry-run` | plan only: no file is created or changed |
| `--yes` | apply without a question; in a terminal without the flag a yes/no question is asked |
| `--include-secrets` | transfer secret values; without it only names in the plan and report |
| `--overwrite` | replace existing values (by default they are not changed and get the `conflict` status) |
| `--skill-conflict <mode>` | what to do when a skill with that name already exists in `DSHBOT_HOME/skills`: `skip` (default, status `conflict`), `rename` (copy as `<name>-openclaw`, next one `<name>-openclaw-2`) or `overwrite` (replace a normal skill; a built-in one is never replaced) |
| `--json` | machine output as a single JSON document |

Each plan item is printed on one line: kind, name, target and status (`plan`, `applied`, `skipped`, `conflict`, `error`, `warning`). Secret values are never printed — not to stdout, the report or the journal.

With `--json` stdout always contains exactly one JSON document: the `applied` field says whether application happened, `items` holds plan items, `report` is the path to the report after application. Without `--yes` in a non-interactive run the hint about `--yes` is in the `hint` field rather than on a separate line. In a terminal without `--yes` the plan and the yes/no question go to stderr, so stdout stays one document.

## What is transferred

### Keys and secrets

Sources:

- `<state>/.env` variables (`KEY=value` lines, including `export KEY=value`);
- `env.vars.<NAME>` from `openclaw.json`;
- `models.providers.<p>.apiKey` — as a string or a `SecretRef` with `source: env`;
- secret fields of `plugins.entries.<p>.config.*` (names with `token`, `key`, `secret`, `password`, `authorization`);
- live `secret_store_entries` records from `<state>/state/openclaw.sqlite` (`deleted_at_ms IS NULL`);
- `api_key` profiles from `agents/<id>/agent/auth-profiles.json` and from the `auth_profile_store` table in `agents/<id>/agent/openclaw-agent.sqlite`;
- files in `<state>/credentials/` (except `telegram-*allowFrom*.json`): the value is the whole file content, byte for byte (binary files too).

Config values with `${NAME}` substitution are expanded the way OpenClaw does it: first from `<state>/.env`, then from `env.vars.*` (including variables referencing each other), then from the process environment. Substitution also works inside a string, for example `Authorization: "Bearer ${HA_TOKEN}"`; `$${NAME}` stays the literal `${NAME}`. An empty value counts as absent. If a variable is nowhere, the plan gets a `warning` with the variable name and field path — without the value — and a value with an unresolved substitution is not written to the store.

Where:

- `TELEGRAM_BOT_TOKEN`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` are appended to the daemon environment file regardless of the source: `.env`, `env.vars`, `models.providers.deepseek.apiKey`, `secret_store_entries` or the `deepseek` provider auth profile. Existing lines are not changed; the file gets mode `0600`. If the file is absent it is created only when there is something to append.
- The environment file is read by systemd `EnvironmentFile=` rules (quotes, escaping of `\"`, `\\`, `\$`, `` \` ``, a newline inside quotes), so a key the owner already wrote with different quoting but the same value counts as transferred. Values with spaces and special characters are written in double quotes with the same escaping: systemd and a POSIX shell read them identically.
- All other keys go into the `DSHBOT_HOME/secrets/<NAME>` store with mode `0600` (the same format as the daemon's: `^[A-Z0-9_]{1,64}$`, the value is the file).
- The same name with the same value is one record. The same name with different values is a `conflict`.

Names:

- variables from `.env`, `env.vars.*` and `secret_store_entries` keep their names;
- a provider key gets the name `<PROVIDER>_API_KEY` (for example `zhipu` → `ZHIPU_API_KEY`), including auth profiles;
- plugin fields and other config fields get a name deterministically derived from the field path (`plugins.entries.sample.config.token` → `PLUGINS_ENTRIES_SAMPLE_CONFIG_TOKEN`); the report shows the "path → name" pair;
- a `SecretRef` with `source: env` is resolved like `${NAME}` substitution: from `<state>/.env`, `env.vars.*` and the process environment. `source: file` and `source: exec` are not resolved automatically: the item gets a `warning` with the field path. OAuth profiles are not transferred, and the report has a line about that too.

Without `--include-secrets` no file in `DSHBOT_HOME/secrets` is created and the environment file is not changed; the output lists the key names that would be transferred and a hint to repeat with `--include-secrets`. The owner and MCP servers are still transferred (secret references in `mcp.json` remain, but the store has no values until they are transferred with `--include-secrets`).

### Telegram: token and owner

The token comes from `channels.telegram.botToken` or `channels.telegram.accounts.<defaultAccount>.botToken` (the active account is `defaultAccount`, otherwise the only account). A string, `${ENV}` form and a `SecretRef` with `source: env` are supported.

The owner is written to `state.db` under `telegram.owner_chat_id`, so the owner's first message does not need a pairing code. The source is chosen in order:

1. the first Telegram id from `commands.ownerAllowFrom` (`telegram:123` and `123` both give `123`);
2. the active account's `allowFrom`;
3. `channels.telegram.allowFrom`;
4. `channel_pairing_allow_entries` in the source SQLite;
5. `credentials/telegram-*allowFrom*.json`.

If `state.db` already has another owner, the value is not changed and the item gets `conflict`; `--overwrite` replaces it.

### MCP servers

`mcp.servers.<name>` is transferred into `DSHBOT_HOME/mcp.json` as `mcpServers.<name>` with the `command`, `args`, `cwd`, `url`, `transport`, `enabled` fields (and `requestTimeoutMs`, if it was present). Other servers in `mcp.json` are preserved.

`env` and `headers` values with secret names (`token`, `key`, `secret`, `password`, `authorization`, case-insensitive) are replaced with a `${secret:NAME}` reference, and the value goes into the store with `--include-secrets`. An `env` or `headers` value with any name where `${NAME}` substitution fired is transferred the same way: the expanded text goes only into the store, not into `mcp.json`. If the substitution did not resolve, the reference remains without a value in the store, and DSHBOT reports a missing secret for the server. A server with the same name is not changed and gets `conflict`; `--overwrite` replaces it. A command absent from `PATH` and not found by an absolute path gives a `warning`, but the server is still transferred. If `command` or `cwd` cannot be executed or opened, an absolute path from `args` or `env` (except secret fields) cannot be read, or any of them lies in a directory unavailable to the current user, the server is still transferred but the plan contains a `warning` with the server name and the path itself: otherwise such a server would silently fail to start after migration.

### Skills

The main agent workspace is `agents.entries.main.workspace`, otherwise `agents.defaults.workspace`, otherwise `<state>/workspace`. Skills are read by priority: `<workspace>/skills`, `<workspace>/.agents/skills`, `~/.agents/skills` (the parent of the state directory), `<state>/skills`, `<state>/agents/main/agent/workshop-skills`. On a name collision the higher-priority directory wins; directories whose name starts with a dot (backups such as `.name-before-…`) are not copied.

Each skill is copied entirely into `DSHBOT_HOME/skills/<name>/` with all its files (`scripts/`, `references/`, `routes.json`, binary attachments) and gets `.meta.json` with `imported: true` — the same mark by which `packages/learn` shows imported skills. A skill with `metadata.openclaw.os` that lacks `linux` is skipped with a platform reason.

`skills.entries.<key>.env.*` and `skills.entries.<key>.apiKey` go into the secret store with `--include-secrets`; `apiKey` gets the name from the skill's `metadata.openclaw.primaryEnv`. Without the flag the names are visible in the plan and report and values are not written. If any source secret value occurs in a copied file, skill or memory text, it is replaced with `[hidden]`, and the report warns about it with the file name. Prefer passing the key through the `exec` tool's `secrets` rather than storing it as skill text.

### Memory and identity

The workspace `MEMORY.md` and `USER.md` are appended to `DSHBOT_HOME/memory/MEMORY.md` and `DSHBOT_HOME/memory/USER.md`: paragraphs that already exist are not repeated. Daily notes `memory/YYYY-MM-DD.md` go to `DSHBOT_HOME/memory/journal/YYYY-MM-DD.md`; an existing file gets an append under the heading "From OpenClaw".

`SOUL.md` and `IDENTITY.md` are the identity. If `memory/identity.md` is missing or equals the `persona/identity.seed.md` seed, the text is written there; with a custom identity it is not changed, and the text is saved to `memory/knowledge/openclaw-persona.md` with status `conflict`. `--overwrite` replaces `identity.md`, and the previous text goes to `before/`. `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` are transferred to `memory/knowledge/openclaw-<lowercase name>.md`. Other agents' workspaces are not transferred.

On a repeated run each knowledge file is compared with what the last migration wrote (its fingerprints live in `migration/openclaw-state.json`). If the owner has not changed the file, changed source text updates it without a conflict. If the DSHBOT file differs both from the new source text and from the previous migration record, this is an owner edit: the item gets `conflict` and the file is not changed. `--overwrite` replaces it with the source text, and the owner's previous bytes go to the report's `before/`.

### Schedules

Jobs are read from `<state>/state/openclaw.sqlite` (the `cron_jobs` table) or the old `<state>/cron/jobs.json` and created in DSHBOT schedules (`state.db`, `packages/scheduler`):

- `cron` → a five-field expression with the `schedule.tz` zone;
- `every` → `every <N>m|h|d`; an interval not a whole number of minutes is rounded up with a warning;
- `at` in the future → a one-shot run; `at` in the past is skipped with a reason;
- the job text is `payload.message` or `payload.text`;
- `enabled: false` → the schedule is created paused;
- OpenClaw service jobs whose whole text looks like `__openclaw_…__` (`__openclaw_memory_core_short_term_promotion_dream__` and similar) are skipped with a reason: they are not meant for a model and must not run as an ordinary schedule;
- absolute paths of migrated skills in the job text are replaced with `DSHBOT_HOME/skills/<name>/SKILL.md`, including when a skill was renamed because of a collision (`<name>-openclaw`), and through the real path when `--from` is a symbolic link; the path to the skill directory is replaced with `DSHBOT_HOME/skills/<name>`. Paths of other skills with the same name prefix are not changed.

Jobs with `payload.kind` `command`, `script`, `heartbeat` and jobs of a non-main agent are not created: they are listed with their name, schedule and command or text in `<report directory>/manual-review.md`, and the owner decides. A repeated run does not create duplicates.

A migrated schedule is matched to the source job by its stable identifier (`job_id` in SQLite, or `id`, or without it the name from `cron/jobs.json`), not by the "schedule and text" pair. DSHBOT schedule identifiers are stored in `$DSHBOT_HOME/migration/openclaw-state.json` on the first transfer. If the job text or schedule changed in OpenClaw under the same identifier, the item gets `conflict` with a reason and the existing row stays as it was; no second schedule appears. `--overwrite` updates the text and schedule of that same row while keeping its `id`. A source job with a different identifier but the same text and schedule as an already transferred job does not create a second row: it is marked `skipped` in the report with the reason "already exists", and its identifier is not written to the map. When such a job changes in OpenClaw, it is transferred as a separate schedule, and the other job's row is not changed. A job with its own row gets a conflict on change or, with `--overwrite`, an update of only its row. A row created by an earlier migration version without a stored identifier but with the same text and schedule is accepted as already transferred: no duplicate is created, and its identifier is written to the map for future runs. The earlier version merged identical jobs into one row; the row goes to the first of them, and the others are skipped as described above. A repeated run without changes changes neither `schedules` rows nor files in `DSHBOT_HOME` and exits with code `0`.

## Report and copies

After application `$DSHBOT_HOME/migration/openclaw-<time>/report.json` is created with mode `0600`. It lists the items (kind, name, source, target, status, field path for derived names, reason) — without secret values. Before existing files are changed (the environment file, `mcp.json`, a skill under `--skill-conflict overwrite` or `--overwrite`, `identity.md`, a knowledge file under `--overwrite`), their exact copies go into `<report directory>/before/` with mode `0600`. A skill is saved entirely, with all files and `.meta.json`. If there are jobs for manual review, `manual-review.md` appears next to it. Next to the report directories, `migration/openclaw-state.json` stores the "OpenClaw job id → `schedules` row" map and fingerprints of written knowledge files; it is updated only on change, so a repeated run without edits creates no new files.

If the report directory cannot be created, the migration applies nothing (without it there are no copies in `before/` either); if `report.json` itself is not written, what was applied stays but the run counts as failed. A message about this and about any unexpected error goes to stderr as one line without a stack; known secret values in it, as in paths, are replaced with `${secret:NAME}`. With `--json` the report failure message is also in the document's `error` field.

Exit code `1` if there is a `conflict` or `error`; otherwise `0`. A repeated run with the same source changes nothing: items are marked as already transferred and no new report is created.

## Migrating from Hermes

The second source of the same tool:

```sh
# item plan without writing anything
scripts/dshbot-migrate hermes --dry-run

# apply (a terminal asks for confirmation; --yes skips the question)
scripts/dshbot-migrate hermes --yes --include-secrets

# named profile ~/.hermes/profiles/work
scripts/dshbot-migrate hermes --profile work --dry-run

# a specific installation directory
scripts/dshbot-migrate hermes --from /srv/hermes --yes --include-secrets
```

The directory is chosen as: `--from`, otherwise `$HERMES_HOME`, otherwise `~/.hermes`. `--profile <name>` appends `profiles/<name>` to that root. The flags `--home`, `--env-file`, `--dry-run`, `--yes`, `--include-secrets`, `--overwrite` and `--json` work as with OpenClaw; the report lives in `$DSHBOT_HOME/migration/hermes-<time>/report.json`.

### Keys and secrets

- `.env` is read as `KEY=value`. Names with `KEY`, `TOKEN`, `SECRET` or `PASSWORD`, case-insensitive, count as secrets, as do `*_BASE_URL` when a `<PREFIX>_API_KEY` is nearby. The name in the store is the variable name in upper case.
- `TELEGRAM_BOT_TOKEN`, `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` go to the daemon environment file, not to `secrets/`.
- Other variables are Hermes settings (`TERMINAL_TIMEOUT`, `WEB_TOOLS_DEBUG` and similar): they are not transferred and are listed in the report.
- `auth.json`: `credential_pool.<provider>` records with `auth_type: api_key` and `source: env:NAME` are resolved from `.env` and do not create a second key. OAuth records (`access_token`, `refresh_token`) are not transferred, and each has a line in the report.
- `credentials/` files are transferred entirely, byte for byte (binary too), into `secrets/`; the name is derived from the file name (for example `service-account.json` → `CREDENTIALS_SERVICE_ACCOUNT_JSON`).

### Telegram

The token comes from `TELEGRAM_BOT_TOKEN` in `.env`. The owner is chosen in order: the first id in `TELEGRAM_ALLOWED_USERS` (a comma-separated list), otherwise the first id in `telegram-pairing/telegram-approved.json`, otherwise `TELEGRAM_HOME_CHANNEL`. If a live Hermes gateway is running — `hermes-gateway`, `hermes gateway`, a path like `.../hermes/.../gateway` or `python -m hermes_cli[.main] gateway` — the token is not transferred: Telegram answers `409 Conflict` when two bots use one token at the same time. The item gets `conflict` with an explanation, and the rest is applied. The decision is made by the program being launched: an executable, an interpreter script (`python3 ~/.local/bin/hermes gateway`) or a module after `-m` among the Python options before the script. A third-party script with these words in its arguments (`python /srv/report.py -m hermes_cli.main gateway`, `node /srv/report.js hermes gateway`) does not count as a gateway.

### MCP servers

`config.yaml` (YAML) is read without transferring the other sections. `mcp_servers.<name>` → `mcp.json`, `mcpServers.<name>`: `command`, `args`, `cwd`, `url`, `enabled`, and `tools.include`/`tools.exclude` into the same-named tool policy fields. `env` and `headers` values with secret names (`token`, `key`, `secret`, `password`, `authorization`) are replaced with a `${secret:NAME}` reference, and the value goes into the store with `--include-secrets`. The `model`, `agent`, `terminal`, `browser` and other sections are not transferred (DSHBOT runs on DeepSeek) and are listed in the report.

### Skills

Both layouts are supported: `skills/<category>/<name>/SKILL.md` and `skills/<name>/SKILL.md`. A skill is copied entirely into `<home>/skills/<name>/` with all files and marked imported (`.meta.json`). If one name occurs in different categories, the directories get `<category>-<name>`, and `name` in the SKILL.md frontmatter is rewritten to the new name on any YAML key form (`name:`, `"name":`, `'name':`, a multiline value). Skills in `skills.disabled` and skills with `platforms` lacking `linux` are not copied, and the reason is visible in the report. An existing skill with different content gives `conflict`; `--skill-conflict overwrite` (or `--overwrite`) replaces it, and the whole previous skill tree, including hidden files, nested directories and `.meta.json`, is saved in the report's `before/` — the same as when replacing an OpenClaw skill.

Values of this transfer's keys (the store and the environment file, from 8 characters) found in skill text files are replaced with a `${secret:NAME}` reference, as in `mcp.json`. Binary files are copied byte for byte.

### Memory and identity

`memories/MEMORY.md` and `memories/USER.md` are split into records by `§` and appended to `memory/MEMORY.md` and `memory/USER.md` without repeating existing records. `MEMORY.md.lock` and `MEMORY.md.bak*` are not read. `SOUL.md` becomes `memory/identity.md` by the same rule as OpenClaw: an empty identity is filled, a matching one is skipped, a different one without `--overwrite` gives `conflict`, and a replacement with `--overwrite` passes the identity length threshold.

### Schedules

`cron/jobs.json` (`{jobs: [{id, name, prompt, schedule, repeat, enabled, state}]}`) is transferred into DSHBOT `state.db`:

- `{kind: cron, expr}` → the same cron expression;
- `{kind: interval, minutes}` → `every <N>m`;
- `{kind: once, run_at}` in the future → a one-shot run; in the past — a skip with a reason;
- `prompt` becomes the job text character for character (with leading and trailing spaces and newlines), and `repeat.times` becomes the run count limit (`maxRuns`);
- `enabled: false` or `state: paused` → the schedule is created paused.

On a repeated run each DSHBOT schedule is matched with at most one job: first by job text together with schedule, limit and pause (these are skipped as already transferred), then by text alone (`conflict`, or an update with `--overwrite`). Therefore several jobs with one `prompt` and different schedules change nothing on a repeat.

Jobs with `script` or `no_agent` are not transferred automatically: they go into `$DSHBOT_HOME/migration/manual-review.md` with the job text and the script for manual review; key values of this transfer in them are replaced with a `${secret:NAME}` reference. `sessions`, `state.db`, `kanban`, `webhook` and other Hermes service data are not transferred and are listed in the report.

## Limitations

- `dshbot-migrate` does not yet transfer OAuth profiles, `SecretRef` with `source: file`/`exec`, or the `telegram-*allowFrom*.json` files themselves (they are identifiers, not secrets).
- Application refuses if a DSHBOT daemon is already running with this `DSHBOT_HOME`: nothing is written and the exit code is `1`. `--dry-run` still works. Stop the daemon and repeat.

## One token for two bots

Telegram returns `409 Conflict` if the same token is used by two `getUpdates` processes at the same time: the OpenClaw gateway, the Hermes gateway and DSHBOT. Therefore, while the source gateway is alive, the token is not transferred, the item gets `conflict`, and the rest is transferred. For OpenClaw a process counts as live when its arguments contain `openclaw` (or a path to it) and a separate `gateway`, case-insensitive: `openclaw gateway`, `openclaw-gateway`, a path like `/opt/openclaw/.../gateway`. For Hermes the deciding factor is the program being launched or the interpreter script: `hermes-gateway`, `hermes gateway`, a path like `.../hermes/.../gateway` or `python -m hermes_cli[.main] gateway`; the words `hermes gateway` in the arguments of a third-party script do not count. `dshbot-migrate` itself is not one of them. Stop the source — or create a new bot in [@BotFather](https://t.me/BotFather) and put its token into DSHBOT.
