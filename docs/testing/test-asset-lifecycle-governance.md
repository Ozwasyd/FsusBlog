# Test asset lifecycle governance

FsusBlog judges test assets by current coverage and ownership—not age, issue
history, runtime, or a one-time optimization campaign. The [test lifecycle
governance](test-lifecycle-governance.md) owns per-file lifecycle state.

## Canonical authorities

- `test-lifecycle-registry.json` assigns every Node test file and test ID one execution category and one physical owner; projection and summary entries cannot execute producers.
- `test-retention-replacements.json` maps every removed test ID to live semantic replacements. Chains must resolve to current tests and remain acyclic.
- `check-test-suite-convergence.mjs` compares the retained test, assertion, coverage, requirement, matrix, and release-evidence universes against the compact baseline and post-baseline manifests.
- `run-test-matrix.mjs validate` owns current topology. It validates the matrix dynamically and does not preserve historical tier counts or migrated-lane lists; the [testing strategy](../testing.md) is the human entry point.
- `check-browser-test-migration.mjs` owns [Browser Contract](browser-contract.md) and diagnostics migration, rejecting browser E2E sources that directly control SQL, Redis, Docker, or child processes.

## Retirement workflow

For each removed test ID:

1. Identify the current behavior or governance owner.
2. Add an exact replacement entry and a post-baseline record for the change.
3. Regenerate the lifecycle registry and generated testing documentation.
4. Run lifecycle, retention, suite-convergence, browser migration when applicable, and matrix validation.

A historical filename, fixed count, elapsed-time target, or prior campaign snapshot is not proof that a test remains valuable or obsolete. If a unique assertion has no current owner, the asset stays until a replacement is implemented and tested.

## Runtime projection replacements

A cache or authentication implementation cutover requires a semantic disposition,
not a test-name substitution. Map retained behavior to all current owners and name
the retired mechanism in the replacement reason; do not restore obsolete cache
strings, synchronous touches, Redis overlays or legacy identities to preserve a
source-shape assertion.

Ban/unban ownership remains with real `BlacklistService` mutations and the existing
`DistributedInvalidationTargetConvergenceIntegrationTests` PostgreSQL/Redis fixture.
Replacement evidence must retain normalized persisted ban reasons, a normal-account
unban, authority generation and the matching durable event, actual publication and
restart replay. A prepare-failure test must prove that authority state, generation
and the durable event roll back together without publishing. Injecting local
projection facts alone cannot replace these mutation and transaction oracles.

Admin validation, bounded last-seen scheduling, bearer-token propagation and
credential/session binding are separate owners. Article-view projection behavior
and real Redis service reads jointly replace the retired per-request overlay;
related-reading ranking, database command counting and benchmark budgets jointly
replace private hot-path source shapes. An unresolved owner remains a failing
retention prerequisite rather than a guessed alias or waiver.

## Local verification

```bash
node tools/check-test-lifecycle.mjs
node tools/check-test-retention.mjs
node tools/check-test-suite-convergence.mjs
node tools/check-browser-test-migration.mjs
node tools/run-test-matrix.mjs validate
```
