# Test lifecycle governance

`tests/governance/test-lifecycle-registry.json` is the checked-in owner boundary for Node test files. Every Node test declares exactly one canonical owner, execution category, lifecycle state, physical execution count, and semantic classification. A newly added test is `unowned` until the registry is intentionally updated; local governance fails closed in that state.

`test-assets` 先且仅先运行一次 `tools/check-test-retention.mjs`，完整生成
matrix 已声明的 `.tmp/release-evidence/test-retention-audit.json` 后，再用
`node tools/check-test-lifecycle.mjs --audit-input <path>` 消费同一 artifact。
输入必须是非空 `fsusblog.test-retention-audit.v2`，并精确匹配当前 commit
和 tracked worktree fingerprint；缺失、损坏、schema 错误、producer
identity 漂移或读取期间变化全部 fail closed。带 `--audit-input` 的
lifecycle 不启动 retention producer，也不修改输入。standalone
`node tools/check-test-lifecycle.mjs` 仍自行生成一份诊断 audit，但该路径
不是 matrix artifact authority。

Lifecycle 把 registry 与该完整 retention audit join，写入
`.tmp/release-evidence/test-lifecycle-report.json`，其中包含每个发现的
test/assertion ID、semantic assertion target、coverage ID、replacement
ID、当前 source identity 和 physical owner；同时写入
`.tmp/release-evidence/test-lifecycle-candidate-matrix.md`，其 action
区分 retain、project、merge、move-layer 和 delete。

Lifecycle decisions do not use elapsed time, file age, or recent failure age. `migration-bound` entries require a structured product or compatibility condition. `replacement-ready` and `obsolete` entries require exact replacement IDs or an explicit proof that the assertion is outside the supported contract. Projection and summary owners cannot execute their producer, while canonical execution owners must have exactly one physical execution.

Update the inventory after intentionally adding, moving, or deleting a Node test:

```bash
node tools/check-test-lifecycle.mjs --write-registry
node tools/check-test-lifecycle.mjs
node --test tests/tools/test-lifecycle-governance.test.mjs
```

The generated registry is a starting classification, not permission to demote a high-value scheduler, artifact, resource, security, migration, or runtime test to manual diagnostics. Such tests must be wired to their canonical executable owner before delivery.
