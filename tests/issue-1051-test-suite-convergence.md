# Issue #1051 test-suite convergence

Issue #1051 is the final tracking gate for issues #1032 through #1050. It does
not own another broad deletion batch. Its executable owner is
`tools/check-test-suite-convergence.mjs`, which consumes the authoritative
before snapshot, central and issue-local replacement manifests, the frontend
#1049 migration plan, and an optional after retention snapshot.

## What the convergence audit proves

- Every issue from #1032 through #1050 appears once in the declared stage
  order, and declared dependencies point only to earlier stages.
- Every baseline test ID whose file disappeared has a replacement declaration.
- Replacement declarations must retain the exact baseline path; issue-local
  manifests with `expectedDeletedTestIds` must match that count exactly.
- In final mode, every baseline ID absent from the after snapshot has a
  declaration and every declared replacement ID exists in the after snapshot.
- Declarations already captured by #1032 under the compact
  `replacementManifestBaseline.deletedTestIndex` remain valid instead of being
  misclassified as post-baseline unknown deletions; the raw ID list is not
  retained in the source-free v3 baseline.
- Duplicate declarations are accepted only when their path and exact
  replacement-ID set agree. Conflicting manifests fail with both owner paths.
- All errors are emitted in one run; the auditor has no maximum-error cutoff.
- Backend `*Tests.cs` files may read runtime artifacts and checked-in fixture
  data, but may not read production, documentation, workflow/matrix, or sibling
  test source as functional proof.
- The retained Public AOT Node protocol test now creates an isolated runtime
  worker artifact and invokes it through `PublicAotNodeSsrRenderer`; it no longer
  imports `src/frontend/scripts` source. The retained legacy-cookie retirement
  test proves production behavior and compiled metadata without loading backend
  `appsettings*.json`. Both corrections keep their original test IDs and are
  recorded in `issue-1051-backend-source-lock-retention-replacements.json`.
- Frontend source-locking remains owned only by
  `check-frontend-test-governance.mjs`; the convergence audit imports its exact
  migration plan instead of implementing a second frontend scanner.

The backend scanner has explicit positive and negative C# fixtures under
`tests/tools/fixtures/test-suite-convergence/`. The Node behavior suite covers
fixture classification, conflicting manifests, undeclared deletions, missing
replacement targets, exact path-plan expansion, and stage dependency order.

## Modes

Implementation mode can be invoked later with:

```text
node tools/check-test-suite-convergence.mjs \
  --out .tmp/release-evidence/test-suite-convergence.json
```

It uses current path existence when no after snapshot exists. This catches
whole-file deletions immediately but does not pretend to prove selective method
retention. Implementation mode never auto-loads the default `.tmp` after path,
so a leftover artifact cannot silently change this result; pass `--after`
explicitly when method-level comparison is wanted.

Final mode requires the actual after audit:

```text
node tools/capture-test-convergence-issues.mjs
node tools/check-test-suite-convergence.mjs \
  --after .tmp/release-evidence/test-retention-audit.json \
  --out .tmp/release-evidence/test-suite-convergence.json \
  --final
```

Final mode additionally requires backend, frontend, and merged coverage
summaries, coverage scope evidence, mutation authority, the production test
plan, test-quality and optimization authority, performance evidence, and
viewport evidence listed in `tests/issue-1051-suite-convergence.json`. Presence
alone is insufficient: the declared JSON fields must report successful status,
the optimization report must prove final authority plus same-or-stronger
coverage, and its authoritative fresh run ID must equal the after audit producer
run ID. The after audit must also carry matching root/producer timestamps and
source-state bindings, and a source state different from the authoritative
before snapshot.

The issue capture is read-only. It queries the current GitHub repository through
`gh`, records the URL and `closedAt` value for every issue from #1032 through
#1050, and fails unless the exact 19-issue set is closed. It does not comment,
close, label, or otherwise mutate any issue.

## Central integration state

The shared-file integration is now present in source but remains deliberately
unverified until the unified validation phase:

1. `tests/test-retention-replacements.json` contains the exact issue-local and
   expanded #1049 declarations consumed by convergence;
2. `tests/coverage-registry.json` registers `test-suite-convergence` as the
   unique cross-suite tracking coverage ID;
3. `tests/matrix.yml` and the release-final evidence lists retain
   `.tmp/release-evidence/test-suite-convergence.json`;
4. static governance invokes `tools/check-test-suite-convergence.mjs` in
   implementation mode;
5. final mode remains intentionally deferred until the authoritative after
   snapshot and all required coverage, mutation, timing and issue-state
   artifacts exist;
6. `tests/tools/test-suite-convergence.test.mjs` and both classifier fixtures
   are registered by the backend/tool requirement catalog;
7. `tools/capture-test-convergence-issues.mjs` remains the live, read-only
   GitHub-state producer immediately before final convergence.
8. the two late N–S source-lock corrections retain their baseline test IDs and
   replace production-source reads with a test-built runtime artifact or
   compiled service behavior; no deletion declaration was invented for them.

`docs/testing.md` links this owner and keeps business evidence at behavior,
protocol/serialization, persistence, concurrency or executable tool boundaries;
source policy remains owned by one fixture-backed static checker.

No test, build, lint, restore, syntax check, source-lock audit, retention audit,
coverage, mutation, timing, production, or release command was executed while
landing this code. The current repository may therefore remain blocked until
all child issues and final evidence are actually complete.
