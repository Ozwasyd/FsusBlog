# WIP: codex/issue-3662-post-claim-stage-io-20261003

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3662-post-claim-stage-io-20261003`
- 原始 commit：`989a0c12c9a02fa2da7dd29b11afd7f175f2076a`
- 原始 tree：`9adc1559892388cc89229a5a6247fc73e194c8df`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3662, #2218
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
989a0c12c fix(governance): derive claim-stage materials inside post IO
Refs: #3662

fd99614b4 fix(governance): bind post callers and current schema facts
Refs: #3662

d20ff640d feat(governance)!: partition post-runtime producers and require native receipt references
Separate registered class ownership and explicitly version changed post-runtime
routing, aggregate envelopes, release authority bundles and raw observations.
The original native collector is not connected in this source-only slice;
current-schema qualification refuses rather than using pre-runtime provenance.

BREAKING CHANGE: reject registry v2, aggregate and envelope v1, release authority bundles and observations v1; require explicit current-schema receipt references and producer selection
Refs: #3662

30b6ea7ad fix(contracts): refuse retired runtime schema overlap proof
Change-Class: implementation

Refs: #2218

524fa8b1a fix(backend): remove retired server migration control plane
Keep historical classification custody separate while retiring the unused Server CLI, DI and writable store. Direct consumers use current refusal inputs and the sole offline destructive guard.

Refs: #2218

21e76b377 test(release): bind finalizer self-test to current-only manifest
Use the existing v3 reference contract in the original valid fixture and retain explicit legacy-window and missing-current refusal controls without changing any validator.

Refs: #2218

c6833259c fix(operations): bound current rehearsal output and owned group cleanup
Refs: #2218

fda4dcc01 fix(deployment): bind rehearsal replay to durable current state
Require complete source/target identities, rollout id and final evidence path to match the explicit current consumer inputs. Preserve the original verifier and add complete positive controls before valid-shape identity and independently sealed report substitutions.

Refs: #2218
```

## 相对原 merge base 的源码差异概况

```text
.../3662-post-native-routing-external-naming.json  |   30 +
 ...-2218-runtime-role-refusal-external-naming.json |   19 +
 .../post-runtime-observation-result.schema.json    |    7 +-
 config/testing/post-runtime-producer-registry.json |  183 ++-
 docs/api/contracts.md                              |   52 +-
 .../admin-operations-health-boundary.md            |   41 +-
 .../monolithic-distributed-boundary.md             |    9 +
 docs/database-migration.md                         |   36 +-
 docs/online-database-migration-operations.md       |  428 ++---
 docs/online-database-migration.md                  |   62 +-
 docs/operations.md                                 |    6 +-
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
 .../tools/application-runtime-observation.test.mjs |   13 +-
 tests/tools/canonical-release-authorities.test.mjs |    4 +-
 .../tools/challenge-kind-cutover-rollout.test.mjs  |   13 +-
 tests/tools/current-schema-authority.test.mjs      |    2 +-
 tests/tools/deployment-slots.test.mjs              |    6 +-
 tests/tools/destructive-migration-proof.test.mjs   |   30 +-
 .../tools/destructive-operation-authority.test.mjs |    2 +
 tests/tools/final-image-toolchain-pin.test.mjs     |   48 +
 tests/tools/gateway-switch.test.mjs                |  465 +++++-
 .../tools/online-schema-migration-wrapper.test.mjs |   75 +-
 .../tools/post-runtime-producer-registry.test.mjs  |   97 +-
 .../tools/release-deployment-observation.test.mjs  |   38 +
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
 .../tools/runtime-role-contract-boundary.test.mjs  |   28 +
 .../support/post-runtime-candidate-fixture.mjs     |   10 +-
 .../support/release-readiness-test-helpers.mjs     |    4 +-
 .../support/release-rollout-evidence-fixture.mjs   |   61 +-
 tests/tools/zero-downtime-rehearsal.test.mjs       |  595 +++++--
 tools/build-final-image.sh                         |   25 +-
 .../FsusBlog.RuntimeRoleObservation/Program.cs     |  306 +---
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
 tools/fact-extractors/post-runtime/candidate.mjs   |   15 +-
 tools/fact-extractors/post-runtime/common.mjs      |   31 +-
 .../post-runtime/evidence-context.mjs              |    4 +-
 tools/fact-extractors/post-runtime/observation.mjs |   15 +-
 tools/fact-extractors/test-matrix/extract.mjs      |   10 +
 .../operations/check-release-evidence-manifest.mjs |  253 ++-
 .../operations/collect-release-rollout-bundle.mjs  |    4 +-
 tools/release/check-release-final.mjs              |   41 +-
 tools/release/check-release-manifest.mjs           |   27 +-
 tools/release/create-release-manifest.mjs          |   52 +-
 tools/release/release-manifest-value-contract.mjs  |  146 +-
 tools/release/release-manifest.mjs                 |  119 +-
 tools/test-evidence/blue-green-containment-raw.mjs |   38 +-
 .../canonical-release-authorities.mjs              |   35 +-
 .../release-authority-bundle-contract.mjs          |  112 +-
 .../release-authority-facts-contract.mjs           |  109 +-
 tools/test-evidence/release-readiness-raw.mjs      |   39 +-
 .../release-readiness-source-support.mjs           |    2 +-
 .../test-matrix/post-runtime-producer-registry.mjs |  100 +-
 106 files changed, 6115 insertions(+), 4794 deletions(-)
```

