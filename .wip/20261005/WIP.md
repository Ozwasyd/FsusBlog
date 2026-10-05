# WIP: codex/issue-3662-final-value-contract-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3662-final-value-contract-20261003`
- 原始 commit：`6112ee8e5b17fef478828cad1f9d1e61790f9b58`
- 原始 tree：`cca34c57f47e00929050489d66507263d3d8654c`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3662, #2218
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
6112ee8e5 refactor(governance): isolate final consistency value validation
Refs: #3662

5d93a32d9 feat(governance)!: compose typed post-source and strict final refusal
Preserve frozen issue 3662 typed target bindings, auxiliary projections and final CURRENT_FAILED controls with exact donor source bytes. The lawful registry material bridge and admitted native proof remain unavailable; this is partial source integration only.

BREAKING CHANGE: integrate the original strict v2 final report and required-evidence source schema interfaces without accepting their retired versions.
Refs: #3662

3c963288d chore(governance): bind core union registered naming surfaces
Refs: #3662

c8d26a0aa feat(governance)!: compose frozen current schema stage sources
BREAKING CHANGE: Post-runtime routing and admission source contracts require explicit producer ownership, v2 stage receipts, and current native receipt references; old versions remain refused.
Refs: #3662

bd620ae57 chore(migration): regenerate historical classification catalog
Run the original source-owned generator and parity consumer against the exact current historical facts and 59 Definitions. Preserve all 143 existing classifications and restore the two existing Expand classifications omitted by the stale artifact. Refresh source navigation/digest and register the generated owner; no hand-authored generated rows or native admission.

Refs: #2218

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
```

## 相对原 merge base 的源码差异概况

```text
.../3662-post-native-routing-external-naming.json  |   30 +
 ...-2218-historical-fence-end-external-naming.json |   13 +
 ...-2218-runtime-role-refusal-external-naming.json |   19 +
 ...issue-3662-core-once-union-external-naming.json |   64 +
 ...ue-3662-core-refusal-union-external-naming.json |   41 +
 .../issue-3662-final-refusal-external-naming.json  |   29 +
 ...-3662-final-value-contract-external-naming.json |   15 +
 ...sue-3662-post-runtime-join-external-naming.json |   19 +
 ...sue-3662-pre-parse-binding-external-naming.json |   19 +
 .../issue-3662-pure-stage-io-external-naming.json  |   18 +
 ...issue-3662-stage-admission-external-naming.json |   32 +
 config/contracts/behavior-contracts.json           |   33 +-
 config/contracts/behavior-fact-extractors.json     |    8 +-
 .../contracts/document-claim-migration-ledger.json |   11 +-
 ...havior-doc-static-admission-receipt.schema.json |   69 +-
 ...r-document-consistency-final-report.schema.json |   47 +-
 ...avior-evidence-post-runtime-receipt.schema.json |   41 +-
 .../post-runtime-observation-result.schema.json    |    7 +-
 .../schemas/runtime-role-observation.schema.json   |  222 ++-
 config/testing/post-runtime-producer-registry.json |  183 ++-
 .../required-evidence-authority-ledger.json        |    4 +-
 docs/api/contracts.md                              |   52 +-
 .../admin-operations-health-boundary.md            |   41 +-
 .../monolithic-distributed-boundary.md             |   15 +
 docs/database-migration.md                         |   46 +-
 docs/development/doc-claim-protocol.md             |   16 +
 docs/online-database-migration-operations.md       |  428 ++---
 docs/online-database-migration.md                  |   75 +-
 docs/operations.md                                 |    6 +-
 docs/releases/blue-green-deployment-runbook.md     |   62 +-
 docs/testing.md                                    |    4 +
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
 .../OfflineMigrationCatalogEntries.generated.cs    |    6 +-
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
 tests/coverage-registry.json                       |   25 +
 .../tools/application-runtime-observation.test.mjs |   13 +-
 tests/tools/behavior-doc-static-admission.test.mjs |  226 ++-
 .../behavior-document-consistency-final.test.mjs   |  373 ++++-
 .../tools/behavior-evidence-post-runtime.test.mjs  |  171 +-
 tests/tools/canonical-release-authorities.test.mjs |  570 ++++++-
 .../tools/challenge-kind-cutover-rollout.test.mjs  |   13 +-
 ...t-run-evidence-locator-negative-matrix.test.mjs |    4 +-
 tests/tools/current-schema-authority.test.mjs      |    2 +-
 tests/tools/deployment-slots.test.mjs              |    6 +-
 tests/tools/destructive-migration-proof.test.mjs   |   30 +-
 .../tools/destructive-operation-authority.test.mjs |    2 +
 tests/tools/final-image-toolchain-pin.test.mjs     |   48 +
 tests/tools/gateway-switch.test.mjs                |  465 +++++-
 .../offline-migration-catalog-parity.test.mjs      |    2 +-
 .../tools/online-schema-migration-wrapper.test.mjs |   75 +-
 .../tools/post-runtime-producer-registry.test.mjs  |   97 +-
 .../tools/release-deployment-observation.test.mjs  |   38 +
 .../release-final-current-run-locator.test.mjs     |    4 +-
 tests/tools/release-manifest.test.mjs              |  233 ++-
 tests/tools/release-retention-state.test.mjs       |    3 +
 tests/tools/release-rollout-bundle.test.mjs        |    6 +-
 tests/tools/release-rollout-evidence.test.mjs      |  227 ++-
 tests/tools/release-rollout-probes.test.mjs        |    4 +-
 tests/tools/release-rollout-state.test.mjs         |   66 +-
 tests/tools/release-traffic-probe-session.test.mjs |    4 +-
 .../tools/release-worker-normal-observer.test.mjs  |    4 +-
 .../tools/release-worker-observer-service.test.mjs |    2 +
 tests/tools/release-worker-reconciliation.test.mjs |    2 +
 .../tools/runtime-role-contract-boundary.test.mjs  |   95 +-
 .../runtime-role-minimal-v3-contract.test.mjs      |   69 +-
 .../support/behavior-doc-admission-fixture.mjs     |   13 +-
 .../behavior-evidence-pre-runtime-fixture.mjs      |    2 +-
 .../support/post-runtime-candidate-fixture.mjs     |   10 +-
 .../support/pure-release-authority-fixture.mjs     |  111 +-
 .../support/release-authority-test-fixtures.mjs    |    3 +
 .../support/release-readiness-test-helpers.mjs     |    4 +-
 .../support/release-rollout-evidence-fixture.mjs   |   61 +-
 .../support/runtime-role-minimal-v3-fixture.mjs    |  142 +-
 tests/tools/test-evidence-receipt-schema.test.mjs  |   31 +-
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
 ...release-rollout-auxiliary-evidence-contract.mjs |   52 +-
 .../release-rollout-evidence-constants.mjs         |    8 +-
 .../release-rollout-evidence-sections.mjs          |    8 +-
 .../release-rollout-evidence-verifier.mjs          |    2 +
 tools/deployment/release-rollout-evidence.mjs      |  129 +-
 tools/deployment/release-rollout-gate.mjs          |    7 +-
 tools/deployment/release-rollout-lib.mjs           |   53 +-
 tools/deployment/release-rollout-recovery.sh       |  242 +--
 .../release-rollout-semantic-artifact-contract.mjs |    2 +-
 tools/deployment/release-rollout.sh                |  191 ++-
 tools/deployment/release-traffic-probe.mjs         |    2 +-
 tools/deployment/rollout-state.mjs                 |   14 +
 tools/deployment/slot-common.sh                    |    3 +-
 .../verify-release-challenge-kind-cutover.mjs      |    7 +-
 tools/deployment/zero-downtime-rehearsal-plan.mjs  |  566 +++++--
 tools/deployment/zero-downtime-rehearsal.sh        | 1692 +-------------------
 ...vior-doc-minimal-contract-build-v3-contract.mjs |   71 +-
 tools/docs/behavior-doc-minimal-contract-build.mjs |   12 +-
 .../behavior-doc-static-admission-contract.mjs     |  244 ++-
 tools/docs/behavior-doc-static-admission.mjs       |   54 +-
 ...r-document-consistency-final-value-contract.mjs |  198 +++
 tools/docs/behavior-document-consistency-final.mjs |  266 ++-
 tools/fact-extractors/post-runtime/candidate.mjs   |   15 +-
 tools/fact-extractors/post-runtime/common.mjs      |   31 +-
 .../post-runtime/evidence-context.mjs              |    4 +-
 tools/fact-extractors/post-runtime/observation.mjs |   15 +-
 tools/fact-extractors/test-matrix/extract.mjs      |   75 +-
 .../operations/check-release-evidence-manifest.mjs |  253 ++-
 .../operations/collect-release-rollout-bundle.mjs  |    4 +-
 tools/release/check-release-final.mjs              |   45 +-
 tools/release/check-release-manifest.mjs           |   27 +-
 tools/release/create-release-manifest.mjs          |   52 +-
 tools/release/release-final-domain-evidence.mjs    |    2 +-
 tools/release/release-manifest-value-contract.mjs  |  217 ++-
 tools/release/release-manifest.mjs                 |  119 +-
 tools/release/test-evidence-receipts.mjs           |    4 +-
 tools/test-evidence/blue-green-containment-raw.mjs |   38 +-
 ...anonical-release-authorities-value-contract.mjs |   75 +-
 .../canonical-release-authorities.mjs              |   35 +-
 .../release-authority-bundle-contract.mjs          |  112 +-
 .../release-authority-facts-contract.mjs           |  109 +-
 tools/test-evidence/release-readiness-raw.mjs      |   39 +-
 .../release-readiness-source-support.mjs           |    2 +-
 .../behavior-doc-static-admission-contract.mjs     |    2 +-
 .../test-matrix/behavior-evidence-post-runtime.mjs |  291 +++-
 .../test-matrix/behavior-evidence-pre-runtime.mjs  |    2 +-
 .../test-matrix/post-runtime-producer-registry.mjs |  100 +-
 .../test-matrix/produce-behavior-test-evidence.mjs |    2 +-
 tools/test-matrix/required-evidence-catalog.mjs    |    4 +-
 .../test-matrix/verify-behavior-test-evidence.mjs  |    2 +-
 173 files changed, 10920 insertions(+), 6656 deletions(-)
```

