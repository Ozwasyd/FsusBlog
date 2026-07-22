# Test lifecycle governance

`tests/governance/test-lifecycle-registry.json` is the checked-in owner boundary for Node test files. Every Node test declares exactly one canonical owner, execution category, lifecycle state, physical execution count, and semantic classification. A newly added test is `unowned` until the registry is intentionally updated; local governance fails closed in that state.

`node tools/check-test-lifecycle.mjs` joins that registry with the full retention audit. It writes `.tmp/release-evidence/test-lifecycle-report.json` with every discovered test/assertion ID, semantic assertion targets, coverage IDs, replacement IDs, current source identity, and physical owner. It also writes `.tmp/release-evidence/test-lifecycle-candidate-matrix.md`, whose actions distinguish retain, project, merge, move-layer, and delete decisions.

Lifecycle decisions do not use elapsed time, file age, or recent failure age. `migration-bound` entries require a structured product or compatibility condition. `replacement-ready` and `obsolete` entries require exact replacement IDs or an explicit proof that the assertion is outside the supported contract. Projection and summary owners cannot execute their producer, while canonical execution owners must have exactly one physical execution.

Update the inventory after intentionally adding, moving, or deleting a Node test:

```bash
node tools/check-test-lifecycle.mjs --write-registry
node tools/check-test-lifecycle.mjs
node --test tests/tools/test-lifecycle-governance.test.mjs
```

The generated registry is a starting classification, not permission to demote a high-value scheduler, artifact, resource, security, migration, or runtime test to manual diagnostics. Such tests must be wired to their canonical executable owner before delivery.
