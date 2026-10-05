# WIP: codex/issue-3662-original-stage-capture-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3662-original-stage-capture-20261003`
- 原始 commit：`1729d91df2ca15c0fdb2e02bb1d5c299d6884f05`
- 原始 tree：`6c522e84578b405773a2b228ee9e13ba28aa6546`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3662, #2218
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
1729d91df feat(deployment): capture bounded original stage shell results
Capture diagnostic-only preparation and actual shell return through the original rollout owner without changing stage v2 or granting native verification. Preserve earlier command failures when collection fails.

Refs: #3662

5de2579cb refactor(migration): combine historical custody with current role contracts
Preserve the reviewed historical facts and strict compiled pre-runtime contract in one source candidate. Generated catalogue refresh and runtime qualification remain pending.

Refs: #2218

7c4777fde chore(governance): declare historical fence source naming surface
Bind the repaired C# path to its existing registry entry without changing external spellings or authority.

Change-Class: implementation

Refs: #2218

951174da9 fix(database): reject trailing newline in historical fences
Preserve the recorded classification catalogue and require the historical date/suffix scalar to end at the absolute string boundary.

Change-Class: implementation

Refs: #2218

6a62c683e refactor(migration): bind the sole historical facts source
Complete the same finite custody increment after the sparse index omitted the new source path. Preserve the preceding normal commit as history; no evaluator, deployment parser or execution authority is restored.

Refs: #2218

9effe061e refactor(migration): take sole custody of historical classification facts
Preserve literal classifications and historical scalar ordering without carrying the Server compatibility evaluator, window admission or deployment identity parser into Migration. Keep original derived products pending their sole producer and preserve current-only refusal consumers.

Refs: #2218

524fa8b1a fix(backend): remove retired server migration control plane
Keep historical classification custody separate while retiring the unused Server CLI, DI and writable store. Direct consumers use current refusal inputs and the sole offline destructive guard.

Refs: #2218

21e76b377 test(release): bind finalizer self-test to current-only manifest
Use the existing v3 reference contract in the original valid fixture and retain explicit legacy-window and missing-current refusal controls without changing any validator.

Refs: #2218
```

## 相对原 merge base 的源码差异概况

```text
...-2218-historical-fence-end-external-naming.json |   12 +
 ...-2218-runtime-role-refusal-external-naming.json |   19 +
 config/contracts/behavior-fact-extractors.json     |    5 +-
 .../schemas/runtime-role-observation.schema.json   |  222 ++-
 docs/api/contracts.md                              |   52 +-
 .../admin-operations-health-boundary.md            |   41 +-
 .../monolithic-distributed-boundary.md             |   15 +
 docs/database-migration.md                         |   36 +-
 docs/online-database-migration-operations.md       |  428 ++---
 docs/online-database-migration.md                  |   75 +-
 docs/operations.md                                 |    6 +-
 docs/release-evidence-model.md                     |    4 +
 ops/docker/FsusBlog.Server.Dockerfile              |    2 +-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../Infrastructure/Operations/ProductionHealth.cs  |   79 +-
 src/backend/Infrastructure/Operations/ReleaseId.cs |    2 +-
 .../Infrastructure/Operations/ServerCommand.cs     |  358 +++++
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  140 ++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../OnlineSchemaMigrationCompatibility.cs          |  383 -----
 .../OnlineSchemaMigrationCoordinator.cs            |  603 -------
 .../PostgresOnlineSchemaMigrationStateStore.cs     |  287 ----
 .../SchemaCompatibilityCoordinate.cs               |  116 --
 .../SchemaMigration/SchemaMigrationRunner.cs       |   93 +-
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |    4 +-
 .../ReleaseSchemaQualificationEndpoints.cs         |  123 +-
 src/backend/Program.cs                             |   35 +-
 .../OfflineMigrationClassificationFacts.cs}        | 1142 +++++++------
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 .../Unit/ActiveReleaseFenceDurableWitnessTests.cs  |    5 +-
 .../backend/Unit/ActiveReleaseFencedCommitTests.cs |    7 +-
 .../ArticleDraftServerRevisionMigrationTests.cs    |    7 +-
 .../ArticleMutationIdempotencyMigrationTests.cs    |    7 +-
 .../Unit/ArticleMutationOutboxClaimLeaseTests.cs   |    7 +-
 .../Unit/ArticlePublicationMigrationTests.cs       |   11 +-
 .../Unit/ArticleRevisionRollbackMigrationTests.cs  |    8 +-
 tests/backend/Unit/BackendTestGovernanceTests.cs   |    2 -
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  394 +++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 +
 .../OnlineSchemaMigrationCompatibilityTests.cs     |  229 +--
 .../Unit/OnlineSchemaMigrationCoordinatorTests.cs  |  113 +-
 .../Unit/OnlineSchemaMigrationPolicyTests.cs       |  469 +++---
 .../backend/Unit/PasskeyProjectionCommandTests.cs  |   18 +-
 tests/backend/Unit/ProductionHealthTests.cs        |  120 +-
 .../ReleaseSchemaQualificationEndpointsTests.cs    |   82 +
 .../Unit/SchemaCompatibilityCoordinateTests.cs     |   66 +-
 tests/backend/Unit/SchemaMigrationRegistryTests.cs |   19 +-
 tests/backend/Unit/ServerCommandTests.cs           |  277 ++++
 tests/tools/behavior-doc-static-admission.test.mjs |   10 +-
 tests/tools/canonical-release-authorities.test.mjs |   24 +-
 .../tools/challenge-kind-cutover-rollout.test.mjs  |   13 +-
 tests/tools/current-schema-authority.test.mjs      |    2 +-
 tests/tools/deployment-slots.test.mjs              |    6 +-
 tests/tools/destructive-migration-proof.test.mjs   |   30 +-
 .../tools/destructive-operation-authority.test.mjs |    2 +
 tests/tools/final-image-toolchain-pin.test.mjs     |   48 +
 tests/tools/gateway-switch.test.mjs                |  465 +++++-
 .../offline-migration-catalog-parity.test.mjs      |    2 +-
 .../tools/online-schema-migration-wrapper.test.mjs |   75 +-
 tests/tools/release-manifest.test.mjs              |  233 ++-
 tests/tools/release-retention-state.test.mjs       |    3 +
 tests/tools/release-rollout-bundle.test.mjs        |    6 +-
 tests/tools/release-rollout-evidence.test.mjs      |  189 ++-
 tests/tools/release-rollout-probes.test.mjs        |    4 +-
 tests/tools/release-rollout-state.test.mjs         |   66 +-
 tests/tools/release-traffic-probe-session.test.mjs |    4 +-
 .../tools/release-worker-normal-observer.test.mjs  |    4 +-
 .../tools/release-worker-observer-service.test.mjs |    2 +
 tests/tools/release-worker-reconciliation.test.mjs |    2 +
 .../tools/runtime-role-contract-boundary.test.mjs  |   71 +-
 .../runtime-role-minimal-v3-contract.test.mjs      |   35 +-
 .../support/behavior-doc-admission-fixture.mjs     |    4 +-
 .../support/release-authority-test-fixtures.mjs    |    3 +
 .../support/release-readiness-test-helpers.mjs     |    4 +-
 .../support/release-rollout-evidence-fixture.mjs   |   61 +-
 .../support/runtime-role-minimal-v3-fixture.mjs    |   72 +-
 tests/tools/zero-downtime-rehearsal.test.mjs       |  595 +++++--
 tools/build-final-image.sh                         |   25 +-
 .../FsusBlog.RuntimeRoleObservation/Models.cs      |   34 +-
 .../FsusBlog.RuntimeRoleObservation/Program.cs     |  414 ++---
 .../db/check-offline-migration-catalog-parity.mjs  |    4 +-
 tools/db/generate-offline-migration-catalog.mjs    |   19 +-
 tools/db/run-online-migrations.sh                  |  113 +-
 tools/deploy-production.sh                         |    5 +-
 tools/deployment/gateway-recover.sh                |   66 +-
 tools/deployment/gateway-rollback.sh               |   67 +-
 tools/deployment/gateway-switch.sh                 |   54 +-
 ...release-rollout-auxiliary-evidence-contract.mjs |   53 +-
 .../release-rollout-evidence-constants.mjs         |    8 +-
 .../release-rollout-evidence-sections.mjs          |    8 +-
 .../release-rollout-evidence-verifier.mjs          |    2 +
 tools/deployment/release-rollout-evidence.mjs      |  255 +--
 tools/deployment/release-rollout-gate.mjs          |    7 +-
 tools/deployment/release-rollout-lib.mjs           |   53 +-
 tools/deployment/release-rollout-recovery.sh       |  242 +--
 .../release-rollout-semantic-artifact-contract.mjs |    2 +-
 tools/deployment/release-rollout.sh                |  216 ++-
 tools/deployment/release-traffic-probe.mjs         |    2 +-
 tools/deployment/rollout-state.mjs                 |   14 +
 tools/deployment/slot-common.sh                    |    3 +-
 .../verify-release-challenge-kind-cutover.mjs      |    7 +-
 tools/deployment/zero-downtime-rehearsal-plan.mjs  |  566 +++++--
 tools/deployment/zero-downtime-rehearsal.sh        | 1692 +-------------------
 ...vior-doc-minimal-contract-build-v3-contract.mjs |   71 +-
 tools/docs/behavior-doc-minimal-contract-build.mjs |   12 +-
 tools/fact-extractors/test-matrix/extract.mjs      |   75 +-
 .../operations/check-release-evidence-manifest.mjs |  253 ++-
 .../operations/collect-release-rollout-bundle.mjs  |    4 +-
 tools/release/check-release-final.mjs              |   41 +-
 tools/release/check-release-manifest.mjs           |   27 +-
 tools/release/create-release-manifest.mjs          |   52 +-
 tools/release/release-manifest-value-contract.mjs  |  146 +-
 tools/release/release-manifest.mjs                 |  119 +-
 ...anonical-release-authorities-value-contract.mjs |    8 +-
 118 files changed, 7237 insertions(+), 6202 deletions(-)
```

