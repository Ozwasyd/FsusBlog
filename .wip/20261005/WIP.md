# WIP: codex/issue-3524-canonical-v7whj5

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3524-canonical-v7whj5`
- 原始 commit：`79987e2f068b29781c2d42e17c282c4537c04a08`
- 原始 tree：`0f27c9d1f5296d03d07a235bfcb5c5119022a97f`
- 与当前 master 的 merge base：`b19b3dc715691b871f0e3cab598ec5da8f27633c`
- 相关 issue 线索：#3524, #3622, #3527, #3617
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
79987e2f0 chore(governance): bind exact Migration lock ownership surfaces
Extend the ordinary current-candidate naming manifest to the three new prerequisite paths, without adding any exception ID, wildcard, historical repair or trusted policy change.

Refs: #3524, #3622

95145dade fix(governance): preserve exact Migration NuGet lock ownership
Register only the existing Migration packages.lock.json as PackageManager-owned in the authority and native selection policies. Preserve original lock bytes and all checker implementations; prove lint/write exclusion and rejection of four neighboring handwritten paths through the unchanged checker.

Refs: #3622, #3524

32d62e9ea chore(governance): normalize Migration service schema layout
Apply the existing native JSON formatter without changing any schema value or key order. Preserve NuGet lockfile bytes under their package-manager ownership boundary.

Refs: #3524

ab7b5f58c chore(governance): bind current Migration candidate outputs
Bind every changed execution-closure input and the six canonical outputs to current producer bytes; keep existing prerequisite manifests consistent without modifying trusted generators, policy or historical repair authority.

Refs: #3524, #3527, #3617

108735b76 test(governance): seal canonical BehaviorDoc CLI fixtures
Refs: #3524, #3617

f7a7d1fac test(governance): isolate planned-leaf remeasurement counter
Keep the default production path/identity remeasurement and prove independent existing-ancestor resolution at guard and completion. Freeze only this component fixture free-byte counter so unrelated shared-disk writers cannot consume its unchanged synthetic 300-byte declaration. Production estimator refusal and its counterexamples are unchanged.

Refs: #3527, #3524

b7c324540 test(governance): bind nested service negatives to live resource owner
Replace the unimplemented ancestor-string fixture with the current opaque owner capability. Preserve pre-spawn rejection for copied capabilities and cross-run, namespace, bundle, source and scheduler identities; reject the simulated foreign unit before any signed release. Actual resource-bound positive service probes remain separate.

Refs: #3527, #3524

cf42e20dd fix(governance): retire removed Migration fixture retry disposition
Regenerate the exact disposition inventory after startup lifecycle moved to the scheduler. Preserve the scanner and add rejection of a removed loop whose source digest is refreshed.

Refs: #3524, #3527
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    1 +
 .../issue-3524-canonical-external-naming.json      |  109 +
 ...gration-execution-target-generated-binding.json |   83 +
 ...sue-3527-resource-boundary-external-naming.json |   46 +
 ...e-3527-resource-boundary-generated-binding.json |   13 +
 ...1-scheduler-fixture-assets-external-naming.json |   12 +
 ...scheduler-fixture-assets-generated-binding.json |   13 +
 ...heduler-finalizer-fixtures-external-naming.json |   12 +
 ...duler-finalizer-fixtures-generated-binding.json |   12 +
 .../issue-3612-external-naming.json                |   12 +
 .../issue-3615-external-naming.json                |   19 +
 .../issue-3615-generated-binding.json              |   12 +
 .../issue-3617-external-naming.json                |   29 +
 ...-3622-nuget-lock-ownership-external-naming.json |   20 +
 .../openapi-minimal-receipt-generated-binding.json |   17 +
 .../migration-assembly-binding.json                |   10 +-
 .../migration-assembly-receipt.json                |   32 +-
 .../authoritative-development-docs.json            |    3 +-
 .../development/native-tooling-style-policy.json   |    1 +
 ...havior-doc-static-admission-receipt.schema.json |   78 +-
 ...st-execution-envelope-applicability.schema.json |    1 +
 .../test-execution-service-catalog.schema.json     |  123 +
 config/testing/correctness-attempt-producers.json  |   89 +-
 .../current-run-evidence-location-acceptance.json  |   12 +-
 .../evidence-location-migration-ledger.json        |  118 +-
 .../testing/physical-execution-process-policy.json |    2 +
 .../test-execution-envelope-applicability.json     |   10 +-
 config/testing/test-execution-service-catalog.json |   36 +
 docs/api/schemas-and-errors.md                     |    2 +-
 docs/database-migration.md                         |   22 +
 .../native-tooling-style-enforcement.md            |    8 +
 docs/releases/release-identity.md                  |    2 +-
 docs/schema-migrations/typed-ddl-primitives.json   |   14 +-
 docs/testing.generated.md                          |    4 +-
 docs/testing.md                                    |   62 +-
 docs/testing/content-addressed-evidence-storage.md |   30 +-
 .../issue-1069-run-bound-production-builds.md      |   10 +-
 .../issue-1072-production-resource-enforcement.md  |  403 ++-
 src/migration/SchemaMigrationDdlPrimitives.cs      |   97 +-
 tests/FsusBlog.ProductionBackend.slnx              |    5 +
 .../release-final-execution-target-authority.json  | 1419 +++++++-
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
 tests/tools/behavior-doc-static-admission.test.mjs |  270 +-
 .../content-addressed-evidence-store.test.mjs      |   75 +-
 tests/tools/correctness-attempt-migration.test.mjs |   32 +-
 tests/tools/doc-claim.test.mjs                     |   38 +
 ...sm-fixture-materializer-runtime-assets.test.mjs |   33 +
 tests/tools/evidence-location-governance.test.mjs  |   58 +
 tests/tools/execution-envelope-network.test.mjs    |   45 +-
 tests/tools/execution-envelope-policy.test.mjs     |   11 +
 tests/tools/execution-envelope-services.test.mjs   | 1567 ++++++++-
 tests/tools/hidden-retry-governance.test.mjs       |   44 +
 .../local-production-profile-evidence.test.mjs     |   21 +
 tests/tools/migration-execution-evidence.test.mjs  |  983 ++++++
 tests/tools/migration-fast-lane.test.mjs           |  226 ++
 tests/tools/native-tooling-style.test.mjs          |   53 +
 tests/tools/openapi-aeds-observation.test.mjs      |   36 +-
 .../tools/physical-execution-process-tree.test.mjs |  676 +++-
 .../physical-execution-systemd-sender.test.mjs     |  104 +
 .../production-capacity-preflight-order.test.mjs   |   82 +-
 .../tools/production-capacity-reservation.test.mjs |  295 +-
 .../tools/production-resource-enforcement.test.mjs | 3608 +++++++++++++++++++-
 tests/tools/run-once-process-identity.test.mjs     |   84 +
 .../runtime-role-minimal-v3-contract.test.mjs      |    1 +
 tests/tools/scheduler-owner-identity.test.mjs      |  312 +-
 .../support/esm-fixture-materializer-contracts.mjs |  175 +-
 .../support/esm-fixture-materializer-runner.mjs    |   70 +
 tests/tools/support/esm-fixture-materializer.mjs   |  116 +-
 .../support/runtime-role-minimal-v3-fixture.mjs    |   12 +
 .../scheduler-checkpoint-recovery-probe.mjs        |   12 +
 .../tools/support/xunit-configuration-fixture.mjs  |  139 +
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 +-
 tests/tools/test-matrix-resource-boundary.test.mjs |  705 ++++
 tests/tools/test-matrix-scheduler.test.mjs         |  564 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   41 +
 tools/check-test-matrix.mjs                        |    4 +-
 tools/contracts/lib/openapi-observation.mjs        |   27 +
 ...vior-doc-minimal-contract-build-v3-contract.mjs |   23 +-
 tools/docs/behavior-doc-minimal-contract-build.mjs |   26 +
 tools/docs/behavior-doc-static-admission.mjs       |   68 +-
 tools/docs/doc-claim.mjs                           |   26 +-
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
 tools/test/process-identity.mjs                    |   19 +-
 tools/test/run-migration-tests.mjs                 |  470 +++
 134 files changed, 23796 insertions(+), 1303 deletions(-)
```

