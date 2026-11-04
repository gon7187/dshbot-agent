# Owner commands

The commands work in the owner's private chat. A guest sees only `/help`; the bot's other commands are unavailable to a guest and do not start a model turn. The Telegram menu and the `/help` answer are built from one list in `packages/app/src/index.ts`, so the document and the menu do not diverge. The full list of environment variables is in [CONFIG.md](CONFIG.md), installation and owner pairing are in [INSTALL.md](INSTALL.md).

[Русская версия](../COMMANDS.md)

## Session and state

- `/new` — start a new main session and archive the old one.
- `/status` — show the main state: model, history, context, usage and uptime.
- `/doctor` — self-diagnose the environment, Telegram, DeepSeek, MCP, disk, state.db and the tools. When the report has a warning or error row, the «Починить» (Repair) button under it queues a task in the task lane with those rows; pressing it again while that task runs does not create another one.
- `/backup` — take a snapshot of state.db and the bot files into `backups/` with rotation.
- `/approvals` — list permanent command permissions and MCP tool permissions (which tool applies plans from which source tool the argument comes from, given with the "Всегда" button on the card) with a button to revoke them.
- `/mcp` — state of the MCP servers, their tools and `mcp.json` problems; `/mcp reload` re-reads the file.
- `/secret` — store a secret: `/secret NAME`, then the value as the next message.
- `/secrets` — list the names of stored secrets without their values.
- `/unsecret` — delete a secret by name: `/unsecret NAME`.
- `/cancel` — cancel the wait for a secret value after `/secret`.
- `/model` — show or change the main model: `flash` (accepts images), `lite` (text only), `pro` (text only) or a model of a provider with a stored sign-in, by id (`glm-5.3`) or `provider/id` (`zai/glm-5.3`), text only. Without an argument it also lists the models of connected providers. When the sign-in of the chosen model's provider is removed, main returns to `flash` on its next start.
- `/effort` — show or change the main reasoning depth: without an argument it lists the levels of the current main model (for DeepSeek `off`, `low`, `high` and `max`; for a provider model its own, for example `minimal`, `medium`, `xhigh`), with an argument it accepts any of them. When the saved level is unavailable on the current model, the turn runs on the model default and `/effort` says so.
- `/compact` — compact the main history with a summary and trim old tool results.
- `/context` — break the main context down in tokens: prefix, tools, history, compaction.
- `/tools` — show the owner turn tools: core, lazy, MCP servers and agent profiles.
- `/toolnotes` — show notes about failed tool calls and the working variant; `/toolnotes clear` wipes them.
- `/mailwatch` — enable or disable the mail watcher without the model: `/mailwatch 5m` enables it, `off` disables it.
- `/export` — send the main session history as a `.md` file with secrets masked.
- `/rollback` — show snapshots of the bot's edits and roll a file back to the version before the edit.
- `/restart` — restart the daemon when no turn is running.
- `/verbose` — show tool call arguments in the stream: `on` or `off`.
- `/usage` — show the usage line under a reply: model, tokens and turn cost (`on` or `off`).
- `/btw` — ask a side question on flash; the answer does not enter the main history.
- `/learn` — build a skill draft from a conversation: `/learn <topic>`; `/learn list` shows pending proposals.
- `/voice` — voice replies: `on`, `off` or `auto` (voice reply to a voice message).
- `/dream` — enable or disable nightly memory consolidation: `on` or `off` (default `on`).
- `/help` — show the command list with one description line each.

## Autonomous work and development

- `/goal` — set a goal the bot pursues on its own until the condition is met.
- `/loop` — repeat a task until a condition is met or on a schedule.
- `/evolve` — start self-development: the bot looks for and makes small improvements itself.
- `/update` — sync with main: pull new commits into live and push its own changes.
- `/stop` — stop the current turn and the autonomous cycle.
- `/panic` — stop the daemon immediately (systemd does not restart it after a panic).
- `/budget` — show spending for the day from the store.
- `/tokens` — show tokens for today, for 30 days and for the session, with an estimate at the model price.
- `/tasks` — show active autonomous tasks and their state.

For tasks with two independent parts, the bot defaults to delegated work; research children receive read-only tools. The built-in `capability-growth` skill covers source discovery, installation in the task sandbox and verification. The `skill_manage` tool with `action: "import"` installs a standard `SKILL.md` into the owner catalog without executing support files or replacing existing skills; `skills_list` and `skill_view` expose the result. Harness dependencies and plugins are tested in a candidate and become active through the normal update after factory acceptance. Installation grants no new host secrets or services.

## Factory

- `/factory` — open the bot's factory: tasks, projects, role models, providers and auto-acceptance. Autopilot is off by default; the owner enables it in the menu, and the setting survives restarts. For low-risk tasks it approves analysis, runs execution, and merges after a green gate and independent review, even with auto-acceptance disabled. Enabling it also picks up already analysed low-risk tasks; a restart also continues successful checked results waiting for acceptance. High-risk work on the bot itself can also be prepared automatically in a confined candidate, including dependency installation and commands; promotion still requires the owner. The writer/executor command runtime stops background processes before the gate; the reviewer remains read-only. External actions, deployments and failures remain with the owner. If the base branch advances after checks, acceptance stops; create a new task on the current base. GitHub uses an allowed repository method (merge, otherwise squash or rebase); a task is marked merged and its worktree removed only after GitHub confirms the checked commit was merged. A role without a saved choice runs on `deepseek-flash`; the other models are off. The role screen lists the enabled models on top in priority order (number and «⬆️» to raise one position; the role's turns run on priority 1), then one button per provider with the enabled and total model counts; a provider button opens its models as switches, 20 per page («◀️»/«▶️», «Назад»); an enabled model joins the end of the priority, and the last model of a role cannot be switched off. Below the providers, pick the role's reasoning level (every level of its first model by priority, including a provider model's own levels such as `minimal`, `medium` or `xhigh`): the choice is stored in kv, survives a restart and defaults to `high`; `/effort` still changes only main. «Провайдеры» lists the provider routes and marks the ones with a stored sign-in; the provider screen offers a button per sign-in method (API key or OAuth, for example «Войти через ChatGPT» for `openai-codex`) and «Отключить» for a connected route. After a successful sign-in the «… подключён.» message carries the keyboard of the «Провайдеры» screen, where the provider is already marked «✅». The sign-in runs in the chat: notices arrive as messages, a link is a button, the device code is shown separately with a copy button, a choice is offered as buttons, and a text or secret request waits for the answer in the next message. The message with the secret is deleted after it is read; «Отмена», any command (which then runs as usual, `/secret`, `/secrets` and `/unsecret` included) or five minutes without an answer withdraws the attempt, and the next message goes to the agent again.

Private factory role skills load automatically from `$DSHBOT_HOME/factory/role-skills/<role>/SKILL.md`, where `<role>` is `analysis`, `test_writer`, `executor`, or `reviewer`. Each profile is a regular UTF-8 file of at most 8192 bytes, without symlinks. A missing file preserves the defaults; an invalid profile stops that role. Only the selected role receives the profile, and its tool permissions stay the same; the reviewer remains read-only. Keep personal content in runtime storage, outside the repository and public exports.

- `/superagent projects` — projects connected in `/factory` and their profile readiness. Project `0` is the bot itself.
- `/superagent new <project number> <task>` — durably submit work to the full Superagent. Omitting the number selects `0`. Only the owner in a private chat may submit; replaying an update does not create another task. Replying to a Superagent message continues the same conversation and project.
- `/superagent` or `/superagent status` — queue/process status and local panel addresses.
- `/superagent pause` — persist a pause and stop every profile. `/superagent resume` — explicitly resume them after startup checks. A failed startup restores the pause; an ordinary restart recovers previously running profiles.
- `/superagent deliveries` — deliveries with an uncertain outcome. `retry <project> <id>` sends again (a duplicate is possible); `dismiss <project> <id>` closes the delivery without resending.
- `/superagent stop <project number> <ticket>` — stop one ticket through the upstream API. `/panic` also immediately stops all Superagent child processes.

Each profile runs the complete upstream runtime with its own SQLite, sessions and working directories. Only the main bot polls Telegram; profiles use separate Unix sockets. Each profile has a private network namespace with checked public egress. Panels are loopback-only; remote access requires an SSH tunnel.

The runtime is installed separately and stays off without configuration. Tasks from the former adapter remain in `/factory`. GitHub uses the existing account through the host broker; profiles receive no GitHub token. Publication and merge require the project's local tests and independent review; CI is not required, and branch protections still apply. Deployment requires a separate owner command. The upstream skips its own GitHub events, so owner tasks should enter through Telegram with a shared account. An ambiguous Telegram send becomes `uncertain` and is not automatically repeated, avoiding duplicate messages.

## Guests and groups

- `/invite` — issue a guest link for a limited time: `/invite 30m`, `2h` or `1d`.
- `/guests` — show the guest list and the time left for their access.
- `/kick` — remove a guest by `chat_id`: `/kick <chat_id>`.
- `/unlock` — unblock a chat blocked after wrong pairing codes: `/unlock <chat_id>`.
- `/group_allow` — in a group, allow the bot to reply in this chat (an owner command, without mentioning the bot).
- `/group_deny` — in a group, remove this chat from the allowlist and stop replying in it.

## Owner's direct shell

- `!command` — run a shell command without the model: the same sandboxed `exec`, exit code and monospace output; long output arrives as a file.
