# WIP: codex/issue-3524-resource-stack

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-resource-stack`
- 原始 commit：`0d648573bbb27599a3a41bb464821b196392d332`
- 原始 tree：`8b458e0e4a44140644426fd0988f122154e56359`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3523, #3527, #3597
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
0d648573b fix(database): execute MySQL typed DDL with exact index ownership
Use selected-database metadata and guarded prepared DDL for ensure/create/drop.
Preserve case-sensitive table ambiguity and shared string literal values.
Add real-engine tests and current semantics documentation without changing
historical descriptors, their fingerprints or PostgreSQL/SQLite snapshots.

This is a local development candidate, not terminal production qualification.
Canonical Migration inventory and execution remain pending under #3524.
Required matrix, independent review and standard PR acceptance remain open.

Refs: #3523

c0302d26a fix(governance): bind integrated resource authority digest
Refs: #3527

668cc2ec8 fix(governance): scope resource naming evidence exactly
Limit the exception manifest to paths matched by the trusted base registry's glob semantics.

Refs: #3527

5a6b7c784 fix(test): align resource boundary imports
Keep canonical test imports lint-clean and reseal the generated release-final closure without changing enforcement behavior.

Refs: #3527

d3039fc32 chore(governance): bind resource boundary PR evidence
Record exact generated authority bytes and the registered external naming surfaces for the resource-bound candidate.

Refs: #3527

0487c728b fix(test): bind durable execution to resource boundary
Keep durable and nested systemd workers beneath the same live resource ancestor, with pre-exec read-back, dynamic grants and exact recovery records. Canonical production-lane qualification and independent review remain open.

Refs: #3527

2694ae441 test(governance): bind Landlock writable paths exactly
Refs: #3597

ee5c378c6 fix(governance): compile Landlock helper with older UAPI headers
Refs: #3597
```

## 相对原 merge base 的源码差异概况

```text
...sue-3527-resource-boundary-external-naming.json |   46 +
 ...e-3527-resource-boundary-generated-binding.json |   13 +
 ...1-scheduler-fixture-assets-external-naming.json |   12 +
 ...scheduler-fixture-assets-generated-binding.json |   13 +
 ...heduler-finalizer-fixtures-external-naming.json |   12 +
 ...duler-finalizer-fixtures-generated-binding.json |   12 +
 .../migration-assembly-binding.json                |   10 +-
 .../migration-assembly-receipt.json                |   32 +-
 .../testing/physical-execution-process-policy.json |    2 +
 config/testing/retry-disposition-registry.json     |   24 +-
 docs/database-migration.md                         |   22 +
 docs/schema-migrations/typed-ddl-primitives.json   |   14 +-
 docs/testing.md                                    |   21 +
 docs/testing/content-addressed-evidence-storage.md |   30 +-
 .../issue-1069-run-bound-production-builds.md      |   10 +-
 .../issue-1072-production-resource-enforcement.md  |  374 ++-
 src/migration/SchemaMigrationDdlPrimitives.cs      |   97 +-
 .../release-final-execution-target-authority.json  |  694 +++-
 tests/migration/MigrationAssemblyBoundaryTests.cs  |   13 +-
 tests/migration/MySqlDdlExecutionTests.cs          |  194 ++
 tests/migration/MySqlDdlFixture.cs                 |  208 ++
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |   79 +-
 tests/migration/schema-ddl-provider-snapshots.json |    6 +-
 .../content-addressed-evidence-store.test.mjs      |   75 +-
 ...sm-fixture-materializer-runtime-assets.test.mjs |   33 +
 tests/tools/execution-envelope-network.test.mjs    |   45 +-
 tests/tools/hidden-retry-governance.test.mjs       |   24 +-
 .../tools/physical-execution-process-tree.test.mjs |  606 +++-
 .../physical-execution-systemd-sender.test.mjs     |  104 +
 .../production-capacity-preflight-order.test.mjs   |   82 +-
 .../tools/production-capacity-reservation.test.mjs |  262 ++
 .../tools/production-resource-enforcement.test.mjs | 3466 +++++++++++++++++++-
 tests/tools/scheduler-owner-identity.test.mjs      |  312 +-
 .../support/esm-fixture-materializer-contracts.mjs |  175 +-
 .../support/esm-fixture-materializer-runner.mjs    |   60 +
 tests/tools/support/esm-fixture-materializer.mjs   |  116 +-
 .../scheduler-checkpoint-recovery-probe.mjs        |   12 +
 tests/tools/test-matrix-resource-boundary.test.mjs |  694 ++++
 tests/tools/test-matrix-scheduler.test.mjs         |  564 ++--
 tools/check-test-matrix.mjs                        |    4 +-
 tools/run-test-matrix.mjs                          |  159 +-
 .../content-addressed-evidence-store.mjs           |   48 +-
 tools/test-matrix/production-build-layout.mjs      | 1223 ++++++-
 tools/test-matrix/production-build-lifecycle.mjs   |   32 +-
 .../production-capacity-reservation.mjs            |  269 +-
 .../production-resource-enforcement.mjs            |  418 ++-
 .../production-systemd-resource-boundary.mjs       | 1191 +++++++
 tools/test-matrix/scheduler.mjs                    | 1068 +++++-
 tools/test/lanes/static-governance.sh              |    6 +
 tools/test/native/execution-envelope-landlock.c    |    6 +
 .../physical-execution-linux-systemd-adapter.mjs   |  619 +++-
 tools/test/physical-execution-nested-channel.mjs   |  584 ++++
 tools/test/physical-execution-nested-socket.py     |  140 +
 tools/test/physical-execution-process-tree.mjs     |  862 ++++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++
 55 files changed, 14555 insertions(+), 916 deletions(-)
```

