# Static governance resident hosts and receipt join

The [test lifecycle registry](test-lifecycle-governance.md) is the sole test-file
inventory. `static-governance` selects its Node contract from each entry's
`staticGovernance` metadata; every migrated check has one registry ID, category,
and physical owner, with no parallel file list.

The execution contract has four categories:

- `pure-file-validation` runs in one resident Node test host.
- `isolated-temporary-repository-fixture` runs in one resident host, while
  every registry entry declares a distinct temporary root and output path.
- `real-subprocess-lifecycle` retains one Node process per check.
- `exclusive-resource-destructive-rehearsal` retains one exclusive process per
  check or zero-downtime shard.

`.tmp/test-governance/host-evidence.json` records source identity, run ID, exact
check catalog, owners, before/after child-process counts, wall time, controller
CPU seconds, and bytes read to materialize the registered catalog.
`static-governance-reporter.mjs` persists structured runtime pass events; the
runner maps them to canonical test IDs instead of inferring from exit code or
logs. Missing, duplicate, skipped, todo, failed, or unregistered IDs fail before
success evidence can be written.

## Frontend structure receipts

`check-dom-depth-static.mjs` and `check-markdown-render-budget.mjs` are the sole
physical producers for their artifacts. Each writes a SHA-256-sealed receipt in
`.tmp/frontend/receipts/`, bound to source commit, worktree fingerprint, and run
ID. `frontend-render-structure.sh` invokes only
`join-frontend-render-structure-receipts.mjs`, never either checker. The join
rejects failed, missing, duplicate, stale-run, wrong-source, or tampered
receipts, missing artifacts, and artifact-digest drift.

## Risk and rollback

The shared-host risk is leaked process-global state. Registry classification keeps
real process/lifecycle and destructive checks outside shared hosts, while
temporary-repository entries retain check-scoped roots and outputs. For a
no-restart rollback, restore the previous runner and lane script while retaining
producer artifacts; do not accept/project the v2 join summary because the old
runner does not prove the same receipt ownership.

Local issue validation covers registry mutations, lifecycle/exclusive boundaries,
receipt mutations, producer-to-join path, matrix schema, and focused runner
contracts. Three-round complete Production Fresh remains final acceptance; issue
validation cannot substitute for it.
