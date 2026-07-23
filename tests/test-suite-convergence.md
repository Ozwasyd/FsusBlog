# Issue #1051 test-suite convergence

Issue #1051 is the final tracking gate for issues #1032 through #1050. It does
not own another broad deletion batch. Its executable owner is
`tools/check-test-suite-convergence.mjs`, which consumes the authoritative
before snapshot, the central replacement ledger, matrix governance, and an
optional after retention snapshot.

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
- Replacement declarations have one current owner:
  `tests/test-retention-replacements.json`.
- All errors are emitted in one run; the auditor has no maximum-error cutoff.
- Backend `*Tests.cs` files may read runtime artifacts and checked-in fixture
  data, but may not read production, documentation, workflow/matrix, or sibling
  test source as functional proof.
- The retained Public AOT Node protocol test now creates an isolated runtime
  worker artifact and invokes it through `PublicAotNodeSsrRenderer`; it no longer
  imports `src/frontend/scripts` source. The retained legacy-cookie retirement
  test proves production behavior and compiled metadata without loading backend
  `appsettings*.json`. Both corrections keep their original test IDs and are
  recorded in the central retention ledger.
- Frontend source-locking remains owned only by
  `check-frontend-test-governance.mjs`; its active ownership declarations live
  in `tests/matrix.yml.governance.sourceLocking`.

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
node tools/check-test-suite-convergence.mjs \
  --after .tmp/release-evidence/test-retention-audit.json \
  --out .tmp/release-evidence/test-suite-convergence.json \
  --final
```

Final mode requires an explicitly selected after retention audit whose producer
and source-state bindings differ from the authoritative before snapshot. Other
release evidence remains owned by its matrix tiers instead of a second
convergence plan.

## Central integration state

The shared-file integration is now present in source but remains deliberately
unverified until the unified validation phase:

1. `tests/test-retention-replacements.json` contains the exact central
   declarations consumed by convergence;
2. `tests/coverage-registry.json` registers `test-suite-convergence` as the
   unique cross-suite tracking coverage ID;
3. `tests/matrix.yml` and the release-final evidence lists retain
   `.tmp/release-evidence/test-suite-convergence.json`;
4. static governance invokes `tools/check-test-suite-convergence.mjs` in
   implementation mode;
5. final mode remains intentionally deferred until the authoritative after
   snapshot exists;
6. `tests/tools/test-suite-convergence.test.mjs` and both classifier fixtures
   are registered by the backend/tool requirement catalog;
7. the two late N–S source-lock corrections retain their baseline test IDs and
   replace production-source reads with a test-built runtime artifact or
   compiled service behavior; no deletion declaration was invented for them.

`docs/testing.md` links this owner and keeps business evidence at behavior,
protocol/serialization, persistence, concurrency or executable tool boundaries;
source policy remains owned by one fixture-backed static checker.

The matrix, focused Node suites, browser migration, cross-stack governance,
execution contract, generated testing docs and retention audit are the focused
verification owners for this migration. Production and release-final remain
separate matrix-owned proofs.
