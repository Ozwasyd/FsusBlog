# WIP: codex/issue-3523-3524-3527-integration

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3523-3524-3527-integration`
- 原始 commit：`f517d17aed8b7bfa3085ca9ee0e4233558b697f6`
- 原始 tree：`db787cad45ac3a20610d8b523017b2c1109880e5`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3523, #3524, #3527
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
f517d17ae fix(governance): bind mysql service to matrix entries
Require strict retained systemd service ownership for direct and CI MySQL tiers, align their namespace binding, and prevent the independent Migration build from retaining a shared compiler. Preserve the remaining canonical admission and build-owner finalization gates.

Refs: #3524

d8917d979 feat(governance): bind migration mysql to scheduler service
Project the exact MySQL need onto its physical producer, reserve its bounded service before payload release, and hand a private verified admission to Migration execution. Constrain asymmetric residual memory without exceeding the bundle grant.

Refs: #3524

851f875a0 chore(governance): bind MySQL service limits to catalog

e49ddacfe chore(governance): integrate migration ownership with durable resource boundary
Preserve independent Migration case identity while moving container reservations onto the current systemd resource owner. MySQL service execution remains fail-closed until scheduler lifecycle admission is wired.

Refs: #3524

1dd0b1491 fix(governance): classify source-owned migration mysql fixtures
Keep execution closed until the canonical service grant and cleanup evidence are admitted.

Refs: #3524

809ebc087 fix(governance): bind nested systemd execution to task slice
Reject caller, unit and pre-release identity drift before running a nested physical command. The enclosing durable slice and grant owner remain separate #3527 work.

Refs: #3527

d094e2991 chore(governance): bind migration matrix-derived artifacts
Regenerate the current applicability, correctness-attempt and testing-index outputs after the admitted MySQL service enters backend-unit, and bind their exact head digests.

Refs: #3524

ee5f0fec7 test(governance): bind migration artifact enumeration
Refs: #3524
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    1 +
 ...gration-execution-target-generated-binding.json |   40 +
 ...sue-3527-resource-boundary-external-naming.json |   46 +
 ...e-3527-resource-boundary-generated-binding.json |   13 +
 ...1-scheduler-fixture-assets-external-naming.json |   12 +
 ...scheduler-fixture-assets-generated-binding.json |   13 +
 ...heduler-finalizer-fixtures-external-naming.json |   12 +
 ...duler-finalizer-fixtures-generated-binding.json |   12 +
 .../migration-assembly-binding.json                |   10 +-
 .../migration-assembly-receipt.json                |   32 +-
 ...st-execution-envelope-applicability.schema.json |    1 +
 .../test-execution-service-catalog.schema.json     |   91 +
 config/testing/correctness-attempt-producers.json  |   89 +-
 .../current-run-evidence-location-acceptance.json  |   12 +-
 .../evidence-location-migration-ledger.json        |  118 +-
 .../testing/physical-execution-process-policy.json |    2 +
 config/testing/retry-disposition-registry.json     |   24 +-
 .../test-execution-envelope-applicability.json     |   10 +-
 config/testing/test-execution-service-catalog.json |   36 +
 docs/database-migration.md                         |   22 +
 docs/schema-migrations/typed-ddl-primitives.json   |   14 +-
 docs/testing.generated.md                          |    4 +-
 docs/testing.md                                    |   55 +-
 docs/testing/content-addressed-evidence-storage.md |   30 +-
 .../issue-1069-run-bound-production-builds.md      |   10 +-
 .../issue-1072-production-resource-enforcement.md  |  403 ++-
 src/migration/SchemaMigrationDdlPrimitives.cs      |   97 +-
 tests/FsusBlog.ProductionBackend.slnx              |    5 +
 .../release-final-execution-target-authority.json  | 1349 +++++++-
 .../backend-production-build-consumers.json        |   40 +-
 tests/governance/test-lifecycle-registry.json      |   36 +
 tests/matrix.yml                                   |   27 +-
 tests/migration/FsusBlog.Migration.Tests.csproj    |    1 +
 tests/migration/MigrationAssemblyBoundaryTests.cs  |   13 +-
 tests/migration/MySqlDdlClient.cs                  |  199 ++
 tests/migration/MySqlDdlClientContractTests.cs     |   87 +
 tests/migration/MySqlDdlExecutionTests.cs          |  194 ++
 tests/migration/MySqlDdlFixture.cs                 |  101 +
 tests/migration/MySqlDdlFixtureContractTests.cs    |   51 +
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |   79 +-
 tests/migration/packages.lock.json                 |   10 +
 tests/migration/schema-ddl-provider-snapshots.json |    6 +-
 .../backend-production-build-authority.test.mjs    |   64 +-
 .../content-addressed-evidence-store.test.mjs      |   75 +-
 tests/tools/correctness-attempt-migration.test.mjs |   32 +-
 ...sm-fixture-materializer-runtime-assets.test.mjs |   33 +
 tests/tools/evidence-location-governance.test.mjs  |   58 +
 tests/tools/execution-envelope-network.test.mjs    |   45 +-
 tests/tools/execution-envelope-policy.test.mjs     |   11 +
 tests/tools/execution-envelope-services.test.mjs   | 1567 ++++++++-
 tests/tools/hidden-retry-governance.test.mjs       |   24 +-
 .../local-production-profile-evidence.test.mjs     |   21 +
 tests/tools/migration-execution-evidence.test.mjs  |  983 ++++++
 tests/tools/migration-fast-lane.test.mjs           |  226 ++
 .../tools/physical-execution-process-tree.test.mjs |  686 +++-
 .../physical-execution-systemd-sender.test.mjs     |  104 +
 .../production-capacity-preflight-order.test.mjs   |   82 +-
 .../tools/production-capacity-reservation.test.mjs |  262 ++
 .../tools/production-resource-enforcement.test.mjs | 3608 +++++++++++++++++++-
 tests/tools/scheduler-owner-identity.test.mjs      |  312 +-
 .../support/esm-fixture-materializer-contracts.mjs |  175 +-
 .../support/esm-fixture-materializer-runner.mjs    |   60 +
 tests/tools/support/esm-fixture-materializer.mjs   |  116 +-
 .../scheduler-checkpoint-recovery-probe.mjs        |   12 +
 .../tools/support/xunit-configuration-fixture.mjs  |  139 +
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 +-
 tests/tools/test-matrix-resource-boundary.test.mjs |  694 ++++
 tests/tools/test-matrix-scheduler.test.mjs         |  564 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   41 +
 tools/check-test-matrix.mjs                        |    4 +-
 tools/run-test-matrix.mjs                          |  195 +-
 tools/test-fixtures/services/mysql.mjs             |  777 +++++
 tools/test-inventory/adapters.mjs                  |   22 +-
 tools/test-inventory/discovery.mjs                 |   55 +-
 tools/test-inventory/produce.mjs                   |   13 +-
 tools/test-inventory/xunit-projects.mjs            |  103 +
 .../test-inventory/xunit-roslyn-adapter/Program.cs |   35 +-
 .../XunitAdapterProjectContext.cs                  |   57 +-
 .../XunitAdapterReferenceResolution.cs             |   68 +-
 .../content-addressed-evidence-store.mjs           |   48 +-
 tools/test-matrix/local-profile.mjs                |   42 +
 tools/test-matrix/production-build-layout.mjs      | 1231 ++++++-
 tools/test-matrix/production-build-lifecycle.mjs   |   32 +-
 .../production-capacity-reservation.mjs            |  269 +-
 .../production-fresh-run-bound-outputs.mjs         |    3 +-
 .../production-resource-enforcement.mjs            |  694 +++-
 .../production-systemd-resource-boundary.mjs       | 1191 +++++++
 tools/test-matrix/scheduler.mjs                    | 1227 ++++++-
 tools/test-retention/audit.mjs                     |   32 +-
 tools/test/backend-platform-selection.mjs          |   80 +-
 tools/test/build-migration-tests.mjs               |   88 +
 tools/test/bundles/run-bundle.mjs                  |   41 +
 .../check-backend-production-build-authority.mjs   |   22 +-
 tools/test/correctness-attempt-migration.mjs       |    4 +-
 tools/test/execution-envelope-services.mjs         |  310 +-
 .../test/generate-evidence-location-governance.mjs |   33 +
 tools/test/lanes/_suite-support.sh                 |   38 +-
 tools/test/lanes/static-governance.sh              |    6 +
 tools/test/migration-build-binding.mjs             |  253 ++
 tools/test/migration-execution-evidence.mjs        |  179 +
 tools/test/mysql-fixture-admission.mjs             |  223 ++
 tools/test/native/execution-envelope-landlock.c    |    6 +
 .../physical-execution-linux-systemd-adapter.mjs   |  619 +++-
 tools/test/physical-execution-nested-channel.mjs   |  584 ++++
 tools/test/physical-execution-nested-socket.py     |  140 +
 tools/test/physical-execution-process-tree.mjs     |  862 ++++-
 tools/test/physical-execution-systemd-sender.mjs   |  274 ++
 tools/test/run-migration-tests.mjs                 |  470 +++
 109 files changed, 22691 insertions(+), 1221 deletions(-)
```

