# Owner commands

The commands work in the owner's private chat. A guest sees only `/help`; the bot's other commands are unavailable to a guest and do not start a model turn. The Telegram menu and the `/help` answer are built from one list in `packages/app/src/index.ts`, so the document and the menu do not diverge. The full list of environment variables is in [CONFIG.md](CONFIG.md), installation and owner pairing are in [INSTALL.md](INSTALL.md).

[Русская версия](../COMMANDS.md)

## Session and state

- `/new` — start a new main session and archive the old one.
- `/status` — show the main state: model, history, context, usage and uptime.
- `/doctor` — self-diagnose the environment, Telegram, DeepSeek, MCP, disk, state.db and the tools. When the report has a warning or error row, the «Починить» (Repair) button under it queues a task in the task lane with those rows; pressing it again while that task runs does not create another one.
- `/backup` — take a snapshot of state.db and the bot files into `backups/` with rotation.
- `/approvals` — list permanent command permissions with a button to revoke them.
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

## Factory

- `/factory` — open the bot's factory: tasks, projects, role models, providers and auto-acceptance. A role without a saved choice runs on `deepseek-flash`; the other models are off. The role screen lists the enabled models on top in priority order (number and «⬆️» to raise one position; the role's turns run on priority 1), then one button per provider with the enabled and total model counts; a provider button opens its models as switches, 20 per page («◀️»/«▶️», «Назад»); an enabled model joins the end of the priority, and the last model of a role cannot be switched off. Below the providers, pick the role's reasoning level (every level of its first model by priority, including a provider model's own levels such as `minimal`, `medium` or `xhigh`): the choice is stored in kv, survives a restart and defaults to `high`; `/effort` still changes only main. «Провайдеры» lists the provider routes and marks the ones with a stored sign-in; the provider screen offers a button per sign-in method (API key or OAuth, for example «Войти через ChatGPT» for `openai-codex`) and «Отключить» for a connected route. After a successful sign-in the «… подключён.» message carries the keyboard of the «Провайдеры» screen, where the provider is already marked «✅». The sign-in runs in the chat: notices arrive as messages, a link is a button, the device code is shown separately with a copy button, a choice is offered as buttons, and a text or secret request waits for the answer in the next message. The message with the secret is deleted after it is read; «Отмена», any command (which then runs as usual, `/secret`, `/secrets` and `/unsecret` included) or five minutes without an answer withdraws the attempt, and the next message goes to the agent again.

## Guests and groups

- `/invite` — issue a guest link for a limited time: `/invite 30m`, `2h` or `1d`.
- `/guests` — show the guest list and the time left for their access.
- `/kick` — remove a guest by `chat_id`: `/kick <chat_id>`.
- `/unlock` — unblock a chat blocked after wrong pairing codes: `/unlock <chat_id>`.
- `/group_allow` — in a group, allow the bot to reply in this chat (an owner command, without mentioning the bot).
- `/group_deny` — in a group, remove this chat from the allowlist and stop replying in it.

## Owner's direct shell

- `!command` — run a shell command without the model: the same sandboxed `exec`, exit code and monospace output; long output arrives as a file.
