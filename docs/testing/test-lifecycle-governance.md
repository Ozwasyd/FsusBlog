# Test lifecycle governance

`tests/governance/test-lifecycle-registry.json` is the checked-in owner boundary for Node tests. Every test declares exactly one canonical owner, execution category, lifecycle state, physical execution count, and semantic classification. A new test is `unowned` until the registry is intentionally updated; governance fails closed while it is unowned. The [test-asset lifecycle](test-asset-lifecycle-governance.md) defines retention and replacement ownership.

`test-assets` runs `tools/check-test-retention.mjs` once to completely generate the matrix-declared `.tmp/release-evidence/test-retention-audit.json`, then runs `node tools/check-test-lifecycle.mjs --audit-input <path>` against it. The input must be non-empty `fsusblog.test-retention-audit.v2` matching the current commit and tracked-worktree fingerprint exactly; missing, corrupt, invalid-schema, producer-identity drift, or read-time changes fail closed. `--audit-input` starts no retention producer and does not modify its input. Standalone `node tools/check-test-lifecycle.mjs` still creates a diagnostic audit, but that path is not the matrix artifact authority.

Lifecycle joins the registry and complete retention audit into `.tmp/release-evidence/test-lifecycle-report.json`, including every discovered test/assertion ID, semantic assertion target, coverage ID, replacement ID, current source identity, and physical owner. It also writes `.tmp/release-evidence/test-lifecycle-candidate-matrix.md` with actions retain, project, merge, move-layer, or delete.

Decisions never use elapsed time, file age, or recent-failure age. `migration-bound` requires a structured product or compatibility condition; `replacement-ready` and `obsolete` require exact replacement IDs or explicit proof that the assertion is outside the supported contract. Projection and summary owners cannot execute their producer; canonical execution owners require exactly one physical execution.

Update the inventory after intentionally adding, moving, or deleting a Node test:

```bash
node tools/check-test-lifecycle.mjs --write-registry
node tools/check-test-lifecycle.mjs
node --test tests/tools/test-lifecycle-governance.test.mjs
```

The generated registry is a starting classification, not permission to demote a high-value scheduler, artifact, resource, security, migration, or runtime test to manual diagnostics. Wire such tests to their canonical executable owner before delivery.
