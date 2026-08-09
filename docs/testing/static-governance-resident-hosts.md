# Static governance resident hosts and receipt join

The Node contract portion of `static-governance` is selected from the
`staticGovernance` metadata on `tests/governance/test-lifecycle-registry.json`
entries. The lifecycle registry is the single test-file inventory authority;
every migrated physical check has one registry ID, one category, and one
physical owner without a parallel static-governance file list.

The execution contract has four categories:

- `pure-file-validation` runs in one resident Node test host.
- `isolated-temporary-repository-fixture` runs in one resident host, while
  every registry entry declares a distinct temporary root and output path.
- `real-subprocess-lifecycle` retains one Node process per check.
- `exclusive-resource-destructive-rehearsal` retains one exclusive process per
  check or zero-downtime shard.

The host evidence at `.tmp/test-governance/host-evidence.json` records the
source identity, run ID, exact check catalog, physical owners, before/after
child-process counts, wall time, controller CPU seconds, and the bytes read to
materialize the registered test-file catalog. Each host uses
`static-governance-reporter.mjs` to persist structured runtime pass events;
the runner maps those events to the canonical test-ID catalog instead of
inferring execution from a zero exit code or parsing logs. Missing, duplicate,
skipped, todo, failed, or unregistered IDs fail before a success evidence
document can be written.

## Frontend structure receipts

`check-dom-depth-static.mjs` and `check-markdown-render-budget.mjs` are the only
physical producers for their artifacts. Each writes a SHA-256-sealed receipt
under `.tmp/frontend/receipts/`, bound to the current source commit, worktree
fingerprint, and run ID. `frontend-render-structure.sh` invokes only
`join-frontend-render-structure-receipts.mjs`; it never launches either
checker. The join rejects failed, missing, duplicate, stale-run, wrong-source,
tampered receipt, missing artifact, and artifact-digest drift.

## Risk and rollback

The shared-host risk is leaked process-global state. Registry classification
keeps real process/lifecycle and destructive checks outside shared hosts, and
temporary-repository entries retain check-scoped roots and outputs. A
no-restart rollback is to restore the previous runner and lane script while
keeping producer artifacts; do not accept or project the v2 join summary after
rollback because the old runner does not prove the same receipt ownership.

Local issue validation covers the registry mutations, lifecycle/exclusive
boundaries, receipt mutations, producer-to-join path, matrix schema, and
focused runner contracts. The three-round complete Production fresh comparison
remains final acceptance and is not substituted by focused issue validation.
