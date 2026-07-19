# Frontend source-locking migration inventory (#1049)

The frontend unit suite previously mixed behavior tests with tests that opened
production source files and asserted private names, source fragments, or the
names of other tests. Issue #1049 moves those responsibilities to direct
behavior tests or one static-governance owner.

## Inventory

| Disposition | Files | Baseline test IDs | Owner |
| --- | ---: | ---: | --- |
| Source-only unit files deleted | 44 | 283 | Direct behavior tests, browser scenarios, or central retention mappings |
| Source assertions removed from otherwise behavioral files | 12 | 31 | The retained behavior tests and the named static checker |
| Legitimate checked-in fixture readers | 3 | Not deleted | Exact owner list in `tests/matrix.yml` |
| Overlapping source-only files completed by #1045 | 5 | 29 | Exact declarations merged into the central retention manifest; no active allowlist remains |
| Files still delegated to overlapping issue owners | 0 | 0 | Final handoff is fail-closed and contains no temporary source-read exemption |

The current machine-readable authorities are `tests/matrix.yml.governance.sourceLocking`
for active owners and `tests/test-retention-replacements.json` for exact deleted
test IDs and replacement IDs. The immutable before snapshot remains
`tests/test-retention-before.json`; historical issue handoffs are not executable
configuration.

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
- The former collision-avoidance entries are gone. All completed source-only
  deletions, including the #1053 and #1054 mappings, are recorded once in the
  central retention ledger.
- `check-frontend-test-governance.mjs` parses active unit files with the
  TypeScript AST and rejects new filesystem source readers or source-lock helper
  calls. Positive and negative fixtures live under
  `tests/frontend/fixtures/source-locking/`.
