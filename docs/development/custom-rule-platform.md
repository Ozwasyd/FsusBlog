# Custom rule platform

FsusBlog keeps domain governance instead of replacing it with generic style lint. The custom rule platform gives every existing check a machine-readable identity while language-generic rules remain owned by Roslyn, ESLint/Vue AST, Stylelint, clang tooling, ShellCheck, and schema-aware parsers.

## Authority and inventory

`config/governance/custom-rule-registry.json` is generated from the tracked `check:*` commands in `src/frontend/package.json` and the custom check implementations selected by `config/governance/complexity-policy.json`. Every entry records its external ID, PascalCase internal symbol, owner, category, engine, source scopes, severity, fixability, changed-file safety, dependencies, fixture, documentation, execution key, and receipt compatibility. Removing or adding a command or implementation without regenerating the registry fails inventory parity.

Text-based rules must include `textRationale`. This is an explicit migration debt marker, not permission to reimplement indentation, naming, unused symbols, promises, or AST nesting with regular expressions. Format and language semantics stay with the standard AST/compiler tools. Domain rules should move to an AST or parser when a stable parser surface exists, while browser/runtime checks remain runtime checks.

Regenerate only after reviewing the inventory change:

```bash
node tools/governance/check-rule-platform.mjs --write-registry --mode changed
```

## Shared scan and execution metadata

The runner builds one Git-backed file inventory and one content cache per run. Rules consume that inventory instead of creating independent unbounded recursive walkers. Changed mode selects rules by scope and closes over rule dependencies; rules marked unsafe for changed-file analysis remain conservative. Full mode is the authoritative registry and complexity conclusion.

Each run writes `.tmp/governance/rule-platform-summary.json` with the source fingerprint, selected rules, execution keys, duration, files scanned, cache hits, violations, and final status. Failed and cancelled runs persist partial summaries. The stable execution key, source fingerprint, and `receiptCompatible` metadata are the integration boundary for #1067 scheduler admission and #1079 deterministic receipt reuse; this issue does not replace either scheduler.

```bash
node tools/governance/check-rule-platform.mjs --mode changed --base origin/master
node tools/governance/check-rule-platform.mjs --mode full
```

## Complexity and responsibility policy

The baseline measures file lines, code lines, type and function/method count, cyclomatic and cognitive complexity, nesting depth, imports/dependencies, public surface, responsibility signals, generated status, 365-day churn, and test-to-source relationships. Budgets are derived from repository category percentiles and are not one global line-count limit.

Categories are independent: endpoint composition, service/domain logic, codec/protocol, generated contract, Vue view/component, build/test orchestrator, manifest/registry, and other handwritten modules. Existing baseline excess is observe-only. New files and files with significant growth above their category budget fail and must be split or receive an explicit temporary exemption.

`config/governance/complexity-exemptions.json` is intentionally empty by default. An exemption requires an owner, concrete reason, expiry date, repository review issue, and exact metrics fingerprint. Expired exemptions, removed sources, and stale fingerprints fail closed; permanent or ownerless exemptions are invalid.

Refresh the baseline only as a reviewed governance change, never as an automatic response to a failure:

```bash
node tools/governance/check-rule-platform.mjs --write-baseline --mode full
```

## Migration boundary

The registry preserves the count and semantics of security, privacy, AEDS, UI, accessibility, cache, release, and test-governance checks. It does not execute hundreds of delegated commands in one process; matrix lanes remain their execution owners. The platform supplies shared discovery, affected-rule metadata, complexity enforcement, and auditable receipts so those lanes can converge without deleting real coverage.
