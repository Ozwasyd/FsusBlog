# WIP: codex/issue-3523-3524-mysql-integration

历史备份与接续信息，非当前规范、合并资格或验收证据。

- 原始分支：`codex/issue-3523-3524-mysql-integration`
- 原始 commit：`569bfedeabfb25864d14622870c33d6a4cdef122`
- 原始 tree：`ebbc70295e315695dc33e66f8dbfe01684d06430`
- 与当前 master 的 merge base：`d653afbde02b75814d8384777886b10419fb38a1`
- 相关 issue 线索：#3523, #3524, #3527, #2174, #3178, #3511, #3060, #3510, #3118
- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。
- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。
- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。
- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。
- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。

## 最近提交（原始历史，不代表已验收）

```text
569bfedea test(governance): stage mysql ddl service integration
Combine the MySQL DDL cases with the canonical Migration inventory and declare the pinned service. Resource-held execution and live admission remain outstanding on this integration branch.

Refs: #3523, #3524, #3527

a9eb6c8a5 test(governance): bind migration inventory and execution owners
Preserve the canonical Migration inventory, independent execution receipt and generated authority while live MySQL service registration remains an explicit acceptance gap.

Refs: #3524

4007bf3e9 fix(database): execute MySQL typed DDL with exact index ownership
Use selected-database metadata and guarded prepared DDL for ensure/create/drop.
Preserve case-sensitive table ambiguity and shared string literal values.
Add real-engine tests and current semantics documentation without changing
historical descriptors, their fingerprints or PostgreSQL/SQLite snapshots.

This is a local development candidate, not terminal production qualification.
Canonical Migration inventory and execution remain pending under #3524.
Required matrix, independent review and standard PR acceptance remain open.

Refs: #3523

d653afbde feat(test): materialize canonical article lifecycle fixtures
Refs: #2174
98e490f6d feat(contracts): bind typed AEDS endpoint observation
Refs: #3178
d3658ecdd fix(governance)!: close terminal zero-legacy scanner (#3511)
Refs: #3060
BREAKING CHANGE: Final consistency reports now require the closed zero-legacy scan shape and an independently recomputed repository scan.
1c59bdb65 Merge pull request #3510 from Ozwasyd/codex/issue-3118-projection-reseal
fix(test): bind content projection to semantic fragments
4258dd302 fix(test): bind content projection to semantic fragments
Exclude compiler and producer implementation metadata from the per-owner source digest while retaining exact Roslyn extraction and generated authority binding.

Refs: #3118
```

## 相对原 merge base 的源码差异概况

```text
Directory.Packages.props                           |    1 +
 ...gration-execution-target-generated-binding.json |   15 +
 .../migration-assembly-binding.json                |   10 +-
 .../migration-assembly-receipt.json                |   32 +-
 .../test-execution-service-catalog.schema.json     |   62 +
 config/testing/correctness-attempt-producers.json  |   87 +-
 config/testing/retry-disposition-registry.json     |   24 +-
 config/testing/test-execution-service-catalog.json |   25 +
 docs/database-migration.md                         |   22 +
 docs/schema-migrations/typed-ddl-primitives.json   |   14 +-
 docs/testing.md                                    |   45 +
 .../issue-1072-production-resource-enforcement.md  |   35 +-
 src/migration/SchemaMigrationDdlPrimitives.cs      |   97 +-
 tests/FsusBlog.ProductionBackend.slnx              |    5 +
 .../release-final-execution-target-authority.json  |  517 ++++++-
 .../backend-production-build-consumers.json        |   40 +-
 tests/governance/test-lifecycle-registry.json      |   36 +
 tests/matrix.yml                                   |   27 +-
 tests/migration/FsusBlog.Migration.Tests.csproj    |    1 +
 tests/migration/MigrationAssemblyBoundaryTests.cs  |   13 +-
 tests/migration/MySqlDdlClient.cs                  |  189 +++
 tests/migration/MySqlDdlClientContractTests.cs     |   74 +
 tests/migration/MySqlDdlExecutionTests.cs          |  194 +++
 tests/migration/MySqlDdlFixture.cs                 |  208 +++
 .../migration/SchemaMigrationDdlPrimitivesTests.cs |   79 +-
 tests/migration/packages.lock.json                 |   10 +
 tests/migration/schema-ddl-provider-snapshots.json |    6 +-
 .../backend-production-build-authority.test.mjs    |   64 +-
 tests/tools/correctness-attempt-migration.test.mjs |   32 +-
 tests/tools/execution-envelope-services.test.mjs   | 1470 +++++++++++++++++++-
 tests/tools/hidden-retry-governance.test.mjs       |   24 +-
 tests/tools/migration-execution-evidence.test.mjs  |  912 ++++++++++++
 tests/tools/migration-fast-lane.test.mjs           |  226 +++
 .../tools/production-resource-enforcement.test.mjs |  247 +++-
 .../tools/support/xunit-configuration-fixture.mjs  |  139 ++
 .../tools/support/xunit-project-graph-fixture.mjs  |    2 +-
 tests/tools/test-inventory.test.mjs                |  179 ++-
 tests/tools/xunit-roslyn-adapter.test.mjs          |   41 +
 tools/test-fixtures/services/mysql.mjs             |  766 ++++++++++
 tools/test-inventory/adapters.mjs                  |   22 +-
 tools/test-inventory/discovery.mjs                 |   55 +-
 tools/test-inventory/produce.mjs                   |   13 +-
 tools/test-inventory/xunit-projects.mjs            |  103 ++
 .../test-inventory/xunit-roslyn-adapter/Program.cs |   35 +-
 .../XunitAdapterProjectContext.cs                  |   57 +-
 .../XunitAdapterReferenceResolution.cs             |   68 +-
 tools/test-matrix/production-build-layout.mjs      |    8 +-
 .../production-fresh-run-bound-outputs.mjs         |    3 +-
 .../production-resource-enforcement.mjs            |  255 +++-
 tools/test-matrix/scheduler.mjs                    |   33 +-
 tools/test-retention/audit.mjs                     |   32 +-
 tools/test/backend-platform-selection.mjs          |   80 +-
 tools/test/build-migration-tests.mjs               |   88 ++
 tools/test/bundles/run-bundle.mjs                  |   41 +
 .../check-backend-production-build-authority.mjs   |   22 +-
 tools/test/correctness-attempt-migration.mjs       |    4 +-
 tools/test/execution-envelope-services.mjs         |  283 +++-
 tools/test/lanes/_suite-support.sh                 |   38 +-
 tools/test/migration-build-binding.mjs             |  253 ++++
 tools/test/migration-execution-evidence.mjs        |  179 +++
 tools/test/run-migration-tests.mjs                 |  385 +++++
 61 files changed, 7705 insertions(+), 322 deletions(-)
```

