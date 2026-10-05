# WIP: codex/issue-2218-terminal-retirement-20261002

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-2218-terminal-retirement-20261002`
- 原始 commit：`c6833259c520ecf42d872161dfc93e92027bae47`
- 原始 tree：`c98572e78e13f4efe8241e0d55e1162bf70b296f`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#2218, #2217
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
c6833259c fix(operations): bound current rehearsal output and owned group cleanup
Refs: #2218

fda4dcc01 fix(deployment): bind rehearsal replay to durable current state
Require complete source/target identities, rollout id and final evidence path to match the explicit current consumer inputs. Preserve the original verifier and add complete positive controls before valid-shape identity and independently sealed report substitutions.

Refs: #2218

de8b2c897 fix(deployment): consume current schema receipts in rehearsal
Retire active online and image-rollback rehearsal paths. Bind explicit immutable current release inputs, perform fresh pinned Server read-only checks, preserve owned cleanup and raw failures, and replay the original complete release evidence. Recording component checks do not establish native or whole migration qualification.

Refs: #2218

a1e324aa8 fix(release): retain probe ownership after admission refusal
Refs: #2218

47b46b7a4 fix(release): bind rollout to fresh current schema admission
Refs: #2218

775419462 fix(release): bind final-image current receipt references
Project explicit whole-artifact current receipt metadata through the original build and manifest producers without granting database admission.

Refs: #2218

f15554042 fix(schema): close receipt status and development admission
Refs: #2217
(cherry picked from commit e16fd36bf4c13c03bf4f923e50c986e1c53450b6)

2fe01ff99 fix(release): preserve executable deployment consumer modes
Refs: #2218
```

## 相对原 merge base 的源码差异概况

```text
docs/api/contracts.md                              |   52 +-
 .../admin-operations-health-boundary.md            |   41 +-
 docs/database-migration.md                         |   36 +-
 docs/online-database-migration-operations.md       |  428 ++---
 ops/docker/FsusBlog.Server.Dockerfile              |    2 +-
 .../Bootstrap/LifecycleHostedBootstrapService.cs   |    2 +-
 ...urityAndLifecycleServiceCollectionExtensions.cs |    1 +
 .../Infrastructure/Operations/ProductionHealth.cs  |   79 +-
 .../Infrastructure/Operations/ServerCommand.cs     |  358 +++++
 .../SchemaMigration/CurrentSchemaReadObserver.cs   |  140 ++
 .../CurrentSchemaReceiptAdmission.cs               |  102 ++
 .../SchemaMigration/SchemaMigrationRunner.cs       |   93 +-
 ...ntSchemaTestMaterializationCandidateVerifier.cs |    4 +-
 .../Testing/CurrentSchemaTestMaterializer.cs       |    4 +-
 .../ReleaseSchemaQualificationEndpoints.cs         |  123 +-
 src/backend/Program.cs                             |   35 +-
 .../CurrentSchemaMigrationIdentityContracts.cs     |   33 +
 .../CurrentSchemaReceiptContracts.cs               |  316 ++++
 .../Integration/SchemaMigrationIntegrationTests.cs |    1 +
 tests/backend/Unit/CurrentSchemaReceiptTests.cs    |  394 +++++
 .../Unit/LifecycleHostedBootstrapServiceTests.cs   |   83 +
 .../backend/Unit/PasskeyProjectionCommandTests.cs  |   18 +-
 tests/backend/Unit/ProductionHealthTests.cs        |  116 +-
 .../ReleaseSchemaQualificationEndpointsTests.cs    |   82 +
 tests/backend/Unit/ServerCommandTests.cs           |  277 ++++
 tests/tools/canonical-release-authorities.test.mjs |    4 +-
 .../tools/challenge-kind-cutover-rollout.test.mjs  |   13 +-
 tests/tools/deployment-slots.test.mjs              |    6 +-
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
 .../support/release-readiness-test-helpers.mjs     |    4 +-
 .../support/release-rollout-evidence-fixture.mjs   |   61 +-
 tests/tools/zero-downtime-rehearsal.test.mjs       |  595 +++++--
 tools/build-final-image.sh                         |   25 +-
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
 tools/fact-extractors/test-matrix/extract.mjs      |   10 +
 .../operations/check-release-evidence-manifest.mjs |  253 ++-
 .../operations/collect-release-rollout-bundle.mjs  |    4 +-
 tools/release/check-release-manifest.mjs           |   27 +-
 tools/release/create-release-manifest.mjs          |   52 +-
 tools/release/release-manifest-value-contract.mjs  |  146 +-
 tools/release/release-manifest.mjs                 |  119 +-
 74 files changed, 5103 insertions(+), 3329 deletions(-)
```

