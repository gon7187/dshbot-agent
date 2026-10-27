# Contributing to DSHBOT

Thanks for your interest. DSHBOT is a personal autonomous agent, but the code is a normal Node.js/TypeScript project and contributions are welcome.

## Getting started

Requirements:

- Linux (the daemon depends on `systemd --user`).
- Node.js no older than the version in `engines` in `package.json` (currently `>=22.19`).
- `bwrap` (bubblewrap). It is required for the `exec` sandbox and the `container` isolation mode, and the test suite uses the same sandbox for the self-change gate. Without it those tests fail or are skipped; install it with your package manager, for example `sudo apt install bubblewrap` or `sudo dnf install bubblewrap`.

Install the dependencies exactly as CI does and run the tests:

```sh
npm ci
npm test        # tsc --noEmit, then vitest run
```

There is no build step: vitest runs `.ts` files directly.

## Repository layout

- `packages/<name>/src/` — the package code.
- `packages/<name>/*.test.ts` — package tests, next to the code they cover (`packages/store` keeps its tests in `packages/store/test/`).
- `tests/*.test.ts` and `tests/<area>/` — cross-cutting checks: the installer, the launcher, documentation contracts, reference locks and repository gates.
- `scripts/` — installation, launch and maintenance scripts.
- `deploy/` — systemd unit templates.
- `docs/` — Russian documentation; `docs/en/` holds the English translations of the user-facing guides.
- `persona/`, `prompts/`, `examples/` — the agent's character, prompt material and example skills.

## Rules

- **Test behaviour, not wording.** Add or extend a behavioural test for every change in executable code. Do not add permanent tests that pin documentation, prompt or skill phrasing; if a document must match code, check the concrete command, flag or configuration key instead.
- **No secrets and no personal data.** Do not put tokens, keys, passwords, private-network addresses, absolute home paths or other people's identifiers in code, tests, fixtures or commits. Tests and `test-support` directories may use obvious fixtures, but never real credentials. The public-repository hygiene gate (`tests/gates/public-repo-hygiene.test.ts`) scans every tracked file.
- **Clean language in code and commits.** Write commit messages, identifiers, comments and user-facing output in neutral, professional English or Russian as appropriate for the surrounding text. No profanity, insults or personal remarks.
- **Keep the diff focused.** Do not reformat unrelated files and do not include generated artifacts or local state. A change that also makes a document wrong must update that document in the same commit.
- **Respect the protected paths.** `CHARTER.md`, `packages/guard/**`, the budget limits, the systemd unit, the adoption scripts, `CHECKLIST.md` and the character scenario tests are changed by the owner by hand, not by the agent or by an unreviewed pull request.
- **Describe the verification.** In a pull request, say what you changed, why, and which command or test proves it.

## Submitting changes

1. Fork the repository and create a topic branch.
2. Make the change and add or extend the relevant behavioural test.
3. Run `npm test` locally.
4. Open a pull request against the main branch and describe the verification.

Please do not open a public issue for a security vulnerability; follow [SECURITY.md](SECURITY.md) instead.
