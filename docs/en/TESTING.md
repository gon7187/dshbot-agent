# Core tests

`npm test` typechecks the repository and runs the complete retained test suite.
There is no separate hidden slow suite and no filtered CI shortcut.

The suite concentrates on behavior whose failure can lose work, expose data or
promote unverified code:

- Durable ingress, task corrections, cancellation, restart recovery and exactly-once delivery.
- Factory risk decisions, failed gates, independent review, fresh Git bases and verified merge receipts.
- Filesystem, process and network isolation; credential masking and principal authority.
- Native update provenance, adoption, rollback and preservation of owner state.
- Approval callbacks, bounded delivery, scheduled claims and atomic imports.

Tests use real local Git, SQLite and Linux isolation where those boundaries are
being checked. External model, Telegram, browser and mail transports use synthetic
fixtures. A fake external transport is not evidence that the corresponding live
service works. Kernel isolation tests need working bubblewrap and user namespaces;
check skipped tests before treating a run as deployment evidence.

## Local workflow

```sh
npm ci
npx vitest run packages/factory/acceptance-flow.test.ts
npm test
```

Use a focused file while iterating, then the whole suite before integration.
Run only one test command at a time. The default is one worker per available CPU;
`DSHBOT_TEST_WORKERS` accepts an explicit positive integer for constrained hosts.
Measure elapsed time on the intended machine before changing concurrency.

When fixing a fragile boundary, extend the closest core case. Prove that the
allowed action actually runs as well as that the forbidden action is denied;
absence of an effect from a process that never started is not an isolation proof.
Seed already-completed state when testing acceptance alone, and keep one real
pipeline test for the complete lifecycle. Prefer observable events or a fake clock
to fixed sleeps.

## Deliberate exclusions

The suite does not pin skill or prompt wording, documentation headings, model
catalogues or presentation snapshots. It does not retest the upstream agent
harness, provider SDKs, every browser feature or every supported document format.
Those regressions can escape this core suite. Check the actual affected integration
when changing an adapter or a feature outside the retained boundaries.
