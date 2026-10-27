# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) for this repository (the "Report a vulnerability" button under the Security tab). Do **not** open a public issue, and do not post exploit details, tokens, personal data or private-network addresses in a public discussion.

Include, when possible:

- the affected version or commit;
- the isolation mode (`host` or `container`) and the relevant part of `~/.config/dshbot/dshbot.env` **with secrets removed**;
- reproduction steps and the observed impact;
- any suggested fix.

We will acknowledge the report, investigate it and coordinate disclosure with you.

## Threat model

DSHBOT runs an autonomous model with tools on the owner's machine. The most important boundaries are:

- **The owner is not the model.** The model's instructions and external content are untrusted. Two layers check tool calls, depending on the tool:
  - **Shell tools** (`exec`, `host_exec`) pass a deterministic command guard (`deny`, `confirm`, `allow`) and then run as described under the sandbox item below.
  - **Other tools** (files, web, memory, MCP and the rest) run inside the daemon process without the command guard. They are bounded by the general access policy — for example, file tools only see the allowed roots and keep secret paths hidden — and by owner confirmations where an action requires one.
- **Owner actions need the owner.** Dangerous, irreversible or out-of-workspace actions require an explicit Telegram confirmation card. Free-form "yes" text does not authorize anything.
- **External content is data.** Web pages, mail, MCP results, command output, files, office documents and attachments reach the model inside an `EXTERNAL_UNTRUSTED_CONTENT` frame, and the prompt forbids following instructions from that frame.
- **Secrets stay out of tools.** Child processes receive a cleaned environment without the bot token, the DeepSeek key or stored secrets. Secret values are masked in output, journals and exported history.
- **Guests are separate.** A guest has no owner memory, files, schedules, credentials or owner tools, and a guest `exec` runs in a fresh, empty bubblewrap sandbox.
- **Sandboxes depend on where a command runs.**
  - `exec` runs in bubblewrap without the owner's `HOME`: it sees the workspace and the extra roots the owner configured, with their read-only or read-write mode, and secret paths inside them are masked.
  - A local `host_exec` runs in bubblewrap over a read-only machine: the owner's `HOME` is readable, and writes go only to `DSHBOT_HOME`, `/tmp` and directories listed in `DSHBOT_HOST_WRITABLE`.
  - An SSH `host_exec` runs on the owner's remote host through SSH without a sandbox; the command guard and the confirmation cards are its only checks.
  - If bubblewrap is unavailable, a local command is refused instead of running unprotected.
- **Panic is final.** `/panic` stops turns, subagents, wake-ups and evolution and exits with code 77; systemd does not restart the daemon after a panic.

## What is protected

- The owner's memory, identity, journal, files and workspace.
- Secrets in `~/.config/dshbot/dshbot.env` and `DSHBOT_HOME/secrets/`.
- The live checkout and the protected paths the self-evolution gate refuses to edit.
- The owner chat: guest turns cannot send messages, cards or confirmations to it.
- The host outside the explicitly writable directories.

## Scope

The threat model, the guest attack-surface audit and the security decisions are documented in [docs/security/](docs/security/) and in the security section of [docs/DESIGN.md](docs/DESIGN.md). Reports about the documented design decisions are still welcome, but please read those documents first.

This policy covers the DSHBOT code in this repository. Vulnerabilities in third-party dependencies should also be reported upstream; the dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
