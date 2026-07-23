# Issue #1048 test-tool behavior handoff

This issue keeps test-tool evidence at executable boundaries. Coverage scripts
run with `--dry-run` under a bounded timeout; the backend TRX contract invokes a
controlled filtered lane and parses the actual result files; viewport state is
written beneath a temporary current-run tree; data/performance aggregators and
release artifact restore execute against isolated local and downloaded layouts.

The retained owners are:

- `CoverageScriptContractTests.cs`: executable bit and bounded dry-run JSON;
- `backend-trx-contract.test.mjs`: lane names, real TRX XML and passing counters;
- `ux-viewport-runner.test.mjs`: Playwright/summary exit-code composition;
- `ux-viewport-progress.test.mjs` and `ux-viewport-runtime-contract.test.mjs`:
  current pointer, fresh/resume, atomic writes, stale exclusion and exact visual
  screenshot counts;
- `data-scale-evidence-summary.test.mjs` and
  `performance-evidence-summary.test.mjs`: fresh/failed/downloaded aggregate
  behavior with deterministic cleanup;
- `quality-gate-artifact-layout.test.mjs`: imported wildcard lookup behavior;
- `release-evidence-artifact-restore.test.mjs`: mixed and stripped layout restore;
- `BackendTestPathsTests.cs`: only the four repository-root resolution cases.

Package, workflow, lane and matrix wiring is delegated to the existing
structured parsers. No replacement test reads shell, workflow, matrix, package
scripts or sibling test source as its primary assertion. The exact 38 baseline
deletions and replacement IDs are recorded in
`tests/issue-1048-retention-replacements.json`.

The exact 38 mappings are present in the shared retention registry with status
`present-not-verified`; unified validation remains intentionally deferred.

No test, build, lint, syntax, checker, profile or timing command was run while
landing this handoff.
