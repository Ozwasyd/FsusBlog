# Test asset lifecycle governance

FsusBlog judges test assets by current coverage and ownership, not by age, issue history, runtime, or a one-time optimization campaign.

## Canonical authorities

- `test-lifecycle-registry.json` assigns every Node test file and test ID one execution category and one physical owner. Projection and summary entries cannot execute producers.
- `test-retention-replacements.json` maps every removed test ID to live semantic replacements. Chains must resolve to current tests and remain acyclic.
- `check-test-suite-convergence.mjs` compares the retained test, assertion, coverage, requirement, matrix, and release-evidence universes against the compact baseline and post-baseline manifests.
- `run-test-matrix.mjs validate` owns current topology. It validates the matrix dynamically and does not preserve historical tier counts or migrated-lane lists.
- `check-browser-test-migration.mjs` owns Browser Contract and diagnostics migration, and rejects browser E2E sources that directly control SQL, Redis, Docker, or child processes.

## Retirement workflow

For each removed test ID:

1. Identify the current behavior or governance owner.
2. Add an exact replacement entry and a post-baseline record for the change.
3. Regenerate the lifecycle registry and generated testing documentation.
4. Run lifecycle, retention, suite-convergence, browser migration when applicable, and matrix validation.

A historical filename, fixed count, elapsed-time target, or prior campaign snapshot is not proof that a test remains valuable or obsolete. If a unique assertion has no current owner, the asset stays until a replacement is implemented and tested.

## Local verification

```bash
node tools/check-test-lifecycle.mjs
node tools/check-test-retention.mjs
node tools/check-test-suite-convergence.mjs
node tools/check-browser-test-migration.mjs
node tools/run-test-matrix.mjs validate
```
