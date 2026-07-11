# Frontend source-locking migration inventory (#1049)

The frontend unit suite previously mixed behavior tests with tests that opened
production source files and asserted private names, source fragments, or the
names of other tests. Issue #1049 moves those responsibilities to direct
behavior tests or one static-governance owner.

## Inventory

| Disposition | Files | Baseline test IDs | Owner |
| --- | ---: | ---: | --- |
| Source-only unit files deleted | 44 | 283 | Direct behavior tests, browser scenarios, or static checkers listed in the migration plan |
| Source assertions removed from otherwise behavioral files | 12 | 31 | The retained behavior tests and the named static checker |
| Legitimate checked-in fixture readers | 3 | Not deleted | Exact allowlist in the migration plan |
| Overlapping source-only files completed by #1045 | 5 | 29 | Exact declarations merged into the central retention manifest; no active allowlist remains |
| Files still delegated to overlapping issue owners | 0 | 0 | Final handoff is fail-closed and contains no temporary source-read exemption |

The machine-readable source of truth is
`frontend-source-locking-migration-plan.mjs`. It includes the expected baseline
record count for every deleted file, every selectively deleted test ID, and the
exact replacement test IDs.

Generate the #1032 handoff JSON with:

```text
node tests/frontend/checks/static/build-frontend-source-locking-handoff.mjs
```

The builder reads `tests/test-retention-before.json`, merges the central
declarations with `tests/issue-1049-retention-replacements.json`, expands all
file-level entries into exact baseline test IDs, rejects missing or circular
replacement IDs, and emits 314 deleted-ID-to-replacement-ID records. It does
not execute any test.

## Ownership rules

- Business behavior is owned by imported unit behavior, component/router/API
  execution, or a browser scenario.
- Static source policy is owned by a single checker in
  `tests/frontend/checks/static/`, not by a Vitest file pretending to exercise
  runtime behavior.
- Performance deletions map only to executable decode/DOM/Markdown/route/asset
  budgets, the frontend benchmark, and the browser performance lane; source
  token checkers are not accepted as performance replacement evidence.
- Protocol hex, binary transport hex, and checked-in cover artifacts are
  fixture reads rather than production-source locking and remain explicitly
  allowlisted.
- The former collision-avoidance entries are gone. #1045's five overlapping
  source-only files are already deleted and centrally mapped; the #1053
  session-fixture and #1054 auth/recovery files are part of this final plan and
  the issue-local retention manifest supplies their exact compact mappings.
- `check-frontend-test-governance.mjs` parses active unit files with the
  TypeScript AST and rejects new filesystem source readers or source-lock helper
  calls. Positive and negative fixtures live under
  `tests/frontend/fixtures/source-locking/`.
