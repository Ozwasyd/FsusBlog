# WIP: codex/issue-3662-pure-stage-io-source-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3662-pure-stage-io-source-20261003`
- 原始 commit：`a96ad5b64bd2619ddbfed3a25f1496f704d09461`
- 原始 tree：`0642efb6439fb807a363e21694344231e7f0a49d`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3662, #2218
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
a96ad5b64 fix(governance): isolate stage authority reads from pure contracts
Refs: #3662

cab598632 fix(governance): bind outer claim stages to actual source parsing
Reject independently resealed located-claim digests by reparsing the required expected worktree. Preserve existing admission requirements and materialize the original parser source closure in controlled value fixtures.

Refs: #3662

ba9944f77 fix(governance): partition document claims by catalog evidence stage
Version the static admission envelope explicitly, retain all compiled observation and mutation requirements, and seal deferred post-runtime claim identities without granting native qualification.

Refs: #3662

73e958b04 feat(governance)!: split code-model and native admission claims
Bind strict runtime build v4 in the original static admission schema; register post-runtime current-schema admission and its actual-source coverage without granting native qualification.

BREAKING CHANGE: historical runtime build v2/v3 no longer satisfy the current nested admission schema. Original outer receipt and ordering remain unchanged.

Refs #3662

42d415e1f fix(governance): align current admission fixtures with v4
Preserve explicit historical v3 downgrade refusals and all existing identity controls.

Refs #3662

56c1c69f6 feat(governance)!: version compiled current-schema role contracts
Separate pre-runtime production code-model probes from native database qualification and bind exact v4 runtime build receipts without changing admission order.

BREAKING CHANGE: runtime-role observation v3 and its build receipt v4 replace old compatibility overlap contracts without dual acceptance.

Refs: #3662

30b6ea7ad fix(contracts): refuse retired runtime schema overlap proof
Change-Class: implementation

Refs: #2218

524fa8b1a fix(backend): remove retired server migration control plane
Keep historical classification custody separate while retiring the unused Server CLI, DI and writable store. Direct consumers use current refusal inputs and the sole offline destructive guard.

Refs: #2218
```

## 相对原 merge base 的源码差异概况

```text
...-2218-runtime-role-refusal-external-naming.json |   19 +
 ...sue-3662-pre-parse-binding-external-naming.json |   19 +
 .../issue-3662-pure-stage-io-external-naming.json  |   18 +
 ...issue-3662-stage-admission-external-naming.json |   32 +
 config/contracts/behavior-contracts.json           |   33 +-
 config/contracts/behavior-fact-extractors.json     |    8 +-
 .../contracts/document-claim-migration-ledger.json |   11 +-
 ...havior-doc-static-admission-receipt.schema.json |   69 +-
 .../schemas/runtime-role-observation.schema.json   |  222 ++-
 docs/api/contracts.md                              |   52 +-
 .../admin-operations-health-boundary.md            |   41 +-
 .../monolithic-distributed-boundary.md             |   15 +
 docs/database-migration.md                         |   46 +-
 docs/development/doc-claim-protocol.md             |   10 +
 docs/online-database-migration-operations.md       |  428 ++---
 docs/online-database-migration.md                  |   62 +-
 docs/operations.md                                 |    6 +-
 docs/releases/blue-green-deployment-runbook.md     |   36 +-
 docs/testing.md                                    |    4 +
 ops/docker/FsusBlog.Server.Dockerfile              |    2 +-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../Infrastructure/Operations/ProductionHealth.cs  |   79 +-
 .../Infrastructure/Operations/ServerCommand.cs     |  358 +++++
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  140 ++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../OnlineSchemaMigrationCoordinator.cs            |  603 -------
 .../PostgresOnlineSchemaMigrationStateStore.cs     |  287 ----
 .../SchemaMigration/SchemaMigrationRunner.cs       |   93 +-
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |    4 +-
 .../ReleaseSchemaQualificationEndpoints.cs         |  123 +-
 src/backend/Program.cs                             |   35 +-
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 tests/backend/Unit/BackendTestGovernanceTests.cs   |    2 -
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  394 +++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 +
 .../Unit/OnlineSchemaMigrationCoordinatorTests.cs  |  113 +-
 .../Unit/OnlineSchemaMigrationPolicyTests.cs       |   87 +-
 .../backend/Unit/PasskeyProjectionCommandTests.cs  |   18 +-
 tests/backend/Unit/ProductionHealthTests.cs        |  120 +-
 .../ReleaseSchemaQualificationEndpointsTests.cs    |   82 +
 tests/backend/Unit/ServerCommandTests.cs           |  277 ++++
 tests/coverage-registry.json                       |   25 +
 tests/tools/behavior-doc-static-admission.test.mjs |  226 ++-
 tests/tools/canonical-release-authorities.test.mjs |   24 +-
 .../tools/challenge-kind-cutover-rollout.test.mjs  |   13 +-
 tests/tools/current-schema-authority.test.mjs      |    2 +-
 tests/tools/deployment-slots.test.mjs              |    6 +-
 tests/tools/destructive-migration-proof.test.mjs   |   30 +-
 .../tools/destructive-operation-authority.test.mjs |    2 +
 tests/tools/final-image-toolchain-pin.test.mjs     |   48 +
 tests/tools/gateway-switch.test.mjs                |  465 +++++-
 .../tools/online-schema-migration-wrapper.test.mjs |   75 +-
 tests/tools/release-manifest.test.mjs              |  233 ++-
 tests/tools/release-retention-state.test.mjs       |    3 +
 tests/tools/release-rollout-bundle.test.mjs        |    6 +-
 tests/tools/release-rollout-evidence.test.mjs      |   95 +-
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
 .../support/release-authority-test-fixtures.mjs    |    3 +
 .../support/release-readiness-test-helpers.mjs     |    4 +-
 .../support/release-rollout-evidence-fixture.mjs   |   61 +-
 .../support/runtime-role-minimal-v3-fixture.mjs    |  142 +-
 tests/tools/zero-downtime-rehearsal.test.mjs       |  595 +++++--
 tools/build-final-image.sh                         |   25 +-
 .../FsusBlog.RuntimeRoleObservation/Models.cs      |   34 +-
 .../FsusBlog.RuntimeRoleObservation/Program.cs     |  414 ++---
 tools/db/run-online-migrations.sh                  |  113 +-
 tools/deploy-production.sh                         |    5 +-
 tools/deployment/gateway-recover.sh                |   66 +-
 tools/deployment/gateway-rollback.sh               |   67 +-
 tools/deployment/gateway-switch.sh                 |   54 +-
 ...release-rollout-auxiliary-evidence-contract.mjs |   53 +-
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
 tools/fact-extractors/test-matrix/extract.mjs      |   75 +-
 .../operations/check-release-evidence-manifest.mjs |  253 ++-
 .../operations/collect-release-rollout-bundle.mjs  |    4 +-
 tools/release/check-release-final.mjs              |   41 +-
 tools/release/check-release-manifest.mjs           |   27 +-
 tools/release/create-release-manifest.mjs          |   52 +-
 tools/release/release-manifest-value-contract.mjs  |  146 +-
 tools/release/release-manifest.mjs                 |  119 +-
 ...anonical-release-authorities-value-contract.mjs |    8 +-
 .../behavior-doc-static-admission-contract.mjs     |    2 +-
 .../test-matrix/behavior-evidence-pre-runtime.mjs  |    2 +-
 .../test-matrix/produce-behavior-test-evidence.mjs |    2 +-
 .../test-matrix/verify-behavior-test-evidence.mjs  |    2 +-
 116 files changed, 6806 insertions(+), 4874 deletions(-)
```

